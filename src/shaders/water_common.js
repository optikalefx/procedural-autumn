// ─────────────────────────────────────────────────────────────────────────────
//  water_common — GLSL shared by rivers, lakes, falls, spray and mist.
//
//  Everything the water shaders need to know about the world comes from the
//  baked data texture (R = bed height, G = water surface, B = river mask,
//  A = moisture). Sampling it means the shoreline is derived from the *terrain*
//  rather than from where the water polygon happens to end, which is the only
//  way to get an edge that follows the carved bank instead of a mesh silhouette.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Colour helpers shared by every water surface.
 *
 * The single worst bug this system has had was that water was multiplied by its
 * own body colour — twice, in places. A body colour whose red channel is 0.10
 * cannot show an amber key however bright the key is, so at dawn the lakes
 * stayed cyan while the entire valley went sepia, and at dusk they went indigo
 * in a hot orange frame. Water read as pasted on, and no amount of surface
 * detail fixes that.
 *
 * So nothing here ever multiplies a colour by a colour. Tinting goes through
 * `wTint`, which normalises the tint to unit luminance first: the operation
 * moves *hue* and leaves *value* to the illuminant. Water keeps its material
 * identity, and every water surface in the game brightens, warms and cools with
 * the same sun as the ground it sits in.
 */
