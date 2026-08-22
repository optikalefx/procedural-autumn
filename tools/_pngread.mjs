/**
 * A PNG reader, in Node, with no browser and no native dependency.
 *
 * `waterstats.mjs` decodes its frames by launching Chromium and drawing them
 * into an OffscreenCanvas. That is fine for a tool that already needs a page,
 * and it is two seconds of browser launch for a tool that does not. This reads
 * the bytes.
 *
 * Supports what this project actually produces: bit depth 8, colour type 2
 * (RGB) or 6 (RGBA), non-interlaced, all five scanline filters. Anything else
 * throws by name rather than returning quiet nonsense — a decoder that
 * silently mis-reads a frame is the "instrument that is confidently wrong"
 * docs/CRITIC_PROTOCOL.md warns about.
 */
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

export function readPNG(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);
  let off = 8;
  let W = 0, H = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      W = data.readUInt32BE(0); H = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8) throw new Error(`${path}: bit depth ${depth}, only 8 supported`);
  if (ctype !== 2 && ctype !== 6) throw new Error(`${path}: colour type ${ctype}, only 2 and 6 supported`);
  if (interlace !== 0) throw new Error(`${path}: interlaced, not supported`);

  const bpp = ctype === 6 ? 4 : 3;
  const stride = W * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * H);

  for (let y = 0; y < H; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = src[x];
      switch (ft) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`${path}: unknown scanline filter ${ft} on row ${y}`);
      }
      cur[x] = v;
    }
  }

  // Normalise to RGB, which is all any caller here wants.
  const px = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    px[i * 3] = out[i * bpp];
    px[i * 3 + 1] = out[i * bpp + 1];
    px[i * 3 + 2] = out[i * bpp + 2];
  }
  return { w: W, h: H, px };
}
