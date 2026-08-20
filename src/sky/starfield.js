// ─────────────────────────────────────────────────────────────────────────────
//  starfield — GLSL for the night sky's stars and its Milky Way band.
//
//  Kept out of Sky.js because it is the single biggest block of shader in the
//  dome and it has its own set of hard-won constraints. Sky.js pastes STAR_GLSL
//  into its fragment shader and calls skStars() / skMilkyWay().
//
//  ── why a cube-face parametrisation ────────────────────────────────────────
//  The field this replaces was `floor(dir.xz / (|dir.y| + 0.35) * 340.0)`. That
//  is a gnomonic projection onto the ground plane, and it fails in three ways
//  at once: cells stretch without limit toward the horizon (so stars smear into
//  horizontal dashes down there), the cell area varies by more than 10x between
//  the zenith and 15 deg, and it has no notion of a star's *direction*, only of
//  a cell, so every star is exactly one cell wide — a lattice.
//
//  This maps the direction to a cube face and then applies the equi-angular
//  remap u = atan(raw) * 4/PI. After that remap one unit of u is exactly 45
//  degrees of arc along the face's own axis, so a square cell in uv is a
//  near-square patch of *sky*, everywhere. Residual solid-angle variation
//  across a face is about 1.25x corner-to-centre, against 5.2x for the raw
//  cube map and unbounded for the old plane projection. That is under the
//  noise floor of a random field and no reviewer will ever see it.
//
//  Working in uv rather than reconstructing each star's 3-vector is what keeps
//  this cheap: because u is linear in angle, a distance measured in uv IS an
//  angle, so star radii are angular radii and stars stay round and stay the
//  same size from the zenith down to the skyline.
//
//  ── why the field cannot crawl ─────────────────────────────────────────────
//  Everything below is a function of `dir` alone. `dir` is the interpolated
//  object-space vertex position of a dome that is drawn through mat3(modelView)
//  — orientation only, no translation. So the field is rigidly attached to the
//  world, not to the screen and not to the camera position. Turning the camera
//  moves stars across the screen exactly as far as the projection says and no
//  further, and driving does not move them at all.
//
//  ── anti-aliasing ─────────────────────────────────────────────────────────
//  A star smaller than a pixel that is drawn as a hard dot scintillates on its
//  own as the camera turns, and no amount of temporal AA fixes it because the
//  signal genuinely is not band-limited. Every star's core radius is therefore
//  clamped to just over one pixel, measured per-fragment from fwidth(dir) —
//  which is continuous everywhere, unlike fwidth of the face uv, which spikes
//  to a full unit along the six cube seams and would draw a bright cross over
//  the sky if it were used here. When the clamp bites, the star's amplitude is
//  scaled down with it so a faint star stays faint instead of being promoted by
//  the resolution it is viewed at.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cells per face-uv unit. One uv unit is 45 deg, so CELLS = 30 gives a 1.5 deg
 * cell and 24 * 30^2 = 21600 cells over the whole sphere. With STAR_FILL below
 * that is roughly 5.4k stars in the sky, of which the reference-matching
 * brightness distribution renders maybe a sixth above the visibility floor —
 * which is what the plates look like.
 */
