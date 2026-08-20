// ─────────────────────────────────────────────────────────────────────────────
//  camp_tent — the tent.
//
//  PLACEHOLDER. This is scaffolding so the system boots and the capture
//  harness has something to photograph; it is not the deliverable. See
//  docs/CAMP_BRIEF.md for the contract and the reference plates.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { Parts, at, fabricPanel, sweptArc, tintOf, sanitizeNormals } from './camp_materials.js';

export const TENT_COLORWAYS = [
  { fly: 0xe08a2c, floor: 0x6b4a2a },   // orange 1P dome
  { fly: 0x6f757c, floor: 0x2f3338 },   // grey cabin
  { fly: 0xe4dccb, floor: 0x6a5a42 },   // cream A-frame
  { fly: 0x2f6a6d, floor: 0x8a3b28 },   // teal / rust 4P dome
];

/** @returns {THREE.Group} origin at ground centre, +Z is the door. */
export function buildTent(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'camp_tent';
  const cw = TENT_COLORWAYS[(opts.colorway ?? 0) % TENT_COLORWAYS.length];
  const P = new Parts('tent');

  const L = 2.30, W = 1.55, H = 1.08;
  const fly = tintOf(cw.fly);

  // Two ridge arcs and a fabric skin between them.
  const arc = (u) => {
    const t = (u - 0.5) * 2;
    return new THREE.Vector3(t * W * 0.5, H * Math.cos(t * 1.32) / Math.cos(1.32) * 0 + H * (1 - t * t * 0.92), 0);
  };
  for (const z of [-L * 0.34, L * 0.34]) {
    const geo = sweptArc((u) => { const p = arc(u); return new THREE.Vector3(p.x, Math.max(p.y, 0.02), z); }, 20, 0.011, 5);
    P.add(geo, 'tube', null, [1, 1, 1]);
  }
  for (const s of [-1, 1]) {
    P.add(fabricPanel([
      new THREE.Vector3(s * W * 0.5, 0.02, -L * 0.5),
      new THREE.Vector3(s * W * 0.5, 0.02, L * 0.5),
      new THREE.Vector3(0, H, L * 0.5),
      new THREE.Vector3(0, H, -L * 0.5),
    ], 8, 10, -0.07), 'fabric', null, fly);
  }
  P.add(fabricPanel([
    new THREE.Vector3(-W * 0.5, 0.02, -L * 0.5),
    new THREE.Vector3(W * 0.5, 0.02, -L * 0.5),
    new THREE.Vector3(0, H, -L * 0.5),
    new THREE.Vector3(0, H, -L * 0.5),
  ], 6, 6, 0.03), 'fabric', null, fly);

  const floor = new THREE.BoxGeometry(W, 0.05, L);
  P.add(floor, 'fabricIn', at(0, 0.025, 0), tintOf(cw.floor));

  P.flush(g);
  g.userData.footprint = 1.45;
  return g;
}
