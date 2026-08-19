// ─────────────────────────────────────────────────────────────────────────────
//  Clouds — a parallax-sliced cumulus deck over the sky dome, plus a cirrus veil.
//
//  WHY THIS IS NOT A RAYMARCH ANY MORE
//  -----------------------------------
//  The previous pass marched a density slab. A march needs a per-pixel jitter or
//  it bands, and a jitter needs a temporal filter or it stipples. There is no
//  TAA and no blur in this project's post chain — the grade and the bloom belong
//  to another author and neither of them cleans up noise. So every cloud in the
//  game carried a woven cross-hatch, and at the grazing angles the canonical
//  cameras actually use (they never look higher than ~30°) a 26 km slab traverse
//  tore that hatch into horizontal ribbons. That is unfixable inside a march
//  without a filter to hide the sampling.
//
//  So the deck is now a *heightfield*, evaluated analytically:
//
//    · one smooth field  H(uv)  gives the cloud-top altitude over the deck base
//    · the ray is sampled at a handful of FIXED altitudes between base and top,
//      each offset by the true horizontal parallax of the view ray
//    · every sample position varies smoothly across the screen, so there is no
//      per-pixel noise anywhere — the only edges are the silhouette edges, and
//      those are antialiased analytically with fwidth
//
//  The parallax is what keeps this from being a painted backdrop: the crown
//  slices sit further from the camera than the base slices, so a cloud shows its
//  flat lit base on the near side and its billowing crown on the far side, and
//  the silhouette genuinely changes as you drive under it. The parallax is
//  *clamped*, though — an unclamped one smears the deck into ribbons at the
//  horizon, which is the ribbon artifact we started with.
//
//  It also happens to be the right look. The reference plates have no crisply
//  modelled cumulus in them at all: they have broad flat masses of colour with
//  soft edges, which is exactly what a shaded heightfield gives and exactly what
//  a volumetric march fights against.
//
//  Everything is driven from one tiling 4-channel noise tile:
//      R  low-frequency coverage      (also the cloud-shadow map on the ground)
//      G  mid-frequency billow
//      B  high-frequency fray
//      A  stretched cirrus
//  Using the *same* R channel for the ground shadow is what makes the shadow on
//  the meadow line up with the cloud you can see overhead.
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
//
// The numbers are chosen from the angular size they produce, not from
// meteorology. The canonical cameras see roughly 0…30° of sky. A cell of the
// coverage field is about TILE/3 across; at 20° elevation the deck base is
// ~2.9 km away, so that cell subtends ~27° — three or four cloud masses across
// a 52° frame, which is the composition the reference plates use. Push TILE up
// and one cloud fills the sky; push it down and the deck turns to popcorn.
const BASE = 1500;
const TOP = 2700;
const TILE = 7000;          // world size of one wrap of the noise tile
const CIRRUS_ALT = 6200;
const CIRRUS_TILE = 30000;

// Orientation only — see the long note on the same line in Sky.js. The deck's
// parallax has to come from uCamPos and the view ray, never from where this
// 1 m sphere happens to be sitting relative to the eye.
const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = vec4(mat3(modelViewMatrix) * position, 1.0);
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
uniform float uInvTile;
uniform float uCirrus;      // cirrus opacity
uniform float uOpacity;     // global fade (kills clouds at night gracefully)
uniform float uSoft;        // extra silhouette softness

const float BASE_Y = ${BASE.toFixed(1)};
const float THICK  = ${(TOP - BASE).toFixed(1)};
// Vertical span, in field units, over which a cloud goes from nothing to its
// full height. Narrow = cliff-edged cartoon cloud, wide = mush.
//
// Narrowed along with the threshold below. The coverage field only has ~0.14 of
// headroom above the new threshold, and a ramp wider than that headroom means
// no column ever reaches full height: every cloud comes out a flat wisp with no
// crown for the parallax slices or the normal to shade.
const float RAMP   = 0.100;

// The coarse coverage field — the only thing sampled per slice, and therefore
// the only thing whose feature size has to stay above the slice spacing. Its
// finest octave is 8 cycles across the tile, i.e. 700 m, against a worst-case
// slice spacing of ~385 m. Break that inequality and the deck stratifies into
// horizontal mackerel rows, which is exactly what the old march did.
float coarse(vec2 uv) {
  return texture2D(uNoise, uv).r;
}

// Cloud-top altitude at uv, as a fraction of the deck thickness. 0 = no cloud.
// det is the fine detail, sampled ONCE per pixel and added to every slice
// alike: a constant offset along the ray cannot stratify the deck, but it still
// varies across the screen, so the silhouette gets its fray back for free.
float topRaw(vec2 uv, float lo, float det) {
  return (coarse(uv) + det - lo) / RAMP;
}
float topAt(vec2 uv, float lo, float det) {
  return clamp(topRaw(uv, lo, det), 0.0, 1.0);
}

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}

