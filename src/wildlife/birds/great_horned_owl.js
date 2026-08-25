// ─────────────────────────────────────────────────────────────────────────────
//  great horned owl — the valley's night bird.
//
//  Behaviour lives in tree_birds.js — an owl is the same perch-and-fly animal
//  as the bald eagle, one more TREE_BIRD_SPECIES row, except that its row
//  carries `nocturnal: true` and the streamer will only hand it a tree while
//  SKY_STATE.nightFactor is up. This file owns only what is different: the
//  model. That is the rule for every file in this folder — the behaviour file
//  is the contract, and four models in it would bury it.
//
//  THE SILHOUETTE IS THE WHOLE JOB. An eagle is read by a tapered white head
//  and slotted primaries; an owl is read by four things and nothing else:
//
//    · a big round head nearly as wide as the body, sitting straight ON the
//      shoulders. There is no neck vertex in this file. The eagle's head is
//      the opposite shape, which is exactly why this one has to be pushed.
//    · two ear tufts. That is the word "horned" in the name and it is the
//      only cue that separates this bird from every other owl.
//    · a flat pale facial disc with two enormous forward-facing eyes. The
//      eyes are real geometry — an amber dome with a dark pupil dome in front
//      of it — because a painted eye disappears the moment the face turns,
//      and the eyes are the entire charm of the animal.
//    · short, broad, blunt wings. Low aspect ratio, rounded tip, no eagle
//      finger slots.
//
//  VALUE. This bird is lit at night by ambient plus the car's headlights and
//  nothing else, so it is authored in warm mid greys and browns with a pale
//  buff face, a white throat and a pale chest. Nothing here is near-black
//  except the pupils and the beak: a coat authored dark shades to a hole (the
//  create-animal palette note), and a hole is what a night bird is one bad
//  decision away from being anyway.
//
//  Conventions, all inherited from tree_birds.js / flocks.js:
//    · nose along +Z, wingspan exactly 1.0 along ±X, so the instance scale IS
//      the wingspan in metres.
//    · flat normals — the material derives the real one per pixel.
//    · aWing bands (the contract is documented in bird_material.js):
//        0                body — never reposed
//        0.001 .. 0.105   tail-fan feather angle (× 5.1 in the shader)
//        0.105 .. 0.119   legs / neck — wader_kit.js's bands. NOT USED HERE:
//                         an owl has no visible neck by construction, and its
//                         legs are feathered stubs that never move.
//        0.12 .. 1.0      wing spanwise fraction (flap and fold)
//    · the shoulder pivot the shader flaps about is (±0.048, 0.030, 0.030) and
//      the tail-fan pivot is z = -0.14. Both are authored to below.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp01, lerp } from '../../core/MathUtils.js';
import { smoothTuples } from '../loft_smooth.js';
import { treeBirdMaterial } from './bird_material.js';

// ── density ──────────────────────────────────────────────────────────────────
//
// The mammals' near LOD (DETAIL[0], mammals/quadruped.js) runs a 14-sided barrel
// and inserts three Catmull-Rom rings between every authored station, with the
// note that the point is facets "small enough to read as a curve instead of as
// armour plate". This bird inherited the eagle's 8-to-10-sided loft with no
// interpolated stations at all, and read as exactly that armour plate: a
// faceted lump for a head, a plated barrel, two flat blades for wings — on the
// one animal the game invites the player to stop and stare at.
//
// So the density here is the mammals', not the eagle's. Triangle count is
// near-free on this GPU (AGENTS.md: the 4.5 M budget line is stale and trees
// peak at 7-8 M while driving), and two live owls at a few thousand triangles
// each is nothing next to that.
//
// FLAT SHADING IS NOT NEGOTIABLE — the material derives the normal per pixel
// from the derivative, and that is the house style. What is bought below is
// SMALLER facets, never smoother ones.
const RING = 22;              // body loft sides
const BODY_SMOOTH = 4;        // Catmull-Rom rings per authored body interval
const NLAT = 18, NLON = 28;   // head dome latitude / longitude
const DISC_N = 30;            // facial disc and rim segments
const DISC_RINGS = 4;         // concentric rings across the dish
const EYE_N = 20;             // iris longitude
const IRIS_LAT = 4, PUP_LAT = 3;
const WING_SMOOTH = 3;        // Catmull-Rom stations per authored wing interval
// Chord splits, leading edge to trailing edge. Span density is what makes the
// shader's graded flap read as a bend; chord density is what stops the panel
// creasing into two flat facets when the fold stands it on edge.
const WING_CHORD = [0, 0.13, 0.28, 0.44, 0.62, 0.81, 1];

