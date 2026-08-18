// ─────────────────────────────────────────────────────────────────────────────
//  Clouds — raymarched cumulus over a sky dome, plus a high cirrus veil.
//
//  Why a march and not billboards: the reference plates want cumulus with real
//  form — a warm lit crown, a violet underside, and a silhouette that changes
//  as you drive under it. Billboards give you the first two by painting them
//  in, and never give you the third. A fixed-step slab march is cheap enough
//  here because the camera never enters the cloud deck: the ray/slab interval
//  is analytic, the density is two texture taps, and the self-shadow is one
//  more tap offset along the sun instead of a second nested march.
//
//  Everything is driven from one tiling 4-channel noise tile:
//      R  low-frequency coverage      (also the cloud-shadow map on the ground)
//      G  mid-frequency erosion
//      B  high-frequency erosion
//      A  stretched cirrus
//  Using the *same* R channel for the ground shadow is what makes the shadow
//  on the meadow line up with the cloud you can see overhead.
//
//  Ordering note: the dome is `transparent: false` with CustomBlending, which
//  keeps it in three's opaque queue (so renderOrder actually applies and the
//  terrain draws over it) while still alpha-blending onto the sky.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { SEED } from '../world/WorldConfig.js';
import { mulberry32 } from '../core/MathUtils.js';
import { SKY_STATE } from '../render/Lighting.js';

