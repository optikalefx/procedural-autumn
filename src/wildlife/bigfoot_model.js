// ─────────────────────────────────────────────────────────────────────────────
//  bigfoot_model — the one thing in this game that walks on two legs.
//
//  Everything else with a skeleton in `wildlife/` is on one of the two tracks
//  `CLAUDE.md` describes: a blueprint lofted by `quadruped.js` and solved by
//  `animal_anim.js`, or a GLB out of Blender played by `glb_rig.js`. This is
//  neither, and it needed a reason.
//
//  ── why not the hand-authored track ─────────────────────────────────────────
//
//  Because there is no asset. Every hand-authored animal in the cast came out
//  of `assets/models/Animals_v3.0.blend`, and that pack is quadrupeds and
//  birds — 233 actions and not one of them belongs to something bipedal. A
//  Blender bigfoot would not be "import the artist's work", it would be
//  modelling and rigging an ape from scratch and inventing every clip, which is
//  a pipeline this repo has never run and which the asset rule
//  ("what you see in Blender is what ships") does nothing to help with when
//  nobody has seen it in Blender either.
//
//  ── why not `quadruped.js` ──────────────────────────────────────────────────
//
//  Because it builds a barrel on a horizontal spine with four legs under it,
//  and the ONE thing this creature has to communicate at eighty metres through
//  timber is that it is standing up. Nothing about the blueprint format bends
//  that far.
//
//  ── so: the primitives, not the builder ─────────────────────────────────────
//
//  What is shared is the layer below both tracks — `Skel`, `RigBuilder`,
//  `tube` and the hide material. That is deliberate and it is most of the
//  value: one draw call, the same flat-shaded faceted surface as the rest of
//  the cast, the same distance-silhouette treatment, the same shadow path.
//  He is built out of the game's own parts; he is just not a deer.
//
//  ── the proportions ARE the design ──────────────────────────────────────────
//
//  `DESIGN_BRIEF` plate 3's argument — get the profile right and the shading
//  barely matters — is more true here than for any animal in the game, because
//  a bigfoot is a thing people only ever claim to have seen badly. Five cues,
//  in the order they survive being reduced to a black shape:
//
//    1. **upright**, and 2.75 m of it at the common variant's scale. Nothing
//       else in the valley is: a bear on all fours is 1.0 m at the shoulder and
//       a stag 1.5 m at the antler tip. The mesh below is authored at 2.22 m
//       and the cast is scaled up from it — see `BIGFOOT` for the reason, which
//       is that 2.22 m is not big enough to read as anything but a large man.
//    2. **no neck.** The trapezius runs from the ear to the deltoid, so the
//       head sits on the shoulders with no stalk between. This is the single
//       strongest "not a man in a suit" cue and it is free — it is one station
//       of the torso loft being 0.36 wide where a human's would be 0.09.
//    3. **the shoulders.** 0.86 m across, against 0.52 at the hips. A wedge,
//       not a cylinder. A man in a parka is a cylinder.
//    4. **the arms reach past the knee.** Fingertips at 0.70 m, knee at 0.60 m.
//       Arm 51% of standing height (human 44%, gorilla 55%). It is what makes
//       the arm swing read at range: the hands swing through a metre of arc
//       below the hip, where a human's swing is a small thing beside the body.
//    5. **the knee never straightens.** See `LEG` below — this is measured, not
//       styled, and it is the only cue on the list that is about MOTION.
//
//  ── and the foot ────────────────────────────────────────────────────────────
//
//  He is named after it. 0.43 m long, 0.19 m wide, flat, and no arch. It is
//  more geometry than a foot at eighty metres can possibly earn, and it is
//  spent anyway, because the payoff of the whole feature is the photograph and
//  the photograph will be looked at in the journal at a metre's distance.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, mulberry32 } from '../core/MathUtils.js';
import { RigBuilder, Skel, tube, makePrototype, MIX, mixLerp } from './animal_rig.js';
import { crom } from './loft_smooth.js';

// ── the skeleton ─────────────────────────────────────────────────────────────
//
// Model space, exactly as `animal_rig.js` requires: +Z forward, +Y up, origin
// on the ground between the feet, every bone at identity rotation. `+X` is his
// left, which is only ever visible in the mirrored limb names.
//
// The heights are a single column of numbers and they are the art. Read down
// it and the creature is there: hip at 1.08 of 2.22 (leg 48.6% of height —
// human 52%, gorilla 40%), shoulder at 1.84, and only 0.06 m of neck between
// the shoulder and the skull.
const J = {
  pelvis: [0, 1.08, -0.02],
  spine:  [0, 1.38, -0.04],
  chest:  [0, 1.68, -0.01],
  neck:   [0, 1.90,  0.00],
  head:   [0, 2.00,  0.02],
  // The clavicle yoke sits inboard and carries the whole shoulder, so a
  // shoulder roll moves the deltoid mass and not just the arm out of its socket.
  clav:   [0.15, 1.78, 0.00],
  arm:    [0.38, 1.84, 0.00],
  fore:   [0.41, 1.32, 0.02],
  hand:   [0.43, 0.88, 0.03],
  // ── the leg is authored dead vertical and coplanar, on purpose ────────────
  // The walk below solves it as a two-link chain in the sagittal plane, and
  // that solve is EXACT only if the bind pose has no x or z offset to lose.
  // A centimetre of authored lean would come back as a centimetre of foot
  // skate, which is the one artefact a slow deliberate walk cannot hide.
  //
  // x = 0.14 rather than the hip's own 0.26 half-width is not a compromise for
  // the solver — it is the narrow single-file track a bigfoot is supposed to
  // leave, and it is why the walk rolls the way it does.
  hip:    [0.14, 1.08, 0.00],
  knee:   [0.14, 0.60, 0.00],
  ankle:  [0.14, 0.13, 0.00],
  toe:    [0.14, 0.07, 0.19],
};

/**
 * Crown of the crest with the knees under him, in metres, **at scale 1** — the
 * height of the mesh below and not the height of anything in the game. Every
 * variant carries a scale of 1.19-1.31 and stands 2.64-2.91 m; see `BIGFOOT`
 * for why. 2.32 m of mesh less the 0.10 m the hips ride down at `LEG.crouch`.
 *
 * Written down here because three things outside this file need it and none of
 * them should be measuring a mesh to get it: the photo detector sizes his
 * silhouette sphere with it, the encounter picks a spawn clearing tall enough
 * for it, and the journal quotes it at the player. It is asserted against the
 * built geometry in `buildBigfoot` — a station that moves and a constant that
 * does not is exactly how a number in a header becomes a lie.
 */
export const STAND_H = 2.22;

/**
 * How far the ankle hangs below the hip when he is standing still, and how far
 * the toe tip is from the ankle. Both derived from `J` and `LEG` rather than
 * written down twice: the ankle path below is authored against the first and
 * the toe-off pivot against the second, and a joint that moved while a literal
 * did not is exactly the bug that shows up as a foot sliding on the ground.
 */