// ── plumage ──────────────────────────────────────────────────────────────────
//
// Mottled warm grey-brown over a pale chest, with the buff face and the white
// throat carrying the identification the way the eagle's white head does.
//
// The whole ramp sits a stop and a half above life, and the reason is a
// measurement: at hour 22 on a perch beside the camera, a bald eagle's body
// (0x4a3826) renders as an unlit black cut-out and only its white head
// (0xd9d2c2) picks up the moon and the sky ambient at all. Everything on a
// night bird therefore has to be authored where that white head is or on the
// way to it — the darkest plumage colour here is the barring at 0x5e5040,
// which is *lighter* than the eagle's mid-brown body, and the face, throat and
// breast are within a stop of the eagle's white. This bird is only ever seen
// in the dark, so nothing is lost by it: there is no noon to blow out.
const C_BACK  = new THREE.Color(0x93805f);   // mantle and crown, warm grey-brown
const C_WING  = new THREE.Color(0x8a7659);   // wing field
const C_BAR   = new THREE.Color(0x5e5040);   // the barring, darkest plumage
const C_CHEST = new THREE.Color(0xded0b4);   // pale streaked breast
const C_HEAD  = new THREE.Color(0x9d8968);   // head dome, a touch lighter than the back
const C_DISC  = new THREE.Color(0xe2c8a0);   // facial disc, pale buff
const C_RIM   = new THREE.Color(0x5c4c38);   // the ring around the disc
const C_BIB   = new THREE.Color(0xefe8d8);   // white throat patch
const C_TUFT  = new THREE.Color(0x63533c);   // ear tufts, dark with a buff face
const C_EYE   = new THREE.Color(0xf1c04a);   // amber iris
const C_PUPIL = new THREE.Color(0x171310);
const C_GLINT = new THREE.Color(0xfdf7e8);   // catchlight
const C_BEAK  = new THREE.Color(0x322d26);   // dark horn, mostly buried in the disc
const C_FOOT  = new THREE.Color(0xc2b092);   // feathered tarsi
const C_CLAW  = new THREE.Color(0x2b2622);

// The head is authored as its own little coordinate system centred on
// HEAD_C and then pitched HEAD_TILT nose-DOWN about X before it is welded on.
//
// Why the tilt: a perched tree bird is pitched steeply nose-up (PERCH_PITCH),
// which is right for the body — an owl on a branch is a vertical parcel — and
// wrong for the face, because the head is rigid with the body and a bird
// authored square would sit on its branch staring at the sky. Tilting the head
// block forward by a quarter radian buys the face back at the perch, and costs
// only a slight downward gaze in flight, which is what a hunting owl is doing
// anyway.
const HEAD_C = [0, 0.058, 0.098];
const HEAD_TILT = 0.26;
const HEAD_R = [0.088, 0.088, 0.081];   // rx, ry, rz — WIDER than the body
// The front hemisphere is squashed to this: the flattening is the facial
// disc's foundation, and it is why the head reads as a plate-fronted ball
// rather than a bowling ball with eyes stuck on.
const HEAD_FLAT = 0.70;
// ...and the BACK hemisphere is stretched by this. Pure profile (yaw 1.57) was
// the model's weakest angle: losing the disc at ninety degrees is honest, owls
// have flat faces, but the head was also losing its roundness and reading as a
// blocky snout on a barrel. A skull that is shallower fore-and-aft than it is
// tall cannot read as a ball from the side however many facets it has, so the
// nape gets its depth back here.
const HEAD_BACK = 1.16;

/** Head-local (origin at HEAD_C, +Z forward) → body space, tilt applied. */
function hp(x, y, z) {
  const c = Math.cos(HEAD_TILT), s = Math.sin(HEAD_TILT);
  return [HEAD_C[0] + x, HEAD_C[1] + y * c - z * s, HEAD_C[2] + y * s + z * c];
}

/** The shared push-triangles-into-arrays rig — the eagle's, kept identical. */
function builder() {
  const pos = [], nor = [], wing = [], col = [];
  const _c = new THREE.Color();
  const vert = (p, w, c, mul = 1) => {
    pos.push(p[0], p[1], p[2]);
    nor.push(0, 1, 0);                 // flat shading derives the real one
    wing.push(w);
    _c.copy(c).multiplyScalar(mul);
    col.push(_c.r, _c.g, _c.b);
  };
  // w is one weight for the whole triangle, or [wa, wb, wc] per vertex.
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
  return { vert, tri, quad, build };
}

/**
 * A fan: apex, a ring of `n` points from `ringPt(k)`, one colour. Used for the
 * facial disc, the eye domes and the pupils — every round plate on this bird.
 */
function fan(B, apex, n, ringPt, w, c, mul = 1, mulRim = mul) {
  for (let k = 0; k < n; k++) {
    B.tri(apex, ringPt(k), ringPt((k + 1) % n), w, c, c, c, mul, mulRim, mulRim);
  }
}

/**
 * The great horned owl, span 1.0 along ±X, nose +Z.
 */
