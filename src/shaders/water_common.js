// ─────────────────────────────────────────────────────────────────────────────
//  water_common — GLSL shared by rivers, lakes, falls, spray and mist.
//
//  Everything the water shaders need to know about the world comes from the
//  baked data texture (R = bed height, G = water surface, B = river mask,
//  A = moisture). Sampling it means the shoreline is derived from the *terrain*
//  rather than from where the water polygon happens to end, which is the only
//  way to get an edge that follows the carved bank instead of a mesh silhouette.
// ─────────────────────────────────────────────────────────────────────────────

/** Cheap value noise + fbm. Deliberately low-octave: this is painterly water. */
export const WATER_NOISE = /* glsl */`
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
// Analytic gradient of a single travelling wave — used instead of sampling a
// noise field four times, so ripples stay smooth and never alias into crawl.
vec2 wWaveGrad(vec2 p, vec2 dir, float k, float speed, float t, float amp){
  float ph = dot(p, dir) * k - speed * k * t;
  return dir * (cos(ph) * amp * k);
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
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyZenith;
uniform vec3  uSkyHorizon;
uniform vec3  uAmbient;
uniform vec3  uRefGround;
uniform vec3  uRefRock;
uniform float uSnowLine;
uniform float uReflectSteps;

vec4 wWorldData(vec2 xz){ return texture2D(uDataTex, xz / uWorldSize + 0.5); }
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
vec3 wEnvReflect(vec3 P, vec3 R){
  vec3 sky = wSky(R);
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
      col = mix(col, uSkyHorizon, clamp(t / 520.0, 0.0, 0.80));
      return col;
    }
    t += dt; dt *= 1.24;
  }
  return sky;
}

/** 6-tap march toward the sun so ridges actually shade the water below them. */
float wSunShadow(vec3 P){
  if (uReflectSteps < 1.0) return 1.0;
  float t = 3.0, occ = 0.0;
  for (int i = 0; i < 6; i++){
    vec3 p = P + uSunDir * t;
    float h = wBed(p.xz);
    occ = max(occ, clamp((h - p.y) * 0.5, 0.0, 1.0));
    t *= 2.15;
  }
  return 1.0 - occ * 0.82;
}
`;
