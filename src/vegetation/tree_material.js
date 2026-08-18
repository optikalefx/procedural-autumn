// ─────────────────────────────────────────────────────────────────────────────
//  Tree materials.
//
//  All of these are raw ShaderMaterials rather than hijacked MeshStandard
//  because foliage does not obey a PBR BRDF: it is a translucent mass that has
//  to glow when backlit, occlude itself from the inside, and shade off a crown
//  normal that has nothing to do with the geometry it is drawn on. What they
//  do borrow from three is the shadow plumbing (`lights: true` + the shadowmap
//  chunks) and the shared atmosphere (`fog: true` + `fogUniforms()`), because
//  a tree that invents its own fog floats in front of the mountains.
//
//  Each material ships with a matching depth material so shadows are cast from
//  the *wind-displaced, billboarded* geometry rather than from the rest pose.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { fogUniforms } from '../render/Atmosphere.js';
import { PALETTE } from '../world/WorldConfig.js';

// ── shared GLSL ──────────────────────────────────────────────────────────────

const WIND = /* glsl */`
uniform vec3  uWindDir;        // unit, horizontal
uniform float uWindStrength;   // metres of tip travel at weight 1
uniform float uTime;

// Whole-tree sway. Two detuned oscillators plus a slow gust envelope, all
// phase-shifted along the wind direction so gusts visibly *travel* across a
// hillside instead of every tree pumping in lockstep.
vec3 windSway(vec3 worldOrigin, float weight, float phase) {
  float travel = dot(worldOrigin.xz, uWindDir.xz) * 0.022;
  float gust = 0.5 + 0.5 * sin(uTime * 0.19 - travel + phase * 0.6);
  gust *= gust;
  float sway = sin(uTime * 0.78 - travel + phase) * 0.72
             + sin(uTime * 1.41 - travel * 1.6 + phase * 2.3) * 0.28;
  float amp = uWindStrength * (0.32 + 0.9 * gust) * weight;
  vec3 o = uWindDir * (sway * amp);
  // Shorten as it leans: the tip travels on an arc, not a rubber band. Without
  // this the whole tree visibly stretches and the wind reads as jelly.
  o.y -= abs(sway) * amp * 0.24;
  return o;
}

// Per-clump flutter — small, fast, and deliberately not aligned with the wind
// so the canopy simmers instead of throbbing.
vec3 leafFlutter(float phase, float weight) {
  float g = 0.55 + 0.45 * sin(uTime * 0.19 + phase * 0.6);
  float a = uWindStrength * weight * (0.22 + 0.78 * g) * 0.17;
  return vec3(sin(uTime * 2.6 + phase * 6.1),
              sin(uTime * 3.2 + phase * 3.7) * 0.55,
              cos(uTime * 2.2 + phase * 4.9)) * a;
}
`;

