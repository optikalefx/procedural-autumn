#!/usr/bin/env node
/**
 * Terrain lab — bake the heightfield in Node and report objective statistics
 * plus a hillshaded PNG preview. Far faster than round-tripping the browser,
 * and it makes terrain tuning measurable instead of vibes-based.
 *
 *   node tools/terrain-lab.mjs --res 768 --out shots/lab.png
 *   node tools/terrain-lab.mjs --res 768 --stage tectonic     # skip erosion
 *   node tools/terrain-lab.mjs --res 768 --stage eroded       # skip relaxation
 */
import { TerrainGen } from '../src/world/TerrainGen.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import zlib from 'node:zlib';

let CRC_TABLE = null;

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const RES = parseInt(arg('res', '768'), 10);
const WORLD = parseFloat(arg('world', '3072'));
const STAGE = arg('stage', 'full');   // tectonic | eroded | relaxed | full
const OUT = arg('out', 'shots/lab.png');
const SEED = parseInt(arg('seed', '20261018'), 10);

const gen = new TerrainGen({ res: RES, worldSize: WORLD, seed: SEED, maxAltitude: parseFloat(arg('alt', '340')) });

const t0 = Date.now();
gen.height = new Float32Array(RES * RES);
gen.hardness = new Float32Array(RES * RES);
gen.sediment = new Float32Array(RES * RES);
gen._tectonic();
const tTect = Date.now();
let stats = { tectonic: roughness(gen.height, RES, WORLD / RES) };

if (STAGE !== 'tectonic') {
  gen._erode(Math.round(RES * RES * 0.14));
  stats.eroded = roughness(gen.height, RES, WORLD / RES);
}
const tEro = Date.now();
if (STAGE !== 'tectonic' && STAGE !== 'eroded') {
  gen._relax();
  stats.relaxed = roughness(gen.height, RES, WORLD / RES);
}
const tRel = Date.now();

let hydro = {};
if (STAGE === 'full') {
  gen._fillDepressions(); gen._flowAccumulation(); gen._carveChannels();
  gen._waterSurface(); gen._climate();
  stats.carved = roughness(gen.height, RES, WORLD / RES);
  hydro = {
    waterfalls: gen.waterfalls.length,
    riverTrunks: gen.riverPolylines.length,
    lakeCells: gen.lakes.cellCount,
    riverCoverPct: +(count(gen.riverMask, v => v > 0) / (RES * RES) * 100).toFixed(2),
  };
}

console.log(JSON.stringify({
  res: RES, seed: SEED,
  timingMs: { tectonic: tTect - t0, erode: tEro - tTect, relax: tRel - tEro, total: Date.now() - t0 },
  stats, hydro,
  hypsometry: hypsometry(gen.height),
}, null, 2));

writePNG(OUT, hillshade(gen.height, RES, WORLD / RES, gen));
console.log('preview:', OUT);

// ── metrics ────────────────────────────────────────────────────────────────
function roughness(h, R, texel) {
  let sum = 0, n = 0, mx = 0, over = 0;
  let mn = Infinity, mxh = -Infinity;
  for (let y = 1; y < R - 1; y++) {
    for (let x = 1; x < R - 1; x++) {
      const i = y * R + x;
      const d = Math.abs(h[i] - h[i + 1]);
      sum += d; n++;
      if (d > mx) mx = d;
      if (d > texel) over++;                 // steeper than 45°
      if (h[i] < mn) mn = h[i];
      if (h[i] > mxh) mxh = h[i];
    }
  }
  return {
    meanStepM: +(sum / n).toFixed(3),
    meanSlopeDeg: +(Math.atan((sum / n) / texel) * 180 / Math.PI).toFixed(1),
    maxStepM: +mx.toFixed(2),
    over45Pct: +(over / n * 100).toFixed(2),
    minH: +mn.toFixed(1), maxH: +mxh.toFixed(1),
  };
}
function count(a, f) { let c = 0; for (let i = 0; i < a.length; i++) if (f(a[i])) c++; return c; }
function hypsometry(h) {
  const bands = [0, 0, 0, 0, 0, 0];   // <0, 0-40, 40-100, 100-180, 180-260, >260
  for (let i = 0; i < h.length; i++) {
    const v = h[i];
    const b = v < 0 ? 0 : v < 40 ? 1 : v < 100 ? 2 : v < 180 ? 3 : v < 260 ? 4 : 5;
    bands[b]++;
  }
  const labels = ['water<0', 'lowland0-40', 'foothill40-100', 'mid100-180', 'high180-260', 'peak>260'];
  return Object.fromEntries(bands.map((v, i) => [labels[i], +(v / h.length * 100).toFixed(1)]));
}

// ── hillshade preview (RGB) ────────────────────────────────────────────────
function hillshade(h, R, texel, g) {
  const px = new Uint8Array(R * R * 3);
  const lx = -0.55, ly = 0.62, lz = 0.56;
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const i = y * R + x;
      const xm = y * R + Math.max(0, x - 1), xp = y * R + Math.min(R - 1, x + 1);
      const ym = Math.max(0, y - 1) * R + x, yp = Math.min(R - 1, y + 1) * R + x;
      const gx = (h[xp] - h[xm]) / (2 * texel);
      const gz = (h[yp] - h[ym]) / (2 * texel);
      const len = Math.hypot(gx, 1, gz);
      const nx = -gx / len, ny = 1 / len, nz = -gz / len;
      let l = Math.max(0, nx * lx + ny * ly + nz * lz);
      l = 0.22 + 0.78 * Math.pow(l, 0.85);

      const alt = h[i];
      let r, gg, b;
      if (alt < 0)          { r = 60;  gg = 90;  b = 130; }
      else if (alt < 40)    { r = 200; gg = 165; b = 80;  }
      else if (alt < 100)   { r = 165; gg = 150; b = 85;  }
      else if (alt < 180)   { r = 145; gg = 135; b = 120; }
      else if (alt < 260)   { r = 155; gg = 150; b = 160; }
      else                  { r = 225; gg = 225; b = 235; }

      if (g && g.riverMask && g.riverMask[i] > 0.02) { r = 70; gg = 130; b = 190; l = Math.max(l, 0.75); }

      px[i * 3]     = Math.min(255, r * l);
      px[i * 3 + 1] = Math.min(255, gg * l);
      px[i * 3 + 2] = Math.min(255, b * l);
    }
  }
  return { w: R, h: R, px };
}

function writePNG(path, img) {
  const { w, h, px } = img;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(px.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const chunks = [];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', zlib.deflateSync(raw, { level: 6 })));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat(chunks));
}
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
