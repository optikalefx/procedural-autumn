// ─────────────────────────────────────────────────────────────────────────────
//  water_surface — THE water shader. One surface, everywhere.
//
//  This file replaces water_river.js and water_lake.js, which were a swept
//  ribbon along the baked centrelines and a mesh contoured from the baked water
//  grid: two meshes, two materials, two noise fields, two foam models and two
//  shoreline rules. They could never agree where they met, and every jagged
//  transition in this project's history was at that seam. A long list of
//  machinery existed only to hide it — a RIVER_LIFT to stop the two surfaces
//  z-fighting, an aLake attribute that flared the ribbon and dived it under the
//  lake so the depth test would swallow the join, an 'airborne' guard on one and
//  a perched-lake guard on the other. Deleting the second surface deletes the
//  whole class of defect, and all of that machinery with it.
//
//  A river is not a different kind of thing from a lake. It is the same water,
//  in a narrower channel, moving faster. So:
//
//    GEOMETRY   one mesh, contoured from (water - bed) over the baked grid.
//               Water.js owns it; it carries two attributes, both distances in
//               metres, and no notion of "river" or "lake" at all.
//
//    FLOW       a FIELD, sampled from uFlowTex, not vertex attributes. Direction
//               and coherence in RG, discharge in B, turbulence in A. See
//               TerrainGen._flowField. Standing water is velocity zero, so the
//               same code path draws a calm lake and a fast channel with no
//               discontinuity anywhere between them, because it is one
//               continuous field rather than two objects.
//
//  Nearly every constant below carries the measurement it was set from. Those
//  are findings, not decoration: the two files this one replaces were heavily
//  iterated and their comments record what failed as well as what worked.
//  docs/WATER_ART_SPEC.md is the arbiter where they disagree with each other.
// ─────────────────────────────────────────────────────────────────────────────
import { WATER_NOISE, WATER_ENV, WATER_FOAM_LIGHT } from './water_common.js';

export const SURFACE_VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>
attribute float aShore;   // SIGNED metres to the waterline: + inside the water
                          // body, - out over the dilation ring. Capped.
attribute float aSpan;    // how open the water is here — the local half-width
                          // of the body, in metres, capped. A brook is under 3,
                          // a trunk river 6-10, a lake is at the cap.

uniform float uTime;
uniform vec2  uWind;

varying vec3  vWPos;
varying float vShore;
varying float vSpan;
varying float vLift;