// The painterly lighting model, shared by leaves and impostors so the LOD
// transition does not change how a tree is lit.
const CANOPY_LIGHT = /* glsl */`
uniform vec3  uSunDir;        // world space, points toward the sun
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uGroundColor;
uniform float uAmbient;
uniform vec3  uTransTint;
uniform float uTransStrength;
uniform float uBands;
uniform float uCanopyGain;

vec3 canopyShade(vec3 albedo, vec3 N, vec3 V, float ao, float thin, float shadow) {
  float ndl = dot(N, uSunDir);

  // Wrapped diffuse: a canopy is a translucent mass, so light bleeds well past
  // the terminator. A hard N·L makes it read as painted plastic.
  float wrap = clamp((ndl + 0.32) / 1.32, 0.0, 1.0);
  // Gentle posterisation — the reference art bands, it does not ramp.
  wrap = mix(wrap, floor(wrap * uBands + 0.5) / uBands, 0.38);
  wrap *= mix(0.18, 1.0, shadow);

  // uCanopyGain < 1 on purpose. A leaf mass shaded with a wrapped diffuse
  // collects far more light than the terrain's N·L at the same sun angle, so
  // matching the two numerically leaves the canopy a full stop brighter than
  // the meadow it stands in — which is why distant gold stands were reading as
  // cream popcorn instead of as gold. The canopy must sit *at or below* the
  // sunlit ground, exactly as it does in the reference plates.
  vec3 direct = uSunColor * wrap * mix(0.28, 0.94, ao) * uCanopyGain;
  // Sky dominates from above: without the extra lift the tops of crowns go as
  // dark as their undersides and the canopy loses all vertical form.
  vec3 hemi = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5)
            * uAmbient * ao * (0.80 + 0.48 * clamp(N.y, 0.0, 1.0));

  // Transmission. The money shot: at golden hour the far side of every crown
  // lights up like stained glass. Strongest where we look into the sun, where
  // the surface faces away from it, and where the clump is thin.
  float toward = clamp(dot(V, uSunDir), 0.0, 1.0);
  float back = clamp(-ndl, 0.0, 1.0);
  // The base term matters more than the peak. A canopy with the sun behind it
  // glows everywhere, not only where you are staring into the disc; keying
  // transmission purely off "toward" lights one tree and leaves the rest of the
  // backlit stand as brown cardboard.
  float trans = (0.34 + 0.66 * pow(toward, 1.7)) * (0.22 + 0.78 * back) * uTransStrength;
  trans *= mix(0.25, 1.0, shadow) * thin;
  // Normalise by the leaf's own brightness. A crimson maple reflects almost
  // nothing and needs the full glow; a gold aspen is already near white, and
  // boosting it the same amount drives it through the top of the tone curve —
  // which reads as washed-out cream, not as light. This is what keeps a distant
  // gold stand *coloured* instead of turning it into popcorn.
  float lum = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  trans /= 1.0 + lum * 2.4;
  vec3 transC = uSunColor * albedo * uTransTint;

  // Rim: a thin bright edge where the crown turns away — cheap silhouette pop.
  float rim = pow(clamp(1.0 - abs(dot(N, V)), 0.0, 1.0), 3.5)
            * clamp(toward * 1.4, 0.0, 1.0) * shadow;

  vec3 col = albedo * (direct + hemi) + transC * trans + uSunColor * albedo * rim * 0.5;

  // Per-channel shoulder before the global tone curve. Sunlit gold foliage plus
  // transmission lands well above 1.0 in two channels at once, and AgX resolves
  // that to cream — a whole hillside of aspen turning to popcorn. Rolling each
  // channel off separately keeps the channels apart, so the mass stays yellow
  // instead of white while still reading as "bright".
  return col / (1.0 + col * 0.34);
}
`;

const SHADOW_SAMPLE = /* glsl */`
float canopyShadow() {
  float s = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    s = getShadow(
      directionalShadowMap[ 0 ],
      directionalLightShadows[ 0 ].shadowMapSize,
      directionalLightShadows[ 0 ].shadowIntensity,
      directionalLightShadows[ 0 ].shadowBias,
      directionalLightShadows[ 0 ].shadowRadius,
      vDirectionalShadowCoord[ 0 ] );
  #endif
  return s;
}
`;

/** Uniforms every tree material shares by reference, so one write drives all. */
export function makeSharedUniforms() {
  return {
    uTime:          { value: 0 },
    uWindDir:       { value: new THREE.Vector3(1, 0, 0) },
    uWindStrength:  { value: 0.45 },
    uSunDir:        { value: new THREE.Vector3(0.4, 0.7, 0.3) },
    uSunColor:      { value: new THREE.Color(1, 0.88, 0.72) },
    uSkyColor:      { value: PALETTE.ambientSky.clone() },
    uGroundColor:   { value: PALETTE.ambientGround.clone() },
    uAmbient:       { value: 0.55 },
    uTransTint:     { value: new THREE.Color(1.62, 1.10, 0.58) },
    uTransStrength: { value: 1.9 },
    uBands:         { value: 4.0 },
    uCanopyGain:    { value: 0.82 },
  };
}

const lightUniforms = () => THREE.UniformsUtils.clone(THREE.UniformsLib.lights);

// ── leaves ───────────────────────────────────────────────────────────────────