// ── the walk ─────────────────────────────────────────────────────────────────
//
// Authored as the path the ANKLE takes relative to the hip, and then solved
// back into two joint angles. That is the opposite of how the mammals work —
// `animal_anim.js` solves a quadruped's four legs against the real ground every
// frame — and it is the right way round here for one reason: with the ankle
// path authored as a straight backward line at a constant rate through stance,
// the ground speed that makes the foot stand still is not a thing to measure,
// it is a thing to divide.
//
//     ground per cycle = excursion / duty          (0.90 / 0.60 = 1.50 m)
//     walk speed       = ground per cycle * cadence (1.50 * 0.62 = 0.93 m/s)
//
// which is `CLAUDE.md`'s rule — derive the game from the clip — with the clip
// close enough to hand to do the arithmetic in the file. `WALK` below is that
// number and nothing reads a speed from anywhere else.
//
// ── the numbers, and the ceiling every one of them is under ──────────────────
//
// Hip-to-ankle is 0.95 m of bone (0.48 + 0.47). The rule the whole path is
// built to is that the leg NEVER reaches more than 95% of that — a locked knee
// is what makes a costume read as a person in a costume, and the compliant,
// always-bent stride is the one thing everybody who argues about the Patterson
// film agrees is in it. Every extreme of the path, as built:
//
//     heel strike     (+0.28, -0.85)   0.895   94.2%   <- the worst case
//     mid stance      (-0.17, -0.85)   0.867   91.3%
//     toe off         (-0.51, -0.71)   0.872   91.8%
//     mid swing       (-0.15, -0.53)   0.551   58.0%
//
// So the knee is bent between 6% and 42% of the way to its limit for the whole
// cycle and the IK never clamps. `solveLeg` clamps anyway, because the day
// somebody retunes one of these numbers is the day it stops being true silently.
//
// The rear extreme is 0.62 against the front's 0.28, which is not a typo and is
// where most of the stride comes from: the heel lifts 0.14 m over the back half
// of stance, and the ankle rising toward the hip is what buys the reach. Take
// the heel lift out and the excursion falls to 0.56 m, the stride to 0.93 m,
// and he walks at 0.58 m/s with a mincing step.
//
// ── the arc, which cost a measurement to find ────────────────────────────────
//
// The ankle does NOT travel in a straight line through the heel lift, and the
// first build had it doing so. A rigid foot pivoted about the ANKLE to keep its
// pad at ground height drags that pad BACKWARD — the pad sits 0.24 m ahead of
// the ankle, and swinging that offset up through 42 degrees shortens its
// forward reach by 0.11 m. The harness caught it exactly: heel contact measured
// 2.7% of walk and the pad measured 16%, worst 55 cm/s, all of it inside the
// lift.
//
// The real pivot is the pad. So `anklePath` runs the CONTACT down the straight
// line — that is what a planted foot does, by definition — and puts the ankle
// where a foot of this length pivoting on that contact would carry it: up and
// FORWARD, arcing over the toe. `FWD_MAX` is how far, and it is derived rather
// than tuned. `tools/_scratch/bfskate.mjs` is the harness and it is worth
// keeping: it is the only thing here that can tell a good stride from a
// plausible-looking one. As built, over one cycle sampled 400 times:
//
//     heel, while it is down      2.30 cm/s mean   2.5% of walk   worst 4.0
//     toe pad, all of stance      1.66 cm/s mean   1.8% of walk   worst 3.7
//
// which is a foot standing on the ground.
const LEG = {
  crouch: 0.10,      // m the hips ride below the bind pose; the standing bend
  front: 0.28,       // m the CONTACT reaches ahead of the hip at heel strike
  back: 0.62,        // m behind it at toe-off
  heel: 0.14,        // m the ankle rises over the back half of stance
  liftAt: 0.50,      // fraction of stance the heel starts coming up at
  lift: 0.30,        // m of ground clearance at mid-swing
  duty: 0.60,        // fraction of the cycle a foot is on the ground
  reachMax: 0.95,    // fraction of leg length the IK will not exceed
};

const STAND_D = J.hip[1] - LEG.crouch - J.ankle[1];              // 0.85 m
// The toe pad, from the last station of the sole loft in `build`: 0.24 m ahead
// of the ankle and 0.078 m below it. Everything at the back of stance pivots
// on this point.
const PAD = { z: 0.240, drop: J.ankle[1] - 0.052 };
const PAD_R = Math.hypot(PAD.z, PAD.drop);                       // 0.252 m
const PAD_A0 = Math.asin(PAD.drop / PAD_R);                      // 18.0 deg
/** Foot pitch that lifts the ankle by `h` while the pad stays on the ground. */
const rollFor = (h) => Math.asin(clamp01((PAD.drop + h) / PAD_R)) - PAD_A0;
/** …and how far forward of the contact line that pitch carries the ankle. */
const fwdFor = (roll) => PAD_R * (Math.cos(PAD_A0) - Math.cos(PAD_A0 + roll));
const ROLL_MAX = rollFor(LEG.heel);                              // 41.9 deg
const FWD_MAX = fwdFor(ROLL_MAX);                                // 0.113 m
/** Where the ankle actually is at toe-off, which is where the swing starts. */
const TOE_OFF_Z = -LEG.back + FWD_MAX;

/** Cycles per second at rate 1. A slow, deliberate cadence: 1.61 s a stride —
 *  and a 1.50 m stride at that cadence is 0.93 m/s, which is a walk with intent
 *  behind it rather than a stroll. He is leaving, not grazing. */
export const CADENCE = 0.62;
/** Metres of ground one cycle covers. `LEG.front + LEG.back` over `LEG.duty`. */
export const GROUND_PER_CYCLE = (LEG.front + LEG.back) / LEG.duty;
/** Metres per second at rate 1. Everything that moves him reads this. */
export const WALK = GROUND_PER_CYCLE * CADENCE;

// ── the coat ─────────────────────────────────────────────────────────────────
//
// Tufts, welded into the body mesh, exactly as `tools/build_goat_blend.py`
// grows the mountain goat's — and for the identical reason, stated in that
// file's header and true twice over here: **at the range this animal is seen
// the coat reads entirely as OUTLINE.** A surface treatment cannot do that. A
// bigfoot is a ragged black shape between two trunks at eighty metres, and the
// ragged edge IS the creature; smooth its outline and you have a bear standing
// up.
//
// The first cut of this file used `tube`'s `ripple` instead — the radius
// modulation written for the yak, unused since the ram replaced it. It is the
// wrong tool and the goat had already found that out: a radius wobble moves the
// silhouette by the amplitude, four centimetres, which is a third of a pixel at
// the distance that matters. A 0.15 m lock standing off the shoulder is eleven.
//
// Three rules carried straight over from that script, each of which cost it a
// round:
//
//   * **hair hangs.** `comb` is combed flat into the tangent plane FIRST and
//     `lift` mixes a little of the normal back in afterwards. Do it the other
//     way — a tuft along the normal, bent toward gravity — and you get thorns.
//   * **a coat needs two scales.** One even field of identical locks reads as
//     upholstery. `vary` on length and `jitter` on direction break it up.
//   * **it belongs on the flank and the hem, not the spine.** Shagging a back
//     turns it into corrugated iron.
//
// And two that are this creature's own.
//
// The **mane** is load-bearing. Cue 2 in the file header is the missing neck,
// and the torso loft only gets it half right — the other half is a ruff of long
// locks welding the skull to the shoulders so there is no gap for a neck to be
// seen through.
//
// And **`taper` is the difference between an ape and a haystack.** The first
// build gave the whole body one 0.15 m lock and it destroyed three of the five
// silhouette cues at once: the hem of the torso coat and the thigh coat met at
// the hip and made the WIDEST part of him his waist, the arms disappeared into
// the flank they hang beside, and what was left was a shaggy cone. The goat's
// version of this rule is "it belongs on the flank and the hem, not the spine";
// this creature's is the same rule pointing the other way, because his cue is
// a wedge and a wedge is heavy at the TOP. So every region's lock length is
// scaled by height: `taper: [yLo, yHi, kLo]` gives `kLo` of the length at yLo
// and all of it at yHi. Long over the shoulders and the upper arm, cropped at
// the hips, the forearms and the shins — which is also, as it happens, exactly
// how hair falls on a gorilla.
//
// `dens` is tufts per square metre of the surface they grow on, so a region's
// count follows its area and no two numbers here have to be balanced by hand.
// A lock is four vertices and three triangles — three sides, base left open,
// because the base is buried in the body and nobody will ever see it.
const FUR_SEED = 0xb1f007;

