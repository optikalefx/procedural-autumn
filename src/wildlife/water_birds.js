// ─────────────────────────────────────────────────────────────────────────────
//  water_birds — the waders: geometry for birds that stand IN the water.
//
//  Behaviour lives in tree_birds.js — a wader is the same perch-and-fly animal
//  as the bald eagle, except its "perch" is a patch of shallow water instead of
//  a treetop (TREE_BIRD_SPECIES rows with habitat: 'water'). This file owns
//  only what is different: the models, and the two aWing bands the shared
//  vertex shader uses to repose them.
//
//  Fidelity: these two run ~4–5× the eagle's triangle budget. They are capped
//  at 3 and 6 instances in a 3–5M-triangle scene, and unlike the eagle a wader
//  is a bird the player WALKS UP TO — it stands in the shallows at eye level
//  instead of on a spire twelve metres up. The extra triangles go where the
//  eye goes: smooth Catmull-Rom lofts with rings oriented to the centreline
//  (a kinked neck ring reads as a broken neck at five metres), prism legs
//  with toes, a real tail fan on the fan band, eyes, the heron's plume.
//
//  The aWing contract (see treeBirdMaterial in tree_birds.js):
//
//    0                body — never reposed
//    0.001 .. 0.105   tail-fan feather angle (spread in flight, folded shut
//                     standing — same encoding as the eagle's fan)
//    LEG  = 0.108     leg vertex; sign is the side. Standing (fold 1) the legs
//                     hang from the hip; in flight (fold 0) they trail straight
//                     back, and the negative-side leg tucks up when standing —
//                     the one-legged stance both these species are known for.
//    NECK band        0.1115 + grade * 0.007, grade 0 at the neck root rising
//                     to 1 where the neck meets the skull; head and bill are
//                     rigid at a flat 1. In flight the shader pitches each
//                     vertex forward about the root BY ITS OWN GRADE, so the
//                     raised standing neck unrolls into the extended flight
//                     neck — which also means any joint spanning two grades
//                     is a joint that shears open in flight. The flamingo
//                     uses it; the heron does NOT — a heron flies with its neck
//                     folded, so its S-curve is authored and left alone.
//    0.12 .. 1.0      wing spanwise fraction (flap and fold)
//
//  Both models author to the shader's shared pivots: hip at (y -0.015,
//  z -0.030), neck root at (y 0.045, z 0.10) — unit space, wingspan 1.0,
//  nose along +Z, the birds.js convention (instance scale IS the wingspan).
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp01, lerp } from '../core/MathUtils.js';
import { treeBirdMaterial } from './tree_birds.js';

// aWing band encodings — must agree with the ranges tested in treeBirdMaterial.
const LEG = 0.108;
const NECK_LO = 0.1115;
const NECK_SPAN = 0.007;
const neckW = (grade) => NECK_LO + clamp01(grade) * NECK_SPAN;

// ── plumage ──────────────────────────────────────────────────────────────────
//
// Flamingo: rose pink with deeper coverts and BLACK flight feathers — the
// black is what says flamingo in flight, and at rest a thin dark seam along
// the folded wing keeps the bird from reading as a lawn ornament. All the
// pinks sit short of saturation so the tonemapper has room (the birds.js
// lesson, again).
const C_FLA_BODY  = new THREE.Color(0xe89aa4);
const C_FLA_DEEP  = new THREE.Color(0xd06e82);   // wing coverts, deep rose
const C_FLA_REM   = new THREE.Color(0x241d1c);   // flight feathers, warm black
const C_FLA_HEAD  = new THREE.Color(0xeeb0b8);
const C_FLA_LEG   = new THREE.Color(0xd8808f);
const C_FLA_BILL  = new THREE.Color(0xe6c3c3);   // pale base
const C_FLA_TIP   = new THREE.Color(0x1f1a19);   // the black kinked tip
//
// Great blue heron: slate blue-grey, paler neck, white head with a dark crown
// stripe, dusky-yellow dagger bill. The greys are lifted a stop over life —
// a true heron grey against dusk water disappears, and a bird nobody can see
// is not worth its draw call.
const C_HER_BODY  = new THREE.Color(0x717d89);
const C_HER_COV   = new THREE.Color(0x828e9a);   // wing coverts — a stop over
// the body, because the covert-to-remige step is the whole top-side read of a
// heron wing and at 0x67737f it vanished into the dark trailing half.
const C_HER_REM   = new THREE.Color(0x3b4550);   // flight feathers, dark slate
const C_HER_NECK  = new THREE.Color(0x939aa2);
const C_HER_HEAD  = new THREE.Color(0xd9d6cd);   // white face
const C_HER_CROWN = new THREE.Color(0x252a32);   // black crown stripe
const C_HER_BILL  = new THREE.Color(0xc7a044);
const C_HER_LEG   = new THREE.Color(0x4c4639);
const C_HER_THIGH = new THREE.Color(0x83583c);   // the rusty thigh patch