void main() {
  vec3 transformed = position;

  // A long, shallow swell so a big sheet is not a dead plane. Two centimetres:
  // enough to move the specular path, far too little to break the shoreline.
  // Faded in with distance from the bank, so nothing moves where the surface
  // meets the ground and the alpha edge stays exactly where the terrain says.
  float sw = sin(transformed.x * 0.021 + uTime * 0.31)
           + sin(transformed.z * 0.017 - uTime * 0.24);
  transformed.y += sw * 0.02 * smoothstep(3.0, 25.0, aShore);

  // ── the clearance lift ───────────────────────────────────────────────────
  // This lift used to scale with camera range, to min(2.2, 0.03 + d * 0.011).
  // The reasoning was sound and the conclusion was wrong, so the reasoning is
  // kept here to stop anyone rebuilding it.
  //
  // The argument was: a horizontal plane meeting a nearly horizontal faceted
  // surface is the worst-conditioned intersection in graphics, the two surfaces
  // disagree about where the ground is (this shader reads the BAKED field; the
  // mesh was that field plus up to half a metre of per-vertex micro-detail), so
  // lift the polygon clear of the argument and hand the fragment shader vLift
  // so every depth it computes is against the REAL surface. It then claimed the
  // visible waterline does not move a millimetre.
  //
  // That claim is true of ALPHA and false of the SILHOUETTE, and nothing in
  // this round could tell the two apart. A lift does not change the (x,z)
  // footprint at all, so coverage stays exactly right — which is why every
  // top-down framing measured clean. But it draws that correct footprint one to
  // two metres too high in world space. At a grazing angle the sheet stands off
  // its own bank and occludes the hillside in front of it, which reads as a
  // river floating over the terrain. A user found it in a minute; five
  // instruments had not, because wedge's four columns are shape statistics of a
  // contour and every one of them is invariant under translation.
  //
  // Attribution, same pose, foliage hidden, lift on vs off: the far bank goes
  // from a straight horizontal cut to a terrain-following curve, and a boulder
  // the raised sheet had half-drowned at waterfall re-emerges with the
  // waterline correctly detouring around it.
  //
  // The premise had also expired. The micro-detail this was clearing is now
  // tapered to zero within 1.5 m of the waterline (0.0004 m RMS at the line),
  // and the edge is cut per-pixel from the hydro SDF rather than by the
  // geometric intersection, so the ill-conditioned cut is not what draws the
  // shoreline any more.
  //
  // Measured at cap 0.03 vs 2.2, bare, all four framings: no wedges returned;
  // mouth aaPx 2.38 -> 1.98, INTO the 1.5-2.5 target, fine 4.6 -> 5.6 against
  // an 8% bar. The fine rises at waterfall (8.4 -> 10.7) and hero (10.8 ->
  // 13.7) are the metric penalising correctness: the zooms show the waterline
  // gaining a real detour around the re-emerged boulder, and hero's rivers
  // simply drawing narrower once the sheet stops overhanging them. Coverage
  // falls everywhere the overhang was real -- mouth 52.5% -> 50.6%, waterfall
  // 12.1% -> 10.9% of screen.
  //
  // What remains is a token constant, below the depth-buffer's argument at any
  // range and far below anything visible. Depth ties are resolved in DEPTH, by
  // polygonOffset on the material in Water.js, because a depth bias cannot move
  // a silhouette and a world-space lift always will.
  vLift = 0.03;
  transformed.y += vLift;

  vWPos  = transformed;
  vShore = aShore;
  vSpan  = aSpan;

  vec3 objectNormal = vec3(0.0, 1.0, 0.0);
  vec3 transformedNormal = normalMatrix * objectNormal;
  vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  #include <shadowmap_vertex>
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

export const SURFACE_FRAG = /* glsl */`
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
uniform float uSheen;
uniform float uFoamCut;
uniform vec3  uCoolTint;
uniform float uCoolGain;
uniform float uPixelScale;
uniform sampler2D uFlowTex;
uniform sampler2D uHydroTex;   // RGBA16F, half the bake's resolution, mipmapped
uniform float uHydroTexel;     // 1 / that texture's resolution

varying vec3  vWPos;
varying float vShore;
varying float vSpan;
varying float vLift;

${WATER_NOISE}
${WATER_ENV}
${WATER_FOAM_LIGHT}

// The flow field, on the same texel convention as wWorldData — see the note
// there about texel centres, which costs a metre of horizontal slip if it is
// got wrong.
vec4 wFlow(vec2 xz){
  return texture2D(uFlowTex, xz / uWorldSize + 0.5 + uDataTexel * 0.5);
}

// ── THE HYDRO FIELD — one fetch, one answer to "where is the edge" ───────────
//
// src/world/hydroField.js, on its own channel layout:
//
//   r depth     the depth to TEST AGAINST. Positive is wet. Inside 18 m of the
//               waterline it is W_HYDRO_SLOPE * sdf by construction rather than
//               a raw subtraction, so its zero set is a smooth curve and its
//               gradient is a known constant instead of whatever the eroded bed
//               happened to leave.
//   g sdf       signed metres of ground to the waterline, + inside, ±48. A real
//               Euclidean distance transform: |grad| = 1, so a band rationed by
//               it is the same width in metres wherever it is drawn, and
//               fwidth(g) IS the pixel footprint in metres with no heuristic.
//   b wet       0..1 coverage.
//   a span      how OPEN the water is here, in metres: the mean inside-distance
//               over a 12 m neighbourhood. A thread reads under a metre, a lake
//               reads at the 48 m cap. It is what the aSpan vertex attribute
//               is, from the same distance field as r, g and b — so it has no
//               lattice seams and it agrees with the shoreline by construction
//               instead of by coincidence.
//
// This replaces four separate answers to the same question — see that file's
// header — and every shoreline quantity below is derived from this one fetch.
// Nothing here reads a bed height, a gradient or the -9999 sentinel any more.
// The RAW tap is still what wEnvReflect and the sun march use, because those
// want the geometry the terrain actually draws.
//
// Mipmapped and half resolution, which matters as much as the smoothing: a
// point sample of a 2 m field at 400 m is an alias generator, and it is a large
// part of why a distant waterline crawls.
vec4 wHydro(vec2 xz){
  // A QUARTER of a texel, not a half, and the difference is a metre. uDataTex's
  // sample i sits at world i*texel - half, so a half-texel correction is right
  // there. The hydro field is stored at half that resolution by AREA-AVERAGING
  // PAIRS, so its sample k is the mean of base samples 2k and 2k+1 and sits at
  // (k + 0.25)*hTexel - half. Measured on a synthetic half-plane whose true
  // waterline is at x = -55.000: with 0.5 the sampled zero lands at -56.000,
  // with 0.25 it lands at -55.000 exactly. On the shipped bake the wrong
  // constant is 1 m in -x and 1 m in -z — 1.41 m diagonally — between the
  // waterline this shader cuts and the bed, slope and river mask the same
  // fragment reads through uDataTex, which is three times the 0.44 m median
  // disagreement the round exists to remove, and in a fixed direction rather
  // than a noisy one. TerrainMaterial.js and WorldData.microDetail carry the
  // same correction; all three have to agree or "one field that everything
  // drawing an edge reads" is false in the shipped build.
  vec2 uv = xz / uWorldSize + 0.5 + uHydroTexel * 0.25;

  // ── the reconstruction IS the polygon, and this is the filter that fixes it ─
  //
  // The header above argues this field can live at half the bake's resolution
  // because it is band-limited by construction. That is true of the FIELD and
  // false of its ZERO SET. Band-limiting bounds how fast the function varies;
  // it says nothing about the reconstruction filter's continuity, and hardware
  // bilinear is only C0 — so the contour picks up a kink at every texel
  // boundary however smooth the function under it is.
  //
  // MEASURED on an input whose answer is known before the tool is trusted: an
  // analytic circle of radius 8 m has curvature exactly 0.125 rad/m everywhere.
  // Through this 4 m lattice, per reconstruction, |turning| per metre of arc:
  //
  //     recon                     p50     max    turn10
  //     0.5 m bilinear (truth)   0.100   0.168    0.152
  //     4 m bilinear             0.036   0.336    0.325   <- what shipped
  //     4 m smoothed bilinear    0.155   1.180    0.285
  //     4 m bicubic B-spline     0.103   0.172    0.143   <- this
  //
  // Bilinear flattens the curve 3x and spikes its corners 2.7x, and the drawn
  // shoreline measured 90% straight at radius 34 m with corners at radius 1.3 m
  // — a polygon.
  //
  // SMOOTHED BILINEAR — warping the fractional texel coordinate by a smoothstep
  // before the fetch — was tried and REGRESSED, and the fixture says exactly
  // why. A signed distance field is locally LINEAR and bilinear reproduces a
  // linear function exactly, so warping the coordinate turns every straight run
  // into an S. On an analytic half-plane, whose true curvature is 0.000 at
  // every angle, it reads p50 0.057 / 0.118 / 0.139 / 0.153 at 11 / 22.5 / 31 /
  // 45 degrees. It manufactures curvature on straight ground. In the frame:
  // hero fine 10.8% -> 16.3%, stair 5.2% -> 9.5%.
  //
  // A cubic B-spline APPROXIMATES rather than interpolates, so it rounds the
  // corners; and it has linear precision, so the same half-plane fixture reads
  // p50 0.000 / max 0.000 at every one of those angles. That is the whole
  // argument: it bends corners and it cannot bend a straight run.
  //
  // Four bilinear taps, not sixteen (Sigg & Hadwiger): the 1D weights split
  // into two pairs, each pair is non-negative and sums to g, and a pair is
  // exactly what the hardware filter computes if you place the sample at the
  // pair's centre of mass. So a 4x4 kernel costs 4 fetches.
  vec2 texSize = vec2(1.0 / uHydroTexel);
  vec2 c  = uv * texSize - 0.5;      // texel-INDEX coordinate; sample k at c = k
  vec2 f  = fract(c);
  vec2 ic = c - f;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) * (1.0 / 6.0);
  vec2 w1 = (3.0 * f3 - 6.0 * f2 + 4.0)      * (1.0 / 6.0);
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) * (1.0 / 6.0);
  vec2 w3 = f3 * (1.0 / 6.0);
  // ── the softening knob, taken off its extreme ───────────────────────────
  //
  // A convex blend of the 1D weights toward bilinear. Separable, non-negative,
  // linear precision intact — still four taps, straight runs still read 0.000.
  //
  // MEASURED by a critic on an instrument whose K=0 fixture reads 0 deleted and
  // 0 severed. At full strength the B-spline does two things and only one of
  // them was wanted:
  //
  //     fully deleted   135 bodies, all but two under 40 m2   <- a fix
  //     SEVERED          82 bodies over 20 m2 into 218 pieces
  //                      = 136 places where one connected channel is now drawn
  //                      as several; the largest lake into 13 pieces, a
  //                      127 942 m2 body into 20
  //
  // A blur cannot break a channel — it erases the narrow links between the
  // pools strung along it, and what you see is a thread that dries up mid-slope
  // and starts again as a chain of dots. Deleting sub-40 m2 specks is what the
  // round was asked for; severing threads is not, and full strength is the
  // extreme end of a curve the knob already existed for.
  //
  // k = 0.5: deletions 135 -> 38, severances 136 -> 72, circle fixture still
  // p50 0.077 / max 0.245 against a truth of 0.100 / 0.168. k = 0.75 reads
  // 0.098 / 0.203 and severs more.
  const float BSPLINE_K = 0.5;
  w0 = mix(vec2(0.0), w0, BSPLINE_K);
  w1 = mix(1.0 - f,   w1, BSPLINE_K);
  w2 = mix(f,         w2, BSPLINE_K);
  w3 = mix(vec2(0.0), w3, BSPLINE_K);
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;                 // g0 + g1 == 1 identically
  vec2 h0 = (w1 / g0) - 1.0 + ic;
  vec2 h1 = (w3 / g1) + 1.0 + ic;
  vec2 uv0 = (h0 + 0.5) * uHydroTexel;
  vec2 uv1 = (h1 + 0.5) * uHydroTexel;

  // texture2DGradEXT, and this is not decoration. h0 jumps 0.8 of a texel every
  // time f wraps, so the tap coordinates' own derivatives are discontinuous at
  // exactly the texel boundaries this filter exists to smooth — implicit mip
  // selection would put a seam back on every one of them, and a mip level is a
  // function of the FOOTPRINT, i.e. of where the camera stands. Handing the
  // derivative of the un-warped uv to all four taps makes the level continuous
  // and identical across them. Three defines this to textureGrad on WebGL2 for
  // any non-raw ShaderMaterial.
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec4 t00 = texture2DGradEXT(uHydroTex, vec2(uv0.x, uv0.y), dx, dy);
  vec4 t10 = texture2DGradEXT(uHydroTex, vec2(uv1.x, uv0.y), dx, dy);
  vec4 t01 = texture2DGradEXT(uHydroTex, vec2(uv0.x, uv1.y), dx, dy);
  vec4 t11 = texture2DGradEXT(uHydroTex, vec2(uv1.x, uv1.y), dx, dy);

  // WHAT IT COSTS, measured on the shipped field rather than argued: an
  // approximating filter is a blur, and blurring an SDF cone pulls its zero in
  // by texel^2 / (6 R) — 8 cm on a 34 m lake, 36 cm on an 8 m pond, and it
  // erases a body under about 3 m of radius. Over the whole shipped hydro
  // field sampled at 1 m: wet area 2 141 374 -> 2 114 056 m2, **-1.28%**, the
  // largest body GROWS 443 629 -> 447 461 m2 (it fills its own concave notches
  // too), and the count of separate bodies falls 953 -> 686. The bodies that go
  // are the sub-40 m2 specks waterlab's speck column fails on, so the way it
  // points is right; but it is a real deletion and it is named here rather than
  // left to be discovered. A straight channel is unaffected until it is under 6 m
  // WIDE (half-width 3 m reads 2.60 m, half-width 4 m reads 3.91 m) because an
  // SDF ridge is linear away from its own centreline.
  //
  // If a later round needs less of it, the knob is a convex blend of the 1D
  // weights toward bilinear, w -> mix(vec2(0,1-f,f,0), w, k), which stays
  // separable, stays non-negative and keeps linear precision, so it is still
  // four taps and straight runs still read 0.000. Measured on the circle:
  // k 0.75 reads p50 0.098 / max 0.203, k 0.5 reads 0.077 / 0.245.
  return mix(mix(t11, t01, g0.x), mix(t10, t00, g0.x), g0.y);
}
// Metres of depth per metre of ground on the field that PLACES the line —
// hydroField.js's own reconstruction constant. Used for exactly one thing:
// turning the raw bed's HEIGHT disagreement into a HORIZONTAL one, which sets a
// band's width and never its position.
const float W_HYDRO_SLOPE = 0.60;

// ── advecting a noise field along a flow that is not constant ───────────────
// A flow map cannot simply offset its sample point by uTime * velocity. The
// velocity field varies over space, so the accumulated offset shears the noise
// without bound. The remedy is the standard one: two copies of the field, half
// a cycle out of phase, cross-faded on a sawtooth, so neither copy is ever
// displaced by more than one cycle's worth.
//
// ── THE SAWTOOTH HAS TO BE IN TIME, NOT IN DISTANCE, AND THAT IS THE FIX ────
//
// What shipped wrapped the phase on a fixed EIGHT METRES of travel:
//
//     cyc = uTime * speed / 8.0;  offsets = fract(cyc) * 8, fract(cyc+0.5) * 8
//
// so the cycle's LENGTH was constant and its PERIOD was a function of the local
// speed. Two things follow from that, and both were measured on the shipped
// flow field with no renderer in the way (the instrument is one page of
// arithmetic; it needs no capture and it cannot be confidently wrong):
//
// 1. THE BLEND HAS EXACTLY ZERO NET TRAVEL. Weight the two copies by their own
//    cross-fade and the centroid of the pair is
//        (1-w)*f0*L + w*fract(f0+0.5)*L  with  w = |1 - 2*f0|
//    which expands to L/2 identically — every phase, every speed, forever.
//    Tabulated over a cycle at 1.5 m/s it reads 4.0000 m at all eight steps.
//    And the picture itself is periodic on a HALF cycle: at f0 = 0 the blend is
//    100% of copy B at 4 m, at f0 = 0.5 it is 100% of copy A at 4 m, and copy A
//    and copy B are the same field. The surface oscillates about a fixed 4 m
//    offset and returns to the identical image every 4/speed seconds. There is
//    no advection in it to measure.
//
//    That is not a flaw in the two-copy trick — a cross-fade never translates
//    its centroid — it is a statement about what the eye is given instead: the
//    INSTANTANEOUS velocity of whichever copy is currently weighted. The size
//    of that signal against the size of the cross-dissolve riding on top of it
//    is (cycle travel) / (2 * feature size). At 8 m of travel and a 9 m swell
//    that ratio is 0.44 — the dissolve is more than twice the advection, so
//    what a correlator locks onto is the dissolve, which points nowhere. A
//    critic measured 0.08 of the prescribed speed and a p75 angle error of
//    155 degrees; this is the arithmetic behind both numbers.
//
// 2. THE PHASE FIELD SCRAMBLES ITSELF. fract() of (t * speed) has a spatial
//    gradient of t * grad(speed), which grows with the clock until the wrap
//    folds it. Over the shipped field, |grad of the sampling offset| in metres
//    of offset per metre of ground, on moving wet texels:
//        t =  0 s   p50 0.000   p90 0.000   over 1.0: 0.0%
//        t = 10 s   p50 0.628   p90 1.049   over 1.0: 14.0%
//        t = 30 s   p50 0.784   p90 1.104   over 1.0: 20.4%
//        t = 900 s  p50 0.796   p90 1.115   over 1.0: 21.4%
//    Within ten seconds of the clock starting, neighbouring water half a metre
//    apart is being sampled from unrelated places, and a fifth of all moving
//    water is past a full metre of offset per metre of ground. The comment this
//    replaces warned about a smear and then built one.
//
// So: the sawtooth is a GLOBAL function of the clock, and the DISPLACEMENT is
// the local velocity times it. grad(phase) is then zero, the offset field's
// gradient is FLOW_CYCLE * grad(velocity) — bounded, and independent of how
// long the game has been running — and the cycle travel is speed * FLOW_CYCLE,
// so fast water genuinely travels further per cycle than slow water instead of
// every pixel in the map travelling the same eight metres.
//
// ── FLOW_CYCLE, and what set it ────────────────────────────────────────────
// Measured over the shipped flow field, on the 23.0% of wet texels that move at
// all (speed > 0.05 m/s; the other 77.0% are standing water and must not move):
//
//     speed, m/s        p25 0.524   p50 1.048   p75 2.031   p90 3.134
//     |grad v|, 1/s     p25 0.058   p50 0.112   p75 0.211   p90 0.328
//
// The cycle buys legibility at (speed * P) / (2 * feature) and costs shear at
// about (0.5 * P * |grad v|) — half, because the copy carrying the weight is
// the one at half the cycle's offset. At P = 5 s that is 5.2 m of travel at the
// median and 0.28 / 0.82 of shear at p50 / p90, which puts the 1.2 m chop at a
// ratio of 2.2 and holds the distortion under a third of a feature over most of
// the map. Swept against the instrument in flow/: see the table at the
// declaration below.
//
// A COARSE FIELD UNDER A SHORT CYCLE IS SAFE, which is why one constant serves
// every scale here. The 52 m mass field travels 5 m per cycle, so its ratio is
// 0.05 — but the two copies are then 2.5 m apart on a 52 m feature, i.e. nearly
// identical, so the cross-dissolve's AMPLITUDE is 5% of contrast as well. Both
// terms are small and the field reads as very nearly static, which is what a
// long streak sliding along its own length looks like. The failure mode a
// cross-fade has is a coarse field under a LONG cycle, and there is none here.
//
// The degenerate case is still exact and is now exact in a stronger sense: at
// speed zero BOTH offsets are zero, so the two copies are the same sample and
// the cross-fade is between a field and itself. Standing water is bit-identical
// to a build with no advection machinery at all. Nothing branches.
// ── FIVE SECONDS, AND IT IS AN INTERIOR OPTIMUM, NOT A CEILING OR A FLOOR ──
// Swept on the real build, three views, four gap rungs, scored on the LONGEST
// window in which the predicted displacement still lands inside the
// correlator's search — because a cross-fade whose centroid never moves can
// report a perfect instantaneous velocity while going nowhere, and scored on
// the shortest rung this instrument put 922 of river's 1275 usable patches on
// a 60 ms gap. Angle is the error between the measured displacement and the
// one this file's own 'speed' predicts, projected through the live camera;
// 'tail' is the fraction of patches past 90 degrees, i.e. uncorrelated:
//
//     FLOW_CYCLE     river ang p50   tail    ratio p50 |  plunge ang p50  tail    ratio p50
//     shipped (8 m)     114.4 deg   55.3%      0.388   |     81.4 deg   42.5%     0.651
//     3 s                 8.8 deg   18.3%      0.863   |     62.3 deg   39.2%     0.935
//     5 s                11.4 deg   25.9%      0.816   |     41.0 deg   32.3%     1.025
//     8 s                16.9 deg   33.5%      0.680   |     46.6 deg   32.6%     0.936
//
// river prefers 3 and plunge prefers 5, and 5 is taken on three grounds. It has
// the best median angle averaged over the two (26.2 deg against 35.6 and 31.8)
// and ties 3 on the tail. plunge is the framing with genuinely fast water and
// its measurement runs on a 0.4 s window against river's 0.15 s, so it is the
// more travel-like of the two readings. And a separate synthetic test, run on
// the actual scheme over a uniform flow where the true velocity is known
// exactly, says the blend tracks that truth only while the gap stays under
// about a third of the cycle and then INVERTS — measured displacement against a
// truth of 8.00 px at dt = 1.0 s: P=1.5 reads 3.64, P=3 reads -8.30, P=5 reads
// 8.20, P=8 reads 8.63, P=12 reads 7.92. Three seconds gives a coherent
// tracking horizon of one second; five gives 1.7, which covers the window an
// eye actually pursues a feature over. The same test says shear is NOT what
// bounds this: repeated at |grad v| * P of 0.28, 0.56 and 1.0 the tracking
// barely moves, because a local patch of a smoothly sheared field is still a
// translation. What bounds it is the ratio of cycle travel to feature size.
const float FLOW_CYCLE = 5.0;   // seconds
// x, y = metres of advection for the two copies; z = mix weight toward the
// second. Continuous in time by construction: at the wrap the weight is 1 and
// the second copy's offset is exactly half a cycle either side of it.
//
// ── the spatial phase break, and why a global sawtooth needs one ────────────
// A phase that is purely a function of the clock wraps everywhere at the same
// instant, and the cross-fade's own contrast dips by 1/sqrt(2) at the crossover
// wherever the two copies are far enough apart to have decorrelated. Uniform in
// space, that is the whole surface of the map breathing together at 2/P Hz —
// a marching pattern, which the brief names as worse than stillness.
//
// So the sawtooth carries a STATIC spatial offset. One octave of value noise,
// not two: this is a phase, not a texture, and nothing downstream can see its
// spectrum. Measured on wNoise itself over 40 000 world points, p * 0.031 at
// x2.6 is a 32.3 m period and a standard deviation of 0.444 of a cycle, which
// decorrelates the wrap over tens of metres — the scale at which this map's
// water already varies through 'gust'.
//
// MEASURED, on the scheme itself over one P = 5 s cycle, as the spatial SD of
// the frame — which is what a contrast pulse is. Amplitude in cycles, against
// the peak-to-mean swing over the cycle:
//     0.0   0.1578 -> 0.1305 -> 0.1578        19.3%   the whole map, in step
//     0.5                                      3.3%
//     1.0                                      4.3%
//     1.8                                      1.2%
//     2.6                                      1.1%   <- this
//     4.0                                      1.2%
// It is flat from about 1.8 upward, so 2.6 sits on the flat with margin rather
// than on a knee.
//
// AND IT IS NOT FREE, which the first draft of this note got wrong by a factor
// of three. A phase that varies in space is extra offset gradient, and it is
// FLOW_CYCLE * speed * |grad phase|: measured, |grad phase| is p50 0.0443 and
// p90 0.0793 cycles per metre, so at the median moving speed's 5.24 m of cycle
// travel it contributes 0.232 at p50 and 0.416 at p90 — the same order as the
// 0.28 / 0.82 the velocity field's own gradient contributes, not a rounding
// error against it. It is still well under the level at which the synthetic
// test above shows tracking degrade (shear * P of 1.0 barely moved it), so it
// is paid. If a later round wants it cheaper, 1.8 measures the SAME 1.2% pulse
// for 30% less of this distortion and is the change to make; it was not landed
// here only because it would have invalidated every flow number in this file
// for a difference the instrument cannot see.
//
// It cannot disturb standing water: the offsets are multiplied by speed, so at
// speed zero the phase is free to be anything and both copies are still the
// same sample.
// ── THE PERIOD IS A PER-FIELD CHOICE, AND THAT IS THE WHOLE MOTION FIX ─────
//
// The note above proves the two-copy blend has zero net travel, and then treats
// that as a statement about the correlator. It is worse than that, and the
// reason is one line of calculus: for a field that is SMOOTH over the distance
// between the two copies,
//
//     mix(F(x - a), F(x - b), w)  ~=  F(x - ((1-w) a + w b))
//
// to first order — and the bracket is exactly the centroid the note tabulates
// as identically L/2. So a coarse field under a short cycle does not merely
// read as static, it IS static: the blend of two nearly identical copies is one
// copy at a FIXED offset, and moving the clock moves nothing at all. The
// approximation fails, and the picture starts to travel, only once the two
// copies are far enough apart to have DECORRELATED — once
//
//     travel / 2  =  speed * period / 2   is comparable to the feature size.
//
// The mass field is 14-26 m across at k = 0.019 and its half-travel at P = 5 s
// on median moving water is 2.6 m, a tenth of a feature. It is in the smooth
// regime by an order of magnitude, which is why 'river' measured a median patch
// NCC of 0.998 against itself after a full second.
//
// So the period is not one number for the whole shader. FLOW_CYCLE stays where
// the sweep at its declaration put it for everything whose legibility came from
// the ripple field; a field that has to be SEEN to travel gets its own longer
// one, because travel is speed * period and speed is the flow field's to set,
// not this file's.
vec3 wFlowPhaseAt(vec2 p, float speed, float period){
  float cyc = uTime / period + wNoise(p * 0.031) * 2.6;
  float f0 = fract(cyc);
  float f1 = fract(cyc + 0.5);
  float travel = speed * period;
  return vec3(f0 * travel, f1 * travel, abs(1.0 - 2.0 * f0));
}
vec3 wFlowPhase(vec2 p, float speed){ return wFlowPhaseAt(p, speed, FLOW_CYCLE); }

// A scalar field that travels with the current. Two taps.
float wDrift(vec2 p, vec2 T, float k, vec3 ph){
  return mix(wFbm2((p - T * ph.x) * k),
             wFbm2((p - T * ph.y) * k), ph.z) * 0.5 + 0.5;
}

// ...and one whose marks LIE ALONG the current. Four taps: a second sample a
// fixed distance downstream, averaged in, smears the along-flow variation away
// and leaves features elongated in the direction of travel. This is the one
// thing that makes flowing water read as flowing rather than as noise that
// happens to be moving, and it is also what plate 3 draws on its still water —
// broad soft masses lying ALONG the river, never isotropic patches.
//
// The offset is a bounded distance in metres, which is the only kind of
// operation a spatially varying frame may be used for. Rotating the domain
// itself — sampling at dot(p, T) — is what a swept ribbon could do and this
// cannot: with T a function of position, the gradient of dot(p, T) picks up a
// term in the world coordinate itself, which reaches into the hundreds a
// kilometre from the origin and drowns the field.
float wStreak(vec2 p, vec2 T, float k, float stretch, vec3 ph){
  vec2 a = (p - T * ph.x) * k;
  vec2 b = (p - T * ph.y) * k;
  vec2 s = T * (stretch * k);
  return mix((wFbm2(a) + wFbm2(a + s)) * 0.5,
             (wFbm2(b) + wFbm2(b + s)) * 0.5, ph.z) * 0.5 + 0.5;
}

void main() {
  // The surface where it really is. vWPos is the drawn geometry, which was
  // lifted clear of the terrain by vLift so the polygon never becomes the
  // visible edge; everything below — depth, the footprint, the reflection
  // origin, the sun march — is about the real surface, which is this.
  vec3 P = vWPos - vec3(0.0, vLift, 0.0);
  vec4 D = wWorldData(P.xz);
  float bed = D.r;
  float depth = P.y - bed;

  // Metres of water covered by one pixel. Everything band-limited below is
  // measured against it. Note wFootprint divides by cos(incidence) floored at
  // 0.035, so on the grazing geometry that is the normal way to look at water
  // here it runs to tens of metres — which is honest, and is why every use of
  // it below is capped. Two shipped defects came from an uncapped one: a depth
  // window widened by a HORIZONTAL footprint, and a world-space reach
  // multiplied by the same unbounded number. Both drew a flat pale slab across
  // the foreground. If a new term scales by foot, cap it and check its units.
  float foot = wFootprint(P, cameraPosition, uPixelScale);
  float dist = length(cameraPosition - P);
  // How far into the aerial perspective this pixel sits. A body a kilometre off
  // is a flat mass at a grazing angle, and almost everything that gives near
  // water its life is noise there.
  float far = smoothstep(80.0, 420.0, dist);
  // There was a 'near = 1 - smoothstep(3, 34, dist)' here and it is gone. Its
  // one consumer was the fine body mottle, and a RANGE is the wrong criterion
  // for whether a 3 m feature survives — see the note there. Nothing else in
  // this shader rations on absolute distance except 'far', which is haze and
  // genuinely is a distance.

  // ── the flow field ───────────────────────────────────────────────────────
  // This is what used to be four vertex attributes on a separate mesh.
  vec4 FL = wFlow(P.xz);
  vec2 vel = FL.rg * 2.0 - 1.0;
  // Not a unit vector: the magnitude is a COHERENCE. It falls off wherever
  // neighbouring water disagrees about which way it is going, which is exactly
  // what happens as a channel opens into standing water, and it is what makes
  // the hand-over a fade instead of a switch. Standing water is coherence zero
  // and everything downstream of here reads as a lake.
  float coh = clamp(length(vel), 0.0, 1.0);
  // Where there is no current the anisotropic frame still has to exist, and the
  // honest axis for still water is the wind — which is what the lake shader
  // this replaces always combed its masses along.
  vec2 wdir = normalize(uWind + vec2(1e-4, 1e-4));
  // Steered, not switched. This was 'coh > 0.02 ? vel/|vel| : wdir', and a
  // ternary on a field is a discontinuity drawn on the water: every quantity
  // downstream of T — the streaked mass, the anisotropic wave differences, the
  // foam streak — jumps by whatever angle separates the current from the wind
  // at the texel where the test flips, and the mass field is QUANTISED, so what
  // that jump draws is a hard-edged step with a lattice staircase on it.
  // Nothing on standing water changes: the bake writes velocity times
  // (1 - lake), so a lake is an exact zero and steer is 0 over all of it. The
  // 0.02 bias along the flow is there only so the mix can never be handed the
  // zero vector to normalise; at its worst it rotates T by 1.1 degrees.
  vec2 vdir = vel / max(length(vel), 1e-4);
  float steer = smoothstep(0.015, 0.075, coh);
  vec2 T = normalize(mix(wdir, vdir, steer) + vdir * 0.02);
  vec2 Bv = vec2(-T.y, T.x);
  float disch = FL.b;                 // 0..1, matches 'flow' on the polylines
  float turb = FL.a * coh;            // steep / pinched / fast
  // Metres per second, near enough. The constants are the swept ribbon's,
  // carried over unchanged because they were calibrated against this map: a 2%
  // surface gradient is a lazy meander and a 20% one is a genuine rapid.
  float speed = (0.55 + 4.2 * disch + 3.0 * turb) * coh;
  vec2 p = P.xz;
  vec3 ph = wFlowPhase(p, speed);

  // ── how far is this pixel from dry ground, in METRES OF GROUND ───────────
  // Two estimates, combined so that each does the job it is good at.
  //
  // Depth divided by the local bed gradient is what both old shaders used. It
  // is per-pixel and precise near the bank, and it EXPLODES on a flat apron
  // where the gradient floor is all that bounds it — and this map is mostly
  // flat apron. Every term ever rationed by it ran unrationed over the
  // foreground of 'mouth'.
  //
  // The mesh's own chamfer is a measured horizontal distance and cannot
  // explode. What it cannot do is place anything: it is a lattice quantity
  // interpolated linearly across triangles, so its level sets are straight
  // segments with a kink at every triangle edge, and any hard threshold on it
  // comes out as a row of faceted wedges. That was measured, by rendering it —
  // the pale hard-edged wedges along the far bank in 'river'.
  //
  // So: the per-pixel estimate places everything, and the lattice one is only a
  // CEILING on it, slack by one lattice step so it can never bite at the scale
  // the shoreline bands live at. Outward, the roles swap — a damp band is
  // killed by being FAR from the water, so the larger of the two is the safe
  // one there.
  //
  // ── and the field it is measured on is ONE FETCH OF ONE THING ───────────
  vec4 HY = wHydro(p);
  // Signed metres of ground to the waterline, twice: once on the field the line
  // is PLACED on, and once on the bed the terrain mesh actually draws. HY.a is
  // the two beds' disagreement in metres of HEIGHT, so it converts at the
  // field's own slope.
  float sdistLP  = HY.g;
  // The raw bed's disagreement, in metres of HEIGHT, converted at the field's
  // own slope. Taken as (raw depth - the depth the line was placed on) rather
  // than from a channel: hydroField.js used to publish exactly this number as
  // bedDelta and no longer does, and one subtraction of two things this shader
  // already holds is cheaper than a channel anyway.
  float sdistRaw = HY.g + (depth - HY.r) / W_HYDRO_SLOPE;
  // ── the dual-scale placement, and the invariant that makes it safe ───────
  // The smooth field places the line; the raw one only modulates it. Blended
  // three parts to one, so the line sits three quarters of the way onto the
  // conditioned bed — and the residual, which is a quarter of the two beds'
  // disagreement, is handed straight to the edge width below. The transition
  // half-width is therefore never smaller than the wobble it has to hide, so
  // what is left of the crenellation shows up as a band that BREATHES in width
  // along its length and never as a line that moves. That is the difference
  // between a scalloped edge and an organic one, and it is an identity rather
  // than a tuning: change the blend and the widening follows it.
  //
  // The disagreement is real and it is why the raw bed cannot simply be
  // dropped: hydroField.js measures the water shader's line and the terrain
  // mesh's line 0.44 m apart at the median and 2.16 m at p90, in HEIGHT. On a
  // 1:30 apron 0.44 m of height is thirteen metres of ground, and a shoreline
  // placed thirteen metres from the ground the player can see is a stain.
  //
  // MEASURED at 0.85 rather than 0.75, and the number came off aaPx. On distant
  // flat aprons the two beds disagree by enough that wob sits on its 2 m cap,
  // and edgeW is then the WOB and not the pixel: dropping the screen
  // coefficient from 1.60 to 1.05 moved 'river' from 4.69 px to 5.10 and 'hero'
  // from 4.68 to 4.40, i.e. by noise, which is the signature of a term that is
  // not in control. Taking the blend from 0.75 to 0.85 cuts the residual — and
  // therefore the widening — by two fifths without touching the invariant,
  // because the two move together by construction.
  float sdist = mix(sdistRaw, sdistLP, 0.85);
  float wob = min(abs(sdistRaw - sdistLP) * 0.15, 1.4);
  // One pixel, in metres of ground, taken from the screen and not guessed.
  //
  // The ceiling is NOT a constant, and that was measured the hard way. At a
  // fixed 6 m it read as "generous" and was in fact the tightest thing in the
  // shader: at 'mouth' the far shore is four hundred metres off at a grazing
  // incidence and one pixel there spans thirty metres of ground, so the edge
  // was being asked for a 9.6 m half-width where a pixel is 30 m — a third of a
  // pixel, i.e. a hard aliased line. tools/wedge.mjs read aaPx 0.89 there and
  // did not move when the coefficient was raised, which is the signature of a
  // clamp and not of a coefficient.
  //
  // So it is bounded against the OTHER estimate of the same quantity instead.
  // wFootprint is analytic and cannot blow up; fwidth is directional and can,
  // on any quad whose neighbours straddle the mesh silhouette or the sdf's own
  // ±48 clamp. Six times the analytic footprint admits every honest reading —
  // fwidth exceeds foot only by the ratio of the shoreline's screen direction
  // to the view direction — and rejects the silhouette case, which runs to the
  // full 96 m span of the field. The 3 m floor under the bound is for the near
  // field, where foot is a tenth of a metre and a shoreline running along the
  // view still legitimately crosses a metre of ground per pixel.
  float aaPix = clamp(fwidth(sdist), 0.02, max(foot * 6.0, 3.0));
  // ── and the lattice ceiling is GONE ──────────────────────────────────────
  // Every shoreline distance in this shader used to be min(depth/grad, vShore+6)
  // inward and max(-depth/grad, -vShore) outward, because depth over a floored
  // gradient explodes on a flat apron and this map is mostly flat apron, and
  // aShore was the only thing that could bound it. That bound cost what it
  // bounded: aShore is a chamfer interpolated linearly across 4 m quads, so its
  // level sets are straight segments with a kink on every triangle edge and a
  // RIDGE along the medial axis of the body, and a hard min() on it draws those
  // ridges as a crease over open water.
  //
  // HY.g cannot explode — it is a Euclidean distance transform capped at ±48 m
  // with a unit gradient — so there is nothing left to bound and no reason to
  // consult the mesh about a distance. Both quantities are now the same field
  // read with two signs, which also means the shoreline and the damp band can
  // no longer disagree about which side of the line a pixel is on.
  float shoreIn  = max(sdist, 0.0);
  float shoreOut = max(-sdist, 0.0);

  // How close to the bank, as a fraction of the local half-width. This is what
  // the ribbon's aSide attribute was: 0 mid-channel, 1 against the bank. On a
  // lake vSpan is at its cap, so it is 0 over the whole open surface and only
  // wakes up within a channel-width of the shore.
  // Openness, from the same fetch as everything else. vSpan is the same
  // quantity read off a vertex attribute, and MESH has just made that attribute
  // an honest distance transform — but it is still linear across a triangle, so
  // it seams at chunk edges and its level sets kink. HY.a is the field it was
  // derived from, mipmapped, and it agrees with HY.g by construction rather
  // than by coincidence, which matters because every use below is a RATIO of
  // the two.
  float span = max(HY.a, 0.35);
  float bankT = 1.0 - clamp(shoreIn / max(span, 1.5), 0.0, 1.0);
  // The width of everything shore-related scales with the body. A fixed one
  // metre band is the whole surface of a two-metre brook, which is how a quiet
  // creek ends up rendered as solid whitewater.
  float shoreBand = clamp(span * 0.30, 0.30, 1.6);

  // ── the shoreline ────────────────────────────────────────────────────────
  // Water exists exactly where the surface is above the ground, and the edge of
  // it is antialiased IN SCREEN SPACE. One smoothstep on one signed field, over
  // a half-width that is the largest of three things, each of which is a
  // different failure if it is left out:
  //
  //   aaPix * 0.75   ~1.5 px. Without a screen-space term the fade is a fixed
  //                  distance on the ground, so at range the whole of it
  //                  collapses inside one pixel and the waterline is a hard
  //                  aliased edge — which is the crenellated shoreline in
  //                  'waterfall' and the zigzag rivers in 'hero'.
  //   0.22 m         the artistic floor, so a bank two metres in front of the
  //                  camera is still a soft edge and not a razor.
  //   wob            the quarter of the two beds' disagreement left after the
  //                  dual-scale blend above. This is what turns a scalloped
  //                  line into an organic one; see the invariant there.
  //
  // WHAT THIS REPLACES, AND WHY IT WAS THE PALE SLAB. The old edge was a min of
  // two fades, and the first of them was
  //     smoothstep(0.0, 0.62 + min(foot, 5.0) * 0.55, depth)
  // — a window in DEPTH widened by a HORIZONTAL footprint. That is exactly the
  // units error the comment at 'foot' above warns about, twice, and it was live:
  // foot divides by cos(incidence) floored at 0.035, so on the grazing geometry
  // water is normally seen at it pins to its 5 m cap past about 110 m and the
  // window opens to 3.37 m OF DEPTH. On this map's 1:30 aprons that is a
  // hundred metres of ground held at partial alpha, and what shows through a
  // half-transparent blue surface over a tan bed is a flat, neutral, grey-mauve
  // slab. MEASURED, by rendering (depthFade, the metre fade, wetT) to the frame
  // at 'mouth': the metre fade was saturated over the whole foreground and the
  // depth fade was not, so alpha was the depth fade everywhere the slab is, and
  // the slab's inner boundary was a depth iso-contour of a bilinear texture —
  // hence the pixel staircase along it. The damp band was ruled out in the same
  // capture: it is the blue channel and it is a narrow strip, as designed.
  //
  // Nothing here is in depth any more. The only depth left in the alpha chain
  // is the see-through in the shallows near the bottom of this function, which
  // is a statement about how much bed you may see and is correctly a depth.
  // MEASURED, and the history is worth keeping because most of it was measured
  // against a broken instrument. tools/wedge.mjs's aaPx and stair were both
  // rewritten mid-round; every number this block was tuned against before that
  // is retracted, including a confident conclusion that 'mouth' was limited by
  // the dry-side geometry rather than by this ramp. It is not. On the corrected
  // tool, same bake, this shader against the one it replaces:
  //
  //     framing     fine            stair            crenel           aaPx
  //     river       44.1% -> 16.9%  42.9% ->  9.6%   1.328 -> 1.072   9.30 -> 3.0
  //     mouth       18.6% ->  8.4%  12.9% ->  2.9%   1.082 -> 1.028   8.95 -> 1.9
  //     hero        27.0% -> 20.7%  20.7% -> 12.2%   1.151 -> 1.085   6.35 -> 3.0
  //
  // The coefficient stays at 1.60, which is where 'mouth' reads 2.41 — the
  // middle of the target band. Lowering it to 1.05 was tried and is recorded at
  // the blend above: it moved 'river' and 'hero' by noise, because on those two
  // framings the edge width is the bed-disagreement residual and not the pixel,
  // and the residual is the right place to fix them.
  //
  // The old edge measured aaPx 8.95 at 'mouth' — not antialiasing, a fade eight
  // and a half metres wide, which is the pale slab wearing another hat.
  float edgeW = max(aaPix * 1.60, 0.18) + wob;
  // ── and it is ASYMMETRIC, because the dry side runs out of geometry ───────
  // A symmetric fade needs edgeW metres of DRY ground to finish in, and there
  // are only ever nine: this shader's own outer guard takes alpha to zero by
  // 9 m of sdist, and Water.js stops emitting quads at SURF_DEAD_M = 11 m for
  // exactly that reason. At 'mouth' the far shore is seen at an incidence where
  // one pixel spans about thirty metres of ground, so a two-pixel fade wants
  // sixty metres of it and has nine — which is why raising the coefficient
  // above moved aaPx by 0.03 and no more. It was never the coefficient; it was
  // the room.
  //
  // The wet side has no such limit — there are hundreds of metres of water
  // behind the line — so the two halves get different widths and the 50% point
  // stays exactly on the waterline. The alternative, shifting a symmetric ramp
  // inward until it fits, moves the line by half its width and at these ranges
  // that is twelve metres of lake deleted.
  //
  // The kink in the derivative at sdist = 0 is real and is the price: alpha is
  // continuous but its slope steps by wIn/wOut at the 50% iso-line. It sits at
  // the steepest point of a smoothstep, where a slope change reads as nothing,
  // and it is one line rather than a whole band.
  // The wet side has no such limit — there are hundreds of metres of water
  // behind the line — so the two halves get different widths and the 50% point
  // stays exactly on the waterline.
  //
  // A/B'd against the obvious alternative, which was to anchor the whole ramp
  // to the geometry — alpha zero at 7 m dry, alpha one however far inside it
  // had to go — and that version is worse where it can be measured at all:
  //
  //     framing     asymmetric (this)      anchored to geometry
  //     river       aaPx 2.24  fine 15.9%  aaPx 4.51  fine 24.5%  crenel 1.134
  //     hero        aaPx 1.77  fine 18.6%  aaPx 1.77  fine 19.7%
  //     mouth       aaPx 0.86              aaPx 0.86
  //
  // The anchored form takes 'river' two and a half times over its target width
  // and puts fine back where it started, for no gain anywhere, because sliding
  // the 50% point inward turns a soft edge into a soft edge in the wrong place.
  //
  // The kink in the derivative at sdist = 0 is real and is the price: alpha is
  // continuous but its slope steps by wIn/wOut at the 50% iso-line. It sits at
  // the steepest point of a smoothstep, where a slope change reads as nothing,
  // and it is one line rather than a whole band.
  float wOut = min(edgeW, 7.5);
  float wIn  = min(edgeW, 60.0);
  float shoreFade = smoothstep(-1.0, 1.0, sdist >= 0.0 ? sdist / wIn : sdist / wOut);
  float alpha = shoreFade;

  // ── the perched guard ────────────────────────────────────────────────────
  // The mesh is deliberately dilated past the baked water so the shoreline fade
  // and the damp band have geometry to finish inside, and that ring is
  // legitimately outside the bake. What must never happen is the surface
  // painting itself down a rock face: D.g is the baked water height and is the
  // sentinel -9999 wherever the bake says there is no water at all, so anything
  // still below -40 after the texture's linear filter is unambiguously outside
  // a body rather than merely near its edge. Metres above the ground separates
  // the two cases — a shore lies within a fraction of a metre of the ground it
  // covers, and water on a cliff is metres above it.
  //
  // This is the ONLY such guard now. The ribbon needed a second one ('airborne')
  // because its height came from a polyline that kept going after the bed
  // dropped out from under it; a surface contoured from the baked grid cannot
  // do that, because the bake refuses to write channel water more than three
  // metres above its own bed. One surface, one guard.
  // Read off H now, not off the sentinel directly: hydroField.js measures that
  // test as a BINARY mask on the 2 m lattice — between a wet texel at 12 m and a
  // dry one at -9999 the -40 threshold is crossed one centimetre past the wet
  // texel's centre — biting on 23% of the mask boundary with no antialiasing at
  // all. H.b is that test today and a real 0..1 coverage the moment uHydroTex
  // lands, and this line does not change when it does.
  alpha *= 1.0 - (1.0 - HY.b) * smoothstep(1.2, 3.5, depth);
  // ...and the ring has an outer limit that does not depend on depth at all.
  //
  // MEASURED, and it is why the dilation cannot be the answer on its own: the
  // ring carries the water level outward from the body it grew from, and on the
  // flat aprons this map is full of that imported level stays ABOVE the ground
  // for tens of metres — the rill network cuts a broad shallow trough either
  // side of every channel, and the fill surface a reach is traced over sits
  // above the terrain across a whole floodplain. Counted over the map, 27% of
  // the cells where the ring runs out still have depth above the iso value at
  // the boundary; growing the ring from 4 rings to 32 only takes that to 7.6%,
  // and costs a third of the surface's triangles doing it. So the mesh always
  // ends somewhere with water still notionally on it, and what is drawn there
  // is a cell-aligned polygon edge at full alpha — the sawtooth along every
  // channel in 'river'.
  //
  // The bake's own account of where water is does not have this problem, and
  // the mesh already carries it: aShore is signed, and negative means outside
  // the wet mask. A few metres of ring is a shoreline; nine is not water by any
  // account, whatever level the flood-fill left lying over the meadow. Wide and
  // soft, so the lattice the distance is measured on cannot show through it.
  // On HY.g, not on vShore: same ramp, same two numbers, and Water.js's
  // SURF_DEAD_M = 11 still bounds it with two metres to spare — but on a field
  // whose level sets are smooth curves rather than a triangle-interpolated
  // chamfer, so the outer limit of the surface stops being a source of straight
  // edges. INTEGRATOR: if this 9 ever moves, SURF_DEAD_M has to move with it.
  // Kept at 2-9 m because Water.js's SURF_DEAD_M = 11 is a restatement of it and
  // the two must not drift apart. INTEGRATOR: if this 9 moves, that 11 moves.
  //
  // A probe run with this line deleted entirely, on the same bake, is recorded
  // here for whoever needs it next — but its numbers were taken with the
  // pre-fix wedge.mjs and are retracted with everything else measured that way.
  alpha *= 1.0 - smoothstep(2.0, 9.0, -sdist);

  // ── the damp margin is GONE from this shader, and that is the fix ────────
  //
  // It used to live here: 0.9 m of dark ground on the dry side, drawn by the
  // water surface and pushed into alpha with alpha = max(alpha, wetT * 0.80).
  // That max() is the defect. Anything max()'d into alpha decides where the
  // water ENDS, so the damp band WAS the outer boundary of the water layer —
  // and the band was rationed by dist, by foot and by aaPix, all functions of
  // where the camera stands.
  //
  // MEASURED by a critic with the engine's clock frozen, so nothing in the
  // scene animated at all: translating the camera five metres swung 6-25% of
  // the waterline's world-space cells by more than 30% of full coverage, and a
  // third to two thirds of those swings REVERSED direction. The control that
  // proves it is not resampling: a 3.6 degree ROTATION moves the pixels exactly
  // as a translation does and produced ~0, while translation produced 5-25%.
  // Six identical frozen renders read exactly 0.00 on all nine sites. Geometry
  // cannot do that, and the geometry did not move.
  //
  // TWO ATTEMPTS TO KEEP THE BAND HERE AND FIX IT BOTH REGRESSED HARD. They are
  // recorded because together they prove the band cannot stay:
  //
  //   1. Hold the alpha geometric, withdraw only the COLOUR with distance. The
  //      band then paints water over the bank at alpha 0.80 wherever it is
  //      withdrawn — a 0.9 m halo round every distant river. hero fine
  //      10.8% -> 16.3%.
  //   2. Hold the alpha geometric and converge the colour ON THE BANK
  //      (uDampDark -> 1.0) so it composites to nothing. It does not: lit gold
  //      painted over the bank is not the bank, the difference capture sees it,
  //      and the contour then traces the band's own ragged outer edge instead
  //      of the waterline. river 9.3 -> 17.9, mouth 6.3 -> 15.1, plunge
  //      6.8 -> 19.3, contour length up 40%.
  //
  // Both failures say one thing: the band's alpha and its colour cannot be
  // separated, because the band is drawn BY THE WATER over dry ground. So the
  // water stops drawing it. TerrainMaterial draws it instead, from this same
  // hydro field, so the two cannot disagree — and the terrain is opaque, so a
  // margin drawn there has no silhouette to move and the whole class of defect
  // goes away. See docs/WATER_ART_SPEC.md 3.1/3.5 for the spec that moved.
  //
  // What is left here: the water's alpha ends at the waterline. shoreFade, the
  // two guards above, and the foam terms. Nothing else may be max()'d into it,
  // and in particular nothing that reads dist, foot or aaPix may be — aaPix is
  // allowed only where it is SYMMETRIC about the 50% line, which changes how
  // soft an edge is without moving it.
  if (alpha < 0.012) discard;

  // ── surface gradient ─────────────────────────────────────────────────────
  // Not sinusoids. Four travelling waves with a shared phase origin comb a
  // surface into corduroy however they are weighted — the previous lake shader
  // warped them by two scales at once and the water still resolved, under
  // magnification, into two families of perfectly regular crests crossing at
  // forty degrees. A sine is a sine. So the gradient comes from a noise field
  // by finite difference, which is aperiodic in every direction and band-limits
  // for free: once a pixel spans more than a feature the difference averages
  // that feature away instead of aliasing it.
  //
  // The differences are ANISOTROPIC, taken along and across the flow rather
  // than along x and z. A long baseline downstream and a short one across it
  // averages out the along-flow variation and leaves crests running ACROSS the
  // channel, which is what a riffle is; on still water the axis is the wind and
  // the same construction gives the combed lanes a lake actually has.
  // Openness, for the wave fetch. On HY.g for the same reason as everything
  // else — a chamfer's medial-axis ridge painted across a lake through a
  // gradient amplitude is a crease. Capped at 48 by the field, which is why the
  // top of the ramp comes in from 55 m to 44.
  float fetch = 0.42 + 0.58 * smoothstep(4.0, 44.0, shoreIn);
  float wmag = length(uWind);
  // Wind drift is a plain coordinate offset because the wind direction is a
  // uniform — no advection machinery needed, and none of its cost.
  //
  // ── AND IT IS UNCONDITIONAL, WHICH WAS TRIED THE OTHER WAY AND MEASURED ───
  // Wind ripple is advected by the current it sits on rather than walking
  // across a river independently of it, so the obvious correction is to
  // withdraw this with coherence: pw = p - wdir * (uTime * 0.55 * (1 - coh)).
  // It is physically right and it REGRESSED the thing it was meant to fix.
  // Against the flow instrument in flow/, same build otherwise:
  //
  //     river   angle p50   12.6 -> 38.4 deg     ratio p50  0.875 -> 0.573
  //             uncorrelated tail  29.1% -> 39.0%   moving/static 4.82% -> 4.32%
  //     plunge  angle p50   27.5 -> 41.7 deg     ratio p50  1.583 -> 1.118
  //             uncorrelated tail  17.1% -> 30.2%   moving/static 5.33% -> 4.97%
  //
  // The reason is worth keeping, because it says what motion is expensive here.
  // This offset is a PURE TRANSLATION: one direction, one speed, no cross-fade
  // riding on it and no shear, because the wind is a uniform. Everything the
  // flow field drives is a two-copy blend whose dissolve is a fixed fraction of
  // its advection. So per unit of screen contrast the wind drift is the most
  // legible motion this shader owns, and taking it off moving water takes off
  // real, coherent, visible movement — the temporal RMS over open water fell
  // with it. It stays.
  vec2 pw = p - wdir * (uTime * 0.55);
  vec2 g = vec2(0.0);
  {
    // Broad swell, ~9 m features. Driven by wind on still water and by
    // discharge on moving water, so a river is never glassy and a sheltered
    // pond can be.
    //
    // ── SHORTENING IT ON A CURRENT WAS TRIED AND BOUGHT NOTHING ────────────
    // A cross-fade flow map only makes a field read as travelling if the
    // feature is small against the distance travelled in a cycle — the ratio is
    // (speed * FLOW_CYCLE) / (2 * feature), so a 9 m swell sits at 0.29 on this
    // map's median moving water and a 2.9 m one sits at 0.88. k was made
    // mix(0.11, 0.34, coh), with the finite-difference baselines below restated
    // as the same fractions of the feature (0.374 / 0.660 / 0.099 / 0.165 of
    // 1/k reproduce 3.4 / 6.0 / 0.9 / 1.5 exactly at k = 0.11) and the
    // amplitude divided by k so the SLOPE was unchanged. Measured on the flow
    // instrument it moved nothing outside its own spread:
    //     river   angle p50 14.6 -> 12.6 deg, ratio 0.909 -> 0.875, tail 29.7 -> 29.1%
    //     plunge  angle p50 27.4 -> 27.5 deg, ratio 1.528 -> 1.583, tail 15.2 -> 17.1%
    // — i.e. the swell is not what a correlator on this surface locks onto, and
    // the change would have altered the look of 23% of the map's water for a
    // reading inside the noise. Recorded rather than landed.
    float k = 0.11;
    // ── the baselines are CAPPED, and that is why the water stopped moving ──
    // dA is (fbm(q + T*eA) - fbm(q)) / eA. That is a derivative only while eA
    // is short against the feature it is differencing — here 1/k, i.e. 9 m.
    // Once eA passes it the numerator is two independent draws from the same
    // field and stops growing, while the denominator keeps growing, so the
    // whole perturbation falls off as 1/eA. With eA = foot * 1.6 that starts at
    // a footprint of 2.1 m, which on the grazing geometry water is normally
    // looked at from is about thirty-five metres of range. MEASURED by a
    // critic: displacement over 0.72 s divided by what the flow field predicts
    // is 0.02 at 'river' and 0.05 at 'plunge', and the temporal RMS of the
    // surface is 0.0015-0.0039 against a static spatial SD of 0.077-0.092.
    // Past about thirty-five metres nothing that moves survives.
    //
    // Band-limiting a noise field by INFLATING its finite-difference baseline
    // is not band-limiting, it is division. Capped at 0.66 and 0.17 of the
    // feature so the difference never stops being a derivative; the prefilter
    // that was supposed to be doing this job is the distance ration at the foot
    // of this block (0.35 + 0.65 * exp(-dist * 0.006)), which is a smooth
    // withdrawal that does not also decorrelate the two taps.
    float eA = clamp(foot * 1.6, 3.4, 6.0);   // along the flow — crests lie across it
    float eB = clamp(foot * 0.85, 0.9, 1.5);  // across it — short
    vec2 q0 = (pw - T * ph.x);
    vec2 q1 = (pw - T * ph.y);
    float c0 = wFbm2(q0 * k), c1 = wFbm2(q1 * k);
    float dA = mix(wFbm2((q0 + T * eA) * k) - c0, wFbm2((q1 + T * eA) * k) - c1, ph.z) / eA;
    float dB = mix(wFbm2((q0 + Bv * eB) * k) - c0, wFbm2((q1 + Bv * eB) * k) - c1, ph.z) / eB;
    g += (T * dA + Bv * dB) * (2.6 * wmag * fetch + 4.4 * (0.25 + 0.75 * turb) * coh * disch);
  }
  // ── gated on the FOOTPRINT, not on the distance ──────────────────────────
  // The claim this gate rests on is "at forty metres the chop is already inside
  // the footprint", and that is a statement about the footprint, so it should
  // be the footprint that is tested. It is not the same number: wFootprint
  // divides by cos(incidence), and on water seen from an eye 2.2 m up the
  // footprint at 34 m is about 0.29 m against a 1.2 m feature — the chop was
  // being switched off with four pixels still across every wave of it. On this
  // geometry 1.2 m of ground reaches one pixel at about a hundred metres, which
  // is where the gate now closes. Nothing here is resolved that was not
  // resolvable before; the old gate was simply reading the wrong quantity.
  float chopOn = 1.0 - smoothstep(0.9, 2.6, foot);
  if (chopOn > 0.01) {
    // Close chop, ~1.2 m features — the scale you see from a car window.
    float k = 0.85;
    float eA = clamp(foot * 1.6, 0.55, 0.8);
    float eB = clamp(foot * 0.85, 0.16, 0.2);
    vec2 q0 = (pw - T * ph.x) + 31.0;
    vec2 q1 = (pw - T * ph.y) + 31.0;
    float c0 = wFbm2(q0 * k), c1 = wFbm2(q1 * k);
    float dA = mix(wFbm2((q0 + T * eA) * k) - c0, wFbm2((q1 + T * eA) * k) - c1, ph.z) / eA;
    float dB = mix(wFbm2((q0 + Bv * eB) * k) - c0, wFbm2((q1 + Bv * eB) * k) - c1, ph.z) / eB;
    g += (T * dA + Bv * dB) * (0.22 * wmag + 0.42 * coh) * chopOn;
  }
  // Wind on water is patchy: cat's-paws of ripple with glassy lanes between.
  // Flowing water is not — a current is a current all the way across — so the
  // patchiness is withdrawn as coherence rises.
  //
  // ── AND IT WAS PINNED TO WORLD SPACE, which is what a cat's-paw is not ──
  // What shipped drifted this field at 0.05 m/s along +x: 'p * 0.045 -
  // vec2(uTime * 0.05, 0.0)'. wFbm2 at k = 0.045 is a 22.2 m lattice, so its
  // features are about 11 m across and the second octave's are 5 m. At
  // 0.05 m/s one feature takes 220 SECONDS to pass, i.e. 0.0045 of a feature
  // per second — arithmetically indistinguishable from a static field over any
  // window an eye or a correlator looks at. And it multiplies the whole
  // gradient, so what was standing still is the AMPLITUDE of every ripple in
  // the frame: the glassy lanes and the rippled lanes were painted onto the
  // world and stayed there.
  //
  // Two things change. The bearing is the wind's, not +x — +x is arbitrary and
  // it slid the amplitude patches sideways across the ripples they modulate,
  // which is the one direction a cat's-paw never travels. And the speed is
  // 1.6 m/s, which is 0.145 of a feature per second: a patch crosses itself in
  // 6.9 s, so it is visibly moving within one second and completely renewed
  // over the seven-second window a still frame pair cannot see. It is faster
  // than the 0.55 m/s the ripple phase itself drifts at (pw, below), which is
  // correct — a gust front outruns the ripple it raises.
  //
  // It cannot disturb a river: this whole term is mixed out by coherence on the
  // line below, so on moving water gust is 1.0 whatever it does.
  float gust = 0.30 + 1.05 * (wFbm2(p * 0.045 - wdir * (uTime * 1.6)) * 0.5 + 0.5);
  g *= mix(gust, 1.0, coh) * (0.35 + 0.65 * exp(-dist * 0.006));
  // Cross-channel chop builds against the banks, where the flow shears.
  g += Bv * (wDrift(p, T, 0.62, ph) - 0.5) * 0.09 * smoothstep(0.35, 0.95, bankT) * coh;
  // Soft ceiling on the slope. Fresnel at a grazing angle is the steepest
  // function in this shader — a tenth of a radian of normal swings it from body
  // colour to mirror — so an unbounded gradient bands. Soft, because a hard
  // clamp draws its own level set across the water as a visible contour.
  g *= 0.075 / (0.075 + length(g));

  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 V = normalize(cameraPosition - P);
  if (!gl_FrontFacing) N = -N;

  // ── the roughness mass ───────────────────────────────────────────────────
  // One low-frequency field, stepped, and everything painterly below is driven
  // off it: how pale the body is, how much sky the surface hands back, and how
  // far past the shore the reflected cone reaches. One field rather than three,
  // because in the plate a pale patch is pale in its body AND bright in its
  // reflection at the same time — a stretch of rougher, shallower water is one
  // physical thing, not three coincidences. Three independent stepped fields
  // multiply into a dozen levels and come back as mottling.
  //
  // Stepped, because the shoulder is the read. docs/WATER_ART_SPEC.md 2
  // measures plate 3's water as FOUR masses spanning 2.29 stops p10-p90 with
  // hard boundaries; run through a smooth ramp the same noise gives every value
  // between them in equal measure, which averages to the correct mean and looks
  // like satin. The average was never the problem.
  //
  // Streaked along the flow, at a frequency a channel can carry two or three of
  // — 62 m of stretch on a 14 m field. The lake shader's version was 238 m by
  // 53 m, sized for the open basin it was written for, and a fifteen-metre
  // channel sat inside a third of one feature and got a single flat level.
  //
  // The stretch is now a function of the current, and that is a correction with
  // a capture behind it. On STILL water T is the wind, which is a uniform — the
  // same vector over the whole map — so a 62 m stretch combs the entire basin
  // along one compass bearing and the level boundaries of a four-level
  // quantiser come out as straight lines tens of metres long. Rendered to the
  // frame at 'mouth' (R = mass) that is the facet crease across the open water:
  // a hard-shouldered, dead straight tone boundary running from the near shelf
  // into the middle of the bay, with a pixel staircase on it. It is this
  // shader's, not the mesh's. A current earns the stretch because a current has
  // a direction that varies along the reach; a lake does not, so it gets 26 m,
  // which is still directional enough to comb but short enough that the masses
  // read as masses rather than as one long corduroy.
  float streakM = mix(26.0, 62.0, coh);
  float massWide = mix(0.14, 0.5, smoothstep(0.9, 3.4, foot));
  float massRaw = wStreak(p, T, 0.019, streakM, ph);
  // ── AND A SECOND SCALE, BECAUSE THE FIRST ONE CANNOT TRAVEL ──────────────
  //
  // This is the term the round's "the surface is 95% static" measurement was
  // actually about, and the arithmetic that says so is this file's own. The
  // note at FLOW_CYCLE gives the legibility ratio of a cross-faded flow map as
  // (cycle travel) / (2 * feature size), and records that at 0.44 the dissolve
  // is already more than twice the advection. The mass field is k = 0.019,
  // i.e. a 52.6 m lattice whose features run 14-26 m across the flow, and on
  // this map's median moving water (1.05 m/s) a five-second cycle carries it
  // 5.2 m. Its ratio is 0.10 across the flow and, because wStreak elongates it
  // to 62 m ALONG the flow and then translates it along that same axis, very
  // nearly zero along it. The file already says this out loud two hundred lines
  // up — "the field reads as very nearly static, which is what a long streak
  // sliding along its own length looks like" — and treats it as harmless.
  //
  // It is not harmless, because this one field is most of what the picture IS.
  // mass drives the mirror over the whole {0.13, 0.36, 0.58, 0.72} range, it
  // drives 'reach' (how much of the reflection is sky rather than dark
  // hillside, 0.30 to 1.00), and it drives the body's pallor. At a grazing
  // angle Fresnel is saturated and the ripple field can only swing it by about
  // 2x, so on every framing that matters the value structure of the water IS
  // this field, quantised to four levels, standing still.
  //
  // MEASURED, tools/_scratch/wmotion.mjs, engine stopped and uTime written
  // directly on the material so the pair differs by the water clock and NOTHING
  // else (its control, two renders at the same uTime, reads 0.000 levels):
  // 'river' open water has a spatial SD of 30.5 levels and differs from itself
  // by 2.67 levels after a whole second — median patch NCC at zero shift 0.998.
  //
  // So the mass gets a component at a scale the current can actually carry.
  // k = 0.16 is a 6.25 m lattice, features about 3.1 m, and 5.2 m of cycle
  // travel puts its ratio at 0.84 — eight times the coarse field's and past the
  // point where advection dominates the dissolve. Stretched only 6 m, so it
  // still lies along the flow and reads as the boils and slicks a real reach
  // draws rather than as isotropic mottle.
  //
  // Three rations, each of which is a different failure if it is left out:
  //   coh          a lake has no current to carry it, and 3 m masses drifting
  //                across standing water is scum, not water. At coh 0 this term
  //                is exactly the shipped field.
  //   the footprint  3 m features need two pixels; past a 2.8 m footprint the
  //                quantiser would be stepping noise. This is the same gate
  //                shape 'chopOn' uses and for the same reason.
  //   far          at four hundred metres it is haze, and a fine field under a
  //                quantiser at that range is the mottling the 'fine' term
  //                below is withdrawn for.
  // ── A LONGER CYCLE FOR THIS FIELD WAS TRIED AND IT REGRESSED ────────────
  // wFlowPhaseAt exists because of the argument in its own note: a blend of two
  // copies closer together than one feature is algebraically ONE copy at a
  // fixed offset, so a field only starts to travel once its half-travel
  // (speed * period / 2) is comparable to its features. At 3.1 m features and
  // 1.05 m/s, P = 5 s gives 2.6 m of half-travel — right on that boundary — and
  // P = 14 s gives 7.4 m, which is 2.4 features and unambiguously decorrelated.
  // So a 14 s cycle for this term only should have been the fix.
  //
  // MEASURED on tools/_scratch/wmotion.mjs at 'river', same build otherwise,
  // this term on P = 5 against P = 14:
  //     moving/static, dt 1 s     0.211 -> 0.199
  //     patch NCC at zero, dt 1 s 0.954 -> 0.980   (LESS change, not more)
  //     angle error p50, dt 0.25s   8.4 -> 56.3 deg
  //     ratio p50, dt 0.25 s       0.016 -> 0.005
  // It is worse on every column, and the angle blows through the 15 deg gate
  // the round set. The reading is that decorrelating the two copies buys a
  // bigger cross-DISSOLVE, not travel: what the correlator then locks onto
  // points nowhere, which is exactly the failure the FLOW_CYCLE note describes
  // at the old 8 m constant. Kept on the shared phase.
  float boilOn = coh * (1.0 - smoothstep(1.1, 2.8, foot)) * (1.0 - far);
  if (boilOn > 0.01) massRaw = mix(massRaw, wStreak(p, T, 0.16, 6.0, ph), 0.42 * boilOn);
  // The quantiser's input, kept as its own name because the cool governor at
  // the foot of this function reads it. A CONTINUOUS 0..1, not the four-level
  // 'mass' below: a hue boundary drawn on exactly the same curve as a value
  // boundary is a colour edge, and the plate's hue drifts ACROSS its masses
  // rather than stepping with them.
  float massT = smoothstep(0.24, 0.76, massRaw);
  float mass = wStepsAA(massT, 3.0, massWide);

  // ── body colour ──────────────────────────────────────────────────────────
  // The depth ramp is a CONTOUR GENERATOR: it is a smooth function of a
  // heightfield, so wherever the bed flattens it draws its own isoline on the
  // water. Perturbing the depth it reads — and only the depth IT reads — with
  // the mass noise turns that boundary ragged for nothing, and stepping it is
  // the whole difference between a shelf and a sandbar. Our carved beds are
  // smooth and have no bars in them at all, so without the perturbation the
  // ramp sits at one level down a whole reach and the mechanism that draws the
  // plate's best feature never fires.
  float shelfWide = mix(0.15, 0.5, smoothstep(1.2, 5.0, foot));
  // Two scales of perturbation, not one, and the fine one is not decoration.
  // The mass field is 62 m along the flow by 14 m across it, so over a wide
  // shelf it is nearly constant and the quantiser is left drawing the isolines
  // of the depth field itself — and depth here is (a piecewise-bilinear vertex
  // level) minus (a bilinear texture), so its isolines have a kink on every
  // lattice line. What comes out is a flight of axis-aligned steps across the
  // shallows, at the resolution of the water mesh. An 11 m perturbation puts
  // several features across a lattice cell and the steps come out ragged, which
  // is what a bar looks like.
  float shelfN = wDrift(p, T, 0.09, ph);
  // Both perturbations are STRETCHED to a real 0..1 before they are scaled.
  // Raw fbm is a bell that rarely leaves the middle third, so a nominal 3.4 m
  // of jitter delivers under a metre of it — and on the 1:100 aprons this map
  // is full of, a metre of depth is a hundred metres of ground, which is not
  // enough to break a contour. What is left is the quantiser drawing the
  // isolines of the bed itself: a flight of steps across the shallows, which is
  // the terracing on the right of the 'mouth' framing. Stretched, the jitter
  // reaches its stated amplitude and the three boundaries come out ragged,
  // which is what a bar looks like.
  // ── ...and SCALED BY THE WATER ACTUALLY PRESENT, which is the whole fix ──
  // Both amplitudes above are absolute metres — plus or minus 1.7 and plus or
  // minus 0.95 — read into a window that runs 0 to 3.2 m. That is a sandbar
  // field on a river. On a 0.7 m lake it is 2.65 m of jitter against 0.7 m of
  // bathymetry, so the quantiser draws the BAR FIELD and the lake floor is a
  // rounding error, which is exactly what a critic measured: row 560 of 'mouth'
  // runs flat at Y 0.085-0.092 for 45 px, steps +0.97 stops over the next 45,
  // then runs flat again for 350. Plateau, ramp, plateau is posterisation, its
  // outline is a closed lozenge attached to no bank, and it was the frame's
  // THIRD VALUE MASS — 18% of the water. Most of the value structure this file
  // appeared to have gained was one banding step.
  //
  // So the jitter becomes a FRACTION of the local depth rather than a number of
  // metres. A 3 m channel keeps the full amplitude it was tuned on; a 0.7 m
  // lake gets 0.38 of it, which puts the jitter and the bathymetry at about 1:1
  // instead of 4:1 and hands the contour back to the bed. The 0.10 floor is so
  // the shallowest water still gets 0.34 m of break — on the 1:100 aprons this
  // map is full of, 0.34 m of depth is 34 m of ground, which is plenty to keep
  // an isoline from drawing itself as a line.
  float jitter = clamp(depth * 0.55, 0.10, 1.0);
  float deepT = wStepsAA(smoothstep(0.0, 3.2,
                  depth + (smoothstep(0.28, 0.72, massRaw) - 0.5) * 3.4 * jitter
                        + (smoothstep(0.30, 0.70, shelfN) - 0.5) * 1.9 * jitter),
                3.0, shelfWide);
  // The shallow anchor is not a paint colour. It is what you see when you can
  // see the bed, and the bed here is gold meadow. Taken literally as the
  // palette's #9dc4d8 it drew every sandbar in the map as a flat pastel cyan
  // island. docs/WATER_ART_SPEC.md 1.2 measures plate 3's shelf at #536684 —
  // C 0.194, S 0.374, cool 1.12, and half a stop BELOW the meadow, which is the
  // one thing a shelf may never fail to be.
  vec3 shelf = mix(uShallow, uRefGround, 0.13) * 0.52;
  vec3 body = mix(shelf, uDeep, deepT);
  // The margins of a channel are always paler than its core, whatever the bed
  // happens to be doing — the water is thinner there and half full of air.
  // Driven off the distance from the bank rather than off the sampled bed, so
  // the read survives the many reaches where the bed is nearly flat. Ragged,
  // via the mass, because a fixed fraction off a smooth ramp is a symmetric
  // gradient toward both banks and the plates emphatically do not draw that.
  body = mix(body, uShallow * 1.06,
             smoothstep(0.30, 0.95, bankT) * (0.26 + 0.48 * mass) * (0.35 + 0.65 * coh));
  // Fine body mottle, ~3 m features (k = 0.16 is a 6.25 m lattice). Withdrawn
  // where it cannot be resolved, because a fine field that is smaller than a
  // pixel is not detail, it is mottling — pale swirls that read as scum.
  //
  // ── RATIONED ON THE FOOTPRINT, NOT ON THE RANGE, and that is a correction ─
  // It was rationed by 'near = 1 - smoothstep(3, 34, dist)', so it was gone by
  // thirty-four metres. Every framing in the harness that has flowing water in
  // it stands further off than that: 'river' is anchored 30 m from the bank and
  // its channel runs from 45 m to 300 m, so this term — the ONLY fine-scale
  // thing in the body colour, and one that genuinely advects with the current —
  // has never been drawn in the frame it is judged in.
  //
  // The criterion was never the range. It is whether the feature survives the
  // pixel, which is the footprint: 3 m of ground reaches two pixels at a
  // footprint of 1.5 m, and on 'river's grazing geometry that is about 130 m of
  // range rather than 34. Same shape of gate as 'chopOn' above and set from the
  // same arithmetic.
  //
  // The amplitude goes 0.16 -> 0.26 with it. At 0.16 the term is a +/-8%
  // modulation of a body that is then mixed 40-70% with a reflection, i.e.
  // under 3% of the finished pixel; the mass field beside it is +/-14% of the
  // body AND swings the mirror over 2.5 stops, so at the old weight this was
  // two orders below the thing it is meant to break up.
  float fine = wDrift(p, T, 0.16, ph);
  float fineOn = 1.0 - smoothstep(0.55, 1.6, foot);
  body *= 0.86 + 0.28 * mass * (1.0 - 0.65 * far) + 0.26 * (fine - 0.5) * fineOn;
  // Ankle-deep water over gold meadow is warm, not cyan. A third of uSubsurface
  // is what made every lake read as a Caribbean swimming pool at noon —
  // measured at S 0.46 against the palette's own shallow tone at S 0.27.
  body = mix(body, uSubsurface, (1.0 - deepT) * 0.22);

  float shadow = min(getShadowMask(), wSunShadow(P + vec3(0.0, 0.4, 0.0)));
  float ndl = max(dot(N, uSunDir), 0.0);

  // Split the water's colour into a value and a hue. Everything below TINTS
  // with absorb (unit luminance) instead of multiplying by the body, because
  // multiplying by a colour whose red channel is 0.10 is what took the sun out
  // of the water: the surface could not show an amber key however bright the
  // key was, and stayed cyan at dawn while the whole valley went sepia.
  float bodyY = max(wLuma(body), 1e-4);
  vec3  absorb = body / bodyY;
  vec3 irr = (uSunLight * ndl * shadow + uAmbient) / PI;
  // Raised to a power before it is used as a tint. Straight absorption plus a
  // warm key cancels out: the illuminant runs 1 : 0.64 : 0.53 and the water
  // 0.29 : 0.63 : 1.0, and their product is a grey-blue at C 0.22 against
  // reference water measured at S 0.47-0.75. The physics is right and the
  // picture is wrong, because a real body of water gets most of its diffuse
  // glow from SKY, not from a low sun that mostly reflects off it. Deepened
  // further with distance, because four hundred metres of the shared haze eats
  // chroma from whatever it is given.
  float absorbPow = uAbsorbPow * (1.0 + 0.42 * far);
  vec3 absorbDeep = pow(absorb, vec3(absorbPow));
  vec3 lit = wTint(irr * bodyY, absorbDeep, uAbsorb) * uBodyGain;

  // ── foam ─────────────────────────────────────────────────────────────────
  // The ribbon's foam model, which was good, expressed as a function of the
  // flow field instead of vertex attributes. Three drives and a waterline.
  // MESH re-derived aSpan this round: it was a chamfer of the QUAD-level wet
  // mask, so a 6 m channel reported an 8 m half-width, and p50 has gone 12.8 m
  // to 7.3 m — a factor of 2.3 on narrow water (docs/INTEGRATION_REQUESTS.md,
  // MESH item 1). This lookahead was calibrated against the inflated number, so
  // the coefficient is multiplied by that factor to keep the reach it was tuned
  // for: 0.7 * 2.3 = 1.6, which on the honest field is a look one and a half
  // half-widths downstream. At the old p50 both give 10.5 m.
  vec2 aheadV = T * (1.5 + span * 1.6);
  float bedAhead = wBed(p + aheadV);
  // Downstream bed gradient, as a rise over run. Past about thirty degrees the
  // channel is not a channel any more and the surface would draw a thin blue
  // thread down a rock face. That water is the falls system's job, so this
  // hands over: white first, because a cascade on stone is whitewater and never
  // a blue line, then out of existence. Only where there IS a current — a lake
  // dammed against a cliff must not delete itself.
  //
  // The current is a GATE on the hand-off, never a SCALE on it, and getting
  // that wrong is what this round shipped. coh is a coherence, not a flag: it
  // is the length of a blurred mean direction, so it reads well under one even
  // on water that is unambiguously moving — MEASURED at 0.67 on the curtain of
  // the main fall, where two box passes over a pinched, turning reach average
  // neighbouring texels that disagree. Multiplied in, that capped the hand-off
  // at 0.67 and left a THIRD of the surface's alpha painted down the rock face:
  // rendering alpha to the frame put it at 0.20-0.23 over the whole curtain.
  // That is the failure the note at the alpha multiply below predicts, and it
  // is what the blind A/B saw — hard-edged slabs of half-transparent water
  // lying on the fall, striped where the two nearly-coplanar surfaces beat
  // against each other, plus the same film on the perched shelves beside it
  // reading as a plate detached from the fall entirely.
  //
  // So: threshold it. The bake writes velocity times (1 - lake), so standing
  // water is an exact zero and the dammed lake the factor exists for is still
  // safe, while anything with a real current gets the whole hand-off. Low and
  // tight, because everything between "no current" and "a current" here is the
  // blur's few-metre skirt into the body a reach arrives at, and that skirt is
  // flat water whose drop term is zero anyway.
  float moving = smoothstep(0.03, 0.14, coh);
  float cliff = smoothstep(0.58, 1.15, (bed - bedAhead) / max(length(aheadV), 1e-3)) * moving;

  // 1. against the banks — the water piles up and aerates on the edge, but only
  //    within a fraction of a channel width of it.
  float bankFoam = smoothstep(0.55, 0.95, bankT) * (0.15 + 0.55 * disch) * coh;
  bankFoam *= 1.0 - smoothstep(shoreBand * 0.8, shoreBand * 2.6, shoreIn);
  // 2. over obstacles — a bed rising into fast water is a standing wave. It is
  //    the RISE that makes whitewater, not shallowness on its own; a calm
  //    ankle-deep run is glass, and treating depth alone as foam turns a whole
  //    river white.
  float obstacle = clamp((bedAhead - bed) * 2.6, 0.0, 1.0)
                 * (0.15 + 0.85 * disch) * smoothstep(1.8, 0.35, depth) * coh;
  // 3. steep, fast reaches go white all over.
  float rapids = smoothstep(0.28, 0.85, turb) * (0.35 + 0.65 * disch);

  float drive = clamp(bankFoam * 0.70 + obstacle * 0.80 + rapids * 0.95 + cliff, 0.0, 1.0);
  // ── this is where the round's extra crawl comes from, and it is the round ─
  // With the phase fixed, foam TRAVELS — this field is 1.8 m across and the
  // cycle carries it several feature widths, so a whitewater mark now moves
  // downstream instead of dissolving in place. It is also pushed into alpha
  // by 'alpha = max(alpha, foam * 0.92 * shoreFade)', and inside the shoreline
  // fade shoreFade is under one, so a moving foam edge really does change the
  // composited COVERAGE of a band pixel. tools/wcrawl's header says flip
  // 'counts pixels crossing 0.5 coverage, which foam cannot do'; through that
  // max() it can.
  //
  // MEASURED by freezing this one field and changing nothing else, against
  // three pre-change captures of a byte-identical shader that all read 3.3%:
  //     hero   flip 3.3% before  ->  3.9% with the phase fixed  ->  3.3% with
  //            this field frozen and the phase still fixed
  //            (crawl% 1.56 -> 1.08 and ratio 2.03 -> 1.40 move with it)
  //     mouth  flip 1.1% -> 1.2% -> 1.2%, against the 1.5% gate
  // So hero's whole rise is this term and nothing else, and the term is doing
  // what the round exists to make it do. It is not frozen.
  float fn  = wStreak(p, T, 0.55, 3.4, ph);
  float cut = uFoamCut - drive * 0.34;
  float foam = smoothstep(cut, cut + 0.10, fn);
  foam *= smoothstep(0.04, 0.16, drive);

  // ── the waterline ────────────────────────────────────────────────────────
  // The single loudest cue in the reference: even a lazy meander is drawn with
  // a bright broken line where the water meets the bank, and without it water
  // reads as a sheet of blue vinyl laid in a ditch.
  //
  // Rewritten as a BAND IN METRES OF GROUND at a fixed offset inside the
  // waterline, because that is what the plate measures and there is now a
  // signed ground distance to hang it on. docs/WATER_ART_SPEC.md 3.1 scans P3's
  // near bank perpendicular and gets, from the crossing inward: 0.27 m of dark
  // shallow rim, then 0.32 m of near-white lace, then 0.26 m of inner pale
  // band. So the lace is centred 0.43 m inside the line and is 0.32 m across.
  // Those two numbers are the whole band; they are used literally.
  //
  // What this replaces was two windows in DEPTH unioned with a metre skirt,
  // with a footprint-scaled pad on both. The arithmetic that block records
  // against itself is the reason: laceD closed at 0.36 m of depth, grad is
  // floored at 0.02, so on any gentle bank it was 19 m of ground wide, and the
  // metre term that was supposed to be a ceiling on it only ever faded it to
  // 0.42 of itself. There is no depth anywhere in the placement now.
  //
  // Scalloped, not feathered. Plate 3's waterline is a row of separate lobes
  // two to four metres long with hard shoulders between them, following the
  // tufts of grass it runs behind — a low frequency and a hard edge, which is
  // what wSteps is for. What it modulates is the band's WIDTH, not its opacity:
  // modulating opacity gives a line that fades in and out along its length,
  // modulating reach gives one that bulges at a mark and pinches to a hairline
  // between them.
  float laceWide = mix(0.11, 0.5, smoothstep(0.5, 2.4, foot));
  // ── FREEZING THIS WAS TRIED, ON THE HYPOTHESIS THAT IT WAS THE CRAWL ─────
  // The scallop modulates the WIDTH of a band whose opacity is pushed into
  // alpha by the max() near the end of this function, so a scallop that
  // travels is a modulation of the waterline's own opacity that travels —
  // crawl by construction. It is also, by its own note above, meant to follow
  // the tufts of grass the line runs behind, and those are on the bank and do
  // not move downstream. So it was made a single static sample (also a tap
  // cheaper) and measured on fresh tools/wcrawl captures: hero flip 3.9% ->
  // 3.9%, mouth 1.2% -> 1.2%, river 4.1% -> 5.1%. It changed nothing it was
  // aimed at and left river ambiguous, so it is not landed.
  //
  // The attribution probe that DID find the crawl is recorded at 'fn' below.
  float scallop = wStepsAA(smoothstep(0.30, 0.70, wDrift(p, T, 0.30, ph)), 3.0, laceWide);
  // A trickle may not carry a 0.32 m band on both banks: F6 fails a lace wider
  // than 8% of the channel, and 0.32 m on a 6 m brook is 5% per bank at this
  // scaling and 21% at full width. So the WIDTH is rationed by the body as well
  // as the value, and both saturate by the time the half-width reaches 7.7 m,
  // which is a 15 m channel — the narrowest thing the plate's number was
  // measured on.
  float laceScale = clamp(span * 0.13, 0.35, 1.0);
  float laceMid  = 0.43 * laceScale;
  float laceHalf = 0.16 * laceScale * (0.35 + 0.85 * scallop);
  // ── and the band-limit, which is what makes it survive at range ──────────
  // A 0.32 m band is 0.8 px across at 'mouth' and under 0.3 px at 'hero'. Drawn
  // at its true width it is a dotted line that crawls; not drawn at all it
  // vanishes, which is what the capture set showed.
  //
  // So it is held at a screen width, and only PART of the widening is paid back
  // in opacity — which is a deliberate departure from the textbook band-limit,
  // taken on a measurement. Held at its full integral (1.2 px, opacity scaled
  // by the ratio) the first capture of this round measured the lace at peak
  // Y 0.306 against docs/WATER_ART_SPEC.md 3.1's 0.616 and §5 item 8's floor of
  // 0.40: present, correctly placed, and too dim to read. A waterline is not a
  // texture detail whose energy has to be conserved; it is the compositional
  // line the whole shoreline read hangs on, and the plates draw it with a brush
  // of roughly constant SCREEN width — P3's two scanned banks are at 150 px/m
  // and 74 px/m and their lace is 48 px and 30 px, a factor of two in metres
  // and a factor of 1.6 in pixels.
  //
  // ── and the size of the departure, stated plainly ────────────────────────
  // At 'mouth' the near shoreline is crossed at about a metre and a half of
  // ground per pixel — tools/wedge.mjs measured the OLD edge there at aaPx 5.80
  // for a fade 8.8 m wide, which is the same number read backwards. The plate's
  // 0.32 m band is therefore a QUARTER OF A PIXEL at the framing this round is
  // judged in. It cannot be drawn at its stated width; the only question is
  // whether it is drawn at a screen width or not at all, and not at all is the
  // failure the capture set has shown for three rounds.
  //
  // So: an opacity floor rather than the integral, and a cap on top so the
  // screen rule can never reproduce the band this file used to draw — the old
  // reach was 1.28 m before the scallop touched it and reached 4 m at a grazing
  // footprint. The floor is withdrawn with distance for the same reason: a
  // fringe held at half value round every lake at a kilometre is F6.
  //
  // ── the screen width was 1.1 px and the cap was 0.9 m of GROUND ──────────
  // Both were wrong and in the same direction, and together they are why a
  // critic measured no bright mass anywhere on the water.
  //
  // 1.1 px of half-width through the profile below is 0.58 px at 80% of peak,
  // i.e. the whole mark is 1.2 px across. MEASURED in the frame: mouth's lace
  // is 2-6 px wide at >=80% of peak, and tools/waterstats.mjs item 8 finds it
  // on 0% of its 74 shoreline scans — the mark is thinner than the 5x5 sample
  // that looks for it. It is not that the lace is dim; it is that there is
  // barely any of it.
  //
  // And 0.9 m of GROUND is not a criterion at all. At mouth one pixel is about
  // 1.5 m of ground, so the cap bit at 0.6 px — a metre cap enforcing a
  // sub-pixel mark. F6's rule is not in metres either: it fails a lace wider
  // than 8% of the CHANNEL. span is the local half-width in metres, so 8% of
  // the channel is 0.08 * span of half-width, and that is the cap, with the old
  // 0.9 m kept underneath it as a floor so a thread still gets a visible mark.
  // On mouth's open water span is at its 48 m cap, so the lace may reach 3.84 m,
  // which is the widest F6 itself permits.
  //
  // The SCREEN width went 1.1 px -> 1.8 px and not further, and the number is a
  // measured trade rather than a taste. A wide bright band sitting just inside
  // the waterline is inside the contour tools/wedge.mjs traces, and it makes
  // that contour ragged. Swept on 'mouth', all with the amplitude below at its
  // raised value:
  //
  //     screen floor   wedge fine  stair  crenel  aaPx | item 8 peak Y  scans  width
  //     1.1 px            5.1%     1.9%   1.025   2.20 |    0.404        1%    40 px
  //     1.8 px            5.3%     2.2%   1.027   2.22 |    0.426        3%    85 px
  //     2.8 px            6.4%     2.9%   1.031   2.19 |    0.466        3%    75 px
  //
  // 2.8 px regresses all three shape columns past where the round found them
  // (5.8 / 2.7 / 1.029) and buys 0.13 stops and no extra coverage; 1.8 px is
  // better than the round's own numbers on all three and still clears item 8's
  // Y >= 0.40 gate with margin. So the metre cap that a critic correctly named
  // as arbitrary is replaced by F6's own rule, and the SCREEN floor — which
  // that critic did not measure against the shape gates — stops at 1.8.
  float laceCap = max(0.9, span * 0.08);
  float laceW = min(max(laceHalf, aaPix * 1.8), laceCap);
  // MEASURED UP, twice, against §5 item 8's own floor. At 0.55 the lace read
  // peak Y 0.306; at 0.72 it read 0.357; the item wants 0.40 and the plate is
  // at 0.616. Both readings are +1.9 and +2.3 stops over the body, so the
  // CONTRAST clause has passed throughout and it is the absolute value that has
  // been short — which is what an opacity floor is for.
  // ...and then MEASURED BACK DOWN to 0.58, and THAT reading is retracted. At
  // 0.88 the near bank of mouth came back as an unbroken white line following
  // the whole shoreline — a piped edge — but that capture was taken BEFORE the
  // coverage field's period was halved (0.011 -> 0.026, and the duty cut from
  // 0.28-0.72 to 0.44-0.78). Coverage now measures 50/50 along the near bank,
  // inside F6's 60% guard, so the continuity that reading was about is gone and
  // the floor it produced is a ration on the wrong axis: 0.58 is the flat top a
  // critic measured on the lace's profile, and a mark whose core never reaches
  // full opacity is a mark that cannot be the brightest thing in the frame.
  // Raised to 0.85. Coverage is what rations a lace; do not ration it twice.
  float laceFloor = mix(0.85, 0.12, far);
  // ── and the band may not reach past the waterline ────────────────────────
  // The profile below falls to zero at |sdist - laceMid| = laceW, so with
  // laceMid at 0.43 m and laceW released to F6's cap the band's OUTER edge sits
  // at sdist = 0.43 - 3.84, i.e. three and a half metres onto the DRY side.
  // The alpha ramp reaches that far at a grazing footprint, so the lace was
  // painting near-white over the outer half of the shoreline fade — and the
  // contour tools/wedge.mjs traces then follows the LACE'S scalloped outer edge
  // instead of the waterline. Visible in the zoom as a white band lying outside
  // the magenta contour, and it is most of what widening the lace cost 'river'.
  // So the centre is pushed in as the band widens, which pins the outer zero to
  // the waterline exactly. A lace is on the wet side; this makes that true
  // rather than nearly true.
  //
  // ── ...AND IT IS NOT THE FIRST THING INSIDE THE LINE ─────────────────────
  // Pinning the outer zero to the waterline made the lace the OUTERMOST wet
  // band, and the plate does not put it there. WATER_ART_SPEC 3.1 scans, from
  // the crossing inward: band 4, a shallow rim ~40 px wide with Y climbing
  // 0.060 -> 0.286; THEN band 5, the lace, ~48 px, 0.481 -> 0.616; then band 6
  // ~40 px falling 0.335 -> 0.275 and band 7 ~72 px falling 0.215 -> 0.133 into
  // a body at 0.105. Seven bands, 220 px, 2.55 stops.
  //
  // MEASURED, ours, mouth row 435 across the headland, single pixel, no filter:
  //     x=800 #663c2f Y 0.063   bank
  //     x=805 #fde8f1 Y 0.849   LACE PEAK
  //     x=810 #334865 Y 0.063   water, already at full depth
  //     x=811..835                flat, 0.055-0.072
  // Eight pixels, 4.24 stops, nothing on either side of it. A white pipe.
  //
  // Both neighbours are missing because the band was built as one term. The rim
  // in front and the pale band behind are added here as ONE envelope, because
  // in the plate they are one: bands 4, 6 and 7 are the same pale mass seen at
  // three strengths, and their signature says so — Y rises 0.060 -> 0.286 while
  // cool FALLS 1.61 -> 0.80, then Y falls 0.335 -> 0.133 while cool RISES
  // 0.02 -> 1.88. That is a single monotone mix toward the lace's own
  // near-neutral pale, peaking where the lace is. So it is drawn as exactly
  // that, and it shares laceCol below rather than inventing a second colour.
  //
  // Widths are in units of the lace's screen-locked half-width, in the plate's
  // own proportions (its lace half-width is 24 px): the rim is 40/24 = 1.67 of
  // it, the pale band and body ramp together 112/24 = 4.67. Screen-locked for
  // the same reason the lace is — the whole 220 px profile is 1.5 m of ground,
  // which at mouth is ONE PIXEL, so a profile drawn at its true width is not a
  // profile. Rationed by span as well, so a 3 m brook does not get its two
  // banks' shoulders meeting in the middle as a pale cord.
  float rimW  = min(laceW * 1.67, span * 0.12);
  float sholW = min(laceW * 4.67, span * 0.28);
  // The rim goes IN FRONT, so the lace's outer zero now sits rimW inside the
  // line instead of on it. That is strictly further from dry ground than the
  // pin above, so the wedge contour has less of the lace to catch, not more.
  float laceCtr = max(laceMid, laceW + rimW);
  // ── the PROFILE is kept separate from the AMPLITUDE, and that is not tidying
  // The ceiling at the bottom of this function bounds the mark's value. A
  // ceiling applied as a clip pins every pixel that reaches it to the same
  // number, which turns the top of the profile into a PLATEAU — a narrower
  // version of the flat-topped pipe the ceiling exists to remove. MEASURED, on
  // river with the clip form: the near-white core went 5 px -> 8 px and the
  // count of water pixels over Y 0.85 went 885 -> 1172. So the ceiling is
  // applied to the AMPLITUDE and the profile multiplies the bounded result,
  // which leaves the shape untouched and only lowers the peak.
  float laceProf = 1.0 - smoothstep(0.35, 1.0, abs(sdist - laceCtr) / laceW);
  float laceTop = max(laceHalf / laceW, laceFloor);
  float lace = laceTop * laceProf;
  // Rise across the rim, peak with the lace, decay across bands 6 and 7. min()
  // of the two smoothsteps rather than a branch: outside the peak the second is
  // 1, inside it the first is, so this is one asymmetric envelope with a short
  // rise and a long tail, which is the shape 3.1 measures.
  float shoulder = min(smoothstep(0.0, laceCtr, sdist),
                       1.0 - smoothstep(laceCtr, laceCtr + sholW, sdist));
  // ...and it is ABSENT on some banks. docs/WATER_ART_SPEC.md 3.3 measures
  // plate 3's far bank and finds no lace at all on it while the near bank in
  // the same frame carries a bright one; F6 fails a near-white band that is
  // continuous along more than about 60% of a shoreline. A fringe round every
  // body of water in the map is pack ice. This is the one term that rations
  // COVERAGE rather than width or value, which is what the measurement says is
  // actually wrong when it goes wrong.
  //
  // MEASURED: this term had never fired. wFbm2 * 0.5 + 0.5 is a bell that
  // rarely leaves the middle third, so it sat near 0.5 nearly everywhere and a
  // smoothstep(0.22, 0.46, ·) came back 1.0 nearly everywhere. Stretched to a
  // real 0..1 first, then thresholded, so the cut can actually land: roughly a
  // third of bank length off, a third on, a third in between. The field is
  // isotropic in world space at a ~90 m period, so it takes the lace off whole
  // stretches of one bank while leaving the other — which is what 3.3 measures
  // P3 doing — and breaks what is left into segments.
  // MEASURED, on the period rather than on the threshold. At 0.011 the field's
  // features are about ninety metres, and a framing looks at thirty to sixty
  // metres of one bank — so a whole capture lands inside one lobe and the lace
  // is either everywhere in the frame or nowhere in it. Nowhere is what three
  // captures in a row showed, at 'mouth' and at 'backwater', with the band
  // correctly placed and simply switched off across the entire shoreline in
  // shot. §3.3's evidence is that a lace is absent from one BANK and present on
  // the other in the same frame, which is a length scale of tens of metres, not
  // of ninety. At 0.026 the period is about thirty-eight metres and a sixty
  // metre shoreline carries on-off-on, which is what the plate draws.
  float laceCov = smoothstep(0.38, 0.62, wFbm2(p * 0.026 + 11.3) * 0.5 + 0.5);
  // Duty cut from about half the bank length to about a third: at 0.28-0.72 an
  // eighty metre shoreline in 'mouth' carried the mark end to end with no break
  // in it at all. §3.3's plate has a bank with none and a bank with plenty, and
  // F6's own detector fails anything continuous along more than 60%.
  laceTop *= smoothstep(0.44, 0.78, laceCov);
  // A trickle gets a hint of a waterline; a river gets the full mark. On a
  // 1.5 m brook the two bands meet in the middle whatever their width, and the
  // stream reads as a white cord lying on dry ground rather than as water.
  laceTop *= 0.42 + 0.58 * smoothstep(1.0, 3.0, span);
  lace = laceTop * laceProf;
  // The shoulder is rationed by the same coverage field, but only half as hard
  // as the lace. 3.3's far bank has no lace AND no rim — it goes damp band, one
  // neutral sample, water at full value — so the pair does belong together. But
  // 5 item 10 wants a shallow shelf mass to exist AT ALL, and switching the
  // shoulder fully off wherever the lace is off puts us back at "no identifiable
  // shelf mass in any framing", which is what 1.2 records against every one of
  // our framings. Half-strength where the lace is absent is a shelf; full
  // strength where it is present is the plate's profile.
  //
  // Withdrawn with distance, but only 55% of the way: a pale ring held at full
  // value round every lake at a kilometre is F6, and taken to nothing it is F6's
  // opposite, which is the failure we actually have.
  shoulder *= (0.45 + 0.55 * smoothstep(0.28, 0.72, laceCov)) * (1.0 - far * 0.55);
  shoulder *= 0.42 + 0.58 * smoothstep(1.0, 3.0, span);
  // ── and it is BESIDE the lace, not under it ──────────────────────────────
  // 3.1's bands 4, 6 and 7 are the neighbours of band 5; the plate does not
  // stack a pale wash under its own waterline. Drawn without this the two
  // brighten the same pixels twice, and the excess is not visible at 'mouth'
  // (where the lace mix is well short of foamCol) but is at 'river' (where it
  // is not). MEASURED, water pixels over Y 0.85 in the bare capture, which is
  // the population the pack-ice failure lives in:
  //     baseline                          885
  //     shoulder only, lace not moved     798
  //     lace moved only, no shoulder      886
  //     both, stacked                    1095   <- neither term on its own
  //     both, with this line and the next  939   <- back inside the baseline
  // Neither change adds anything alone; the sum of the two does, which is what
  // double-counting looks like from the outside.
  // Withdrawn under the rapid foam for the same reason and by the same
  // arithmetic: a shelf tint is the BODY seen through thin water, and where the
  // surface is aerated the body is not visible at all. 'foam' here is still the
  // wStreak term only — the lace is folded into it four lines below — so the two
  // factors gate on different things and neither counts the other twice.
  // MEASURED at 'plunge', which is almost all whitewater, on item 8's brightest
  // near-shore sample: 0.869 baseline, 0.950 with the shoulder unrationed.
  shoulder *= (1.0 - laceProf) * (1.0 - foam);
  // Still water gets the same mark a current does. The 0.88 here was the third
  // multiplier in a row on a term that measured too dim (laceCov, the span
  // ration, and this), and a lake has as much right to a waterline as a river:
  // §3.1's scan is of a slow reach and §3.3's, which has none at all, is of the
  // same water on the other bank. Coverage is what rations a lace, not
  // discharge.
  foam = clamp(max(foam, lace * (0.94 + 0.06 * disch)), 0.0, 1.0);

  // ── reflection ───────────────────────────────────────────────────────────
  float fres = 0.020 + 0.980 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  // Reflect off a SMOOTHED normal as the footprint grows. A pixel covering many
  // wavelengths does not reflect a ray, it reflects a cone; marching a
  // per-ripple mirror direction through a discrete heightfield instead flips
  // between hit and miss from pixel to pixel and resolves into a dotted
  // halftone grid — measured as the single worst artifact this system has had.
  vec3 Nr = normalize(mix(N, vec3(0.0, 1.0, 0.0), clamp(foot * 3.0, 0.0, 0.94)));
  vec3 R = reflect(-V, Nr);
  // Nr is fully flat by a footprint of 0.31, so past that the march is a smooth
  // function of position and there is nothing left to dither; the cutoff only
  // has to stay ahead of the point where the heightfield itself is coarser than
  // the pixel. The old cutoff at 1.25 switched the landscape reflection off
  // about twenty-five metres out on a surface seen from its own bank, which is
  // why a critic recorded no reflection of sky or shore anywhere in the build.
  float marchOn = 1.0 - smoothstep(3.0, 9.0, foot);
  // The marched landscape is a near-field read on top of that. Half a kilometre
  // out the hit point wanders by tens of metres between neighbouring pixels and
  // draws warm diagonal smears that read as an oil slick.
  marchOn *= 1.0 - far * 0.78;
  // How much of the cone reaches past the shore, decided by roughness. Water
  // looked at from its own bank points the mirror direction into the opposite
  // shore across the ENTIRE surface, so the march hands back hillside
  // everywhere; that hillside is deliberately desaturated and darkened, so it
  // lands within a few percent of the body colour and mixing between the two
  // cannot produce a mass however it is weighted. A rough patch reflects a
  // wider cone whose top clears the ridge, so roughness is what decides how
  // much sky is in the answer — and that is also what the plate draws: pale
  // sheets lying between darker smears of reflected bank, better than a stop
  // apart.
  float reach = marchOn * (0.30 + 0.70 * (1.0 - mass));
  vec3 envRaw = wSkyTilt(R);
  if (reach > 0.01) envRaw = mix(envRaw, wEnvReflect(P, R), reach);
  // A reflection off the air/water interface is spectrally neutral: it is the
  // sky, not the water. Water stays the cool note by ROTATING it a fraction
  // toward its own hue, which moves colour and leaves value alone.
  vec3 env = wTint(envRaw, absorb, mix(uEnvTint, uEnvTint + 0.20, far));
  // The broad sheet of reflected sky. Physical Fresnel at anything but a
  // grazing angle is 5-8% and the surface is then almost pure body colour,
  // which measured two and a half stops under the plates. A real surface is
  // brighter than that because it is ROUGH: a rippled surface reflects a cone,
  // and the fraction of that cone clearing the critical angle is far larger
  // than the mirror-direction reflectance of a flat one. This is the floor
  // under Fresnel, and it is the one dial that decides whether water reads as
  // water or as a dark hole. Withdrawn in the shallows and inside foam, where
  // the surface is no longer a mirror of anything.
  // Withdrawn in the shallows, but only PART WAY, and that is a correction.
  // Both old shaders took the mirror to zero over a shelf on the reasoning that
  // a rim you can see the bed through does not hand back a sheet of sky. Half
  // right: you can see the bed, and Fresnel does not care — a grazing surface
  // over ankle-deep water is as much a mirror as a grazing surface over forty
  // metres of it. Taken to zero, the whole shelf is body colour under a warm
  // key, which measures as MUD: the near shelf in 'mouth' came back #4e3835,
  // cool NEGATIVE, against docs/WATER_ART_SPEC.md 1.2's shelf target of #536684
  // at cool 1.12 and half a stop below the meadow. That is failure F1 drawn
  // across the whole foreground, and this gate is what drew it.
  float shallowMirror = mix(0.30, 1.0, smoothstep(0.05, 1.4, depth));
  // How mirror-like this pixel is at all, before anything rations it: Fresnel,
  // with the roughness floor under it that keeps water from being a dark hole.
  float mirrorT = max(fres * 0.90, uSheen * 0.88);
  // ...and the MASS is what turns that single number into the plate's value
  // masses. This is where item 1 was being lost, and the arithmetic is the
  // whole finding: the old line was
  //     clamp(max(fres * 0.90 * (0.36 + 0.64 * mass), sheen), 0.0, 0.52)
  // and at a grazing angle fres * 0.90 is about 0.81, so the product passed
  // 0.52 at mass = 0.44. mass is wSteps(·, 3), i.e. FOUR levels {0, ⅓, ⅔, 1},
  // and the top TWO of them both landed on the ceiling. Measured that way the
  // mirror ran {0.29, 0.46, 0.52, 0.52} — a four-mass field flattened to
  // three, with the two brightest merged, over every grazing pixel in the
  // frame, which is most of the water. The ceiling was clipping the range
  // instead of bounding it.
  //
  // So the ceiling bounds the TOP of the range and the mass spans the whole of
  // it. The SPAN is the change, not the level: grazing, this runs
  // {0.13, 0.36, 0.58, 0.72} against the old {0.29, 0.46, 0.52, 0.52} — four
  // separated levels instead of three, over a two-and-a-half-stop range
  // instead of one — and its mean over the mass field's own distribution
  // (measured 7.5 / 42.5 / 42.5 / 7.5 across the four levels) is 0.46 against
  // the old 0.45. That matters: a first attempt at this used mass*mass to keep
  // the bright level small, and it moved the whole distribution DOWN rather
  // than widening it — measured, the river view's brightest mass fell from
  // +0.59 to +0.04 stops over its meadow and mouth's p98 from -0.44 to -0.63, i.e.
  // item 2 got worse in two frames while item 3 got better in all four.
  // Uniformly darker water is not the fix; the span is.
  mirrorT *= 0.16 + 0.84 * mass;
  // The withdrawals are unchanged and now apply once rather than twice —
  // shallowMirror used to multiply both the sheen and the result, so a shelf
  // got 0.09 of a mirror where it was meant to get 0.30, which is the squared
  // form of the gate the note above says must NOT go to zero.
  float mirror = min(mirrorT, 0.72)
               * shallowMirror * (1.0 - foam * 0.9) * (1.0 - turb * 0.45);
  // A river is broken up and half aerated and never mirrors as hard as a lake
  // does; letting it try buries the body under a sheet of reflected sky at
  // every grazing angle, which is most of a channel.
  mirror *= 1.0 - 0.34 * coh * (0.3 + 0.7 * turb);
  vec3 col = mix(lit, env, mirror);

  // Sun path. Broad and graded, never a hard hotspot — and band-limited, which
  // matters more here than anywhere else: a pow-260 lobe riding a ripple field
  // resolves into hard rings the instant the ripples approach the size of a
  // pixel, and from a bank at a grazing angle that is a grid of dots marching
  // across the water.
  vec3 H = normalize(uSunDir + V);
  float nh = max(dot(N, H), 0.0);
  // ── the sun path, and why there was not one ──────────────────────────────
  // 'sharp' is the prefilter: a pixel that covers many wavelengths cannot see a
  // sharp specular lobe, so the exponent falls and the lobe widens. That part
  // is right. What was wrong is that the sharp lobe's WEIGHT was also
  // multiplied by 'sharp' and nothing picked the energy up.
  //
  // exp(-foot * 8.0) is under a thousandth at 20 m and arithmetically zero past
  // 40 m from an eye 2.2 m up. So over the whole 50-500 m band where a sun path
  // actually lives, 0.55 of the surface's specular return was multiplied by
  // zero and the broad lobe was left holding 0.09. That is not a prefilter, it
  // is a delete — and a sun path is the one bright mass a lake is entitled to.
  // A critic measured the brightest value mass in 'mouth' at 0.42 stops BELOW
  // the meadow against plate 3's p98 at +1.20; this is where that stop went.
  //
  // Prefiltering conserves energy. So the 0.46 the sharp lobe gives up as the
  // footprint grows is handed to the broad one — 0.09 + 0.46 = 0.55, the same
  // number, at an exponent of 10 instead of 260. Near field is unchanged to the
  // last digit, because at foot -> 0 sharp -> 1 and the migration term is zero.
  float sharp = exp(-foot * 8.0);
  col += uSunLight * (pow(nh, mix(24.0, 260.0, sharp)) * 0.55 * sharp
                    + pow(nh, mix(10.0,  40.0, sharp)) * (0.09 + 0.46 * (1.0 - sharp)))
                   * (1.0 - foam) * shadow;

  // The cool governor runs on the BODY, before the foam is laid over it. Foam
  // is near-neutral by construction, so a governor that treats neutral as a
  // miss would tint every whitecap in the game blue. In proportion to how much
  // of the pixel is body rather than mirror: a reflected sky rotated toward the
  // body hue comes back as bright saturated blue where plate 3 keeps its pale
  // masses near-neutral, and it is that saturation SPLIT rather than an average
  // chroma that reads as water.
  //
  // ── AND IT IS SPLIT ON THE MASS, WHICH IS WHERE THE SPREAD COMES FROM ────
  // The paragraph above says the split is what reads as water and the shader
  // was not drawing one: measured at 'mouth', the whole water body sat inside
  // 0.66 of cool against a spec bar of 1.5 and reference plates at 1.59-2.40 —
  // and with this governor switched off entirely it sat inside 0.45, so the
  // uniformity is upstream of here (see the sweep in wCoolGovern's note). Every
  // path in this shader is tinted by the same 'absorb', so a pixel that is
  // three quarters reflected sky and a pixel that is all body arrive at the
  // same hue whatever their value.
  //
  // massT is the one field that already says which of those a pixel is: high is
  // the rough pale mass that hands back a wide cone of sky, low is the dark
  // glassy patch that is nearly all body. So the demand and the strength both
  // ride it, in opposite proportions to keep the MEAN where it is while opening
  // the ends:
  //   floor    1.32x down to 0.44x of the 1.40 * (absorb.b - absorb.r) demand,
  //            i.e. about 3.3 down to about 1.1 on this bake's uDeep. The pale
  //            end is still a floor four times over F1's p10 >= +0.3 guard, so
  //            nothing here can let water go warm — which is the failure the
  //            governor exists for and the one 'hero' has on record.
  //   strength  1.55x down to 0.75x, so a dark patch is driven to its floor and
  //            a pale one is only nudged toward its much lower one.
  // Weighted over the mass field's own measured distribution (7.5 / 42.5 / 42.5
  // / 7.5 across the four levels) the pair is very nearly mean-neutral by
  // construction; the numbers it actually produced are in the table below.
  col = wCoolGovern(col, absorbDeep, uCoolGain * (1.0 - mirror * 0.50), 1.0);
  // Foam is a diffuse mass of bubbles: lit nearly flat, and through the foam
  // illuminant so a rapid under a golden key is white water and not a ribbon of
  // cream.
  vec3 foamCol = uFoam * wFoamLight(shadow) * 0.95;
  // ── and the LACE is not the same colour as whitewater ────────────────────
  // MEASURED: ours reads #9b94a1 / #b3abb6, a mauve-grey at C 0.043-0.11 —
  // B > R > G, i.e. on the cool side of neutral. Plate 3's lace is #e2c7d3, a
  // faintly warm cream at C 0.107 — R > B > G. Same lightness, opposite hue
  // sign. A whitewater curtain is correctly neutral-to-cool and uFoam is shared
  // with the falls, so this is not a change to the illuminant: it is a tint
  // applied in proportion to how much of THIS pixel's foam is lace rather than
  // rapid. The ratios are the two hex readings divided through: plate R/G 1.136
  // and B/G 1.060 against ours 1.047 and 1.088, so (1.085, 1.0, 0.974).
  //
  // NOT converted to linear, and the first attempt that did is the reason the
  // number is stated this way. Both hex readings are FINAL rendered pixels, so
  // their ratio is already a display-space ratio; squaring it into (1.18, 1.0,
  // 0.95) and applying it before the tone map over-corrected badly — the lace's
  // chroma went to 0.31 and tripped waterstats item 8's own C <= 0.30 gate, so
  // the brightest samples stopped qualifying and the reported peak FELL from
  // Y 0.338 to 0.297 while the mark on screen got brighter. Plate 3's lace is
  // C 0.107; this is a hue nudge, not a colour.
  float laceShare = clamp(lace * 0.94 / max(foam, 0.001), 0.0, 1.0);
  vec3 laceCol = foamCol * mix(vec3(1.0), vec3(1.085, 1.0, 0.974), laceShare);
  // ── the rim, the inner pale band and the body ramp, under the lace ───────
  // WATER_ART_SPEC 3.1 bands 4, 6 and 7. The envelope was built at 'shoulder'
  // above; this is its colour, and it is the lace's, because the plate's is.
  // Applied BEFORE the lace mix so the lace's core overwrites rather than adds
  // to it — the two are not stacked, the lace is the top of the same profile.
  //
  // The amplitude is a mix weight, not a luminance, and it was measured rather
  // than reasoned: the plate wants the shoulder peaking at Y 0.286-0.335 with
  // our near-shore body at 0.063, and the mix runs into the tone map's shoulder
  // long before it runs into laceCol's own value.
  col = mix(col, laceCol, shoulder * 0.30);
  col = mix(col, laceCol, foam * 0.94);
  // ── and the lace gets a lift the rest of the foam does not ───────────────
  // MEASURED, and it is a finding about where the ceiling was. Raising the
  // lace's own opacity floor from 0.72 to 0.88 moved its peak Y by 0.001
  // (0.357 -> 0.356), which means the lace term had already saturated the mix
  // and the number being measured was the FOAM ILLUMINANT'S own luminance, not
  // the lace's. At foam 0.83 of the way to foamCol the result lands at Y 0.356
  // against docs/WATER_ART_SPEC.md 3.1's 0.616 and §5 item 8's floor of 0.40.
  //
  // uFoamGain is shared with the falls and is not this file's to move — a
  // whitewater curtain is correctly lit where it is. But the plate's lace is
  // not whitewater: §3.1 measures it at Y 0.481-0.616 against the same frame's
  // aerated water, i.e. it is the BRIGHTEST note in the picture, 2.8 stops over
  // the meadow behind it. So the band gets an additive lift of its own,
  // withdrawn with distance on the same schedule as its opacity floor, because
  // a bright line held at full value round every lake at a kilometre is F6.
  //
  // MEASURED UP from 0.20, on the tool rather than by eye. tools/waterstats.mjs
  // item 8 wants the lace's peak at Y >= 0.40 and the plate is at 0.616; at
  // 0.20 the frame read 0.338 and item 8 failed on PRESENCE, because its
  // detector qualifies a sample at Y >= 0.40 and nothing in the frame reached
  // it — 0% of 74 shoreline scans, with the mark correctly placed on every one
  // of them. The mix cannot supply the rest: at foam 0.80 the result is already
  // 0.75 of the way to foamCol, whose own luminance is 0.58, so the mix is
  // within 0.1 stops of its own ceiling and the remaining stop has to be added.
  // Swept against item 8, which gates a sample at Y >= 0.40 and then asks what
  // FRACTION of the shoreline scans carry one (target 10-85%):
  //     lift   peak Y   scans carrying a lace
  //     0.20    0.338      0%
  //     0.50    0.394      0%
  //     0.62    0.419      1%
  //     0.85    0.465      1%
  // The plate's lace peaks at Y 0.616 and +1.72 stops over its meadow; 0.465 is
  // +0.97 over ours, against plate 3's p98 at +1.20 — so there is still a
  // stop of headroom before this is the plate's value, let alone F6's pack ice.
  //
  // NOT FIXED, and named rather than left: item 8's COVERAGE clause wants a
  // qualifying lace on 10-85% of shoreline scans and this moves it 0% -> 1% and
  // then stops. Brightness is not what is holding it — 0.62 and 0.85 report the
  // same 1% at 0.05 stops apart. The scans that fail are the DISTANT ones, and
  // both of this mark's distance withdrawals hit them: laceFloor falls to 0.12
  // and this lift falls to zero, both on 'far'. Weakening either is the exact
  // change whose failure mode is a bright fringe round every lake at a
  // kilometre, so it wants its own measurement and its own capture set.
  // ── AND THE LIFT NOW HAS A CEILING, WHICH IS THE WHOLE FIX ───────────────
  // Everything above is a floor with no ceiling, and so is 5 item 8, which
  // gates peak Y >= 0.40 and says nothing about how far past it a lace may go.
  // Raising the mark to clear that floor sailed it 0.47 stops past the plate's
  // own value: MEASURED peak Y 0.851 against 3.1's 0.616, a 4.24-stop spike
  // between two dark fields, and at dawn 1.53 stops above the whole frame's
  // 99th percentile — a light leak, not a waterline.
  //
  // An absolute clamp cannot hold that, because the frame's key moves four
  // stops across a day and a constant that reads as a waterline at noon reads
  // as a hole in the sky at 07:24. So the ceiling is expressed in units of the
  // FOAM ILLUMINANT'S OWN LUMINANCE. foamCol is uFoam * wFoamLight(shadow):
  // it is what whitewater in this frame is lit to, it moves with the key by
  // construction, and it is the one near-white quantity this shader already
  // holds. laceCol is foamCol times a hue nudge, so adding laceCol * k raises
  // luminance by very nearly k * foamY and the headroom division is exact.
  //
  // The plate's own reading agrees that this is the right anchor: P3's lace is
  // Y 0.616 and P5's plunge whitewater is Y 0.715, so a lace is 0.21 stops
  // BELOW the whitewater in the same illuminant family, not above it.
  //
  // Bounded on the AMPLITUDE and multiplied by the profile afterwards, not
  // clipped on the result — see the laceProf note above for the measurement
  // that forced that, and for what clipping costs.
  vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);
  float foamY = max(dot(foamCol, LUMA_W), 1e-4);
  float laceLift = min(laceTop * 0.85 * (1.0 - far),
                       max(foamY * 1.14 - dot(col, LUMA_W), 0.0) / foamY);
  col += laceCol * (laceLift * laceProf);

  // A whisper of cool in the whole surface. Water in the reference is never the
  // same hue as the cream sky it sits under, even where it reflects it.
  col *= uCoolTint;

  // Shallows are see-through, but only a little. At 0.62 the gold bank read
  // straight through the shelf and every margin in the game came out khaki —
  // mud, which the brief names as an anti-pattern. Shallowness belongs in the
  // water's colour, which the depth ramp already handles, not in how much of
  // the bank is allowed to show through it.
  alpha *= mix(0.84, 1.0, smoothstep(0.12, 1.5, depth));
  // Rationed by the shoreline ramp, which it was not. Foam is opaque, and the
  // lace puts a 3 px band of it at a FIXED offset inside the waterline — so an
  // unrationed max() here replaces the soft toe of the alpha ramp with a step,
  // and the edge the frame actually shows is that step however wide the ramp
  // under it is. MEASURED: wedge.mjs read aaPx 0.86 at 'mouth' with the ramp
  // set to give 1.8, and moving the ramp to 1.6x fwidth changed it to 0.91 —
  // i.e. the ramp was not what was being drawn. Over open water shoreFade is 1
  // and this line is exactly what it was.
  alpha = max(alpha, foam * 0.92 * shoreFade);
  // Hand the steep reaches over to the falls system. A hard hand-off, not a
  // fade: a surface left at even a few percent alpha in front of a curtain
  // shows up as dark blotches chopping the white water into segments, which is
  // worse than either surface on its own.
  alpha *= 1.0 - cliff;
  // ...and the multiply on its own is not that hand-off, which is the other
  // half of what shipped. One-minus-cliff only reaches zero when cliff reaches
  // exactly one, so the whole leading half of the ramp is spent drawing water
  // at a third, a fifth, a tenth of alpha over a curtain — the range where this
  // surface contributes nothing but a stain, and where being nearly coplanar
  // with the falls mesh is free to stripe. So the tail is taken to nothing
  // outright: past a bit over half committed, the pixel is the falls system's
  // and this one is not there at all. The leading edge keeps the smoothstep so
  // the lip of a drop is still antialiased rather than a stair.
  alpha *= 1.0 - smoothstep(0.34, 0.60, cliff);
  if (alpha < 0.012) discard;


  // ── the tide line ────────────────────────────────────────────────────────
  // docs/WATER_ART_SPEC.md 3.1, band 3: between the damp band and the shallow
  // rim P3 has ONE DARK NEAR-NEUTRAL STEP about 0.05 m wide — #383640, Y 0.039,
  // C 0.039 — and it is 0.35 stops below the damp band that precedes it and
  // 0.6 below the rim that follows. It is a fifth of the width of the lace and
  // it does more work than the lace does, because it is what separates the two:
  // §3.5's rule reads "a dark band on the dry side and a bright lace on the wet
  // side", and drawn without the dark note between them the bright one just
  // looks like a highlight ON the bank.
  //
  // We had no such band anywhere. §3.6's scan of ours finds "one dark neutral
  // step, 5 px" in 'river' — which is the terrain's own shadow, not ours — and
  // in 'mouth' the elements arrive in the wrong ORDER, pale inland of dark.
  //
  // Band-limited exactly as the lace is: 0.05 m is sub-pixel almost everywhere,
  // so the band is held at ~1.2 px and the darkening is scaled by how much it
  // was widened. And it is pushed into alpha, because a darkening applied at
  // alpha 0.1 is not a band — this is the one place the surface is allowed to
  // assert itself outside the waterline, and it is fifty millimetres wide.
  // Same screen-width floor as the lace and for the same reason, one notch
  // narrower — 1.8 px against 2.8 — because the plate's step is a fifth of the
  // lace's width and the PAIR is the read. Two bands the same width side by
  // side is a stripe, which is the failure the damp band's own note warns about.
  //
  // MOVED TO THE WET SIDE, two centimetres inside instead of two outside. It
  // used to sit at sdist = -0.02 and its own note said it needed no alpha of
  // its own because the damp band above had already taken alpha to 0.80 there.
  // The damp band is gone, so on the dry side there is now nothing to darken —
  // shoreFade is under a half two centimetres out and falling. Inside the line
  // the surface is opaque and the step draws at full strength, and the plate's
  // reading survives the move: WATER_ART_SPEC 3.5 wants the dark step BETWEEN
  // the damp band and the bright lace, and with the damp band on the terrain
  // the innermost thing the terrain draws is its own outer edge — the dark step
  // still lands between them, it is just cut from the water's side of the seam.
  float tideHalf = max(0.05, aaPix * 0.9);
  float tide = max(0.05 / tideHalf, mix(0.50, 0.10, far))
             * (1.0 - smoothstep(0.25, 1.0, abs(sdist - 0.02) / tideHalf));
  // Toward a dark blue-neutral, not toward black: the plate's step is cool
  // +0.33, i.e. faintly on the water's side of neutral rather than a shadow of
  // the bank. Rationed by the same coverage field the lace uses, half-strength,
  // so the pair appear and disappear together along a bank.
  tide *= 0.55 + 0.45 * smoothstep(0.28, 0.72, laceCov);
  // No alpha of its own, deliberately: a max() here puts a step in the alpha
  // ramp at exactly the pixel the ramp exists to soften. On the wet side it
  // does not need one — shoreFade is past its 50% point two centimetres in.
  col = mix(col, col * 0.30 + vec3(0.006, 0.006, 0.009), tide * 0.80);

  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
