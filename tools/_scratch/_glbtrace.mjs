#!/usr/bin/env node
/** One foot's z-velocity through one cycle: is there a stance plateau at all? */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
const FILE = process.argv[2], NAME = process.argv[3], BONE = process.argv[4] || 'hind_toeL';
const buf = readFileSync(FILE);
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
const root = gltf.scene, clip = gltf.animations.find((a) => a.name === NAME);
const mixer = new THREE.AnimationMixer(root), action = mixer.clipAction(clip); action.play();
const bone = root.getObjectByName(BONE);
const N = 64, p = new THREE.Vector3(), z = [], y = [];
for (let i = 0; i < N; i++) {
  mixer.setTime((i / N) * clip.duration); root.updateMatrixWorld(true);
  p.setFromMatrixPosition(bone.matrixWorld); z.push(p.z); y.push(p.y);
}
const step = clip.duration / N;
console.log(`${NAME} / ${BONE}  (${clip.duration.toFixed(3)}s, ${N} samples)`);
console.log('  i   height   vz');
for (let i = 0; i < N; i++) {
  const vz = (z[(i + 1) % N] - z[i]) / step;
  const lo = Math.min(...y), rng = Math.max(...y) - lo;
  const planted = (y[i] - lo) < rng * 0.12;
  console.log(`  ${String(i).padStart(2)}  ${y[i].toFixed(4)}  ${vz.toFixed(3).padStart(7)} ${planted ? ' PLANTED' : ''}`);
}
