// ─────────────────────────────────────────────────────────────────────────────
//  camp_chair — the camp chair.
//
//  PLACEHOLDER. Scaffolding only; see docs/CAMP_BRIEF.md.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { Parts, at, span, tube, fabricPanel, tintOf, M } from './camp_materials.js';

export const CHAIR_COLORWAYS = [0x2b6a7a, 0x3f6b3a, 0xa8352c, 0x2f6f78];

/** @returns {THREE.Group} origin at ground centre, +Z is the seat front. */
export function buildChair(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'camp_chair';
  const col = tintOf(CHAIR_COLORWAYS[(opts.colorway ?? 0) % CHAIR_COLORWAYS.length]);
  const P = new Parts('chair');

  const SEAT = 0.36, W = 0.52, D = 0.46, BACK = 0.78;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  // Splayed X legs.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const a = V(sx * W * 0.30, 0.0, sz * D * 0.34);
    const b = V(sx * W * 0.20, SEAT, -sz * D * 0.18);
    const len = a.distanceTo(b);
    P.add(tube(0.0075, len), 'tube', span(a, b, M()), [1, 1, 1]);
  }
  // Seat rails.
  for (const sx of [-1, 1]) {
    const a = V(sx * W * 0.5, SEAT, -D * 0.5), b = V(sx * W * 0.5, SEAT, D * 0.5);
    P.add(tube(0.008, a.distanceTo(b)), 'tube', span(a, b, M()), [1, 1, 1]);
    const c = V(sx * W * 0.46, BACK, -D * 0.42);
    P.add(tube(0.008, a.distanceTo(c)), 'tube', span(a, c, M()), [1, 1, 1]);
  }
  // Sling.
  P.add(fabricPanel([
    V(-W * 0.48, SEAT, D * 0.48), V(W * 0.48, SEAT, D * 0.48),
    V(W * 0.46, BACK, -D * 0.40), V(-W * 0.46, BACK, -D * 0.40),
  ], 10, 12, 0.085), 'fabricIn', null, col);

  P.flush(g);
  g.userData.footprint = 0.42;
  return g;
}
