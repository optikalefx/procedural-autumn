#!/usr/bin/env node
/**
 * Replicate `glb_rig.measureGround` on the exported GLB, and print the whole
 * velocity distribution rather than just its answer.
 *
 * The loader reports "moved none of the feet backwards" as one line, which is
 * true but says nothing about WHY. This prints the densest cluster, its share
 * of the samples (which should come out as the gait's duty factor) and the
 * histogram either side of it, so a clip that cannot be read says so in
 * numbers.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const FILE = process.argv[2] || 'public/models/new_deer.glb';
const FEET = (process.env.FEET || 'fore_toeL,fore_toeR,hind_toeL,hind_toeR').split(',');
const N = 256, TOL = 0.02;
const buf = readFileSync(FILE);
const gltf = await new Promise((res, rej) =>
  new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
const root = gltf.scene;
console.log('clips:', gltf.animations.map((a) => `${a.name} ${a.duration.toFixed(3)}s`).join(', '));

for (const clip of gltf.animations) {
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip); action.play();
  const bones = FEET.map((n) => root.getObjectByName(n)).filter(Boolean);
  if (!bones.length) { console.log('  NO FEET RESOLVED'); break; }
  const p = new THREE.Vector3();
  const tracks = bones.map(() => new Float64Array(N));
  for (let i = 0; i < N; i++) {
    mixer.setTime((i / N) * clip.duration);
    root.updateMatrixWorld(true);
    for (let b = 0; b < bones.length; b++) {
      p.setFromMatrixPosition(bones[b].matrixWorld);
      tracks[b][i] = p.z;
    }
  }
  action.stop(); mixer.uncacheRoot(root);
  const step = clip.duration / N;
  const speeds = [];
  for (const t of tracks) for (let i = 0; i < N; i++) speeds.push((t[(i + 1) % N] - t[i]) / step);
  speeds.sort((a, b) => a - b);
  const band = (speeds[speeds.length - 1] - speeds[0]) * TOL;
  let bf = 0, bt = 0;
  for (let from = 0, to = 0; from < speeds.length; from++) {
    while (to < speeds.length && speeds[to] - speeds[from] <= band) to++;
    if (to - from > bt - bf) { bf = from; bt = to; }
  }
  let tot = 0; for (let i = bf; i < bt; i++) tot += speeds[i];
  const mean = tot / (bt - bf);
  const share = (bt - bf) / speeds.length;
  // the same search restricted to POSITIVE velocities, which is the only sign
  // a planted foot can have
  const first = speeds.findIndex((v) => v > 0);
  let pf = first, pt = first, pmean = 0, pshare = 0;
  if (first >= 0) {
    for (let from = first, to = first; from < speeds.length; from++) {
      while (to < speeds.length && speeds[to] - speeds[from] <= band) to++;
      if (to - from > pt - pf) { pf = from; pt = to; }
    }
    let t2 = 0; for (let i = pf; i < pt; i++) t2 += speeds[i];
    pmean = t2 / Math.max(pt - pf, 1); pshare = (pt - pf) / speeds.length;
  }
  // how many samples sit in the positive plateau a planted hoof would make
  const pos = speeds.filter((v) => v > 0).length / speeds.length;
  console.log(`  ${clip.name.padEnd(10)} cluster ${mean.toFixed(3)} u/s  share ${(share*100).toFixed(1)}%  `
    + `| POSITIVE-ONLY cluster ${pmean.toFixed(3)} share ${(pshare*100).toFixed(1)}%`);
}
