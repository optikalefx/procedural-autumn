// A camper running an animal down on open ground must not make it give up.
import { readFileSync, readdirSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { SPECIES } from '../../src/wildlife/animal_species.js';
import { Brain, ST, WATER_MAX } from '../../src/wildlife/animal_brain.js';
const SEED = 20262018, res = '1536';
const dir = new URL('../../public/bakes/', import.meta.url);
const file = readdirSync(dir).find((f) => f.startsWith(`world-${SEED}-${res}-`));
const buf = readFileSync(new URL(file, dir));
const W = new WorldData(decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), SEED);
const NAMES = ['IDLE','GRAZE','WANDER','ALERT','FLEE','PATROL','WATCH'];
// open, dry, flat sites well away from water
const sites = [];
for (let i = 0; i < 200000 && sites.length < 12; i++) {
  const x = ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 1600 - 800;
  const z = ((Math.sin(i * 78.233) * 43758.5453) % 1) * 1600 - 800;
  if (!W.isInBounds(x, z) || W.getWaterDepth(x, z) > 0 || W.getSlope(x, z) > 0.3) continue;
  let ok = true;
  for (let a = 0; a < 12 && ok; a++) {
    for (const r of [10, 25, 45]) {
      const tx = x + Math.sin(a * 0.52) * r, tz = z + Math.cos(a * 0.52) * r;
      if (!W.isInBounds(tx, tz) || W.getWaterDepth(tx, tz) > WATER_MAX) { ok = false; break; }
    }
  }
  if (ok) sites.push({ x, z });
}
for (const key of ['deer', 'bear', 'rabbit', 'fox']) {
  let gaveUp = 0, dists = [];
  for (let s = 0; s < sites.length; s++) {
    const b = sites[s];
    const brain = new Brain(key, SPECIES[key], 77 + s, { alarm: 0, fleeH: null, line: null }, 0);
    brain.reset(b.x, W.getHeight(b.x, b.z), b.z, 0, 1);
    // camper driving straight at it at 13 m/s, from 60 m out
    const th = { x: b.x, z: b.z - 60, speed: 13 };
    const x0 = brain.pos.x, z0 = brain.pos.z;
    let sawFlee = false, watchedWhileClose = 0;
    for (let i = 0; i < 60 * 12; i++) {
      th.z += 13 / 60;
      brain.update(1 / 60, W, th, null);
      if (brain.state === ST.FLEE) sawFlee = true;
      const d = Math.hypot(th.x - brain.pos.x, th.z - brain.pos.z);
      if (sawFlee && brain.state === ST.WATCH && d < 25) watchedWhileClose++;
    }
    dists.push(Math.hypot(brain.pos.x - x0, brain.pos.z - z0));
    if (watchedWhileClose > 30) gaveUp++;
  }
  dists.sort((a, b) => a - b);
  console.log(`${key.padEnd(7)} median run ${dists[dists.length >> 1].toFixed(1)} m  min ${dists[0].toFixed(1)} m  gave-up-while-close ${gaveUp}/${sites.length}`);
}
