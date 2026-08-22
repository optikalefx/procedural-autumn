#!/usr/bin/env node
// What does the terrain's submerged `damp` band actually cover, and how steep
// is the ground under it? Domain: 0.02 < hydro.depth < 0.50.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { buildHydroField } from '../../src/world/hydroField.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/bakes/manifest.json'), 'utf8'));
const e = man.entries.find((x) => x.res === 1536 && x.hash === man.current);
const b = fs.readFileSync(path.join(ROOT, 'public/bakes', e.file));
const bake = decodeBake(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const R = bake.res, WS = bake.worldSize, T = WS / R;
const hydro = buildHydroField(bake.height, bake.water, R, WS);
const HR = hydro.res;
// coarse bed gradient over L metres, central difference on the baked bed
const coarse = (L) => {
  const s = Math.max(1, Math.round(L / T));
  const g = new Float32Array(R * R);
  for (let z = 0; z < R; z++) for (let x = 0; x < R; x++) {
    const xa = Math.max(0, x - s), xb = Math.min(R - 1, x + s);
    const za = Math.max(0, z - s), zb = Math.min(R - 1, z + s);
    const dx = (bake.height[z * R + xb] - bake.height[z * R + xa]) / ((xb - xa) * T);
    const dz = (bake.height[zb * R + x] - bake.height[za * R + x]) / ((zb - za) * T);
    g[z * R + x] = Math.hypot(dx, dz);
  }
  return g;
};
const g7 = coarse(7), g14 = coarse(14);
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
const cols = { texel: [], c7: [], c14: [] };
let n = 0;
for (let z = 0; z < HR; z++) for (let x = 0; x < HR; x++) {
  const k = z * HR + x;
  const d = hydro.depth[k];
  if (!(d > 0.02 && d < 0.50)) continue;
  n++;
  const i = (z * 2) * R + x * 2;
  cols.texel.push(bake.slope[i]); cols.c7.push(g7[i]); cols.c14.push(g14[i]);
}
console.log(`damp-band cells: ${n} (${(n / (HR * HR) * 100).toFixed(2)}% of map, ${(n * 16 / 1e6).toFixed(3)} km2)`);
for (const key of ['texel', 'c7', 'c14']) {
  const a = cols[key].slice().sort((p, q) => p - q);
  const over = (t) => (a.filter((v) => v > t).length / a.length * 100).toFixed(1);
  console.log(`${key.padEnd(6)} p10 ${pct(a, .1).toFixed(2)} p50 ${pct(a, .5).toFixed(2)} p90 ${pct(a, .9).toFixed(2)} p99 ${pct(a, .99).toFixed(2)}   >0.58 ${over(0.58)}%  >0.85 ${over(0.85)}%  >1.15 ${over(1.15)}%`);
}
// ...and the same restricted to the mouth massif patch, where the loop is.
const inBox = (x, z) => x > 1020 && x < 1160 && z > -700 && z < -580;
for (const key of ['texel', 'c7', 'c14']) {
  const a = [];
  for (let z = 0; z < HR; z++) for (let x = 0; x < HR; x++) {
    const k = z * HR + x, d = hydro.depth[k];
    if (!(d > 0.02 && d < 0.50)) continue;
    const wx = -WS / 2 + (x + 0.5) * hydro.texel, wz = -WS / 2 + (z + 0.5) * hydro.texel;
    if (!inBox(wx, wz)) continue;
    const i = (z * 2) * R + x * 2;
    a.push(key === 'texel' ? bake.slope[i] : key === 'c7' ? g7[i] : g14[i]);
  }
  a.sort((p, q) => p - q);
  console.log(`LOOP BOX ${key.padEnd(6)} n=${a.length} p10 ${pct(a, .1).toFixed(2)} p50 ${pct(a, .5).toFixed(2)} p90 ${pct(a, .9).toFixed(2)}  >0.58 ${(a.filter(v => v > 0.58).length / a.length * 100).toFixed(0)}%`);
}

// ── how much of the band is drawn over water the surface shader is not ─────
// `cliff` is water_surface.js's hand-off to the falls system:
//   smoothstep(0.58, 1.15, (bed - bedAhead) / |aheadV|) * moving,
//   aheadV = flowDir * (1.5 + span * 1.6)
// and past 0.60 of it the surface deletes itself outright.
{
  const bl = (arr, res, tx, x, z) => {
    const HALF = WS / 2;
    let gx = (x + HALF) / tx - 0.5, gz = (z + HALF) / tx - 0.5;
    gx = Math.min(res - 1.001, Math.max(0, gx)); gz = Math.min(res - 1.001, Math.max(0, gz));
    const x0 = gx | 0, z0 = gz | 0, fx = gx - x0, fz = gz - z0;
    return (arr[z0 * res + x0] * (1 - fx) + arr[z0 * res + x0 + 1] * fx) * (1 - fz)
         + (arr[(z0 + 1) * res + x0] * (1 - fx) + arr[(z0 + 1) * res + x0 + 1] * fx) * fz;
  };
  const sm = (a, c, x) => { const t = Math.min(1, Math.max(0, (x - a) / (c - a))); return t * t * (3 - 2 * t); };
  let n = 0, handed = 0, gated058 = 0, gated085 = 0, both = 0, missed = 0;
  for (let z = 0; z < HR; z++) for (let x = 0; x < HR; x++) {
    const k = z * HR + x, d = hydro.depth[k];
    if (!(d > 0.02 && d < 0.50)) continue;
    const wx = -WS / 2 + (x + 0.25) * hydro.texel, wz = -WS / 2 + (z + 0.25) * hydro.texel;
    const vx = bl(bake.flowVX, R, T, wx, wz), vz = bl(bake.flowVZ, R, T, wx, wz);
    const L = Math.hypot(vx, vz);
    const span = hydro.span[k];
    const ah = 1.5 + span * 1.6;
    const tx2 = L > 1e-4 ? vx / L : 0, tz2 = L > 1e-4 ? vz / L : 0;
    const drop = (bl(bake.height, R, T, wx, wz) - bl(bake.height, R, T, wx + tx2 * ah, wz + tz2 * ah)) / ah;
    const cliff = sm(0.58, 1.15, drop);
    const s = bake.slope[(z * 2) * R + x * 2];
    const g58 = sm(0.58, 1.15, s), g85 = sm(0.85, 1.40, s);
    n++;
    if (cliff > 0.60) handed++;
    gated058 += g58; gated085 += g85;
    if (cliff > 0.60 && g58 > 0.60) both++;
    if (cliff > 0.60 && g58 < 0.30) missed++;
  }
  console.log(`\nband cells ${n}`);
  console.log(`  the surface has handed to the falls system (cliff > 0.60): ${handed} (${(handed / n * 100).toFixed(1)}%)`);
  console.log(`  mean withdrawal, gate 0.58-1.15 on slope:                  ${(gated058 / n * 100).toFixed(1)}% of the band`);
  console.log(`  mean withdrawal, gate 0.85-1.40 on slope:                  ${(gated085 / n * 100).toFixed(1)}% of the band`);
  console.log(`  handed off AND gated by 0.58-1.15:                         ${both} (${(both / Math.max(1, handed) * 100).toFixed(0)}% of handed)`);
  console.log(`  handed off and STILL painted (gate < 0.30):                ${missed} (${(missed / Math.max(1, handed) * 100).toFixed(0)}% of handed)`);
}
