// ─────────────────────────────────────────────────────────────────────────────
//  Atmosphere — physically-motivated aerial perspective.
//
//  Three's built-in fog is a flat exponential: it fogs a mountain peak and the
//  valley floor identically, which is exactly what makes stylised scenes read
//  as "washed out" instead of "deep". This replaces the fog chunks globally so
//  every material — terrain, trees, rock, water, the camper — shares one
//  atmosphere with:
//
//    · height falloff        haze pools in the valleys, thins over ridges
//    · analytic integration  correct optical depth along a slanted ray
//    · chroma falloff        distance eats saturation faster than it eats
//                            contrast — this is what separates ridgelines into
//                            clean layers instead of one flat wash
//    · Mie inscattering      looking toward the sun brightens the haze
//    · two-tone extinction   warm near, cool far, like real Rayleigh/Mie split
//    · cloud shadow          one tap of a tiling coverage map, projected along
//                            the sun. Lives here because the fog chunk is the
//                            one hook that reaches every material in the game
//                            without editing anyone else's shader.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { PALETTE } from '../world/WorldConfig.js';

const FOG_PARS = /* glsl */`
#ifdef USE_FOG
  uniform vec3  fogColor;          // near / ground haze colour
  uniform vec3  uFogFarColor;      // distant colour (cooler, bluer)
  uniform vec3  uFogSunColor;      // inscattered sunlight
  uniform vec3  uFogSunDir;
  uniform float uFogDensity;       // extinction at base height, per metre
  uniform float uFogHeightFalloff; // 1 / scale-height
  uniform float uFogBaseHeight;
  uniform float uFogInscatter;     // Mie strength toward the sun
  uniform float uFogInscatterMax;
  uniform float uFogAnisotropy;    // Henyey–Greenstein g
  uniform float uFogFarStart;
  uniform float uFogMax;
  uniform float uFogDesat;         // how much chroma distance eats
  uniform sampler2D uCloudMap;
  uniform float uCloudShadow;      // 0 = off
  uniform float uCloudScale;       // world metres -> uv
  uniform float uCloudAltitude;
  uniform vec2  uCloudOffset;
  varying vec3  vFogWorldPos;
  varying vec3  vFogCamPos;
#endif`;

const FOG_VERT_PARS = /* glsl */`
#ifdef USE_FOG
  varying vec3 vFogWorldPos;
  varying vec3 vFogCamPos;
#endif`;

const FOG_VERT = /* glsl */`
#ifdef USE_FOG
  vFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vFogCamPos = cameraPosition;
#endif`;

