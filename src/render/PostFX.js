// ─────────────────────────────────────────────────────────────────────────────
//  Post chain — the grade is where the painterly look actually lands.
//  Order: render -> SSAO -> DOF -> bloom -> tone map -> vignette -> grade -> SMAA
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, ShaderPass, BloomEffect, SMAAEffect,
  DepthOfFieldEffect, VignetteEffect,
  Effect, BlendFunction, KernelSize,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { QUALITY_PRESETS } from '../world/WorldConfig.js';
import { SKY_STATE } from './Lighting.js';
import { HEARTH } from './Hearth.js';
import { createUpscalePass } from './UpscalePass.js';

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
uniform float uMgntTame;
uniform float uMgntTameMax;
uniform float uNight;
uniform float uRodAmount;
uniform float uRodKnee;
uniform float uRodCoolLo;
uniform float uRodCoolHi;
uniform vec3  uRodTint;
// ── the hearth ──────────────────────────────────────────────────────────────
// Where the camp fire is, in VIEW space, and how far its warmth is allowed to
// hold the night grade off. Written every frame from HEARTH by _driveHearth().
// View space rather than world space so the reconstruction below needs no
// inverse-view matrix — the view transform is rigid, so a distance measured in
// it is the same metre distance as one measured in the world.
uniform vec3  uHearthPos;
uniform vec2  uHearthRange;   // x: full protection out to here, y: none past here
uniform float uHearthAmt;
// tan(fov/2) in x and y, so a depth sample can be turned back into a view-space
// position without a matrix.
uniform vec2  uTanHalf;
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

  // ── Magenta governor — the candy-pink distance, from the other side ────────
  //
  // The green governor above catches a pixel whose green LEADS. This catches the
  // opposite: green as the minimum channel with red *and* blue both above it,
  // which is the magenta / rose / violet sector and nothing else. A red-led
  // autumn pixel has G > B and is untouched; a blue-led sky pixel has G > R and
  // is untouched; only a pixel that has given up its middle channel is inside
  // this term.
  //
  // Measured at twilight (BASELINE, share of chromatic pixels): sunvista-h19 is
  // 23.8% magenta + rose + violet against morning.jpg's 1.7% and plate 1's 0.1%,
  // and the ladder puts the zenith at linear 1 : 0.425 : 0.881 — blue *above*
  // green over a peach horizon. That is a straight RGB lerp between a blue
  // zenith key and a peach horizon key passing through magenta, which is the
  // dome's business and is filed as a request to Author A. This is the backstop
  // for whatever survives it, and for the same crossing in the haze ramp.
  //
  // Raising green toward min(r, b) is the one move that cannot make things
  // worse: it walks magenta to a warm neutral, rose to a duller red and violet
  // to a blue-grey, and every step is toward the channel ordering the pixel
  // already has. Bounded well short of full, because a real violet twilight
  // zenith is a colour the plates do have — night.jpg's sky is 1 : 0.72 : 1.60,
  // which is inside this sector — and flattening it entirely would take the
  // night dome to navy, which is the exact defect the brief opens with.
  {
    float mid = min(c.r, c.b);
    float mgntLead = clamp((mid - c.g) / max(mid, 1e-4), 0.0, 1.0);
    float w = min(mgntLead * uMgntTame, uMgntTameMax);
    c.g = mix(c.g, mid, w);
  }

  // ── Scotopic response — the night frame's own tone curve ───────────────────
  //
  // THE NIGHT FRAME WAS THE BLACK LIFT AND NOTHING ELSE. Measured on the
  // baseline: ridge-h0 runs lumaP05 0.161 to lumaP95 0.168 — a range of 0.007
  // across the whole frame — and dome-h0 reads luma 0.024 at all twelve
  // ladder points, zenith and horizon alike. Traced back through this pass, a
  // rendered night sky of srgb(35,43,58) is linear (0.016, 0.024, 0.043), and
  // the lift above adds (0.014, 0.018, 0.027) of that: two thirds of every
  // night pixel in the game was a spatially constant term added by this shader.
  // A constant has no gradient, which is why the dome measured flat. The other
  // half of the fix is exposure (see EXPOSURE_ELEV) — the scene has to outrun
  // the lift before any of this is worth applying.
  //
  // What the plates do at night is NOT a desaturation. night.jpg's sky is
  // 1 : 0.72 : 1.60 and its moonlit ground is srgb(14,47,88), chroma 0.29 — a
  // strongly chromatic cool blue, not a grey. Meanwhile the tent beside it is a
  // saturated orange and the fire keeps its ember. So a global saturation cut at
  // night is wrong twice over: it greys the cool mass the plate makes its
  // picture out of, and it kills the warm accent that picture is composed
  // around.
  //
  // Purkinje is a shift toward the rods' response. Mixing toward
  // luma * uRodTint rather than toward vec3(luma) is what keeps the chroma —
  // it rotates hue, it does not remove it, which is the same argument the lift
  // tint above is built on.
  //
  // TWO gates, and the second one is the interesting half.
  //
  // uRodKnee is a HIGHLIGHT gate in linear light. Above it a pixel is a real
  // light source — a campfire, a headlight pool, a lit window — bright enough
  // for cones, and it keeps its own colour completely. This is what stops the
  // operator from eating the warm accent that night.jpg composes its whole
  // picture around. It is deliberately set well ABOVE the moonlit ground, not
  // below it, which is the opposite of the first version of this block: with
  // the knee under the ground the term reached only the sky, and the moonlit
  // meadow stayed the khaki it is at noon.
  //
  // The second gate is the pixel's own coolness, and it is what protects the
  // dome without an explicit exclusion. Rods peak near 500 nm, so a surface
  // that is already blue looks the same to rods and to cones and has nothing
  // to shift; a warm surface is what a rod response changes. So taper the term
  // out as the pixel's blue lead rises. This falls out as: the khaki meadow,
  // the brown trunk and the orange leaf litter — the whole "daytime ground,
  // dimmed" mass the baseline note names — are moved, and the violet sky,
  // the blue snow and the blue distance, which are Author A's and Author B's
  // authored colours, are left exactly as authored.
  //
  // Without it this term and the sky dome fight: measured on dome-h0, a
  // full-strength rod shift with no coolness taper took the frame from 42% to
  // 81% of chromatic pixels in the violet/magenta sector, i.e. it was
  // re-authoring the dome from the grade.
  //
  // ── AND THE THIRD GATE IS THE FIRE, WHICH IS NOT A BRIGHTNESS TEST ────────
  //
  // uRodKnee above is the highlight gate, and its note names a campfire as one
  // of the things it protects. It does not protect one, and it cannot: the knee
  // sits at 0.60 linear because it has to stay clear of the moonlit ground, and
  // a camp fire's POOL — as opposed to its flame, which passes easily — runs an
  // order of magnitude under that. So the ground, the chairs and the tent went
  // to the rod axis while the flame in the middle of them kept its ember, and
  // the camp read as lavender lit by an orange light, which is not a thing.
  //
  // This has been paid for elsewhere for a long time. camp_fire.js's light
  // block records three sweeps that all found the same wall — "4.2 put the
  // whole clearing in pale lavender out to six metres" — and resolved it by
  // turning the fire down until it lit almost nothing, tightening its falloff,
  // and giving the warmth to an emissive flame that cannot light a chair. That
  // is this operator's bill, paid by the art.
  //
  // The gate is spatial, and that is the honest form of it rather than a
  // convenient one. Purkinje is a fact about the eye, not about a pixel: a
  // person sitting inside a fire's light is not dark-adapted, their cones are
  // working, and the shift belongs to the trees BEYOND the fire. So take the
  // pixel's world distance from the flame and hold the operator off inside it.
  //
  // Reconstruction is two multiplies: getViewZ() gives the view-space depth,
  // and the frustum's tangent half-angles turn the screen position into the
  // other two axes. Distance is then measured against the fire's own view-space
  // position, which PostFX writes each frame — a rigid transform, so this is
  // metres in the world.
  //
  // uHearthAmt is zero whenever there is no lit fire, which is almost always,
  // and the branch on it keeps the depth fetch out of every frame that has no
  // camp in it. Nothing is gated on this at the CPU: one uniform write per
  // frame is cheaper than a pass rebuild, and a pass rebuild relinks the merged
  // shader, which is the freeze this whole chain is arranged to avoid.
  if (uNight > 0.001) {
    float ln = luma(c);
    float dim = 1.0 - smoothstep(uRodKnee * 0.35, uRodKnee, ln);
    float coolLead2 = clamp((c.b - max(c.r, c.g)) / max(c.b, 1e-4), 0.0, 1.0);
    float already = 1.0 - smoothstep(uRodCoolLo, uRodCoolHi, coolLead2);

    float hearth = 0.0;
    if (uHearthAmt > 0.001) {
      // readDepth() and getViewZ() are the effect prelude's, declared for every
      // merged pass whether or not anything asked for depth — which is what
      // makes this legal without the attribute. See the note in GradeEffect.
      float vz = getViewZ(readDepth(uv));
      vec3 vpos = vec3((uv * 2.0 - 1.0) * uTanHalf * -vz, vz);
      float hd = distance(vpos, uHearthPos);
      hearth = uHearthAmt * (1.0 - smoothstep(uHearthRange.x, uHearthRange.y, hd));
    }

    float w = uRodAmount * uNight * dim * already * (1.0 - hearth);
    vec3 rod = vec3(ln) * uRodTint;
    c = mix(c, rod, clamp(w, 0.0, 1.0));
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
uniform float uOffsetScale;

vec3 pbrNeutral( vec3 c ) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;

  // ── THE BLACK OFFSET IS A DAYLIGHT ASSUMPTION, AND AT NIGHT IT IS FALSE ────
  //
  // PBR Neutral subtracts the pixel's own minimum channel, up to a ceiling of
  // 0.04. In a daylight frame that is a small toe on a picture whose subject
  // sits between 0.1 and 1.0. At night the ENTIRE frame is below 0.04, so the
  // subtraction is not a toe — it is most of the image.
  //
  // Worked through with a measured night sky, linear (0.006, 0.008, 0.020):
  //   x = 0.006, offset = 0.00578, result (0.00022, 0.00222, 0.01422)
  // Two things happen and both are defects the round has been chasing.
  //
  //   · The pixel loses two thirds of its luminance. That is the "night is 4x
  //     too dark" reading, and no exposure setting fixes it cleanly because the
  //     subtraction is of a quantity that itself scales with exposure — which
  //     is why the measured transfer from exposure to rendered night sky is a
  //     3.4 POWER rather than a linear one. Swept on dome-h0:
  //       base exposure  0.44   0.55   0.70   0.88
  //       zenith luma    0.014  0.033  0.081  0.144
  //     A 2x change in exposure is a 10x change on screen. Every author's
  //     night radiance lands on that curve, so the night level is not really
  //     anybody's to own until this is flattened.
  //
  //   · Subtracting the minimum channel is, exactly, a saturation operator. It
  //     takes the red channel of a night sky to nearly zero, so a dome authored
  //     at a plausible 1 : 0.9 : 1.5 arrives at 1 : 0.7 : 6.4 — the blue excess
  //     reported against Author B's night keys. Part of that number is this
  //     line and not their keys, and chasing it in the keyframe table means
  //     authoring a colour that this curve then re-breaks.
  //
  // So scale the offset out as night falls. It is not a change to the curve's
  // shape where the curve has a job to do: uOffsetScale is 1.0 for every
  // daylight and twilight hour and only falls once the frame is genuinely below
  // the offset's own ceiling. The black point at night is then set by the
  // grade's toe, which is a term authored for the purpose and is measured in
  // the frame it is applied to.
  float x = min( c.r, min( c.g, c.b ) );
  float offset = ( x < 0.08 ? x - 6.25 * x * x : 0.04 ) * uOffsetScale;
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
      uniforms: new Map([
        ['uExposure', new THREE.Uniform(exposure)],
        ['uOffsetScale', new THREE.Uniform(1.0)],
      ]),
    });
  }
  get exposure() { return this.uniforms.get('uExposure').value; }
  set exposure(v) { this.uniforms.get('uExposure').value = v; }
  get offsetScale() { return this.uniforms.get('uOffsetScale').value; }
  set offsetScale(v) { this.uniforms.get('uOffsetScale').value = v; }
}

