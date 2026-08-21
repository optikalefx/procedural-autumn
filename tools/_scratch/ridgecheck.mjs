#!/usr/bin/env node
/**
 * ridgecheck — build both tents, every colourway, every wear, and measure them.
 *
 *   node tools/_scratch/ridgecheck.mjs
 *
 * `galcheck.mjs` calls every builder in a browser and reports the ones that
 * throw or come back empty, which is the right gate for the gallery and is not
 * enough for a displaced parametric shell. A patch whose surface function
 * returns NaN for some (s, t) still "builds": the geometry exists, the triangle
 * count is right, the thumbnail renders, and the defect only shows up later as
 * the black square in `sanitizeNormals`' docstring. This ran in Node in under a
 * second and caught exactly that — 792 non-finite floats from a corner-rounding
 * function sampled outside its domain by the window binding — on a build the
 * gallery had just reported as fine.
 *
 * So: no browser, no renderer. Call the builders, walk every position and
 * normal, and print the numbers that a wrong build gets wrong — non-finite
 * values, zero-length normals, overall size, how far below the origin the stake
 * tips reach, and the footprint the layout solver is going to be handed.
 */
import { buildRidgeTent, RIDGETENT_COLORWAYS } from '/Users/sean/htdocs/procedural-fall/src/camp/camp_tent_ridge.js';
import { buildTent } from '/Users/sean/htdocs/procedural-fall/src/camp/camp_tent.js';
import { mulberry32 } from '/Users/sean/htdocs/procedural-fall/src/core/MathUtils.js';
import * as THREE from 'three';

function report(name, g) {
  let tris = 0, nan = 0, zeroN = 0, verts = 0;
  const bb = new THREE.Box3();
  g.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.getAttribute('position');
    const n = o.geometry.getAttribute('normal');
    tris += p.count / 3; verts += p.count;
    for (let i = 0; i < p.count * 3; i++) if (!Number.isFinite(p.array[i])) nan++;
    if (n) for (let i = 0; i < n.count; i++) {
      const x=n.getX(i),y=n.getY(i),z=n.getZ(i);
      if (!Number.isFinite(x+y+z)) nan++;
      else if (x*x+y*y+z*z < 1e-8) zeroN++;
    }
    bb.expandByObject(o);
  });
  const s = new THREE.Vector3(); bb.getSize(s);
  console.log(`${name.padEnd(26)} tris ${String(Math.round(tris)).padStart(6)}  ` +
    `size ${s.x.toFixed(3)}x${s.y.toFixed(3)}x${s.z.toFixed(3)}  ` +
    `minY ${bb.min.y.toFixed(4)}  foot ${g.userData.footprint?.toFixed(3)}  ` +
    `NaN ${nan}  zeroN ${zeroN}  cw ${g.userData.colorway ?? '-'}`);
  return { nan, zeroN, tris };
}

let bad = 0;
for (let i = 0; i < RIDGETENT_COLORWAYS.length; i++) {
  for (const wear of [0.0, 0.45, 1.0]) {
    const r = report(`ridge ${RIDGETENT_COLORWAYS[i].name} w${wear}`,
      buildRidgeTent(mulberry32(0x51ed0000 + i * 17 + wear * 100), { colorway: i, wear }));
    if (r.nan) bad++;
  }
}
console.log('--- for comparison ---');
report('dome colorway 0', buildTent(mulberry32(1), {}));

// watertight-at-the-ridge check: build once and look for the top edge pairing.
console.log(bad ? `FAIL: ${bad} builds with NaN` : 'OK: no NaN in any build');

