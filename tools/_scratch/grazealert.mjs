import * as THREE from 'three';
import { SPECIES, buildSpecies } from '../../src/wildlife/animal_species.js';
import { instantiate } from '../../src/wildlife/animal_rig.js';
import { AnimRig } from '../../src/wildlife/animal_anim.js';
const world = { getHeight: () => 0 };
const clamp01 = (x) => Math.max(0, Math.min(1, x));
// graze -> startled: graze falls, alert rises, then the animal bolts.
for (const key of ['deer','bear','rabbit']) {
  const sp = SPECIES[key]; const v = sp.variants[0];
  const proto = buildSpecies(key, 12345)[0];
  const inst = instantiate(proto, new THREE.MeshBasicMaterial(), 0);
  const rig = new AnimRig(proto, inst, v.scale, sp.gait, key);
  const root = new THREE.Group(); root.add(inst.mesh);
  const pos = new THREE.Vector3();
  const drive = { pos, heading: 0, speed: 0, graze: 1, alert: 0, flag: 0, look: null, lod: 0 };
  rig.reset(pos, 0, world);
  for (let i = 0; i < 180; i++) rig.update(1/60, drive, world);
  const q = new THREE.Quaternion(), qp = new THREE.Quaternion();
  let maxW = 0, tMax = 0; const dt = 1/60;
  for (let i = 0; i < 600; i++) {
    const t = i * dt;
    drive.graze = clamp01(1 - t / 0.45);
    drive.alert = clamp01(t / 0.35);
    drive.speed = t > 1.2 ? Math.min(sp.gait.run, (t - 1.2) * 12) * v.scale : 0;
    pos.z += drive.speed * dt;
    rig.update(dt, drive, world);
    root.updateMatrixWorld(true);
    inst.byName['head'].getWorldQuaternion(q);
    if (i) { const w = 2 * Math.acos(Math.min(1, Math.abs(q.dot(qp)))) / dt; if (w > maxW) { maxW = w; tMax = t; } }
    qp.copy(q);
  }
  console.log(key.padEnd(7), 'graze->alert->bolt  max head ang vel', maxW.toFixed(2), '@t', tMax.toFixed(2));
}
