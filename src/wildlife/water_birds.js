// ─────────────────────────────────────────────────────────────────────────────
//  water_birds — the waders: geometry for birds that stand IN the water.
//
//  Behaviour lives in tree_birds.js — a wader is the same perch-and-fly animal
//  as the bald eagle, except its "perch" is a patch of shallow water instead of
//  a treetop (TREE_BIRD_SPECIES rows with habitat: 'water'). This file owns
//  only what is different: the models, and the two aWing bands the shared
//  vertex shader uses to repose them.
//
//  The aWing contract (see treeBirdMaterial in tree_birds.js):
//
//    0                body — never reposed
//    0.001 .. 0.105   tail-fan feather angle (the eagle)
//    LEG  = 0.108     leg vertex; sign is the side. Standing (fold 1) the legs
//                     hang from the hip; in flight (fold 0) they trail straight
//                     back, and the negative-side leg tucks up when standing —
//                     the one-legged stance both these species are known for.
//    NECK band        0.1115 + grade * 0.007, grade 0 at the neck root and 1 at
//                     the bill tip. In flight the shader pitches the neck
//                     forward about the root, graded, so the raised standing
//                     neck unrolls into the extended flight neck. The flamingo
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

/**
 * Body loft through stations [z, halfWidth, halfDepth, centreY, color], with
 * the eagle's countershade: belly a stop lighter than the back so the bird has
 * internal value range before light touches it.
 */
function bodyLoft(B, ST, RING = 8) {
  const ring = (s) => {
    const pts = [];
    for (let k = 0; k < RING; k++) {
      const a = (k / RING) * Math.PI * 2;
      pts.push([Math.cos(a) * s[1], s[3] + Math.sin(a) * s[2], s[0]]);
    }
    return pts;
  };
  const rings = ST.map(ring);
  for (let i = 0; i < ST.length - 1; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    for (let k = 0; k < RING; k++) {
      const k2 = (k + 1) % RING;
      const sA = Math.sin((k / RING) * Math.PI * 2);
      const sB = Math.sin((k2 / RING) * Math.PI * 2);
      const mA = 1 - sA * 0.10 + clamp01(-sA) * 0.14;
      const mB = 1 - sB * 0.10 + clamp01(-sB) * 0.14;
      B.tri(r0[k], r0[k2], r1[k2], 0, ST[i][4], ST[i][4], ST[i + 1][4], mA, mB, mB);
      B.tri(r0[k], r1[k2], r1[k], 0, ST[i][4], ST[i + 1][4], ST[i + 1][4], mA, mB, mA);
    }
  }
  return rings;
}

/**
 * Neck loft along a polyline of [y, z, radius, grade] stations. Rings are laid
 * horizontally — the neck is never far from vertical in the authored pose, and
 * at this fidelity a tilted ring buys nothing. `grade` rides into aWing so the
 * shader can unroll the neck (pass grades of 0 to pin it, heron-style).
 */
function neckLoft(B, ST, color, RING = 6, mulFn = null) {
  const ring = (s) => {
    const pts = [];
    for (let k = 0; k < RING; k++) {
      const a = (k / RING) * Math.PI * 2;
      pts.push([Math.cos(a) * s[2], s[0], s[1] + Math.sin(a) * s[2]]);
    }
    return pts;
  };
  const rings = ST.map(ring);
  for (let i = 0; i < ST.length - 1; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    const w0 = ST[i][3] > 0 ? neckW(ST[i][3]) : 0;
    const w1 = ST[i + 1][3] > 0 ? neckW(ST[i + 1][3]) : 0;
    for (let k = 0; k < RING; k++) {
      const k2 = (k + 1) % RING;
      const m = mulFn ? mulFn(k / RING) : 1;
      const m2 = mulFn ? mulFn(k2 / RING) : 1;
      B.tri(r0[k], r0[k2], r1[k2], [w0, w0, w1], color, color, color, m, m2, m2);
      B.tri(r0[k], r1[k2], r1[k], [w0, w1, w1], color, color, color, m, m2, m);
    }
  }
}

/**
 * One leg: hip, ankle, foot, toe as a chain of thin cross-strips (the eagle's
 * foot idiom — two perpendicular ribbons per segment, cheap and readable from
 * every angle). aWing carries the LEG band with the side in its sign; the whole
 * chain rides the hip pivot rigidly in the shader.
 */
