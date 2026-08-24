import * as THREE from 'three';
import { SPECIES, buildSpecies } from '../../src/wildlife/animal_species.js';
import { instantiate } from '../../src/wildlife/animal_rig.js';
import { AnimRig } from '../../src/wildlife/animal_anim.js';
const world = { getHeight: () => 0 };
const MODES = [['stand',0,0,0],['alert',0,0,1],['walk',1,0,0],['trot',3,0,0.3],['run',8,0,1],['graze',0,1,0]];
for (const key of ['deer','bear','rabbit']) {
  const sp = SPECIES[key];
  const out = [];
  for (const [name, spd, gz, al] of MODES) {
    const proto = buildSpecies(key, 12345)[0];
    const v = sp.variants[0];
    const inst = instantiate(proto, new THREE.MeshBasicMaterial(), 0);
    const rig = new AnimRig(proto, inst, v.scale, sp.gait, key);
    const root = new THREE.Group(); root.add(inst.mesh);
    const pos = new THREE.Vector3();
    const drive = { pos, heading: 0, speed: spd * v.scale, graze: gz, alert: al, flag: 0, look: null, lod: 0 };
    rig.reset(pos, 0, world);
    const q = new THREE.Quaternion(), qp = new THREE.Quaternion();
    let maxW = 0; const dt = 1/60;
    for (let i = 0; i < 600; i++) {
      pos.z += drive.speed * dt;
      rig.update(dt, drive, world);
      root.updateMatrixWorld(true);
      inst.byName['head'].getWorldQuaternion(q);
      if (i > 120) { const w = 2 * Math.acos(Math.min(1, Math.abs(q.dot(qp)))) / dt; if (w > maxW) maxW = w; }
      qp.copy(q);
    }
    out.push(`${name} ${maxW.toFixed(2)}`);
  }
  console.log(key.padEnd(7), out.join('  '));
}
