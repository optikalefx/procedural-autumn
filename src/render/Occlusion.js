// ─────────────────────────────────────────────────────────────────────────────
//  Occlusion — whatever the camera is standing inside gets out of the way.
//
//  The player's words, twice, a round apart:
//
//    "transparent frustum for the camera, so that objects are not constantly
//     in my view."
//
//    "It should hide entire objects when they are basically on top of the
//     camera. Not if they are far away but in front of the car, and not with a
//     little circle window like its doing now. […] We should only occlude the
//     trees directly in front of the camera."
//
//  In a chase-camera driving game through dense forest, the camera regularly
//  ends up INSIDE something — a conifer bough half a metre from the lens fills
//  a third of the screen, a birch trunk the boom has backed into fills all of
//  it. That is the whole problem, and the answer is small: measure how close
//  the OBJECT is to the lens, and if it is essentially touching it, take the
//  object away. All of it, at once.
//
//  ── what this used to be, and why it is not that any more ────────────────
//
//  The first build of this file was two shapes: the near-camera sphere below,
//  and a camera-to-subject cone that dissolved anything between the lens and
//  the camper at any range. The cone is the standard answer to "keep the
//  subject visible" and it is the thing the player rejected on sight, for two
//  reasons that are worth keeping written down:
//
//    · It fires on distance-from-the-view-axis, not distance-from-the-lens, so
//      it dissolves canopy fifteen and twenty metres out — trees that were
//      never in anyone's way — and it does it in the exact middle of the frame.
//    · It is a cone through a scattered medium, so what it leaves behind is a
//      ROUND HOLE punched through a crown, at partial dither, that follows the
//      camper around. Nothing in the picture is shaped like that. It reads as a
//      lens artifact rather than as the forest making room.
//
//  So the cone is gone, along with `wide`, `soft`, `taper` and the subject
//  vector the shader used to carry. What is left is one distance and one
//  smoothstep. The subject is still handed in once a frame, but only as the
//  switch that says "we are behind the camper" — see setOcclusionSubject.
//
//  ── the shape: how far is the OBJECT from the lens ───────────────────────
//
//  Not the fragment, not the vertex: the object. A fade computed per fragment
//  from a world position is a sphere of clear air around the camera, and what
//  it cuts out of a solid trunk is a soft-edged porthole — the same artifact
//  the player rejected in the cone, at a different scale. Every consumer
//  therefore evaluates this ONCE per instance, at the instance's own origin,
//  and carries the one value across the whole of it:
//
//    · a tree      — `occludeFadeColumn`, off the trunk axis (both the bark and
//                    every clump of its canopy, so a tree leaves as one thing)
//    · a leaf clump — `occludeFadeAt`, off the clump centre with its own radius,
//                    ALSO, because a low bough can lie on the lens while the
//                    trunk it belongs to is six metres away
//    · a rock      — `occludeFadeAt`, off the instance origin with its own size
//    · a cover plant — `occludeFadeAt`, off the root, which is what it already did
//
//  A tree is a COLUMN and not a point, which is the one place this needs more
//  than a distance. Its origin is at its foot, twenty metres below the crown
//  and often several metres below the camera, so a plain distance to that
//  origin would hide a tree only once you were standing on its roots. The test
//  is therefore the distance to a vertical segment through the trunk, spanning
//  `spanBelow` under the foot to `spanAbove` over it — a window sized for where
//  a chase camera actually rides, so that a tree on the hillside twelve metres
//  below the road is not "on top of the camera" however close its axis passes
//  in plan.
//
//  ── how it fades ─────────────────────────────────────────────────────────
//
//  Three mechanisms, because the game has three kinds of surface and only one
//  of them can afford a discard for free:
//
//    · Foliage is ALPHA-TESTED. A naive opacity fade does nothing on an
//      alpha-tested material (there is no blending to fade into) and an
//      alpha-test ramp pops. Dithered screen-door transparency is the standard
//      answer for this look, costs a handful of ALU, and — unlike real
//      transparency — needs no sort and does not disturb the render order the
//      rest of the game is tuned against. That shader already discards, so
//      early-Z is already off for it and the discard is genuinely free.
//    · Ground cover is opaque. Adding a discard there would cost early-Z on a
//      surface that has it, so instead it reuses the shrink-toward-the-root
//      that `coverFade` in shaders/cover_material.js already does at the
//      visibility limit: a plant in the way sinks into the ground. Vertex-side
//      only, no fragment cost at all, and it is the idiom that file already
//      speaks.
//    · BARK AND ROCK are opaque too, and neither can be shrunk. A trunk pulled
//      toward its own axis shears its branches off it (photographed:
//      shots/occlude/bark-on.png), and a boulder pulled toward its centre is a
//      boulder visibly deflating in the middle of the frame. Both therefore
//      dither like the foliage — and both pay the early-Z that costs, which on
//      bark alone measured at 19 fps. So each of them ships TWO PROGRAMS, one
//      with the dither and one without, and the system that owns the meshes
//      swaps between them per instanced mesh per frame using the CPU copy of
//      this volume further down the file. The bill arrives only on the frames
//      that are actually hiding something, and only on the meshes doing the
//      hiding; every other frame is bit-identical to a build without this.
//      See `_gateOcclusion` in vegetation/Trees.js and rocks/Rocks.js.
//
//  Because the fade is now one value per instance rather than a field over the
//  surface, the dither is a whole-object dissolve: the tree thins out evenly
//  and vanishes. That is also why the feather has to stay wide — see nearFull.
//
//  ── what it must NOT touch ───────────────────────────────────────────────
//
//  The shadow pass. Every material here casts through a separate depth
//  material, and none of them opt in — deliberately. A tree that stopped
//  casting as you drove past it would strobe its shadow across the ground,
//  which is far more conspicuous than the tree itself. So the canopy you can
//  see through still lays its dapple on the road, and that is also why the
//  effect reads as the camera getting out of the way rather than as the forest
//  disappearing.
//
//  ── opting in ────────────────────────────────────────────────────────────
//
//  Same pattern as render/Stylize.js and render/Atmosphere.js: merge the
//  uniforms, include the pars, call the function. Three lines, in your file.
//
//    import { occlusionUniforms, OCCLUDE_PARS, OCCLUDE_DITHER }
//      from '../render/Occlusion.js';
//
//    uniforms: Object.assign( { …yours }, occlusionUniforms() )
//    vertexShader:   OCCLUDE_PARS   + `… vOcc = occludeFadeAt( origin, r ); …`
//    fragmentShader: OCCLUDE_DITHER + `… occludeCut( vOcc ); …`
//
//  Evaluate it at YOUR OBJECT'S ORIGIN, in the vertex shader, and pass the one
//  value down as a varying. Do not evaluate it per fragment off the world
//  position: that is the porthole, and it is the artifact this round removed.
//
//  If your surface is OPAQUE and its shader is not already discarding, do not
//  opt in like that. Build a second material with the three lines in it, leave
//  the first one alone, and gate the swap on `occlusionTouchesSphere` /
//  `occlusionTouchesColumn` below — otherwise the whole draw loses early-Z in
//  every frame of the game to buy a fade that engages in very few of them.
//
//  MERGE WITH Object.assign, NOT THREE.UniformsUtils.merge(). merge() deep
//  clones, which would give your material a private copy of the uniform block
//  that nothing ever writes to, and the effect would silently never appear on
//  it. Everything in this game that opts in uses Object.assign already.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