const FUR = {
  // The main mass, and the wedge. Full length across the shoulders, a third of
  // it at the hip — the taper is doing more for the silhouette here than the
  // length is.
  torso: { dens: 300, len: 0.175, lift: 0.10, comb: [0, -1, -0.34], width: 0.30,
           jitter: 0.16, vary: 0.42, curl: 0.30, taper: [0.98, 1.62, 0.30] },
  // The ruff. Denser than the flank, and `backOnly` — see `addFur`, where a
  // lock that would grow out over his own face is folded back.
  mane:  { dens: 640, len: 0.125, lift: 0.20, comb: [0, -0.75, -1], width: 0.32,
           jitter: 0.12, vary: 0.34, curl: 0.26, backOnly: true },
  // The arm carries the deltoid's worth and then gets out of the way, because
  // the arm's own length past the knee is cue 4 and a fringe hides it.
  arm:   { dens: 380, len: 0.115, lift: 0.13, comb: [0, -1, -0.12], width: 0.30,
           jitter: 0.18, vary: 0.40, curl: 0.34, taper: [1.34, 1.82, 0.34] },
  fore:  { dens: 420, len: 0.062, lift: 0.11, comb: [0, -1, -0.10], width: 0.30,
           jitter: 0.18, vary: 0.38, curl: 0.30, taper: [0.90, 1.30, 0.45] },
  thigh: { dens: 340, len: 0.088, lift: 0.11, comb: [0, -1, -0.16], width: 0.30,
           jitter: 0.16, vary: 0.40, curl: 0.28, taper: [0.62, 1.06, 0.45] },
  shin:  { dens: 400, len: 0.050, lift: 0.10, comb: [0, -1, -0.10], width: 0.30,
           jitter: 0.16, vary: 0.35, curl: 0.24, taper: [0.18, 0.60, 0.45] },
};

// Ring sides. Lower than the first cut, and deliberately: with the coat as
// geometry the body underneath is a shape to hang it on rather than the thing
// being looked at, and the vertices are better spent on locks. One creature
// exists at a time, so neither number is a budget question — see `build`.
const R_BODY = 18, R_LIMB = 10, R_TRIM = 8;

/**
 * Catmull-Rom resample of station objects, the same trick `quadruped.js` runs
 * on a blueprint's barrel: `f - 1` rings between each authored pair, every
 * numeric field following a spline through the keys rather than the chord. The
 * authored stations pass through untouched — they are the art.
 *
 * Local rather than shared because `smoothStations` lives inside `quadruped.js`
 * and reaching into the quadruped builder from the one thing in the tree that
 * is not a quadruped would be the wrong dependency to add for twelve lines.
 */
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
        if (k === 'mix') continue;
        if (typeof p1[k] !== 'number') continue;
        st[k] = crom(p0[k] ?? p1[k], p1[k], p2[k] ?? p1[k], p3[k] ?? p2[k] ?? p1[k], t);
      }
      if (p1.mix) st.mix = mixLerp(p1.mix, p2.mix ?? p1.mix, t);
      out.push(st);
    }
  }
  out.push(src[src.length - 1]);
  return out;
}

/** A straight run of stations between two model-space points. */
function limb(a, b, r0, r1, bone, bone2, ts, extra = {}) {
  return ts.map((t) => ({
    x: lerp(a[0], b[0], t), y: lerp(a[1], b[1], t), z: lerp(a[2], b[2], t),
    rx: lerp(r0, r1, t) * (extra.flat ?? 1), ry: lerp(r0, r1, t),
    // Only the last ring shares weight with the joint below, so the segment
    // keeps a hard profile and only the seam bends — the cast's own rule.
    bone, bone2: t > 0.9 ? bone2 : bone, w2: t > 0.9 ? 0.5 : 0,
    mix: extra.mix ?? MIX.coat, shade: extra.shade ?? 1,
    k: extra.k ?? 1,
  }));
}

const LIMB_T = [0.02, 0.20, 0.42, 0.64, 0.84, 0.97];

// ── growing the coat ─────────────────────────────────────────────────────────

const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _fn = new THREE.Vector3();
const _pt = new THREE.Vector3(), _cb = new THREE.Vector3(), _tg = new THREE.Vector3();
const _d = new THREE.Vector3(), _ax = new THREE.Vector3(), _th = new THREE.Vector3();
const _c0 = new THREE.Vector3(), _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3();

/**
 * Scatter tufts over triangles `[i0, i1)` of whatever `B` has built so far, and
 * weld them into the same buffers. The body is the source AND the destination,
 * which is what makes this cheap: no second draw call, no second material, no
 * transfer step, and every lock inherits the skin weights of the body vertex it
 * grows from — so it rides the walk exactly, through every pose, forever.
 *
 * That last point is the whole reason this is geometry and not a shader trick:
 * `addFur` runs once at build, and after that a lock costs precisely what three
 * triangles of anything else costs.
 *
 * Tufts are placed by AREA (`spec.dens` is per square metre), so a region does
 * not need its count tuned when a station moves — which is also why the arm and
 * the forearm can share a comb direction and differ only in length.
 */
