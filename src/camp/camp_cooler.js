// ─────────────────────────────────────────────────────────────────────────────
//  camp_cooler — the hard cooler.
//
//  PLACEHOLDER. Scaffolding only; see docs/CAMP_BRIEF.md.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { Parts, at, rbox, tintFrom, dusted, tintMul } from './camp_materials.js';

export const COOLER_COLORWAYS = [0x8f3a3c, 0xd8d2c4, 0x35424a];

/** @returns {THREE.Group} origin at ground centre, +Z is the latch face. */
export function buildCooler(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'camp_cooler';
  const body = tintFrom(0x8f3a3c, COOLER_COLORWAYS[(opts.colorway ?? 0) % COOLER_COLORWAYS.length]);
  const P = new Parts('cooler');

  const W = 0.66, H = 0.38, D = 0.40, LID = 0.10;
  P.add(rbox(W, H - LID, D, 0.05, 3), 'hdpe', at(0, (H - LID) * 0.5, 0),
        tintMul(dusted([1, 1, 1], { top: 0.09, amount: 0.28 }), body));
  P.add(rbox(W * 1.01, LID, D * 1.01, 0.04, 3), 'hdpe', at(0, H - LID * 0.5, 0), body);
  for (const sx of [-1, 1]) {
    P.add(rbox(0.045, 0.10, 0.03, 0.012, 2), 'rubber', at(sx * W * 0.26, H - LID * 0.6, D * 0.5 + 0.008), [1, 1, 1]);
  }
  P.flush(g);
  g.userData.footprint = 0.46;
  return g;
}