// ── Veiling glare ───────────────────────────────────────────────────────────
//
// A mipmap bloom is a *scattering* kernel: its energy falls off fast, so it
// draws a tight halo and nothing else. What makes morning.jpg read as looking
// INTO the light is not that halo — it is the low-frequency wash that lifts the
// entire upper-left quadrant of the frame, mountains included, most of a
// frame-width away from the disc. sunset2.jpg is the same operator at full
// strength: the canyon walls either side of the sun are washed pale for
// hundreds of pixels. No amount of bloom intensity produces that, because
// raising intensity brightens the core long before it reaches the corner.
//
// So take it from the broadest thing already in the chain. The bloom's mipmap
// pyramid computes a heavily-filtered, luminance-thresholded copy of the frame
// on its way down; the smallest upsampling level is that copy at roughly a
// hundredth of the frame's width, which as a screen-space field is exactly the
// wash. Adding it back at its own gain — separately from the bloom, which keeps
// its own tighter radius — gives two independent knobs for two different
// optical effects instead of one knob that has to be both.
//
// It costs five taps of a texture a few dozen texels wide, i.e. nothing: it is
// resident in cache for the whole frame. And it is occlusion-correct for free,
// which an analytic screen-space flare centred on the sun's projected position
// is not — put the sun behind a ridge and the bright pixels are not in the
// pyramid, so the wash is not there either.
//
// Five taps rather than one because a texture this small is being magnified
// ~64x, and bilinear magnification is only C0: the gradient breaks at every
// texel boundary, which on a smooth low-amplitude wash shows up as faint
// diamond facets. Four half-texel diagonal taps plus the centre is a tent over
// the interpolant and removes them.
//
// Runs in linear HDR *before* the tone curve, which is where glare belongs —
// it is light arriving at the sensor, so the curve must compress it. Added
// after the curve it would simply raise the black level of the whole frame.
const VEIL_FRAG = /* glsl */`
uniform sampler2D uVeilTex;
uniform vec2  uVeilTexel;
uniform float uVeilGain;
uniform vec3  uVeilTint;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 v = texture2D(uVeilTex, uv).rgb * 0.3333;
  v += texture2D(uVeilTex, uv + uVeilTexel * vec2( 0.75,  0.75)).rgb * 0.1667;
  v += texture2D(uVeilTex, uv + uVeilTexel * vec2(-0.75,  0.75)).rgb * 0.1667;
  v += texture2D(uVeilTex, uv + uVeilTexel * vec2( 0.75, -0.75)).rgb * 0.1667;
  v += texture2D(uVeilTex, uv + uVeilTexel * vec2(-0.75, -0.75)).rgb * 0.1667;
  outputColor = vec4(max(v, 0.0) * uVeilGain * uVeilTint, inputColor.a);
}`;

class VeilEffect extends Effect {
  constructor() {
    super('AutumnVeil', VEIL_FRAG, {
      blendFunction: BlendFunction.ADD,
      uniforms: new Map([
        ['uVeilTex',   new THREE.Uniform(null)],
        ['uVeilTexel', new THREE.Uniform(new THREE.Vector2(1 / 32, 1 / 18))],
        ['uVeilGain',  new THREE.Uniform(0.0)],
        // Slightly warm, and only slightly. The plates' glare core is
        // `#fefcf0` — a neutral white — and only turns peach several degrees
        // out, so the wash must not arrive pre-tinted orange or the frame
        // never produces a near-neutral pixel. The peach comes from the
        // *source* being peach, not from this.
        ['uVeilTint',  new THREE.Uniform(new THREE.Vector3(1.04, 1.00, 0.94))],
      ]),
    });
  }
  get gain() { return this.uniforms.get('uVeilGain').value; }
  set gain(v) { this.uniforms.get('uVeilGain').value = v; }
}

// ── THE GRADE MUST NOT DECLARE EffectAttribute.DEPTH, AND IT WANTS TO ───────
//
// Its hearth mask reads the depth buffer, and `EffectAttribute.DEPTH` is the
// documented way for an effect to ask for one. Setting it here silently
// re-orders the whole post chain and destroys the grade.
//
// EffectPass.setEffects() sorts: `effects.sort((a, b) => b.attributes -
// a.attributes)`. DEPTH is bit 0, so ANY effect that declares it is moved ahead
// of every effect that declares nothing. This effect is handed to the pass last
// on purpose — a grade grades a finished frame — and with the attribute set it
// jumped from slot 6 to slot 2, in front of bloom, the veil, the tone curve and
// the vignette. Confirmed by dumping the merged fragment shader both ways: the
// grade's uniforms went from e6* to e2*.
//
// What that failure looks like is worth writing down, because it looks like
// nothing to do with the change. There is no error, no warning, and no night in
// it: the daylight hero vista simply came back more saturated and more
// contrasty, 39% of its pixels moved by more than 8 levels, from a diff whose
// every new line of shader code sits inside `if (uNight > 0.001)`.
//
// So take the depth the other way. `readDepth()`, `getViewZ()`, the
// `depthBuffer` sampler and the PERSPECTIVE_CAMERA define are in the effect
// prelude unconditionally — every merged pass gets them whether or not any
// effect asked for depth — so the grade just calls them. The other half of what
// the attribute would have done, making the composer bind a depth texture, is
// done explicitly in _rebuildMainPass.
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
        ['uMgntTame',      new THREE.Uniform(0.55)],
        ['uMgntTameMax',   new THREE.Uniform(0.40)],
        // Written every frame by PostFX.render() from SKY_STATE. See _night().
        ['uNight',         new THREE.Uniform(0.0)],
        ['uRodAmount',     new THREE.Uniform(0.70)],
        // Linear light. Above this a pixel is a light source and keeps its own
        // colour — see the block in the grade. Set ABOVE the moonlit ground.
        ['uRodKnee',       new THREE.Uniform(0.60)],
        ['uRodCoolLo',     new THREE.Uniform(0.18)],
        ['uRodCoolHi',     new THREE.Uniform(0.55)],
        // Luminance-normalised (luma 0.999), so this sets a hue and never a
        // brightness. One axis has to serve two plate samples that are not the
        // same colour — night.jpg's sky is 1 : 0.72 : 1.60 (violet) and its
        // moonlit snow is srgb(14,47,88), effectively 1 : 13 : 46 (blue) — so
        // this sits between them at 1 : 0.95 : 2.10, a blue-violet. Pulled to
        // the snow end it takes the dome to navy, which is the defect the brief
        // opens with; pulled to the sky end the ground stays brown.
        ['uRodTint',       new THREE.Uniform(new THREE.Vector3(0.958, 0.910, 2.012))],
        // All four written every frame by _driveHearth(), so these values are
        // only what the shader links against. Amount 0 is "no fire", which is
        // the state all day and almost everywhere at night; the block is
        // branched on it, so the other three are never read until there is one.
        ['uHearthPos',     new THREE.Uniform(new THREE.Vector3(0, 0, -1e4))],
        ['uHearthRange',   new THREE.Uniform(new THREE.Vector2(3.2, 8.6))],
        ['uHearthAmt',     new THREE.Uniform(0.0)],
        ['uTanHalf',       new THREE.Uniform(new THREE.Vector2(0.577, 0.414))],
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
//
// 7, down from 12, and it is a look change bought with the headroom that note
// describes. The widest lobe a mipmap bloom can draw is set by its smallest
// level: at a 12 px floor a 900 px frame gets 6 levels and the broadest kernel
// is ~1/64 of the frame, which cannot reach the halo `morning.jpg` puts across
// a third of its width. At 7 px it gets 7 levels. The two extra targets are
// 14x8 and 7x4 — about 130 texels of render work between them, which is not a
// measurable cost, and the black-frame table above is not a reason to refuse
// them now that its actual cause is fixed. Checked with perf.mjs's
// black-frame sampler after the change: 0 of 8 sampled during motion.
const MIN_BLOOM_MIP = 7;

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

// ── Exposure follows the sun's elevation ────────────────────────────────────
//
// Critic blocker 3 says the ground is the `#f0ad46` anchor's colour at one hour
// in four, and the failing hours are the *bright* one and the *dim* one. The
// bright one is measured on a gold card in full sun through the whole chain:
//
//   h  7.4   1 : 0.748 : 0.330   luma 0.513
//   h 16.7   1 : 0.718 : 0.326   luma 0.464     anchor is 1 : 0.721 : 0.292
//   h 12     1 : 0.819 : 0.367   luma 0.730     washed cream
//
// At luma 0.73 the card is past PBR Neutral's compression knee, and that curve
// desaturates as it compresses — so noon's gold is bleached by the *tone
// curve*, and no grade downstream can put it back because the information is
// gone by then. It is also not a lighting-authoring error: a flat, up-facing
// ground plane at a 53 deg noon sun genuinely receives about four times the
// irradiance it does at a 14 deg golden hour. Cutting the midday keyframes to
// hide that was tried and reverted — a 13% cut in scene radiance moved the card
// by 1.6% on screen, because the shoulder is exactly where changes stop showing
// — and it would have dimmed the ground while leaving the independently-lit sky
// dome where it was.
//
// So absorb it here, where a photographer would: hold the whole frame under the
// knee by stopping down as the sun climbs. `sunElev` is sin(elevation) off
// SKY_STATE and runs 0 at the horizon to 0.92 at noon; the canonical views all
// sit between 0.12 (h7.4) and 0.34 (h17.9), so the ramp starts *above* every
// framing this project judges and the whole shipping sheet is bit-identical.
// It is a smooth function of a smooth quantity, so it cannot flicker, and it is
// a multiplier on the base rather than a write to it, so photo mode's exposure
// slider still works.
const EXPOSURE_ELEV_START = 0.40;   // sin(elev) at which stopping down begins
const EXPOSURE_ELEV_END   = 0.92;   // …and reaches full
const EXPOSURE_ELEV_MIN   = 0.66;   // multiplier at the top of the arc

// ── …AND THE OTHER HALF OF THE ARC, WHICH HAD NEVER BEEN WRITTEN ────────────
//
// The ramp above is one-sided. It clamps at `sunElev` 0.40, so from the
// horizon down to midnight the exposure was a constant, and every hour this
// round is about — twilight and night — sat on the flat part of a curve whose
// whole argument is that exposure is where a photographer absorbs a change in
// scene radiance. A photographer opens up at dusk. This did not.
//
// What that cost, measured on the pinned baseline at 1600x900:
//
//   frame          lumaP05  lumaP95  range    plate            P05    P95
//   sunvista-h19    0.291    0.614   0.322    sunset.jpg      0.247  0.927
//   hero-h19        0.263    0.612   0.349    sunset2.jpg     0.204  0.703
//   ridge-h0        0.161    0.168   0.007    night.jpg       0.028  0.336
//   dome-h0         0.161    0.167   0.005    night3.jpg      0.072  0.282
//
// Two different failures and they want opposite corrections.
//
// TWILIGHT is missing its TOP. Our black point is already at the plate's — 0.26
// against 0.247 — and we reach lumaP95 0.61 where the plate reaches 0.93. There
// is no blown pixel anywhere in the frame, which is the numeric form of "no
// golden glow": a glow IS a blown highlight. So open up. The bottom is held by
// raising twilight contrast in the same ramp (see _lowSun in render), which
// pushes the toe down as fast as the exposure lifts the top, so the range grows
// from both ends instead of the whole frame sliding up.
//
// NIGHT is missing EVERYTHING, and the reason is arithmetic rather than art.
// `ridge-h0` spans 0.007 of luma across the entire frame. Traced back through
// the grade, srgb(41,42,42) is linear ~(0.021,0.023,0.024) and the grade's own
// black lift contributes (0.014,0.018,0.027) of it — so upward of two thirds of
// every night pixel in the game was a spatially constant term this file adds,
// and a constant has no gradient. The scene has to outrun the lift before any
// night grading is worth doing, and a 3.4x open-up is what puts the dome at the
// plates' 0.050 linear with the lift then a minority of it. The lift is also
// cut at night (uNight, see render) so the two moves do not fight.
//
// Written as a small monotone table rather than a second smoothstep because it
// is three joined ramps and a formula with three more constants in it is harder
// to read than the shape it makes. Interpolated with smoothstep between rows,
// so it is C1 in `sunElev`, which is itself continuous — this cannot flicker,
// and photo mode's slider still composes with it because it multiplies
// `_baseExposure` rather than writing it.
//
// The table below is authored against the tree as it stands, and the top of it
// is deliberately flat: with Authors A and B's twilight sky in place,
// `sunvista-h19` reaches lumaP95 0.866 with every term in this file disabled,
// so dusk needs no exposure help at all and an earlier version that gave it
// 1.34x bought top-end by moving lumaP05 from 0.305 to 0.369 — the wrong
// trade. Everything below the horizon does need it.
//
// The night end started at 2.10 and came down to 1.28 as the three daylight
// constants below (tone-curve offset, contrast pivot, toe) were scaled out of
// the night in turn. Each of them was suppressing the night frame, so each time
// one went the exposure needed less to do. That is the honest reading of this
// table: MOST of what looked like a night exposure problem was three
// display-referred corrections applied to a frame two decades below the range
// they were sized for.
//
//   sin(elev)   x     what
//     0.40+    1.00   day: handed to the EXPOSURE_ELEV ramp above, untouched
//     0.10     1.00   dawn/golden hour: the shipping sheet, bit-identical
//     0.00     1.00   sun on the horizon — the sunset plates, and already there
//    -0.09     1.07   civil twilight
//    -0.22     1.20   astronomical twilight into night
//    -0.45     1.28   deep night
const EXPOSURE_LOW = [
  [ 0.10, 1.00 ],
  [ 0.00, 1.00 ],
  [-0.09, 1.07 ],
  [-0.22, 1.20 ],
  [-0.45, 1.28 ],
];

/** Interpolate EXPOSURE_LOW at `e`, smoothstepped between rows. */
function exposureLow(e) {
  if (e >= EXPOSURE_LOW[0][0]) return EXPOSURE_LOW[0][1];
  const last = EXPOSURE_LOW.length - 1;
  if (e <= EXPOSURE_LOW[last][0]) return EXPOSURE_LOW[last][1];
  for (let i = 0; i < last; i++) {
    const [e0, v0] = EXPOSURE_LOW[i];
    const [e1, v1] = EXPOSURE_LOW[i + 1];
    if (e > e1) {
      let t = (e0 - e) / (e0 - e1);
      t = t * t * (3 - 2 * t);
      return v0 + (v1 - v0) * t;
    }
  }
  return EXPOSURE_LOW[last][1];
}

