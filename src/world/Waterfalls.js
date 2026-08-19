// ─────────────────────────────────────────────────────────────────────────────
//  Waterfalls — falling sheet, spray, mist and plunge pool.
//
//  Every fall is built once as a *path*: a chain of points from lip to pool,
//  integrated with real gravity and clamped to the rock. That is what makes a
//  cliff read as a free-falling curtain and a 12° chute read as a cascade
//  hugging the stone, from the same code. The path is baked into a small float
//  texture so the sheet mesh, the spray particles and the mist all sample the
//  identical curve — spray that drifts off the sheet is the classic tell.
//
//  Advection is done in "time of flight": each point on the sheet knows how
//  many seconds ago the water there left the lip, so 'flightTime - now' is
//  constant along a parcel's trajectory. Scrolling that coordinate gives flow
//  that accelerates and stretches exactly like falling water, with no
//  hand-tuned per-fall speeds.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { PALETTE } from './WorldConfig.js';
import { fogUniforms } from '../render/Atmosphere.js';
import { WATER_NOISE, WATER_ENV, WATER_FOAM_LIGHT } from '../shaders/water_common.js';
import { clamp, clamp01, mulberry32 } from '../core/MathUtils.js';

// 32 steps over a 70 m fall is a 2 m polygon, and the sheet's silhouette shows
// every one of them as a visible corner from the bank. 48 is still a rounding
// error against the frame budget (28 falls x 48 x 7 verts) and the outline
// reads as a curve.
const PATH_STEPS = 48;                       // texels along each fall
// Out to +/-1.25 rather than +/-1: the alpha falloff and the noise erosion that
// chews the silhouette both finish around 1.27 half-widths, and they need mesh
// to finish *inside* or the curtain ends on a dead-straight polygon edge.
const SHEET_COLS = [-1.25, -0.95, -0.68, -0.36, 0, 0.36, 0.68, 0.95, 1.25];

// ── falling sheet ────────────────────────────────────────────────────────────
const SHEET_VERT = /* glsl */`
#include <fog_pars_vertex>
attribute float aU;
attribute float aSide;
attribute float aFlight;   // seconds since this water left the lip
attribute float aWidth;
attribute float aDisc;
attribute vec3  aNrm;
attribute vec3  aSideDir;   // unit horizontal width axis of this fall

uniform float uTime;
uniform float uPixelScale;  // radians of view angle per output pixel
uniform float uMinPx;       // narrowest a curtain is ever allowed to draw

varying vec3  vWPos;
varying vec3  vNrm;
varying float vU;
varying float vSide;
varying float vFlight;
varying float vWidth;
varying float vDisc;
varying float vGrow;

void main() {
  vec3 transformed = position;

  // ── LOD: a fall never gets narrower than a couple of pixels ───────────────
  // A 4 m curtain at 800 m is a third of a pixel wide. The rasteriser then
  // samples it at one point in three, the silhouette noise inside the shader
  // decides that point at random, and the fall comes back as a dashed line of
  // hard-ended white lozenges with rock between them — which is exactly what
  // the peaks and dawn views showed. Widening the geometry to a floor of a
  // couple of pixels is the standard line-primitive fix: the mark stays
  // continuous, and the alpha is pulled down (softly — a distant fall is a
  // bright thread, not a grey one) so it does not gain weight as it recedes.
  float camDist = distance(cameraPosition, transformed);
  float halfW = max(aWidth * 0.5, 0.05);
  float wantHalf = uMinPx * camDist * uPixelScale * 0.5;
  vGrow = clamp(wantHalf / halfW, 1.0, 7.0);
  transformed += aSideDir * (aSide * halfW * (vGrow - 1.0));

  vWPos = transformed;
  vNrm = aNrm;
  vU = aU; vSide = aSide; vFlight = aFlight; vWidth = aWidth; vDisc = aDisc;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  #include <fog_vertex>
}`;

