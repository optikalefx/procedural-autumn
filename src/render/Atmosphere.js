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
//    · Mie inscattering      looking toward the sun brightens the haze
//    · two-tone extinction   warm near, cool far, like real Rayleigh/Mie split
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { PALETTE } from '../world/WorldConfig.js';

const FOG_PARS = /* glsl */`
#ifdef USE_FOG
  uniform vec3  fogColor;          // near / ground haze colour
  uniform vec3  uFogFarColor;      // distant colour (cooler, bluer)
  uniform vec3  uFogSunColor;      // inscattered sunlight
  uniform vec3  uFogSunDir;
  uniform float uFogDensity;       // extinction at sea level, per metre
  uniform float uFogHeightFalloff; // 1 / scale-height
  uniform float uFogBaseHeight;
  uniform float uFogInscatter;     // Mie strength toward the sun
  uniform float uFogAnisotropy;    // Henyey–Greenstein g
  uniform float uFogFarStart;
  uniform float uFogMax;
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

  // ── colour: warm ground haze -> cool distant air, plus sun glow ─────────
  float farMix = smoothstep(uFogFarStart, uFogFarStart * 4.5, dist);
  vec3 hazeCol = mix(fogColor, uFogFarColor, farMix);
  hazeCol = mix(hazeCol, uFogSunColor, clamp(hg * uFogInscatter, 0.0, 0.85));

  gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeCol, clamp(fogFactor, 0.0, uFogMax));
}
#endif`;

let patched = false;

export function patchFogChunks() {
  if (patched) return;
  patched = true;
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS;
  THREE.ShaderChunk.fog_fragment = FOG_FRAG;
  THREE.ShaderChunk.fog_pars_vertex = FOG_VERT_PARS;
  THREE.ShaderChunk.fog_vertex = FOG_VERT;

  // Register the extra uniforms so three uploads them for every fogged material.
  const extra = {
    uFogFarColor:      { value: PALETTE.fogFar.clone() },
    uFogSunColor:      { value: PALETTE.sunDisc.clone() },
    uFogSunDir:        { value: new THREE.Vector3(0, 1, 0) },
    uFogDensity:       { value: 0.0062 },
    uFogHeightFalloff: { value: 0.0125 },
    uFogBaseHeight:    { value: -4.0 },
    uFogInscatter:     { value: 2.6 },
    uFogAnisotropy:    { value: 0.62 },
    uFogFarStart:      { value: 260.0 },
    uFogMax:           { value: 0.985 },
  };
  Object.assign(THREE.UniformsLib.fog, extra);
  return extra;
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
      density: 0.0062,
      heightFalloff: 0.0125,
      baseHeight: -4.0,
      inscatter: 2.6,
      anisotropy: 0.62,
      farStart: 260.0,
      max: 0.985,
      nearColor: PALETTE.fogNear.clone(),
      farColor: PALETTE.fogFar.clone(),
      sunColor: PALETTE.sunDisc.clone(),
    };
    this._materials = new Set();
  }

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
      if (u.fogColor) u.fogColor.value.copy(p.nearColor);
    }
    void sunColor; void elevation01;
  }
}
