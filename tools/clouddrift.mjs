#!/usr/bin/env node
/**
 * Measure cloud drift, rather than eyeballing a strip of it.
 *
 * `skystrip.mjs` writes frames for a human to compare; that is the right tool
 * for "does the leaf tumble". It cannot answer "is the deck moving at 0.05°/s
 * or 0.4°/s", and drift speed is exactly the quantity where a still frame lies:
 * anything slower than about 0.08°/s reads as a painted backdrop and anything
 * over about 0.5°/s reads as a screensaver, and both look identical in a
 * screenshot. It also dies whenever a peer saves a file, because it does not
 * block Vite's HMR socket, which is how it failed four authors into this round.
 *
 * This holds a fixed camera, captures a few frames a known wall-clock apart,
 * and cross-correlates a band of pure sky between them to recover the pixel
 * displacement. Reported as px/s and as deg/s through the view's own FOV.
 *
 *   node tools/clouddrift.mjs --view dome --hour 19
 *   node tools/clouddrift.mjs --view dome --hour 7.4 --gap 2500 --frames 4
 *
 * Interpreting it:
 *   direction   should be constant across the pairs. A wandering direction
 *               means something is being driven by a phase rather than by a
 *               velocity.
 *   speed       should be constant too. A speed that varies between pairs is a
 *               crawl or a strobe, which is the defect this exists to catch.
 *   peak        correlation strength, 0..1. A low peak with a large claimed
 *               displacement means the field is CHANGING rather than moving —
 *               which is fine in moderation (that is evolution) and a defect if
 *               it dominates.
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
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

const EXTRA_VIEWS = {
  dome:    { anchor: 'vista',  height: 60, dist: 150, pitch: 0.55, fov: 62 },
  sunvista:{ anchor: 'vista',  height: 62, dist: 150, pitch: 0.03, fov: 52, faceSun: true },
  ridge:   { anchor: 'vista',  height: 40, dist: 120, pitch: -0.05, fov: 55 },
};
const ALL_VIEWS = { ...VIEWS, ...EXTRA_VIEWS };

const URL = String(arg('url', 'http://localhost:5180'));
const W = parseInt(String(arg('w', '960')), 10);
const H = parseInt(String(arg('h', '540')), 10);
const RES = arg('res', '640');
const viewName = String(arg('view', 'dome'));
const hour = Number(arg('hour', 19));
const GAP = parseInt(String(arg('gap', '2000')), 10);
const FRAMES = parseInt(String(arg('frames', '4')), 10);
// Search radius in pixels. Wider than any plausible drift so a runaway shows up
// as a large number rather than as a clamp.
const RAD = parseInt(String(arg('radius', '24')), 10);

const v = ALL_VIEWS[viewName];
if (!v) { console.error(`unknown view: ${viewName}`); process.exit(1); }

await acquire('clouddrift');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
// Block Vite HMR. Without this a peer saving a file mid-run navigates the page
// and the capture dies with "Execution context was destroyed" — which is how
// skystrip.mjs failed on this tree with four authors editing at once.
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

await page.goto(`${URL}?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 600000, polling: 250 });

let frozen = null;
for (const p of ['review/anchors.json', 'shots/_anchors.json']) {
  if (!existsSync(p)) continue;
  try { frozen = { ...JSON.parse(readFileSync(p, 'utf8')), ...(frozen ?? {}) }; } catch { /* corrupt */ }
}
await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, hour);
await page.evaluate(new Function('P', POSE_SRC), { v, frozen, dynamic: [] });
await page.evaluate(async () => { if (window.__settleStable) await window.__settleStable(); });

const shots = [];
for (let i = 0; i < FRAMES; i++) {
  if (i) await page.waitForTimeout(GAP);
  const t = Date.now();
  shots.push({ t, b64: (await page.screenshot()).toString('base64') });
}

const res = await page.evaluate(async ({ shots, RAD }) => {
  const load = async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    // A luma band from the upper third: guaranteed sky in every framing here,
    // and high-pass filtered so a slow gradient cannot dominate the match.
    const x0 = Math.round(img.width * 0.18), x1 = Math.round(img.width * 0.82);
    const y0 = Math.round(img.height * 0.05), y1 = Math.round(img.height * 0.35);
    const w = x1 - x0, h = y1 - y0;
    const raw = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = ((y + y0) * img.width + (x + x0)) * 4;
      raw[y * w + x] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    }
    // High pass: subtract a wide box blur.
    const R = 12, hp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -R; dy <= R; dy += 4) for (let dx = -R; dx <= R; dx += 4) {
        const yy = Math.min(h - 1, Math.max(0, y + dy)), xx = Math.min(w - 1, Math.max(0, x + dx));
        s += raw[yy * w + xx]; n++;
      }
      hp[y * w + x] = raw[y * w + x] - s / n;
    }
    return { hp, w, h };
  };
  const imgs = [];
  for (const s of shots) imgs.push({ t: s.t, ...(await load(s.b64)) });

  const match = (A, B) => {
    const { w, h } = A;
    let best = { dx: 0, dy: 0, score: -Infinity }, sumsq = 0;
    for (let i = 0; i < A.hp.length; i++) sumsq += A.hp[i] * A.hp[i];
    for (let dy = -RAD; dy <= RAD; dy++) for (let dx = -RAD; dx <= RAD; dx++) {
      let s = 0, n = 0;
      for (let y = RAD; y < h - RAD; y += 2) for (let x = RAD; x < w - RAD; x += 2) {
        s += A.hp[y * w + x] * B.hp[(y + dy) * w + (x + dx)]; n++;
      }
      const score = s / Math.max(1, n);
      if (score > best.score) best = { dx, dy, score };
    }
    // Normalised peak, for "is this a match at all".
    let selfS = 0, n2 = 0;
    for (let y = RAD; y < h - RAD; y += 2) for (let x = RAD; x < w - RAD; x += 2) {
      selfS += A.hp[y * w + x] * A.hp[y * w + x]; n2++;
    }
    best.peak = best.score / Math.max(1e-6, selfS / Math.max(1, n2));
    return best;
  };

  const pairs = [];
  for (let i = 1; i < imgs.length; i++) {
    const m = match(imgs[i - 1], imgs[i]);
    pairs.push({ dt: (imgs[i].t - imgs[i - 1].t) / 1000, ...m });
  }
  return { pairs, W: imgs[0].w };
}, { shots, RAD });

const degPerPx = v.fov / H;
console.log(`\n── cloud drift · ${viewName} h${hour} · fov ${v.fov}°, ${W}x${H}`);
console.log('   pair    dt     dx      dy    px/s    deg/s   dir      peak');
for (const p of res.pairs) {
  const sp = Math.hypot(p.dx, p.dy) / p.dt;
  const dir = (Math.atan2(-p.dy, p.dx) * 180 / Math.PI + 360) % 360;
  console.log(`   ${String(res.pairs.indexOf(p) + 1).padStart(4)}  ${p.dt.toFixed(2)}s  ` +
    `${String(p.dx).padStart(5)}  ${String(p.dy).padStart(5)}  ${sp.toFixed(2).padStart(6)}  ` +
    `${(sp * degPerPx).toFixed(3).padStart(6)}   ${dir.toFixed(0).padStart(4)}°  ${p.peak.toFixed(3)}`);
}
console.log();
await browser.close();
