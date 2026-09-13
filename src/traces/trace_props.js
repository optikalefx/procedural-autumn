// ─────────────────────────────────────────────────────────────────────────────
//  trace_props — the quiet things a prior camper left on the ground.
//
//  Cold ring, stake holes, a small cairn, and the journal lying where it was
//  put down. Built from the camp material kit so they sit in the same light
//  as a fire someone is still using. Nothing here smokes, glows, or asks to
//  be collected.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { Parts, at, campMaterials } from '../camp/camp_materials.js';
import { standOn, groundLift } from '../camp/camp_site.js';
import { buildJournal, BOOK, HIDE_LIFT } from '../journal/journal_model.js';

const TAU = Math.PI * 2;

/** A lumpy cobble — same primitive the fire ring uses, kept local so that
 *  file does not have to export its workshop. */
function cobble(rnd, R) {
  const g = new THREE.IcosahedronGeometry(R, 1);
  const p = g.attributes.position;
  const ph = [rnd() * TAU, rnd() * TAU, rnd() * TAU, rnd() * TAU];
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const d = 1
      + 0.12 * Math.sin(v.x * 3.1 + ph[0]) * Math.cos(v.z * 2.7 + ph[1])
      + 0.07 * Math.sin(v.y * 4.4 + ph[2])
      + 0.04 * Math.sin(v.x * 7.0 + v.z * 5.2 + ph[3]);
    v.multiplyScalar(R * d);
    v.y *= 0.62 + rnd() * 0.16;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

const STONE = [
  [0.49, 0.47, 0.44], [0.42, 0.43, 0.46], [0.54, 0.50, 0.44],
  [0.38, 0.37, 0.36], [0.50, 0.48, 0.43],
];

export function buildColdRing(rnd) {
  const g = new THREE.Group();
  g.name = 'trace_cold_ring';
  const P = new Parts('trace_ring');
  const n = 9 + Math.floor(rnd() * 3);
  const R = 0.50;
  const gap = Math.floor(rnd() * n);
  for (let i = 0; i < n; i++) {
    if (i === gap && rnd() < 0.55) continue;
    const a = (i / n) * TAU + (rnd() - 0.5) * 0.28;
    const rr = R * (0.92 + rnd() * 0.16);
    const s = 0.068 + Math.pow(rnd(), 1.4) * 0.070;
    const cx = Math.cos(a) * rr, cz = Math.sin(a) * rr;
    const sink = 0.38 + rnd() * 0.28;
    const sy = 0.70 + rnd() * 0.40;
    const cy = s * sy * (1 - sink);
    const geo = cobble(rnd, s);
    const base = STONE[Math.floor(rnd() * STONE.length)];
    const inx = -Math.cos(a), inz = -Math.sin(a);
    const soot = 0.22 + rnd() * 0.18;
    P.add(geo, 'stone', at(cx, cy, cz, rnd() * 0.4, a, rnd() * 0.3, 1, sy, 1),
      (x, y, z) => {
        const dx = x - cx, dz = z - cz;
        const l = Math.hypot(dx, dz) || 1;
        const facing = Math.max(0, (dx * inx + dz * inz) / l);
        const k = soot * facing * facing;
        return [base[0] * (1 - 0.45 * k), base[1] * (1 - 0.48 * k), base[2] * (1 - 0.50 * k)];
      });
  }
  // Grey ash, not coals. A cold ring is a colour, not a light.
  const bed = new THREE.CircleGeometry(R * 0.72, 10);
  bed.rotateX(-Math.PI / 2);
  P.add(bed, 'stone', at(0, 0.008, 0), [0.36, 0.34, 0.31]);
  P.flush(g);
  g.userData.trace = { kind: 'ring', pickR: 0.72 };
  return g;
}

/** Four holes where a tent's stakes came out. A rectangle, not a scatter. */
export function buildStakeHoles(rnd) {
  const g = new THREE.Group();
  g.name = 'trace_stake_holes';
  const P = new Parts('trace_stakes');
  const W = 1.55 + rnd() * 0.25;
  const D = 1.15 + rnd() * 0.20;
  const yaw0 = (rnd() - 0.5) * 0.35;
  const spots = [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]];
  for (const [lx, lz] of spots) {
    const jx = lx + (rnd() - 0.5) * 0.08;
    const jz = lz + (rnd() - 0.5) * 0.08;
    const r = 0.028 + rnd() * 0.010;
    // A cone point-down, sunk: the lip is the only part that reads.
    const hole = new THREE.ConeGeometry(r, 0.07, 6);
    hole.rotateX(Math.PI);
    P.add(hole, 'char', at(jx, -0.012, jz, 0, yaw0, 0), [0.16, 0.13, 0.11]);
    // A little thrown dirt beside the hole.
    const spoil = cobble(rnd, 0.034 + rnd() * 0.012);
    const sa = yaw0 + Math.atan2(jz, jx) + 0.4;
    P.add(spoil, 'stone',
      at(jx + Math.cos(sa) * 0.07, 0.006, jz + Math.sin(sa) * 0.07, 0.2, rnd(), 0.1, 1, 0.45, 1),
      [0.40, 0.34, 0.26]);
  }
  P.flush(g, { cast: false, receive: true });
  g.userData.trace = { kind: 'stakes', pickR: 1.15 };
  return g;
}

