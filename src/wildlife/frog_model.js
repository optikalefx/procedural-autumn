// ─────────────────────────────────────────────────────────────────────────────
//  frog_model — the thing that sits on the lily pads.
//
//  Built the way `bigfoot_model.js` is built, and for the same reason: it is
//  on neither animal track. `quadruped.js` lofts a barrel on four walking legs
//  and solves a GAIT against the ground every frame; a frog has no gait — it
//  sits, and then it is somewhere else. `glb_rig.js` plays an artist's clips,
//  and there is no artist's frog. So this uses the layer under both tracks —
//  `Skel`, `RigBuilder`, `tube`, the hide material — for one draw call and the
//  cast's shading, and authors the JUMP as a function of one timeline rather
//  than as a clip.
//
//  ── the proportions ARE the frog ────────────────────────────────────────────
//
//  Reference: a low-poly green frog, sitting, from the front three-quarter. A
//  frog is read by four things, in the order they survive being made small:
//
//    1. THE HUMP. The sacrum is the highest point of the animal and it is
//       BEHIND the middle — the back rises from the head to a peak over the
//       hips and drops off short to the vent. A frog whose high point is over
//       the shoulders is a toad-shaped lizard.
//    2. THE EYES ON TOP. Two domes on the crown, wide apart, bulging above the
//       skull line. They are the second-largest shapes on the animal after the
//       body and they are what makes the front view a face.
//    3. THE FOLDED HIND LEGS. Thigh forward and out, shank back, long foot
//       forward again under the body: a Z lying on its side, wider than the
//       body, with the knee the widest point of the whole silhouette. Sitting,
//       the hind leg is longer than the frog; that is what a jump is made of.
//    4. THE SHORT ARMS, propping the chest up off the ground so the body sits
//       nose-high with the belly line sloping down to the vent.
//
//  Authored at 0.28 m snout-to-vent and scaled by variant to bullfrog size; see
//  `FROG`. Colours: a green back over a cream belly and throat, dark eyes,
//  pale toe pads. NO collar, no markings the reference does not have.
//
//  ── the jump, as a timeline ─────────────────────────────────────────────────
//
//  The reference strip is five frames: sit — launch with the legs already
//  straight — apex with legs trailing — descent with the arms out and the legs
//  coming forward — landed. `jumpPose(t)` produces the joint parameters for any
//  point on that timeline; the world layer (`frogs.js`) owns WHERE the body is
//  on its arc and how long the flight lasts, and hands this file only the
//  phase. Every joint angle is derived from the bind skeleton (`extension()`),
//  so moving a joint in `J` moves the pose with it.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp01, lerp, smoothstep, mulberry32 } from '../core/MathUtils.js';
import { RigBuilder, Skel, tube, makePrototype, MIX, mixLerp } from './animal_rig.js';
import { crom } from './loft_smooth.js';

// ── the skeleton, sitting ────────────────────────────────────────────────────
//
// Model space: +Z forward, +Y up, origin on the ground under the body. +X is
// the frog's left. Every joint below is the SITTING pose; the jump is angles
// applied on top of it.
const J = {
  pelvis:   [0, 0.090, -0.062],
  spine:    [0, 0.086, -0.004],
  head:     [0, 0.074,  0.056],
  throat:   [0, 0.040,  0.074],
  // The eye centre sits INSIDE the top of the skull, so the ball bulges out
  // of the head rather than hovering over it (the first cut had it 2 cm up).
  eye:      [0.040, 0.098, 0.078],
  // ── the arm: DOWN and a little out, then forward to a hand under the chin ──
  // Down rather than out on purpose: every arm pose is a rotation about the
  // shoulder's X axis, which cannot move the arm's own sideways component —
  // an upper arm authored pointing out to the side sweeps through a cone
  // beside the body and never reaches the flank. Authored down, the same
  // rotation lays it back along the body in flight.
  shoulder: [0.046, 0.072, 0.048],
  elbow:    [0.056, 0.028, 0.044],
  wrist:    [0.064, 0.011, 0.066],
  hand:     [0.066, 0.007, 0.100],
  // ── the hind leg: a Z lying on its side ───────────────────────────────────
  // Thigh forward and OUT (the knee is the widest point of the frog), shank
  // straight back, tarsus forward and down, toes forward under the body.
  hip:      [0.042, 0.076, -0.062],
  knee:     [0.092, 0.060,  0.008],
  ankle:    [0.102, 0.022, -0.084],
  heel:     [0.094, 0.009, -0.028],
  toe:      [0.096, 0.006,  0.038],
};

