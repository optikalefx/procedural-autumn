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
// renders 1.02 MP (a ~1170x870 window at an effective ratio of 1.0, which is
// the hard floor — anything below native reads as "blurry", so the scaler may
// not go there).
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
// `medium` and `low` inherit `ssao: true/false` and `dof: false` from the
// preset, so the effects they drop are dropped by the preset. What this adds is
// that a tier they *keep* an effect at is a cheaper version of it.
//
// Nothing here softens the image at any tier: SMAA and the guard pass are
// present at every tier, and no tier lowers a render resolution. A tier drop
// removes work; it never trades sharpness for it.
const POST_TIERS = {
  ultra:  { aoSamples: 16, denoiseSamples: 8, denoiseIterations: 2, bloomMip: 12 },
  high:   { aoSamples: 16, denoiseSamples: 8, denoiseIterations: 2, bloomMip: 12 },
  medium: { aoSamples: 8,  denoiseSamples: 4, denoiseIterations: 1, bloomMip: 24 },
  low:    { aoSamples: 8,  denoiseSamples: 4, denoiseIterations: 1, bloomMip: 32 },
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
    //
    // Built lazily by _setDOF() so the constructor and a later tier change go
    // through one code path. A tier that has no DOF never builds it.

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
    this.composer.addPass(this.sanity);

    // Builds the SSAO pass and the merged main pass for this tier.
    this._applyTier(this.preset, this.tier);

    engine.onResize((w, h) => {
      this.composer.setSize(w, h);
      this.ao?.setSize(w, h);
      this._capBloomMips();
    });
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
   * adaptive scaler is pinned at its floor on the reporting player's machine
   * (effective ratio 1.0, which is a hard minimum because anything below native
   * reads as "blurry"), so the tier is the *only* lever left.
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
    this._capBloomMips();
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

  /** Add or remove depth of field, rebuilding the merged pass around it. */
  _setDOF(on) {
    const want = on
      ? (this._dofEffect ??= new DepthOfFieldEffect(this.engine.camera, {
          focusDistance: 55 / this.engine.camera.far,
          focalLength: 0.26,
          bokehScale: 0.60,
          height: 720,
        }))
      : null;
    if (this.mainPass && want === this.dof) return;
    this.dof = want;
    this._rebuildMainPass();
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
    this.composer.addPass(this.mainPass);
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
    u.get('uToe').value = 0.022 * (1 - L.nightToeCut * night);
    // Vibrance down at twilight. It is a chroma *compressor* — it boosts by
    // (1 - sat), so it does its largest work on the least saturated pixels in
    // the frame, and at dusk those are the sky and the haze. Measured on the
    // baseline, sunvista-h19 came back 23.8% magenta/rose/violet with zero
    // near-neutral pixels; this is the term that was amplifying a mildly purple
    // dome into a strongly purple one.
    u.get('uVibrance').value = 0.90 - L.twiVibrance * lowSun;
    // …and the lift down at night, so the scene outruns it. See the scotopic
    // block in the grade for the measurement.
    u.get('uLift').value = 0.020 * (1 - L.nightLiftCut * night);
    u.get('uRodAmount').value = L.rodAmount;
    u.get('uRodTint').value.set(L.rodTint[0], L.rodTint[1], L.rodTint[2]);
    this.tone.offsetScale = 1 - (1 - L.nightOffset) * night;
  }

  /** Scene exposure applied immediately before the tone curve. */
  setExposure(v) { this._baseExposure = v; this.tone.exposure = v; }
  getExposure() { return this._baseExposure; }

  setFocus(distance) {
    if (!this.dof) return;
    this.dof.cocMaterial.uniforms.focusDistance.value =
      distance / this.engine.camera.far;
  }

  dispose() {
    this.composer.dispose();
    // The composer disposes its passes, and an EffectPass disposes the effects
    // it holds — but a tier without depth of field keeps the effect detached,
    // so nothing would ever reach it.
    if (!this.dof) this._dofEffect?.dispose();
  }
}
