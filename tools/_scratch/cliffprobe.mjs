#!/usr/bin/env node
// The water shader's `cliff` hand-off, evaluated offline on the real bake at
// the ghost loop. cliff = smoothstep(0.58,1.15,(bed-bedAhead)/|aheadV|)*moving
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { buildHydroField } from '../../src/world/hydroField.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/bakes/manifest.json'), 'utf8'));
const e = man.entries.find((x) => x.res === 1536 && x.hash === man.current);
const b = fs.readFileSync(path.join(ROOT, 'public/bakes', e.file));
const bake = decodeBake(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const R = bake.res, WS = bake.worldSize, HALF = WS / 2, T = WS / R;
const hydro = buildHydroField(bake.height, bake.water, R, WS);
const bl = (arr, res, tx, x, z, st = 1) => {
  let gx = (x + HALF) / tx - 0.5, gz = (z + HALF) / tx - 0.5;
  gx = Math.min(res - 1.001, Math.max(0, gx)); gz = Math.min(res - 1.001, Math.max(0, gz));
  const x0 = gx | 0, z0 = gz | 0, fx = gx - x0, fz = gz - z0;
  const g = (xx, zz) => arr[(zz * res + xx) * st];
  return (g(x0, z0) * (1 - fx) + g(x0 + 1, z0) * fx) * (1 - fz) + (g(x0, z0 + 1) * (1 - fx) + g(x0 + 1, z0 + 1) * fx) * fz;
};
const bed = (x, z) => bl(bake.height, R, T, x, z);
const sm = (a, c, x) => { const t = Math.min(1, Math.max(0, (x - a) / (c - a))); return t * t * (3 - 2 * t); };
console.log('   x       z    bed   hydro.d  span   flow|v|   drop/m   cliff   slope');
for (const [x, z] of [[1090, -644], [1082, -623], [1100, -640], [1054, -633], [1070, -636], [1110, -645], [1120, -650], [733, -646], [1040, -630]]) {
  const vx = bl(bake.flowVX, R, T, x, z), vz = bl(bake.flowVZ, R, T, x, z);
  const L = Math.hypot(vx, vz);
  const span = bl(hydro.span, hydro.res, hydro.texel, x, z);
  const tx = L > 1e-4 ? vx / L : 0, tz = L > 1e-4 ? vz / L : 0;
  const ah = 1.5 + span * 1.6;
  const drop = (bed(x, z) - bed(x + tx * ah, z + tz * ah)) / ah;
  const i = Math.round((z + HALF) / T) * R + Math.round((x + HALF) / T);
  console.log(`${String(x).padStart(5)} ${String(z).padStart(7)} ${bed(x, z).toFixed(1).padStart(6)} ${bl(hydro.depth, hydro.res, hydro.texel, x, z).toFixed(2).padStart(7)} ${span.toFixed(2).padStart(6)} ${L.toFixed(3).padStart(8)} ${drop.toFixed(3).padStart(8)} ${sm(0.58, 1.15, drop).toFixed(3).padStart(7)} ${bake.slope[i].toFixed(2).padStart(6)}`);
}

// riverMask (data.b) at the same points, plus the waterfall pool.
console.log('\n   x       z    riverMask   slope   hydro.depth   span   bake wet');
const bl2 = (arr, x, z) => bl(arr, R, T, x, z);
for (const [x, z] of [[1090, -644], [1100, -640], [1110, -645], [1054, -633], [733, -646], [1040, -630]]) {
  const i = Math.round((z + HALF) / T) * R + Math.round((x + HALF) / T);
  console.log(`${String(x).padStart(5)} ${String(z).padStart(7)} ${bl2(bake.riverMask, x, z).toFixed(3).padStart(10)} ${bake.slope[i].toFixed(2).padStart(7)} ${bl(hydro.depth, hydro.res, hydro.texel, x, z).toFixed(2).padStart(12)} ${bl(hydro.span, hydro.res, hydro.texel, x, z).toFixed(2).padStart(7)}   ${bake.water[i] > -9000 && bake.water[i] > bake.height[i] ? 'WET' : 'dry'}`);
}
