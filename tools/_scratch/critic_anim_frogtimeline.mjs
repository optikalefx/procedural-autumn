#!/usr/bin/env node
/**
 * Critic probe: the whole hop as the WORLD plays it, sampled at 30 Hz.
 *   node tools/_scratch/critic_anim_frogtimeline.mjs [d=0.7] [size=0.74]
 * Reproduces frogs.js's stage machine (crouch -> launch(arc 0..JUMP.arc) ->
 * flight(arc JUMP.arc..1) -> land) and, per frame: joint params, bone rotation
 * deltas (deg/frame), body pitch vs the arc's velocity direction, and the
 * mesh's lowest world point relative to the pad plane (negative = under).
 *
 * The overlap is read from `JUMP.arc` and the flight is timed the way
 * `frogs.js` times it — (1 - arc) of the parabola over (1 - arc) of the flight
 * time — rather than restated here. This file reimplements the stage machine,
 * so every constant it hardcodes is a number that can silently go stale: the
 * first cut pinned 0.15/0.85 and went on reporting the pre-fix 0.72 g float
 * after the code had been fixed.
 */
import * as THREE from 'three';
import { frogProtos, FrogRig, JUMP, jumpPose } from '../../src/wildlife/frog_model.js';

const d = parseFloat(process.argv[2] ?? '0.7');
const size = parseFloat(process.argv[3] ?? '0.74');
const G = 9.81;
const apex = Math.min(Math.max(0.30 * d, 0.10), 0.32) * (0.8 + 0.4 * size);
const flightT = 2 * Math.sqrt(2 * apex / G);
const DT = 1 / 30;

const proto = frogProtos()[0];
const rig = new FrogRig(proto, new THREE.MeshBasicMaterial(), size);
const skin = rig.skin;

function lowest() {
  rig.mesh.updateMatrixWorld(true); skin.skeleton.update();
  const g = skin.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  let minY = 1e9, minName = '';
  const p = new THREE.Vector3(), q = new THREE.Vector3(), tmp = new THREE.Vector3(), bm = new THREE.Matrix4();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i); q.set(0, 0, 0);
    let bestW = 0, bestB = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k); if (!w) continue;
      const bi = si.getComponent(i, k);
      if (w > bestW) { bestW = w; bestB = bi; }
      bm.multiplyMatrices(skin.skeleton.bones[bi].matrixWorld, skin.skeleton.boneInverses[bi]);
      tmp.copy(p).applyMatrix4(bm).multiplyScalar(w); q.add(tmp);
    }
    if (q.y < minY) { minY = q.y; minName = skin.skeleton.bones[bestB].name; }
  }
  return { y: minY, bone: minName };
}

const BONES = ['pelvis', 'head', 'hipL', 'kneeL', 'ankleL', 'heelL', 'shoulderL', 'elbowL', 'wristL'];
const rot = () => Object.fromEntries(BONES.map((b) => [b, rig.bones[b].rotation.x]));

// Build the frame list.
const frames = [];
let t = 0;
const push = (stage, u, arcU) => frames.push({ t, stage, u, arcU });
for (let ft = 0; ft < JUMP.crouch; ft += DT, t += DT) push('crouch', ft / JUMP.crouch, null);
const ARC = JUMP.arc, REST = 1 - ARC;
const flightRun = REST * flightT;      // frogs.js: the rest of the arc over the rest of the time
for (let ft = 0; ft < JUMP.launch; ft += DT, t += DT) push('launch', ft / JUMP.launch, ARC * ft / JUMP.launch);
for (let ft = 0; ft < flightRun; ft += DT, t += DT) { const au = ARC + REST * ft / flightRun; push('flight', (au - ARC) / REST, au); }
for (let ft = 0; ft < JUMP.land; ft += DT, t += DT) push('land', ft / JUMP.land, null);
push('sit', 0, null);

console.log(`d=${d} size=${size} apex=${apex.toFixed(3)} flightT=${flightT.toFixed(3)} total=${t.toFixed(2)}s  (crouch ${JUMP.crouch} launch ${JUMP.launch} land ${JUMP.land})`);
console.log(`arc takeoff angle ${(Math.atan(4 * apex / d) * 180 / Math.PI).toFixed(1)} deg; du/dt launch ${(ARC / JUMP.launch).toFixed(2)} flight ${(REST / flightRun).toFixed(2)} ideal ${(1 / flightT).toFixed(2)}; g_eff in flight ${(8 * apex * (REST / flightRun) ** 2).toFixed(2)}`);
console.log('');
console.log('   t    stage   u   arcU |  fold   arm  pitch°  drop | vel°  pitch-vel | lowest(world, m rel pad)  bone | max Δrot deg/frame (bone)');
let prev = null;
for (const fr of frames) {
  rig.setPose(fr.stage, fr.u); rig.update(0);
  // world position on the arc
  let y = 0;
  if (fr.arcU !== null) y = 4 * apex * fr.arcU * (1 - fr.arcU);
  rig.mesh.position.set(0, y, fr.arcU !== null ? fr.arcU * d : (fr.stage === 'land' || fr.stage === 'sit' ? d : 0));
  const low = lowest();
  const R = rot();
  let maxD = 0, maxB = '';
  if (prev) for (const b of BONES) { const dd = Math.abs(R[b] - prev[b]) * 180 / Math.PI; if (dd > maxD) { maxD = dd; maxB = b; } }
  let vel = '     ', pv = '      ';
  if (fr.arcU !== null) {
    const du = 1e-4, u0 = fr.arcU, u1 = fr.arcU + du;
    const dz = d * du, dy = 4 * apex * (u1 * (1 - u1) - u0 * (1 - u0));
    const va = Math.atan2(dy, dz) * 180 / Math.PI;
    const bp = -rig.pitch * 180 / Math.PI;   // nose-up positive to match vel
    vel = va.toFixed(0).padStart(5); pv = (bp - va).toFixed(0).padStart(6);
  }
  console.log(`${fr.t.toFixed(3)} ${fr.stage.padEnd(7)} ${fr.u.toFixed(2)} ${fr.arcU === null ? '  -- ' : fr.arcU.toFixed(2).padStart(5)} | ${rig.fold.toFixed(2).padStart(5)} ${rig.arm.toFixed(2).padStart(5)} ${(rig.pitch * 180 / Math.PI).toFixed(0).padStart(5)} ${rig.drop.toFixed(3).padStart(7)} | ${vel} ${pv} | ${low.y.toFixed(3).padStart(7)} ${low.bone.padEnd(9)} | ${maxD.toFixed(1).padStart(5)} ${maxB}`);
  prev = R;
}