/**
 * Snout-to-vent, metres, at scale 1. Asserted against the built body: the
 * loft below runs 0.28 m dome to dome, and the variants scale it down to the
 * 17-26 cm of a real bullfrog. The mesh is authored large because a 0.2 m
 * station list rounds every toe to a vertex.
 */
export const BODY_L = 0.28;
/** Height of the crown of the eyes over the ground, sitting, at scale 1. */
export const SIT_H = J.eye[1] + 0.022;

// ── the cast ─────────────────────────────────────────────────────────────────
export const FROG = {
  key: 'frog',
  variants: [
    // The reference: leaf green over cream.
    // Lighter and warmer than the lily pad's greens (lily_material uLilyA/B),
    // on purpose: the first cut was the pad's own hex and the frog vanished on
    // its perch.
    { name: 'green', scale: 0.74, weight: 0.55,
      col: { coat: 0x69b04b, pale: 0xe4d9ad, dark: 0x1c2618, horn: 0xe9dcae } },
    // A bullfrog: bigger, olive, the belly greyer.
    { name: 'bull', scale: 0.92, weight: 0.25,
      col: { coat: 0x596a2a, pale: 0xcfc9a2, dark: 0x1a1f14, horn: 0xdccfa4 } },
    // A small bright one.
    { name: 'leaf', scale: 0.60, weight: 0.20,
      col: { coat: 0x84c65a, pale: 0xf0e6b8, dark: 0x1e2a1a, horn: 0xf1e4b6 } },
  ],
};

// Ring sides. Small animal, few instances — spend the vertices on shape.
const R_BODY = 14, R_LIMB = 8, R_TOE = 5;

/** Catmull-Rom resample of stations — the same trick `bigfoot_model.js` uses. */
function smooth(src, f) {
  if (f <= 1 || src.length < 3) return src;
  const out = [];
  for (let i = 0; i < src.length - 1; i++) {
    const p0 = src[Math.max(0, i - 1)], p1 = src[i];
    const p2 = src[i + 1], p3 = src[Math.min(src.length - 1, i + 2)];
    out.push(p1);
    for (let s = 1; s < f; s++) {
      const t = s / f;
      const st = {};
      for (const k in p1) {
        if (k === 'mix' || typeof p1[k] !== 'number') continue;
        st[k] = crom(p0[k] ?? p1[k], p1[k], p2[k] ?? p1[k], p3[k] ?? p2[k] ?? p1[k], t);
      }
      if (p1.mix) st.mix = mixLerp(p1.mix, p2.mix ?? p1.mix, t);
      out.push(st);
    }
  }
  out.push(src[src.length - 1]);
  return out;
}

/** A straight run of stations from `a` to `b`, bound to `bone`, blending into `bone2` at the far end. */
function limb(a, b, r0, r1, bone, bone2, opts = {}) {
  const ts = opts.ts ?? [0.02, 0.30, 0.62, 0.90, 0.99];
  const flat = opts.flat ?? 1;
  return ts.map((t) => ({
    x: lerp(a[0], b[0], t), y: lerp(a[1], b[1], t), z: lerp(a[2], b[2], t),
    rx: lerp(r0, r1, t), ry: lerp(r0, r1, t) * flat,
    bone, bone2: t > 0.85 ? bone2 : bone, w2: t > 0.85 ? 0.5 : 0,
    mix: opts.mix ?? MIX.coat, shade: opts.shade ?? 1, k: opts.k ?? 1,
  }));
}

/**
 * After a tube has been laid down, repaint its underside pale: the belly and
 * throat of a frog are cream and the back is green, and the line between them
 * runs round the flank, not across a station — so it is a function of the
 * normal, applied to the vertices the tube just wrote.
 */
function bellyPaint(B, i0, i1, lo = -0.05, hi = 0.55) {
  for (let i = i0; i < i1; i++) {
    const ny = B.nor[i * 3 + 1];
    const t = smoothstep(hi, lo, ny);     // 1 where the normal faces down
    if (t <= 0) continue;
    const m = mixLerp([B.mix[i * 4], B.mix[i * 4 + 1], B.mix[i * 4 + 2], B.mix[i * 4 + 3]], MIX.pale, t);
    B.mix[i * 4] = m[0]; B.mix[i * 4 + 1] = m[1]; B.mix[i * 4 + 2] = m[2]; B.mix[i * 4 + 3] = m[3];
  }
}

