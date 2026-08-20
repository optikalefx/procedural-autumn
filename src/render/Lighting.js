// ─────────────────────────────────────────────────────────────────────────────
//  Lighting — the sun, the fills, the shadow camera, and the time-of-day arc.
//
//  `hour` is the single scrubbable control (0..24). Everything visual — sun
//  colour and intensity, ambient split, sky gradient, haze colour and density,
//  cloud shading — is interpolated from the keyframe table below. That table
//  *is* the art direction for light; if a time of day looks wrong, fix the
//  keyframe, not the code around it.
//
//  Sky.js and Clouds.js are constructed independently by main.js and never see
//  the Lighting instance, so the per-frame result is published on the shared
//  `SKY_STATE` record they import. One writer, several readers, no globals.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { TOD, QUALITY_PRESETS } from '../world/WorldConfig.js';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// ── The day, as keyframes ────────────────────────────────────────────────────
//  sun/sunI      key light
//  hemiSky/Gnd   sky fill (cool) and ground bounce (warm) — the complementary
//                split that gives the reference art its depth
//  zen/hor       sky dome gradient endpoints
//  sunHor        horizon colour in the sun's azimuth (the "sunset wedge")
//  glow/glowI    colour + strength of the aureole around the sun disc
//  fog*/fogD     aerial perspective, consumed by Atmosphere
//  cloudLit/Dark cumulus top and shadow, consumed by Clouds
//
//  Colours are authored as display-referred sRGB and converted to the working
//  space on read; they land close to their hex after AgX because AgX keeps
//  middle grey. Anything whose *linear* luminance exceeds ~0.9 will clip to
//  white once bloom is applied, so the sky keys deliberately stay under it.
//
//  The daylight hor/sunHor keys were paled and lightened after measuring a
//  vertical ladder up plate 1's sky against ours. The *zenith* keys were paled
//  too and then put back: the vistas only ever see up to about 14 deg of sky, so
//  they are lit almost entirely by `hor` and did not care, while `waterfall`
//  pitches up and lost its blue — a blind A/B of the whole round picked the old
//  frame for that view and the new one everywhere else, and this was the reason.
//  So: pale the band the vistas actually see, and leave the dome blue.
//
//                        top of frame        mid sky          near the ridge
//    plate 1        luma 0.89 chroma 0.02  0.88 / 0.02      0.80 / 0.15
//    ours (before)  luma 0.78 chroma 0.21  0.84 / 0.33      0.83 / 0.33
//    ours (after)   luma 0.80 chroma 0.21  0.87 / 0.29      —
//
//  The reference sky is a near-white dome that only turns peach where it meets
//  the haze band; ours was a saturated peach slab, darkest at the top, and in
//  the three vista views that slab is close to half the frame. The haze keeps
//  its own colour — fogNear/fogFar are untouched — because that is what plate 1
//  actually puts over its ridges (measured srgb(223,185,167), chroma 0.22).
//  THE SUN AND HAZE KEYS ARE A HUE *WIDTH* CONTROL — 2026-08-19.
//
//  The standing art-director complaint on this project is that the game reads
//  as monochrome orange, and measurement finally located it. A fine hue
//  histogram (10 deg bins, tools/_scratch/huefine.mjs) of the meadow frame put
//  58% of every chromatic pixel inside the single 20-30 deg bin and nothing at
//  all above 70 deg. Plate 1 spreads the same mass across 10-50 deg with a real
//  8% tail out to 130. It is not that our hues are in the wrong place; it is
//  that they are all in the *same* place.
//
//  The key light was most of it. At 0xffbe72 the golden-hour sun is
//  linear 1 : 0.51 : 0.17 — as a multiplier that is a hue *replacement*, not a
//  tint. Crimson maple, gold grass, orange canopy and green conifer all get
//  their green and blue channels scaled by 0.5 and 0.17, which collapses four
//  distinct albedo hues into one band; no grade downstream can pull them back
//  apart, because by then they are the same colour. The haze did the same job
//  to the distance: fogNear was 0xe0ac72, saturation 0.49, where the comment
//  right above it correctly records plate 1's own haze as srgb(223,185,167) —
//  saturation 0.25. The measured value and the shipped value had drifted apart.
//
//  So the golden-hour keys are warm by a *ratio*, not by saturation:
//    sun 17.1   0xffbe72 -> 0xffd49c   linear 1 : 0.51 : 0.17  ->  1 : 0.66 : 0.35
//    haze 17.1  0xe0ac72 -> 0xe0b296   saturation 0.49 -> 0.33
//  and the same move, scaled, at 7.4 / 15.5 / 18.3 / 19.0. The frame still
//  reads as late afternoon — the sun is still a full stop warmer than the
//  midday key — but albedo hue survives the multiply, which is what puts the
//  yellow and yellow-green bands back and lets the conifers stay green instead
//  of arriving olive. Do not re-saturate these to chase "more golden": the gold
//  belongs to the ground albedo, and every time it has been moved into the
//  light instead, the whole frame has gone one colour.
//
//  THE DAYLIGHT `fogFar` KEYS WERE MAGENTA-LED — 2026-08-19.
//
//  Every one of them, 7.4 through 19.0, had blue *above* green: 0xdcbcc8 at
//  golden hour is srgb(220,188,200), which is a pink. Past `farStart * 5` the
//  haze is entirely fogFar, so in a vista that pink is the colour of every
//  distant ridge — and it is exactly the critic's fourth blocker, "the cool
//  half is arriving as candy pink in the distant range instead of as
//  blue-violet in the cast shadow". Confirmed by construction: neutralising the
//  key light (KEY_TINT below) took `hero`'s rose share *up* from 17.4% to
//  24.7%, because there was less orange left to bury the pink under.
//
//  Plate 1 is the plate vistas are judged against and its distance ramp has
//  blue as the LOWEST channel the whole way in, with no magenta anywhere:
//    far peak      srgb(219,183,167)   1 : 0.834 : 0.762
//    far mtn L     srgb(230,187,170)   1 : 0.817 : 0.740
//    far mtn R     srgb(223,194,181)   1 : 0.869 : 0.812
//    mid ridge     srgb(209,179,165)   1 : 0.857 : 0.789
//    haze band     srgb(203,169,150)   1 : 0.833 : 0.740
//  (plate 3's far slopes *are* mauve — srgb(141,111,122) — but that is a
//  shadowed hillside, not the haze, and it is the cast-shadow mass this brief
//  keeps pointing at. Do not put it back in the fog.)
//
//  So the daylight fogFar keys are re-authored onto plate 1's ramp: still paler
//  and less saturated than fogNear, which is what "far" means, but warm-neutral
//  rather than pink. The blue-hour and twilight keys (6.3, 19.8 and the night
//  block) keep B above G — at those hours the distance genuinely is blue and
//  the plates say nothing about it.
const KEYS = [
  { h: 0.0,  sun: 0x3b4a7a, sunI: 0.10, hemiSky: 0x5c6892, hemiGnd: 0x3a3c52, hemiI: 0.42,
    zen: 0x0d1226, hor: 0x1c2440, sunHor: 0x2e3050, glow: 0x2a3358, glowI: 0.12,
    fogNear: 0x1e2740, fogFar: 0x151b30, fogSun: 0x2a3358, fogD: 0.0030,
    cloudLit: 0x3a4468, cloudDark: 0x131a2e, cover: 0.35 },

  { h: 5.2,  sun: 0x3f5080, sunI: 0.12, hemiSky: 0x606c96, hemiGnd: 0x3c3e54, hemiI: 0.46,
    zen: 0x111834, hor: 0x2a3352, sunHor: 0x4b4468, glow: 0x50486e, glowI: 0.22,
    fogNear: 0x2a3350, fogFar: 0x1d2440, fogSun: 0x4b4468, fogD: 0.0031,
    cloudLit: 0x4a5074, cloudDark: 0x191f36, cover: 0.37 },

  // Blue hour — the sun is still under the horizon, the sky does the lighting.
  { h: 6.3,  sun: 0x9a7ea0, sunI: 0.55, hemiSky: 0x8d96b2, hemiGnd: 0x776a76, hemiI: 0.84,
    zen: 0x25407e, hor: 0xb59aa4, sunHor: 0xe0a088, glow: 0xf0ac82, glowI: 0.50,
    fogNear: 0x9c8a94, fogFar: 0x8a82a0, fogSun: 0xe0a088, fogD: 0.0036,
    cloudLit: 0xc9a8b0, cloudDark: 0x584f6e, cover: 0.34 },

  // Cool dawn — long low light, pale horizon. Cool is a *relative* statement:
  // the zenith is the bluest of the day, but the haze itself stays peach, or
  // the frame measures out at a fifth of the reference's chroma.
  { h: 7.4,  sun: 0xffcc9c, sunI: 2.60, hemiSky: 0xb8bcd0, hemiGnd: 0xd0a482, hemiI: 1.14,
    zen: 0x76abdc, hor: 0xf4d4b4, sunHor: 0xffc794, glow: 0xffd4ab, glowI: 0.95,
    fogNear: 0xe6b79c, fogFar: 0xd4b8ac, fogSun: 0xffcc96, fogD: 0.0024,
    cloudLit: 0xffe0c4, cloudDark: 0xa8968e, cover: 0.30 },

  { h: 9.5,  sun: 0xffdfae, sunI: 3.10, hemiSky: 0xb6c0e4, hemiGnd: 0xdcb072, hemiI: 0.96,
    zen: 0x63a0dc, hor: 0xf2e2d6, sunHor: 0xf8ead8, glow: 0xffeed6, glowI: 0.72,
    fogNear: 0xdcbb92, fogFar: 0xd2bfb4, fogSun: 0xffe8c8, fogD: 0.0021,
    cloudLit: 0xfff6ec, cloudDark: 0xbcae9e, cover: 0.24 },

  { h: 12.5, sun: 0xffecc8, sunI: 3.40, hemiSky: 0xbac6ec, hemiGnd: 0xe0b476, hemiI: 0.90,
    zen: 0x5fa0de, hor: 0xf0e2d8, sunHor: 0xeee6da, glow: 0xfff4e4, glowI: 0.62,
    fogNear: 0xd8c3a0, fogFar: 0xccbdb2, fogSun: 0xf8ecd8, fogD: 0.0015,
    cloudLit: 0xfffaf4, cloudDark: 0xbcb4a8, cover: 0.20 },

  { h: 15.5, sun: 0xffe6c4, sunI: 3.25, hemiSky: 0xbfbede, hemiGnd: 0xd8ae76, hemiI: 1.00,
    zen: 0x9ec0e6, hor: 0xf2dcc8, sunHor: 0xf8dcbc, glow: 0xffe6bc, glowI: 0.80,
    fogNear: 0xdcb99c, fogFar: 0xd8c2b6, fogSun: 0xffdfb4, fogD: 0.0021,
    cloudLit: 0xfff2e2, cloudDark: 0xbcaa9a, cover: 0.20 },

  // The money frame: deep golden hour.
  { h: 17.1, sun: 0xffd49c, sunI: 2.95, hemiSky: 0xbeb6d4, hemiGnd: 0xd2a066, hemiI: 0.98,
    zen: 0xa9c4e4, hor: 0xf2dac6, sunHor: 0xf8cd9c, glow: 0xffcf90, glowI: 1.00,
    fogNear: 0xe0b296, fogFar: 0xdcbcae, fogSun: 0xffc98c, fogD: 0.0027,
    cloudLit: 0xffe2bc, cloudDark: 0xb49688, cover: 0.22 },

  { h: 18.3, sun: 0xffb47e, sunI: 2.05, hemiSky: 0xb4a8cc, hemiGnd: 0xcc9060, hemiI: 1.16,
    zen: 0x5b83c2, hor: 0xf4d2b0, sunHor: 0xf8ac74, glow: 0xffae66, glowI: 1.20,
    fogNear: 0xe2a888, fogFar: 0xdab0a2, fogSun: 0xffa860, fogD: 0.0035,
    cloudLit: 0xffcc9c, cloudDark: 0xa8867a, cover: 0.32 },

  { h: 19.0, sun: 0xff9a6a, sunI: 1.50, hemiSky: 0xb49eac, hemiGnd: 0xb27a58, hemiI: 1.14,
    zen: 0x4a6bb4, hor: 0xeaae90, sunHor: 0xf28a4c, glow: 0xff9450, glowI: 1.32,
    fogNear: 0xd88a62, fogFar: 0xc09084, fogSun: 0xff8a48, fogD: 0.0040,
    cloudLit: 0xffb078, cloudDark: 0x94706a, cover: 0.34 },

  { h: 19.8, sun: 0x9c5a76, sunI: 0.32, hemiSky: 0x8a92ae, hemiGnd: 0x7a6672, hemiI: 0.72,
    zen: 0x33508e, hor: 0xb890a0, sunHor: 0xd0756e, glow: 0xe07a62, glowI: 0.66,
    fogNear: 0xa8808e, fogFar: 0x92849e, fogSun: 0xd8756e, fogD: 0.0043,
    cloudLit: 0xd09aa0, cloudDark: 0x6a5468, cover: 0.36 },

  { h: 21.0, sun: 0x4a4a80, sunI: 0.12, hemiSky: 0x64709a, hemiGnd: 0x40425a, hemiI: 0.48,
    zen: 0x151c3a, hor: 0x35395c, sunHor: 0x53476c, glow: 0x54486e, glowI: 0.22,
    fogNear: 0x333a58, fogFar: 0x232a48, fogSun: 0x53476c, fogD: 0.0034,
    cloudLit: 0x4a5074, cloudDark: 0x191f36, cover: 0.39 },

  { h: 24.0, sun: 0x3b4a7a, sunI: 0.10, hemiSky: 0x5c6892, hemiGnd: 0x3a3c52, hemiI: 0.42,
    zen: 0x0d1226, hor: 0x1c2440, sunHor: 0x2e3050, glow: 0x2a3358, glowI: 0.12,
    fogNear: 0x1e2740, fogFar: 0x151b30, fogSun: 0x2a3358, fogD: 0.0030,
    cloudLit: 0x3a4468, cloudDark: 0x131a2e, cover: 0.35 },
];

