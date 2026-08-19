#!/usr/bin/env node
/**
 * Rock ownership mask. Given a rocks-ON and a rocks-OFF capture of the same
 * anchor (cloud shadow frozen in both), find the pixels the rock system owns
 * and report what they measure, bucketed by how bright they are so the lit and
 * shadow families can be judged against their own anchors.
 *
 *   node tools/_scratch/rockmask.mjs shots/rocks/r0on/peaks.png shots/rocks/r0off/peaks.png
 */
import { decodePNG } from './rock_px.mjs';

const anchors = {
  lit:    [195, 191, 204],   // #c3bfcc
  shadow: [ 92,  90, 117],   // #5c5a75
};

function stats(list) {
  if (!list.length) return null;
  let r = 0, g = 0, b = 0;
  for (const p of list) { r += p[0]; g += p[1]; b += p[2]; }
  const n = list.length;
  r /= n; g /= n; b /= n;
  return { r, g, b, n, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
}
const fmt = (s) => s
  ? `srgb(${s.r.toFixed(0)},${s.g.toFixed(0)},${s.b.toFixed(0)})  1:${(s.g / s.r).toFixed(3)}:${(s.b / s.r).toFixed(3)}  luma ${s.luma.toFixed(1)}  n=${s.n}`
  : '(none)';

const [onF, offF, thrArg] = process.argv.slice(2);
const THR = Number(thrArg ?? 14);
const A = decodePNG(onF), B = decodePNG(offF);
if (A.w !== B.w || A.h !== B.h) throw new Error('size mismatch');

const px = [];
for (let y = 0; y < A.h; y++) {
  for (let x = 0; x < A.w; x++) {
    const i = y * A.w * A.ch + x * A.ch, j = y * B.w * B.ch + x * B.ch;
    const d = Math.abs(A.data[i] - B.data[j]) + Math.abs(A.data[i + 1] - B.data[j + 1])
            + Math.abs(A.data[i + 2] - B.data[j + 2]);
    if (d > THR) px.push([A.data[i], A.data[i + 1], A.data[i + 2], y]);
  }
}
px.sort((p, q) => (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2])
                - (0.2126 * q[0] + 0.7152 * q[1] + 0.0722 * q[2]));
const n = px.length;
console.log(`${onF}  rock pixels ${n} (${(100 * n / (A.w * A.h)).toFixed(2)}% of frame)`);
if (!n) process.exit(0);
console.log(`  all      ${fmt(stats(px))}`);
console.log(`  darkest25 ${fmt(stats(px.slice(0, n >> 2)))}`);
console.log(`  brightest25 ${fmt(stats(px.slice(n - (n >> 2))))}`);
console.log(`  anchors  lit srgb(195,191,204) 1:0.980:1.046 luma 191.5 | shadow srgb(92,90,117) 1:0.978:1.272 luma 92.3`);
void anchors;