const LEAF_VERT = /* glsl */`
attribute vec2 aCorner;
attribute vec2 aSize;
attribute vec3 aCrownN;
attribute vec3 aData;      // ao, tone, flex
attribute vec3 aColA;      // instanced
attribute vec3 aColB;      // instanced
attribute vec2 aWind;      // instanced: phase, stiffness

varying vec2 vUv;
varying vec3 vColA;
varying vec3 vColB;
varying float vTone;
varying float vAO;
varying vec3 vN;
varying vec3 vWorld;

#include <common>
#include <shadowmap_pars_vertex>
#include <fog_pars_vertex>
${WIND}

void main() {
  float scale = length(instanceMatrix[0].xyz);
  vec3 worldOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  // Per-clump phase from its own position, so clumps on one tree do not move
  // as a rigid body while the whole tree still shares an instance phase.
  float phase = aWind.x + fract(dot(position.xz, vec2(0.1731, 0.3719))) * 6.2831853;
  float flex = aData.z * aData.z * aWind.y;
  vec3 disp = windSway(worldOrigin, flex, aWind.x) + leafFlutter(phase, aData.z * aWind.y);

  vec3 local = position + disp / max(scale, 1e-4);
  vec4 worldPosition = modelMatrix * instanceMatrix * vec4(local, 1.0);

  // Billboard in the *current* camera's basis. In the shadow pass that camera
  // is the sun, so each clump presents its full disc to the light and the
  // canopy casts a soft blob rather than a card edge.
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  worldPosition.xyz += camRight * (aCorner.x * aSize.x * scale)
                     + camUp    * (aCorner.y * aSize.y * scale);

  vec3 wn = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * aCrownN);
  vec3 transformedNormal = mat3(viewMatrix) * wn;

  vUv = uv;
  vColA = aColA;
  vColB = aColB;
  vTone = aData.y;
  vAO = aData.x;
  vN = wn;
  vWorld = worldPosition.xyz;

  #ifdef USE_FOG
    vFogWorldPos = worldPosition.xyz;
    vFogCamPos = cameraPosition;
  #endif

  #include <shadowmap_vertex>
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const LEAF_FRAG = /* glsl */`
uniform sampler2D uAtlas;
uniform float uAlphaTest;
uniform float uBake;

varying vec2 vUv;
varying vec3 vColA;
varying vec3 vColB;
varying float vTone;
varying float vAO;
varying vec3 vN;
varying vec3 vWorld;

#include <common>
#include <packing>
#include <shadowmap_pars_fragment>
#include <fog_pars_fragment>
${CANOPY_LIGHT}
${SHADOW_SAMPLE}

void main() {
  vec4 t = texture2D(uAtlas, vUv);
  if (t.a < uAlphaTest) discard;

  float jitter = 0.80 + 0.36 * t.r;     // per-mark value break-up
  float core = t.g;                      // 1 deep in the clump, 0 at its rim
  float ao = clamp(vAO * mix(1.05, 0.86, core), 0.0, 1.2);

  if (uBake > 0.5) {
    // Impostor bake: encode palette weights, not colour, so a distant tree can
    // still be tinted per instance. b is reserved for bark.
    float shade = ao * jitter;
    gl_FragColor = vec4((1.0 - vTone) * shade, vTone * shade, 0.0, 1.0);
    return;
  }

  vec3 albedo = mix(vColA, vColB, vTone) * jitter;
  vec3 N = normalize(vN);
  vec3 V = normalize(vWorld - cameraPosition);
  vec3 col = canopyShade(albedo, N, V, ao, mix(1.15, 0.62, core), canopyShadow());

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const LEAF_DEPTH_VERT = /* glsl */`
attribute vec2 aCorner;
attribute vec2 aSize;
attribute vec3 aData;
attribute vec2 aWind;
varying vec2 vUv;
varying vec2 vHighPrecisionZW;
#include <common>
${WIND}
void main() {
  float scale = length(instanceMatrix[0].xyz);
  vec3 worldOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float phase = aWind.x + fract(dot(position.xz, vec2(0.1731, 0.3719))) * 6.2831853;
  float flex = aData.z * aData.z * aWind.y;
  vec3 disp = windSway(worldOrigin, flex, aWind.x) + leafFlutter(phase, aData.z * aWind.y);
  vec3 local = position + disp / max(scale, 1e-4);
  vec4 worldPosition = modelMatrix * instanceMatrix * vec4(local, 1.0);
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  worldPosition.xyz += camRight * (aCorner.x * aSize.x * scale)
                     + camUp    * (aCorner.y * aSize.y * scale);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
  vHighPrecisionZW = gl_Position.zw;
}
`;

const CUTOUT_DEPTH_FRAG = /* glsl */`
#include <packing>
uniform sampler2D uAtlas;
uniform float uAlphaTest;
varying vec2 vUv;
varying vec2 vHighPrecisionZW;
void main() {
  if (texture2D(uAtlas, vUv).a < uAlphaTest) discard;
  float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;
  gl_FragColor = packDepthToRGBA(fragCoordZ);
}
`;

export function createLeafMaterial(atlas, shared, opts = {}) {
  const bake = !!opts.bake;
  const uniforms = Object.assign(
    bake ? {} : lightUniforms(), bake ? {} : fogUniforms(), shared,
    {
      uAtlas: { value: atlas },
      uAlphaTest: { value: opts.alphaTest ?? 0.38 },
      uBake: { value: bake ? 1 : 0 },
    }
  );
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: LEAF_VERT,
    fragmentShader: LEAF_FRAG,
    lights: !bake,
    fog: !bake,
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
  });
  // three's shadow pass copies these onto the depth material; declaring them
  // keeps it from clobbering ours with `undefined`.
  mat.alphaTest = opts.alphaTest ?? 0.38;
  mat.shadowSide = THREE.DoubleSide;

  const depth = new THREE.ShaderMaterial({
    uniforms: Object.assign({}, shared, {
      uAtlas: { value: atlas },
      uAlphaTest: { value: (opts.alphaTest ?? 0.38) * 0.9 },
    }),
    vertexShader: LEAF_DEPTH_VERT,
    fragmentShader: CUTOUT_DEPTH_FRAG,
    side: THREE.DoubleSide,
  });
  return { mat, depth };
}

