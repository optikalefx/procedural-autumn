#!/usr/bin/env node
// Where does the excess depth at a channel centreline come from?
import { TerrainGen } from '../../src/world/TerrainGen.js';
const res = parseInt(process.argv[2] || '1536', 10);
const gen = new TerrainGen({ res, worldSize: 3072, seed: 20261018, maxAltitude: 340, onProgress: () => {} });
gen.generate();
const R = gen.res, half = gen.worldSize / 2, texel = gen.worldSize / R;
const at = (arr, x, z) => {
  const i = Math.max(0, Math.min(R - 1, Math.round((x + half) / texel - 0.5)));
  const j = Math.max(0, Math.min(R - 1, Math.round((z + half) / texel - 0.5)));
  return arr[j * R + i];
};
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
const over = [], deepv = [], radv = [], baseDrop = [];
let n = 0, lakeN = 0;
for (const sta of gen.channels) {
  for (let k = 0; k < sta.length; k++) {
    const p = sta[k];
    const bed = at(gen.height, p.x, p.z);
    const bedC = p.surf - p.wdep;
    over.push(bedC - bed);
    const deep = Math.max(0, p.base - bedC);
    deepv.push(deep);
    radv.push((1.0 + p.m * 7.5 + Math.max(0, deep - p.dcarve) * 0.9) * (1 + p.lake * 0.6) * texel);
    if (k > 0) baseDrop.push(sta[k - 1].base - p.base);
    n++; if (p.lake > 0.05) lakeN++;
  }
}
console.log(JSON.stringify({
  stations: n, withLake: lakeN,
  overcut_p50: +q(over, .5).toFixed(2), p90: +q(over, .9).toFixed(2), p99: +q(over, .99).toFixed(2), max: +q(over, 1).toFixed(2),
  overcutOver1: over.filter(v => v > 1).length, overcutOver3: over.filter(v => v > 3).length,
  deep_p50: +q(deepv, .5).toFixed(2), deep_p90: +q(deepv, .9).toFixed(2), deep_p99: +q(deepv, .99).toFixed(2), deep_max: +q(deepv, 1).toFixed(2),
  radiusM_p50: +q(radv, .5).toFixed(1), radiusM_p90: +q(radv, .9).toFixed(1), radiusM_p99: +q(radv, .99).toFixed(1), radiusM_max: +q(radv, 1).toFixed(1),
  baseStepUp_p99: +q(baseDrop.map(v => -v), .99).toFixed(2), baseStepUp_max: +q(baseDrop.map(v => -v), 1).toFixed(2),
  baseStepDown_p99: +q(baseDrop, .99).toFixed(2), baseStepDown_max: +q(baseDrop, 1).toFixed(2),
}, null, 1));
