#!/usr/bin/env node
/** Scratch: print a small pixel neighbourhood around a coordinate as RGB. */
import { readPNG } from './../_pngread.mjs';
const img = readPNG(process.argv[2]);
const cx = Number(process.argv[3]), cy = Number(process.argv[4]);
const rad = Number(process.argv[5] ?? 5);
const W = img.w, d = img.px;
for (let y = cy - rad; y <= cy + rad; y++) {
  const row = [];
  for (let x = cx - rad; x <= cx + rad; x++) {
    const i = (y * W + x) * 3;
    row.push(`${String(d[i]).padStart(3)},${String(d[i + 1]).padStart(3)},${String(d[i + 2]).padStart(3)}`);
  }
  console.log(row.join(' | '));
}
