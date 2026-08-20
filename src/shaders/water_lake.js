// ─────────────────────────────────────────────────────────────────────────────
//  water_lake — the standing-water surface shader.
//
//  Split out of Water.js for the reason given in water_river.js. Water.js owns
//  the lake mesh and the aWet / aShore attributes; this file owns the surface.
// ─────────────────────────────────────────────────────────────────────────────
import { WATER_NOISE, WATER_ENV, WATER_FOAM_LIGHT } from './water_common.js';

export const LAKE_VERT = /* glsl */`
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

export const LAKE_FRAG = /* glsl */`
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
uniform float uWetBand;
uniform vec3  uCoolTint;
uniform float uCoolGain;
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
  // Capped, for the reason given in the river shader: an uncapped band turns
  // the whole shallow rim of a distant lake into a fade instead of into water.
  // The interior of a lake is exempt from the fade entirely — how far from the
  // bank a pixel is, not how wide a pixel is, decides whether it is water — so
  // the band is free to stay wide enough to actually antialias the margin.
  // ...and this exemption is where the hard shoreline actually lived. At 2-11 m
  // from the bank it takes over almost immediately, and its own depth ramp is a
  // fixed 20 cm — so on any bank steeper than about 1:10 the max() below picks
  // the exempt term two metres from the water's edge, the footprint-scaled
  // antialias never gets to run, and the lake ends on a one-pixel step. Which
  // is exactly what the far shore of the big lake measured at 180 m, and what
  // a critic recorded as 'a hard aliased line where the water quad meets
  // terrain'.
  //
  // The exemption is for the *interior*, so it has to start where the interior
  // does. Ten to forty metres out, and its ramp widens with the pixel too —
  // just far more slowly than the shoreline's, which is the whole distinction
  // the exemption exists to draw.
  float lakeCore = smoothstep(10.0, 40.0, vShore);
  float shoreFade = max(smoothstep(0.0, 0.62 + min(foot, 5.0) * 0.55, depth),
                        lakeCore * smoothstep(0.0, 0.20 + min(foot, 5.0) * 0.10, depth));
  // The mesh is dilated one ring beyond the baked water so the fade has room to
  // finish inside geometry. That ring is the only place this gate does anything
  // — it stops a perched lake from painting itself down a cliff face.
  float alpha = shoreFade * smoothstep(0.05, 0.55, vWet);

  // ── wet margin ───────────────────────────────────────────────────────────
  // Everything above places the *edge of the water*. What it cannot do is put
  // anything on the dry side of that edge, and the dry side is where half the
  // read lives: in the plates a bank is gold grass, then a band of dark damp
  // substrate, then the waterline, then water. We drew the first, third and
  // fourth and skipped the second, which is why a shoreline here has always
  // read as a cut-out — a perfectly antialiased line is still a line.
  //
  // The lake mesh is already dilated a full 8 m quad past the baked water, so
  // there is geometry sitting over dry ground with nothing drawn on it. This
  // uses it: a couple of metres of low-alpha cool grey laid over whatever the
  // terrain author put there, strongest at the waterline and gone by the time
  // it reaches the edge of the ring. Over gold meadow that reads as damp sand,
  // which is exactly what it is.
  //
  // Note it is measured in *depth*, negative on the dry side, so it follows
  // the same surface the alpha edge does and can never separate from it.
  float wetT = smoothstep(-uWetBand, -0.02, depth) * (1.0 - shoreFade);
  // The dilation ring's own taper — and it was throttling the band almost out
  // of existence. aWet is averaged over the (up to four) grid cells touching a
  // vertex, so on the outer half of the ring it is 0 and on the inner half it
  // is 0.25 or 0.5: gating at 0.02-0.30 left the band alive across about one
  // 8 m cell of an 8 m ring, quantised to the grid, and absent altogether on
  // any bank whose geometry happened to land the other way. Measured on the
  // far shore of the big lake at 180 m there was no band at all and the water
  // ended on a one-pixel step against gold grass — blocker #13 in its plainest
  // form, still there after the band was written.
  //
  // The whole ring may take part now. The depth gate above is the real limit
  // and it is the honest one: ground more than uWetBand metres above the water
  // is not a damp margin whatever the mesh says, so a cliff is excluded by
  // construction and cannot pick this up.
  wetT *= smoothstep(-0.45, 0.10, vWet);

  // ...and the band has to be limited in METRES OF GROUND, not only in depth.
  //
  // uWetBand is a depth, and on a flat apron a depth is an enormous area: at a
  // bed slope of 1:30, 1.1 m of it is thirty-three metres of shore. That is
  // the pale slab filling the foreground of the 'mouth' framing. It survived
  // narrowing the band from 3.1 m to 1.1 m, survived retiring the terrain sand
  // stub, and survived darkening the shallow-shelf body colour, because none
  // of those was what drew it. Hiding the lake meshes alone — river ribbons
  // left visible — removes it and hands back warm meadow, which is what
  // finally named it.
  //
  // The river shader has had the answer since the round that fixed the same
  // defect on channel margins: divide depth by the local bed gradient to get
  // a horizontal distance, and gate on that. Its comment says it exactly —
  // "a wide shallow flat is not a shoreline, and treating it as one is what
  // turns river margins into big amorphous white blobs". A lake margin is the
  // identical case and never got the identical fix.
  //
  // Sampled on both axes because a lake bank has no channel tangent to work
  // across, and floored so a dead-level pan cannot divide by zero and paint
  // the county.
  float bedE = wBed(vWPos.xz + vec2(2.0, 0.0));
  float bedN = wBed(vWPos.xz + vec2(0.0, 2.0));
  float grad = max(length(vec2(bedE - D.r, bedN - D.r)) * 0.5, 0.035);
  float shoreM = abs(depth) / grad;
  // docs/WATER_ART_SPEC.md 3.5 measures the plates' damp band at 0.7-1.1 m on
  // an ordinary bank, reaching ~3.1 m only on the very shallowest. That is a
  // width on the ground, which is what this now is.
  wetT *= 1.0 - smoothstep(1.1, 3.1, shoreM);
  alpha = max(alpha, wetT * 0.66);

  // ── the perched-lake guard ───────────────────────────────────────────────
  // A hard-edged blue wedge lies across a bare gorge wall in the 'waterfall'
  // framing and across a ridge in 'peaks', with straight polygon edges and no
  // ground contact anywhere. The comment on 'vWet' above claims that gate
  // "stops a perched lake from painting itself down a cliff face". It does
  // not, and it cannot: aWet is a property of the *mesh*, quantised to the
  // 8 m lake grid, so a vertex on the rim of a perched basin carries a wet
  // value from the cell it belongs to and the fragments interpolated off it
  // inherit it all the way down the rock. Nothing in this shader ever asked
  // the world whether there was water at the pixel.
  //
  // The river ribbon has had the equivalent guard for several rounds — see
  // 'airborne' in water_river.js, written for a ribbon that kept going after
  // its bed dropped out from under it. This is the same defect with a lake in
  // it, and it went unnoticed for as long as it did because the water was a
  // pale haze; a round that made the body properly blue made it loud.
  //
  // The honest signal is the bake. D.g is the baked water surface and it is
  // the sentinel -9999 wherever the bake says there is no standing water. The
  // data texture filters linearly, so that sentinel is blended across the
  // boundary and anything still below about -40 is unambiguously *outside*
  // any water body rather than merely near its edge.
  float baked = smoothstep(-4000.0, -40.0, D.g);
  // Both terms are needed. The mesh is deliberately dilated a ring past the
  // baked water so the shoreline fade has geometry to finish inside, and that
  // ring is legitimately outside the bake — but it lies within a fraction of
  // a metre of the ground it covers, because that is what a shore is. Water
  // painting itself down a rock face is metres above the rock. Gating on the
  // bake alone would delete the dilation ring and take the whole antialiased
  // shoreline and the damp band with it.
  float perched = (1.0 - baked) * smoothstep(1.2, 3.5, depth);
  alpha *= 1.0 - perched;
  // MEASURED — this widening was the one un-isolated perf suspect left in the
  // system, on the reasoning that the ring's fragments now clear the discard
  // below and run the full lake shader including a 24-step wEnvReflect. It is
  // not a cost. Interleaved sceneab, 16 cycles x 20 frames, camera parked on
  // the bank of the deepest lake in the map looking across it so the frame is
  // as much shoreline as this map can make:
  //
  //   uWetBand  0.001   +0.4%   (iqr 2.0%)
  //   uWetBand  3.1      base
  //   uWetBand  12.0    +0.3%   (iqr 2.6%)
  //   uWetBand  40.0    -0.3%   (iqr 1.4%)
  //
  // 40 m is 13x the shipped band and pushes the *entire* dilation ring past
  // the discard, so that arm is the ceiling on what this can ever cost, and it
  // is zero. The stronger result from the same run: uReflectSteps 24 -> 0 in
  // that framing is -0.6% (iqr 2.9%). The march does not measure even when it
  // runs on every lake pixel in a lake-filling frame, so it cannot measure on
  // an 8 m ring. Water fill is not what this frame is bound by. Do not spend a
  // round making this cheaper.
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

  // ── the roughness mass ───────────────────────────────────────────────────
  // One low-frequency field, stepped, and everything painterly below is driven
  // off it: how pale the body is, how much sky the surface hands back, and how
  // far past the shore the reflected cone reaches. One field rather than three,
  // because in the plate a pale patch is pale in its body *and* bright in its
  // reflection at the same time — a stretch of rougher, shallower water is one
  // physical thing, not three coincidences. Three independent stepped fields
  // multiply into a dozen levels and come back as mottling.
  //
  // Streaked, not blobbed. The plate's bright masses are long marks lying along
  // the water, not isotropic patches — a rippled surface hands back sky in
  // *bands* because the roughness that does it is combed by the wind. Sampling
  // the mass anisotropically along the wind axis costs nothing and is most of
  // what makes this read as water rather than as mottling.
  //
  // Stepped, because the shoulder is the read. Plate 3's bright sheets are flat
  // hard-shouldered masses spanning luma 0.29 to 0.61 with a boundary you can
  // put a finger on; run through a smooth ramp the same noise gives every value
  // between the two in equal measure, which averages to the correct mean and
  // looks like satin. The average was never the problem.
  //
  // A second octave, and it is not a refinement — without it this shader has no
  // masses at all on most of the water in the game. MEASURED by rendering the
  // field straight to the frame in the river view: the surface came back as one
  // continuous blue-to-magenta ramp with no step in it, and the reason is scale,
  // not band-limiting (the footprint there is under 0.6 m, so the quantiser is
  // running at its narrowest). The broad term is 238 m along the wind by 53 m
  // across it — sized for the open basin this shader was written for — and the
  // channel it is now being asked to paint is fifteen metres wide, so a whole
  // reach sits inside a third of one feature and the three levels have nowhere
  // to change. The plate's masses are metres across, not hundreds.
  //
  // That matters because the lake surface draws far more than lakes now: the
  // 'river' framing is standing water end to end, so this field has to hold up
  // at channel scale and at basin scale from the same constants. 62 m by 14 m
  // is a mass a river can carry two or three of.
  //
  // The fine octave is the one with features small enough to alias, so it fades
  // out on the footprint and the sum is renormalised as it goes — the broad
  // term keeps the same mean and range on its own once the fine one is gone,
  // which is what stops a distant basin changing value as it recedes.
  vec2 sdir = normalize(uWind + vec2(1e-4, 1e-4));
  vec2 sperp = vec2(-sdir.y, sdir.x);
  vec2 sq  = vec2(dot(p, sdir) * 0.0042, dot(p, sperp) * 0.019);
  vec2 sq2 = vec2(dot(p, sdir) * 0.016, dot(p, sperp) * 0.072);
  float sheenWide = mix(0.14, 0.5, smoothstep(0.9, 3.4, foot));
  float fineAmt = 0.55 * (1.0 - smoothstep(1.2, 4.0, foot));
  float massRaw = (wFbm2(sq + vec2(uTime * 0.004, 0.0))
                 + wFbm2(sq2 + vec2(uTime * 0.013, 0.0)) * fineAmt)
                / (1.0 + fineAmt) * 0.5 + 0.5;
  float mass = wSteps(smoothstep(0.24, 0.76, massRaw), 3.0, sheenWide);

  // The ramp reaches further than it did. A shelf that darkens to full depth
  // colour inside four metres gives a lake two states — rim and body — and the
  // reference reads its water as a continuous gradient from a pale, almost
  // sandy edge into the deep. Six metres is roughly the depth at which the bed
  // stops contributing anything.
  // Painterly value structure: broad, slow, low-frequency masses rather than a
  // single flat tint. Large areas of near-uniform colour with soft boundaries
  // is what makes the reference read as painted. The field is the shared one
  // computed above — it was a separate 83 m noise, which is the same
  // one-feature-per-reach problem, and folding the two saves a wFbm2 as well.
  // The depth ramp is a *contour generator*: it is a smooth function of a
  // heightfield, so wherever the bed flattens out it draws its own isoline on
  // the water. Measured on this lake, a shelf came back as flat pale islands
  // with a boundary you could trace — the same class of artifact as the gold
  // contour ribbons the terrain author had to break on land. Perturbing the
  // depth the ramp reads (not the depth anything else reads) with the broad
  // mass noise turns that boundary ragged for nothing.
  // ...and the ramp is stepped, which is the whole difference between a shelf
  // and a sandbar. Measured off plate 3: the pale mass inside its water runs
  // #9c98ad at luma 0.61 against #2b5a8a at 0.33 for the deep body beside it —
  // two masses, nearly a stop apart, with a boundary you can put a finger on.
  // A continuous ramp cannot draw that however far it reaches; it draws the
  // average of the two and a gradient where the edge should be, which is what
  // every shelf in this map has looked like.
  //
  // The perturbation above stays and matters *more* here, not less. Quantising
  // a smooth function of the bed turns the contour-generator problem from one
  // isoline into three, so the depth the ramp reads is jittered by the broad
  // mass noise before the quantiser sees it and the three boundaries come out
  // ragged. The step width falls back to 0.5 — a plain linear ramp — as soon as
  // a level is smaller than a pixel, so nothing here can band or crawl at
  // range; a distant basin still gets the smooth gradient it had.
  //
  // The perturbation carries more than it used to, and that is the point
  // rather than a side effect. The pale masses inside plate 3's water are
  // shelves and bars: the *body* going pale where the bed is close, at
  // #9c98ad against #2b5a8a — a factor of 1.9 in luma, and the brightest note
  // in the water short of the waterline itself. Our carved channels have a
  // smooth bed and therefore no bars at all, so on this map the ramp sits at
  // one level down the whole reach and the mechanism that draws the plate's
  // best feature never fires. Perturbing by 3.4 m against a 0-7 m ramp is what
  // lets a two-metre channel hold a pale mass and a deep one; it is a
  // stylisation, and it is the same one the plate is making, since a painter
  // draws a bar where the picture wants a bar.
  float shelfWide = mix(0.15, 0.5, smoothstep(1.2, 5.0, foot));
  // The ramp reached to 7 m, and a lake in this map has a wide shallow apron:
  // anything under about two metres therefore sat at the pale shallow anchor,
  // and on the 'mouth' framing that painted a single near-neutral mass across
  // most of the foreground — brighter than the gold meadow beside it, when
  // reference plate 3 puts its shelf half a stop BELOW the meadow. Attributed
  // by hiding one system at a time in a single page load: with water hidden
  // the mass disappears entirely and the ground under it is ordinary warm
  // meadow, so it is this surface and not the terrain's sand term (which was a
  // step function on a two-valued stub, separately fixed) and not the damp
  // band (narrowed from 3.1 m to 1.1 m first, with no effect on it at all).
  //
  // 3.2 m puts the transition where a shelf actually stops contributing.
  float deepT = wSteps(smoothstep(0.0, 3.2, depth + (massRaw - 0.5) * 3.4), 3.0, shelfWide);
  // ...and the shallow anchor is not a paint colour. It is what you see when
  // you can see the bed, and the bed here is gold meadow. Taken literally as
  // '#9dc4d8' it drew every sandbar in the map as a flat pastel cyan island —
  // the Caribbean swimming pool the note on uSubsurface below already warns
  // about, arriving from the other side. Warmed toward the ground it covers,
  // a shelf reads as sand under water and the step against the deep water
  // beside it drops from two stops to under one.
  // ...and the shallow anchor itself was too pale and too warm. Warming the
  // pale tone 40% toward the ground it covers is the right idea — a shelf
  // should read as bed seen through water — but taken this far it lands ABOVE
  // the meadow in value, which is the one thing a shelf may never do.
  // docs/WATER_ART_SPEC.md 1.2 measures plate 3's shelf at #536684: C 0.194,
  // S 0.374, cool 1.12, and 0.53 stops BELOW the meadow. Half the ground mix
  // and a third off the value lands on that; the deep end is untouched, so the
  // saturation split the plate has between shelf and deep body survives.
  vec3 shelf = mix(uShallow, uRefGround, 0.20) * 0.62;
  vec3 body = mix(shelf, uDeep, deepT);
  // Same idea at arm's length: broad masses read at 300 m, these read at 3 m.
  float fine = wFbm2(p * 0.16 + vec2(uTime * 0.03, uTime * 0.012)) * 0.5 + 0.5;
  // The broad masses are a near-field read. At a kilometre they are 80 m
  // features seen through haze, and all they do there is mottle the surface
  // into pale swirls that look like scum on it — a distant lake wants to be
  // one flat mass of colour, which is what the reference plates do with it.
  body *= 0.86 + 0.28 * mass * (1.0 - 0.65 * far) + 0.16 * (fine - 0.5) * near;
  // Ankle-deep water over gold meadow is warm, not cyan. Letting the bed colour
  // through the shallows is what stops a flooded flat reading as a plastic
  // sheet laid over the ground.
  // Trimmed from 0.34. uSubsurface is a saturated teal, and a third of it in
  // the shallows is what made every lake read as a Caribbean swimming pool at
  // noon — measured at chroma 0.46 against the palette's own shallow tone at
  // 0.24. The warm bed bounce is a real effect and worth keeping; it is not
  // worth a turquoise lake.
  body = mix(body, uSubsurface, (1.0 - deepT) * 0.22);

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
  //
  // Deepened further with distance. Four hundred metres of the shared haze is
  // a hard lerp toward a warm, bright horizon colour, and it eats chroma from
  // whatever it is given: a basin measured at chroma 0.078 against 0.48 for
  // the land it sits in, which is a neutral slab, not water. Handing the haze
  // a more saturated surface to work on is the only lever this material has
  // that does not amount to writing its own fog — the brief reserves that for
  // Atmosphere, and rightly.
  float absorbPow = uAbsorbPow * (1.0 + 0.42 * far);
  // Hoisted: the cool governor at the bottom of the shader has to be handed
  // the same deepened hue this line tints with, or the two disagree about
  // what colour the water is. See wCoolGovern.
  vec3 absorbDeep = pow(absorb, vec3(absorbPow));
  vec3 lit = wTint(irr * bodyY, absorbDeep, uAbsorb) * uBodyGain;

  // The mass this rides on is computed above the body colour, because the
  // depth ramp and the reflection both read it too — see the note there.

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
  // ...and the marched *landscape* is a near-field read on top of that. Half a
  // kilometre out the hit point wanders by tens of metres between neighbouring
  // pixels, and what it draws on the water is a set of warm diagonal smears
  // that read as an oil slick rather than as a reflected bank. Past that range
  // the honest answer is the sky, which is also the one that keeps a distant
  // basin the cool note in a hot valley.
  marchOn *= 1.0 - far * 0.78;
  // How much of the cone reaches past the shore, decided by the roughness mass
  // — see the long note at the river's copy of this, which is where it was
  // measured. A lake looked at from its own bank is the same geometry as a
  // river looked at from its own bank: the mirror direction points into the
  // opposite shore across the entire surface, the march hands back hillside
  // everywhere, and because that hillside is deliberately desaturated and
  // darkened it lands within a few percent of the body colour in value. Mixing
  // between two colours that close cannot produce a mass however it is
  // weighted. A rough patch reflects a wider cone whose top clears the ridge,
  // so roughness is what decides how much sky is in the answer.
  float reach = marchOn * (0.30 + 0.70 * (1.0 - mass));
  vec3 envRaw = wSkyTilt(R);
  if (reach > 0.01) envRaw = mix(envRaw, wEnvReflect(vWPos, R), reach);
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
  // ── the broad sheet of reflected sky ─────────────────────────────────────
  // Fresnel alone is not what the reference plates draw. Measured: plate 3's
  // river runs srgb(107,119,135) at luma 0.46 with a ratio of 1:1.11:1.27 —
  // a pale, almost neutral blue-grey. This lake measured srgb(33,49,81) at
  // luma 0.187 and 1:1.46:2.45, i.e. two and a half stops darker and twice as
  // saturated, because at anything but a grazing angle physical Fresnel is
  // 5-8% and the surface is then almost pure body colour. A basin that dark is
  // a hole in a frame the brief wants at lumaP05 0.16+.
  //
  // A real lake is brighter than Fresnel says because it is *rough*: a rippled
  // surface reflects a cone, and the fraction of that cone that clears the
  // critical angle is far larger than the mirror-direction reflectance of a
  // flat one. Stating that as a floor under the Fresnel term is the honest
  // stylisation, and it is broad and low-frequency by construction — the
  // brief's "broad low-frequency sky reflection, not mirror detail" — because
  // the mass it rides on is an 80 m noise, not a per-ripple normal.
  // ...and the *range* in that sheet is the whole read, which the first pass at
  // this missed. Measured off plate 3, the water there runs from a dark
  // blue-violet body at srgb(52,62,96) to near-white silver sheets at
  // srgb(205,216,232) — better than two stops, inside one river, in broad soft
  // masses. Ours ran 0.52-1.0 of a single dial, which after the mix lands
  // everywhere between 'pale blue' and 'slightly paler blue': one flat tint, and
  // a lake that reads as a paint-bucket fill however correct its average is.
  // The average was never the problem.
  //
  // The mass this rides on is computed above the reflection now, because the
  // reflection reads it too — see the note there.
  float sheenMass = 0.10 + 0.90 * mass;
  // Withdrawn in the shallows for the same reason the mirror is: a rim you can
  // see the bed through does not hand back a sheet of sky.
  float sheen = uSheen * sheenMass * smoothstep(0.10, 1.4, depth);
  // The mass scales the Fresnel sheet too, not just the sheen floor beside it.
  // Measured on the river capture and it applies here with more force: a lake
  // is nearly always seen at a grazing angle from its own bank, fres runs into
  // its ceiling across the whole surface, and max() then discards the sheen
  // mass and every bit of value range it carries. Scaling by roughness rather
  // than adding another dial — a combed lane hands back less of a grazing
  // reflection than the glassy lane beside it, which is the banding plate 3
  // draws on its water.
  // ...but the ceiling was 0.88, and that is the pale slab.
  //
  // A lake in this map is nearly always seen from its own bank, so the whole
  // near half of it sits at a grazing angle and fres is pinned at its ceiling
  // there. At 0.88 the surface is then 88% environment, the march over open
  // water usually clears the far ridge, and what comes back is wSkyTilt — the
  // pale sky, lifted 0.42 in y to sample higher and bluer. The foreground of
  // the 'mouth' framing is that: a mirror of the sky, brighter than the gold
  // meadow beside it, neutral, and completely immune to the body colour.
  //
  // Which is exactly why it survived four separate attempts to fix it as
  // something else — narrowing the damp band 3.1 m to 1.1 m, gating that band
  // in metres of ground instead of depth, retiring the terrain's two-valued
  // sand stub, and darkening the shallow-shelf anchor. None of them touched
  // it, because none of them was in the term that draws it. Hiding the lake
  // meshes while leaving the river ribbons visible is what finally isolated it.
  //
  // The river shader caps the same quantity at 0.42 on the same geometry, and
  // docs/WATER_ART_SPEC.md names this failure F3 with a measurement: under 15%
  // of the water may be simultaneously C < 0.09 and above the meadow in value.
  // Note the spec's instrument cannot see this particular instance — its water
  // mask is a blue rule, and water this neutral falls outside it, so item 5
  // reports 0.1% on a frame with a sky-mirror across the foreground. Trust the
  // frame over the number here; the mask share is printed for this reason.
  //
  // 0.52 keeps the grazing sheet that gives a lake its far-shore glare and
  // stops it owning the near field. The mass scaling stays: it is what kept
  // the sheen's value range from being discarded by the max().
  float mirror = clamp(max(fres * 0.90 * (0.36 + 0.64 * mass), sheen), 0.0, 0.88)
               * smoothstep(0.10, 1.2, depth);
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
  float fn = wFbm3(p * 0.30 + vec2(uTime * 0.05, 0.0)) * 0.5 + 0.5;
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
  // The depth window the waterline lives in has to grow with the pixel. Fixed
  // at 1.5-36 cm it is sub-pixel on any bank more than a few dozen metres off,
  // so the lace vanishes exactly where it is most needed and the shoreline
  // resolves into a bare stair-stepped polygon edge — visible at 3x on any
  // mid-distance bank. A waterline is a couple of pixels wide at every range,
  // which is a statement about the footprint, not about depth.
  // 6.0 was far too generous a cap, and it is the pale slab.
  //
  // laceScale multiplies a set of DEPTH windows. At the cap it reaches 11.2,
  // which puts laceD's window at roughly 1 m to 4 m of depth — so on any lake
  // with a wide shallow apron the waterline paints the entire apron, and the
  // apron is most of the near field. wFootprint divides by cos(incidence) with
  // a floor of 0.035 precisely so grazing geometry reports the very large
  // footprint it really has, and a lake seen from its own bank is the most
  // grazing geometry in the game.
  //
  // The intent of the scaling is sound and is argued above: a waterline should
  // be a couple of pixels wide at every range rather than dropping below
  // Nyquist in the mid distance. But a couple of pixels is what it has to buy,
  // and 2.5 m of footprint already buys that at any range this map contains.
  //
  // Capped once, here, and reused by laceReach below, because the same
  // unbounded footprint was inflating a world-space reach there as well. This
  // is failure F6 in docs/WATER_ART_SPEC.md — a foam line reading as pack ice —
  // arriving through the band-limiting term rather than through opacity, which
  // is where the round that wrote this was watching for it. It survived
  // narrowing the damp band, gating that band in metres of ground, retiring
  // the terrain sand stub, darkening the shallow-shelf anchor and dropping the
  // reflection ceiling, because none of those is what draws it: foam is
  // applied last, through col = mix(col, foamCol, foam), over everything.
  float laceFoot = min(foot, 2.5);
  float laceScale = 1.0 + laceFoot * 1.7;
  // ...and laceScale must not be applied to these, because they are DEPTHS and
  // it is a HORIZONTAL footprint. That unit mismatch is the pale slab.
  //
  // A pixel spanning foot metres of ground spans foot * grad metres of DEPTH,
  // where grad is the local bed gradient computed for the damp band above. On
  // a flat apron grad is small, so the honest depth pad is small however wide
  // the pixel is — which is correct: a shallow shelf seen at a grazing angle
  // needs a wider band in metres of shore, not a deeper one in metres of
  // water. Multiplying the depth window by the raw footprint instead pushed it
  // out to roughly 0.5-1.9 m of depth, which on this lake is the entire
  // foreground, and foam is applied last through col = mix(col, foamCol, foam)
  // over everything else.
  //
  // Confirmed by writing vec4(foam, mirror, deepT, 1.0) straight to the frame:
  // the slab comes back solid RED. It survived six other fixes — narrowing the
  // damp band, gating that band in metres of ground, retiring the terrain sand
  // stub, darkening the shallow-shelf anchor, dropping the reflection ceiling,
  // and capping the footprint feeding laceReach — because none of them was the
  // term that draws it.
  float laceDepthPad = min(laceFoot * grad, 0.30);
  float laceD = smoothstep(0.015, 0.10 + laceDepthPad, depth)
              * (1.0 - smoothstep(0.09 + laceDepthPad, 0.36 + laceDepthPad * 2.0, depth));
  float laceW = 1.0 - smoothstep(0.8, 3.6, distShore);
  // The floor was rationed to 0.26 against a continuous white fringe reading as
  // pack ice. That was the right worry and the wrong number: plate 3 draws the
  // margin of its river as a *bright* cream ribbon several metres wide along
  // most of its length, and the shelves this map is made of put nearly every
  // shoreline in the game on the floor rather than at the peak.
  // A second placement, in metres of water rather than in depth — see the long
  // note in the river shader, the argument is the same one and this is the
  // shore it fails on hardest. A lake dammed against a steep bank crosses the
  // whole 1.5-36 cm depth window inside a few centimetres of ground, so the
  // band existed and was narrower than a pixel. Still depth-anchored, so it
  // cannot leave the alpha edge.
  // Broken twice, at two scales. One noise threshold turns the band into a
  // long soft smear with a couple of gaps in it; the reference draws its
  // waterline as a row of separate bright marks, and it takes a coarse noise
  // to place the marks and a finer one to give each of them an edge.
  //
  // The coarse one places them with wSteps now rather than with a smoothstep.
  // Two soft ramps multiplied together are still a soft ramp: what came out was
  // a band whose *strength* varied continuously along the shore, which reads as
  // a line that fades in and out, not as separate marks with gaps between them.
  // fn is stretched to a real 0..1 before quantising (raw fbm never leaves the
  // middle third) and dropped from 1.3 m features to 3.3 m, because a scallop
  // in plate 3 is metres long, not a hand's width. The fine noise keeps its
  // job — an edge on each mark — but is faded on the footprint, which it never
  // was: 0.34 m features are sub-pixel on any shore past a few dozen metres.
  //
  // And what the coarse mark drives is the band's *width*, for the reason set
  // out at the river's copy of this: modulating opacity gives a line that
  // pulses in brightness, modulating reach gives one that bulges and pinches,
  // and only the second reads as a scallop. It is also what keeps the pack-ice
  // failure away without rationing the peak — the band is allowed to be bright
  // and several metres wide at a mark precisely because it closes to a
  // hairline between them.
  float fn2 = wFbm2(p * 2.9 + vec2(uTime * 0.09, uTime * 0.04)) * 0.5 + 0.5;
  float laceWide = mix(0.11, 0.5, smoothstep(0.5, 2.4, foot));
  float scallop = wSteps(smoothstep(0.30, 0.70, fn), 3.0, laceWide);
  float edge = mix(1.0, smoothstep(0.30, 0.50, fn2), 1.0 - smoothstep(0.12, 0.45, foot));
  // CAPPED, and this is the pale slab.
  //
  // Every other use of foot in this file is bounded — laceScale takes
  // min(foot, 6.0), the shoreline fade min(foot, 5.0) — and this one was not.
  // It matters more here than anywhere else because laceReach is a distance in
  // METRES OF WORLD, not a blend width: whatever it comes to, the line below
  // paints lace across that much shore.
  //
  // wFootprint divides by cos(incidence) with a floor of 0.035, precisely so a
  // grazing surface reports the large footprint it really has. A lake seen
  // from its own bank over a near-flat apron is the most grazing geometry in
  // the game, so foot there runs to tens of metres, and 1.6x that is a lace
  // band wider than the bay. That is the flat pale mass filling the foreground
  // of the 'mouth' framing: not sand, not the damp margin, not the shallow
  // shelf, not a sky mirror — the waterline itself, painted a hundred times
  // too wide, and applied last through col = mix(col, foamCol, foam), which is
  // why it was immune to every body, shelf and reflection change made while
  // hunting it.
  //
  // It is the pack-ice failure named in docs/WATER_ART_SPEC.md F6, arriving
  // through the footprint rather than through opacity — which is where the
  // round that wrote this term was watching for it.
  //
  // 2.5 m still lets a distant shoreline hold a lace band a pixel or two wide
  // rather than dropping it below Nyquist, which is what the scaling is for.
  float laceReach = max(1.1, laceFoot * 1.6) * (0.12 + 1.25 * scallop);
  float laceM = (1.0 - smoothstep(laceReach * 0.20, laceReach, distShore))
              * smoothstep(0.012, 0.04 + 0.07 * laceScale, depth);
  float lace = max(laceD * mix(0.42, 1.0, laceW) * (0.20 + 0.80 * scallop), laceM);
  float marks = mix(0.55, 1.0, edge);
  // Far shorelines get a pale edge, not a white rope: the lace noise is
  // sub-pixel past a couple of hundred metres and averages to a solid band.
  float foam = lace * marks * mix(1.0, 0.45, smoothstep(140.0, 520.0, dist));
  // Foam is a diffuse mass of bubbles: lit nearly flat, and never allowed to
  // sink to the ambient's blue — white water that is not white is haze.
  // The governor runs on the *body*, before the foam is laid over it. Foam is
  // near-neutral by construction, so a governor that treats neutral as a miss
  // would tint every whitecap in the game blue.
  // ...and in proportion to how much of the pixel is body rather than mirror,
  // for the reason set out at the river's call site: the floor is a statement
  // about the water, and a reflected sky rotated toward the body hue comes back
  // as bright saturated blue where plate 3 keeps its pale masses near-neutral.
  //
  // Half, not all of it, and the number was swept rather than argued. At a full
  // withdrawal (1.0 - mirror * 0.85) the far half of the lake in the mouth
  // framing measured 1:1.65:2.42; at 0.50 it measures 1:1.86:2.81 against plate
  // 3's 1:2.11:3.23, and the near water, the shelves and the dawn frame all
  // moved by less than one part in a hundred. The grazing far field is where a
  // lake is almost all mirror and is exactly where it used to read as a pale
  // neutral slab, so that is the arm of the sweep that had something to gain.
  // The saturation split the gate exists to protect survives it — checked on
  // the capture, the pale masses are still visibly the desaturated ones.
  col = wCoolGovern(col, absorbDeep, uCoolGain * (1.0 - mirror * 0.50));
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

  // The damp band is ground with water in it, not water: darker and a shade
  // cooler than the dry substrate beside it, never brighter. A *pale* fringe
  // round every lake is pack ice, which is the failure the lace above already
  // has to be rationed to avoid. Broken with the same shore noise so its outer
  // boundary is a ragged tide mark rather than a second hard line parallel to
  // the first — two soft edges in a row is still a stripe.
  float wetN = wFbm2(p * 0.42 + 5.7) * 0.5 + 0.5;
  float wet = wetT * mix(0.55, 1.0, smoothstep(0.34, 0.62, wetN));
  // Pale, not dark. Wet sand in the world is darker than dry sand; wet sand in
  // *these plates* is not. Plate 3 draws the margin between gold grass and blue
  // water as a bright cream ribbon and plate 5 draws it as pale grey — the
  // stylisation puts a light note there, and a dark umber band drawn on the
  // same geometry reads as mud, which the brief names as an anti-pattern. Lit
  // through the foam illuminant so it stays neutral under an amber key.
  col = mix(col, mix(uShallow, uFoam, 0.62) * wFoamLight(shadow) * 0.72,
            smoothstep(0.0, 0.55, wet));

  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
