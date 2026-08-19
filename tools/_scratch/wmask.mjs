#!/usr/bin/env node
// Mean colour of the pixels that a system actually draws.
//   node tools/_scratch/wmask.mjs on.png off.png [threshold]
// Compares a frame with the system visible against the same frame with it
// hidden; every pixel that moved is water, so the statistic is taken over the
// real mask instead of over a rectangle guessed off a thumbnail.
import { readPNG } from './wpx.mjs';

const [aF, bF, thrArg] = process.argv.slice(2);
const thr = parseInt(thrArg ?? '6', 10);
const A = readPNG(aF), B = readPNG(bF);
let r = 0, g = 0, b = 0, n = 0;
let rB = 0, gB = 0, bB = 0;
let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
const lum = [];
for (let y = 0; y < A.h; y++) {
  for (let x = 0; x < A.w; x++) {
    const i = (y * A.w + x) * A.ch, j = (y * B.w + x) * B.ch;
    const d = Math.abs(A.data[i] - B.data[j]) + Math.abs(A.data[i + 1] - B.data[j + 1]) +
              Math.abs(A.data[i + 2] - B.data[j + 2]);
    if (d < thr * 3) continue;
    r += A.data[i]; g += A.data[i + 1]; b += A.data[i + 2];
    rB += B.data[j]; gB += B.data[j + 1]; bB += B.data[j + 2];
    lum.push((0.2126 * A.data[i] + 0.7152 * A.data[i + 1] + 0.0722 * A.data[i + 2]) / 255);
    n++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
}
if (!n) { console.log('no differing pixels'); process.exit(0); }
const fmt = (r, g, b) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const hex = '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  return `${hex} rgb(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)}) luma ${((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255).toFixed(3)} chroma ${((mx - mn) / 255).toFixed(3)}`;
};
lum.sort((p, q) => p - q);
const pct = (p) => lum[Math.min(lum.length - 1, Math.floor(p * lum.length))].toFixed(3);
console.log(`mask     ${n} px (${(100 * n / (A.w * A.h)).toFixed(1)}% of frame)  bbox ${minX},${minY} ${maxX - minX}x${maxY - minY}`);
console.log(`water    ${fmt(r / n, g / n, b / n)}`);
console.log(`behind   ${fmt(rB / n, gB / n, bB / n)}`);
console.log(`luma     p05 ${pct(0.05)}  p50 ${pct(0.5)}  p95 ${pct(0.95)}`);
