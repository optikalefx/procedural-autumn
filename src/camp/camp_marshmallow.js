// ─────────────────────────────────────────────────────────────────────────────
//  camp_marshmallow — the roasting stick, and the marshmallow on the end of it.
//
//  Two builders, one object. `buildRoastStick` is the prop that leans against
//  the camp table and is the thing the player clicks; `buildHeldStick` is the
//  same switch built for the hand, which the view parents to the camera and
//  spins. They share every millimetre of profile, palette and wear logic below,
//  because the moment the stick you pick up is not the stick you were looking
//  at, the step-in reads as a scene change rather than as picking something up.
//
//  ── what makes this object read, in order of how much it matters ────────────
//
//  1. **The white marshmallow ABOVE the chair backs, at the top of a diagonal.**
//     Round 1 put it at 0.67 m, which is chair-seat height — so the one bright
//     element in the prop landed on the one black element in the camp and both
//     disappeared. The height is not a free parameter and it is not the lean
//     angle either: because the solve holds the shaft's contact at `restH`,
//
//         y_mallow ≈ y0 + (restH − y0) · sMallow / sRest
//
//     — the length and the lean cancel out and `sRest`, the fraction of the
//     stick that is BELOW the edge it leans on, is the only knob. So `sRest` is
//     no longer a constant: `solveRest` inverts that expression against the
//     thing the marshmallow has to clear, which is a camp chair's back at
//     0.848 m (`camp_chair.js`). On a table it lands the marshmallow at 0.93 m
//     — 80 mm proud of the chairs, with sky or open dirt behind it from any eye
//     between seated and standing — and it holds that height across the whole
//     0.425-0.470 m range the table's own randomiser produces. Its floor is
//     where the stick topples off the edge; see `S_REST_MIN`.
//
//  2. **It is a whittled green switch, not a dowel.** Four things carry that and
//     all four are nearly free: a real taper (21 mm across at the butt, 12.8 mm
//     where the bark stops, 4.8 mm at the point), a gentle S in *two* planes plus
//     a droop in the cantilever, two to four knots with the odd cut side-branch
//     nub, and a knife-whittled pale point where the last 155 mm of bark was cut
//     back. A straight constant-radius cylinder is the single loudest tell
//     available on a prop like this — but so is a taper that runs away: round 1
//     went 23 mm to 3.2 mm, a 7:1 whip whose whole cantilevered half was two or
//     three pixels wide at the prop framing and under one at the wide. See the
//     section constants for where the new numbers come from.
//
//  3. **The char.** This is the detail that says the stick has been used, and it
//     is the difference between a prop and a length of hazel. The burn peaks
//     exactly at the whittle shoulder — where the bark ends is where the flame
//     reaches — falls off fast toward the point (which has been re-whittled
//     since, so it is pale again) and trails a long way back down the shaft as
//     soot. Read from the tip inward that is pale / black / brown: three values
//     in the last 250 mm of an object whose other metre is one value, which is
//     also why the tip is where the eye goes second, after the marshmallow.
//
//  4. **The marshmallow is a squat rounded cylinder with FLAT ends.** Not a
//     capsule and not a sphere; both are the classic mistake and both read as
//     candy. But there is a third way to lose it that rounds 1 and 2 both found:
//     dish the ends. A countersunk end turns the silhouette into a doughnut and
//     the object into a small potato, and it is the loudest defect the critic
//     found on the mesh. So: 42 mm across, 26 mm long, a 5 mm edge radius, ends
//     that are flat to within half a millimetre over the outer two thirds of
//     their radius, and 2 mm of pull-in spent entirely on a 4 mm crease where
//     the wood goes through — one end creased a fifth deeper than the other.
//     Plus a 1.6% barrel bulge and a 2% oval so no two silhouettes of it are
//     quite the same. Held, it is a hero object at a tenth of frame height, so
//     it also carries a soft bag-squash over the barrel, with closed-form
//     normals (`mallowGeometry`) rather than displacement the shading is left
//     behind by.
//
//  ── things this file deliberately does not do ───────────────────────────────
//
//  · **No metal, anywhere.** The kit's `alu` / `steel` / `anod` have an
//    `envMapIntensity` and no `envMap`, and nothing in `src/` sets
//    `scene.environment`, so a standard material at 0.9 metalness has almost no
//    diffuse term and nothing to reflect, and renders as flat near-black. The
//    table and telescope authors each measured this and each wrote it up. A
//    roasting stick has no metal on it anyway, so this file pays no price — the
//    note is here so nobody "improves" the char by reaching into that half of
//    the kit.
//
//  · **No contact-shadow patch.** `camp_telescope.js` carries one because the
//    sun's shadow map is 117 mm per texel and cannot resolve a 34 mm tripod leg.
//    The same is true here and more so — but a stick's contact with the ground
//    is a single 30 mm patch under the butt, and this prop does not read by its
//    footprint, it reads by the diagonal. What it does instead is let the butt
//    sit slightly *under* the dirt. `camp_ground.js` lifts the visible ground
//    13 mm plus a berm plus up to 26 mm of hummock over the terrain the layout
//    solver measured, so the bottom 40-60 mm of any prop is inside the dirt
//    whether its author planned it or not — the table author measured its feet
//    buried and the telescope author measured the same. A stick's butt buried in
//    dirt reads as *planted*, which makes this the one prop in the camp for
//    which that band is a gift rather than a bug. The shaft clears it within
//    100 mm of the butt, so nothing else is affected.
//
//  · **No spear TILT on the held stick — the offset does that job alone.** The
//    contract asks the held marshmallow to sit off the twirl axis so the spin is
//    visible, and it is right to. But it asks for offset *and* tilt in one
//    sentence and they cost different things: an offset orbits every texel on
//    the same circle and averages out over a turn, while a tilt makes each texel
//    sweep a cone and keeps a bias no spin rate can remove. Measured, that is
//    0.001 of `evenness` per millimetre of offset against 0.0139 per degree of
//    tilt. So the offset stays where the solve puts it (8.4 mm) and the tilt is
//    spent down to a 2.4-degree budget. The full table and the reasoning are at
//    the held solve in `buildHeldStick`; the leaning prop, which never turns,
//    keeps its full crooked tilt.
//
//  · **No toast material.** `buildHeldStick`'s marshmallow gets a placeholder
//    `MeshStandardMaterial`; `marshmallow_toast.js` replaces it. The UVs handed
//    over are a contract and are specified at `mallowGeometry`.
//
//  Construction follows the camper and the rest of the camp: primitives placed
//  by matrix into a `Parts` bin, merged once. Each variant is TWO draw calls —
//  the shaft (`wood`) and the marshmallow, which is its own mesh both because
//  the held one's material belongs to another author and because a marshmallow
//  is the one object in this camp that should be smooth-shaded rather than
//  faceted. Roughly 1.8 k triangles for the prop and 5.6 k for the held stick,
//  up from 1.2 k and 2.9 k: the prop's went into a shaft you can see, and the
//  held stick's into the one mesh in this game that is held 300 mm from the lens.
//
//  Geometry: metres. `buildRoastStick`'s origin is on the ground directly under
//  the butt, and it leans toward `+Z` rotated by `opts.leanYaw`.
//  `buildHeldStick`'s origin is the grip, the stick runs along `+Z`, `+Y` is up.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { Parts, campMaterials, sanitizeNormals, tintFrom, tintOf } from './camp_materials.js';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils.js';

const TAU = Math.PI * 2;
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

// Base colour of the one shared material this file borrows, needed by
// `tintFrom`. Same duplication `camp_table.js` and `camp_telescope.js` carry and
// for the same reason: a mismatch shows up as a wrong-coloured stick rather than
// as an error, so it is worth being explicit about.
const HEX_WOOD = 0x8a6a46;

// ── the palette ──────────────────────────────────────────────────────────────
//
// BARK. Two species, because a camp that always cuts the same switch reads as a
// camp with one stick in it. Hazel is a warm grey-brown; willow is greener and a
// shade lighter. Both sit well below the kit's `wood` (0x8a6a46, which is sawn
// timber and far warmer than living bark): a switch cut this morning is the
// darkest thin thing in the camp and it needs to be, because its whole job is to
// be the dark half of the contrast the marshmallow is the bright half of.
const BARK_HAZEL = 0x6a5943;
const BARK_WILLOW = 0x6d6a4c;
// Fresh-cut wood under the bark. Nearly bone, faintly green, and deliberately
// NOT white — it sits directly beside the marshmallow and the marshmallow has to
// win that comparison. About 30% under RAW_SUGAR in value, which is the gap that
// lets a 40 mm pale point read as *wood* next to a 42 mm pale marshmallow rather
// than as more of the same object.
const WHITTLED = 0xb9ac86;
// Char. Lifted off true black: burnt wood photographs around 6-8% reflectance
// and authoring it at 2% is what makes a prop look like a hole cut in the frame
// — the same argument `camp_telescope.js` makes about its gloss black.
const CHAR = 0x191413;
// Ash. Grey and faintly cool. Wood ash is one of the very few genuinely neutral
// things in this valley, and the flecks of it are what stop the char band
// reading as paint rather than as burning.
const ASH = 0x8b8781;