export function buildFrog(variant) {
  const S = new Skel();
  const B = new RigBuilder();

  S.add('root', null, 0, 0, 0);
  S.add('pelvis', 'root', ...J.pelvis);
  S.add('spine', 'pelvis', ...J.spine);
  S.add('head', 'spine', ...J.head);
  S.add('throat', 'head', ...J.throat);
  for (const s of [1, -1]) {
    const tag = s > 0 ? 'L' : 'R';
    const m = (p) => [p[0] * s, p[1], p[2]];
    S.add(`shoulder${tag}`, 'spine', ...m(J.shoulder));
    S.add(`elbow${tag}`, `shoulder${tag}`, ...m(J.elbow));
    S.add(`wrist${tag}`, `elbow${tag}`, ...m(J.wrist));
    S.add(`hip${tag}`, 'pelvis', ...m(J.hip));
    S.add(`knee${tag}`, `hip${tag}`, ...m(J.knee));
    S.add(`ankle${tag}`, `knee${tag}`, ...m(J.ankle));
    S.add(`heel${tag}`, `ankle${tag}`, ...m(J.heel));
  }
  const b = (n) => S.idx(n);

  // ── the body ──────────────────────────────────────────────────────────────
  //
  // One loft, vent to snout. `y` is the centre of each cross-section and `ry`
  // its half-height, so the top line is y + ry and the belly line y - ry: read
  // the two together. The top climbs from the vent to the sacral hump at
  // z -0.055 (0.112 high — the highest point of the body, BEHIND the middle),
  // falls through the shoulders to the skull, and runs out flat to the snout.
  // The belly line stays a few millimetres off the ground all the way, rising
  // toward the throat where the arms hold the chest up. `k` 0.82 squares the
  // section: a frog is a flattened bag, not a sausage.
  // Short and wide. Vent to snout is 0.23 m of station plus the two domes;
  // the widest ring (0.064) is a third of that, where a lizard's is a fifth.
  // The head is nearly as wide as the body and the snout is a broad shovel,
  // not a point: the last station is still 0.040 across and the end dome is
  // shallow.
  const body = [
    { z: -0.095, y: 0.040, rx: 0.024, ry: 0.026, bone: b('pelvis'), shade: 0.86 },
    { z: -0.075, y: 0.054, rx: 0.046, ry: 0.048, bone: b('pelvis'), shade: 0.94 },
    // The hump has AMPLITUDE (top 0.132 against a skull top of 0.092, 1.43:1)
    // and the belly line climbs from the pad at the vent to 4 cm of daylight
    // under the throat — the chest is propped on the arms, not lying on the
    // leaf. The step at z 0.046 is the neck. The first cut ran one even wedge
    // from eyes to rump with the belly on the ground the whole way, which is
    // a salamander.
    { z: -0.048, y: 0.066, rx: 0.060, ry: 0.066, bone: b('pelvis') },
    { z: -0.018, y: 0.062, rx: 0.064, ry: 0.062, bone: b('pelvis'), bone2: b('spine'), w2: 0.5 },
    { z:  0.014, y: 0.059, rx: 0.062, ry: 0.052, bone: b('spine') },
    { z:  0.046, y: 0.062, rx: 0.058, ry: 0.032, bone: b('spine'), bone2: b('head'), w2: 0.5 },
    { z:  0.078, y: 0.066, rx: 0.062, ry: 0.026, bone: b('head') },
    { z:  0.106, y: 0.064, rx: 0.056, ry: 0.020, bone: b('head') },
    { z:  0.128, y: 0.060, rx: 0.040, ry: 0.014, bone: b('head'), shade: 0.96 },
  ];
  for (const st of body) { st.x = 0; st.k = 0.82; }
  const i0 = B.count;
  // smooth ×2 on 14 sides: ×3 on 16 was 25 thin rings that read as a lathed
  // loaf, smoother than the reference's visible facets.
  tube(B, smooth(body, 2), {
    radial: R_BODY, ao: 0.50, mix: MIX.coat,
    domeStart: 0.8, domeEnd: 0.5, domeSteps: 3,
  });
  // A clean line at mid-flank, not a soft band on the underside.
  bellyPaint(B, i0, B.count, 0.04, 0.20);

  // ── the eyes ──────────────────────────────────────────────────────────────
  //
  // Two domes on the crown. Each is a short tube with hemispherical caps — a
  // ball — in the dark colour, sitting in a shallow coat-coloured socket so the
  // eye reads as bulging OUT of the head rather than stuck on it.
  for (const s of [1, -1]) {
    const ex = J.eye[0] * s, ey = J.eye[1], ez = J.eye[2];
    // The socket: a coat-coloured mound rising out of the skull, its base
    // buried in the head so no seam shows. Then the ball, dark, half out.
    // A LOW collar (its top a few mm under the eye centre) and a big dark
    // dome: about 3 cm of eye shows over 1.5 cm of ring. The first cut was a
    // 2 cm green cylinder with a black lid — a turret.
    const socket = [
      { x: ex, y: ey - 0.024, z: ez, rx: 0.033, ry: 0.033, bone: b('head'), shade: 0.95 },
      { x: ex, y: ey - 0.014, z: ez, rx: 0.029, ry: 0.029, bone: b('head') },
    ];
    tube(B, socket, { radial: 10, mix: MIX.coat, capStart: false, domeEnd: 0.3, domeSteps: 2 });
    const ball = [
      { x: ex, y: ey - 0.004, z: ez, rx: 0.027, ry: 0.027, bone: b('head') },
      { x: ex, y: ey + 0.004, z: ez, rx: 0.027, ry: 0.027, bone: b('head') },
    ];
    tube(B, ball, { radial: 10, mix: MIX.dark, shade: 1.05, domeStart: 0.9, domeEnd: 0.9, domeSteps: 4, ao: 0 });
  }

  // ── the throat ────────────────────────────────────────────────────────────
  // A soft pale pouch under the jaw on its own bone, so a croak can inflate it
  // (bone scale) without touching the head.
  const th = J.throat;
  const throat = [
    { x: 0, y: th[1] + 0.006, z: th[2] - 0.030, rx: 0.026, ry: 0.014, bone: b('throat'), k: 0.9 },
    { x: 0, y: th[1] - 0.004, z: th[2] + 0.002, rx: 0.030, ry: 0.018, bone: b('throat'), k: 0.9 },
    { x: 0, y: th[1] + 0.004, z: th[2] + 0.040, rx: 0.022, ry: 0.012, bone: b('throat'), k: 0.9 },
  ];
  tube(B, smooth(throat, 2), { radial: 10, mix: MIX.pale, shade: 0.97, domeStart: 0.7, domeEnd: 0.7, ao: 0.2 });

  // ── the limbs ─────────────────────────────────────────────────────────────
  for (const s of [1, -1]) {
    const tag = s > 0 ? 'L' : 'R';
    const m = (p) => [p[0] * s, p[1], p[2]];

    // Arms: upper arm from a domed shoulder, forearm down to the wrist.
    tube(B, limb(m(J.shoulder), m(J.elbow), 0.014, 0.010, b(`shoulder${tag}`), b(`elbow${tag}`)),
         { radial: R_LIMB, domeStart: 0.9, domeSteps: 2, capEnd: false });
    tube(B, limb(m(J.elbow), m(J.wrist), 0.010, 0.0075, b(`elbow${tag}`), b(`wrist${tag}`)),
         { radial: R_LIMB, domeStart: 0.6, capEnd: false });
    // The hand: a flat pad from the wrist forward, and four toes fanning off it.
    const hand = limb(m(J.wrist), m(J.hand), 0.010, 0.012, b(`wrist${tag}`), b(`wrist${tag}`), { flat: 0.45, k: 0.8 });
    tube(B, hand, { radial: R_LIMB, domeStart: 0.5, domeEnd: 0.4, domeSteps: 1 });
    for (let f = 0; f < 4; f++) {
      const a = (f - 1.5) * 0.36;
      const base = m(J.hand);
      const tip = [base[0] + Math.sin(a) * 0.024 * s, base[1] - 0.002, base[2] + Math.cos(a) * 0.026];
      const toe = limb(base, tip, 0.0045, 0.0045, b(`wrist${tag}`), b(`wrist${tag}`), { ts: [0.0, 0.6, 1.0], flat: 0.7 });
      // Pale toe pads: the last station carries the horn colour.
      toe[toe.length - 1].mix = MIX.horn;
      tube(B, toe, { radial: R_TOE, capStart: false, domeEnd: 0.9, domeSteps: 1, ao: 0.1 });
    }

    // Hind legs. Thigh out of a domed hip socket, shank back, tarsus forward.
    // The thigh is the meat of the animal — a slab, cream underneath like
    // the belly, fatter than anything but the body; the shank tucks against it.
    const t0 = B.count;
    tube(B, limb(m(J.hip), m(J.knee), 0.036, 0.024, b(`hip${tag}`), b(`knee${tag}`), { flat: 0.68 }),
         { radial: R_LIMB, domeStart: 0.9, domeSteps: 2, capEnd: false });
    bellyPaint(B, t0, B.count, -0.35, 0.05);
    tube(B, limb(m(J.knee), m(J.ankle), 0.022, 0.013, b(`knee${tag}`), b(`ankle${tag}`)),
         { radial: R_LIMB, domeStart: 0.8, domeSteps: 2, capEnd: false });
    tube(B, limb(m(J.ankle), m(J.heel), 0.0085, 0.0075, b(`ankle${tag}`), b(`heel${tag}`)),
         { radial: R_LIMB, domeStart: 0.7, capEnd: false });
    // The foot: a long flat pad with five webbed toes. The webbing is the pad
    // itself, widening toward the toes; the toes are thin tubes off its end.
    const foot = limb(m(J.heel), m(J.toe), 0.009, 0.020, b(`heel${tag}`), b(`heel${tag}`), { flat: 0.30, k: 0.75 });
    tube(B, foot, { radial: R_LIMB, domeStart: 0.5, domeEnd: 0.3, domeSteps: 1 });
    for (let f = 0; f < 5; f++) {
      const a = (f - 2) * 0.30;
      const base = m(J.toe);
      const len = 0.026 + 0.008 * (1 - Math.abs(f - 2) / 2);
      const tip = [base[0] + Math.sin(a) * len * s, base[1], base[2] + Math.cos(a) * len];
      const toe = limb(base, tip, 0.0045, 0.0045, b(`heel${tag}`), b(`heel${tag}`), { ts: [0.0, 0.6, 1.0], flat: 0.7 });
      toe[toe.length - 1].mix = MIX.horn;
      tube(B, toe, { radial: R_TOE, capStart: false, domeEnd: 0.9, domeSteps: 1, ao: 0.1 });
    }
  }

  const g = B.toGeometry();
  // Every pose the jump reaches fits in a sphere about the hips of roughly
  // the extended leg length; frustum culling is on the SkinnedMesh.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.08, -0.02), 0.42);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-0.14, 0, -0.36), new THREE.Vector3(0.14, 0.16, 0.16));

  // The header's number, checked against the mesh it describes.
  const vent = body[0].z - 0.8 * (body[0].rx + body[0].ry) * 0.5;
  const snout = body[body.length - 1].z + 0.9 * (body[body.length - 1].rx + body[body.length - 1].ry) * 0.5;
  const measured = snout - vent;
  if (Math.abs(measured - BODY_L) > 0.02) {
    console.warn(`[frog] BODY_L says ${BODY_L} m, the body lofts to ${measured.toFixed(3)} m`);
  }

  return makePrototype(S, [g], {
    tris: B.index.length / 3,
    ext: extension(),
    variant,
  });
}

