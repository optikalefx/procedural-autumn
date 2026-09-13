// ─────────────────────────────────────────────────────────────────────────────
//  trace_props — the quiet things a prior camper left on the ground.
//
//  The start scuff (cold ring, stake holes, journal) plus the wider leftover
//  pool: a pinned note, a tipped bike, tracks, a tin, a stick, a rope, a
//  second night, and — when the seed has them — a canoe, a paddle, a cairn.
//  Nothing here smokes, glows, or asks to be collected.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { Parts, at, campMaterials, tintOf } from '../camp/camp_materials.js';
import { standOn, groundLift } from '../camp/camp_site.js';
import { clamp01, lerp, smoothstep } from '../core/MathUtils.js';
import { buildJournal, BOOK, HIDE_LIFT } from '../journal/journal_model.js';
import { buildBike, BIKE_DIM } from '../bike/bike_model.js';
import { buildCanoe, CANOE_DIM } from '../boat/boat_canoe.js';

const TAU = Math.PI * 2;

// Albedo in the vertex colour, on a white material. The live fire ring
// multiplies through `stone` (#7d7871) and is saved by the firelight; the
// same product in daylight fell into the stylise floor and read as coal.
const STONE = [
  tintOf(0x8b8279), tintOf(0x6e7278), tintOf(0x9a8b76),
  tintOf(0x7a7670), tintOf(0x968e83), tintOf(0x8a7f70),
];
const ASH = tintOf(0xa39c94);
const ASH_COOL = tintOf(0x8a847c);

/**
 * Own material, own program. Two things made a leftover cobble draw black
 * in daylight: the camp stone singleton is compiled against the pre-warm
 * fire, and its vertex-colour × #7d7871 product sits under the stylise
 * floor without a fire to lift it. A fresh un-tinted standard material
 * harvests cleanly and reads as river stone.
 */
function traceMat(key) {
  const src = campMaterials()[key];
  return new THREE.MeshStandardMaterial({
    color: key === 'char' ? 0x4a4038 : 0xa89f93,
    roughness: src.roughness,
    metalness: 0.02,
    envMapIntensity: 0.35,
    vertexColors: false,
  });
}

function flushTrace(P, parent, opts) {
  const made = P.flush(parent, { receive: false, ...opts });
  for (const mesh of made) {
    const key = mesh.name.slice(mesh.name.lastIndexOf('_') + 1);
    if (campMaterials()[key]) {
      mesh.material = traceMat(key);
      mesh.receiveShadow = false;
    }
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
          lerp(base[0], base[0] * 0.72, k),
          lerp(base[1], base[1] * 0.70, k),
          lerp(base[2], base[2] * 0.68, k),
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
      tintOf(0x3a322c));
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
  const DIRT = tintOf(0x8a7358);
  const HOLE = tintOf(0x3a3028);
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
  const n = 5 + Math.floor(rnd() * 2);
  let y = 0;
  for (let i = 0; i < n; i++) {
    const s = 0.10 * (1 - i * 0.07) + rnd() * 0.02;
    const stone = new THREE.Mesh(
      cobble(rnd, s),
      propMat(0xc2b8aa, { roughness: 0.9 }),
    );
    const sy = 0.58 + rnd() * 0.2;
    y += s * sy * 0.74;
    stone.position.set((rnd() - 0.5) * 0.04, y, (rnd() - 0.5) * 0.04);
    stone.rotation.set(rnd() * 0.5, rnd() * TAU, rnd() * 0.4);
    stone.scale.y = sy;
    stone.castShadow = false;
    stone.receiveShadow = false;
    g.add(stone);
    y += s * sy * 0.40;
  }
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

// ── the wider leftover pool ──────────────────────────────────────────────────
//
// These sit out in the valley, not on the start dirt. They use their own
// materials (or the bike / canoe builders') so they do not inherit the camp
// stone singleton — that product went black in daylight once already.

function propMat(color, extra = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.84,
    metalness: 0.03,
    envMapIntensity: 0.32,
    vertexColors: false,
    ...extra,
  });
}

/** Cream scrap pinned to a trunk. The words live on the overlay, not the mesh. */
export function buildTreeNote(rnd) {
  const g = new THREE.Group();
  g.name = 'trace_tree_note';
  const paper = new THREE.Mesh(
    new THREE.PlaneGeometry(0.16, 0.22),
    propMat(0xf0e4cc, { roughness: 0.94, metalness: 0, side: THREE.DoubleSide }),
  );
  paper.position.z = 0.006;
  paper.rotation.z = (rnd() - 0.5) * 0.14;
  g.add(paper);
  const pin = new THREE.Mesh(
    new THREE.SphereGeometry(0.01, 8, 6),
    propMat(0x6a4030, { roughness: 0.55, metalness: 0.08 }),
  );
  pin.position.set(0, 0.09, 0.014);
  g.add(pin);
  g.userData.trace = { kind: 'tree-note', pickR: 0.28 };
  return g;
}

/**
 * A packer bike on its side. Origin stays on the ground; the wrap is what
 * `placeOnGround` stands. Not a rideable Bike system object.
 */
export function buildTippedBike(rnd) {
  const wrap = new THREE.Group();
  wrap.name = 'trace_bike';
  const bike = buildBike(rnd, {
    style: 'packer',
    colorway: 2 + Math.floor(rnd() * 2),
    wear: 0.55 + rnd() * 0.32,
    rack: true,
  });
  // Fall onto +X. After rot-z the bars' half-width is the height of the pile.
  bike.rotation.z = Math.PI / 2 + (rnd() - 0.5) * 0.10;
  bike.position.y = BIKE_DIM.width * 0.28;
  bike.position.x = -0.06;
  wrap.add(bike);
  wrap.userData.trace = { kind: 'bike', pickR: 1.15 };
  return wrap;
}

