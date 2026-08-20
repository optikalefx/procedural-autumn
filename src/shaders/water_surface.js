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
  // A horizontal plane meeting a nearly horizontal, faceted surface is the
  // worst-conditioned intersection in computer graphics: a few centimetres of
  // vertex error swings the cut line by metres, and what gets drawn is a row of
  // long straight wedges. That is what the water edge on a gentle bank looked
  // like — measured, by rendering alpha with the discards removed, the last
  // visible pixel was at full alpha and the boundary was the terrain, not the
  // fade.
  //
  // The fade cannot win that race honestly, because the two surfaces do not
  // agree about where the ground is. This shader reads the BAKED heightfield;
  // the terrain mesh is that field plus up to half a metre of micro-detail
  // added per vertex, plus whatever its LOD interpolation does between
  // vertices. So the water is still a metre deep, by its own account, at the
  // pixel where the terrain rises through it.
  //
  // So lift the geometry clear of the argument, and tell the fragment shader
  // exactly how far it was lifted so that every depth it computes is against
  // the REAL surface. The visible waterline does not move a millimetre — it is
  // decided by depth, which is corrected — but the polygon now goes under the
  // bank a metre further on, where alpha has already reached zero and there is
  // nothing to draw a wedge with.
  //
  // Scaled with range, because the error it is clearing is a world-space
  // quantity and the artifact it prevents is a screen-space one. Seven
  // centimetres at five metres is under the micro-detail and invisible; 2.2 m
  // at two hundred is a fifth of a degree and is what that geometry needs.
  vec3 toCam = cameraPosition - transformed;
  vLift = min(2.2, 0.03 + length(toCam) * 0.011);
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
uniform float uDampDark;
uniform vec2  uWind;
uniform float uBodyGain;
uniform float uAbsorb;
uniform float uAbsorbPow;
uniform float uEnvTint;
uniform float uSheen;
uniform float uWetBand;
uniform float uFoamCut;
uniform vec3  uCoolTint;
uniform float uCoolGain;
uniform float uPixelScale;
uniform sampler2D uFlowTex;

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

