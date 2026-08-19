import { readPNG, sample } from './wpx.mjs';
const img = readPNG(process.argv[2]);
const CELL = 40;
const cw = Math.ceil(img.w / CELL), chh = Math.ceil(img.h / CELL);
let out = '';
for (let cy = 0; cy < chh; cy++) {
  let line = String(cy * CELL).padStart(4) + ' ';
  for (let cx = 0; cx < cw; cx++) {
    let n = 0, tot = 0;
    for (let y = cy * CELL; y < Math.min(img.h, (cy + 1) * CELL); y += 4)
      for (let x = cx * CELL; x < Math.min(img.w, (cx + 1) * CELL); x += 4) {
        const i = (y * img.w + x) * img.ch; tot++;
        if (img.data[i + 2] > img.data[i] - 22) n++;
      }
    const f = n / Math.max(tot, 1);
    line += f > 0.85 ? 'W' : f > 0.5 ? 'w' : f > 0.2 ? '.' : ' ';
  }
  out += line + '\n';
}
console.log('cols step ' + CELL + 'px from x=0');
console.log(out);