// ── THE MIDDAY GROUND IS BLEACHED BY GEOMETRY, NOT BY THE KEY ───────────────
//
// The other half of critic blocker 3. Measured on a `#f0ad46` card in full sun
// through the whole chain (tools/_scratch/look/neutral.mjs), against the
// anchor's own 1 : 0.721 : 0.292:
//
//   h  7.4   1 : 0.748 : 0.330   luma 0.513   the anchor
//   h 16.7   1 : 0.718 : 0.326   luma 0.464   the anchor
//   h 12     1 : 0.819 : 0.367   luma 0.730   washed cream
//
// The noon row is not a hue error, and this is worth stating precisely because
// the obvious fix does not work: at luma 0.73 the card is past PBR Neutral's
// compression knee, and that curve's own desaturation term is what raises the
// two low channels. Cutting the midday keys (tried, 3.40 -> 2.95 at 12.5) moved
// the card from luma 0.730 to 0.718 and the ratio the *wrong* way, because the
// shoulder compresses hard enough that a 13% cut in scene radiance is a 1.6%
// change on screen. It was reverted; the keys here are the authored ones.
//
// The cause is geometry. A flat, up-facing ground plane at a 53-degree noon sun
// receives about four times the irradiance it does at a 14-degree golden hour,
// which is a real property of the world and not something the keyframe table
// should be lying about. The right place to absorb four stops of daylight
// variation is the exposure, and that is what PostFX now does — see
// EXPOSURE_ELEV there. Do not re-cut these keys to chase the same thing; it
// would dim the ground while leaving the sky dome, which is lit independently,
// exactly where it was.
const COLOR_FIELDS = ['sun', 'hemiSky', 'hemiGnd', 'zen', 'hor', 'sunHor', 'glow',
                      'fogNear', 'fogFar', 'fogSun', 'cloudLit', 'cloudDark'];
