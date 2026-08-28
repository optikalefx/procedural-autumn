#!/usr/bin/env node
/**
 * Nearest-neighbour magnified crop, on this tree's own PNG reader/writer.
 * `_scratch/rcrop.mjs` goes out of memory on a 1600x900 roast capture.
 *
 *   node tools/_scratch/mcrop.mjs in.png out.png x0,y0,x1,y1 [zoom]
 */
import { readPNG } from '../_pngread.mjs';
import { writePNG } from '../_png.mjs';

const [inF, outF, rect, zoomS] = process.argv.slice(2);
const [x0, y0, x1, y1] = rect.split(',').map(Number);
const Z = Math.max(1, Math.round(Number(zoomS || 2)));
const img = readPNG(inF);
const w = (x1 - x0) * Z, h = (y1 - y0) * Z;
const px = new Uint8Array(w * h * 3);
for (let y = 0; y < h; y++) {
  const sy = y0 + Math.floor(y / Z);
  for (let x = 0; x < w; x++) {
    const sx = x0 + Math.floor(x / Z);
    const s = (sy * img.w + sx) * 3, d = (y * w + x) * 3;
    px[d] = img.px[s]; px[d + 1] = img.px[s + 1]; px[d + 2] = img.px[s + 2];
  }
}
writePNG(outF, { w, h, px });
console.log(outF, `${w}x${h}`);
