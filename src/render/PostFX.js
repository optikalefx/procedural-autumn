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
uniform float uContrastHue;
uniform float uLift;
uniform float uLiftKnee;
uniform float uToe;
uniform vec3  uLiftTint;
uniform vec3  uLiftTintCool;
uniform float uVibrance;
uniform float uGoldRotate;
uniform float uHuePivot;
uniform float uHueSpread;
uniform float uHueSpreadW;
uniform float uWarmSat;
uniform float uWarmSatSlope;
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
  //
  // Two ways to apply it, blended by uContrastHue. Per channel is the usual
  // one, and it does not preserve hue: it is an affine map, and an affine map
  // moves R:G:B ratios. On a gold pixel the effect is asymmetric and large.
  // Traced through this pass with real numbers from the river view, the shaded
  // bank arrives at the grade with G/R 0.393 and leaves the contrast step at
  // 0.136, i.e. the contrast alone turns an amber into a vermilion; the lift
  // and the warm regrade downstream spend most of their authority buying that
  // back and still only reach 0.585, against a reference cast shadow that
  // measures G/R 0.716. Sunlit gold, being well above the pivot, barely moves.
  // So "our shaded ground is red-brown where the reference's is amber-olive"
  // was, in the end, a property of this one line.
  //
  // The other way applies the same curve to luminance and scales the colour by
  // the result, which preserves R:G:B exactly — a shadow becomes a darker
  // version of the same colour, which is what the reference plates do (plate 1's
  // sunlit meadow is G/R 0.425 and its cast shadow 0.482, essentially the same
  // pigment at two brightnesses). Blended rather than swapped, because the
  // per-channel form is also where a good deal of the frame's chroma comes
  // from: at uContrastHue 1.0 the conifer-heavy views fall under the reference
  // chromaMean floor.
  //
  // The luma is soft-floored before the divide so the gain cannot go negative
  // and the divisor is clamped, which between them make this NaN-proof — see
  // the note on pow() and varyings in the grass shader for why that matters
  // here in particular: this pass is upstream of nothing, but it is downstream
  // of bloom, and a single non-finite pixel arriving here is already spread.
  vec3 cPerCh = (c - 0.18) * uContrast + 0.18;
  float l0 = luma(c);
  float l1 = (l0 - 0.18) * uContrast + 0.18;
  l1 = 0.5 * (l1 + sqrt(l1 * l1 + uToe * uToe));
  vec3 cRatio = c * (l1 / max(l0, 1e-4));
  c = mix(cPerCh, cRatio, uContrastHue);
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
  // uLiftKnee is where the lift has fallen to nothing. It used to be hard-coded
  // at 0.22 linear (~0.50 sRGB), which is well *above* shaded ground: a bank at
  // luma 0.10 linear was still collecting 57% of the lift while the sunlit gold
  // beside it, at 0.28, collected none. The lift was therefore spending most of
  // its authority closing the sun/shade gap the frame is supposed to have — it
  // measured as 0.03 of display luma on the river view's shaded bank alone. Pulled in
  // to 0.13 the lift keeps its actual job (a near-black leaf or a hole under a
  // canopy still lands on a warm brown rather than on nothing: at 0.02 linear it
  // is still at 92% strength) and stops paying for the shaded mid-tones.
  //
  // TWO tints, chosen by what the pixel already is, and this is the seam where
  // the cool cast-shadow mass was being destroyed. Stylize rotates a shadowed
  // pixel to the plate's blue *before* the grade; the lift then arrived as a
  // fixed warm brown that is larger than the whole pixel. Traced with real
  // numbers from the meadow view at full rotation, the shadow reaches this line
  // at linear (0.0117, 0.0176, 0.0417) — decisively blue-led — and the warm
  // lift adds (0.0369, 0.0270, 0.0193), which lands it on srgb(62,59,72): a
  // near-neutral, chroma 0.05, below the 0.06 the histogram even counts as
  // chromatic. That is the whole reason a full-strength rotation still measured
  // 0% azure. The rotation was never the thing that was too weak.
  //
  // So pick the tint off the pixel's own blue lead. A dark warm leaf, a shaded
  // trunk, a hole under a canopy — every one of them has coolLead 0 and lands
  // on exactly the warm brown this line has always given them. A cast-shadow
  // mass lands on srgb(44,60,96) instead, against plate 3's own srgb(47,66,102).
  // The cool tint carries the same luminance as the warm one (1.005), so this
  // chooses a colour and never a brightness, and the two agree at the seam.
  float coolLead = clamp((c.b - max(c.r, c.g)) / max(c.b, 1e-4), 0.0, 1.0);
  vec3 liftTint = mix(uLiftTint, uLiftTintCool, smoothstep(0.02, 0.30, coolLead));
  c += uLift * liftTint * (1.0 - smoothstep(0.0, uLiftKnee, luma(c)));

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

  // ── Warm regrade: rotate the red band to gold and cap its saturation ───────
  //
  // THIS IS THE "MONOCHROME ORANGE" FIX. Read the numbers before touching it.
  //
  // Measured on meadow against plate 1, as a share of chromatic pixels:
  //   red 68.4 / orange 29.1 / yellow 1.6 / y-grn 0.0
  //   plate 1 : 51.8 / 38.4 / 4.8 / 3.1
  // while lumaP05, lumaRange, contrastStd and chromaMean were all inside their
  // bands. Nothing about the frame was wrong except *where the hues sat*, and
  // a whole sheet of frames read as one rust-coloured smear because of it.
  //
  // The predecessor of this block was additive — c.g += c.r * redLead^2 * k
  // with k = 0.13. Two things were wrong with it. It is quadratic in redLead,
  // so it is weakest exactly on the dominant gold mass (which is only
  // moderately red-led) and strongest on the crimson maples that should be
  // left alone; and at k = 0.13 its whole authority was to move the meadow
  // from R:G:B 1 : 0.48 : 0.17 to 1 : 0.52 : 0.19, against a reference gold of
  // 1 : 0.68 : 0.36. It could not reach the masses that make the frame.
  //
  // So drive the correction off hue angle directly, and off measurement:
  //
  //   our gold mass  srgb(0.622, 0.300, 0.103)   hue 22 deg   sat 0.83
  //   plate 1 meadow srgb(0.911, 0.621, 0.327)   hue 29 deg   sat 0.63
  //
  // i.e. the gold is a *seven degree* rotation plus a large saturation cut.
  // The cut is the bigger half of it, and it is the half that restores blue
  // rather than adding green: pulling saturation down raises the lowest
  // channel, which on every red-led pixel in this game is blue. Adding green
  // alone was the trap the last two authors fell into — it walks the hue meter
  // toward gold while leaving B pinned near zero, and a pixel with no blue
  // reads vermilion no matter what its hue angle says. It also matches the
  // plates on chroma, which we were over rather than under: reference
  // chromaMean 0.29-0.31 and vividPct 31-34 against our 0.39-0.43 and 56-63.
  //
  // Done in a gamma space, not the linear one this pass otherwise works in.
  // Hue angle and saturation are perceptual quantities and the histogram that
  // judges them is computed on display values; in linear the same gold measures
  // sat 0.97, where a saturation ceiling has almost nothing to grip. The curve
  // used is sqrt (gamma 2.0), an approximation of sRGB and deliberately so —
  // this is a look control, not a colour-management step, and the gold lands
  // within a degree of where the exact curve puts it.
  //
  // It runs *after* the tone curve, not before. PBR Neutral's first move is to
  // subtract an offset derived from the minimum channel, which is precisely the
  // blue we are trying to put back; corrected upstream, the curve takes most of
  // it away again.
  {
    // Worked in place, in RGB, in a gamma-2.0 space. Two earlier shapes of this
    // block were both far too expensive for what they do — measured over a 45 s
    // drive at 1536, with the block compiled but branched around versus live:
    //   rgb2hsv/hsv2rgb + pow(2.2)   p50 25.5 ms  p95 56.1
    //   rgb2hsv/hsv2rgb + sqrt       p50 25.4 ms  p95 56.8
    //   block skipped                p50 16.7-18.0 ms  p95 37.2-48.6
    // The transcendentals were not the problem; swapping pow for sqrt bought
    // nothing. The four vec4 temporaries inside the branchless HSV pair were.
    // This effect is merged with bloom, tone map, vignette and SMAA into one
    // fragment program, and pushing that program past the register budget
    // spills it, which is why the cost shows up only when the branch is
    // actually taken.
    //
    // So do the work directly. Inside the red-to-yellow sector the hue is just
    // where the middle channel sits between the other two, which is one divide,
    // and saturation is one more; there is no reason to build a full HSV triple
    // to rotate inside a single sector. Gamma 2.0 (sqrt / square) because hue
    // and saturation are perceptual quantities and the histogram that judges
    // them is computed on display values — in linear the same gold measures
    // saturation 0.97, where a ceiling has nothing to grip.
    vec3 g = sqrt(max(c, 0.0));
    float wmx = max(g.r, max(g.g, g.b));
    float wmn = min(g.r, min(g.g, g.b));
    float wch = wmx - wmn;
    // Position of green between the other two channels: 0 at pure red, 1 where
    // green catches red at 60 deg. This is only a hue when red leads and blue
    // trails, which is exactly the band this operator is allowed to touch.
    float t = (g.g - wmn) / max(wch, 1e-4);
    // step() excludes the rose and blue side (green below blue); the taper on t
    // hands off before green becomes the lead channel, so conifers, sky and
    // water are all untouched and there is no seam where the ordering flips.
    // forest and waterfall are majority conifer and put 32-48% of their
    // chromatic pixels above 60 deg; rotating those would march the conifer
    // mass toward green, the exact thing uGreenTame exists to prevent.
    float warm = step(g.b, g.g) * (1.0 - smoothstep(0.80, 1.0, t)) * step(0.012, wch);
    float deg = t * 60.0;
    // Hue *spread*, which is the operator this frame actually needed. A pure
    // rotation cannot fix a monochrome frame; it only moves the smear, and the
    // proof is in the archive — rotating by 11 deg took meadow from 68% red /
    // 29% orange to 5% / 89%, a frame that reads as monochrome yellow instead
    // of monochrome orange and is no closer to the plate.
    //
    // Measured in 10 deg bins, plate 1 spreads its chromatic pixels 20.6 / 29.8
    // / 24.4 / 11.1 across 10-50 deg. Ours piled 58% into one bin. So push hues
    // away from wherever the pile is: a Gaussian-weighted expansion about the
    // pile centre, which separates the crimson maples below it from the gold
    // canopy above it and leaves everything far from the pivot alone. The
    // Gaussian is what keeps it local; without it a gain this size throws the
    // 50 deg tail into pure green.
    float dh = (deg - uHuePivot) / uHueSpreadW;
    deg += (uGoldRotate + (deg - uHuePivot) * uHueSpread * exp(-dh * dh)) * warm;
    // Saturation ceiling with a soft knee, not a clamp: below uWarmSat nothing
    // moves, above it the excess is compressed rather than flattened, so a
    // crimson maple and a gold grass blade do not arrive at the same
    // saturation. This is the half that restores blue rather than adding green
    // — pulling saturation down raises the lowest channel, which on every
    // red-led pixel in this game is blue.
    float sat = wch / max(wmx, 1e-4);
    sat -= max(sat - uWarmSat, 0.0) * uWarmSatSlope * warm;
    float lo = wmx * (1.0 - sat);
    vec3 gold = vec3(wmx, lo + clamp(deg / 60.0, 0.0, 1.0) * (wmx - lo), lo);
    g = mix(g, gold, warm);
    c = g * g;
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
        ['uSaturation',    new THREE.Uniform(0.80)],
        ['uContrast',      new THREE.Uniform(1.36)],
        ['uContrastHue',   new THREE.Uniform(0.55)],
        ['uLift',          new THREE.Uniform(0.020)],
        ['uLiftKnee',      new THREE.Uniform(0.130)],
        ['uToe',           new THREE.Uniform(0.022)],
        ['uLiftTint',      new THREE.Uniform(new THREE.Vector3(1.30, 0.95, 0.68))],
        ['uLiftTintCool',  new THREE.Uniform(new THREE.Vector3(0.78, 1.02, 1.48))],
        ['uVibrance',      new THREE.Uniform(0.90)],
        ['uGoldRotate',    new THREE.Uniform(1.75)],
        ['uHuePivot',      new THREE.Uniform(28.5)],
        ['uHueSpread',     new THREE.Uniform(0.85)],
        ['uHueSpreadW',    new THREE.Uniform(15.0)],
        ['uWarmSat',       new THREE.Uniform(0.63)],
        ['uWarmSatSlope',  new THREE.Uniform(0.85)],
        ['uBlueFloor',     new THREE.Uniform(0.160)],
        ['uGreenTame',     new THREE.Uniform(0.50)],
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
// Down from 0.92 with the golden-hour key desaturated (see Lighting KEYS). Two
// things in that change add luminance: the sun's green channel goes 0.51 -> 0.66
// linear and luma is 71% green, and the warm regrade's saturation ceiling raises
// the lowest channel of every gold pixel. Measured on the two vista frames,
// which are the ones with the least headroom:
//   hero  P05 0.425 -> 0.477, range 0.460 -> 0.412
//   dawn  P05 0.438 -> 0.496, range 0.425 -> 0.381
// against a reference black point of 0.16-0.42. That is the brief's "do not
// trade value structure for hue" being traded, so it is bought straight back
// here rather than by re-darkening the haze, which would undo the hue work.
const EXPOSURE = 0.88;

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