const WATER_COLOUR_UTILS = /* glsl */`
float wLuma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 wTint(vec3 c, vec3 tint, float amount){
  vec3 t = tint / max(wLuma(tint), 1e-4);
  return c * mix(vec3(1.0), t, amount);
}

// Desaturate toward own luminance. Used where a surface has to stay legible as
// water under a hard amber key without being repainted by it.
vec3 wDesat(vec3 c, float amount){
  return mix(c, vec3(wLuma(c)), amount);
}

// The cool governor.
//
// Everything above is value-preserving and hue-honest, and under a hard amber
// key that is not enough on its own: the illuminant, the inscattered haze and
// the reflected hillside are all warm, and their sum drifts the surface to a
// warm grey-brown. Measured on the peaks water mask at three of four times of
// day — #8d6c5f at 7.4, #8f7355 at 16.7, #935d42 at 18.6, against #b36f39,
// #c57c40 and #b26533 for the land immediately behind. A desaturated copy of
// the ground it sits in is not water; it is wet dirt.
//
// Reference plate 3 settles the art direction: a golden-hour frame whose grass
// is pure orange puts a strongly blue-violet river through the middle of it.
// So water is allowed one asymmetric rule — it may drift *cool*, never warm.
//
// The governor asks how far apart blue and red have ended up, relative to how
// far apart the water's own body colour would put them, and rotates back
// toward the body until a floor is met. It is a floor and not a target: water
// that is already blue enough is left alone entirely, so nothing here can make
// a lake *more* saturated than the shader asked for.
//
// A neutral pixel counts as a failure, not just a warm one. Shaded water in
// plate 3 is a strong blue-violet; ours measured #4a4344 at chroma 0.027,
// which is charcoal.
//
// RE-MEASURED against plate 3, in the units this function works in — cool =
// (b - r) / luma, linear. The plate's river runs 1.74 in its far reach
// (srgb #25405a), 1.90 mid-channel in shade (#2c4f71) and 2.38 in the lit
// deep body (#2b5a8a). Ours measured **1.15** mid-channel in the river view
// (#33364a), so the water was a little over half as separated as the target.
//
// The floor as written could never have caught that. 'want' was 0.34 of
// uDeep's own blue-red separation, and uDeep's separation is 1.15 — so the
// floor sat at 0.39 and the pixel sat at 1.15, three times above it. The
// governor has never fired on flowing water in this build; every capture that
// looked governed was governed by the tint chain instead.
//
// What it is measured against changed too, and that matters as much as the
// number. The body colour the rest of the shader treats as the water's hue is
// not uDeep: it is pow(absorb, uAbsorbPow), deepened for the reason given at
// 'lit' because a warm key cancels straight absorption. Handing the governor
// the shallow copy meant the two disagreed about what colour water is, and it
// also cost the rotation its strength — wTint moves a pixel further per unit
// amount when the tint it is given is further from neutral. Callers pass the
// deepened form now, so separation runs 1.81 rather than 1.15 for uDeep and a
// coefficient of 1.40 puts the floor at 2.5, which is plate 3's lit deep body
// (2.38) with a little headroom for what the shared haze takes back out.
//
// Self-scaling, and that is what keeps it honest: the shallows pass in a pale
// absorb whose separation is a third of uDeep's and are asked for a third as
// much, which is why a shelf can stay the near-neutral #9c98ad the plate draws
// while the deep water beside it is asked for a strong blue-violet. It is that
// saturation *split*, not an average chroma, that reads as water.
//
// It stays a floor. Water already past it is untouched, and because the
// rotation is one-shot the result lands short of 'want' rather than on it.
//
// ── ONE FLOOR FOR THE WHOLE SURFACE IS WHY THE SPREAD COLLAPSED ────────────
//
// docs/WATER_ART_SPEC.md 5 item 8 asks the water body for a cool MEAN >= 1.5
// AND a p90-p10 SPREAD >= 1.5, and the reference plates run 1.59-2.40 of
// spread. 'mouth' measured mean 2.10 / spread 0.66 against a pristine
// baseline's mean 1.98 / spread 2.77 — the mean correct and the variation gone.
//
// The obvious suspect was this function, on the reasoning that a floor
// truncates a distribution and can only ever narrow it. tools/waterstats.mjs
// says so in as many words on the item-3 line. MEASURED instead of assumed,
// by sweeping uCoolGain over one page load with the clock stopped
// (tools/_scratch/wuni.mjs), so the five frames differ by that uniform and by
// nothing else:
//
//     uCoolGain    mean   p10    p90   spread
//     0.00         1.50   1.23   1.68   0.45     <- the governor is OFF here
//     0.15         1.67   1.41   1.86   0.45
//     0.30         1.84   1.56   2.07   0.51
//     0.55         2.10   1.80   2.46   0.66     <- shipped
//     0.80         2.33   2.02   2.78   0.76
//
// So the governor is INNOCENT, and the first draft of this change was aimed at
// the wrong term: with it switched off entirely the spread is 0.45, NARROWER
// than with it on. The surface's hue is uniform before this function ever runs,
// because every path in the shader converges on one hue — the body is tinted by
// 'absorb' and so is the reflection, so a pixel that is 70% mirrored sky and a
// pixel that is 100% body come out the same colour. There is no saturation
// SPLIT anywhere for a floor to preserve.
//
// The floor is still the cheapest place to MAKE one, because it is the last
// thing that touches hue and it already runs on a per-pixel basis. So it takes
// a scale: the caller hands it the surface's own roughness/pallor mass, and a
// rough pale patch — which in the plate is a near-neutral sheet of reflected
// sky — is asked for a third of what a dark glassy patch is asked for. Both
// ends are still floors, so nothing here can make water WARM: at the pale end
// the demand is still ~1.1, which is four times F1's p10 >= +0.3 guard.
vec3 wCoolGovern(vec3 c, vec3 absorb, float amount, float floorScale){
  float y = max(wLuma(c), 1e-4);
  float cool = (c.b - c.r) / y;
  float want = max(absorb.b - absorb.r, 1e-3) * 1.40 * floorScale;
  float miss = clamp(1.0 - cool / want, 0.0, 1.0);
  return wTint(c, absorb, clamp(miss * amount, 0.0, 0.72));
}
`;

