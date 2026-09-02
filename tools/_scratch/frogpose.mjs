#!/usr/bin/env node
/**
 * Frog pose probe — the rig in node, no browser: forward-kinematics every joint
 * for a point on the jump timeline and print where it lands, in model metres
 * (scale 1, frog facing +Z, origin under the body on the pad).
 *
 *   node tools/_scratch/frogpose.mjs                 # the key frames
 *   node tools/_scratch/frogpose.mjs flight 0.3      # one stage and phase
 *   node tools/_scratch/frogpose.mjs --sweep         # every stage at 0.1 steps
 *
 * What to read off it:
 *   · leg direction and length in each stage (is it straight back at launch?)
 *   · the lowest point of the body/limbs (negative y = under the pad surface)
 *   · the arm direction (down? back along the flank? forward for the landing?)
 *   · where the knee, the widest point of the sitting silhouette, sits
 */
import * as THREE from 'three';
import { frogProtos, FrogRig, JUMP } from '../../src/wildlife/frog_model.js';

const argv = process.argv.slice(2);
const proto = frogProtos()[0];
const rig = new FrogRig(proto, new THREE.MeshBasicMaterial(), 1);
const skin = rig.skin;
const v = new THREE.Vector3();
const posOf = (name) => { skin.updateMatrixWorld(true); return rig.bones[name].getWorldPosition(v.set(0, 0, 0)).clone(); };
const f = (n) => (n >= 0 ? ' ' : '') + n.toFixed(3);
const dir = (a, b) => { const d = b.clone().sub(a); const l = d.length(); return `${(Math.atan2(d.y, d.z) * 180 / Math.PI).toFixed(0).padStart(5)}° len ${l.toFixed(3)}`; };

function report(stage, u) {
  rig.setPose(stage, u); rig.update(0);
  rig.mesh.updateMatrixWorld(true);
  const P = {};
  for (const n of ['pelvis', 'head', 'shoulderL', 'elbowL', 'wristL', 'hipL', 'kneeL', 'ankleL', 'heelL']) P[n] = posOf(n);
  // The toe and hand tips are geometry, not bones: extend the last segment by
  // its authored length along the bone's world direction.
  const toe = P.heelL.clone().add(P.heelL.clone().sub(P.ankleL).normalize().multiplyScalar(0.066));
  const hand = P.wristL.clone().add(P.wristL.clone().sub(P.elbowL).normalize().multiplyScalar(0.034));
  // Lowest vertex of the skinned mesh, so nothing is missed.
  const g = skin.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  skin.skeleton.update();
  let minY = 1e9, maxZ = -1e9, minZ = 1e9, maxX = 0;
  const p = new THREE.Vector3(), q = new THREE.Vector3(), tmp = new THREE.Vector3();
  const bm = new THREE.Matrix4();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    q.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k); if (!w) continue;
      const bi = si.getComponent(i, k);
      bm.multiplyMatrices(skin.skeleton.bones[bi].matrixWorld, skin.skeleton.boneInverses[bi]);
      tmp.copy(p).applyMatrix4(bm).multiplyScalar(w);
      q.add(tmp);
    }
    minY = Math.min(minY, q.y); maxZ = Math.max(maxZ, q.z); minZ = Math.min(minZ, q.z); maxX = Math.max(maxX, Math.abs(q.x));
  }
  console.log(`\n== ${stage} u=${u.toFixed(2)}  fold ${rig.fold.toFixed(2)} arm ${rig.arm.toFixed(2)} pitch ${(rig.pitch * 180 / Math.PI).toFixed(0)}° drop ${rig.drop.toFixed(3)}`);
  console.log(`  thigh  ${dir(P.hipL, P.kneeL)}   shank ${dir(P.kneeL, P.ankleL)}   tarsus ${dir(P.ankleL, P.heelL)}`);
  console.log(`  upper  ${dir(P.shoulderL, P.elbowL)}   fore  ${dir(P.elbowL, P.wristL)}`);
  console.log(`  knee   x ${f(P.kneeL.x)} y ${f(P.kneeL.y)} z ${f(P.kneeL.z)}   toe tip y ${f(toe.y)} z ${f(toe.z)}   hand tip y ${f(hand.y)} z ${f(hand.z)}`);
  console.log(`  mesh   lowest y ${f(minY)}   z ${f(minZ)} .. ${f(maxZ)}   half-width ${f(maxX)}   head y ${f(P.head.y)}`);
  console.log(`  hip-to-toe reach ${P.hipL.distanceTo(toe).toFixed(3)} m (leg bone total ${(P.hipL.distanceTo(P.kneeL) + P.kneeL.distanceTo(P.ankleL) + P.ankleL.distanceTo(P.heelL) + 0.066).toFixed(3)})`);
}

if (argv.includes('--sweep')) {
  for (const st of ['crouch', 'launch', 'flight', 'land']) for (let i = 0; i <= 10; i++) report(st, i / 10);
} else if (argv.length >= 2 && !argv[0].startsWith('--')) {
  report(argv[0], parseFloat(argv[1]));
} else {
  console.log(`JUMP ${JSON.stringify(JUMP)}  tris ${proto.tris}  bones ${proto.skel.bones.length}`);
  report('sit', 0); report('crouch', 1); report('launch', 1); report('flight', 0.45); report('flight', 0.92); report('land', 0.35);
}
