// ─────────────────────────────────────────────────────────────────────────────
//  Species definitions and the procedural grower.
//
//  Every tree in the world is one of a handful of *prototypes* — a species
//  grown with a fixed variant seed — instanced thousands of times. So the
//  variants have to carry all the silhouette variety on their own: lean,
//  branch count, crown asymmetry and height are all re-rolled per variant, and
//  per-instance yaw / scale / palette do the rest.
//
//  The grower returns a species-agnostic description:
//    strands  — poly-lines with radii, extruded into bark geometry
//    clusters — leaf-clump billboards positioned over the crown volume
//  Both are in tree-local space with the base at the origin, +Y up.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { PALETTE } from '../world/WorldConfig.js';
import { mulberry32, lerp, clamp01, smoothstep } from '../core/MathUtils.js';
import { TILE } from './tree_textures.js';

const TAU = Math.PI * 2;
const GOLDEN = 2.39996323;

// Bark styles the shader knows how to draw: 0 = pale birch with dark scars,
// 1 = ridged brown, 2 = dark red-brown conifer.
export const BARK = { BIRCH: 0, ROUGH: 1, CONIFER: 2 };

const c = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// ── Species table ────────────────────────────────────────────────────────────
// `palettes` are (colA, colB) pairs; a tree picks one pair and every cluster
// mixes between them by a coherent noise, so one crown carries two related
// hues in clumps rather than a single flat colour.
export const SPECIES = [
  {
    key: 'birch',
    height: [13, 21],
    trunkFrac: 0.94,            // how much of H the leader occupies
    trunkRadiusK: 0.0165,       // base radius / height — birch is a wand
    taperPow: 0.85,
    lean: 0.055, curve: 0.55, gnarl: 0.30,
    trunkSegs: 9,
    levels: 2,
    branchStart: 0.40, branchEnd: 0.96,
    branchCount: [6, 10],
    branchAngle: [0.55, 1.05],  // radians from the parent's direction
    branchLen: [0.20, 0.36],
    branchUp: 0.55,             // re-aim toward vertical: birch sweeps up
    branchSegs: 4,
    subLen: 0.52, subCount: [2, 3], subAngle: [0.5, 0.9],
    bark: BARK.BIRCH,
    barkColor: PALETTE.barkBirch,
    clusterCount: 195,
    clusterSize: [0.048, 0.082], // fraction of H
    clusterAspect: 1.15,
    tipBlob: 0.090,
    tile: TILE.FINE,
    crownLift: 0.06,
    palettes: [
      [PALETTE.leafGold, PALETTE.leafLimeFade],
      [PALETTE.leafGold, PALETTE.leafAmber],
      [PALETTE.leafAmber, c(0xf6dd72)],
    ],
  },
  {
    key: 'aspen',
    height: [12, 19],
    trunkFrac: 0.96,
    trunkRadiusK: 0.0150,
    taperPow: 0.80,
    lean: 0.030, curve: 0.25, gnarl: 0.16,   // aspens are conspicuously straight
    trunkSegs: 8,
    levels: 1,
    branchStart: 0.46, branchEnd: 0.98,
    branchCount: [7, 11],
    branchAngle: [0.35, 0.75],
    branchLen: [0.16, 0.26],
    branchUp: 0.80,             // tight, near-columnar crown
    branchSegs: 3,
    subLen: 0.5, subCount: [1, 2], subAngle: [0.4, 0.7],
    bark: BARK.BIRCH,
    barkColor: PALETTE.barkAspen,
    clusterCount: 180,
    clusterSize: [0.044, 0.074],
    clusterAspect: 1.0,
    tipBlob: 0.078,
    tile: TILE.FINE,
    crownLift: 0.10,
    crownSquash: 1.35,          // taller than wide
    palettes: [
      [PALETTE.leafGold, c(0xffe066)],
      [PALETTE.leafGold, PALETTE.leafAmber],
      [c(0xffd23f), PALETTE.leafLimeFade],
    ],
    clonal: true,
  },
  {
    key: 'maple',
    height: [11, 17],
    trunkFrac: 0.58,            // short bole, then it forks
    trunkRadiusK: 0.030,
    taperPow: 0.65,
    lean: 0.07, curve: 0.5, gnarl: 0.35,
    trunkSegs: 6,
    levels: 2,
    branchStart: 0.42, branchEnd: 1.0,
    branchCount: [4, 6],
    branchAngle: [0.75, 1.25],
    branchLen: [0.42, 0.62],
    branchUp: 0.35,             // broad spreading crown
    branchSegs: 4,
    subLen: 0.55, subCount: [2, 4], subAngle: [0.6, 1.05],
    bark: BARK.ROUGH,
    barkColor: PALETTE.barkMaple,
    clusterCount: 235,
    clusterSize: [0.058, 0.098],
    clusterAspect: 1.25,
    tipBlob: 0.125,
    tile: TILE.BROAD,
    crownLift: -0.02,
    crownSquash: 0.80,          // wider than tall
    palettes: [
      [PALETTE.leafCrimson, PALETTE.leafOrange],
      [PALETTE.leafOrange, PALETTE.leafAmber],
      [PALETTE.leafCrimson, PALETTE.leafRust],
    ],
  },
  {
    key: 'oak',
    height: [10, 16],
    trunkFrac: 0.46,
    trunkRadiusK: 0.045,        // heavy bole
    taperPow: 0.50,
    lean: 0.10, curve: 0.8, gnarl: 0.85,     // gnarled, wandering limbs
    trunkSegs: 6,
    levels: 2,
    branchStart: 0.34, branchEnd: 1.0,
    branchCount: [4, 6],
    branchAngle: [0.85, 1.45],
    branchLen: [0.45, 0.70],
    branchUp: 0.18,
    branchSegs: 5,
    subLen: 0.5, subCount: [2, 4], subAngle: [0.7, 1.2],
    bark: BARK.ROUGH,
    barkColor: c(0x5d4634),
    clusterCount: 245,
    clusterSize: [0.062, 0.105],
    clusterAspect: 1.3,
    tipBlob: 0.135,
    tile: TILE.BROAD,
    crownLift: -0.04,
    crownSquash: 0.70,
    palettes: [
      [PALETTE.leafRust, c(0x8a6a38)],       // oak holds dead brown leaves
      [PALETTE.leafRust, PALETTE.leafAmber],
      [c(0xa8552a), c(0x7a5a33)],
    ],
  },
  {
    key: 'spruce',
    conifer: true,
    height: [16, 30],
    trunkRadiusK: 0.020,
    taperPow: 1.15,
    lean: 0.018, curve: 0.10, gnarl: 0.08,
    trunkSegs: 10,
    crownR: 0.155,              // crown radius / H — a narrow spire
    crownBase: 0.10,            // whorls start at this fraction of H
    whorls: [11, 15],
    boughs: [6, 9],
    boughDroop: 0.34,
    bark: BARK.CONIFER,
    barkColor: PALETTE.barkPine,
    clusterSize: [0.042, 0.066],
    clusterAspect: 2.0,         // boughs are wide and flat
    tile: TILE.NEEDLE,
    palettes: [
      [PALETTE.coniferLit, PALETTE.coniferDeep],
      [PALETTE.coniferMid, PALETTE.coniferDeep],
      [c(0x5c7d4a), c(0x24402c)],
    ],
  },
];

