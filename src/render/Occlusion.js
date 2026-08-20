// ─────────────────────────────────────────────────────────────────────────────
//  Occlusion — the transparent frustum in front of the chase camera.
//
//  The player's words, given twice:
//
//    "transparent frustum for the camera, so that objects are not constantly
//     in my view."
//
//  In a chase-camera driving game through dense forest, the thing between you
//  and the camper is almost never the thing you came to look at. A conifer
//  bough half a metre from the lens fills a third of the screen; a birch trunk
//  cuts the camper in two. The frame is not wrong — that IS what standing
//  behind a camper in a wood looks like — it is simply not playable, and the
//  difference between a cozy drive and fighting the camera is entirely this.
//
//  ── the shape: BOTH of the two standard answers, because each alone fails ─
//
//    · A near-camera sphere (the cheap answer) clears the bough in your face,
//      and does nothing about the trunk the camper is parked behind fifteen
//      metres out.
//    · A camera-to-subject cone (the correct answer) clears that trunk, and
//      sails straight past the bough — because a bough owning the right third
//      of the frame is three or four metres off the view AXIS in world units
//      even while it is centimetres from the lens.
//
//  Both were built and both were photographed before this settled. The first
//  version tried to be tidy and express the near half as a floor under the cone
//  radius; the player's own conifer bough went straight through it, for the
//  reason above. So it is a max() of two shapes, which costs one extra
//  length() and is the thing that actually clears the frame:
//
//    max( sphere of radius `nearFull..nearNone` about the camera,
//         cone of radius `wide * t` from the camera to the subject )
//
//  The cone's radius being linear in t makes it a *constant angular* cone, i.e.
//  a fixed hole in screen space — literally the transparent frustum that was
//  asked for — and it closes before the subject so nothing beside or behind
//  the camper is touched.
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
//      that are actually hiding the camper, and only on the meshes doing the
//      hiding; every other frame is bit-identical to a build without this.
//      Measured over a frozen pose with a trunk squarely across the camper,
//      18.1 ms -> 18.2 ms; over a crag doing the same, 17.7 -> 17.7. See
//      `_gateOcclusion` in vegetation/Trees.js and rocks/Rocks.js, and
//      tools/_scratch/occsolid.mjs and occgate.mjs for both measurements.
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
//    vertexShader:   OCCLUDE_PARS   + `… vOcc = occludeFade( worldPos ); …`
//    fragmentShader: OCCLUDE_DITHER + `… occludeCut( vOcc ); …`
//
//  If your surface is OPAQUE and its shader is not already discarding, do not
//  opt in like that. Build a second material with the three lines in it, leave
//  the first one alone, and gate the swap on `occlusionTouchesSphere` /
//  `occlusionTouchesColumn` below — otherwise the whole draw loses early-Z in
//  every frame of the game to buy a fade that engages in very few of them.
//
//  MERGE WITH Object.assign, NOT THREE.UniformsUtils.merge(). merge() deep
//  clones, which would give your material a private copy of the target vector
//  that nothing ever writes to, and the effect would silently never appear on
//  it. Everything in this game that opts in uses Object.assign already.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

