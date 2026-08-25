#!/usr/bin/env node
/**
 * dogrise — frame-by-frame trace of one settle + rest + rise, per bone.
 * Localizes which joint carries the mid-rise head whip dogfull.mjs found.
 */
import * as THREE from 'three';
import { CampDog } from '../../src/camp/camp_dog.js';

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const world = { getHeight: () => 0, getSlope: () => 0 };
const rnd = mulberry32(5 * 7919);
const parent = new THREE.Group();
const dog = new CampDog(parent, { x: 0, y: 0, z: 0 }, rnd, world, { obstacles: [] });

const names = ['chest', 'neck1', 'neck2', 'head'];
const bones = names.map((n) => dog.inst.byName[n]);
const qs = names.map(() => new THREE.Quaternion());
const qps = names.map(() => new THREE.Quaternion());
const dt = 1 / 60;
let simT = 0, printed = 0, sawRest = false;

for (let i = 0; i < 60 * 600 && printed < 4000; i++) {
  const st0 = dog.stateName;
  dog.update(dt, null);
  simT += dt;
  parent.updateMatrixWorld(true);
  const ws = names.map((n, j) => {
    bones[j].getWorldQuaternion(qs[j]);
    const w = 2 * Math.acos(Math.min(1, Math.abs(qs[j].dot(qps[j])))) / dt;
    qps[j].copy(qs[j]);
    return w;
  });
  if (dog.stateName === 'rest') sawRest = true;
  const interesting = dog.stateName === 'settle' || dog.stateName === 'rise' ||
    (sawRest && st0 === 'rise');
  if (i > 120 && interesting) {
    printed++;
    console.log(
      simT.toFixed(2).padStart(7),
      `${st0}->${dog.stateName}`.padEnd(16),
      'blend', dog.blend.toFixed(3),
      'pose', dog.pose ? Object.keys(dog.pose.bones).length && (dog.pose === undefined) : 'null',
      '| w:', names.map((n, j) => `${n} ${ws[j].toFixed(2)}`).join('  '),
      '| loc:', names.map((n, j) => `${bones[j].rotation.x.toFixed(2)}/${bones[j].rotation.y.toFixed(2)}`).join(' '),
    );
  }
  if (sawRest && dog.stateName === 'wander' && st0 === 'rise') break;
}
