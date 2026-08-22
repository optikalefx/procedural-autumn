#!/usr/bin/env node
// Crop and nearest-neighbour magnify a capture, so a defect can be looked at
// at the scale it lives at instead of at the scale the frame was taken at.
//   node tools/_scratch/crop.mjs in.png out.png x y w h [zoom]
import fs from 'node:fs'; import zlib from 'node:zlib';
import { writePNG, canvas } from '../_png.mjs';
const [inp, outp, X, Y, W, H, Z = 3] = process.argv.slice(2);
const buf = fs.readFileSync(inp);
let off = 8, w = 0, h = 0, bd = 0, ct = 0; const idat = [];
while (off < buf.length) {
  const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
  if (type === 'IHDR') { w = buf.readUInt32BE(off + 8); h = buf.readUInt32BE(off + 12); bd = buf[off + 16]; ct = buf[off + 17]; }
  if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
  off += 12 + len;
}
if (bd !== 8) throw new Error('bit depth ' + bd);
const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : (() => { throw new Error('colour type ' + ct); })();
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = w * ch;
const px = Buffer.alloc(h * stride);
let p = 0;
for (let y = 0; y < h; y++) {
  const f = raw[p++];
  const row = y * stride, prev = row - stride;
  for (let i = 0; i < stride; i++) {
    const a = i >= ch ? px[row + i - ch] : 0;
    const b = y > 0 ? px[prev + i] : 0;
    const c = (y > 0 && i >= ch) ? px[prev + i - ch] : 0;
    let v = raw[p + i];
    if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
    else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
    px[row + i] = v & 255;
  }
  p += stride;
}
const x0 = +X, y0 = +Y, cw = +W, chh = +H, z = +Z;
const img = canvas(cw * z, chh * z);
for (let y = 0; y < chh * z; y++) {
  for (let x = 0; x < cw * z; x++) {
    const sx = Math.min(w - 1, x0 + ((x / z) | 0)), sy = Math.min(h - 1, y0 + ((y / z) | 0));
    const s = sy * stride + sx * ch, d = (y * cw * z + x) * 3;
    img.px[d] = px[s]; img.px[d + 1] = px[s + 1]; img.px[d + 2] = px[s + 2];
  }
}
writePNG(outp, img);
console.log('wrote', outp, cw * z + 'x' + chh * z);