function addFur(B, i0, i1, spec, rnd) {
  const P = B.pos, N = B.nor, M = B.mix, SH = B.shade, SI = B.si, SW = B.sw;
  const idx = B.index;
  let made = 0;
  // The index array is appended to as we go, so the loop bound is captured up
  // front: without this the first tuft's own triangles become sites for more.
  for (let t = i0; t < i1; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    _c0.fromArray(P, a * 3); _c1.fromArray(P, b * 3); _c2.fromArray(P, c * 3);
    _e1.subVectors(_c1, _c0); _e2.subVectors(_c2, _c0);
    _fn.crossVectors(_e1, _e2);
    const area2 = _fn.length();
    if (area2 < 1e-12) continue;
    _fn.multiplyScalar(1 / area2);

    // Stochastic rounding, so a triangle owed 0.3 of a tuft gets one three
    // times in ten rather than never. Without it every small face is bald and
    // the coat thins out exactly where the geometry is finest — the joints.
    const exact = area2 * 0.5 * spec.dens;
    let k = Math.floor(exact);
    if (rnd() < exact - k) k++;

    for (let n = 0; n < k; n++) {
      let u = rnd(), v = rnd();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      _pt.copy(_c0).addScaledVector(_e1, u).addScaledVector(_e2, v);
      // The nearest corner owns the lock. Rigid to one body vertex on purpose:
      // a tuft is small, and interpolated weights would let it shear at a seam.
      const w = 1 - u - v;
      const root = w >= u && w >= v ? a : u >= v ? b : c;

      // Comb flat FIRST, then lift. The reverse is what makes thorns.
      _cb.set(spec.comb[0] + (rnd() * 2 - 1) * spec.jitter, spec.comb[1], spec.comb[2]);
      _tg.copy(_cb).addScaledVector(_fn, -_cb.dot(_fn));
      if (_tg.lengthSq() < 1e-8) _tg.set(0, 1, 0).addScaledVector(_fn, -_fn.y);
      _tg.normalize();
      _d.copy(_tg).multiplyScalar(1 - spec.lift).addScaledVector(_fn, spec.lift);
      _d.x += (rnd() * 2 - 1) * spec.jitter * 0.5;
      _d.y += (rnd() * 2 - 1) * spec.jitter * 0.5;
      _d.z += (rnd() * 2 - 1) * spec.jitter * 0.5;
      if (_d.lengthSq() < 1e-8) continue;
      _d.normalize();
      // Nothing on the skull may grow FORWARD. Those surfaces face the muzzle,
      // so `lift` — which mixes the normal back in — aims their locks straight
      // across his own face. Hair on a throat hangs and sweeps back; it never
      // leads. (The goat learned this one the hard way; its header says so.)
      if (spec.backOnly && _d.z > 0) { _d.z *= 0.1; _d.normalize(); }

      const tp = spec.taper
        ? lerp(spec.taper[2], 1, smoothstep(spec.taper[0], spec.taper[1], _pt.y))
        : 1;
      const ln = spec.len * tp * (1 + (rnd() * 2 - 1) * spec.vary);
      const rad = Math.max(ln * spec.width, 0.004);
      // A lock is a flat RIBBON — wide across the fall, thin through it. A
      // round base is what makes a coat read as grass stuck to an animal.
      _ax.crossVectors(_d, _fn);
      if (_ax.lengthSq() < 1e-8) _ax.crossVectors(_d, _th.set(0, 1, 0));
      _ax.normalize();
      _th.crossVectors(_d, _ax).normalize();

      // Colour and shading come from the root, so a lock is the same hide as
      // the skin it grows out of and the coat cannot band against the body.
      const mix = [M[root * 4], M[root * 4 + 1], M[root * 4 + 2], M[root * 4 + 3]];
      const sh = SH[root];
      const b0 = SI[root * 4], b1 = SI[root * 4 + 1];
      const w0 = SW[root * 4], w1 = SW[root * 4 + 1];
      const put = (x, y, z, shade) => B.vert(x, y, z, _fn.x, _fn.y, _fn.z,
        mix, shade, b0, w0, b1, w1, 0);

      // The base is sunk half a radius INTO the body so the weld never gaps
      // when the skin bends underneath it.
      const bx = _pt.x - _d.x * rad * 0.5, by = _pt.y - _d.y * rad * 0.5,
            bz = _pt.z - _d.z * rad * 0.5;
      // Roots sit in the shade of their neighbours; tips catch the sky. Small,
      // because the hide material is doing the real work — but a coat with one
      // flat value is a cardboard cutout of a coat.
      const r0 = put(bx + _ax.x * rad, by + _ax.y * rad, bz + _ax.z * rad, sh * 0.82);
      const r1 = put(bx - _ax.x * rad, by - _ax.y * rad, bz - _ax.z * rad, sh * 0.82);
      const r2 = put(bx + _th.x * rad * 0.55, by + _th.y * rad * 0.55, bz + _th.z * rad * 0.55, sh * 0.82);
      // The tip falls away under its own weight. This is what makes a lock hang
      // rather than point, and it is the only place gravity enters the model.
      const tip = put(_pt.x + _d.x * ln, _pt.y + _d.y * ln - ln * spec.curl,
                      _pt.z + _d.z * ln, sh * 1.04);
      const ring = [r0, r1, r2];
      for (let j = 0; j < 3; j++) B.tri(ring[j], ring[(j + 1) % 3], tip);
      made++;
    }
  }
  return made;
}


/**
 * Build the mesh and the skeleton. One geometry, not two.
 *
 * Every other animal carries a near and a mid LOD because there can be nine
 * deer alive at once and the mid mesh is a fifth of the rings. There is at most
 * ONE of these in the world, ever, by construction (`bigfoot.js` owns that),
 * so a second geometry would buy a few hundred triangles back off a 60-call
 * budget and cost the coat: `quadruped.js`'s own note says the ripple cannot
 * survive the mid mesh's ring count, and the mid LOD starts at 58 m — which is
 * the middle of the range this creature is designed to be seen at.
 */
