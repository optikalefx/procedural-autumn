// ─────────────────────────────────────────────────────────────────────────────
//  camp_table — the folding table.
//
//  PLACEHOLDER. Scaffolding only; see docs/CAMP_BRIEF.md.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { Parts, at, span, tube, M } from './camp_materials.js';

/** @returns {THREE.Group} origin at ground centre, +Z is the long front edge. */
export function buildTable(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'camp_table';
  const P = new Parts('table');
  const W = 0.56, D = 0.44, H = 0.40, SLATS = 7;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  for (let i = 0; i < SLATS; i++) {
    const z = (i / (SLATS - 1) - 0.5) * D;
    P.add(new THREE.BoxGeometry(W, 0.010, D / SLATS * 0.76), 'anod', at(0, H, z), [1, 1, 1]);
  }
  for (const sx of [-1, 1]) {
    const a = V(sx * W * 0.42, 0, -D * 0.40), b = V(sx * W * 0.42, H, D * 0.40);
    const c = V(sx * W * 0.42, 0, D * 0.40), d = V(sx * W * 0.42, H, -D * 0.40);
    P.add(tube(0.011, a.distanceTo(b)), 'alu', span(a, b, M()), [1, 1, 1]);
    P.add(tube(0.011, c.distanceTo(d)), 'alu', span(c, d, M()), [1, 1, 1]);
  }
  P.flush(g);
  g.userData.footprint = 0.40;
  return g;
}
