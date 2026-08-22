// Scratch: crop and upscale a region of a PNG so it can be looked at.
//   node tools/_scratch/crop.mjs in.png out.png x y w h [scale]
import { readPNG } from '../_pngread.mjs';
import { writePNG } from '../_png.mjs';
const [inp, outp, X, Y, W, H, S] = process.argv.slice(2);
const x0 = +X, y0 = +Y, w = +W, h = +H, s = +(S ?? 3);
const img = readPNG(inp);
const bpp = img.px.length / (img.w * img.h);
const out = new Uint8Array(w * s * h * s * 3);
for (let y = 0; y < h * s; y++) {
  for (let x = 0; x < w * s; x++) {
    const sx = Math.min(img.w - 1, x0 + Math.floor(x / s));
    const sy = Math.min(img.h - 1, y0 + Math.floor(y / s));
    const o = (sy * img.w + sx) * bpp, d = (y * w * s + x) * 3;
    out[d] = img.px[o]; out[d + 1] = img.px[o + 1]; out[d + 2] = img.px[o + 2];
  }
}
writePNG(outp, { w: w * s, h: h * s, px: out });
console.log(outp, w * s, 'x', h * s);
