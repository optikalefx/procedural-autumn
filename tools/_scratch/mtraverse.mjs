// Scratch: horizontal linear-luma traverse across a frame row.
//   node tools/_scratch/mtraverse.mjs img.png y x0 x1 [step]
import { readPNG } from '../_pngread.mjs';
const [p, Y, X0, X1, S] = process.argv.slice(2);
const img = readPNG(p); const bpp = img.px.length / (img.w * img.h);
const lin = (u) => { const c = u / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const step = +(S ?? 15);
let out = '';
for (let x = +X0; x <= +X1; x += step) {
  const o = ((+Y) * img.w + x) * bpp;
  const l = 0.2126 * lin(img.px[o]) + 0.7152 * lin(img.px[o + 1]) + 0.0722 * lin(img.px[o + 2]);
  out += `x=${String(x).padStart(4)} ${l.toFixed(3)}  [${img.px[o]},${img.px[o+1]},${img.px[o+2]}]\n`;
}
console.log(out);