void main() {
  vec3 d = normalize(vDir);
  // Never branch on d.y before the derivatives below — a discard here poisons
  // fwidth for the whole 2x2 quad and puts a dotted line along the skyline.
  float dy = max(d.y, 0.012);

  // Where the view ray crosses the cloud base, and the uv there. Capped: an
  // uncapped 1/dy at the skyline blows the uv derivative up past anything a
  // 512² tile can represent, which is where the venetian-blind moire came from.
  float tBase = min((BASE_Y - uCamPos.y) / dy, 46000.0);
  vec2 uv0 = (uCamPos.xz + d.xz * tBase) * uInvTile + uWind;

  // Horizontal uv travel of the view ray across the full deck thickness. This
  // is the parallax that gives the deck its volume: the crown slices land
  // further from the camera than the base slices, so a cloud shows its flat
  // base on the near side and its billowing crown on the far side.
  //
  // It has to be clamped. The true value at 5° of elevation is two whole tiles,
  // which spreads the slices further apart than the cloud features themselves
  // and stratifies the deck into the horizontal ribbons this shader exists to
  // get rid of. The clamp is set to just under one slice-spacing per feature:
  // past it the deck stops gaining apparent height and flattens toward the
  // skyline, which is what distant cumulus do anyway.
  //
  // Tightened from 0.75 with the coverage cut. 0.75 of a tile is six widths of
  // the coarsest coverage feature, so the eight slices under a low-elevation
  // pixel were six near-independent draws on the coverage field, and their
  // *union* is what the eye reads as sky cover — which is why the deck looked
  // overcast at only half areal coverage. At 0.40 the slices stay inside about
  // three feature widths and a gap in the field survives as a gap in the sky.
  vec2 par = d.xz / dy * (THICK * uInvTile);
  float pl = length(par);
  par *= min(pl, 0.40) / max(pl, 1e-4);

  // Coverage threshold. Higher cover = lower threshold = more sky filled.
  //
  // WHY THIS NUMBER IS NOT 0.745
  // ----------------------------
  // 0.745 was picked as if the coverage field were uniform on 0..1 with a mean
  // of 0.5. It is not: normalize01() stretches an fbm min-to-max, and this
  // field's mean comes out at 0.635. So the shipping-hour threshold of 0.650
  // landed within 0.015 of the field's own median and put HALF the deck area
  // under cloud — measured, 50.7% areal at cover 0.215.
  //
  // Areal is not what the player sees, either. Every ray crosses the deck at a
  // grazing angle, so a low-elevation pixel is the union of eight slices spread
  // over several feature widths, and a 50% areal deck reads as an overcast one:
  // measured, 84-99% of visible sky was cloud in the eye-level and hero views,
  // which is exactly the "the sky is like 90% clouds" the player reported.
  //
  // The reference plates are the opposite — open gradient with, at most, a few
  // soft high wisps — and an overcast deck also flattens the light this whole
  // palette is built on. So the threshold is now set from the field's measured
  // distribution rather than an assumed one: 0.86 at the shipping hour is the
  // top ~17% of the field by area, which lands the visible sky around a third
  // cloud. tools/_scratch/cloudfrac.mjs is the measurement.
  float lo = 0.950 - 0.44 * uCover;

  // Fine detail: two taps, once, at the middle of the slab. See topAt().
  vec2  uvM = uv0 + par * 0.5;
  // Kept well under RAMP: detail this field can outweigh the coarse coverage
  // turns organised cloud masses into an even mottle, which is the other way
  // for a sky to look broken.
  // Scaled down with RAMP, so the detail keeps the same weight against the
  // coarse coverage it perturbs and does not start deciding where clouds are.
  float det = (texture2D(uNoise, uvM * 1.5 + vec2(0.31, -0.17)).g - 0.5) * 0.084
            + (texture2D(uNoise, uvM * 2.6 + vec2(-0.23, 0.41)).b - 0.5) * 0.036;

  // Column height at the middle of the slab: the one value that drives the
  // lighting, so shading costs a few extra taps for the whole pixel rather
  // than a few per slice.
  float ht  = topAt(uvM, lo, det);

  // Analytic antialiasing. fwidth of the height field is exactly the pixel
  // footprint in the units the silhouette threshold uses, so the same number
  // both antialiases nearby cloud edges and melts distant ones into a wash
  // instead of letting them alias.
  float sw = max(fwidth(ht) * 1.4, 0.085 + uSoft);

  // ── shading ──────────────────────────────────────────────────────────────
  // The deck is a heightfield, so it has a real normal, and at golden hour the
  // normal is what matters: a 6° sun lights the *flanks* of a cumulus, not its
  // crown. Shading on altitude alone (which is what the first version of this
  // did) leaves every cloud the colour of its own underside — a violet-grey
  // sheet — no matter where the sun is.
  // Differences on the UNCLAMPED height. Clamping first flattens the interior
  // of every cloud to a plateau with a dead-vertical normal, and a plateau lit
  // by a 9° sun comes out the colour of its own shadow — the whole deck went
  // violet-grey at exactly the hour it should be glowing.
  const float EPS = 0.055;
  float raw = topRaw(uvM, lo, det);
  float hx = topRaw(uvM + vec2(EPS, 0.0), lo, det) - raw;
  float hz = topRaw(uvM + vec2(0.0, EPS), lo, det) - raw;
  // dz/dx in world units: a height fraction over a uv distance.
  float k = THICK / (EPS / uInvTile);
  vec3 nrm = normalize(vec3(-hx * k, 1.0, -hz * k));
  // A very wide terminator, to sit with the global stylised diffuse the rest
  // of the game uses. A hard lambert here reads as a plastic ball, and at a 9°
  // sun it also leaves nine tenths of the deck unlit.
  float lam = smoothstep(-0.85, 0.55, dot(nrm, uSunDir));

  // Self-shadow: is the column one sun-step toward the sun taller than this
  // one? That single comparison is what puts a cloud in the shadow of its
  // neighbour, and unlike an optical-depth march it cannot stipple.
  vec2 sunStep = uSunDir.xz / max(uSunDir.y, 0.20) * (THICK * uInvTile);
  float pls = length(sunStep);
  sunStep *= min(pls, 0.60) / max(pls, 1e-4);
  float hs = topAt(uvM + sunStep * 0.7, lo, det);
  float shadow = clamp((hs - ht) * 1.7, 0.0, 1.0);

  // Forward scatter: the silver lining you get looking toward the sun. Thin
  // margins scatter hardest, hence the (1 - ht) weight.
  float silver = clamp(hg(dot(d, uSunDir), 0.74) * 0.042, 0.0, 0.9) * (1.0 - ht * 0.70);

  vec3  acc = vec3(0.0);
  float alpha = 0.0;
  float trans = 1.0;

  // Front to back: slice 0 is the deck base, which is the nearest point on the
  // ray, so it occludes the crown behind it.
  for (int i = 0; i < SLICES; i++) {
    float f = float(i) / float(SLICES - 1);
    float h = topAt(uv0 + par * f, lo, det);
    float inside = smoothstep(f - sw, f + sw, h);
    if (inside <= 0.002) continue;

    // Altitude only *biases* the lit fraction — the base of a cloud is never
    // as bright as its shoulder — but the normal decides it.
    float lit = lam * (0.50 + 0.50 * f);
    float energy = (0.18 + 0.82 * lit) * (1.0 - 0.50 * shadow);
    vec3 col = mix(uDark, uLit, energy);
    col = mix(col, uAmbient, (1.0 - f) * 0.22);
    col += uLit * silver;

    float a = inside * 0.64;
    acc   += trans * a * col;
    alpha += trans * a;
    trans *= (1.0 - a);
  }

  // ── cirrus veil, behind the cumulus ──────────────────────────────────────
  if (uCirrus > 0.004 && trans > 0.02) {
    float tc = min((${CIRRUS_ALT.toFixed(1)} - uCamPos.y) / dy, 40000.0);
    vec2 cu = (uCamPos.xz + d.xz * tc) / ${CIRRUS_TILE.toFixed(1)} + uWind * 0.30;
    // Anisotropic lookup: squashing one axis turns fbm blobs into wind streaks.
    float ci = texture2D(uNoise, vec2(cu.x * 0.34, cu.y)).a;
    float cw = max(fwidth(ci) * 1.5, 0.05);
    float ca = smoothstep(0.52 - cw, 0.52 + cw + 0.30, ci)
             * uCirrus * smoothstep(0.10, 0.38, d.y);
    vec3 ccol = mix(uAmbient, uLit, 0.62 + 0.38 * clamp(hg(dot(d, uSunDir), 0.5) * 0.2, 0.0, 1.0));
    acc   += trans * ca * ccol;
    alpha += trans * ca;
  }

  if (alpha <= 0.003) discard;

  // Aerial perspective on the deck itself: distant cloud melts into the haze
  // band, which is what stops the horizon reading as a hard cut-off line.
  // Undo the pre-multiply first so the fade is a colour blend, not a dim.
  vec3 col = acc / max(alpha, 1e-4);
  // Aerial fade, on view elevation alone.
  //
  // It is tempting to fade on distance instead, but on a flat deck the distance
  // to the base plane is purely a function of elevation, so a distance fade IS
  // an elevation fade — just a much steeper one, and a steep fade on a
  // horizontal band draws a dead-straight line across the frame. Hence one
  // wide, gentle ramp: full cloud above ~11°, dissolved into the haze band by
  // ~1°, which is what the reference plates do with their skylines.
  float far = 1.0 - smoothstep(0.022, 0.19, d.y);
  col = mix(col, uHorizon, far * 0.90);

  float a = clamp(alpha, 0.0, 1.0) * (1.0 - far * 0.78) * uOpacity;
  a *= smoothstep(0.004, 0.030, d.y);   // nothing below the skyline
  if (a <= 0.003) discard;
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

/**
 * Stretch a field to fill 0..1.
 *
 * This matters more than it looks. An fbm of uniform lattice noise is a sum of
 * random variables, so it piles up around 0.5 with a standard deviation of
 * barely 0.1 — and the deck's cloud-top height is a *threshold* on that field.
 * Un-normalised, no column ever got more than a fifth of the way up the slab,
 * so the whole deck rendered as one flat translucent sheet with no crown, no
 * shadowed base and nothing for the parallax to show. Normalising is what turns
 * the field back into cloud with a top.
 */
function normalize01(a) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < a.length; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; }
  const k = hi > lo ? 1 / (hi - lo) : 1;
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * k;
  return a;
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

