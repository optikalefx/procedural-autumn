#!/usr/bin/env node
/**
 * Rocks author's pixel probe. Decodes a PNG with node's own zlib (no browser,
 * no capture slot) and reports the mean RGB / luma of rectangles given in
 * fractions of the image, so "is the boulder darker than the grass beside it"
 * is a measurement rather than a squint.
 *
 *   node tools/_scratch/rock_px.mjs shots/rocks/r1/meadow.png 0.1,0.6,0.2,0.8
 *
 * Rect is x0,y0,x1,y1 in 0..1. With no rects it prints a coarse grid of the
 * frame so you can find the region you want.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export function decodePNG(file) {
  const buf = readFileSync(file);
  let p = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} not supported`);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error(`colour type ${colorType} not supported`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[q++];
    const row = raw.subarray(q, q + stride); q += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev ? prev[i] : 0;
      const c = (prev && i >= ch) ? prev[i - ch] : 0;
      let v = row[i];
      switch (filter) {
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: break;
      }
      cur[i] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

/** Mean colour over a rect given in 0..1 fractions. */
export function meanRect(img, x0, y0, x1, y1) {
  const { w, h, ch, data } = img;
  const ax = Math.max(0, Math.round(x0 * w)), bx = Math.min(w, Math.round(x1 * w));
  const ay = Math.max(0, Math.round(y0 * h)), by = Math.min(h, Math.round(y1 * h));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = ay; y < by; y++) {
    for (let x = ax; x < bx; x++) {
      const i = y * w * ch + x * ch;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  if (!n) return null;
  r /= n; g /= n; b /= n;
  return { r, g, b, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b, n };
}

const fmt = (m) => m
  ? `rgb(${m.r.toFixed(0).padStart(3)},${m.g.toFixed(0).padStart(3)},${m.b.toFixed(0).padStart(3)}) luma ${m.luma.toFixed(1).padStart(5)}`
  : 'empty';

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, ...rects] = process.argv.slice(2);
  const img = decodePNG(file);
  console.log(`${file}  ${img.w}x${img.h}`);
  if (!rects.length) {
    const N = 6;
    for (let j = 0; j < N; j++) {
      const cols = [];
      for (let i = 0; i < N; i++) {
        const m = meanRect(img, i / N, j / N, (i + 1) / N, (j + 1) / N);
        cols.push(m.luma.toFixed(0).padStart(4));
      }
      console.log(cols.join(''));
    }
  }
  for (const r of rects) {
    const [x0, y0, x1, y1] = r.split(',').map(Number);
    console.log(`  [${r}] ${fmt(meanRect(img, x0, y0, x1, y1))}`);
  }
}

// ── crop, magnified, back out to PNG ─────────────────────────────────────────
// So a boulder can actually be looked at rather than measured. Nearest-neighbour
// on purpose: I am judging facet edges, and a smoothing filter would hide the
// exact defect I am hunting.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

export function writePNG(file, w, h, rgb) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

export function crop(img, x0, y0, x1, y1, zoom = 1) {
  const ax = Math.round(x0 * img.w), ay = Math.round(y0 * img.h);
  const cw = Math.round((x1 - x0) * img.w), chh = Math.round((y1 - y0) * img.h);
  const ow = cw * zoom, oh = chh * zoom;
  const out = Buffer.alloc(ow * oh * 3);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(img.w - 1, ax + ((x / zoom) | 0));
      const sy = Math.min(img.h - 1, ay + ((y / zoom) | 0));
      const s = sy * img.w * img.ch + sx * img.ch, d = (y * ow + x) * 3;
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2];
    }
  }
  return { w: ow, h: oh, rgb: out };
}
