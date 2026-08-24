// ─────────────────────────────────────────────────────────────────────────────
//  sky_objects — the things in the dome that are worth finding, in JS.
//
//  ── why this file is a copy, and what keeps it honest ──────────────────────
//
//  The planets and the galaxies are drawn entirely in the sky shader: their
//  positions are `#define`s and literal arguments inside `PLANET_GLSL` and
//  `GALAXY_GLSL`, and no JavaScript has ever needed to know where they are.
//  Awarding a discovery for pointing the telescope AT one does need to know, so
//  this file mirrors those constants.
//
//  A mirrored constant is a constant that will drift, so:
//
//   · The numbers below are the ONLY duplicated values, and each carries the
//     file and the symbol it was copied from.
//   · `tools/_scratch/skytargets.mjs` (see the header of that script) compares
//     what this file computes against where the shader actually puts light, and
//     is the check to re-run after touching either side.
//   · If they do drift, the failure is small and quiet — a discovery that needs
//     the eyepiece a degree off centre. Nothing renders differently.
//
//  The alternative was making the sky publish its own catalogue, which means
//  moving the placement out of GLSL and into a uniform array for the benefit of
//  a feature that reads it eight times a session. Filed as the better long-term
//  shape in docs/INTEGRATION_REQUESTS.md; not worth it today.
//
//  ── the names ───────────────────────────────────────────────────────────────
//  The planets are the four the shader's own header calls them by. The galaxies
//  have never been named anywhere, so they are named here, by what they look
//  like through this telescope — which is how everything in the sky got its
//  name in the first place.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

const DEG = Math.PI / 180;

// src/sky/planets.js — PL_POLE
const PL_POLE = new THREE.Vector3(-0.62, 0.57, 0.54).normalize();

/** src/sky/planets.js — plDir(lon, lat), transcribed. */
function plDir(lon, lat) {
  const u = new THREE.Vector3().crossVectors(PL_POLE, new THREE.Vector3(0, 1, 0)).normalize();
  const v = new THREE.Vector3().crossVectors(PL_POLE, u);
  return new THREE.Vector3()
    .addScaledVector(u, Math.cos(lon) * Math.cos(lat))
    .addScaledVector(v, Math.sin(lon) * Math.cos(lat))
    .addScaledVector(PL_POLE, Math.sin(lat))
    .normalize();
}

/**
 * Everything a player can find at the eyepiece.
 *
 * `rad` is the object's own angular RADIUS in degrees — for the planets the
 * disc from `plPlanets`, for the galaxies the semi-major axis from
 * `gxGalaxies`. It widens the target so that centring a big face-on spiral
 * counts the same as centring a planet that is a tenth its size.
 *
 * `dir` is a fixed world direction. The moon moves with the day, so it carries
 * `live` instead and is resolved against SKY_STATE each frame.
 */
export const SKY_OBJECTS = [
  // src/sky/planets.js — plPlanets(), in call order. Radii are the `radA`
  // argument in degrees; the names are from that function's own header.
  { id: 'venus',   label: 'Venus',   dir: plDir(3.70,  0.050), rad: 0.052,
    note: 'the brightest thing in the sky after the moon' },
  { id: 'jupiter', label: 'Jupiter', dir: plDir(4.35, -0.040), rad: 0.075,
    note: 'four moons strung out in a line beside it' },
  { id: 'mars',    label: 'Mars',    dir: plDir(5.05,  0.070), rad: 0.046,
    note: 'found by its colour, not its brightness' },
  { id: 'saturn',  label: 'Saturn',  dir: plDir(5.62, -0.050), rad: 0.060,
    note: 'rings, and two moons' },

  // src/sky/galaxies.js — GX_DIR_A/B/C, with the semi-major axes from the
  // three gxSpiral calls.
  { id: 'spiral',    label: 'the Great Spiral', rad: 1.35,
    dir: new THREE.Vector3(0.709, 0.500, -0.497).normalize(),
    note: 'a grand design, seen at an angle' },
  { id: 'pinwheel',  label: 'the Pinwheel',     rad: 0.80,
    dir: new THREE.Vector3(-0.736, 0.438, 0.516).normalize(),
    note: 'four loose arms, face on' },
  { id: 'companion', label: 'the Companion',    rad: 0.46,
    dir: new THREE.Vector3(0.063, 0.695, -0.716).normalize(),
    note: 'a small edge-on smudge near the Great Spiral' },

  // src/render/Lighting.js — SKY_STATE.moonDir. 2.0 degrees across per
  // moon.js's header, so a one degree radius.
  { id: 'moon', label: 'the Moon', rad: 1.0, live: 'moonDir',
    note: 'craters along the terminator' },
];

export const SKY_TOTAL = SKY_OBJECTS.length;

/** Look up a target's label without walking the table at every call site. */
const BY_ID = new Map(SKY_OBJECTS.map((o) => [o.id, o]));
export const skyLabel = (id) => BY_ID.get(id)?.label ?? id;

/**
 * Which target the telescope is pointed at, or null.
 *
 * `fovDeg` is the eyepiece's current field of view, and the tolerance scales
 * with it for the reason every other pointing test in this game does: what the
 * player means by "I am looking at it" is a fraction of what they can see, not
 * a fixed number of degrees. An eighth of the field, floored so that a planet
 * three hundredths of a degree wide is still catchable at full zoom, and
 * widened by the object's own size so the big soft ones are not harder to claim
 * than the small hard ones.
 *
 * @param dir    unit view direction, world space
 * @param fovDeg current eyepiece field of view
 * @param state  SKY_STATE, for the moon
 */
export function skyTargetAt(dir, fovDeg, state) {
  const tol = Math.max(0.55, fovDeg * 0.125);
  let best = null, bestAng = Infinity;
  for (const o of SKY_OBJECTS) {
    let d = o.dir;
    if (o.live) {
      d = state?.[o.live];
      // A moon under the skyline is not a moon anyone is looking at, and the
      // sky does not draw it there either.
      if (!d || d.y <= 0.02) continue;
    }
    const cos = THREE.MathUtils.clamp(dir.dot(d), -1, 1);
    const ang = Math.acos(cos) / DEG;
    if (ang < tol + o.rad && ang < bestAng) { best = o; bestAng = ang; }
  }
  return best;
}