// ── the shared mesh bag ──────────────────────────────────────────────────────
// The same vert/tri/quad idiom the eagle is built from, boxed so two builders
// can share it without sharing arrays.
function bag() {
  const pos = [], nor = [], wing = [], col = [];
  const _c = new THREE.Color();
  const vert = (p, w, c, mul = 1) => {
    pos.push(p[0], p[1], p[2]);
    nor.push(0, 1, 0);            // flat shading derives the real one per-pixel
    wing.push(w);
    _c.copy(c).multiplyScalar(mul);
    col.push(_c.r, _c.g, _c.b);
  };
  const tri = (a, b, c, w, ca, cb = ca, cc = ca, ma = 1, mb = 1, mc = 1) => {
    const wa = Array.isArray(w) ? w[0] : w;
    const wb = Array.isArray(w) ? w[1] : w;
    const wc = Array.isArray(w) ? w[2] : w;
    vert(a, wa, ca, ma); vert(b, wb, cb, mb); vert(c, wc, cc, mc);
  };
  const quad = (a, b, c, d, w, cab, ccd = cab, mab = 1, mcd = 1) => {
    tri(a, b, c, w, cab, cab, ccd, mab, mab, mcd);
    tri(a, c, d, w, cab, ccd, ccd, mab, mcd, mcd);
  };
  const build = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  };
  return { tri, quad, build };
}

// ── smooth lofts ─────────────────────────────────────────────────────────────

/**
 * Catmull-Rom through rows of numbers, `sub` samples per span, endpoints
 * clamped. Every column is splined — centre, radii, neck grade alike — so a
 * loft authored as five stations comes out as a smooth dozen instead of a
 * chain of cylinders. Returns [{ v: row, u: 0..1 }].
 */
function crSample(rows, sub) {
  const n = rows.length;
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = rows[Math.max(i - 1, 0)], p1 = rows[i];
    const p2 = rows[i + 1], p3 = rows[Math.min(i + 2, n - 1)];
    for (let s = 0; s < sub; s++) {
      const t = s / sub, t2 = t * t, t3 = t2 * t;
      const v = p1.map((_, k) =>
        0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t
          + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2
          + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
      out.push({ v, u: (i + t) / (n - 1) });
    }
  }
  out.push({ v: rows[n - 1].slice(), u: 1 });
  return out;
}

/**
 * The one loft. Body, neck, head and bill are all tubes along a planar
 * (x = 0) centreline, so one builder serves them: rows of
 * [centreY, centreZ, halfWidth, halfDepth, grade?], Catmull-Rom-smoothed,
 * with every ring laid PERPENDICULAR to the local centreline tangent — on the
 * raised S of a neck an axis-aligned ring pinches the outside of each bend.
 *
 * opts:
 *   col(u, off)  vertex colour; u runs 0..1 along the loft, off is the unit
 *                offset direction (x, y, z) — how the crown stripe and the
 *                throat streak pick their vertices.
 *   mul(off)     brightness multiplier (countershading etc.), default 1.
 *   w(grade)     aWing from the splined grade column, default 0.
 *   capStart / capEnd   close the tube with a fan.
 */
