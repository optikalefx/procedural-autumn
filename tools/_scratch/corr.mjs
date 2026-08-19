// Measure fine corrugation in the baked heightfield on steep massif faces.
import { readFileSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';

const f = process.argv[2] || 'public/bakes/world-20261018-1536-b0006627.pab';
const b = decodeBake(readFileSync(f).buffer);
const R = b.res, W = b.worldSize, texel = W / R, h = b.height, N = R * R;
console.log('res', R, 'texel', texel.toFixed(3));

function boxBlur(src, radiusM, passes) {
  const rad = Math.max(1, Math.round(radiusM / texel));
  const inv = 1 / (rad * 2 + 1);
  const cl = v => (v < 0 ? 0 : v >= R ? R - 1 : v);
  let a = Float32Array.from(src);
  const t = new Float32Array(N);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < R; y++) { const row = y * R; let s = 0;
      for (let k = -rad; k <= rad; k++) s += a[row + cl(k)];
      for (let x = 0; x < R; x++) { t[row + x] = s * inv; s += a[row + cl(x + rad + 1)] - a[row + cl(x - rad)]; } }
    for (let x = 0; x < R; x++) { let s = 0;
      for (let k = -rad; k <= rad; k++) s += t[cl(k) * R + x];
      for (let y = 0; y < R; y++) { a[y * R + x] = s * inv; s += t[cl(y + rad + 1) * R + x] - t[cl(y - rad) * R + x]; } }
  }
  return a;
}

// slope from height
const slope = new Float32Array(N);
for (let y = 1; y < R - 1; y++) for (let x = 1; x < R - 1; x++) {
  const i = y * R + x;
  const gx = (h[i + 1] - h[i - 1]) / (2 * texel), gz = (h[i + R] - h[i - R]) / (2 * texel);
  slope[i] = Math.hypot(gx, gz);
}

// steep massif mask: slope > 0.7 and altitude > 100
const mask = new Uint8Array(N);
let mc = 0;
for (let i = 0; i < N; i++) if (slope[i] > 0.7 && h[i] > 100) { mask[i] = 1; mc++; }
console.log('steep cells', mc, (100 * mc / N).toFixed(2) + '%');

const radii = [3, 6, 10, 16, 26, 44, 70];
const blurs = radii.map(r => boxBlur(h, r, 1));
let prev = h;
const out = [];
for (let k = 0; k < radii.length; k++) {
  let s = 0, n = 0;
  for (let i = 0; i < N; i++) if (mask[i]) { const d = prev[i] - blurs[k][i]; s += d * d; n++; }
  out.push({ band: (k === 0 ? '<' : radii[k - 1] + '-') + radii[k] + 'm', rms: +Math.sqrt(s / n).toFixed(3) });
  prev = blurs[k];
}
console.log('height RMS per band on steep faces:');
console.table(out);

// Same on flat/basin ground for reference
let mask2 = new Uint8Array(N), m2c = 0;
for (let i = 0; i < N; i++) if (slope[i] < 0.25 && h[i] < 90) { mask2[i] = 1; m2c++; }
prev = h; const out2 = [];
for (let k = 0; k < radii.length; k++) {
  let s = 0, n = 0;
  for (let i = 0; i < N; i++) if (mask2[i]) { const d = prev[i] - blurs[k][i]; s += d * d; n++; }
  out2.push({ band: (k === 0 ? '<' : radii[k - 1] + '-') + radii[k] + 'm', rms: +Math.sqrt(s / n).toFixed(3) });
  prev = blurs[k];
}
console.log('height RMS per band on gentle basin ground:');
console.table(out2);

// Slope-field ripple: how much of `slope` variance is at fine scale on steep faces
const sB = boxBlur(slope, 12, 1);
let sd = 0, n3 = 0, smean = 0;
for (let i = 0; i < N; i++) if (mask[i]) { const d = slope[i] - sB[i]; sd += d * d; smean += slope[i]; n3++; }
console.log('steep-face slope mean', (smean / n3).toFixed(3), ' fine(<12m) slope RMS', Math.sqrt(sd / n3).toFixed(3));

// Directional autocorrelation of the fine height residual along the fall line
const fine = new Float32Array(N);
const b16 = blurs[3]; // 16 m
for (let i = 0; i < N; i++) fine[i] = h[i] - b16[i];
// pick a steep region: find densest 128x128 window of mask
let best = -1, bx = 0, by = 0;
for (let y = 0; y < R - 128; y += 32) for (let x = 0; x < R - 128; x += 32) {
  let c = 0;
  for (let j = 0; j < 128; j += 2) for (let i2 = 0; i2 < 128; i2 += 2) c += mask[(y + j) * R + x + i2];
  if (c > best) { best = c; bx = x; by = y; }
}
console.log('densest steep window at grid', bx, by, 'world', (bx * texel - W / 2).toFixed(0), (by * texel - W / 2).toFixed(0));
const lags = [];
for (let L = 1; L <= 24; L++) {
  let num = 0, d0 = 0, n = 0;
  for (let j = 0; j < 128; j++) for (let i2 = 0; i2 < 128 - L; i2++) {
    const a = fine[(by + j) * R + bx + i2], c = fine[(by + j) * R + bx + i2 + L];
    num += a * c; d0 += a * a; n++;
  }
  lags.push({ lagM: +(L * texel).toFixed(1), acf: +(num / d0).toFixed(3) });
}
console.log('ACF of <16 m height residual, X direction:');
console.table(lags);
