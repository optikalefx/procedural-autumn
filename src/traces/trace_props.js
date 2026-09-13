// ─────────────────────────────────────────────────────────────────────────────
//  trace_props — the quiet things a prior camper left on the ground.
//
//  Cold ring, stake holes, a small cairn, and the journal lying where it was
//  put down. Built from the camp material kit so they sit in the same light
//  as a fire someone is still using. Nothing here smokes, glows, or asks to
//  be collected.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { Parts, at, campMaterials, tintFrom } from '../camp/camp_materials.js';
import { standOn, groundLift } from '../camp/camp_site.js';
import { clamp01, lerp, smoothstep } from '../core/MathUtils.js';
import { buildJournal, BOOK, HIDE_LIFT } from '../journal/journal_model.js';

const TAU = Math.PI * 2;

// Multipliers through `stone` (#7d7871), same kit the live fire ring uses.
// Absolute RGB here would double-darken: vertex colour × material colour.
const STONE = [
  tintFrom(0x7d7871, 0x8b8279), tintFrom(0x7d7871, 0x6e7278),
  tintFrom(0x7d7871, 0x9a8b76), tintFrom(0x7d7871, 0x5c5e60),
  tintFrom(0x7d7871, 0x968e83), tintFrom(0x7d7871, 0x7a6f63),
];
const ASH = tintFrom(0x7d7871, 0x9a948c);
const ASH_COOL = tintFrom(0x7d7871, 0x7a756e);

/**
 * A new MeshStandardMaterial matching the camp kit, not the kit singleton.
 *
 * Camp pre-warms a fire under the loader and harvests `campMaterials().stone`
 * against that geometry. Reusing the compiled singleton on these leftovers
 * drew a black slab — vertex colours (0.56–1.43) and normals were fine; a
 * fresh standard material harvested in place lights like a cobble. Same
 * albedo and roughness so they still sit in the same valley as a live ring.
 */
function traceMat(key) {
  const src = campMaterials()[key];
  return new THREE.MeshStandardMaterial({
    color: src.color.clone(),
    roughness: src.roughness,
    metalness: src.metalness,
    envMapIntensity: src.envMapIntensity,
    vertexColors: true,
  });
}

function flushTrace(P, parent, opts) {
  const made = P.flush(parent, opts);
  for (const mesh of made) {
    const key = mesh.name.slice(mesh.name.lastIndexOf('_') + 1);
    if (campMaterials()[key]) mesh.material = traceMat(key);
  }
  return made;
}

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