/** Cheap value noise + fbm. Deliberately low-octave: this is painterly water. */
export const WATER_NOISE = /* glsl */`
${WATER_COLOUR_UTILS}
// ── the hash, and why it is not fract(sin(x)) any more ──────────────────────
//
// This function is the single most executed piece of arithmetic in the game.
// Counted over the assembled shader with the call graph expanded, a near water
// fragment evaluates 30 wFbm2, which is 60 wNoise, which is 240 hashes; the old
// form ran two sin() per hash, so 480 transcendentals per pixel over half the
// screen. MEASURED, water-only pass at the 'mouth' framing, 52.1% coverage,
// exclusive lock, both variants compiled into the same page and timed
// interleaved so that neither tree drift nor lock contention can enter:
// 4.235 ms with the sin hash, 2.510 ms with this one. That is -41% of the
// whole water bill for four lines, and it is what took 'mouth' under the 3 ms
// the round was asked for.
//
// A CHEAPER HASH THAT CORRELATES IS NOT A SPEEDUP, it is a lattice — so this
// was chosen on measurements of the field, not on op count. Rendered on the
// GPU at the coordinate magnitudes the shader actually reaches (world is
// 3072 m, the fine octave runs p to about 2800) and compared against the hash
// it replaces, over bases 0, +/-700, +/-1300, +/-2800 and 6000:
//
//                       worst lag r    x/y r   diagonal x/y r   distinct   chi2
//   fract(sin) (old)         0.0041   0.0029           0.0413       3.2%   24-49
//   this one                 0.0035   0.0050           0.0292      21.2%    1-13
//
// Same decorrelation, a sixth of the histogram error, and six times as many
// distinct outputs — the old hash had already lost most of its mantissa to
// sin() of a large argument. wNoise sd 0.162-0.179 against 0.162-0.177 and
// wFbm2 sd 0.120-0.129 against 0.119-0.128, so the field's AMPLITUDE is
// unchanged and nothing downstream that thresholds it has moved.
//
// The instrument is spd/hashlab.mjs and it was fed answers it could not get
// wrong before any of the above was believed: a constant hash (must report
// lag r exactly 1), fract(p * 0.7) (must report r ~0.52), and a candidate
// whose two output components were algebraically identical — which the
// whole-grid correlation missed and the diagonal-band one caught.
//
// And then the PICTURE, because field statistics are not a frame. The five
// judged frames were captured with each hash in ONE page load off one frozen
// clock, and — the part that matters — also with four different SEEDS of each
// hash, so that the wedge metrics' own field-to-field spread is measured
// rather than assumed. Over crenel, fine, stair, aaPx and mask on all five
// frames, 25 comparisons, the shift between the two families is smaller than
// the spread between seeds of either family in every single one. 'mouth' fine
// alone swings 1.7 points on the same shader with a different magic constant,
// so a single-capture A/B of a noise change would have been unreadable.
vec2 wHash22(vec2 p){
  vec2 q = fract(p * vec2(0.1031, 0.3071));
  q += dot(q, q.yx + 19.19);
  return fract((q.x + q.y) * q) * 2.0 - 1.0;
}
float wNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dot(wHash22(i + vec2(0,0)), f - vec2(0,0)),
                 dot(wHash22(i + vec2(1,0)), f - vec2(1,0)), u.x),
             mix(dot(wHash22(i + vec2(0,1)), f - vec2(0,1)),
                 dot(wHash22(i + vec2(1,1)), f - vec2(1,1)), u.x), u.y);
}
float wFbm2(vec2 p){ return wNoise(p) * 0.62 + wNoise(p * 2.13) * 0.38; }
float wFbm3(vec2 p){
  return wNoise(p) * 0.53 + wNoise(p * 2.07) * 0.30 + wNoise(p * 4.23) * 0.17;
}
// Flat masses separated by soft edges — which is the brief's definition of the
// style, and is literally what the reference draws whitewater as. Plate 5's
// falling curtain is near-white, a mid blue-grey and a dark teal, with *edges*
// between them; measured, it spans luma 0.41 to 0.91. Our foam ran the same
// noise through a smooth ramp and came back as soft grey mottle on white —
// airbrushed, and reading as dirty snow rather than as broken water.
//
// Quantising into n levels with a narrow transition is the whole difference.
// 'wide' is the half-width of each step in units of a level: small values give
// painted marks, and 0.5 degenerates back to the linear ramp — which is what
// makes this safe to band-limit. Steps of a noise whose features are smaller
// than a pixel are just aliasing, so callers fade 'wide' to 0.5 as the pixel
// footprint grows and the marks dissolve back into a smooth tone at range.
float wSteps(float x, float n, float wide){
  float s = clamp(x, 0.0, 1.0) * n;
  float i = floor(s);
  float f = s - i;
  return (i + smoothstep(0.5 - wide, 0.5 + wide, f)) / n;
}
// ...and the same quantiser with the band-limit taken from the SCREEN rather
// than guessed from a world-space footprint. FRAGMENT SHADERS ONLY.
//
// The band-limit above is driven by callers fading 'wide' out as 'foot' grows,
// and 'foot' is the footprint along the VIEW direction with cos(incidence)
// floored at 0.035 — the largest the pixel can be. A step whose level set runs
// across the view is compressed on screen by the same factor the footprint was
// stretched by, so the guess is right in one direction and up to 28x too
// generous in the other. MEASURED: rendering 'mass' to the frame at the 'mouth'
// framing put a hard-shouldered level boundary across the middle of the bay
// with a visible pixel STAIRCASE on it, at foot 2.7 where the caller's fade had
// already taken 'wide' to 0.42 and believed the step was soft.
//
// fwidth(x) is that number exactly and in the right direction: it is how much
// the field moves between neighbouring pixels. A shoulder half-width of
// n * fwidth(x) * 0.6 puts the transition at ~1.2 px across, which is the
// narrowest a hard edge may be without aliasing. It is a FLOOR under the
// artistic width, never a replacement — a step the artist wants soft stays
// soft, and one the artist wants hard gets exactly as hard as the pixel grid
// can carry.
float wStepsAA(float x, float n, float wide){
  return wSteps(x, n, min(max(wide, fwidth(x) * n * 0.60), 0.5));
}

// Analytic gradient of a single travelling wave — used instead of sampling a
// noise field four times, so ripples stay smooth and never alias into crawl.
vec2 wWaveGrad(vec2 p, vec2 dir, float k, float speed, float t, float amp){
  float ph = dot(p, dir) * k - speed * k * t;
  return dir * (cos(ph) * amp * k);
}
// How much of a wave of wavenumber k survives at a pixel whose footprint on the
// water is foot metres across. Nyquist, essentially: once a wavelength is down
// to a fraction of a pixel the wave is not detail any more, it is noise, and it
// beats against the pixel grid into a dotted moire. A *distance* fade cannot do
// this job — at a grazing angle the footprint along the view direction blows up
// while the distance barely changes, which is exactly where a lake seen from its
// own bank turns into a sheet of dots.
float wRippleFade(float foot, float k){
  return 1.0 - smoothstep(0.18, 0.50, foot * k * 0.1591549);
}
// Metres of water covered by one pixel, computed analytically.
//
// THE NOTE THIS REPLACES WAS WRONG, and it cost the shader every band-limit
// that could have been exact. It said dFdx/dFdy on the interpolated world
// position "came back as zero here (measured — a debug pass showed the whole
// lake at footprint 0)". RE-MEASURED, this build, by rendering
// clamp(fwidth(vWPos.x) * 2.0, 0.0, 1.0) to the blue channel at the 'mouth'
// framing: it is zero nowhere, it ramps smoothly from the near bank to the far
// shore exactly as a footprint must, and it saturates at range. Derivatives
// work. (three r180 is WebGL2-only; there is no extension to enable and no
// WebGL1 path left in which that claim could have been true.)
//
// This function stays, because it is still the right tool for one job: it is
// the footprint of a pixel on a HORIZONTAL PLANE, which is what a world-space
// noise scale has to be measured against and what a fragment can compute
// without asking its neighbours. What it is NOT is the screen-space width of an
// edge — see wStepsAA, and see the shoreline block in water_surface.js, both of
// which take that from fwidth now.
// uPixelScale is 2*tan(fovY/2) / drawingBufferHeight, i.e. radians per pixel.
float wFootprint(vec3 P, vec3 camPos, float pixelScale){
  vec3 d = P - camPos;
  float dist = length(d);
  // Foreshortening. A pixel's footprint on a near-horizontal surface grows as
  // 1/cos(incidence), which is exactly why the far half of a lake aliases while
  // the same water two metres in front of the camera is perfectly stable.
  float cosI = max(abs(d.y) / max(dist, 1e-4), 0.035);
  return dist * pixelScale / cosI;
}
`;

