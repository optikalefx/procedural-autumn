// Throwaway: build the table headlessly and print per-mesh bounds + vertex
// colour range, so a missing part can be found without paying for a capture.
import * as THREE from 'three';
import { buildTable } from '../../src/camp/camp_table.js';

let s = 12345;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

const g = buildTable(rnd, { wear: 0.5, dressed: true });
g.traverse((o) => {
  if (!o.isMesh) return;
  o.geometry.computeBoundingBox();
  const b = o.geometry.boundingBox;
  const c = o.geometry.getAttribute('color');
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < c.count; i++) { const v = c.getX(i); if (v < lo) lo = v; if (v > hi) hi = v; }
  console.log(o.name.padEnd(16),
    'tris', String(o.geometry.getAttribute('position').count / 3).padStart(6),
    ` x[${b.min.x.toFixed(3)},${b.max.x.toFixed(3)}]`,
    ` y[${b.min.y.toFixed(3)},${b.max.y.toFixed(3)}]`,
    ` z[${b.min.z.toFixed(3)},${b.max.z.toFixed(3)}]`,
    ` col[${lo.toFixed(2)},${hi.toFixed(2)}]`);
});
console.log('footprint', g.userData.footprint);