function loft(B, rows, RING, sub, opts) {
  const S = crSample(rows, sub);
  const rings = S.map((r, i) => {
    const [y, z, hw, hd] = r.v;
    const p = S[Math.max(i - 1, 0)].v, n = S[Math.min(i + 1, S.length - 1)].v;
    let ty = n[0] - p[0], tz = n[1] - p[1];
    const tl = Math.hypot(ty, tz) || 1; ty /= tl; tz /= tl;
    const pts = [], offs = [];
    for (let k = 0; k < RING; k++) {
      const a = (k / RING) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      pts.push([ca * hw, y + sa * hd * tz, z - sa * hd * ty]);
      offs.push([ca, sa * tz, -sa * ty]);
    }
    return { pts, offs, u: r.u, g: r.v[4] ?? 0, y, z, ty, tz };
  });
  const mul = opts.mul ?? (() => 1);
  const wOf = opts.w ?? (() => 0);
  for (let i = 0; i < rings.length - 1; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    const w0 = wOf(r0.g), w1 = wOf(r1.g);
    for (let k = 0; k < RING; k++) {
      const k2 = (k + 1) % RING;
      const cA = opts.col(r0.u, r0.offs[k]), cB = opts.col(r0.u, r0.offs[k2]);
      const cC = opts.col(r1.u, r1.offs[k2]), cD = opts.col(r1.u, r1.offs[k]);
      const mA = mul(r0.offs[k]), mB = mul(r0.offs[k2]);
      const mC = mul(r1.offs[k2]), mD = mul(r1.offs[k]);
      B.tri(r0.pts[k], r0.pts[k2], r1.pts[k2], [w0, w0, w1], cA, cB, cC, mA, mB, mC);
      B.tri(r0.pts[k], r1.pts[k2], r1.pts[k], [w0, w1, w1], cA, cC, cD, mA, mC, mD);
    }
  }
  const cap = (ring, dir) => {
    const c = [0, ring.y + ring.ty * 0.002 * dir, ring.z + ring.tz * 0.002 * dir];
    const col = opts.col(ring.u, [0, ring.ty * dir, ring.tz * dir]);
    const w = wOf(ring.g);
    for (let k = 0; k < RING; k++) {
      B.tri(ring.pts[k], ring.pts[(k + 1) % RING], c, w, col, col, col, 0.95, 0.95, 0.95);
    }
  };
  if (opts.capStart) cap(rings[0], -1);
  if (opts.capEnd) cap(rings[rings.length - 1], 1);
  return rings;
}

// Countershade for the body lofts: belly a stop lighter than the back, so the
// bird has internal value range before light touches it (the eagle's trick).
const countershade = (off) => 1 - off[1] * 0.10 + clamp01(-off[1]) * 0.14;

/** Colour-by-nearest-authored-station, for lofts whose rows carry colours. */
const colBySt = (ST) => (u) => ST[Math.round(u * (ST.length - 1))][5];

// ── the tail fan ─────────────────────────────────────────────────────────────
// The eagle's fan, parameterised: staggered feather quads whose aWing encodes
// the feather angle on the fan band (< 0.105), so the shared shader spreads
// the fan in flight and folds it to a wedge on the stand.
function tailFan(B, TB, NF, spread, len0, taper, hw, color, mul = 1) {
  for (let i = 0; i < NF; i++) {
    const a = lerp(-spread, spread, NF === 1 ? 0.5 : i / (NF - 1));
    const wTail = (a / spread) * 0.09;
    const dx = Math.sin(a), dz = -Math.cos(a);
    const len = len0 - Math.abs(a) * taper;          // centre feathers longest
    const y = TB[1] - 0.003 + (i % 2) * 0.004;       // stagger kills coplanar shimmer
    const px = -dz * hw, pz = dx * hw;               // half-width across the feather
    B.quad(
      [TB[0] - px, y, TB[2] - pz],
      [TB[0] + px, y, TB[2] + pz],
      [TB[0] + dx * len + px * 1.5, y - 0.010, TB[2] + dz * len + pz * 1.5],
      [TB[0] + dx * len - px * 1.5, y - 0.010, TB[2] + dz * len - pz * 1.5],
      wTail, color, color, mul, mul * 0.92,
    );
  }
}

// ── legs ─────────────────────────────────────────────────────────────────────

const _cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const _norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/** Local frame ⊥ `t`, with U kept forward-ish (+Z) so prism edges align. */
function frameOf(t) {
  let U = _norm([-t[0] * t[2], -t[1] * t[2], 1 - t[2] * t[2]]);
  if (!Number.isFinite(U[0])) U = [0, 0, 1];
  return [U, _cross(t, U)];
}

