#!/usr/bin/env node
/**
 * dogsnap — reproduce one dogfull spike frame and dump everything around it.
 *   node tools/_scratch/dogsnap.mjs --seed 6 --at 1059.7
 */
import * as THREE from 'three';
import { CampDog } from '../../src/camp/camp_dog.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SEED = parseInt(arg('seed', '6'), 10);
const AT = parseFloat(arg('at', '1059.7'));

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
function makeObstacles(rnd) {
  const out = [];
  const n = 5 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const big = rnd() < 0.18;
    const a = rnd() * Math.PI * 2;
    const d = 1.6 + rnd() * 2.0;
    out.push({ x: Math.sin(a) * d, z: Math.cos(a) * d, r: big ? 1.5 + rnd() * 0.5 : 0.45 + rnd() * 0.4 });
  }
  return out;
}
const world = {
  getHeight: (x, z) => 0.06 * Math.sin(x * 0.9) * Math.cos(z * 0.7),
  getSlope: () => 0,
};
const rnd = mulberry32(SEED * 7919);
const parent = new THREE.Group();
const dog = new CampDog(parent, { x: 0, y: 0, z: 0 }, rnd, world, { obstacles: makeObstacles(rnd) });
const camPos = new THREE.Vector3(4, 1.6, 4);

const names = ['chest', 'neck1', 'neck2', 'head'];
const bones = names.map((n) => dog.inst.byName[n]);
const dt = 1 / 60;
let simT = 0;
for (let i = 0; simT < AT + 0.25; i++) {
  dog.update(dt, camPos);
  simT += dt;
  if (simT > AT - 0.25) {
    console.log(
      simT.toFixed(3), dog.stateName.padEnd(8),
      'spd', dog.speed.toFixed(3),
      'hd', dog.heading.toFixed(2),
      'bl', dog.blend.toFixed(3), 'hbl', dog.headBlend.toFixed(4),
      'pose', dog.pose ? 'Y' : '-',
      '|', names.map((n, j) => `${n} ${bones[j].rotation.x.toFixed(2)}/${bones[j].rotation.y.toFixed(2)}/${bones[j].rotation.z.toFixed(2)}`).join('  '),
      '| hT', dog.rig.headTarget.y.toFixed(3), dog.rig.headTarget.z.toFixed(3),
      'chain', dog.rig.neckChain.toFixed(2),
      'hp', dog.rig.headPitch.toFixed(2),
    );
  }
}
