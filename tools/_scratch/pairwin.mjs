#!/usr/bin/env node
/**
 * Stitched A/B pairs that are still at FULL PIXEL RESOLUTION.
 *
 * `ab.mjs --stitch` butts two 1600x900 frames into one 3200x900 image, and
 * every reader this project has downscales that by half — which is the exact
 * failure two rounds have now been warned about. Reading `-left.png` and
 * `-right.png` as separate files keeps the resolution and introduces a worse
 * problem: the second image is judged with fresh eyes and the first from
 * memory. In this round that produced 12 right-hand calls out of 14, on a key
 * that put the same arm on the right only 3 times — a position bias, not a
 * judgement, and it would have been read as a result.
 *
 * So: crop the SAME window out of both frames and butt those. Half the frame
 * width each, full height, one image, one look, no memory and no downscale.
 *
 *   node tools/_scratch/pairwin.mjs --dir shots/ab-r2 [--w 760] [--x 0.5]
 *
 * `--x` is the centre of the crop window as a fraction of frame width, so a
 * view whose subject is off-centre can be followed without recapturing.
 * Writes `<view>-WIN.png` beside the pair. Does NOT read KEY.json.
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import zlib from 'node:zlib';
import { readPNG } from '../_pngread.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const DIR = arg('dir', 'shots/ab');
const CW = parseInt(arg('w', '760'), 10);
const CX = parseFloat(arg('x', '0.5'));
const SEAM = 16;

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePNG(path, w, h, rgb) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    rgb.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

const views = [...new Set(readdirSync(DIR)
  .filter((f) => f.endsWith('-left.png'))
  .map((f) => basename(f, '-left.png')))].sort();

for (const v of views) {
  const L = readPNG(join(DIR, `${v}-left.png`));
  const R = readPNG(join(DIR, `${v}-right.png`));
  if (L.w !== R.w || L.h !== R.h) { console.error(`${v}: size mismatch`); continue; }
  const cw = Math.min(CW, L.w);
  const x0 = Math.max(0, Math.min(L.w - cw, Math.round(L.w * CX - cw / 2)));
  const W = cw * 2 + SEAM, H = L.h;
  const out = Buffer.alloc(W * H * 3);
  const ch = L.px.length / (L.w * L.h);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < cw; x++) {
      const s = (y * L.w + x0 + x) * ch;
      let d = (y * W + x) * 3;
      out[d] = L.px[s]; out[d + 1] = L.px[s + 1]; out[d + 2] = L.px[s + 2];
      d = (y * W + cw + SEAM + x) * 3;
      out[d] = R.px[s]; out[d + 1] = R.px[s + 1]; out[d + 2] = R.px[s + 2];
    }
  }
  writePNG(join(DIR, `${v}-WIN.png`), W, H, out);
  console.log(`${v}-WIN.png  ${W}x${H}  window x${x0}..${x0 + cw}`);
}