// Raw marshmallow sugar.
//
// `docs/ROAST_CONTRACT.md` names 0xe8e0cf and it is not decoration. At dusk the
// fire owns the value range; a white marshmallow is the only object in this game
// that can out-value a flame; and the grade (Khronos PBR Neutral, see
// `src/render/PostFX.js`) starts compressing hard at 0.76, so a marshmallow
// authored at paper white does not arrive brighter — it arrives clipped, with a
// bloom halo and no form left in it.
//
// Round 1 authored the contract's number literally and the frame did not agree.
// Measured off `shots/roast/r1/prop-side.png`, the marshmallow's brightest pixel
// was (194, 123, 86) against open dirt in the same frame at (247, 169, 101) — a
// near-white object reading a quarter DARKER than the ground it stands over,
// which is why it vanished. Two things are wrong there and this fixes one of
// them: the other is that it was sitting in the chairs' shade, and that is what
// `solveRest` is for.
//
// The ceiling was then measured rather than argued about. Authored at pure
// white (0xffffff) and re-captured, the same marshmallow in the same frame goes
// from mean luma 88.5 to 105.9 against ground at 140.3 — i.e. even a perfectly
// white marshmallow reads DARKER than the dirt here. So the value in `prop-side`
// is lighting-bound and not albedo-bound: at hour 16.7 that framing looks at the
// object's shaded hemisphere, and no albedo inside this contract reaches the
// ground's value. Chasing the last few percent of value is the wrong trade.
//
// What the white probe DID show is worth having. At neutral albedo the
// marshmallow rendered (195, 141, 131) where the warm one rendered (196, 123,
// 77) — the same value, but a pink-grey instead of a salmon, and the background
// it has to separate from is yellow foliage at (234, 200, 90). Hue is the axis
// with headroom on it, so 0xf3eee6 takes it: 5% up on the contract's number and
// with the red-blue spread cut from 41 points to 13. That is what "near-white
// matte sugar" is, and it is still a clear step under paper white. The dusk
// measurement is in the build report — the fire still owns the range.
const RAW_SUGAR = 0xf3eee6;
// The toast ramp for `opts.toast` — the *leaning prop's* marshmallow only, which
// is one a used stick is still carrying rather than the mini-game's live
// surface. The live one belongs to `marshmallow_toast.js` and has its own far
// better ramp. Four stops rather than two because caramelisation is not linear:
// cream to gold is slow, gold to mahogany is quick, mahogany to black is quicker
// still, and a single lerp from cream to brown reads as a stain, not as cooking.
const TOAST_STOPS = [RAW_SUGAR, 0xd8ae6c, 0xa2643a, 0x4e2f1b];

const T_WHITTLED = tintFrom(HEX_WOOD, WHITTLED);
const T_CHAR = tintFrom(HEX_WOOD, CHAR);
const T_ASH = tintFrom(HEX_WOOD, ASH);

// ── shape constants ──────────────────────────────────────────────────────────
//
// The marshmallow. The contract fixes `radius ≈ 0.021` and two other authors
// read that number off `userData`, so it is exact here. The half-length is at
// the top of the band the contract's prose allows (26 mm long against 42 mm
// across) for the reason the prose gives — "slightly wider than it is long" —
// and because at 25 mm the barrel between the two 5 mm round-overs is only 15 mm
// tall, which is not enough straight side for the toast gradient to happen on.
const MALLOW_R = 0.021;
const MALLOW_HALF = 0.0130;
const MALLOW_EDGE = 0.0050;
// How wide the pull-in around the shaft is where it pierces an end. A speared
// marshmallow does not just dish — the sugar is dragged in tight against the
// wood for a few millimetres around it, and at the held view's hero scale that
// crease is the single detail that says *pierced* rather than *stuck on*.
//
// It is the Gaussian's sigma below, so it is a RADIUS — and round 2 set it
// against the shaft's DIAMETER ("5.8 is a shade wider than the 4.8-6 mm of
// shaft"), which built the crease at twice the width it was specified at. That
// unit slip is half of why the end face came back as a countersunk crater
// (`docs/ROAST_CRITIC_FINDINGS.md` D3-5); the broad dish is the other half.
//
// Measured off this file's own section rather than estimated: `w` at the two
// cap planes works out independent of the stick's length, so the point is
// 6.0-7.2 mm across where it enters the grip-side cap and 4.8-5.7 mm where it
// leaves the far one — 2.4 to 3.6 mm of RADIUS once the three knife flats are
// counted. 4.2 mm puts the crease's 1/e ring between 0.6 and 1.8 mm clear of
// the wood on every seed, which is what "a shade wider than the shaft" was
// always supposed to mean, and it leaves the rest of the face alone.
const PUCK_R = 0.0042;
// How far the marshmallow's centre sits back from the very tip of the stick.
// Measured over 300 seeds — the tilt and the lateral offset both eat into it —
// the point emerges 5.2 / 6.1 / 7.2 mm past the far face and exits 1.6 / 5.3 /
// 10.7 mm off the marshmallow's own axis, well inside its 21 mm rim. (Round 11
// spent the held stick's tilt budget down to 2.4 degrees and the protrusion band
// tightened from 3.5-8.0 mm with it, which is the same fact seen twice: most of
// that spread was the cone, not the inset.) That is
// exactly how a speared marshmallow looks and gives the toast author a pale
// spike to blister around. Any less and the point disappears at the held view's
// hero scale; any more and the whole thing reads as a skewer. Round 1 ran this
// at 0.019, i.e. a 4 mm median stub, and the point could not be found.
const MALLOW_INSET = 0.021;
// Metres of bark cut back at the business end.
const WHITTLE = 0.155;
// ── where the shaft crosses the edge it leans on ─────────────────────────────
//
// Per note 1 in the header this is the composition number of the whole prop,
// because the marshmallow ends up at `y0 + (restH − y0)·sMallow / sRest` and
// nothing else in the build moves it. So it is solved against the height the
// marshmallow has to reach rather than typed — the same argument `solveLean`
// makes, and for the same reason: the integrator picks the edge, and it is not
// always the table.
//
// MALLOW_Y is what it has to clear. A camp chair's back tops out at 0.848 m
// (`camp_chair.js`, `A.backTop`) and round 1 put the marshmallow at 0.67 — right
// in the middle of the black mass, which is how the one bright element in the
// prop and the one black element in the camp cancelled each other out. 0.93 m is
// 80 mm proud of the chairs, which from any eye between seated and standing puts
// clear sky or clear dirt behind it rather than sling fabric.
//
// S_REST_MIN is physics, not taste. A stick propped butt-on-the-ground against
// an edge stays there only while its centre of mass is BELOW the contact; past
// that it pivots on the edge and goes over. Integrating this file's own section
// (r² from 10.5 mm to 6.4 mm over the barked length, ~210 g of green hazel) puts
// the bare stick's CoM at 0.42 of its length, and the 8 g marshmallow out at
// 0.985 drags it to 0.441. 0.46 is the nearest fraction that is still standing.
//
// S_REST_MAX is only a backstop for an edge taller than anything this camp
// builds; nothing in `camp_site.js` reaches it.
//
// None of these have to land on a sample ring — `pointAt` evaluates the
// centreline in closed form, so `userData.roast.rest` is exact wherever the
// solve puts it. Round 1's 5/8 existed only because the query was quantised.
const MALLOW_Y = 0.93;
const S_REST_MIN = 0.46;
const S_REST_MAX = 0.56;
// The held stick's origin: the point a fist closes on, measured from the butt.
// Named in the contract.
const GRIP = 0.100;
// Lean angles the prop may be built at. The solve is clamped into this band
// rather than allowed to produce whatever `restH` implies.
//
// Both ends moved this round, and both because the contact moved. sinθ =
// (restH − y0)/(L · sRest), so pulling the contact in from 0.625 to about 0.47
// makes every lean a third steeper for the same edge, and the measured band over
// 300 seeds x seven edge heights is now 18.7 to 45.2 degrees. The old [25, 44]
// clamped both ends of that: at the top it left the shaft floating 3 mm off the
// tallest tables, and at the bottom it lifted the butt off the ground on the
// fire-stone fallback that every camp with no table falls back to. These are
// measured limits with a couple of degrees either side, not taste — a stick
// leaning on a 0.22 m cobble IS at 18 degrees, and saying otherwise floats it.
const LEAN_MIN = 0.31;   // 17.8 degrees — under the fire-stone case's 18.7
const LEAN_MAX = 0.86;   // 49.3 degrees — over the tallest table's 45.2

const mix3 = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// ─────────────────────────────────────────────────────────────────────────────
//  The centreline
//
//  Everything on this prop hangs off one polyline, and it is built in a FIXED
//  frame rather than a transported one. That is a decision, not a shortcut: the
//  kit's own `sweptArc()` warns that `TubeGeometry`'s Frenet frames flip on a
//  low-curvature arc and put a visible twist in the middle of a tent pole, and
//  this shaft is exactly that case — 1.25 m long with under 25 mm of total
//  deflection, so its tangent never leaves the baseline direction by more than
//  about two degrees. A fixed frame cannot flip, and at two degrees the
//  cross-section it sweeps is 0.06% out of round, which is four microns.
//
//  The frame also buys something the colour pass needs. Because `lat` and `up`
//  are both perpendicular to `dir`, the axial projection of any point on the
//  centreline is EXACTLY `len * s` — the deflection contributes nothing to it.
//  So a vertex's arc parameter can be recovered from its position with one dot
//  product and no search, which is what makes `shaftTint` possible at all.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param A       the butt, in the space being built
 * @param theta   elevation of the shaft above horizontal; 0 lays it along +Z
 * @param len     shaft length, metres
 * @param samples ring count - 1
 * @param defl    fn(s) -> [lateral, perpendicular-up] deflection, metres
 */
function centreline(A, theta, len, samples, defl) {
  const ct = Math.cos(theta), st = Math.sin(theta);
  const dir = V(0, st, ct);
  // `lat` is horizontal and `up` is the remaining perpendicular. Taken in this
  // order (lat, up, dir) the triple is right-handed — lat × up = dir — which is
  // what the sweep's winding argument below depends on.
  const lat = V(1, 0, 0);
  const up = V(0, ct, -st);
  const P = [];
  for (let i = 0; i <= samples; i++) {
    const s = i / samples;
    const d = defl(s);
    P.push(V(
      A.x + dir.x * len * s + lat.x * d[0] + up.x * d[1],
      A.y + dir.y * len * s + lat.y * d[0] + up.y * d[1],
      A.z + dir.z * len * s + lat.z * d[0] + up.z * d[1],
    ));
  }
  return { A, dir, lat, up, len, P, samples, defl };
}