// ── advecting a noise field along a flow that is not constant ───────────────
// A flow map cannot simply offset its sample point by uTime * velocity. The
// velocity field varies over space, so the accumulated offset shears the noise
// without bound: the distortion of the sampled coordinate is (travel) times
// (the rate the direction turns), and on a meander the direction turns through
// pi in about fifty metres. A minute of play at three metres a second is a
// hundred and eighty metres of travel, and the surface is a smear.
//
// The remedy is the standard one: two copies of the field, half a cycle out of
// phase, cross-faded on the sawtooth, so neither copy is ever displaced by more
// than one cycle. FLOW_TRAVEL is that cycle in metres. Eight is a fraction of
// the broad features and about six of the fine ones, so the fade is invisible
// and the worst-case shear is bounded at eight metres times the turn rate,
// which is a tenth of a feature.
//
// It also has exactly the right degenerate case: at speed zero the phase is
// frozen and the field is static, which is a calm lake. Nothing has to branch.
const float FLOW_TRAVEL = 8.0;
// x, y = metres of advection for the two copies; z = mix weight toward the
// second. Continuous in time by construction: at the wrap the weight is 1 and
// the second copy's offset is exactly half a cycle either side of it.
vec3 wFlowPhase(float speed){
  float cyc = uTime * speed / FLOW_TRAVEL;
  float f0 = fract(cyc);
  float f1 = fract(cyc + 0.5);
  return vec3(f0 * FLOW_TRAVEL, f1 * FLOW_TRAVEL, abs(1.0 - 2.0 * f0));
}

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
  float near = 1.0 - smoothstep(3.0, 34.0, dist);

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
  vec2 T = coh > 0.02 ? vel / max(length(vel), 1e-4) : wdir;
  vec2 Bv = vec2(-T.y, T.x);
  float disch = FL.b;                 // 0..1, matches 'flow' on the polylines
  float turb = FL.a * coh;            // steep / pinched / fast
  // Metres per second, near enough. The constants are the swept ribbon's,
  // carried over unchanged because they were calibrated against this map: a 2%
  // surface gradient is a lazy meander and a 20% one is a genuine rapid.
  float speed = (0.55 + 4.2 * disch + 3.0 * turb) * coh;
  vec3 ph = wFlowPhase(speed);
  vec2 p = P.xz;

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
  float bedE = wBed(p + vec2(2.0, 0.0));
  float bedN = wBed(p + vec2(0.0, 2.0));
  float grad = max(length(vec2(bedE - bed, bedN - bed)) * 0.5, 0.02);
  float shoreIn = min(max(depth, 0.0) / grad, max(vShore, 0.0) + 6.0);
  float shoreOut = max(max(-depth, 0.0) / grad, max(-vShore, 0.0));

  // How close to the bank, as a fraction of the local half-width. This is what
  // the ribbon's aSide attribute was: 0 mid-channel, 1 against the bank. On a
  // lake vSpan is at its cap, so it is 0 over the whole open surface and only
  // wakes up within a channel-width of the shore.
  float bankT = 1.0 - clamp(shoreIn / max(vSpan, 1.5), 0.0, 1.0);
  // The width of everything shore-related scales with the body. A fixed one
  // metre band is the whole surface of a two-metre brook, which is how a quiet
  // creek ends up rendered as solid whitewater.
  float shoreBand = clamp(vSpan * 0.30, 0.30, 1.6);

  // ── the shoreline ────────────────────────────────────────────────────────
  // Water exists exactly where the surface is above the ground. Not where the
  // polygon ends, not where the baked wet flag flips — both are quantised to a
  // lattice and read as a cut edge. The band is wide enough to swallow the
  // half metre of micro-detail the terrain mesh adds on top of the baked
  // heightfield, and it widens with the pixel so the bank is one soft pixel at
  // any range rather than a stairstep at distance. Capped, or the shallow rim
  // of a distant body becomes a fade instead of water.
  //
  // The interior is exempt: whether there is water in the middle of a river is
  // not a question the antialias band gets to answer. The exemption starts
  // where the interior does, which is a distance from the bank and not a depth.
  float bodyCore = smoothstep(10.0, 40.0, max(vShore, 0.0));
  float depthFade = max(smoothstep(0.0, 0.62 + min(foot, 5.0) * 0.55, depth),
                        bodyCore * smoothstep(0.0, 0.20 + min(foot, 5.0) * 0.10, depth));
  // ...and a second fade, in METRES OF GROUND, and it is the one that actually
  // antialiases the waterline.
  //
  // A fade in depth is only an edge fade where the bank is gentle. On a steep
  // one — and the carve makes plenty of those — the whole depth band is crossed
  // inside a fraction of a metre of ground, which at any distance is inside one
  // pixel, so alpha goes 0 to 1 in a single step. What is then drawn as the
  // edge of the water is the GEOMETRIC intersection of the surface with the
  // terrain mesh, and that is a polygon: measured, by rendering alpha with the
  // discards removed, alpha was 1 on the last visible pixel along every incised
  // channel in 'river' and the boundary was the mesh, complete with 45-degree
  // corners, halving in size when the water lattice was halved.
  //
  // A fade over foot metres of GROUND is one pixel wide at every range by
  // construction, whatever the bank is doing, and it finishes before the
  // intersection rather than at it. Depth still has a veto — it is what knows
  // there is no water on the dry side — so the two are combined with a min.
  float edgeM = max(0.35, min(foot, 8.0) * 1.1);
  float shoreFade = min(depthFade, smoothstep(0.0, edgeM, shoreIn));
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
  float baked = smoothstep(-4000.0, -40.0, D.g);
  alpha *= 1.0 - (1.0 - baked) * smoothstep(1.2, 3.5, depth);
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
  alpha *= 1.0 - smoothstep(2.0, 9.0, -vShore);

  // ── the damp margin, on the DRY side ─────────────────────────────────────
  // Everything above places the edge of the water. What it cannot do is put
  // anything on the dry side of that edge, and half the read lives there: in
  // the plates a bank is gold grass, then a band of damp substrate, then the
  // waterline, then water. Draw the first, third and fourth and skip the
  // second and a shoreline reads as a cut-out however well antialiased it is.
  //
  // Gated in METRES OF GROUND, not in depth. uWetBand is a depth, and on a
  // flat apron a depth is an enormous area — at a bed slope of 1:30, one metre
  // of it is thirty-three metres of shore.
  //
  // ...and it is a WINDOW, which the lake shader's version was not: its inner
  // ramp opened at the waterline and never closed, so it was alive over every
  // pixel of water shallower than the shoreline fade's own band — up to three
  // and a half metres of depth at a grazing angle. A damp margin drawn over
  // open water is a pale slab lying on the bay, and it is only invisible when
  // the shoreline fade happens to be saturated.
  float wetT = smoothstep(-uWetBand, -0.02, depth)
             * (1.0 - smoothstep(-0.04, 0.06, depth))
             * (1.0 - smoothstep(1.1, 3.1, shoreOut));
  alpha = max(alpha, wetT * 0.80);
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
  float fetch = 0.42 + 0.58 * smoothstep(4.0, 55.0, max(vShore, 0.0));
  float wmag = length(uWind);
  // Wind drift is a plain coordinate offset because the wind direction is a
  // uniform — no advection machinery needed, and none of its cost.
  vec2 pw = p - wdir * (uTime * 0.55);
  vec2 g = vec2(0.0);
  {
    // Broad swell, ~9 m features. Driven by wind on still water and by
    // discharge on moving water, so a river is never glassy and a sheltered
    // pond can be.
    float k = 0.11;
    float eA = max(3.4, foot * 1.6);   // along the flow — long, so crests lie across it
    float eB = max(0.9, foot * 0.85);  // across it — short
    vec2 q0 = (pw - T * ph.x);
    vec2 q1 = (pw - T * ph.y);
    float c0 = wFbm2(q0 * k), c1 = wFbm2(q1 * k);
    float dA = mix(wFbm2((q0 + T * eA) * k) - c0, wFbm2((q1 + T * eA) * k) - c1, ph.z) / eA;
    float dB = mix(wFbm2((q0 + Bv * eB) * k) - c0, wFbm2((q1 + Bv * eB) * k) - c1, ph.z) / eB;
    g += (T * dA + Bv * dB) * (2.6 * wmag * fetch + 4.4 * (0.25 + 0.75 * turb) * coh * disch);
  }
  if (near > 0.01) {
    // Close chop, ~1.2 m features — the scale you see from a car window. At
    // forty metres it is already inside the footprint and the difference has
    // averaged it out on its own, so the whole block is skipped there.
    float k = 0.85;
    float eA = max(0.55, foot * 1.6);
    float eB = max(0.16, foot * 0.85);
    vec2 q0 = (pw - T * ph.x) + 31.0;
    vec2 q1 = (pw - T * ph.y) + 31.0;
    float c0 = wFbm2(q0 * k), c1 = wFbm2(q1 * k);
    float dA = mix(wFbm2((q0 + T * eA) * k) - c0, wFbm2((q1 + T * eA) * k) - c1, ph.z) / eA;
    float dB = mix(wFbm2((q0 + Bv * eB) * k) - c0, wFbm2((q1 + Bv * eB) * k) - c1, ph.z) / eB;
    g += (T * dA + Bv * dB) * (0.22 * wmag + 0.42 * coh) * near;
  }
  // Wind on water is patchy: cat's-paws of ripple with glassy lanes between.
  // Flowing water is not — a current is a current all the way across — so the
  // patchiness is withdrawn as coherence rises.
  float gust = 0.30 + 1.05 * (wFbm2(p * 0.045 - vec2(uTime * 0.05, 0.0)) * 0.5 + 0.5);
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
  float massWide = mix(0.14, 0.5, smoothstep(0.9, 3.4, foot));
  float massRaw = wStreak(p, T, 0.019, 62.0, ph);
  float mass = wSteps(smoothstep(0.24, 0.76, massRaw), 3.0, massWide);

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
  float deepT = wSteps(smoothstep(0.0, 3.2,
                  depth + (smoothstep(0.28, 0.72, massRaw) - 0.5) * 3.4
                        + (smoothstep(0.30, 0.70, shelfN) - 0.5) * 1.9),
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
  // Broad soft masses. At a kilometre they are eighty-metre features seen
  // through haze and all they do is mottle the surface into pale swirls that
  // read as scum, so they are withdrawn with distance.
  float fine = wDrift(p, T, 0.16, ph);
  body *= 0.86 + 0.28 * mass * (1.0 - 0.65 * far) + 0.16 * (fine - 0.5) * near;
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
  vec2 aheadV = T * (1.5 + vSpan * 0.7);
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
  float fn  = wStreak(p, T, 0.55, 3.4, ph);
  float cut = uFoamCut - drive * 0.34;
  float foam = smoothstep(cut, cut + 0.10, fn);
  foam *= smoothstep(0.04, 0.16, drive);

  // ── the waterline ────────────────────────────────────────────────────────
  // The single loudest cue in the reference: even a lazy meander is drawn with
  // a bright broken line where the water meets the bank, and without it water
  // reads as a sheet of blue vinyl laid in a ditch.
  //
  // Two placements, unioned, and they are complementary by construction. DEPTH
  // places the line, because depth is what places the alpha edge it has to sit
  // on; METRES OF SHORE decides how far it may spread. On a steep bank the
  // depth window is thin on screen and the metre skirt carries the width; on a
  // flat shelf the skirt closes while the depth window spreads.
  //
  // Both are capped. laceScale multiplies DEPTH windows and the footprint is a
  // HORIZONTAL distance: a pixel spanning foot metres of ground spans
  // foot * grad metres of depth, and on a flat apron that is small however wide
  // the pixel is. Multiplying the depth window by the raw footprint instead
  // pushed it to a couple of metres of depth, which on this map is the whole
  // foreground, and foam is applied LAST over everything else — which is why
  // that particular slab was immune to six body, shelf and reflection changes
  // made while hunting it.
  float laceFoot = min(foot, 2.5);
  float laceDepthPad = min(laceFoot * grad, 0.30);
  // Scalloped, not feathered. Plate 3's waterline is a row of separate lobes
  // two to four metres long with hard shoulders between them, following the
  // tufts of grass it runs behind — a low frequency and a hard edge, which is
  // what wSteps is for. What it modulates is the band's WIDTH, not its opacity:
  // modulating opacity gives a line that fades in and out along its length,
  // modulating reach gives one that bulges to a couple of metres at a mark and
  // pinches to a hairline between them.
  float laceWide = mix(0.11, 0.5, smoothstep(0.5, 2.4, foot));
  float scallop = wSteps(smoothstep(0.30, 0.70, wDrift(p, T, 0.30, ph)), 3.0, laceWide);
  // How wide the band is allowed to be, in METRES OF GROUND, and that is the
  // number docs/WATER_ART_SPEC.md 3.1-3.2 actually states: 0.3-0.4 m, on a
  // channel twenty to forty-five metres across. The old reach was
  // max(shoreBand * 0.80, laceFoot * 1.6) * (0.12 + 1.25 * scallop) — on a lake
  // shoreBand is at its 1.6 cap, so the floor alone was 1.28 m and the scallop
  // took it to 1.75, and at a grazing footprint the other branch reached 4 m
  // before the scallop touched it. An order of magnitude over the plate.
  //
  // The footprint term stays, because a band narrower than a pixel is a dotted
  // line rather than a waterline, but it is a FLOOR under a width that is
  // otherwise about half a metre — never a multiplier on it — and it is capped,
  // because foot divides by cos(incidence) floored at 0.035 and runs to tens of
  // metres on exactly the grazing geometry a shoreline is usually seen at.
  float laceReach = min(max(0.42, laceFoot * 1.1), 1.7) * (0.35 + 0.85 * scallop);
  float laceD = smoothstep(0.015, 0.10 + laceDepthPad, depth)
              * (1.0 - smoothstep(0.09 + laceDepthPad, 0.36 + laceDepthPad * 2.0, depth));
  // ...and the metre reach is a CEILING on the depth placement, not a taper on
  // it. This is where the pack ice actually came from, and the arithmetic is
  // worth writing down: laceD closes at 0.36 m of DEPTH, grad is floored at
  // 0.02, so on any gentle bank the window is 19 m of GROUND wide. Rendered at
  // 'river' that is a 30-50 px unbroken pale ribbon on both banks for the full
  // width of frame — measured #626270, C 0.053, and it is F6 exactly. The old
  // metre term only faded the band to 0.42 of itself over shoreBand * 3.2,
  // which for a lake is five metres, so it never cut anything.
  float laceW = 1.0 - smoothstep(laceReach, laceReach * 2.4, shoreIn);
  float laceM = (1.0 - smoothstep(laceReach * 0.25, laceReach, shoreIn))
              * smoothstep(0.012, 0.04 + laceDepthPad * 0.7, depth);
  float lace = max(laceD * laceW * (0.20 + 0.80 * scallop), laceM);
  // ...and it is ABSENT on some banks. docs/WATER_ART_SPEC.md 3.3 measures
  // plate 3's far bank and finds no lace at all on it while the near bank in
  // the same frame carries a bright one; F6 fails a near-white band that is
  // continuous along more than about 60% of a shoreline. A fringe round every
  // body of water in the map is pack ice. This is the one term that rations
  // COVERAGE rather than width or value, which is what the measurement says is
  // actually wrong when it goes wrong.
  //
  // MEASURED: this term had never fired. wFbm2 * 0.5 + 0.5 is a bell that
  // rarely leaves the middle third — the trap already written down at the depth
  // perturbation above, where a nominal 3.4 m of jitter delivered under a metre
  // — so it sat near 0.5 nearly everywhere and smoothstep(0.22, 0.46, ·) came
  // back 1.0 nearly everywhere. Rendering vec3(lace, foam, mirror) to the frame
  // showed the band unbroken along both banks across the whole of 'river'. The
  // one term that rations coverage was a no-op.
  //
  // Stretched to a real 0..1 first, then thresholded, so the cut can actually
  // land: roughly a third of bank length off, a third on, a third in between.
  // The field is isotropic in world space at a ~90 m period, so it takes the
  // lace off whole stretches of one bank while leaving the other — which is
  // what §3.3 measures P3 doing — and breaks what is left into segments.
  float laceCov = smoothstep(0.38, 0.62, wFbm2(p * 0.011 + 11.3) * 0.5 + 0.5);
  lace *= smoothstep(0.28, 0.72, laceCov);
  // A trickle gets a hint of a waterline; a river gets the full mark. On a
  // 1.5 m brook the depth window the line lives in is the whole creek, so the
  // line on each bank meets in the middle and the stream reads as a white cord
  // lying on dry ground rather than as water.
  lace *= 0.42 + 0.58 * smoothstep(1.0, 3.0, vSpan);
  foam = clamp(max(foam, lace * (0.88 + 0.12 * disch)), 0.0, 1.0);

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
  float sharp = exp(-foot * 8.0);
  col += uSunLight * (pow(nh, mix(24.0, 260.0, sharp)) * 0.55 * sharp
                    + pow(nh, mix(10.0,  40.0, sharp)) * 0.09) * (1.0 - foam) * shadow;

  // The cool governor runs on the BODY, before the foam is laid over it. Foam
  // is near-neutral by construction, so a governor that treats neutral as a
  // miss would tint every whitecap in the game blue. In proportion to how much
  // of the pixel is body rather than mirror: a reflected sky rotated toward the
  // body hue comes back as bright saturated blue where plate 3 keeps its pale
  // masses near-neutral, and it is that saturation SPLIT rather than an average
  // chroma that reads as water.
  col = wCoolGovern(col, absorbDeep, uCoolGain * (1.0 - mirror * 0.50));
  // Foam is a diffuse mass of bubbles: lit nearly flat, and through the foam
  // illuminant so a rapid under a golden key is white water and not a ribbon of
  // cream.
  vec3 foamCol = uFoam * wFoamLight(shadow) * 0.95;
  col = mix(col, foamCol, foam * 0.94);

  // A whisper of cool in the whole surface. Water in the reference is never the
  // same hue as the cream sky it sits under, even where it reflects it.
  col *= uCoolTint;

  // Shallows are see-through, but only a little. At 0.62 the gold bank read
  // straight through the shelf and every margin in the game came out khaki —
  // mud, which the brief names as an anti-pattern. Shallowness belongs in the
  // water's colour, which the depth ramp already handles, not in how much of
  // the bank is allowed to show through it.
  alpha *= mix(0.84, 1.0, smoothstep(0.12, 1.5, depth));
  alpha = max(alpha, foam * 0.92);
  alpha = max(alpha, wetT * 0.80);
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

  // ── the damp band, over dry ground ───────────────────────────────────────
  // DARK, and it keeps the meadow's hue. The lake shader drew it pale on the
  // strength of plate 5, where whitewater meets grass and the margin brightens
  // as its chroma collapses. docs/WATER_ART_SPEC.md 3.5 settles it: the
  // polarity comes from what the water is doing next to it. Against WHITE water
  // the band goes pale; against BLUE water — which is every frame in this map
  // except the foot of a fall — it goes 0.8 to 1.9 stops DOWN with C held at
  // 0.19-0.27 and cool held at -0.95 to -1.40, and a separate bright lace on
  // the wet side supplies the light note. A pale fringe drawn on the dry side
  // of blue water is the P5 recipe applied to a P3 situation, and it is a
  // second source of the pale slab this round exists to remove.
  //
  // This surface is composited OVER the ground, so it cannot multiply it. What
  // it can do is lay a colour that is already the ground's hue at a third of
  // its value: at the 0.62 alpha this band carries, blending 0.34 of the lit
  // gold over the meadow lands about 0.8 stops down with the hue intact, which
  // is band 2 of the plate's scan. uRefGround is that gold, already multiplied
  // by the key and the sun's intensity, so the band warms and cools with the
  // hour exactly as the bank beside it does. Broken with a shore noise so its
  // outer boundary is a ragged tide mark and not a second hard line parallel to
  // the first — two soft edges in a row is still a stripe.
  float wetN = wFbm2(p * 0.42 + 5.7) * 0.5 + 0.5;
  float wet = wetT * mix(0.55, 1.0, smoothstep(0.34, 0.62, wetN));
  col = mix(col, uRefGround * uDampDark, smoothstep(0.0, 0.55, wet));

  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
