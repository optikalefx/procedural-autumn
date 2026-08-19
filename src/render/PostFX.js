// ─────────────────────────────────────────────────────────────────────────────
//  Post chain — the grade is where the painterly look actually lands.
//  Order: render -> SSAO -> DOF -> bloom -> tone map -> vignette -> grade -> SMAA
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect,
  DepthOfFieldEffect, VignetteEffect,
  Effect, BlendFunction, KernelSize,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { QUALITY_PRESETS } from '../world/WorldConfig.js';

// ── Custom grade: aerial perspective, warm/cool split-tone, film curve ───────
const GRADE_FRAG = /* glsl */`
uniform vec3  uShadowTint;
uniform vec3  uHighlightTint;
uniform float uSplitStrength;
uniform float uSaturation;
uniform float uContrast;
uniform float uLift;
uniform float uToe;
uniform vec3  uLiftTint;
uniform float uVibrance;
uniform float uRedToGold;
uniform float uBlueFloor;
uniform float uGrain;
uniform float uTime;

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;

  // NOTE ON UNITS. This pass runs inside the composer, which is linear — the
  // sRGB encode happens in the output pass after us. Every threshold below is
  // therefore a *linear* value, and small linear numbers are large display
  // ones: 0.02 linear is 0.15 sRGB, 0.18 linear is middle grey, 0.5 linear is
  // already 0.74 sRGB. Reading them as display values is how this grade ended
  // up pivoting its contrast near the highlights and lifting the toe by a
  // quarter of the display range.

  // Split toning: cool violet in shadow, warm gold in highlight. This is the
  // brief's complementary split, and it is also the only tool that puts chroma
  // into near-neutral pixels — bare rock is the biggest of those, and the
  // forest frame was measuring 31% near-neutral against a reference ceiling of
  // 28%. Strong enough to read as a tint, nowhere near enough to make a shadow
  // blue.
  float l = luma(c);
  float shadowW = 1.0 - smoothstep(0.0, 0.14, l);   // ~0 … 0.41 display
  float highW   = smoothstep(0.25, 0.85, l);        // ~0.55 … 0.94 display
  // Tints are luminance-normalised, so this rotates hue instead of dimming.
  c = mix(c, c * uShadowTint,    uSplitStrength * shadowW);
  c = mix(c, c * uHighlightTint, uSplitStrength * highW * 0.7);

  // Filmic contrast around middle grey, then lift the toe.
  //
  // 1.26, and the number matters less than which plate it is measured against.
  // The reference set is five images and only one of them — plate 1, a wide
  // hazy aerial — is framed like a vista; it measures lumaP05 0.161 and
  // contrastStd 0.218. The three framed like the game (riverbank, close-up,
  // camper) measure lumaP05 0.195 / 0.393 / 0.424 and contrastStd 0.134 /
  // 0.180 / 0.142: heavily lifted blacks, soft contrast. Averaging all five and
  // anchoring on plate 1 is what once drove this to 1.30 with the toe lift cut
  // to 0.004, which doubled the luminance range and turned every shaded shrub
  // into a black hole — the art director called it "really harsh contrast
  // shadows" and preferred the rounds from before the recalibration.
  //
  // So the targets are per framing. Eye-level: lumaP05 0.20-0.42, lumaRange
  // 0.41-0.53, contrastStd 0.13-0.18, chromaMean 0.30-0.42. Only hero, peaks
  // and dawn should go anywhere near plate 1 numbers.
  c = (c - 0.18) * uContrast + 0.18;
  // Soft toe, not a hard clamp. Contrast about any pivot maps a true black to a
  // negative, so the floor has to happen before the lift — but max(c, 0.0) maps
  // *every* negative to exactly zero, and the additive lift then lands all of
  // them on one identical colour. That is not a crushed black, it is a constant:
  // a critic pass measured 44% of the waterfall frame and 11.8% of backlit on a
  // single hex, with rock, cliff, bush, understory and terrain all returning the
  // same srgb(57,52,48) — no normal response, no hue, no form.
  //
  // A smooth max keeps the ordering. Distinct near-blacks stay distinct, and
  // because it runs per channel, a dark green leaf still comes out green-led
  // and a warm rock still comes out red-led instead of both arriving hueless.
  // Above the knee it is max() to within a thousandth.
  c = 0.5 * (c + sqrt(c * c + uToe * uToe));
  // 0.040 linear is ~0.22 sRGB, inside the reference own 0.16-0.42 band for the
  // 5th percentile — the point of the whole exercise: the reference lifts its
  // blacks, never crushes them. The reach matters as much as the amount: at a
  // 0.10 knee only literal black was caught, and the dense conifer masses that
  // dominate the river and forest frames sit just above it.
  //
  // Tinted hard, not neutral, and the tint carries real chroma. An almost-grey
  // lift is what turned the shadow mass into mud: the frames were coming back
  // 30-44% near-neutral pixels, because a 1.06/1.01/0.92 amber added to a black
  // pixel is still, to within a couple of levels, grey. At 1.30/0.95/0.68 the
  // darkest pixels land as a warm brown of R:G:B roughly 1 : 0.73 : 0.52 —
  // which is, measured, exactly where the reference plates put their own
  // darkest samples (srgb(76,64,48) in plate 1, olive srgb(56,66,32) in plate
  // 3). The tint is luminance-normalised, so this sets a colour, not a
  // brightness. After it, near-neutral pixels measure under 3% in every view.
  c += uLift * uLiftTint * (1.0 - smoothstep(0.0, 0.22, luma(c)));

  // Vibrance up, global saturation down. The pair is a chroma *compressor*, not
  // a chroma trim, and that is what the frames needed: the gold meadow measured
  // 0.51 against a reference band of 0.28–0.42 while the hazed vistas measured
  // 0.24–0.26 under it. A flat saturation cut moves both the same way and only
  // trades one error for the other; boosting by (1 - sat) pulls the pale haze up
  // and the neon meadow down in the same pass.
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float sat = mx - mn;
  c = mix(vec3(luma(c)), c, 1.0 + uVibrance * (1.0 - sat));
  c = mix(vec3(luma(c)), c, uSaturation);

  // Hue-vs-hue: push the red band toward gold.
  //
  // Measured against the plates, our chromatic pixels were 78% red / 6% orange
  // where the reference is 52% red / 38% orange. Autumn foliage and dry grass
  // both sit in the orange-gold band, and our albedos land a little too far
  // round toward red; global desaturation cannot fix that — it only drains the
  // colour toward grey, and the red-ward lift and highlight tints then turn
  // that grey salmon-pink. Lifting green where red leads walks the hue back
  // round to gold while leaving genuinely crimson foliage crimson.
  {
    float redLead = clamp((c.r - max(c.g, c.b)) / max(c.r, 1e-4), 0.0, 1.0);
    float w = c.r * redLead * redLead * uRedToGold;
    // Green *and* blue, not green alone. Adding green to a red-led pixel walks
    // the hue toward gold but leaves the blue channel wherever it was, and ours
    // was on the floor: measured, the reference meadow runs R:G:B 1 : 0.74 :
    // 0.49 and the drive frame was rendering 1 : 0.65 : 0.18, with the two
    // largest colour masses in backlit sitting at B <= 4/255. A pixel with no
    // blue at all cannot be gold, only vermilion, however much green it has.
    c.g += w;
    c.b += w * 0.35;
  }

  // Blue floor. Nothing in the reference sits at zero blue: its meadow runs
  // R:G:B 1 : 0.68 : 0.36 and its darkest sample is a warm srgb(76,64,48),
  // while our two largest colour masses were measuring B <= 4 of 255. A channel
  // pinned at zero is not a saturated colour, it is a clipped one — it has no
  // hue left to shift, which is why adding green alone kept reading as
  // vermilion and why the frames came back 0.0% yellow in all ten views.
  //
  // Raise-only, and never past green, so this can lift a gold grass blade out
  // of clipping without touching the blue of a sky or turning a crimson maple
  // mauve. It is a floor, not a tint.
  c.b = max(c.b, min(luma(c) * uBlueFloor, c.g));

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
        ['uShadowTint',    new THREE.Uniform(new THREE.Vector3(0.93, 0.94, 1.12))],
        ['uHighlightTint', new THREE.Uniform(new THREE.Vector3(1.10, 1.02, 0.90))],
        ['uSplitStrength', new THREE.Uniform(0.21)],
        ['uSaturation',    new THREE.Uniform(0.74)],
        ['uContrast',      new THREE.Uniform(1.26)],
        ['uLift',          new THREE.Uniform(0.040)],
        ['uToe',           new THREE.Uniform(0.042)],
        ['uLiftTint',      new THREE.Uniform(new THREE.Vector3(1.30, 0.95, 0.68))],
        ['uVibrance',      new THREE.Uniform(0.90)],
        ['uRedToGold',     new THREE.Uniform(0.130)],
        ['uBlueFloor',     new THREE.Uniform(0.160)],
        ['uGrain',         new THREE.Uniform(0.005)],
        ['uTime',          new THREE.Uniform(0)],
      ]),
    });
  }
  update(renderer, inputBuffer, dt) {
    this.uniforms.get('uTime').value += dt;
  }
}

// Scene exposure. Engine ships a default, but exposure is a *look* decision and
// it is graded here, so this file owns it — Engine's value is only the fallback
// if this is ever set to null.
//
// Calibrated by measurement, not by feel. At 1.28 the high-albedo surfaces —
// bare rock especially, which is a near-white lavender before it is lit —
// pushed past the tone curve's shoulder, where PBR Neutral desaturates toward
// white. Rock, snow and sky all collapsed into the same cream, so `hero` and
// `peaks` measured lumaP05 ≈ 0.53–0.61 against a reference band of 0.16–0.42
// and chromaMean 0.21 against 0.28–0.42. Backing exposure off keeps the bright
// end below the shoulder, which buys back both the value range and the colour.
//
// 1.0 was still not enough. PBR Neutral starts compressing at 0.76 and is very
// aggressive above it: at 1.0 a lit rock face landed at 0.97 and its shaded
// face at 0.80, so a 3:1 scene ratio arrived as 0.99 vs 0.92 on screen. That is
// the whole reason `peaks` and `hero` read as pale tan with no form — it is the
// shoulder eating the highlights, not the lighting failing to make them. The
// bright end has to sit *under* the shoulder for form to survive it.
// Briefly raised to 1.12 to chase the plates' mean luminance. That was a
// mis-calibration and it cost the look: the reference set is five plates, and
// the wide hazy aerial (plate 1, lumaP05 0.161 / contrastStd 0.218) is the only
// one framed like a vista. The three plates framed like the game — riverbank,
// close-up, camper — measure lumaP05 0.195/0.393/0.424 and contrastStd
// 0.134/0.180/0.142. They have heavily *lifted* blacks and soft contrast.
// Averaging all five and anchoring on plate 1 pulled exposure up and the toe
// lift down, which doubled the luminance range and turned every shaded shrub
// into a black hole — the art director's "harsh contrast shadows".
//
// So: eye-level views target plates 3/4/5 — lumaP05 0.20-0.42, lumaRange
// 0.41-0.53, contrastStd 0.13-0.18, chromaMean 0.30-0.42. Only hero/peaks/dawn
// should approach plate 1. 0.86 with vibrance 0.90 is what lands there; the
// frame reads darker than the plate-1 mean on purpose, because a high mean is
// bought by pushing the meadow into PBR Neutral's shoulder, where its own
// desaturation term bleaches the gold and the frame measures right but looks
// like beige sand.
const EXPOSURE = 0.86;

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
      // A grass field is hundreds of thousands of mutually-occluding sheets, so
      // a metres-wide AO radius finds a contact between every pair of adjacent
      // blades and fills the canopy interior with salt-and-pepper — the exact
      // high-frequency noise the brief rules out, and the grass author's logged
      // request. Pulling the radius in to roughly a blade-height keeps the cue
      // that actually reads (a rock or a trunk meeting the ground) and drops
      // the one that only adds noise.
      this.ao.configuration.aoRadius = 1.1;
      this.ao.configuration.distanceFalloff = 1.0;
      // Weaker and less blue than it was. Ambient occlusion is a contact cue,
      // not a grade: at 2.6 with a near-navy tint it was stamping a cold violet
      // into every crease of a gold meadow, which is the exact failure the
      // brief calls out — the cool note belongs to distant rock and haze, not
      // to shaded ground. Blue/violet/magenta together are about 1% of the
      // reference's chromatic pixels.
      this.ao.configuration.intensity = 1.15;
      this.ao.configuration.color = new THREE.Color(0x40303f);
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

    // Depth of field. `focusDistance` is a fraction of camera.far, so the
    // default has to be derived from it rather than hard-coded — 0.02 put the
    // focal plane at a fixed ~60 m, which is wrong at every chase distance and
    // wrong in every headless capture (CameraRig drives the focus in game, but
    // nothing does during a capture).
    //
    // bokehScale is down from 1.6. At that size a blown highlight behind the
    // focal plane resolved as a hard white disc several percent of frame width
    // — the waterfall view was full of them — and the whole frame read as
    // tilt-shift miniature rather than cozy, which the camera author also
    // logged. A smaller circle of confusion still separates the camper from the
    // valley without turning specular into confetti.
    this.dof = this.preset.dof
      ? new DepthOfFieldEffect(camera, {
          focusDistance: 55 / camera.far,
          focalLength: 0.26,
          bokehScale: 0.60,
          height: 720,
        })
      : null;

    // A cozy frame wants its corners to fall away. It also buys real measured
    // contrast in the vista views, which are otherwise a single 0.60–0.70 value
    // band from the valley floor to the sky (contrastStd 0.09 against a
    // reference band of 0.13–0.22).
    //
    // It runs *before* the grade (see the pass order below). Running it after
    // meant the corners were darkened by up to 38% with nothing downstream to
    // catch them, which is how `river` and `forest` — frames whose edges are
    // dense conifer — measured lumaP05 0.02 despite a shadow lift specifically
    // designed to stop exactly that.
    this.vignette = new VignetteEffect({ offset: 0.40, darkness: 0.30 });
    this.grade = new GradeEffect();
    // Khronos PBR Neutral, not AgX. AgX is a filmic curve built for
    // photographic realism: it has a long toe and it deliberately desaturates
    // highlights. Against a painterly reference that is exactly backwards —
    // it drains the gold out of every sunlit surface, which then has to be
    // clawed back with a global saturation boost that over-cooks the midtones.
    // Neutral holds hue and saturation up into the highlights, which is what
    // lets a bright gold meadow stay gold.
    this.tone = new ToneMapEffect(EXPOSURE ?? engine.exposure ?? 1.0);
    this.smaa = new SMAAEffect();

    // Order matters. Bloom and depth of field belong in linear HDR, tone
    // mapping converts to display range, and the grade must run *after* that
    // so its contrast/saturation operate on the values the player actually
    // sees. Renderer tone mapping is disabled (see Engine) so this is the only
    // place the conversion happens. The vignette sits between the two: it is a
    // darkening, so the grade's black lift has to be the last thing that
    // touches the shadows or the corners fall through it.
    // Depth of field runs *before* bloom. The other way round, bloom turned
    // every specular sparkle on the waterfall into a bright point and the DOF
    // kernel then resolved each one as a hard white disc a few percent of frame
    // width across — the single most conspicuous artifact left in that view.
    // Defocusing first means the highlight is already spread when bloom sees it.
    const effects = [];
    if (this.dof) effects.push(this.dof);
    effects.push(this.bloom, this.tone, this.vignette, this.grade, this.smaa);
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
