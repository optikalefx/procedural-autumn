// ─────────────────────────────────────────────────────────────────────────────
//  flamingo — the payoff at the end of a boat trip.
//
//  Three statements carry the silhouette: the impossible legs, the raised
//  question-mark neck with the down-kinked bill, and (in flight) black flight
//  feathers on a pink bird. Built from `wader_kit.js`; behaviour, and the
//  colony that puts every flamingo in the valley on two known islands, is
//  `tree_birds.js`.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp01, lerp } from '../../core/MathUtils.js';
import {
  bag, loft, countershade, colBySt, tailFan, leg, foot, wingLoft, eyes, neckW,
  galleryBird, RING_BODY, SUB_BODY, RING_NECK, SUB_NECK, RING_HEAD, SUB_HEAD,
  RING_BILL, SUB_BILL,
} from './wader_kit.js';

// ── plumage ──────────────────────────────────────────────────────────────────
//
// Flamingo: rose pink with deeper coverts and BLACK flight feathers — the
// black is what says flamingo in flight, and at rest a thin dark seam along
// the folded wing keeps the bird from reading as a lawn ornament. All the
// pinks sit short of saturation so the tonemapper has room (the flocks.js
// lesson, again).
const C_FLA_BODY  = new THREE.Color(0xe89aa4);
const C_FLA_DEEP  = new THREE.Color(0xd06e82);   // wing coverts, deep rose
const C_FLA_REM   = new THREE.Color(0x241d1c);   // flight feathers, warm black
const C_FLA_HEAD  = new THREE.Color(0xeeb0b8);
const C_FLA_LEG   = new THREE.Color(0xd8808f);
const C_FLA_BILL  = new THREE.Color(0xe6c3c3);   // pale base
const C_FLA_TIP   = new THREE.Color(0x1f1a19);   // the black kinked tip

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
  ], RING_BODY, SUB_BODY, {
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
  ], RING_NECK, SUB_NECK, {
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
  ], RING_HEAD, SUB_HEAD, {
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
    loft(B, ST.map((r) => r.slice(0, 5)), RING_BILL, SUB_BILL, {
      col: colBySt(ST), w: () => neckW(1), capEnd: true,
    });
  }

  // Eyes: dark beads either side of the head, riding the neck rotation.
  eyes(B, neckW(1), 0.398, 0.126, 0.0155, 0.0042, C_FLA_TIP);

  // Wings: narrow chord, rose coverts over black remiges. The rear of the
  // chord is black along the whole span and the outer stations are black
  // across the whole chord — the black primaries wrap the tip. Panel colours
  // stay uniform across the chord inside a triangle; see wingLoft.
  {
    const SPAN_KEY = [
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
    // IS the flight read, and at a narrower band it disappeared from above —
    // and from x 0.420 outboard. Both thresholds are the authored stations
    // and splits the old index test named, so they land exactly where they
    // did before the span was resampled and the chord recut.
    wingLoft(B, SPAN_KEY, wingW, (x, t) => (x >= 0.420 || t >= 0.62 ? C_FLA_REM : C_FLA_DEEP));
    // Pointed tip: close the last station to a point past it.
    for (const s of [1, -1]) {
      const [xt, le, te, yt] = SPAN_KEY[SPAN_KEY.length - 1];
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

// ── gallery builder ──────────────────────────────────────────────────────────

export const FLAMINGO_POSES = ['wading', 'flight'];

// The pose reads are spelt out against opts.pose so the gallery's option
// probe sees a two-value enum and deals each pose its own card.

/** One flamingo (4.35 m span — 3x life, see TREE_BIRD_SPECIES) for the gallery. */
export function buildFlamingo(rnd, opts = {}) {
  const flight = opts.pose === 'flight' && opts.pose !== 'wading';
  void rnd;
  return galleryBird(buildFlamingoGeometry, 4.35, -0.436, flight);
}