const DEFAULTS = {
  // ── the one distance ─────────────────────────────────────────────────────
  // An object whose body comes within `nearFull` metres of the lens is gone;
  // one that stays outside `nearNone` is untouched; in between it dissolves.
  //
  // 1.80 / 4.20. The inner number is "the camera is inside this" — the chase
  // boom's own clearance is about that, so a trunk at 1.8 m is one the boom has
  // backed into. The outer one is what makes the dissolve a dissolve: an object
  // crossing 2.4 m of feather at driving speed takes a third of a second to go,
  // and the brief for this feature is explicit that a tree which blinks out is
  // worse than one you can see past. It is also, measured, the half of this
  // feature that BUYS frame time rather than costing it — it discards
  // near-camera canopy overdraw, which is the single most expensive fill in the
  // game (X5: p50 -0.60 ms, p95 -2.60 ms against the near sphere switched off).
  //
  // Widening it further is tempting and is a trap: the fade is now per OBJECT,
  // so every metre added here takes whole trees out of the frame rather than
  // trimming the twigs in front of the lens.
  nearFull: 1.80,
  nearNone: 4.20,

  // ── the trunk window, for occludeFadeColumn ──────────────────────────────
  // How much of the vertical line through a tree's foot counts as "the tree",
  // measured from the foot: `spanBelow` under it, `spanAbove` over it.
  //
  // This exists because an instance origin is at the FOOT and the thing in your
  // way is the ten metres of trunk above it. Without a window the test would be
  // a distance to the foot, and a tree would only hide once the camera was down
  // at its roots. With an unbounded column it would be a distance in plan, and
  // every tree on a hillside below a ridge road would dissolve as you drove
  // over it, twelve metres beneath the camera.
  //
  // 9.0 is a chase camera's working height over the ground the tree stands on
  // (the boom rides 2-5 m up, more when it is looking down a slope) plus enough
  // margin that cresting a rise does not flicker. 1.5 below the foot covers a
  // camera in a dip beside a tree that stands on the lip of it.
  spanBelow: 1.5,
  spanAbove: 9.0,

  // How far a fully-enclosed object goes. 1.0 is fully transparent.
  amount: 1.0,

  // ── engagement gate, applied on the CPU ──────────────────────────────────
  // The chase camera is the only camera this is for. Handing in the camper's
  // position once a frame is what says "we are driving"; the fly camera and
  // every capture in tools/shot.mjs hand in nothing and the whole feature
  // switches off, exactly as it did before.
  //
  // The old build also refused to engage unless the camper was near the view
  // AXIS, because the cone had to point at something. There is no axis any
  // more and that gate is gone with it: a bough on the lens is a bough on the
  // lens whichever way the player has swung the camera, and refusing to clear
  // it while they look sideways was a bug waiting to be filed.
  maxDist: 80.0,     // the chase wheel tops out at 68 m
  enabled: true,
};

