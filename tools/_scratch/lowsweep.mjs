// Sweep the low-sun key/fill/haze split in ONE boot.
//
// `Lighting.keyOverride` rewrites keyframe fields after the table is sampled,
// for every hour, so `{ sunI: 4.4, hemiI: 0.72, fogD: 0.004 }` is the shipping
// build with three authored numbers replaced — which is exactly the candidate
// this round is choosing between. Nine candidates in one bake instead of nine
// bakes.
//
//   node tools/_scratch/lowsweep.mjs --view hero --hour 7.4 \
//     --sun 2.6,3.9,5.2 --hemi 1.14,0.80,0.60 --dir shots/sweep-m
import { chromium } from 'playwright';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquire } from '../_lock.mjs';
import { POSE_SRC } from '../_pose.mjs';
import { VIEWS } from '../shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const W = parseInt(arg('w', '1280'), 10), H = parseInt(arg('h', '720'), 10);
const URL = arg('url', 'http://localhost:5180');
const VIEW = arg('view', 'hero');
const HOUR = parseFloat(arg('hour', '7.4'));
const SUNS = arg('sun', '').split(',').filter(Boolean).map(Number);
const HEMIS = arg('hemi', '').split(',').filter(Boolean).map(Number);
const FOGS = arg('fog', '').split(',').filter(Boolean).map(Number);
const COVERS = arg('cover', '').split(',').filter(Boolean).map(Number);
const DIR = resolve(arg('dir', 'shots/lowsweep'));
mkdirSync(DIR, { recursive: true });

await acquire('lowsweep');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

let frozen = null;
for (const p of ['review/anchors.json', 'shots/_anchors.json']) {
  if (!existsSync(p)) continue;
  try { frozen = { ...JSON.parse(readFileSync(p, 'utf8')), ...(frozen ?? {}) }; } catch { /* corrupt */ }
}
const poseFn = new Function('P', POSE_SRC);

await page.evaluate(() => {
  const L = window.__lighting;
  const inner = L.update.bind(L);
  window.__kfMode = 'A';
  L.update = (dt, focus) => { inner(dt, focus); if (window.__kfMode === 'B') L.sun.intensity = 0; };
});

const v = { ...VIEWS[VIEW] };
await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, HOUR);
await page.evaluate(poseFn, { v, frozen, dynamic: ['vehicle'] });

const shoot = async (mode) => {
  await page.evaluate((m) => { window.__kfMode = m; }, mode);
  await page.evaluate(async () => {
    if (window.__settleStable) await window.__settleStable();
    else if (window.__settle) await window.__settle(30);
  });
  await page.waitForTimeout(300);
  return await page.screenshot();
};

const combos = [];
for (const s of (SUNS.length ? SUNS : [null]))
  for (const hm of (HEMIS.length ? HEMIS : [null]))
    for (const f of (FOGS.length ? FOGS : [null]))
      for (const cv of (COVERS.length ? COVERS : [null])) combos.push({ sunI: s, hemiI: hm, fogD: f, cover: cv });

console.log(`${VIEW} h${HOUR}`);
console.log('sunI    hemiI   fogD     cover   keyShare  lit/fill   P05     P95    range   cStd   chroma');
for (const c of combos) {
  const ov = {};
  if (c.sunI != null) ov.sunI = c.sunI;
  if (c.hemiI != null) ov.hemiI = c.hemiI;
  if (c.fogD != null) ov.fogD = c.fogD;
  if (c.cover != null) ov.cover = c.cover;
  await page.evaluate((o) => { window.__lighting.keyOverride = o; }, ov);
  const A = await shoot('A');
  const B = await shoot('B');
  const tag = `${VIEW}-h${String(HOUR).replace('.', 'p')}-s${c.sunI ?? 'x'}-a${c.hemiI ?? 'x'}-f${c.fogD ?? 'x'}-c${c.cover ?? 'x'}`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${DIR}/${tag}.png`, A);
  const r = await page.evaluate(async ({ a64, b64 }) => {
    const dec = async (b64) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const w = 400, h = Math.round(img.height / img.width * w);
      const c = new OffscreenCanvas(w, h); const g = c.getContext('2d');
      g.drawImage(img, 0, 0, w, h);
      return g.getImageData(0, 0, w, h).data;
    };
    const a = await dec(a64), b = await dec(b64);
    const lin = (u) => { const x = u / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    let n = 0, sA = 0, sB = 0;
    const lum = [], chr = [];
    for (let i = 0; i < a.length; i += 4) {
      const r = a[i] / 255, g = a[i + 1] / 255, bl = a[i + 2] / 255;
      lum.push(0.2126 * r + 0.7152 * g + 0.0722 * bl);
      chr.push(Math.max(r, g, bl) - Math.min(r, g, bl));
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d < 4) continue;
      sA += 0.2126 * lin(a[i]) + 0.7152 * lin(a[i + 1]) + 0.0722 * lin(a[i + 2]);
      sB += 0.2126 * lin(b[i]) + 0.7152 * lin(b[i + 1]) + 0.0722 * lin(b[i + 2]);
      n++;
    }
    lum.sort((x, y) => x - y);
    const pct = (p) => lum[Math.floor(p * lum.length)];
    const mean = lum.reduce((x, y) => x + y, 0) / lum.length;
    const sd = Math.sqrt(lum.reduce((x, y) => x + (y - mean) ** 2, 0) / lum.length);
    return {
      keyShare: n ? (sA - sB) / sA : 0, litFill: n ? (sA - sB) / sB : 0,
      p05: pct(0.05), p95: pct(0.95), cStd: sd,
      chroma: chr.reduce((x, y) => x + y, 0) / chr.length,
    };
  }, { a64: A.toString('base64'), b64: B.toString('base64') });
  const f = (x, d = 3) => x.toFixed(d).padStart(7);
  console.log(`${String(c.sunI ?? '-').padEnd(7)} ${String(c.hemiI ?? '-').padEnd(7)} ${String(c.fogD ?? '-').padEnd(8)}${String(c.cover ?? '-').padEnd(7)}${f(r.keyShare)}${f(r.litFill)}${f(r.p05)}${f(r.p95)}${f(r.p95 - r.p05)}${f(r.cStd)}${f(r.chroma)}`);
}
await page.evaluate(() => { window.__lighting.keyOverride = null; });
console.log('dir:', DIR);
await browser.close();
