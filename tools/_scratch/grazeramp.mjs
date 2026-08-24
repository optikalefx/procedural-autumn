import * as THREE from 'three';
import { SPECIES } from '../../src/wildlife/animal_species.js';
import { buildSpecies } from '../../src/wildlife/animal_species.js';
import { instantiate } from '../../src/wildlife/animal_rig.js';
import { AnimRig } from '../../src/wildlife/animal_anim.js';

for (const key of ['deer','bear','rabbit']) {
  const sp = SPECIES[key];
  const proto = buildSpecies(key, 12345)[0];
  const v = sp.variants[0];
  const inst = instantiate(proto, new THREE.MeshBasicMaterial(), 0);
  const rig = new AnimRig(proto, inst, v.scale, sp.gait, key);
  const root = new THREE.Group(); root.add(inst.mesh);
  const pos = new THREE.Vector3();
  const world = { getHeight: () => 0 };
  const drive = { pos, heading: 0, speed: 0, graze: 0, alert: 0, flag: 0, look: null, lod: 0 };
  rig.reset(pos, 0, world);
  const q = new THREE.Quaternion(), qp = new THREE.Quaternion();
  let maxW = 0, maxJ = 0, prevW = 0, tMax = 0;
  const dt = 1/60;
  for (let i = 0; i < 900; i++) {
    const t = i * dt;
    // ramp graze in over 1 s at t=1, hold, ramp out at t=6
    drive.graze = t < 1 ? 0 : t < 2 ? (t - 1) : t < 6 ? 1 : t < 7 ? (7 - t) : 0;
    rig.update(dt, drive, world);
    root.updateMatrixWorld(true);
    inst.byName['head'].getWorldQuaternion(q);
    if (i) { const w = 2 * Math.acos(Math.min(1, Math.abs(q.dot(qp)))) / dt;
      if (w > maxW) { maxW = w; tMax = t; }
      const j = Math.abs(w - prevW) / dt; if (i > 2 && j > maxJ) maxJ = j;
      prevW = w; }
    qp.copy(q);
  }
  console.log(key.padEnd(7), 'max head ang vel', maxW.toFixed(2), 'rad/s @t', tMax.toFixed(2), ' max jerk', maxJ.toFixed(1), 'rad/s^2');
}
