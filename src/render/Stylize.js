// ─────────────────────────────────────────────────────────────────────────────
//  Stylize — global non-photoreal lighting response.
//
//  The reference art is soft and nearly cel-shaded: lit and shaded areas sit
//  close together in value, the terminator is wide and diffuse, specular is
//  almost absent, and large surfaces read as flat masses of colour rather than
//  as smoothly-shaded geometry. A standard physical BRDF does the opposite —
//  it produces a hard terminator, a wide value range, and lots of high-frequency
//  shading detail. That mismatch is what makes an otherwise correct palette
//  still read as "realistic renderer" instead of "painted".
//
//  Rather than ask eleven authors to each hand-roll a stylised shader, this
//  patches Three's physical direct-lighting term once, globally, so every
//  material in the game — terrain, trees, grass, rock, water, the camper —
//  shares one lighting response. Same approach as Atmosphere.js takes for fog.
//
//  Three effects, all tunable at runtime:
//    wrap       light bleeds past the terminator, widening and softening it
//    banding    the diffuse ramp is quantised into a few soft steps
//    specular   direct specular is scaled down toward matte
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { injectUniforms, verifyUniforms, patchChunk, captureShader } from './uniformPatch.js';

const STYLIZED_DIRECT = /* glsl */`
	// ── stylised diffuse response ──────────────────────────────────────────
	float rawNL = dot( geometryNormal, directLight.direction );

	// Wrap: treat the surface as if lit by a large area source. This is what
	// removes the hard shadow terminator the reference does not have.
	float wrapNL = saturate( ( rawNL + uStyleWrap ) / ( 1.0 + uStyleWrap ) );

	// Quantise into soft bands so broad surfaces read as flat masses.
	float _s = wrapNL * uStyleSteps;
	float _f = floor( _s );
	float _fr = _s - _f;
	float _band = ( _f + smoothstep( 0.5 - uStyleSoft, 0.5 + uStyleSoft, _fr ) ) / uStyleSteps;

	float dotNL = mix( wrapNL, _band, uStyleBanding );

	// Never let a surface fall to zero direct light. Physically wrong, but it is
	// what keeps shaded areas as *tinted colour* rather than as holes, which is
	// the single clearest difference between the reference and a PBR render.
	dotNL = uStyleFloor + ( 1.0 - uStyleFloor ) * dotNL;

	// Slight desaturation of the key toward its own luminance in the darkest
	// band keeps shadowed colour from going muddy.
	vec3 irradiance = dotNL * directLight.color;

	// Specular is computed from the true geometric term, then scaled toward
	// matte — banding a highlight produces visible rings.
	vec3 specIrradiance = saturate( rawNL ) * directLight.color * uStyleSpecular;
`;

const DEFAULTS = {
  // Tuned against the reference plates: a very wide terminator, gentle
  // banding, and almost no direct specular. The reference's shaded meadow sits
  // only slightly below its lit meadow in value — the shading does very little
  // work, and colour does the rest.
  wrap: 0.42,        // 0 = physical, 1 = fully wrapped
  steps: 3.0,        // number of quantisation bands
  soft: 0.26,        // band edge softness (0.5 = no banding at all)
  banding: 0.45,     // blend between smooth wrap and hard bands
  specular: 0.14,    // direct specular scale
  floor: 0.11,       // minimum diffuse response — nothing goes fully unlit
};

let patched = false;