const SCALAR_FIELDS = ['sunI', 'hemiI', 'glowI', 'fogD', 'cover'];

// The fogD curve below was authored while a wiring bug meant MeshStandardMaterial
// received no fog uniforms at all (see docs/INTEGRATION_REQUESTS.md). Only the
// opt-in ShaderMaterials were hazed, so the densities were pushed high to make
// trees recede — and once the terrain started receiving fog too, every distant
// view turned into a white-out. This scales the whole authored curve rather
// than flattening its time-of-day shape, which is still right.
// Recalibrated once the aerial perspective stopped bleeding toward grey: at
// 0.34 there was barely any haze left to layer with — `peaks` reached only
// fogFactor ~0.25 on its furthest ridge, so near, mid and far read as one
// plane. 0.34 was over-correcting for the fact that the old desaturation term
// was neutralising the frame, which is fixed at source in Atmosphere now.
// Nudged up from 0.54 after Atmosphere instanced-transform fix landed. Every
// InstancedMesh — trees, rocks, grass, ground cover — had been hazed as if it
// stood at the world origin, which pinned it at the uFogMax cap; correcting it
// removed, in one commit, most of the aerial perspective the painterly look was
// actually resting on. This buys that dissolve back, now applied to the right
// object at the right distance. Kept short of the 0.78 that looked best at eye
// level, because the vistas pay for it: at 0.78 hero lumaP05 climbs to 0.40 and
// its range falls to 0.41, i.e. back toward the flat cream wash.
// Cut again, to 0.42, and this is the vista half of the "no true dark anywhere"
// finding. Measured on `hero` by sweeping this multiplier alone in one boot
// (tools/_scratch/coolsweep.mjs, fogScale):
//
//   scale   lumaP05   lumaRange   contrastStd
//   0.64     0.397      0.337        0.109
//   0.45     0.351      0.383        0.120
//   0.29     0.312      0.421        0.131
//   0.16     0.277      0.457        0.143
//
// against plate 1's 0.161 / 0.705 / 0.218. Nothing else in the chain comes
// close to that authority over a vista: the grade's toe and lift, swept over
// the same frame across a 3.5x range, moved lumaP05 by 0.004 in total, because
// nothing in `hero` was ever near the toe. The frame had no darks because the
// haze had already eaten them, several hundred metres before the grade saw the
// pixel.
//
// It is a real trade and it is deliberately not taken to the end: aerial
// perspective is the brief's named depth cue, and at 0.16 the far peaks are as
// contrasty as the near ones and the layering is gone. 0.42 keeps the ridge
// separation (the altitude profile in heightFalloff does most of that work and
// is untouched) while letting the shadowed forest mass in the near third
// arrive dark enough to be the frame's black point.
const FOG_DENSITY_SCALE = 0.42;

// ── THE NEUTRAL POINT — 2026-08-19 ──────────────────────────────────────────
//
// The rocks author supplied the cleanest diagnostic this project has had: a
// surface with equal RGB reflectance does not come back neutral. Reproduced
// directly (tools/_scratch/look/neutral.mjs floats a linear-0.5 grey card in
// full sun, with receiveShadow off so no cast shadow can contaminate it):
//
//              a pure grey card renders as        an unlit 0.5 grey through
//              sun + hemi + stylise + grade       the post chain alone
//   h 7.4      1 : 0.778 : 0.512                  1 : 0.999 : 0.997
//   h 12       1 : 0.982 : 0.726                  1 : 0.999 : 0.997
//   h 16.7     1 : 0.796 : 0.410                  1 : 0.999 : 0.997
//   h 18.6     1 : 0.553 : 0.350                  1 : 0.999 : 0.997
//
// Two things follow, and they close a question that has been mis-attributed
// three times. **The grade is exactly neutral.** A known grey put through
// tone map, split-tone, contrast, lift, vibrance, warm regrade, blue floor and
// grain comes out 184,184,184 at every hour. Every previous author who went
// looking for the warm cast in PostFX was looking in the wrong file. It is the
// key light, and it is the same finding as "the key light was a hue
// replacement, not a tint" — that commit halved the error at one hour and left
// the mechanism in place.
//
// What the reference does instead, measured on its own sunlit stone:
//   plate 5 boulder      srgb(181,169,163)   1 : 0.929 : 0.896
//   plate 5 rock         srgb(160,152,150)   1 : 0.950 : 0.939
//   plate 1 fg rock      srgb(157,140,137)   1 : 0.893 : 0.871
//   plate 2 mountain     srgb(114,111,119)   1 : 0.974 : 1.049
// — all in the same frames whose grass measures chroma 0.58-0.71. The
// reference gets blazing gold and neutral stone *in one frame* because its key
// is achromatic in ratio and the gold lives in the albedo. Ours cannot: at
// h16.7 a grey card loses 59% of its blue to the light before any surface
// author gets a say, which is why stone cannot be lavender, why the cool
// shadow cannot be reached by rotating a pixel whose blue is already gone, and
// why the ground drifts salmon at dawn and brick at dusk — those are the same
// multiply at a more extreme ratio.
//
// So the key is now applied as a *tint of a neutral*: the authored hue lerped
// toward its own luminance. Luminance is preserved exactly (luma is linear in
// the channels, so mixing toward vec3(luma) cannot change it), which means
// intensity, exposure and every value calibration in this file and in PostFX
// are untouched by this — it moves hue and nothing else.
//
// The warmth of golden hour does not go away, because it was never really
// coming from here: it comes from the gold ground albedo, from the sky and
// haze, and from the grade's highlight tint. What goes away is the warmth
// being applied to *rock, birch, conifer and the camper as well*, which is the
// monochrome-orange complaint in its final form.
//
// Swept in one boot on the grey card and on a `#f0ad46` card, both in full sun
// (tools/_scratch/look/neutral.mjs --variants), then on real views:
//
//   tint    grey h16.7        grey h7.4         gold h16.7       gold h7.4
//   1.00    1:0.797:0.412     1:0.775:0.512     1:0.659:0.331    1:0.682:0.335
//   0.55    1:0.844:0.666     1:0.880:0.728     1:0.692:0.328    1:0.721:0.332
//   0.30    1:0.925:0.805     1:0.964:0.859     1:0.716:0.326    1:0.748:0.330
//   0.00    1:1.018:1.003     1:1.071:1.041     1:0.748:0.323    1:0.786:0.334
//   want    1:0.89 :0.87  …  1:0.97:1.05        1:0.72 :0.33  (plate 3 / critic)
//
// The gold column is the reason this is safe: it barely moves, because a gold
// surface's hue was always mostly its own albedo. The grey column is the whole
// defect, and it is 0.41 -> 0.81 of blue at one number.
//
// ── 0.22, RE-SWEPT WITH THE PLATE ANCHORS AS THE TARGET ─────────────────────
//
// The sweep above compared the grey card against "1 : 0.89 : 0.87 … 1:0.97:1.05"
// as a band. Re-run on the shipping build with a `#c3bfcc` card in the chart —
// which is the brief's *lit rock* anchor, sRGB 1 : 0.979 : 1.046, and the exact
// thing the rocks author said is unreachable — the sweep reads:
//
//   tint   grey card h16.7    #c3bfcc card h16.7   #f0ad46 card h16.7
//   0.30   1 : 0.928 : 0.817  1 : 0.831 : 0.975    1 : 0.718 : 0.326
//   0.22   1 : 0.949 : 0.859  1 : 0.851 : 1.024    1 : 0.723 : 0.325
//   0.15   1 : 0.971 : 0.899  1 : 0.871 : 1.072    1 : 0.730 : 0.324
//   want   1 : 0.93  : 0.92   1 : 0.979 : 1.046    1 : 0.721 : 0.292
//
// 0.22 lands the rock card's blue within 2% of the anchor, where 0.30 was 7%
// short and 0.15 is 2.5% over — and the gold column moves by half a percent
// across the whole sweep, which is the whole reason this is safe to do. The
// predecessor's warning about 0.0 (acid grass, lilac rock) still stands and
// this stays well clear of it.
//
// The green channel is still short on the rock card at every setting, and that
// residual is *not* the key: the grade is neutral to within a level, and the
// hemisphere fill is itself green-short (hemiSky 0xbeb6d4 is 1 : 0.95 : 1.11).
// Left as it is this round rather than moved blind — a hemi hue change reaches
// every shaded surface in the game and wants its own measurement.
// 0.22, not 0.0. At 0.0 the grass reads acid yellow-green rather than gold and
// the rock goes lilac — the frame stops being golden hour and starts being an
// overcast noon with a warm sky. At 0.30 the birch trunks come back near-white
// (the brief calls them a signature and they were rendering tan), the conifers
// are green instead of olive, the rock is lavender-grey instead of brown-grey,
// and the gold ground is unchanged to the eye. Judged on `drive` at full res.
const KEY_TINT = 0.22;

