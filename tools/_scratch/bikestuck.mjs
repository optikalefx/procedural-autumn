#!/usr/bin/env node
/** Why will the bike not leave (-404, -943)? Ask the physics' own predicate. */
import { readFileSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { SEED } from '../../src/world/WorldConfig.js';
import { BikePhysics } from '../../src/bike/bike_physics.js';

const dir = new URL('../../public/bakes/', import.meta.url);
const buf = readFileSync(new URL(`world-${SEED}-1536-a2d45edb.pab`, dir));
const W = new WorldData(decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), SEED);

const X = Number(process.argv[2] ?? -404.19), Z = Number(process.argv[3] ?? -942.90);
const H = Number(process.argv[4] ?? 3.5343);
const p = new BikePhysics(W, { wheelbase: 1.1, wheelR: 0.35 }).place(X, Z, H);
console.log(`start  slope ${W.getSlope(X, Z).toFixed(2)}  water ${W.getWaterDepth(X, Z).toFixed(2)}  y ${p.y.toFixed(1)}`);

// The 24 bearings around it, and whether each is rideable — the same question
// `_blockNormal` asks when it looks for a way out.
let ok = 0;
for (let a = 0; a < 24; a++) {
  const ang = a / 24 * Math.PI * 2;
  const px = X + Math.cos(ang) * 0.6, pz = Z + Math.sin(ang) * 0.6;
  if (p.rideable(px, pz, { maxGrade: p._gradeLimit(px, pz) })) ok++;
}
console.log(`bearings rideable  ${ok}/24`);

for (let i = 0; i < 600; i++) p.step(1 / 60, i / 60, { fwd: 1 });
console.log(`after 10 s: moved ${Math.hypot(p.x - X, p.z - Z).toFixed(1)} m, speed ${p.speed.toFixed(2)}, blocked ${p.blocked}`);
