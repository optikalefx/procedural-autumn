import { decodePNG, meanRect } from './rock_px.mjs';
const [file, ...pts] = process.argv.slice(2);
const img = decodePNG(file);
console.log(`${file} ${img.w}x${img.h}`);
for (const p of pts) {
  const [x, y, r = 3] = p.split(',').map(Number);
  const m = meanRect(img, (x - r) / img.w, (y - r) / img.h, (x + r) / img.w, (y + r) / img.h);
  const R = m.r, G = m.g, B = m.b;
  console.log(`(${x},${y}) srgb(${R.toFixed(0)},${G.toFixed(0)},${B.toFixed(0)}) ratio 1:${(G/R).toFixed(3)}:${(B/R).toFixed(3)} luma ${m.luma.toFixed(1)}`);
}
