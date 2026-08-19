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
vec3 wCoolGovern(vec3 c, vec3 absorb, float amount){
  float y = max(wLuma(c), 1e-4);
  float cool = (c.b - c.r) / y;
  float want = max(absorb.b - absorb.r, 1e-3) * 0.34;
  float miss = clamp(1.0 - cool / want, 0.0, 1.0);
  return wTint(c, absorb, clamp(miss * amount, 0.0, 0.72));
}
`;

/** Cheap value noise + fbm. Deliberately low-octave: this is painterly water. */
export const WATER_NOISE = /* glsl */`
${WATER_COLOUR_UTILS}
vec2 wHash22(vec2 p){
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
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
// Metres of water covered by one pixel, computed analytically rather than from
// screen-space derivatives: dFdx/dFdy on the interpolated world position came
// back as zero here (measured — a debug pass showed the whole lake at footprint
// 0), which silently disabled every band-limit that depended on it.
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
vec3 wEnvReflect(vec3 P, vec3 R){
  // A rippled surface reflects a *cone*, not a ray, and at grazing angles half
  // that cone is pointed at higher, bluer sky. Sampling the mirror direction
  // literally returns the cream horizon band and turns every lake into a sheet
  // of silver — lifting the sample is both closer to the truth and the reason
  // water stays the cool note in a hot frame.
  vec3 sky = wSkyTilt(R);
  if (uReflectSteps < 1.0 || R.y <= 0.004) return sky;
  float t = 2.5, dt = 3.5;
  int N = int(uReflectSteps);
  for (int i = 0; i < 28; i++){
    if (i >= N) break;
    vec3 p = P + R * t;
    if (p.y > 340.0) break;
    vec4 d = wWorldData(p.xz);
    if (p.y < d.r){
      float alt = clamp(d.r / 190.0, 0.0, 1.0);
      vec3 col = mix(uRefGround, uRefRock, smoothstep(0.30, 0.80, alt));
      col = mix(col, vec3(0.95, 0.95, 1.0), smoothstep(uSnowLine, uSnowLine + 45.0, d.r) * 0.8);
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
      col = mix(col, haze, clamp(0.22 + t / 620.0, 0.0, 0.80));
      return col;
    }
    t += dt; dt *= 1.24;
  }
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
 */
float wSunShadow(vec3 P){
  if (uReflectSteps < 1.0) return 1.0;
  float t = 4.0, occ = 0.0;
  for (int i = 0; i < 12; i++){
    vec3 p = P + uSunDir * t;
    if (p.y > 345.0) break;
    float h = wBed(p.xz);
    occ = max(occ, clamp((h - p.y) * 0.45, 0.0, 1.0));
    t *= 1.55;
  }
  return 1.0 - occ * 0.90;
}
`;
