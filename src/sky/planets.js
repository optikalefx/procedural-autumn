// ─────────────────────────────────────────────────────────────────────────────
//  planets — GLSL for the handful of wanderers, and the moons of the two that
//  have them.
//
//  Separate from starfield.js because a planet is not a bright star and the
//  whole point of having them is that it is not:
//
//  ── 1. a planet does not twinkle, and that is the feature ──────────────────
//  This is the actual way people tell one from a star with the naked eye. A
//  star is a point source, so the atmosphere's cells move its whole image at
//  once and it scintillates; a planet is a resolved DISC, and the cells across
//  it average out. So the twinkle work in starfield.js — where about half the
//  field now shimmers and one star in eight can flare — is exactly what makes
//  these read as something else in the same sky. They are the still things.
//  Nothing here reads uTime except the moon orbits, and those move at a
//  ten-minute period, which is not motion at the timescale anyone looks for.
//
//  ── 2. they are on the ecliptic, in the half of it that is UP ─────────────
//  Planets lie on a great circle, because the solar system is flat. That is
//  free realism and it is also the better composition: they line up, so one
//  sweep finds all four, and the line crosses the Milky Way's band at an angle
//  rather than lying along it.
//
//  Half of any great circle is below the horizon, and the first placement here
//  ignored that: longitudes were picked to look well spread around the circle
//  and two of the four landed underground — Venus at -27 deg and Jupiter, the
//  one with the four moons and the entire reason for the feature, at -52. A
//  planet nobody can ever point a telescope at is not a planet. The longitudes
//  below are all inside the arc that clears the skyline, which for this pole
//  runs from 3.54 to 5.88 rad; `tools/_scratch/planetshot.mjs` prints the
//  elevation of every one of them and is the check to re-run after touching
//  either these numbers or PL_POLE.
//
//  ── 3. the sizes are art-directed, and they have to be ────────────────────
//  Jupiter is 40 arcsec across, which is 0.011 deg. At the eyepiece's tightest
//  6 deg over a 900 px frame that is 1.7 px — not a disc, just a slightly fat
//  star, and the entire payoff of walking to the telescope evaporates. The
//  discs here are 0.092 to 0.150 deg across, which is six times life size for
//  Venus and twenty for Saturn — the exaggeration is largest where the real
//  disc is smallest, because what has to be constant is the SCREEN size in the
//  eyepiece, not the ratio. The moon in moon.js takes the same liberty for the
//  same reason (2.0 deg against a real 0.52) and its header says so; this is
//  that precedent, not a new one.
//
//  What the exaggeration buys, measured on Jupiter at 0.150 deg with its moons
//  strung out to 0.50 deg:
//
//    field of view        px/deg at 900px   Jupiter disc   outermost moon
//    52 (normal play)          17.3            2.6 px          8.7 px out
//    18 (eyepiece at rest)     50.0            7.5 px           25 px out
//     6 (fully zoomed)        150.0           22.5 px           75 px out
//
//  So in normal play it is the brightest thing in that patch of sky, faintly
//  warm and — because it does not twinkle — noticeably steady among neighbours
//  that do; at the eyepiece it is a disc with companions strung out beside it.
//  That is the whole brief.
//
//  ── 4. the moons are strung out in a LINE ─────────────────────────────────
//  Galilean moons sit in a line through the planet, because the orbits are seen
//  nearly edge-on. Scattering them isotropically around the disc is the one
//  thing that would make this read as lens dirt instead of as a system, so the
//  offsets are along one tangent axis with only a twelfth of that across it.
// ─────────────────────────────────────────────────────────────────────────────

