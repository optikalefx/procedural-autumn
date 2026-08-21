// ─────────────────────────────────────────────────────────────────────────────
//  camp_clearing — the record of where the camps are, and the one uniform block
//  that makes the grass and the ground cover get out of their way.
//
//  The obvious implementation is to re-scatter: tell Grass and GroundCover that
//  a region changed and let them rebuild the affected tiles with the camp in
//  their density field, the way `RoadMask` already works. That is the *right*
//  answer for something baked into the world, and the wrong one here, because
//  the player places a camp at runtime while driving. A grass tile costs
//  several milliseconds to fill and a clearing spans a dozen of them across
//  three rings; rebuilding them is a visible hitch at the exact moment the
//  player is being shown something new. GroundCover is worse — its cells are
//  built on a frame budget and would trickle in over a second or two, so the
//  shrubs would visibly evaporate one at a time after the camp appeared.
//
//  So a clearing is a *shader* fact, not a scatter fact: a small array of vec4s
//  that every grass ring and every cover instance already-built or built later
//  reads, and the plants inside them shrink to nothing on the frame they are
//  published. No rebuild, no hitch, and — because it is continuous — it can
//  animate, which is what lets a clearing sweep open over three quarters of a
//  second instead of popping.
//
//  ── why this is an array and was not ────────────────────────────────────────
//
//  It held exactly one camp until the player said: "if I forget to pack up
//  camp, I can't make a new camp elsewhere. Let's not make that a requirement.
//  I can make as many camps as I want as long as they aren't right next to each
//  other." Which is obviously right — the single slot was an implementation
//  detail wearing a design decision's clothes.
//
//  `CAMP_SLOTS` is what the SHADER can hold, not what the world can. Camp.js
//  keeps as many camps as it likes and uploads the nearest few, because a
//  clearing only has to suppress vegetation that exists, and grass stops at
//  about a hundred metres. A camp further away than that needs no slot at all —
//  its dirt is still drawn, there is simply no grass left there to hide.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

/**
 * How many clearings the vegetation shaders can suppress at once.
 *
 * Four, and the number is a cost decision. `campCover` runs per vertex on the
 * largest geometry population in the game — three grass rings, hundreds of
 * thousands of blades — so the loop has to be short and every iteration has to
 * be able to leave early. Four covers every case a player can see at once: the
 * camps are separated by at least the sum of their radii, so a fifth is either
 * beyond the grass or beyond the horizon.
 */
export const CAMP_SLOTS = 4;

const EMPTY = () => new THREE.Vector4(0, 0, 0, 1);

export const campSite = {
  // x, z, radius, feather — per pitched camp. radius 0 means the slot is unused.
  uCampSites: { value: Array.from({ length: CAMP_SLOTS }, EMPTY) },

  // The placement preview, which is deliberately NOT one of the slots above.
  //
  // It is not a camp, it is a proposal, and it behaves differently in the one
  // way that matters: it only thins the grass rather than clearing it. That
  // turned out to matter more than it sounds. The placement reticle is a 13 cm
  // ribbon lying 6 cm off the ground, and the first time the feature was driven
  // through the real input path the ribbon was completely invisible — the
  // meadow's canopy is half a metre tall, so the ring was simply inside it.
  // Brightening it or lifting it clear both turn a diegetic mark on the ground
  // into a UI overlay floating in the air. Thinning the grass under it fixes
  // the legibility and is also just a better idea: the ground GHOSTS clear
  // where the player is aiming, so what they see before they commit is the
  // shape of the thing they are about to make.
  uCampAim: { value: EMPTY() },
  // How much vegetation survives at the centre of the preview. 1 disables it.
  uCampAimFloor: { value: 1 },
};

/**
 * Publish the pitched camps. Pass at most `CAMP_SLOTS` of them; the rest are
 * blanked. Each entry is `{ x, z, radius, feather }`.
 */
export function setCampSlots(list) {
  const v = campSite.uCampSites.value;
  for (let i = 0; i < CAMP_SLOTS; i++) {
    const c = list[i];
    if (c && c.radius > 0) v[i].set(c.x, c.z, c.radius, Math.max(0.35, c.feather));
    else v[i].set(0, 0, 0, 1);
  }
}

