#!/usr/bin/env node
// Crop (and optionally magnify) a region of a PNG so an artifact can be looked at.
import { readPNG } from './wpx.mjs';
import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

function writePNG(path, w, h, rgb) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    rgb.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  const chunks = [];
  const chunk = (type, data) => {
    const b = Buffer.alloc(8 + data.length + 4);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, 'ascii');
    data.copy(b, 8);
    const crcBuf = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    b.writeUInt32BE(crc32(crcBuf) >>> 0, 8 + data.length);
    chunks.push(b);
  };
  let T = null;
  function crc32(buf) {
    if (!T) { T = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c; } }
    let c = -1; for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 255] ^ (c >>> 8); return c ^ -1;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  chunk('IHDR', ihdr); chunk('IDAT', idat); chunk('IEND', Buffer.alloc(0));
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]));
}

const [src, out, x0, y0, cw, ch, magArg] = process.argv.slice(2);
const mag = parseInt(magArg ?? '2', 10);
const img = readPNG(src);
const X = +x0, Y = +y0, W = +cw, H = +ch;
const ow = W * mag, oh = H * mag;
const buf = Buffer.alloc(ow * oh * 3);
for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
  const sx = Math.min(img.w - 1, X + Math.floor(x / mag));
  const sy = Math.min(img.h - 1, Y + Math.floor(y / mag));
  const si = (sy * img.w + sx) * img.ch, di = (y * ow + x) * 3;
  buf[di] = img.data[si]; buf[di + 1] = img.data[si + 1]; buf[di + 2] = img.data[si + 2];
}
writePNG(out, ow, oh, buf);
console.log(out, ow + 'x' + oh);
