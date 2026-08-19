#!/usr/bin/env node
// Diff two frames; report the bounding boxes and mean colour of changed regions.
import { readPNG, sample } from './wpx.mjs';
const [aF, bF, thrArg] = process.argv.slice(2);
const thr = parseInt(thrArg ?? '10', 10);
const A = readPNG(aF), B = readPNG(bF);
const CELL = 20;
const cw = Math.ceil(A.w / CELL), chh = Math.ceil(A.h / CELL);
const grid = new Float32Array(cw * chh);
const acc = new Float64Array(cw * chh * 3);
const cnt = new Float64Array(cw * chh);
for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
  const i = (y * A.w + x) * A.ch;
  const d = Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i+1] - B.data[i+1]) + Math.abs(A.data[i+2] - B.data[i+2]);
  if (d > thr) {
    const c = Math.floor(y / CELL) * cw + Math.floor(x / CELL);
    grid[c]++; acc[c*3] += A.data[i]; acc[c*3+1] += A.data[i+1]; acc[c*3+2] += A.data[i+2]; cnt[c]++;
  }
}
let rows = '';
let total = 0;
for (let cy = 0; cy < chh; cy++) {
  let line = '';
  for (let cx = 0; cx < cw; cx++) {
    const f = grid[cy*cw+cx] / (CELL*CELL); total += grid[cy*cw+cx];
    line += f > 0.6 ? '#' : f > 0.3 ? '+' : f > 0.08 ? '.' : ' ';
  }
  rows += String(cy*CELL).padStart(4) + ' ' + line + '\n';
}
console.log(`changed ${(100*total/(A.w*A.h)).toFixed(1)}% of pixels  (cell=${CELL}px, x0=0 step ${CELL})`);
console.log(rows);
// mean colour of the changed area in A
let r=0,g=0,b=0,n=0;
for (let c=0;c<cw*chh;c++){ r+=acc[c*3]; g+=acc[c*3+1]; b+=acc[c*3+2]; n+=cnt[c]; }
if (n) console.log('mean colour of changed pixels in A: rgb(' + [r/n,g/n,b/n].map(v=>Math.round(v)).join(',') + ')');
