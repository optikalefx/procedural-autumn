import { SPECIES, growTree } from '../../src/vegetation/tree_species.js';
import { buildBarkGeometry, buildLeafGeometry } from '../../src/vegetation/tree_geometry.js';
let tot = {};
for (const sp of SPECIES) {
  let bark4 = 0, bark5 = 0, leaf = 0, mid = 0, midbark = 0;
  for (let v = 0; v < 5; v++) {
    const t = growTree(sp, (12345) + v * 104729);
    bark4 += buildBarkGeometry(t, sp, { radialSegs: 4, maxLevel: 2 }).index.count / 3;
    bark5 += buildBarkGeometry(t, sp, { radialSegs: 5, maxLevel: 2 }).index.count / 3;
    leaf += buildLeafGeometry(t, { keep: 1 }).index.count / 3;
    if (v < 2) { mid += buildLeafGeometry(t, { keep: 4, sizeBoost: 0.86 }).index.count / 3;
                 midbark += buildBarkGeometry(t, sp, { radialSegs: 3, maxLevel: 0 }).index.count / 3; }
  }
  console.log(sp.key, 'near bark@4', (bark4/5)|0, 'bark@5', (bark5/5)|0, 'near leaf', (leaf/5)|0,
              'mid leaf', (mid/2)|0, 'mid bark', (midbark/2)|0);
}
