/**
 * Minimal RGB PNG writer, shared by the offline labs.
 *
 * Lifted out of terrain-lab.mjs when waterlab.mjs needed the same thing. There
 * is no image library in this tree on purpose — the capture path goes through
 * a real browser, and a native dependency that has to compile is a per-machine
 * failure the harness cannot afford.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import zlib from 'node:zlib';

let CRC_TABLE = null;

function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

/** img = { w, h, px } where px is w*h*3 bytes of RGB. */
export function writePNG(path, img) {
  const { w, h, px } = img;
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  const src = Buffer.from(px.buffer, px.byteOffset, px.length);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    src.copy(raw, y * stride + 1, y * w * 3, (y + 1) * w * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const out = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out);
}

/** A blank RGB canvas with a simple put/blit surface. */
export function canvas(w, h, fill = [24, 24, 28]) {
  const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { px[i * 3] = fill[0]; px[i * 3 + 1] = fill[1]; px[i * 3 + 2] = fill[2]; }
  return {
    w, h, px,
    put(x, y, r, g, b) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const k = (y * w + x) * 3;
      px[k] = r; px[k + 1] = g; px[k + 2] = b;
    },
    blit(img, ox, oy) {
      for (let y = 0; y < img.h; y++) {
        const ty = oy + y; if (ty < 0 || ty >= h) continue;
        for (let x = 0; x < img.w; x++) {
          const tx = ox + x; if (tx < 0 || tx >= w) continue;
          const s = (y * img.w + x) * 3, d = (ty * w + tx) * 3;
          px[d] = img.px[s]; px[d + 1] = img.px[s + 1]; px[d + 2] = img.px[s + 2];
        }
      }
    },
  };
}

// ── a 5x7 bitmap font, enough to label a contact sheet ───────────────────────
const GLYPHS = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110',
  C: '01110100011000010000100001000101110', D: '11110100011000110001100011000111110',
  E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001',
  I: '11111001000010000100001000010011111', J: '00111000100001000010000101001001100',
  K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110001100011000110001', N: '10001110011010110011100011000110001',
  O: '01110100011000110001100011000101110', P: '11110100011000111110100001000010000',
  Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100',
  U: '10001100011000110001100011000101110', V: '10001100011000110001100010101000100',
  W: '10001100011000110001101011101110001', X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111',
  0: '01110100111010110011110011000101110', 1: '00100011000010000100001000010001110',
  2: '01110100010000100110010001000011111', 3: '11111000100010000010000011000101110',
  4: '00010001100101010010111110001000010', 5: '11111100001111000001000011000101110',
  6: '00110010001000011110100011000101110', 7: '11111000010001000100001000010000100',
  8: '01110100011000101110100011000101110', 9: '01110100011000101111000010001001100',
  '.': '00000000000000000000000000110001100', '-': '00000000000000011111000000000000000',
  '/': '00001000100010001000100010001000000', ':': '00000011000110000000011000110000000',
  '%': '11001110010001000100010001001100111', ' ': '00000000000000000000000000000000000',
  '_': '00000000000000000000000000000011111', '+': '00000001000010011111001000010000000',
  '(': '00010001000100001000010000010000010', ')': '01000001000001000010000100010001000',
  '=': '00000000001111100000111110000000000', ',': '00000000000000000000000001100001000',
};

export function text(img, x, y, s, rgb = [235, 235, 235], scale = 1) {
  let cx = x;
  for (const ch of String(s).toUpperCase()) {
    const g = GLYPHS[ch] ?? GLYPHS[' '];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (g[r * 5 + c] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = cx + c * scale + sx, py = y + r * scale + sy;
            if (px < 0 || py < 0 || px >= img.w || py >= img.h) continue;
            const k = (py * img.w + px) * 3;
            img.px[k] = rgb[0]; img.px[k + 1] = rgb[1]; img.px[k + 2] = rgb[2];
          }
        }
      }
    }
    cx += 6 * scale;
  }
}
