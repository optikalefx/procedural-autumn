// ─────────────────────────────────────────────────────────────────────────────
//  wader_kit — what the flamingo and the heron are both built out of.
//
//  Two birds that stand IN the water: the same prism legs with toes, the same
//  smooth Catmull-Rom lofts with rings oriented to the centreline (a kinked
//  neck ring reads as a broken neck at five metres), the same tail fan, the
//  same eyes. Only the numbers and the plumage differ, and those live one file
//  over in `flamingo.js` and `blue_heron.js`.
//
//  The eagle and the owl do NOT use this: each is a single model with its own
//  builder, and neither has a leg worth sharing.
//
//  The aWing contract (see treeBirdMaterial in `bird_material.js`):
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
//  nose along +Z, the flocks.js convention (instance scale IS the wingspan).
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp01, lerp } from '../../core/MathUtils.js';
import { crom, smoothTuples } from '../loft_smooth.js';
import { treeBirdMaterial } from './bird_material.js';

// aWing band encodings — must agree with the ranges tested in treeBirdMaterial.
const LEG = 0.108;
const NECK_LO = 0.1115;
const NECK_SPAN = 0.007;
export const neckW = (grade) => NECK_LO + clamp01(grade) * NECK_SPAN;

// ── density ──────────────────────────────────────────────────────────────────
//
// The same recipe the great horned owl is built to (great_horned_owl.js's
// own "density" block carries the long version). These two shipped at ~860 and
// ~900 triangles — a twelve-sided body, an eight-sided neck, and a wing cut into
// three chord panels — which was four to five times the eagle and still, next
// to a rebuilt owl, a plated barrel wearing two blades.
//
// Triangle count is near-free on this GPU (AGENTS.md: the 4.5 M budget line is
// stale and the trees peak at 7–8 M while driving), these are capped at 3 and
// 6 live instances, and a wader is a bird the player WALKS UP TO. Smaller
// facets are the cheapest fidelity in the file.
//
// Rings by part rather than one number for the whole bird: a neck and a bill
// are a fraction of the body's radius, and giving them the body's ring count
// spends triangles on curvature nobody can resolve. Sub is the Catmull-Rom
// sample count per authored span — `loft` already splined its centreline, so
// what changes here is only how finely.
//
// FLAT SHADING IS NOT NEGOTIABLE — treeBirdMaterial derives the normal per
// pixel from the derivative, and that is the house style. What is bought here
// is SMALLER facets, never smoother ones.
export const RING_BODY = 20, SUB_BODY = 4;   // was 12, 3
export const RING_NECK = 14, SUB_NECK = 3;   // was 8, 2
export const RING_HEAD = 14, SUB_HEAD = 3;   // was 7, 2
export const RING_BILL = 10, SUB_BILL = 2;   // was 6, 2
const WING_SMOOTH = 2;                // Catmull-Rom stations per authored span
// Chord splits, leading edge to trailing edge. Six panels instead of three,
// and the two boundaries that carry colour are kept exactly where the old
// three-panel array put them: 0.42 (the heron's covert-to-remige step) and
// 0.62 (the flamingo's black rear half).
const WING_CHORD = [0, 0.14, 0.28, 0.42, 0.62, 0.80, 1];

