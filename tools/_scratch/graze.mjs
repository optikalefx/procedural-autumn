import * as THREE from 'three';
import { SPECIES, buildSpecies } from '../../src/wildlife/animal_species.js';
import { instantiate } from '../../src/wildlife/animal_rig.js';
import { AnimRig } from '../../src/wildlife/animal_anim.js';

const key = process.argv[2] || 'deer';
const grazeAmt = parseFloat(process.argv[3] ?? '1');
const sp = SPECIES[key];
const proto = buildSpecies(key, 12345)[0];
const v = sp.variants[0];
const inst = instantiate(proto, new THREE.MeshBasicMaterial(), 0);
const rig = new AnimRig(proto, inst, v.scale, sp.gait, key);
const root = new THREE.Group(); root.add(inst.mesh);
const pos = new THREE.Vector3();
const drive = { pos, heading: 0, speed: 0, graze: grazeAmt, alert: 0, flag: 0, look: null, lod: 0 };
rig.reset(pos, 0, { getHeight: () => 0 });
for (let i = 0; i < 400; i++) rig.update(1/60, drive, { getHeight: () => 0 });
root.updateMatrixWorld(true);
const w = (n) => { const b = inst.byName[n]; const p = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld); return p; };
const f = (p) => `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`;
console.log('species', key, 'scale', v.scale, 'graze', grazeAmt);
for (const n of ['root','pelvis','chest','neck1','neck2','head','earL']) {
  if (inst.byName[n]) console.log(' ', n.padEnd(7), f(w(n)));
}
console.log('  neckSpan', rig.neckSpan.toFixed(4), 'l1', rig.neck.l1.toFixed(4), 'l2', rig.neck.l2.toFixed(4));
console.log('  restAng', rig.restAng.toFixed(3), 'restLen', rig.restLen.toFixed(3), 'grazeAng', rig.grazeAng.toFixed(3), 'grazeLen', rig.grazeLen.toFixed(3));
console.log('  headTarget(local)', f(rig.headTarget));
console.log('  n1.rotX', rig.neck.a.rotation.x.toFixed(3), 'n2.rotX', rig.neck.b.rotation.x.toFixed(3), 'head.rotX', rig.head.rotation.x.toFixed(3));
// distance head bone -> where the neck geometry ends
const hd = w('head'), n2 = w('neck2');
console.log('  |head-neck2| world', hd.distanceTo(n2).toFixed(4), 'bind l2*scale', (rig.neck.l2*v.scale).toFixed(4));
// muzzle tip direction: head local +z rotated
const q = new THREE.Quaternion(); inst.byName['head'].getWorldQuaternion(q);
const fwd = new THREE.Vector3(0,0,1).applyQuaternion(q);
console.log('  head fwd', f(fwd));

// chest-frame numbers
const chest = inst.byName['chest'];
const m = new THREE.Matrix4().copy(chest.matrixWorld).invert();
const t = rig.headTarget.clone(); inst.mesh.localToWorld(t); t.applyMatrix4(m);
console.log('  target in chest frame', f(t));
console.log('  neck1 local pos (chest frame)', f(rig.neck.a.position));
console.log('  bindA', rig.neck.bindA.toFixed(3), 'bindB', rig.neck.bindB.toFixed(3));
const dy = t.y - rig.neck.a.position.y, dz = Math.hypot(t.x,t.z)*Math.sign(t.z||1) - rig.neck.a.position.z;
console.log('  d from neck1', Math.hypot(dy,dz).toFixed(4), 'dy', dy.toFixed(3), 'dz', dz.toFixed(3), 'span', rig.neckSpan.toFixed(4));
console.log('  chest world rot y-pitch', new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(chest.matrixWorld)).x.toFixed(3));

// muzzle tip: lowest skinned vertex bound to the head bone
{
  const g = inst.mesh.geometry;
  const p = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const iHead = proto.info.iHead;
  let lo = Infinity, loz = 0, hiz = -Infinity, hizy = 0;
  const tmp = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === iHead) w += sw.getComponent(i, k);
    if (w < 0.5) continue;
    tmp.fromBufferAttribute(p, i);
    inst.mesh.applyBoneTransform(i, tmp);
    inst.mesh.localToWorld(tmp);
    if (tmp.y < lo) { lo = tmp.y; loz = tmp.z; }
    if (tmp.z > hiz) { hiz = tmp.z; hizy = tmp.y; }
  }
  console.log('  muzzle lowest y', lo.toFixed(3), '@z', loz.toFixed(3), ' furthest z', hiz.toFixed(3), '@y', hizy.toFixed(3));
}