// Cloud deck geometry, in metres. The valley tops out at ~340 m.
const BASE = 800;
const TOP = 1660;
const TILE = 8200;          // world size of one wrap of the noise tile
const CIRRUS_ALT = 6200;
const CIRRUS_TILE = 34000;

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w;
}`;

const FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;

uniform sampler2D uNoise;
uniform vec3  uCamPos;
uniform vec3  uSunDir;
uniform vec3  uLit;         // sunlit crown
uniform vec3  uDark;        // self-shadowed underside
uniform vec3  uAmbient;     // sky bounce into the shadow side
uniform vec3  uHorizon;     // what a cloud fades into at the skyline
uniform vec2  uWind;
uniform float uCover;       // 0..1, from the time-of-day table
uniform float uDensity;
uniform float uInvTile;
uniform float uCirrus;      // cirrus opacity
uniform float uOpacity;     // global fade (kills clouds at night gracefully)

const float BASE_Y = ${BASE.toFixed(1)};
const float TOP_Y  = ${TOP.toFixed(1)};
const float THICK  = ${(TOP - BASE).toFixed(1)};
const float MAXT   = 22000.0;

float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// Low-frequency coverage, remapped by the cover control. 1 tap.
// A smoothstep rather than a clamp: a hard threshold on a bilinearly filtered
// tile produces visible polygonal edges where the interpolation triangles meet.
float coverageAt(vec2 xz) {
  float n = texture2D(uNoise, xz * uInvTile + uWind).r;
  float t = 1.0 - uCover;
  // Narrow ramp = defined cloud with real gaps; wide ramp = wispy stratus.
  return smoothstep(t - 0.03, t + 0.19, n);
}

// The vertical profile alone — used by the light march, which cannot afford
// the erosion taps.
float profileAt(float y, float cov) {
  float hf = clamp((y - BASE_Y) / THICK, 0.0, 1.0);
  float top = 0.24 + 0.70 * cov;
  return cov * smoothstep(0.0, 0.13, hf) * (1.0 - smoothstep(top, top + 0.36, hf));
}

// Full density at a point inside the slab. 2 taps.
float densityAt(vec3 p, float cov) {
  float hf = clamp((p.y - BASE_Y) / THICK, 0.0, 1.0);
  vec2 uv = p.xz * uInvTile + uWind;

  // The erosion octaves are skewed hard with height. Without that shear the
  // density is a 2D shape extruded straight up, and from the side the deck
  // reads as stacked flat plates instead of billowing cloud.
  float e1 = texture2D(uNoise, uv * 3.3 + vec2(0.46, -0.31) * hf + uWind * 1.6).g;
  float e2 = texture2D(uNoise, uv * 10.5 + vec2(1.15, 0.72) * hf - uWind * 2.4).b;

  // Flat base, cauliflower crown whose height is driven by both coverage and
  // the mid octave — a constant lid is the other half of the "plate" look.
  float top = 0.24 + 0.70 * cov * (0.55 + 0.90 * e1);
  float prof = smoothstep(0.0, 0.13, hf) * (1.0 - smoothstep(top, top + 0.36, hf));
  float d = cov * prof;
  // Erosion carves the silhouette; too much of it and the low-frequency core
  // is all that survives, which reads as fog rather than as cumulus.
  d -= (e1 * 0.24 + e2 * 0.11) * (0.25 + 0.75 * hf);
  return max(d, 0.0) * 1.7;
}

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}

void main() {
  vec3 d = normalize(vDir);
  if (d.y <= 0.018) discard;

  float t0 = max((BASE_Y - uCamPos.y) / d.y, 0.0);
  float t1 = (TOP_Y - uCamPos.y) / d.y;
  float tEntry = max(t0, 1.0);
  vec3 acc = vec3(0.0);
  float alpha = 0.0;

  // ── cirrus veil, behind everything ───────────────────────────────────────
  if (uCirrus > 0.004) {
    float tc = (${CIRRUS_ALT.toFixed(1)} - uCamPos.y) / d.y;
    vec2 cu = (uCamPos.xz + d.xz * tc) / ${CIRRUS_TILE.toFixed(1)} + uWind * 0.30;
    // Anisotropic lookup: squashing one axis turns fbm blobs into wind streaks.
    float ci = texture2D(uNoise, vec2(cu.x * 0.34, cu.y)).a;
    float ca = smoothstep(0.44, 0.86, ci) * uCirrus * smoothstep(0.02, 0.22, d.y);
    float lit = 0.55 + 0.45 * hg(dot(d, uSunDir), 0.55) * 0.25;
    acc = mix(uAmbient, uLit, clamp(lit, 0.0, 1.0)) * ca;
    alpha = ca;
  }

  if (t1 > t0 && t0 < MAXT) {
    t1 = min(t1, MAXT);

    // Cheap rejection: three coverage taps along the slab. An empty ray costs
    // 3 samples instead of the full march, which is most of the sky most of
    // the time.
    vec3 pa = uCamPos + d * t0;
    vec3 pb = uCamPos + d * mix(t0, t1, 0.5);
    vec3 pc = uCamPos + d * t1;
    float ca_ = coverageAt(pa.xz), cb_ = coverageAt(pb.xz), cc_ = coverageAt(pc.xz);

    if (max(ca_, max(cb_, cc_)) > 0.01) {
      // Geometric stepping. A uniform step sized for a 20 km grazing traverse
      // is ~800 m, which slices nearby cloud into visible horizontal plates;
      // sized for nearby cloud it never reaches the horizon. Growing the step
      // gives ~70 m resolution on the cumulus you are actually looking at and
      // lets the tail of the ray run cheap and coarse, where the distance fade
      // is about to swallow it anyway.
      float span = min(t1 - t0, 16000.0);
      t1 = t0 + span;
      const float GROW = 1.10;
      float s0 = span * (GROW - 1.0) / (pow(GROW, float(STEPS)) - 1.0);
      // Stable per-pixel jitter (no temporal term) breaks the slab banding
      // without introducing crawl — there is no TAA in the chain to clean up
      // an animated dither.
      // Interleaved gradient noise, not a sin-hash: the sin-hash aliases into
      // visible rectangular moiré at 1600×900, which on a slab crossed at a
      // grazing angle turns into torn-paper edges on every cloud.
      float ign = fract(52.9829189 * fract(0.06711056 * gl_FragCoord.x
                                         + 0.00583715 * gl_FragCoord.y));
      float jit = ign * s0;

      float trans = 1.0 - alpha;
      vec3 cum = vec3(0.0);
      float cumA = 0.0;
      // Forward scatter: the silver lining you get looking toward the sun.
      // Additive only — multiplying the whole cloud by a phase function is
      // what turned the deck into brown smog in the previous pass.
      float silver = clamp(hg(dot(d, uSunDir), 0.68) * 0.055, 0.0, 1.1);

      float t = t0 + jit;
      float stepLen = s0;
      for (int i = 0; i < STEPS; i++) {
        if (trans < 0.02) break;
        if (t > t1) break;
        vec3 p = uCamPos + d * t;
        float cov = coverageAt(p.xz);
        float dens = cov <= 0.001 ? 0.0 : densityAt(p, cov);
        if (dens <= 0.001) { t += stepLen; stepLen *= GROW; continue; }

        float hf = clamp((p.y - BASE_Y) / THICK, 0.0, 1.0);

        // Self-shadow: a two-sample optical depth along the actual sun ray.
        // Coverage-only (no erosion taps) — at 260 m and 760 m the shape of
        // the cloud, not its fuzz, is what decides whether this sample sees
        // the sun. This is the whole warm-crown / violet-base split.
        vec3 l1 = p + uSunDir * 260.0;
        vec3 l2 = p + uSunDir * 760.0;
        float od = profileAt(l1.y, coverageAt(l1.xz)) * 300.0
                 + profileAt(l2.y, coverageAt(l2.xz)) * 620.0;
        float energy = exp(-od * uDensity * 1.9);
        // Never fully black: multiple scattering keeps real cloud shadow open.
        energy = 0.14 + 0.86 * energy;

        vec3 col = mix(uDark, uLit, energy);
        // Sky bounce fills the base; the crown already has the sun.
        col = mix(col, uAmbient, (1.0 - hf) * 0.22);
        // Powder: thin edges scatter forward hardest, which is what draws the
        // bright rim around a backlit cloud.
        col += uLit * silver * (1.0 - dens * 1.6) * energy;

        float a = 1.0 - exp(-dens * uDensity * stepLen);
        cum += trans * a * col;
        cumA += trans * a;
        trans *= (1.0 - a);
        t += stepLen;
        stepLen *= GROW;
      }
      acc += cum;
      alpha += cumA;
    }
  }

  if (alpha <= 0.002) discard;

  // Aerial perspective on the deck itself: distant cloud melts into the haze
  // band, which is what stops the horizon reading as a hard cut-off line.
  // Undo the pre-multiply first so the fade is a colour blend, not a dim.
  vec3 col = acc / max(alpha, 1e-4);
  // Fade on *distance*, not view elevation. The canonical cameras never look
  // higher than ~15°, so an elevation-based fade erases the entire deck; a
  // distance fade keeps the cumulus that sit 3–8 km out, which is where they
  // actually read as clouds with size.
  float far = smoothstep(7500.0, 17000.0, tEntry);
  col = mix(col, uHorizon, far * 0.85);

  float a = clamp(alpha, 0.0, 1.0) * (1.0 - far * 0.75) * uOpacity;
  gl_FragColor = vec4(col * a, a);   // pre-multiplied; see the blend setup
}`;

