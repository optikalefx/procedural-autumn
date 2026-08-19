// ─────────────────────────────────────────────────────────────────────────────
//  Water — river ribbons and lake surfaces.
//
//  Two very different characters share one shader library:
//
//    RIVERS  swept ribbons along the baked polylines. Everything the shader
//            needs to make water look like it is *going somewhere* lives in
//            vertex attributes: distance downstream drives the flow scroll, the
//            channel tangent rotates the ripple basis, discharge and surface
//            gradient drive foam. Nothing is a global scroll.
//
//    LAKES   a mesh built cell-by-cell from the baked water grid, one vertex
//            every ~8 m, each carrying the *local* baked surface height. Calm,
//            near-mirror at grazing angles, gentle wind ripple. The polygon
//            only ever has to be roughly right: the visible edge is a per-pixel
//            depth fade against the terrain, so the shoreline comes from the
//            ground, not from where the mesh happens to stop.
//
//  The shoreline in both cases is a depth fade computed from the data texture,
//  so the water edge is soft and follows the carved bank rather than reading as
//  a cut polygon against the ground.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { PALETTE, WORLD } from './WorldConfig.js';
import { fogUniforms } from '../render/Atmosphere.js';
import { WATER_NOISE, WATER_ENV, WATER_FOAM_LIGHT } from '../shaders/water_common.js';
import { clamp01, smoothstep } from '../core/MathUtils.js';

// Cross-channel profile, in half-widths. Denser near the banks where the foam
// and the shoreline fade need the resolution; the outer ±1.5 columns run up the
// bank and are hidden by the terrain, which is what makes the edge crisp.
const COLS = [-1.5, -1.05, -0.72, -0.36, 0, 0.36, 0.72, 1.05, 1.5];
const RIVER_BUCKET = 1024;   // metres; coarse spatial split so culling can work
const LAKE_QUAD = 8;         // metres per lake quad — fine enough that the surface
                             // follows the baked water instead of averaging it
const LAKE_CHUNK = 768;      // metres per lake draw call
// Metres a single lake quad's four corners may disagree about the surface
// height before the quad is thrown away. Standing water is level; anything
// steeper than this is the mesh bridging two different bodies across a lip,
// and it draws as a vertical wall of water down the rock between them.
const LAKE_LEVEL_STEP = 2.5;
// A ribbon and a lake covering the same flooded reach are coplanar and would
// z-fight. Six centimetres is far more than depth precision at these ranges and
// far less than anything the eye can read as a step.
const RIVER_LIFT = 0.06;

// ── river surface ────────────────────────────────────────────────────────────
const RIVER_VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>
attribute float aSide;    // -1.5 … 1.5, in half-widths
attribute float aDist;    // metres travelled downstream
attribute float aFlow;    // 0..1 discharge
attribute float aTurb;    // 0..1 whitewater tendency (steep / narrow / fast)
attribute float aWidth;   // channel width, metres
attribute vec2  aTan;     // unit downstream direction in XZ

uniform float uTime;

varying vec3  vWPos;
varying float vSide;
varying float vDist;
varying float vFlow;
varying float vTurb;
varying float vWidth;
varying vec2  vTan;

