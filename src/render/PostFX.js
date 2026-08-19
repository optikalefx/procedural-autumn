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
uniform float uGreenTame;
uniform float uGreenTameMax;
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

  // Green-side chroma governor — the other half of the blue-channel finding.
  //
  // The blue floor above is keyed on luminance, and luminance in a green-led
  // pixel is nine tenths the green channel, so a foliage mass gets almost no
  // lift out of it: the trees author measured our foliage at R:G:B 1 : 0.86 :
  // 0.38 against plate 1's 1 : 0.84 : 0.68 and correctly declined to patch it
  // inside their own material, because a per-material blue lift makes foliage
  // disagree with the terrain it stands on.
  //
  // Measured, the reference does not put a saturated green anywhere. Every
  // conifer sampled across the plates comes back near-neutral and warm, with
  // red at or above green:
  //   plate 1 near conifer  srgb(138,119,98)   1 : 0.86 : 0.71   chroma 0.16
  //   plate 2 near conifer  srgb(112, 99, 84)  1 : 0.88 : 0.75   chroma 0.11
  //   plate 2 mid conifer   srgb(106,105, 76)  1 : 0.99 : 0.72   chroma 0.12
  //   plate 3 conifer       srgb( 95, 82, 64)  1 : 0.86 : 0.67   chroma 0.12
  // Ours rendered srgb(90,103,40) — 1 : 1.15 : 0.44, chroma 0.25: green *above*
  // red and barely half the blue. That is the whole "blue channel is short on
  // foliage" finding, and it is a saturation error, not a hue error.
  //
  // So: pull green-led pixels toward their own luminance. It is the same
  // operator the terrain uses on bare rock, deliberately, so the two agree —
  // and because it is a pull toward grey it raises the *lowest* channel, which
  // on a green-led pixel is blue. Gold meadow, orange canopy, crimson maple,
  // sky and water are all red- or blue-led and grnLead is zero on every one
  // of them, so none of them move.
  //
  // Capped well short of full: the brief wants conifer as "the visual rest in a
  // hot palette", not as grey. At the cap a pure green would keep just over half
  // its chroma.
  //
  // 0.75 was picked by sweeping 0 / 0.6 / 1.15 / 1.8 and measuring the near
  // conifer in forest, which is the largest green mass in any canonical view:
  //   0     srgb( 84,102, 38)  1 : 1.21 : 0.45   chroma 0.25
  //   0.6   srgb( 89,101, 58)  1 : 1.14 : 0.65   chroma 0.17
  //   1.15  srgb( 91,100, 68)  1 : 1.09 : 0.75   chroma 0.12
  // against a reference conifer band of chroma 0.04-0.21 and blue 0.67-0.75 of
  // red. 1.15 measures dead centre and looks it — a sage green that has stopped
  // reading as conifer. 0.75 lands blue at ~0.69 of red, which is the trees
  // author's stated target, with enough chroma left that the mass still says
  // evergreen next to gold. Gold meadow, gold canopy and the camper measure
  // bit-identical across the whole sweep; nothing red-led is inside this term.
  {
    float grnLead = clamp((c.g - max(c.r, c.b)) / max(c.g, 1e-4), 0.0, 1.0);
    c = mix(c, vec3(luma(c)), min(grnLead * uGreenTame, uGreenTameMax));
  }

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
        ['uContrast',      new THREE.Uniform(1.30)],
        ['uLift',          new THREE.Uniform(0.030)],
        ['uToe',           new THREE.Uniform(0.032)],
        ['uLiftTint',      new THREE.Uniform(new THREE.Vector3(1.30, 0.95, 0.68))],
        ['uVibrance',      new THREE.Uniform(0.90)],
        ['uRedToGold',     new THREE.Uniform(0.130)],
        ['uBlueFloor',     new THREE.Uniform(0.160)],
        ['uGreenTame',     new THREE.Uniform(0.75)],
        ['uGreenTameMax',  new THREE.Uniform(0.45)],
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
// Smallest bloom mip, in pixels on its short side. See _capBloomMips().
//
// The black frames were never the mip chain's fault; they were NaN.
//
// A drive-time readback of every presented frame put the rate at 0.61% with
// six levels, 0.10% with five and 0.00% with four, which reads exactly like a
// driver bug on small render targets and is why the floor was raised twice.
// It is not. A single NaN fragment anywhere in the scene is averaged outward by
// each downsample, so a deeper chain simply carries it further: four levels
// confined it to a block, six spread it over the whole frame. The source was
// `pow(vT, uTipBias)` in the grass albedo with `vT` a hair below zero (see
// src/shaders/grass_material.js). With that clamped, six levels measures zero
// black frames, so the floor stays where the look wants it.
const MIN_BLOOM_MIP = 12;