const DEFAULTS = {
  // ── (1) the near-camera sphere ───────────────────────────────────────────
  // Everything within `nearFull` metres of the lens is gone; nothing past
  // `nearNone` is touched.
  //
  // This is a SPHERE and not the near end of the cone, and the frames are what
  // decided that. The first build put a floor under the cone radius instead, on
  // the reasoning that one expression is tidier than two — and the conifer
  // bough in the top corner of the frame, the exact thing the player
  // photographed, sailed straight through it. A world-space radius around the
  // view axis is the wrong test for near clutter, because at a metre from the
  // lens EVERYTHING is in your face: a bough owning the right third of the
  // screen is three or four metres off-axis in world units and only centimetres
  // from your eye. Distance from the camera is the honest criterion for that
  // half of the problem, and it is also the cheap one.
  // 1.80 / 4.20, widened from 1.50 / 3.40 on a measurement that came out the
  // opposite way round to the prediction and is worth writing down, because it
  // inverts how this feature should be tuned.
  //
  // Interleaved A/B inside one page load (tools/_scratch/cost2.mjs, 8 blocks),
  // both arms with the feature ON, varying only the sphere:
  //
  //   cone only (sphere ~off)  vs  cone + sphere      p50 -0.60 ms, p95 -2.60
  //   sphere 1.5/3.4           vs  sphere 2.2/5.0     p50 -6.80 ms, p95 -10.20
  //
  // The near sphere does not cost frame time, it BUYS it. It discards
  // near-camera canopy overdraw, which is the single most expensive fill in the
  // game, and that outweighs the extra world it exposes behind the bough. The
  // cone is the half that costs: it dithers mid-field canopy and what it
  // uncovers is more scene rather than less.
  //
  // (The second row was taken on a badly contended machine — 34.7 ms frames
  // against ~21 on a quiet one — so read it as a ratio, not as milliseconds.
  // That is why this lands at 1.80 / 4.20 rather than at the 2.20 / 5.00 the
  // number would justify: the direction is well established across two tests,
  // the magnitude is not, and a 5 m clearing sphere against a 5.5 m minimum
  // chase distance would dissolve almost everything between the camera and the
  // camper at full zoom-in. Anyone re-measuring this on a quiet machine should
  // feel free to take the rest of it.)
  nearFull: 1.80,
  nearNone: 4.20,

  // ── (2) the cone to the subject ──────────────────────────────────────────
  // Radius at the subject, in metres. The camper's silhouette from behind is
  // about 1.2 m half-width and 1.3 m half-height; this is that plus enough
  // margin that the vehicle sits inside the *fully* cleared core rather than
  // in the feather, which is the difference between seeing it and seeing a
  // halftone of it.
  //
  // Price it against the subject and nothing else. The cone contributes a
  // CONSTANT fraction of the screen at every depth — wide / (D * tan(fov/2)) —
  // so a value picked for comfort rather than for the camper is a permanent
  // hole through the middle of the picture at every range. The first pass used
  // 3.40 and that is 55% of the half-height at a 12 m chase; the frame came
  // back looking screen-printed.
  wide: 2.40,
  // Width of the feather, as a fraction of the radius, shared by both shapes.
  // The brief for this feature is explicit that a tree which blinks out is
  // worse than one you can see past, so this is a band and not a line — but at
  // the 0.55 it started on, more than half the cone's area was in partial
  // dither at once. 0.35 still crosses a near trunk over a couple of
  // centimetres of screen.
  soft: 0.35,
  // Where the cone starts closing, as a fraction of the camera-to-subject
  // distance. Without it the cone carries on through the camper and dissolves
  // the cover immediately around the vehicle, which puts a bare patch under it
  // wherever it stands. 0.92 rather than the 0.86 of the first pass: at 0.86 a
  // bough half a metre in front of the camper was already outside the closing
  // cone and stayed drawn across the windscreen, which is the one thing this
  // must not do.
  taper: 0.92,
  // How far a fully-enclosed fragment goes. 1.0 is fully transparent.
  amount: 1.0,

  // ── engagement gates, applied on the CPU ─────────────────────────────────
  // The effect exists to keep one subject visible, so it has no business
  // running when that subject is not on screen. These also keep every
  // landscape capture in tools/shot.mjs (hero, peaks, forest, river …) bit
  // identical to what it was: the camper is either far away or well off the
  // view axis in all of them, and the frustum simply switches off.
  maxDist: 80.0,     // the chase wheel tops out at 68 m
  minDist: 2.0,
  minFacing: 0.86,   // cos ~31 deg off the view axis
  enabled: true,
};

// The largest extent any caller hands to occludeFadeAt, in metres. Leaf clumps
// are the big ones. Generous, because getting it wrong pops geometry rather
// than costing time.
const CLUMP_MARGIN = 8.0;

/** Runtime-tunable copy. Reachable as `window.__occlusion.params`. */
const PARAMS = { ...DEFAULTS };