// ── AND A CEILING ON THE KEY'S CHROMA, WHICH IS THE OTHER HALF ──────────────
//
// KEY_TINT is a *fraction*, so it hands every hour the same proportion of an
// authored hue that is not the same size at every hour. Measured on the grey
// card with the tint shipping at 0.30:
//
//            grey card in full sun        gold #f0ad46 card in full sun
//   h 7.4    1 : 0.970 : 0.859            1 : 0.748 : 0.330
//   h 12     1 : 1.029 : 0.934            1 : 0.819 : 0.367
//   h 16.7   1 : 0.928 : 0.817            1 : 0.718 : 0.326
//   h 18.6   1 : 0.757 : 0.669            1 : 0.603 : 0.318
//
// The gold column is critic blocker 3 in one line: the ground is the anchor's
// colour at 7.4 and 16.7 and neither at 12 (washed) nor 18.6 (brick). And the
// grey column says why — it is not the ground, it is the light. The authored
// key runs from linear 1 : 0.84 : 0.58 at noon to 1 : 0.32 : 0.15 at 19.0, a
// factor of four in chroma, and a constant fractional tint passes that factor
// straight through. Dusk is not "golden hour but more so"; it is the same
// multiply at a ratio no albedo survives.
//
// So cap the *result* instead. Tinting toward luminance is a lerp, so the
// linear saturation it lands on has a closed form and can be inverted: with
// c(a) = l + (c0 - l) a, sat(a) = a (mx0 - mn0) / (l + a (mx0 - l)), which is
// monotonic in a, so the amount that lands exactly on a ceiling S is
//
//     a = S l / ( (mx0 - mn0) - S (mx0 - l) )
//
// and the key is tinted at min(KEY_TINT, that). Luminance is untouched at any
// amount, so no intensity, exposure or value calibration anywhere in this file
// or in PostFX is affected — this moves hue and only hue.
//
// 0.25 is chosen so it is a *no-op at 17.1*, the money hour: the shipping tint
// of 0.30 already lands the key there at saturation 0.2506, so the ceiling
// binds at 0.299 and golden hour is bit-for-bit what it was. It binds hard
// where the defect is — 0.203 at 18.3, 0.158 at 19.0, 0.286 at 7.4 — and not
// at all at noon, whose key is pale enough to sit under it at any amount. The
// day still reads as a day: the sun *disc* and the sky glow are published from
// the untinted key (see update()), so a low sun is still orange in the sky.
// What stops changing is how much of that orange is multiplied into rock,
// birch, conifer and the camper.
// 0.22. Verified free at every framing this project judges: the amount that
// lands the 17.1 key on this ceiling is 0.259, above KEY_TINT, so `min()` picks
// KEY_TINT and golden hour is bit-identical. It binds only past 18.0, where the
// authored key runs away — 0.175 at 18.3 and 0.136 at 19.0 — which is the hour
// the gold ground was measuring brick at.
const KEY_SAT_MAX = 0.22;

/**
 * Tint amount for this key: the smaller of the base amount and the amount that
 * lands the key exactly on the chroma ceiling. Returns `base` when the key is
 * already under the ceiling untinted (the denominator goes non-positive), so a
 * pale midday key is never *pushed* toward its authored hue.
 */
function keyTintAmount(c, base, satMax) {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const mx = Math.max(c.r, c.g, c.b);
  const mn = Math.min(c.r, c.g, c.b);
  const denom = (mx - mn) - satMax * (mx - l);
  if (denom <= 1e-6) return base;
  return Math.min(base, (satMax * l) / denom);
}

/** Lerp a light colour toward its own luminance. Preserves luminance exactly. */
function tintKey(c, amt) {
  if (amt >= 1) return c;
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  c.setRGB(l + (c.r - l) * amt, l + (c.g - l) * amt, l + (c.b - l) * amt);
  return c;
}

// The hemisphere fill was authored to keep shadows off the floor while the
// Stylize diffuse floor was not running (same wiring bug as the fog). With both
// active it is doing the job twice, and a large near-white ambient is the
// classic way to flatten a stylised frame: it lifts the shaded side of every
// high-albedo surface — bare rock most of all — until form disappears. The
// reference's rock runs #c3bfcc lit against #5c5a75 shaded, a ratio of about
// 0.19 in linear; at full ambient ours measured 0.7. Scaling the whole authored
// curve keeps its time-of-day shape, which is right.
//
// 0.62 was still too much for a vista. Worked through for the hero massif at
// golden hour: sun 2.95, ambient 0.61, stylised diffuse 0.72 lit / 0.12 shaded.
// Ambient was then 22% of the lit face but 64% of the shaded one, so it set the
// contrast of every mountain in the frame. At 0.50 the shaded flank drops from
// 0.92 to about 0.74 display against a lit flank at 0.98 — the difference
// between a beige lump and a mountain.
//
// Settled well above that at 0.72. The eye-level frames — river, forest,
// waterfall, vehicle — are mostly shaded ground and dark conifer, and anything
// at or under 0.55 put all four below the reference bands lumaMean floor of
// 0.37. Ambient is the one lever that lifts those without also brightening the
// lit rock the vistas are made of.
const AMBIENT_SCALE = 0.72;

// Shadow normal offset, expressed in shadow-map texels. See _setShadowExtent().
const SHADOW_NORMAL_BIAS_TEXELS = 5.5;

