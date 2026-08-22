#!/usr/bin/env node
// buildWaterSurface, exact-transform path vs hydro-field path, 7 runs, median.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { buildHydroField } from '../../src/world/hydroField.js';
import { buildWaterSurface } from '../../src/world/Water.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/bakes/manifest.json'), 'utf8'));
const e = man.entries.find((x) => x.res === 1536 && x.hash === man.current);
const b = fs.readFileSync(path.join(ROOT, 'public/bakes', e.file));
const bake = decodeBake(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const mk = () => ({ res: bake.res, worldSize: bake.worldSize, half: bake.worldSize / 2,
  texel: bake.worldSize / bake.res, height: bake.height, water: bake.water });
const med = (a) => a.slice().sort((p, q) => p - q)[a.length >> 1];
const N = +(process.argv.includes('--n') ? process.argv[process.argv.indexOf('--n') + 1] : 7);
const hyT = [];
let hydro;
for (let i = 0; i < N; i++) { const t = process.hrtime.bigint(); hydro = buildHydroField(bake.height, bake.water, bake.res, bake.worldSize); hyT.push(Number(process.hrtime.bigint() - t) / 1e6); }
const runs = { exact: [], hydro: [] };
let a, c;
for (let i = 0; i < N; i++) {
  const w1 = mk(); let t = process.hrtime.bigint(); a = buildWaterSurface(w1); runs.exact.push(Number(process.hrtime.bigint() - t) / 1e6);
  const w2 = mk(); w2.hydro = hydro; t = process.hrtime.bigint(); c = buildWaterSurface(w2); runs.hydro.push(Number(process.hrtime.bigint() - t) / 1e6);
}
// MIN as well as median, and read the min. This machine is shared with two
// other authors' capture and bake runs and never goes quiet, so the median
// carries their load; the minimum over N reps is the closest thing to an
// uncontended number that can be had here. The RATIO is stable across load and
// is what should be quoted.
const mn = (a2) => Math.min(...a2);
console.log(`buildHydroField          min ${mn(hyT).toFixed(0)}  median ${med(hyT).toFixed(0)} ms`);
console.log(`buildWaterSurface exact  min ${mn(runs.exact).toFixed(0)}  median ${med(runs.exact).toFixed(0)} ms   quads ${a.quads} tris ${a.triangles}`);
console.log(`buildWaterSurface hydro  min ${mn(runs.hydro).toFixed(0)}  median ${med(runs.hydro).toFixed(0)} ms   quads ${c.quads} tris ${c.triangles}`);
console.log(`saved  min ${(mn(runs.exact) - mn(runs.hydro)).toFixed(0)} ms   median ${(med(runs.exact) - med(runs.hydro)).toFixed(0)} ms   ratio ${(mn(runs.hydro) / mn(runs.exact)).toFixed(2)} / ${(med(runs.hydro) / med(runs.exact)).toFixed(2)}`);
