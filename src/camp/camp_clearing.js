// ─────────────────────────────────────────────────────────────────────────────
//  camp_clearing — the record of where the camp is, and the one uniform that
//  makes the grass and the ground cover get out of its way.
//
//  The obvious implementation is to re-scatter: tell Grass and GroundCover that
//  a region changed and let them rebuild the affected tiles with the camp in
//  their density field, the way `RoadMask` already works. That is the *right*
//  answer for something baked into the world, and the wrong one here, because
//  the player places a camp at runtime while driving. A grass tile costs
//  several milliseconds to fill and the clearing spans a dozen of them across
//  three rings; rebuilding them is a visible hitch at the exact moment the
//  player is being shown something new. GroundCover is worse — its cells are
//  built on a frame budget and would trickle in over a second or two, so the
//  shrubs would visibly evaporate one at a time after the camp appeared.
//
//  So the clearing is a *shader* fact, not a scatter fact: one vec4 that every
//  grass ring and every cover instance already-built or built later reads, and
//  the plants inside it shrink to nothing on the frame it is published. No
//  rebuild, no hitch, and — because it is continuous — it can animate, which is
//  what lets the clearing sweep open over three quarters of a second instead of
//  popping.
//
//  Shape of the clearing:  vec4( centreX, centreZ, radius, feather )
//  Everything inside `radius - feather` is bare; the fringe between there and
//  `radius` thins out. Nothing here is a hard circle — see `campCover()`.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

/**
 * The live clearing, shared by reference with every material that patches it in.
 *
 * `w` (feather) doubles as the enable flag: radius 0 means no camp, and the
 * GLSL below early-outs on it, so the cost when no camp exists is one uniform
 * fetch and one compare.
 */
export const campSite = {
  uCampSite: { value: new THREE.Vector4(0, 0, 0, 1) },
  // How much vegetation survives at the very centre of the clearing.
  //
  // 0 while a camp is pitched — the ground is bare. It exists for the *aiming*
  // state, and that turned out to matter more than it sounds. The placement
  // reticle is a 13 cm ribbon lying 6 cm off the ground, and the first time the
  // feature was driven through the real input path the ribbon was completely
  // invisible: the meadow's grass canopy is half a metre tall, so the ring was
  // simply inside it. Brightening it or lifting it clear are both fixes that
  // turn a diegetic mark on the ground into a UI overlay floating in the air.
  //
  // Thinning the grass a little where the player is aiming fixes the
  // legibility, and it is also just a better idea: the ground *ghosts* clear
  // under the reticle, so what the player sees before they commit is the shape
  // of the thing they are about to make.
  uCampFloor: { value: 0 },
};

/**
 * Set the clearing. Radius 0 clears it.
 * `floor` is how much vegetation survives at the centre — 0 when pitched,
 * ~0.6 while aiming. See the note on `uCampFloor` above.
 */
export function setCampSite(x, z, radius, feather = 2.6, floor = 0) {
  campSite.uCampSite.value.set(x, z, radius, Math.max(0.35, feather));
  campSite.uCampFloor.value = floor;
}

export function getCampSite() {
  return campSite.uCampSite.value;
}

/**
 * GLSL: `campCover(worldXZ)` returns 1 outside the camp and 0 at its centre.
 *
 * The edge is deliberately not a circle. A clearing with a circular boundary
 * reads as a decal the instant you see any of it in one frame, and this
 * project has forty archived review rounds whose single most repeated finding
 * is that a critic sees a hard or regular edge before it sees anything else.
 * Two octaves of angular wobble — one slow lobe that makes the clearing an
 * irregular blob, one faster that gives it a ragged fringe — cost four sin()
 * calls and remove the tell completely.
 *
 * Wobble is a function of the angle around the centre only, so it is stable in
 * world space: the fringe does not swim when the camera moves, which a
 * position-noise version would do at grazing angles.
 */
export const CAMP_CLEARING_GLSL = /* glsl */`
uniform vec4  uCampSite;    // x, z, radius, feather
uniform float uCampFloor;   // vegetation surviving at the centre: 0 pitched, ~0.6 aiming

float campCover( vec2 wxz ) {
  if ( uCampSite.z <= 0.0 || uCampFloor >= 1.0 ) return 1.0;
  vec2 d = wxz - uCampSite.xy;
  float r = length( d );
  // Cheap early-out for the whole valley outside the camp.
  if ( r > uCampSite.z + 4.0 ) return 1.0;
  float a = atan( d.y, d.x );
  float wob = sin( a * 2.0 + 1.7 ) * 0.115
            + sin( a * 3.0 - 0.6 ) * 0.075
            + sin( a * 7.0 + 2.3 ) * 0.038;
  float R = uCampSite.z * ( 1.0 + wob );
  return mix( uCampFloor, 1.0, smoothstep( R - uCampSite.w, R, r ) );
}
`;

/**
 * The same function on the CPU, for the scatter and layout code that has to
 * agree with what the shader draws — the dirt decal's own edge, and the test
 * for whether a prop is standing on bare ground.
 *
 * Keep these two in step. A mismatch here is a rim of grass growing through the
 * dirt disc, which is the kind of defect that looks like a z-fighting bug.
 */
export function campCoverAt(x, z) {
  const s = campSite.uCampSite.value;
  if (s.z <= 0) return 1;
  const dx = x - s.x, dz = z - s.y;
  const r = Math.hypot(dx, dz);
  if (r > s.z + 4) return 1;
  const a = Math.atan2(dz, dx);
  const wob = Math.sin(a * 2 + 1.7) * 0.115
            + Math.sin(a * 3 - 0.6) * 0.075
            + Math.sin(a * 7 + 2.3) * 0.038;
  const R = s.z * (1 + wob);
  const t = (r - (R - s.w)) / Math.max(s.w, 1e-4);
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const e = k * k * (3 - 2 * k);
  const f = campSite.uCampFloor.value;
  return f + (1 - f) * e;
}

/** The clearing's outer radius including the wobble — for culling and layout. */
export function campOuterRadius() {
  const s = campSite.uCampSite.value;
  return s.z <= 0 ? 0 : s.z * 1.23;
}
