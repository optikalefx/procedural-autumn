// ─────────────────────────────────────────────────────────────────────────────
//  moon — GLSL for the lit crescent, its earthshine, its maria and its halo.
//
//  Read the reference plates before changing any number here. `night.jpg` and
//  `night3.jpg` are both *built around* the moon: it is the brightest thing in
//  either frame by a wide margin, it is the only element that blooms, and the
//  halo around it is several times the width of the disc. Take the halo away
//  and the disc is a 14-pixel white dot; take the disc away and the halo alone
//  still reads as a moon behind haze. The halo is the part that sells it.
//
//  ── the terminator is an ellipse ───────────────────────────────────────────
//  The single most common way to get a crescent wrong is to cut the disc with a
//  straight chord. That is the shape you get by intersecting two circles, and
//  the eye reads it instantly as a cookie-cutter bite rather than as a sphere
//  lit from the side. The real terminator is the projection of the great circle
//  where the lit and unlit hemispheres meet, and its projection onto the disc
//  is a half-ellipse: x_t(y) = k * sqrt(1 - y^2), with k = 1 - 2*illuminated.
//  It meets the limb tangentially at both horns, which is exactly the detail
//  that reads as roundness.
//
//  ── which way the crescent points ──────────────────────────────────────────
//  The lit side is built from the sun direction, projected into the plane of
//  the disc, rather than from a fixed screen axis. That costs two dot products
//  and means the horns always point away from where the sun actually is — so
//  as the sun sinks further under the horizon through the evening, the crescent
//  rotates, for free and correctly.
//
//  ── earthshine ────────────────────────────────────────────────────────────
//  Both plates show the unlit part of the disc as a very faint disc rather than
//  as nothing: sunlight bounced off the Earth. It is worth having for one
//  reason — it makes the moon a *sphere with a lit side* instead of a crescent-
//  shaped decal. Keep it just above the point where it disappears.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apparent diameter, in degrees.
 *
 * The real one is 0.52 deg and the brief measures the plates at "roughly 1.2".
 * Re-measured off `night.jpg`: the disc spans about 115 px of a 2694 px frame
 * covering an estimated 60 deg, i.e. nearer 2.5 deg. Both plates exaggerate,
 * and they have to — at 0.52 deg a 1600 px wide frame gives a moon nine pixels
 * across, which cannot carry a crescent, let alone maria. 2.0 is the smallest
 * value at which the ellipse of the terminator is still legible at 1600x900,
 * which is the resolution this is reviewed at.
 */
export const MOON_GLSL = /* glsl */`
#define MN_RADIUS 0.017453   // half of 2.0 deg, in radians

// Illuminated fraction from the published phase.
//
// The contract says 0 = new, 0.5 = full, 1 = new, and Lighting publishes 0.32
// with the comment "the plates' crescent". Under the astronomical mapping,
// illum = (1 - cos(2*pi*phase)) / 2, a phase of 0.32 is 71% lit — a gibbous
// moon, not a crescent, so that mapping cannot be the one the contract means.
// The curve is therefore eased: it keeps all three of the documented anchors
// exactly, and spends most of the cycle in crescent territory, which is both
// what the plates show and what a cozy title wants — a gibbous moon is a bright
// featureless blob and reads as a bug in the sky.
#define MN_PHASE_SHAPE 4.0

float mnIllum(float phase) {
  return pow(clamp(0.5 - 0.5 * cos(6.2831853 * phase), 0.0, 1.0), MN_PHASE_SHAPE);
}

/**
 * dir      the fragment's world direction (unit)
 * mdir     the moon's world direction (unit)
 * sdir     the sun's world direction (unit) — sets which way the horns point
 * phase    SKY_STATE.moonPhase
 * mcol     SKY_STATE.moonColor
 * pxAng    angular size of one pixel, radians (length(fwidth(dir)))
 * discAmp  radiance of the fully lit limb
 * haloAmp  radiance scale of the halo
 */
vec3 mnMoon(vec3 dir, vec3 mdir, vec3 sdir, float phase, vec3 mcol,
            float pxAng, float discAmp, float haloAmp) {
  float ca = dot(dir, mdir);
  // atan(sin, cos) rather than acos: acos loses all its precision exactly where
  // this needs it, within a degree of the disc. It is also continuous past 90
  // deg, which a plain asin of the chord is not — the widest halo lobe still
  // carries a few thousandths out there and a step in it would draw a great
  // circle across the sky.
  float ang = atan(length(dir - mdir * ca), ca);

  // ── the disc ─────────────────────────────────────────────────────────────
  // A tangent frame whose +x points at the sun, so +x is the lit limb.
  vec3 toSun = sdir - mdir * dot(sdir, mdir);
  float tl = length(toSun);
  vec3 mx = tl > 1e-3 ? toSun / tl : normalize(cross(mdir, vec3(0.0, 0.0, 1.0)));
  vec3 my = cross(mdir, mx);
  vec2 p = vec2(dot(dir, mx), dot(dir, my)) / MN_RADIUS;
  float r = length(p);

  float aa = max(pxAng / MN_RADIUS, 0.012);   // one pixel, in disc radii
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);

  // The elliptical terminator. Softened by roughly a pixel plus a little, which
  // stands in for the fact that a real terminator is a grazing-illumination
  // gradient several kilometres wide and never a hard edge.
  float illum = mnIllum(phase);
  float k = 1.0 - 2.0 * illum;
  float xt = k * sqrt(max(0.0, 1.0 - p.y * p.y));
  float lit = smoothstep(-aa - 0.055, aa + 0.055, p.x - xt);

  // Maria. Low-contrast, low-frequency, and only on the lit part — the plates
  // have a hint of this at high zoom and it is the difference between a sphere
  // and a paper cut-out. skFBM comes from starfield.js.
  float maria = skFBM(vec3(clamp(p, -2.0, 2.0) * 1.15, 3.7)) - 0.5;
  float shade = 1.0 + 0.20 * maria;

  // Limb darkening. A real moon is nearly flat-lit (it is a rough regolith, not
  // a Lambertian ball) so this is deliberately weak — just enough to keep the
  // edge from reading as a sticker.
  shade *= 1.0 - 0.16 * smoothstep(0.55, 1.0, r);

  float body = lit * shade + (1.0 - lit) * 0.028;   // 0.028 is earthshine

  // ── the halo ─────────────────────────────────────────────────────────────
  // Three exponential lobes in angle: a tight flare that hugs the limb and is
  // what actually goes over the bloom threshold, a mid lobe about eight disc
  // radii across which is the halo the plates show, and a very wide, very faint
  // skirt that keeps the surrounding sky from having a visible edge where the
  // halo stops.
  float hr = ang / MN_RADIUS;
  float halo = exp(-hr * 0.72) * 0.85
             + exp(-hr * 0.155) * 0.16
             + exp(-hr * 0.042) * 0.035;

  return mcol * (disc * body * discAmp + halo * haloAmp);
}
`;
