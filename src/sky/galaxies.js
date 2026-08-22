// ─────────────────────────────────────────────────────────────────────────────
//  galaxies — GLSL for the two or three faint spirals hanging in the night sky.
//
//  A sister file to planets.js, and it exists for the same reason that one
//  does: a galaxy is not a bright star and everything about how it is drawn
//  follows from that.
//
//  ── 1. it is a SURFACE, not a point ───────────────────────────────────────
//  Every other object in this dome is a point with a halo — a star, a planet's
//  disc, the moon. A galaxy is an extended low-surface-brightness object, which
//  has two consequences that shape this whole file:
//
//    * it cannot twinkle. Scintillation is an atmospheric cell moving a POINT
//      image around; across a two-degree object the cells average out, the same
//      argument planets.js opens with. Nothing here reads uTime at all.
//    * its brightness per unit sky does not change with magnification, only its
//      size does. So the telescope does not make it brighter — it makes it
//      BIGGER, which is exactly what a real eyepiece does and is why the arms
//      are allowed to appear only when there are enough pixels to hold them
//      (see 4).
//
//  ── 2. the size needs NO exaggeration, and that is worth saying ───────────
//  The moon here is 2.0 deg against a real 0.52, and the planets run six to
//  twenty times life size, both for reasons their files argue at length. This
//  file needs none of that. Andromeda is genuinely 3.2 x 1.0 deg — six moons
//  long — and the reason nobody thinks of it as huge is that only its core
//  clears the naked eye's contrast threshold. So the sizes below are real
//  sizes, and what is lifted instead is the SURFACE BRIGHTNESS, by roughly the
//  same factor the rest of this sky is already lifted (starfield.js runs 585
//  stars/Mpx against a photographic 76-174, and says so).
//
//  At the game's 52 deg over a 900 px frame, the big one is 43 px across: a
//  soft elongated smudge that reads as "something is there". At the eyepiece's
//  6 deg it is 375 px and has arms. That gap IS the feature.
//
//  ── 3. they sit off the Milky Way, because that is where galaxies are ─────
//  The band is opaque with our own dust — the zone of avoidance — and almost
//  every galaxy anyone can name sits well away from it, clustered toward the
//  galactic poles. Free realism, and it is also the better composition: a faint
//  smudge laid over the busiest, brightest part of the sky is a smudge nobody
//  can see. GX_DIR_A is the north galactic pole of this sky's own band to
//  within a degree — dot(A, SK_MW_POLE) is 1.00 — and the other two sit at 0.74
//  and 0.61.
//
//  A and C are 42 deg apart, which is a deliberate pairing rather than a
//  scatter: Andromeda and Triangulum are 15 deg apart in the real sky and
//  finding the second one after the first is most of the pleasure of looking.
//
//  ── 4. the arms fade out rather than alias ────────────────────────────────
//  A two-armed logarithmic spiral is a high-frequency pattern in angle, and at
//  the game's default field of view one arm is about four pixels wide. Drawn
//  hard at that size it crawls and fizzes as the camera turns — the same defect
//  starfield.js clamps its star radii for, and the same one that made the ring
//  in planets.js soften its edges by a pixel rather than by a fraction of the
//  radius.
//
//  So the arm modulation is faded toward its own MEAN as the object shrinks
//  below about forty pixels (GX_ARM_PX). Toward the mean, not toward zero: the
//  galaxy keeps the same total light at every field of view and only loses the
//  structure, so it neither brightens nor dims when the player raises the
//  telescope. What they get for walking over to it is the shape.
//
//  Checked rather than assumed: sub-pixel yaw steps over the big one's own
//  patch move it no more than the star field beside it moves (mean pixel
//  difference 1.00 against 1.06 over the whole frame, 0.05% of pixels changed
//  by more than 6 levels at a fifth of a pixel of turn).
//
//  ── what it costs ─────────────────────────────────────────────────────────
//  Three rejects on every fragment of dome and a body that only runs inside a
//  couple of degrees. Measured with tools/_scratch/skybench.mjs, interleaved
//  arms against the same build with this file switched out:
//
//    a night sky with no galaxy in it       p50 6.10 -> 6.20 ms   (the rejects)
//    the big one filling a 6 deg eyepiece   p50 5.73 -> 5.97 ms   (worst case)
//
//  The second is the whole feature at its most expensive — a galaxy across half
//  the screen — and it is a fifth of a millisecond.
// ─────────────────────────────────────────────────────────────────────────────