// ── The glare ramp ──────────────────────────────────────────────────────────
//
// Bloom and veil both key off "how low is the sun", for the reason the note at
// the top of Sky.js gives from the other side: a sky sitting near the tone
// curve's knee blooms *everywhere*, and at midday the whole dome is there. A
// low sun is when a broad, hot lobe reads as glare and a high sun is when the
// same lobe reads as white paper, so the threshold has to move with it.
//
// `lowSun` below is 1 with the sun at or under the horizon and 0 by the time it
// is 20 deg up, which puts h7.4 (sin 0.12) at 0.62 and h17.1 at about 0.35 —
// i.e. the two golden-hour framings get most of it and noon gets none.
//
// Threshold is in LINEAR light, which is the trap in this block and the reason
// the header comment above once described this pass as running on the
// display-referred result. BloomEffect's luminance pass reads the merged pass's
// *input buffer*, which is the HDR scene straight off the guard pass — the tone
// curve is an effect further down the same merged shader and has not run. So
// 0.80 here is 0.91 on screen, not 0.80, and a dusk sky peaking at 0.4 linear
// was never within reach of it at any intensity.
const GLARE_THRESH_HI  = 1.05;   // linear luma the bloom starts at, sun high
const GLARE_THRESH_LO  = 0.72;   // …and with the sun on the horizon
                                 //
                                 // Swept on sunvista and sunlow at h7.4 and
                                 // h19 (tools/postsweep.mjs), lumaRange at
                                 // h19: 0.60 -> 0.696, 0.90 -> 0.680,
                                 // 1.20 -> 0.645, 1.60 -> 0.636. Below ~0.6
                                 // the whole dusk sky is over the line and the
                                 // frame goes to white paper — the failure the
                                 // note at the top of Sky.js records — while
                                 // above ~1.2 only the disc is admitted and
                                 // there is no aureole to spread. 0.72 sits
                                 // just under the dusk sky's own peak, so the
                                 // sky contributes weakly and the aureole
                                 // strongly, which is the shape the plates
                                 // have.
const GLARE_SMOOTH_HI  = 0.45;   // knee width, sun high
const GLARE_SMOOTH_LO  = 0.30;   // …and low: a narrower knee, so the broad
                                 // low-amplitude aureole is admitted rather
                                 // than being smoothed away to nothing
const GLARE_INTENS_HI  = 0.34;
const GLARE_INTENS_LO  = 0.86;
const GLARE_RADIUS_HI  = 0.68;
const GLARE_RADIUS_LO  = 0.84;   // wider upsample tent: each level contributes
                                 // more of the level above it, which is what
                                 // carries the halo out past the disc
const VEIL_GAIN_HI     = 0.10;
const VEIL_GAIN_LO     = 0.25;

// ── …and a third arm, for night ─────────────────────────────────────────────
//
// `lowSun` is 1 all night, so without this the dusk glare settings run at
// midnight too — and at midnight the only things over a 0.72 threshold are the
// moon and the brightest stars. The moon SHOULD have a halo: night.jpg draws
// one about ten disc-radii across and it is a large part of why that plate
// reads as moonlit rather than as dark. The stars should not. Measured on
// dome-h0 at the dusk settings, the brightest stars came back with visible
// halos tens of pixels across against a plate whose stars are points.
//
// The two are separated by brightness and nothing else, so raise the threshold
// at night until only the moon is over it, and take the intensity down with it.
// The veil follows for free — it reads the same thresholded pyramid, so a star
// that is no longer in the source is no longer in the wash either.
const GLARE_THRESH_NIGHT = 1.70;
const GLARE_INTENS_NIGHT = 0.42;
const VEIL_GAIN_NIGHT    = 0.30;

// ── HDR sanity gate ──────────────────────────────────────────────────────────
//
// A structural backstop, not a fix for any particular bug. One non-finite
// fragment anywhere in the scene is not a wrong pixel — the bloom mip chain
// averages it outward roughly a texel per level while each level's texel is
// twice as wide, so six levels turn it into a black square several hundred
// pixels across. That is the difference between an invisible defect and one the
// player calls immersion-breaking, and it has now cost three authors a hunt.
//
// This runs once, before anything that blurs, and replaces any non-finite or
// absurd channel with zero. Cost is one full-screen half-float blit.
//
// Note the test is written as "is this value inside a sane range" and takes the
// *failure* branch, rather than testing for badness directly. That is not a
// style choice: every comparison against NaN is false, so `if ( c > BIG )` and
// `if ( c != c )` are not equivalent, and the first one silently does nothing.
// The same trap is why `if ( alpha < 0.004 ) discard;` never discards a NaN.
const SANITY_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
varying vec2 vUv;

// Well below half-float max (65504) so an Inf, a NaN, or a value that would
// overflow the buffer on the next multiply all fail together.
const float SANE = 60000.0;

float sane( float c ) {
	return ( c >= -SANE && c <= SANE ) ? c : 0.0;
}