void main() {
  vec3 transformed = position;

  // A slow swell riding downstream. Kept under ~12 cm: any more and the ribbon
  // pulls away from the bank and breaks the shoreline fade.
  float phase = aDist * 0.42 - uTime * (1.1 + 3.4 * aFlow);
  float swell = sin(phase) * 0.6 + sin(phase * 1.87 + aSide * 2.3) * 0.4;
  transformed.y += swell * (0.025 + 0.085 * aTurb) * (1.0 - abs(aSide) * 0.45);

  vWPos  = transformed;
  vSide  = aSide;
  vDist  = aDist;
  vFlow  = aFlow;
  vTurb  = aTurb;
  vWidth = aWidth;
  vTan   = aTan;

  vec3 objectNormal = vec3(0.0, 1.0, 0.0);
  vec3 transformedNormal = normalMatrix * objectNormal;
  vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  #include <shadowmap_vertex>

  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const RIVER_FRAG = /* glsl */`
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <shadowmap_pars_fragment>
// Three declares this one only for its own material types; getShadowMask()
// references it regardless, so a ShaderMaterial has to bring its own.
uniform bool receiveShadow;
#include <shadowmask_pars_fragment>
precision highp float;

uniform float uTime;
uniform vec3  uSunLight;
uniform vec3  uShallow;
uniform vec3  uDeep;
uniform vec3  uFoam;
uniform vec3  uSubsurface;
uniform float uFoamCut;
uniform float uBodyGain;
uniform float uAbsorb;
uniform float uAbsorbPow;
uniform float uEnvTint;
uniform vec3  uCoolTint;
uniform float uPixelScale;

varying vec3  vWPos;
varying float vSide;
varying float vDist;
varying float vFlow;
varying float vTurb;
varying float vWidth;
varying vec2  vTan;

${WATER_NOISE}
${WATER_ENV}
${WATER_FOAM_LIGHT}

void main() {
  vec4 D = wWorldData(vWPos.xz);
  float bed = D.r;
  float depth = vWPos.y - bed;

  // Shoreline: a depth fade, not a polygon edge. The band is wide enough to
  // swallow the ±0.4 m of micro-detail the terrain mesh adds on top of the
  // baked heightfield, so the water never shows a hairline of z-fight — and it
  // widens with the pixel footprint, so the bank is one soft pixel at every
  // range instead of a stairstep at distance. See the lake for the argument.
  float foot = wFootprint(vWPos, cameraPosition, uPixelScale);
  float shoreFade = smoothstep(0.0, 0.62 + foot * 0.55, depth);
  // Taper across the profile as well. The outer columns exist to give the
  // shoreline fade somewhere to finish, not to be water: on an incised channel
  // the terrain cuts them off first, but on a flat flood plain nothing does,
  // and a 12 m river then paints itself 32 m wide as a flat blue film over the
  // meadow. The channel is as wide as the channel.
  float profile = smoothstep(1.38, 0.98, abs(vSide));
  // ...and a ceiling as well as a floor. The ribbon's height comes from the
  // baked polyline, which follows the *channel*; where a river runs off a lip
  // the polyline keeps going while the bed drops out from under it, and the
  // shoreline fade — which only ever asked whether there was ground *below* —
  // then paints a solid blue ribbon straight out across the void. Two of them
  // crossing over one gorge is the floating pale-blue X a critic pass logged in
  // the waterfall view, with no source and no ground contact, and it is a
  // ribbon that had left its bed. A channel is at most a few metres deep; past
  // that the water is not in a channel any more, it is a waterfall, and the
  // falls system draws it.
  float airborne = 1.0 - smoothstep(5.0, 11.0, depth);
  float alpha = shoreFade * profile * airborne;
  if (alpha < 0.012) discard;

  // ── flow space: u across the channel, v downstream, both in metres ────────
  vec2 fp = vec2(vSide * vWidth * 0.5, vDist);
  float speed = 0.9 + 4.2 * vFlow + 3.0 * vTurb;

  // Two scales of travelling ripple, analytic gradients so nothing aliases.
  float rough = 0.35 + 0.65 * vTurb;
  vec2 g = vec2(0.0);
  g += wWaveGrad(fp, normalize(vec2( 0.16, 1.0)), 2.10, speed,        uTime, 0.030 * rough * wRippleFade(foot, 2.10));
  g += wWaveGrad(fp, normalize(vec2(-0.28, 1.0)), 3.40, speed * 0.86, uTime, 0.018 * rough * wRippleFade(foot, 3.40));
  g += wWaveGrad(fp, normalize(vec2( 0.85, 0.6)), 6.30, speed * 0.45, uTime, 0.008 * rough * wRippleFade(foot, 6.30));
  g += wWaveGrad(fp, normalize(vec2(-0.90, 0.4)), 9.10, speed * 0.35, uTime, 0.005 * rough * wRippleFade(foot, 9.10));
  // Cross-channel chop that builds against the banks, where the flow shears.
  float bankShear = smoothstep(0.35, 1.15, abs(vSide));
  g += wWaveGrad(fp, vec2(1.0, 0.0), 5.2, 0.7, uTime, 0.012 * bankShear * wRippleFade(foot, 5.2));

  // Rotate the flow-space gradient back into world space.
  vec3 T = normalize(vec3(vTan.x, 0.0, vTan.y));
  vec3 B = vec3(-T.z, 0.0, T.x);
  vec3 N = normalize(vec3(0.0, 1.0, 0.0) - B * g.x - T * g.y);

  vec3 V = normalize(cameraPosition - vWPos);
  if (!gl_FrontFacing) N = -N;

  // ── foam ─────────────────────────────────────────────────────────────────
  // Scrolls downstream with the water, and is stretched along the flow so the
  // marks read as streaks rather than clouds. Thresholded hard: painted shapes,
  // not a soft dirt-map smear.
  vec2 sp = fp * vec2(1.15, 0.30) - vec2(0.0, uTime * speed * 0.30);
  float fn  = wFbm3(sp) * 0.5 + 0.5;
  float fn2 = wFbm2(sp * 2.7 + vec2(3.1, uTime * 0.12)) * 0.5 + 0.5;

  // How far, in metres, is this pixel from dry ground? Depth alone says
  // nothing — a wide shallow flat is not a shoreline, and treating it as one is
  // what turns river margins into big amorphous white blobs.
  float bedAcross = wBed(vWPos.xz + B.xz * 2.0);
  float across = abs(bedAcross - bed) * 0.5;
  float distShore = depth / max(across, 0.055);

  // The width of everything shore-related has to scale with the channel. A
  // fixed one-metre band is the whole surface of a two-metre brook, which is
  // how a quiet creek ends up rendered as solid whitewater.
  float shoreBand = clamp(vWidth * 0.16, 0.30, 1.6);

  // 1. against the banks — the water piles up and aerates on the edge, but
  //    only within a fraction of a channel width of it
  float bankFoam = smoothstep(0.80, 1.35, abs(vSide)) * (0.15 + 0.55 * vFlow);
  bankFoam *= 1.0 - smoothstep(shoreBand * 0.8, shoreBand * 2.6, distShore);

  // 2. over obstacles — a bed rising into fast water is a standing wave. It is
  //    the *rise* that makes whitewater, not shallowness on its own; a calm
  //    ankle-deep run is glass, and treating depth alone as foam is what turns
  //    a whole river white.
  float aheadM = 1.5 + vWidth * 0.35;
  float bedAhead = wBed(vWPos.xz + vTan * aheadM);
  float rise = clamp((bedAhead - bed) * 2.6, 0.0, 1.0);
  // Downstream gradient of the bed, as a rise over run. Past about 30 degrees
  // the channel is not a channel any more, and the ribbon draws a thin blue
  // thread straight down a rock face — visible as a hairline scratch on the
  // cliff beside the big fall. That water is the falls system's job, so the
  // ribbon hands over: it goes white first (a cascade on stone is whitewater,
  // never a blue line) and then fades out entirely.
  float drop = (bed - bedAhead) / aheadM;
  float cliff = smoothstep(0.58, 1.15, drop);
  float obstacle = rise * (0.15 + 0.85 * vFlow) * smoothstep(1.8, 0.35, depth);

  // 3. steep, fast reaches go white all over
  float rapids = smoothstep(0.28, 0.85, vTurb) * (0.35 + 0.65 * vFlow);

  float drive = clamp(bankFoam * 0.70 + obstacle * 0.80 + rapids * 0.95 + cliff, 0.0, 1.0);
  float cut = uFoamCut - drive * 0.34;
  float foam = smoothstep(cut, cut + 0.10, fn);
  foam = max(foam, smoothstep(cut + 0.12, cut + 0.21, fn2) * 0.7);
  foam *= smoothstep(0.04, 0.16, drive);

  // The waterline itself. This is the single loudest cue in the reference: even
  // a lazy meander is drawn with a bright broken white line where the water
  // meets the bank, and without it a river reads as a sheet of blue vinyl laid
  // in a ditch. So it is unconditional — turbulence changes how *much*, never
  // whether there is any at all.
  // Same lesson the lake taught: depth is what places the waterline, because
  // depth is what places the alpha edge it has to sit on. Metres-from-shore
  // decides only how far the line may spread — anchored to metres alone it
  // ends up living inside five centimetres of depth on every gentle bank,
  // which is to say nowhere.
  float laceD = smoothstep(0.02, 0.14, depth) * (1.0 - smoothstep(0.12, 0.50, depth));
  float laceW = 1.0 - smoothstep(shoreBand * 0.8, shoreBand * 3.0, distShore);
  float lace = laceD * mix(0.35, 1.0, laceW) * smoothstep(0.18, 0.62, abs(vSide));
  // Broken by a noise that rides downstream, so the line reads as painted marks
  // travelling with the current rather than a stencilled outline.
  float laceN = wFbm3(fp * vec2(0.9, 0.22) - vec2(0.0, uTime * speed * 0.26)) * 0.5 + 0.5;
  foam = max(foam, lace * smoothstep(0.34, 0.52, laceN) * (0.72 + 0.28 * vFlow));
  foam = clamp(foam, 0.0, 1.0);

  // ── colour ───────────────────────────────────────────────────────────────
  float deepT = smoothstep(0.15, 2.2, depth);
  vec3 body = mix(uShallow, uDeep, deepT);
  // The margins of a channel are always paler than its core, whatever the bed
  // happens to be doing — the water is thinner there and half full of air.
  // Driving it off the channel profile rather than off the sampled bed keeps
  // the read legible on the many reaches where the bed is nearly flat.
  body = mix(body, uShallow * 1.06, smoothstep(0.40, 1.20, abs(vSide)) * 0.55);
  // Broad soft bands riding downstream. This is the painted-water read in the
  // reference: the surface is never one flat tint, it is lanes of slightly
  // different value drifting with the current.
  float band = wFbm2(fp * vec2(0.26, 0.05) - vec2(0.0, uTime * speed * 0.18)) * 0.5 + 0.5;
  float lanes = wFbm2(fp * vec2(1.30, 0.09) - vec2(0.0, uTime * speed * 0.30)) * 0.5 + 0.5;
  // Stretched to a real 0..1 first. Raw fbm is a bell that rarely leaves the
  // middle third, so used directly these lanes moved the surface by about a
  // seventh of a stop — under the tone curve, a satin ribbon with no current
  // in it. The same correction the falling sheet needed.
  body *= 0.66 + 0.40 * smoothstep(0.34, 0.66, band) + 0.30 * smoothstep(0.34, 0.66, lanes);
  // Shallow water shows the bed through it; a warm bounce keeps the palette
  // from going cold and dead where the river is only ankle-deep.
  body = mix(body, uSubsurface * 1.05, (1.0 - deepT) * 0.35);

  float shadow = min(getShadowMask(), wSunShadow(vWPos + vec3(0.0, 0.4, 0.0)));
  float ndl = max(dot(N, uSunDir), 0.0);
  // Same split as the lake: value from the illuminant, hue from the water. The
  // old form multiplied the light by the body colour twice over, which held the
  // channel blue under any key at all — including a dawn key that had turned
  // every other surface in the frame sepia.
  float bodyY = max(wLuma(body), 1e-4);
  vec3  absorb = body / bodyY;
  vec3 irr = (uSunLight * ndl * shadow + uAmbient) / PI;
  // Raised to a power before it is used as a tint. Straight absorption plus a
  // warm key cancels out: the illuminant runs 1 : 0.64 : 0.53 and the water
  // 0.29 : 0.63 : 1.0, and their product is a grey-blue at chroma 0.22 against
  // reference water measured at 0.48-0.78. The physics is right and the picture
  // is wrong, because a real lake gets most of its diffuse glow from *sky*, not
  // from a low sun that mostly reflects off it. Deepening the absorption is the
  // cheap way to say that: it restores the chroma the key cancels and leaves
  // the value, and therefore the whole time-of-day response, untouched.
  vec3 lit = wTint(irr * bodyY, pow(absorb, vec3(uAbsorbPow)), uAbsorb) * uBodyGain;

  // Fresnel-weighted environment. Rivers are broken up and half-aerated, so
  // they never mirror as hard as a lake does — and letting them try buries the
  // body colour under a sheet of reflected sky at every grazing angle.
  float fres = 0.024 + 0.976 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  fres *= 0.62 * (1.0 - foam * 0.9) * (1.0 - vTurb * 0.45);
  // Same cone argument as the lake: past a fraction of a wavelength per pixel
  // the marched reflection is noise, not detail.
  vec3 Nr = normalize(mix(N, vec3(0.0, 1.0, 0.0), clamp(foot * 3.0, 0.0, 0.94)));
  vec3 R = reflect(-V, Nr);
  // Same correction as the lake: the old cutoff at a footprint of 0.11 m meant
  // a river reflected nothing but sky past a few metres.
  float marchOn = 1.0 - smoothstep(1.2, 4.0, foot);
  vec3 envRaw = wSkyTilt(R);
  if (marchOn > 0.01) envRaw = mix(envRaw, wEnvReflect(vWPos, R), marchOn);
  // Rotated a fraction toward the channel's own hue, never multiplied by it: a
  // river has to pick up a dawn sky the same way the bank beside it does.
  vec3 env = wTint(envRaw, absorb, uEnvTint + 0.10);
  vec3 col = mix(lit, env, clamp(fres, 0.0, 0.34));

  // Specular glints — tight, and killed inside foam so nothing sparkles on
  // what is meant to read as aerated white water. Band-limited against the
  // pixel footprint for the same reason the lake's is: a tight lobe on a
  // rippled surface aliases into a crawling grid of dots long before the
  // ripples themselves become visible as ripples.
  vec3 H = normalize(uSunDir + V);
  float sharp = exp(-foot * 8.0);
  float spec = pow(max(dot(N, H), 0.0), mix(26.0, 220.0, sharp)) * (1.0 - foam) * sharp;
  col += uSunLight * spec * 0.85 * shadow;

  // Foam is lit almost flat — it is a diffuse mass of bubbles, and flattening
  // it is what makes it read as a painted shape. Through wFoamLight so a rapid
  // under a golden key is white water and not a ribbon of cream.
  vec3 foamCol = uFoam * wFoamLight(shadow) * 0.86;
  col = mix(col, foamCol, foam * 0.94);

  // A whisper of cool in the whole channel. Water in the reference is never
  // the same hue as the cream sky it sits under, even where it reflects it.
  col *= uCoolTint;

  alpha = mix(alpha, min(1.0, alpha + 0.45), foam);
  // Hand the steep reaches over to the falls system (see cliff, above). A hard
  // hand-off, not a fade: a ribbon left at even a few percent alpha in front
  // of a curtain shows up as dark blotches chopping the white water into
  // segments, which is worse than either surface on its own.
  alpha *= 1.0 - cliff;
  if (alpha < 0.012) discard;

  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ── lake surface ─────────────────────────────────────────────────────────────
const LAKE_VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>
attribute float aWet;     // 1 inside the baked water body, 0 on the overhang ring
attribute float aShore;   // metres to the nearest dry cell, capped

uniform float uTime;

varying vec3  vWPos;
varying float vWet;
varying float vShore;

void main() {
  vec3 transformed = position;

  // A long, shallow swell so a big lake is not a dead sheet. Two centimetres:
  // enough to move the specular path, far too little to break the shoreline.
  float sw = sin(transformed.x * 0.021 + uTime * 0.31)
           + sin(transformed.z * 0.017 - uTime * 0.24);
  transformed.y += sw * 0.02 * smoothstep(3.0, 25.0, aShore);

  vWPos  = transformed;
  vWet   = aWet;
  vShore = aShore;

  vec3 objectNormal = vec3(0.0, 1.0, 0.0);
  vec3 transformedNormal = normalMatrix * objectNormal;
  vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  #include <shadowmap_vertex>
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const LAKE_FRAG = /* glsl */`
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <shadowmap_pars_fragment>
// Three declares this one only for its own material types; getShadowMask()
// references it regardless, so a ShaderMaterial has to bring its own.
uniform bool receiveShadow;
#include <shadowmask_pars_fragment>
precision highp float;

uniform float uTime;
uniform vec3  uSunLight;
uniform vec3  uShallow;
uniform vec3  uDeep;
uniform vec3  uFoam;
uniform vec3  uSubsurface;
uniform vec2  uWind;
uniform float uBodyGain;
uniform float uAbsorb;
uniform float uAbsorbPow;
uniform float uEnvTint;
uniform vec3  uCoolTint;
uniform float uPixelScale;

varying vec3  vWPos;
varying float vWet;
varying float vShore;

${WATER_NOISE}
${WATER_ENV}
${WATER_FOAM_LIGHT}

void main() {
  vec4 D = wWorldData(vWPos.xz);
  float depth = vWPos.y - D.r;
  // Pixel footprint first: the shoreline width depends on it.
  float foot = wFootprint(vWPos, cameraPosition, uPixelScale);
  // The whole shoreline, in one line: water exists exactly where the surface is
  // above the ground. Not where the polygon ends, not where the baked wet/dry
  // flag flips — both of those are quantised to the grid and read as a cut
  // edge. The band is wide enough to swallow the ±0.5 m of micro-detail the
  // terrain mesh adds on top of the baked heightfield.
  //
  // ...and it widens with the pixel. At four hundred metres and a grazing
  // angle a pixel spans ten metres of bank, so a fixed 0.62 m band crosses
  // from nothing to solid water inside a fraction of one — which is a hard
  // stairstepped polygon edge, and is what a critic measured along every
  // shoreline in the peaks view. Scaling the band by the footprint is a
  // genuine analytic antialias rather than a fudge: the transition is always
  // exactly one pixel wide wherever you stand.
  float shoreFade = smoothstep(0.0, 0.62 + foot * 0.55, depth);
  // The mesh is dilated one ring beyond the baked water so the fade has room to
  // finish inside geometry. That ring is the only place this gate does anything
  // — it stops a perched lake from painting itself down a cliff face.
  float alpha = shoreFade * smoothstep(0.05, 0.55, vWet);
  if (alpha < 0.012) discard;

  // ── wind ripple ───────────────────────────────────────────────────────────
  // Not sinusoids. Four travelling waves with a shared phase origin comb a
  // lake into corduroy no matter how they are weighted or domain-warped: the
  // previous pass warped them by two scales at once and the surface still
  // resolved, under magnification, into two families of perfectly regular
  // crests crossing at forty degrees. A sine is a sine.
  //
  // So the surface gradient comes from a noise field instead, by central
  // difference. Two properties fall out of that which the wave stack could not
  // have: the field is aperiodic in every direction, and the difference
  // baseline can be tied to the pixel footprint — which band-limits it for
  // free, because once a pixel spans more than a feature the difference
  // averages that feature away instead of aliasing it.
  vec2 p = vWPos.xz;
  vec2 wdir = normalize(uWind + vec2(1e-4));
  float wmag = length(uWind);
  float dist = length(cameraPosition - vWPos);
  // How far into the aerial perspective this pixel sits. Several decisions
  // below depend on it: a lake a kilometre off is a flat mass at a grazing
  // angle, and almost everything that gives near water its life is noise there.
  float far = smoothstep(80.0, 420.0, dist);
  // Fetch is a *distance* thing, not a depth thing: a puddle is glass however
  // deep it is, and the middle of a lake is textured however shallow it is.
  float fetch = 0.42 + 0.58 * smoothstep(4.0, 55.0, vShore);
  float near = 1.0 - smoothstep(3.0, 34.0, dist);

  vec2 g = vec2(0.0);
  {
    // Broad swell, ~9 m features, drifting downwind.
    float k = 0.11;
    float e = max(0.9, foot * 0.85);
    vec2 q = p * k - wdir * (uTime * 0.55 * k);
    float hC = wFbm2(q);
    vec2 d = vec2(wFbm2(q + vec2(e * k, 0.0)) - hC, wFbm2(q + vec2(0.0, e * k)) - hC) / e;
    g += d * (2.6 * wmag * fetch);
  }
  {
    // Close chop, ~1.2 m features. This is the scale you actually see from a
    // car window; at forty metres it is already inside the footprint and the
    // difference has averaged it out on its own.
    float k = 0.85;
    float e = max(0.16, foot * 0.85);
    vec2 q = p * k - wdir * (uTime * 1.30 * k);
    float hC = wFbm2(q + 31.0);
    vec2 d = vec2(wFbm2(q + vec2(e * k, 0.0) + 31.0) - hC, wFbm2(q + vec2(0.0, e * k) + 31.0) - hC) / e;
    g += d * (0.22 * wmag * near);
  }
  // Wind on water is patchy: cat's-paws of ripple with glassy lanes between.
  float gust = 0.30 + 1.05 * (wFbm2(p * 0.045 - vec2(uTime * 0.05, 0.0)) * 0.5 + 0.5);
  g *= gust * (0.35 + 0.65 * exp(-dist * 0.006));
  // Soft ceiling on the surface slope. Fresnel at a grazing angle is the
  // steepest function in this shader — a tenth of a radian of normal swings it
  // from body colour to mirror — so an unbounded gradient bands. Soft, because
  // a hard clamp draws its own level set across the water as a visible contour.
  g *= 0.075 / (0.075 + length(g));

  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 V = normalize(cameraPosition - vWPos);
  if (!gl_FrontFacing) N = -N;

  // The ramp reaches further than it did. A shelf that darkens to full depth
  // colour inside four metres gives a lake two states — rim and body — and the
  // reference reads its water as a continuous gradient from a pale, almost
  // sandy edge into the deep. Six metres is roughly the depth at which the bed
  // stops contributing anything.
  float deepT = smoothstep(0.12, 6.0, depth);
  vec3 body = mix(uShallow, uDeep, deepT);
  // Painterly value structure: broad, slow, low-frequency masses rather than a
  // single flat tint. Large areas of near-uniform colour with soft boundaries
  // is what makes the reference read as painted.
  float band = wFbm2(p * 0.012 + vec2(uTime * 0.006, 0.0)) * 0.5 + 0.5;
  // Same idea at arm's length: broad masses read at 300 m, these read at 3 m.
  float fine = wFbm2(p * 0.16 + vec2(uTime * 0.03, uTime * 0.012)) * 0.5 + 0.5;
  // The broad masses are a near-field read. At a kilometre they are 80 m
  // features seen through haze, and all they do there is mottle the surface
  // into pale swirls that look like scum on it — a distant lake wants to be
  // one flat mass of colour, which is what the reference plates do with it.
  body *= 0.86 + 0.28 * band * (1.0 - 0.65 * far) + 0.16 * (fine - 0.5) * near;
  // Ankle-deep water over gold meadow is warm, not cyan. Letting the bed colour
  // through the shallows is what stops a flooded flat reading as a plastic
  // sheet laid over the ground.
  body = mix(body, uSubsurface, (1.0 - deepT) * 0.34);

  float shadow = min(getShadowMask(), wSunShadow(vWPos + vec3(0.0, 0.4, 0.0)));
  float ndl = max(dot(N, uSunDir), 0.0);

  // Split the water's own colour into a value and a hue. Everything below
  // *tints* with absorb (unit luminance) instead of multiplying by the body,
  // because multiplying by a colour whose red channel is 0.10 is what took the
  // sun out of the lake: the surface could not show an amber key however bright
  // the key was, and stayed cyan at dawn while the whole valley went sepia.
  float bodyY = max(wLuma(body), 1e-4);
  vec3  absorb = body / bodyY;

  // The irradiance the water is standing in — the same key and the same
  // hemisphere fill as the terrain around it, with the key's hue intact.
  vec3 irr = (uSunLight * ndl * shadow + uAmbient) / PI;
  // Light that went into the volume, scattered, and came back out: the
  // illuminant, valued by how much the water lets back out and tinted by what
  // it absorbed on the way.
  // Raised to a power before it is used as a tint. Straight absorption plus a
  // warm key cancels out: the illuminant runs 1 : 0.64 : 0.53 and the water
  // 0.29 : 0.63 : 1.0, and their product is a grey-blue at chroma 0.22 against
  // reference water measured at 0.48-0.78. The physics is right and the picture
  // is wrong, because a real lake gets most of its diffuse glow from *sky*, not
  // from a low sun that mostly reflects off it. Deepening the absorption is the
  // cheap way to say that: it restores the chroma the key cancels and leaves
  // the value, and therefore the whole time-of-day response, untouched.
  vec3 lit = wTint(irr * bodyY, pow(absorb, vec3(uAbsorbPow)), uAbsorb) * uBodyGain;

  // Near-mirror at grazing angles: this is the whole point of a lake.
  float fres = 0.020 + 0.980 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  // Reflect off a *smoothed* normal as the pixel footprint grows. A pixel that
  // covers many wavelengths does not reflect a ray, it reflects a cone; marching
  // a per-ripple mirror direction through a discrete heightfield instead flips
  // between hit and miss from pixel to pixel and resolves into a dotted
  // halftone grid — measured as the single worst artifact in this system, and
  // confirmed by capturing the same frame with uReflectSteps forced to 0.
  vec3 Nr = normalize(mix(N, vec3(0.0, 1.0, 0.0), clamp(foot * 3.0, 0.0, 0.94)));
  vec3 R = reflect(-V, Nr);
  // The march itself is a hit/miss test, so a smoothed normal is not enough:
  // once a pixel spans more than a fraction of a wavelength the ray flips
  // between hitting the far bank and missing it from one pixel to the next.
  // Past that point the landscape reflection is not information, so it is
  // dropped for the smooth sky term — which also makes the far half of every
  // lake in the frame cost nothing to shade.
  // Reach: the march used to stop at a footprint of 0.11 m, which on a lake
  // seen from its own bank is about eight metres out — so in practice no lake
  // in the game ever reflected anything but sky, and a critic pass recorded
  // exactly that. The halftone that forced the old cutoff came from the ray
  // direction wobbling with the ripple, not from the march: with Nr fully
  // flattened by a footprint of 0.31 m the reflected direction is a smooth
  // function of position again and the hit/miss test stops dithering. So the
  // cutoff belongs *past* the point where Nr goes flat, not before it.
  //
  // ...and it was still an order of magnitude too tight. The footprint on a
  // lake seen from its own bank is *dominated by the grazing angle*, not by
  // distance: three metres of eye height over water sixty metres away gives
  // cosI ~ 0.05 and a footprint near two metres, so a cutoff at 1.25 switched
  // the landscape reflection off about twenty-five metres out. Every lake in
  // the game was therefore body colour plus flat sky — measured, and it is
  // exactly the "no reflection of sky or shore anywhere in the build" a critic
  // recorded. Nr is fully flat by a footprint of 0.31, so past that the march
  // is a smooth function of position and there is nothing left to dither; the
  // cutoff only has to stay ahead of the point where the *heightfield itself*
  // is coarser than the pixel.
  float marchOn = 1.0 - smoothstep(3.0, 9.0, foot);
  vec3 envRaw = wSkyTilt(R);
  if (marchOn > 0.01) envRaw = mix(envRaw, wEnvReflect(vWPos, R), marchOn);
  // A reflection off the air/water interface is spectrally neutral: it is the
  // sky, not the water. Multiplying it by the body colour is what stopped every
  // lake in the game turning sepia at dawn with the rest of the world. Water
  // stays the cool note by *rotating* the reflection a fraction toward its own
  // hue — which moves colour and leaves value, and therefore the illuminant,
  // alone. A little more of the rotation at distance, where a grazing mirror
  // would otherwise hand back the cream horizon band as a beige slab.
  vec3 env = wTint(envRaw, absorb, mix(uEnvTint, uEnvTint + 0.20, far));
  // Shallow water has almost no path length to reflect out of — the shelf at
  // the shore should show its bed, not the sky.
  // The mirror is pulled right down at distance. At a kilometre every lake in
  // the map is at a grazing angle, so a strong fresnel there hands back the
  // bright horizon band, and after the shared haze has finished with it the
  // basin reads as a pale neutral slab — a critic measured exactly that at the
  // peaks anchor. Past a few hundred metres the only thing that still says
  // "water" through that much haze is *value*, and value is what the body
  // colour has and the reflected sky does not.
  // ...and the distant throttle is gone entirely. It was compensating for the
  // *content* of the reflection, not for its strength: with the march cut off
  // at twenty-five metres the only thing a grazing lake could hand back was
  // the cream horizon band, so pulling the mirror down at distance was the
  // only way to stop a basin reading as a pale slab.
  //
  // But that is also what killed every distant lake in the game. Measured on
  // the peaks mask: the water averaged #8f6d47 against #bf7838 for the land
  // it covers — a desaturated copy of the hillside, because a diffuse body
  // this dark (linear luma ~0.07) is almost entirely eaten by four hundred
  // metres of haze. Water is bright at a grazing angle *because* it is a
  // mirror; taking the mirror away leaves nothing for the haze to work on.
  // With the march now reaching the far bank the reflection is hills and the
  // higher, bluer sky above them — cooler and darker than the gold valley —
  // so fresnel can simply be allowed to do its job.
  float mirror = clamp(fres * 0.90, 0.0, 0.88) * smoothstep(0.10, 1.2, depth);
  vec3 col = mix(lit, env, mirror);

  // Sun path. Broad and graded, never a hard hotspot — and band-limited, which
  // matters more here than anywhere else in the shader. A pow-260 lobe riding a
  // ripple field resolves into hard rings the instant the ripples approach the
  // size of a pixel, and from the bank of a lake at a grazing angle that is a
  // grid of dots marching across the water: the worst artifact this system had.
  // Widening the lobe with the footprint is the standard fix — the same energy,
  // spread over the solid angle a pixel actually covers.
  vec3 H = normalize(uSunDir + V);
  float nh = max(dot(N, H), 0.0);
  float sharp = exp(-foot * 8.0);
  col += uSunLight * (pow(nh, mix(24.0, 260.0, sharp)) * 0.55 * sharp
                    + pow(nh, mix(10.0,  40.0, sharp)) * 0.09) * shadow;

  // A thin lapping line where the water meets the ground. Measured in metres
  // from the shore, not in depth: a shallow shelf is not a beach.
  float fn = wFbm3(p * 0.75 + vec2(uTime * 0.05, 0.0)) * 0.5 + 0.5;
  float bx = wBed(p + vec2(2.0, 0.0)) - wBed(p - vec2(2.0, 0.0));
  float bz = wBed(p + vec2(0.0, 2.0)) - wBed(p - vec2(0.0, 2.0));
  float slope = length(vec2(bx, bz)) * 0.25;
  float distShore = depth / max(slope, 0.05);
  // The waterline has to be placed by the same quantity that places the alpha
  // edge, or it wanders off it. That quantity is depth. Metres-from-shore is
  // the honest measure of how *wide* the band should be, but on the 1:20
  // shelves this map is full of, a metre of shore is five centimetres of
  // depth — thinner than the terrain's own micro-detail — so a band defined
  // purely in metres either vanishes or sits somewhere the water does not end.
  // Depth places the line; slope is only allowed to limit how far it spreads,
  // because a continuous three-metre white fringe around every lake in the map
  // reads as pack ice rather than water lapping at a bank.
  float laceD = smoothstep(0.015, 0.10, depth) * (1.0 - smoothstep(0.09, 0.36, depth));
  float laceW = 1.0 - smoothstep(0.8, 3.6, distShore);
  float lace = laceD * mix(0.26, 1.0, laceW);
  // Broken twice, at two scales. One noise threshold turns the band into a
  // long soft smear with a couple of gaps in it; the reference draws its
  // waterline as a row of separate bright marks, and it takes a coarse noise
  // to place the marks and a finer one to give each of them an edge.
  float fn2 = wFbm2(p * 2.9 + vec2(uTime * 0.09, uTime * 0.04)) * 0.5 + 0.5;
  float marks = smoothstep(0.36, 0.50, fn) * smoothstep(0.30, 0.46, fn2);
  // Far shorelines get a pale edge, not a white rope: the lace noise is
  // sub-pixel past a couple of hundred metres and averages to a solid band.
  float foam = lace * marks * mix(1.0, 0.45, smoothstep(140.0, 520.0, dist));
  // Foam is a diffuse mass of bubbles: lit nearly flat, and never allowed to
  // sink to the ambient's blue — white water that is not white is haze.
  vec3 foamCol = uFoam * wFoamLight(shadow) * 0.86;
  col = mix(col, foamCol, foam);

  col *= uCoolTint;

  // Shallows are see-through; the body closes up as it deepens.
  // Shallows are see-through, but only a little. At 0.62 the gold bank read
  // straight through the shelf and every lake margin in the game came out
  // khaki — mud, which the brief names as an anti-pattern. Shallowness belongs
  // in the water's *colour*, which the depth ramp already handles, not in how
  // much of the bank is allowed to show through it.
  alpha *= mix(0.84, 1.0, smoothstep(0.12, 1.5, depth));
  alpha = max(alpha, foam * 0.92);

  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Water extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Water';
    this.loadLabel = 'Filling the rivers';
    this.group = new THREE.Group();
    this.group.name = 'Water';
    this._meshes = [];
    this._materials = [];
    this._tmpC = new THREE.Color();
  }

  async init() {
    const { world, scene, preset } = this.ctx;
    if (!world) return;

    // Uniforms shared by every water material — one object, updated once.
    const reflectSteps = preset?.reflections ? 24 : 0;
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
      uRefGround:    { value: PALETTE.grassGoldDeep.clone().multiplyScalar(0.62) },
      uRefRock:      { value: PALETTE.rockMid.clone().multiplyScalar(0.72) },
      uSnowLine:     { value: 262.0 },
      uReflectSteps: { value: reflectSteps },
      uShallow:      { value: PALETTE.waterShallow.clone() },
      // The palette's deep blue is the colour of a *sample* of deep water, not
      // of a lake seen under a bright sky. Taken literally it makes every basin
      // in the map a dark hole, which fails the brief's lifted-blacks target;
      // lifting it a quarter of the way to the shallow tone keeps the hue and
      // gets the value back.
      uDeep:         { value: PALETTE.waterDeep.clone().lerp(PALETTE.waterShallow, 0.26) },
      uFoam:         { value: PALETTE.waterFoam.clone() },
      uSubsurface:   { value: PALETTE.waterSubsurface.clone() },
      // Shallow water at 3.1 clipped every channel past 1.0 — the surface then
      // has no structure left to see, which is how a pond two metres from the
      // camera ends up reading as flat turquoise vinyl.
      //
      // Re-measured against the current grade (the flat-shadow clamp is gone,
      // AMBIENT_SCALE is 0.72) and against the new tint model, which no longer
      // multiplies the light by the body colour and so no longer needs a gain
      // to put back the value that the double filter took out.
      uBodyGain:     { value: 1.30 },
      // How much of the water's own hue is imposed on the light coming back out
      // of it. 1.0 is a literal multiply by the body colour; below that the
      // illuminant shows through, which is the whole point.
      uAbsorb:       { value: 1.0 },
      // Chroma of the absorption tint. See the shader: 1.0 is literal, above
      // that the water holds its blue against a hard amber key the way the
      // reference plates do.
      uAbsorbPow:    { value: 1.60 },
      // How far the surface reflection is rotated toward the water's hue. The
      // reflection is physically neutral, so this is pure art direction: enough
      // that a lake stays the cool note in a hot frame, little enough that a
      // dawn sky still lands on it.
      uEnvTint:      { value: 0.34 },
      uCoolTint:     { value: new THREE.Vector3(0.96, 1.00, 1.03) },
      // Radians of view angle per output pixel. Everything that has to be
      // band-limited — ripple scales, the specular lobe, the reflection march —
      // is measured against the footprint this implies.
      uPixelScale:   { value: 0.0016 },
      // Shared with the falls: the one dial for every aerated surface. See
      // wFoamLight in water_common.js for why foam gets its own illuminant.
      uFoamGain:     { value: 1.55 },
    };

    this.riverMaterial = new THREE.ShaderMaterial({
      lights: true,
      uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
                              fogUniforms(), this.shared, {
        uFoamCut: { value: 0.74 },
      }),
      vertexShader: RIVER_VERT,
      fragmentShader: RIVER_FRAG,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      fog: true,
    });

    this.lakeMaterial = new THREE.ShaderMaterial({
      lights: true,
      uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
                              fogUniforms(), this.shared, {
        uWind: { value: new THREE.Vector2(0.62, 0.36) },
      }),
      vertexShader: LAKE_VERT,
      fragmentShader: LAKE_FRAG,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      fog: true,
    });
    this._materials.push(this.riverMaterial, this.lakeMaterial);

    this._buildLakes();
    this._buildRivers();

    scene.add(this.group);
  }

  // ── rivers ─────────────────────────────────────────────────────────────────
  _buildRivers() {
    const world = this.ctx.world;
    const polys = world.riverPolylines ?? [];
    const buckets = new Map();

    const bucketOf = (x, z) =>
      (Math.floor((x + world.half) / RIVER_BUCKET) << 4) | Math.floor((z + world.half) / RIVER_BUCKET);

    const getBucket = (k) => {
      let b = buckets.get(k);
      if (!b) {
        b = { pos: [], side: [], dist: [], flow: [], turb: [], wid: [], tan: [], idx: [], n: 0 };
        buckets.set(k, b);
      }
      return b;
    };

    for (const poly of polys) {
      if (!poly || poly.length < 6) continue;

      // ── repair the channel profile ────────────────────────────────────────
      // The baked polylines carry per-point width and discharge sampled off the
      // flow-accumulation grid, and roughly one point in eight drops out to the
      // headwater minimum where the trace strays a texel off the channel. Swept
      // straight, that turns a 12 m trunk into a row of paper darts. A windowed
      // maximum repairs the dropouts (discharge only ever grows downstream),
      // then a box blur takes the stairstep out of the confluences.
      const n0 = poly.length;
      const wRep = new Float32Array(n0), fRep = new Float32Array(n0);
      const RAD = 5;
      for (let i = 0; i < n0; i++) {
        let mw = 0, mf = 0;
        for (let k = Math.max(0, i - RAD); k <= Math.min(n0 - 1, i + RAD); k++) {
          if (poly[k].w > mw) mw = poly[k].w;
          if (poly[k].flow > mf) mf = poly[k].flow;
        }
        wRep[i] = mw; fRep[i] = mf;
      }
      const wSm = new Float32Array(n0), fSm = new Float32Array(n0);
      const BLUR = 8;
      for (let i = 0; i < n0; i++) {
        let sw = 0, sf = 0, c = 0;
        for (let k = Math.max(0, i - BLUR); k <= Math.min(n0 - 1, i + BLUR); k++) {
          sw += wRep[k]; sf += fRep[k]; c++;
        }
        wSm[i] = sw / c; fSm[i] = sf / c;
      }

      // ── resample: station spacing scales with the channel, so a 12 m trunk
      // is not tessellated at the same density as a 1.5 m brook.
      const stations = [];
      let maxW = 0;
      const push = (i, d) => {
        stations.push({ x: poly[i].x, y: poly[i].y, z: poly[i].z, w: wSm[i], flow: fSm[i], d });
        if (wSm[i] > maxW) maxW = wSm[i];
      };
      let travelled = 0, sinceStation = 0;
      push(0, 0);
      for (let i = 1; i < poly.length; i++) {
        const seg = Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z);
        travelled += seg;
        sinceStation += seg;
        const stepM = Math.min(12, Math.max(4, wSm[i] * 0.9));
        if (sinceStation >= stepM || i === poly.length - 1) {
          push(i, travelled);
          sinceStation = 0;
        }
      }
      if (stations.length < 3 || maxW < 1.5) continue;

      // Tangents + turbulence. Surface gradient is the honest signal for
      // whitewater: a reach that drops fast is a rapid, one that does not is a
      // pool, regardless of how much water is in it.
      const n = stations.length;
      for (let k = 0; k < n; k++) {
        const a = stations[Math.max(0, k - 1)];
        const b = stations[Math.min(n - 1, k + 1)];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        stations[k].tx = dx / len;
        stations[k].tz = dz / len;
        const ds = Math.max(b.d - a.d, 1e-3);
        const grad = Math.max(0, (a.y - b.y) / ds);
        // Calibration matters more than the formula here. A 2 % surface
        // gradient is a lazy meander and a 20 % one is a genuine rapid; a
        // linear ramp saturates every mountain creek in the map at "full
        // whitewater" and renders the whole river network as white paint.
        const steep = smoothstep(0.015, 0.20, grad);
        // Discharge squeezed through a narrow channel is fast, and fast water
        // over a rough bed aerates even where it is not steep.
        const pinch = clamp01(stations[k].flow * 5 / Math.max(stations[k].w, 1.5));
        stations[k].turb = clamp01(steep * 0.85 + pinch * 0.25);
      }
      // Smooth turbulence along the reach — foam does not switch on per-vertex.
      const sm = stations.map((s) => s.turb);
      for (let k = 0; k < n; k++) {
        const a = sm[Math.max(0, k - 2)], b = sm[Math.max(0, k - 1)];
        const c = sm[k], d = sm[Math.min(n - 1, k + 1)], e = sm[Math.min(n - 1, k + 2)];
        stations[k].turb = (a + b * 2 + c * 3 + d * 2 + e) / 9;
      }

      // ── emit into spatial buckets. A station that straddles two buckets is
      // duplicated into both; a few thousand extra vertices is a cheaper price
      // than losing frustum culling on a 3 km river network.
      const placed = new Map();   // `${bucket}:${station}` -> first vertex index
      const put = (bk, si) => {
        const key = bk * 100000 + si;
        const hit = placed.get(key);
        if (hit !== undefined) return hit;
        const b = getBucket(bk);
        const s = stations[si];
        const base = b.n;
        const hw = s.w * 0.5;
        for (let c = 0; c < COLS.length; c++) {
          const off = COLS[c] * hw;
          b.pos.push(s.x - s.tz * off, s.y + RIVER_LIFT, s.z + s.tx * off);
          b.side.push(COLS[c]);
          b.dist.push(s.d);
          b.flow.push(s.flow);
          b.turb.push(s.turb);
          b.wid.push(s.w);
          b.tan.push(s.tx, s.tz);
        }
        b.n += COLS.length;
        placed.set(key, base);
        return base;
      };

      for (let k = 0; k < n - 1; k++) {
        const s = stations[k];
        const bk = bucketOf(s.x, s.z);
        const a = put(bk, k);
        const c = put(bk, k + 1);
        const b = getBucket(bk);
        for (let q = 0; q < COLS.length - 1; q++) {
          b.idx.push(a + q, c + q, a + q + 1);
          b.idx.push(a + q + 1, c + q, c + q + 1);
        }
      }
    }

    let tris = 0;
    for (const [, b] of buckets) {
      if (!b.idx.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('aSide', new THREE.Float32BufferAttribute(b.side, 1));
      geo.setAttribute('aDist', new THREE.Float32BufferAttribute(b.dist, 1));
      geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(b.flow, 1));
      geo.setAttribute('aTurb', new THREE.Float32BufferAttribute(b.turb, 1));
      geo.setAttribute('aWidth', new THREE.Float32BufferAttribute(b.wid, 1));
      geo.setAttribute('aTan', new THREE.Float32BufferAttribute(b.tan, 2));
      geo.setIndex(b.idx);
      geo.computeBoundingSphere();
      geo.boundingSphere.radius *= 1.1;
      const mesh = new THREE.Mesh(geo, this.riverMaterial);
      mesh.receiveShadow = true;
      mesh.renderOrder = 6;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = 'RiverChunk';
      this.group.add(mesh);
      this._meshes.push(mesh);
      tris += b.idx.length / 3;
    }
    this.riverTriangles = tris;
  }

  // ── lakes ──────────────────────────────────────────────────────────────────
  /**
   * The lake surface is a mesh over the baked water grid, not a set of flat
   * tiles laid on top of it.
   *
   * The previous build averaged the water height over a 48 m tile and drew one
   * quad at that level. Over the near-flat valley floors this map is full of,
   * a neighbouring tile averaging 0.4 m differently moves the waterline by tens
   * of metres — which is precisely why the lakes read as hard-edged slabs
   * floating over the ground, with dead-straight tile seams through the middle
   * of a single body of water.
   *
   * Instead: one vertex every ~8 m carrying the *local* baked surface height,
   * cells emitted only where there is water, the whole thing dilated one ring
   * so the per-pixel depth fade has geometry to finish inside. The polygon
   * boundary is then always well outside the visible waterline, and the
   * waterline itself is decided by the terrain.
   */
  _buildLakes() {
    const world = this.ctx.world;
    const R = world.res;
    const half = world.half;
    const texel = world.texel ?? (world.worldSize / R);

    const S = Math.max(1, Math.round(LAKE_QUAD / texel));  // grid cells per quad
    const quadM = S * texel;
    const G = Math.floor(R / S);                           // quads per side
    const DRY = -9999;

    // ── coarse pass: is there water in this quad, and at what level? ─────────
    const level = new Float32Array(G * G).fill(DRY);
    const wet = new Uint8Array(G * G);
    for (let cz = 0; cz < G; cz++) {
      for (let cx = 0; cx < G; cx++) {
        let n = 0, sum = 0;
        for (let j = 0; j < S; j++) {
          const row = (cz * S + j) * R;
          for (let i = 0; i < S; i++) {
            const v = world.water[row + cx * S + i];
            if (v < -9000) continue;
            n++; sum += v;
          }
        }
        if (!n) continue;
        wet[cz * G + cx] = 1;
        level[cz * G + cx] = sum / n;
      }
    }

    // ── drop stray specks ───────────────────────────────────────────────────
    // The baked water grid leaves isolated single cells scattered across the
    // valley wherever the fill algorithm caught a local pit. Each one becomes
    // an 8 m slab of water sitting in the middle of dry meadow, and a critic
    // pass logged three of them in one frame as evidence of a broken mask.
    // A body of water this small has no shoreline, no depth and no reflection
    // to speak of — it is a puddle-shaped bug. Flood-fill and discard anything
    // under three quads.
    {
      const MIN_CELLS = 3;
      const seen = new Uint8Array(G * G);
      const stack = new Int32Array(G * G);
      const comp = new Int32Array(G * G);
      for (let k0 = 0; k0 < G * G; k0++) {
        if (!wet[k0] || seen[k0]) continue;
        let sp = 0, n = 0;
        stack[sp++] = k0; seen[k0] = 1;
        while (sp > 0) {
          const k = stack[--sp];
          comp[n++] = k;
          const cx = k % G, cz = (k / G) | 0;
          if (cx > 0 && wet[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; stack[sp++] = k - 1; }
          if (cx < G - 1 && wet[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; stack[sp++] = k + 1; }
          if (cz > 0 && wet[k - G] && !seen[k - G]) { seen[k - G] = 1; stack[sp++] = k - G; }
          if (cz < G - 1 && wet[k + G] && !seen[k + G]) { seen[k + G] = 1; stack[sp++] = k + G; }
        }
        if (n < MIN_CELLS) {
          for (let i = 0; i < n; i++) { wet[comp[i]] = 0; level[comp[i]] = DRY; }
        }
      }
    }

    // ── dilate one ring, carrying the neighbouring level outward ────────────
    // These cells are never *seen* as water unless the ground genuinely lies
    // below the lake there; they exist so the shoreline fade never coincides
    // with the edge of the mesh.
    const mask = Uint8Array.from(wet);
    for (let cz = 0; cz < G; cz++) {
      for (let cx = 0; cx < G; cx++) {
        const k = cz * G + cx;
        if (wet[k]) continue;
        let n = 0, sum = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const z = cz + dz; if (z < 0 || z >= G) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const x = cx + dx; if (x < 0 || x >= G) continue;
            if (!wet[z * G + x]) continue;
            n++; sum += level[z * G + x];
          }
        }
        if (!n) continue;
        mask[k] = 1;
        level[k] = sum / n;
      }
    }

    // ── distance to the nearest dry cell, in metres (two-pass chamfer) ───────
    // Fetch, not depth, is what decides whether water is glassy or textured.
    const FAR = 1e6;
    const dist = new Float32Array(G * G);
    for (let k = 0; k < G * G; k++) dist[k] = wet[k] ? FAR : 0;
    for (let cz = 0; cz < G; cz++) {
      for (let cx = 0; cx < G; cx++) {
        const k = cz * G + cx;
        let d = dist[k];
        if (cx > 0) d = Math.min(d, dist[k - 1] + 1);
        if (cz > 0) d = Math.min(d, dist[k - G] + 1);
        if (cx > 0 && cz > 0) d = Math.min(d, dist[k - G - 1] + 1.41);
        if (cx < G - 1 && cz > 0) d = Math.min(d, dist[k - G + 1] + 1.41);
        dist[k] = d;
      }
    }
    for (let cz = G - 1; cz >= 0; cz--) {
      for (let cx = G - 1; cx >= 0; cx--) {
        const k = cz * G + cx;
        let d = dist[k];
        if (cx < G - 1) d = Math.min(d, dist[k + 1] + 1);
        if (cz < G - 1) d = Math.min(d, dist[k + G] + 1);
        if (cx < G - 1 && cz < G - 1) d = Math.min(d, dist[k + G + 1] + 1.41);
        if (cx > 0 && cz < G - 1) d = Math.min(d, dist[k + G - 1] + 1.41);
        dist[k] = d;
      }
    }

    // ── emit, chunked for frustum culling ───────────────────────────────────
    const perChunk = Math.max(8, Math.round(LAKE_CHUNK / quadM));
    const chunks = Math.ceil(G / perChunk);
    const vmap = new Int32Array((perChunk + 1) * (perChunk + 1));
    let quadCount = 0, tris = 0;

    // Vertex value = mean over the (up to four) mesh cells touching it, so the
    // surface is continuous across chunk borders.
    const vertexAt = (vx, vz, out) => {
      let n = 0, lv = 0, w = 0, sh = 0;
      for (let dz = -1; dz <= 0; dz++) {
        const cz = vz + dz; if (cz < 0 || cz >= G) continue;
        for (let dx = -1; dx <= 0; dx++) {
          const cx = vx + dx; if (cx < 0 || cx >= G) continue;
          const k = cz * G + cx;
          if (!mask[k]) continue;
          n++; lv += level[k]; w += wet[k]; sh += Math.min(dist[k], 12) * quadM;
        }
      }
      if (!n) return false;
      out[0] = lv / n; out[1] = w / n; out[2] = sh / n;
      return true;
    };

    const vv = [0, 0, 0];
    for (let bz = 0; bz < chunks; bz++) {
      for (let bx = 0; bx < chunks; bx++) {
        const cz0 = bz * perChunk, cx0 = bx * perChunk;
        const cz1 = Math.min(G, cz0 + perChunk), cx1 = Math.min(G, cx0 + perChunk);
        vmap.fill(-1);
        const pos = [], wetA = [], shoreA = [], idx = [];

        const vert = (vx, vz) => {
          const li = (vz - cz0) * (perChunk + 1) + (vx - cx0);
          const hit = vmap[li];
          if (hit >= 0) return hit;
          if (!vertexAt(vx, vz, vv)) return -1;
          const id = pos.length / 3;
          pos.push(-half + vx * quadM, vv[0], -half + vz * quadM);
          wetA.push(vv[1]);
          shoreA.push(vv[2]);
          vmap[li] = id;
          return id;
        };

        for (let cz = cz0; cz < cz1; cz++) {
          for (let cx = cx0; cx < cx1; cx++) {
            if (!mask[cz * G + cx]) continue;
            const a = vert(cx, cz), b = vert(cx + 1, cz);
            const c = vert(cx + 1, cz + 1), d = vert(cx, cz + 1);
            if (a < 0 || b < 0 || c < 0 || d < 0) continue;
            // A lake surface is level. Reject any quad whose corners disagree
            // about where the surface is by more than a step.
            //
            // This is the bug behind everything a critic pass logged against
            // the waterfall view. The baked water grid marks the pool above a
            // lip and the pool below it as water, sixty metres apart in
            // height; the mesh then joins them with one 8 m quad, which is a
            // near-vertical wall of "lake" hanging down the cliff face. Two of
            // them across one gorge is the floating pale-blue X with no source
            // and no ground contact. One of them in front of a fall is the
            // "flat pale rectangle with horizontal pencil streaking" — the
            // pencil streaking is the *lake's* wind ripple seen edge on, and
            // an isolation capture (lake chunks hidden, everything else on)
            // shows the falls system's curtain behind it, correctly white and
            // fully streaked, having been covered up the whole time.
            const ya = pos[a * 3 + 1], yb = pos[b * 3 + 1];
            const yc = pos[c * 3 + 1], yd = pos[d * 3 + 1];
            const span = Math.max(ya, yb, yc, yd) - Math.min(ya, yb, yc, yd);
            if (span > LAKE_LEVEL_STEP) continue;
            idx.push(a, c, b, a, d, c);
            quadCount++;
          }
        }
        if (!idx.length) continue;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('aWet', new THREE.Float32BufferAttribute(wetA, 1));
        geo.setAttribute('aShore', new THREE.Float32BufferAttribute(shoreA, 1));
        geo.setIndex(idx);
        geo.computeBoundingSphere();
        geo.boundingSphere.radius *= 1.05;
        const mesh = new THREE.Mesh(geo, this.lakeMaterial);
        mesh.receiveShadow = true;
        mesh.renderOrder = 4;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.name = 'LakeChunk';
        this.group.add(mesh);
        this._meshes.push(mesh);
        tris += idx.length / 3;
      }
    }
    this.lakeQuads = quadCount;
    this.lakeTriangles = tris;
  }

  // ── per frame ──────────────────────────────────────────────────────────────
  update(dt, elapsed) {
    const u = this.shared;
    if (!u) return;
    const { lighting, sky } = this.ctx;
    u.uTime.value = elapsed;

    // Angular pixel size, for the band limits. Recomputed every frame because
    // both the field of view and the drawing buffer can change under us.
    const cam = this.ctx.camera, rend = this.ctx.renderer;
    if (cam && rend) {
      const h = rend.getDrawingBufferSize(this._tmpSize ??= new THREE.Vector2()).y;
      if (h > 0) {
        u.uPixelScale.value = 2 * Math.tan(cam.fov * Math.PI / 360) / h;
      }
    }

    const sun = lighting?.sun;
    if (sun) {
      u.uSunColor.value.copy(sun.color);
      u.uSunLight.value.copy(sun.color).multiplyScalar(sun.intensity);
    }
    if (lighting?.sunDir) u.uSunDir.value.copy(lighting.sunDir);

    const hemi = lighting?.hemi;
    if (hemi) {
      // Match three's hemisphere irradiance for an up-facing surface: mostly
      // sky, a little bounce. Water lit any other way drifts out of step with
      // the terrain it sits in.
      u.uAmbient.value.copy(hemi.groundColor).lerp(hemi.color, 0.78)
        .multiplyScalar(hemi.intensity);
    }

    // Sky gradient for the reflection. Read defensively — Sky is another
    // author's module and its uniform names are not a contract.
    const su = sky?.uniforms;
    const zen = su?.uZenith?.value ?? su?.uSkyZenith?.value;
    const hor = su?.uHorizon?.value ?? su?.uSkyHorizon?.value;
    if (zen?.isColor) u.uSkyZenith.value.copy(zen);
    if (hor?.isColor) u.uSkyHorizon.value.copy(hor);
    else if (lighting?.fogNear) u.uSkyHorizon.value.copy(lighting.fogNear);

    // Reflected land is lit by the same sun; tie it to the key so a dawn lake
    // does not reflect a golden-hour hillside.
    if (sun) {
      const k = Math.min(1.6, 0.35 + sun.intensity * 0.22);
      u.uRefGround.value.copy(PALETTE.grassGoldDeep).multiply(sun.color).multiplyScalar(k * 0.9);
      u.uRefRock.value.copy(PALETTE.rockMid).multiply(sun.color).multiplyScalar(k * 0.95);
    }
    void dt;
  }

  dispose() {
    for (const m of this._meshes) m.geometry.dispose();
    for (const m of this._materials) m.dispose();
    this.ctx.scene?.remove(this.group);
    this._meshes.length = 0;
  }
}

void WORLD;