// ── the jump angles, derived ─────────────────────────────────────────────────
//
// `rotation.x = θ` on a bone subtracts θ from the angle its child direction
// makes in the YZ plane (atan2(y, z)); see the working in `FrogRig._pose`. So
// every joint's extension angle is the bind angle minus the wanted angle, and
// it is COMPUTED from `J` — a thigh authored a little more forward extends a
// little further and nothing else has to know.
function yzAngle(a, b) { return Math.atan2(b[1] - a[1], b[2] - a[2]); }
function extension() {
  const thigh = yzAngle(J.hip, J.knee), shank = yzAngle(J.knee, J.ankle);
  const tarsus = yzAngle(J.ankle, J.heel), foot = yzAngle(J.heel, J.toe);
  // Fully extended: the whole leg points straight back, a hair DOWN — and it
  // is written as -(π + 0.06) rather than (π - 0.06) on purpose. The two name
  // the same direction, but the rotation that reaches each from the sitting
  // thigh (which points forward, angle ≈ -0.17) is not the same: subtracting
  // toward -π swings the knee DOWN and back under the body, which is how a
  // frog extends; toward +π swings it UP over the back, which is how a frog
  // does not. The first cut had the second and the launch was a backflip.
  const back = -(Math.PI + 0.06);
  const upper = yzAngle(J.shoulder, J.elbow), fore = yzAngle(J.elbow, J.wrist), hand = yzAngle(J.wrist, J.hand);
  return {
    // hind leg: each joint's rotation to bring its segment collinear, back
    hip: thigh - back,
    knee: (shank - thigh) - 0.10,           // a hair of knee left in
    ankle: (tarsus - shank) - 0.04,
    heel: (foot - tarsus),
    // arms swept back along the flanks in flight: upper arm to back-and-down
    // (-(π - 0.22), the short way from hanging-down), forearm nearly in line
    armBack: upper + (Math.PI - 0.22),
    foreBack: (fore - upper) + 0.20,
    // arms reaching forward-down for the landing
    armReach: upper - (-0.75),
    foreReach: (fore - upper) - 0.55,
    handFlat: hand - fore,
  };
}

