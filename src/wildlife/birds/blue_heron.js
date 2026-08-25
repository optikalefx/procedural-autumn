// ─────────────────────────────────────────────────────────────────────────────
//  great blue heron — the statue on the bank.
//
//  A heron keeps its S-neck in BOTH states (it folds its neck to fly, which is
//  why its stations carry grade 0 and the shader never touches them), which is
//  the one place it parts company with the flamingo. Built from
//  `wader_kit.js`; behaviour is `tree_birds.js`.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp01, lerp } from '../../core/MathUtils.js';
import {
  bag, loft, countershade, colBySt, tailFan, leg, foot, wingLoft, eyes,
  galleryBird, RING_BODY, SUB_BODY, RING_NECK, SUB_NECK, RING_HEAD, SUB_HEAD,
  RING_BILL, SUB_BILL,
} from './wader_kit.js';

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
    loft(B, ST.map((r) => r.slice(0, 5)), RING_BODY, SUB_BODY, {
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
  ], RING_NECK, SUB_NECK, {
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
  ], RING_HEAD, SUB_HEAD, {
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
  ], RING_BILL, SUB_BILL, { col: () => C_HER_BILL, capEnd: true });

  // Eyes: on the white face, just under the crown stripe.
  eyes(B, 0, 0.302, 0.163, 0.0140, 0.0040, C_HER_CROWN);

  // Wings: broad and rounded, pale coverts over dark slate remiges — the
  // covert panel stays solid (the first build's lesson) — with four modest
  // slotted fingers at the tip.
  {
    const SPAN_KEY = [
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
    // The pale covert panel is the leading 42% of chord inboard of x 0.400 —
    // the same two boundaries the old index test named, restated against the
    // station's x and the panel's chord fraction so resampling the span cannot
    // move them.
    wingLoft(B, SPAN_KEY, wingW, (x, t) => (x >= 0.400 || t >= 0.42 ? C_HER_REM : C_HER_COV));
    for (const s of [1, -1]) {
      const [xt, let_, tet, yt] = SPAN_KEY[SPAN_KEY.length - 1];
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

// ── gallery builder ──────────────────────────────────────────────────────────

export const BLUE_HERON_POSES = ['wading', 'flight'];

/** One blue heron (5.7 m span — 3x life, see TREE_BIRD_SPECIES) for the gallery. */
export function buildBlueHeron(rnd, opts = {}) {
  const flight = opts.pose === 'flight' && opts.pose !== 'wading';
  void rnd;
  return galleryBird(buildBlueHeronGeometry, 5.7, -0.271, flight);
}