// ── tiling noise tile ────────────────────────────────────────────────────────

/** Periodic value noise: `freq` lattice cells across the tile, wraps exactly. */
function latticeNoise(size, freq, rand) {
  const lat = new Float32Array(freq * freq);
  for (let i = 0; i < lat.length; i++) lat[i] = rand();
  const out = new Float32Array(size * size);
  const scale = freq / size;
  for (let y = 0; y < size; y++) {
    const fy = y * scale, iy = Math.floor(fy);
    let ty = fy - iy;
    ty = ty * ty * (3 - 2 * ty);
    const y0 = ((iy % freq) + freq) % freq, y1 = (y0 + 1) % freq;
    for (let x = 0; x < size; x++) {
      const fx = x * scale, ix = Math.floor(fx);
      let tx = fx - ix;
      tx = tx * tx * (3 - 2 * tx);
      const x0 = ((ix % freq) + freq) % freq, x1 = (x0 + 1) % freq;
      const a = lat[y0 * freq + x0], b = lat[y0 * freq + x1];
      const c = lat[y1 * freq + x0], e = lat[y1 * freq + x1];
      out[y * size + x] = (a + (b - a) * tx) + ((c + (e - c) * tx) - (a + (b - a) * tx)) * ty;
    }
  }
  return out;
}

/** Sum of octaves; `billow` folds the noise for cauliflower edges. */
function fbm(size, freqs, rand, billow = false) {
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0;
  for (const f of freqs) {
    const o = latticeNoise(size, f, rand);
    for (let i = 0; i < out.length; i++) {
      const v = billow ? Math.abs(o[i] * 2 - 1) : o[i];
      out[i] += v * amp;
    }
    norm += amp;
    amp *= 0.52;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function buildNoiseTexture(size, seed) {
  const rand = mulberry32(seed);
  // R is deliberately the *softest* field: it doubles as the ground shadow,
  // and high-frequency detail there just reads as dirt on the meadow.
  const r = fbm(size, [4, 8, 15], rand);
  const g = fbm(size, [8, 16, 32], rand, true);
  const b = fbm(size, [16, 32, 64], rand, true);
  const a = fbm(size, [4, 9, 18], rand);

  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4 + 0] = Math.max(0, Math.min(255, Math.round(r[i] * 255)));
    data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(g[i] * 255)));
    data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(b[i] * 255)));
    data[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(a[i] * 255)));
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // No mipmaps on purpose: the march samples this inside divergent control
  // flow, where implicit-LOD derivatives are undefined in GLSL ES. The R
  // channel is low-frequency enough that the ground shadow does not alias.
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const TIERS = {
  ultra:  { steps: 26, size: 512 },
  high:   { steps: 24, size: 384 },
  medium: { steps: 14, size: 256 },
  low:    { steps: 9,  size: 192 },
};