void main() {
	vec4 c = texture2D( inputBuffer, vUv );
	gl_FragColor = vec4( sane( c.r ), sane( c.g ), sane( c.b ), sane( c.a ) );
}
`;

const SANITY_VERT = /* glsl */`
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4( position.xy, 1.0, 1.0 );
}
`;

// ── WHAT THE POST CHAIN ACTUALLY COSTS ───────────────────────────────────────
//
// "Post processing is 56-59% of frame time" was true, and it is no longer the
// number to plan against, because it was measured before the pixel-ratio fix
// and before adaptive resolution. The post chain is fixed cost per pixel, so
// when the pixel count fell the whole term fell with it. The reporting player
// rendered 1.02 MP (a ~1170x870 window at the then-current effective ratio of
// 1.0). That is the historical measurement configuration; the current quality-
// biased adaptive policy is defined in WorldConfig.ADAPTIVE_RESOLUTION.
//
// Measured at exactly that: 1.02 MP, driving, one effect removed at a time,
// arms alternated every ~34 frames inside one page load so that this shared
// machine's 2-3x throughput drift cancels instead of being mistaken for a
// result (tools/_scratch/postab.mjs explains why the two obvious methods —
// per-pass timer queries, and one timer query per frame — both fail here).
// Baseline 13.02 ms/frame, IQR on every ratio below 0.12:
//
//     removed                   d_ms      share
//     depth of field           -1.07      -8.2%
//     SSAO (N8AO, whole pass)  -0.94      -7.2%
//     bloom                    -0.15      -1.2%
//     SMAA                     +0.10       noise
//     HDR guard pass           +0.13       noise
//     grade + vignette         -0.01       noise
//     ENTIRE CHAIN             -3.25     -24.9%
//
// Three separate runs put the whole chain at 23%, 25% and 32%. So: post is
// about a quarter of the frame, no single effect is worth more than 8%, and
// deleting every effect this project's look is made of — grade, tone curve,
// AO, all of it — buys ~4 fps at the rate the player is seeing. That is why
// nothing in the ultra chain was cut. The remaining ~1.1 ms of the 3.25 that
// the individual rows do not account for is the merged fullscreen shader plus
// the composer buffer swaps that disappear when only one effect is left.
//
// Two things that were checked and are NOT problems:
//   * Effect merging really happens. All six effects compile into ONE
//     EffectPass fragment shader; the composer holds exactly four passes
//     (scene, SSAO, guard, merged). Nothing forces a pass of its own.
//   * The HDR guard pass is free — 0.13 ms, inside the noise. gputime.mjs
//     reports 13 ms for it, which is that harness's fixed per-span cost, not
//     the pass.
//
// One thing that is worth a look author's attention, unchanged here because it
// is what shipped and a blind A/B cannot separate it: EffectPass sorts its
// effects by attribute, and SMAA declares CONVOLUTION|DEPTH. It therefore runs
// FIRST in the merged shader, not last as the header comment above describes —
// i.e. edges are detected and blended in linear HDR, before the tone curve.
//
// ── Per-tier post chain ──────────────────────────────────────────────────────
//
// QUALITY_PRESETS owns whether SSAO and DOF exist at all; it has no vocabulary
// for *sampling rates*, which is what the rest of a tier drop should be. This
// table is that vocabulary, and it lives here because these are post decisions.
//
// SSAO is currently disabled in every shipping preset after a paired run found
// it consumed 22% of the Ultra frame for no perceptible change across three
// canonical plates. The implementation and its sampling ladder remain here as
// an instrument: if the look changes enough to need AO later, it can be priced
// and restored without reconstructing the pass from scratch.
//
// Nothing here softens the image at any tier: SMAA and the guard pass are
// present at every tier, and no tier lowers a render resolution. A tier drop
// removes work; it never trades sharpness for it.
const POST_TIERS = {
  ultra:  { aoSamples: 16, denoiseSamples: 8, denoiseIterations: 2, bloomMip: 12 },
  // One denoise iteration, not two. `ultra` and `high` used to be identical
  // rows — docs/PERF_FINDINGS.md flags it — and the AO the denoiser cleans is
  // a 1.1 m contact cue at half res, where the second poisson iteration is
  // plausibly as expensive as the AO pass itself. With the internal-resolution
  // path the AO buffer is smaller again, so the noise a single iteration
  // leaves is below what the reconstruction filter preserves.
  high:   { aoSamples: 16, denoiseSamples: 8, denoiseIterations: 1, bloomMip: 12 },
  medium: { aoSamples: 8,  denoiseSamples: 4, denoiseIterations: 1, bloomMip: 24 },
  low:    { aoSamples: 8,  denoiseSamples: 4, denoiseIterations: 1, bloomMip: 32 },
};

// ── Depth of field: two configurations, one effect ───────────────────────────
//
// DOF_TIER is what a quality preset with `dof: true` would get. Nothing ships
// with it — `QUALITY_PRESETS` has `dof: false` on all four tiers — so this row
// is the historical gameplay tune preserved as the thing `setPhotoDOF(false)`
// restores. bokehScale 0.60 is down from 1.6 because at that size a blown
// highlight behind the focal plane resolved as a hard white disc several
// percent of frame width (the waterfall view was full of them) and the whole
// frame read as tilt-shift miniature rather than cozy.
//
// PHOTO_DOF is the other extreme, and it is allowed to be, because photo mode
// is a different machine: the world is frozen, one still image is being drawn,
// and the render resolution is pinned to the display's native density. The
// "confetti highlights" constraint above was derived for a 60 fps drive; a
// still photograph WANTS its out-of-focus highlights to resolve as discs.
//
// ── why there is a film size in here, and why it is not a constant ─────────
//
// The aperture dial is real optics, not a magic slider, so that f/2.8 and f/11
// differ the way a photographer expects: the wide stop melts the background and
// leaves a plane of sharpness a few centimetres thick, the narrow one brings
// the valley back and holds everything from the grass to the ridge.
//
// The circle of confusion for a background at infinity is
//
//     c = f² / (N · (s − f))          f = focal length, N = f-stop,
//                                     s = focus distance, all in mm
//
// and what the shader wants is that circle as a fraction of FRAME HEIGHT,
// c / (2·format), because `bokehScale` is a radius in buffer pixels and the
// buffer is whatever photo mode's resolution pin made it. So two numbers decide
// the whole picture: the focal length and the film it is covering.
//
// The trap is that a game camera is a wide lens. This game's driving fov is
// 44–58° vertical, which on a 24 mm-tall full-frame sensor is a 22–28 mm lens —
// and a full-frame 24 mm at f/1.4 focused at 11 m gives a background blur of
// about **1.7 px** at 900 lines. That is the correct answer and it is not a
// photograph; wide lenses at ordinary distances have no bokeh, which is exactly
// why nobody shoots portraits on them.
//
// Rather than fake it with a fudge factor, photo mode shoots a bigger piece of
// film, and the size was chosen by capture rather than by reverence for a film
// stock: on 8×10 (203 mm) the `vehicle` plate focused at 18.8 m gave a
// 0.6%-of-height background circle — correct, and too polite to be worth a
// feature — while 14×17 (356 mm) landed the same frame at 1.06%, melted at a
// glance. Those two were captured at f/1.4, a stop the lens kit has since taken
// away; the ratio between two formats is 1.75 at every stop, but a paragraph
// that argues a tuning at an unreachable aperture is arguing about nothing, so
// the spread that matters is re-measured at the stops that exist. On the same
// plate at 18.8 m the background circle is **0.53%** of frame height at f/2.8,
// the widest the 24-70 opens, and **0.13%** at f/11. That spread between the
// ends of the dial is the thing that was tuned.
//
// ── what a 16:1 zoom ring did to that ──────────────────────────────────────
//
// `format` was a CONSTANT 356 mm, and that was defensible for exactly as long
// as the camera only ever wore one lens. Photo mode now fits a 24-70 or a
// 200-400 (`src/photo/lens_models.js`), and at a fixed angle of view depth of
// field scales as 1/format: the film that gives a 24 mm its invented bokeh gives
// a 400 mm a band **14.8× shallower than a real full-frame lens of the same
// angle**. Measured, camper at 50.1 m, focus pulled onto it: a 14 cm band at
// f/4, 76 cm stopped all the way down to f/22, `wideOpen` (background already
// at the kernel ceiling) at every one of the nine stops, and the wheel that was
// clicked on soft in the plate. One focus detent moved the plane 3.01 m —
// twenty-one times the entire band. Nothing in the frame read as sharp; see
// `out/before/f1-01-tele400-f4.png` in the round-three capture set.
//
// The fix is to stop holding the film and start holding the LENS. `focal` is
// 440 mm — the lens the paragraph above always claimed to be simulating — and
// the format is whatever that lens has to cover to give the fitted angle of
// view:
//
//     format = 2 · focal · tan(vfov / 2)
//
// Physically that is one 440 mm lens and a zoom ring that CROPS. Measured off
// `lensInfo().format` at 16:9: 371.3 mm at 24 mm-equivalent (14×17), 254.6 at
// 35, 127.3 at 70 (4×5-ish), 44.6 at 200 and 22.3 at 400 — and 22.3 is within
// 10% of the 20.25 mm a 36 mm-wide frame is tall at this aspect, which is to
// say the long end simply becomes a real full-frame 400 mm f/4 and stops
// inventing anything. The invention is spent where the invention was needed.
//
// Three things fall out of it, and all three are the point:
//
//  · **The wide end does not move.** 440 mm is the focal the old constant
//    implied at a 44° vertical fov, so `2·440·tan(22°)` is 355.5 mm against the
//    old 356 — a 0.1% difference. Every measurement the previous round took on
//    the `vehicle` plate (fov 44) is preserved by construction, not by luck.
//  · **The band tracks the barrel.** Camper at 50.1 m, focus pulled onto it:
//    400 mm at f/4 reads 48.9–51.4 m (2.55 m, against 14 cm before) and at f/8
//    reads 47.7–52.8 m — a 5.1 m band, which holds a whole camper end to end.
//    The dial's detent (6%, 3.01 m at 50 m) is finally smaller than the thing
//    it is aiming at instead of 21× larger.
//  · **The ring gets its far end back.** `wideOpen` is true at f/4 on the tele
//    (kInf 2.2% of frame height against the 1.3% ceiling — it can still throw a
//    background away) and FALSE from f/8 down, so stopping down means something
//    again.
//
// The one honest cost: because c also shrinks with the crop, the band narrows
// as 1/focal rather than the 1/focal² a real full-frame lens would give. A real
// 70 mm at f/2.8 focused at 50 m holds 27 m to 351 m; this one holds 45 to 56.
// That is the large-format drama the wide end was tuned for, decaying smoothly
// into reality as the barrel gets longer, rather than two models with a seam.
//
// `blurCap` exists because the model is unbounded, and because the effect's
// kernel is not. The bokeh gather is 64 taps over a disc: at a 10 px radius the
// taps are ~1 px apart and the circle is solid, at 20 px they are ~2.2 px apart
// and the frame grows visible contour rings around every blob, plus white
// halos where a near-field edge meets the sky. Captured on `--view forest` and
// on a 2.6 m focus pull in `meadow`, a 0.022 ceiling produced exactly that —
// a posterised smear, not a photograph. 0.013 is under the point where the
// kernel stops resolving its own circle, and it is a ceiling on the RADIUS as a
// fraction of frame height, so it means the same thing at every resolution.
//
// Since 2026-08-26 it is a ceiling on the SIZE of the biggest circle and
// nothing else. It used to be the whole aperture model's output as well, and
// that is what made three to six of the nine stops byte-identical: see the
// next section.
//
// ── the ramp: why `focusRange` is not photo mode's model any more ───────────
//
// The stock circle-of-confusion shader is
//
//     magnitude = smoothstep(0, focusRange, |d − s|)
//
// — one symmetric ramp, in metres, either side of the plane. Two numbers
// (`bokehScale`, `focusRange`) are the entire vocabulary, and the first
// revision of this feature spent both on the textbook depth-of-field half
// width. Three things were wrong with that and all three were shipped:
//
//  1. **A hyperfocal singularity.** `far = sH/(H − s)` goes to infinity as the
//     focus approaches the hyperfocal distance, so `focusRange` measured 4.4 m
//     at a 20 m focus, 236 m at 150 m and 2881 m at 300 m. Past ~150 m the
//     dial silently switched the effect off: a shift+click on the ridge at
//     f/1.4 left grass 3 m from the lens at 92% of its unblurred acutance,
//     when a 440 mm f/1.4 focused at 237 m would obliterate it.
//  2. **Non-monotonic in the aperture.** At 80 m the same expression gave
//     f/4 → 272 m, f/5.6 → **1316 m**, f/8 → 184 m. One click toward
//     "everything sharp" spiked and the next reversed.
//  3. **A symmetric ramp cannot express a long focus at all.** Focused at
//     237 m the picture wants a melted 3 m foreground AND a sharp 300 m ridge.
//     |Δ| is 234 m and 63 m: no single `focusRange`, and no `bokehScale`
//     derived from either end, can give one of them blur and the other none.
//     There is no tuning of the stock ramp that fixes B1; the ramp itself is
//     the bug.
//
// So photo mode replaces the ramp with the optics it was always pretending to
// be (`_patchCoC`). For a subject at `d` with the plane at `s`,
//
//     c(d) = f² / (N·(s − f)) · |d − s| / d
//
// which is the same c the row above already computes for `d = ∞`, scaled by
// |d − s|/d. Written that way there is no singularity to clamp, the result is
// monotonic in N and in s by construction, a foreground melts when the focus
// goes long because |d − s|/d is 78 at 3 m against a 237 m plane, and the
// aperture is present in EVERY pixel of the frame rather than in two derived
// constants — which is what makes all nine stops distinguishable at every
// focus distance. `focusRange` is left to the tier row; the photo shader
// ignores it (`uCocPhysical`), and `lensInfo()` publishes the real near/far
// sharp limits for a readout to show.
//
// The one place the physical model still needs help is its own ceiling: c is
// unbounded and the 64-tap kernel is not. Rather than clip at `blurCap` — a
// hard corner in depth, and the far side of it is where every stop collapses
// onto every other one — the top is compressed: linear to `knee`, then
// asymptotic. It is C1 continuous at the knee, and because the asymptote is
// still strictly monotonic in the gain, the frame keeps a little separation
// between two adjacent wide stops in places that are past the cap.
//
// What this bought, measured old-model-against-new inside one page load, same
// pose, world paused and the animated film grain pinned (it is worth 6.9% of
// the frame per frame on its own): acutance is σ of a Laplacian over a fixed
// 44 px box, and the repeatability control was 0.137% of pixels.
//
//   · `vehicle` plate, shift+click the ridge at 236.6 m, f/1.4. Grass 3.17 m
//     from the lens: 16.24 with the effect off → 14.76 old (a 9% loss: inert)
//     → 0.75 new (95%: melted). The camper at 19.1 m, 218 m out of focus:
//     52.23 → 48.77 old → 1.78 new.
//   · Nine stops at a 3 m focus: f/1.4 through f/8 differed from their
//     neighbour by 0.000–0.012% of pixels — six byte-identical stops, under
//     the control. After: every neighbour pair differs by at least 0.94%, and
//     all nine (bokehScale, gain) pairs are distinct. Same at 6 m (three dead
//     before) and 10 m (two dead before).
//   · The subject at the plane of focus is not paid for: 19.1 m at f/2 scored
//     41.44 under the old model and 44.84 under the new one, against 52.23
//     with the effect off. The physical ramp is the SHARPER of the two.
//
// ── the cut-out, and what a gather can and cannot do about it ───────────────
//
// A canopy holds many depths within a few pixels — a probed 48 px window in
// `backlit` has 21 m elements interleaved with 48, 92, 100, 167 and 208 m ones
// — and the old model quantised them into two states. `bokehScale` is also the
// composite's blend factor (`min(coc·scale, 1)`), so at 5.86 anything more
// than about 1.4 m off the plane composited as 100% blurred while its
// neighbour at the plane composited as 100% sharp. That is the aliased cut-out a stranger
// names as amateur: the window measured acutance 52.7 against 47.2 with the
// effect OFF — foliage inside the blur that is SHARPER than the unblurred
// frame is the signature of a badly-keyed matte. Under c(d) the same window
// measures 36.1.
//
// Be careful about WHY, because the obvious sentence for it is wrong and was
// written here once: "the composite now grades". It does not, or rather it
// grades over a window nobody can see. The blend factor is still the library's
// `min(coc·scale, 1)` and `bokehScale` is still ~11.7 in photo mode, so the
// composite saturates at a coc of 1/11.7 — a ONE PIXEL circle. Everything
// larger than a pixel composites at 100% blurred, and that is correct: a
// feature bigger than a pixel is out of focus, and asking the composite to
// half-blend it would only re-introduce the softness the far-field experiment
// below was rejected for. What actually changed is upstream of the blend —
// c(d) is smooth and unbounded where the ramp was a saturating smoothstep, so
// many more of the canopy's interleaved depths land inside that sub-pixel
// window instead of being quantised to the two ends of it.
//
// It is mitigated, not solved, and the honest reason is structural: a GATHER
// cannot do partial occlusion. The obvious cheap fix was tried and rejected on
// capture — compositing the far field against the BLURRED CoC buffer (which is
// what the library already does for the near field, so the matte edge softens
// over a few pixels). It softens the matte and everything else with it: the
// in-focus conifer at the plane of focus fell from 60.1 to 32.4 acutance in the
// same run, and dark halos appeared along every silhouette. A real fix is
// scatter-as-you-gather, or weighting each tap by its own CoC and depth order,
// and that is a new pass, not a uniform.
const DOF_TIER = {
  focusDistance: 55, focusRange: 12, bokehScale: 0.60, resolutionScale: 0.5, fillMax: true,
  physical: false,   // the tier keeps the stock smoothstep ramp, byte for byte
};
const PHOTO_DOF = {
  // mm of simulated LENS. The film is derived from it and the fitted angle of
  // view (`_lensGeometry`) — 371 mm at 24 mm-equivalent, 22 mm at 400 — which
  // is the whole of the fix above. 440 is the focal the old constant 356 mm
  // format implied at a 44° vertical fov, chosen so the wide end lands where
  // the captures that tuned it landed.
  focal: 440,
  cocDiv: 900,        // acceptable circle of confusion = format / this
  blurCap: 0.013,     // max blur RADIUS as a fraction of frame height
  knee: 0.75,         // fraction of the cap where the compression starts
  // The closest thing the frame is assumed to contain, in metres. It sizes the
  // blur ceiling when the focus is long: the biggest circle in a photograph
  // focused at 237 m is not the background at infinity (0.7 px) but the grass
  // at the bottom of the frame (291 px), and a ceiling derived from the
  // background alone is exactly the bug B1 describes. 0.6 m is the near end of
  // photo_focus's own dial and closer than the free camera's clearance lets it
  // get to anything, so nothing in a real composition is nearer.
  nearRef: 0.6,
  // The stop photo mode opens at, and it has to be a stop that EXISTS: the rail
  // clamps the ring to the fitted lens (`hud_photo._lensStop`), so the ladder
  // runs f/2.8–f/22 on the 24-70 and f/4–f/22 on the 200-400. This was 2.0,
  // which neither lens can be set to — the wide lens quietly re-clamped it to
  // f/2.8 on the frame after entry and nothing else ever read it. f/2.8 is now
  // the wide lens's own maximum aperture: it separates the subject from the
  // valley on sight and still holds a whole vehicle, and the tele's own clamp
  // takes it to f/4 without a second write.
  fStop: 2.8,
  physical: true,     // use the optics ramp above, not the stock smoothstep
  // Half resolution — the library's default, kept after trying and rejecting
  // full res.
  //
  // WHAT THE FLAG RESIZES, read out of `node_modules/postprocessing/build/
  // index.js` rather than inferred, because this paragraph has now been wrong
  // twice. `DepthOfFieldEffect.setSize(width, height)` gives `renderTargetFar`,
  // `renderTargetCoC` and `renderTargetMasked` the FULL size, gives
  // `renderTarget` (the intermediate), `renderTargetNear` and
  // `renderTargetCoCBlurred` the scaled one, and hands all four bokeh materials
  // a full-resolution `texelSize`. That much the last revision got right.
  //
  // The trap is that the list of full-size TARGETS is not the list of full-size
  // WORK. `update()` runs
  //
  //     bokehFarBasePass.render(renderer, renderTargetMasked, renderTarget)
  //     bokehFarFillPass.render(renderer, renderTarget, renderTargetFar)
  //
  // and `renderTarget` is the HALF-RES one. So the expensive 64-tap far gather
  // runs at half resolution and the fill pass upsamples it; `renderTargetFar`
  // being full size says only where the result lands. The near chain is half
  // res end to end (its fill writes `renderTargetNear`, also scaled). The two
  // sentences this replaces — "the far field is drawn at full resolution
  // regardless" and "what the setting costs is the NEAR half" — are both false,
  // and they were derived from the target list instead of from `update()`.
  //
  // Measured rather than inferred, A/B at 0.5 against 1.0 inside one page load,
  // world stopped, film grain pinned, the `vehicle` plate focused at 19.1 m at
  // f/2.8: **4.38%** of pixels change, against a 0.18% repeatability control,
  // and the acutance moves on BOTH sides of the plane of focus — a 236 m box by
  // −3.28 and a 15 m one by +3.67. Not a near-field-only setting.
  //
  // WHAT IT COSTS, and this is the second correction in two rounds. The line
  // here used to read "full res − half res: +0.65 ms ± 0.07" beside "the whole
  // effect ≈ +1.70". Re-measured by two people on the same harness, the first
  // number is the WHOLE EFFECT and the second is unsupported by any run.
  // Paired base/arm/base inside ONE page load, IN photo mode (the world is
  // stopped there, so unlike ablate's `still` anchor the pose cannot fail to
  // settle), 9 arms, 24 composed renders and a `gl.finish()` per sample, at
  // 1600×900 focused at 19.1 m, f/2.8:
  //
  //     whole photo DoF, on − off:   +0.68 ms ± 0.19   (9/9 arms positive)
  //     resolution.scale 1.0 − 0.5:  +0.24 ms ± 0.09   (9/9 arms positive)
  //     control, base − base:        +0.11 ms ± 0.17
  //
  // An independent run of the same script a day earlier: +0.657 ± 0.097 and
  // +0.162 ± 0.141, control −0.081 ± 0.68. The whole effect reproduces tightly;
  // the resolution flip is small — a third of the effect's own cost, and in the
  // earlier run barely outside the control's spread — but it is 9/9 positive in
  // both runs, so it is real and it is cheap.
  //
  // Half res is therefore kept on the evidence rather than on the old story:
  // the flip buys about a fifth of a millisecond here and changes 4% of the
  // pixels by an amount that does not read as sharper at a glance. Anyone who
  // wants the finer gather back can have it for that price, on both fields.
  //
  // Two caveats, since a number without them is the bug being fixed here: this
  // is not `ablate` (ablate has no knob for the DoF buffer's own resolution —
  // `fx.dof` is the whole effect), and 1600×900 at dpr 1 is not what a Retina
  // player's photo mode renders. Both arms shared everything else, which is
  // what makes the DELTA worth quoting and the absolutes not.
  resolutionScale: 0.5,
  // ── the fill pass, and why it is turned OFF for a photograph ─────────────
  //
  // `DepthOfFieldEffect` blurs in two steps: a 64-tap disc gather, then a
  // 16-tap pass that takes the per-channel MAX of its neighbourhood to fill the
  // gaps the sparse kernel leaves and to bloom highlights outward.
  //
  // A per-channel max is not a colour operation. Where a silhouette meets the
  // sky — every conifer edge in this game — it takes the red from the foliage
  // and the blue from the sky and writes both, so the whole frame grew hot
  // orange and magenta rims. Measured on `--view vehicle` at bokehScale 6:
  // with the max fill every tree/sky boundary, the far shoreline and the lake
  // edge carried a saturated fringe; with the fill switched to a second 64-tap
  // gather (`PASS 1`) the fringes vanished and the only red left in the frame
  // was the red maples that were actually there.
  //
  // The cost is that two chained discs convolve toward a gaussian, so a point
  // highlight resolves as a soft ball rather than a hard-edged disc. Bloom runs
  // AFTER depth of field (see the pass order below), so a blown out-of-focus
  // highlight still spreads and glows — it just does not bring a colour fringe
  // with it.
  fillMax: false,
};