/** Runtime-tunable copy. Reachable as `window.__occlusion.params`. */
const PARAMS = { ...DEFAULTS };

// ONE uniform block, shared by reference across every material that opts in,
// so switching the effect on and off each frame is a single scalar write rather
// than a walk over a material set. This is why occlusionUniforms() hands back
// the same object every call instead of a clone.
const UNIFORMS = {
  // x: nearFull, y: nearNone. Packed because these two are only ever read
  // together and a uniform slot is a uniform slot on the low tiers.
  uOccNear:   { value: new THREE.Vector2(DEFAULTS.nearFull, DEFAULTS.nearNone) },
  // x: spanBelow, y: spanAbove — the trunk window of occludeFadeColumn.
  uOccSpan:   { value: new THREE.Vector2(DEFAULTS.spanBelow, DEFAULTS.spanAbove) },
  // Starts at zero, and that is the off switch: every occludeFade* below
  // returns 1.0 on it before touching anything else. A material that opts in
  // but is never handed a subject — the impostor bake programs, anything
  // compiled during warm-up — therefore behaves exactly as it did before.
  uOccAmount: { value: 0 },
};

/**
 * Uniform block a material merges in to participate. Same object every call:
 * see the note above UNIFORMS, and use Object.assign, never UniformsUtils.merge.
 */
export function occlusionUniforms() { return UNIFORMS; }

const _d = new THREE.Vector3();
const _cam = new THREE.Vector3();

/**
 * Tell the effect that the chase camera is live, once per frame.
 *
 * The subject is no longer a target to aim a cone at — nothing in the shape
 * depends on where the camper is any more. It is the switch: a frame that is
 * following the camper gets the volume, a frame that is not (the fly camera,
 * every landscape capture, the impostor bake) gets `uOccAmount = 0` and is
 * bit-identical to a build without this file.
 *
 * @param {THREE.Camera} camera  the camera being rendered
 * @param {THREE.Vector3|null} pos  the subject's world position, or null/absent
 *                                  to switch the effect off for this frame
 */
export function setOcclusionSubject(camera, pos) {
  if (!pos || !camera || !PARAMS.enabled) { UNIFORMS.uOccAmount.value = 0; return; }

  // The CPU mirror below needs the same lens the shader gets from three's own
  // `cameraPosition`. Copied on every engaged frame, and never read while
  // uOccAmount is 0.
  _cam.copy(camera.position);

  _d.copy(pos).sub(camera.position);
  if (_d.lengthSq() > PARAMS.maxDist * PARAMS.maxDist) {
    UNIFORMS.uOccAmount.value = 0;
    return;
  }

  UNIFORMS.uOccNear.value.set(PARAMS.nearFull, Math.max(PARAMS.nearNone, PARAMS.nearFull + 0.01));
  UNIFORMS.uOccSpan.value.set(PARAMS.spanBelow, PARAMS.spanAbove);
  UNIFORMS.uOccAmount.value = PARAMS.amount;
}

/** Old name, kept so nothing outside this file has to change at once. */
export const setOcclusionTarget = setOcclusionSubject;