export class Clouds extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Clouds';
    this.loadLabel = 'Building weather';
    // Wind, in metres/second of cloud drift. Slow on purpose: at this scale
    // anything faster than a brisk walk reads as a screensaver.
    this.wind = new THREE.Vector2(4.4, 2.1);
    this._uv = new THREE.Vector2();
  }

  async init() {
    const { scene, quality, preset } = this.ctx;
    const tier = TIERS[quality] ?? TIERS.high;
    // `volumetric: false` tiers still get clouds — just a coarser march. A
    // deck of cumulus is load-bearing for the composition, not an effect.
    const steps = preset?.volumetric ? tier.steps : Math.max(8, Math.round(tier.steps * 0.55));

    this.noise = buildNoiseTexture(tier.size, SEED ^ 0x51ed5);

    this.uniforms = {
      uNoise:    { value: this.noise },
      uCamPos:   { value: new THREE.Vector3() },
      uSunDir:   { value: new THREE.Vector3(0, 1, 0) },
      uLit:      { value: new THREE.Color(0xffffff) },
      uDark:     { value: new THREE.Color(0x8888aa) },
      uAmbient:  { value: new THREE.Color(0x9aa8c8) },
      uHorizon:  { value: new THREE.Color(0xf0d6b4) },
      uWind:     { value: new THREE.Vector2() },
      uCover:    { value: 0.5 },
      uDensity:  { value: 0.030 },
      uInvTile:  { value: 1 / TILE },
      uCirrus:   { value: 0.5 },
      uOpacity:  { value: 1.0 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      defines: { STEPS: steps },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: true,
      // See the header: opaque queue (so renderOrder wins over the terrain)
      // but still alpha-blended over the sky dome.
      transparent: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,          // colour is pre-multiplied in the shader
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -999;
    this.mesh.name = 'Clouds';
    scene.add(this.mesh);

    // Hand the same coverage field to the shared atmosphere so the meadow
    // gets the shadow of the cloud that is actually overhead.
    this.ctx.atmosphere?.setCloudShadow({
      map: this.noise,
      scale: 1 / TILE,
      altitude: BASE,
      strength: 0.30,
    });
  }

  update(dt, elapsed) {
    if (!this.mesh) return;
    const s = SKY_STATE;
    const u = this.uniforms;

    // uv drift = metres travelled / tile size.
    this._uv.set(-this.wind.x * elapsed / TILE, -this.wind.y * elapsed / TILE);
    u.uWind.value.copy(this._uv);
    u.uCamPos.value.copy(this.ctx.camera.position);
    u.uSunDir.value.copy(s.sunDir);
    u.uLit.value.copy(s.cloudLit);
    u.uDark.value.copy(s.cloudDark);
    u.uAmbient.value.copy(s.cloudAmbient);
    u.uHorizon.value.copy(s.fogFar).lerp(s.horizon, 0.5);
    u.uCover.value = s.cloudCover;
    u.uCirrus.value = 0.42 * (0.35 + 0.65 * s.dayFactor);
    u.uOpacity.value = 0.35 + 0.65 * s.dayFactor;

    this.mesh.position.copy(this.ctx.camera.position);

    // Scroll the ground shadow with the deck, and fade it out with the sun so
    // an overcast dusk does not stamp hard patches on an unlit valley.
    const a = this.ctx.atmosphere;
    if (a) {
      a.setCloudOffset(this._uv.x, this._uv.y);
      a.params.cloudShadow = 0.34 * Math.min(Math.max((s.sunElev - 0.02) / 0.18, 0), 1);
    }
    void dt;
  }

  dispose() {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.noise?.dispose();
    this.ctx.scene.remove(this.mesh);
    this.mesh = null;
  }
}