export function buildGreatHornedOwlGeometry() {
  const B = builder();

  // ── body ──────────────────────────────────────────────────────────────────
  //
  // Five stations, tail root to shoulder. It stops at z = 0.078 and the head
  // dome starts at z = 0.098 with a radius of 0.079 — they overlap by most of
  // a head, which is the point: the last body ring is INSIDE the skull, so
  // there is no seam and no neck to see. The barrel is deliberately fat
  // (half-width 0.072 against the eagle's 0.047 on a wing that is shorter);
  // an owl is a soft parcel, and the roundness is half of the cute.
  //
  // Five AUTHORED stations, then smoothTuples rounds the path between them:
  // the straight chords between five keys are what made the barrel read as a
  // welded cone, and no amount of extra radial sides fixes a profile that is
  // piecewise linear along its own length.
  const ST_KEY = [
    // z,      half-width, half-depth, centre y
    [-0.155, 0.026, 0.028, 0.030],
    [-0.085, 0.057, 0.059, 0.026],
    [-0.015, 0.072, 0.076, 0.026],
    [0.040, 0.070, 0.074, 0.034],
    [0.078, 0.058, 0.061, 0.044],
  ];
  const ST = smoothTuples(ST_KEY, BODY_SMOOTH);
  const ringPt = (s, k) => {
    const a = (k / RING) * Math.PI * 2;
    return [Math.cos(a) * s[1], s[3] + Math.sin(a) * s[2], s[0]];
  };
  // Colour of a body vertex. Two gradients and a mottle:
  //   · countershading — the belly runs to the pale chest, hard, so the bird
  //     has real internal value range before any light touches it (the
  //     flocks.js trick, pushed further because this one is lit by a headlight
  //     or by nothing).
  //   · the throat — under the face, the palest thing on the animal.
  //   · a deterministic mottle so the back is not one flat field of brown.
  //
  // Both are functions of (z, angle) rather than of (station index, ring
  // index): the mottle has to keep the same physical scale whatever
  // BODY_SMOOTH and RING are set to, or raising the density turns a mottled
  // back into a fine shimmer.
  const _bc = new THREE.Color();
  const bodyCol = (i, k) => {
    const a = (k / RING) * Math.PI * 2;
    const up = Math.sin(a);
    const belly = clamp01(-up);
    const z = ST[i][0];
    const front = clamp01((z + 0.13) / 0.20);
    _bc.copy(C_BACK).lerp(C_CHEST, belly * (0.30 + 0.55 * front));
    // Throat: the front-most stations, underside only.
    if (z > 0.03) _bc.lerp(C_BIB, clamp01((z - 0.03) / 0.05) * belly * 0.75);
    return _bc;
  };
  const bodyMul = (i, k) => {
    const a = (k / RING) * Math.PI * 2;
    const up = Math.sin(a);
    const z = ST[i][0];
    return 1 + 0.085 * Math.sin(z * 33.0 + a * 3.3) - 0.10 * clamp01(up);
  };
  for (let i = 0; i < ST.length - 1; i++) {
    for (let k = 0; k < RING; k++) {
      const k2 = (k + 1) % RING;
      const p00 = ringPt(ST[i], k), p01 = ringPt(ST[i], k2);
      const p10 = ringPt(ST[i + 1], k), p11 = ringPt(ST[i + 1], k2);
      // Six vert() calls rather than two tri() calls: every corner wants its
      // own colour, and tri()'s three-colour form cannot express a quad.
      B.vert(p00, 0, bodyCol(i, k), bodyMul(i, k));
      B.vert(p01, 0, bodyCol(i, k2), bodyMul(i, k2));
      B.vert(p11, 0, bodyCol(i + 1, k2), bodyMul(i + 1, k2));
      B.vert(p00, 0, bodyCol(i, k), bodyMul(i, k));
      B.vert(p11, 0, bodyCol(i + 1, k2), bodyMul(i + 1, k2));
      B.vert(p10, 0, bodyCol(i + 1, k), bodyMul(i + 1, k));
    }
  }
  // Tail-root cap.
  for (let k = 0; k < RING; k++) {
    B.tri([0, 0.030, -0.168], ringPt(ST[0], (k + 1) % RING), ringPt(ST[0], k), 0, C_BACK);
  }

  // ── head dome ─────────────────────────────────────────────────────────────
  //
  // A latitude/longitude sphere, slightly wider than it is deep, with the
  // FRONT hemisphere squashed by HEAD_FLAT and the back stretched by
  // HEAD_BACK.
  //
  // This is where the density mattered most and where it was worst: a 6 x 12
  // dome on the cutest, most-looked-at part of the animal, which duly read as
  // a polyhedron with eyes on it. At 18 x 28 the crown is a curve — and the
  // rows at the poles that a lat/long sphere degenerates to zero area are
  // skipped rather than emitted, so the count buys facets and not slivers.
  const headPt = (la, lo) => {
    const ay = (la / NLAT - 0.5) * Math.PI;
    const ax = (lo / NLON) * Math.PI * 2;
    const ca = Math.cos(ay);
    let z = HEAD_R[2] * ca * Math.cos(ax);
    z *= z > 0 ? HEAD_FLAT : HEAD_BACK;
    return hp(HEAD_R[0] * ca * Math.sin(ax), HEAD_R[1] * Math.sin(ay), z);
  };
  const _hc = new THREE.Color();
  const headCol = (la, lo) => {
    const ay = (la / NLAT - 0.5) * Math.PI;
    const ax = (lo / NLON) * Math.PI * 2;
    const f = Math.cos(ay) * Math.cos(ax);          // 1 dead ahead, -1 behind
    _hc.copy(C_HEAD).lerp(C_DISC, clamp01((f - 0.15) / 0.6) * 0.85);
    // Under the jaw runs into the throat patch.
    if (Math.sin(ay) < -0.45) _hc.lerp(C_BIB, clamp01((-Math.sin(ay) - 0.45) / 0.4) * 0.6);
    return _hc;
  };
  // Mottle in radians, not in loop indices, for the same reason bodyMul is.
  const headMul = (la, lo) => {
    const ay = (la / NLAT - 0.5) * Math.PI, ax = (lo / NLON) * Math.PI * 2;
    return 1 + 0.07 * Math.sin(ay * 5.9 + ax * 4.2) - 0.09 * clamp01(Math.sin(ay));
  };
  for (let la = 0; la < NLAT; la++) {
    for (let lo = 0; lo < NLON; lo++) {
      const lo2 = (lo + 1) % NLON;
      const a = headPt(la, lo), b = headPt(la, lo2);
      const c = headPt(la + 1, lo2), d = headPt(la + 1, lo);
      // At la 0 the a/b pair collapses onto the south pole and at la NLAT-1
      // the c/d pair collapses onto the north one; emitting the degenerate
      // half of those quads would cost 2 x NLON zero-area triangles.
      if (la > 0) {
        B.vert(a, 0, headCol(la, lo), headMul(la, lo));
        B.vert(b, 0, headCol(la, lo2), headMul(la, lo2));
        B.vert(c, 0, headCol(la + 1, lo2), headMul(la + 1, lo2));
      }
      if (la < NLAT - 1) {
        B.vert(a, 0, headCol(la, lo), headMul(la, lo));
        B.vert(c, 0, headCol(la + 1, lo2), headMul(la + 1, lo2));
        B.vert(d, 0, headCol(la + 1, lo), headMul(la + 1, lo));
      }
    }
  }

  // ── facial disc ───────────────────────────────────────────────────────────
  //
  // A shallow plate across the flattened front, plus a dark rim band that
  // runs back onto the dome. The band is not decoration: it is what guarantees
  // there is no gap between plate and skull at any angle, and the dark ring
  // around a pale face is most of what makes an owl's stare read at distance.
  //
  // It was a CONE — one fan from an apex straight out to a rim 18 mm proud of
  // the skull — and side-on a cone is a snout, which is most of why the pure
  // profile was the model's worst angle. It is a dish now: concentric rings on
  // a curve, the rim brought in to half its old proudness so it rolls into the
  // dome instead of standing off it. Face-on nothing is lost, because face-on
  // a dish and a cone of the same radius are the same pale plate — but the rim
  // band below has to be widened to compensate, since the dark ring around the
  // stare was partly the shadow the old cone's edge threw on itself.
  const discR = 0.076;
  const DISC_Z0 = 0.063;         // dish centre
  const DISC_Z1 = 0.038;         // dish rim — half the old cone's proudness
  // Power > 1 keeps the middle of the face flat and rolls it away only near
  // the edge, which is what a facial disc actually does.
  const discZ = (r) => lerp(DISC_Z0, DISC_Z1, Math.pow(clamp01(r / discR), 1.6));
  const discPt = (j, k) => {
    const r = (j / DISC_RINGS) * discR;
    const a = (k / DISC_N) * Math.PI * 2;
    return hp(Math.cos(a) * r, 0.008 + Math.sin(a) * r * 0.96, discZ(r));
  };
  const discRim = (k) => discPt(DISC_RINGS, k);
  // The ruff: two bands out from the dish rim, the outer one a whisker PROUD
  // of the skull's own equator so it reads as a raised collar of feather all
  // the way round rather than a painted line on the front. That is what buys
  // the head back at ninety degrees — the disc itself honestly disappears
  // there, owls have flat faces, but the ruff crosses the profile as a dark
  // curve and tells the eye where the ball ends and the shoulders start.
  const RUFF = [
    // radius, y-scale, z
    [0.087, 0.086, 0.020],
    [0.094, 0.092, -0.006],
  ];
  // A D, not a hoop. A full circle at this radius surfaces through the chest
  // below the chin and shows as a pale bib with a facet-jagged lower edge on
  // the three-quarter view — which is also the truth about the animal: a great
  // horned owl's disc border is a dark bracket over the crown and cheeks and
  // simply stops at the throat, where the white bib takes over. Squashing the
  // lower half buries it inside the skull, which is where it belongs.
  const RUFF_UNDER = 0.62;
  const ruffPt = (n, k) => {
    const a = (k / DISC_N) * Math.PI * 2;
    const sy = Math.sin(a);
    return hp(Math.cos(a) * RUFF[n][0],
      0.008 + (sy > 0 ? sy : sy * RUFF_UNDER) * RUFF[n][1], RUFF[n][2]);
  };
  fan(B, hp(0, 0.008, DISC_Z0), DISC_N, (k) => discPt(1, k), 0, C_DISC, 1.06, 1.03);
  for (let j = 1; j < DISC_RINGS; j++) {
    for (let k = 0; k < DISC_N; k++) {
      const k2 = (k + 1) % DISC_N;
      // Value falls off toward the rim, which is what shapes the dish when the
      // whole plate faces the same way and the lighting cannot do it.
      const m0 = 1.06 - 0.10 * (j / DISC_RINGS), m1 = 1.06 - 0.10 * ((j + 1) / DISC_RINGS);
      B.quad(discPt(j, k), discPt(j, k2), discPt(j + 1, k2), discPt(j + 1, k),
        0, C_DISC, C_DISC, m0, m1);
    }
  }
  // The ring is dark around the top and sides and runs pale under the chin:
  // that pale patch is the throat, the one white thing on a great horned owl,
  // and without it the rim closes into a black chinstrap that reads as a beard.
  const _rc = new THREE.Color();
  const ring = [discRim, (k) => ruffPt(0, k), (k) => ruffPt(1, k)];
  const ringMul = [1.18, 0.92, 0.70];
  for (let n = 0; n < ring.length - 1; n++) {
    for (let k = 0; k < DISC_N; k++) {
      const k2 = (k + 1) % DISC_N;
      // Kept to the true underside: at the old width the pale throat rode up
      // onto the cheek and read as a bandage across the face on the
      // three-quarter view, now that the ruff is wide enough to see.
      const down = clamp01((-Math.sin((k / DISC_N) * Math.PI * 2) - 0.45) / 0.45);
      _rc.copy(C_RIM).lerp(C_BIB, down * 0.8);
      B.quad(ring[n](k), ring[n](k2), ring[n + 1](k2), ring[n + 1](k),
        0, _rc, _rc, ringMul[n], ringMul[n + 1]);
    }
  }

  // ── eyes ──────────────────────────────────────────────────────────────────
  //
  // Two amber domes set into the plate, each with a pupil dome in front of it
  // and a catchlight in front of that — real geometry, not a painted eye,
  // because the whole animal's charm is here and a flat eye dies the instant
  // the head turns off-axis. They are authored large enough to nearly touch at
  // the centreline: a real owl's eyes take up most of its skull, and
  // underselling that is what makes a cartoon owl look like a pigeon.
  //
  // They used to be fans — cones, really, one apex over one ring — and a cone
  // catches light in a single facet per segment, so the iris read as a paper
  // sunburst rather than a wet ball. They are spherical caps now, a lat/long
  // dome for the iris and a smaller one for the pupil, both landing on exactly
  // the depths the fans used, so the face that came out of this is the face
  // that went in. The catchlight stays a six-sided speck; it is the one thing
  // here that is better flat.
  const eyeDome = (cx, cy, r, z0, z1, nlat, col, mHi, mLo) => {
    // t 0 at the rim, 1 at the pole; r cos, z sin — a cap, not a cone.
    const pt = (la, k) => {
      const t = (la / nlat) * Math.PI * 0.5;
      const rr = r * Math.cos(t);
      const a = (k / EYE_N) * Math.PI * 2;
      return hp(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, lerp(z0, z1, Math.sin(t)));
    };
    const mAt = (la) => lerp(mLo, mHi, la / nlat);
    for (let la = 0; la < nlat - 1; la++) {
      for (let k = 0; k < EYE_N; k++) {
        const k2 = (k + 1) % EYE_N;
        B.quad(pt(la, k), pt(la, k2), pt(la + 1, k2), pt(la + 1, k),
          0, col, col, mAt(la), mAt(la + 1));
      }
    }
    fan(B, pt(nlat, 0), EYE_N, (k) => pt(nlat - 1, k), 0, col, mHi, mAt(nlat - 1));
  };
  for (const s of [1, -1]) {
    const ex = s * 0.032, ey = 0.016;
    // Disc surface height at the eye, so the iris sits IN the face. Anchored
    // to DISC_Z0, so moving the dish moves the eyes with it and the depths the
    // face was tuned at survive.
    const zAt = (r) => DISC_Z0 - (r / discR) * 0.016;
    const irisR = 0.027;
    eyeDome(ex, ey, irisR, zAt(irisR) + 0.002, zAt(0.020) + 0.015,
      IRIS_LAT, C_EYE, 1.12, 0.86);
    const pupR = 0.0135;
    eyeDome(ex, ey, pupR, zAt(0.020) + 0.0135, zAt(0.020) + 0.0205,
      PUP_LAT, C_PUPIL, 1.0, 1.0);
    // Catchlight: a speck up and inboard. Tiny on purpose — big enough to
    // register as a live eye at ten metres, small enough to vanish at fifty
    // rather than read as a white defect.
    const gx = ex - s * 0.005, gy = ey + 0.007, gr = 0.0042;
    const gring = (k) => {
      const a = (k / 6) * Math.PI * 2;
      return hp(gx + Math.cos(a) * gr, gy + Math.sin(a) * gr, zAt(0.020) + 0.0215);
    };
    fan(B, hp(gx, gy, zAt(0.020) + 0.023), 6, gring, 0, C_GLINT);
  }

  // ── beak ──────────────────────────────────────────────────────────────────
  //
  // A short hook between and below the eyes, three faces and a cap. Kept small
  // and dark: on a real owl the bill is nearly buried in the disc feathering,
  // and every version of this that was allowed to be an eagle's bill turned
  // the face into a puffin.
  {
    // Carried forward with the dish: the disc centre moved out by 4 mm, and a
    // bill left behind swallows itself.
    const p0 = hp(-0.011, -0.008, 0.056);
    const p1 = hp(0.011, -0.008, 0.056);
    const p2 = hp(0, -0.020, 0.064);
    const tip = hp(0, -0.040, 0.050);
    B.tri(p0, p1, tip, 0, C_BEAK, C_BEAK, C_BEAK, 1.0, 1.0, 0.75);
    B.tri(p1, p2, tip, 0, C_BEAK, C_BEAK, C_BEAK, 1.15, 1.25, 0.8);
    B.tri(p2, p0, tip, 0, C_BEAK, C_BEAK, C_BEAK, 1.25, 1.15, 0.8);
    B.tri(p0, p2, p1, 0, C_BEAK, C_BEAK, C_BEAK, 1.1, 1.2, 1.1);
  }

  // ── ear tufts ─────────────────────────────────────────────────────────────
  //
  // The word "horned". Three-sided tapers rooted INSIDE the dome (base y is
  // below the skull surface at that x) so they can never read as two twigs
  // floating over the bird, angled outward and very slightly back. The forward
  // face is buff and the back is dark, which is how they read as tufts of
  // feather rather than as horns.
  for (const s of [1, -1]) {
    const bx = s * 0.040, by = 0.060, bz = -0.008;
    const apex = hp(s * 0.074, 0.140, -0.020);
    const b0 = hp(bx - s * 0.019, by - 0.008, bz + 0.017);
    const b1 = hp(bx + s * 0.019, by - 0.008, bz + 0.008);
    const b2 = hp(bx, by - 0.008, bz - 0.022);
    B.tri(b0, b1, apex, 0, C_TUFT, C_TUFT, C_TUFT, 1.45, 1.30, 1.05);
    B.tri(b1, b2, apex, 0, C_TUFT, C_TUFT, C_TUFT, 1.30, 0.9, 0.85);
    B.tri(b2, b0, apex, 0, C_TUFT, C_TUFT, C_TUFT, 0.9, 1.45, 1.0);
  }

  // ── tail ──────────────────────────────────────────────────────────────────
  //
  // Short and square — an owl's tail barely clears its wings, and a long
  // eagle wedge back here would undo the compact parcel the body is selling.
  // Seven feathers, barred, on the fan band (< 0.105) so the shader closes
  // them into a narrow blade when the bird settles.
  {
    const TB = [0, 0.028, -0.142];
    const NF = 7;
    for (let i = 0; i < NF; i++) {
      const a = lerp(-0.50, 0.50, i / (NF - 1));
      const wTail = (a / 0.50) * 0.09;
      const dx = Math.sin(a), dz = -Math.cos(a);
      const len = 0.118 - Math.abs(a) * 0.026;
      const y = TB[1] - 0.004 + (i % 2) * 0.005;    // stagger kills coplanar shimmer
      const px = -dz * 0.014, pz = dx * 0.014;
      const bar = i % 2 ? 0.86 : 1.05;
      // Three segments along the feather, drooping on a curve rather than a
      // straight ramp: cheap, and it is what keeps the closed fan from
      // reading as a folded paper wedge when the shader swings it shut.
      const TSEG = 3;
      const fp = (u, side) => {
        const q = lerp(1, 1.4, u) * side;
        return [TB[0] + dx * len * u + px * q, y - 0.010 * u * u,
          TB[2] + dz * len * u + pz * q];
      };
      for (let g = 0; g < TSEG; g++) {
        const u0 = g / TSEG, u1 = (g + 1) / TSEG;
        B.quad(fp(u0, -1), fp(u0, 1), fp(u1, 1), fp(u1, -1),
          wTail, C_WING, C_BAR, lerp(bar, bar * 1.1, u0), lerp(bar, bar * 1.1, u1));
      }
    }
  }

  // ── wings ─────────────────────────────────────────────────────────────────
  //
  // The anti-eagle. Root chord 0.196 against the eagle's 0.18 on a span three
  // quarters the size, a tip that stays broad until it rounds off, and four
  // SHORT blunt fingers instead of five long slotted ones — an owl's wing is a
  // paddle and the paddle is why it flies silently. The root station sits at
  // x 0.072, outboard of the fat body, while the shader's shoulder pivot stays
  // at 0.048: the fold therefore sweeps the whole panel back along the flank
  // instead of pivoting a slab out of the bird's middle.
  //
  // The trailing edge used to run out to -0.115 and was pulled forward to
  // here because the perched bird wore the panel as a cape. That diagnosis was
  // half right and the wrong half was blamed: the cape was the shared fold in
  // treeBirdMaterial rolling the span downward before it swept it, which it
  // did to all four birds and worst to the eagle, and it is fixed at the
  // source now. The chord stays where it is anyway — a blunt short wing is the
  // owl read — but nothing here is load-bearing for the fold any more, so a
  // future pass is free to give the trailing edge its width back.
  //
  // Density: the five authored stations are smoothTuples'd to thirteen and the
  // chord is cut into six panels instead of two. Both halves earn their keep
  // and for different reasons — the shader bends the wing by grading its
  // rotation on the spanwise fraction, so SPAN density is what turns the beat
  // from a hinge into a curve, while CHORD density is what stops the panel
  // creasing into two flat facets when the fold stands it on edge. At two
  // chord panels it was, unmistakably, a blade.
  const SPAN_KEY = [
    // x,     LE z,   TE z,   y
    [0.072, 0.118, -0.078, 0.032],
    [0.170, 0.128, -0.082, 0.041],
    [0.285, 0.120, -0.072, 0.047],
    [0.385, 0.100, -0.052, 0.051],
    [0.452, 0.066, -0.024, 0.053],
  ];
  const SPAN = smoothTuples(SPAN_KEY, WING_SMOOTH);
  const wingW = (x) => 0.12 + 0.88 * clamp01((x - 0.072) / 0.38);
  // Camber as an arc peaking a third of the way back, rather than the single
  // lifted mid-chord point that made a tent out of it.
  const camber = (t) => 0.013 * Math.sin(Math.PI * Math.pow(clamp01(t), 0.72));
  const _wc = new THREE.Color();
  const wingCol = (t) => {
    _wc.copy(C_BACK).lerp(C_WING, clamp01(t / 0.34));
    return _wc.lerp(C_BAR, clamp01((t - 0.58) / 0.42) * 0.9);
  };
  // Barring rides on x, not on the station index, so subdividing the span does
  // not turn the bars into a shimmer: the period is the authored spacing.
  const wingBar = (x) => 0.96 + 0.10 * Math.sin((x - 0.072) * 27.0);
  for (const s of [1, -1]) {
    const pt = (st, t) => [s * st[0], st[3] + camber(t), lerp(st[1], st[2], t)];
    for (let i = 0; i < SPAN.length - 1; i++) {
      const A = SPAN[i], D = SPAN[i + 1];
      const wA = s * wingW(A[0]), wD = s * wingW(D[0]);
      const bA = wingBar(A[0]), bD = wingBar(D[0]);
      for (let j = 0; j < WING_CHORD.length - 1; j++) {
        const t0 = WING_CHORD[j], t1 = WING_CHORD[j + 1];
        // Six vert() calls: every corner wants its own colour and weight, and
        // quad()'s two-colour form cannot express a bilinear patch.
        const put = (st, w, b, t) => B.vert(pt(st, t), w, wingCol(t), b * (1 - 0.10 * t));
        put(A, wA, bA, t0); put(D, wD, bD, t0); put(D, wD, bD, t1);
        put(A, wA, bA, t0); put(D, wD, bD, t1); put(A, wA, bA, t1);
      }
    }
    // The rounded tip: four stubby fingers, barely swept, tips lifted a
    // little. Long enough to break the outline so the wing does not end in a
    // straight cut; nowhere near long enough to read as an eagle's slots.
    // Split in two along their length so they curl rather than kink.
    const [xt, let_, tet, yt] = SPAN[SPAN.length - 1];
    const FING = [
      // sweep (rad back from +x), length, chord position 0..1 LE→TE
      [0.06, 0.046, 0.10],
      [0.30, 0.052, 0.38],
      [0.58, 0.048, 0.66],
      [0.86, 0.038, 0.90],
    ];
    const FSEG = 2;
    for (const [sw, len, cp] of FING) {
      const bz = lerp(let_, tet, cp);
      const dx = Math.cos(sw), dz = -Math.sin(sw);
      const hw = 0.016;
      const fp = (u, side) => {
        const h = hw * lerp(1, 0.6, u);
        return [s * (xt + dx * len * u), yt + 0.014 * u * u, bz + dz * len * u + h * side];
      };
      for (let g = 0; g < FSEG; g++) {
        const u0 = g / FSEG, u1 = (g + 1) / FSEG;
        B.quad(fp(u0, 1), fp(u0, -1), fp(u1, -1), fp(u1, 1),
          s * 1.0, C_WING, C_BAR, lerp(0.98, 1.0, u0), lerp(0.98, 1.0, u1));
      }
    }
  }

  // ── feet ──────────────────────────────────────────────────────────────────
  //
  // Feathered tarsi with dark talons — an owl's legs are trousered to the toe,
  // so these are pale and soft rather than the eagle's bare yellow scales.
  // Same deal as the eagle's: visible gripping under a perched bird, lost
  // against the belly in flight, one geometry for both.
  for (const s of [1, -1]) {
    const fx = s * 0.024, fz = 0.006;
    B.quad([fx - 0.009, -0.046, fz + 0.008], [fx + 0.009, -0.046, fz + 0.008],
      [fx + 0.007, -0.070, fz + 0.016], [fx - 0.007, -0.070, fz + 0.016], 0, C_FOOT, C_FOOT, 0.85, 0.7);
    B.quad([fx + 0.009, -0.046, fz + 0.008], [fx + 0.009, -0.046, fz - 0.008],
      [fx + 0.007, -0.070, fz + 0.000], [fx + 0.007, -0.070, fz + 0.016], 0, C_FOOT, C_FOOT, 0.7, 0.6);
    B.quad([fx - 0.009, -0.046, fz - 0.008], [fx - 0.009, -0.046, fz + 0.008],
      [fx - 0.007, -0.070, fz + 0.016], [fx - 0.007, -0.070, fz + 0.000], 0, C_FOOT, C_FOOT, 0.7, 0.6);
    // Two talons per foot, forward and back.
    B.tri([fx - 0.006, -0.070, fz + 0.014], [fx + 0.006, -0.070, fz + 0.014],
      [fx, -0.078, fz + 0.030], 0, C_CLAW);
    B.tri([fx + 0.006, -0.070, fz + 0.002], [fx - 0.006, -0.070, fz + 0.002],
      [fx, -0.076, fz - 0.014], 0, C_CLAW);
  }

  return B.build();
}