export const SPECIES_INDEX = Object.fromEntries(SPECIES.map((s, i) => [s.key, i]));

// ── small helpers ────────────────────────────────────────────────────────────
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

function randRange(rng, r) { return lerp(r[0], r[1], rng()); }
function randInt(rng, r) { return Math.round(lerp(r[0], r[1], rng())); }

/** Cheap deterministic 3-D value noise — used for coherent crown colour patches. */
function vnoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const h = (a, b, cc) => {
    let n = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(cc | 0, 0x9e3779b9);
    n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
    n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const l = (a, b, t) => a + (b - a) * t;
  const c00 = l(h(xi, yi, zi), h(xi + 1, yi, zi), sx);
  const c10 = l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), sx);
  const c01 = l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), sx);
  const c11 = l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), sx);
  return l(l(c00, c10, sy), l(c01, c11, sy), sz);
}

/** A direction `elev` radians off `axis`, at azimuth `az` around it. */
function offAxis(axis, elev, az, out = V()) {
  // Build an orthonormal basis around the axis.
  const up = Math.abs(axis.y) > 0.94 ? V(1, 0, 0) : V(0, 1, 0);
  const t1 = V().crossVectors(axis, up).normalize();
  const t2 = V().crossVectors(axis, t1).normalize();
  const se = Math.sin(elev), ce = Math.cos(elev);
  return out.copy(axis).multiplyScalar(ce)
    .addScaledVector(t1, se * Math.cos(az))
    .addScaledVector(t2, se * Math.sin(az));
}

// ── the grower ───────────────────────────────────────────────────────────────

/**
 * Grow one prototype. Returns { height, crown, strands, clusters }.
 * Deterministic in `seed`.
 */
