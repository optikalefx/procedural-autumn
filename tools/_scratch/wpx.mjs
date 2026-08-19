#!/usr/bin/env node
// Minimal PNG (8-bit truecolour/alpha) pixel sampler. No deps.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

export function readPNG(file) {
  const buf = readFileSync(file);
  let off = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bd !== 8) throw new Error('bit depth ' + bd + ' unsupported');
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : ct === 4 ? 2 : 0;
  if (!ch) throw new Error('colour type ' + ct + ' unsupported');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, y * stride + stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev ? prev[i] : 0;
      const c = (prev && i >= ch) ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

export function sample(img, x, y, rad = 3) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
    const xx = Math.min(img.w - 1, Math.max(0, x + dx)), yy = Math.min(img.h - 1, Math.max(0, y + dy));
    const i = (yy * img.w + xx) * img.ch;
    r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

if (process.argv[1].endsWith('wpx.mjs')) {
  const [file, ...pts] = process.argv.slice(2);
  const img = readPNG(file);
  console.log(`${file}  ${img.w}x${img.h}`);
  for (const p of pts) {
    let [x, y] = p.split(',').map(Number);
    if (x <= 1 && y <= 1) { x = Math.round(x * img.w); y = Math.round(y * img.h); }
    const c = sample(img, x, y);
    const mx = Math.max(...c), mn = Math.min(...c);
    console.log(`  (${x},${y}) ${hex(c)} rgb(${c}) sat=${mx ? ((mx - mn) / mx).toFixed(2) : 0}`);
  }
}