// Pre-convert the table once; per-frame we only lerp.
const BAKED = KEYS.map((k) => {
  const o = { h: k.h };
  for (const f of COLOR_FIELDS) o[f] = C(k[f]);
  for (const f of SCALAR_FIELDS) o[f] = k[f];
  return o;
});

/**
 * Per-frame atmosphere state, written by Lighting, read by Sky and Clouds.
 * Mutated in place — never reassign the objects, consumers hold references.
 */
export const SKY_STATE = {
  sunDir: new THREE.Vector3(0, 1, 0),
  sunElev: 0,          // sin(elevation), -1..1
  dayFactor: 0,        // 0 night … 1 full day, useful for fading effects
  hour: TOD.hour,
  // ── the night half of the record — see docs/SKY_NIGHT_BRIEF.md ───────────
  // Added as a contract so Sky and Clouds can be built against it. Lighting is
  // the only writer. Values may be re-authored; fields may not be removed.
  moonDir: new THREE.Vector3(0, -1, 0),
  moonElev: -1,
  moonPhase: 0.32,     // 0 new … 0.5 full … 1 new. 0.32 is the plates' crescent.
  moonColor: new THREE.Color(0.82, 0.86, 1.0),
  moonIntensity: 0,    // 0 while the moon is down or the sun is up
  // Stars need their own ramp. Driving them off `1 - dayFactor` put a full
  // starfield over the salmon sky of `sunvista-h19`, because dayFactor reaches
  // 0 the moment the sun touches the horizon and civil twilight is another
  // forty minutes of bright sky after that.
  starAmount: 0,
  milkyWay: 0,
  nightFactor: 0,
  zenith: new THREE.Color(),
  horizon: new THREE.Color(),
  sunHorizon: new THREE.Color(),
  glow: new THREE.Color(),
  glowIntensity: 1,
  sunColor: new THREE.Color(),
  sunIntensity: 1,
  cloudLit: new THREE.Color(),
  cloudDark: new THREE.Color(),
  cloudAmbient: new THREE.Color(),
  cloudCover: 0.5,
  fogNear: new THREE.Color(),
  fogFar: new THREE.Color(),
};

export class Lighting {
  constructor(scene, quality = 'ultra') {
    this.scene = scene;
    this.quality = quality;
    this.preset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.high;
    this.hour = TOD.hour;
    this.azimuth = TOD.sunAzimuth;
    this.cycleSpeed = TOD.cycleSpeed;
    // Runtime multipliers on the two authored curves. They exist so a value
    // decision can be *swept* in one browser boot instead of one boot per
    // candidate — both of these were previously module constants that could
    // only be changed by editing the file, which is why every note beside them
    // records three data points and not fifteen. They default to 1.0 and the
    // constants below remain the shipping values.
    this.ambientScale = 1.0;
    this.fogScale = 1.0;
    // Null means "use KEY_TINT". Set to a number to sweep the key's hue width
    // in one browser boot — see the note beside KEY_TINT.
    this.keyTint = null;
    // Same, for the chroma ceiling. Null means "use KEY_SAT_MAX".
    this.keySatMax = null;

    // Sunrise / sunset in hours. The elevation curve is shaped so that the
    // canonical golden-hour views (16.4 … 17.9) sit between 5° and 18° — a
    // symmetric sine puts the sun far too high there.
    this.sunrise = 6.2;
    this.sunset = 18.9;

    this.sunDir = new THREE.Vector3();

    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.sun.castShadow = true;
    const S = this.preset.shadowMapSize;
    this.sun.shadow.mapSize.set(S, S);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 1400;
    // PCF-soft wants a small constant bias and most of the work done by the
    // normal offset; a large normalBias is what produced the visible
    // peter-panning gap under ridgelines in the first pass.
    this.sun.shadow.bias = -0.0004;
    // normalBias is now derived from the shadow map's texel footprint rather
    // than being a constant — see SHADOW_NORMAL_BIAS_TEXELS and
    // _setShadowExtent(). A constant is wrong on both ends: 0.35 m is three
    // texels at ultra and under two at medium, and the ground-cover author
    // measured that anything small which both casts and receives was testing as
    // shadowed by itself. Their proof was a fallen log forced to pure white
    // albedo still rendering as a flat black band across the bottom of forest,
    // with the same mesh lighting correctly the moment receive was turned off.
    // Ground-hugging litter was worse: it sits inside the terrain's own bias
    // envelope. See item 8 in docs/INTEGRATION_REQUESTS.md.
    // NOTE ON SOFTNESS — do not re-add shadow.radius or shadow.blurSamples here.
    //
    // They used to be set (3.5 / 10) alongside a forced PCF_SOFT below, and both
    // were dead values: radius is read only by SHADOWMAP_TYPE_PCF and
    // blurSamples only by VSM. An author flagged that and it was never resolved,
    // so this pass resolved it — by measuring, in both directions.
    //
    // Look: PCF with radius 4 is genuinely softer and better. A/B'd inside one
    // page load on `waterfall`, the only canonical view with cast tree shadows
    // on a large clean receiver, PCF_SOFT gives hard aliased blobs on the cliff,
    // PCF r=4 gives soft legible tree shapes, PCF r=9 dissolves them entirely.
    //
    // Performance: it is not affordable. Two 45 s drives each, interleaved on
    // the same machine so concurrent load hits both arms:
    //   PCF_SOFT   p50 19.0 / 17.5 ms   p95 47.0 / 40.4   >50 ms  123 /  99
    //   PCF r=4    p50 26.8 / 28.2 ms   p95 56.6 / 59.0   >50 ms  194 / 190
    // a ~55% regression at the median, while a performance author is already
    // chasing frames over 100 ms. Three's PCF_SOFT is nine bilinear-filtered
    // compares and PCF is nine point compares, so the cost is not the tap count
    // — it is that a radius-4 kernel scatters those taps four texels apart
    // across a 4096² map and loses the cache. It gets worse, not better, with a
    // larger radius, which is the direction "softer" wants to go.
    //
    // So the softness we ship is the texel size: PCF_SOFT's penumbra is one
    // texel, which is 7 cm at the 150 m eye-level extent and 44 cm at the 900 m
    // vista extent. If a future pass wants a real penumbra the cheap route is
    // the shadow *map*, not the filter — a second, coarse, wide-extent map for
    // the soft distant shapes — not turning this constant back on.
    // A cast shadow in the reference is a warm, semi-transparent shape on gold
    // meadow, not a hole. Three defaults shadow.intensity to 1 — fully black —
    // and that default was once in force, which is how the near-field views came
    // to measure lumaP05 0.00-0.08 against a reference band of 0.16-0.42.
    //
    // The over-correction was as bad in the other direction. At 0.46 the shadows
    // were technically present and visually absent, and a critic pass named the
    // missing cast shadow the single biggest reason the meadows read flat: plate
    // 1 gets its whole sense of form from long soft shapes crossing a third of
    // the frame. At 0.66 the shape is unmistakable and still nowhere near a
    // hole — ambient, the stylised diffuse floor and the grade chromatic toe
    // between them keep shaded ground a warm colour rather than an absence.
    //
    // 0.66 was still short, and this is now measured rather than judged. The
    // measurement (tools/_scratch/sepdiag.mjs) captures the same posed frame
    // twice — once normally, once with intensity forced to 0 — and compares the
    // two at the pixels that changed, so it is the same surface, same albedo,
    // same camera, with a cast shadow as the only difference. No albedo or
    // weather variance can leak into it.
    //
    // The target comes off plate 1's meadow, where a cast tree shadow on gold
    // measures srgb(148,106,47) luma 0.433 against sunlit gold at luma 0.69-0.73
    // — a shaded/sunlit display-luma ratio of about 0.60. Our sunlit gold sits
    // at 0.53-0.57 in the same frames, so the same ratio wants a separation of
    // 0.21-0.23. Measured across intensities:
    //           drive          meadow
    //   0.66    0.194          0.152
    //   0.78    0.233          0.187
    //   0.88    0.269          0.216
    // 0.82 lands drive ~0.25 and meadow ~0.20, i.e. the plate's ratio on both,
    // and it is still a long way from a hole: the shaded pixels come back a warm
    // srgb(126,73,42) at chroma 0.34, against a reference shadow that is warm
    // srgb(76,64,48) at its darkest. The reason a bigger number than 0.46 no
    // longer reads as harsh is that the softness comes from the map (PCF_SOFT at
    // a 150 m extent) rather than from the shadow being pale.
    // 0.74, down from 0.82, and the reason is that the shadow no longer has to
    // carry its own weight in value alone. With the cool rotation in Stylize
    // giving a cast shadow a different *hue* from the ground it lies on, it
    // reads as a shape at a shallower value drop than it needed when it was
    // only a darker gold — which is the trade every one of the reference plates
    // makes. Measured on the meadow view, dropping from 0.82 also took the blue
    // mass from chroma 0.111 to 0.144 without moving its luminance, because a
    // shadow with more sun in it has more chroma for the rotation to work with.
    // 0.62, down from 0.74. The cool cast-shadow mass in Stylize is no longer
    // luminance-preserving, so shadow depth and shadow hue are no longer
    // independent the way the old note in that file recorded — a darker shadow
    // now also makes the painted blue darker, and a dark saturated blue on gold
    // ground reads as water rather than as shade. Lighter shadow, high-value
    // mass, which is what the brief asks for in as many words: "a soft,
    // HIGH-VALUE violet-blue mass". Also back toward the 0.52 the art-director
    // correction originally asked for, without going all the way and losing the
    // shadow shapes that draw the forms.
    this.sun.shadow.intensity = 0.62;
    this._setShadowExtent(220);
    scene.add(this.sun);
    scene.add(this.sun.target);

    // Sky fill (cool) + ground bounce (warm). The split has to be *visible* —
    // the hemiSky keys used to be pinkish greys, so a shaded cliff got a warm
    // fill from both hemispheres and rendered dark chocolate brown, against a
    // brief that says rock is lavender-grey lit and violet-grey shaded and
    // never brown. It is still a tint, not a hue replacement: a shadow that has
    // gone saturated blue is a bug.
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1.1);
    scene.add(this.hemi);