/**
 * One leg: a chain of triangular prisms — a real cross-section instead of the
 * eagle's crossed ribbons, because a wader's leg is half its silhouette and a
 * ribbon leg vanishes edge-on. One prism edge faces forward, which is also
 * roughly what a bird's scaled shank does. aWing carries the LEG band with the
 * side in its sign; the whole chain rides the hip pivot rigidly in the shader.
 * Returns the joint frames so the foot can build off the last one.
 */
function leg(B, s, pts, rad, colors) {
  const w = s * LEG;
  const SIDES = 3;
  const rings = pts.map((p, i) => {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
    const t = _norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const [U, V] = frameOf(t);
    const out = [];
    for (let k = 0; k < SIDES; k++) {
      const ang = (k / SIDES) * Math.PI * 2;
      const ca = Math.cos(ang) * rad[i], sa = Math.sin(ang) * rad[i];
      out.push([p[0] + U[0] * ca + V[0] * sa, p[1] + U[1] * ca + V[1] * sa, p[2] + U[2] * ca + V[2] * sa]);
    }
    return out;
  });
  for (let i = 0; i < pts.length - 1; i++) {
    const c = colors[Math.min(i, colors.length - 1)];
    for (let k = 0; k < SIDES; k++) {
      const k2 = (k + 1) % SIDES;
      B.quad(rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k], w, c, c, 1, 0.88);
    }
  }
  return rings;
}

/** A toe (or the bill of a very unlucky fish): tapered 3-prism to a point. */
function spike(B, w, base, tip, r, c, mul = 1) {
  const t = _norm([tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]]);
  const [U, V] = frameOf(t);
  const ring = [];
  for (let k = 0; k < 3; k++) {
    const ang = (k / 3) * Math.PI * 2;
    const ca = Math.cos(ang) * r, sa = Math.sin(ang) * r;
    ring.push([base[0] + U[0] * ca + V[0] * sa, base[1] + U[1] * ca + V[1] * sa, base[2] + U[2] * ca + V[2] * sa]);
  }
  for (let k = 0; k < 3; k++) {
    B.tri(ring[k], ring[(k + 1) % 3], tip, w, c, c, c, mul, mul, mul * 0.85);
  }
  return ring;
}

/**
 * The foot: three toes splayed forward off the foot centre, one short hind
 * toe, all landing exactly on `footY` — the species table stands the bird on
 * its toes' own lowest vertex, so the toe tips ARE the contact patch.
 */
function foot(B, s, at, footY, fwdLen, toeR, c, webbed) {
  const w = s * LEG;
  const tips = [];
  for (const a of [-0.55, 0, 0.55]) {
    const tip = [at[0] + Math.sin(a) * fwdLen * 0.8, footY, at[2] + Math.cos(a) * fwdLen];
    spike(B, w, at, tip, toeR, c);
    tips.push(tip);
  }
  // Hind toe — the prop that keeps the stance from reading as pinned in place.
  spike(B, w, at, [at[0], footY, at[2] - fwdLen * 0.45], toeR * 0.8, c, 0.9);
  if (webbed) {
    // Web: one triangle filling each pair of adjacent toes, slung slightly
    // under the spread so it reads as membrane rather than plate.
    for (let i = 0; i < 2; i++) {
      B.tri([at[0], at[1] - 0.001, at[2]],
        [tips[i][0], tips[i][1] + 0.001, tips[i][2]],
        [tips[i + 1][0], tips[i + 1][1] + 0.001, tips[i + 1][2]], w, c, c, c, 0.82, 0.82, 0.82);
    }
  }
}

// ── wings ────────────────────────────────────────────────────────────────────

/**
 * One wing pair from spanwise stations [x, LEz, TEz, y]: three chord panels
 * with a cambered mid-line, colour stepped per-panel and per-station but held
 * UNIFORM inside each triangle — mixing panel colours across shared verts let
 * interpolation drown the pale covert band once already (the heron lesson,
 * kept from the first build).
 */
