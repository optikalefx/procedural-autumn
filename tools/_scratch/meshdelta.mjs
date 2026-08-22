#!/usr/bin/env node
// Which quads the hydro-fed shore field costs the mesh, and whether the shader
// would have drawn anything in them.
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
const hydro = buildHydroField(bake.height, bake.water, bake.res, bake.worldSize);
const dA = {}, dB = {};
buildWaterSurface(mk(), dA);
const w2 = mk(); w2.hydro = hydro; buildWaterSurface(w2, dB);
const { G, quadM } = dA, HALF = bake.worldSize / 2, HR = hydro.res, HT = hydro.texel;
const hAt = (arr, x, z) => {
  let gx = (x + HALF) / HT - 0.25, gz = (z + HALF) / HT - 0.25;
  gx = Math.min(HR - 1.001, Math.max(0, gx)); gz = Math.min(HR - 1.001, Math.max(0, gz));
  const x0 = gx | 0, z0 = gz | 0, tx = gx - x0, tz = gz - z0;
  return (arr[z0 * HR + x0] * (1 - tx) + arr[z0 * HR + x0 + 1] * tx) * (1 - tz)
       + (arr[(z0 + 1) * HR + x0] * (1 - tx) + arr[(z0 + 1) * HR + x0 + 1] * tx) * tz;
};
let lost = 0, gained = 0, lostDraw = 0, lostWet = 0, gainedWet = 0;
const worst = [];
for (let k = 0; k < G * G; k++) {
  const a = dA.drawn[k], c = dB.drawn[k];
  if (a === c) continue;
  const cx = k % G, cz = (k / G) | 0;
  const x = -HALF + (cx + 0.5) * quadM, z = -HALF + (cz + 0.5) * quadM;
  const s = hAt(hydro.sdf, x, z), d = hAt(hydro.depth, x, z);
  if (a && !c) { lost++; if (s > -9) { lostDraw++; worst.push({ s, d, x, z }); } if (d > 0) lostWet++; }
  else { gained++; if (d > 0) gainedWet++; }
}
console.log(`quads lost ${lost}, gained ${gained}`);
console.log(`  of the lost: shader would draw there (hydro sdf > -9 m): ${lostDraw}`);
console.log(`  of the lost: hydro says WET (depth > 0):                 ${lostWet}`);
console.log(`  of the gained: hydro says WET:                           ${gainedWet}`);
worst.sort((p, q) => q.s - p.s);
for (const w of worst.slice(0, 5)) console.log(`     sdf ${w.s.toFixed(1)} depth ${w.d.toFixed(2)} at (${w.x.toFixed(0)}, ${w.z.toFixed(0)})`);