export function buildBigfoot(variant) {
  const S = new Skel();
  const B = new RigBuilder();
  const rnd = mulberry32(FUR_SEED ^ ((variant.furSeed ?? 0) >>> 0));
  const coat = {};
  // Grow the tufts over exactly the triangles the last tube laid down. A
  // range rather than a position test: the goat's script needed
  // `_fur_region` because it was handed a finished mesh with no idea which
  // face was a cheek and which was a flank, and its header records that the
  // first cut at that test left holes. Here the builder knows, so the bald
  // regions — the face, the hands, the soles — are simply the tubes this is
  // not called after.
  let mark = 0;
  const fur = (name, spec) => {
    coat[name] = (coat[name] ?? 0) + addFur(B, mark, B.index.length, spec, rnd);
    mark = B.index.length;
  };
  const skip = () => { mark = B.index.length; };

  S.add('root', null, 0, 0, 0);
  S.add('pelvis', 'root', ...J.pelvis);
  S.add('spine', 'pelvis', ...J.spine);
  S.add('chest', 'spine', ...J.chest);
  S.add('neck', 'chest', ...J.neck);
  S.add('head', 'neck', ...J.head);
  const side = [];
  for (const s of [1, -1]) {
    const tag = s > 0 ? 'L' : 'R';
    const m = (p) => [p[0] * s, p[1], p[2]];
    S.add(`clav${tag}`, 'chest', ...m(J.clav));
    S.add(`arm${tag}`, `clav${tag}`, ...m(J.arm));
    S.add(`fore${tag}`, `arm${tag}`, ...m(J.fore));
    S.add(`hand${tag}`, `fore${tag}`, ...m(J.hand));
    S.add(`hip${tag}`, 'pelvis', ...m(J.hip));
    S.add(`knee${tag}`, `hip${tag}`, ...m(J.knee));
    S.add(`ankle${tag}`, `knee${tag}`, ...m(J.ankle));
    S.add(`toe${tag}`, `ankle${tag}`, ...m(J.toe));
    side.push({ s, tag, m });
  }
  const b = (n) => S.idx(n);

  // ── the torso ──────────────────────────────────────────────────────────────
  //
  // One loft, crotch to the top of the trapezius, and it is where four of the
  // five silhouette cues live. `rx` is across, `ry` is front-to-back: read the
  // two columns together and the wedge is visible as a number — 0.26 wide and
  // 0.20 deep at the hip, 0.43 wide and 0.26 deep at the shoulder. Wide and
  // SHALLOW, which is what makes him read as a slab from the front and as
  // surprisingly thin from the side, exactly like the film everybody argues
  // about.
  //
  // `k: 0.78` is the superellipse: a squarer cross-section than any animal in
  // the cast wears. A round barrel reads as an animal; a slab reads as a chest.
  const torso = [
    { y: 0.84, z: -0.02, rx: 0.205, ry: 0.170, bone: b('pelvis'), shade: 0.80 },
    { y: 0.98, z: -0.02, rx: 0.250, ry: 0.198, bone: b('pelvis'), shade: 0.88 },
    { y: 1.12, z: -0.03, rx: 0.262, ry: 0.208, bone: b('pelvis'), bone2: b('spine'), w2: 0.5 },
    { y: 1.28, z: -0.04, rx: 0.268, ry: 0.212, bone: b('spine') },
    { y: 1.46, z: -0.04, rx: 0.310, ry: 0.232, bone: b('spine'), bone2: b('chest'), w2: 0.5 },
    { y: 1.62, z: -0.02, rx: 0.372, ry: 0.256, bone: b('chest') },
    { y: 1.76, z: -0.01, rx: 0.424, ry: 0.258, bone: b('chest') },
    // ── the cue ──────────────────────────────────────────────────────────────
    // 0.36 half-width at 1.86, which is above the shoulder joint and level with
    // the jaw. This station is the missing neck: the trapezius comes up to the
    // ear instead of a stalk coming out of a collar. Delete it and he is a very
    // large man.
    { y: 1.86, z: 0.00, rx: 0.360, ry: 0.226, bone: b('chest'), bone2: b('neck'), w2: 0.4 },
    { y: 1.93, z: 0.01, rx: 0.235, ry: 0.185, bone: b('neck'), shade: 0.92 },
  ];
  for (const st of torso) { st.x = 0; st.k = st.k ?? 0.78; }
  tube(B, smooth(torso, 3), {
    radial: R_BODY, ao: 0.55, mix: MIX.coat,
    domeStart: 0.85, domeEnd: false, capEnd: false, domeSteps: 3,
  });
  fur('torso', FUR.torso);

  // ── the skull ──────────────────────────────────────────────────────────────
  //
  // Small for the shoulders — that is the whole point of it — and topped with a
  // sagittal crest, which is a real thing on a large ape and reads at range as
  // a pointed head. The face is a second short loft rather than a bend in this
  // one, because a heavy brow over a jutting muzzle is two masses meeting at an
  // angle and lofting through it rounds off precisely the corner that matters.
  const skull = [
    { y: 1.88, z: -0.04, rx: 0.150, ry: 0.150, bone: b('neck'), bone2: b('head'), w2: 0.5, shade: 0.9 },
    { y: 1.98, z: -0.02, rx: 0.152, ry: 0.163, bone: b('head') },
    { y: 2.09, z: -0.01, rx: 0.136, ry: 0.156, bone: b('head') },
    { y: 2.18, z: -0.03, rx: 0.088, ry: 0.112, bone: b('head') },
    { y: 2.25, z: -0.05, rx: 0.034, ry: 0.056, bone: b('head'), mix: mixLerp(MIX.coat, MIX.pale, 0.35) },
  ];
  for (const st of skull) { st.x = 0; st.k = 0.86; }
  tube(B, smooth(skull, 3), { radial: R_LIMB, ao: 0.5, domeEnd: 0.9, domeSteps: 3 });
  fur('mane', FUR.mane);

  // The face: brow, then muzzle, running forward and down. Bare skin, so no
  // shag and the dark channel rather than the coat.
  const face = [
    { y: 2.04, z: 0.06, rx: 0.140, ry: 0.062, bone: b('head'), mix: MIX.dark, shade: 0.72 },
    { y: 1.99, z: 0.13, rx: 0.128, ry: 0.070, bone: b('head'), mix: MIX.dark, shade: 0.66 },
    { y: 1.93, z: 0.16, rx: 0.108, ry: 0.070, bone: b('head'), mix: MIX.dark, shade: 0.62 },
    { y: 1.87, z: 0.15, rx: 0.086, ry: 0.058, bone: b('head'), mix: MIX.dark, shade: 0.58 },
  ];
  for (const st of face) { st.x = 0; st.k = 0.72; }
  tube(B, smooth(face, 3), { radial: R_TRIM, ao: 0.45, domeEnd: 0.7, capStart: false });
  skip();                                   // bare skin: brow, muzzle, jaw

  // ── the limbs ──────────────────────────────────────────────────────────────
  for (const { tag, m } of side) {
    const A = (n) => m(J[n]);
    const arm = A('arm'), fore = A('fore'), hand = A('hand');
    // Fingertips: the hand segment carried on past the knuckles, so the arm
    // ends where a hanging hand ends rather than at the wrist.
    const tip = [hand[0] + (fore[0] - arm[0]) * 0.1, hand[1] - 0.18, hand[2] + 0.02];

    tube(B, smooth(limb(arm, fore, 0.118, 0.092, b(`arm${tag}`), b(`fore${tag}`), LIMB_T,
      { flat: 0.92 }), 2),
      { radial: R_LIMB, ao: 0.5, domeStart: 0.95, domeEnd: 0.6, domeSteps: 2 });
    fur('arm', FUR.arm);
    tube(B, smooth(limb(fore, hand, 0.092, 0.062, b(`fore${tag}`), b(`hand${tag}`), LIMB_T,
      { flat: 0.9 }), 2),
      { radial: R_LIMB, ao: 0.5, domeStart: 0.8, domeEnd: 0.6, domeSteps: 2 });
    fur('fore', FUR.fore);
    // The hand is bare, and flattened — a broad paddle, not a fist.
    tube(B, limb(hand, tip, 0.070, 0.040, b(`hand${tag}`), b(`hand${tag}`), [0, 0.35, 0.7, 1],
      { flat: 1.5, mix: MIX.dark, shade: 0.7, k: 0.7 }),
      { radial: R_TRIM, ao: 0.4, domeStart: 0.7, domeEnd: 0.9, domeSteps: 2 });
    skip();                                 // bare skin: the palm and fingers

    const hip = A('hip'), knee = A('knee'), ankle = A('ankle');
    tube(B, smooth(limb(hip, knee, 0.163, 0.118, b(`hip${tag}`), b(`knee${tag}`), LIMB_T,
      { flat: 0.94 }), 2),
      { radial: R_LIMB, ao: 0.55, domeStart: 0.95, domeEnd: 0.6, domeSteps: 2 });
    fur('thigh', FUR.thigh);
    tube(B, smooth(limb(knee, ankle, 0.118, 0.062, b(`knee${tag}`), b(`ankle${tag}`), LIMB_T,
      { flat: 0.92 }), 2),
      { radial: R_LIMB, ao: 0.5, domeStart: 0.8, domeEnd: 0.5, domeSteps: 2 });
    fur('shin', FUR.shin);

    // ── the foot ─────────────────────────────────────────────────────────────
    // Heel behind the ankle, toe well in front of it, and flat all the way: no
    // arch, which is the anatomical claim every plaster cast in the literature
    // is arguing about. Bound half to the ankle and half to the toe at the
    // ball, so the toe-off at the back of stance bends it where a foot bends.
    const [fx, , ] = ankle;
    const sole = [
      { x: fx, y: 0.075, z: ankle[2] - 0.135, rx: 0.072, ry: 0.070, bone: b(`ankle${tag}`), k: 0.6 },
      { x: fx, y: 0.062, z: ankle[2] - 0.040, rx: 0.093, ry: 0.058, bone: b(`ankle${tag}`), k: 0.55 },
      { x: fx, y: 0.058, z: ankle[2] + 0.055, rx: 0.098, ry: 0.052, bone: b(`ankle${tag}`), bone2: b(`toe${tag}`), w2: 0.5, k: 0.55 },
      { x: fx, y: 0.056, z: ankle[2] + 0.150, rx: 0.092, ry: 0.048, bone: b(`toe${tag}`), k: 0.55 },
      { x: fx, y: 0.052, z: ankle[2] + 0.240, rx: 0.070, ry: 0.042, bone: b(`toe${tag}`), k: 0.6 },
    ];
    for (const st of sole) { st.mix = MIX.dark; st.shade = 0.62; }
    tube(B, smooth(sole, 2), { radial: R_TRIM, ao: 0.35, domeStart: 0.8, domeEnd: 0.75, domeSteps: 2 });
    skip();                                 // bare skin: the sole. He is named
                                            // after it; do not hide it in hair.
  }

  const geo = B.toGeometry();

  // Extent, off the built mesh rather than off the numbers above — the same
  // reason `quadruped.js` measures its own: a station that moved should move
  // the bounding sphere with it.
  let top = 0, halfLen = 0, halfW = 0;
  const pos = geo.attributes.position.array;
  for (let i = 0; i < pos.length; i += 3) {
    top = Math.max(top, pos[i + 1]);
    halfLen = Math.max(halfLen, Math.abs(pos[i + 2]));
    halfW = Math.max(halfW, Math.abs(pos[i]));
  }
  // Padded for the widest the walk reaches: a leg at full stride puts a foot
  // 0.56 m behind the origin and an arm swings as far the other way.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, top * 0.5, 0),
    Math.hypot(Math.max(halfLen, 0.7), top * 0.55) * 1.2);

  // The constant and the mesh, checked against each other once at build. A
  // centimetre is slack for a coat tuft poking above the crest; ten is a
  // station somebody moved.
  const stand = top - LEG.crouch;
  if (Math.abs(stand - STAND_H) > 0.10) {
    console.warn('[bigfoot] STAND_H is', STAND_H, 'but the mesh stands', stand.toFixed(3));
  }

  return makePrototype(S, [geo, geo], {
    variant, height: top, halfW, stand, tris: geo.index.count / 3, coat,
    tufts: Object.values(coat).reduce((a, n) => a + n, 0),
    legs: { l1: S.span('hipL', 'kneeL'), l2: S.span('kneeL', 'ankleL') },
  });
}


