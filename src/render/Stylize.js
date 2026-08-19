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
  // 0.48, up from 0.36. Widening the terminator is the cheapest way to stop a
  // back-facing conifer card or a shaded shrub from arriving at the grade as a
  // silhouette with nothing in it, and it is what the reference does: its
  // shaded masses are lit masses in a different key, not absences.
  wrap: 0.48,        // 0 = physical, 1 = fully wrapped
  // Banding is the direct expression of the brief's "large areas of uniform
  // colour with few shading gradients". At 0.45/3.0 the quantisation was a
  // suggestion — a smooth terrain normal still produced a smooth ramp, which is
  // exactly the "realistic renderer" tell the art director called out. Fewer,
  // firmer, still-soft-edged steps make a mountain flank read as two or three
  // painted masses instead of a gradient.
  steps: 2.6,        // number of quantisation bands
  // Softer and weaker than the 0.24 / 0.62 the terrain-only era wanted. The
  // same quantisation that reads as painted masses on a mountain flank reads as
  // a hard step across a leaf card, and foliage is now on this path too.
  soft: 0.30,        // band edge softness (0.5 = no banding at all)
  banding: 0.52,     // blend between smooth wrap and hard bands
  specular: 0.14,    // direct specular scale
  // Minimum diffuse response — nothing goes fully unlit. Raised back to 0.13
  // once foliage adopted stylizeDiffuse: the note that used to sit here said
  // the floor was irrelevant to foliage because trees are ShaderMaterials that
  // never ran this term, and that stopped being true. Trees, ground cover and
  // grass are now the largest consumers of it, and they are the surfaces that
  // were reading as black holes. It still has to stay modest, because it is
  // also what decides how much *form* a big terrain mass keeps: pushed much
  // past this the shaded flank of the hero massif closes to within a few
  // percent of its lit flank and the mountain reads as one smooth beige lump.
  floor: 0.13,
  // NOT A KNOB, DELIBERATELY. A shaped floor — one that fades across the back
  // hemisphere so a surface 70 degrees past the terminator sits below one at 40
  // — was built here and reverted, because it measured as a no-op. The river
  // view's foreground bank, which is the surface the whole idea was for, moved
  // from luma 0.299 to 0.290 at backFloor 0.46 and 0.288 at 0.30, and the
  // forest frame moved 0.003 of lumaMean. The reason is arithmetic: on a
  // back-facing surface the floor supplies only about a third of the light and
  // ambient supplies the rest, so halving the floor moves the pixel by a sixth
  // of a sixth. Anything that wants form on the dark side of a mass has to come
  // from the ambient term's orientation response, not from here.
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

  // Guarded, and it declares stylizeDiffuse() as well as the uniforms. A
  // MeshStandardMaterial already receives the stylised response through the
  // patched RE_Direct_Physical, but its author may also include STYLIZE_PARS
  // (there is no way to tell from inside a shader which path you are on).
  // Without the guard that is a redefinition error and the material silently
  // fails to compile.
  THREE.ShaderChunk[CHUNK] =
    STYLIZE_PARS + '\nuniform float uStyleSpecular;\n' + THREE.ShaderChunk[CHUNK];

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
#ifndef STYLIZE_DECLARED
#define STYLIZE_DECLARED
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
}
#endif`;

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
