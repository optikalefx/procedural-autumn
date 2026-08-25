// A patrolling bear on a river bank with a kayak parked next to it: does it
// ever actually go anywhere, or does it shuffle on the spot?
import { readFileSync, readdirSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { SPECIES } from '../../src/wildlife/animal_species.js';
import { Brain, ST, WATER_MAX } from '../../src/wildlife/animal_brain.js';

const SEED = parseInt(process.argv[2] || '20262018', 10);
const res = '1536';
const dir = new URL('../../public/bakes/', import.meta.url);
const file = readdirSync(dir).find((f) => f.startsWith(`world-${SEED}-${res}-`));
const buf = readFileSync(new URL(file, dir));
const W = new WorldData(decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), SEED);

// Find bank points: dry, with water within 3 m.
const banks = [];
const B = W.size ?? 2048;
for (let i = 0; i < 40000 && banks.length < 40; i++) {
  const x = (Math.sin(i * 12.9898) * 43758.5453 % 1) * B - B / 2;
  const z = (Math.sin(i * 78.233) * 43758.5453 % 1) * B - B / 2;
  if (!W.isInBounds(x, z)) continue;
  if (W.getWaterDepth(x, z) > WATER_MAX) continue;
  let wx = null;
  for (let a = 0; a < 8; a++) {
    const tx = x + Math.sin(a * 0.785) * 3, tz = z + Math.cos(a * 0.785) * 3;
    if (W.isInBounds(tx, tz) && W.getWaterDepth(tx, tz) > 0.5) { wx = [tx, tz]; break; }
  }
  if (wx) banks.push({ x, z, wx });
}
console.log('bank sites', banks.length);

const sp = SPECIES.bear;
let pinned = 0;
for (let s = 0; s < banks.length; s++) {
  const b = banks[s];
  const brain = new Brain('bear', sp, 1234 + s, { alarm: 0, fleeH: null, line: null }, 0);
  brain.reset(b.x, W.getHeight(b.x, b.z), b.z, 0, 1.08);
  // The kayak: sitting on the water a few metres off, barely moving.
  const threat = { x: b.wx[0], z: b.wx[1], speed: 0.4 };
  let blocked = 0, far = 0;
  const x0 = brain.pos.x, z0 = brain.pos.z;
  const states = new Set();
  for (let i = 0; i < 60 * 60; i++) {
    const px = brain.pos.x, pz = brain.pos.z;
    brain.update(1 / 60, W, threat, null);
    states.add(brain.state);
    // the final water guard fired if speed was live but the position held
    if (brain.speed > 0.05 && Math.hypot(brain.pos.x - px, brain.pos.z - pz) < 1e-6) blocked++;
    far = Math.max(far, Math.hypot(brain.pos.x - x0, brain.pos.z - z0));
  }
  const d = Math.hypot(brain.pos.x - x0, brain.pos.z - z0);
  const tag = blocked > 60 ? '  <-- PINNED' : '';
  if (blocked > 60) pinned++;
  console.log(`site ${String(s).padStart(2)} (${b.x.toFixed(0)},${b.z.toFixed(0)})  net ${d.toFixed(1)}m  max ${far.toFixed(1)}m  blocked frames ${String(blocked).padStart(4)}/3600  states {${[...states].join(',')}}${tag}`);
}
console.log(`pinned at ${pinned}/${banks.length} sites`);