let _protos = null;
/** The prototypes, built once and shared by the world, the gallery and the harnesses. */
export function frogProtos() {
  return (_protos ??= FROG.variants.map((v) => buildFrog(v)));
}

/** Deterministic weighted pick over the variants. */
export function pickFrogVariant(r) {
  let acc = 0;
  for (let i = 0; i < FROG.variants.length; i++) {
    acc += FROG.variants[i].weight;
    if (r < acc) return i;
  }
  return FROG.variants.length - 1;
}

// ── the jump timeline ────────────────────────────────────────────────────────
//
// Durations, seconds, of the three fixed stages. The FLIGHT is not fixed: the
// world layer sets it from the arc, and `jumpPose` takes the stage and a
// 0..1 phase within it.
export const JUMP = {
  crouch: 0.22,      // gather: hips sink onto the hands, legs fold tighter
  launch: 0.10,      // legs go straight, body pitches nose-up, arms sweep back
  land: 0.26,        // arms take it high, the body sinks, then rises to sit
  // How much of the arc the LAUNCH stage plays. A real take-off lifts the body
  // about a leg length while the legs straighten; at 0.15 the feet went
  // through the leaf and the body had to jump in speed at flight start.
  arc: 0.25,
};

/**
 * The joint parameters for a point on the jump.
 *   stage  'sit' | 'crouch' | 'launch' | 'flight' | 'land'
 *   u      0..1 within the stage
 *
 * Returns { fold, arm, pitch, drop } where
 *   fold   -0.3 .. 1: hind legs, negative = tucked tighter than sitting,
 *          0 = the sitting bind pose, 1 = straight out behind
 *   arm    -1 .. 1: 1 = swept back along the body, -1 = reaching forward, 0 = sitting
 *   pitch  radians of body pitch, negative = nose up
 *   drop   metres the body sinks toward the pad (the crouch and the landing dip)
 */