// ── the same shape, on the CPU ───────────────────────────────────────────────
//
//  The shader owns the fade; this owns the QUESTION "is anything I am about to
//  draw inside the volume at all", and it exists because two of the materials
//  that opt in cannot afford to carry the effect unconditionally.
//
//  A discard anywhere in a program turns early-Z off for the whole of it, and
//  bark and rock are the two opaque surfaces in this game that have early-Z and
//  need it — see the measurement in the header of vegetation/tree_material.js,
//  where switching the bark program to a discarding one cost 19 fps. So each of
//  them ships TWO programs, one with the dither and one without, and swaps
//  between them per mesh per frame. In the overwhelming majority of frames
//  nothing is in the volume, every mesh keeps the discard-free program, and the
//  build is bit-identical to one that never had this.
//
//  These mirror the shader EXACTLY now rather than conservatively, because both
//  sides ask the same question of the same per-instance origin: the gate reads
//  the instance matrix, the shader reads the same matrix. At the moment of
//  either swap the object sits at `nearNone`, where the smoothstep returns 1.0
//  and `occludeCut` discards nothing, so the two programs render the same
//  pixels there and a per-frame material swap is invisible. The small margin
//  each caller adds is for float, not for shape.

/** GLSL smoothstep, so the mirror below reads like the shader it mirrors. */
function sstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Is the volume switched on this frame at all? False in every capture and in
 * the fly camera — which is the cheap first line of every gate.
 */
export function occlusionActive() { return UNIFORMS.uOccAmount.value > 0; }

/**
 * `occludeFadeAt` from the GLSL below, in JS. 1.0 = untouched.
 *
 * Kept alongside the shader string rather than in the consumers, because the
 * one thing that must not happen to these two is that they drift.
 */
export function occlusionFadeAt(x, y, z, radius = 0) {
  const amt = UNIFORMS.uOccAmount.value;
  if (amt <= 0) return 1;
  const rx = x - _cam.x, ry = y - _cam.y, rz = z - _cam.z;
  const d = Math.sqrt(rx * rx + ry * ry + rz * rz) - radius;
  return 1 - amt * (1 - sstep(UNIFORMS.uOccNear.value.x, UNIFORMS.uOccNear.value.y, Math.max(d, 0)));
}

/** Is this object's body inside the volume at all? The gate form of the above. */
export function occlusionTouchesSphere(x, y, z, radius) {
  if (UNIFORMS.uOccAmount.value <= 0) return false;
  const rx = x - _cam.x, ry = y - _cam.y, rz = z - _cam.z;
  const lim = UNIFORMS.uOccNear.value.y + radius;
  return rx * rx + ry * ry + rz * rz < lim * lim;
}

/**
 * Squared distance from the lens to a standing object's trunk — the geometry of
 * `occludeFadeColumn`, shared by the fade and the gate below. (x, y, z) is the
 * foot. Squared, because the gate runs this over every drawn tree instance in
 * the frame and wants its answer without a root.
 */
function columnDist2(x, y, z) {
  const dx = x - _cam.x, dz = z - _cam.z;
  // How far the camera is outside the trunk window, and zero while it is
  // inside it — the same max() the shader runs.
  const span = UNIFORMS.uOccSpan.value;
  const dy = Math.max(y - span.x - _cam.y, _cam.y - (y + span.y), 0);
  return dx * dx + dz * dz + dy * dy;
}

/** `occludeFadeColumn` from the GLSL below, in JS. (x, y, z) is the foot. */
export function occlusionFadeColumn(x, y, z, radius = 0) {
  const amt = UNIFORMS.uOccAmount.value;
  if (amt <= 0) return 1;
  const n = UNIFORMS.uOccNear.value;
  const d = Math.max(Math.sqrt(columnDist2(x, y, z)) - radius, 0);
  return 1 - amt * (1 - sstep(n.x, n.y, d));
}

/**
 * Is a standing object — a tree, on its foot at (x, y, z) — inside the volume?
 * The gate form of occludeFadeColumn, and what Trees.js swaps bark programs on.
 *
 * This is the hot one: it runs over every drawn trunk in the frame, so it is
 * written as one squared compare and nothing else. Everything it rejects — in
 * open country, all of it — costs three subtractions and three multiplies.
 */
export function occlusionTouchesColumn(x, y, z, radius) {
  if (UNIFORMS.uOccAmount.value <= 0) return false;
  const lim = UNIFORMS.uOccNear.value.y + radius;
  return columnDist2(x, y, z) < lim * lim;
}