function wingLoft(B, SPAN, wingW, colFn, SPLITS = [0, 0.42, 0.72, 1]) {
  const CAMB = [0, 0.009, 0.004, -0.001];
  for (const s of [1, -1]) {
    for (let i = 0; i < SPAN.length - 1; i++) {
      const [x0, le0, te0, y0] = SPAN[i], [x1, le1, te1, y1] = SPAN[i + 1];
      const w0 = s * wingW(x0), w1 = s * wingW(x1);
      for (let j = 0; j < SPLITS.length - 1; j++) {
        const c0 = colFn(i, j), c1 = colFn(i + 1, j);
        const a = [s * x0, y0 + CAMB[j], lerp(le0, te0, SPLITS[j])];
        const b = [s * x1, y1 + CAMB[j], lerp(le1, te1, SPLITS[j])];
        const c = [s * x1, y1 + CAMB[j + 1], lerp(le1, te1, SPLITS[j + 1])];
        const d = [s * x0, y0 + CAMB[j + 1], lerp(le0, te0, SPLITS[j + 1])];
        const mT = j === SPLITS.length - 2 ? 0.9 : 1;
        B.tri(a, b, c, [w0, w1, w1], c0, c1, c1, 1, 1, mT);
        B.tri(a, c, d, [w0, w1, w0], c0, c1, c0, 1, mT, mT);
      }
    }
  }
}