    // Weak counter-key. Real golden hour has enough bounce off the valley that
    // shadowed faces never go to mud; without it the terminator reads as a
    // hard black edge, which is the single most "amateur" lighting tell.
    this.fill = new THREE.DirectionalLight(0xffffff, 0.34);
    scene.add(this.fill);

    // Fog is owned by Atmosphere (height-based aerial perspective).

    this._tmp = new THREE.Vector3();
    this._k = { sun: new THREE.Color(), hemiSky: new THREE.Color(), hemiGnd: new THREE.Color() };
    this._shadowsConfigured = false;
    this.update(0, new THREE.Vector3());
  }

  // ── time of day ────────────────────────────────────────────────────────────

  /** Sample the keyframe table at an arbitrary hour into `out`. */
  sampleKeys(hour, out = {}) {
    const h = ((hour % 24) + 24) % 24;
    let i = 0;
    while (i < BAKED.length - 2 && BAKED[i + 1].h <= h) i++;
    const a = BAKED[i], b = BAKED[i + 1];
    // Smoothstep between keys: linear ramps make the sunset visibly "kink"
    // as it crosses a keyframe when the cycle is running.
    const t = smoothstep(a.h, b.h, h);
    for (const f of COLOR_FIELDS) {
      (out[f] ??= new THREE.Color()).lerpColors(a[f], b[f], t);
    }
    for (const f of SCALAR_FIELDS) out[f] = lerp(a[f], b[f], t);
    return out;
  }

  /**
   * Sun direction from hour-of-day. Returns a shared temporary — copy it if
   * you need to keep it.
   */
  computeSunDir(hour) {
    const span = this.sunset - this.sunrise;
    const t = (hour - this.sunrise) / span;
    // pow > 1 flattens the ends of the arc, so "late afternoon" is genuinely
    // low-angle light rather than the 45° a plain sine would give.
    let elev;
    if (t < 0 || t > 1) {
      const night = t < 0 ? -t : t - 1;
      elev = -0.06 - Math.min(night * 1.6, 1) * 0.24;
    } else {
      elev = Math.pow(Math.sin(t * Math.PI), 1.6) * 0.95 - 0.015;
    }
    const az = this.azimuth + (clamp(t, -0.15, 1.15) - 0.5) * 2.4;
    const cosE = Math.sqrt(Math.max(1 - elev * elev, 0));
    return this._tmp.set(Math.cos(az) * cosE, elev, Math.sin(az) * cosE).normalize();
  }

  /**
   * The moon's direction.
   *
   * Deliberately NOT exactly anti-solar: a moon locked 180 deg from the sun is
   * always full and always rises at the instant the sun sets, which reads as a
   * mechanism rather than as a sky. Offsetting the arc by a fixed fraction of a
   * day gives a moon that is up for part of the night, at a believable angle to
   * the sun, and whose phase follows from that angle the way the real one does.
   */
  computeMoonDir(hour) {
    // Lags the anti-solar point by ~2.4 h, which is what puts the crescent
    // where the plates have it — high and to one side, not opposite the camera.
    const mh = (hour + 12 + 2.4) % 24;
    const span = this.sunset - this.sunrise;
    const t = (mh - this.sunrise) / span;
    let elev;
    if (t < 0 || t > 1) {
      const below = t < 0 ? -t : t - 1;
      elev = -0.06 - Math.min(below * 1.6, 1) * 0.24;
    } else {
      elev = Math.pow(Math.sin(t * Math.PI), 1.6) * 0.95 - 0.015;
    }
    const az = this.azimuth + (clamp(t, -0.15, 1.15) - 0.5) * 2.4;
    const cosE = Math.sqrt(Math.max(1 - elev * elev, 0));
    return (this._moonTmp ??= new THREE.Vector3())
      .set(Math.cos(az) * cosE, elev, Math.sin(az) * cosE).normalize();
  }

  // ── shadows ────────────────────────────────────────────────────────────────

  _setShadowExtent(e) {
    if (Math.abs(e - this.shadowExtent) < 0.5) return;
    const c = this.sun.shadow.camera;
    c.left = -e; c.right = e; c.top = e; c.bottom = -e;
    c.updateProjectionMatrix();
    this.shadowExtent = e;
    // Normal offset in *texels*, not metres. The quantity that decides whether
    // a surface shadows itself is how far the PCF kernel reaches in world
    // space, and that is one shadow texel — 0.107 m at ultra's 4096 map over a
    // 220 m extent, but 0.43 m at low's 1024. A constant metre value is
    // therefore simultaneously too large on the best preset (peter-panning
    // under ridgelines, which is what the old comment was reacting to) and far
    // too small on the worst.
    //
    // 5.5 texels. PCF_SOFT is a 2x2 bilinear-filtered kernel, so its penumbra
    // is about 1.5 texels; a receiver needs to clear its own caster by that
    // plus the depth-slope error, and small geometry has no depth slope to
    // spare. Below ~4 texels the ground-cover archetypes still self-shadow;
    // above ~7 the gap under a camper wheel becomes visible at 2 m. At ultra
    // this is 0.59 m against the old 0.35.
    this.sun.shadow.normalBias =
      SHADOW_NORMAL_BIAS_TEXELS * (2 * e / this.preset.shadowMapSize);
  }

  /**
   * VSM gave a soft edge for free but light-bleeds badly across a heightfield:
   * long shallow-slope receivers produced a regular plaid of half-lit texels
   * on every shaded mountain face. PCF-soft with a real normal offset is both
   * cheaper and clean. The renderer belongs to Engine, which system authors do
   * not edit, so this is a one-shot late binding via the debug surface.
   * See docs/INTEGRATION_REQUESTS.md.
   *
   * PCF_SOFT and not plain PCF, measured — see the note beside shadow.bias in
   * the constructor for the numbers. Plain PCF would let shadow.radius soften
   * the edge, which is what the art direction wants, and costs 55% at the
   * median frame time, which we do not have.
   *
   * The scene-wide needsUpdate below recompiles every program in the game in
   * one frame and shows up as a ~500 ms hitch at about 1.5 s into a run. It is
   * only here because these files may not edit Engine; if Engine sets
   * PCFSoftShadowMap at construction this whole method becomes a no-op. Logged
   * in docs/INTEGRATION_REQUESTS.md.
   */
  _configureShadows() {
    if (this._shadowsConfigured) return;
    const r = globalThis.__engine?.renderer;
    if (!r) return;
    this._shadowsConfigured = true;
    if (r.shadowMap.type !== THREE.PCFSoftShadowMap) {
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      // Materials compiled before the switch carry the old shadow defines.
      this.scene.traverse((o) => {
        const m = o.material;
        if (!m) return;
        if (Array.isArray(m)) m.forEach((x) => { x.needsUpdate = true; });
        else m.needsUpdate = true;
      });
      // Rebuild them all now rather than letting each one recompile the first
      // frame it happens to enter the frustum.
      //
      // Invalidating a material does not recompile it; the next *render* of an
      // object using it does. main.js warms the whole scene with
      // renderer.compile() before the first frame, but that runs before this
      // switch, so every one of those programs is thrown away here and rebuilt
      // lazily. Measured on a drive: the camper's seven materials and the first
      // wildlife material rebuilt at 0.62 s, 1.14 s and 1.15 s after the game
      // reported ready — as the camera rig swung the camper into view — and the
      // frame that caught the last of them took 508 ms. compile() walks
      // everything visible rather than everything in frustum, so doing it here
      // costs one stall on the first frame, where a loading screen is still up,
      // instead of three freezes in the first two seconds of play.
      const cam = globalThis.__engine?.camera;
      if (cam) r.compile(this.scene, cam);
    }
  }

  // ── per frame ──────────────────────────────────────────────────────────────

  update(dt, focus) {
    this._configureShadows();
    if (this.cycleSpeed) this.hour = (this.hour + dt * this.cycleSpeed) % 24;

    const dir = this.computeSunDir(this.hour);
    this.sunDir.copy(dir);

    const k = this.sampleKeys(this.hour, this._keys ??= {});
    const elev = dir.y;
    // 0 while the sun is under the horizon, 1 once it is properly up.
    const day = smoothstep(-0.08, 0.10, elev);

    // The key illuminates as a tint of a neutral, not as its authored hue. See
    // the note beside KEY_TINT. Applied here and not to the baked table so the
    // sun *disc* and the sky glow, published below from the same key, keep the
    // authored colour — a low sun looks orange because the disc is orange, not
    // because everything it touches is.
    this.sun.color.copy(k.sun);
    tintKey(this.sun.color,
      keyTintAmount(k.sun, this.keyTint ?? KEY_TINT, this.keySatMax ?? KEY_SAT_MAX));
    this.sun.intensity = k.sunI;
    this.sun.castShadow = k.sunI > 0.35;

    this.hemi.color.copy(k.hemiSky);
    this.hemi.groundColor.copy(k.hemiGnd);
    this.hemi.intensity = k.hemiI * AMBIENT_SCALE * this.ambientScale;

    // Counter-key sits opposite the sun and slightly above, so it fills the
    // shadow side without flattening the form.
    this.fill.position.copy(dir).multiplyScalar(-1).setY(0.42).normalize().multiplyScalar(400);
    // Warm the counter-key toward the key when the sun is low: at golden hour
    // the bounce off a gold valley floor is the dominant fill, and a purely
    // cool one drives every shaded face to the saturated blue the brief calls
    // out as a bug. Kept well short of fully warm, though — at 0.65 the fill
    // was almost pure ground bounce and a cast shadow on gold meadow rendered
    // as dark red-brown mud instead of the lighter, slightly cooled gold the
    // reference shows.
    const lowSun = 1 - smoothstep(0.06, 0.34, elev);
    this.fill.color.copy(k.hemiSky).lerp(k.hemiGnd, 0.18 + 0.24 * lowSun);
    this.fill.intensity = lerp(0.10, 0.24, day);

    // Atmosphere palette for this hour (main.js copies these into Atmosphere).
    (this.fogNear ??= new THREE.Color()).copy(k.fogNear);
    (this.fogFar ??= new THREE.Color()).copy(k.fogFar);
    (this.fogSun ??= new THREE.Color()).copy(k.fogSun);
    this.fogDensity = k.fogD * FOG_DENSITY_SCALE * this.fogScale;

    // Publish for Sky / Clouds.
    const s = SKY_STATE;
    s.sunDir.copy(dir);
    s.sunElev = elev;
    s.dayFactor = day;
    s.hour = this.hour;

    // ── moon and stars ──────────────────────────────────────────────────────
    // A placeholder arc that is *correct in kind*: the moon rides roughly
    // opposite the sun, so it is up when the sun is not, and it is a real
    // direction that a light and a disc can both be hung off. The author who
    // owns this file re-authors the numbers; the field contract is what the
    // dome is being built against right now.
    const md = this.computeMoonDir(this.hour);
    s.moonDir.copy(md);
    s.moonElev = md.y;
    // Up, and only once the sun is far enough down that it would actually read.
    const moonUp = smoothstep(-0.02, 0.12, md.y);
    const sunGone = 1 - smoothstep(-0.14, 0.02, elev);
    s.moonIntensity = moonUp * sunGone;
    // Astronomical rather than civil twilight: the sky is still bright enough
    // to wash out all but the brightest stars well after `dayFactor` hits 0.
    s.starAmount = 1 - smoothstep(-0.16, -0.03, elev);
    s.milkyWay = 1 - smoothstep(-0.20, -0.07, elev);
    s.nightFactor = 1 - day;
    s.zenith.copy(k.zen);
    s.horizon.copy(k.hor);
    s.sunHorizon.copy(k.sunHor);
    s.glow.copy(k.glow);
    s.glowIntensity = k.glowI;
    s.sunColor.copy(k.sun);
    s.sunIntensity = k.sunI;
    s.cloudLit.copy(k.cloudLit);
    s.cloudDark.copy(k.cloudDark);
    // Cloud ambient — the colour the underside and the cirrus veil fall back
    // to. It used to be hemiSky lerped toward cloudDark, and both were mauve,
    // so `ccol = mix(uAmbient, uLit, 0.62)` in Clouds put a lavender veil over
    // the whole upper sky in every daylight frame. Measured on `hero`: the top
    // of the sky rendered srgb(205,178,182) — B above G, i.e. literally
    // magenta-led — against plate 1's srgb(251,213,198) cream and
    // srgb(227,228,224) near-white. Hiding the cloud dome alone moved it to
    // srgb(215,188,173). The plates' skies are cream at the skyline going pale
    // and neutral upward; nothing in them is lilac.
    //
    // Pulling a third of the way to the horizon colour keeps the ambient a
    // *sky* colour rather than a pigment, and it tracks the time of day for
    // free because `hor` already does.
    s.cloudAmbient.copy(k.hemiSky).lerp(k.cloudDark, 0.45).lerp(k.hor, 0.34);
    s.cloudCover = k.cover;
    s.fogNear.copy(k.fogNear);
    s.fogFar.copy(k.fogFar);

    // ── shadow camera ────────────────────────────────────────────────────────
    if (focus) {
      // Grow the covered area when the camera climbs: a vista shot needs the
      // whole massif in frustum, an eye-level drive shot wants every texel it
      // can get.
      //
      // The old 520 m cap was the reason `peaks` had no value structure. From
      // a 350 m camera the mountains that fill the frame sit 600–1300 m out —
      // entirely outside the shadow frustum — so a 28° sun threw no ridge
      // shadows on them at all and the massif rendered as one flat tan mass
      // (contrastStd 0.087 against a reference band of 0.13–0.22). Terrain
      // already casts out to LOD 2 (~720 m); this is what lets those casters
      // land. At 900 m and a 4096 map that is 0.44 m per texel, which is soft
      // but perfectly clean at the distance the extent only reaches from.
      // Camera height is the only proxy available here for "how far away is the
      // thing being looked at", and it was under-reading: from the `peaks`
      // camera at 140 m the extent came out at 470 m while the massif filling
      // the frame sits 500–1500 m out, so none of it received a cast shadow and
      // it rendered as one flat cream mass (contrastStd 0.115 against a
      // reference band of 0.13–0.22). A steeper ramp reaches those casters and
      // leaves eye-level driving frames, where every texel counts, untouched.
      // ── AND IT HAS TO BE HEIGHT ABOVE THE *TERRAIN*, NOT ABOVE SEA LEVEL ──
      //
      // `focus` is the camera position, so `focus.y` is altitude. The wildlife
      // + vehicle author traced critic blocker 14 ("the camper casts no
      // shadow") to this line and their measurement is conclusive
      // (docs/INTEGRATION_REQUESTS.md, W1): the `vehicle` anchor sits on a
      // mountainside at y = 194 m with the camera 2.6 m above the ground, and
      // this formula read that as a 200 m aerial vista and clamped the extent
      // to the 900 m cap. Both biases are derived from the extent, so at the
      // cap the shadow test carries 0.75 m of normal offset and ~1.4 m of depth
      // slack — which skips every occluder whose standoff from its receiver is
      // under about a metre and a half. A 2.5 m camper is 13.5 texels across
      // the whole 4096 map there; it and every contact shadow in the frame
      // vanish, while ridge-scale casters survive, so the frame does not look
      // obviously broken until you go looking. They proved it by clamping the
      // extent to 170 m with nothing else changed and the camper's shadow came
      // straight back.
      //
      // Height above ground is what the reasoning above always meant by "when
      // the camera climbs", and it leaves the two frames that reasoning was for
      // exactly where they are: `hero` is 62 m over the vista and `peaks` 120 m
      // over a summit either way. What changes is that an eye-level frame is
      // now 150-170 m of extent wherever in the valley it happens to be, rather
      // than depending on the altitude of the ground under it.
      //
      // Read off the debug global defensively, same as _configureShadows does
      // for the renderer: Lighting is constructed before the world exists and
      // main.js is not ours to add a setter to. With no world this falls back
      // to the old behaviour rather than to a broken one.
      // The slope goes 4.0 -> 12.0 in the same move, and it has to: the two
      // readings are not on the same scale. W1's suggested patch keeps 4.0 and
      // states that `hero` and `peaks` land where they were, which is true only
      // if the valley floor is near sea level — it is not. `hero` sits 62 m over
      // ground at an absolute y of ~370 m, so the old formula gave it the 900 m
      // cap and the new one at 4.0 would give it 398, taking the distant ridge
      // casters straight back out of the frustum and undoing the reasoning
      // above. At 12.0 the mapping preserves both ends: `peaks` (120 m up) and
      // `hero` (62 m) are still at or within a few metres of the cap, `dawn`
      // (48 m) sits at 726, and every eye-level frame lands between 150 and
      // 200 m — `vehicle` at 2.6 m above the ground gets 181 m regardless of
      // which mountainside it is parked on, which is the whole point.
      const wd = globalThis.__world;
      const terrainY = wd?.getHeight ? wd.getHeight(focus.x, focus.z) : null;
      const above = Number.isFinite(terrainY) ? focus.y - terrainY : focus.y - 6;
      this._setShadowExtent(clamp(150 + Math.max(above, 0) * 12.0, 150, 900));

      const texelWorld = (this.shadowExtent * 2) / this.preset.shadowMapSize;
      const sx = Math.round(focus.x / texelWorld) * texelWorld;
      const sz = Math.round(focus.z / texelWorld) * texelWorld;
      // Push the target slightly down-sun so more of the frustum lands in
      // front of the camera rather than behind it.
      this.sun.target.position.set(sx, focus.y, sz);
      this.sun.position.copy(this.sun.target.position)
        .addScaledVector(dir, Math.max(this.shadowExtent * 2.4, 420));
      this.sun.target.updateMatrixWorld();
      this.sun.shadow.camera.far = Math.max(this.shadowExtent * 2.4, 420) + this.shadowExtent * 2;
      this.sun.shadow.camera.updateProjectionMatrix();

      // Both biases have to track the frustum, because the extent now spans
      // 150 m (eye level) to 900 m (vista) and a texel is six times wider at
      // the top of that range. The constants that were clean at 150 m produced
      // a regular diamond moiré of self-shadowing on every shallow distant
      // slope once the extent grew — classic acne, and very visible at driving
      // speed because it crawls. Normal offset does the real work; the depth
      // bias is kept small so ridgelines do not peter-pan.
      this.sun.shadow.normalBias = clamp(texelWorld * 1.7, 0.12, 0.90);
      this.sun.shadow.bias = -0.00018 - texelWorld * 0.0004;
    }
  }

  /**
   * P8 in docs/INTEGRATION_REQUESTS.md. `preset.shadowMapSize` is 4096 / 3072 /
   * 2048 / 1024 across the tiers, but it was only ever read in the constructor,
   * so a runtime tier step left the map at whatever it booted with —
   * `tools/_scratch/tierload.mjs` reported `shadow 4096` even at `low`. The
   * perf author measured the map alone at 1.06 MP over 24 interleaved cycles:
   * 4096 -> 3072 is -2.3%, -> 2048 is -6.5%, -> 1024 is -8.6%. That is most of
   * what stepping a tier down is supposed to buy, and we were not collecting it.
   */
  onQuality(preset) {
    if (!preset?.shadowMapSize) return;
    this.preset = preset;                       // both biases read through this
    const S = preset.shadowMapSize;
    if (this.sun.shadow.mapSize.x === S) return;

    this.sun.shadow.mapSize.set(S, S);
    // three allocates the depth target on first use and never re-checks
    // mapSize. Disposing it is the only thing that forces the reallocation.
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.sun.shadow.needsUpdate = true;

    // Both biases are derived from texel width, and a texel just changed width
    // by up to 4x. `_setShadowExtent` memoises on the extent and would early-
    // return, leaving the normal offset sized for the old map — that exact
    // mismatch is what made the camper's contact shadow disappear in W1. Clear
    // the memo and re-derive at the current extent.
    const e = this.shadowExtent;
    this.shadowExtent = -1;
    this._setShadowExtent(e);
  }

  dispose() {
    this.scene.remove(this.sun, this.sun.target, this.hemi, this.fill);
  }
}