export function growTree(species, seed) {
  const rng = mulberry32(seed >>> 0);
  return species.conifer ? growConifer(species, rng) : growDeciduous(species, rng);
}

function growDeciduous(P, rng) {
  const H = randRange(rng, P.height);
  const strands = [];
  const tips = [];

  // ── leader ────────────────────────────────────────────────────────────────
  const leanAz = rng() * TAU;
  const leanAmt = P.lean * (0.35 + 1.3 * rng());
  const dir = V(Math.cos(leanAz) * Math.sin(leanAmt), Math.cos(leanAmt), Math.sin(leanAz) * Math.sin(leanAmt));
  const trunkH = H * P.trunkFrac;
  const r0 = H * P.trunkRadiusK * (0.85 + 0.35 * rng());
  const trunkPts = [];
  const p = V(0, 0, 0);
  const step = trunkH / P.trunkSegs;
  for (let i = 0; i <= P.trunkSegs; i++) {
    const t = i / P.trunkSegs;
    trunkPts.push({ p: p.clone(), r: r0 * Math.pow(1 - t * 0.93, P.taperPow) + 0.012 });
    p.addScaledVector(dir, step);
    // Sway the leader a little more with height — a dead-straight stick reads CG.
    dir.x += (rng() - 0.5) * P.gnarl * 0.055 + Math.cos(leanAz) * P.curve * 0.014;
    dir.z += (rng() - 0.5) * P.gnarl * 0.055 + Math.sin(leanAz) * P.curve * 0.014;
    dir.normalize();
  }
  strands.push({ pts: trunkPts, level: 0 });
  tips.push({ p: trunkPts[trunkPts.length - 1].p.clone(), w: 0.7 });

  // ── limbs ─────────────────────────────────────────────────────────────────
  const nb = randInt(rng, P.branchCount);
  let az = rng() * TAU;
  // A crown that is even all the way round reads as a lollipop, so bias one
  // side: pick a "light direction" the tree grew toward and lengthen that half.
  const asymAz = rng() * TAU;
  const asym = 0.18 + 0.42 * rng();

  for (let k = 0; k < nb; k++) {
    const f = nb === 1 ? 0.7 : k / (nb - 1);
    const t = clamp01(lerp(P.branchStart, P.branchEnd, f) + (rng() - 0.5) * 0.09);
    const fi = t * P.trunkSegs;
    const i0 = Math.min(P.trunkSegs - 1, Math.floor(fi));
    const ft = fi - i0;
    const base = trunkPts[i0].p.clone().lerp(trunkPts[i0 + 1].p, ft);
    const baseR = lerp(trunkPts[i0].r, trunkPts[i0 + 1].r, ft);
    az += GOLDEN + (rng() - 0.5) * 0.5;

    const sideBoost = 1 + asym * Math.cos(az - asymAz);
    // Low branches are long, high ones short: that is what makes a crown.
    const lenF = randRange(rng, P.branchLen) * (1.25 - 0.55 * t) * sideBoost;
    growLimb(P, rng, strands, tips, base, dir, az, H, lenF * H, baseR * 0.62, 1);
  }

  return finishDeciduous(P, rng, H, strands, tips);
}

/** One limb, recursing into sub-limbs until `level` exceeds the species depth. */
function growLimb(P, rng, strands, tips, base, parentDir, az, H, length, radius, level) {
  const elev = randRange(rng, level === 1 ? P.branchAngle : P.subAngle);
  const d = offAxis(parentDir.clone().normalize(), elev, az).normalize();
  const segs = Math.max(2, P.branchSegs - (level - 1));
  const pts = [];
  const p = base.clone();
  const stepLen = length / segs;
  const upBias = P.branchUp;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push({ p: p.clone(), r: radius * (1 - t * 0.88) + 0.008 });
    p.addScaledVector(d, stepLen);
    // Bend back toward vertical (phototropism) plus a gnarl wobble.
    d.y += upBias * 0.16;
    d.x += (rng() - 0.5) * P.gnarl * 0.16;
    d.z += (rng() - 0.5) * P.gnarl * 0.16;
    d.normalize();
  }
  strands.push({ pts, level });

  if (level >= P.levels) {
    tips.push({ p: pts[pts.length - 1].p.clone(), w: 1 });
    // Mid-limb tips too, so foliage hugs the branch instead of floating at the end.
    tips.push({ p: pts[Math.max(1, segs - 1)].p.clone(), w: 0.55 });
    return;
  }

  const n = randInt(rng, P.subCount);
  let saz = rng() * TAU;
  for (let k = 0; k < n; k++) {
    saz += GOLDEN;
    const t = 0.45 + 0.55 * (n === 1 ? 0.8 : k / (n - 1));
    const fi = t * segs;
    const i0 = Math.min(segs - 1, Math.floor(fi));
    const bp = pts[i0].p.clone().lerp(pts[i0 + 1].p, fi - i0);
    growLimb(P, rng, strands, tips, bp, d, saz, H,
      length * P.subLen * (0.75 + 0.5 * rng()), radius * 0.5, level + 1);
  }
}

