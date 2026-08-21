#!/usr/bin/env node
/**
 * twinkle — does the star field actually scintillate on screen, and by how much?
 *
 *   node tools/_scratch/twinkle.mjs --frames 10 --gap 0.4
 *
 * starpan.mjs deliberately freezes uTime so camera instability cannot be
 * confused with scintillation. This is the opposite instrument: the camera is
 * nailed down and only TIME moves. Find the stars once, then read the same
 * pixels in every later frame and report how far each one swings.
 *
 * How to read it: `depth` is (max-min)/max of a star's contrast over the run.
 * 0 means the field is frozen. The interesting question this answers is not
 * "is there a sin() in the shader" — there is — but whether it survives the
 * tonemapper and reaches the display at a size a viewer can see.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { POSE_SRC } from '../_pose.mjs';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const W = 1600, H = 900;
const FRAMES = parseInt(arg('frames', '10'), 10);
const GAP = parseFloat(arg('gap', '0.4'));
const DIR = resolve(arg('dir', 'shots/_scratch/twinkle'));
const URL = arg('url', 'http://localhost:5180');

await acquire('twinkle');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

let frozen = null;
for (const p of ['review/anchors.json', 'shots/_anchors.json']) {
  if (!existsSync(p)) continue;
  try { frozen = { ...JSON.parse(readFileSync(p, 'utf8')), ...(frozen ?? {}) }; } catch { /* corrupt */ }
}
mkdirSync(DIR, { recursive: true });
const poseFn = new Function('P', POSE_SRC);
await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, 0);
await page.evaluate(poseFn, {
  v: { anchor: 'vista', height: 60, dist: 150, pitch: 0.55, fov: parseFloat(arg('fov','62')) },
  frozen, dynamic: ['vehicle'],
});
await page.evaluate(async () => { if (window.__settleStable) await window.__settleStable(); });

const shots = [];
for (let i = 0; i < FRAMES; i++) {
  if (i) await page.waitForTimeout(GAP * 1000);
  const out = `${DIR}/f${String(i).padStart(2, '0')}.png`;
  await page.screenshot({ path: out });
  shots.push(readFileSync(out).toString('base64'));
}

const res = await page.evaluate(async (b64s) => {
  const lums = [];
  let Wp = 0, Hp = 0;
  for (const b of b64s) {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b;
    await img.decode();
    Wp = img.width; Hp = Math.floor(img.height * 0.45);
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, Wp, Hp).data;
    const l = new Float32Array(Wp * Hp);
    for (let i = 0, n = Wp * Hp; i < n; i++) {
      const j = i * 4;
      l[i] = (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255;
    }
    lums.push(l);
  }
  // contrast of a pixel against its own 5x5 ring, in one frame
  const con = (l, x, y) => {
    let ring = 0, rn = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (Math.abs(dx) === 2 || Math.abs(dy) === 2) { ring += l[(y + dy) * Wp + (x + dx)]; rn++; }
    }
    return l[y * Wp + x] - ring / rn;
  };
  // stars from frame 0
  const stars = [];
  const l0 = lums[0];
  for (let y = 3; y < Hp - 3; y++) for (let x = 3; x < Wp - 3; x++) {
    const v = l0[y * Wp + x];
    let localMax = true;
    for (let dy = -2; dy <= 2 && localMax; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (!dx && !dy) continue;
      if (l0[(y + dy) * Wp + (x + dx)] > v) { localMax = false; break; }
    }
    if (!localMax) continue;
    if (con(l0, x, y) > 0.045) stars.push([x, y]);
  }
  const depths = [];
  for (const [x, y] of stars) {
    let mn = Infinity, mx = -Infinity;
    for (const l of lums) {
      // take the local peak in a 1px window: sub-pixel jitter is not twinkle
      let best = -Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        best = Math.max(best, con(l, x + dx, y + dy));
      }
      mn = Math.min(mn, best); mx = Math.max(mx, best);
    }
    if (mx > 0) depths.push({ mx, depth: (mx - mn) / mx });
  }
  depths.sort((a, b) => a.depth - b.depth);
  const q = (p) => depths.length ? depths[Math.min(depths.length - 1, Math.floor(p * depths.length))].depth : 0;
  const bright = depths.filter((d) => d.mx > 0.15).map((d) => d.depth).sort((a, b) => a - b);
  return {
    stars: stars.length,
    p10: q(0.10), p50: q(0.50), p90: q(0.90), max: q(0.999),
    brightN: bright.length,
    brightP50: bright.length ? bright[Math.floor(bright.length / 2)] : 0,
  };
}, shots);

console.log(`stars tracked ${res.stars}   over ${FRAMES} frames ${GAP}s apart`);
console.log(`swing depth (max-min)/max:  p10 ${res.p10.toFixed(3)}   p50 ${res.p50.toFixed(3)}` +
            `   p90 ${res.p90.toFixed(3)}   max ${res.max.toFixed(3)}`);
console.log(`bright stars (contrast>0.15): ${res.brightN}   p50 depth ${res.brightP50.toFixed(3)}`);
console.log(`frames: ${DIR}`);
await browser.close();