export function patchStylizedLighting() {
  if (patched) return;
  patched = true;

  const CHUNK = 'lights_physical_pars_fragment';

  // Whitespace-tolerant: three's bundled build strips the blank line that its
  // source tree has between these two statements, and an exact-string match
  // against the source form silently no-ops against the build.
  const ok = patchChunk(
    CHUNK,
    /float dotNL = saturate\( dot\( geometryNormal, directLight\.direction \) \);\s*vec3 irradiance = dotNL \* directLight\.color;/,
    STYLIZED_DIRECT,
    'Stylize'
  );
  if (!ok) return;

  // Direct specular must use the unbanded term — banding a highlight rings.
  patchChunk(
    CHUNK,
    /reflectedLight\.directSpecular \+= irradiance \* BRDF_GGX\(/,
    'reflectedLight.directSpecular += specIrradiance * BRDF_GGX(',
    'Stylize'
  );

  THREE.ShaderChunk[CHUNK] = `
uniform float uStyleWrap;
uniform float uStyleSteps;
uniform float uStyleSoft;
uniform float uStyleBanding;
uniform float uStyleSpecular;
uniform float uStyleFloor;
` + THREE.ShaderChunk[CHUNK];

  injectUniforms('lights', {
    uStyleWrap:     { value: DEFAULTS.wrap },
    uStyleSteps:    { value: DEFAULTS.steps },
    uStyleSoft:     { value: DEFAULTS.soft },
    uStyleBanding:  { value: DEFAULTS.banding },
    uStyleSpecular: { value: DEFAULTS.specular },
    uStyleFloor:    { value: DEFAULTS.floor },
  });
  verifyUniforms('Stylize', ['uStyleWrap', 'uStyleSpecular', 'uStyleFloor']);
}

// ── Opt-in for custom ShaderMaterials ───────────────────────────────────────
// The chunk patch above only reaches materials that use Three's physical
// lighting. Trees, water and waterfalls roll their own, so they get none of it
// — and it shows: a near, shadowed conifer card in the `waterfall` view renders
// at literal zero, where the reference's darkest foliage sits at luma 0.37.
// This is the `fogUniforms()` pattern: merge the uniforms, call the function,
// and a custom shader lands on the same lighting response as everything else.
//
//   import { stylizeUniforms, STYLIZE_PARS } from '../render/Stylize.js';
//   uniforms: THREE.UniformsUtils.merge([stylizeUniforms(), { … }])
//   fragmentShader: STYLIZE_PARS + `… float nl = stylizeDiffuse( dot(N, L) ); …`
export const STYLIZE_PARS = /* glsl */`
uniform float uStyleWrap;
uniform float uStyleSteps;
uniform float uStyleSoft;
uniform float uStyleBanding;
uniform float uStyleFloor;

// rawNL is the unclamped dot(normal, lightDir). Returns the stylised diffuse
// response: wide soft terminator, gently banded, floored so nothing goes to a
// hole. Multiply by your light colour and shadow mask as usual.
float stylizeDiffuse( float rawNL ) {
  float wrapNL = clamp( ( rawNL + uStyleWrap ) / ( 1.0 + uStyleWrap ), 0.0, 1.0 );
  float s  = wrapNL * uStyleSteps;
  float f  = floor( s );
  float fr = s - f;
  float band = ( f + smoothstep( 0.5 - uStyleSoft, 0.5 + uStyleSoft, fr ) ) / uStyleSteps;
  float nl = mix( wrapNL, band, uStyleBanding );
  return uStyleFloor + ( 1.0 - uStyleFloor ) * nl;
}`;

/** Uniform block a custom ShaderMaterial merges in to use `stylizeDiffuse`. */
export function stylizeUniforms() {
  return {
    uStyleWrap:    { value: DEFAULTS.wrap },
    uStyleSteps:   { value: DEFAULTS.steps },
    uStyleSoft:    { value: DEFAULTS.soft },
    uStyleBanding: { value: DEFAULTS.banding },
    uStyleFloor:   { value: DEFAULTS.floor },
  };
}

export class Stylize {
  constructor(scene) {
    patchStylizedLighting();
    this.scene = scene;
    this.params = { ...DEFAULTS };
    this._materials = new Set();
  }

  register(material) {
    if (!material || material.lights === false) return material;
    if (this._materials.has(material)) return material;
    this._materials.add(material);
    // Same reason as Atmosphere.register: built-in materials keep the values
    // they were compiled with unless the shader is stashed, so any runtime
    // tuning of the stylised response would reach only the custom shaders.
    captureShader(material);
    return material;
  }

  harvest() {
    this.scene.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) this.register(m);
    });
  }

  update() {
    const p = this.params;
    for (const m of this._materials) {
      const u = m.userData?.shader?.uniforms ?? m.uniforms;
      if (!u || !u.uStyleWrap) continue;
      u.uStyleWrap.value = p.wrap;
      u.uStyleSteps.value = p.steps;
      u.uStyleSoft.value = p.soft;
      u.uStyleBanding.value = p.banding;
      u.uStyleSpecular.value = p.specular;
      u.uStyleFloor.value = p.floor;
    }
  }
}