/**
 * The centreline at an arbitrary `s`, in closed form.
 *
 * Round 1 read the contact point off `P[round(s · samples)]`, which forced
 * the contact fraction to be a value that landed on a ring for both sample
 * counts — and 5/8 was the only one anywhere near where the composition wanted
 * it. That is the tail wagging the dog: the curve is an analytic function of
 * `s`, `solveRest` now returns a different one on every camp, and there is no
 * reason to quantise a query on it. `Camp._seatStick` slides the whole prop
 * until this point sits on the edge it measured, so a 3 mm error here is a 3 mm
 * gap under the shaft, which is the first thing a critic sees.
 */
function pointAt(cl, s) {
  const d = cl.defl(s);
  return V(
    cl.A.x + cl.dir.x * cl.len * s + cl.lat.x * d[0] + cl.up.x * d[1],
    cl.A.y + cl.dir.y * cl.len * s + cl.lat.y * d[0] + cl.up.y * d[1],
    cl.A.z + cl.dir.z * cl.len * s + cl.lat.z * d[0] + cl.up.z * d[1],
  );
}

/**
 * The fraction of the shaft that sits below the edge it leans on.
 *
 * Solved so the marshmallow lands at `MALLOW_Y` on any edge tall enough to put
 * it there, and at the topple limit on any edge that is not. On the table — the
 * case `camp_site.js` prefers and takes on most camps — that is 0.469 at a
 * 0.447 m top, and it self-corrects across the whole 0.425-0.470 m the table's
 * own randomiser produces, which a typed constant cannot: at a fixed 0.47 the
 * tallest tables pushed the lean past its clamp and left the shaft 3 mm off the
 * edge it was supposed to be resting on.
 *
 * @param restH the height of the edge, metres
 * @param y0    the height of the butt, metres
 * @param sM    where the marshmallow sits along the shaft, 0..1
 */
function solveRest(restH, y0, sM) {
  const rise = Math.max(1e-4, restH - y0);
  return clamp(rise * sM / (MALLOW_Y - y0), S_REST_MIN, S_REST_MAX);
}

/**
 * The elevation at which the shaft's height at `sRest` is exactly `restH`.
 *
 * Closed form rather than a search, because the height along the shaft is
 *
 *     y(s) = y0 + len·s·sinθ + defl_up(s)·cosθ
 *
 * — the deflection enters through `up`, whose y component is cosθ — and
 * `a·sinθ + b·cosθ = c` is a phase-shifted sine, so θ = asin(c/R) − atan2(b, a).
 * Solving it rather than dialling it in is what keeps the lean correct when the
 * integrator hands over a table that is not 0.42 m tall, or when the length
 * randomiser moves `len`.
 */
function solveLean(len, sRest, y0, restH, defl) {
  const a = len * sRest;
  const b = defl(sRest)[1];
  const c = restH - y0;
  const R = Math.hypot(a, b) || 1e-6;
  return clamp(Math.asin(clamp(c / R, -1, 1)) - Math.atan2(b, a), LEAN_MIN, LEAN_MAX);
}

// ─────────────────────────────────────────────────────────────────────────────
//  The sweep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sweep a closed polygon of `sides` along the centreline, capped at both ends.
 *
 * Winding, spelled out because three authors on this project have shipped
 * geometry whose winding disagreed with its normals and `tools/winding.mjs`
 * exists because of it. Ring vertices run anticlockwise about `dir` in the
 * (lat, up) plane. For a quad a = (i, j), b = (i, j+1), c = (i+1, j+1),
 * d = (i+1, j), the edge a→b runs along +θ (which at θ = 0 is `up`) and a→d runs
 * along +s (`dir`), so the geometric normal of triangle (a, b, c) is
 * cross(b−a, c−a) = cross(up, dir) = lat — the outward radial at θ = 0. Both
 * triangles of the quad therefore face out. The end caps reverse for the start
 * ring and keep the order for the end ring, for the same reason.
 *
 * @param radiusFn fn(s, angle) -> metres
 */
function sweepShaft(cl, radiusFn, sides) {
  const { P, lat, up, samples } = cl;
  const N = samples + 1;
  const ring = new Array(N * sides);
  for (let i = 0; i < N; i++) {
    const s = i / samples;
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * TAU;
      const r = radiusFn(s, a);
      const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
      ring[i * sides + j] = V(
        P[i].x + lat.x * ca + up.x * sa,
        P[i].y + lat.y * ca + up.y * sa,
        P[i].z + lat.z * ca + up.z * sa,
      );
    }
  }

  const tris = samples * sides * 2 + sides * 2;
  const pos = new Float32Array(tris * 9);
  let o = 0;
  const put = (v) => { pos[o++] = v.x; pos[o++] = v.y; pos[o++] = v.z; };
  const tri = (a, b, c) => { put(a); put(b); put(c); };

  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < sides; j++) {
      const j1 = (j + 1) % sides;
      const a = ring[i * sides + j];
      const b = ring[i * sides + j1];
      const c = ring[(i + 1) * sides + j1];
      const d = ring[(i + 1) * sides + j];
      tri(a, b, c);
      tri(a, c, d);
    }
  }
  // Caps. The butt's is a cut end — pale, and visible where the stick lies in
  // the dirt. The tip's is 1.6 mm across and exists so the point is closed
  // rather than a hole the camera can see down at 0.6 m.
  for (let j = 0; j < sides; j++) {
    const j1 = (j + 1) % sides;
    tri(P[0], ring[j1], ring[j]);
    tri(P[samples], ring[samples * sides + j], ring[samples * sides + j1]);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  sanitizeNormals(g);
  return g;
}

/**
 * Turn a colour function of (s, angle, height) into a `Parts.add` tint callback.
 *
 * `Parts.add` hands the tint callback nothing but a position, which is the right
 * API for a prop made of boxes and the wrong one for a bent stick whose whole
 * colour story runs along its length and around its circumference. Recovering
 * (s, angle) from a position is exact rather than approximate here — see the
 * note at `centreline` for why the axial projection carries no deflection error
 * — and costs one dot product, one array lookup and one atan2 per vertex, on a
 * few hundred vertices, once, at build time.
 */
