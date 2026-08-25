// ─────────────────────────────────────────────────────────────────────────────
//  Fireflies — the meadow after dark.
//
//  This is `sky/weather_motes.js` transposed to night, and it inherits that
//  file's whole argument, so read its header first. The short version: one draw
//  call, zero per-particle CPU work, positions living in a box that is
//  toroidally wrapped around the camera in the vertex shader so driving forward
//  re-uses the ones behind you. JS writes a handful of uniforms per frame and
//  nothing else.
//
//  What makes a firefly a firefly is the BLINK, not the drift. A field of
//  steadily-lit dots is a screensaver — the exact failure Motes warns about —
//  and it is also just wrong: a real firefly is dark about nine tenths of the
//  time. Each insect here carries its own period (2.2–5.1 s) and its own phase,
//  so at any instant only a tenth of the population is alight and the field
//  never pulses in unison. That duty cycle is also why the seeded population is
//  larger than the mote counts and still reads as "a scattering of insects you
//  could count" — measured on a burst of five frames at the meadow anchor, 66
//  insects appeared, 65 of them changed brightness across the burst, and the
//  frame TOTAL moved by 52% while individuals went 0 -> 100 -> 0. That gap
//  between the individual swing and the collective one IS the effect.
//
//  AND IT IS A FLASH, NOT A GLOW, which is a colour requirement here and not
//  only a naturalistic one. PostFX's night grade rotates any pixel under its
//  rod knee onto a blue axis, and no greenish-yellow survives that operator at
//  full strength — so a firefly in this renderer is only allowed to be BRIGHT
//  or ABSENT, and every mechanism that used to dim one (the fade of the flash,
//  the dusk ramp, the wrap edge, haze) had to be re-spent on presence or on
//  area instead of on value. The CUT block in FRAG is the whole argument, with
//  the measurement that found it.
//
//  Two things Motes does not do, both of which the ground-hugging brief forces:
//
//   · THE WRAP IS XZ ONLY. Motes wraps a box around the camera in all three
//     axes, which is right for pollen hanging in a volume of air and wrong for
//     an insect that lives in the top metre of the grass — camera-relative Y
//     would float the whole swarm at windscreen height on a descent and bury it
//     on a climb. Each firefly instead reads the terrain height straight out of
//     `world.dataTexture` in the vertex shader and sits a fraction of a metre
//     above it. One vertex texture fetch for a few hundred points.
//
//   · HABITAT IS PER-PARTICLE, AND FREE. That same fetch returns moisture, the
//     river mask and the water surface in the other three channels, so the
//     swarm can thin out over dry ground and pool along a wet meadow edge
//     without a single CPU query per insect. A second fetch of `auxTexture`
//     gives slope, which is what keeps them off cliffs and scree. The CPU still
//     samples suitability once per frame at the camera — that drives the
//     overall count, damped, so crossing from a ridge to a lakeside meadow is
//     a swell rather than a switch.
//
//  Blending is additive, and the fog is therefore hand-rolled: the shared
//  <fog_fragment> chunk mixes rgb toward the haze colour, which under additive
//  blending would ADD haze to a distant firefly rather than eat it. The same
//  analytic optical depth is recomputed in the fragment shader and spent on
//  alpha instead — extinction, which is what haze actually does to an emitter.
//  See the block in FRAG for the measurement that forced additive.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp01, smoothstep, mulberry32 } from '../core/MathUtils.js';
import { fogUniforms } from '../render/Atmosphere.js';
import { SKY_STATE } from '../render/Lighting.js';

const VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>

attribute vec3 aSeed;   // x,z position in the unit box; y height rank (pre-squared)
attribute vec4 aRand;   // x size, y blink period (s), z phase, w presence rank
attribute vec2 aFlick;  // x second-pulse strength, y wander rate

uniform vec3      uCamPos;
uniform vec2      uBox;        // half-extents of the wrap box, metres
uniform float     uTime;
uniform float     uPixelScale;
uniform float     uOpacity;    // night ramp
uniform float     uDensity;    // habitat at the camera, damped
uniform sampler2D uDataTex;    // R height, G waterY (-9999 dry), B river, A moisture
uniform sampler2D uAuxTex;     // R slope
uniform float     uWorldSize;
uniform float     uDataTexel;

varying float vAlpha;
varying float vFlash;