// ── the cast of one ──────────────────────────────────────────────────────────
//
// Three coats, and every one of them is a dark value against a #f0ad46 meadow
// and a rust canopy. That is not a preference — `hide.js`'s distance-silhouette
// block is the file that explains it, and it applies here harder than to any
// animal in the cast, because this is a creature whose entire job is to be
// *recognisable and unidentifiable at the same time*. A hide that reads as a
// hue is a hide you can identify.
//
// `pale` is the grizzle at the shoulders and the crest rather than a belly:
// nothing about this animal is pale underneath, and the one place a big ape
// actually goes light is the back, with age.
// ── and why the scales are not 1 ─────────────────────────────────────────────
//
// The mesh above is authored at 2.22 m standing, which is the top of the range
// anybody actually claims and about 30 cm over the tallest man most people have
// met. It is not enough. Put him on a riverbank at fifteen metres with nothing
// human in the frame and he reads as a big man in a fur coat — the trees and
// the grass are the only scale reference the shot has, and neither of them
// tells you how tall a person is.
//
// So the cast stands at `STAND_H * scale`:
//
//     rust      2.64 m        the small one
//     sable     2.75 m        the common one
//     grizzled  2.91 m        the old one
//
// which is a foot and a half over the tallest thing on two legs anybody has
// ever met, and reads that way instantly. Scaling rather than re-authoring is
// not a shortcut: `scale` rides the node the world holds him by, so the walk
// scales with him — `GROUND_PER_CYCLE * scale` at the sable's 1.24 is a **1.86
// m stride at 1.15 m/s**, which is very close to the 1.7 m stride measured off
// the line of prints everybody argues about. The proportion cues in this
// file's header are ratios and are untouched by any of it.
export const BIGFOOT = {
  key: 'bigfoot',
  variants: [
    { name: 'sable', scale: 1.24, weight: 0.50, furSeed: 1,
      col: { coat: 0x2a2018, pale: 0x4a3b2a, dark: 0x120e0a, horn: 0x6b5c46 } },
    { name: 'rust', scale: 1.19, weight: 0.30, furSeed: 2,
      col: { coat: 0x3a2618, pale: 0x6b4b2e, dark: 0x1a1009, horn: 0x6b5c46 } },
    // The old one. Grey through the shoulders and the crest, which is the
    // single most photographed thing about a silverback and reads at range as
    // a light patch riding above the arms — and the biggest of the three,
    // because the one people swear was enormous should sometimes be enormous.
    { name: 'grizzled', scale: 1.31, weight: 0.20, furSeed: 3,
      col: { coat: 0x332c26, pale: 0x77706a, dark: 0x17130f, horn: 0x6b5c46 } },
  ],
};

let _protos = null;
/**
 * The three prototypes, built once and shared. Memoised rather than rebuilt
 * because the gallery, the encounter and any harness all want the same three
 * and building one costs ~14 ms — small, and paid on whichever frame asks
 * first, which is a frame the player is looking at.
 */
export function bigfootProtos() {
  return (_protos ??= BIGFOOT.variants.map((v) => buildBigfoot(v)));
}

