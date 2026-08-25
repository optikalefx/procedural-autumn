#!/usr/bin/env node
// dogstuckwatch — per-frame steering dump around one respawn, real camp layout.
import * as THREE from 'three';
import { CampDog } from '../../src/camp/camp_dog.js';
import { layoutCamp } from '../../src/camp/camp_site.js';

const SEED = parseInt(process.argv[2] ?? '1', 10);
const AT = parseFloat(process.argv[3] ?? '20');
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const world = {
  getHeight: (x, z) => 0.06 * Math.sin(x * 0.9) * Math.cos(z * 0.7),
  getSlope: () => 0, getWaterDepth: () => 0, isInBounds: () => true,
};
const KIND_R = { tent: 1.85, telescope: 0.77, chair: 0.55, cooler: 0.60, table: 0.80, woodpile: 0.70 };
const rnd = mulberry32(SEED * 7919);
const items = layoutCamp(rnd, world, 0, 0, {});
const obstacles = items.map((it) => ({ x: it.x, z: it.z, r: KIND_R[it.kind] ?? 0.6, kind: it.kind }));
console.log('props:', obstacles.map(o => `${o.kind}@(${o.x.toFixed(1)},${o.z.toFixed(1)})r${o.r}`).join('  '));
const dog = new CampDog(new THREE.Group(), { x: 0, y: 0, z: 0 }, rnd, world, { obstacles });
const camPos = new THREE.Vector3(4, 1.6, 4);
const dt = 1 / 60;
let simT = 0;
for (let i = 0; simT < AT + 0.3; i++) {
  dog.update(dt, camPos);
  simT += dt;
  if (simT > AT - 12 && i % 15 === 0) {
    console.log(simT.toFixed(2).padStart(7), dog.stateName.padEnd(8),
      'p', dog.pos.x.toFixed(2), dog.pos.z.toFixed(2),
      'tgt', dog.target.x.toFixed(2), dog.target.z.toFixed(2),
      'ang', dog.ang.toFixed(2), 'dir', dog.orbitDir,
      'hd', (dog.heading % (Math.PI*2)).toFixed(2), 'spd', dog.speed.toFixed(2),
      'clr', dog.nearestClearance.toFixed(2),
      'rec', dog.recovering ? 1 : 0, 'rc', dog.recoverCount,
      'blk', dog.blockedTime.toFixed(2), 'stk', dog.stuckT.toFixed(1),
      'rsp', dog.respawns);
  }
}