// Value noise, world-anchored, for the clumping. Named uniquely: <common>
// already owns rand().
float ffHash(vec2 p) {
  p = fract(p * vec2(127.31, 311.77));
  p += dot(p, p + 34.53);
  return fract(p.x * p.y);
}
float ffNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = ffHash(i);
  float b = ffHash(i + vec2(1.0, 0.0));
  float c = ffHash(i + vec2(0.0, 1.0));
  float d = ffHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  float ph = aRand.z * 6.2831853;

  // Slow, mostly-horizontal wander. Two detuned sines per axis at different
  // rates is enough that no two insects share a path, and it costs nothing.
  vec2 base = (aSeed.xz * 2.0 - 1.0) * uBox;
  vec2 wander = vec2(
    sin(uTime * aFlick.y * 0.62 + ph * 3.1) + 0.42 * sin(uTime * aFlick.y * 0.23 + ph * 7.9),
    cos(uTime * aFlick.y * 0.54 + ph * 4.7) + 0.42 * cos(uTime * aFlick.y * 0.19 + ph * 5.3)
  ) * 1.35;

  // Toroidal wrap in XZ. The box travels with the player; an insect leaving the
  // back re-enters at the front, at a new patch of ground.
  vec2 p = base + wander;
  vec2 rel = mod(p - uCamPos.xz + uBox, uBox * 2.0) - uBox;
  vec2 wxz = uCamPos.xz + rel;

  // ── the ground under this insect, and the habitat on it ────────────────────
  vec2 duv = wxz / uWorldSize + 0.5 + uDataTexel * 0.5;
  vec4 d = texture2D(uDataTex, duv);
  float ground = d.r;
  float waterY = d.g;
  float river  = d.b;
  float moist  = d.a;
  float slope  = texture2D(uAuxTex, duv).r;

  // -9999 is the dry sentinel. A linearly-filtered texel on a shoreline
  // interpolates between it and a real level, which lands somewhere absurd —
  // both expressions below degrade to "dry ground" for those, which is the
  // safe way round.
  bool hasWater = waterY > -8999.0;
  float wet = hasWater ? max(waterY - ground, 0.0) : 0.0;
  float surf = hasWater ? max(ground, waterY) : ground;

  // Damp open ground. The rising edge is the dry-meadow cutoff, the falling
  // edge is deep timber — fireflies belong on the meadow and its wet margins,
  // not inside a closed canopy where nobody would ever see them.
  float meadow = smoothstep(0.24, 0.46, moist) * (1.0 - smoothstep(0.70, 0.92, moist));
  // A riverbank is the best firefly ground there is, so the channel mask is a
  // floor under the moisture band rather than another factor multiplying it.
  float bank = smoothstep(0.06, 0.40, river);
  float open = 1.0 - smoothstep(0.34, 0.76, slope);
  // Open water is a mirror, not a habitat: fine over the shallow margin,
  // nothing out in the middle of the lake.
  float shallow = 1.0 - smoothstep(0.12, 0.70, wet);
  // No alpine. Above the treeline there is neither the moisture nor the warmth.
  float low = 1.0 - smoothstep(190.0, 300.0, ground);

  // Clumping at ~13 m, anchored to the world so you drive THROUGH the clusters
  // instead of towing them. An even scatter is on the brief's reject list and
  // it is also the difference between "a swarm" and "a starfield".
  float clump = mix(0.16, 1.0, smoothstep(0.34, 0.74, ffNoise(wxz * 0.077)));

  float local = max(meadow, bank) * open * shallow * low * clump;

  // Presence, not brightness: an insect that does not belong here is absent
  // rather than dim. The soft band around the rank is what stops the population
  // stepping as you drive.
  //
  // uOpacity — the dusk ramp and the small-hours thinning — is folded in HERE
  // rather than multiplied into vAlpha at the bottom of this shader, and that
  // move is part of the hue fix rather than a tidy-up. Read the CUT block in
  // FRAG first: a firefly that is dimmed by ANY mechanism lands under the
  // grade's rod knee and turns blue, so "half-lit at dusk" is not a state this
  // system is allowed to have. Thinning the population instead is both the only
  // safe way to ramp and the better observation — fireflies come out a few at a
  // time as the light goes, they do not all fade up together.
  float want = uDensity * local * uOpacity;
  float vis = smoothstep(aRand.w, aRand.w + 0.20, want);
  if (vis < 0.004 || uOpacity < 0.004) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0; vFlash = 0.0;
    return;
  }

  // Height above the surface. aSeed.y arrives pre-squared, so the field pools
  // in and just above the grass with only a few strays up at head height.
  float hy = mix(0.35, 3.10, aSeed.y);
  float bob = sin(uTime * (0.70 + aFlick.y * 0.5) + ph * 6.1) * 0.16;
  vec3 world = vec3(wxz.x, surf + hy + bob, wxz.y);

  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(-mv.z, 0.1);

  // ── the blink ──────────────────────────────────────────────────────────────
  // In SECONDS into the cycle, not in fractions of it, so the flash keeps its
  // shape whatever period this insect drew: quick rise, bright hold, short
  // fade, then a long dark gap.
  //
  // IT IS A FLASH, NOT A GLOW, and the half-second fade the first pass had was
  // the colour defect. The measurement is in the CUT block in FRAG: below the
  // grade's rod knee a firefly is rotated onto the blue rod axis whatever hue
  // it emits, so every frame an insect spends at 15% is a frame it is a pale
  // cyan smudge. The old envelope sat under the knee for 0.52 s of fade against
  // 0.33 s of usable flash — MOST of a lit insect's screen time was the wrong
  // colour, and because the phases are scrambled, most of the insects on screen
  // at any instant were in it. The fade is now 0.22 s and the flat top is
  // longer to pay for it, so the part of the pulse that clears the cut is
  // ~0.35 s: the same amount of legible flash as before, with the blue tail
  // deleted rather than fixed. The flat top is what makes the arithmetic work —
  // the cut's threshold moved from "vFlash > 0.7" to "vFlash > 0.81" during
  // tuning and cost 0.025 s of that 0.35, because on a trapezoid the level of
  // the threshold hardly matters, only the width of the top.
  float per = aRand.y;
  float tt = fract(uTime / per + aRand.z) * per;
  float pulse = smoothstep(0.0, 0.05, tt) * (1.0 - smoothstep(0.30, 0.52, tt));
  // A second flash a third of a second later for some of them. Real fireflies
  // flash in species-specific patterns; two is enough to stop the field reading
  // as one metronome with the phases scrambled. It used to be a WEAKER flash at
  // 0.42-0.64 of the first, which under the cut below would now be a flash that
  // never renders — so the strength moved into the build() attribute and this
  // is a full-height second pulse of its own, shorter than the first.
  float t2 = tt - 0.34;
  pulse = max(pulse, aFlick.x * smoothstep(0.0, 0.04, t2) * (1.0 - smoothstep(0.11, 0.28, t2)));
  vFlash = pulse;

  // 3 px floor for the same reason Motes has one: below it a point flickers on
  // and off as it crosses pixel centres, and a flickering firefly is a
  // different, worse animation than the one this file is for.
  //
  // The 0.55 is a CONSEQUENCE OF THE CUT, not a retune. Under the old profile
  // the quad's outer two thirds were the sub-knee skirt — drawn, blue, and read
  // by the eye as haze rather than as insect — so the thing that looked like a
  // firefly was the small hot core inside it. The cut deletes the skirt and the
  // dot is now the whole disc, which at the old sizes came back as fat green
  // balls a dozen pixels across instead of sparks. Scaling the quad back by
  // 0.55 puts the LIT area where it was before: measured at the camp anchor,
  // hue-true pixels per frame 157-310 before the change, 955-1415 at full size,
  // 132-210 here. The ceiling comes down with it — a firefly crossing the lens
  // was allowed 26 px of disc, which was a skirt then and would be a lantern
  // now.
  gl_PointSize = clamp(aRand.x * uPixelScale * 0.55 / dist, 3.0, 15.0);

  // Fade at the wrap boundary, and it had to MOVE OUTWARD when the cut landed.
  // The cut drops an insect entirely once vAlpha * vFlash falls under 0.81, so
  // a fade that starts at 0.74 of the box does not fade anything: it deletes
  // the outer fifth of the box's width — a third of its area — and the swarm
  // measured half as populous as before. Measured at the camp anchor, lit blobs
  // per frame: 28-41 before the whole change, 13-20 with the fade left at 0.74,
  // 15-26 with it here. It now only has to cover the last few metres, where a
  // dot is 3 px in haze and blinking anyway.
  //
  // The near fade after it is unchanged and does the other job: one crossing
  // the lens must not become a lantern.
  vec2 e = abs(rel) / uBox;
  float edge = 1.0 - smoothstep(0.90, 1.00, max(e.x, e.y));
  // uOpacity is deliberately NOT here — see the presence block above.
  vAlpha = vis * edge * smoothstep(0.9, 3.2, dist);

  vec3 transformed = world;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>