// ── the shape, for any shader stage ──────────────────────────────────────────
// Usable in a vertex or a fragment shader; `cameraPosition` is in three's own
// prefix for both — but see the note in the header: call these from the VERTEX
// stage, at your object's origin, and carry the one value down as a varying.
// Guarded because a material may reach this string twice (once itself, once
// through a chunk that also carries it) and a redefinition is a link failure,
// not a warning — see the block comment in Stylize.js about the day that took
// grass, bark and the canopy off the air at once.
export const OCCLUDE_PARS = /* glsl */`
#ifndef OCCLUDE_DECLARED
#define OCCLUDE_DECLARED
uniform vec2  uOccNear;    // x: fully gone inside this, y: untouched outside it
uniform vec2  uOccSpan;    // x: below the foot, y: above it — occludeFadeColumn
uniform float uOccAmount;

/** Shared tail: a distance from the lens to a body, in metres, to a fade. */
float occludeRamp( float dist ) {
  return 1.0 - uOccAmount * ( 1.0 - smoothstep( uOccNear.x, uOccNear.y, max( dist, 0.0 ) ) );
}

// 1.0 = untouched, 0.0 = fully out of the way.
//
// origin is the OBJECT's own origin and radius its own extent — a leaf
// clump's half-size, a boulder's size, zero for something small enough to be a
// point. Subtracting the radius is what makes this ask "is any part of this
// thing in my face" rather than "is its centre two metres away", which for a
// several-metre clump the camera is standing inside is the difference between
// it going and it sitting there at half dither owning the screen.
//
// The early-out is a compare against the only distance that can matter, and it
// rejects essentially every instance in the frame before the sqrt: the volume
// is a few metres across and the forest runs to 900 m. Written against the
// radius rather than against a precomputed cap so a twenty-metre crag cannot
// slip through it.
float occludeFadeAt( vec3 origin, float radius ) {
  if ( uOccAmount <= 0.0 ) return 1.0;
  vec3 rel = origin - cameraPosition;
  float lim = uOccNear.y + radius;
  if ( dot( rel, rel ) > lim * lim ) return 1.0;
  return occludeRamp( length( rel ) - radius );
}

// The same, for something that STANDS: a tree, whose origin is at its foot and
// whose body is the column above it. Distance to a vertical segment through
// (origin.xz) spanning uOccSpan.x under the foot to uOccSpan.y over it.
//
// Every part of one tree — the bark, and every clump of its canopy — calls this
// with the same instance origin and therefore carries the same fade, which is
// what makes a tree leave the frame as one object instead of as a hole punched
// through itself. See the header.
float occludeFadeColumn( vec3 origin, float radius ) {
  if ( uOccAmount <= 0.0 ) return 1.0;
  vec3 rel = origin - cameraPosition;
  // Outside the window, and exactly zero anywhere inside it — so the whole
  // trunk is as near as its nearest point and the fade does not depend on how
  // tall the tree happens to be.
  float dy = max( rel.y - uOccSpan.x, -rel.y - uOccSpan.y );
  vec3 body = vec3( rel.x, max( dy, 0.0 ), rel.z );
  float lim = uOccNear.y + radius;
  if ( dot( body, body ) > lim * lim ) return 1.0;
  return occludeRamp( length( body ) - radius );
}

float occludeFade( vec3 wp ) { return occludeFadeAt( wp, 0.0 ); }
#endif`;

