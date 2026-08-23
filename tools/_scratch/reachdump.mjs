#!/usr/bin/env node
// Dump one reach: what the trace sampled, what the surface became, what the carve did.
import { TerrainGen } from '../../src/world/TerrainGen.js';
const res = parseInt(process.argv[2] || '768', 10);
const tx = parseFloat(process.argv[3]), tz = parseFloat(process.argv[4]);
const gen = new TerrainGen({ res, worldSize: 3072, seed: 20261018, maxAltitude: 340, onProgress: () => {} });
gen.generate();
const R = gen.res, half = gen.worldSize / 2, texel = gen.worldSize / R;
const at = (arr, x, z) => {
  const i = Math.max(0, Math.min(R - 1, Math.round((x + half) / texel - 0.5)));
  const j = Math.max(0, Math.min(R - 1, Math.round((z + half) / texel - 0.5)));
  return arr[j * R + i];
};
let best = null;
for (const sta of gen.channels) for (const p of sta) {
  const d = Math.hypot(p.x - tx, p.z - tz);
  if (!best || d < best.d) best = { d, sta, p };
}
console.log(`reach of ${best.sta.length} stations, nearest ${best.d.toFixed(1)} m`);
console.log('    s     x       z     m    lake  base    surf   wdep dcarve  bed   dep   carve  rill  preH');
for (const p of best.sta) {
  const bed = at(gen.height, p.x, p.z);
  const carve = at(gen.carve, p.x, p.z), rill = at(gen.rill, p.x, p.z);
  console.log([p.s, p.x, p.z].map(v => v.toFixed(1).padStart(7)).join(' '),
    p.m.toFixed(2).padStart(5), p.lake.toFixed(2).padStart(5),
    p.base.toFixed(1).padStart(7), p.surf.toFixed(1).padStart(7),
    p.wdep.toFixed(2).padStart(5), p.dcarve.toFixed(2).padStart(6),
    bed.toFixed(1).padStart(7), (p.surf - bed).toFixed(1).padStart(6),
    carve.toFixed(1).padStart(6), rill.toFixed(2).padStart(6),
    (bed + carve + rill).toFixed(1).padStart(7));
}