// ── bark ─────────────────────────────────────────────────────────────────────

const BARK_VERT = /* glsl */`
attribute vec2 aBark;      // style, wind weight
attribute vec3 aColA;      // instanced bark colour
attribute vec2 aWind;      // instanced: phase, stiffness

varying vec2 vUv;
varying vec3 vColor;
varying float vStyle;
varying vec3 vN;
varying vec3 vWorld;
varying float vHeight;

#include <common>
#include <shadowmap_pars_vertex>
#include <fog_pars_vertex>
${WIND}

void main() {
  float scale = length(instanceMatrix[0].xyz);
  vec3 worldOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  // Trunks bend, they do not flutter — half the weight of the foliage.
  vec3 disp = windSway(worldOrigin, aBark.y * aWind.y * 0.55, aWind.x);
  vec3 local = position + disp / max(scale, 1e-4);

  vec4 worldPosition = modelMatrix * instanceMatrix * vec4(local, 1.0);
  vec3 wn = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vec3 transformedNormal = mat3(viewMatrix) * wn;

  vUv = uv;
  vColor = aColA;
  vStyle = aBark.x;
  vN = wn;
  vWorld = worldPosition.xyz;
  vHeight = position.y * scale;

  #ifdef USE_FOG
    vFogWorldPos = worldPosition.xyz;
    vFogCamPos = cameraPosition;
  #endif

  #include <shadowmap_vertex>
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const BARK_FRAG = /* glsl */`
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uGroundColor;
uniform float uAmbient;
uniform float uBake;

varying vec2 vUv;
varying vec3 vColor;
varying float vStyle;
varying vec3 vN;
varying vec3 vWorld;
varying float vHeight;

#include <common>
#include <packing>
#include <shadowmap_pars_fragment>
#include <fog_pars_fragment>
${SHADOW_SAMPLE}

float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

/** One scale of birch lenticels: lens-shaped horizontal dashes on a jittered grid. */
float lenticel(vec2 uv, vec2 freq, float density, float strength) {
  vec2 g = uv * freq;
  vec2 cell = floor(g);
  vec2 f = fract(g) - 0.5;
  float r = h21(cell);
  if (r > density) return 0.0;
  f.x -= (h21(cell + 3.7) - 0.5) * 0.55;
  f.y -= (h21(cell + 9.1) - 0.5) * 0.6;
  float w = 0.16 + 0.28 * h21(cell + 5.3);      // half-length
  float t = 0.030 + 0.048 * h21(cell + 7.9);    // half-thickness at the middle
  float ex = clamp(abs(f.x) / w, 0.0, 1.0);
  float th = t * sqrt(max(0.0, 1.0 - ex * ex)); // lens profile
  return strength * smoothstep(th, th * 0.3, abs(f.y)) * (1.0 - smoothstep(0.80, 1.0, ex));
}

