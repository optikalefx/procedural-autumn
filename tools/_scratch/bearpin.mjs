// Trace one pinned bear frame by frame.
import { readFileSync, readdirSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { SPECIES } from '../../src/wildlife/animal_species.js';
import { Brain, WATER_MAX } from '../../src/wildlife/animal_brain.js';
const SEED = 20262018, res = '1536';
const dir = new URL('../../public/bakes/', import.meta.url);
const file = readdirSync(dir).find((f) => f.startsWith(`world-${SEED}-${res}-`));
const buf = readFileSync(new URL(file, dir));
const W = new WorldData(decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), SEED);
const [X, Z] = [parseFloat(process.argv[2] ?? '170'), parseFloat(process.argv[3] ?? '219')];
// where the water is
let wx = null;
for (let a = 0; a < 8; a++) { const tx = X + Math.sin(a * 0.785) * 3, tz = Z + Math.cos(a * 0.785) * 3; if (W.getWaterDepth(tx, tz) > 0.5) { wx = [tx, tz]; break; } }
console.log('bear at', X.toFixed(1), Z.toFixed(1), 'depth', W.getWaterDepth(X, Z).toFixed(3), 'threat at', wx.map(v => v.toFixed(1)).join(','));
// map the dry land around it
let row = '';
for (let dz = -6; dz <= 6; dz += 1) {
  row = '';
  for (let dx = -6; dx <= 6; dx += 1) {
    const d = W.getWaterDepth(X + dx * 2, Z + dz * 2);
    row += d > WATER_MAX ? '~' : (dx === 0 && dz === 0 ? 'B' : '.');
  }
  console.log('  ' + row);
}
const brain = new Brain('bear', SPECIES.bear, 1234 + 15, { alarm: 0, fleeH: null, line: null }, 0);
brain.reset(X, W.getHeight(X, Z), Z, 0, 1.08);
const threat = { x: wx[0], z: wx[1], speed: 0.4 };
const ST = ['IDLE', 'GRAZE', 'WANDER', 'ALERT', 'FLEE', 'PATROL', 'WATCH'];
for (let i = 0; i < 60 * 40; i++) {
  const px = brain.pos.x, pz = brain.pos.z;
  brain.update(1 / 60, W, threat, null);
  const moved = Math.hypot(brain.pos.x - px, brain.pos.z - pz);
  if (i % 30 === 0) {
    console.log(`t ${(i / 60).toFixed(1).padStart(5)} ${ST[brain.state].padEnd(6)} pos(${brain.pos.x.toFixed(1)},${brain.pos.z.toFixed(1)}) hd ${brain.heading.toFixed(2).padStart(6)} want ${brain.wantHeading.toFixed(2).padStart(6)} avoid ${brain._avoid.toFixed(2).padStart(5)} stuck ${brain._stuck} spd ${brain.speed.toFixed(2)} moved ${(moved * 60).toFixed(2)}m/s spent ${brain.spent.toFixed(1)}`);
  }
}