const FOG_FRAG = /* glsl */`
#ifdef USE_FOG
{
  vec3 toFrag = vFogWorldPos - vFogCamPos;
  float dist = length(toFrag);
  vec3 dir = dist > 1e-4 ? toFrag / dist : vec3(0.0, 1.0, 0.0);

  // ── cloud shadow ────────────────────────────────────────────────────────
  // Walk from the surface up the sun ray to cloud altitude and sample the
  // same coverage field the cloud dome marches. One tap, no extra passes.
  if (uCloudShadow > 0.001) {
    float sy = max(uFogSunDir.y, 0.16);
    float climb = clamp((uCloudAltitude - vFogWorldPos.y) / sy, 0.0, 4200.0);
    vec2 cuv = (vFogWorldPos.xz + uFogSunDir.xz * climb) * uCloudScale + uCloudOffset;
    float cov = texture2D(uCloudMap, cuv).r;
    // Soft, wide edges: a hard-edged cloud shadow at this scale reads as a
    // texture crawling over the ground rather than as weather.
    float shade = 1.0 - uCloudShadow * smoothstep(0.42, 0.78, cov);
    gl_FragColor.rgb *= shade;
  }

  // ── analytic height-fog optical depth ───────────────────────────────────
  // rho(y) = D * exp(-k * (y - baseY));  integrate along the ray.
  float k  = uFogHeightFalloff;
  float y0 = vFogCamPos.y - uFogBaseHeight;
  float dy = toFrag.y;
  float baseDensity = uFogDensity * exp(-k * y0);
  float integral;
  if (abs(dy) < 1e-3) {
    integral = baseDensity * dist;
  } else {
    integral = baseDensity * dist * (1.0 - exp(-k * dy)) / (k * dy);
  }
  integral = max(integral, 0.0);
  float fogFactor = 1.0 - exp(-integral);

  // ── Mie inscattering: the haze glows around the sun ─────────────────────
  float cosT = dot(dir, uFogSunDir);
  float g = uFogAnisotropy;
  float hg = (1.0 - g * g) / (4.0 * 3.14159265 * pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-4), 1.5));

  // ── colour ──────────────────────────────────────────────────────────────
  // Chroma goes before value does. Bleeding saturation out ahead of the haze
  // mix is what makes 400 m, 900 m and 1500 m read as three distinct planes.
  float lum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(lum),
                         clamp(uFogDesat * fogFactor, 0.0, 1.0));

  float farMix = smoothstep(uFogFarStart, uFogFarStart * 5.0, dist);
  vec3 hazeCol = mix(fogColor, uFogFarColor, farMix);
  hazeCol = mix(hazeCol, uFogSunColor, clamp(hg * uFogInscatter, 0.0, uFogInscatterMax));

  gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeCol, clamp(fogFactor, 0.0, uFogMax));
}
#endif`;