/** Low ash dome — same idea as the live pit, paler because this one went out. */
function ashBed(rnd, R) {
  const seg = 16;
  const radii = [0, 0.28, 0.56, 0.80, 1].map((k) => k * R);
  const H = [0.028, 0.024, 0.016, 0.007, 0.0];
  const ring = radii.map((r, ri) => {
    const out = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * TAU;
      const wob = 1 + (ri === 0 ? 0 : 0.09 * Math.sin(a * 3 + ri) + 0.05 * Math.sin(a * 5 + ri * 2));
      out.push(new THREE.Vector3(
        Math.cos(a) * r * wob,
        H[ri] + (ri === 0 ? 0 : (rnd() - 0.5) * 0.008),
        Math.sin(a) * r * wob));
    }
    return out;
  });
  const pos = [];
  const tri = (a, b, c) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    tri(ring[0][0], ring[1][j], ring[1][i]);
    for (let r = 1; r < radii.length - 1; r++) {
      tri(ring[r][i], ring[r][j], ring[r + 1][j]);
      tri(ring[r][i], ring[r + 1][j], ring[r + 1][i]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  return g;
}

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
    const s = 0.078 + Math.pow(rnd(), 1.4) * 0.078;
    const cx = Math.cos(a) * rr, cz = Math.sin(a) * rr;
    const sink = 0.22 + rnd() * 0.20;
    const sy = 0.78 + rnd() * 0.36;
    const cy = s * sy * (1 - sink);
    const geo = cobble(rnd, s);
    const base = STONE[Math.floor(rnd() * STONE.length)];
    const inx = -Math.cos(a), inz = -Math.sin(a);
    const soot = 0.12 + rnd() * 0.14;
    P.add(geo, 'stone',
      at(cx, cy, cz, (rnd() - 0.5) * 0.4, a, (rnd() - 0.5) * 0.3, 1, sy, 1),
      (x, y, z) => {
        const dx = x - cx, dz = z - cz;
        const l = Math.hypot(dx, dz) || 1;
        const facing = Math.max(0, (dx * inx + dz * inz) / l);
        const k = soot * facing * facing;
        return [
          lerp(base[0], 0.42, k),
          lerp(base[1], 0.40, k),
          lerp(base[2], 0.38, k),
        ];
      });
  }
  // Pale wood ash, not a charcoal disc. A cold ring is a colour.
  const ph = rnd() * TAU;
  P.add(ashBed(rnd, R * 0.74), 'stone', null, (x, y, z) => {
    const d = Math.hypot(x, z) / (R * 0.74);
    const grain = 0.5 + 0.5 * Math.sin(x * 19 + ph) * Math.cos(z * 15 - ph);
    const k = clamp01(smoothstep(0.15, 0.92, d) * 0.55 + grain * 0.18);
    return [lerp(ASH_COOL[0], ASH[0], k), lerp(ASH_COOL[1], ASH[1], k), lerp(ASH_COOL[2], ASH[2], k)];
  });
  // Two spent bits of fuel — the fire is out; these stayed.
  for (let i = 0; i < 2; i++) {
    const a = rnd() * TAU, r = R * (0.12 + rnd() * 0.38);
    const s = 0.024 + rnd() * 0.018;
    P.add(new THREE.TetrahedronGeometry(s, 0), 'char',
      at(Math.cos(a) * r, 0.018 + s * 0.35, Math.sin(a) * r,
         rnd() * TAU, rnd() * TAU, rnd() * TAU, 1.2, 0.7, 1.0),
      [1.05, 1.0, 0.96]);
  }
  flushTrace(P, g);
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
  const DIRT = tintFrom(0x7d7871, 0x8a7358);
  const HOLE = tintFrom(0x241d1c, 0x2a221c);
  for (const [lx, lz] of spots) {
    const jx = lx + (rnd() - 0.5) * 0.08;
    const jz = lz + (rnd() - 0.5) * 0.08;
    const r = 0.034 + rnd() * 0.010;
    // Point-down cone, plus a raised dirt lip — the lip is what reads at play
    // distance; a 2 cm dent disappears into the meadow.
    const hole = new THREE.ConeGeometry(r, 0.08, 6);
    hole.rotateX(Math.PI);
    P.add(hole, 'char', at(jx, -0.008, jz, 0, yaw0, 0), HOLE);
    const lip = new THREE.TorusGeometry(r * 0.92, 0.012, 5, 8);
    lip.rotateX(Math.PI / 2);
    P.add(lip, 'stone', at(jx, 0.010, jz, 0.08, yaw0, 0.05), DIRT);
    const spoil = cobble(rnd, 0.042 + rnd() * 0.016);
    const sa = yaw0 + Math.atan2(jz, jx) + 0.4;
    P.add(spoil, 'stone',
      at(jx + Math.cos(sa) * 0.08, 0.012, jz + Math.sin(sa) * 0.08, 0.25, rnd(), 0.12, 1, 0.48, 1),
      DIRT);
  }
  flushTrace(P, g, { cast: false, receive: true });
  g.userData.trace = { kind: 'stakes', pickR: 1.15 };
  return g;
}

export function buildCairn(rnd) {
  const g = new THREE.Group();
  g.name = 'trace_cairn';
  const P = new Parts('trace_cairn');
  const n = 6 + Math.floor(rnd() * 2);
  let y = 0;
  for (let i = 0; i < n; i++) {
    const s = 0.095 * (1 - i * 0.08) + rnd() * 0.022;
    const geo = cobble(rnd, s);
    const sy = 0.58 + rnd() * 0.22;
    y += s * sy * 0.74;
    P.add(geo, 'stone',
      at((rnd() - 0.5) * 0.045, y, (rnd() - 0.5) * 0.045,
        rnd() * 0.5, rnd() * TAU, rnd() * 0.4, 1, sy, 1),
      STONE[Math.floor(rnd() * STONE.length)]);
    y += s * sy * 0.40;
  }
  flushTrace(P, g);
  g.userData.trace = { kind: 'cairn', pickR: 0.42 };
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

/**
 * Stand a group on the heightfield — or on a CampGround floor if `floorY`
 * is passed (the dirt skin sits proud of the analytic field).
 */
export function placeOnGround(world, group, x, z, yaw = 0, tilt = 0.82, footprint = 0.55, floorY = null) {
  standOn(world, x, z, yaw, tilt, _q);
  const y = Number.isFinite(floorY)
    ? floorY
    : world.getHeight(x, z) + groundLift(world, x, z, _q, footprint);
  group.position.set(x, y, z);
  group.quaternion.copy(_q);
  return y;
}