/** Deterministic weighted pick over the variants. */
export function pickBigfootVariant(r) {
  let acc = 0;
  for (let i = 0; i < BIGFOOT.variants.length; i++) {
    acc += BIGFOOT.variants[i].weight;
    if (r < acc) return i;
  }
  return BIGFOOT.variants.length - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
//  the rig
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the ankle should be at cycle phase `p`, relative to the hip, in the
 * sagittal plane. Returns `[dz, dy]` with `dy` negative (the ankle is below the
 * hip) and `dz` positive forward, plus the pitch the sole should hold.
 *
 * This function IS the animation. Everything else in the rig is arithmetic
 * around it.
 */
function anklePath(p) {
  const { front, back, heel, lift, duty, liftAt } = LEG;
  if (p < duty) {
    // ── stance ──────────────────────────────────────────────────────────────
    // The CONTACT runs straight backward at a constant rate. That constancy is
    // not a simplification, it is the definition of a planted foot: it travels
    // backward relative to the hip at exactly the speed the body travels
    // forward, and any curve in this line would be skate.
    const t = p / duty;
    const contact = lerp(front, -back, t);
    // The heel comes up over the back half, pivoting on the pad.
    const h = heel * smoothstep(liftAt, 1.0, t);
    const roll = rollFor(h);
    // …and the ankle arcs up and FORWARD over that pad rather than following
    // the contact line down. See the header: this is the whole correction.
    const dz = contact + fwdFor(roll);
    // Sole pitch: a little toe-up at heel strike, flat through the middle, and
    // rolled onto the toe at the end. The roll is not styled — it is exactly
    // the angle the arc above is built on, so the pad cannot leave the ground.
    const pitch = lerp(-0.13, 0, smoothstep(0, 0.18, t)) + roll;
    return [dz, -(STAND_D - h), pitch, roll];
  }
  // ── swing ─────────────────────────────────────────────────────────────────
  // Every one of these starts where stance left off, in all three channels. A
  // discontinuity here would be a leg that teleports on one frame every stride,
  // which is invisible in a still and unmissable in motion.
  const t = (p - duty) / (1 - duty);
  // Eased at both ends: a swinging leg is a pendulum, not a conveyor.
  const e = t * t * (3 - 2 * t);
  const dz = lerp(TOE_OFF_Z, front, e);
  // One hump of clearance over the height the toe-off already gave it, biased
  // early — the foot is picked up smartly and set down softly, which is what
  // makes a heavy walk read as heavy.
  const up = heel * (1 - e) + lift * Math.sin(Math.PI * Math.min(1, t * 1.12)) * (1 - 0.25 * t);
  const pitch = lerp(ROLL_MAX, -0.13, smoothstep(0.10, 0.92, t));
  return [dz, -(STAND_D - up), pitch, ROLL_MAX * (1 - smoothstep(0, 0.35, t))];
}

/**
 * Two-link IK in the sagittal plane. `dz`/`dy` are the ankle relative to the
 * hip; returns the thigh's pitch and the knee's flexion, both as the sign
 * convention the bones want.
 *
 * Positive `rotation.x` swings a downward-pointing bone BACKWARD (rotating +Z
 * toward -Y), so a thigh reaching forward is negative and a knee — which only
 * ever folds the heel back and up — is positive. That the knee has one sign is
 * the whole reason this needs no pole vector.
 */
function solveLeg(dz, dy, l1, l2) {
  const reach = (l1 + l2) * LEG.reachMax;
  let d = Math.hypot(dz, dy);
  if (d > reach) { const k = reach / d; dz *= k; dy *= k; d = reach; }
  d = Math.max(d, Math.abs(l1 - l2) + 1e-3);
  // Interior angle at the knee, then the flexion away from straight.
  const ck = clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1);
  const flex = Math.PI - Math.acos(ck);
  // Angle of the hip-to-ankle line off straight-down, positive forward.
  const base = Math.atan2(dz, -dy);
  // …and the thigh leads it by the triangle's own offset.
  const ca = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const off = Math.acos(ca);
  return { thigh: -(base + off), knee: flex };
}

/**
 * Poses one bigfoot. Same contract as `GlbRig` and `AnimRig` where it overlaps
 * — `reset` / `update` / `mesh` — so the detector and the encounter above it do
 * not have to know which kind of animal this is.
 *
 * What it does NOT have is a `gaitName` or a LOD, because it has one gait and
 * one mesh. `bigfoot.js` is the only caller and there is never more than one.
 */
export class BigfootRig {
  constructor(proto, material, scale = 1) {
    this.proto = proto;
    const inst = instantiateBigfoot(proto, material);
    this.skin = inst.mesh;
    this.bones = inst.byName;
    this.root = inst.bones[0];
    this._rootY = this.root.position.y;

    // ── the node the world holds him by ──────────────────────────────────────
    // Same shape as `GlbRig`'s, and for the same two reasons. Yaw before tilt
    // (`YXZ`), so he leans along his own heading on a slope rather than around
    // the world axes. And `geometry` hung on a Group that never draws, because
    // `hunt_detect.meshHeight` reads `mesh.geometry.boundingBox` and
    // `mesh.position` to size the silhouette it gates the photograph on — this
    // is the one place the detector and the renderer have to agree, and putting
    // the scale HERE rather than on an inner fit node is what makes them: the
    // detector multiplies the box by `mesh.scale.y`, so a variant scaled on a
    // node it cannot see would be measured at the wrong size.
    this.mesh = new THREE.Group();
    this.mesh.rotation.order = 'YXZ';
    this.mesh.scale.setScalar(scale);
    this.mesh.add(this.skin);
    this.mesh.geometry = proto.geoms[0];
    this.scale = scale;

    this.pitch = 0; this.roll = 0;
    this.phase = 0;
    /** 0..1 — how much of the walk is playing, against the stand. */
    this.moving = 0;
    /** 0..1 — the head coming round over the left shoulder. */
    this.lookBack = 0;
    /** Playback rate. Speed scales with it; the pose never changes. */
    this.rate = 1;
    this._breath = 0;
  }

  /** Metres per second this rig is currently walking at, over the ground. */
  get speed() { return WALK * this.scale * this.rate * this.moving; }
  /** Standing height in world units, crest to ground. */
  get height() { return STAND_H * this.scale; }

  /** Put him down at `pos`, facing `heading`, settled on the ground. */
  reset(pos, heading, world) {
    this.phase = 0; this.moving = 0; this.lookBack = 0; this.rate = 1;
    this.mesh.position.copy(pos);
    this.mesh.rotation.y = heading;
    this.pitch = 0; this.roll = 0;
    if (world) this._tilt(pos, heading, world, 1);
    this.mesh.rotation.x = this.pitch;
    this.mesh.rotation.z = this.roll;
    this._pose();
  }

  /**
   * Sit him on the ground and lean him along it. Lifted from `GlbRig._tilt`
   * with one number changed — the reach is his STRIDE rather than his height,
   * because a 2.2 m sample fan on a 2.2 m creature reads the far side of a
   * gully as the slope he is standing on. He is tall and his feet are close
   * together; the ground he is actually on is a stride wide.
   */
  _tilt(pos, heading, world, k) {
    const fx = Math.sin(heading), fz = Math.cos(heading);
    const reach = GROUND_PER_CYCLE * 0.5 * this.scale;
    const hF = world.getHeight(pos.x + fx * reach, pos.z + fz * reach);
    const hB = world.getHeight(pos.x - fx * reach, pos.z - fz * reach);
    const hL = world.getHeight(pos.x - fz * reach, pos.z + fx * reach);
    const hR = world.getHeight(pos.x + fz * reach, pos.z - fx * reach);
    const wantPitch = clamp(Math.atan2(hB - hF, reach * 2), -0.42, 0.42);
    const wantRoll = clamp(Math.atan2(hR - hL, reach * 2), -0.34, 0.34);
    this.pitch += (wantPitch - this.pitch) * k;
    this.roll += (wantRoll - this.roll) * k;
  }

