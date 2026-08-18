// ─────────────────────────────────────────────────────────────────────────────
//  Post chain — the grade is where the painterly look actually lands.
//  Order: render -> SSAO -> bloom -> DOF -> custom grade -> SMAA -> output
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect,
  DepthOfFieldEffect, VignetteEffect,
  Effect, BlendFunction, KernelSize, NoiseEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { QUALITY_PRESETS, PALETTE } from '../world/WorldConfig.js';

// ── Custom grade: aerial perspective, warm/cool split-tone, film curve ───────
const GRADE_FRAG = /* glsl */`
uniform vec3  uShadowTint;
uniform vec3  uHighlightTint;
uniform float uSplitStrength;
uniform float uSaturation;
uniform float uContrast;
uniform float uLift;
uniform float uVibrance;
uniform float uGrain;
uniform float uTime;
uniform float uCAStrength;

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;

  // Split toning: cool violet in shadow, warm gold in highlight.
  float l = luma(c);
  float shadowW = 1.0 - smoothstep(0.0, 0.42, l);
  float highW   = smoothstep(0.45, 1.0, l);
  // Tints are luminance-normalised, so this rotates hue instead of dimming.
  c = mix(c, c * uShadowTint,    uSplitStrength * shadowW);
  c = mix(c, c * uHighlightTint, uSplitStrength * highW * 0.7);

  // Filmic contrast around a slightly lifted pivot.
  c = (c - 0.5) * uContrast + 0.5 + uLift;

  // Vibrance: boost the unsaturated, protect the already-saturated.
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float sat = mx - mn;
  c = mix(vec3(luma(c)), c, 1.0 + uVibrance * (1.0 - sat));
  c = mix(vec3(luma(c)), c, uSaturation);

  // Fine grain, luminance-weighted so it stays out of the highlights.
  float n = fract(sin(dot(uv * (1.0 + uTime * 0.0001), vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) * uGrain * (1.0 - smoothstep(0.5, 1.0, luma(c)));

  outputColor = vec4(max(c, 0.0), inputColor.a);
}`;

// ── Exposure + Khronos PBR Neutral tone map ─────────────────────────────────
// Written out rather than using the library's ToneMappingEffect so exposure
// lives in the same pass as the curve, and so the curve is visible and tunable
// here instead of buried in a dependency.
const TONEMAP_FRAG = /* glsl */`
uniform float uExposure;

vec3 pbrNeutral( vec3 c ) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;

  float x = min( c.r, min( c.g, c.b ) );
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c -= offset;

  float peak = max( c.r, max( c.g, c.b ) );
  if ( peak < startCompression ) return c;

  float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / ( peak + d - startCompression );
  c *= newPeak / peak;

  float g = 1.0 - 1.0 / ( desaturation * ( peak - newPeak ) + 1.0 );
  return mix( c, vec3( newPeak ), g );
}

void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
  outputColor = vec4( pbrNeutral( max( inputColor.rgb * uExposure, 0.0 ) ), inputColor.a );
}`;

class ToneMapEffect extends Effect {
  constructor(exposure = 1.0) {
    super('AutumnToneMap', TONEMAP_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([['uExposure', new THREE.Uniform(exposure)]]),
    });
  }
  get exposure() { return this.uniforms.get('uExposure').value; }
  set exposure(v) { this.uniforms.get('uExposure').value = v; }
}

class GradeEffect extends Effect {
  constructor() {
    super('AutumnGrade', GRADE_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['uShadowTint',    new THREE.Uniform(new THREE.Vector3(0.97, 0.95, 1.06))],
        ['uHighlightTint', new THREE.Uniform(new THREE.Vector3(1.12, 1.02, 0.86))],
        ['uSplitStrength', new THREE.Uniform(0.14)],
        ['uSaturation',    new THREE.Uniform(0.96)],
        ['uContrast',      new THREE.Uniform(1.06)],
        ['uLift',          new THREE.Uniform(0.004)],
        ['uVibrance',      new THREE.Uniform(0.16)],
        ['uGrain',         new THREE.Uniform(0.005)],
        ['uTime',          new THREE.Uniform(0)],
        ['uCAStrength',    new THREE.Uniform(0.0006)],
      ]),
    });
  }
  update(renderer, inputBuffer, dt) {
    this.uniforms.get('uTime').value += dt;
  }
}

export class PostFX {
  constructor(engine, quality = 'ultra') {
    this.engine = engine;
    this.preset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.high;
    const { renderer, scene, camera } = engine;

    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    });

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    if (this.preset.ssao) {
      this.ao = new N8AOPostPass(scene, camera, engine.width, engine.height);
      this.ao.configuration.aoRadius = 3.2;
      this.ao.configuration.distanceFalloff = 1.4;
      this.ao.configuration.intensity = 2.6;
      this.ao.configuration.color = new THREE.Color(0x2c2a4a);
      this.ao.configuration.halfRes = true;
      this.ao.configuration.denoiseSamples = 8;
      this.ao.configuration.denoiseRadius = 12;
      this.ao.setQualityMode('High');
      this.composer.addPass(this.ao);
    }

    this.bloom = new BloomEffect({
      intensity: 0.38,
      luminanceThreshold: 0.80,
      luminanceSmoothing: 0.45,
      mipmapBlur: true,
      radius: 0.68,
      kernelSize: KernelSize.HUGE,
      blendFunction: BlendFunction.ADD,
    });

    this.dof = this.preset.dof
      ? new DepthOfFieldEffect(camera, {
          focusDistance: 0.02,
          focalLength: 0.20,
          bokehScale: 1.6,
          height: 720,
        })
      : null;

    this.vignette = new VignetteEffect({ offset: 0.42, darkness: 0.16 });
    this.grade = new GradeEffect();
    // Khronos PBR Neutral, not AgX. AgX is a filmic curve built for
    // photographic realism: it has a long toe and it deliberately desaturates
    // highlights. Against a painterly reference that is exactly backwards —
    // it drains the gold out of every sunlit surface, which then has to be
    // clawed back with a global saturation boost that over-cooks the midtones.
    // Neutral holds hue and saturation up into the highlights, which is what
    // lets a bright gold meadow stay gold.
    this.tone = new ToneMapEffect(engine.exposure ?? 1.0);
    this.smaa = new SMAAEffect();

    // Order matters. Bloom and depth of field belong in linear HDR, tone
    // mapping converts to display range, and the grade must run *after* that
    // so its contrast/saturation operate on the values the player actually
    // sees. Renderer tone mapping is disabled (see Engine) so this is the only
    // place the conversion happens.
    const effects = [this.bloom];
    if (this.dof) effects.push(this.dof);
    effects.push(this.tone, this.grade, this.vignette, this.smaa);
    this.mainPass = new EffectPass(camera, ...effects);
    this.composer.addPass(this.mainPass);

    engine.onResize((w, h) => {
      this.composer.setSize(w, h);
      this.ao?.setSize(w, h);
    });
  }

  render(dt) {
    this.composer.render(dt);
  }

  /** Scene exposure applied immediately before the tone curve. */
  setExposure(v) { this.tone.exposure = v; }
  getExposure() { return this.tone.exposure; }

  setFocus(distance) {
    if (!this.dof) return;
    this.dof.cocMaterial.uniforms.focusDistance.value =
      distance / this.engine.camera.far;
  }

  dispose() { this.composer.dispose(); }
}