export const GALAXY_GLSL = /* glsl */`
#define GX_DEG 0.01745329252

// Where they hang. Az/el, converted: dir = (sin(az)cos(el), sin(el), cos(az)cos(el)).
//
//   A  az 125  el 30   the showpiece, on the galactic pole
//   B  az -55  el 26   the face-on one, on the other side of the sky
//   C  az 175  el 44   the small companion to A, 42 deg away from it
//
// All three clear the treeline and all three are inside the telescope's pitch
// range (it stops just short of the zenith, at 80 deg).
#define GX_DIR_A normalize(vec3( 0.709,  0.500, -0.497))
#define GX_DIR_B normalize(vec3(-0.736,  0.438,  0.516))
#define GX_DIR_C normalize(vec3( 0.063,  0.695, -0.716))

// Semi-major axis, in pixels, below which the arms are faded into their own
// mean. See the header. 40 px puts the fade across the range between the
// game's field of view and the eyepiece's, so the structure arrives as the
// player zooms in rather than switching on at a threshold.
#define GX_ARM_PX 40.0

// The mean of the arm ridge function pow(0.5 + 0.5*cos(n*phase), GX_ARM_SHARP)
// over a full turn. It is what the ridge is faded TOWARD, so that fading costs
// no light. At sharpness 3.0 the integral is exactly C(6,3)/64 = 0.3125; if the
// sharpness changes this has to change with it, or the galaxies will dim as
// they shrink. The mean is unaffected by the knots below, whose own mean is 1.
#define GX_ARM_SHARP 3.0
#define GX_ARM_MEAN  0.3125

/**
 * One spiral galaxy.
 *
 * gdir     unit direction to it
 * radA     angular SEMI-major axis, radians
 * cosI     cos of the inclination: 1 is face-on, 0.3 is nearly edge-on. It is
 *          the ratio of the projected minor axis to the major, which is how an
 *          inclination is measured off a photograph in the first place.
 * pa       position angle — which way the major axis lies on the sky
 * narms    2 for a grand design, 4 for a flocculent one
 * pitch    winding: the tangent of the arm's pitch angle. Small is tightly
 *          wound, large is open. Real spirals run 0.1 (tight) to 0.5 (open).
 * dust     depth of the dust lane, 0..1. Only reads on an inclined disc, where
 *          the lane crosses the bulge; face-on it is interarm dust and stays low.
 * amp      surface brightness of the core, in the same linear units as a star's
 *          amplitude in starfield.js (the brightest star there is 1.55).
 * sd       seeds the knots, so no two have the same clumps
 * pxAng    angular size of one pixel, radians — the same value planets.js and
 *          moon.js take, and it is what decides whether the arms are drawn
 */
vec3 gxSpiral(vec3 dir, vec3 gdir, float radA, float cosI, float pa,
              float narms, float pitch, float dust,
              vec3 coreTint, vec3 armTint, float amp, float sd, float pxAng) {
  vec3 off = dir - gdir;
  // One reject for the whole object. The exponential disc below is at 0.06% of
  // its own core by 3.4 semi-major axes, so nothing survives out here and a
  // fragment further away pays a subtract, a dot and a compare.
  float reach = radA * 3.4;
  if (dot(off, off) > reach * reach) return vec3(0.0);

  // A tangent frame at the galaxy, turned to its position angle. The seed axis
  // is swapped near the zenith, where the world's up and the galaxy's direction
  // are parallel and the cross product collapses.
  vec3 seedAx = abs(gdir.y) > 0.90 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 tv = normalize(cross(gdir, seedAx));
  vec3 bv = cross(gdir, tv);
  float cp = cos(pa), sp = sin(pa);
  vec3 e1 =  tv * cp + bv * sp;      // major axis on the sky
  vec3 e2 = -tv * sp + bv * cp;      // minor axis on the sky

  // Sky-plane coordinates, in semi-major axes...
  float xs = dot(off, e1) / radA;
  float ys = dot(off, e2) / radA;
  float rs = length(vec2(xs, ys));
  // ...and the same point DEPROJECTED into the disc's own plane, where the
  // arms are circles rather than ellipses. Dividing the minor-axis coordinate
  // by cos(i) is the whole of the deprojection, and it is why one spiral
  // function draws both a face-on galaxy and a nearly edge-on one.
  float yd = ys / max(cosI, 0.06);
  float rd = length(vec2(xs, yd));
  if (rd > 3.4) return vec3(0.0);

  // ── the smooth light ────────────────────────────────────────────────────
  // An exponential disc, which is what a real one is to within the accuracy
  // anyone can see, plus a bulge.
  //
  // The bulge is measured in the SKY plane, not the disc plane, because a bulge
  // is a sphere: it stays round when the disc is squashed to a spindle. That
  // one detail is most of what makes an inclined galaxy read as a disc seen at
  // an angle rather than as an ellipse drawn on the sky.
  float disc = exp(-rd / 0.40);
  // The core is floored at a pixel and a half for the reason every other object
  // in this dome floors its core: drawn smaller than a pixel it scintillates on
  // its own as the camera turns. The amplitude is NOT given back here the way a
  // star's is — a star is a point source whose light is conserved when it is
  // spread, and this is a surface.
  float bcore = max(0.070, pxAng * 1.5 / radA);
  float bulge = exp(-(rs * rs) / (bcore * bcore)) * 1.70
              + exp(-rs / (bcore * 2.4)) * 0.55;
  // The inner disc, which is elongated with everything else rather than round
  // with the bulge. Without it the core is a bead sitting on the arms instead
  // of the centre of them.
  bulge += exp(-rd / 0.16) * 0.60;

  // ── the arms ────────────────────────────────────────────────────────────
  // A logarithmic spiral is r = r0 * exp(pitch * theta), so a point's phase
  // along the arm is theta - ln(r)/pitch and the arms are the ridges of a
  // cosine in that phase. This is the actual shape a density wave makes, and
  // it is also the cheapest possible spiral: one atan, one log.
  float th = atan(yd, xs);
  float ph = th - log(max(rd, 0.05)) / pitch;
  float ridge = pow(0.5 + 0.5 * cos(narms * ph), GX_ARM_SHARP);
  // One arm brighter than the other. Every real spiral is lopsided — the light
  // of a density wave is not shared evenly between its arms — and a pattern
  // with perfectly matched arms is the single thing that reads as a logo rather
  // than as an object. Averages to 1 over a turn, so it costs no light.
  ridge *= 1.0 + 0.34 * cos(th - pa * 1.7);

  // Knots. A real arm is a chain of star-forming regions, not a painted stripe,
  // and without this the pattern reads as a logo. Sampled in DISC coordinates
  // so the clumps deproject with everything else.
  // Two octaves: the coarse one breaks the arm into segments, the fine one
  // grains it. Written so the product still averages 1 over the disc, because
  // the fade below is calibrated on the ridge's own mean.
  float knot = skFBM(vec3(xs * 2.4, yd * 2.4, sd))
             + 0.55 * (skFBM(vec3(xs * 7.1, yd * 7.1, sd + 11.0)) - 0.5);
  ridge *= 0.20 + 1.60 * knot;

  // Arms belong between the bulge and the edge of the disc.
  float armWin = smoothstep(0.15, 0.44, rd) * exp(-rd / 0.50);

  // Fade to the mean when the object is too small to hold the pattern. See the
  // header: this costs no light, only structure.
  float res = clamp(radA / (pxAng * GX_ARM_PX), 0.0, 1.0);
  ridge = mix(GX_ARM_MEAN, ridge, res);

  // ── the dust lane ───────────────────────────────────────────────────────
  // Drawn in the SKY plane, like the bulge, and for the same reason: what a
  // dust lane looks like is a dark line lying across the near side of the
  // bulge, slightly off the major axis. Deprojected it would smear across the
  // whole disc and stop reading as a line at all.
  // A lane, not a shadow over the middle: the width is a twentieth of the major
  // axis, which at cosI 0.38 is an eighth of the visible minor one. Wider than
  // that and it stops reading as a line and just dims the galaxy.
  float lz = ys - 0.14 * cosI;
  float lane = 1.0 - dust * exp(-(lz * lz) / (0.0018 + 0.0022 * cosI))
                          * smoothstep(1.7, 0.7, rs);

  float armLight = ridge * armWin * 1.55;
  vec3 col = coreTint * (bulge + disc * 0.36)
           + armTint  * (armLight + disc * 0.16);

  // Taken to zero AT the reject rather than left to stop there. The arm window
  // is still worth 0.0007 of linear light at 3.4 semi-major axes, which is over
  // the floor the star field uses for "cannot be seen" — so without this the
  // faintest possible hard-edged ellipse is drawn around every galaxy, which is
  // the exact defect starfield.js's halo had and the reason its lobes now
  // subtract their own value at the cull. Cheaper here: the outskirt is a
  // smooth function already, so one smoothstep ends it.
  float edge = 1.0 - smoothstep(2.4, 3.4, rd);

  return col * (amp * lane * edge);
}

/**
 * The sky's galaxies.
 *
 * Brightness is in the same linear units as everything else in the dome, where
 * a star's cap is 1.55 and the Milky Way's haze peaks around 0.075. These sit
 * between: a core an order of magnitude under a bright star, and arms in the
 * same range as the band they are meant to be seen against.
 */
vec3 gxGalaxies(vec3 dir, float pxAng) {
  vec3 acc = vec3(0.0);

  // A — the showpiece. An inclined two-armed spiral, 2.7 deg on the long axis
  // and a third of that across, tipped 68 degrees so it is a lens rather than a
  // disc and the dust lane crosses the bulge. Warm core, blue arms: that colour
  // split is not decoration, it is the oldest fact about a spiral — red giants
  // in the bulge, young hot stars in the arms.
  acc += gxSpiral(dir, GX_DIR_A, 1.35 * GX_DEG, 0.38, 0.72, 2.0, 0.46, 0.62,
                  vec3(1.00, 0.90, 0.72), vec3(0.74, 0.84, 1.00), 0.30, 3.1, pxAng);

  // B — face-on, 1.6 deg across, seen from directly above the disc. Fainter per
  // unit sky than A because the same light is spread over a rounder shape,
  // which is true of the real ones and is why the face-on spirals are the hard
  // ones to find. Four arms and a looser winding: a flocculent spiral, so the
  // two of them do not read as one model used twice.
  acc += gxSpiral(dir, GX_DIR_B, 0.80 * GX_DEG, 0.92, 2.30, 4.0, 0.58, 0.16,
                  vec3(1.00, 0.93, 0.80), vec3(0.70, 0.82, 1.00), 0.20, 7.7, pxAng);

  // C — A's companion, 42 deg away and small enough that it is a smudge at any
  // field of view under the eyepiece's. Nearly edge-on and tightly wound.
  acc += gxSpiral(dir, GX_DIR_C, 0.46 * GX_DEG, 0.30, 1.95, 2.0, 0.38, 0.66,
                  vec3(1.00, 0.91, 0.76), vec3(0.76, 0.86, 1.00), 0.24, 5.2, pxAng);

  return max(acc, 0.0);
}
`;