// Raised to 0.94 with the toe and lift pulled back (0.040/0.042 -> 0.026/0.030)
// and contrast to 1.30. The old numbers were set while the shadow clamp bug was
// live: `max(c, 0.0)` after the contrast pivot landed every negative on one
// value, so any reduction of the lift produced a flat black mass rather than a
// dark one, and the art director quite correctly rejected it. With the smooth
// toe in place a smaller lift produces *varied* darks, so the range is now
// available at no cost in flatness.
//
// Measured on `drive`, which is framed like plates 3/4/5:
//   before  lumaP05 0.326  range 0.460  contrastStd 0.152  chroma 0.391
//   after   lumaP05 0.306  range 0.518  contrastStd 0.169  chroma 0.404
// against an eye-level band of P05 0.20-0.42 / range 0.41-0.53 / std 0.13-0.18
// / chroma 0.30-0.42. Plate 1's own lit meadow measures luma 0.650 and its big
// cast tree shadow 0.566 — a 13% value drop that keeps full chroma — and ours
// was rendering that same pair at 0.501 / 0.433, i.e. the right *ratio* on a
// meadow a sixth of a stop too dark to read as sunlit.
//
// Checked against the shoulder, which is what capped exposure before: `hero`
// P95 goes 0.811 -> 0.847 (plate 1 is 0.866) and its chromaMean *rises*
// 0.308 -> 0.313, so the bright end is still under PBR Neutral's desaturating
// knee rather than bleaching through it.
const EXPOSURE = 0.92;

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
      // Sampling rate, set explicitly rather than through setQualityMode().
      //
      // Two things were wrong with the preset call. It came *after* the two
      // denoise lines and silently overwrote them (its 'High' preset is
      // denoiseSamples 8 / denoiseRadius 6, not the 8 / 12 written here), and
      // its 'High' means 64 AO samples per pixel — which, at half res over a
      // 1600x900 frame, is 23 M depth taps every frame and was the single most
      // expensive thing in the whole render. A/B'd inside one page load with
      // 4 s blocks so machine load hits both arms equally, 64 -> 16 samples is
      // p50 -1.4 ms and p95 -23.4 ms. Nothing else in the frame is worth that
      // much.
      //
      // This is a sampling *rate*, not a look control: radius, intensity and
      // colour above are what shape the AO, and they are untouched. At half res
      // with two poisson denoise iterations the difference 16 samples makes is
      // noise, and the denoiser is what removes it — which is why the still
      // frames measure the same either way (docs/INTEGRATION_REQUESTS.md).
      this.ao.configuration.aoSamples = 16;
      this.ao.configuration.denoiseSamples = 8;
      this.ao.configuration.denoiseRadius = 12;
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

    this._capBloomMips();

    engine.onResize((w, h) => {
      this.composer.setSize(w, h);
      this.ao?.setSize(w, h);
      this._capBloomMips();
    });
  }

  /**
   * Cap the bloom mip chain so its smallest level never gets tiny.
   *
   * THIS IS THE FLASHING-BLACK-FRAME FIX. Measured with a per-frame readback of
   * the default framebuffer plus a compositor screencast, 7-9% of *presented*
   * frames during a drive came out entirely black — the whole canvas, with only
   * the HUD (a separate compositor layer) still on it. Bisecting the chain
   * pinned it on this effect and nothing else: bloom+tonemap alone reproduced
   * it at 7.7%, every other effect paired with tonemap measured 0.0%. Bisecting
   * again on the mip count pinned it on the *depth* of the chain:
   *
   *   levels 8 (smallest mip 3x2 px)  7.7% of frames black
   *   levels 7 (6x4)                  1.4%
   *   levels 6 (13x7)                 0.3%
   *   levels 5 (25x14)                0.2%
   *
   * That table is real but its cause was misattributed. Deeper chains do not
   * lose the present; they carry a NaN further. See MIN_BLOOM_MIP.
   *
   * i.e. binding a handful-of-pixels render target and then coming back to the
   * default framebuffer intermittently loses the present. That is a driver bug,
   * not a bug here, but the last two or three levels of a mipmap bloom are the
   * ones a viewer can least see and the ones that cost the most in dropped
   * frames, so the chain stops before it gets there.
   *
   * The floor is on the mip's own short side, so this stays correct at every
   * window size instead of hard-coding a level count for one resolution.
   *
   * NOTE FOR THE LOOK AUTHOR: this shortens the widest, faintest part of the
   * halo. If the glow wants its old reach back, `radius` (currently 0.68) is
   * the knob — it widens each upsample step and does not reintroduce the tiny
   * targets. Logged in docs/INTEGRATION_REQUESTS.md.
   */
  _capBloomMips() {
    const pass = this.bloom?.mipmapBlurPass;
    if (!pass) return;
    const r = pass.resolution;
    const short = Math.min(r.width || 0, r.height || 0);
    if (short < 2) return;
    const levels = Math.max(1, Math.min(8, Math.floor(Math.log2(short / MIN_BLOOM_MIP))));
    if (pass.levels !== levels) pass.levels = levels;
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