export function buildCairn(rnd) {
  const g = new THREE.Group();
  g.name = 'trace_cairn';
  const P = new Parts('trace_cairn');
  const n = 5 + Math.floor(rnd() * 3);
  let y = 0;
  for (let i = 0; i < n; i++) {
    const s = 0.075 * (1 - i * 0.09) + rnd() * 0.018;
    const geo = cobble(rnd, s);
    const sy = 0.55 + rnd() * 0.22;
    y += s * sy * 0.72;
    P.add(geo, 'stone',
      at((rnd() - 0.5) * 0.04, y, (rnd() - 0.5) * 0.04,
        rnd() * 0.5, rnd() * TAU, rnd() * 0.4, 1, sy, 1),
      STONE[Math.floor(rnd() * STONE.length)]);
    y += s * sy * 0.38;
  }
  P.flush(g);
  g.userData.trace = { kind: 'cairn', pickR: 0.38 };
  return g;
}

/**
 * The closed book, on the ground (or a parent already stood on the ground).
 *
 * Same seating as Camp._seatJournal — tipped onto its back, leather lifted
 * for a scene with no environment map — but parented to a holder we place,
 * not to a table. The overlay book is still the one the player reads.
 */
export function seatJournal(rnd, parent) {
  campMaterials();
  let book;
  try {
    book = buildJournal(rnd, { colorway: 0, shadow: false, lift: HIDE_LIFT });
  } catch (e) {
    console.error('[traces] journal builder threw', e);
    return null;
  }
  const holder = new THREE.Group();
  holder.name = 'trace_journal';
  holder.rotation.y = (rnd() - 0.5) * 0.8;
  book.rotation.x = -Math.PI / 2;
  book.position.y = BOOK.T / 2 + BOOK.COV;
  const J = book.userData.journal;
  book.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  for (const m of [J?.frontPivot, J?.backPivot, J?.spine]) {
    m?.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  }
  if (J?.frontPivot) J.frontPivot.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
  holder.add(book);
  parent.add(holder);
  holder.userData.trace = { kind: 'journal', pickR: 0.22 };
  return holder;
}

const _q = new THREE.Quaternion();

/** Stand a group on the heightfield. Returns the world y used. */
export function placeOnGround(world, group, x, z, yaw = 0, tilt = 0.82, footprint = 0.55) {
  const y = world.getHeight(x, z);
  standOn(world, x, z, yaw, tilt, _q);
  const lift = groundLift(world, x, z, _q, footprint);
  group.position.set(x, y + lift, z);
  group.quaternion.copy(_q);
  return y + lift;
}
