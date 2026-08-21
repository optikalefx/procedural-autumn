// Offline geometry census for camp_telescope.js — no browser, no dev server.
// Answers the questions a capture cannot: how far below y=0 does anything dip,
// how many draw calls, how many triangles, and where the counterweight is.
import * as THREE from 'three';
import { mulberry32 } from '/Users/sean/htdocs/procedural-fall/src/core/MathUtils.js';
import { buildTelescope } from '/Users/sean/htdocs/procedural-fall/src/camp/camp_telescope.js';

for (const variant of ['refractor', 'reflector']) {
  for (const seed of [1, 7, 99]) {
    const g = buildTelescope(mulberry32(seed), { variant, wear: 0.5 });
    g.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(g);
    let tris = 0, calls = 0;
    g.traverse((o) => { if (o.isMesh) { calls++; tris += o.geometry.getIndex()
      ? o.geometry.getIndex().count / 3 : o.geometry.attributes.position.count / 3; } });
    const d = g.userData.telescope;
    console.log(`${variant} seed ${seed}: h ${(bb.max.y - bb.min.y).toFixed(3)}  ` +
      `minY ${bb.min.y.toFixed(4)}  foot ${g.userData.footprint.toFixed(3)}  ` +
      `calls ${calls}  tris ${tris}  eye ${d.eye.toArray().map(n=>n.toFixed(2)).join(',')}  ` +
      `aim ${d.aim.toArray().map(n=>n.toFixed(2)).join(',')}`);
  }
}