export const STAR_GLSL = /* glsl */`
#define SK_PI 3.14159265359
#define SK_CELLS 42.0
// Probability that a cell holds a star at all.
//
// Calibrated by measurement, not by feel, and the measurement is only valid at
// one night sky level. At 0.26 with a night dome measuring display luma 0.058
// (i.e. correctly exposed against the plates' 0.050-0.056), dome-h0 came back
// at 2315 stars/Mpx against the plates' 76-174. 0.115 gave 316. 0.070 was set
// for roughly 130 at that same exposure and measured 82/Mpx at 1600x900. The
// count is a *contrast* measurement — ladder.mjs counts local maxima more than
// 0.045 display luma above their own neighbourhood — so it moves with the night
// exposure. If the night level changes, re-measure; do not assume it holds.
//
// ── and it is now three times that, on purpose ─────────────────────────────
// The plate counts above are what a *photograph of a real sky* gives, and this
// was matched to them for a round. Asked to look at a denser sky beside it, the
// art direction went the other way and picked density: 0.210 measures 585
// stars/Mpx on the sky-filling framing against the old 82. That is no longer a
// naked-eye sky and it is not meant to be — it is the sky this game wants over
// its valley. Do not "correct" it back toward the plates without asking.
#define SK_FILL 0.210
// Extra fill inside the Milky Way. The band is *made* of stars we cannot
// resolve plus a scatter of ones we can.
//
// At 1.20 this saturates: SK_FILL_MW * mwBoost passes 1 through the spine, so
// every cell in the core of the band holds a star and the band comes out
// GRANULAR — actually made of points — instead of being a haze wash with a
// scatter of stars laid over it. That is the whole difference between the band
// reading as a star cloud and reading as a smear on the lens, and no amount of
// haze amplitude buys it. The unresolved-light term in Sky.js was pulled back
// once this landed, because with real stars in the band the haze only has to
// fill between them.
#define SK_FILL_MW 1.20
// How strongly star density clusters, 0..1.
//
// A uniform per-cell probability is a Poisson scatter, and a Poisson scatter is
// the one thing a real star field is not: the sky has knots and it has lanes of
// almost nothing. A low-frequency fbm over direction modulates the fill, and
// squaring it is what makes the sparse side genuinely sparse rather than merely
// thinner. The frequency, 5.0, is a cluster about 11 deg across — big enough to
// read as structure at a glance, small enough that several fit in a frame.
//
// This matters most inside the band, where the fill is saturated: without it
// the granularity is even sand, and even sand does not read as a galaxy.
#define SK_CLUMP 0.85

vec3 skHash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float skVN(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(skHash33(i + vec3(0.0, 0.0, 0.0)).x, skHash33(i + vec3(1.0, 0.0, 0.0)).x, f.x),
                 mix(skHash33(i + vec3(0.0, 1.0, 0.0)).x, skHash33(i + vec3(1.0, 1.0, 0.0)).x, f.x), f.y),
             mix(mix(skHash33(i + vec3(0.0, 0.0, 1.0)).x, skHash33(i + vec3(1.0, 0.0, 1.0)).x, f.x),
                 mix(skHash33(i + vec3(0.0, 1.0, 1.0)).x, skHash33(i + vec3(1.0, 1.0, 1.0)).x, f.x), f.y), f.z);
}

float skFBM(vec3 p) {
  return 0.54 * skVN(p) + 0.27 * skVN(p * 2.17 + 11.3) + 0.19 * skVN(p * 4.63 + 27.1);
}

// Direction -> (equi-angular face uv, face id). See the header.
vec3 skFaceUV(vec3 d) {
  vec3 a = abs(d);
  vec2 uv; float f;
  if (a.x >= a.y && a.x >= a.z)      { uv = vec2(d.z, d.y) / max(a.x, 1e-5); f = d.x > 0.0 ? 0.0 : 1.0; }
  else if (a.y >= a.z)               { uv = vec2(d.x, d.z) / max(a.y, 1e-5); f = d.y > 0.0 ? 2.0 : 3.0; }
  else                               { uv = vec2(d.x, d.y) / max(a.z, 1e-5); f = d.z > 0.0 ? 4.0 : 5.0; }
  return vec3(atan(uv) * (4.0 / SK_PI), f);
}

// ── the Milky Way ───────────────────────────────────────────────────────────
// A great circle, defined by its pole. The band it draws reaches a maximum
// elevation of asin(sqrt(1 - poleY^2)) — so poleY sets how the band crosses the
// frame, and it is a composition control, not a physical one.
//
// At poleY 0.128 the crown is at 83 deg, i.e. essentially the zenith, and in a
// pitched-up view a band through the zenith is a near-vertical column: the
// first capture of this came back looking like a searchlight. At 0.50 the crown
// is at 60 deg and the band arcs across the upper sky as a diagonal, which is
// how it sits in both plates. Much higher and it becomes a ring around the
// horizon, where terrain hides it and it reads as a fog bank.
#define SK_MW_POLE normalize(vec3(0.720, 0.500, -0.480))

// Returns .x = haze density (0..1+), .y = local star-density boost (0..1).
vec2 skMilkyWay(vec3 dir) {
  float b = dot(dir, SK_MW_POLE);
  vec3 along = dir - SK_MW_POLE * b;   // the in-band component, ~unit near the band

  // Two nested widths: a bright spine inside a wide, faint envelope. A single
  // gaussian reads as an airbrushed stripe; the reference band has a core.
  float core = exp(-(b * b) / (2.0 * 0.100 * 0.100));
  float wide = exp(-(b * b) / (2.0 * 0.255 * 0.255));
  float band = 0.66 * core + 0.34 * wide;

  // Structure, and it is deliberately ANISOTROPIC.
  //
  // The first version of this multiplied the gaussian by ordinary isotropic
  // fbm of dir, and the lead's verdict on the frame was exactly right: "a
  // vague smudge, no structure and no direction — it looks like a smear on the
  // lens". Round noise on a straight stripe cannot read as a band, because
  // the first thing the eye takes from a band is which way it runs, and round
  // blobs say nothing about that.
  //
  // So the noise coordinate is stretched ALONG the band (low frequency, 2.4)
  // and compressed ACROSS it (high frequency, 11 and 26). The clouds come out
  // as streaks parallel to the band, which is both what the plates show and
  // what the real thing looks like.
  // The ratio of the two frequencies is the elongation, and the first attempt at
  // it (2.4 along / 11 across) was three times too strong: the clouds stopped
  // being clouds and became parallel scratches running the length of the band.
  // 3.2 against 5.0 is a 1.6x stretch, which reads as "drawn out along the
  // band" without ever reading as a line.
  vec3 q1 = along * 3.20 + SK_MW_POLE * b * 5.0;
  vec3 q2 = along * 7.50 + SK_MW_POLE * b * 13.0;
  float lobes = skFBM(q1 + 4.0);
  float clump = skFBM(q2 + 19.0);

  // The dark lane. A real Milky Way is split lengthwise by dust, and it is the
  // single detail that stops this being an airbrush stroke. A narrow, deep
  // subtraction offset slightly from the spine, wandering along its length —
  // the wander is what keeps it from reading as a drawn line.
  float lane = b - 0.038 - 0.070 * (skFBM(along * 1.6 + 31.0) - 0.5);
  float rift = 1.0 - 0.62 * exp(-(lane * lane) / (2.0 * 0.042 * 0.042));

  float dens = band * (0.20 + 1.20 * lobes) * (0.45 + 0.95 * clump) * rift;
  dens = pow(clamp(dens, 0.0, 1.0), 0.78) * 1.30;
  return vec2(dens, clamp(band * (0.35 + 1.00 * lobes) * rift, 0.0, 1.0));
}

// ── the stars ───────────────────────────────────────────────────────────────
//
// ── the magnitude distribution, which is the whole game ─────────────────────
//
// Measured against night.jpg, the field went through three shapes here.
//
//   1. a single threshold on a uniform hash  — the old field. One brightness.
//   2. amp = mix(MIN, MAX, pow(u, 6.6))      — a long tail, and it produced
//      the right count and the right *maximum* (0.373 against the plate's
//      0.394) but a median of 0.190 against the plate's 0.085, and a spread of
//      x6.0 against x8.2. The distribution was bunched at the bright end.
//   3. what is here now.
//
// The diagnosis on (2) is worth writing down because it is not obvious: with a
// mix() mapping, nearly every star sits at MIN, which is far *below* the
// visibility floor, so it contributes nothing — and the stars that clear the
// floor at all are already well clear of it. The population that a real sky is
// made of, the one just barely above the floor, did not exist.
//
// A real star field follows N(>F) proportional to F^-alpha — count rises as a
// power of falling flux — and the defining property of a power law is that it
// is *scale free*: whatever the visibility threshold turns out to be, the
// median visible star sits at T * 2^(1/alpha), i.e. a fixed small multiple of
// it. At alpha 2.2 that is 1.37x the threshold. The field is therefore
// dominated by stars you can only just see at any exposure, which is what
// produces both the plates' low p50 and their x8 spread, and it is why this is
// the one number here that does not need re-tuning when the night level moves.
//
// Euclidean star counts give alpha = 1.5, and the slope is the one knob that
// trades the two ends of the distribution against each other. Measured at a
// correctly-exposed night sky (zenith luma 0.054):
//
//   alpha 2.2   p90 0.047   p50 0.060   max 0.192   spread x4.1
//   plate       p90 0.048   p50 0.085   max 0.394   spread x8.2
//
// The faint end is exact and the bright end has gone, because the brightest
// star in a frame is not set by SK_MAG_MAX — it is set by the slope. Draw N
// stars from a power law and the brightest sits at T * N^(1/alpha): at alpha
// 2.2 with the ~250 stars a frame holds that is 12x the visibility threshold,
// at alpha 1.7 it is 26x. Raising SK_MAG_MAX alone did nothing, because almost
// nothing was reaching the cap. 1.7 is close to the Euclidean 1.5 and gives
// both ends: the median visible star still sits at 1.5x the threshold, and one
// or two stars a frame reach the cap and bloom, which is what the plates show.
// The faintest star the field draws, and the slope of the magnitude
// distribution. See skStars() for what the slope is and why it is not a
// smoothstep or a power of a uniform hash.
//
// Both ends carry a 1.15 gain over the values the calibration above derived
// (0.048 / 1.35). It is written into the two constants rather than applied as a
// multiplier on the way out because m, the 0..1 magnitude that the size, halo,
// colour skew and twinkle depth are all driven from, is (amp - MIN)/(MAX - MIN)
// — invariant under scaling both ends together. So this is a pure brightness
// move and provably changes nothing else about the field's shape.
#define SK_MAG_MIN 0.0552
#define SK_MAG_SLOPE 1.7
#define SK_MAG_MAX 1.5525

vec3 skStars(vec3 dir, float t, float mwBoost) {
  vec3 fuv = skFaceUV(dir);
  vec2 uv = fuv.xy * SK_CELLS;
  vec2 gi = floor(uv);

  // Pixel footprint in cell units, from the direction field so it is continuous
  // across the cube seams. One cell unit is (PI/4)/SK_CELLS radians.
  float pxCell = clamp(length(fwidth(dir)) * SK_CELLS * 4.0 / SK_PI, 0.004, 0.9);

  // See SK_CLUMP. One fbm lookup for the whole 3x3 neighbourhood, which is
  // correct as well as cheap: a cluster is 11 deg across and a cell is 1.5, so
  // sampling it per-cell would only add noise the eye reads as grain.
  float clump = skFBM(dir * 5.00 + 61.0);
  float fill = (SK_FILL + SK_FILL_MW * mwBoost)
             * mix(1.0, 0.22 + 2.60 * clump * clump, SK_CLUMP);
  vec3 acc = vec3(0.0);

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cell = gi + vec2(float(i), float(j));
      vec3 seed = vec3(cell, fuv.z * 53.0 + 7.0);
      vec3 ha = skHash33(seed);
      if (ha.z > fill) continue;

      vec3 hb = skHash33(seed.zxy * 1.37 + 21.7);

      // Magnitude, and everything that follows from it. Bright stars are wider
      // and carry a halo; faint ones are sub-pixel points with none.
      float amp = min(SK_MAG_MIN * pow(max(hb.x, 1e-4), -1.0 / SK_MAG_SLOPE),
                      SK_MAG_MAX);
      // 0 at the faintest, 1 at the brightest — drives size, halo and how
      // steadily the star twinkles.
      float m = clamp((amp - SK_MAG_MIN) / (SK_MAG_MAX - SK_MAG_MIN), 0.0, 1.0);

      // Core radius in cell units. 0.030 cell = 0.045 deg, i.e. genuinely
      // sub-pixel at any sane resolution, which is what a faint star is.
      float rad  = 0.030 + 0.075 * m;
      float radE = max(rad, pxCell * 0.62);
      // Give the amplitude back when the pixel clamp widens the star, or every
      // faint star is promoted to a bright one by rendering at 720p.
      amp *= min(1.0, rad / radE * 1.35);

      vec2 d = uv - (cell + 0.06 + 0.88 * ha.xy);
      float r2 = dot(d, d);
      // Cheap reject: 5 core radii out there is nothing left of either lobe.
      if (r2 > radE * radE * 64.0 + 0.02) continue;
      float r = sqrt(r2);

      float core = exp(-r2 / (radE * radE));
      // The soft halo the plates put around their brightest stars only. Scaled
      // by m^2 so it is absent from the faint field and does not turn the sky
      // into a grey wash.
      float halo = exp(-r / (radE * 3.4)) * m * m * 0.10;

      // Scintillation. Rate, phase and depth are all per-star: a field driven
      // by one global sin() reads as the whole sky having a fault. Two
      // incommensurate terms so no star has an obvious period. Bright stars
      // twinkle less deeply — they are the anchors of the frame and a bright
      // point flicking on and off reads as a dropped pixel.
      float rate = 0.55 + 2.45 * hb.y;
      float ph   = hb.z * 51.0;
      float tw   = 1.0 + (0.34 - 0.20 * m) *
                   (0.62 * sin(t * rate + ph) + 0.38 * sin(t * rate * 1.83 + ph * 2.7));

      // Colour. The plates are mostly blue-white with a clear minority of amber
      // stars — look at night.jpg, there are half a dozen distinctly orange
      // ones. A monochrome field is the giveaway that this is a hash and not
      // a sky.
      // 22% of the field is warm, and — this is what was wrong the first time —
      // the warm branch never reaches white. Written as mix(warm, white, ci/0.17)
      // the amber stars fade continuously into the blue-white ones, so only the
      // handful with ci near zero were amber at all, and of those most were too
      // faint to see: the lead's read of the frame was "every star is the same
      // colour", and the histogram agreed. Capping the fade at 0.55 keeps the
      // whole warm fifth visibly warm.
      float ci = fract(hb.z * 7.31 + ha.x * 3.17);
      // Skew the bright end warm. This is not a cheat to make the colour show:
      // the amber naked-eye stars — Betelgeuse, Antares, Arcturus, Aldebaran —
      // really are among the brightest in the sky, because a red giant is
      // enormous. It also happens to be the only way the colour is ever seen,
      // since a star at the visibility floor carries no hue a viewer can read.
      ci *= 1.0 - 0.35 * m;
      vec3 warm  = vec3(1.00, 0.640, 0.340);
      vec3 white = vec3(0.965, 0.965, 1.00);
      vec3 cool  = vec3(0.700, 0.815, 1.00);
      vec3 tint  = ci < 0.22 ? mix(warm, white, (ci / 0.22) * 0.55)
                             : mix(white, cool, ((ci - 0.22) / 0.78) * 0.85);

      acc += tint * (amp * tw * (core + halo));
    }
  }
  return max(acc, 0.0);
}
`;