export function jumpPose(stage, u, out = {}, dive = false) {
  u = clamp01(u);
  const e = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };   // clamped smoothstep
  // Defaults for the two parameters most stages do not use.
  out.kneeLag = 0; out.elbow = 0;
  switch (stage) {
    case 'crouch': {
      // The wind-up has to READ: the body sinks 3 cm onto the hands and the
      // elbows give (the forearm flattens toward the leaf, negative here) so
      // the chest drops onto them. Arms otherwise planted, nose barely down.
      const k = e(u);
      out.fold = -0.45 * k; out.arm = 0; out.pitch = 0.04 * k; out.drop = 0.032 * k;
      out.elbow = -0.40 * k;
      break;
    }
    case 'launch': {
      // Fast out of the crouch: most of the extension in the first half. Hip,
      // knee and ankle go together (kneeLag 0) — the lag is for folding BACK.
      // The body pitches to the take-off angle (~35° nose-up, the strip's
      // frame 2), starting from the crouch's own pitch so nothing pops.
      const k = 1 - Math.pow(1 - u, 2.2);
      out.fold = lerp(-0.45, 1.0, k);
      out.arm = lerp(0, 1.0, e(u));
      out.pitch = lerp(0.04, -0.60, k);
      out.drop = lerp(0.032, 0, k);
      out.elbow = -0.40 * (1 - e(u));
      out.kneeLag = 0;
      break;
    }
    case 'flight': {
      // Legs trail straight past the apex, then fold — knee first — back to
      // the sitting Z ready to take the landing; the arms leave the flanks and
      // reach; the nose comes level at the apex then down for the landing.
      // A DIVE holds the streamlined pose and noses down hard, 40° by entry.
      const fold = dive ? 1.0 : (u < 0.45 ? 1.0 : lerp(1.0, 0.0, e((u - 0.45) / 0.5)));
      const arm = dive ? 1.0 : (u < 0.35 ? 1.0 : lerp(1.0, -1.0, e((u - 0.35) / 0.55)));
      const down = dive ? 0.70 : 0.34;
      const pitch = u < 0.5 ? lerp(-0.60, -0.10, e(u / 0.5)) : lerp(-0.10, down, e((u - 0.5) / 0.5));
      out.fold = fold; out.arm = arm; out.pitch = pitch; out.drop = 0;
      out.kneeLag = 1;
      break;
    }
    case 'land': {
      // Contact is HIGH, on straight arms — the body is never lower than
      // sitting at touchdown — then it sinks fast onto the folded hind legs
      // and rises slowly to sit. The sink uses the crouch mapping, so the
      // feet stay on the leaf. Pitch comes off quickly so the pelvis is not
      // still driving the chin down while the arms are taking the weight.
      const dip = u < 0.25 ? Math.sin(Math.PI * 0.5 * u / 0.25) : Math.cos(Math.PI * 0.5 * clamp01((u - 0.25) / 0.45));
      out.fold = -0.26 * dip;
      out.arm = lerp(-1.0, 0, e(u / 0.8));
      out.pitch = lerp(0.34, 0, e(u / 0.45));
      out.drop = lerp(-0.035, 0, e(u / 0.45)) + 0.024 * dip;
      break;
    }
    default:
      out.fold = 0; out.arm = 0; out.pitch = 0; out.drop = 0;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  the rig
// ─────────────────────────────────────────────────────────────────────────────

export class FrogRig {
  constructor(proto, material, scale = 1) {
    this.proto = proto;
    const inst = instantiateFrog(proto, material);
    this.skin = inst.mesh;
    this.bones = inst.byName;
    this.root = inst.bones[0];

    // The node the world holds it by — see BigfootRig for why the scale sits
    // here and `geometry` is hung on the group.
    this.mesh = new THREE.Group();
    this.mesh.rotation.order = 'YXZ';
    this.mesh.scale.setScalar(scale);
    this.mesh.add(this.skin);
    this.mesh.geometry = proto.geoms[0];
    this.scale = scale;

    /** The joint parameters — see `jumpPose`. Written by `setPose`. */
    this.fold = 0; this.arm = 0; this.pitch = 0; this.drop = 0;
    this.kneeLag = 0; this.elbow = 0;
    /** 0..1 through the launch, 1 otherwise — see the heel guard in `_pose`. */
    this.launchU = 1;
    this._m = new THREE.Matrix4();
    this._hv = new THREE.Vector3();
    /** 0..1, how inflated the vocal sac is. */
    this.sac = 0;
    /** Breathing phase, for the idle. */
    this._breath = Math.random() * 6.28;
    this._pose();
  }

  /** Body length in world metres. */
  get length() { return BODY_L * this.scale; }

  /** Apply one point on the jump timeline. `dive` selects the water-entry choreography. */
  setPose(stage, u, dive = false) {
    const p = jumpPose(stage, u, this._pp ??= {}, dive);
    this.fold = p.fold; this.arm = p.arm; this.pitch = p.pitch; this.drop = p.drop;
    this.kneeLag = p.kneeLag; this.elbow = p.elbow;
    this.launchU = stage === 'launch' ? clamp01(u) : 1;
  }

  /** Advance the idle (breath) and re-pose. */
  update(dt) {
    this._breath += dt * 1.9;
    this._pose();
  }

  _pose() {
    const B = this.bones, E = this.proto.ext;
    const f = this.fold, a = this.arm;
    const br = 0.5 + 0.5 * Math.sin(this._breath);

    // ── hind legs ─────────────────────────────────────────────────────────────
    // fold 0 is the bind pose (every rotation 0); fold 1 is the derived
    // extension. The joints do NOT move in step: the hip drives first and the
    // knee straightens behind it (kneeF lags), so on the way OUT the leg
    // unfolds hip-first like a real push, and on the way BACK (the descent)
    // the knee tucks before the thigh swings forward — measured, a plain
    // linear fold passed through a pose with the whole leg hanging straight
    // down, 14 cm under the body, at fold 0.35.
    //
    // Negative fold is the crouch: the body has dropped `drop`, so the thigh
    // rotates UP to keep the knee where it was and the knee gives the same
    // back so the shank, tarsus and foot keep their world angles — the feet
    // stay planted on the pad instead of folding through it (the first cut
    // put the toes 8 cm under the leaf).
    // `kneeLag` is 1 on the way back (descent) and 0 on the way out: with the
    // lag applied to the launch as well, the thigh swung back while the shank
    // was still folded and the leg made an upside-down V over the back.
    const lag = 0.45 * this.kneeLag;
    for (const tag of ['L', 'R']) {
      if (f >= 0) {
        const hipF = clamp01(f / 0.6);
        const kneeF = clamp01((f - lag) / (1 - lag));
        B[`hip${tag}`].rotation.x = E.hip * hipF;
        B[`knee${tag}`].rotation.x = E.knee * kneeF;
        B[`ankle${tag}`].rotation.x = E.ankle * kneeF;
        B[`heel${tag}`].rotation.x = E.heel * kneeF;
      } else {
        const t = -f / 0.45;        // 0..1 into the crouch
        B[`hip${tag}`].rotation.x = -0.28 * t;
        B[`knee${tag}`].rotation.x = 0.28 * t;
        B[`ankle${tag}`].rotation.x = 0;
        B[`heel${tag}`].rotation.x = 0;
      }
    }

    // ── arms ─────────────────────────────────────────────────────────────────
    for (const tag of ['L', 'R']) {
      let sh, el, wr;
      if (a >= 0) {
        sh = E.armBack * a; el = E.foreBack * a; wr = -0.4 * a;
      } else {
        const t = -a;
        sh = E.armReach * t; el = E.foreReach * t; wr = E.handFlat * t;
      }
      B[`shoulder${tag}`].rotation.x = sh;
      B[`elbow${tag}`].rotation.x = el + this.elbow;
      B[`wrist${tag}`].rotation.x = wr;
    }

    // ── body ─────────────────────────────────────────────────────────────────
    // Pitch about the hips; the head counters a little so the eyes stay on
    // the target through the launch and the landing.
    B.pelvis.rotation.x = this.pitch;
    B.head.rotation.x = -0.35 * this.pitch;
    let lift = 0;
    if (this.launchU < 1) {
      // The push: while the legs straighten under a body the arc has barely
      // lifted, the heel would sweep below the leaf. Raise the root by that
      // depth — the body rides up on its own legs, which is what a push is —
      // fading out by the end of the launch so flight starts without a step.
      const depth = this._heelDepth();
      if (depth < 0) lift = -depth * (1 - this.launchU);
    }
    this.root.position.y = -this.drop + lift;
    // Breath: the flanks swell a few percent. Bone scale on the spine ring.
    const sw = 1 + 0.025 * br;
    B.spine.scale.set(sw, 1 + 0.015 * br, 1);
    // The vocal sac.
    const s = 1 + 0.9 * this.sac;
    B.throat.scale.set(s, s, 1 + 0.35 * this.sac);
  }

  /**
   * The lowest of heel and toe tip in the skin's frame, from the bone chain's
   * local matrices — four multiplies, no world-matrix pass. Toe tip is the
   * authored heel→toe vector carried on the heel bone.
   */
  _heelDepth() {
    const B = this.bones, m = this._m, v = this._hv;
    let low = 1e9;
    for (const tag of ['L', 'R']) {
      m.identity();
      for (const n of ['pelvis', `hip${tag}`, `knee${tag}`, `ankle${tag}`, `heel${tag}`]) {
        const b = B[n]; b.updateMatrix(); m.multiply(b.matrix);
      }
      v.set(0, 0, 0).applyMatrix4(m); low = Math.min(low, v.y);
      v.set(0.002, -0.003, 0.066).applyMatrix4(m); low = Math.min(low, v.y);
    }
    return low;
  }

  setShadow(on) { this.skin.castShadow = on; }
  dispose() { this.mesh.parent?.remove(this.mesh); }
}

/** `animal_rig.instantiate` with a root that may move (the crouch drops it). */
function instantiateFrog(proto, material) {
  const bones = [];
  const byName = {};
  for (const d of proto.skel.bones) {
    const bone = new THREE.Bone();
    bone.name = d.name;
    if (d.parent >= 0) {
      const p = proto.skel.bones[d.parent];
      bone.position.set(d.x - p.x, d.y - p.y, d.z - p.z);
      bones[d.parent].add(bone);
    } else {
      bone.position.set(d.x, d.y, d.z);
    }
    bones.push(bone);
    byName[d.name] = bone;
  }
  const skeleton = new THREE.Skeleton(bones, proto.boneInverses);
  const mesh = new THREE.SkinnedMesh(proto.geoms[0], material);
  mesh.add(bones[0]);
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  return { mesh, skeleton, bones, byName };
}