// ── gallery builder ──────────────────────────────────────────────────────────
//
// Same deal as buildBaldEagle: one bird at the in-game scale, pose baked
// per-vertex, time frozen. The gallery discovers this by the
// `build<Thing>(rnd, opts) -> Object3D` convention and deals one card per pose.

/** COLORWAYS-style variants for the gallery: judge both states. */
export const GREAT_HORNED_OWL_POSES = ['perched', 'glide'];

/** One great horned owl (2.8 m span, matching TREE_BIRD_SPECIES). */
export function buildGreatHornedOwl(rnd, opts = {}) {
  // Spelt out against opts.pose so the gallery's option probe sees a two-value
  // enum and deals each pose its own card (the eagle's trick).
  const perched = opts.pose === 'perched' && opts.pose !== 'glide';
  const geo = buildGreatHornedOwlGeometry();
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    arr[i * 4] = 0.7;                        // phase → wings a touch raised
    arr[i * 4 + 1] = 0.0;                    // rate 0: frozen for the thumbnail
    arr[i * 4 + 2] = perched ? 0.0 : 0.62;
    arr[i * 4 + 3] = perched ? 1.0 : 0.0;
  }
  geo.setAttribute('aPose', new THREE.Float32BufferAttribute(arr, 4));
  const mesh = new THREE.Mesh(geo, treeBirdMaterial({ time: { value: 0 } }));
  const S = 2.8;
  mesh.scale.setScalar(S);
  // Perched sits at the species' own perch pitch, not the eagle's -0.85: a
  // steeper tilt puts this bird's big face at the ceiling.
  if (perched) { mesh.rotation.x = -0.70; mesh.position.y = S * 0.44; }
  else mesh.position.y = S * 0.59;
  const g = new THREE.Group();
  g.add(mesh);
  void rnd;
  return g;
}
