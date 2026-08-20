#!/usr/bin/env node
/**
 * A/B the cloud dome against itself: capture each (view, hour) twice — once as
 * shipped, once with `Clouds.mesh.visible = false` — and report what the cloud
 * layer is actually contributing at named points in the sky.
 *
 * This exists because of the `cloudAmbient` note at the end of Lighting.js's
 * update(). That bug — a lavender cloud veil over the whole upper sky — was
 * only ever found by hiding the cloud dome and re-measuring the top of the sky,
 * and that measurement was a one-off done by hand. It is now a tool, so the
 * next author can answer "is the cloud layer tinting my sky" in one command
 * instead of rediscovering the method.
 *
 *   node tools/cloudprobe.mjs --views sunvista,hero --hours 19,19.8
 *   node tools/cloudprobe.mjs --views dome --hours 0 --dir shots/probe --keep
 *
 * Reported per sample point:
 *   with   — the shipping frame
 *   without— cloud dome hidden
 *   dR/dG/dB in linear light, and the linear B:G ratio of BOTH, because
 *   "blue leads green in daylight" is the specific failure being watched for.
 *
 * `cloudPct` is the share of sampled sky pixels the dome changed by more than
 * one 8-bit step — i.e. how much of the sky the deck is actually covering,
 * which no whole-frame statistic can tell you.
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { acquire } from './_lock.mjs';
import { POSE_SRC } from './_pose.mjs';
import { VIEWS } from './shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

// Same extra framings tod.mjs adds. Duplicated rather than imported because
// tod.mjs is a script with top-level await and importing it would run a sweep.
const EXTRA_VIEWS = {
  dome:    { anchor: 'vista',  height: 60, dist: 150, pitch: 0.55, fov: 62 },
  moon:    { anchor: 'vista',  height: 60, dist: 150, pitch: 0.42, fov: 56, faceMoon: true },
  camp:    { anchor: 'meadow', height: 1.7, dist: 30, pitch: 0.02, fov: 58 },
  sunvista:{ anchor: 'vista',  height: 62, dist: 150, pitch: 0.03, fov: 52, faceSun: true },
  sunlow:  { anchor: 'meadow', height: 2.4, dist: 40, pitch: 0.06, fov: 54, faceSun: true },
  sunwater:{ anchor: 'river',  height: 6,  dist: 60, pitch: 0.02, fov: 54, faceSun: true },
  ridge:   { anchor: 'vista',  height: 40, dist: 120, pitch: -0.05, fov: 55 },
};
const ALL_VIEWS = { ...VIEWS, ...EXTRA_VIEWS };

const URL = String(arg('url', 'http://localhost:5180'));
const OUT_W = parseInt(String(arg('w', '1280')), 10);
const OUT_H = parseInt(String(arg('h', '720')), 10);
const RES = arg('res', null);
const DIR = String(arg('dir', 'shots/cloudprobe'));
const viewNames = String(arg('views', 'sunvista')).split(',').map((s) => s.trim()).filter(Boolean);
const hours = String(arg('hours', '19')).split(',').map(Number);

// Sky-only points: every one of these is above the ridge line in the framings
// above, so a difference here is a difference in the sky and not in a mountain.
const POINTS = [
  { label: 'zenith    ', x: 0.50, y: 0.03 },
  { label: 'upper sky ', x: 0.50, y: 0.10 },
  { label: 'mid sky   ', x: 0.50, y: 0.20 },
  { label: 'sky L     ', x: 0.12, y: 0.12 },
  { label: 'sky R     ', x: 0.88, y: 0.12 },
];

const hTag = (h) => `h${String(h).replace('.', 'p')}`;

await acquire('cloudprobe');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: OUT_W, height: OUT_H }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});

const url = RES ? `${URL}${URL.includes('?') ? '&' : '?'}res=${RES}` : URL;
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 600000, polling: 250 });

let frozen = null;
for (const p of ['review/anchors.json', 'shots/_anchors.json']) {
  if (!existsSync(p)) continue;
  try { frozen = { ...JSON.parse(readFileSync(p, 'utf8')), ...(frozen ?? {}) }; } catch { /* corrupt */ }
}
if (has('keep')) mkdirSync(DIR, { recursive: true });
const poseFn = new Function('P', POSE_SRC);

const setClouds = (vis) => page.evaluate((v) => {
  const sys = Object.values(window.__systems ?? {}).find((s) => s?.name === 'Clouds');
  if (!sys?.mesh) return false;
  sys.mesh.visible = v;
  return true;
}, vis);

const shoot = async () => {
  await page.evaluate(async () => {
    if (window.__settleStable) await window.__settleStable();
    else if (window.__settle) await window.__settle(60);
  });
  await page.waitForTimeout(500);
  return (await page.screenshot()).toString('base64');
};

