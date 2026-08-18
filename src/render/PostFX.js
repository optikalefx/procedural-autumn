// ─────────────────────────────────────────────────────────────────────────────
//  Post chain — the grade is where the painterly look actually lands.
//  Order: render -> SSAO -> bloom -> DOF -> custom grade -> SMAA -> output
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect,
  DepthOfFieldEffect, VignetteEffect, ToneMappingEffect, ToneMappingMode,
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

class GradeEffect extends Effect {
  constructor() {
    super('AutumnGrade', GRADE_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['uShadowTint',    new THREE.Uniform(new THREE.Vector3(0.88, 0.92, 1.12))],
        ['uHighlightTint', new THREE.Uniform(new THREE.Vector3(1.10, 1.01, 0.88))],
        ['uSplitStrength', new THREE.Uniform(0.34)],
        ['uSaturation',    new THREE.Uniform(1.10)],
        ['uContrast',      new THREE.Uniform(1.09)],
        ['uLift',          new THREE.Uniform(0.006)],
        ['uVibrance',      new THREE.Uniform(0.22)],
        ['uGrain',         new THREE.Uniform(0.016)],
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
      intensity: 0.72,
      luminanceThreshold: 0.62,
      luminanceSmoothing: 0.34,
      mipmapBlur: true,
      radius: 0.78,
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

    this.vignette = new VignetteEffect({ offset: 0.28, darkness: 0.42 });
    this.grade = new GradeEffect();
    this.tone = new ToneMappingEffect({
      mode: ToneMappingMode.AGX,
      resolution: 256,
      whitePoint: 8.0,
      middleGrey: 0.6,
      adaptive: false,
    });
    this.smaa = new SMAAEffect();

    const effects = [this.bloom];
    if (this.dof) effects.push(this.dof);
    effects.push(this.grade, this.vignette, this.smaa);
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

  setFocus(distance) {
    if (!this.dof) return;
    this.dof.cocMaterial.uniforms.focusDistance.value =
      distance / this.engine.camera.far;
  }

  dispose() { this.composer.dispose(); }
}