function finishDeciduous(P, rng, H, strands, tips) {
  // ── crown volume, measured from where the foliage actually ended up ───────
  const centre = V();
  let wsum = 0;
  for (const t of tips) { centre.addScaledVector(t.p, t.w); wsum += t.w; }
  centre.multiplyScalar(1 / Math.max(wsum, 1e-4));
  centre.y += H * (P.crownLift ?? 0);

  let rad = 0.001, radY = 0.001;
  for (const t of tips) {
    rad = Math.max(rad, Math.hypot(t.p.x - centre.x, t.p.z - centre.z));
    radY = Math.max(radY, Math.abs(t.p.y - centre.y));
  }
  const squash = P.crownSquash ?? 1.0;
  rad += H * P.tipBlob * 0.9;
  radY = Math.max(radY + H * P.tipBlob * 0.9, rad * 0.55 * squash);

  // ── leaf clumps ───────────────────────────────────────────────────────────
  const clusters = [];
  const n = P.clusterCount;
  const totalW = tips.reduce((a, t) => a + t.w, 0);
  for (let i = 0; i < n; i++) {
    // Pick a tip proportionally to its weight, then blob around it.
    let r = rng() * totalW, ti = 0;
    while (ti < tips.length - 1 && (r -= tips[ti].w) > 0) ti++;
    const tip = tips[ti].p;

    const a = rng() * TAU, b = Math.acos(2 * rng() - 1);
    const rr = H * P.tipBlob * Math.cbrt(rng());
    const px = tip.x + Math.sin(b) * Math.cos(a) * rr;
    const py = tip.y + Math.cos(b) * rr * 0.85;
    const pz = tip.z + Math.sin(b) * Math.sin(a) * rr;

    // Normalised position inside the crown ellipsoid drives both the shading
    // normal and the interior occlusion.
    const ex = (px - centre.x) / rad;
    const ey = (py - centre.y) / radY;
    const ez = (pz - centre.z) / rad;
    const d = Math.min(1.35, Math.hypot(ex, ey, ez));

    let nx = ex, ny = ey * 0.9 + 0.35, nz = ez;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;

    // Interior clumps sit in shadow; the underside more so than the top.
    const ao = clamp01(0.30 + 0.70 * smoothstep(0.15, 1.0, d))
             * lerp(0.62, 1.0, smoothstep(-1.0, 0.6, ey));

    const size = randRange(rng, P.clusterSize) * H * lerp(1.0, 0.78, clamp01(d));
    clusters.push({
      x: px, y: py, z: pz,
      sx: size * (P.clusterAspect ?? 1) * 0.5,
      sy: size * 0.5,
      nx, ny, nz,
      ao,
      tone: clamp01(vnoise3(px * 0.42 + 11.3, py * 0.30, pz * 0.42) * 1.5 - 0.25),
      tile: d > 0.80 && rng() < 0.55 ? TILE.SPARSE : P.tile,
      rot: Math.floor(rng() * 4),
      flip: rng() < 0.5,
      flex: lerp(0.6, 1.0, clamp01(py / (H * 1.05))),
    });
  }

  return { height: H, crown: { centre, rad, radY }, strands, clusters };
}