export const PLANET_GLSL = /* glsl */`
#define PL_DEG 0.01745329252

// The pole of the ecliptic, and therefore where the line of planets runs.
//
// Same geometry as the Milky Way's pole in starfield.js: a great circle with
// pole P crowns at asin(sqrt(1 - P.y^2)). At P.y = 0.57 that is 55 deg, which
// arcs the planets across the upper sky where the telescope can reach them and
// the treeline cannot hide them. Deliberately NOT the Milky Way's pole — two
// great circles sharing a pole are the same circle, and the planets would then
// be strung out along the band instead of crossing it.
#define PL_POLE normalize(vec3(-0.62, 0.57, 0.54))

// A direction on the ecliptic at longitude lon, lifted off it by lat radians.
// The lift is what keeps them from being exactly collinear — real planets sit a
// few degrees either side of the ecliptic, and a perfectly straight line of
// four reads as placed rather than as found.
vec3 plDir(float lon, float lat) {
  vec3 P = PL_POLE;
  vec3 u = normalize(cross(P, vec3(0.0, 1.0, 0.0)));
  vec3 v = cross(P, u);
  return normalize((u * cos(lon) + v * sin(lon)) * cos(lat) + P * sin(lat));
}

/**
 * One body — planet or moon — as a disc with a soft limb and a tight glow.
 *
 * .x is the disc, .y is the glow. Angles are measured as the chord
 * length(dir - bdir), which is the angle to within a part in 10^5 at the
 * fractions of a degree everything here lives at, and costs a subtract instead
 * of an acos.
 *
 * The pixel clamp is the same contract starfield.js documents at length: a body
 * smaller than a pixel drawn hard scintillates on its own as the camera turns,
 * so the radius is floored at just over one pixel — and when that floor bites,
 * the amplitude comes down with it, or a 1.5 px Jupiter would be as bright at
 * 720p as a 13 px one is in the eyepiece. That would be a planet that gets
 * DIMMER as you magnify it, which is exactly backwards.
 */
vec2 plBody(vec3 dir, vec3 bdir, float radA, float pxAng) {
  float ang = length(dir - bdir);
  float rad = max(radA, pxAng * 0.62);
  if (ang > rad * 7.0) return vec2(0.0);
  float k    = min(1.0, radA / rad * 1.35);
  // The limb is softened by a PIXEL, not by a fraction of the radius.
  //
  // Written as smoothstep(rad*0.70, rad*1.04, ang) the transition is 34% of the
  // radius wide, which is fine on a 22 px Jupiter and is two tenths of a pixel
  // on the same planet at the game's default 52 deg — i.e. a hard edge on a
  // 3 px disc, which pops in and out as the camera turns for exactly the reason
  // starfield.js clamps its star radii. Tying the softness to pxAng makes the
  // limb crisp when the disc is large and a clean one-pixel ramp when it is
  // not, which is the same trade the star field makes and the same one that
  // keeps this from fizzing while driving.
  float aa   = max(pxAng * 0.60, rad * 0.06);
  float disc = (1.0 - smoothstep(rad - aa, rad + aa, ang)) * k;
  // Tight. The glow's width scales with the disc, so enlarging the discs to
  // read at fov 6 blew this out with them: at 1.9 Jupiter came with a 150 px
  // wash of blue around it that read as lens flare and buried its own inner
  // moons. 1.3 keeps it as an edge rather than an atmosphere.
  float glow = exp(-ang / (rad * 1.3)) * k;
  return vec2(disc, glow);
}


// ── Saturn's rings ──────────────────────────────────────────────────────────
//
// Inner and outer edge in PLANET RADII, which is how ring geometry is always
// quoted and keeps these tied to the disc if its size is ever retuned. The real
// C ring starts at 1.24 and the A ring ends at 2.27; the Cassini division — the
// gap between the A and B rings, and the one feature of the rings a person can
// name — sits at 1.95 to 2.02.
#define PL_RING_IN   1.28
#define PL_RING_OUT  2.30
#define PL_RING_CAS  1.98

// How far the ring plane is tipped toward us, as the ratio of the projected
// ellipse's minor axis to its major.
//
// This is the single number that decides whether the rings read at all. At 0
// they are edge-on: a line through the planet, which is what the real thing
// does twice per orbit and which reads here as a rendering fault. At 1 they are
// face-on and the planet looks like a bullseye. 0.46 is around 27 degrees of
// tilt, which is close to the maximum the real planet reaches and is the view
// every photograph anyone has seen is taken at.
#define PL_RING_TILT 0.46

// Position angle. Tips the ellipse off horizontal so it does not read as a bar
// laid through the planet by the renderer.
#define PL_RING_PA   0.42

/**
 * The rings, as a tilted elliptical annulus centred on the globe.
 *
 * ── why an ellipse and not a projected circle ──────────────────────────────
 * A circle in 3D seen from an angle projects to an ellipse, exactly, so there
 * is nothing to gain from carrying the ring's real geometry through a
 * projection: the answer is an ellipse either way. Working in the tangent plane
 * at the planet means the whole thing is two dot products and a length.
 *
 * ── the half behind the globe has to go ───────────────────────────────────
 * Drawing the full annulus over the planet is the difference between rings and
 * a hoop painted on the sky. The far half passes BEHIND, so it is cut where it
 * crosses the disc; the near half passes in front and is drawn over it. That
 * single occlusion is what makes the globe read as a sphere with something
 * around it rather than as a decal.
 *
 * The near half is added rather than composited — a ring in front of a planet
 * really is brighter than either alone — but damped over the disc, or the
 * crossing blows out to white and takes the limb with it. What is NOT here is
 * the shadow the rings cast on the globe. It is the next thing worth adding and
 * it is a genuine omission, not an oversight.
 */
vec3 plRings(vec3 dir, vec3 bdir, float radA, vec3 tint, float amp, float pxAng) {
  vec3 tv = normalize(cross(bdir, PL_POLE));
  vec3 bv = cross(bdir, tv);
  float ca = cos(PL_RING_PA), sa = sin(PL_RING_PA);
  vec3 e1 =  tv * ca + bv * sa;      // the ellipse's major axis
  vec3 e2 = -tv * sa + bv * ca;      // its minor axis, i.e. the tilt direction

  vec3 off = dir - bdir;
  float u = dot(off, e1);
  float v = dot(off, e2);

  float a = radA * PL_RING_OUT;
  float b = a * PL_RING_TILT;
  float rr = sqrt((u / a) * (u / a) + (v / b) * (v / b));   // 1.0 at the outer edge
  if (rr > 1.25) return vec3(0.0);

  // Anti-aliasing width, in rr units, ANALYTICALLY rather than from fwidth().
  //
  // fwidth would be the obvious tool and it is not available here: this runs
  // inside plSystem's early-out on distance, which is non-uniform control flow,
  // and a derivative taken there is undefined. The gradient of rr is known in
  // closed form, so take it directly. It matters that this varies around the
  // ellipse — near the top and bottom of the ring the two edges really are a
  // pixel apart and must blur together, while at the ansae they are far apart
  // and must stay crisp. A single global width does one of those two jobs.
  float grad = sqrt((u / (a * a)) * (u / (a * a)) + (v / (b * b)) * (v / (b * b)))
             / max(rr, 1e-6);
  float aaR = max(pxAng * 0.70 * grad, 0.012);

  float inner = PL_RING_IN / PL_RING_OUT;
  float ring = (1.0 - smoothstep(1.0 - aaR, 1.0 + aaR, rr))
             * smoothstep(inner - aaR, inner + aaR, rr);

  // The Cassini division, widened to at least a pixel so it never strobes.
  float cas = PL_RING_CAS / PL_RING_OUT;
  float cw  = max(0.030, aaR);
  // 0.85 rather than a gentler dip because this is competing with clipping:
  // the ring's own value is the thing that decides whether the gap survives
  // tonemapping, and a shallow division on a bright annulus is simply not there
  // once both sides have pinned to white.
  ring *= 1.0 - 0.85 * exp(-((rr - cas) * (rr - cas)) / (cw * cw));

  // Banding, so the annulus is not a flat wash. Shallow on purpose: the rings
  // are structured but they are not stripey, and at any real magnification here
  // strong bands read as moire.
  ring *= 0.82 + 0.18 * sin(rr * 27.0 + 1.3);

  // The far half is cut where it crosses the globe; the near half is drawn over
  // it, damped so the crossing does not blow out.
  //
  // step() is a hard switch and it is safe here, which is worth writing down
  // because it does not look safe. The switch happens on the line v = 0, which
  // runs through the globe along the ellipse's major axis — so at first glance
  // it draws a seam straight across the planet. It does not: on that line
  // rr = |u|/a, which inside the globe is at most radA/a = 1/2.30 = 0.435,
  // while the annulus does not begin until inner = 1.28/2.30 = 0.557. The ring
  // is identically zero everywhere the switch is ambiguous, with a fifth of the
  // ring's width to spare. The overlap that DOES need deciding is near the top
  // and bottom of the ellipse, where v is far from zero and the answer is
  // unambiguous. If PL_RING_IN is ever taken below about 1.05 planet radii this
  // stops being true and the seam appears.
  float ang     = length(off);
  float far     = step(0.0, v);
  float onGlobe = 1.0 - smoothstep(radA * 0.90, radA * 1.02, ang);
  ring *= (1.0 - far * onGlobe) * (1.0 - 0.50 * (1.0 - far) * onGlobe);

  // Slightly paler and cooler than the globe: the rings are water ice.
  //
  // 0.38, down from 0.62. At 0.62 the annulus came out at 0.96 of the globe's
  // own amplitude, and since the globe is already the brightest thing in that
  // patch of sky the whole system pinned to white: the first capture of these
  // rings was a flat cream ellipse with no banding and no Cassini division in
  // it, both of which were being computed correctly and then clipped away. The
  // rings must sit clearly UNDER the globe in value or none of their structure
  // survives — which is also true of the real thing.
  return mix(tint, vec3(0.97, 0.96, 0.93), 0.45) * amp * ring * 0.38;
}

/**
 * A planet, its rings if it has any, and up to four moons.
 *
 * nm is the moon count. spread is the outermost moon's angular distance in
 * radians; the inner ones are scaled down from it. sd seeds the orbital
 * phases so two systems are never in the same arrangement. rings is 0 or 1.
 */
vec3 plSystem(vec3 dir, float lon, float lat, float radA, vec3 tint, float amp,
              int nm, float spread, float sd, float rings, float pxAng, float t) {
  vec3 bdir = plDir(lon, lat);

  // One reject for the whole system. Everything in it — planet, glow, outermost
  // moon — is inside a degree and a half of the centre, so a fragment further
  // out than that pays a subtract and a compare for all of it.
  if (length(dir - bdir) > spread + 0.026) return vec3(0.0);

  vec2 b = plBody(dir, bdir, radA, pxAng);
  vec3 acc = tint * amp * (b.x + b.y * 0.20);
  if (rings > 0.5) acc += plRings(dir, bdir, radA, tint, amp, pxAng);

  // The moons' line. tv is along the orbital plane, bv across it.
  vec3 tv = normalize(cross(bdir, PL_POLE));
  vec3 bv = cross(bdir, tv);

  for (int i = 0; i < 4; i++) {
    if (i >= nm) break;
    float fi = float(i);
    // A ten-minute period. Over the half-minute anyone spends at the eyepiece
    // this is 3 degrees of orbit and cannot be seen moving — which is right,
    // moons that visibly slide would read as fireflies. What it buys is that
    // the arrangement is different every time you come back to it.
    float ph = sd * 7.3 + fi * 2.39 + t * (0.0105 + 0.0041 * fi);
    float r  = spread * (0.40 + 0.20 * fi);
    vec3 md  = normalize(bdir + tv * (r * cos(ph)) + bv * (r * 0.085 * sin(ph)));
    // Moons are drawn a shade cooler than their planet and much fainter — they
    // are lit by the same sun but they are tiny. A third of the disc radius
    // keeps them clearly subordinate at the eyepiece while still resolving:
    // Jupiter's come out 7.6 px across at fov 6 against its 22.5 px disc.
    vec2 mb = plBody(dir, md, radA * 0.34, pxAng);
    acc += mix(tint, vec3(0.92, 0.94, 1.00), 0.35) * amp * 0.42 * (mb.x + mb.y * 0.22);
  }
  return acc;
}

/**
 * The four wanderers.
 *
 * Brightness is in the same units as a star's amplitude in starfield.js, where
 * SK_MAG_MAX — the brightest star the field will ever draw — is 1.55. Venus at
 * 2.6 is therefore comfortably the brightest point in the sky after the moon,
 * which is true of the real one and is what makes it findable without knowing
 * where to look. Mars is the dimmest of the four and the most saturated, so it
 * is found by its colour rather than by its brightness.
 */
vec3 plPlanets(vec3 dir, float pxAng, float t) {
  vec3 acc = vec3(0.0);
  // lon,        lat,      radius,        tint,                      amp,  moons, spread,   seed, rings
  acc += plSystem(dir, 3.70,  0.050, 0.0520 * PL_DEG, vec3(1.00, 0.97, 0.90), 2.60, 0, 0.0,          0.0, 0.0, pxAng, t);
  acc += plSystem(dir, 4.35, -0.040, 0.0750 * PL_DEG, vec3(1.00, 0.93, 0.78), 1.90, 4, 0.50 * PL_DEG, 3.1, 0.0, pxAng, t);
  acc += plSystem(dir, 5.05,  0.070, 0.0460 * PL_DEG, vec3(1.00, 0.55, 0.34), 1.35, 0, 0.0,          0.0, 0.0, pxAng, t);
  acc += plSystem(dir, 5.62, -0.050, 0.0600 * PL_DEG, vec3(0.98, 0.88, 0.66), 1.30, 2, 0.34 * PL_DEG, 7.7, 1.0, pxAng, t);
  return max(acc, 0.0);
}
`;