const analyse = (a, b) => page.evaluate(async ({ a, b, POINTS }) => {
  const load = async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, img.width, img.height).data, W: img.width, H: img.height };
  };
  const A = await load(a), B = await load(b);
  const toLin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const patch = (I, px, py) => {
    const cx = Math.round(px * (I.W - 1)), cy = Math.round(py * (I.H - 1));
    let r = 0, g = 0, bl = 0, n = 0;
    for (let y = Math.max(0, cy - 5); y <= Math.min(I.H - 1, cy + 5); y++)
      for (let x = Math.max(0, cx - 5); x <= Math.min(I.W - 1, cx + 5); x++) {
        const i = (y * I.W + x) * 4; r += I.d[i]; g += I.d[i + 1]; bl += I.d[i + 2]; n++;
      }
    return [r / n, g / n, bl / n];
  };
  const rows = POINTS.map((p) => {
    const wa = patch(A, p.x, p.y), wb = patch(B, p.x, p.y);
    const la = wa.map(toLin), lb = wb.map(toLin);
    const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
    return {
      label: p.label,
      withHex: hex(wa), withoutHex: hex(wb),
      // linear B:G — the magenta-veil test. >1 means blue leads green.
      withBG: la[2] / Math.max(la[1], 1e-6),
      withoutBG: lb[2] / Math.max(lb[1], 1e-6),
      withChroma: (Math.max(...wa) - Math.min(...wa)) / 255,
      withoutChroma: (Math.max(...wb) - Math.min(...wb)) / 255,
      dLuma: (0.2126 * la[0] + 0.7152 * la[1] + 0.0722 * la[2]) -
             (0.2126 * lb[0] + 0.7152 * lb[1] + 0.0722 * lb[2]),
    };
  });
  // Coverage over the upper 30% of the frame, in two tiers. The tiers matter:
  // the deck's aerial fade means it perturbs almost every sky pixel by a step
  // or two, so a "changed at all" count reads 100% on a sky a human would call
  // three-quarters clear. `solid` is the number to argue about — a 24/255 shift
  // is cloud you can see as a shape.
  const y1 = Math.floor(A.H * 0.30);
  let changed = 0, solid = 0, tot = 0;
  for (let y = 0; y < y1; y++) for (let x = 0; x < A.W; x += 2) {
    const i = (y * A.W + x) * 4;
    tot++;
    const dmax = Math.max(Math.abs(A.d[i] - B.d[i]), Math.abs(A.d[i + 1] - B.d[i + 1]),
                          Math.abs(A.d[i + 2] - B.d[i + 2]));
    if (dmax > 1) changed++;
    if (dmax > 24) solid++;
  }
  // Whole-frame top-end, with and without: the cloud is meant to own the
  // highlight, so this is the number that says whether it does.
  const p95 = (I) => {
    const l = [];
    for (let i = 0; i < I.d.length; i += 16) {
      l.push(0.2126 * toLin(I.d[i]) + 0.7152 * toLin(I.d[i + 1]) + 0.0722 * toLin(I.d[i + 2]));
    }
    l.sort((x, y) => x - y);
    return { p95: l[Math.floor(l.length * 0.95)], max: l[l.length - 1] };
  };
  return { rows, cloudPct: 100 * changed / Math.max(1, tot), solidPct: 100 * solid / Math.max(1, tot), withTop: p95(A), withoutTop: p95(B) };
}, { a, b, POINTS });

for (const name of viewNames) {
  const v = ALL_VIEWS[name];
  if (!v) { console.error(`unknown view: ${name}`); continue; }
  for (const hour of hours) {
    await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, hour);
    await page.evaluate(poseFn, { v, frozen, dynamic: ['vehicle'] });

    await setClouds(true);
    const withA = await shoot();
    await setClouds(false);
    const withoutB = await shoot();
    await setClouds(true);

    if (has('keep')) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`${DIR}/${name}-${hTag(hour)}-with.png`, Buffer.from(withA, 'base64'));
      writeFileSync(`${DIR}/${name}-${hTag(hour)}-without.png`, Buffer.from(withoutB, 'base64'));
    }

    const r = await analyse(withA, withoutB);
    console.log(`\n── ${name} h${hour}   cloud touches ${r.cloudPct.toFixed(1)}% of the upper frame, reads as cloud over ${r.solidPct.toFixed(1)}%`);
    console.log(`   frame lumaP95  with ${r.withTop.p95.toFixed(3)}  without ${r.withoutTop.p95.toFixed(3)}` +
                `   max  with ${r.withTop.max.toFixed(3)}  without ${r.withoutTop.max.toFixed(3)}`);
    console.log('   point        with      without    B:G with  B:G w/o   chroma w/wo    dLuma');
    for (const s of r.rows) {
      console.log(`   ${s.label}  ${s.withHex}   ${s.withoutHex}   ` +
        `${s.withBG.toFixed(3).padStart(7)}  ${s.withoutBG.toFixed(3).padStart(7)}   ` +
        `${s.withChroma.toFixed(3)}/${s.withoutChroma.toFixed(3)}   ${(s.dLuma >= 0 ? '+' : '') + s.dLuma.toFixed(4)}`);
    }
  }
}
console.log();
await browser.close();
