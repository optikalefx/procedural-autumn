// Does the planted foot stand still? The rig walks in place, so a foot on the
// ground must travel backward at exactly WALK m/s. Anything else is skate.
import * as THREE from 'three';
import { buildBigfoot, BigfootRig, WALK, CADENCE, GROUND_PER_CYCLE, STAND_H }
  from '/Users/sean/htdocs/procedural-fall/src/wildlife/bigfoot_model.js';

const proto = buildBigfoot({ name:'t', scale:1, weight:1,
  col:{coat:0x2a2018, pale:0x4a3b2a, dark:0x120e0a, horn:0x6b5c46} });
const rig = new BigfootRig(proto, new THREE.MeshBasicMaterial());
const holder = new THREE.Group(); holder.add(rig.mesh);

const N = 400, T = 1 / CADENCE, dt = T / N;
const p = new THREE.Vector3();
const rows = [];
let ground = 0;
for (let i = 0; i <= N; i++) {
  ground += rig.update(dt, 1, 0);
  holder.updateMatrixWorld(true);
  const r = {};
  for (const tag of ['L','R']) {
    // Heel and toe pad, both in world space. Whichever is lower is the one
    // carrying him, and it is the one that must not slide.
    rig.bones[`ankle${tag}`].getWorldPosition(p);
    const heel = { y: p.y, z: p.z };
    // The PAD, not the toe bone. The pad is the last station of the sole loft
    // (0.240 m ahead of the ankle, y 0.052) and it is bound to the toe bone, so
    // in that bone's local frame it sits at (0, -0.018, +0.050). Measuring the
    // bone instead measures a point 5 cm behind the one touching the ground,
    // and every degree of foot pitch turns that offset into fictional skate.
    p.set(0, -0.018, 0.050);
    rig.bones[`toe${tag}`].localToWorld(p);
    r[tag] = { heel, toe: { y: p.y, z: p.z } };
  }
  r.phase = rig.phase;
  rows.push(r);
}
console.log('ground covered over one cycle:', ground.toFixed(4),
            'm  (GROUND_PER_CYCLE', GROUND_PER_CYCLE.toFixed(4) + ')');

// Contact = the toe pad within 4 cm of the ground. Over those samples the pad's
// world z must fall at WALK m/s; report the error as a fraction of WALK.
for (const tag of ['L','R']) {
  const off = tag === 'L' ? 0 : 0.5;
  // Two contacts, measured separately, because they are two different POINTS:
  // comparing a heel sample against a toe sample across the roll reports the
  // length of the foot as skate. The heel is down from heel-strike until the
  // lift begins (LEG.heel's smoothstep opens at 0.66 of stance = phase 0.396);
  // the pad is down for the whole of stance.
  const seg = (name, key, a0, a1) => {
    let n = 0, sum = 0, worst = 0, worstAt = 0;
    for (let i = 1; i <= N; i++) {
      const ph = (rows[i].phase + off) % 1;
      if (ph < a0 || ph > a1) continue;
      const v = (rows[i][tag][key].z - rows[i-1][tag][key].z) / dt;
      const err = Math.abs(v + WALK);
      sum += err; if (err > worst) { worst = err; worstAt = ph; } n++;
    }
    console.log(`${tag} ${name}: ${n} samples, mean ${(sum/n*100).toFixed(2)} cm/s`
      + ` (${(100*sum/n/WALK).toFixed(1)}% of walk), worst ${(worst*100).toFixed(1)} cm/s`
      + ` at phase ${worstAt.toFixed(2)}`);
  };
  seg('heel  ', 'heel', 0.02, 0.28);   // down until the lift opens at 0.30
  seg('toe pad', 'toe', 0.02, 0.58);
  let lo = 9, hi = -9;
  for (let i = 0; i <= N; i++) {
    lo = Math.min(lo, rows[i][tag].heel.y, rows[i][tag].toe.y);
    hi = Math.max(hi, rows[i][tag].toe.y);
  }
  console.log(`   foot height ${lo.toFixed(3)} .. ${hi.toFixed(3)} m`);
}
console.log('STAND_H', STAND_H, 'WALK', WALK.toFixed(3));
