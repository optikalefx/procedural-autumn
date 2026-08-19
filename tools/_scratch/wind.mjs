import * as THREE from 'three';
import { SPECIES, growTree } from '../../src/vegetation/tree_species.js';
import { buildBarkGeometry } from '../../src/vegetation/tree_geometry.js';
for (const sp of [SPECIES[0], SPECIES[4]]) {
  const tree = growTree(sp, 1234);
  const g = buildBarkGeometry(tree, sp, { radialSegs: 4, maxLevel: 2 });
  const pos = g.attributes.position.array, nrm = g.attributes.normal.array, idx = g.index.array;
  let agree = 0, disagree = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), gn = new THREE.Vector3(), vn = new THREE.Vector3();
  for (let i = 0; i < idx.length; i += 3) {
    const [ia, ib, ic] = [idx[i], idx[i+1], idx[i+2]];
    a.fromArray(pos, ia*3); b.fromArray(pos, ib*3); c.fromArray(pos, ic*3);
    e1.subVectors(b, a); e2.subVectors(c, a); gn.crossVectors(e1, e2);
    if (gn.lengthSq() < 1e-16) continue;
    gn.normalize();
    vn.set(0,0,0);
    for (const k of [ia, ib, ic]) vn.x += nrm[k*3], vn.y += nrm[k*3+1], vn.z += nrm[k*3+2];
    if (vn.lengthSq() < 1e-16) continue;
    vn.normalize();
    if (gn.dot(vn) > 0) agree++; else disagree++;
  }
  console.log(sp.key, 'agree', agree, 'disagree', disagree);
}
