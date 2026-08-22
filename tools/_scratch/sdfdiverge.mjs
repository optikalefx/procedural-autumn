#!/usr/bin/env node
// How far apart are the TWO signed distance fields this project carries?
//   A  Water.js's own exact 2 m Felzenszwalb-Huttenlocher transform of the raw
//      texel wet mask, which feeds the aShore attribute, the mesh's dilation
//      criterion and its dead-quad cull.
//   B  hydroField.js's sdf: the same transform of the CLEANED mask, span-
//      rationed-blurred, stored at 4 m by area-averaging.
// docs/WATER_SMOOTH_STATE.md asked for this number and nobody had taken it.
// Sampled where it is USED: at the 4 m lattice points Water.js evaluates on.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { buildHydroField } from '../../src/world/hydroField.js';
import { buildWaterSurface } from '../../src/world/Water.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/bakes/manifest.json'), 'utf8'));
const e = man.entries.find((x) => x.res === 1536 && x.hash === man.current);
const b = fs.readFileSync(path.join(ROOT, 'public/bakes', e.file));
const bake = decodeBake(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const world = { res: bake.res, worldSize: bake.worldSize, half: bake.worldSize / 2,
  texel: bake.worldSize / bake.res, height: bake.height, water: bake.water };
const hydro = buildHydroField(bake.height, bake.water, bake.res, bake.worldSize);
const dbg = {};
buildWaterSurface(world, dbg);           // no world.hydro -> the exact path
const { sdfAt, G, quadM, drawn, vOk, VG } = dbg;
const HALF = world.half, HR = hydro.res, HT = hydro.texel;
const hAt = (x, z) => {
  let gx = (x + HALF) / HT - 0.25, gz = (z + HALF) / HT - 0.25;
  gx = Math.min(HR - 1.001, Math.max(0, gx)); gz = Math.min(HR - 1.001, Math.max(0, gz));
  const x0 = gx | 0, z0 = gz | 0, tx = gx - x0, tz = gz - z0;
  const p = hydro.sdf;
  return (p[z0 * HR + x0] * (1 - tx) + p[z0 * HR + x0 + 1] * tx) * (1 - tz)
       + (p[(z0 + 1) * HR + x0] * (1 - tx) + p[(z0 + 1) * HR + x0 + 1] * tx) * tz;
};
const bins = { 'band |A|<=8 m': [], 'ring -15..-8 m': [], 'all |A|<=32 m': [] };
let signFlip = 0, signN = 0, deadFlip = 0;
// Only vertices the MESH uses: one of the four quads touching them emitted
// triangles. The unrestricted figure is dominated by ponds under 40 m2 that
// hydroField's crumb rule deletes and Water.js's own speck rule deletes too,
// at a bigger threshold — so neither field's answer there is ever read.
const touchedX = (vx, vz) => {
  for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
    const cz = vz + dz, cx = vx + dx;
    if (cz >= 0 && cz < G && cx >= 0 && cx < G && drawn[cz * G + cx]) return true;
  }
  return false;
};
for (let vz = 0; vz <= G; vz++) for (let vx = 0; vx <= G; vx++) {
  if (!touchedX(vx, vz)) continue;
  const x = -HALF + vx * quadM, z = -HALF + vz * quadM;
  // Both capped at Water.js's SHORE_CAP, or the 32-vs-48 cap difference alone
  // reads as a flat 16 m error over every open lake.
  const cap = (v) => Math.max(-32, Math.min(32, v));
  const a = cap(sdfAt(x, z)), h = cap(hAt(x, z)), d = h - a;
  if (Math.abs(a) <= 8) bins['band |A|<=8 m'].push(Math.abs(d));
  if (a <= -8 && a >= -15) bins['ring -15..-8 m'].push(Math.abs(d));
  if (Math.abs(a) <= 32) bins['all |A|<=32 m'].push(Math.abs(d));
  if (Math.abs(a) <= 32) { signN++; if ((a > 0) !== (h > 0)) signFlip++; }
  // the two decisions the field actually makes in Water.js
  if ((a < -11) !== (h < -11)) deadFlip++;
}
const p = (arr, q) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))].toFixed(2) : '-';
for (const [k, v] of Object.entries(bins)) {
  v.sort((m, n) => m - n);
  console.log(`${k.padEnd(16)} n=${String(v.length).padStart(7)}  |B-A|  p50 ${p(v, .5)}  p90 ${p(v, .9)}  p99 ${p(v, .99)}  max ${p(v, 1)} m`);
}
console.log(`sign disagreement inside 32 m: ${signFlip} of ${signN} (${(signFlip / signN * 100).toFixed(3)}%)`);
console.log(`SURF_DEAD_M(-11) cull would flip on ${deadFlip} of ${signN} mesh vertices (${(deadFlip / signN * 100).toFixed(3)}%)`);
void vOk; void VG;

// ── the defect the divergence causes, not just its size ────────────────────
// The fragment shader's outer guard is on hydro (`1 - smoothstep(2,9,-HY.g)`),
// so the shader draws wherever hydro's sdf > -9. The mesh is culled on
// Water.js's own field at SURF_DEAD_M = -11. Where the two disagree by more
// than the two metres of margin between 9 and 11, the shader wants to draw and
// there is no triangle.
{
  let want = 0, wantNoGeo = 0, geoNoWant = 0, n = 0;
  const worst = [];
  for (let vz = 0; vz <= G; vz++) for (let vx = 0; vx <= G; vx++) {
    if (!touchedX(vx, vz)) continue;
    const x = -HALF + vx * quadM, z = -HALF + vz * quadM;
    const a = sdfAt(x, z), h = hAt(x, z);
    n++;
    if (h > -9) { want++; if (a < -11) wantNoGeo++; }
    if (a > -11 && h < -9) geoNoWant++;
    const d = Math.abs(Math.max(-32, Math.min(32, h)) - Math.max(-32, Math.min(32, a)));
    if (d > 6) worst.push({ d, x, z, a, h });
  }
  console.log(`\nshader wants to draw (hydro > -9 m): ${want} of ${n} mesh vertices`);
  console.log(`  ...and Water.js's field culls the quad (its sdf < -11 m): ${wantNoGeo} (${(wantNoGeo / want * 100).toFixed(3)}% of them)`);
  console.log(`  geometry kept where the shader draws nothing:            ${geoNoWant}`);
  worst.sort((p, q) => q.d - p.d);
  console.log(`  vertices disagreeing by > 6 m: ${worst.length}`);
  for (const w of worst.slice(0, 6)) console.log(`     ${w.d.toFixed(1)} m at (${w.x.toFixed(0)}, ${w.z.toFixed(0)})  water ${w.a.toFixed(1)}  hydro ${w.h.toFixed(1)}`);
}