/** Publish the placement preview. `floor` of 1 turns it off. */
export function setCampAim(x, z, radius, feather = 1.2, floor = 0.42) {
  campSite.uCampAim.value.set(x, z, radius, Math.max(0.35, feather));
  campSite.uCampAimFloor.value = floor;
}

export function clearCampAim() {
  campSite.uCampAim.value.set(0, 0, 0, 1);
  campSite.uCampAimFloor.value = 1;
}

// The clearing's outline. Deliberately not a circle: a clearing with a circular
// boundary reads as a decal the instant you see any of it in one frame, and
// this project has forty archived review rounds whose single most repeated
// finding is that a critic sees a hard or regular edge before it sees anything
// else. Two octaves of angular wobble — one slow lobe that makes the clearing
// an irregular blob, one faster that gives it a ragged fringe — cost four sin()
// calls and remove the tell completely.
//
// Wobble is a function of the angle around the centre only, so it is stable in
// world space: the fringe does not swim when the camera moves, which a
// position-noise version would do at grazing angles.
const WOBBLE_GLSL = /* glsl */`
float campWobble( float a ) {
  return sin( a * 2.0 + 1.7 ) * 0.115
       + sin( a * 3.0 - 0.6 ) * 0.075
       + sin( a * 7.0 + 2.3 ) * 0.038;
}
float campCoverOne( vec2 wxz, vec4 s, float floorV ) {
  vec2 d = wxz - s.xy;
  float r = length( d );
  // Cheap early-out for the whole valley outside this clearing. It is what
  // makes a four-slot loop cost about as much as one slot for the 99% of the
  // world's grass that is nowhere near a camp.
  if ( r > s.z + 4.0 ) return 1.0;
  float R = s.z * ( 1.0 + campWobble( atan( d.y, d.x ) ) );
  return mix( floorV, 1.0, smoothstep( R - s.w, R, r ) );
}
`;

/**
 * GLSL: `campCover(worldXZ)` returns 1 outside every camp and 0 at the centre
 * of one. The minimum over all of them, so overlapping clearings merge rather
 * than fighting.
 */
export const CAMP_CLEARING_GLSL = /* glsl */`
uniform vec4  uCampSites[ ${CAMP_SLOTS} ];
uniform vec4  uCampAim;
uniform float uCampAimFloor;

${WOBBLE_GLSL}

float campCover( vec2 wxz ) {
  float c = 1.0;
  for ( int i = 0; i < ${CAMP_SLOTS}; i++ ) {
    vec4 s = uCampSites[ i ];
    if ( s.z <= 0.0 ) continue;
    c = min( c, campCoverOne( wxz, s, 0.0 ) );
  }
  if ( uCampAim.z > 0.0 && uCampAimFloor < 1.0 ) {
    c = min( c, campCoverOne( wxz, uCampAim, uCampAimFloor ) );
  }
  return c;
}
`;

/**
 * The same function on the CPU, for the code that has to agree with what the
 * shader draws — the dirt mesh's own edge, and the test for whether a prop is
 * standing on bare ground.
 *
 * Keep these two in step. A mismatch here is a rim of grass growing through the
 * dirt, which is the kind of defect that looks like a z-fighting bug.
 */
export function campCoverAt(x, z) {
  let c = 1;
  const v = campSite.uCampSites.value;
  for (let i = 0; i < CAMP_SLOTS; i++) {
    const s = v[i];
    if (s.z <= 0) continue;
    c = Math.min(c, coverOne(x, z, s, 0));
    if (c <= 0) return 0;
  }
  const aim = campSite.uCampAim.value;
  const floor = campSite.uCampAimFloor.value;
  if (aim.z > 0 && floor < 1) c = Math.min(c, coverOne(x, z, aim, floor));
  return c;
}

function coverOne(x, z, s, floor) {
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
  return floor + (1 - floor) * e;
}

/** The outer radius of a clearing including its wobble — for culling. */
export function campOuterRadius(radius) {
  return radius <= 0 ? 0 : radius * 1.23;
}
