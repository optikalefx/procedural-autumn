#!/usr/bin/env node
/**
 * Ownership masks and masked colour statistics for ground cover.
 *
 *   node tools/_scratch/covermask.mjs --base B.png --hidden groundCover=NC.png \
 *        --hidden grass=NG.png --region 0.00,0.10,0.55,0.90
 *
 * For each `--hidden name=file`, the mask is the set of pixels that CHANGED
 * when that system was hidden — i.e. the pixels the system actually owns. Then
 * it reports, over the mask and over its complement inside the region:
 *
 *   share of region, luma mean/p05/p95, chroma mean, neutral%, vivid%,
 *   mean sRGB, and a coarse 12-bin hue histogram.
 *
 * Written because four reference targets in the last five critic passes were
 * quoted on rects picked by eye, and a rect picked that way over `river`'s
 * hillside contains grass, rock, terrain and cover in one average.
 *
 * Pure node — a minimal PNG decoder, no playwright, so it needs no capture
 * lock and can run while a capture is in flight.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

function decode(buf) {
  let p = 8, w = 0, h = 0, bd = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8) throw new Error('bit depth ' + bd);
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 4 ? 2 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let o = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[o++]; const line = raw.subarray(o, o + stride); o += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev ? prev[i] : 0, c = (prev && i >= ch) ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const many = (n) => argv.reduce((acc, a, i) => (a === `--${n}` ? [...acc, argv[i + 1]] : acc), []);

const BASE = arg('base');
if (!BASE) { console.error('need --base <png>'); process.exit(1); }
const TH = Number(arg('thresh', 6));
const REGION = arg('region') ? arg('region').split(',').map(Number) : [0, 0, 1, 1];
const GRID = argv.includes('--grid');

const base = decode(fs.readFileSync(BASE));
const { w, h } = base;
// A world-data mask (tools/_scratch/cover/rivermap.mjs) beats any rect: it is
// "the pixels whose terrain hit is nearer than D and steeper than S", which is
// a statement about the ground rather than about a screenshot.
const MASKF = arg('mask');
let region = null;
if (MASKF) {
  const mi = decode(fs.readFileSync(MASKF));
  if (mi.w !== w || mi.h !== h) { console.error(`mask size mismatch: ${MASKF}`); process.exit(1); }
  region = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) region[i] = mi.data[i * mi.ch] > 127 ? 1 : 0;
}
const rx0 = Math.round(REGION[0] * w), ry0 = Math.round(REGION[1] * h);
const rx1 = Math.round((REGION[0] + REGION[2]) * w), ry1 = Math.round((REGION[1] + REGION[3]) * h);

const stat = () => ({ n: 0, r: 0, g: 0, b: 0, c: 0, neutral: 0, vivid: 0, L: [], hue: new Array(12).fill(0) });
const push = (a, r, g, b) => {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), ch = mx - mn;
  a.n++; a.r += R; a.g += G; a.b += B; a.c += ch;
  a.L.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
  if (ch < 0.06) a.neutral++;
  if (ch > 0.35) a.vivid++;
  if (ch > 0.04) {
    let hh;
    if (mx === R) hh = ((G - B) / ch + 6) % 6;
    else if (mx === G) hh = (B - R) / ch + 2;
    else hh = (R - G) / ch + 4;
    a.hue[Math.min(11, Math.floor((hh / 6) * 12))]++;
  }
};
const report = (name, a, denom) => {
  if (!a.n) { console.log(`  ${name.padEnd(14)} (empty)`); return; }
  a.L.sort((x, y) => x - y);
  const q = (p) => a.L[Math.min(a.L.length - 1, Math.floor(p * a.L.length))];
  const mean = a.L.reduce((s, v) => s + v, 0) / a.n;
  const sd = Math.sqrt(a.L.reduce((s, v) => s + (v - mean) ** 2, 0) / a.n);
  const rgb = [a.r / a.n * 255, a.g / a.n * 255, a.b / a.n * 255].map((v) => Math.round(v));
  const hueTop = a.hue.map((v, i) => [i, v]).sort((x, y) => y[1] - x[1]).slice(0, 3)
    .filter((p) => p[1] > 0)
    .map(([i, v]) => `${i * 30}°:${Math.round(100 * v / a.n)}%`).join(' ');
  console.log(`  ${name.padEnd(14)} ${String((100 * a.n / denom).toFixed(1)).padStart(5)}%  `
    + `luma ${mean.toFixed(3)} [${q(0.05).toFixed(3)}..${q(0.95).toFixed(3)}] sd ${sd.toFixed(3)}  `
    + `chroma ${(a.c / a.n).toFixed(3)}  neut ${(100 * a.neutral / a.n).toFixed(1)}%  `
    + `vivid ${(100 * a.vivid / a.n).toFixed(1)}%  rgb(${rgb.join(',')})  hue ${hueTop}`);
};

console.log(`${BASE}  ${w}x${h}  region ${REGION.join(',')}${MASKF ? `  mask ${MASKF}` : ''}`);

const inR = (x, y) => (!region || region[y * w + x]);
const regionAll = stat();
for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) {
  if (!inR(x, y)) continue;
  const i = (y * w + x) * base.ch;
  push(regionAll, base.data[i], base.data[i + 1], base.data[i + 2]);
}
const denom = regionAll.n;
report('REGION(all)', regionAll, denom);

const owned = new Uint8Array(w * h);
for (const spec of many('hidden')) {
  const eq = spec.indexOf('=');
  const name = spec.slice(0, eq), file = spec.slice(eq + 1);
  const other = decode(fs.readFileSync(file));
  if (other.w !== w || other.h !== h) { console.error(`size mismatch: ${file}`); continue; }
  const a = stat();
  const GX = 16, GY = 10;
  const grid = Array.from({ length: GY }, () => new Array(GX).fill(0));
  const cell = Array.from({ length: GY }, () => new Array(GX).fill(0));
  for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) {
    if (!inR(x, y)) continue;
    const i = (y * w + x) * base.ch, j = (y * w + x) * other.ch;
    const d = (Math.abs(base.data[i] - other.data[j])
      + Math.abs(base.data[i + 1] - other.data[j + 1])
      + Math.abs(base.data[i + 2] - other.data[j + 2])) / 3;
    const gy = Math.min(GY - 1, Math.floor((y - ry0) / (ry1 - ry0) * GY));
    const gx = Math.min(GX - 1, Math.floor((x - rx0) / (rx1 - rx0) * GX));
    cell[gy][gx]++;
    if (d > TH) {
      grid[gy][gx]++;
      owned[y * w + x] = 1;
      push(a, base.data[i], base.data[i + 1], base.data[i + 2]);
    }
  }
  report(name, a, denom);
  if (GRID) for (let gy = 0; gy < GY; gy++)
    console.log('      ' + grid[gy].map((v, gx) => String(Math.round(100 * v / (cell[gy][gx] || 1))).padStart(4)).join(''));
}

if (many('hidden').length) {
  const rest = stat();
  for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) {
    if (!inR(x, y) || owned[y * w + x]) continue;
    const i = (y * w + x) * base.ch;
    push(rest, base.data[i], base.data[i + 1], base.data[i + 2]);
  }
  report('UNOWNED', rest, denom);
}
