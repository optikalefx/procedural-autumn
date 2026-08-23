#!/usr/bin/env node
// Coverage of the water's own contribution: |with - without| as an ASCII map
// plus the fraction of the frame it composites over.
import { readPNG } from '../_pngread.mjs';
const a = readPNG(process.argv[2]), b = readPNG(process.argv[3]);
const W = a.w, H = a.h, ch = a.px.length / (a.w * a.h);
const A = a.px, B = b.px;
const cw = 96, chh = 42;
let strong = 0, any = 0, n = 0;
let out = '';
for (let ry = 0; ry < chh; ry++) {
  let row = '';
  for (let rx = 0; rx < cw; rx++) {
    let acc = 0, c = 0;
    const x0 = Math.floor(rx / cw * W), x1 = Math.floor((rx + 1) / cw * W);
    const y0 = Math.floor(ry / chh * H), y1 = Math.floor((ry + 1) / chh * H);
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * W + x) * ch;
      const d = (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2])) / 3;
      acc += d; c++;
    }
    const d = acc / c;
    row += d < 4 ? '.' : d < 16 ? ':' : d < 40 ? '+' : d < 80 ? '*' : '#';
  }
  out += row + '\n';
}
for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
  const i = (y * W + x) * ch;
  const d = (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2])) / 3;
  n++; if (d > 4) any++; if (d > 30) strong++;
}
console.log(out);
console.log(`water touches ${(any / n * 100).toFixed(1)}% of the frame, strongly ${(strong / n * 100).toFixed(1)}%`);