export class PostFX {
  constructor(engine, quality = 'ultra') {
    this.engine = engine;
    this.tier = QUALITY_PRESETS[quality] ? quality : 'high';
    this.preset = QUALITY_PRESETS[this.tier];
    const { renderer, scene, camera } = engine;

    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    });

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.ao = null;
    this.dof = null;
    this._dofEffect = null;
    this.mainPass = null;

    this.bloom = new BloomEffect({
      intensity: GLARE_INTENS_HI,
      luminanceThreshold: GLARE_THRESH_HI,
      luminanceSmoothing: GLARE_SMOOTH_HI,
      mipmapBlur: true,
      radius: GLARE_RADIUS_HI,
      kernelSize: KernelSize.HUGE,
      blendFunction: BlendFunction.ADD,
    });
    this.veil = new VeilEffect();

    // Every time-of-day look number in one writable record, so a decision can
    // be swept in ONE browser boot instead of one boot per candidate — the
    // same pattern, and the same reason, as Lighting.ambientScale and
    // Lighting.fogScale. The module constants above remain the authored
    // shipping values; this is a copy of them that tools/postsweep.mjs writes.
    this.look = {
      threshHi: GLARE_THRESH_HI, threshLo: GLARE_THRESH_LO,
      smoothHi: GLARE_SMOOTH_HI, smoothLo: GLARE_SMOOTH_LO,
      intensHi: GLARE_INTENS_HI, intensLo: GLARE_INTENS_LO,
      radiusHi: GLARE_RADIUS_HI, radiusLo: GLARE_RADIUS_LO,
      veilHi:   VEIL_GAIN_HI,    veilLo:   VEIL_GAIN_LO,
      threshNight: GLARE_THRESH_NIGHT,
      intensNight: GLARE_INTENS_NIGHT,
      veilNight:   VEIL_GAIN_NIGHT,
      // Multipliers on the low half of the exposure arc and on the two
      // twilight grade terms. 1.0 is the authored curve.
      exposureLow: 1.0,
      twiContrast: 0.30,
      twiVibrance: 0.34,
      nightLiftCut: 0.85,
      nightContrast: 1.05,
      nightToeCut: 0.60,
      // How much of PBR Neutral's black offset survives at full night. See the
      // note in TONEMAP_FRAG — at 1.0 the curve eats two thirds of the night
      // frame and inflates its blue-to-red ratio fourfold.
      nightOffset: 0.15,
      rodAmount: 0.50,
      // The scotopic axis, luminance-normalised. Written every frame so a
      // sweep can move it; see the note in the grade.
      //
      // Swept against the plates' own night chromaMean (0.157-0.172) on camp-h0,
      // measuring whole-frame chroma at rodAmount 0.70 / 0.90:
      //   1 : 0.95 : 2.10   0.094 / -
      //   1 : 1.55 : 4.75   0.124 / 0.138
      //   1 : 2.88 : 11.7   0.153 / 0.175
      // and then re-swept on amount alone once the contrast pivot came down,
      // which raised every dark pixel and with it the chroma the term has to
      // work on: 0.45 -> 0.162, 0.60 -> 0.188 against the three night plates'
      // own chromaMean of 0.157 / 0.164 / 0.172. Held at 0.50, the middle of
      // that band — past it the autumn meadow stops being an autumn meadow and
      // starts reading as frost, which is a real colour for the SNOW the plates
      // happen to be shot on and not for this game's ground.
      // and the value distribution is bit-stable across all of them — p05/p95
      // move by 0.004 — so this is a pure hue-and-chroma operator, which is
      // what a scotopic shift should measure like and what a saturation
      // multiply would not. The last row is close to the plates' own moonlit
      // ground, srgb(14,47,88) at linear 1 : 6.3 : 24.
      rodTint: [0.32, 0.92, 3.75],
      // Where `lowSun` reaches 0, in sin(elev). 0.34 is ~20 deg.
      lowSunEnd: 0.34,
    };

    // Scratch for the hearth transform. One vector, reused — see _driveHearth.
    this._hv = new THREE.Vector3();

    // Depth of field. Built lazily by _syncDOF() so the constructor, a later
    // tier change and photo mode all go through one code path; a tier that has
    // no DOF never builds it. The parameters live in DOF_TIER / PHOTO_DOF above
    // — see those, and `setPhotoDOF`, for what the two configurations are for.
    this._tierDOF = false;
    this._photoDOF = false;
    this._dofSaved = null;
    this._depthProbe = null;
    this._focusHeld = false;
    this._fStop = PHOTO_DOF.fStop;

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
    // The *base* the elevation ramp multiplies. setExposure() writes this, not
    // the uniform, so photo mode and the ramp compose instead of fighting.
    this._baseExposure = this.tone.exposure;
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
    // Between the scene (plus AO) and everything that blurs. It has to be its
    // own pass rather than the first effect in mainPass: bloom's mipmap blur
    // reads the pass's input buffer directly in update(), not the chained
    // inputColor, so an inline effect would sanitise the value bloom's own
    // output is composited over and none of the values bloom actually samples.
    this.sanity = new ShaderPass(new THREE.ShaderMaterial({
      name: 'HdrSanityMaterial',
      uniforms: { inputBuffer: { value: null } },
      vertexShader: SANITY_VERT,
      fragmentShader: SANITY_FRAG,
      depthWrite: false,
      depthTest: false,
    }), 'inputBuffer');
    // OFF by default, priced at 1.8 ms of a 3.78 MP frame (9% — it is a
    // full-screen HalfFloat read-modify-write, so it grew with the pixel count
    // like everything else). The NaN it guarded against was fixed at its
    // source — `pow(max(vT, 0.0), ...)` in grass — and MIN_BLOOM_MIP's note
    // records the black-frame sampler measuring zero with six mip levels after
    // that fix. The pass is kept, disabled, because it is the diagnostic to
    // switch back on the day a black square returns: `?sanity=1`, or
    // `postfx.sanity.enabled = true` from the console, no rebuild needed.
    // tools/perf.mjs counts black frames during motion on every run, so a
    // regression here cannot land silently.
    this.sanity.enabled =
      new URLSearchParams(location.search).get('sanity') === '1';
    this.composer.addPass(this.sanity);

    // Builds the SSAO pass and the merged main pass for this tier.
    this._applyTier(this.preset, this.tier);

    // `?photodof=1` boots with photo mode's lens already fitted, wide open.
    //
    // It exists for one reason: tools/ablate.mjs has no setup hook, and the
    // only trustworthy way to price this — paired baselines inside ONE page
    // load, per AGENTS.md — is for the page to come up with the effect already
    // in the merged pass so `--only fx.dof` has something to leave out. It is a
    // test instrument exactly like `?sanity=1` above, and no player path sets
    // it. The sizes are asserted below, after the upscale pass exists.
    if (new URLSearchParams(location.search).get('photodof') === '1') {
      this.setPhotoDOF(true);
      this.holdFocus(true);
      this.setFocusManual(24);
    }

    // ── internal-resolution rendering ───────────────────────────────────────
    // The whole chain above renders at `internalScale` of the presented
    // buffer; this pass reconstructs to the canvas with Catmull-Rom + CAS.
    // See UpscalePass.js for the argument. Added LAST so the composer marks it
    // renderToScreen; _setUpscale keeps the flags straight when it is off.
    this.internalScale = 1;
    this.upscale = createUpscalePass();
    this.composer.addPass(this.upscale);
    this._setUpscale(false);

    engine.onResize(() => this._applySizes());
  }

  /**
   * Render the scene and the post chain at `s` times the presented resolution.
   *
   * The canvas never changes size here — only offscreen targets do. This is
   * much cheaper than the former 450–2500 ms drawing-buffer reallocation, but
   * it is not free: reallocating the whole composer graph still measured near
   * 300 ms on ANGLE/Metal in a real drive. Engine therefore changes this only
   * under genuine strain and caps recovery at the boot target.
   *
   * At s = 1 the upscale pass is switched off and the chain presents exactly
   * as it always did.
   */
  setInternalScale(s) {
    const next = Math.min(1, Math.max(0.4, s || 1));
    if (Math.abs(next - this.internalScale) < 1e-3) return;
    this.internalScale = next;
    this._applySizes();
  }

  /** Enable or disable the present pass, keeping renderToScreen coherent. */
  _setUpscale(on) {
    this.upscale.enabled = on;
    this.upscale.renderToScreen = on;
    if (this.mainPass) this.mainPass.renderToScreen = !on;
  }

  /**
   * Size every offscreen buffer to the internal resolution and the present
   * pass to the canvas. Runs on window resize, on tier change and on every
   * internal-scale change; it is the single place buffer sizes are decided.
   *
   * The composer's own setSize is bypassed on purpose: it sizes every pass to
   * the drawing buffer, and the drawing buffer is exactly the one size the
   * internal chain must not be locked to.
   */
  _applySizes() {
    const r = this.engine.renderer;
    const db = r.getDrawingBufferSize(this._dbSize ??= new THREE.Vector2());
    const s = this.internalScale;
    const iw = Math.max(1, Math.round(db.x * s));
    const ih = Math.max(1, Math.round(db.y * s));
    const c = this.composer;
    c.inputBuffer.setSize(iw, ih);
    c.outputBuffer.setSize(iw, ih);
    if (c.depthRenderTarget) c.depthRenderTarget.setSize(iw, ih);
    for (const p of c.passes) {
      if (p === this.upscale) p.setSize(db.x, db.y);
      else p.setSize(iw, ih);
    }
    this.upscale.setSourceSize(iw, ih);
    this._setUpscale(s < 0.999);
    this._capBloomMips();
    // bokehScale is a pixel radius, so the circle has to be re-derived from the
    // new buffer height or the aperture would mean a different thing at every
    // window size. Photo mode's entry resize is exactly this path.
    this._applyAperture();
  }

  /**
   * Change the post chain's quality tier. Called by main when Engine's
   * `setQuality()` fires.
   *
   * Before this existed the settings panel could move a struggling machine to
   * `medium` or `low` and the post chain would not notice: SSAO and depth of
   * field were decided once, in the constructor, so the only thing a tier drop
   * actually changed here was the pixel ratio. That left a player with no
   * working escape hatch, which matters more now than any single cut — the
   * adaptive scaler was pinned at its floor on the reporting player's machine,
   * so the tier was the *only* lever left. The exact current floor belongs to
   * WorldConfig.ADAPTIVE_RESOLUTION rather than this historical account.
   */
  onQuality(preset, name) {
    if (!preset) return;
    this.preset = preset;
    this.tier = QUALITY_PRESETS[name] ? name : this.tier;
    this._applyTier(preset, this.tier);
  }

  /**
   * Build the chain for a tier. The constructor calls this too, so there is
   * exactly one description of what a tier means and construction cannot drift
   * away from a runtime change.
   */
  _applyTier(preset, name) {
    const tier = POST_TIERS[name] ?? POST_TIERS.high;
    this._minBloomMip = tier.bloomMip;
    this._setSSAO(!!preset.ssao, tier);
    this._setDOF(!!preset.dof);
    // Adding a pass sizes it to the drawing buffer (the composer's default),
    // so the internal-resolution sizing has to be reasserted afterwards. The
    // constructor path lands here before the upscale pass exists; it calls
    // _applySizes itself once the pass is in place.
    if (this.upscale) this._applySizes();
    else this._capBloomMips();
  }

  /** Add, retune or remove the SSAO pass. */
  _setSSAO(on, tier) {
    if (!on) {
      if (this.ao) {
        this.composer.removePass(this.ao);
        this.ao.dispose?.();
        this.ao = null;
      }
      return;
    }
    if (!this.ao) {
      const { scene, camera, width, height } = this.engine;
      this.ao = new N8AOPostPass(scene, camera, width, height);
      const c = this.ao.configuration;
      // A grass field is hundreds of thousands of mutually-occluding sheets, so
      // a metres-wide AO radius finds a contact between every pair of adjacent
      // blades and fills the canopy interior with salt-and-pepper — the exact
      // high-frequency noise the brief rules out, and the grass author's logged
      // request. Pulling the radius in to roughly a blade-height keeps the cue
      // that actually reads (a rock or a trunk meeting the ground) and drops
      // the one that only adds noise.
      c.aoRadius = 1.1;
      c.distanceFalloff = 1.0;
      // Weaker and less blue than it was. Ambient occlusion is a contact cue,
      // not a grade: at 2.6 with a near-navy tint it was stamping a cold violet
      // into every crease of a gold meadow, which is the exact failure the
      // brief calls out — the cool note belongs to distant rock and haze, not
      // to shaded ground. Blue/violet/magenta together are about 1% of the
      // reference's chromatic pixels.
      c.intensity = 1.15;
      c.color = new THREE.Color(0x40303f);
      c.halfRes = true;
      c.denoiseRadius = 12;
      // Directly after the scene render and before the guard pass, so the
      // guard still sits between the scene and everything that blurs.
      this.composer.addPass(this.ao, 1);
      this.ao.setSize(this.engine.width, this.engine.height);
    }
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
    const c = this.ao.configuration;
    if (c.aoSamples !== tier.aoSamples) c.aoSamples = tier.aoSamples;
    if (c.denoiseSamples !== tier.denoiseSamples) c.denoiseSamples = tier.denoiseSamples;
    if (c.denoiseIterations !== tier.denoiseIterations) c.denoiseIterations = tier.denoiseIterations;
  }

  /**
   * The TIER's opinion on depth of field. Photo mode has its own — see
   * `setPhotoDOF` — and the two are OR'd together by `_syncDOF`, so a tier
   * change while a photograph is being composed cannot pull the lens out from
   * under the player.
   */
  _setDOF(on) {
    this._tierDOF = !!on;
    if (this._dofEffect && !this._photoDOF) this._applyDOFConfig(DOF_TIER);
    this._syncDOF();
  }

  /**
   * Photo mode's depth of field: on, wide open, and restored exactly on exit.
   *
   * Turning it on rebuilds the merged EffectPass, which recompiles a shader —
   * a real hitch, and this is the one place in the game where it is affordable.
   * Photo mode's entry already spends 450–2500 ms reallocating the drawing
   * buffer for native resolution (see the note in ui/hud_photo.js), it already
   * cuts the camera, takes the HUD away and plays a door sound. Nothing here
   * touches the driving frame: every shipping tier has `dof: false`, so the
   * effect does not exist until photo mode asks for it and stops existing when
   * it leaves.
   *
   * `off` restores the tier's configuration byte for byte, including the focus
   * distance CameraRig had written and whether `setFocus` was being obeyed. The
   * exposure bug this file's neighbour records — a mode that read back a value
   * the ramp had already multiplied and handed it back as the base, so the
   * world got darker on every visit — is the failure mode being avoided.
   */
  setPhotoDOF(on) {
    const want = !!on;
    if (want === this._photoDOF) return;
    if (want) {
      const u0 = this._dofEffect?.cocMaterial.uniforms;
      this._dofSaved = {
        focusDistance: u0?.focusDistance.value ?? DOF_TIER.focusDistance,
        held: this._focusHeld,
        // `uCocGain` and `uCocKnee` are photo mode's alone — the tier's branch
        // is `mix(smoothstep(...), physical, uCocPhysical)` with uCocPhysical 0,
        // so a leftover value is discarded and nothing looks wrong. It is still
        // wrong: "restores exactly" was the property this mode was reviewed on
        // twice, and one uniform short of true is not true. Cheap to keep.
        cocGain: u0?.uCocGain?.value ?? 1,
        cocKnee: u0?.uCocKnee?.value ?? 1,
      };
      this._photoDOF = true;
      this._syncDOF();
      this._applyDOFConfig(PHOTO_DOF);
      this.setAperture(this._fStop);
    } else {
      this._photoDOF = false;
      this._focusHeld = this._dofSaved?.held ?? false;
      if (this._dofEffect) {
        this._applyDOFConfig(DOF_TIER);
        const u1 = this._dofEffect.cocMaterial.uniforms;
        u1.focusDistance.value = this._dofSaved?.focusDistance ?? DOF_TIER.focusDistance;
        if (u1.uCocGain) u1.uCocGain.value = this._dofSaved?.cocGain ?? 1;
        if (u1.uCocKnee) u1.uCocKnee.value = this._dofSaved?.cocKnee ?? 1;
      }
      this._dofSaved = null;
      this._syncDOF();
    }
  }

  /** Build the effect if anything wants it, drop it if nothing does. */
  _syncDOF() {
    const want = (this._tierDOF || this._photoDOF)
      ? (this._dofEffect ??= this._buildDOF())
      : null;
    if (this.mainPass && want === this.dof) return;
    this.dof = want;
    this._rebuildMainPass();
  }

  _buildDOF() {
    const dof = new DepthOfFieldEffect(this.engine.camera, {
      // METRES. This was `55 / camera.far` — the normalised convention
      // `postprocessing` used before 6.30 — and the installed version is 6.39,
      // where `focusDistance` and `focusRange` are world units and the CoC
      // shader compares them against `length(viewPosition)` directly. The old
      // form put the focal plane 3 cm in front of the lens. Nothing caught it
      // because no shipping tier has ever built this effect.
      focusDistance: DOF_TIER.focusDistance,
      focusRange: DOF_TIER.focusRange,
      bokehScale: DOF_TIER.bokehScale,
      resolutionScale: DOF_TIER.resolutionScale,
    });
    this._patchCoC(dof);
    this._applyDOFConfig(DOF_TIER, dof);
    return dof;
  }

  /**
   * Teach the circle-of-confusion material the lens equation.
   *
   * The stock ramp is a `smoothstep(0, focusRange, |d − s|)` and the section
   * above the two configuration rows is the full argument for why photo mode
   * cannot be built on it. This adds the optical CoC beside it and picks
   * between them with a uniform, rather than replacing it, for two reasons:
   * `DOF_TIER` is the configuration `setPhotoDOF(false)` restores and it has to
   * come back byte for byte, and one shader with a 0/1 mix is one program
   * either way — a second material would be a second compile at the exact
   * moment (mode entry) the frame budget is already being spent on one.
   *
   * The edit is a regex against the library's own minified source rather than
   * a copy of it: a copied shader silently stops tracking `postprocessing`'s
   * depth-packing and log-depth branches at the next bump. If the pattern ever
   * stops matching, this warns and leaves the stock material alone — photo
   * mode then behaves like the tier does, which is wrong but not broken.
   */
  _patchCoC(dof) {
    const m = dof.cocMaterial;
    const RAMP = /smoothstep\s*\(\s*0\.0\s*,\s*focusRange\s*,\s*abs\s*\(\s*signedDistance\s*\)\s*\)/;
    if (!RAMP.test(m.fragmentShader) || !/void\s+main\s*\(/.test(m.fragmentShader)) {
      console.warn('[PostFX] CoC shader did not match; photo depth of field falls back to the tier ramp.');
      return;
    }
    m.uniforms.uCocGain = new THREE.Uniform(1);
    m.uniforms.uCocKnee = new THREE.Uniform(PHOTO_DOF.knee);
    m.uniforms.uCocPhysical = new THREE.Uniform(0);
    const helper = /* glsl */`
      uniform float uCocGain;
      uniform float uCocKnee;
      uniform float uCocPhysical;
      // d is the distance along the RAY (the shader's own "distance"), sd is
      // d - focusDistance. uCocGain is the circle a background at infinity
      // would project, divided by the ceiling bokehScale stands for, so the
      // result is already normalised to the [0,1] the composite and the mask
      // expect. (No backticks in here: this is inside a template literal.)
      float paCoC(const in float d, const in float sd) {
        float x = uCocGain * abs(sd) / max(d, 1e-3);
        float k = uCocKnee;
        // Linear to the knee, then asymptotic to 1. A hard min() here is a
        // corner in depth AND the place every wide stop collapses onto every
        // other one.
        float physical = (x < k) ? x : 1.0 - (1.0 - k) * exp(-(x - k) / max(1.0 - k, 1e-3));
        return mix(smoothstep(0.0, focusRange, abs(sd)), physical, uCocPhysical);
      }
      void main(`;
    m.fragmentShader = m.fragmentShader
      .replace(/void\s+main\s*\(/, helper)
      .replace(RAMP, 'paCoC(distance, signedDistance)');
    m.needsUpdate = true;
  }

  /** Push one of the two configurations above into the live effect. */
  _applyDOFConfig(cfg, dof = this._dofEffect) {
    if (!dof) return;
    dof.cocMaterial.uniforms.focusRange.value = cfg.focusRange ?? dof.cocMaterial.uniforms.focusRange.value;
    if (dof.cocMaterial.uniforms.uCocPhysical) {
      dof.cocMaterial.uniforms.uCocPhysical.value = cfg.physical ? 1 : 0;
    }
    dof.bokehScale = cfg.bokehScale ?? dof.bokehScale;
    if (dof.resolution.scale !== cfg.resolutionScale) dof.resolution.scale = cfg.resolutionScale;
    // The fill pass is `PASS 2` (per-channel max) as built; `PASS 1` is a
    // second disc gather. See PHOTO_DOF.fillMax for the measurement.
    const pass = cfg.fillMax ? '2' : '1';
    for (const p of [dof.bokehNearFillPass, dof.bokehFarFillPass]) {
      const m = p.fullscreenMaterial;
      if (m.defines.PASS !== pass) { m.defines.PASS = pass; m.needsUpdate = true; }
    }
  }

  /**
   * Rebuild the single merged EffectPass.
   *
   * `postprocessing` compiles every effect handed to one EffectPass into one
   * fragment shader — verified, not assumed: with all six effects the composer
   * holds exactly four passes (scene, SSAO, guard, merged), so nothing here is
   * forcing a pass of its own.
   *
   * The old pass is stripped of its effects *before* it is disposed:
   * `EffectPass.dispose()` disposes the effects it holds, and those objects are
   * shared with this class, so disposing the pass directly would take the bloom
   * and the grade down with it.
   */
  _rebuildMainPass() {
    const effects = [];
    if (this.dof) effects.push(this.dof);
    // Veil directly after bloom and before the tone curve: it is light arriving
    // at the sensor, so the curve has to compress it. Added after the curve it
    // would only raise the whole frame's black level.
    effects.push(this.bloom, this.veil, this.tone, this.vignette, this.grade, this.smaa);
    if (this.mainPass) {
      this.composer.removePass(this.mainPass);
      this.mainPass.setEffects([]);
      this.mainPass.dispose();
    }
    this.mainPass = new EffectPass(this.engine.camera, ...effects);
    // The grade samples the depth buffer for the hearth mask but must not
    // declare EffectAttribute.DEPTH to get it — that attribute is also the
    // pass's sort key, and declaring it moves the grade to the front of the
    // chain (see GradeEffect). EffectPass derives this flag from its effects'
    // attributes, so with none of them asking, say so directly: the composer
    // reads it in addPass and binds the shared depth texture.
    //
    // It matters most on the tiers that have neither depth of field nor SSAO,
    // which are the only ones where nothing else would have asked. Without it
    // `depthBuffer` is an unbound sampler there, every pixel reads depth 0, and
    // the mask would sit at the near plane covering the whole frame.
    this.mainPass.needsDepthTexture = true;
    // Before the present pass, which must stay last. During construction the
    // present pass does not exist yet and appending is correct.
    const at = this.upscale ? this.composer.passes.indexOf(this.upscale) : undefined;
    this.composer.addPass(this.mainPass, at >= 0 ? at : undefined);
    if (this.upscale) this._applySizes();
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
    // Per-tier floor (POST_TIERS), falling back to the ultra/high value.
    const floor = this._minBloomMip || MIN_BLOOM_MIP;
    const levels = Math.max(1, Math.min(8, Math.floor(Math.log2(short / floor))));
    if (pass.levels !== levels) pass.levels = levels;
  }

  render(dt) {
    this._driveTimeOfDay();
    this._driveHearth();
    this.composer.render(dt);
  }

  /**
   * Put the camp fire into the grade's frame of reference.
   *
   * The mask is a world-space distance and the grade only has a depth buffer,
   * so one of the two has to move. Moving the FIRE is the cheap direction:
   * transforming one point by the view matrix here costs nothing, where giving
   * the shader an inverse-view matrix would make every pixel reconstruct a
   * world position to compare against a point that never moves within a frame.
   *
   * `uTanHalf` goes with it, and it is read off the camera every frame rather
   * than cached on resize: the game changes its own field of view — the chase
   * camera widens with speed and the scope view narrows hard — so a value
   * cached at construction would put the mask in the wrong place for exactly
   * the shots the player is looking closely at.
   */
  _driveHearth() {
    const u = this.grade.uniforms;
    const amt = HEARTH.strength;
    u.get('uHearthAmt').value = amt;
    if (amt <= 0.001) return;

    // This runs BEFORE composer.render(), so `matrixWorldInverse` still holds
    // last frame's camera — a one-frame lag that shows up as the warm pool
    // sliding on the ground while the camera swings. Refresh it here; the
    // renderer will redo the same work a moment later and one 4x4 invert per
    // frame is not a cost worth reasoning about.
    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    this._hv.set(HEARTH.x, HEARTH.y, HEARTH.z).applyMatrix4(cam.matrixWorldInverse);
    u.get('uHearthPos').value.copy(this._hv);
    // Inner radius is a fixed fraction of the outer rather than a second
    // published number: the fire has one size, and two independent radii is an
    // invitation to author a hard edge by setting them close together.
    u.get('uHearthRange').value.set(HEARTH.radius * 0.38, HEARTH.radius);

    const tanY = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    u.get('uTanHalf').value.set(tanY * cam.aspect, tanY);
  }

  /**
   * Everything in this chain that is a function of where the sun is.
   *
   * All of it is a smooth function of `SKY_STATE.sunElev`, which is itself
   * smooth, so nothing here can flicker or pop between frames — the same
   * argument the original elevation ramp was written on. Nothing here
   * reallocates: `levels` is fixed by resolution and tier, and only uniforms
   * are written.
   */
  _driveTimeOfDay() {
    const e = SKY_STATE.sunElev;
    const L = this.look;

    // ── exposure ────────────────────────────────────────────────────────────
    let t = (e - EXPOSURE_ELEV_START) / (EXPOSURE_ELEV_END - EXPOSURE_ELEV_START);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    t = t * t * (3 - 2 * t);
    const high = 1 + (EXPOSURE_ELEV_MIN - 1) * t;
    // The low half, scaled so a sweep can move twilight and night together.
    const low = 1 + (exposureLow(e) - 1) * L.exposureLow;
    this.tone.exposure = this._baseExposure * high * low;

    // ── how low is the sun ──────────────────────────────────────────────────
    // 1 at and below the horizon, 0 by ~20 deg up.
    let s = e / L.lowSunEnd;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    const lowSun = 1 - s * s * (3 - 2 * s);

    // ── night ───────────────────────────────────────────────────────────────
    // Its own ramp, later than `dayFactor` and later than `lowSun`: the frame
    // is still a bright twilight when the sun touches the horizon, and a rod
    // response applied there would put a blue cast over the sunset wedge.
    let n = (-0.045 - e) / 0.115;
    n = n < 0 ? 0 : n > 1 ? 1 : n;
    const night = n * n * (3 - 2 * n);

    // ── …AND THE SECOND ONE, BECAUSE THE FIVE TERMS ABOVE IT ARE NOT ONE ────
    //
    // `night` above used to carry all five of the grade's night corrections,
    // and the comment defending its late start defends exactly ONE of them:
    // the rod response, which must not touch a sunset wedge. The lift cut, the
    // toe cut and the tone curve's black-offset cut rest on a completely
    // different argument — the one written out at EXPOSURE_LOW and again at
    // the contrast pivot — that a term sized for a display-referred daylight
    // frame becomes the majority of the signal in a frame two decades lower.
    // That stops being an argument about rods and starts being arithmetic, and
    // the arithmetic changes at SUNSET, not twenty-five minutes after it.
    //
    // What the single ramp cost, measured with tools/_scratch/fireworth.mjs,
    // which draws ONE frozen instant twice — fire lit and fire dark — and
    // differences them, so the number is "how much of this picture is the
    // fire" and does not care where the camp lottery put the tent. Mean sRGB
    // delta over the ground, and the percentage of ground pixels the fire
    // moves by more than eight levels. Both ramps, same instant, same pinned
    // fire, so the two columns differ in these three uniforms and nothing else:
    //
    //   hour    elev    uLift          mean            %>8
    //           .       old -> new     old -> new      old -> new
    //   17.1  +0.247   .0200  .0200    9.02   9.02    47.2  47.2   identical
    //   18.3  +0.045   .0200  .0195   10.24  10.38    45.0  45.5
    //   18.9   0.000   .0200  .0140    7.99   9.80    40.0  43.9
    //   19.0  -0.014   .0200  .0117    7.95  10.71    40.1  46.6
    //   19.4  -0.054   .0197  .0055    6.76  12.06    31.5  46.1   <- the dip
    //   20.0  -0.105   .0110  .0030    9.26  14.80    42.6  51.8
    //   20.6  -0.149   .0034  .0030   17.77  18.30    57.6  59.0
    //   21.0  -0.177   .0030  .0030   18.84  18.84    58.6  58.6   identical
    //   23.0  -0.279   .0030  .0030   20.68  20.68    60.2  60.2   identical
    //
    // The old column is the shape the player reported: a fire worth 6.8 at
    // 19:24 against 18.8 at 21:00, and worth LESS just after sunset than it
    // was in broad daylight — while emitting MORE (2.42 against 1.95 in a live
    // run; the inverted ramp at LIGHT_DAY in camp_fire.js is deliberate and is
    // not what was wrong). Between 18.9 and ~19.3 the sun has stopped reaching
    // up-facing ground and the moon key has not started — `sunGone` in
    // Lighting.js gates on this same -0.045, correctly, because moonlight at
    // civil twilight is three decades under the sky — so the world is already
    // lit like night while the grade is still corrected like day.
    //
    // Note what this table does NOT say: the frozen instant pins the fire's
    // own emission at one value for every row, which is the right control for
    // isolating the grade and is not what a player sees, since the fire also
    // ramps 4.0 -> 2.1 across the same hours. Read the columns against each
    // other, not down the page.
    //
    // Which term, at h19, one at a time (from the earlier unfrozen sweep, so
    // these carry an animation noise floor and are ordering only — the ranking
    // reproduced on the frozen pairs above, the magnitudes did not):
    //
    //   uLift 0.020 -> 0.003     <- the big one, by a distance
    //   exposure x1.166          <- see EXPOSURE_LOW; deliberately NOT taken
    //   offsetScale -> 0.15
    //   uToe -> 0.0088
    //   uContrast -> 1.05        <- WORSE than shipping
    //
    // The lift dominates for the reason its own note gives from the other end:
    // it is a spatially constant pedestal, and a constant has no gradient. A
    // camp fire's contribution three to five metres out is the same order of
    // magnitude as 0.020, so the lift does not dim the fire's pool — it fills
    // the frame in underneath it until there is no pool left to see.
    //
    // uContrast is deliberately NOT on this ramp, and the table above is why:
    // it is a multiplicative term, so it scales the fire's own delta along
    // with everything else, and moving it early made the fire LESS visible
    // while also being the term the sunset look is calibrated on. Splitting a
    // ramp is cheap; re-deriving the twilight contrast against the plates is
    // not, and nothing here needs it.
    //
    // ── where this ramp is anchored, and why not at the horizon ─────────────
    //
    // The obvious anchor is sunset — e = 0 — and it does not work. Measured:
    // an `-e / 0.16` smoothstep leaves uLift at 0.0196 at h19, because h19 is
    // six minutes past sunset and sits at e = -0.014, which is inside any
    // smoothstep's flat toe — so the term barely moved and the dip survived.
    // A ramp anchored at the horizon cannot move fast enough to matter in the
    // twenty-five minutes that need it.
    //
    // It should not be anchored there anyway. The key stops *reaching the
    // ground* well before it geometrically sets, because N.L on flat ground is
    // sin(elev): at e = 0.03 the meadow is already collecting three percent of
    // the key, and the frame's radiance has fallen the two decades this whole
    // family of corrections is sized against. So the band runs from a grazing
    // sun to civil twilight — 0.060 down to -0.090, the elevation where
    // EXPOSURE_LOW takes its own first real step.
    //
    // The shipping daylight sheet is untouched by construction: the canonical
    // golden-hour framings sit at sin(elev) 0.12 (h7.4) to 0.34 (h17.9), and
    // even h18.3 — the last key before sunset, and past every judged view — is
    // at 0.045, where this reads 0.028 and uLift lands on 0.0195 against
    // 0.0200. Below -0.16 `dark` and `night` are both 1, so the night frames
    // are bit-identical too. Everything this can reach is inside twilight.
    let d = (0.060 - e) / 0.150;
    d = d < 0 ? 0 : d > 1 ? 1 : d;
    const dark = d * d * (3 - 2 * d);

    // ── glare ───────────────────────────────────────────────────────────────
    const lm = this.bloom.luminanceMaterial;
    const thresh = L.threshHi + (L.threshLo - L.threshHi) * lowSun;
    const intens = L.intensHi + (L.intensLo - L.intensHi) * lowSun;
    lm.threshold = thresh + (L.threshNight - thresh) * night;
    lm.smoothing = L.smoothHi + (L.smoothLo - L.smoothHi) * lowSun;
    this.bloom.intensity = intens + (L.intensNight - intens) * night;
    this.bloom.mipmapBlurPass.radius = L.radiusHi + (L.radiusLo - L.radiusHi) * lowSun;

    // ── veil ────────────────────────────────────────────────────────────────
    // The source texture is the smallest level of the bloom's own pyramid, so
    // it is re-read every frame rather than cached: `levels` changes with the
    // window size and with the quality tier, and a stale texture here would be
    // a disposed render target.
    const mm = this.bloom.mipmapBlurPass;
    const us = mm.upsamplingMipmaps, ds = mm.downsamplingMipmaps;
    const rt = (us && us.length >= 2) ? us[us.length - 1]
             : (ds && ds.length ? ds[ds.length - 1] : null);
    const vu = this.veil.uniforms;
    if (rt && rt.texture) {
      vu.get('uVeilTex').value = rt.texture;
      vu.get('uVeilTexel').value.set(1 / Math.max(1, rt.width), 1 / Math.max(1, rt.height));
      const vg = L.veilHi + (L.veilLo - L.veilHi) * lowSun;
      this.veil.gain = vg + (L.veilNight - vg) * night;
    } else {
      this.veil.gain = 0;
    }

    // ── the twilight / night grade ──────────────────────────────────────────
    const u = this.grade.uniforms;
    u.get('uNight').value = night;
    // Contrast up at twilight. The exposure ramp above lifts the top of the
    // curve; this takes the bottom back down, so the range opens from both ends
    // rather than the whole frame sliding up — measured, exposure alone moved
    // lumaP05 up almost as much as lumaP95. The pivot is 0.18 linear, which is
    // above every dark mass in a dusk frame, so a contrast above 1 is a
    // darkening there and a brightening only on the sky and the glare.
    //
    // Twilight-only, and that matters: the archive records a global 1.30 with
    // the toe cut turning every shaded shrub into a black hole at eye level in
    // daylight, and the art director rejecting it. `lowSun` is 0 at noon and
    // 0.35 at h17.1, so the daylight sheet moves by a third of this at most.
    // ── AND THE CONTRAST PIVOT IS THE THIRD DAYLIGHT CONSTANT ────────────────
    //
    // The grade's contrast pivots on 0.18 — middle grey — which is the right
    // pivot for a frame whose subject spans 0.1 to 1.0. At night the BRIGHTEST
    // pixel in the frame is about 0.05, so every pixel is far below the pivot
    // and a contrast above 1 throws all of them deep negative; the soft toe
    // beneath is then the only thing bringing them back, and what it brings
    // back is dominated by the toe constant rather than by the pixel.
    //
    // Worked with real numbers, a night ground channel at 0.020 linear:
    //   contrast 1.36  ->  v = -0.0624, toe 0.022 -> 0.0019
    //   contrast 1.05  ->  v = -0.0090, toe 0.022 -> 0.0089
    // i.e. at the daylight setting the output is four fifths toe. That is the
    // same failure as the lift and the tone curve's black offset, from a third
    // direction: a term sized for a display-referred daylight frame becomes the
    // majority of the signal in a frame that lives two decades lower. It shows
    // up as the night ground going grey — one constant added to all three
    // channels of a dark pixel IS a desaturation — while the sky's chroma
    // simultaneously reads too HIGH, because the tone curve's min-channel
    // subtraction is pulling the other way on the pixels just above it.
    //
    // Ramped toward 1.0 rather than to it. The plates' own night contrast is
    // low (contrastStd 0.074-0.123 across the three) so there is nothing here
    // that wants a strong S-curve, but a value of exactly 1 makes this line a
    // no-op and the next author will delete it.
    const contrastDay = 1.36 + L.twiContrast * lowSun;
    u.get('uContrast').value = contrastDay + (L.nightContrast - contrastDay) * night;
    // The toe goes with it, for the same reason and by the same argument as the
    // lift: with the pivot brought down there is much less negative excursion
    // for it to catch, and what it does catch it should catch gently or it is
    // once again the majority of a dark pixel.
    // …on `dark` rather than on `night`, though. See the note beside that
    // ramp: the pivot argument this line inherits is arithmetic about where
    // the frame's radiance sits, and the frame's radiance falls at sunset.
    u.get('uToe').value = 0.022 * (1 - L.nightToeCut * dark);
    // Vibrance down at twilight. It is a chroma *compressor* — it boosts by
    // (1 - sat), so it does its largest work on the least saturated pixels in
    // the frame, and at dusk those are the sky and the haze. Measured on the
    // baseline, sunvista-h19 came back 23.8% magenta/rose/violet with zero
    // near-neutral pixels; this is the term that was amplifying a mildly purple
    // dome into a strongly purple one.
    u.get('uVibrance').value = 0.90 - L.twiVibrance * lowSun;
    // …and the lift down at night, so the scene outruns it. See the scotopic
    // block in the grade for the measurement, and `dark` above for why this is
    // the one term of the five that most needed to let go at the horizon: it
    // is the pedestal that was filling in underneath the camp fire's pool.
    u.get('uLift').value = 0.020 * (1 - L.nightLiftCut * dark);
    // The rod block keeps `night`, and it is the term that ramp's late start
    // was written for.
    u.get('uRodAmount').value = L.rodAmount;
    u.get('uRodTint').value.set(L.rodTint[0], L.rodTint[1], L.rodTint[2]);
    this.tone.offsetScale = 1 - (1 - L.nightOffset) * dark;
  }

  /** Scene exposure applied immediately before the tone curve. */
  setExposure(v) { this._baseExposure = v; this.tone.exposure = v; }
  getExposure() { return this._baseExposure; }

  /**
   * Put the focal plane at `distance` METRES.
   *
   * The divide by `camera.far` that used to be here was the normalised
   * convention `postprocessing` retired at 6.30 — see `_buildDOF`.
   *
   * The hold is what lets photo mode take the lens. CameraRig writes this
   * every frame from the free camera's own pivot distance (`_free`, and
   * `_focus` for the driving cameras), which is the right default and exactly
   * wrong once a player is pulling focus by hand: without the hold, one wheel
   * detent of manual focus survived until the next frame and no further. The
   * rig is left alone — it may keep calling — and this decides who wins.
   */
  setFocus(distance) {
    if (!this.dof || this._focusHeld) return;
    this.dof.cocMaterial.uniforms.focusDistance.value = distance;
  }

  /** The focal plane, in metres, whoever last set it. */
  get focusDistance() {
    return this.dof?.cocMaterial.uniforms.focusDistance.value ?? 0;
  }

  /** Take the focus away from CameraRig (`true`) or hand it back (`false`). */
  holdFocus(on) {
    this._focusHeld = !!on;
  }

  /** Set the focal plane past the hold. The manual dial's write path. */
  setFocusManual(distance) {
    if (!this.dof) return;
    this.dof.cocMaterial.uniforms.focusDistance.value = Math.max(0.05, distance);
    this._applyAperture();
  }

  /**
   * The aperture, as an f-number. Only photo mode's configuration reads it —
   * the tier row has a fixed circle and no dial.
   *
   * N reaches the frame through the circle-of-confusion shader itself
   * (`uCocGain`), not through two derived constants. That is the fix for the
   * three-to-six byte-identical stops: `bokehScale` and `focusRange` were the
   * whole vocabulary, both of them saturated at close focus, and identical
   * numbers mean an identical frame. A gain inside c(d) cannot saturate for
   * every depth in the picture at once.
   */
  setAperture(fStop) {
    this._fStop = Math.max(0.7, Math.min(45, fStop || PHOTO_DOF.fStop));
    this._applyAperture();
  }

  get fStop() { return this._fStop; }

  /**
   * Recompute bokehScale and focusRange from the aperture, the focus distance,
   * the camera's field of view and the buffer's pixel height.
   *
   * Called from `_applySizes` as well as from the dials: `bokehScale` is a
   * radius in BUFFER PIXELS, so a fixed number would be half as wide a circle
   * the moment photo mode pins the resolution to a Retina panel's density. It
   * is derived from a fraction of frame height every time instead.
   */
  _applyAperture() {
    if (!this._photoDOF || !this._dofEffect) return;
    const g = this._lensGeometry();
    const h = this.composer?.inputBuffer?.height || this.engine.height || 900;
    // The ceiling is the smaller of the kernel's limit and the biggest circle
    // this composition can actually contain — the background at infinity, or a
    // foreground at PHOTO_DOF.nearRef, whichever is larger. Taking only the
    // first is B1: focused at 237 m it sized the whole effect off a 0.74 px
    // background circle and the near field went with it.
    const capFrac = Math.min(PHOTO_DOF.blurCap, Math.max(g.kInf, g.kNear));
    const bokeh = Math.max(0.05, capFrac * h);
    this._dofEffect.bokehScale = bokeh;

    const u = this._dofEffect.cocMaterial.uniforms;
    // The shader multiplies this by |d − s|/d, so the number it wants is the
    // infinity circle expressed in units of the ceiling. Nothing else about
    // the aperture reaches the frame any more, and nothing needs to: N is
    // inside kInf, so every stop moves every defocused pixel.
    if (u.uCocGain) {
      u.uCocGain.value = g.kInf / (bokeh / h);
      u.uCocKnee.value = PHOTO_DOF.knee;
    }
    // `focusRange` is deliberately NOT written here. In photo mode the shader
    // ignores it (uCocPhysical), and the tier row owns it; a photo-mode write
    // would leak into the configuration `setPhotoDOF(false)` restores. What a
    // readout wants instead is `lensInfo()`.
  }

  /**
   * The lens, as numbers: focal length, the film it is covering, the circle a
   * background at infinity projects, and the same circle for something at the
   * near reference.
   *
   * Split out of `_applyAperture` because `lensInfo()` needs the identical
   * geometry and two copies of the lens equation is one copy too many.
   *
   * The FILM is derived and the LENS is the constant — the inverse of what this
   * used to do, and the whole of the B1 fix. See the header above `PHOTO_DOF`:
   * a fixed film with a 16:1 zoom ring on the front of it makes the long end
   * 14.8× shallower than the real lens it is drawing, which is a uniform smear
   * and not a photograph. Here the ring crops instead, and the format falls out
   * of the fitted angle of view.
   */
  _lensGeometry() {
    const P = PHOTO_DOF;
    const cam = this.engine.camera;
    const f = P.focal;                                          // mm, fixed
    // The film this lens has to cover to give the camera's vertical fov. The
    // floor is paranoia about a degenerate fov, not a real case.
    const format = Math.max(2 * f * Math.tan((cam.fov * Math.PI / 180) * 0.5), 1);
    const s = Math.max(f * 1.05, this.focusDistance * 1000);   // mm, never inside the lens
    const N = this._fStop;
    // Diameter of the blur circle for a subject at infinity, in mm of film;
    // c(d) = A·|d − s|/d for everything else.
    const A = (f * f) / (N * (s - f));
    const kInf = 0.5 * A / format;                   // radius, as a frac of frame height
    const dNear = Math.min(P.nearRef * 1000, s);
    return { f, format, s, N, A, kInf, kNear: kInf * (s - dNear) / dNear };
  }

  /**
   * What the lens is doing, for a readout: the focal length it is pretending
   * to be, the stop, and the near and far limits of the acceptably-sharp zone
   * in METRES (`far` is `Infinity` past the hyperfocal distance — that is the
   * honest answer, and the caller formats it).
   *
   * These are the textbook limits, solved from the same c(d) the shader runs
   * rather than from the hyperfocal shorthand: c(d) = format/cocDiv gives
   * d = sA/(A ± c), which has no singularity to clamp and is monotonic in both
   * s and N. `wideOpen` says the background at infinity is already past the
   * kernel's ceiling — opening up further cannot melt it any harder, which is
   * the one thing left that can make two adjacent stops look alike, and is
   * worth telling the player rather than letting them discover it.
   *
   * `hyperfocal` is here for the dial's own far limit rather than for the
   * readout. It is the focus distance past which `far` is already infinite, so
   * it is the furthest setting that buys anything — and a dial that stops short
   * of it cannot reach the ridgeline the 200-400's blurb sells. photo_focus.js
   * reads it instead of keeping a second copy of the model that would drift
   * from this one; that file's `_reach` is the caller.
   */
  lensInfo() {
    if (!this._dofEffect) return null;
    const P = PHOTO_DOF;
    const { f, format, s, N, A, kInf } = this._lensGeometry();
    const c = format / P.cocDiv;                     // acceptable circle, mm
    const near = (s * A) / (A + c) / 1000;
    // `far = sA/(A − c)` divides by a difference that goes to ZERO at the
    // hyperfocal, and `A > c` is a knife-edge test right where the divide
    // blows up. That used to be an academic worry; it is not any more, because
    // `photo_focus._openAt` now parks the opening autofocus exactly ON the
    // hyperfocal. Measured on a cold entry at 200 mm: the panel printed
    // "sharp 23.3 – 320072412631920576 m".
    //
    // The cut-off is the camera's own far plane rather than an epsilon on the
    // comparison, because that is the honest statement: past `camera.far`
    // nothing is drawn, `readDepthAt` returns null, and "sharp to 218 km" and
    // "sharp to infinity" describe the same photograph. An epsilon would have
    // had to be tuned per focal length to say anything different.
    const raw = A > c ? (s * A) / (A - c) / 1000 : Infinity;
    const far = raw >= (this.engine.camera?.far ?? 6000) ? Infinity : raw;
    return {
      focal: f, format, fStop: N, focus: s / 1000, near, far,
      // H = f²/(Nc) + f, in metres. Focus there and A is exactly c, which is
      // the `A > c` above going false: same model, one solve.
      hyperfocal: ((f * f) / (N * c) + f) / 1000,
      bokehPx: this._dofEffect.bokehScale,
      wideOpen: kInf >= P.blurCap,
    };
  }

  /**
   * How far away, in metres, whatever is drawn at screen uv (`0,0` bottom
   * left) is — or `null` if nothing is.
   *
   * This is what makes focus pullable. A blind numeric dial is miserable to
   * use, and the two obvious ways to give the player something to aim with are
   * both wrong here:
   *
   *  · `Raycaster.intersectObjects(scene, true)` walks streamed terrain LOD
   *    tiles, half a million grass blades and the tree BVH, and the first thing
   *    it hits is usually a grass blade a metre from the lens. camp_site.js's
   *    `groundRay` header says the same thing about the same world.
   *  · re-rendering the scene through `scene.overrideMaterial` into a tiny
   *    depth target replaces the VERTEX shaders too, and grass, ground cover
   *    and the canopy are *built* in theirs — they would be sampled where they
   *    are not drawn. AGENTS.md logs the same trap as `fx.flatShade`.
   *
   * The composer already keeps a stable copy of the frame's depth (the merged
   * pass asks for it — see `_rebuildMainPass`), so the answer is one texel of a
   * buffer that has already been paid for. One 1×1 draw plus a 4-byte
   * `readPixels`, and it is exact for everything the player can see: terrain,
   * trees, the camper, a bear, the far shore.
   *
   * The read is synchronous and therefore a pipeline stall. That is why this is
   * called on a click, not per frame.
   */
  readDepthAt(u = 0.5, v = 0.5) {
    const depth = this.composer?.depthTexture ?? this.composer?.inputBuffer?.depthTexture;
    if (!depth) return null;
    const cam = this.engine.camera;
    const probe = this._depthProbe ??= this._buildDepthProbe();
    const uni = probe.pass.fullscreenMaterial.uniforms;
    uni.uDepth.value = depth;
    uni.uUv.value.set(u, v);
    uni.uNear.value = cam.near;
    uni.uFar.value = cam.far;

    const r = this.engine.renderer;
    const prev = r.getRenderTarget();
    probe.pass.render(r, null, probe.target);
    r.readRenderTargetPixels(probe.target, 0, 0, 1, 1, probe.bytes);
    r.setRenderTarget(prev);

    const [b0, b1, b2] = probe.bytes;
    const t = (b0 + b1 / 255 + b2 / 65025) / 255;
    // The far plane means "sky", not "a subject 3 km away".
    if (t >= 0.999) return null;
    const viewZ = t * cam.far;

    // `viewZ` is the distance along the view AXIS; the CoC shader compares
    // against `length(viewPosition)`, the distance along the RAY. They are the
    // same only at the centre of the frame, and a focus pull to a corner would
    // otherwise land short by the cosine.
    const ty = Math.tan((cam.fov * Math.PI / 180) * 0.5);
    const nx = (u * 2 - 1) * ty * cam.aspect;
    const ny = (v * 2 - 1) * ty;
    return viewZ * Math.sqrt(1 + nx * nx + ny * ny);
  }

  _buildDepthProbe() {
    const target = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: false,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    target.texture.name = 'PostFX.DepthProbe';
    // Hand-rolled 24-bit encode rather than three's `packDepthToRGBA`, because
    // both ends of it live here and a byte target is the only thing
    // `readRenderTargetPixels` is guaranteed to be able to read back. Each
    // channel is written as an exact multiple of 1/255 so the unorm8 rounding
    // round-trips instead of drifting a metre.
    const pass = new ShaderPass(new THREE.ShaderMaterial({
      name: 'DepthProbeMaterial',
      uniforms: {
        inputBuffer: { value: null },
        uDepth: { value: null },
        uUv: { value: new THREE.Vector2(0.5, 0.5) },
        uNear: { value: 0.1 },
        uFar: { value: 3000 },
      },
      vertexShader: /* glsl */`
        void main() { gl_Position = vec4(position.xy, 1.0, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform highp sampler2D uDepth;
        uniform vec2 uUv;
        uniform float uNear;
        uniform float uFar;
        void main() {
          float d = texture2D(uDepth, uUv).x;
          // Window depth to view-space Z, the perspective form. Written out
          // rather than included so this pass carries no chunk dependency.
          float z = (2.0 * uNear * uFar) / (uFar + uNear - (d * 2.0 - 1.0) * (uFar - uNear));
          float t = clamp(z / uFar, 0.0, 1.0);
          float a = floor(t * 255.0);
          float f1 = fract(t * 255.0);
          float b = floor(f1 * 255.0);
          float c = floor(fract(f1 * 255.0) * 255.0);
          gl_FragColor = vec4(a, b, c, 255.0) / 255.0;
        }`,
      depthWrite: false,
      depthTest: false,
    }));
    return { target, pass, bytes: new Uint8Array(4) };
  }

  dispose() {
    this.composer.dispose();
    this._depthProbe?.target.dispose();
    this._depthProbe?.pass.dispose();
    // The composer disposes its passes, and an EffectPass disposes the effects
    // it holds — but a tier without depth of field keeps the effect detached,
    // so nothing would ever reach it.
    if (!this.dof) this._dofEffect?.dispose();
  }
}
