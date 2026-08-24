import * as THREE from 'three';
import { SPECIES, buildSpecies } from '../../src/wildlife/animal_species.js';
import { instantiate } from '../../src/wildlife/animal_rig.js';
import { AnimRig } from '../../src/wildlife/animal_anim.js';
// Grazing on real ground: uphill, downhill and across a side-slope.
for (const [name, gx, gz] of [['flat',0,0],['uphill',0,0.36],['downhill',0,-0.36],['sidehill',0.36,0]]) {
  const world = { getHeight: (x, z) => x * gx + z * gz };
  for (const key of ['deer','bear','rabbit']) {
    const sp = SPECIES[key]; const v = sp.variants[0];
    const proto = buildSpecies(key, 12345)[0];
    const inst = instantiate(proto, new THREE.MeshBasicMaterial(), 0);
    const rig = new AnimRig(proto, inst, v.scale, sp.gait, key);
    const root = new THREE.Group(); root.add(inst.mesh);
    const pos = new THREE.Vector3(0, 0, 0);
    const drive = { pos, heading: 0, speed: 0, graze: 0, alert: 0, flag: 0, look: null, lod: 0 };
    rig.reset(pos, 0, world);
    const q = new THREE.Quaternion(), qp = new THREE.Quaternion();
    let maxW = 0; const dt = 1/60;
    for (let i = 0; i < 900; i++) {
      const t = i * dt;
      drive.graze = t < 1 ? 0 : t < 1.6 ? (t - 1) / 0.6 : 1;
      rig.update(dt, drive, world);
      root.updateMatrixWorld(true);
      inst.byName['head'].getWorldQuaternion(q);
      if (i > 45) { const w = 2 * Math.acos(Math.min(1, Math.abs(q.dot(qp)))) / dt; if (w > maxW) maxW = w; }
      qp.copy(q);
    }
    // Does the neck still read as one chain? Poll must sit forward of the base.
    const n1 = new THREE.Vector3().setFromMatrixPosition(inst.byName[proto.skel.bones[proto.info.neck[0]].name].matrixWorld);
    const hd = new THREE.Vector3().setFromMatrixPosition(inst.byName['head'].matrixWorld);
    const local = hd.clone().sub(n1);
    const ok = local.z > 0 && local.y < 0;
    console.log(name.padEnd(9), key.padEnd(7), 'maxW', maxW.toFixed(2).padStart(6),
      ' poll rel base  fwd', local.z.toFixed(3), 'down', (-local.y).toFixed(3), ok ? '' : '  <-- FOLDED BACK');
  }
}
