#!/usr/bin/env node
/** Scratch: the N brightest pixels of a capture, with their RGB. */
import { readPNG } from './../_pngread.mjs';
const img = readPNG(process.argv[2]);
const n = Number(process.argv[3] ?? 12);
const W = img.w, H = img.h, ch = 3, d = img.px;
const all = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * ch;
  const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  all.push([l, x, y, d[i], d[i + 1], d[i + 2]]);
}
all.sort((a, b) => b[0] - a[0]);
const seen = [];
for (const p of all) {
  if (seen.length >= n) break;
  if (seen.some((q) => Math.abs(q[1] - p[1]) < 12 && Math.abs(q[2] - p[2]) < 12)) continue;
  seen.push(p);
}
for (const [l, x, y, r, g, b] of seen) console.log(`(${x},${y}) rgb(${r},${g},${b}) luma ${(l / 255).toFixed(3)}`);
