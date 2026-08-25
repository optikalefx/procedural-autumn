// Head orientation sweep: is the skull ever upside down?
import * as THREE from 'three';
import { SPECIES, buildSpecies } from '../../src/wildlife/animal_species.js';
import { instantiate } from '../../src/wildlife/animal_rig.js';
import { AnimRig } from '../../src/wildlife/animal_anim.js';

const key = process.argv[2] || 'bear';
const sp = SPECIES[key];
const proto = buildSpecies(key, 12345)[0];
const v = sp.variants[0];
const inst = instantiate(proto, new THREE.MeshBasicMaterial(), 0);
const rig = new AnimRig(proto, inst, v.scale, sp.gait, key);
const root = new THREE.Group(); root.add(inst.mesh);
const W = { getHeight: () => 0 };
const pos = new THREE.Vector3();
const drive = { pos, heading: 0, speed: 0, graze: 0, alert: 0, flag: 0, look: null, lod: 0 };
rig.reset(pos, 0, W);
const q = new THREE.Quaternion();
const up = new THREE.Vector3(), fwd = new THREE.Vector3();
const line = (tag) => {
  root.updateMatrixWorld(true);
  inst.byName['head'].getWorldQuaternion(q);
  up.set(0, 1, 0).applyQuaternion(q);
  fwd.set(0, 0, 1).applyQuaternion(q);
  console.log(`${tag.padEnd(28)} up.y ${up.y.toFixed(3).padStart(7)}  fwd(${fwd.x.toFixed(2)},${fwd.y.toFixed(2)},${fwd.z.toFixed(2)})  headRotX ${rig.head.rotation.x.toFixed(3).padStart(7)} chain ${rig.neckChain.toFixed(3).padStart(7)} nA ${rig.neck.a.rotation.x.toFixed(2)} nB ${rig.neck.b.rotation.x.toFixed(2)}`);
};
for (const g of [0, 0.25, 0.5, 0.75, 1]) {
  drive.graze = g; drive.alert = 0; drive.speed = 0; drive.look = null;
  rig.reset(pos, 0, W);
  rig.neckChain = 0; rig.headPitch = 0;
  for (let i = 0; i < 600; i++) rig.update(1 / 60, drive, W);
  line(`graze ${g}`);
}
drive.graze = 0;
for (const a of [0, 0.5, 1]) {
  drive.alert = a; rig.reset(pos, 0, W);
  for (let i = 0; i < 600; i++) rig.update(1 / 60, drive, W);
  line(`alert ${a}`);
}
drive.alert = 0;
for (const sp2 of [0.5, 1.5, 3, 6]) {
  drive.speed = sp2; rig.reset(pos, 0, W);
  for (let i = 0; i < 600; i++) rig.update(1 / 60, drive, W);
  line(`speed ${sp2}`);
}
drive.speed = 0;
// looking around, including up/down
for (const [lx, ly, lz] of [[0, 2, 8], [8, 2, 0], [-8, 2, 0], [0, 6, 3], [0, 0.2, 6]]) {
  drive.look = new THREE.Vector3(lx, ly, lz);
  rig.reset(pos, 0, W);
  for (let i = 0; i < 600; i++) rig.update(1 / 60, drive, W);
  line(`look ${lx},${ly},${lz}`);
}
