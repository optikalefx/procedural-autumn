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
//  Two mechanisms, because the game has two kinds of surface and only one of
//  them can afford a discard:
//
//    · Foliage and bark are ALPHA-TESTED. A naive opacity fade does nothing on
//      an alpha-tested material (there is no blending to fade into) and an
//      alpha-test ramp pops. Dithered screen-door transparency is the standard
//      answer for this look, costs a handful of ALU, and — unlike real
//      transparency — needs no sort and does not disturb the render order the
//      rest of the game is tuned against. Those shaders already discard, so
//      early-Z is already off for them and the discard is genuinely free.
//    · Ground cover is opaque. Adding a discard there would cost early-Z on a
//      surface that has it, so instead it reuses the shrink-toward-the-root
//      that `coverFade` in shaders/cover_material.js already does at the
//      visibility limit: a plant in the way sinks into the ground. Vertex-side
//      only, no fragment cost at all, and it is the idiom that file already
//      speaks.
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

/**
 * Point the frustum at the thing that must stay visible, once per frame.
 *
 * @param {THREE.Camera} camera  the camera being rendered
 * @param {THREE.Vector3|null} pos  the subject's world position, or null/absent
 *                                  to switch the effect off for this frame
 */
export function setOcclusionTarget(camera, pos) {
  if (!pos || !camera || !PARAMS.enabled) { UNIFORMS.uOccAmount.value = 0; return; }

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
// An ordered 4x4 Bayer threshold. Written as arithmetic on the wrapped
// coordinate rather than the usual fract(x*0.5 + y*y*0.75) one-liner, because
// that form squares the raw fragment coordinate: at 4K the y term reaches 3e6,
// where a float32 has a spacing of 0.25 and the pattern it is supposed to
// reproduce has a step of exactly 0.25. Taking the mod first keeps every
// intermediate under 16 and costs nothing.
export const OCCLUDE_DITHER = /* glsl */`
#ifndef OCCLUDE_DITHER_DECLARED
#define OCCLUDE_DITHER_DECLARED
float occBayer2( float x, float y ) { return mod( 2.0 * x + 3.0 * y, 4.0 ); }
float occBayer4( vec2 p ) {
  vec2 q = mod( floor( p ), 4.0 );
  vec2 h = floor( q * 0.5 );
  vec2 l = mod( q, 2.0 );
  return ( 4.0 * occBayer2( l.x, l.y ) + occBayer2( h.x, h.y ) ) * 0.0625;
}
// The early-out is the important line, not a tidiness. In any given frame the
// overwhelming majority of canopy fragments are nowhere near the frustum and
// carry fade == 1.0 exactly, and the canopy is the heaviest fill in the game;
// without this every one of them evaluated the Bayer threshold to discover it
// had nothing to do. It also means a switched-off build pays a single compare
// rather than the whole pattern.
//
// The threshold tops out at 15/16, so a fade of 1.0 could never discard anyway
// — the early-out changes cost, not behaviour, and a material that is switched
// off stays bit-identical to one that never had this.
void occludeCut( float fade ) {
  if ( fade >= 1.0 ) return;
  if ( fade <= occBayer4( gl_FragCoord.xy ) ) discard;
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