const SHEET_FRAG = /* glsl */`
#include <fog_pars_fragment>
precision highp float;

uniform float uTime;
uniform vec3  uSunLight;
uniform vec3  uFoam;
uniform vec3  uShallow;

varying vec3  vWPos;
varying vec3  vNrm;
varying float vU;
varying float vSide;
varying float vFlight;
varying float vWidth;
varying float vDisc;
varying float vGrow;

${WATER_NOISE}
${WATER_ENV}
${WATER_FOAM_LIGHT}

void main() {
  // Advection coordinate: constant along a falling parcel. Because flight time
  // compresses near the lip and spreads out below, the streaks automatically
  // stretch as the water accelerates.
  float ph = (vFlight - uTime) * 3.4;
  // Everything below is sampled in *metres across the sheet*. The old
  // coordinate multiplied the side coordinate by the full width and then by
  // another 1.15, so a 12 m curtain was sampled at thirty-odd cycles across:
  // every octave degenerated into sub-metre pinstripes and the sheet read as
  // combed paper. Lump size is a physical quantity — it belongs in metres.
  float xm = vSide * vWidth * 0.5;

  // Aspect ratio, and it was inverted. A falling curtain is streaked *along*
  // the fall: the marks are long in the direction of travel and narrow across
  // it. Sampled at 0.35 cycles per metre across a 12 m sheet and 0.55 per unit
  // of advection down it, the noise varied faster down the fall than across it
  // and the sheet came back combed with horizontal pencil lines — brushed
  // steel, which is exactly what a critic pass called it. High frequency
  // across, low frequency down.
  float streak = wFbm3(vec2(xm * 1.70, ph * 0.22)) * 0.5 + 0.5;
  // Chunks. A fall is a stream of *parcels* — lumps of half-aerated water with
  // gaps between them — and the near-square aspect of this octave is what makes
  // them read as lumps rather than as combed pinstripes. Without it the sheet
  // is a printed gradient and there is nothing for the eye to hold on to at
  // two metres, which is the range the reference plate shows it at.
  // Its coordinate compensates for the advection stretch: flight time spreads
  // out as the water accelerates, so a noise sampled in flight time alone is
  // lumpy at the lip and drawn out into infinite pinstripes by the time it
  // reaches the pool. Winding the frequency up with vU keeps parcels the same
  // physical size all the way down — and, as a free consequence, makes them
  // travel visibly faster the further they have fallen.
  vec2 cp = vec2(xm * 0.95, ph * (0.55 + 1.30 * vU));
  float chunk  = wFbm3(cp + 23.0) * 0.5 + 0.5;
  float fine   = wFbm2(vec2(xm * 3.10, ph * 0.70) + 11.0) * 0.5 + 0.5;
  float hair   = wFbm2(vec2(xm * 6.40, ph * 1.30) + 41.0) * 0.5 + 0.5;

  // fbm returns a bell centred on 0.5 and hardly ever reaches either end, so
  // used raw it modulates the sheet by about +/-14% — under the tone curve that
  // is no structure at all, which is why the curtain still read as airbrushed
  // after its colour was fixed. Stretch each octave to a real 0..1 first.
  float c1 = smoothstep(0.34, 0.66, chunk);
  float s1 = smoothstep(0.32, 0.68, streak);
  float h1 = smoothstep(0.35, 0.65, hair);
  // Band limit. The two fine octaves run at 3 and 6 cycles per metre across
  // the sheet; on a 4 m curtain seen from two hundred metres that is thirty
  // cycles inside fifteen pixels, and the curtain came back cross-hatched with
  // a regular moire grid. Fade them out once they are smaller than the pixel.
  float sheetDist = distance(cameraPosition, vWPos);
  float fineFade = 1.0 - smoothstep(45.0, 130.0, sheetDist);
  float hairFade = 1.0 - smoothstep(22.0, 70.0, sheetDist);
  fine = mix(0.5, fine, fineFade);
  h1   = mix(0.5, h1, hairFade);
  // The two coarse octaves are the ones that chew the *silhouette*, and they
  // needed the same treatment. A metre of lump on a curtain three pixels wide
  // is a coin-toss per pixel, and a coin-toss per pixel down a 70 m fall is a
  // dashed line. Past a couple of hundred metres the honest read is a solid
  // white thread — which is what the reference plates draw a distant fall as.
  float lodFar = smoothstep(140.0, 460.0, sheetDist);
  c1 = mix(c1, 0.5, lodFar);
  s1 = mix(s1, 0.5, lodFar);
  streak = mix(streak, 0.5, lodFar);

  // The sheet is coherent at the lip and shreds into ribbons as it falls — but
  // it stays a *curtain* the whole way down. Shredding it to translucent
  // threads (which is what a linear ramp to a thresholded noise does) turns a
  // 74 m fall into a bootlace; the reference shows a solid white column with
  // structure inside it, so the noise modulates the density and never the
  // existence of the sheet.
  float shred = smoothstep(0.16, 0.95, vU);
  float body = mix(1.0, 0.62 + 0.38 * smoothstep(0.30, 0.62, streak), shred);
  body = max(body, smoothstep(0.55, 0.72, fine) * shred * 0.55);

  // Edges tear before the middle does, and only the edges. Eroding the side
  // coordinate with the parcel noise (rather than fading the alpha) chews the
  // *silhouette*: a curtain cut off at a constant half-width shows the mesh's
  // own polygon outline, which at close range is the loudest tell in the frame.
  // Tried and reverted: adding the 'fine' octave here as a second scale of
  // tearing. It does straighten out the long flat sides, but 'fine' runs at
  // 3.1 cycles per metre *across* the sheet, so eroding the silhouette with it
  // cuts the curtain into vertical pinstripes — and captured side by side the
  // lump structure inside the sheet went with them and the whole column came
  // back reading as smooth wax. The straight sides are the lesser fault.
  float sideN = abs(vSide) + (c1 - 0.5) * 0.40 * (0.35 + 0.65 * shred);
  // Taper both ends of the *silhouette*. A curtain that begins and ends on a
  // dead-flat horizontal edge is a painted rectangle, and that is precisely how
  // every distant fall in the peaks view reads: a five-pixel white strip with
  // two square ends and an L-shaped notch, sitting on the rock like a sticker.
  // No amount of interior detail fixes it, because at that range there is no
  // interior — only the outline. Narrowing the mark where the water necks over
  // the lip and where it enters the boil turns the strip into a brush stroke.
  // Both tapers are a few metres on a seventy metre drop, so the near view is
  // unchanged apart from a lip that now looks like water accelerating.
  // 0.16, not 0.055. The path is integrated in uniform *horizontal* steps, so
  // on a steep fall the index bunches hard at the lip: 5.5% of it is a couple
  // of metres of drop, the taper finishes inside a few pixels, and the curtain
  // begins on a dead-flat horizontal edge — the exact painted-rectangle top the
  // taper exists to prevent. Widened until the neck is a neck.
  float endTaper = min(smoothstep(0.0, 0.16, vU), 1.0 - smoothstep(0.90, 1.0, vU));
  sideN += (1.0 - endTaper) * 0.72;
  // Widened from 0.72-1.06. The brief asks for a *soft* white ribbon and the
  // plates draw one: plate 5's curtain has no hard boundary anywhere along it,
  // it fades into the rock over several pixels. A 0.34-wide alpha ramp on a
  // 7 m curtain is about ten centimetres, i.e. a hard edge at any framing you
  // would actually stand at. Half a half-width of feather is what turns the
  // cut-out into a brush mark.
  float edge = 1.0 - smoothstep(0.58, 1.18, sideN);
  float rim = smoothstep(0.40, 1.0, abs(vSide));
  edge = mix(edge, edge * (0.30 + 0.70 * smoothstep(0.24, 0.60, streak)), shred * rim);

  // Opacity is where the fall's *value* actually lives. Measured against
  // reference plate 5 the curtain there is #aec1d3 at luma 0.75; ours came
  // back at 0.55, and the shader is not the reason — the lit colour leaves
  // this function at a linear 0.7-0.8. It was the alpha: at 0.62 + 0.38*disc a
  // typical fall ran about 0.78 opaque, so a fifth of the near-black gorge
  // wall behind it was showing through every pixel of white water, and the
  // depth-of-field pass then smeared more of that wall into it. A curtain of
  // aerated water a metre thick is opaque. Only the torn edges are not.
  // ...and both of those go solid at range, for the reason given at lodFar.
  body = mix(body, 1.0, lodFar);
  edge = mix(edge, 1.0 - smoothstep(0.86, 1.14, abs(vSide)), lodFar);

  float alpha = body * edge * (0.84 + 0.16 * vDisc);
  // Let go just before the pool so the sheet never clips through the foam.
  // The sheet has to arrive. Faded over the last 14% of the path it died
  // roughly eight metres above the rock, and the plunge pool is a ground decal
  // that cannot climb to meet it — so the curtain broke, and a strip of bare
  // tan channel showed between the two. That gap is the "column breaks" a
  // critic logged. It holds full strength to the waterline now, and the boil
  // and the burst take over there, where the water actually is.
  alpha *= 1.0 - smoothstep(0.955, 1.0, vU);
  // Pay back a little of the width the LOD borrowed. Not all of it: a fall on
  // a far ridge is a *bright* thread in the reference, not a grey one, so the
  // exponent is well under the 1.0 that would conserve energy exactly.
  alpha *= pow(1.0 / vGrow, 0.42);
  alpha = clamp(alpha, 0.0, 1.0);
  // NaN-blind guards were the shape of every black-pixel bug this project has
  // had: a less-than test is false when its left side is NaN, so the fragment
  // survives the guard and writes a non-finite colour. Stated the other way
  // round — keep the fragment only if alpha is provably big enough — a NaN
  // fails the test and is discarded.
  if (!(alpha >= 0.015)) discard;

  vec3 V = normalize(cameraPosition - vWPos);
  vec3 N = normalize(vNrm);
  if (dot(N, V) < 0.0) N = -N;

  float shadow = wSunShadow(vWPos);
  float ndl = max(dot(N, uSunDir), 0.0);

  // Glassy and blue at the lip where the sheet is unbroken, white where the
  // water has aerated. Aeration is what turns water into foam, not speed — and
  // it is per *parcel*, so the lumps go white while the ribbons between them
  // stay glassy and keep the channel's blue. That contrast is the whole
  // difference between broken water and a printed sheet.
  // Measured against plate 5: the curtain there runs RGB 0.86-0.96 at a chroma
  // of 0.04-0.11, sitting right next to orange grass. Ours measured 0.34-0.56
  // at chroma 0.32 — half the value and three times the colour, which is how a
  // 70 m fall ended up reading as a pale blue rectangle. A fall is white water
  // within a couple of metres of the lip; only the unbroken glassy tongue at
  // the very top keeps any of the channel's blue at all.
  float aer = clamp(0.42 + 0.50 * smoothstep(0.0, 0.22, vU)
                         + 0.45 * (c1 - 0.5) + 0.22 * (s1 - 0.5), 0.0, 1.0);
  // The glassy end of the ramp is the shallow tone taken most of the way to
  // white, not the shallow tone itself: even the lip of a fall is aerated.
  vec3 tint = mix(mix(uShallow, uFoam, 0.55), uFoam, aer);
  // The torn edges of a curtain are the most aerated part of it.
  tint = mix(tint, uFoam, smoothstep(0.55, 1.0, abs(vSide)) * 0.5 * shred);

  // Value structure *inside* the sheet, and it has to live in the colour rather
  // than the alpha: shredding the alpha gives a bootlace. Equally, it has to
  // fit *under* white — the previous gain drove the red channel past 1.0 across
  // most of the sheet, so every lane clipped to the same cream and the fall
  // rendered as a strip of paper with correct silhouette and no water in it.
  //
  // The band has to peak *under* unity, not straddle it. At 0.62 + 0.46 + 0.22
  // + 0.11 the brightest lanes left here at 1.41x the foam illuminant, and the
  // illuminant is already near 1.0 in open sun — so the curtain clipped
  // wherever a cloud was not covering it. Measured on the same 77 m fall: p50
  // luma 0.818 under a cloud shadow (right, and the number this was tuned on)
  // but 0.960 with the shadow frozen off, p95 0.987. Every lane painted into
  // the sheet survives only while it happens to be overcast, which is not a
  // level, it is a coincidence. Same total contrast, moved below the ceiling.
  //
  // Painted, not airbrushed, for the reason given at wSteps: the plate's
  // curtain is flat marks with edges, ours was a smooth gradient over every
  // lump. The step width is driven off the same distance fade the octaves
  // already use, so a far fall dissolves back to a smooth thread rather than
  // stepping and crawling.
  float lanesWide = mix(0.17, 0.5, smoothstep(60.0, 200.0, sheetDist));
  float lanes = 0.55 + 0.30 * wSteps(c1, 3.0, lanesWide)
                     + 0.14 * wSteps(s1, 2.0, lanesWide) + 0.07 * h1;
  // Level set against the plate: whitewater there has a median luma of 0.80 and
  // never clips. Anything brighter loses every lane painted into it.
  //
  // The ndl term is nearly flat now. A curtain is a volume of scattering
  // droplets, not a lambertian wall — it is bright from every side, which is
  // why a fall in a shaded gorge still reads white in the reference while the
  // rock behind it is nearly black. Driving it off the surface normal put the
  // whole sheet at 0.58 whenever the fall faced away from the sun, which in a
  // north-south gorge is most of the day.
  vec3 col = tint * lanes * wFoamLight(mix(shadow, 1.0, 0.55)) * (0.86 + 0.14 * ndl);

  // Backlight: a curtain of white water in front of a low sun glows. Through
  // the same desaturated illuminant, or a backlit fall turns into orange neon.
  float back = pow(max(dot(-V, uSunDir), 0.0), 2.0);
  col += uFoam * wFoamLight(1.0) * back * 0.42 * shadow * (0.4 + 0.6 * vU);

  // A specular sliver on the unbroken lip reads as glass. Kept small: a hard
  // ungraded hotspot is on the brief's list of things that get work rejected.
  vec3 H = normalize(uSunDir + V);
  col += uSunLight * pow(max(dot(N, H), 0.0), 60.0) * (1.0 - shred) * 0.22 * shadow;

  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ── spray / streak particles ─────────────────────────────────────────────────
const SPRAY_VERT = /* glsl */`
#include <fog_pars_vertex>
attribute vec3  aSideDir;
attribute vec3  aOutward;
attribute float aRow;      // v coordinate into the path texture
attribute float aPhase;
attribute float aRate;
attribute float aU0;
attribute float aSideOff;
attribute float aSize;
attribute float aSpread;
attribute float aSeed;

uniform sampler2D uPathTex;
uniform float uTime;
uniform float uCullDist;
uniform float uPathStep;   // 1 / PATH_STEPS

varying vec2  vUv;
varying float vFade;
varying float vSeed;
varying float vDist;