// ── screen-door transparency, for alpha-tested materials ─────────────────────
//
// The threshold used to be an ordered 4x4 Bayer matrix, and the critic caught
// it: "the occlusion fade reads as a halftone screen door… several crowns left
// and centre carry an obvious regular dot pattern" (CRITIC_FINDINGS D2,
// shots/wedge/f9.png). They were right, and the interesting part is WHY,
// because the obvious diagnosis is wrong.
//
// The obvious diagnosis is that the dots are too big. They are not. Magnified
// 7x, the pattern in f9 is a 2 px checkerboard — a 4x4 Bayer evaluated at one
// device pixel per cell, which is already the finest an ordered matrix can be.
// Making it finer is not available.
//
// What makes it read as a screen door is that it is ORDERED, and two properties
// of an ordered matrix that are virtues in a print halftone are defects here:
//
//   · It is periodic. Every 4 px the same sixteen thresholds come round again,
//     so a region at a constant fade is a perfect lattice — and at fade 0.5, a
//     perfect checkerboard, which is the single most visible pattern a screen
//     can hold. The fade IS constant over large regions: tree_material.js
//     evaluates it once per clump centre, deliberately (see its note), so a
//     whole billboard quad dithers at one level and the eye gets an unbroken
//     field of lattice several hundred pixels across to lock on to.
//   · It has sixteen levels. A fade that varies smoothly across a frame lands
//     in sixteen discrete densities, so the feather bands.
//
// So: keep the ordered-dither IDEA — it is still the right technique, it still
// survives alpha testing and the render order, and it still measures negative
// (X5: -1.10 ms p50, -3.70 ms p95) — and replace the ordered matrix with an
// aperiodic threshold of the same cost.
//
// Interleaved gradient noise (Jimenez 2014). Two multiplies, two fracts, no
// texture, no table. It is not white noise: it is low-discrepancy over a local
// neighbourhood, so a region at fade 0.5 still gets very close to half its
// pixels rather than clumping into holes the way a hash does — which is the
// whole reason to prefer it to `fract(sin(dot(…)))`. And it is continuous
// rather than sixteen-valued, so the feather no longer bands.
//
// Measured against the Bayer inside ONE page load with the clock stopped
// (tools/_scratch/occdither.mjs: drive, engine.stop(), hot-swap this function in
// the already-compiled material, render the same frozen frame again — camera,
// wind, sun and every clump bit-identical, and a two-identical-frames control
// that comes back at exactly 0.0000). At the one canopy pose of three where the
// effect engaged at all, it changed 0.0050 of the frame out of 0.0217 engaged.
// The lattice is gone; see shots/occdither/p2-bayer.png against p2-ign.png.
//
// The wrap is the same guard the Bayer carried and it is kept for the same
// reason: at 4K the raw coordinate reaches ~3840, and every intermediate here
// would carry it into a part of float32 where `fract` has thrown away half its
// mantissa — and on a mediump fragment stage, all of it. mod first, and the dot
// product stays under 19. 256 px is orders of magnitude beyond any period the
// eye can find in noise, so the wrap is free.
export const OCCLUDE_DITHER = /* glsl */`
#ifndef OCCLUDE_DITHER_DECLARED
#define OCCLUDE_DITHER_DECLARED
float occThreshold( vec2 p ) {
  vec2 q = mod( p, 256.0 );
  return fract( 52.9829189 * fract( dot( q, vec2( 0.06711056, 0.00583715 ) ) ) );
}
// The early-out is the important line, not a tidiness. In any given frame the
// overwhelming majority of canopy fragments are nowhere near the frustum and
// carry fade == 1.0 exactly, and the canopy is the heaviest fill in the game;
// without this every one of them evaluated the threshold to discover it had
// nothing to do. It also means a switched-off build pays a single compare
// rather than the whole pattern.
//
// fract() is strictly below 1.0, so a fade of 1.0 could never discard anyway —
// the early-out changes cost, not behaviour, and a material that is switched
// off stays bit-identical to one that never had this. That was true of the
// Bayer (it topped out at 15/16) and it is still true here.
void occludeCut( float fade ) {
  if ( fade >= 1.0 ) return;
  if ( fade <= occThreshold( gl_FragCoord.xy ) ) discard;
}
#endif`;

// ── measurement switch ──────────────────────────────────────────────────────
// `?occ=0` switches the whole feature off for the life of the page, which makes
// the build bit-identical to one that never had it (every occludeFade returns
// 1.0 on uOccAmount before touching anything else, and the Bayer threshold tops
// out at 15/16 so a fade of 1.0 cannot discard).
//
// It exists because tools/dprtest.mjs has no eval hook, and a dozen authors are
// editing this tree at once: an absolute frame time measured here is a
// measurement of everyone's uncommitted work, not of mine. Two runs of the same
// build minutes apart, one with this and one without, is the only honest way to
// price a feature in a shared tree. Reach it through --quality, which is
// concatenated into the query string:
//
//   node tools/dprtest.mjs --quality 'ultra&occ=0' --dpr 2 …
if (typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('occ') === '0') {
  PARAMS.enabled = false;
}

// Runtime handle, so the shape can be swept from a capture without a rebuild:
//   node tools/shot.mjs --view … --eval "window.__occlusion.params.nearNone = 6.0"
// setTarget is the old name of setSubject, kept because the scratch benches in
// tools/_scratch drive the effect through it.
if (typeof window !== 'undefined') {
  window.__occlusion = {
    params: PARAMS, uniforms: UNIFORMS,
    setSubject: setOcclusionSubject, setTarget: setOcclusionSubject,
  };
}
