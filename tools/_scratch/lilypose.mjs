// Camera poses for the busiest colonies: a dry, flat spot on the bank, looking at the colony.
import { readFileSync, readdirSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { LilyScatter } from '../../src/vegetation/lily_scatter.js';
// The scatter is seeded from WorldConfig.SEED in the game whatever bake is
// loaded (the Rocks/Trees convention), so the census must be too.
import { SEED as SCATTER_SEED } from '../../src/world/WorldConfig.js';
const SEED = 20261018;
const file = readdirSync('public/bakes').find((f) => f.startsWith(`world-${SEED}-1536-`));
const buf = readFileSync(`public/bakes/${file}`);
const world = new WorldData(decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), SEED);
const sc = new LilyScatter(world, SCATTER_SEED);
const pads = [];
for (let cz = -24; cz < 24; cz++) for (let cx = -24; cx < 24; cx++) sc.generateCell(cx, cz, 64, pads);
const byCell = new Map();
for (const p of pads) { const a = byCell.get(p.cell) ?? []; a.push(p); byCell.set(p.cell, a); }
const cells = [...byCell.values()].sort((a, b) => b.length - a.length).slice(0, 10);
const h = (x, z) => world.getHydro(x, z, {}).sdf;
for (const list of cells) {
  const mx = list.reduce((s, p) => s + p.x, 0) / list.length, mz = list.reduce((s, p) => s + p.z, 0) / list.length;
  const wy = world.getWaterHeight(mx, mz) ?? list[0].y;
  let best = null;
  for (let a = 0; a < 48; a++) {
    const th = a / 48 * Math.PI * 2;
    for (let d = 9; d <= 22; d += 1.5) {
      const x = mx + Math.sin(th) * d, z = mz + Math.cos(th) * d;
      const s = h(x, z);
      if (s > -1.0 || s < -5) continue;
      const slope = world.getSlope(x, z);
      const gy = world.getHeight(x, z);
      if (gy > wy + 3) continue;
      const score = slope * 4 + Math.abs(d - 13) * 0.05;
      if (!best || score < best.score) best = { x, z, gy, slope, d, score };
    }
  }
  if (!best) { console.log(`n ${list.length}  centroid ${mx.toFixed(1)},${mz.toFixed(1)}  no bank found`); continue; }
  console.log(`n ${list.length}  --pos ${best.x.toFixed(1)},${(best.gy + 2.2).toFixed(1)},${best.z.toFixed(1)} --look ${mx.toFixed(1)},${(wy + 0.1).toFixed(1)},${mz.toFixed(1)}   d ${best.d} slope ${best.slope.toFixed(2)}`);
}

// A frog's-eye pose: the pad in the busiest colony nearest its bank camera,
// seen from 2.4 m away at 0.9 m above the water.
{
  const list = cells[0];
  const bank = { x: 370.2, z: -5.9 };
  list.sort((a, b) => Math.hypot(a.x - bank.x, a.z - bank.z) - Math.hypot(b.x - bank.x, b.z - bank.z));
  const p = list[3];
  const dx = p.x - bank.x, dz = p.z - bank.z, d = Math.hypot(dx, dz);
  const cx = p.x - dx / d * 2.4, cz = p.z - dz / d * 2.4;
  console.log(`frog  --pos ${cx.toFixed(2)},${(p.y + 0.9).toFixed(2)},${cz.toFixed(2)} --look ${p.x.toFixed(2)},${(p.y + 0.05).toFixed(2)},${p.z.toFixed(2)}   pad r ${p.r.toFixed(2)} variant ${p.variant}`);
}