function leg(B, s, pts, halfW, colors) {
  const w = s * LEG;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0, z0] = pts[i], [x1, y1, z1] = pts[i + 1];
    const h0 = halfW[i], h1 = halfW[i + 1];
    const c = colors[i];
    B.quad([x0 - h0, y0, z0], [x0 + h0, y0, z0], [x1 + h1, y1, z1], [x1 - h1, y1, z1],
      w, c, c, 1, 0.88);
    B.quad([x0, y0, z0 - h0], [x0, y0, z0 + h0], [x1, y1, z1 + h1], [x1, y1, z1 - h1],
      w, c, c, 0.78, 0.7);
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

  // Body: small, egg-round, riding high on the legs.
  bodyLoft(B, [
    [-0.170, 0.011, 0.013, 0.022, C_FLA_BODY],
    [-0.090, 0.036, 0.042, 0.006, C_FLA_BODY],
    [0.000, 0.044, 0.048, 0.004, C_FLA_BODY],
    [0.070, 0.036, 0.040, 0.012, C_FLA_BODY],
    [0.112, 0.020, 0.024, 0.030, C_FLA_BODY],
  ]);

  // Tail: a short pink wedge, static (no fan band — a flamingo's tail is a
  // rumour at the best of times).
  B.quad([-0.014, 0.030, -0.165], [0.014, 0.030, -0.165],
    [0.010, 0.048, -0.215], [-0.010, 0.048, -0.215], 0, C_FLA_BODY, C_FLA_BODY, 1, 0.9);

  // Neck: raised, gently S-curved, graded into the NECK band so flight
  // unrolls it forward. Root sits on the shader's shared pivot (0.045, 0.10).
  neckLoft(B, [
    [0.048, 0.108, 0.016, 0.0],
    [0.130, 0.148, 0.014, 0.25],
    [0.220, 0.164, 0.012, 0.5],
    [0.310, 0.148, 0.011, 0.75],
    [0.368, 0.122, 0.010, 0.92],
  ], C_FLA_BODY);

  // Head: a small loft at the top of the neck, all at grade ~1 so it rides the
  // neck's rotation rigidly.
  {
    const w = neckW(1);
    const ST = [
      [0.096, 0.007, 0.007, 0.390, C_FLA_HEAD],
      [0.124, 0.017, 0.016, 0.394, C_FLA_HEAD],
      [0.152, 0.011, 0.011, 0.388, C_FLA_HEAD],
    ];
    const RING = 6;
    const ring = (s) => {
      const pts = [];
      for (let k = 0; k < RING; k++) {
        const a = (k / RING) * Math.PI * 2;
        pts.push([Math.cos(a) * s[1], s[3] + Math.sin(a) * s[2], s[0]]);
      }
      return pts;
    };
    const rings = ST.map(ring);
    for (let i = 0; i < ST.length - 1; i++) {
      for (let k = 0; k < RING; k++) {
        const k2 = (k + 1) % RING;
        B.tri(rings[i][k], rings[i][k2], rings[i + 1][k2], w, C_FLA_HEAD);
        B.tri(rings[i][k], rings[i + 1][k2], rings[i + 1][k], w, C_FLA_HEAD);
      }
    }
    // Bill: pale base dropping from the face, then the black tip kinked
    // steeply down — the kink is the flamingo's whole face at forty metres.
    const bw = 0.008, tw = 0.0045;
    B.quad([-bw, 0.384, 0.158], [bw, 0.384, 0.158], [tw, 0.356, 0.180], [-tw, 0.356, 0.180],
      w, C_FLA_BILL, C_FLA_BILL, 1, 0.9);
    B.quad([-bw, 0.376, 0.152], [bw, 0.376, 0.152], [tw, 0.352, 0.172], [-tw, 0.352, 0.172],
      w, C_FLA_BILL, C_FLA_BILL, 0.85, 0.8);
    B.quad([-tw, 0.356, 0.180], [tw, 0.356, 0.180], [0.003, 0.322, 0.184], [-0.003, 0.322, 0.184],
      w, C_FLA_TIP);
    B.quad([-tw, 0.352, 0.172], [tw, 0.352, 0.172], [0.003, 0.320, 0.178], [-0.003, 0.320, 0.178],
      w, C_FLA_TIP);
  }

  // Wings: narrow chord, rose coverts over black remiges. The chord is split
  // at 45% so the colour can step covert to remige across it; the outer two
  // stations go black on both halves — the black primaries wrap the tip.
  {
    const SPAN = [
      [0.040, 0.068, -0.048, 0.022],
      [0.150, 0.075, -0.058, 0.032],
      [0.280, 0.066, -0.046, 0.038],
      [0.380, 0.050, -0.028, 0.042],
      [0.462, 0.026, -0.004, 0.044],
    ];
    const wingW = (x) => 0.12 + 0.88 * clamp01((x - 0.04) / 0.42);
    const cLE = [C_FLA_DEEP, C_FLA_DEEP, C_FLA_DEEP, C_FLA_REM, C_FLA_REM];
    for (const s of [1, -1]) {
      for (let i = 0; i < SPAN.length - 1; i++) {
        const [x0, le0, te0, y0] = SPAN[i];
        const [x1, le1, te1, y1] = SPAN[i + 1];
        // Split at 62%, not mid-chord: the folded wing rolls against the
        // flank and shows its whole chord side-on, and at 45% the standing
        // bird was half black. Flight keeps a full black trailing band and
        // the all-black outer stations.
        const m0 = lerp(le0, te0, 0.62), m1 = lerp(le1, te1, 0.62);
        const w0 = s * wingW(x0), w1 = s * wingW(x1);
        const camber = 0.007;
        B.tri([s * x0, y0, le0], [s * x1, y1, le1], [s * x1, y1 + camber, m1], [w0, w1, w1], cLE[i], cLE[i + 1], cLE[i + 1]);
        B.tri([s * x0, y0, le0], [s * x1, y1 + camber, m1], [s * x0, y0 + camber, m0], [w0, w1, w0], cLE[i], cLE[i + 1], cLE[i]);
        B.tri([s * x0, y0 + camber, m0], [s * x1, y1 + camber, m1], [s * x1, y1, te1], [w0, w1, w1], C_FLA_REM, C_FLA_REM, C_FLA_REM, 1, 1, 0.9);
        B.tri([s * x0, y0 + camber, m0], [s * x1, y1, te1], [s * x0, y0, te0], [w0, w1, w0], C_FLA_REM, C_FLA_REM, C_FLA_REM, 1, 0.9, 0.9);
      }
    }
  }

  // Legs: the point of the whole bird. Hips on the shared pivot; the ankle
  // kinks backward (a bird's visible "knee" bends the wrong way) and the toes
  // reach forward off a webbed foot.
  for (const s of [1, -1]) {
    leg(B, s, [
      [s * 0.030, -0.015, -0.030],
      [s * 0.030, -0.235, -0.050],
      [s * 0.030, -0.425, -0.018],
      [s * 0.030, -0.436, 0.022],
    ], [0.0075, 0.005, 0.004, 0.003], [C_FLA_LEG, C_FLA_LEG, C_FLA_LEG]);
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

  bodyLoft(B, [
    [-0.190, 0.013, 0.015, 0.030, C_HER_BODY],
    [-0.100, 0.042, 0.050, 0.012, C_HER_BODY],
    [0.000, 0.050, 0.056, 0.010, C_HER_BODY],
    [0.080, 0.040, 0.046, 0.022, C_HER_BODY],
    [0.126, 0.022, 0.026, 0.040, C_HER_NECK],
  ]);

  // Tail: short and square, darker than the body.
  B.quad([-0.020, 0.036, -0.185], [0.020, 0.036, -0.185],
    [0.015, 0.052, -0.245], [-0.015, 0.052, -0.245], 0, C_HER_REM, C_HER_REM, 1, 0.9);

  // Neck: the S, authored and pinned (grade 0 throughout). Pale grey, with the
  // front face a touch lighter — the white throat streak, done in value.
  neckLoft(B, [
    [0.052, 0.128, 0.019, 0],
    [0.115, 0.172, 0.016, 0],
    [0.185, 0.158, 0.014, 0],
    [0.245, 0.134, 0.013, 0],
    [0.288, 0.150, 0.012, 0],
  ], C_HER_NECK, 6, (t) => 1 + 0.14 * Math.max(0, Math.sin(t * Math.PI * 2)));

  // Head: white face under a black crown stripe — the stripe is the line that
  // says heron, so like the eagle's white head it lives in the geometry. Top
  // vertices of each ring take the crown colour.
  {
    const ST = [
      [0.138, 0.006, 0.006, 0.296],
      [0.164, 0.015, 0.014, 0.301],
      [0.192, 0.010, 0.009, 0.298],
    ];
    const RING = 6;
    const ring = (s) => {
      const pts = [];
      for (let k = 0; k < RING; k++) {
        const a = (k / RING) * Math.PI * 2;
        pts.push([Math.cos(a) * s[1], s[3] + Math.sin(a) * s[2], s[0]]);
      }
      return pts;
    };
    const rings = ST.map(ring);
    const colAt = (k) => (Math.sin((k / RING) * Math.PI * 2) > 0.45 ? C_HER_CROWN : C_HER_HEAD);
    for (let i = 0; i < ST.length - 1; i++) {
      for (let k = 0; k < RING; k++) {
        const k2 = (k + 1) % RING;
        B.tri(rings[i][k], rings[i][k2], rings[i + 1][k2], 0, colAt(k), colAt(k2), colAt(k2));
        B.tri(rings[i][k], rings[i + 1][k2], rings[i + 1][k], 0, colAt(k), colAt(k2), colAt(k));
      }
    }
    // Bill: the dagger. A fan from the front ring to a tip well forward.
    const front = rings[ST.length - 1];
    const tip = [0, 0.288, 0.278];
    for (let k = 0; k < RING; k++) {
      B.tri(front[k], front[(k + 1) % RING], tip, 0, C_HER_BILL);
    }
  }

  // Wings: broad and rounded, pale coverts over dark slate remiges, with four
  // modest slotted fingers at the tip.
  {
    const SPAN = [
      [0.046, 0.102, -0.074, 0.028],
      [0.160, 0.112, -0.088, 0.038],
      [0.290, 0.102, -0.074, 0.044],
      [0.390, 0.082, -0.050, 0.048],
      [0.452, 0.052, -0.018, 0.050],
    ];
    const wingW = (x) => 0.12 + 0.88 * clamp01((x - 0.046) / 0.40);
    for (const s of [1, -1]) {
      for (let i = 0; i < SPAN.length - 1; i++) {
        const [x0, le0, te0, y0] = SPAN[i];
        const [x1, le1, te1, y1] = SPAN[i + 1];
        const m0 = lerp(le0, te0, 0.42), m1 = lerp(le1, te1, 0.42);
        const w0 = s * wingW(x0), w1 = s * wingW(x1);
        const camber = 0.008;
        // The leading half is SOLID covert — mixing toward the remige colour
        // at the mid-chord verts (the eagle's pattern, where both browns are
        // near neighbours) let interpolation drown the pale band and the
        // whole wing read black.
        B.tri([s * x0, y0, le0], [s * x1, y1, le1], [s * x1, y1 + camber, m1], [w0, w1, w1], C_HER_COV);
        B.tri([s * x0, y0, le0], [s * x1, y1 + camber, m1], [s * x0, y0 + camber, m0], [w0, w1, w0], C_HER_COV);
        B.tri([s * x0, y0 + camber, m0], [s * x1, y1 + camber, m1], [s * x1, y1, te1], [w0, w1, w1], C_HER_REM, C_HER_REM, C_HER_REM, 1, 1, 0.9);
        B.tri([s * x0, y0 + camber, m0], [s * x1, y1, te1], [s * x0, y0, te0], [w0, w1, w0], C_HER_REM, C_HER_REM, C_HER_REM, 1, 0.9, 0.9);
      }
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

  // Legs: shorter than the flamingo's, dark olive, with the rusty thigh patch
  // where leg meets body.
  for (const s of [1, -1]) {
    leg(B, s, [
      [s * 0.032, -0.015, -0.030],
      [s * 0.032, -0.150, -0.052],
      [s * 0.032, -0.262, -0.026],
      [s * 0.032, -0.271, 0.016],
    ], [0.008, 0.005, 0.004, 0.003], [C_HER_THIGH, C_HER_LEG, C_HER_LEG]);
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
  mesh.position.y = flight ? 1.3 : -footY * span;
  const g = new THREE.Group();
  g.add(mesh);
  return g;
}

// The pose reads are spelt out against opts.pose so the gallery's option
// probe sees a two-value enum and deals each pose its own card.

/** One flamingo (1.45 m span) for the object gallery. */
export function buildFlamingo(rnd, opts = {}) {
  const flight = opts.pose === 'flight' && opts.pose !== 'wading';
  void rnd;
  return galleryBird(buildFlamingoGeometry, 1.45, -0.436, flight);
}

/** One blue heron (1.9 m span) for the object gallery. */
export function buildBlueHeron(rnd, opts = {}) {
  const flight = opts.pose === 'flight' && opts.pose !== 'wading';
  void rnd;
  return galleryBird(buildBlueHeronGeometry, 1.9, -0.271, flight);
}
