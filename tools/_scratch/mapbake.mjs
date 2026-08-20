#!/usr/bin/env node
/**
 * Render the HUD minimap's raster from a .pab bake, in Node.
 *
 *   node tools/_scratch/mapbake.mjs --res 1536 --out shots/ui/mapbake.png --scale 3
 *
 * It imports `sampleWorld` / `paintMap` from src/ui/hud_map.js, so what comes
 * out is exactly what the game draws — as of the water revision that is now
 * literally pixel for pixel, because the canvas-only river polyline stroke is
 * gone. No browser, no capture slot, ~1 s per iteration, which is the only
 * reason the palette and the water thresholds got more than two attempts each.
 *
 * To judge it, render at the size it is actually displayed (`--n 200 --scale 1`
 * on a dpr-2 screen) and look at *that*. `--scale 3` is for diagnosis only: an
 * enlarged review copy hides exactly the class of mistake this map has already
 * made twice.
 */
import { decodeBake } from '../../src/world/bakeFormat.js';
import { sampleWorld, paintMap } from '../../src/ui/hud_map.js';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import zlib from 'node:zlib';

let CRC_TABLE = null;

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const RES = arg('res', '1536');
const OUT = arg('out', 'shots/ui/mapbake.png');
const N = parseInt(arg('n', '512'), 10);
const SCALE = parseInt(arg('scale', '1'), 10);

const file = readdirSync('public/bakes').find((f) => f.includes(`-${RES}-`) && f.endsWith('.pab'));
if (!file) throw new Error(`no bake at res ${RES}`);
const buf = readFileSync(`public/bakes/${file}`);
const baked = decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
console.log(`${file}  res ${baked.res}  world ${baked.worldSize} m  h ${baked.minHeight.toFixed(1)}…${baked.maxHeight.toFixed(1)}`);

// What fraction of the world each threshold would call water.
const stat = (name, a) => {
  const s = [...a].sort((x, y) => x - y);
  const q = (f) => s[Math.floor(s.length * f)];
  console.log(`${name}: p50 ${q(0.5).toFixed(3)}  p90 ${q(0.9).toFixed(3)}  p99 ${q(0.99).toFixed(3)}  max ${s[s.length - 1].toFixed(3)}` +
    `   >0.1 ${(a.filter((v) => v > 0.1).length / a.length * 100).toFixed(1)}%` +
    `   >0.42 ${(a.filter((v) => v > 0.42).length / a.length * 100).toFixed(1)}%` +
    `   >0.7 ${(a.filter((v) => v > 0.7).length / a.length * 100).toFixed(1)}%`);
};
stat('riverMask', baked.riverMask);

const world = { res: baked.res, worldSize: baked.worldSize, height: baked.height,
                water: baked.water, riverMask: baked.riverMask };
const t0 = Date.now();
const f = sampleWorld(world, N);
const rgba = new Uint8ClampedArray(N * N * 4);
const iv = paintMap(f, N, world.worldSize, rgba);
console.log(`bake ${Date.now() - t0} ms   contour interval ${iv} m`);

// Nearest-neighbour upscale so a 512 px raster is reviewable by eye.
const W = N * SCALE;
const raw = Buffer.alloc((W * 3 + 1) * W);
for (let y = 0; y < W; y++) {
  const rowOff = y * (W * 3 + 1);
  raw[rowOff] = 0;
  const sy = (y / SCALE) | 0;
  for (let x = 0; x < W; x++) {
    const k = ((sy * N) + ((x / SCALE) | 0)) * 4;
    const o = rowOff + 1 + x * 3;
    raw[o] = rgba[k]; raw[o + 1] = rgba[k + 1]; raw[o + 2] = rgba[k + 2];
  }
}
writePNG(OUT, W, W, raw);
console.log(`wrote ${OUT} (${W}x${W})`);

function writePNG(path, w, h, rawData) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', zlib.deflateSync(rawData, { level: 6 })));
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
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