/** A small dark eye on each side of the head — 4 tris of glint each. */
function eyes(B, w, y, z, x, r, c) {
  for (const s of [1, -1]) {
    const apex = [s * (x + r * 0.9), y, z];
    const ring = [
      [s * x, y + r, z], [s * x, y, z + r], [s * x, y - r, z], [s * x, y, z - r],
    ];
    for (let k = 0; k < 4; k++) B.tri(ring[k], ring[(k + 1) % 4], apex, w, c);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Flamingo — wingspan 1.0, so at the game's 1.35–1.55 m span the legs are a
//  believable 0.6 m. The silhouette carries three statements: the impossible
//  legs, the raised question-mark neck with the down-kinked bill, and (in
//  flight) black flight feathers on a pink bird.
// ─────────────────────────────────────────────────────────────────────────────
export function buildFlamingoGeometry() {
  const B = bag();

  // Body: small, egg-round, riding high on the legs. [y, z, hw, hd] stations,
  // splined; the countershade does the pre-lighting.
  loft(B, [
    [0.022, -0.172, 0.010, 0.012],
    [0.006, -0.090, 0.036, 0.042],
    [0.004, 0.000, 0.044, 0.048],
    [0.012, 0.070, 0.036, 0.040],
    [0.030, 0.114, 0.018, 0.022],
  ], 12, 3, {
    col: () => C_FLA_BODY, mul: countershade, capStart: true, capEnd: true,
  });

  // Tail: a small pink fan on the fan band — folded to a wedge on the stand,
  // spread when the shader opens it in flight. A flamingo's tail is a rumour,
  // so it stays short.
  tailFan(B, [0, 0.030, -0.162], 6, 0.38, 0.072, 0.020, 0.008, C_FLA_BODY, 0.96);

  // Neck: raised, gently S-curved, graded into the NECK band so flight
  // unrolls it forward. Root sits on the shader's shared pivot (0.045, 0.10).
  //
  // The last station is deliberately BURIED inside the skull (0.386, 0.120 is
  // within 0.008 of the head's widest ring) rather than stopping where the
  // neck stops looking like a neck. Two tube ends butted near each other do
  // not join: authored to end at 0.368 the surfaces missed by ~0.009 and the
  // head floated, with the open ring end reading as a hole straight down the
  // throat. It also runs its grade to a FULL 1.0 here, matching the head and
  // bill — the shader rotates each neck vertex by its own grade, so a joint
  // spanning grade 0.92 to 1.0 shears itself open in the flight pose even
  // when it looks closed standing. Head and bill are rigid at 1.0 and ride
  // the neck tip's rotation exactly.
  loft(B, [
    [0.048, 0.108, 0.017, 0.017, 0.0],
    [0.100, 0.134, 0.015, 0.015, 0.16],
    [0.160, 0.156, 0.0135, 0.0135, 0.36],
    [0.220, 0.164, 0.0125, 0.0125, 0.56],
    [0.280, 0.156, 0.0115, 0.0115, 0.76],
    [0.330, 0.138, 0.0105, 0.0105, 0.90],
    [0.360, 0.127, 0.0100, 0.0100, 0.97],
    [0.386, 0.120, 0.0098, 0.0098, 1.0],
  ], 8, 2, {
    col: () => C_FLA_BODY,
    w: (g) => (g > 0.001 ? neckW(g) : 0),
    capEnd: true,
  });

  // Head: a smooth knob the neck runs up into, rigid at grade 1 so it rides
  // the neck's rotation as one piece. Capped at both ends — the occiput would
  // otherwise show its open ring from behind, and the front cap is what the
  // bill emerges through.
  loft(B, [
    [0.386, 0.094, 0.007, 0.007, 1],
    [0.394, 0.118, 0.016, 0.015, 1],
    [0.392, 0.140, 0.013, 0.012, 1],
    [0.386, 0.155, 0.009, 0.008, 1],
  ], 7, 2, {
    col: () => C_FLA_HEAD, w: () => neckW(1), capStart: true, capEnd: true,
  });

  // Bill: pale base dropping out of the face, then the whole thing kinked
  // steeply down into the black tip — the kink is the flamingo's entire face
  // at forty metres, so it gets a real loft rather than two quads.
  {
    const ST = [
      // Starts INSIDE the skull, not flush against its front ring — a butted
      // ring leaves its own opening facing back out of the join.
      [0.386, 0.150, 0.0072, 0.0078, 1, C_FLA_BILL],
      [0.376, 0.172, 0.0055, 0.0062, 1, C_FLA_BILL],
      [0.362, 0.181, 0.0040, 0.0048, 1, C_FLA_TIP],
      [0.336, 0.186, 0.0016, 0.0020, 1, C_FLA_TIP],
    ];
    loft(B, ST.map((r) => r.slice(0, 5)), 6, 2, {
      col: colBySt(ST), w: () => neckW(1), capEnd: true,
    });
  }

  // Eyes: dark beads either side of the head, riding the neck rotation.
  eyes(B, neckW(1), 0.398, 0.126, 0.0155, 0.0042, C_FLA_TIP);

  // Wings: narrow chord, rose coverts over black remiges. The trailing panel
  // is black along the whole span and the outer stations go black on every
  // panel — the black primaries wrap the tip. Panel colours stay uniform per
  // triangle; see wingLoft.
  {
    const SPAN = [
      [0.040, 0.068, -0.048, 0.022],
      [0.105, 0.073, -0.055, 0.028],
      [0.170, 0.075, -0.058, 0.033],
      [0.235, 0.072, -0.053, 0.037],
      [0.300, 0.064, -0.044, 0.040],
      [0.360, 0.053, -0.032, 0.042],
      [0.420, 0.038, -0.016, 0.044],
      [0.462, 0.020, -0.002, 0.044],
    ];
    const wingW = (x) => 0.12 + 0.88 * clamp01((x - 0.04) / 0.42);
    // Black from 62% of chord — on a flamingo the dark rear half of the wing
    // IS the flight read, and at a narrower band it disappeared from above.
    wingLoft(B, SPAN, wingW, (i, j) => (i >= 6 || j === 2 ? C_FLA_REM : C_FLA_DEEP),
      [0, 0.38, 0.62, 1]);
    // Pointed tip: close the last station to a point past it.
    for (const s of [1, -1]) {
      const [xt, le, te, yt] = SPAN[SPAN.length - 1];
      const tip = [s * 0.484, yt, lerp(le, te, 0.5)];
      B.tri([s * xt, yt, le], tip, [s * xt, yt + 0.004, lerp(le, te, 0.72)], s, C_FLA_REM);
      B.tri([s * xt, yt + 0.004, lerp(le, te, 0.72)], tip, [s * xt, yt, te], s, C_FLA_REM, C_FLA_REM, C_FLA_REM, 1, 0.9, 0.9);
    }
  }

  // Legs: the point of the whole bird. Hips on the shared pivot; the ankle
  // kinks backward (a bird's visible "knee" bends the wrong way) and the toes
  // reach forward off a webbed foot whose tips land exactly on footY (-0.436).
  for (const s of [1, -1]) {
    leg(B, s, [
      [s * 0.030, -0.015, -0.030],
      [s * 0.030, -0.190, -0.048],
      [s * 0.030, -0.418, -0.020],
      [s * 0.030, -0.430, -0.002],
    ], [0.0080, 0.0056, 0.0044, 0.0040], [C_FLA_LEG, C_FLA_LEG, C_FLA_LEG]);
    foot(B, s, [s * 0.030, -0.430, -0.002], -0.436, 0.032, 0.0026, C_FLA_LEG, true);
  }

  return B.build();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Blue heron — bigger span, broad rounded wings, and the S-neck it keeps in
//  BOTH states (a heron folds its neck to fly, which is why its stations carry
//  grade 0 and the shader never touches them).
// ─────────────────────────────────────────────────────────────────────────────
export function buildBlueHeronGeometry() {
  const B = bag();

  {
    const ST = [
      [0.030, -0.192, 0.012, 0.014, 0, C_HER_BODY],
      [0.012, -0.100, 0.042, 0.050, 0, C_HER_BODY],
      [0.010, 0.000, 0.050, 0.056, 0, C_HER_BODY],
      [0.022, 0.080, 0.040, 0.046, 0, C_HER_BODY],
      [0.040, 0.128, 0.020, 0.024, 0, C_HER_NECK],
    ];
    loft(B, ST.map((r) => r.slice(0, 5)), 12, 3, {
      col: colBySt(ST), mul: countershade, capStart: true, capEnd: true,
    });
  }

  // Tail: short, square-ish and dark — a real fan on the fan band, spread a
  // hand's width in flight, shut to a wedge on the stand.
  tailFan(B, [0, 0.036, -0.184], 7, 0.42, 0.088, 0.022, 0.010, C_HER_REM);

  // Neck: the S, authored and pinned (grade 0 throughout — the whole point of
  // a heron). Pale grey, the front face a touch lighter: the white throat
  // streak, done in value against the ring's actual forward direction.
  loft(B, [
    [0.050, 0.126, 0.020, 0.020, 0],
    [0.100, 0.164, 0.017, 0.017, 0],
    [0.150, 0.172, 0.015, 0.015, 0],
    [0.200, 0.152, 0.014, 0.014, 0],
    [0.240, 0.134, 0.013, 0.013, 0],
    [0.272, 0.138, 0.012, 0.012, 0],
    [0.292, 0.150, 0.011, 0.011, 0],
  ], 8, 2, {
    col: () => C_HER_NECK,
    mul: (off) => 1 + 0.14 * Math.max(0, off[2]),
  });

  // Head: white face under a black crown stripe — the stripe is the line that
  // says heron, so like the eagle's white head it lives in the geometry: the
  // up-facing vertices of every ring take the crown colour.
  loft(B, [
    [0.294, 0.132, 0.006, 0.006, 0],
    [0.301, 0.150, 0.0145, 0.013, 0],
    [0.300, 0.170, 0.0125, 0.0115, 0],
    [0.296, 0.186, 0.009, 0.008, 0],
  ], 7, 2, {
    col: (u, off) => (off[1] > 0.42 ? C_HER_CROWN : C_HER_HEAD),
  });

  // Occipital plume: the two black feathers trailing off the back of the
  // crown. Two staggered slivers — at this scale they are a silhouette
  // accent, and the silhouette is where a heron does its acting.
  for (const s of [1, -1]) {
    B.quad(
      [s * 0.004, 0.310, 0.146], [s * 0.009, 0.306, 0.142],
      [s * 0.013, 0.286, 0.090], [s * 0.006, 0.290, 0.092],
      0, C_HER_CROWN, C_HER_CROWN, 1, 0.9,
    );
  }

  // Bill: the dagger, lofted to a fine point with a hint of down-curve on the
  // culmen so it reads as a blade rather than a cone.
  loft(B, [
    [0.294, 0.188, 0.0075, 0.0068, 0],
    [0.290, 0.226, 0.0050, 0.0046, 0],
    [0.286, 0.262, 0.0026, 0.0024, 0],
    [0.283, 0.286, 0.0007, 0.0007, 0],
  ], 6, 2, { col: () => C_HER_BILL, capEnd: true });

  // Eyes: on the white face, just under the crown stripe.
  eyes(B, 0, 0.302, 0.163, 0.0140, 0.0040, C_HER_CROWN);

  // Wings: broad and rounded, pale coverts over dark slate remiges — the
  // covert panel stays solid (the first build's lesson) — with four modest
  // slotted fingers at the tip.
  {
    const SPAN = [
      [0.046, 0.102, -0.074, 0.028],
      [0.105, 0.108, -0.082, 0.033],
      [0.165, 0.112, -0.088, 0.038],
      [0.230, 0.108, -0.082, 0.041],
      [0.290, 0.101, -0.073, 0.044],
      [0.345, 0.091, -0.061, 0.046],
      [0.400, 0.077, -0.044, 0.048],
      [0.452, 0.052, -0.018, 0.050],
    ];
    const wingW = (x) => 0.12 + 0.88 * clamp01((x - 0.046) / 0.40);
    wingLoft(B, SPAN, wingW, (i, j) => (i >= 6 || j > 0 ? C_HER_REM : C_HER_COV));
    for (const s of [1, -1]) {
      const [xt, let_, tet, yt] = SPAN[SPAN.length - 1];
      const FING = [
        [-0.05, 0.078, 0.10],
        [0.18, 0.086, 0.38],
        [0.44, 0.080, 0.66],
        [0.72, 0.064, 0.90],
      ];
      for (const [sw, len, cp] of FING) {
        const bz = lerp(let_, tet, cp);
        const dx = Math.cos(sw), dz = -Math.sin(sw);
        const hw = 0.012;
        B.quad(
          [s * xt, yt, bz + hw],
          [s * xt, yt, bz - hw],
          [s * (xt + dx * len), yt + 0.018, bz + dz * len - hw * 0.5],
          [s * (xt + dx * len), yt + 0.018, bz + dz * len + hw * 0.5],
          s * 1.0, C_HER_REM, C_HER_REM, 1, 0.88,
        );
      }
    }
  }

  // Legs: shorter than the flamingo's, dark olive, the rusty thigh patch
  // where leg meets body, long unwebbed toes on footY (-0.271).
  for (const s of [1, -1]) {
    leg(B, s, [
      [s * 0.032, -0.015, -0.030],
      [s * 0.032, -0.130, -0.050],
      [s * 0.032, -0.256, -0.028],
      [s * 0.032, -0.265, -0.008],
    ], [0.0090, 0.0060, 0.0050, 0.0046], [C_HER_THIGH, C_HER_LEG, C_HER_LEG]);
    foot(B, s, [s * 0.032, -0.265, -0.008], -0.271, 0.036, 0.0028, C_HER_LEG, false);
  }

  return B.build();
}

// ── gallery builders ─────────────────────────────────────────────────────────
//
// Same deal as buildBaldEagle: one bird at real scale, pose baked per-vertex,
// time frozen. Standing puts the feet exactly on the studio floor.

export const FLAMINGO_POSES = ['wading', 'flight'];
export const BLUE_HERON_POSES = ['wading', 'flight'];

function galleryBird(geoFn, span, footY, flight) {
  const geo = geoFn();
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    arr[i * 4] = 0.7;                       // phase: wings a touch raised
    arr[i * 4 + 1] = 0.0;                   // rate 0: frozen for the thumbnail
    arr[i * 4 + 2] = flight ? 0.55 : 0.0;
    arr[i * 4 + 3] = flight ? 0.0 : 1.0;
  }
  geo.setAttribute('aPose', new THREE.Float32BufferAttribute(arr, 4));
  const mesh = new THREE.Mesh(geo, treeBirdMaterial({ time: { value: 0 } }));
  mesh.scale.setScalar(span);
  // Hover proportional to span, not a fixed 1.3 m — at 3x scale a fixed lift
  // buries the flight pose's trailing legs in the studio floor.
  mesh.position.y = flight ? span * 0.9 : -footY * span;
  const g = new THREE.Group();
  g.add(mesh);
  return g;
}

// The pose reads are spelt out against opts.pose so the gallery's option
// probe sees a two-value enum and deals each pose its own card.

/** One flamingo (4.35 m span — 3x life, see TREE_BIRD_SPECIES) for the gallery. */
export function buildFlamingo(rnd, opts = {}) {
  const flight = opts.pose === 'flight' && opts.pose !== 'wading';
  void rnd;
  return galleryBird(buildFlamingoGeometry, 4.35, -0.436, flight);
}

/** One blue heron (5.7 m span — 3x life, see TREE_BIRD_SPECIES) for the gallery. */
export function buildBlueHeron(rnd, opts = {}) {
  const flight = opts.pose === 'flight' && opts.pose !== 'wading';
  void rnd;
  return galleryBird(buildBlueHeronGeometry, 5.7, -0.271, flight);
}