// ONE uniform block, shared by reference across every material that opts in,
// so driving the subject each frame is a single vector write rather than a
// walk over a material set. This is why occlusionUniforms() hands back the
// same object every call instead of a clone.
const UNIFORMS = {
  uOccTarget: { value: new THREE.Vector3() },
  // x: nearFull, y: nearNone. Packed because these two are only ever read
  // together and a uniform slot is a uniform slot on the low tiers.
  uOccNear:   { value: new THREE.Vector2(DEFAULTS.nearFull, DEFAULTS.nearNone) },
  uOccWide:   { value: DEFAULTS.wide },
  uOccSoft:   { value: DEFAULTS.soft },
  uOccTaper:  { value: DEFAULTS.taper },
  // Squared radius beyond which nothing can be in either shape, so the shaders
  // can reject the overwhelming majority of the world with one dot product.
  // See the note where it is used.
  uOccFar2:   { value: 0 },
  // Starts at zero, and that is the off switch: every occludeFade() below
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
const _f = new THREE.Vector3();
const _cam = new THREE.Vector3();

/**
 * Point the frustum at the thing that must stay visible, once per frame.
 *
 * @param {THREE.Camera} camera  the camera being rendered
 * @param {THREE.Vector3|null} pos  the subject's world position, or null/absent
 *                                  to switch the effect off for this frame
 */
export function setOcclusionTarget(camera, pos) {
  if (!pos || !camera || !PARAMS.enabled) { UNIFORMS.uOccAmount.value = 0; return; }
  // The CPU mirror below needs the same lens the shader gets it from three's
  // own `cameraPosition`. Copied on every engaged frame, and never read while
  // uOccAmount is 0.
  _cam.copy(camera.position);

  // Nothing to keep visible if the subject is not in front of us. Cheap, and
  // it is what makes this safe to leave switched on in every capture and in
  // the developer fly camera.
  _d.copy(pos).sub(camera.position);
  const dist = _d.length();
  if (dist < PARAMS.minDist || dist > PARAMS.maxDist) {
    UNIFORMS.uOccAmount.value = 0;
    return;
  }
  camera.getWorldDirection(_f);
  if (_d.dot(_f) / dist < PARAMS.minFacing) { UNIFORMS.uOccAmount.value = 0; return; }

  UNIFORMS.uOccTarget.value.copy(pos);
  UNIFORMS.uOccNear.value.set(PARAMS.nearFull, Math.max(PARAMS.nearNone, PARAMS.nearFull + 0.01));
  UNIFORMS.uOccWide.value  = PARAMS.wide;
  UNIFORMS.uOccSoft.value  = PARAMS.soft;
  UNIFORMS.uOccTaper.value = PARAMS.taper;
  UNIFORMS.uOccAmount.value = PARAMS.amount;

  // ── the early rejection radius ───────────────────────────────────────────
  // Both shapes are small and both are near the camera; the forest is not. A
  // point inside the cone has along-axis depth below the subject distance and
  // radial offset below `wide`, so it cannot be further than
  // sqrt(dist^2 + wide^2) from the camera — a hair over `dist`. A point inside
  // the sphere cannot be further than nearNone plus its own extent, and the
  // largest extent any caller passes is a leaf clump of a few metres.
  //
  // So one squared-distance compare at the top of occludeFadeAt rejects
  // essentially every tree and shrub in the frame, which at a 19 m chase and a
  // 900 m draw distance is almost all of them. This is where the vertex cost of
  // the feature went.
  const far = Math.max(dist + 1.0, PARAMS.nearNone + CLUMP_MARGIN);
  UNIFORMS.uOccFar2.value = far * far;
}

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
//  nothing is in the frustum, every mesh keeps the discard-free program, and
//  the build is bit-identical to one that never had this. The swap is what
//  makes the answer to the player's request affordable, and these three
//  functions are what decide it.
//
//  All three are CONSERVATIVE: they may say yes where the shader's own fade
//  turns out to be 1.0 everywhere on the surface, and that costs a program
//  swap and nothing else. They must never say no where the shader would fade,
//  because that is a solid trunk in the middle of the frame — so every margin
//  here is spent in the same direction, and the cone test drops the taper (a
//  term that only ever narrows the cone) for the same reason.

/** GLSL smoothstep, so the mirror below reads like the shader it mirrors. */
function sstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Is the frustum switched on this frame at all? False in every capture, in the
 * fly camera, and whenever the camper is off-axis or out of range — which is
 * the cheap first line of every gate.
 */
export function occlusionActive() { return UNIFORMS.uOccAmount.value > 0; }

/**
 * `occludeFadeAt` from the GLSL above, in JS. 1.0 = untouched.
 *
 * Kept alongside the shader string rather than in the consumers, because the
 * one thing that must not happen to these two is that they drift.
 */
export function occlusionFadeAt(x, y, z, radius = 0) {
  const amt = UNIFORMS.uOccAmount.value;
  if (amt <= 0) return 1;
  const rx = x - _cam.x, ry = y - _cam.y, rz = z - _cam.z;
  const d2 = rx * rx + ry * ry + rz * rz;
  if (d2 > UNIFORMS.uOccFar2.value) return 1;

  const n = UNIFORMS.uOccNear.value;
  let m = 1 - sstep(n.x, n.y, Math.max(Math.sqrt(d2) - radius, 0));

  const t3 = UNIFORMS.uOccTarget.value;
  const ax = t3.x - _cam.x, ay = t3.y - _cam.y, az = t3.z - _cam.z;
  const len2 = ax * ax + ay * ay + az * az;
  if (len2 >= 1) {
    const t = (rx * ax + ry * ay + rz * az) / len2;
    if (t > 0 && t < 1) {
      const r = UNIFORMS.uOccWide.value * t * (1 - sstep(UNIFORMS.uOccTaper.value, 1, t));
      const r1 = Math.max(r, 1e-3);
      const r0 = r1 * (1 - Math.max(UNIFORMS.uOccSoft.value, 0.02));
      const ox = rx - ax * t, oy = ry - ay * t, oz = rz - az * t;
      m = Math.max(m, 1 - sstep(r0 * r0, r1 * r1, ox * ox + oy * oy + oz * oz));
    }
  }
  return 1 - amt * m;
}

/**
 * Does a sphere reach into either shape?
 *
 * Not `occlusionFadeAt(centre) < 1`: a rock whose centre is fifteen metres away
 * can still have a face against the lens, and that face is the whole reason
 * this feature exists. The sphere's own radius is therefore subtracted from
 * both tests, the cone is measured at the furthest `t` the sphere can reach
 * rather than at its centre's, and the taper is ignored.
 */
export function occlusionTouchesSphere(x, y, z, radius) {
  if (UNIFORMS.uOccAmount.value <= 0) return false;
  const rx = x - _cam.x, ry = y - _cam.y, rz = z - _cam.z;
  const d2 = rx * rx + ry * ry + rz * rz;
  const far = Math.sqrt(UNIFORMS.uOccFar2.value) + radius;
  if (d2 > far * far) return false;
  if (Math.sqrt(d2) - radius < UNIFORMS.uOccNear.value.y) return true;

  const t3 = UNIFORMS.uOccTarget.value;
  const ax = t3.x - _cam.x, ay = t3.y - _cam.y, az = t3.z - _cam.z;
  const len2 = ax * ax + ay * ay + az * az;
  if (len2 < 1) return false;
  const slack = radius / Math.sqrt(len2);
  let t = (rx * ax + ry * ay + rz * az) / len2;
  if (t + slack <= 0 || t - slack >= 1) return false;
  t = Math.min(1, Math.max(0, t));
  const ox = rx - ax * t, oy = ry - ay * t, oz = rz - az * t;
  const off = Math.sqrt(ox * ox + oy * oy + oz * oz);
  return off - radius < UNIFORMS.uOccWide.value * Math.min(1, t + slack);
}

/**
 * Does a vertical capsule — a tree, standing on the ground — reach into either
 * shape? (x, z) is its axis, y0..y1 its extent, `radius` its widest reach.
 *
 * Stepped as a chain of spheres rather than solved, because the cone's radius
 * grows along its own axis and the nearest point of the capsule to that axis
 * is therefore not the point of deepest engagement. Each sphere is inflated by
 * half the step so the chain covers the capsule with nothing between the
 * beads, which is what makes a coarse step safe: at most it costs a swap on a
 * tree whose bark turns out not to fade.
 */
export function occlusionTouchesColumn(x, z, y0, y1, radius) {
  if (UNIFORMS.uOccAmount.value <= 0) return false;
  // One horizontal reject before any of it. The volume lives within `far` of
  // the lens and a column outside that in plan cannot be inside it at any
  // height.
  const far = Math.sqrt(UNIFORMS.uOccFar2.value) + radius;
  const dx = x - _cam.x, dz = z - _cam.z;
  if (dx * dx + dz * dz > far * far) return false;

  const span = Math.max(y1 - y0, 0.001);
  const n = Math.min(24, Math.max(1, Math.ceil(span / 2)));
  const step = span / n;
  const r = radius + step * 0.5;
  for (let i = 0; i < n; i++) {
    if (occlusionTouchesSphere(x, y0 + step * (i + 0.5), z, r)) return true;
  }
  return false;
}

// ── the shape, for any shader stage ──────────────────────────────────────────
// Usable in a vertex or a fragment shader; `cameraPosition` is in three's own
// prefix for both. Guarded because a material may reach this string twice
// (once itself, once through a chunk that also carries it) and a redefinition
// is a link failure, not a warning — see the block comment in Stylize.js about
// the day that took grass, bark and the canopy off the air at once.
export const OCCLUDE_PARS = /* glsl */`
#ifndef OCCLUDE_DECLARED
#define OCCLUDE_DECLARED
uniform vec3  uOccTarget;
uniform vec2  uOccNear;    // x: fully gone inside this, y: untouched outside it
uniform float uOccWide;
uniform float uOccSoft;
uniform float uOccTaper;
uniform float uOccAmount;
uniform float uOccFar2;

// 1.0 = untouched, 0.0 = fully out of the way. wp is a world-space position;
// the radius argument is the caller's own extent, subtracted from the
// near-sphere test so a several-metre billboard clump the camera is standing
// inside is treated as being in your face rather than as a point two metres
// away. Pass 0.0 for a surface small enough to be a point, which is what
// occludeFade() below does.
//
// Two shapes, combined with max(): a sphere around the camera for near clutter
// and a cone to the subject for what the camper is actually parked behind. See
// the note beside nearFull in the JS — neither one alone clears the frame the
// player photographed.
//
// The cone's radial test is done in SQUARED distance. It is the one place a
// second square root could hide, this runs per vertex on the two largest
// geometry populations in the game, and squaring only reshapes the feather —
// which is a soft band whose exact profile nothing depends on. The sphere keeps
// its root because the radius has to be subtracted in linear units.
//
// Every division is guarded, and that is not decoration: a fade built on a
// divide is this project's classic source of non-finite pixels, and
// tools/nanhunt.mjs is run against it. len2 is rejected below 1; the smoothstep
// edges are forced apart by construction, so the degenerate edge0 == edge1 case
// cannot arise however the parameters are tuned at runtime.
float occludeFadeAt( vec3 wp, float radius ) {
  if ( uOccAmount <= 0.0 ) return 1.0;
  vec3 rel = wp - cameraPosition;

  // Reject everything past both shapes with one dot product, before any root or
  // smoothstep. Both shapes live within a few metres of a subject that is
  // itself only a chase length away, and the forest runs to 900 m, so this
  // rejects almost every vertex it is asked about. See the note beside
  // uOccFar2 in setOcclusionTarget.
  float d2 = dot( rel, rel );
  if ( d2 > uOccFar2 ) return 1.0;

  // (1) near-camera sphere.
  float m = 1.0 - smoothstep( uOccNear.x, uOccNear.y, max( sqrt( d2 ) - radius, 0.0 ) );

  // (2) cone to the subject.
  vec3 axis = uOccTarget - cameraPosition;
  float len2 = dot( axis, axis );
  if ( len2 >= 1.0 ) {
    float t = dot( rel, axis ) / len2;         // 0 at the camera, 1 at the subject
    if ( t > 0.0 && t < 1.0 ) {                // behind us, or past the subject
      // Linear in t, i.e. a fixed hole in screen space — literally the frustum
      // that was asked for — shut down by the taper before it reaches the
      // subject so the ground the camper stands on keeps its cover.
      float r  = uOccWide * t * ( 1.0 - smoothstep( uOccTaper, 1.0, t ) );
      float r1 = max( r, 1e-3 );
      float r0 = r1 * ( 1.0 - max( uOccSoft, 0.02 ) );
      vec3  off = rel - axis * t;
      m = max( m, 1.0 - smoothstep( r0 * r0, r1 * r1, dot( off, off ) ) );
    }
  }
  return 1.0 - uOccAmount * m;
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
//   node tools/shot.mjs --view … --eval "window.__occlusion.params.wide = 5.0"
if (typeof window !== 'undefined') {
  window.__occlusion = { params: PARAMS, uniforms: UNIFORMS, setTarget: setOcclusionTarget };
}