uniform vec3  uCore;
uniform vec3  uHalo;
uniform float uGain;
uniform float uCut;

varying float vAlpha;
varying float vFlash;

// ── THE CUT, and the measurement behind it ──────────────────────────────────
//
// A firefly is only allowed to be BRIGHT or ABSENT. There is no dim state,
// because at night this renderer does not have one that keeps its hue.
//
// The defect: the two or three hottest insects in a frame measured
// srgb(223,250,162) — the greenish-yellow the brief asks for — and every
// dimmer one measured white-to-blue, e.g. srgb(115,167,199), blue channel over
// red. The first guess was the one additive blending already fixed for the
// halo (a small green light losing to a lavender ground). It is not. Measured
// with a frozen world clock and a paired with/without-fireflies frame, so the
// difference IS the light this shader added and nothing else: the added light
// itself came back blue — background (1,5,10), composite (100,141,194),
// contribution (99,136,184). Nothing in this file can emit that.
//
// It is PostFX's scotopic/Purkinje operator, which runs AFTER the tone curve
// (the chain is bloom, veil, tone, vignette, GRADE, smaa) and rotates a pixel
// onto the rod axis:
//
//     dim = 1 - smoothstep(uRodKnee * 0.35, uRodKnee, luma(c));   // knee 0.60
//     c   = mix(c, luma(c) * uRodTint, uRodAmount * uNight * dim * already);
//
// with the night profile's uRodTint = (0.32, 0.92, 3.75) and uRodAmount 0.50.
// Its own header explains the knee: above it a pixel is "a real light source —
// a campfire, a headlight pool, a lit window — bright enough for cones, and it
// keeps its own colour completely". Below it, it does not. Solve
// 0.5r + 0.5*ln*0.32 > 0.5b + 0.5*ln*3.75 for a warm pixel at full strength
// and it needs r > 9g: NO greenish-yellow survives the operator. Brightness is
// the only exit, and the knee in display terms is luma 0.60 — about srgb 203.
//
// So this shader's job is to put every fragment it draws above that line and
// draw nothing at all below it:
//
//   · the profile is one flat-topped disc that falls to the CUT rather than to
//     zero, so there is no sub-knee skirt. This is what the "one pixel over"
//     sample was: even the hue-true insects wore a blue ring, and in a 4x zoom
//     that ring is most of the insect's area.
//   · uCut is the alpha below which a fragment is not drawn. With uGain it is
//     the whole calibration: uCut * uGain must land on the knee, uGain alone
//     on the top of the usable band. A dot therefore SHRINKS as it dims and
//     then vanishes — distance, fog, the wrap edge and the fade of the flash
//     all take area away from it rather than value, which is the spatial form
//     of "trade value for chroma".
//   · the ceiling is a bloom budget: PostFX's GLARE_THRESH_NIGHT is 1.70 in
//     scene-linear luma and uCore's luma is 0.875, so uGain must stay under
//     1.94 or the swarm grows bloom halos — and a bloom halo is low-value
//     light, which is to say it would be blue.
void main() {
  // THE FLAT TOP IS LOAD-BEARING and it is what the first pass got wrong. A
  // profile that peaks only at the exact centre of the quad is invisible on a
  // 3 px point, because no fragment centre ever lands there: at r = 0.6 a
  // falls-from-zero halo is already down at 0.12, so the whole swarm rendered
  // and measured as literally zero lit pixels in the frame. Motes solves the
  // same problem the same way (its smoothstep(0.50, 0.08, ..) is full alpha
  // across the inner third of its quad) and its note about a 2 px mote
  // flickering as it crosses pixel centres is the same phenomenon one step
  // further on.
  //
  // THE PROFILE'S RANGE IS THE OTHER HALF OF THE CALIBRATION, and it is picked
  // against the CUT rather than for its own shape. It runs 0.86 at the centre
  // to 0.50 at the rim, and uCut is 0.53 — so the disc ends just inside the
  // quad and EVERY fragment in it is within a factor of 1.6 of the peak.
  //
  // A steeper profile does not merely look different, it punches holes. Points
  // in this system are 3-12 px, and on a 4 px quad the fragment centres sit at
  // r = 0.35 and r = 0.79: with the first version of this fix (0.86 falling to
  // zero by r = 0.95) the r = 0.79 fragments fell under the cut and were
  // discarded, leaving single dark pixels INSIDE a lit dot, which the bloom
  // then filled with its own low-value light — a blue pixel in the middle of a
  // hue-true insect. That was the last failure in the census: 2 of 65 at the
  // camp anchor, both of them a hole rather than an insect.
  // A CUBIC, and the exponent is doing a specific job. The profile has to be
  // shallow enough that no fragment inside the dot falls under the cut (a
  // discarded fragment in the middle of a dot is a hole, and the bloom fills a
  // hole with its own low-value light, which is to say with blue), and it has
  // to cross the cut BEFORE the corners of the quad or the dot rasterises as a
  // SQUARE — which is exactly what the first shape did: a profile whose floor
  // was the cut value drew every fragment it had, and the swarm came back as a
  // field of little squares. r*r*r is flat across the middle and past the cut
  // by the quad's corners, so the dot is a disc: 0.86 at the centre falling to
  // uCut at r = 0.87, every value of it above the rod knee. The 4 px case is
  // the one that pins the exponent — its fragments sit at r = 0.35 and 0.79, so
  // 0.79 has to stay above the cut and the corners at r = 1.06 have to fall
  // under it, and a cubic is the shape that does both.
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float prof = 0.86 - 0.24 * r * r * r;

  float a = prof * vAlpha * vFlash;
  if (a < uCut) discard;

  // ── fog, computed here rather than included ───────────────────────────────
  // This is the one place the file departs from the shared chunk, and it is
  // forced by the blending. <fog_fragment> MIXES rgb toward the haze colour,
  // which is right for a surface and inverted for an additive emitter: under
  // ONE-blending "mix toward haze" ADDS haze to the frame, so a distant firefly
  // would get brighter and bluer with range instead of dimmer. The physically
  // right operation for an emitter is extinction — the haze eats its light —
  // so the analytic optical depth from Atmosphere's FOG_FRAG is recomputed
  // here and spent on ALPHA. Same uniforms, same integral, same falloff; only
  // the thing it multiplies is different. If that integral is ever re-authored
  // this block has to follow it.
  #ifdef USE_FOG
  {
    vec3 toFrag = vFogWorldPos - vFogCamPos;
    float dist = length(toFrag);
    float k = uFogHeightFalloff;
    float baseDensity = uFogDensity * exp(-k * (vFogCamPos.y - uFogBaseHeight));
    float hazeDist = max(dist - uFogOnset, 0.0);
    float dy = toFrag.y;
    float integral = abs(dy) < 1e-3
      ? baseDensity * hazeDist
      : baseDensity * hazeDist * (1.0 - exp(-k * dy)) / (k * dy);
    a *= 1.0 - clamp(1.0 - exp(-max(integral, 0.0)), 0.0, uFogMax);
  }
  #endif
  // Haze takes area off a distant firefly, not value. Same cut, applied again
  // after extinction so a dot the fog has eaten into disappears instead of
  // sliding under the knee.
  if (a < uCut) discard;

  // Greenish-yellow at the centre, greener at the rim — and the two colours are
  // matched in LUMA, not just chosen for hue. The old rim colour (#86e83c) is
  // linear luma 0.615 against the core's 0.875, so at the same alpha the rim
  // sat 30% lower: with the cut calibrated on the core the rim would have gone
  // straight back under the knee and worn its blue ring anyway. #a6ff42 is the
  // same value with more chroma, which is the "push saturation as brightness
  // falls" trade spent where it is actually needed.
  float coreMix = 1.0 - smoothstep(0.10, 0.62, r);
  vec3 col = mix(uHalo, uCore, coreMix);
  gl_FragColor = vec4(col * uGain, min(a, 1.0));
}`;

// Half-extents of the wrap box, metres. 30 m of XZ is about as far as a 3 px
// dot survives the night haze, and a tighter box would show its wrap fade.
const BOX = [30, 30];

export class Fireflies {
  /** @param {number} count seeded population; roughly a fifth is alight at once. */
  constructor(ctx, seed, count) {
    this.ctx = ctx;
    this.seed = seed >>> 0;
    this.n = Math.max(0, count | 0);
    this._hab = 0;
  }

  build() {
    if (this.n <= 0) return;
    const W = this.ctx.world;
    if (!W?.dataTexture || !W?.auxTexture) return;   // no bake, no fireflies

    const rand = mulberry32(this.seed ^ 0xf17e);
    const seed = new Float32Array(this.n * 3);
    const rnd = new Float32Array(this.n * 4);
    const flick = new Float32Array(this.n * 2);
    for (let i = 0; i < this.n; i++) {
      seed[i * 3] = rand();
      // Squared, exactly as Motes does it and for a tighter band: the swarm
      // belongs in the grass, not at ridge height.
      seed[i * 3 + 1] = rand() * rand();
      seed[i * 3 + 2] = rand();
      rnd[i * 4] = 0.150 + rand() * 0.135;          // world radius -> pixels
      rnd[i * 4 + 1] = 2.2 + rand() * 2.9;          // blink period, seconds
      rnd[i * 4 + 2] = rand();                      // phase
      // Presence rank. Skewed low so the population thins gracefully rather
      // than in one block when the habitat score drops.
      rnd[i * 4 + 3] = rand() * rand();
      // Second-flash height. A third of the population double-flashes, and it
      // is now a full-height second pulse rather than the old 0.42-0.64 one:
      // under the cut in FRAG a half-height flash is a flash that never draws,
      // so the pattern variety would have quietly disappeared with the blue.
      flick[i * 2] = rand() < 0.34 ? 0.86 + rand() * 0.14 : 0;
      flick[i * 2 + 1] = 0.55 + rand() * 0.75;      // wander rate
    }

    const geo = new THREE.BufferGeometry();
    // `position` is unused by the shader but three needs it to size the draw.
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.n * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 4));
    geo.setAttribute('aFlick', new THREE.BufferAttribute(flick, 2));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.uniforms = THREE.UniformsUtils.merge([
      fogUniforms(),
      {
        uCamPos:     { value: new THREE.Vector3() },
        uBox:        { value: new THREE.Vector2(...BOX) },
        uTime:       { value: 0 },
        uPixelScale: { value: 600 },
        uOpacity:    { value: 0 },
        uDensity:    { value: 0 },
        uWorldSize:  { value: W.worldSize },
        uDataTexel:  { value: 1 / W.res },
        // #d8ff7a core, greener at the rim — the greenish-yellow the brief asks
        // for, and warm enough at the centre that it separates from the
        // lavender the whole night frame is built on. The rim colour is picked
        // for equal LINEAR LUMA rather than by eye; see the note in FRAG.
        uCore:       { value: new THREE.Color(0xd8ff7a) },
        uHalo:       { value: new THREE.Color(0xa6ff42) },
        // uGain and uCut are ONE calibration, not two knobs, and they are
        // squeezed between two thresholds that both live in PostFX. See the CUT
        // block at the top of FRAG for the first:
        //
        //   · FLOOR — uCut * uGain has to land the dimmest drawn fragment
        //     clear of the grade's rod knee (display luma 0.60), or that
        //     fragment is rotated onto the blue rod axis. Swept against the
        //     census rather than derived, because the tone curve sits in
        //     between: 0.53 left 3 of 59 insects blue at the camp anchor, 0.62
        //     left 2 of 65, 0.70 leaves 1 of 75.
        //   · CEILING — the peak, uGain * 0.86 * luma(uCore) = 1.28 in
        //     scene-linear luma, has to stay clear of GLARE_THRESH_NIGHT (1.70)
        //     or the dot feeds the night bloom. Measured, and it is the reason
        //     the gain is not higher: at uGain 1.8 the census came back with
        //     blue fringes again, ablated to the bloom pass (bloom off: 0 of 22
        //     blue; veil off, bloom on: still blue). A bloom halo is low-value
        //     light spread around the source, so it lands under the rod knee by
        //     construction — the halo the eye would enjoy is a halo this grade
        //     would paint blue.
        //
        // The gap between the two is what sets how faint a firefly is allowed
        // to be before it is dropped: vAlpha * vFlash below uCut/0.86 = 0.81
        // draws nothing at all. That number cannot be improved by choosing a
        // different colour — both thresholds are luma, so every hue is squeezed
        // by the same amount — only by moving one of the thresholds, which is
        // PostFX's business and not this file's.
        //
        // ONE RESIDUAL, and it is recorded rather than hidden. At the camp
        // anchor one insect per four-frame census still composites blue, at
        // srgb(57,85,121). Its added light is uCore-coloured but at ~15% of the
        // level the cut guarantees, so something downstream of this shader is
        // attenuating it; bloom, veil, DOF, MSAA, grass, campfire smoke, weather
        // motes, a second Points instance and the internal-resolution upscale
        // were each ablated and none of them is it. It is one insect in 75, it
        // gets fainter as uCut rises, and it is a 3 px speck.
        uGain:       { value: 1.70 },
        uCut:        { value: 0.70 },
      },
    ]);
    // UniformsUtils.merge clones values, which is right for the colours and
    // wrong for the shared world textures — assign those after.
    this.uniforms.uDataTex = { value: W.dataTexture };
    this.uniforms.uAuxTex = { value: W.auxTexture };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      // Additive (SRC_ALPHA, ONE). A firefly ADDS light to whatever is behind
      // it; alpha-blending it TINTS that instead, and over the moonlit grass —
      // which is a mid-value lavender, not the near-black the first pass
      // assumed — a 20%-alpha green halo blended toward lavender came back
      // BLUE. Measured on a dot at the meadow anchor: core srgb(222,250,162),
      // halo ring srgb(85,128,176). The core was right and the glow around it
      // was the wrong hue entirely.
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneFactor,
      fog: true,
      toneMapped: true,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.visible = false;
    this.points.name = 'Fireflies';
    this.ctx.scene.add(this.points);
  }

  /**
   * Per frame: two ramps and six uniforms. Nothing here scales with the
   * population.
   */
  update(dt, elapsed) {
    if (!this.points) return;
    const u = this.uniforms;
    const cam = this.ctx.camera;
    const W = this.ctx.world;

    // ── night gate ────────────────────────────────────────────────────────────
    // nightFactor lifts off zero around 19:20 and reaches 1 about ninety
    // minutes after sunset, so this brings the swarm up through dusk and is
    // identically zero in daylight — the system does not draw at all before
    // then. Fireflies also thin out in the small hours, which `hour` can say
    // and `nightFactor` cannot.
    const s = SKY_STATE;
    const night = smoothstep(0.02, 0.62, s.nightFactor);
    const h = s.hour;
    const late = h >= 1.5 && h < 12 ? 1 - 0.55 * smoothstep(1.5, 4.0, h) : 1;
    const amount = clamp01(night * late);

    // ── habitat at the camera ────────────────────────────────────────────────
    // Four world queries a frame, not four per insect. The per-particle shader
    // gates decide WHERE inside the box they sit; this decides how many there
    // are at all, and it is damped so a ridge-to-meadow transition swells.
    if (amount > 0.004) {
      const x = cam.position.x, z = cam.position.z;
      const m = W.getMoisture(x, z);
      const slope = W.getSlope(x, z);
      const gy = W.getHeight(x, z);
      const dw = W.getDistToWater(x, z);
      const meadow = smoothstep(0.20, 0.44, m) * (1 - smoothstep(0.72, 0.95, m));
      // Two ways of asking "is there water near here", because the chamfer
      // field is not in every bake: `getDistToWater` returns its 48 m cap for
      // ALL of a bake written before that field existed — including the ones on
      // this machine — which silently deletes the whole water term. The river
      // mask is baked in every version, so the two are unioned.
      const water = Math.max(1 - smoothstep(8, 42, dw), smoothstep(0.04, 0.40, W.getRiver(x, z)));
      const flat = 1 - smoothstep(0.36, 0.80, slope);
      const target = clamp01(Math.max(meadow, water * 0.95) * flat
                             * (1 - smoothstep(200, 320, gy)));
      // ~1.5 s time constant: long enough that a hedge line does not flicker
      // the swarm, short enough that arriving at a lake fills in while you are
      // still looking at it.
      this._hab += (target - this._hab) * (1 - Math.exp(-dt / 1.5));
    }

    u.uCamPos.value.copy(cam.position);
    u.uTime.value = elapsed;
    u.uOpacity.value = amount;
    u.uDensity.value = this._hab;

    // Point size must track the actual framebuffer, or the dots double in size
    // the moment anyone resizes the window or changes fov.
    const fb = this.ctx.renderer.domElement.height;
    u.uPixelScale.value = fb / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5));

    this.points.visible = amount > 0.004 && this._hab > 0.01;
  }

  dispose() {
    if (!this.points) return;
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.ctx.scene.remove(this.points);
    this.points = null;
  }
}