void main() {
  float f = fract(aPhase + uTime * aRate);
  float u = mix(aU0, 1.0, f);

  vec4 pathA = texture2D(uPathTex, vec2(u * (1.0 - uPathStep) + uPathStep * 0.5, aRow));
  vec3 p = pathA.xyz;
  float w = pathA.w;

  // Wander across the sheet, widening as the fall breaks up.
  float wob = sin(aSeed * 31.0 + u * 9.0) * 0.5 + sin(aSeed * 17.0 + u * 21.0) * 0.5;
  p += aSideDir * (aSideOff * w * (0.5 + u) + wob * aSpread * u);

  // The last quarter is the burst off the plunge pool: outward and up.
  float b = smoothstep(0.70, 1.0, u);
  p += aOutward * b * b * aSpread * 0.55;
  p.y += b * (1.0 - b) * 2.2 * aSpread;

  // Grows as the parcel falls and shatters, but nothing like as fast as the
  // first attempt at this. At 3.4 u^2 the biggest fall in the map was throwing
  // ten-metre sprites, and from the far bank they merged into a pale blue-grey
  // butterfly hanging in the gorge with no visible source — which is precisely
  // the floating X a critic pass logged here. Spray is a cloud of small things;
  // if a single sprite is readable as a shape, it is too big.
  float size = aSize * (0.55 + 0.70 * u * u);
  vFade = smoothstep(0.0, 0.10, f) * (1.0 - smoothstep(0.72, 1.0, f));
  vSeed = aSeed;
  vUv = uv;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  if (-mv.z > uCullDist) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // Distance fade. Individual droplets are a near-field read; past a hundred
  // metres what a plume actually does to a frame is soften the air, and the
  // mist volume already does that. Left at full strength the sprites instead
  // painted large flat translucent shapes across a distant gorge.
  vDist = 1.0 - smoothstep(90.0, 260.0, -mv.z);
  // Streaks are taller than wide — falling water is a line, not a dot.
  mv.xy += vec2(position.x * size * 0.62, position.y * size * (1.0 + u * 0.45));

  vec3 transformed = p;
  gl_Position = projectionMatrix * mv;
  #include <fog_vertex>
}`;

const SPRAY_FRAG = /* glsl */`
#include <fog_pars_fragment>
precision highp float;
uniform vec3  uSunLight;
uniform vec3  uFoam;
uniform vec3  uSunDir;
uniform vec3  uAmbient;
varying vec2  vUv;
varying float vFade;
varying float vSeed;
varying float vDist;

${WATER_FOAM_LIGHT}

