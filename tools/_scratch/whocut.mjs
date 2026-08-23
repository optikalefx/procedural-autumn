#!/usr/bin/env node
// Who excavated this station's bed? Finds, for stations whose bed is well below
// their own bedC, the station whose bedC matches the bed that is there.
import { TerrainGen } from '../../src/world/TerrainGen.js';
const res = parseInt(process.argv[2] || '1536', 10);
const gen = new TerrainGen({ res, worldSize: 3072, seed: 20261018, maxAltitude: 340, onProgress: () => {} });
gen.generate();
const R = gen.res, half = gen.worldSize / 2, texel = gen.worldSize / R;
const bedAt = (x, z) => {
  const i = Math.max(0, Math.min(R - 1, Math.round((x + half) / texel - 0.5)));
  const j = Math.max(0, Math.min(R - 1, Math.round((z + half) / texel - 0.5)));
  return gen.height[j * R + i];
};
const all = [];
for (const sta of gen.channels) for (const p of sta) all.push(p);
const BK = 64, BG = Math.ceil(gen.worldSize / BK);
const buckets = new Map();
for (const p of all) {
  const k = Math.floor((p.z + half) / BK) * BG + Math.floor((p.x + half) / BK);
  let a = buckets.get(k); if (!a) buckets.set(k, a = []); a.push(p);
}
const hits = [];
let n = 0;
for (const sta of gen.channels) {
  for (const p of sta) {
    const bed = bedAt(p.x, p.z);
    const over = (p.surf - p.wdep) - bed;
    if (over < 2) continue;
    n++;
    // who has a bedC near this bed?
    let best = null;
    const bx = Math.floor((p.x + half) / BK), bz = Math.floor((p.z + half) / BK);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const arr = buckets.get((bz + dz) * BG + (bx + dx)); if (!arr) continue;
      for (const q of arr) {
        const bc = q.surf - q.wdep;
        if (Math.abs(bc - bed) > 0.6) continue;
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (!best || d < best.d) best = { d, q, sameReach: sta.includes(q) };
      }
    }
    hits.push({ over, d: best ? best.d : null, same: best ? best.sameReach : null });
  }
}
const q = (a, pp) => a.slice().sort((x, y) => x - y)[Math.floor(pp * (a.length - 1))];
const withD = hits.filter(h => h.d != null);
console.log(JSON.stringify({
  stationsOver2: n, matched: withD.length,
  cutterDist_p50: +q(withD.map(h => h.d), .5).toFixed(1),
  cutterDist_p90: +q(withD.map(h => h.d), .9).toFixed(1),
  cutterDist_max: +q(withD.map(h => h.d), 1).toFixed(1),
  sameReachPct: +(100 * withD.filter(h => h.same).length / withD.length).toFixed(1),
  under6m: withD.filter(h => h.d < 6).length, under12m: withD.filter(h => h.d < 12).length,
}, null, 1));