// ── the shared mesh bag ──────────────────────────────────────────────────────
// The same vert/tri/quad idiom the eagle is built from, boxed so two builders
// can share it without sharing arrays.
export function bag() {
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
export function crSample(rows, sub) {
  const n = rows.length;
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = rows[Math.max(i - 1, 0)], p1 = rows[i];
    const p2 = rows[i + 1], p3 = rows[Math.min(i + 2, n - 1)];
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      const v = p1.map((_, k) => crom(p0[k], p1[k], p2[k], p3[k], t));
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
export function loft(B, rows, RING, sub, opts) {
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
export const countershade = (off) => 1 - off[1] * 0.10 + clamp01(-off[1]) * 0.14;

/** Colour-by-nearest-authored-station, for lofts whose rows carry colours. */
export const colBySt = (ST) => (u) => ST[Math.round(u * (ST.length - 1))][5];

// ── the tail fan ─────────────────────────────────────────────────────────────
// The eagle's fan, parameterised: staggered feather quads whose aWing encodes
// the feather angle on the fan band (< 0.105), so the shared shader spreads
// the fan in flight and folds it to a wedge on the stand.
export function tailFan(B, TB, NF, spread, len0, taper, hw, color, mul = 1) {
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
export function leg(B, s, pts, rad, colors) {
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
export function spike(B, w, base, tip, r, c, mul = 1) {
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
export function foot(B, s, at, footY, fwdLen, toeR, c, webbed) {
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
 * One wing pair from AUTHORED spanwise stations [x, LEz, TEz, y]: the stations
 * are Catmull-Rom resampled (WING_SMOOTH) and the chord is cut into six
 * panels with a cambered arc across it.
 *
 * Both halves of that earn their keep and for different reasons — the shader
 * bends the wing by grading its rotation on the spanwise fraction, so SPAN
 * density is what turns the beat from a hinge into a curve, while CHORD
 * density is what stops the panel creasing into flat facets when the fold
 * stands it on edge.
 *
 * `colFn(x, t)` takes the station's x and the panel's LEADING chord fraction,
 * never an index — an index-keyed ramp moves the moment the density changes.
 * It is held UNIFORM inside each triangle across the chord (mixing panel
 * colours across shared verts let interpolation drown the pale covert band
 * once already — the heron lesson, kept from the first build) and blends only
 * along the span, exactly as before.
 */
export function wingLoft(B, SPAN_KEY, wingW, colFn, SPLITS = WING_CHORD) {
  const SPAN = smoothTuples(SPAN_KEY, WING_SMOOTH);
  // Camber as an arc rather than the old four sampled values, which only
  // existed because there were only four chord positions to sample at. Peaks
  // where CAMB did: ~0.009 at 42% of chord, ~0.005 at 72%, flat at both edges.
  const camber = (t) => 0.0095 * Math.sin(Math.PI * Math.pow(clamp01(t), 0.62));
  // Two owned instances: both colours of a band are alive at once inside a
  // tri() call, and a colFn that returns a scratch Color would hand it the
  // same value twice.
  const _c0 = new THREE.Color(), _c1 = new THREE.Color();
  for (const s of [1, -1]) {
    for (let i = 0; i < SPAN.length - 1; i++) {
      const [x0, le0, te0, y0] = SPAN[i], [x1, le1, te1, y1] = SPAN[i + 1];
      const w0 = s * wingW(x0), w1 = s * wingW(x1);
      for (let j = 0; j < SPLITS.length - 1; j++) {
        const t0 = SPLITS[j], t1 = SPLITS[j + 1];
        _c0.copy(colFn(x0, t0)); _c1.copy(colFn(x1, t0));
        const a = [s * x0, y0 + camber(t0), lerp(le0, te0, t0)];
        const b = [s * x1, y1 + camber(t0), lerp(le1, te1, t0)];
        const c = [s * x1, y1 + camber(t1), lerp(le1, te1, t1)];
        const d = [s * x0, y0 + camber(t1), lerp(le0, te0, t1)];
        // Trailing edge a stop down, ramped over the rear of the chord rather
        // than stepped on the last panel — six panels would have made that
        // step a visible line.
        const mA = lerp(1, 0.9, clamp01((t0 - 0.42) / 0.58));
        const mT = lerp(1, 0.9, clamp01((t1 - 0.42) / 0.58));
        B.tri(a, b, c, [w0, w1, w1], _c0, _c1, _c1, mA, mA, mT);
        B.tri(a, c, d, [w0, w1, w0], _c0, _c1, _c0, mA, mT, mT);
      }
    }
  }
}

/** A small dark eye on each side of the head — 4 tris of glint each. */
export function eyes(B, w, y, z, x, r, c) {
  for (const s of [1, -1]) {
    const apex = [s * (x + r * 0.9), y, z];
    const ring = [
      [s * x, y + r, z], [s * x, y, z + r], [s * x, y - r, z], [s * x, y, z - r],
    ];
    for (let k = 0; k < 4; k++) B.tri(ring[k], ring[(k + 1) % 4], apex, w, c);
  }
}

// ── gallery builders ─────────────────────────────────────────────────────────
//
// Same deal as buildBaldEagle: one bird at real scale, pose baked per-vertex,
// time frozen. Standing puts the feet exactly on the studio floor.

export function galleryBird(geoFn, span, footY, flight) {
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
