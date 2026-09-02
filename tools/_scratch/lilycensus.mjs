#!/usr/bin/env node
/**
 * Lily pad census — run the REAL placement code over the whole baked map in
 * node, no browser, and say where the colonies landed.
 *
 *   node tools/_scratch/lilycensus.mjs [--seed 20261018] [--top 12]
 *
 * Prints: cells touched, colonies, pads, the size/depth/shore distributions,
 * and the densest colony centres — which is what a capture wants to be posed
 * at. The water level here is the raw grid (no drawn mesh in node), which is
 * within a few cm of the sheet on a lake and is fine for a census.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { LilyScatter } from '../../src/vegetation/lily_scatter.js';
// The scatter is seeded from WorldConfig.SEED in the game whatever bake is
// loaded (the Rocks/Trees convention), so the census must be too.
import { SEED as SCATTER_SEED } from '../../src/world/WorldConfig.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SEED = parseInt(arg('seed', '20261018'), 10);
const TOP = parseInt(arg('top', '12'), 10);
const RES = arg('res', '1536');

const file = readdirSync('public/bakes').find((f) => f.startsWith(`world-${SEED}-${RES}-`));
if (!file) { console.error(`no bake for seed ${SEED} at ${RES}`); process.exit(1); }
const buf = readFileSync(`public/bakes/${file}`);
const data = decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const world = new WorldData(data, SEED);

const CELL = 64;
const scatter = new LilyScatter(world, SCATTER_SEED);
const half = world.half;
const n = Math.ceil(world.worldSize / CELL);
const t0 = performance.now();
let cells = 0, wetCells = 0, clusters = 0;
const pads = [];
const perCell = [];
for (let cz = -n / 2; cz < n / 2; cz++) {
  for (let cx = -n / 2; cx < n / 2; cx++) {
    cells++;
    const before = pads.length;
    const c = scatter.generateCell(cx, cz, CELL, pads);
    if (pads.length > before) { wetCells++; perCell.push({ cx, cz, n: pads.length - before, c }); }
    clusters += c;
  }
}
const ms = performance.now() - t0;

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const rs = pads.map((p) => p.r);
const depths = pads.map((p) => world.getWaterDepth(p.x, p.z));
const sdfs = pads.map((p) => world.getHydro(p.x, p.z, {}).sdf);
const ages = pads.map((p) => p.age);
console.log(`seed ${SEED}  ${cells} cells scanned in ${ms.toFixed(0)} ms  (${(ms / cells).toFixed(2)} ms/cell)`);
console.log(`cells with pads ${wetCells}   colonies ${clusters}   pads ${pads.length}   pads/colony ${(pads.length / Math.max(1, clusters)).toFixed(1)}`);
if (pads.length) {
  console.log(`radius   p05 ${pct(rs, .05).toFixed(2)}  p50 ${pct(rs, .5).toFixed(2)}  p95 ${pct(rs, .95).toFixed(2)} m`);
  console.log(`depth    p05 ${pct(depths, .05).toFixed(2)}  p50 ${pct(depths, .5).toFixed(2)}  p95 ${pct(depths, .95).toFixed(2)} m`);
  console.log(`shore    p05 ${pct(sdfs, .05).toFixed(1)}  p50 ${pct(sdfs, .5).toFixed(1)}  p95 ${pct(sdfs, .95).toFixed(1)} m inside`);
  console.log(`age      p50 ${pct(ages, .5).toFixed(2)}  p90 ${pct(ages, .9).toFixed(2)}   turned(>0.5) ${(100 * ages.filter((a) => a > 0.5).length / ages.length).toFixed(0)}%`);
  const variants = [0, 0, 0, 0]; for (const p of pads) variants[p.variant]++;
  console.log(`variants ${variants.join(' / ')}`);
}
perCell.sort((a, b) => b.n - a.n);
console.log(`\nbusiest cells (centre x,z  pads  colonies):`);
for (const c of perCell.slice(0, TOP)) {
  // The centroid of the cell's pads, which is where to point a camera.
  const mine = pads.filter((p) => p.cell === c.cx * 100003 + c.cz);
  const mx = mine.reduce((s, p) => s + p.x, 0) / mine.length;
  const mz = mine.reduce((s, p) => s + p.z, 0) / mine.length;
  const wy = world.getWaterHeight(mx, mz);
  console.log(`  ${mx.toFixed(0).padStart(6)},${mz.toFixed(0).padStart(6)}  y ${wy?.toFixed(1)}  ${String(c.n).padStart(4)}  ${c.c}`);
}