// Nyquist note: a channel whose top lattice frequency is F, read in the shader
// at `uv * S`, needs F * S <= size / 4 or it aliases into hard blocks — /4
// rather than /2 because bilinear filtering of a value-noise lattice is only
// C1, and the kink shows before the true Nyquist limit does. The highest
// combination here is B at 40 * 1.60 = 64 cycles over a 256-texel tile, which
// is the low tier's budget exactly.
function buildNoiseTexture(size, seed) {
  const rand = mulberry32(seed);
  // R is deliberately the *softest* field: it doubles as the ground shadow, and
  // high-frequency detail there just reads as dirt on the meadow.
  const r = normalize01(fbm(size, [2, 4, 8], rand));
  const g = normalize01(fbm(size, [5, 10, 20], rand, true));
  const b = normalize01(fbm(size, [8, 16, 32], rand, true));
  const a = normalize01(fbm(size, [3, 7, 14], rand));

  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4 + 0] = Math.max(0, Math.min(255, Math.round(r[i] * 255)));
    data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(g[i] * 255)));
    data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(b[i] * 255)));
    data[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(a[i] * 255)));
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // No mipmaps: the deck relies on fwidth for its level of detail, and a mip
  // chain on a 4-channel field whose channels are read at different scales
  // would blur the coverage long before it blurred the fray.
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Slices trade silhouette accuracy for taps, not for noise: dropping to four
// still gives a lit crown and a shadowed base, it just resolves the shoulder
// between them more coarsely. The tile size cannot drop below 256 without the
// B channel aliasing (see the Nyquist note above).
const TIERS = {
  ultra:  { slices: 9, size: 512 },
  high:   { slices: 8, size: 512 },
  medium: { slices: 6, size: 384 },
  low:    { slices: 4, size: 256 },
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
    // `volumetric: false` tiers still get clouds — just fewer slices. A deck of
    // cumulus is load-bearing for the composition, not an effect.
    const slices = preset?.volumetric ? tier.slices : Math.max(4, tier.slices - 3);

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
      uInvTile:  { value: 1 / TILE },
      uCirrus:   { value: 0.5 },
      uOpacity:  { value: 1.0 },
      // Fewer slices resolve the silhouette shoulder more coarsely, so the low
      // tiers buy the difference back as softness rather than showing steps.
      uSoft:     { value: Math.max(0, (9 - slices)) * 0.010 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      defines: { SLICES: slices },
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

    // Hand the same coverage field to the shared atmosphere so the meadow gets
    // the shadow of the cloud that is actually overhead.
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
    u.uCirrus.value = 0.22 * (0.35 + 0.65 * s.dayFactor);
    u.uOpacity.value = 0.35 + 0.65 * s.dayFactor;

    // Cosmetic only: the dome is drawn as a direction field (see VERT), so the
    // image no longer depends on this being exact — which matters, because the
    // camera pose is written in lateUpdate and this value is one frame old.
    // uCamPos is one frame old for the same reason, and that is harmless: at
    // 22 m/s a frame is 0.37 m against a 7000 m tile.
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