// A 4×4 mid-grey map so the cloud-shadow tap is never a null sampler for
// materials cloned before Clouds finishes building the real one.
function neutralCloudMap() {
  const d = new Uint8Array(4 * 4 * 4).fill(0);
  const t = new THREE.DataTexture(d, 4, 4, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

const DEFAULTS = {
  density: 0.0015,
  // ~450 m scale height. Shorter than this and the analytic integral collapses
  // the moment the camera climbs a peak — a vista shot loses all its haze
  // exactly where the layering matters most.
  heightFalloff: 0.0022,
  baseHeight: 10.0,
  inscatter: 1.35,
  inscatterMax: 0.62,
  anisotropy: 0.60,
  farStart: 300.0,
  max: 0.93,               // never a perfect wash — the last ridge keeps 7%
  desat: 0.72,
  cloudShadow: 0.0,
  cloudScale: 1 / 2600,
  cloudAltitude: 900.0,
};

let patched = false;
let sharedCloudMap = null;

export function patchFogChunks() {
  if (patched) return;
  patched = true;
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS;
  THREE.ShaderChunk.fog_fragment = FOG_FRAG;
  THREE.ShaderChunk.fog_pars_vertex = FOG_VERT_PARS;
  THREE.ShaderChunk.fog_vertex = FOG_VERT;

  sharedCloudMap = neutralCloudMap();

  // Register the extra uniforms so three uploads them for every fogged
  // material, and so `fogUniforms()` hands opt-in ShaderMaterials the same set.
  Object.assign(THREE.UniformsLib.fog, {
    uFogFarColor:      { value: PALETTE.fogFar.clone() },
    uFogSunColor:      { value: PALETTE.sunDisc.clone() },
    uFogSunDir:        { value: new THREE.Vector3(0, 1, 0) },
    uFogDensity:       { value: DEFAULTS.density },
    uFogHeightFalloff: { value: DEFAULTS.heightFalloff },
    uFogBaseHeight:    { value: DEFAULTS.baseHeight },
    uFogInscatter:     { value: DEFAULTS.inscatter },
    uFogInscatterMax:  { value: DEFAULTS.inscatterMax },
    uFogAnisotropy:    { value: DEFAULTS.anisotropy },
    uFogFarStart:      { value: DEFAULTS.farStart },
    uFogMax:           { value: DEFAULTS.max },
    uFogDesat:         { value: DEFAULTS.desat },
    uCloudMap:         { value: sharedCloudMap },
    uCloudShadow:      { value: DEFAULTS.cloudShadow },
    uCloudScale:       { value: DEFAULTS.cloudScale },
    uCloudAltitude:    { value: DEFAULTS.cloudAltitude },
    uCloudOffset:      { value: new THREE.Vector2() },
  });
}

/**
 * Uniform block a custom ShaderMaterial must merge in to participate in the
 * shared atmosphere. Pair with `fog: true` and the standard fog shader chunks.
 */
export function fogUniforms() {
  return THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
}

export class Atmosphere {
  constructor(scene) {
    patchFogChunks();
    this.scene = scene;
    // A Fog instance is what makes three define USE_FOG; the near/far are unused.
    scene.fog = new THREE.Fog(PALETTE.fogNear.clone(), 1, 10000);

    this.params = {
      ...DEFAULTS,
      nearColor: PALETTE.fogNear.clone(),
      farColor: PALETTE.fogFar.clone(),
      sunColor: PALETTE.sunDisc.clone(),
      cloudMap: sharedCloudMap,
      cloudOffset: new THREE.Vector2(),
    };
    this._materials = new Set();
  }

  /**
   * Hand the shared atmosphere a tiling cloud-coverage map (red channel) so
   * the landscape gets the shadows of the clouds actually drawn overhead.
   * Called by Clouds; safe to never call.
   */
  setCloudShadow({ map, scale, altitude, strength }) {
    if (map) this.params.cloudMap = map;
    if (scale !== undefined) this.params.cloudScale = scale;
    if (altitude !== undefined) this.params.cloudAltitude = altitude;
    if (strength !== undefined) this.params.cloudShadow = strength;
  }

  /** Scroll the projected cloud shadows with the cloud wind. */
  setCloudOffset(x, y) { this.params.cloudOffset.set(x, y); }

  /**
   * Track a material so its fog uniforms get driven each frame.
   * Never flips `fog` on: a ShaderMaterial that did not opt in has no fog
   * uniform block, and forcing it makes three throw inside refreshFogUniforms.
   * Custom shaders opt in with `fogUniforms()` + `fog: true`.
   */
  register(material) {
    if (!material || material.fog === false) return material;
    this._materials.add(material);
    return material;
  }

  /** Walk the scene and pick up anything new. Cheap; call occasionally. */
  harvest() {
    this.scene.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) this.register(m);
    });
  }

  update(sunDir, sunColor, elevation01) {
    const p = this.params;
    this.scene.fog.color.copy(p.nearColor);

    for (const m of this._materials) {
      const u = m.userData?.shader?.uniforms ?? m.uniforms;
      if (!u || !u.uFogDensity) continue;
      u.uFogDensity.value = p.density;
      u.uFogHeightFalloff.value = p.heightFalloff;
      u.uFogBaseHeight.value = p.baseHeight;
      u.uFogInscatter.value = p.inscatter;
      u.uFogAnisotropy.value = p.anisotropy;
      u.uFogFarStart.value = p.farStart;
      u.uFogMax.value = p.max;
      u.uFogFarColor.value.copy(p.farColor);
      u.uFogSunColor.value.copy(p.sunColor);
      u.uFogSunDir.value.copy(sunDir);
      if (u.uFogInscatterMax) u.uFogInscatterMax.value = p.inscatterMax;
      if (u.uFogDesat) u.uFogDesat.value = p.desat;
      if (u.uCloudShadow) {
        u.uCloudShadow.value = p.cloudShadow;
        u.uCloudScale.value = p.cloudScale;
        u.uCloudAltitude.value = p.cloudAltitude;
        u.uCloudOffset.value.copy(p.cloudOffset);
        if (u.uCloudMap.value !== p.cloudMap) u.uCloudMap.value = p.cloudMap;
      }
      if (u.fogColor) u.fogColor.value.copy(p.nearColor);
    }
    void sunColor; void elevation01;
  }
}