/**
 * Canoe heeled on a bank. The pack paddle stays in the boat file; we hide
 * those so the put-in leftover is a separate crumb, not a third blade.
 */
export function buildBeachedCanoe(rnd) {
  const wrap = new THREE.Group();
  wrap.name = 'trace_canoe';
  const canoe = buildCanoe(rnd, { colorway: 1 + Math.floor(rnd() * 2) });
  for (const p of Object.values(canoe.userData.paddles ?? {})) p.visible = false;
  if (canoe.userData.paddle) canoe.userData.paddle.visible = false;
  canoe.rotation.z = Math.PI * (0.52 + rnd() * 0.12);
  canoe.position.y = CANOE_DIM.beam * 0.46;
  wrap.add(canoe);
  wrap.userData.trace = { kind: 'canoe', pickR: 2.15 };
  return wrap;
}

/** Shaft and blade, leaned as if the rock it was against walked off. */
export function buildLeanedPaddle(rnd) {
  const wrap = new THREE.Group();
  wrap.name = 'trace_paddle';
  const g = new THREE.Group();
  const wood = propMat(0xc4a06a, { roughness: 0.72 });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.016, 1.08, 7), wood);
  shaft.position.y = 0.54;
  const blade = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 8, 6),
    propMat(0xb08950, { roughness: 0.7 }),
  );
  blade.scale.set(0.70, 1.9, 0.13);
  blade.position.y = 1.22;
  g.add(shaft, blade);
  // Lean lives on the child. placeOnGround writes the wrap's quaternion.
  g.rotation.z = 0.95 + rnd() * 0.12;
  wrap.add(g);
  wrap.userData.trace = { kind: 'paddle', pickR: 0.62 };
  return wrap;
}

export function buildCoffeeTin(rnd) {
  const g = new THREE.Group();
  g.name = 'trace_tin';
  const h = 0.112, r = 0.036;
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r * 1.03, h, 12),
    propMat(0xb45a3c, { roughness: 0.62 }),
  );
  body.position.y = h * 0.5;
  const lid = new THREE.Mesh(
    new THREE.CylinderGeometry(r * 1.05, r * 1.05, 0.007, 12),
    propMat(0x8a6a50, { roughness: 0.7 }),
  );
  lid.position.set(0.068 + rnd() * 0.02, 0.004, 0.03 + rnd() * 0.02);
  lid.rotation.set(0.18, rnd(), 0.12);
  g.add(body, lid);
  g.userData.trace = { kind: 'tin', pickR: 0.22 };
  return g;
}

/** A spent roasting switch on the ground — not the camp's leaning hero prop. */
export function buildLaidStick(rnd) {
  const g = new THREE.Group();
  g.name = 'trace_stick';
  const L = 1.12 + rnd() * 0.10;
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.006, 0.013, L, 7),
    propMat(0x6e5336, { roughness: 0.9 }),
  );
  shaft.rotation.z = Math.PI / 2;
  shaft.position.set(L * 0.5, 0.012, 0);
  const mallow = new THREE.Mesh(
    new THREE.SphereGeometry(0.022, 8, 6),
    propMat(0xf2ebe0, { roughness: 0.96, metalness: 0 }),
  );
  mallow.scale.set(1, 0.68, 0.84);
  mallow.position.set(L - 0.03, 0.026, 0);
  g.add(shaft, mallow);
  g.userData.trace = { kind: 'stick', pickR: 0.58 };
  return g;
}

/** Two fading bicycle ruts. Soft, not a road decal. */
export function buildTireTracks(rnd) {
  const g = new THREE.Group();
  g.name = 'trace_tracks';
  const dirt = propMat(0x6e4c34, { roughness: 0.96 });
  const n = 5;
  for (let s = -1; s <= 1; s += 2) {
    for (let i = 0; i < n; i++) {
      const fade = 1 - i / n;
      const len = 0.55 * fade + 0.28;
      const w = 0.14 * (0.6 + 0.4 * fade);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, len), dirt);
      mesh.position.set(s * 0.40 + (rnd() - 0.5) * 0.04, 0.006, i * 0.62);
      mesh.rotation.y = (rnd() - 0.5) * 0.08;
      mesh.castShadow = false;
      g.add(mesh);
    }
  }
  g.userData.trace = { kind: 'tracks', pickR: 1.55 };
  return g;
}

/** A coil and trailing end on the facing side of a trunk — not a buried ring. */
export function buildTrunkRope(rnd, trunkR = 0.14) {
  const g = new THREE.Group();
  g.name = 'trace_rope';
  const cord = propMat(0xe2d2a6, { roughness: 0.86, metalness: 0 });
  const R = 0.11;
  const loop = new THREE.Mesh(
    new THREE.TorusGeometry(R, 0.018, 6, 12),
    cord,
  );
  loop.position.set(0, 1.05, 0.02);
  loop.rotation.y = 0.18;
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.007, 0.72, 6), cord);
  tail.position.set(0.08, 0.62, 0.04);
  tail.rotation.z = 0.28 + rnd() * 0.1;
  g.add(loop, tail);
  g.userData.trace = { kind: 'rope', pickR: 0.55 };
  return g;
}