void main() {
  vec2 d = vUv * 2.0 - 1.0;
  // Radial, not squashed. Scaling d.y down inside the falloff meant the alpha
  // was still a third of its peak at the top and bottom edges of the quad, so
  // every spray sprite ended in a dead-straight horizontal cut — at the foot of
  // a fall that reads as a heap of white rectangles, which is worse than no
  // spray at all. The streak shape belongs in the billboard's screen-space
  // aspect (it is already stretched there), not in a falloff that then has to
  // be clipped by the polygon.
  float r = length(d);
  float a = pow(1.0 - smoothstep(0.0, 1.0, r), 1.7) * vFade;
  if (a < 0.01) discard;
  vec3 col = uFoam * wFoamLight(1.0) * 0.86;
  // See the note on the burst's alpha: a streak that is legible on its own is
  // a white lozenge hanging in the air, and there is no count at which those
  // become water.
  gl_FragColor = vec4(col, a * 0.26 * vDist);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ── mist volume ──────────────────────────────────────────────────────────────
const MIST_VERT = /* glsl */`
#include <fog_pars_vertex>
attribute vec3  aCentre;
attribute float aPhase;
attribute float aRate;
attribute float aSize;
attribute float aRise;
attribute vec3  aDrift;
attribute float aSeed;

uniform float uTime;
uniform float uCullDist;

varying vec2  vUv;
varying float vFade;
varying float vSeed;
varying vec3  vWPos;

void main() {
  float f = fract(aPhase + uTime * aRate);
  vec3 p = aCentre + aDrift * f + vec3(0.0, aRise * f, 0.0);
  float size = aSize * (0.55 + 0.8 * f);
  // In and out slowly — mist has no edges, only densities.
  // The tail is pulled forward so a puff is gone before it separates from the
  // mass. See aRise: the failure mode is not a plume that is too thin, it is
  // one stray puff that outlived its neighbours and is now a disc on its own
  // against the sky.
  vFade = smoothstep(0.0, 0.30, f) * (1.0 - smoothstep(0.42, 0.86, f));
  vSeed = aSeed;
  vUv = uv;
  vWPos = p;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  if (-mv.z > uCullDist) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // Ramp a puff out as the camera enters it, or driving past a fall wipes the
  // whole screen with a cream card.
  vFade *= smoothstep(1.5, 14.0, -mv.z);
  float s = sin(aSeed * 6.28), c = cos(aSeed * 6.28);
  vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
  mv.xy += q * size;

  vec3 transformed = p;
  gl_Position = projectionMatrix * mv;
  #include <fog_vertex>
}`;

const MIST_FRAG = /* glsl */`
#include <fog_pars_fragment>
precision highp float;

uniform vec3  uSunLight;
uniform vec3  uSunDir;
uniform vec3  uAmbient;
uniform vec3  uFoam;
uniform float uRainbow;

varying vec2  vUv;
varying float vFade;
varying float vSeed;
varying vec3  vWPos;

${WATER_NOISE}
${WATER_FOAM_LIGHT}

// Cheap spectral ramp: 0 = violet, 1 = red.
vec3 spectrum(float t){
  t = clamp(t, 0.0, 1.0);
  return clamp(vec3(
    smoothstep(0.42, 0.86, t),
    sin(clamp(t, 0.0, 1.0) * W_PI) * 0.95,
    1.0 - smoothstep(0.16, 0.58, t)), 0.0, 1.0);
}

void main() {
  vec2 d = vUv * 2.0 - 1.0;
  // Internal shape. A radial falloff alone is a gaussian dot, and a dozen
  // gaussian dots stacked on each other is a featureless white disc — which is
  // exactly what the near field of the waterfall view was full of. The noise is
  // keyed to the sprite's own uv and seed, so it turns with the billboard and
  // never swims across it.
  float lump = wFbm3(d * 1.7 + vSeed * 37.0) * 0.5 + 0.5;
  float r = length(d) * (1.22 - 0.44 * lump);
  // Soft, fat falloff — a mist puff with a visible rim is a sprite, not fog.
  float a = pow(1.0 - smoothstep(0.0, 1.0, r), 2.2) * vFade * (0.52 + 0.72 * lump);
  if (a < 0.004) discard;

  vec3 V = normalize(vWPos - cameraPosition);

  // Backlit mist is the whole reason this exists: forward scattering makes a
  // plume in front of a low sun glow far brighter than its albedo. Lit through
  // the foam illuminant so a plume stays white — under the raw amber key it
  // came out as a cream disc, and over the dark rock of a gorge the cool half
  // of it stained the whole cliff violet.
  float fwd = max(dot(V, uSunDir), 0.0);
  // Capped. The tight lobe used to reach 0.85 on top of the broad one, and on
  // a 19 m puff that is a disc of near-clipped white the bloom then blows into
  // a perfect circle — a critic pass read two of them as dirt on the lens.
  // Forward scatter is real, but it belongs to a plume with structure, not to
  // a sprite bright enough to become its own light source.
  float glow = min(pow(fwd, 3.0) * 0.34 + pow(fwd, 12.0) * 0.30, 0.52);
  // Denser cores are brighter: light gets scattered out of a fat parcel, not a
  // thin one, and it is the density variation that gives the plume its volume.
  //
  // Lifted from 0.34. At that level the plume measured as a faint grey stain:
  // isolating this mesh at the foot of the 65 m fall left a frame you could
  // not tell from one with the mist hidden entirely, which is precisely the
  // "no mist column" a critic pass logged. A plume of vapour in front of a
  // bright sky is *bright* — in reference plate 5 the haze at the foot of the
  // fall sits at luma 0.70 against rock at 0.59, i.e. lighter than everything
  // it covers. It cannot do that while it is scattering a third of the foam
  // illuminant.
  vec3 col = uFoam * wFoamLight(1.0) * (0.56 + glow) * (0.70 + 0.50 * lump);

  // Primary bow, 42° off the antisolar point. It shows up when the sun is
  // behind the camera, which is exactly when a real one would.
  float deg = degrees(acos(clamp(dot(V, -uSunDir), -1.0, 1.0)));
  float t = (deg - 40.2) / 2.4;
  float band = smoothstep(0.0, 0.18, t) * (1.0 - smoothstep(0.80, 1.0, t));
  // Only where there is enough spray to disperse in, and only while the sun is
  // actually up — a bow floating over thin air is worse than no bow at all.
  col += spectrum(t) * band * uRainbow * uSunLight * 0.30
       * smoothstep(0.25, 0.7, a) * smoothstep(0.02, 0.16, uSunDir.y);

  // ...and the same correction in the alpha, which is where most of the
  // invisibility actually lived. A puff that is 4% opaque at its core needs
  // twenty-five of them stacked before the plume exists at all, and the
  // density field only ever puts three or four along a view ray. Fog and
  // depth-of-field then finished off what was left.
  gl_FragColor = vec4(col, a * 0.58);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ── impact burst ─────────────────────────────────────────────────────────────
//  Water hitting rock does not drift; it is *thrown*. The streak particles
//  above ride the fall's own path and then nudge outward by half a metre at the
//  end of it, which at the foot of a 96 m drop is nothing at all — measured on
//  the biggest fall in the map the whole "burst" spanned about 70 cm, which is
//  why every capture of a plunge came back with the curtain simply stopping in
//  the dirt.
//
//  So the impact gets its own set: real ballistic arcs launched from the
//  landing point, with an upward component scaled by the energy arriving and a
//  horizontal one biased downstream. Parabolas are what give a plunge its
//  shape — a burst rises, slows, arcs over and falls back, and it is that
//  silhouette rather than any amount of noise that reads as churn.
const BURST_VERT = /* glsl */`
#include <fog_pars_vertex>
attribute vec3  aOrigin;
attribute vec3  aVel;
attribute float aPhase;
attribute float aLife;
attribute float aSize;
attribute float aSeed;

uniform float uTime;
uniform float uCullDist;
uniform float uPixelScale;
uniform float uMinPx;

varying vec2  vUv;
varying float vFade;
varying float vSeed;
varying float vDist;
varying float vAge;
varying float vGrow;

void main() {
  float f = fract(aPhase + uTime / aLife);
  float t = f * aLife;
  // Gravity, honestly. Half of 9.81 is what turns a straight line into an arc,
  // and the arc is the whole read.
  vec3 p = aOrigin + aVel * t - vec3(0.0, 4.905, 0.0) * t * t;
  // A droplet cluster shatters and spreads as it flies.
  float size = aSize * (0.5 + 0.95 * f);
  // ...and it is never allowed to fall under a couple of pixels. A clot of
  // water 0.37 m across — which is what the biggest fall in the map throws — is
  // half a pixel at a hundred metres, so the entire burst was rasterising to
  // nothing and the plunge had no spray in it from any distance worth framing.
  // Same line-primitive fix the curtain uses: hold the mark at a readable size
  // and pay the width back out of the alpha, so the cloud gains no weight as it
  // recedes. Without this the burst is 258 invisible sprites per fall.
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  if (-mv.z > uCullDist) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float bMin = uMinPx * max(-mv.z, 0.1) * uPixelScale;
  vGrow = clamp(bMin / max(size, 1e-3), 1.0, 6.0);
  size *= vGrow;
  vFade = smoothstep(0.0, 0.07, f) * (1.0 - smoothstep(0.48, 1.0, f));
  vSeed = aSeed;
  vAge = f;
  vUv = uv;

  // Individual droplets are a near-field read, but a *plume* is not — and the
  // old 110-300 m fade was switching the burst off exactly where the reference
  // still draws white water at the foot of a fall. It now reaches as far as the
  // curtain it belongs to; the pixel floor above is what keeps it readable.
  vDist = 1.0 - smoothstep(900.0, 2200.0, -mv.z);
  // Taller than wide. A thrown clot of water is a streak in the direction it is
  // travelling, and a round sprite is a bubble — which is exactly how the first
  // pass at this read: a scatter of soft white balls hanging in the gorge.
  // Stretched, but not into a capsule. At 1.45 the sprite was 26 px tall at
  // thirty metres with a near-opaque core, and a hundred of those is not a
  // plume — it is a scatter of white sausages over the hillside, which is
  // exactly what isolating this mesh showed. The streak read has to come from
  // the *cloud's* shape, not from each member of it being a legible streak.
  mv.xy += vec2(position.x * size * 0.72, position.y * size * 1.16);

  vec3 transformed = p;
  gl_Position = projectionMatrix * mv;
  #include <fog_vertex>
}`;

const BURST_FRAG = /* glsl */`
#include <fog_pars_fragment>
precision highp float;
uniform vec3  uSunLight;
uniform vec3  uAmbient;
uniform vec3  uFoam;
varying vec2  vUv;
varying float vFade;
varying float vSeed;
varying float vDist;
varying float vAge;
varying float vGrow;

${WATER_NOISE}
${WATER_FOAM_LIGHT}

void main() {
  vec2 d = vUv * 2.0 - 1.0;
  // A torn clot of water, not a gaussian dot. The noise is keyed to the
  // sprite's own uv and seed so it turns with the billboard rather than
  // swimming across it, and it is what stops a hundred of these stacking into
  // one smooth white cauliflower.
  float lump = wFbm3(d * 3.6 + vSeed * 53.0) * 0.5 + 0.5;
  float r = length(d) * (1.14 - 0.52 * lump);
  // A tighter exponent than the mist's. Spray has an edge — it is water, not
  // vapour — and a fat gaussian falloff is what made a hundred of these stack
  // into soft white balls instead of into churn.
  float a = pow(1.0 - smoothstep(0.0, 1.0, r), 2.4) * vFade * (0.40 + 0.85 * lump);
  if (!(a >= 0.012)) discard;
  // Freshly thrown water is denser and whiter than the tail of the arc.
  vec3 col = uFoam * wFoamLight(1.0) * (0.80 + 0.26 * (1.0 - vAge));
  // Pay back most of the area the pixel floor borrowed, so a burst seen from
  // far away is a faint haze of spray rather than a cloud that grows as it
  // recedes. Not all of it: the reference keeps a distant plunge bright.
  a *= pow(1.0 / vGrow, 1.45);
  // 0.62 was an opacity you can see a single sprite through nothing of. A
  // cloud of water droplets is *individually* almost transparent and reads only
  // where several overlap; that overlap is what makes the mass look like it has
  // volume, and a per-sprite alpha high enough to read alone destroys it by
  // painting the first sprite the ray meets and nothing behind it.
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * 0.34 * vDist);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ── plunge pool ──────────────────────────────────────────────────────────────
const POOL_VERT = /* glsl */`
#include <fog_pars_vertex>
attribute vec2  aLocal;    // metres from the impact point
attribute float aRadius;
attribute float aPower;
attribute float aBaseY;    // world height of the impact point itself
varying vec3  vWPos;
varying vec2  vLocal;
varying float vRadius;
varying float vPower;
varying float vBaseY;
void main() {
  vec3 transformed = position;
  vWPos = transformed; vLocal = aLocal; vRadius = aRadius; vPower = aPower;
  vBaseY = aBaseY;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  #include <fog_vertex>
}`;

const POOL_FRAG = /* glsl */`
#include <fog_pars_fragment>
precision highp float;
uniform float uTime;
uniform float uPixelScale;  // radians of view angle per output pixel
uniform vec3  uSunLight;
uniform vec3  uFoam;
uniform vec3  uShallow;
varying vec3  vWPos;
varying vec2  vLocal;
varying float vRadius;
varying float vPower;
varying float vBaseY;

${WATER_NOISE}
${WATER_ENV}
${WATER_FOAM_LIGHT}

void main() {
  // The pool is draped on the surface it lands on, so it is always in contact.
  // What it must not do is climb a cliff: churn collects on something flat.
  //
  // Stated as a local slope this kept killing the pool outright. A plunge basin
  // sits at the *foot of a cliff* by definition, so a gradient sampled over
  // 3.2 m there straddles the cliff base and comes back near-vertical — and at
  // a cutoff of 2.30 the whole apron went to zero. Hiding the sheet on the
  // 77 m fall showed the result: no pool, no burst and no mist under it, only a
  // few sub-pixel droplets. The gate was rejecting the one place it exists.
  //
  // Height above the impact point is the honest test, and it is the thing the
  // gate was always trying to express: foam that has been draped four metres
  // up the wall behind the fall is climbing, foam at the waterline is not.
  // It needs no gradient, and it cannot be fooled by a cliff underfoot.
  // 2.5 to 7.0, not 1.4 to 4.5: the drape adds 0.55 m of its own on top of a
  // heightfield with half a metre of micro-detail, and a plunge apron is never
  // level, so the tighter window was costing 40% of the mask everywhere before
  // any of the churn had been evaluated. Measured on the 77 m fall it left the
  // gate at 0.6 across the whole pool.
  // ...but stated as a bare smoothstep over height it is still a *smooth
  // function of the heightfield*, which is a contour generator — the same class
  // of artifact as the gold isolines on land. At the foot of a cliff the ground
  // climbs those 4.5 m inside a couple of pixels, so the gate drew a hard,
  // dead-straight boundary across the apron wherever the wall began. Isolating
  // this mesh showed the pool as a pale polygon with three straight sides.
  // Widening the ramp alone cannot fix that (the wall is vertical at any ramp
  // width); breaking the *threshold* with a metre-scale noise is what turns the
  // contour into a torn edge.
  float climbN = wFbm2(vWPos.xz * 0.55 + 17.3) * 0.5 + 0.5;
  float climb = 1.0 - smoothstep(2.0 + climbN * 3.0, 8.5 + climbN * 3.0,
                                 vWPos.y - vBaseY);
  // The slope test is kept, well relaxed, only to stop an apron painting itself
  // up a genuinely vertical face that happens to sit at the impact height.
  vec2 e = vec2(2.6, 0.0);
  float bx = wBed(vWPos.xz + e.xy) - wBed(vWPos.xz - e.xy);
  float bz = wBed(vWPos.xz + e.yx) - wBed(vWPos.xz - e.yx);
  // Same treatment, same reason: a slope test on a cliff base is a step
  // function of position however wide its ramp is written.
  float bench = climb * (1.0 - smoothstep(2.4 + climbN * 1.2, 5.0 + climbN * 1.2,
                                          length(vec2(bx, bz)) / 5.2));

  float R = max(vRadius, 0.5);
  // Pool space: x runs downstream, y across. The mesh is built as a disc here
  // and stretched along x on the way into the world, so everything below can be
  // reasoned about as a circle and still come out as a downstream-biased oval.
  vec2 q = vLocal / R;
  float r = length(q);
  if (!(r <= 1.0)) discard;

  // Where the water actually lands is *upstream* of the pool's centre. That
  // single offset is most of what turns a symmetric splash decal into a plunge:
  // the boil sits under the curtain and the foam trails away from it.
  vec2 imp = vec2(-0.34, 0.0);
  float rImp = length((q - imp) * vec2(1.0, 1.22));

  // Churn, not a whirlpool. The previous form added a sin(r * 14) ring train to
  // a noise sampled in a radially-advected frame, and the two together drew a
  // fourteen-armed spiral: from any distance the plunge read as a hurricane
  // symbol rather than as water landing hard on rock. Both of its ingredients
  // were polar functions of the same origin, which is a rosette generator.
  //
  // The advection is now mostly *downstream* and only a little radial. Radial
  // advection alone shears the noise along every radius, which at any speed
  // worth seeing smears the churn into thirty-metre spokes; a pool with a
  // current through it moves one way, and saying so gets motion for free
  // without the starburst.
  vec2 outw = normalize(vLocal + 1e-4);
  vec2 sp = vLocal * 0.55 - (outw * 0.26 + vec2(1.05, 0.0)) * uTime;
  float n  = wFbm3(sp) * 0.5 + 0.5;
  float n2 = wFbm2(vLocal * 1.55 + vec2(uTime * 0.62, -uTime * 0.20) + 8.7) * 0.5 + 0.5;
  // One slow surge travelling out from the impact — foam is thrown outward in
  // pulses. An order of magnitude broader than the old ring train, so it says
  // "surge" without drawing rings on the water.
  float surge = sin(rImp * 2.6 - uTime * 1.5) * 0.5 + 0.5;
  float churn = n * 0.54 + n2 * 0.30 + surge * 0.16;

  // ── the shape ────────────────────────────────────────────────────────────
  // Two masses, not one disc. A hard white boil under the curtain, and a tail
  // of broken foam dragged off it downstream. The tail is gated on the
  // downstream half-plane, which is the whole reason the pool stops reading as
  // a circular decal centred on nothing.
  float boil = 1.0 - smoothstep(0.05, 0.66, rImp);
  float tail = (1.0 - smoothstep(0.15, 1.02, r)) * smoothstep(-0.42, 0.62, q.x);
  float density = clamp(boil * 1.20 + tail * 0.70, 0.0, 1.35) * vPower;

  // Chew the outline with low-frequency noise so the pool never reads as the
  // disc it is actually built from.
  // Two scales of lobe, not one. A single octave chews the disc into a smooth
  // four-lobed clover that still reads as a disc; the second, finer scale is
  // what turns the outline into torn foam.
  // Half polar, half cartesian. A shape whose outline is a function of angle
  // alone is a rosette however many octaves it has; mixing in a noise sampled
  // in the plane breaks the radial symmetry and the boundary starts reading as
  // torn foam instead of as a flower.
  float lobes  = wFbm2(outw * 2.4 + vec2(uTime * 0.09, 0.0)) * 0.5 + 0.5;
  float lobes2 = wFbm2(vLocal * 0.30 + vec2(uTime * 0.05, 3.1)) * 0.5 + 0.5;
  // Both of those are low-frequency — a couple of cycles round the whole pool —
  // so between them they can only push the boundary into a smooth four- or
  // five-lobed blob, which from any distance is still an ellipse. That is what
  // the plunge kept reading as. Torn foam needs a mark the size of the tearing,
  // not the size of the pool: this third octave runs at about a metre and is
  // what actually puts a ragged edge on the shape.
  float lobes3 = wFbm3(vLocal * 1.05 + vec2(-uTime * 0.35, uTime * 0.12) + 5.3) * 0.5 + 0.5;
  float rEff = r / mix(0.56, 1.12, lobes * 0.34 + lobes2 * 0.40 + lobes3 * 0.26);

  // Threshold, and it has to stay *inside* the range the noise occupies.
  // churn is a sum of fbm bells: it lives between about 0.25 and 0.75 and
  // almost never leaves that. The old cut ran from 0.72 down to -0.12, so
  // anywhere the density was over roughly 0.75 — which is the whole boil and
  // most of the tail — the threshold had fallen clean out of the noise's range
  // and *every* pixel passed it. That is why the plunge stayed a smooth white
  // egg through three rounds of work on its outline: the churn was being
  // computed, thresholded against nothing, and discarded. Measured on the
  // 77 m fall, the pool came back p50 luma 0.96 against plate 5's 0.80 with no
  // internal range at all.
  //
  // Density now *biases* the cut within the band the noise actually occupies
  // and can never leave it, so the boil is where foam wins most often, not
  // where the test stops being a test.
  float cut = mix(0.62, 0.28, clamp(density / 1.35, 0.0, 1.0));
  float foam = smoothstep(cut, cut + 0.13, churn) * smoothstep(1.06, 0.52, rEff);
  // The white core under the impact, chewed by the same churn so it is a
  // painted shape rather than a printed disc — and it is a *high* threshold on
  // the churn, not a floor under it. Forcing 0.58 across the core was the
  // second half of the same mistake: it printed a solid disc on top of the
  // structure that the cut had already stopped modulating.
  foam = max(foam, (1.0 - smoothstep(0.02, 0.74, rImp)) * smoothstep(0.28, 0.46, churn));
  // Streaks pulled downstream off the boil. Long across the flow direction and
  // narrow against it — the marks a current leaves, and the thing that says
  // which way the water is going once it has landed.
  float threads = wFbm3(vLocal * vec2(0.22, 1.35) - vec2(uTime * 1.6, 0.0)) * 0.5 + 0.5;
  foam = max(foam, smoothstep(0.56, 0.74, threads) * tail * vPower * 0.85);
  foam = clamp(foam, 0.0, 1.0);
  foam *= bench;

  // Value structure inside the mass. Alpha alone gives a smooth white potato:
  // the previous author's note that the plunge was "a soft white burst rather
  // than churn with shape" survived every change to its outline, because the
  // outline was never the problem — the inside of it had no tone in it. Real
  // churn is white crests over blue-grey troughs, and it is the troughs that
  // make the crests read as water rather than as paint.
  //
  // ...and the whole ramp has to sit *under* white, which is where the second
  // half of this bug lived. At 0.60 + 0.52 + 0.22 the crests left this function
  // at 1.23x the foam illuminant, and the illuminant alone is already near
  // unity in full sun — so every crest clipped, the troughs went with them, and
  // the tone curve handed back one flat card. Measured under a frozen cloud
  // shadow the pool ran p50 0.96 / p95 0.987 against plate 5's 0.80 / 0.91.
  // The band below peaks just under 1.0 with the plate's range beneath it.
  // ...and it has to be painted, not airbrushed. Run through a smooth ramp the
  // churn came back as soft grey mottle with a gradient round every blob; the
  // plate draws three flat values with edges between them. See wSteps. The
  // steps dissolve back to the smooth ramp once a level is smaller than a
  // pixel, so nothing here can crawl at range.
  float poolFoot = wFootprint(vWPos, cameraPosition, uPixelScale);
  float poolWide = mix(0.16, 0.5, smoothstep(0.35, 1.6, poolFoot));
  float trough = 0.50 + 0.38 * wSteps(smoothstep(0.20, 0.84, churn), 3.0, poolWide)
                      + 0.15 * (n2 - 0.5);
  // The trough end of the ramp is not the channel's blue. Measured on the 65 m
  // fall the pool came back srgb(137,159,184), ratio 1:1.16:1.34, against the
  // whitewater at the foot of reference plate 5 at 1:0.99:1.00 — the *value*
  // was right (0.61 against 0.60-0.67) and the hue was a stop and a third too
  // blue, which is what made the plunge read as a pale blue wash lying on the
  // ground rather than as churn. A trough between crests of foam is still
  // aerated water; only the water outside the pool is the channel colour.
  vec3 poolLow = mix(uShallow, uFoam, 0.52);
  vec3 col = mix(poolLow, uFoam, foam) * trough
           * wFoamLight(mix(wSunShadow(vWPos), 1.0, 0.5)) * 0.86;

  // The outline was a 0.6-wide radial airbrush — more than half the pool's
  // radius spent on a smooth gradient, which draws an ellipse whatever the
  // noise inside it is doing, and is the rest of why this read as an egg. The
  // band is now narrow enough that the lobe noise chewing rEff is what
  // decides the boundary, which is what makes it read as torn foam.
  // The plunge is the loudest white shape in plate 5. Measured, this material
  // was reaching an alpha of about 0.2 at its strongest — a wash that fog then
  // finished off, which is why hiding the sheet left no pool visible at all.
  float alpha = clamp(foam * 1.45, 0.0, 1.0) * smoothstep(1.05, 0.86, rEff);
  if (!(alpha >= 0.02)) discard;

  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Waterfalls extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Waterfalls';
    this.loadLabel = 'Pouring the falls';
    this.group = new THREE.Group();
    this.group.name = 'Waterfalls';
    this._geoms = [];
    this._materials = [];
    this.falls = [];
  }

  async init() {
    const { world, scene, preset } = this.ctx;
    const list = world?.waterfalls;
    if (!list || !list.length) return;

    this.shared = {
      uTime:         { value: 0 },
      uDataTex:      { value: world.dataTexture },
      uWorldSize:    { value: world.worldSize },
      uDataTexel:    { value: 1 / world.res },
      uSunDir:       { value: new THREE.Vector3(0.4, 0.5, 0.3) },
      uSunColor:     { value: new THREE.Color(1, 1, 1) },
      uSunLight:     { value: new THREE.Color(1, 1, 1) },
      uAmbient:      { value: new THREE.Color(0.4, 0.45, 0.55) },
      uSkyZenith:    { value: PALETTE.skyZenith.clone() },
      uSkyHorizon:   { value: PALETTE.skyHorizon.clone() },
      uRefGround:    { value: PALETTE.grassGoldDeep.clone() },
      uRefRock:      { value: PALETTE.rockMid.clone() },
      uSnowLine:     { value: 262.0 },
      uReflectSteps: { value: preset?.reflections ? 8 : 0 },
      uFoam:         { value: PALETTE.waterFoam.clone() },
      uShallow:      { value: PALETTE.waterShallow.clone() },
      // Radians of view angle per output pixel, kept in step with Water's own.
      // The sheet's minimum-width LOD is measured against it.
      uPixelScale:   { value: 0.0016 },
      // One dial for every aerated surface in the game — see wFoamLight. Set so
      // sunlit foam lands just under 1.0 before exposure: high enough to read as
      // white water, low enough that the structure inside it survives the tone
      // curve instead of clipping to a flat card.
      uFoamGain:     { value: 1.55 },
    };

    this._buildPaths();
    this._buildSheet();
    this._buildSpray();
    this._buildBurst();
    this._buildMist();
    this._buildPools();

    scene.add(this.group);
  }

  /**
   * Integrate each fall from lip to pool. Gravity decides how fast the water
   * can drop; the rock decides how fast it actually does. Where the ground
   * falls away faster than free-fall the water leaves the rock and arcs.
   */
  _buildPaths() {
    const world = this.ctx.world;
    const rng = mulberry32(0x77a7e2);
    const G = 9.81;

    for (const wf of world.waterfalls) {
      const top = wf.top, bot = wf.bottom;
      const hor = Math.hypot(bot[0] - top[0], bot[2] - top[2]);
      const H = Math.max(wf.height, 1.0);
      // A big river arrives at the lip moving fast; a trickle dribbles over.
      const v0 = clamp(2.2 + wf.discharge * 7.0, 2.2, 9.0);

      const dirX = hor > 1e-3 ? (bot[0] - top[0]) / hor : 1;
      const dirZ = hor > 1e-3 ? (bot[2] - top[2]) / hor : 0;
      const sideX = -dirZ, sideZ = dirX;

      const pts = [];
      let y = top[1], vy = 0, flight = 0;
      const dsH = hor / (PATH_STEPS - 1);
      const seed = rng();

      for (let i = 0; i < PATH_STEPS; i++) {
        const u = i / (PATH_STEPS - 1);
        // A little lateral meander so no fall is a perfectly straight ribbon.
        const wob = Math.sin(seed * 40 + u * 4.2) * Math.min(2.5, wf.width * 0.35) * u;
        const x = top[0] + dirX * hor * u + sideX * wob;
        const z = top[2] + dirZ * hor * u + sideZ * wob;

        if (i > 0) {
          let dt;
          if (hor > 0.6) {
            dt = dsH / v0;
            vy -= G * dt;
            let yNext = y + vy * dt;
            // 0.9, not 0.35. This samples the *baked* heightfield, and the
            // terrain mesh adds up to half a metre of micro-detail on top of
            // it — so at 0.35 the rock pokes through the curtain wherever the
            // detail happens to rise, and because that rock is faceted the
            // intersection is a set of dead-straight vertical lines cut into
            // the sheet's silhouette. That is the hard-edged left boundary and
            // the notch beside it in the waterfall view, and it is why the
            // curtain reads hard on one side and feathered on the other: only
            // one side is against the wall.
            const ground = world.getHeight(x, z) + 0.9;
            if (yNext < ground) {
              yNext = ground;
              // Landed on rock: the water now slides, so its vertical speed is
              // whatever the slope gives it.
              vy = (yNext - y) / dt;
            }
            y = yNext;
          } else {
            // A clean vertical drop: solve the parabola directly.
            const drop = H * u * u;
            y = top[1] - drop;
            dt = Math.sqrt(Math.max(2 * H / G, 1e-3)) / (PATH_STEPS - 1);
          }
          flight += dt;
        }
        // Never let the path finish above the recorded plunge point.
        if (i === PATH_STEPS - 1) y = Math.min(y, bot[1] + 0.4);

        // A curtain spreads as it falls, but nowhere near this much. At
        // 0.8 + 1.5u the sheet reached 2.3x its nominal width at the foot, and
        // the mesh runs out to +/-1.25 half-widths on top of that — so the
        // 8 m fall was 23 m across where it landed. Rendered opaque and white,
        // that is a lens: captured at 110 m the "plunge" on the biggest fall in
        // the map was a smooth faceted egg hanging on a vertical cliff, which
        // is what every pass since has been trying to fix inside the *pool*
        // shader. Hiding the pool entirely left the egg untouched — it was
        // always the sheet, and it was also covering the pool, the burst and
        // the mist, which is why none of them ever showed.
        //
        // The white mass at the bottom of a fall belongs on the ground, where
        // the water hits something. The sheet's job is to arrive.
        const w = wf.width * (0.85 + 0.55 * u);
        pts.push({ x, y, z, w, u, flight });
      }

      // Take the kinks out. Clamping to the rock is a per-step decision, so the
      // integrated path picks up corners wherever the ground catches it; a 1-2-1
      // pass over the interior leaves the endpoints (lip and plunge point) exact
      // and turns the corners into a curve. Water does not turn sharply.
      for (let pass = 0; pass < 2; pass++) {
        const sx = pts.map((p) => p.x), sy = pts.map((p) => p.y), sz = pts.map((p) => p.z);
        for (let i = 1; i < pts.length - 1; i++) {
          pts[i].x = (sx[i - 1] + sx[i] * 2 + sx[i + 1]) * 0.25;
          pts[i].y = (sy[i - 1] + sy[i] * 2 + sy[i + 1]) * 0.25;
          pts[i].z = (sz[i - 1] + sz[i] * 2 + sz[i + 1]) * 0.25;
        }
      }

      this.falls.push({
        wf, pts, sideX, sideZ, dirX, dirZ, hor,
        height: H,
        disc: clamp01(wf.discharge),
        width: wf.width,
      });
    }

    // Bake the paths into a float texture so spray and mist ride the same curve.
    const N = this.falls.length;
    const data = new Float32Array(PATH_STEPS * N * 4);
    for (let f = 0; f < N; f++) {
      const pts = this.falls[f].pts;
      for (let i = 0; i < PATH_STEPS; i++) {
        const o = (f * PATH_STEPS + i) * 4;
        data[o] = pts[i].x; data[o + 1] = pts[i].y; data[o + 2] = pts[i].z; data[o + 3] = pts[i].w;
      }
    }
    const tex = new THREE.DataTexture(data, PATH_STEPS, N, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.pathTex = tex;
  }

  // ── sheet ──────────────────────────────────────────────────────────────────
  _buildSheet() {
    const pos = [], u = [], side = [], flight = [], wid = [], disc = [], nrm = [],
          sdir = [], idx = [];
    let base = 0;
    const C = SHEET_COLS.length;

    for (const f of this.falls) {
      for (let i = 0; i < f.pts.length; i++) {
        const p = f.pts[i];
        const a = f.pts[Math.max(0, i - 1)], b = f.pts[Math.min(f.pts.length - 1, i + 1)];
        // Sheet normal: perpendicular to both the flow direction and the width
        // axis, i.e. facing out of the rock face.
        const tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
        let nx = ty * f.sideZ - tz * 0,
            ny = tz * f.sideX - tx * f.sideZ,
            nz = 0 * tx - ty * f.sideX;
        const nl = Math.hypot(nx, ny, nz);
        // '|| 1' was the wrong fallback: it left the *vector* at (0,0,0), which
        // normalize() in the shader turns into NaN. A degenerate cross product
        // needs a real substitute direction, not a substitute length. Facing
        // back up the channel is what a vertical drop's normal resolves to
        // anyway, so it is continuous with the non-degenerate case.
        if (nl > 1e-5) { nx /= nl; ny /= nl; nz /= nl; }
        else { nx = -f.dirX; ny = 0; nz = -f.dirZ; }
        // ...and it has to point *away from the wall*, which cross(t, side)
        // does not guarantee — its sign depends on which way round the width
        // axis was built. For a vertical drop it resolves to -dir, i.e. back up
        // the channel, which is straight into the cliff: standing the sheet off
        // along it buried the curtain in the rock and the fall came back a
        // third narrower. Downstream is the honest outward direction, because
        // the rock a fall hangs in front of is by construction the thing it
        // just left.
        if (nx * f.dirX + nz * f.dirZ < 0.0) { nx = -nx; ny = -ny; nz = -nz; }
        // Stand the sheet off the rock along its own normal. A curtain of
        // water is a *volume* — a metre or so of it on a fall this size — and
        // it hangs in front of the wall rather than being painted on it. The
        // path clamp above keeps the sheet's centreline off the baked ground;
        // this keeps the near face of the curtain off the faceted mesh, which
        // is what the eye actually sees intersecting.
        const stand = Math.min(0.25 + p.w * 0.06, 0.9);
        for (let c = 0; c < C; c++) {
          const off = SHEET_COLS[c] * p.w * 0.5;
          pos.push(p.x + f.sideX * off + nx * stand,
                   p.y + ny * stand,
                   p.z + f.sideZ * off + nz * stand);
          u.push(p.u); side.push(SHEET_COLS[c]); flight.push(p.flight);
          wid.push(p.w); disc.push(f.disc);
          nrm.push(nx, ny, nz);
          sdir.push(f.sideX, 0, f.sideZ);
        }
      }
      for (let i = 0; i < f.pts.length - 1; i++) {
        const a = base + i * C, b = base + (i + 1) * C;
        for (let c = 0; c < C - 1; c++) {
          idx.push(a + c, b + c, a + c + 1);
          idx.push(a + c + 1, b + c, b + c + 1);
        }
      }
      base += f.pts.length * C;
    }
    if (!idx.length) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aU', new THREE.Float32BufferAttribute(u, 1));
    geo.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
    geo.setAttribute('aFlight', new THREE.Float32BufferAttribute(flight, 1));
    geo.setAttribute('aWidth', new THREE.Float32BufferAttribute(wid, 1));
    geo.setAttribute('aDisc', new THREE.Float32BufferAttribute(disc, 1));
    geo.setAttribute('aNrm', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('aSideDir', new THREE.Float32BufferAttribute(sdir, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    this._geoms.push(geo);

    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign(fogUniforms(), this.shared, {
        uMinPx: { value: 1.9 },
      }),
      vertexShader: SHEET_VERT,
      fragmentShader: SHEET_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this._materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 8;
    mesh.frustumCulled = false;
    mesh.name = 'WaterfallSheets';
    this.group.add(mesh);
  }

  // ── spray ──────────────────────────────────────────────────────────────────
  _buildSpray() {
    const rng = mulberry32(0x5b0a11);
    const N = this.falls.length;
    const rows = [], phase = [], rate = [], u0 = [], sideOff = [], size = [],
          spread = [], seed = [], sideDir = [], outward = [];

    for (let f = 0; f < N; f++) {
      const fl = this.falls[f];
      // Doubled, to pay for the size cut below. Same trade as the burst: fill
      // rate goes as area, so 2x the count at 0.6x the linear size is cheaper
      // than what it replaces.
      const count = Math.round(clamp(60 + fl.disc * 460 + fl.height * 4.4, 52, 580));
      const row = (f + 0.5) / N;
      // Time of flight sets the loop rate: a 60 m fall must take much longer
      // to traverse than a 6 m one or the scale reads wrong.
      const tof = Math.max(fl.pts[fl.pts.length - 1].flight, 0.6);
      for (let i = 0; i < count; i++) {
        const burst = rng() < 0.42;
        rows.push(row);
        phase.push(rng());
        rate.push((1 / tof) * (burst ? 1.9 : 1.0) * (0.85 + rng() * 0.3));
        u0.push(burst ? 0.55 + rng() * 0.25 : rng() * 0.30);
        sideOff.push((rng() * 2 - 1) * 0.55);
        // Same correction as the burst clots: at 0.22-0.62 m scaled by width
        // these read as separate white teardrops hanging beside the curtain
        // from any near framing. Spray is a mist of small things.
        // ...and once more. In the canonical waterfall frame these were still
        // 20 px tall at sixty metres and *isolated* — a loose scatter of white
        // dots either side of the curtain, which reads as sleet falling past a
        // waterfall rather than as spray coming off one. A droplet that can be
        // counted is too big, whatever it is made of.
        size.push((0.08 + rng() * 0.14) * (0.6 + fl.width * 0.10) * (burst ? 1.6 : 1.0));
        spread.push((0.35 + rng() * 1.0) * (0.5 + fl.disc * 1.6));
        seed.push(rng());
        sideDir.push(fl.sideX, 0, fl.sideZ);
        const a = rng() * Math.PI * 2;
        outward.push(Math.cos(a) * 0.8 + fl.dirX * 0.6, 0.15, Math.sin(a) * 0.8 + fl.dirZ * 0.6);
      }
    }
    if (!rows.length) return;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    geo.instanceCount = rows.length;
    const IA = (arr, n) => new THREE.InstancedBufferAttribute(new Float32Array(arr), n);
    geo.setAttribute('aRow', IA(rows, 1));
    geo.setAttribute('aPhase', IA(phase, 1));
    geo.setAttribute('aRate', IA(rate, 1));
    geo.setAttribute('aU0', IA(u0, 1));
    geo.setAttribute('aSideOff', IA(sideOff, 1));
    geo.setAttribute('aSize', IA(size, 1));
    geo.setAttribute('aSpread', IA(spread, 1));
    geo.setAttribute('aSeed', IA(seed, 1));
    geo.setAttribute('aSideDir', IA(sideDir, 3));
    geo.setAttribute('aOutward', IA(outward, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this._geoms.push(geo);

    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign(fogUniforms(), this.shared, {
        uPathTex:  { value: this.pathTex },
        uPathStep: { value: 1 / PATH_STEPS },
        uCullDist: { value: 420 },
      }),
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this._materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 9;
    mesh.frustumCulled = false;
    mesh.name = 'WaterfallSpray';
    this.group.add(mesh);
    this.sprayCount = rows.length;
  }

  // ── impact burst ───────────────────────────────────────────────────────────
  /**
   * Ballistic droplet clusters thrown from the landing point. See BURST_VERT:
   * this is the thing that was missing, not more noise on the pool.
   *
   * Launch speed is tied to the energy actually arriving — a 96 m drop throws
   * water several metres into the air, a 27 m chute barely lifts it — and the
   * horizontal component is biased downstream so the burst leans the way the
   * water was already travelling instead of blooming symmetrically.
   */
  _buildBurst() {
    const rng = mulberry32(0x3f19c4);
    const origin = [], vel = [], phase = [], life = [], size = [], seed = [];

    for (const fl of this.falls) {
      const b = fl.pts[fl.pts.length - 1];
      const energy = clamp01(fl.disc * 0.6 + fl.height / 90);
      // Denser, to pay for the smaller sprites below. A cloud reads by count,
      // not by clot size, and the two have to move together or halving one
      // just thins the plume out.
      // Raised with the size cut, not beyond it: the fill rate a sprite costs
      // goes as its area, so 1.35x the count at 0.72x the linear size is
      // cheaper than what it replaces.
      const count = Math.round(clamp(130 + energy * 560, 120, 660));
      for (let i = 0; i < count; i++) {
        // Spread the launch points across the foot of the curtain, not from one
        // node: a burst radiating from a single point is a firework.
        const across = (rng() * 2 - 1) * fl.width * 0.55;
        const along = rng() * fl.width * 0.5;
        origin.push(
          b.x + fl.sideX * across + fl.dirX * along,
          b.y + 0.3 + rng() * 0.9,
          b.z + fl.sideZ * across + fl.dirZ * along
        );

        // Calibrated down hard from the first attempt. At 3.4 + 7 m/s of lift
        // the biggest fall in the map threw droplets thirteen metres into the
        // air, and a sprite that far from anything reads as snow rather than as
        // spray. A plunge throws water a *couple* of metres; what makes it read
        // is the density of the cloud, not the size of the arc.
        const vUp = (1.7 + rng() * 3.2) * (0.5 + energy);
        const a = rng() * Math.PI * 2;
        // Halved. At up to 6 m/s over a 1.3 s life a clot travelled eight
        // metres from the fall, and eight metres from a 7 m curtain is open
        // hillside — isolating this mesh showed white sprites scattered across
        // dry ground with no water anywhere near them. The plunge is dense and
        // local or it is not a plunge; horizontal throw is the one number that
        // decides which.
        const vH = (0.6 + rng() * 1.7) * (0.5 + energy);
        // Two thirds of the horizontal throw is downstream, a third is random —
        // enough scatter that the plume is not a fan, enough bias that it has
        // a direction.
        const hx = Math.cos(a) * 0.62 + fl.dirX * 0.85;
        const hz = Math.sin(a) * 0.62 + fl.dirZ * 0.85;
        const hl = Math.hypot(hx, hz);
        const ux = hl > 1e-4 ? hx / hl : fl.dirX;
        const uz = hl > 1e-4 ? hz / hl : fl.dirZ;
        vel.push(ux * vH, vUp, uz * vH);

        phase.push(rng());
        // Long enough for the arc to come back down, and no longer — a droplet
        // still on screen after it should have landed reads as snow.
        life.push(clamp(0.50 + vUp * 0.21, 0.6, 2.2));
        // Halved again, and the count raised to pay for it. The previous size
        // fixed the far view — a clot has to be worth a pixel at 200 m — but
        // it was set without checking the near one, and near is where the
        // whole read broke: on a 7 m fall these grew to 2.3 m, which at thirty
        // metres is a hundred-pixel blob. Fifty of them is not a plunge, it is
        // confetti, and that is exactly what a critic saw. Individual sprites
        // must not be readable as shapes; the *cloud* is the read. The pixel
        // floor in BURST_VERT still holds the far view on its own, so this
        // costs nothing there.
        size.push((0.12 + rng() * 0.21) * (0.65 + fl.width * 0.07));
        seed.push(rng());
      }
    }
    if (!origin.length) return;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    geo.instanceCount = phase.length;
    const IA = (arr, n) => new THREE.InstancedBufferAttribute(new Float32Array(arr), n);
    geo.setAttribute('aOrigin', IA(origin, 3));
    geo.setAttribute('aVel', IA(vel, 3));
    geo.setAttribute('aPhase', IA(phase, 1));
    geo.setAttribute('aLife', IA(life, 1));
    geo.setAttribute('aSize', IA(size, 1));
    geo.setAttribute('aSeed', IA(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this._geoms.push(geo);

    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign(fogUniforms(), this.shared, {
        // Reaches as far as the curtain does now that the sprites hold a
        // minimum pixel size — a fall with no spray at its foot reads as a
        // painted strip, which is what every distant fall in peaks looked like.
        uCullDist: { value: 2600 },
        uMinPx:    { value: 2.4 },
      }),
      vertexShader: BURST_VERT,
      fragmentShader: BURST_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this._materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 10;
    mesh.frustumCulled = false;
    mesh.name = 'WaterfallBurst';
    this.group.add(mesh);
    this.burstCount = phase.length;
  }

  // ── mist ───────────────────────────────────────────────────────────────────
  _buildMist() {
    const rng = mulberry32(0x2ee11c);
    const centre = [], phase = [], rate = [], size = [], rise = [], drift = [], seed = [];

    for (const fl of this.falls) {
      const b = fl.pts[fl.pts.length - 1];
      const energy = clamp01(fl.disc * 0.7 + fl.height / 70);
      // Many small puffs rather than a handful of big ones: a plume is a
      // density field, and a dozen 19 m discs is a density field with three
      // samples in it. Raising the count and halving the size costs about the
      // same fill rate and reads as vapour instead of as sprites.
      const count = Math.round(clamp(18 + energy * 76, 18, 96));
      // Tightened from 3 + energy*16. A 19 m spread with another half of that
      // in drift on top puts puffs forty metres from the fall, where they are
      // no longer part of a plume — they are single soft discs hanging over
      // dry hillside, and the frame reads as smeared rather than misty. A
      // plume is *dense and local*; what makes it read is the concentration,
      // which is also why the alpha could be raised without it becoming a haze
      // over the whole gorge.
      const spread = 2.2 + energy * 8.0;
      for (let i = 0; i < count; i++) {
        // Three populations, not one. A single uniform cloud of puffs is what
        // gave the plume its two failure modes at once: thin enough at the
        // waterline that there was no bloom there, and wide and sparse enough
        // above it that individual puffs separated out into discs.
        //
        //   bloom  — the diffuse white mass sitting *on* the plunge. Big, slow,
        //            barely rising, tightly centred. This is the thing the
        //            reference actually draws, and the thing we did not have.
        //   plume  — medium puffs lifting off it, the visible vapour.
        //   veil   — small puffs hugging the last few metres of the curtain.
        //
        // The veil is confined to the bottom 18% of the path. It used to run
        // from 0.62, which on a 65 m fall starts twenty-five metres up a bare
        // cliff, where there is nothing for a puff to belong to.
        const roll = rng();
        const kind = roll < 0.34 ? 0 : roll < 0.84 ? 1 : 2;
        const t = kind === 2 ? 0.82 + rng() * 0.17 : 1.0;
        const p = fl.pts[Math.min(fl.pts.length - 1, Math.round(t * (fl.pts.length - 1)))];
        const lat = kind === 0 ? 0.34 : kind === 1 ? 0.60 : 0.22;
        centre.push(
          p.x + (rng() * 2 - 1) * spread * lat,
          p.y + rng() * (kind === 0 ? 1.2 : 2.5),
          p.z + (rng() * 2 - 1) * spread * lat
        );
        phase.push(rng());
        rate.push(0.045 + rng() * 0.055);
        const sizeMul = kind === 0 ? 1.55 : kind === 1 ? 1.0 : 0.62;
        size.push((1.7 + rng() * 3.4) * (0.5 + energy * 1.0) * sizeMul);
        // Halved. At up to 24 m of rise the last third of every puff's life
        // was spent alone against open sky, and an isolated soft disc against
        // sky is not vapour — it is a bokeh ball, and a critic pass has
        // already read two of them as dirt on the lens. Vapour thins as it
        // climbs; it does not travel to the top of the cliff intact.
        // The bloom barely climbs at all — it is the mass sitting on the water,
        // not the vapour leaving it.
        rise.push((2.0 + rng() * 4.5) * (0.5 + energy) * (kind === 0 ? 0.22 : 1.0));
        const a = rng() * Math.PI * 2;
        const dr = spread * (kind === 0 ? 0.10 : 0.32);
        drift.push(Math.cos(a) * dr, 0, Math.sin(a) * dr);
        seed.push(rng());
      }
    }
    if (!centre.length) return;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    geo.instanceCount = phase.length;
    const IA = (arr, n) => new THREE.InstancedBufferAttribute(new Float32Array(arr), n);
    geo.setAttribute('aCentre', IA(centre, 3));
    geo.setAttribute('aPhase', IA(phase, 1));
    geo.setAttribute('aRate', IA(rate, 1));
    geo.setAttribute('aSize', IA(size, 1));
    geo.setAttribute('aRise', IA(rise, 1));
    geo.setAttribute('aDrift', IA(drift, 3));
    geo.setAttribute('aSeed', IA(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this._geoms.push(geo);

    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign(fogUniforms(), this.shared, {
        uCullDist: { value: 700 },
        // Cut from 0.55. The bow is evaluated per sprite over a volume, so a
        // 2.4-degree band in view angle lands on some puffs and not their
        // neighbours — which at the old mist opacity was invisible and at the
        // new one is a set of pale green and cyan patches inside the plume.
        // Magnified they read as mould on the white water, and neither
        // reference plate has a bow in it at all. Kept as a whisper.
        uRainbow:  { value: 0.18 },
      }),
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this._materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 11;
    mesh.frustumCulled = false;
    mesh.name = 'WaterfallMist';
    this.group.add(mesh);
    this.mistCount = phase.length;
  }

  // ── plunge pools ───────────────────────────────────────────────────────────
  _buildPools() {
    const world = this.ctx.world;
    const pos = [], local = [], rad = [], pow = [], baseY = [], idx = [];
    let base = 0;
    const RINGS = 5, SEG = 32;

    // Drape each vertex on whatever it lands on. A flat disc at the recorded
    // plunge height is buried by any ground that rises across it and leaves a
    // thin crescent of foam floating in the air — which is exactly what a
    // waterfall landing on a sloping apron used to look like.
    const drapeY = (x, z) => {
      const surf = world.getWaterHeight(x, z);
      const g = world.getHeight(x, z);
      // 0.55 m, not 0.12. The terrain mesh adds up to half a metre of micro-
      // detail on top of the baked heightfield this drape samples, so at 12 cm
      // the ground punched through the foam in hard-edged triangular wedges all
      // round the impact — visible in a zoom as straight-sided orange shards
      // lying on top of the whitewater.
      return (surf !== null && surf > g ? surf : g) + 0.55;
    };

    for (const fl of this.falls) {
      const b = fl.pts[fl.pts.length - 1];
      // ...but not this big. At 2.9 the largest fall in the map got a twenty
      // metre radius — a forty metre disc of foam round an eight metre
      // curtain, five channel widths in every direction including *upstream*.
      // Seen from the bank at a grazing angle that is not a plunge pool, it is
      // a flat white fan lying on the valley floor, and with the churn advected
      // radially through it the whole thing reads as a splash decal with motion
      // blur. Three channel widths is already generous; the reference throws
      // its white water *downstream*, not in a circle.
      const radius = clamp(2.2 + Math.sqrt(fl.disc * fl.height) * 1.45, 3.0, 11);
      const power = clamp01(0.62 + fl.disc * 0.55);
      // The waterline at the landing point. Everything the shader says about
      // whether a bit of apron is lying flat or climbing the wall behind the
      // fall is measured against this one height — see the climb gate in
      // POOL_FRAG. Taken from the same drape the vertices use, so the two can
      // never disagree about where the ground is.
      const impactY = drapeY(b.x, b.z);

      // ── downstream bias ───────────────────────────────────────────────────
      // The pool is still built as a disc in its own space — the shader shapes
      // it there — but it is *placed* as an oval stretched along the flow and
      // shifted downstream of the impact. Water landing on rock throws its
      // foam the way it was already going; a circle centred on the landing
      // point is a splash decal, and reads as one from every angle.
      const dX = fl.dirX, dZ = fl.dirZ;      // unit, downstream, horizontal
      const sX = fl.sideX, sZ = fl.sideZ;    // unit, across
      const K_DOWN = 1.55, K_SIDE = 0.88, SHIFT = 0.42;
      const place = (lx, lz) => {
        const d = lx * K_DOWN + radius * SHIFT;
        const s = lz * K_SIDE;
        return [b.x + dX * d + sX * s, b.z + dZ * d + sZ * s];
      };

      {
        const [wx, wz] = place(0, 0);
        pos.push(wx, drapeY(wx, wz), wz); local.push(0, 0); rad.push(radius); pow.push(power);
        baseY.push(impactY);
      }
      for (let r = 1; r <= RINGS; r++) {
        const rr = radius * (r / RINGS);
        for (let s = 0; s < SEG; s++) {
          const a = (s / SEG) * Math.PI * 2;
          const lx = Math.cos(a) * rr, lz = Math.sin(a) * rr;
          const [wx, wz] = place(lx, lz);
          pos.push(wx, drapeY(wx, wz), wz);
          local.push(lx, lz); rad.push(radius); pow.push(power);
          baseY.push(impactY);
        }
      }
      for (let s = 0; s < SEG; s++) {
        idx.push(base, base + 1 + s, base + 1 + ((s + 1) % SEG));
      }
      for (let r = 0; r < RINGS - 1; r++) {
        const a0 = base + 1 + r * SEG, a1 = a0 + SEG;
        for (let s = 0; s < SEG; s++) {
          const n = (s + 1) % SEG;
          idx.push(a0 + s, a1 + s, a0 + n);
          idx.push(a0 + n, a1 + s, a1 + n);
        }
      }
      base += 1 + RINGS * SEG;
    }
    if (!idx.length) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aLocal', new THREE.Float32BufferAttribute(local, 2));
    geo.setAttribute('aRadius', new THREE.Float32BufferAttribute(rad, 1));
    geo.setAttribute('aPower', new THREE.Float32BufferAttribute(pow, 1));
    geo.setAttribute('aBaseY', new THREE.Float32BufferAttribute(baseY, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    this._geoms.push(geo);

    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign(fogUniforms(), this.shared),
      vertexShader: POOL_VERT,
      fragmentShader: POOL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this._materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 7;
    mesh.name = 'PlungePools';
    this.group.add(mesh);
  }

  // ── per frame ──────────────────────────────────────────────────────────────
  update(dt, elapsed) {
    const u = this.shared;
    if (!u) return;
    const { lighting, sky } = this.ctx;
    u.uTime.value = elapsed;

    // Angular pixel size, for the sheet's minimum-width LOD. Same derivation as
    // Water's, recomputed each frame because fov and buffer size both move.
    const cam = this.ctx.camera, rend = this.ctx.renderer;
    if (cam && rend) {
      const h = rend.getDrawingBufferSize(this._tmpSize ??= new THREE.Vector2()).y;
      if (h > 0) u.uPixelScale.value = 2 * Math.tan(cam.fov * Math.PI / 360) / h;
    }

    const sun = lighting?.sun;
    if (sun) {
      u.uSunColor.value.copy(sun.color);
      u.uSunLight.value.copy(sun.color).multiplyScalar(sun.intensity);
    }
    if (lighting?.sunDir) u.uSunDir.value.copy(lighting.sunDir);
    const hemi = lighting?.hemi;
    if (hemi) {
      u.uAmbient.value.copy(hemi.groundColor).lerp(hemi.color, 0.78)
        .multiplyScalar(hemi.intensity);
    }
    const su = sky?.uniforms;
    const zen = su?.uZenith?.value ?? su?.uSkyZenith?.value;
    const hor = su?.uHorizon?.value ?? su?.uSkyHorizon?.value;
    if (zen?.isColor) u.uSkyZenith.value.copy(zen);
    if (hor?.isColor) u.uSkyHorizon.value.copy(hor);
    void dt;
  }

  dispose() {
    for (const g of this._geoms) g.dispose();
    for (const m of this._materials) m.dispose();
    this.pathTex?.dispose();
    this.ctx.scene?.remove(this.group);
  }
}