/**
 * The illuminant for aerated water — foam, spray, mist and the falling sheet.
 *
 * Requires `uSunLight`, `uAmbient` and `uFoamGain` in scope.
 *
 * Whitewater is the one surface in this game that has to stay *white* under a
 * hard amber key. Lit literally, the golden-hour sun (RGB 3.0/1.7/0.7 here)
 * turns every fall, every rapid and every lapping shoreline into cream, and
 * because the red channel then clips first, all the structure painted into the
 * water survives only in blue — which is exactly how a waterfall ends up
 * reading as a strip of paper. Reference plate 5 has white water sitting next
 * to orange grass; plate 3 keeps its river blue-white under a low gold sun.
 *
 * So the illuminant is desaturated toward its own luminance before it touches
 * foam, and tipped a hair cool. It is a *lighting* stylisation, not a per-pixel
 * colour hack: the shadow term still moves it, so foam in shade is grey and
 * foam in sun is white, and nothing clips.
 */
export const WATER_FOAM_LIGHT = /* glsl */`
uniform float uFoamGain;
const float W_PI = 3.14159265;
vec3 wFoamLight(float shadow){
  vec3 L = (uSunLight * (0.30 + 0.55 * shadow) + uAmbient * 0.75) / W_PI;
  float y = dot(L, vec3(0.2126, 0.7152, 0.0722));
  // Measured off reference plate 5: the falling curtain there is RGB
  // 0.67/0.75/0.81 — not white but distinctly *blue*-white, and 0% of it is
  // clipped. So the desaturation is heavy and the residual tilt is cool.
  // ...but the residual tilt was too strong, and it is the only thing left in
  // the chain that can colour foam. At 0.88/0.97/1.12 it is a ratio of
  // 1:1.10:1.27, and every aerated surface in the game came out of it that
  // blue: the plunge pool at the foot of the 65 m fall measured srgb
  // 1:1.14:1.31. Re-measured off plate 5 in the space the tilt actually
  // applies, the falling curtain there is 1:1.12:1.21 and the *whitewater at
  // the foot of it* — the plunge, which is what this pool is — is 1:0.99:1.00,
  // effectively neutral. The cool note in these plates belongs to the body of
  // the water, not to the air in it. Halved toward that.
  return mix(L, vec3(y), 0.86) * vec3(0.94, 0.99, 1.06) * uFoamGain;
}
`;

