// What is left in the frame when every light and the haze are switched off?
// Saves the frame so it can be looked at, and reports how flat it is.
//
// WHAT IT ACTUALLY ANSWERS, AND THE TRAP IN READING IT.
//
// It forces `sun.intensity`, `hemi.intensity` and `fill.intensity` to zero
// AFTER Lighting.update has run. That reaches every material three lights
// through its own light uniforms — terrain, rock, trees, grass, the camper.
// It does NOT reach a system that reads Lighting's *published* values and
// computes its own light, and the water is one: `hero-h7p4-darkNoPost.png`
// comes back with the land black and the lake a bright pale blue, which reads
// like "the water is self-lit" and is not — the shipping lake dims correctly
// across the arc. It is the override that does not reach it.
//
// So the residual this prints is an upper bound on "light from somewhere else",
// and the useful reading is the picture rather than the number: whatever is
// still visible in the dark frame is a system this rig cannot switch off.
import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
import { POSE_SRC } from '../_pose.mjs';
import { VIEWS } from '../shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const URL = arg('url', 'http://localhost:5180');
const VIEW = arg('view', 'hero');
const HOUR = parseFloat(arg('hour', '7.4'));
const DIR = arg('dir', 'shots/residual');
mkdirSync(DIR, { recursive: true });

await acquire('residual');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

let frozen = null;
for (const p of ['review/anchors.json', 'shots/_anchors.json']) {
  if (!existsSync(p)) continue;
  try { frozen = { ...JSON.parse(readFileSync(p, 'utf8')), ...(frozen ?? {}) }; } catch { /* corrupt */ }
}
await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, HOUR);
await page.evaluate(new Function('P', POSE_SRC), { v: { ...VIEWS[VIEW] }, frozen, dynamic: ['vehicle'] });

await page.evaluate(() => {
  const L = window.__lighting;
  const inner = L.update.bind(L);
  window.__fd = { sun: 1, hemi: 1, fill: 1 };
  L.update = (dt, f) => {
    inner(dt, f);
    L.sun.intensity *= window.__fd.sun;
    L.hemi.intensity *= window.__fd.hemi;
    L.fill.intensity *= window.__fd.fill;
    L.moon.intensity *= window.__fd.sun;
  };
});

const ARMS = {
  A: { fd: { sun: 1, hemi: 1, fill: 1 }, haze: false, post: false },
  dark: { fd: { sun: 0, hemi: 0, fill: 0 }, haze: true, post: false },
  darkNoPost: { fd: { sun: 0, hemi: 0, fill: 0 }, haze: true, post: true },
};
for (const [tag, a] of Object.entries(ARMS)) {
  await page.evaluate(({ a }) => {
    window.__fd = a.fd;
    window.__lighting.fogScale = a.haze ? 0 : 1;
    const p = window.__postfx;
    if (p && a.post) {
      p._driveTimeOfDay = () => {};
      p.grade.uniforms.get('uLift').value = 0;
      p.grade.uniforms.get('uToe').value = 0;
      p.bloom.intensity = 0;
      p.veil.gain = 0;
      p.tone.offsetScale = 0;
    }
  }, { a });
  await page.evaluate(async () => {
    if (window.__settleStable) await window.__settleStable();
    else if (window.__settle) await window.__settle(30);
  });
  await page.waitForTimeout(400);
  const buf = await page.screenshot();
  writeFileSync(`${DIR}/${VIEW}-h${String(HOUR).replace('.', 'p')}-${tag}.png`, buf);
  const s = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const w = 400, h = Math.round(img.height / img.width * w);
    const c = new OffscreenCanvas(w, h); const g = c.getContext('2d');
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const lin = (u) => { const x = u / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    let s = 0, n = 0; const v = [];
    for (let i = 0; i < d.length; i += 4) {
      const L = 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
      s += L; n++; v.push(L);
    }
    v.sort((x, y) => x - y);
    return { mean: s / n, p05: v[Math.floor(0.05 * n)], p95: v[Math.floor(0.95 * n)] };
  }, buf.toString('base64'));
  console.log(`${tag.padEnd(11)} mean ${s.mean.toFixed(4)}  p05 ${s.p05.toFixed(4)}  p95 ${s.p95.toFixed(4)}`);
}
console.log('dir:', DIR);
await browser.close();
