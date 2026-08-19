// Directional corrugation probe: is the fine residual on steep faces
// contour-parallel (i.e. isolines) or fall-line parallel (drainage grain)?
import { readFileSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';

const f = process.argv[2] || 'public/bakes/world-20261018-1536-b52f2ff5.pab';
const b = decodeBake(readFileSync(f).buffer);
const R = b.res, W = b.worldSize, texel = W / R, h = b.height, N = R * R;

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

const lp = boxBlur(h, Number(process.argv[3]||30), 1);
const res = new Float32Array(N);
for (let i = 0; i < N; i++) res[i] = h[i] - lp[i];

// smooth gradient for a stable fall-line direction
const sm = boxBlur(h, 40, 1);
const bil = (a, gx, gy) => {
  gx = Math.min(R - 1.001, Math.max(0, gx)); gy = Math.min(R - 1.001, Math.max(0, gy));
  const x = gx | 0, y = gy | 0, fx = gx - x, fy = gy - y, i = y * R + x;
  return a[i]*(1-fx)*(1-fy) + a[i+1]*fx*(1-fy) + a[i+R]*(1-fx)*fy + a[i+R+1]*fx*fy;
};

const slope = new Float32Array(N);
for (let y = 1; y < R - 1; y++) for (let x = 1; x < R - 1; x++) {
  const i = y * R + x;
  const gx = (h[i + 1] - h[i - 1]) / (2 * texel), gz = (h[i + R] - h[i - R]) / (2 * texel);
  slope[i] = Math.hypot(gx, gz);
}

const LAGS = 24;
const sumF = new Float64Array(LAGS + 1), sumC = new Float64Array(LAGS + 1);
let n0 = 0, var0 = 0;
for (let y = 40; y < R - 40; y++) for (let x = 40; x < R - 40; x++) {
  const i = y * R + x;
  if (slope[i] < 0.8 || h[i] < 110) continue;
  const gx = (sm[i + 1] - sm[i - 1]) / 2, gz = (sm[i + R] - sm[i - R]) / 2;
  const L = Math.hypot(gx, gz); if (L < 1e-4) continue;
  const fx = gx / L, fz = gz / L;      // fall line (downhill = -f)
  const cx = -fz, cz = fx;             // contour direction
  const v0 = res[i];
  var0 += v0 * v0; n0++;
  for (let k = 1; k <= LAGS; k++) {
    sumF[k] += v0 * bil(res, x + fx * k, y + fz * k);
    sumC[k] += v0 * bil(res, x + cx * k, y + cz * k);
  }
}
const v = var0 / n0;
console.log(`steep cells ${n0}  residual RMS ${Math.sqrt(v).toFixed(3)} m  texel ${texel.toFixed(2)} m`);
console.log('lag(m)  ACF-fallline  ACF-contour');
for (let k = 1; k <= LAGS; k++) {
  console.log(`${(k*texel).toFixed(1).padStart(6)}  ${(sumF[k]/n0/v).toFixed(3).padStart(12)}  ${(sumC[k]/n0/v).toFixed(3).padStart(11)}`);
}