void main() {
  // pat is the bark *pattern*, kept separate from the base colour so the
  // impostor bake can store shading without baking a species hue into it.
  // (Named pat, not mod: mod() is a GLSL builtin and shadowing it is illegal.)
  vec3 pat = vec3(1.0);
  float style = vStyle;

  if (style < 0.5) {
    // Birch / aspen: near-white paper bark with dark horizontal lenticels and
    // a smudged, darker base. The high-value trunk is a signature of the plates.
    // A lenticel is a lens, not a rectangle — tapering the dash at both ends is
    // the whole difference between "birch" and "trunk with black stickers".
    float scar = lenticel(vUv, vec2(6.0, 2.6), 0.42, 1.0)
               + lenticel(vUv, vec2(11.0, 6.5), 0.30, 0.55);
    pat = mix(pat, pat * 0.16, clamp(scar, 0.0, 1.0));
    pat = mix(pat * 0.46, pat, smoothstep(0.0, 1.8, vHeight));
    pat *= 0.95 + 0.10 * h21(vUv * 40.0);
  } else if (style < 1.5) {
    // Rough bark: vertical ridges, dark in the fissures.
    float ridge = sin(vUv.x * 44.0 + h21(vec2(floor(vUv.y * 6.0), 1.0)) * 6.0) * 0.5 + 0.5;
    ridge = pow(ridge, 1.6);
    float grain = h21(vec2(floor(vUv.x * 22.0), floor(vUv.y * 9.0)));
    pat *= mix(0.48, 1.12, ridge) * (0.86 + 0.28 * grain);
  } else {
    // Conifer: dark, finely flaked.
    float flake = h21(vec2(floor(vUv.x * 16.0), floor(vUv.y * 14.0)));
    pat *= 0.72 + 0.5 * flake;
  }

  if (uBake > 0.5) {
    gl_FragColor = vec4(0.0, 0.0, clamp(dot(pat, vec3(1.0 / 3.0)), 0.0, 1.0), 1.0);
    return;
  }

  vec3 albedo = vColor * pat;
  vec3 N = normalize(vN);
  float shadow = canopyShadow();
  float ndl = dot(N, uSunDir);
  float wrap = clamp((ndl + 0.22) / 1.22, 0.0, 1.0) * mix(0.15, 1.0, shadow);
  vec3 hemi = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5) * uAmbient;
  // A touch of rim so a white birch trunk still separates from a gold meadow.
  vec3 V = normalize(vWorld - cameraPosition);
  float rim = pow(clamp(1.0 - abs(dot(N, V)), 0.0, 1.0), 4.0) * clamp(dot(V, uSunDir), 0.0, 1.0);

  vec3 col = albedo * (uSunColor * wrap + hemi) + uSunColor * rim * 0.35 * shadow;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const BARK_DEPTH_VERT = /* glsl */`
attribute vec2 aBark;
attribute vec2 aWind;
varying vec2 vHighPrecisionZW;
#include <common>
${WIND}
void main() {
  float scale = length(instanceMatrix[0].xyz);
  vec3 worldOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 disp = windSway(worldOrigin, aBark.y * aWind.y * 0.55, aWind.x);
  vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position + disp / max(scale, 1e-4), 1.0);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
  vHighPrecisionZW = gl_Position.zw;
}
`;

const OPAQUE_DEPTH_FRAG = /* glsl */`
#include <packing>
varying vec2 vHighPrecisionZW;
void main() {
  float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;
  gl_FragColor = packDepthToRGBA(fragCoordZ);
}
`;

export function createBarkMaterial(shared, opts = {}) {
  const bake = !!opts.bake;
  const mat = new THREE.ShaderMaterial({
    uniforms: Object.assign(
      bake ? {} : lightUniforms(), bake ? {} : fogUniforms(), shared,
      { uBake: { value: bake ? 1 : 0 } }),
    vertexShader: BARK_VERT,
    fragmentShader: BARK_FRAG,
    lights: !bake,
    fog: !bake,
    side: THREE.FrontSide,
  });
  const depth = new THREE.ShaderMaterial({
    uniforms: Object.assign({}, shared),
    vertexShader: BARK_DEPTH_VERT,
    fragmentShader: OPAQUE_DEPTH_FRAG,
    side: THREE.FrontSide,
  });
  return { mat, depth };
}