function shaftTint(cl, colourAt) {
  const { A, dir, lat, up, len, P, samples } = cl;
  return (x, y, z) => {
    const px = x - A.x, py = y - A.y, pz = z - A.z;
    const s = clamp01((px * dir.x + py * dir.y + pz * dir.z) / len);
    const c = P[Math.round(s * samples)];
    const qx = x - c.x, qy = y - c.y, qz = z - c.z;
    const a = Math.atan2(
      qx * up.x + qy * up.y + qz * up.z,
      qx * lat.x + qy * lat.y + qz * lat.z,
    );
    return colourAt(s, a, y);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  The switch itself — one seeded description of a stick, shared by both
//  builders so the prop and the thing in your hand are the same object.
// ─────────────────────────────────────────────────────────────────────────────

// ── the section, re-derived ──────────────────────────────────────────────────
//
// Round 1's shaft read as a wire, a scratch on the lens, an antenna. These are
// RADII, so double them for the number you would measure with a caliper.
//
// The pixel budget the section has to survive, taken off `tools/roastshot.mjs`'s
// own framings and a 1600 x 900 capture:
//
//   prop-side/fq/back   dist 1.65 m, fov 34 vertical  →  0.85 px per mm
//   prop-wide           dist 7.40 m, fov 46 vertical  →  0.14 px per mm
//
// The wide is the binding one and it is unforgiving: nothing on this prop is
// more than a couple of pixels wide there, so the question is only whether the
// shaft is a solid line or a dashed one that the resolve flickers away. Two
// pixels is solid. One is not — and one pixel is what round 1's cantilevered
// half measured, which is why `prop-wide` had nothing findable in it.
//
// Read as diameters, the critic's band is 14-18 mm at the butt, 8-10 through the
// middle and 3-4 at the point. Their ratio is the correction and it is right:
// 4.6 : 2.6 : 1 against round 1's 7.2 : 2.5 : 1, i.e. the butt was not too thin,
// the far half was. The absolute scale below is set from the pixel budget rather
// than from the middle of their band, and comes out one notch over it.
//
//   butt      21.0 mm across   17.9 px / 3.0 px    hazel a hand closes on
//   mid-shaft 15.2 mm          12.9 px / 2.2 px    solved by TAPER_P, below
//   shoulder  12.8 mm          10.9 px / 1.8 px    where the bark stops
//   point      4.8 mm           4.1 px / 0.7 px    the whittled spike
//
// Ratio 4.4 : 2.7 : 1. The butt comes DOWN 2 mm from round 1 — the whip was the
// defect, not the grip — and the far end goes up 60%, which is the whole fix.
const R_BUTT = 0.0105;      // a switch you can lean on without it bowing
const R_SHOULDER = 0.0064;  // where the bark stops
const R_POINT = 0.0024;     // the point. Blunter than a real one on purpose: a
                            // needle tip is a sub-pixel line that crawls, and
                            // this one is a disc the held view sees at 0.3 m.
// Taper exponent. Green wood tapers slowly near the butt and fast near the tip;
// 1.0 is a machined cone and round 1's 1.55 held the butt's section far too long
// and then fell off a cliff. 1.20 puts the mid-shaft at 15.2 mm across, which is
// the number in the table above.
const TAPER_P = 1.20;

function switchSpec(rnd, len, wear, { dustTop = 0, dustAmt = 0, droop = 0.010 }) {
  const willow = rnd() < 0.42;
  const bark = tintFrom(HEX_WOOD, willow ? BARK_WILLOW : BARK_HAZEL);

  const sWhit = 1 - WHITTLE / len;
  // The burn peaks where the bark ends, because that is where the flame reaches
  // — jittered a little so it is not suspiciously exactly the shoulder.
  const sChar = sWhit + (rnd() - 0.5) * 0.014;
  const charPeak = 0.56 + 0.40 * wear;
  // Asymmetric on purpose. Soot trails a long way back down a shaft that has
  // been held over a fire; the last hundred millimetres have been re-whittled
  // since and are nearly clean. A symmetric blob reads as a painted band.
  const charAt = (s) => {
    const d = s - sChar;
    const t = d / (d < 0 ? 0.062 : 0.028);
    return charPeak * Math.exp(-0.5 * t * t);
  };

  // ── the S, in two planes ─────────────────────────────────────────────────
  // A first harmonic (one bow, zero at both ends) plus a second (which turns
  // the bow into an S), in the lateral plane and in the vertical one, with
  // different phases so the two do not read as one bend seen twice. Amplitudes
  // are small — 25 mm of total deflection over 1.25 m — because a switch that
  // visibly snakes reads as a rubber hose. The point is not that the player sees
  // the curve; it is that they never see a straight line.
  const aL1 = (rnd() < 0.5 ? -1 : 1) * (0.011 + rnd() * 0.012);
  const aL2 = (rnd() < 0.5 ? -1 : 1) * (0.005 + rnd() * 0.007);
  const aU1 = -(0.005 + rnd() * 0.009);
  const aU2 = (rnd() - 0.5) * 0.011;
  const phL = rnd() * TAU, phU = rnd() * TAU;
  // Both harmonics are offset so `defl(0)` is exactly zero: the prop contract
  // puts the origin directly under the butt, and a second harmonic with a phase
  // on it would otherwise slide the butt a centimetre off its own origin.
  const sL = Math.sin(phL), sU = Math.sin(phU);
  const defl = (s) => [
    aL1 * Math.sin(Math.PI * s) + aL2 * (Math.sin(TAU * s + phL) - sL),
    aU1 * Math.sin(Math.PI * s) + aU2 * (Math.sin(TAU * s + phU) - sU)
      // The droop. Green wood with 8 g of marshmallow on the end of a half-metre
      // cantilever sags, and the sag is the one part of the curve a player
      // registers consciously — it is also what stops the cantilevered end
      // reading as a ruler balanced on a table edge.
      - droop * Math.pow(smoothstep(0.50, 1.0, s), 2),
  ];

  // ── knots ────────────────────────────────────────────────────────────────
  // Two to four, never in the whittled zone (a knife takes them off), each a
  // Gaussian swelling that is deliberately lopsided — a knot is a stub of
  // branch, so it bulges on one side and barely at all on the other.
  const knots = [];
  const nk = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < nk; i++) {
    knots.push({
      s: 0.08 + rnd() * (sWhit - 0.14),
      w: 0.011 + rnd() * 0.011,
      // Up a third on round 1, in step with the section: a knot is a proportion
      // of the rod it grew out of, and 0.8 mm on a 12.8 mm shoulder is a bump
      // you cannot see in a silhouette that is eleven pixels wide.
      h: 0.0011 + rnd() * 0.0015,
      a: rnd() * TAU,
      lean: 0.50 + rnd() * 0.35,          // radians off the perpendicular
      len: 0.013 + rnd() * 0.011,
    });
  }
  // One cut side-branch, on about half of them. It is 15 mm of geometry and it
  // is the single cheapest thing in this file that says "somebody cut this out
  // of a hedge" rather than "this came off a shelf".
  const nubs = rnd() < 0.55 ? [knots[Math.floor(rnd() * knots.length)]] : [];

  const facetPh = rnd() * TAU;
  const wob0 = rnd() * TAU, wob1 = rnd() * TAU;

  const radius = (s, a) => {
    let r;
    if (s <= sWhit) {
      r = lerp(R_BUTT, R_SHOULDER, Math.pow(clamp01(s / sWhit), TAPER_P));
      // Bark is not round. Two low-amplitude terms, one around and one along.
      r *= 1 + 0.030 * Math.sin(a * 2.0 + s * 37 + wob0)
             + 0.017 * Math.sin(s * 97 + wob1);
    } else {
      const w = (s - sWhit) / (1 - sWhit);
      // A 0.5 mm step where the bark was cut away. Small, and it is what makes
      // the pale section read as *peeled* rather than as painted.
      r = lerp(R_SHOULDER - 0.0005, R_POINT, Math.pow(w, 1.25));
      // Three knife flats. A whittled point is faceted, not turned, and three
      // strokes is what one actually looks like.
      r *= 1 + 0.085 * Math.cos(a * 3 + facetPh) * smoothstep(0.0, 0.22, w);
    }
    for (const k of knots) {
      const d = (s - k.s) / k.w;
      r += k.h * Math.exp(-d * d) * (1 + 0.45 * Math.cos(a - k.a));
    }
    // Burnt wood loses volume. 6% is invisible as a measurement and visible as a
    // waist in the silhouette exactly where the black band is.
    r *= 1 - 0.06 * charAt(s);
    return Math.max(0.0009, r);
  };

  const p0 = rnd() * TAU, p1 = rnd() * TAU, p2 = rnd() * TAU;
  const p3 = rnd() * TAU, p4 = rnd() * TAU, p5 = rnd() * TAU;
  const mottle = 0.09 + 0.07 * wear;
  // Dust lightens and warms; it never just darkens. Same model as the kit's
  // `dusted()`, applied as a multiplier because these tints are large
  // `tintFrom` ratios and lerping one of those toward a dust colour deletes it
  // rather than dusting it — the lesson `camp_table.js` wrote up as `dustMul`.
  const DUST = [1.22, 1.12, 0.92];

  const colour = (s, a, y) => {
    const w = smoothstep(sWhit - 0.006, sWhit + 0.010, s);
    const m = 1 + mottle * (
      Math.sin(s * 61 + a * 2.1 + p0) * 0.50 +
      Math.sin(s * 27 - a * 3.3 + p1) * 0.32 +
      Math.sin(s * 149 + p2) * 0.18);
    // Lenticels: the pale horizontal dashes down hazel bark. Raised to a power
    // so they read as flecks rather than as stripes, and wandering around the
    // stick so they do not line up into rings.
    const l = Math.pow(Math.max(0, Math.sin(s * 168 + Math.sin(a * 2 + p3) * 2.2)), 8) * 0.5;
    let c = mix3(
      [bark[0] * m + l * 0.30, bark[1] * m + l * 0.28, bark[2] * m + l * 0.20],
      T_WHITTLED, w);
    // Char, broken up around the circumference — fire does not paint an even
    // band, it licks one side.
    const ch = clamp01(charAt(s) * (0.72 + 0.40 * Math.sin(a * 2.0 + s * 11 + p4)));
    c = mix3(c, T_CHAR, ch);
    // Ash, only in the deepest char.
    const ashK = clamp01((ch - 0.55) * 2.2)
      * Math.max(0, Math.sin(s * 331 + a * 5.0 + p5)) * 0.30;
    c = mix3(c, T_ASH, ashK);
    if (dustAmt > 0) {
      const k = smoothstep(dustTop, 0.0, y) * dustAmt;
      c = [c[0] * lerp(1, DUST[0], k), c[1] * lerp(1, DUST[1], k), c[2] * lerp(1, DUST[2], k)];
    }
    return c;
  };

  return { defl, radius, colour, charAt, knots, nubs, sWhit, sChar, bark };
}

/** A cut side-branch stub at a knot: five sides, 15 mm, leaning toward the tip. */
function addNub(P, cl, k, spec) {
  const i = clamp(Math.round(k.s * cl.samples), 1, cl.samples - 1);
  const c = cl.P[i];
  const T = new THREE.Vector3().subVectors(cl.P[i + 1], cl.P[i - 1]).normalize();
  const out = cl.lat.clone().multiplyScalar(Math.cos(k.a)).addScaledVector(cl.up, Math.sin(k.a));
  // Every branch on a switch leans toward the tip, because that is the direction
  // it grew. A stub sticking out square is the one that looks modelled.
  const d = out.multiplyScalar(Math.cos(k.lean)).addScaledVector(T, Math.sin(k.lean)).normalize();
  const rs = spec.radius(k.s, k.a);
  const base = c.clone().addScaledVector(d, rs * 0.5);
  const geo = new THREE.CylinderGeometry(rs * 0.20, rs * 0.62, k.len, 5, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d);
  const m = new THREE.Matrix4().compose(base.addScaledVector(d, k.len * 0.5), q, V(1, 1, 1));
  P.add(geo, 'wood', m, shaftTint(cl, spec.colour));
}

// ─────────────────────────────────────────────────────────────────────────────
//  The marshmallow
//
//  ── the UV contract, which another author's shader depends on ──────────────
//
//  `u = angle / TAU` about the marshmallow's own axis, measured from its local
//  +X. The seam ring at u = 0/1 is DUPLICATED (`cols = rings + 1`), so the
//  wrapped texture does not smear a whole ring's worth of the map across one
//  quad — which is the one failure in this parameterisation that looks like a
//  shader bug and is not.
//
//  `v = 0` at the end nearest the grip, `v = 1` at the far end, linear along the
//  axis. Precisely: `v = clamp01((z + zBar) / (2·zBar))` where `zBar = half −
//  edge` is the half-extent of the STRAIGHT barrel. So v runs 0 → 1 across the
//  barrel at a constant rate, and both rounded ends — the round-over and the
//  flat cap together — continue past 0 and 1 at that same rate and are clamped,
//  which collapses each of them to a single v. That is what the contract means
//  by "the caps read as the poles of the map": every texel row of the toast map
//  that is not on the barrel is a pole, exactly as on a sphere.
//
//  Round 3 note for the toast author: the parameterisation is UNCHANGED, but
//  this round it is finally true. Round 2's caps were dished 5.4 mm on a 8 mm
//  `zBar`, so the two innermost rows of each cap fell back INSIDE the barrel's
//  v range and sampled v ≈ 0.025 / 0.975 instead of clamping. Flattening the
//  end face puts every cap vertex past `zBar` again, so both poles are now
//  exact. The affected rows were inside r = 1.2 mm, which is inside the wood, so
//  nothing that was ever on screen moves — but the map does now see a clean pole.
//
//  Local axis is +Z, so the mesh's own transform is what carries the offset and
//  the tilt off the stick. That is deliberate and it matters twice: the view
//  spins the stick about +Z and a marshmallow whose offset was baked into its
//  vertices would spin about its own centre instead of orbiting; and
//  `marshmallowMaterial`'s `uFireDir` is specified in the mallow's LOCAL space,
//  which only exists if the mallow has a local space of its own.
// ─────────────────────────────────────────────────────────────────────────────

// ── the two things an end face is, in one place ──────────────────────────────
//
// Shared by the lathe below and by `mallowColourFn`'s hand-baked occlusion, so
// that the shading and the shape cannot drift apart — which is exactly how the
// crater got twice as loud as the geometry: a 3 mm dish darkened by a SEPARATE
// 14% ramp over a SEPARATE radius, neither of them the other's.
//
// `capDish` is the mould concavity a marshmallow has anyway, spread over the
// whole face and worth well under a millimetre; `capPucker` is the crease the
// shaft drags in and is the only steep thing on a cap. `t` is radius / rim
// radius; `r` is metres. `spread` widens the pucker for the occlusion term,
// because a crease shades a little further out than it is deep.
//
// The dish is a SQUARED paraboloid and that is the point of it. A plain
// (1 − t²) meets the round-over at its steepest — round 2's met it at 20
// degrees off flat — and that junction is precisely where the critic measured
// the 12% value trough that turns the object into a bagel, because a cap that
// arrives at the rim tilted draws a dark ring around itself. Squared, the
// profile is tangent to flat at BOTH ends: zero slope on the axis, zero slope
// where it meets the arc, and never more than 2.5 degrees off flat in between.
const capDish = (t) => (1 - t * t) * (1 - t * t);
const capPucker = (r, spread = 1) => Math.exp(-(r * r) / (PUCK_R * PUCK_R * spread));

/**
 * @param colour fn(localPos, localNormal, u, v) -> [r, g, b] vertex tint
 */
function mallowGeometry({
  rings = 24, bands = 18,
  R = MALLOW_R, half = MALLOW_HALF, edge = MALLOW_EDGE,
  dentA = 0.00045, dentB = 0.00030,
  puckA = 0.0019, puckB = 0.0014,
  bulge = 0.016, oval = 0.020, ovalPhase = 0,
  dents = 0, dentPhase = 0,
  colour = null,
}) {
  // Band allocation. Deliberately not even: the round-overs and the creases
  // hold all of the curvature across a third of the length, so they take three
  // quarters of the bands. An evenly divided profile spends its budget on the
  // straight barrel, where three rings would do, and then facets the two things
  // the eye actually checks — the rim, which is the whole read of a squat
  // cylinder, and the pucker, which is now a 4 mm feature inside a 16 mm cap.
  const nA = Math.max(3, Math.round(bands * 0.20));
  const nRA = Math.max(2, Math.round(bands * 0.17));
  const nRB = nRA, nB = nA;
  const nBar = Math.max(2, bands - nA - nRA - nRB - nB);
  // Cap rows are spaced in r^CAP_BIAS, i.e. crowded toward the axis, which is
  // where the pucker is. Up from 1.35 because the cap is no longer a bowl: with
  // the broad dish taken down to 0.45 mm everything that curves is inside a
  // 4.2 mm radius and everything outside it is flat, and a flat wants two rows,
  // not four. At 1.60 the held stick's seven cap rows land at 0.7, 2.2, 4.1,
  // 6.5, 9.3 and 12.5 mm — four of them inside the crease, where round 2 put
  // two, and the rest spread over a face that has nothing on it.
  const CAP_BIAS = 1.60;

  const rimR = R - edge;
  const zBar = half - edge;
  const pr = [], pz = [];
  const push = (r, z) => { pr.push(r); pz.push(z); };

  /**
   * How far into the body an end face is pulled at radius `rimR·t`.
   *
   * Two superposed terms, and they are different things — see `capDish` and
   * `capPucker`. What matters is the RATIO between them, and rounds 1 and 2
   * both had it upside down.
   *
   * Round 1 had only the paraboloid, so the stick entered a smooth bowl with no
   * crease and read as pushed against the end rather than through it. Round 2
   * added the crease but left the bowl at 3 mm on a 13 mm half-length and set
   * the crease's sigma from a diameter, so the two together pulled the centre
   * of the face in 5.4 mm — a fifth of the whole body — with no flat anywhere
   * on it: measured off the shipped mesh, the pull-in was still 1.1 mm at
   * r = 13 mm, which is 81% of the way to the rim. That is a countersink, and
   * an object with a countersunk end is a doughnut, not a cylinder of sugar.
   *
   * A real marshmallow's end is essentially flat. So the dish is now 0.45 mm
   * over the whole 16 mm face, in the tangent-flat profile `capDish` describes
   * — under 2.5 degrees off flat anywhere, which is below what the eye reads as
   * a hollow and is the whisper of concavity a moulded end actually has — and
   * the 2 mm of pull-in the contract asks for is spent entirely on the crease,
   * where the wood is. Total centre drop 2.4 mm against round 2's 5.4, and the
   * outer two thirds of the radius are flat to within a fifth of a millimetre.
   */
  const capDrop = (t, dish, pucker) =>
    dish * capDish(t) + pucker * capPucker(rimR * t);

  // Grip cap, centre outward. Real marshmallows dent at both ends and never
  // equally, so the two differ by half again; it is a third of a millimetre of
  // dish and a fifth of the crease, and it is what stops the thing reading as a
  // lathe-turned bead now that neither end is a bowl.
  for (let i = 0; i <= nA; i++) {
    const t = Math.pow(i / nA, CAP_BIAS);
    push(rimR * t, -half + capDrop(t, dentA, puckA));
  }
  // Grip round-over: a quarter arc of radius `edge`, centre (rimR, -half+edge).
  for (let i = 1; i <= nRA; i++) {
    const psi = -Math.PI / 2 + (i / nRA) * (Math.PI / 2);
    push(rimR + edge * Math.cos(psi), -half + edge + edge * Math.sin(psi));
  }
  // The barrel, with a 1.6% bulge at the waist. A marshmallow is extruded and
  // then settles; its sides are very slightly convex, and a dead-straight side
  // beside a 5 mm round-over reads as a machined part.
  for (let i = 1; i <= nBar; i++) {
    const z = -zBar + 2 * zBar * (i / nBar);
    const k = z / zBar;
    push(R * (1 + bulge * (1 - k * k)), z);
  }
  // Far round-over.
  for (let i = 1; i <= nRB; i++) {
    const psi = (i / nRB) * (Math.PI / 2);
    push(rimR + edge * Math.cos(psi), half - edge + edge * Math.sin(psi));
  }
  // Far cap, rim inward. Same rows as the grip cap, walked backwards, so the
  // two ends are sampled identically and the profile normals difference cleanly
  // across the join.
  for (let i = nB - 1; i >= 0; i--) {
    const t = Math.pow(i / nB, CAP_BIAS);
    push(rimR * t, half - capDrop(t, dentB, puckB));
  }

  const rows = pr.length;
  // Profile normals by central difference. For a surface of revolution swept
  // with t increasing along the profile, the outward normal is (z', −r') in
  // (radial, axial) — which is the same expression on the barrel, on the arcs
  // and inside the creases, where the normal correctly turns to face down AND
  // inward, the way the punt of a bottle does. Differencing rather than
  // deriving it per segment is what keeps the joins seamless.
  const nr = new Float32Array(rows), nz = new Float32Array(rows);
  for (let i = 0; i < rows; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(rows - 1, i + 1);
    const dr = pr[i1] - pr[i0], dz = pz[i1] - pz[i0];
    const L = Math.hypot(dr, dz) || 1;
    nr[i] = dz / L; nz[i] = -dr / L;
  }
  // On the axis the radial direction is undefined, so force the poles to face
  // straight out. Left alone they fan a whole ring of slightly different
  // normals through one point, which shows up as a dark speck.
  nr[0] = 0; nz[0] = -1;
  nr[rows - 1] = 0; nz[rows - 1] = 1;

  // ── the out-of-the-bag squash, and why it comes with derivatives ──────────
  //
  // A marshmallow has been in a bag under other marshmallows and it is not a
  // solid of revolution. Two low-order terms around and along, ±2% of radius, at
  // a wavelength of most of the body — soft dents, not noise: legible noise on a
  // white object reads as a pebble.
  //
  // The catch is that a displacement without a matching normal is worse than no
  // displacement. Round 1 already ducked this once, leaving the 2% oval out of
  // the normals and writing down that the error was a fifth of a degree — true
  // at that amplitude and that frequency, and false the moment the held view is
  // brought to hero scale and this term is added on top. So `eps` carries both
  // partials in closed form, which is nine multiplies a vertex at build time and
  // exact shading forever after. The oval joins them, for the same reason.
  //
  // Frequency is deliberately low along the axis (a half-wave over the body) so
  // that ∂ε/∂z stays under 3 degrees of normal tilt. Crank it and the dents
  // start reading as a shading artefact instead of as a squashed sweet.
  const kz = Math.PI / (2 * half);
  const eA = 0.62, eB = 0.38;
  const eps = (th, z) => dents * (
    eA * Math.cos(2 * th + dentPhase) * Math.sin(kz * z + dentPhase * 0.7) +
    eB * Math.cos(3 * th - dentPhase * 1.4) * Math.sin(0.7 * kz * z - dentPhase));
  const epsTh = (th, z) => dents * (
    -2 * eA * Math.sin(2 * th + dentPhase) * Math.sin(kz * z + dentPhase * 0.7) +
    -3 * eB * Math.sin(3 * th - dentPhase * 1.4) * Math.sin(0.7 * kz * z - dentPhase));
  const epsZ = (th, z) => dents * kz * (
    eA * Math.cos(2 * th + dentPhase) * Math.cos(kz * z + dentPhase * 0.7) +
    0.7 * eB * Math.cos(3 * th - dentPhase * 1.4) * Math.cos(0.7 * kz * z - dentPhase));

  const cols = rings + 1;               // +1: the duplicated u seam
  const pos = new Float32Array(rows * cols * 3);
  const nrm = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  const col = colour ? new Float32Array(rows * cols * 3) : null;
  const tp = new THREE.Vector3(), tn = new THREE.Vector3();

  for (let i = 0; i < rows; i++) {
    const v = clamp01((pz[i] + zBar) / (2 * zBar));
    // Both perturbations are graphs over (θ, z), which the caps are not — at a
    // pole the whole ring is one point and a radial wobble tears it. `nr` is
    // already 1 on the barrel and 0 at the poles, so it is exactly the weight
    // that wants applying, and no extra term has to be invented for it.
    const wD = Math.max(0, nr[i]);
    for (let j = 0; j < cols; j++) {
      const u = j / rings;
      const th = u * TAU;
      const ct = Math.cos(th), st = Math.sin(th);
      // The oval. Two percent is under half a millimetre, and it is here for one
      // reason: the view spins this thing, and a perfectly circular marshmallow
      // spinning is indistinguishable from a still one.
      const e = wD * (oval * Math.cos(2 * (th + ovalPhase)) + eps(th, pz[i]));
      const r = pr[i] * (1 + e);
      // For r(θ,z) = r0(z)·(1 + ε), the normal picks up −(1/r)·∂r/∂θ along ê_θ
      // and −r0·∂ε/∂z along ê_z, on top of the profile's own (nr, nz). The r0'
      // part of ∂r/∂z is already inside (nr, nz), so only the ε half is added.
      const dTh = wD * (-2 * oval * Math.sin(2 * (th + ovalPhase)) + epsTh(th, pz[i]));
      const dZ = wD * epsZ(th, pz[i]);
      const cr = nr[i];
      const cth = -dTh;
      const cz = nz[i] - pr[i] * dZ * nr[i];
      const inv = 1 / (Math.hypot(cr, cth, cz) || 1);
      const o = (i * cols + j) * 3;
      pos[o] = r * ct; pos[o + 1] = r * st; pos[o + 2] = pz[i];
      // ê_r = (cos, sin, 0), ê_θ = (−sin, cos, 0), ê_z = (0, 0, 1).
      nrm[o] = (cr * ct - cth * st) * inv;
      nrm[o + 1] = (cr * st + cth * ct) * inv;
      nrm[o + 2] = cz * inv;
      uvs[(i * cols + j) * 2] = u;
      uvs[(i * cols + j) * 2 + 1] = v;
      if (col) {
        tp.set(pos[o], pos[o + 1], pos[o + 2]);
        tn.set(nrm[o], nrm[o + 1], nrm[o + 2]);
        const c = colour(tp, tn, u, v);
        col[o] = c[0]; col[o + 1] = c[1]; col[o + 2] = c[2];
      }
    }
  }

  // Indexed, unlike everything else in this camp, because this is the one prop
  // whose normals must NOT be recomputed per triangle — `Parts` deliberately
  // refacets everything it merges, which is right for a slat and a tube and
  // wrong for a marshmallow. Winding matches `sweepShaft`: +u then +v, so
  // cross(b−a, c−a) comes out as (S_θ × S_t), which is the outward normal above.
  const idx = [];
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < rings; j++) {
      const a = i * cols + j, b = a + 1;
      const c = (i + 1) * cols + j + 1, d = c - 1;
      // At a pole one edge of the quad collapses; emitting the degenerate
      // triangle anyway is how a zero-area face with a NaN normal gets into a
      // bloom mip chain (see `sanitizeNormals`).
      if (pr[i] <= 1e-9) idx.push(a, c, d);
      else if (pr[i + 1] <= 1e-9) idx.push(a, b, c);
      else idx.push(a, b, c, a, c, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  sanitizeNormals(g);
  return g;
}

/** Sample the four-stop toast ramp as linear vertex-colour multipliers. */
const TOAST_LIN = TOAST_STOPS.map(tintOf);
function toastRamp(k) {
  const t = clamp01(k) * (TOAST_LIN.length - 1);
  const i = Math.min(TOAST_LIN.length - 2, Math.floor(t));
  return mix3(TOAST_LIN[i], TOAST_LIN[i + 1], t - i);
}

/**
 * The marshmallow's vertex colour: sugar, the dusting, the dents, and — on the
 * leaning prop only — however toasted `opts.toast` says this one already is.
 *
 * There is no ambient-occlusion pass anywhere in this game, so the crease is
 * darkened by hand. That is the same trick the cooler and the telescope's feet
 * use, and here it has to be spent where the concavity actually is.
 *
 * ── who ever sees this ─────────────────────────────────────────────────────
 * As of this round, ONLY THE LEANING PROP. `marshmallow_toast.js`'s
 * `marshmallowMaterial` is a `MeshStandardMaterial` that does not set
 * `vertexColors`, so on the held marshmallow this whole function is computed at
 * build time and then dropped on the floor — the toast author writes
 * `diffuseColor` outright. Which is right, and it is worth writing down twice:
 * every number below is tuned for a 28-pixel blob at the top of a diagonal in
 * daylight, and NOT for the hero object. If that material ever turns vertex
 * colours on, these amplitudes are the first thing to re-measure.
 */
function mallowColourFn({ toast = 0, half = MALLOW_HALF, R = MALLOW_R, phase = 0 }) {
  // The side that hung toward the flame. Down and a little forward, because a
  // stick lies across the fire rather than pointing into it.
  const fire = V(0, -1, 0.22).normalize();
  return (p, n) => {
    const k = toast <= 0 ? 0
      : clamp01(toast * (0.40 + 0.80 * Math.max(0, n.dot(fire))));
    const base = toastRamp(k);
    // Icing sugar / cornstarch. "Barely visible" is the brief and it is the
    // right call: a marshmallow with legible noise on it reads as a pebble. This
    // is ±3% at a frequency fine enough that at any distance past a metre it is
    // simply a very slightly uneven matte, which is exactly what the dusting
    // does in life.
    const g = 1 + 0.022 * (
      Math.sin(p.x * 430 + p.y * 310 + phase) * 0.50 +
      Math.sin(p.z * 520 + p.x * 270 + phase) * 0.35 +
      Math.sin(p.y * 690 + p.z * 180) * 0.15);
    // Two occlusion terms, and they now use the cap's OWN two profiles rather
    // than a pair of ramps invented beside them — which is how round 2 ended up
    // darkening 86% of the radius by 14% to shade a dish that was supposed to
    // be a dent. A flat face is not occluded, so the broad term drops to 5%:
    // enough that the end does not read as a disc pasted on, small enough that
    // it cannot draw a trough. The crease keeps 20%, because it is a real
    // 4 mm concavity around a piece of wood, it IS in shadow, and it is the one
    // line on this object that says the stick went through rather than up to.
    const rXY = Math.hypot(p.x, p.y);
    const capK = clamp01((Math.abs(p.z) - half * 0.62) / (half * 0.38));
    const dish = capK * capDish(clamp01(rXY / (R - MALLOW_EDGE)));
    const puck = capK * capPucker(rXY, 1.6);
    const ao = 1 - 0.05 * dish - 0.20 * puck;
    // Baked transmission, which is the half of translucency that is NOT a
    // function of where the light is. The contract is explicit that a
    // marshmallow reads by light coming THROUGH it, and it is equally explicit
    // that the wrap/back-scatter term belongs to `marshmallow_toast.js` — whose
    // material is only ever on the held variant. So this is the prop's whole
    // translucency budget, and round 2 spent it entirely on the rim.
    //
    // Two terms now, and the split is the reason the prop reads as a dark lump
    // in `prop-side` rather than as sugar. Measured there: the marshmallow runs
    // 85 mean luma against grass at 180 and dirt at 175 — half the value of
    // everything it is supposed to be the bright element in front of. Round 2
    // proved that is lighting-bound (a pure-white probe moved it 17 points and
    // no further) and concluded that chasing value was the wrong trade. That
    // conclusion was right about ALBEDO and wrong about the model: a Lambert
    // lobe with no transmission at all is a real understatement of a white
    // sugar foam, which returns essentially every photon that enters it.
    //
    //   BODY, 12%. Not a cheat with a bound picked by eye: 0xf3eee6 is linear
    //   (0.897, 0.855, 0.792), so 1.12 puts the red channel at 1.004 and the
    //   luminance at 0.963. That is the ceiling and it is a real one — a
    //   surface cannot return more light than falls on it — so this is the
    //   whole of the value move that is available inside a diffuse lobe, and
    //   the frame can have all of it.
    //
    //   RIM, 22%, on the round-over ring where the barrel turns the corner into
    //   a cap. This one MAY pass unity, because it is not reflected flux: it is
    //   light that entered the far side of a 5 mm edge and came out here, and
    //   at that thickness against a 42 mm body most of it does. It lands
    //   exactly on the silhouette edge, which on a 28-pixel object is most of
    //   what the eye reads.
    //
    // Both are hue-neutral multipliers so neither can tint the rim, and neither
    // is emissive — an emissive marshmallow would glow at dusk, and the one
    // rule this object has is that the fire owns the top of the range.
    const sss = 1 + 0.12 + 0.22
      * clamp01((rXY / R - 0.62) / 0.38)
      * clamp01((Math.abs(p.z) - half * 0.30) / (half * 0.55));
    const m = g * ao * sss;
    return [base[0] * m, base[1] * m, base[2] * m];
  };
}

/**
 * The marshmallow's own frame on the stick.
 *
 * A speared marshmallow is never square to the stick — it went on crooked and
 * nobody straightened it — so the axis is tilted a few degrees off `base`. The
 * roll is CHOSEN rather than left to `setFromUnitVectors`, which picks an
 * arbitrary one: the u = 0 seam is put on the underside, which is the
 * least-seen face in both the leaning framing and the held one, so the one place
 * the toast map can smear is the one place nobody looks.
 *
 * `base` is what the tilt is measured FROM, and the two builders pass different
 * things on purpose. The prop leaves it null and gets the shaft's own tangent,
 * because a crooked marshmallow on a stick that never turns costs nothing. The
 * held stick passes the twirl axis, because tilt off THAT axis is the one thing
 * spinning cannot average away — see the long note at the held solve, and do
 * not swap them back.
 */
function mallowFrame(rnd, cl, iM, tiltMax, base = null) {
  const T = base ? base.clone().normalize() : new THREE.Vector3().subVectors(
    cl.P[Math.min(cl.samples, iM + 1)], cl.P[Math.max(0, iM - 1)]).normalize();
  const axis = T.clone()
    .applyAxisAngle(cl.lat, (rnd() - 0.5) * 2 * tiltMax)
    .applyAxisAngle(cl.up, (rnd() - 0.5) * 2 * tiltMax)
    .normalize();
  const ref = cl.up.clone().negate();
  const x = ref.addScaledVector(axis, -ref.dot(axis));
  if (x.lengthSq() < 1e-9) x.copy(cl.lat);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(axis, x);   // (x, y, axis) right-handed
  return {
    axis,
    quat: new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(x, y, axis)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The prop that leans against the table.
 *
 * Origin: on the ground, directly under the stick's butt end.
 *
 * @param rnd  seeded RNG — every random choice on this prop goes through it
 * @param opts { restH, leanYaw, toast, wear } — see `docs/ROAST_CONTRACT.md`
 * @returns {THREE.Group}
 */
export function buildRoastStick(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'camp_roaststick';

  const restH = Math.max(0.14, opts.restH ?? 0.42);
  const leanYaw = opts.leanYaw ?? 0;
  const toast = clamp01(opts.toast ?? 0);
  const wear = clamp01(opts.wear ?? rnd());

  // Everything is authored leaning toward +Z and the whole assembly is yawed
  // once, which is cheaper and far easier to reason about than carrying the
  // bearing through every matrix — and `y` is untouched by a yaw, so the dust
  // ramp and the lean solve are unaffected by it.
  const lean = new THREE.Group();
  lean.rotation.y = leanYaw;
  g.add(lean);

  // 1.32-1.44 m. A roasting switch is cut long enough to keep a forearm out of a
  // fire and short enough to carry: measured against the camper (4.7 m) and the
  // table (0.56 m) in the same frame, anything under a metre reads as a wand.
  //
  // Up 11% on round 1, and it is the contact solve's bill rather than a taste
  // change. sinθ = (restH − y0)/(L · sRest): with the contact pulled in to about
  // 0.47 a 1.19 m stick against the top of `camp_table.js`'s range wants 52
  // degrees, which is a fence post and past the clamp either way. 1.32 is the
  // shortest that keeps the whole table range inside `LEAN_MAX`. It also buys
  // the wide shot 15% more diagonal, which is 25 more pixels of the only line in
  // that frame.
  const L = 1.32 + rnd() * 0.12;
  const spec = switchSpec(rnd, L, wear, {
    dustTop: 0.13,
    dustAmt: 0.28 + 0.30 * wear,
    droop: 0.009 + 0.006 * rnd(),
  });

  // The butt sits 8 mm up, which puts it *inside* the camp's dirt mesh. That is
  // intended — see the header. The shaft clears the dirt band within 100 mm.
  const y0 = 0.008;
  const sM = 1 - MALLOW_INSET / L;
  const sRest = solveRest(restH, y0, sM);
  const theta = solveLean(L, sRest, y0, restH, spec.defl);
  const cl = centreline(V(0, y0, 0), theta, L, 48, spec.defl);

  const P = new Parts('roaststick');
  // Ten sides. The kit argues for six on a chair leg and is right about it, but
  // this shaft has to survive a 1.65 m prop framing as well as the wide, and six
  // facets on a 21 mm-diameter cylinder at that range is a pencil. Eight was
  // enough while the cantilever was three pixels across; at eleven it is not.
  P.add(sweepShaft(cl, spec.radius, 10), 'wood', null, shaftTint(cl, spec.colour));
  for (const k of spec.nubs) addNub(P, cl, k, spec);
  P.flush(lean);

  // ── the marshmallow ────────────────────────────────────────────────────────
  const iM = Math.round(sM * cl.samples);
  const fr = mallowFrame(rnd, cl, iM, 0.11);
  const oa = rnd() * TAU, off = 0.004 + rnd() * 0.003;
  const centre = cl.P[iM].clone()
    .addScaledVector(cl.lat, Math.cos(oa) * off)
    .addScaledVector(cl.up, Math.sin(oa) * off);

  // 22 x 18 rather than the held stick's 48 x 34. This one is seen at 7.4 m and
  // at 1.65 m and never at 0.3 m, and it carries no vertex-shader swell or sag,
  // so the only thing the segment count buys is a round rim and enough cap rows
  // for the pucker to be a crease rather than a chamfer. Up from 18 x 14 because
  // the marshmallow is now the top of a taller diagonal and is what the prop is
  // FOUND by — it is worth 200 triangles that it is round.
  const mallow = new THREE.Mesh(
    mallowGeometry({
      rings: 22, bands: 18,
      // The same flat end the held one gets. It is worth as much here as at
      // hero scale and for a different reason: at 28 px across, a cap that is
      // 40% crater is the whole right-hand half of the blob, and a blob with a
      // hole in it is not findable as a marshmallow at any distance.
      dentA: 0.00045, dentB: 0.00030,
      ovalPhase: rnd() * TAU,
      dents: 0.020, dentPhase: rnd() * TAU,
      colour: mallowColourFn({ toast, phase: rnd() * TAU }),
    }),
    // `fabric` and not a new material: matte, no metalness, no glint, white base
    // with vertex colours — which is what raw sugar is, and it costs no extra
    // program. The kit's own note is that a prop must never invent a material a
    // peer already made; this is the case that rule was written for.
    campMaterials().fabric,
  );
  mallow.name = 'roaststick_mallow';
  mallow.castShadow = true;
  // …and NOT receiveShadow, which round 1 had on and which is most of why the
  // marshmallow arrived at half the value of the dirt behind it.
  //
  // The sun's shadow map is 117 mm per texel — the number `camp_telescope.js`
  // measured and wrote up when it could not resolve a 34 mm tripod leg. This
  // marshmallow is 42 mm across and 26 mm long: the WHOLE OBJECT is a third of
  // one texel. What the map holds at that texel is the depth of whatever face of
  // it happened to win the raster, so every other point on the surface tests
  // behind that depth and shades itself. Measured off round 1's `prop-side`, the
  // marshmallow's brightest pixel was (194, 123, 86) against dirt at (247, 169,
  // 101) — a 0.88-albedo object taking a third of the irradiance of 0.30-albedo
  // ground two metres away, which is not a lighting result, it is acne.
  //
  // It still CASTS, which is what puts it on the table, and the held variant has
  // had `receiveShadow` off since round 1 for the same reason — which is exactly
  // why the held marshmallow read as sugar in `held-clean` and this one did not.
  mallow.receiveShadow = false;
  mallow.position.copy(centre);
  mallow.quaternion.copy(fr.quat);
  lean.add(mallow);

  // ── what the integrator reads ──────────────────────────────────────────────
  const yaw = new THREE.Quaternion().setFromAxisAngle(UP, leanYaw);
  const rest = pointAt(cl, sRest);
  g.userData.roast = {
    mallow: centre.clone().applyQuaternion(yaw),
    butt: V(0, y0, 0),
    len: L,
    // NOT in the contract — an addition, flagged in the build report. It is the
    // point on the shaft that is meant to be touching the table edge, in prop
    // space, and without it `camp_site.js` has to re-derive the lean angle from
    // `len` and `restH` to know how far from the table to stand the butt.
    rest: rest.applyQuaternion(yaw),
  };
  g.userData.footprint = 0.28;
  return g;
}

/**
 * The same stick, built for the hand.
 *
 * Origin: the GRIP, 0.10 m from the butt. The stick runs along +Z; +Y is up when
 * it is level. The view rotates this group about its own +Z to twirl.
 *
 * @param rnd  seeded RNG
 * @param opts { rings, bands, wear } — see `docs/ROAST_CONTRACT.md`
 * @returns {THREE.Group}
 */
export function buildHeldStick(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'camp_roaststick_held';

  // 48 x 34, up from the contract's 32 x 24 defaults (which remain overridable,
  // and the contract only ever asked for "generous"). The view brings this to
  // hero scale this round — roughly a tenth of frame height, so a 42 mm
  // marshmallow lands about 110 px across. At 32 rings the visible half of the
  // rim is sixteen facets over that width, which is a seven-pixel flat on the
  // one silhouette a squat cylinder is read by. 48 halves it to under four,
  // which is where the rim stops being a polygon. Bands go up for the caps: the
  // pucker is a 6 mm feature and gets four rows across it at 34.
  //
  // The whole mallow is 1700 vertices. This is the one mesh in the camp that is
  // held 300 mm from the lens and it is the one place the polygons are worth it.
  const rings = Math.max(8, Math.round(opts.rings ?? 48));
  const bands = Math.max(10, Math.round(opts.bands ?? 34));
  const wear = clamp01(opts.wear ?? rnd());

  // The same band as the leaning prop, because it is the same stick — see the
  // note there for why the band moved.
  const L = 1.32 + rnd() * 0.12;
  const spec = switchSpec(rnd, L, wear, {
    // No dust: this is the end of the stick a hand has been on, held above a
    // fire, and a dust ramp keyed to world height is meaningless once the prop
    // is parented to a camera anyway.
    dustTop: 0, dustAmt: 0,
    // A much smaller droop than the leaning prop's. Two reasons: nothing is
    // resting on the table edge here so the cantilever is shorter, and the droop
    // carries the tip off the twirl axis, which eats into the offset budget
    // below — see the solve.
    droop: 0.005 + 0.003 * rnd(),
  });

  // 72 samples rather than 56. The S and the droop are 20 mm of deflection over
  // 1.4 m; at hero scale the eye is looking straight down the length of that
  // curve, and a polyline joint is the one place a swept tube shows its seams.
  const cl = centreline(V(0, 0, -GRIP), 0, L, 72, spec.defl);

  const P = new Parts('heldstick');
  // Sixteen sides here rather than the prop's ten. This shaft passes within
  // 300 mm of the lens and is the most-looked-at cylinder in the game while the
  // view is open — at 300 mm a 21 mm butt is over a tenth of frame width, and
  // twelve facets across that is a visible dodecagon. The extra 600 triangles
  // are the cheapest thing in the frame.
  P.add(sweepShaft(cl, spec.radius, 16), 'wood', null, shaftTint(cl, spec.colour));
  for (const k of spec.nubs) addNub(P, cl, k, spec);
  P.flush(g);

  // ── where the marshmallow goes, and why it is solved rather than typed ─────
  //
  // The contract requires 5-12 mm of offset off the +Z twirl axis and a few
  // degrees of tilt, and it is right to require it: the view spins this group
  // about +Z, and a marshmallow concentric with that axis simply does not appear
  // to move. Spinning is the verb of the entire mini-game, so this offset is the
  // difference between a mechanic and a still image.
  //
  // But the shaft's own S and droop have already carried its tip a few
  // millimetres off the axis, in a direction the seeded RNG picked, so a typed-in
  // offset lands somewhere between 1 mm and 20 mm depending on the seed — and at
  // 20 mm the stick would exit through the SIDE of a 21 mm marshmallow instead of
  // going through it. Both ends of that are contract violations, so both are
  // solved for: hold the stick-to-centre distance at a fixed 5.5-7 mm (well
  // inside the body, so the shaft always pierces it, off-centre, the way a real
  // one does) and scan the phase for the one that puts the CENTRE nearest 8.4 mm
  // off the twirl axis.
  const sM = 1 - MALLOW_INSET / L;
  const iM = Math.round(sM * cl.samples);
  const tip = cl.P[iM];
  const off = 0.0055 + rnd() * 0.0015;
  const target = 0.0070 + rnd() * 0.0028;
  const ph0 = rnd() * TAU;
  let best = null;
  for (let k = 0; k < 24; k++) {
    const a = ph0 + (k / 24) * TAU;
    const cx = tip.x + Math.cos(a) * off;
    const cy = tip.y + Math.sin(a) * off;
    const e = Math.abs(Math.hypot(cx, cy) - target);
    if (!best || e < best.e) best = { e, cx, cy };
  }
  // Belt to that brace: whatever the scan found, force the published offset into
  // the contract's band. A seed that puts the shaft tip dead on the axis cannot
  // get closer to `target` than `off`, and 5 mm is the floor that matters.
  const rXY = Math.hypot(best.cx, best.cy) || 1e-6;
  const kScale = clamp(rXY, 0.0050, 0.0115) / rXY;
  const centre = V(best.cx * kScale, best.cy * kScale, tip.z);

  // ── and why the TILT is not solved the same way, but taken almost out ──────
  //
  // The contract clause above asks for two things in one sentence — "5-12 mm of
  // offset and a few degrees of tilt" — and they are not the same thing. The
  // toast map's lattice follows the MESH's axis (it has to: u is the geometry
  // contract's u and the map is a texture drawn on this mesh), so:
  //
  //   · a LATERAL OFFSET orbits every texel on a circle of the same radius.
  //     Distance to the fire varies through the turn and averages out over one.
  //   · an ANGULAR TILT makes every texel sweep a CONE. The up side of the cone
  //     is permanently further from the fire than the down side, and no rate of
  //     spin averages that away.
  //
  // Round 11 measured it — `tools/_scratch/mtilt.mjs`, the real ToastMap
  // replayed against the real dumped pose, offset and tilt swept one at a time.
  // `evenness` at golden, at the default height:
  //
  //     tilt  0°  0.983   |  offset   0 mm  0.991
  //           2°  0.955   |           8 mm  0.983
  //           6°  0.899   |          16 mm  0.975
  //          10°  0.842   |          28 mm  0.963
  //          13.9° 0.789  |
  //
  // — 0.0139 of evenness per degree of tilt against 0.001 per millimetre of
  // offset, and NEITHER number moves with spin rate (13.9° reads 0.789 at
  // 2.0 rad/s and 0.799 at 9.5). Round 10 shipped 0.13 rad about each of two
  // axes off the shaft TANGENT, which is 6.5 degrees median and 13.3 worst off
  // the twirl axis, and that alone held the best grade a player could reach at
  // 0.03 clear of 'perfect' (0.78) — a coin toss rather than a thing skill
  // earns. It also cost the toast author TOAST_ACC, held at 2.80 rather than
  // the 4.50 their never-turn target wanted.
  //
  // So: measure the tilt off +Z, the axis this group is spun about, and spend a
  // budget rather than a taste. 0.030 rad about each of two axes is at most
  // 2.43 degrees off the twirl axis. Measured back through the same instrument
  // with the real mesh on the real line, 60 seeds at the keyboard's 9.5 rad/s,
  // `evenness` at golden is now 0.957 / 0.979 / 0.997 where round 10's was
  // 0.848 / 0.914 / 0.981 — the worst camp is better than the median camp was,
  // and the margin over 'perfect' went from 0.03 at the dumped camp to 0.18 at
  // the worst of sixty.
  //
  // NOBODY SHOULD PUT THE TILT BACK TO SATISFY THE CONTRACT CLAUSE. The clause
  // is about the spin being legible, and the offset above does all of that work:
  // it is the marshmallow's whole 8.4 mm orbit, and the strip in
  // `shots/roast/r11-geo` is the evidence. What tilt buys on top of it is a nod,
  // which is worth 2 degrees and is not worth 14. The crooked-spear read at hero
  // scale survives too, and for free: the axis is +Z but the SHAFT arrives at
  // 0.07 / 0.99 / 5.25 degrees off it (its own S and droop, measured over 300
  // seeds), so the wood still goes through the marshmallow at an angle to the
  // marshmallow — and the toast map does not care what the wood does.
  const fr = mallowFrame(rnd, cl, iM, 0.030, V(0, 0, 1));

  // A placeholder, built per call rather than shared out of a module singleton.
  // The view replaces this material with `marshmallowMaterial()` and may
  // reasonably dispose what it replaces; a shared one would take the kit down
  // with it. It costs nothing: `vertexColors` + standard is the same program key
  // every material in `campMaterials()` already linked, so three's cache serves
  // it and no shader is compiled.
  const placeholder = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true,
    roughness: 0.88, metalness: 0.0, envMapIntensity: 0.25,
  });
  placeholder.name = 'roast_mallow_placeholder';

  const mallow = new THREE.Mesh(
    mallowGeometry({
      rings, bands,
      // Slightly deeper than the prop's, both dish and crease: this one is
      // looked at from 300 mm and the dents are the difference between a sweet
      // and a bead. The toast author's vertex shader swells and sags over the
      // top of this, and it needs something to deform.
      //
      // The crease is where the extra depth goes now, not the dish. 2.1 mm at
      // the grip end against the contract's "maybe 2 mm deep", 1.8 at the far
      // end — a pierced marshmallow is never creased equally at both ends —
      // and the face they sit in is flat to within half a millimetre.
      dentA: 0.00050, dentB: 0.00034,
      puckA: 0.0021, puckB: 0.0018,
      ovalPhase: rnd() * TAU,
      dents: 0.022, dentPhase: rnd() * TAU,
      colour: mallowColourFn({ toast: 0, phase: rnd() * TAU }),
    }),
    placeholder,
  );
  mallow.name = 'held_mallow';
  mallow.castShadow = true;
  mallow.receiveShadow = false;
  mallow.position.copy(centre);
  mallow.quaternion.copy(fr.quat);
  // The mallow swells and sags in a vertex shader it does not own, so its bounds
  // are not what its vertices say they are; without this it pops out of frame at
  // the exact moment it is biggest.
  mallow.frustumCulled = false;
  g.add(mallow);

  g.userData.held = {
    mallow,
    tip: centre.clone(),
    len: centre.length(),
    radius: MALLOW_R,
    half: MALLOW_HALF,
  };
  return g;
}