/**
 * World sampling + sky/environment reflection.
 * Requires uniforms: uDataTex, uWorldSize, uSunDir, uSunColor, uSkyZenith,
 * uSkyHorizon, uRefGround, uRefRock, uSnowLine, uReflectSteps.
 */
export const WATER_ENV = /* glsl */`
uniform sampler2D uDataTex;
uniform float uWorldSize;
uniform float uDataTexel;   // 1 / dataTexture resolution, in UV
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyZenith;
uniform vec3  uSkyHorizon;
uniform vec3  uAmbient;
uniform vec3  uRefGround;
uniform vec3  uRefRock;
uniform float uSnowLine;
uniform float uReflectSteps;

// Texel centres, not texel corners. WorldData's CPU bilinear puts sample i at
// world -half + i*texel, which is UV (i + 0.5) / res — so the naive
// xz/worldSize + 0.5 lookup is half a texel off. On a 2 m grid that is a metre
// of horizontal slip between the bed the water thinks it has and the bed the
// terrain mesh actually draws, which on any steep bank is several metres of
// height error and is exactly what makes a water edge miss its shoreline.
vec4 wWorldData(vec2 xz){
  return texture2D(uDataTex, xz / uWorldSize + 0.5 + uDataTexel * 0.5);
}
float wBed(vec2 xz){ return wWorldData(xz).r; }


// A compact restatement of Sky.js's gradient. Close enough that a mirror-calm
// lake and the sky above it read as the same air.
vec3 wSky(vec3 d){
  float h = clamp(d.y, 0.0, 1.0);
  vec3 c = mix(uSkyHorizon, uSkyZenith, pow(h, 0.55));
  float cosT = max(dot(normalize(d), uSunDir), 0.0);
  c += uSunColor * (pow(cosT, 5.0) * 0.06 + pow(cosT, 160.0) * 1.1);
  return c;
}

/**
 * Reflection of the surrounding landscape, ray-marched against the baked
 * heightfield. A real planar reflection would cost a second scene pass (and
 * ~150 draw calls); marching the height texture costs nothing but ALU and is
 * more than enough for a stylised near-mirror at grazing angles.
 */
// The sky a rippled surface actually shows: a rippled surface reflects a cone,
// and at grazing angles half that cone points at higher, bluer sky. Sampling
// the mirror direction literally returns the cream horizon band and turns every
// lake into a sheet of silver.
vec3 wSkyTilt(vec3 R){
  return wSky(normalize(vec3(R.x, R.y + 0.42, R.z)));
}
// The colour a reflected hillside hands back, given the height it was hit at
// and how far the ray travelled to get there. Lifted out of the march loop so
// the march can call it ONCE, on an interpolated crossing, instead of once per
// sample on a quantised one — see the banding note below.
vec3 wRefLand(float hHit, float t){
  float alt = clamp(hHit / 190.0, 0.0, 1.0);
  vec3 col = mix(uRefGround, uRefRock, smoothstep(0.30, 0.80, alt));
  col = mix(col, vec3(0.95, 0.95, 1.0), smoothstep(uSnowLine, uSnowLine + 45.0, hHit) * 0.8);
  // Reflected hills sit behind a double thickness of haze — they should be
  // paler and flatter than the real thing, never a crisp mirror copy.
  // Rolled off hard: a lake that faithfully mirrors a gold hillside is a
  // brown lake, and water in the reference is always the cool note in the
  // frame however hot the land around it is.
  // Toward the *cool* end of the sky, not the cream horizon band: hazing a
  // gold hillside toward cream leaves khaki, and khaki water is mud.
  vec3 haze = mix(uSkyHorizon, uSkyZenith, 0.62);
  // Desaturated hard before it is hazed. A reflected gold hillside carries
  // enough chroma that even a heavy haze leaves it khaki, and once the
  // surface then rotates it toward the water hue the lake fills with olive
  // patches that read as scum. In the plates a reflected bank is a darker,
  // near-monochrome smear — value, not colour.
  // Hazed, but not out of existence. At 0.46 + t/260 a bank forty metres
  // away came back 61% haze and a far shore 90%, so even once the march
  // was allowed to reach them there was nothing left of them to see. A
  // reflection *is* a darker, flatter copy — it is not fog.
  col = wDesat(col, 0.55);
  // And a *darker* copy, which matters more than it sounds. A reflected
  // bank in the plates is a dark, faintly violet mass — the near shore of
  // plate 3 reads as a shadow lying on the water, and it is that dark band
  // that gives the river its value composition. Handing back the hillside
  // at its own brightness instead does two bad things: the water loses the
  // one dark note it has, and a warm gold reflection mixed into a blue body
  // cancels to neutral. Measured mid-channel at #5c6077, chroma 0.107 —
  // the grey a critic pass called out, arriving from the reflection rather
  // than from the body.
  col *= 0.58;
  return mix(col, haze, clamp(0.22 + t / 620.0, 0.0, 0.80));
}
vec3 wEnvReflect(vec3 P, vec3 R){
  // A rippled surface reflects a *cone*, not a ray, and at grazing angles half
  // that cone is pointed at higher, bluer sky. Sampling the mirror direction
  // literally returns the cream horizon band and turns every lake into a sheet
  // of silver — lifting the sample is both closer to the truth and the reason
  // water stays the cool note in a hot frame.
  vec3 sky = wSkyTilt(R);
  if (uReflectSteps < 1.0 || R.y <= 0.004) return sky;
  // ── the step schedule, and why it banded ──────────────────────────────────
  //
  // The old schedule was 24 samples of 3.5 m growing 1.24x, which reaches
  // 2536 m. Two things were wrong with it, and they are opposite mistakes.
  //
  // TOO LONG. The answer this function returns is hazed by clamp(0.22 + t/620,
  // .., 0.80), so it is PINNED at 80% haze for every t past 360 m and the only
  // thing left varying is 20% of a copy already desaturated by 0.55 and
  // darkened by 0.58. Counted on the schedule, samples 16 through 23 — a third
  // of the whole march — all landed in that saturated region and could not
  // between them move the returned colour by more than about 1%.
  //
  // TOO COARSE WHERE IT MATTERED, AND IT SHOWED. The colour was computed from
  // the SAMPLE, not from the crossing, so a hit anywhere inside a step returned
  // the step's far end: at sample 20 the step is 170 m long, which is 0.27 of
  // the haze range, and two neighbouring pixels whose rays cross the ground a
  // metre apart can land either side of a step boundary. That is a hard
  // quarter-of-the-range jump between adjacent pixels, and it is the dark
  // banding over the open water in 'mouth' and 'river'.
  //
  // Both are fixed by the same change. The crossing is INTERPOLATED — the
  // clearance above the bed is tracked at each sample, the zero of that scalar
  // is found by one linear step between the last two, and the bed height at the
  // crossing is P.y + R.y*t, which is exact by construction and free. Every
  // quantity the colour depends on is then a continuous function of position
  // and there is nothing left to band. With the answer continuous the steps can
  // be coarse, so the ratio goes to 1.38 and the count to 16: that still
  // reaches 1578 m nominal, further than the old schedule needed to be, in two
  // thirds of the samples. The hard stop at 900 m is where the haze has been
  // pinned for 540 m and typically fires at sample 14.
  //
  // uReflectSteps IS 16, and it says 16 because the loop bound below is 16.
  // For a round it said 24 while this loop capped at 16, so the one dial a
  // quality preset has over this march overstated the work by half and could
  // not be read; a sweep of the uniform is flat from 16 to 24 for exactly that
  // reason and the flatness was reported as a property of the march rather
  // than as the bug it was. Lowering it further was measured and rejected: 24
  // to 8 is worth 0.08 ms at 'mouth' (under 2% of the water bill) and it
  // withdraws every crossing past 117 m, which over open water at eye height
  // is most of the far half of the frame. If the two numbers ever disagree
  // again, the uniform is the one that is wrong.
  float t = 2.5, dt = 3.5;
  float tp = 0.0, cp = 1.0;   // previous sample: range, and clearance over the bed
  float cmin = 1e9, tmin = 0.0;
  // ── a known, localised, UNFIXED discontinuity — read before you try again ─
  //
  // Two critics measured a blocky, unantialiased step on near-field water at
  // --pos -830,62,-930 --look -720,19,-816: 0.24 stops in ONE pixel, 2-6 px
  // treads, on water that reads +/-0.03 everywhere else.
  //
  // It is in THIS function, and specifically in the near-miss branch at the
  // bottom. Probes, same pose, worst single-pixel delta in the critic's own box:
  //
  //     shipped                                             0.231 st
  //     near-miss range = nearness-weighted mean of samples  0.246 st
  //     near-miss range = parabolic closest approach         0.226 st
  //     graze width made screen-relative via fwidth(cmin)    0.244 st
  //     the near-miss branch removed entirely                0.106 st
  //
  // So: removing the branch halves it, and NEITHER the range it reports NOR the
  // width of its ramp is the cause. Three plausible repairs moved nothing, and
  // all three are therefore eliminated rather than merely untried. Whatever is
  // left is the only other thing that varies between adjacent rays here — how
  // many samples the loop takes before one of its three breaks fires
  // (i >= N, t > 900, p.y > 340), which changes the SET that cmin is a minimum
  // over and can therefore jump even though each sample is continuous.
  //
  // Not fixed. A previous author's four probes from the surface side had
  // already eliminated everything the surface feeds this march (an unquantised
  // mass field, maximum AA on the shelf quantiser, and even a perfectly flat
  // mirror normal all left it unchanged), so the two investigations agree on
  // where it is and neither has closed it. Do not delete the branch: its own
  // note records that hit-or-nothing draws every ridge silhouette on the water
  // as a hard-edged blot, which is worse.

  int N = int(uReflectSteps);
  for (int i = 0; i < 16; i++){
    if (i >= N || t > 900.0) break;
    vec3 p = P + R * t;
    if (p.y > 340.0) break;
    float c = p.y - wBed(p.xz);
    if (c < 0.0){
      float f = clamp(cp / max(cp - c, 1e-4), 0.0, 1.0);
      float th = mix(tp, t, f);
      return wRefLand(P.y + R.y * th, th);
    }
    if (c < cmin) { cmin = c; tmin = t; }
    tp = t; cp = c;
    t += dt; dt *= 1.38;
  }
  // A ray that missed by a metre and a ray that hit are the same ray as far as
  // the picture is concerned, and treating them as hit-or-nothing draws the
  // silhouette of every ridge on the water as a hard-edged blot. Softened over
  // the closest approach: six metres is about one ripple's worth of normal
  // wobble at these ranges, so a surface that is rough enough to point a
  // neighbouring pixel INTO the ridge gets a partial answer rather than a
  // binary one. Costs no fetch — the clearance was already being computed.
  float graze = 1.0 - smoothstep(0.0, 6.0, cmin);
  float tg = tmin;
  if (graze > 0.01) return mix(sky, wRefLand(P.y + R.y * tg, tg), graze);
  return sky;
}

/**
 * March toward the sun so ridges actually shade the water below them.
 *
 * Water is the one surface in the scene that is not a lit standard material,
 * so it gets no shadow map. Without this a river running along the foot of a
 * ridge stays in full golden key while the ground around it has gone violet,
 * and the ribbon reads as painted on. The steps grow geometrically out to
 * ~500 m, which is the scale of the shadows that actually matter here.
 *
 * MEASURED COST, water-only pass at the 'mouth' framing: 0.16 ms of a 3.02 ms
 * bill, i.e. 5%, and 0.02 of 0.70 at 'hero'. Twelve steps is not the expensive
 * thing here and shortening the schedule buys almost nothing while withdrawing
 * the ridge shadows that are the whole point, so the schedule is unchanged and
 * the two savings taken are both free ones.
 *
 * The FIRST is 'cap': every caller of this mins the result with a shadow term
 * it already has (the cascade's getShadowMask(), which the water is not lit by
 * but can still read). Where that term is already zero the min is zero however
 * this march comes out, so the march is pure waste — and it is waste over
 * whole shadowed regions of the frame at once, which is the coherent case a
 * GPU branch is actually good at. Pass it in; the one-argument form is the
 * ungated march and is what a caller with nothing to offer should use.
 *
 * The SECOND is the saturation break. occ only ever rises and clamp() pins it
 * at 1.0 as soon as one sample is 2.22 m inside the terrain, so continuing is
 * arithmetically incapable of changing the answer. The break is exact, not an
 * approximation with a tolerance — do not soften it to occ > 0.99 to catch a
 * few more pixels, that would be a (small) change to the picture in exchange
 * for a (smaller) saving.
 */
float wSunShadow(vec3 P, float cap){
  if (uReflectSteps < 1.0 || cap < 0.02) return 1.0;
  float t = 4.0, occ = 0.0;
  for (int i = 0; i < 12; i++){
    vec3 p = P + uSunDir * t;
    if (p.y > 345.0 || occ >= 1.0) break;
    float h = wBed(p.xz);
    occ = max(occ, clamp((h - p.y) * 0.45, 0.0, 1.0));
    t *= 1.55;
  }
  return 1.0 - occ * 0.90;
}
float wSunShadow(vec3 P){ return wSunShadow(P, 1.0); }
`;