// ── distant impostor ─────────────────────────────────────────────────────────
//  One quad carrying a baked front view of the species. The bake stores palette
//  *weights* (r = colour A, g = colour B, b = bark) rather than colour, so a
//  distant stand still varies tree to tree, and it is shaded at runtime with
//  the same canopy model as the near geometry — which is what stops the LOD
//  change from reading as a colour pop.

const IMP_VERT = /* glsl */`
attribute vec2 aCorner;
attribute vec3 aColA;
attribute vec3 aColB;
attribute vec3 aColC;
attribute vec3 aImp;     // tile index, height (m), half-width (m)
attribute vec2 aWind;

varying vec2 vUv;
varying vec3 vColA;
varying vec3 vColB;
varying vec3 vColC;
varying vec3 vN;
varying vec3 vWorld;
varying float vFade;

#include <common>
#include <fog_pars_vertex>
${WIND}

uniform float uTileCount;
uniform float uFadeStart;
uniform float uFadeEnd;

void main() {
  vec3 base = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  // Cylindrical billboard: yaw toward the camera but keep the trunk vertical,
  // otherwise a hillside of impostors visibly tips as the camera pitches.
  vec3 toCam = cameraPosition - base;
  vec3 right = normalize(vec3(-toCam.z, 0.0, toCam.x));

  vec3 world = base
             + right * (aCorner.x * aImp.z)
             + vec3(0.0, aCorner.y * aImp.y, 0.0)
             + windSway(base, aCorner.y * aCorner.y * aWind.y * 0.5, aWind.x);

  float tile = aImp.x;
  vUv = vec2((tile + uv.x) / uTileCount, uv.y);
  vColA = aColA; vColB = aColB; vColC = aColC;
  vWorld = world;
  // A spherical-ish normal across the card keeps the mass turning in the light.
  vec3 nrm = normalize(right * (aCorner.x * 0.85)
                     + vec3(0.0, (aCorner.y - 0.55) * 0.5, 0.0)
                     + normalize(vec3(toCam.x, 0.0, toCam.z)) * 0.6);
  vN = nrm;
  vFade = 1.0 - smoothstep(uFadeStart, uFadeEnd, length(toCam));

  vec4 worldPosition = vec4(world, 1.0);
  #ifdef USE_FOG
    vFogWorldPos = world;
    vFogCamPos = cameraPosition;
  #endif
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const IMP_FRAG = /* glsl */`
uniform sampler2D uAtlas;
uniform float uAlphaTest;
varying vec2 vUv;
varying vec3 vColA;
varying vec3 vColB;
varying vec3 vColC;
varying vec3 vN;
varying vec3 vWorld;
varying float vFade;

#include <common>
#include <packing>
#include <fog_pars_fragment>
${CANOPY_LIGHT}

void main() {
  vec4 t = texture2D(uAtlas, vUv);
  if (t.a < uAlphaTest) discard;
  vec3 albedo = t.r * vColA + t.g * vColB + t.b * vColC;
  float ao = clamp(t.r + t.g + t.b, 0.15, 1.0);
  vec3 N = normalize(vN);
  vec3 V = normalize(vWorld - cameraPosition);
  // Distant canopy reads as a mass that is slightly darker than the sunlit
  // ground, never brighter — impostors lit as if fully exposed turn a fogged
  // hillside into popcorn instead of letting it recede.
  vec3 col = canopyShade(albedo, N, V, ao, 0.5, 0.8) * 0.78;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export function createImpostorMaterial(atlas, shared, tileCount, fade) {
  const mat = new THREE.ShaderMaterial({
    uniforms: Object.assign(fogUniforms(), shared, {
      uAtlas: { value: atlas },
      uAlphaTest: { value: 0.45 },
      uTileCount: { value: tileCount },
      uFadeStart: { value: fade[0] },
      uFadeEnd: { value: fade[1] },
    }),
    vertexShader: IMP_VERT,
    fragmentShader: IMP_FRAG,
    fog: true,
    side: THREE.DoubleSide,
  });
  return { mat, depth: null };
}