function growConifer(P, rng) {
  const H = randRange(rng, P.height);
  const strands = [];
  const clusters = [];

  const leanAz = rng() * TAU;
  const leanAmt = P.lean * (0.4 + 1.4 * rng());
  const dir = V(Math.cos(leanAz) * Math.sin(leanAmt), Math.cos(leanAmt), Math.sin(leanAz) * Math.sin(leanAmt));
  const r0 = H * P.trunkRadiusK * (0.85 + 0.3 * rng());
  const trunkPts = [];
  const p = V(0, 0, 0);
  const step = H / P.trunkSegs;
  for (let i = 0; i <= P.trunkSegs; i++) {
    const t = i / P.trunkSegs;
    trunkPts.push({ p: p.clone(), r: r0 * Math.pow(1 - t * 0.985, P.taperPow) + 0.008 });
    p.addScaledVector(dir, step);
    dir.x += (rng() - 0.5) * P.gnarl * 0.03 + Math.cos(leanAz) * P.curve * 0.01;
    dir.z += (rng() - 0.5) * P.gnarl * 0.03 + Math.sin(leanAz) * P.curve * 0.01;
    dir.normalize();
  }
  strands.push({ pts: trunkPts, level: 0 });

  const nW = randInt(rng, P.whorls);
  const crownR = H * P.crownR * (0.82 + 0.4 * rng());
  const base = P.crownBase * (0.7 + 0.8 * rng());
  let az = rng() * TAU;

  const pointAt = (t) => {
    const fi = clamp01(t) * P.trunkSegs;
    const i0 = Math.min(P.trunkSegs - 1, Math.floor(fi));
    return trunkPts[i0].p.clone().lerp(trunkPts[i0 + 1].p, fi - i0);
  };

  for (let w = 0; w < nW; w++) {
    const t = lerp(base, 0.985, w / (nW - 1));
    const o = pointAt(t);
    // Cone profile with a slight bulge low down — a pure cone reads as a party hat.
    const prof = Math.pow(clamp01((0.995 - t) / (0.995 - base)), 0.72);
    const R = crownR * prof * (0.85 + 0.3 * rng());
    if (R < H * 0.012) continue;

    const nB = Math.max(3, randInt(rng, P.boughs) - Math.floor(w / 4));
    for (let b = 0; b < nB; b++) {
      az += GOLDEN * 0.62 + (rng() - 0.5) * 0.4;
      const droop = P.boughDroop * (0.6 + 0.8 * rng());
      const len = R * (0.8 + 0.4 * rng());
      const dx = Math.cos(az), dz = Math.sin(az);

      // Thin woody bough — only visible up close but it stops the whorls
      // looking like floating cards.
      if (w < nW - 2) {
        strands.push({
          pts: [
            { p: o.clone(), r: Math.max(0.012, r0 * 0.22 * prof) },
            { p: V(o.x + dx * len * 0.55, o.y - len * droop * 0.35, o.z + dz * len * 0.55), r: 0.010 },
            { p: V(o.x + dx * len, o.y - len * droop, o.z + dz * len), r: 0.006 },
          ],
          level: 1,
        });
      }

      // 2–3 needle sprays along the bough, biggest at the tip.
      const nS = R > H * 0.05 ? 5 : 3;
      for (let s = 0; s < nS; s++) {
        const ft = 0.22 + 0.78 * (s / Math.max(1, nS - 1));
        const px = o.x + dx * len * ft;
        const py = o.y - len * droop * ft * ft - H * 0.004;
        const pz = o.z + dz * len * ft;
        const size = randRange(rng, P.clusterSize) * H * lerp(0.72, 1.15, ft) * (0.85 + 0.3 * rng());
        // Normal points out and slightly up: a conifer reads as a lit cone.
        let nx = dx, ny = 0.55, nz = dz;
        const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
        clusters.push({
          x: px, y: py, z: pz,
          sx: size * P.clusterAspect * 0.5,
          sy: size * 0.5,
          nx, ny, nz,
          // Deep inside the cone is nearly black; the tips catch the light.
          ao: clamp01(0.26 + 0.74 * ft) * lerp(0.66, 1.0, t),
          tone: clamp01(vnoise3(px * 0.5, py * 0.22, pz * 0.5) * 1.4 - 0.2),
          tile: TILE.NEEDLE,
          rot: 0,                       // a needle fan must stay the right way up
          flip: rng() < 0.5,
          flex: lerp(0.35, 1.0, t),     // conifers are stiff; only the top moves
        });
      }
    }
  }

  // A tight spike of foliage at the very top so the spire does not end in a stick.
  const topP = trunkPts[trunkPts.length - 1].p;
  for (let i = 0; i < 3; i++) {
    const size = H * P.clusterSize[0] * (0.7 + 0.3 * rng());
    clusters.push({
      x: topP.x + (rng() - 0.5) * size * 0.2,
      y: topP.y - H * 0.012 * i,
      z: topP.z + (rng() - 0.5) * size * 0.2,
      sx: size * 0.55, sy: size * 0.75,
      nx: 0, ny: 1, nz: 0,
      ao: 1.0,
      tone: rng(),
      tile: TILE.NEEDLE, rot: 0, flip: rng() < 0.5, flex: 1.0,
    });
  }

  return {
    height: H,
    crown: { centre: V(0, H * 0.55, 0), rad: crownR, radY: H * 0.45 },
    strands,
    clusters,
  };
}