  /** Move him to `pos`/`heading` and re-settle onto the ground under him. */
  place(pos, heading, world, dt) {
    this.mesh.position.copy(pos);
    this.mesh.rotation.y = heading;
    this._tilt(pos, heading, world, 1 - Math.exp(-6 * dt));
    this.mesh.rotation.x = this.pitch;
    this.mesh.rotation.z = this.roll;
  }

  /**
   * @param {number} dt      seconds
   * @param {number} moving  0..1, blend from the stand to the walk
   * @param {number} lookBack 0..1
   * @returns {number} metres of ground the walk covered this frame
   */
  update(dt, moving, lookBack) {
    this.moving = moving;
    this.lookBack = lookBack;
    this._breath += dt * 0.42;
    const adv = CADENCE * this.rate * this.moving * dt;
    this.phase = (this.phase + adv) % 1;
    this._pose();
    return GROUND_PER_CYCLE * this.scale * adv;
  }

  _pose() {
    const B = this.bones;
    const { l1, l2 } = this.proto.legs;
    const w = this.moving;
    const br = Math.sin(this._breath * Math.PI * 2);

    // ── the legs ──────────────────────────────────────────────────────────────
    // Half a cycle apart, which is what a walk is.
    for (const [tag, off] of [['L', 0], ['R', 0.5]]) {
      const p = (this.phase + off) % 1;
      const [dz, dy, pitch, roll] = anklePath(p);
      // The stand is the same solve at the same crouch with the ankle under the
      // hip, so blending between them cannot pop: it is one continuous pose.
      const sz = lerp(0, dz, w);
      // A hair deeper than mid-stance, so a standing bigfoot is settled on his
      // haunches rather than propped up on two straight legs.
      const sy = lerp(-(STAND_D - 0.02), dy, w);
      const { thigh, knee } = solveLeg(sz, sy, l1, l2);
      B[`hip${tag}`].rotation.x = thigh;
      B[`knee${tag}`].rotation.x = knee;
      // The sole holds the pitch the path asked for, in WORLD terms, so the
      // ankle has to give back everything the two joints above it added.
      // The sole holds the pitch the path asked for, in WORLD terms, so the
      // ankle gives back everything the two joints above it added.
      B[`ankle${tag}`].rotation.x = lerp(0.06, pitch, w) - thigh - knee;
      // The forefoot bends a little of the roll back out, so the foot creases
      // where a foot creases instead of tipping up as one rigid plank. Kept
      // small: the pad is the pivot the whole stance is solved on, and every
      // degree here lifts it off its own solution. At 0.22 the lift is 8 mm at
      // peak toe-off, which the harness sees and a player cannot.
      B[`toe${tag}`].rotation.x = -0.22 * roll * w;
    }

    // ── the body ──────────────────────────────────────────────────────────────
    const ph = this.phase * Math.PI * 2;
    // Two bobs a cycle — once per foot-fall — and it lifts at mid-stance.
    const bob = -LEG.crouch + 0.030 * Math.cos(ph * 2) * w;
    // The weight goes over the stance foot and the whole mass follows it. A
    // 0.14 m track under a 0.86 m shoulder means the roll is most of what
    // reads at range; it is the reason the walk looks like it weighs something.
    const sway = 0.055 * Math.sin(ph) * w;
    this.root.position.y = this._rootY + bob + 0.006 * br;
    this.root.position.x = sway;
    this.root.rotation.z = -0.055 * Math.sin(ph) * w;

    // Shoulders counter-rotate against the hips. Small — a heavy ape does not
    // wind up through the waist the way a runner does — but without any of it
    // the arm swing reads as two pendulums bolted to a wardrobe.
    B.pelvis.rotation.y = -0.075 * Math.sin(ph) * w;
    B.spine.rotation.y = 0.045 * Math.sin(ph) * w;
    B.spine.rotation.x = 0.045 + 0.012 * br;
    B.chest.rotation.y = 0.105 * Math.sin(ph) * w;
    // A permanent forward stoop. The head is carried in FRONT of the shoulders,
    // not on top of them, and that is most of what separates this posture from
    // a person's at any distance where the face is gone.
    B.chest.rotation.x = 0.10;

    // ── the head, and the shot everybody wants ────────────────────────────────
    // The turn is split across three joints rather than yawed at the neck,
    // because 77 degrees on one bone shears the trapezius off the shoulder. In
    // thirds up the chain it reads as the whole animal looking round.
    const lb = this.lookBack;
    B.chest.rotation.y += 0.30 * lb;
    B.neck.rotation.y = 0.52 * lb;
    B.neck.rotation.x = -0.10 - 0.05 * lb + 0.02 * br;
    B.head.rotation.y = 0.42 * lb;
    B.head.rotation.x = 0.06 - 0.10 * lb - 0.028 * Math.cos(ph * 2) * w;

    // ── the arms ──────────────────────────────────────────────────────────────
    // Opposite the leg on the same side, which is the only rule. The amplitude
    // is large because the arm is long: 0.44 rad at a 1.14 m arm swings the
    // hand through 1.0 m of arc, and that arc below the hip is the thing you
    // actually see moving between two trunks.
    for (const [tag, off, s] of [['L', 0.5, 1], ['R', 0, -1]]) {
      const p = (this.phase + off) % 1;
      const sw = Math.sin(p * Math.PI * 2);
      B[`clav${tag}`].rotation.x = -0.05 * sw * w;
      B[`arm${tag}`].rotation.x = -0.44 * sw * w;
      // Held off the ribs by the mass of the lats — a hanging-straight arm
      // reads as a mannequin. Positive z rotation swings the +X arm outward.
      B[`arm${tag}`].rotation.z = s * (0.13 + 0.02 * br);
      // Apes do not straighten the elbow either. A little more flexion on the
      // forward swing, which is where a carried arm bends.
      B[`fore${tag}`].rotation.x = -(0.26 + 0.16 * Math.max(0, sw) * w);
      B[`hand${tag}`].rotation.x = -0.14;
    }
  }

  setShadow(on) { this.skin.castShadow = on; }
  /**
   * Geometry and material belong to the prototype and the caller respectively,
   * so there is nothing here that is this object's to free. The skeleton's
   * Bones are plain Object3Ds and go with the mesh.
   */
  dispose() { this.mesh.parent?.remove(this.mesh); }
}

/**
 * `animal_rig.instantiate`, minus the LOD argument and plus a root that is
 * allowed to move. The stock one is right for every other animal and would be
 * right here too; it is copied rather than called only because the bob and the
 * sway write `bones[0].position`, and the stock path hands back a `bones` array
 * with no promise about which entry that is.
 */
function instantiateBigfoot(proto, material) {
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
