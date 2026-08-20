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
  alpha = max(alpha, wetT * 0.66);
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

  // The ramp reaches further than it did. A shelf that darkens to full depth
  // colour inside four metres gives a lake two states — rim and body — and the
  // reference reads its water as a continuous gradient from a pale, almost
  // sandy edge into the deep. Six metres is roughly the depth at which the bed
  // stops contributing anything.
  // Painterly value structure: broad, slow, low-frequency masses rather than a
  // single flat tint. Large areas of near-uniform colour with soft boundaries
  // is what makes the reference read as painted.
  float band = wFbm2(p * 0.012 + vec2(uTime * 0.006, 0.0)) * 0.5 + 0.5;
  // The depth ramp is a *contour generator*: it is a smooth function of a
  // heightfield, so wherever the bed flattens out it draws its own isoline on
  // the water. Measured on this lake, a shelf came back as flat pale islands
  // with a boundary you could trace — the same class of artifact as the gold
  // contour ribbons the terrain author had to break on land. Perturbing the
  // depth the ramp reads (not the depth anything else reads) with the broad
  // mass noise turns that boundary ragged for nothing.
  float deepT = smoothstep(0.0, 7.0, depth + (band - 0.5) * 2.2);
  // ...and the shallow anchor is not a paint colour. It is what you see when
  // you can see the bed, and the bed here is gold meadow. Taken literally as
  // '#9dc4d8' it drew every sandbar in the map as a flat pastel cyan island —
  // the Caribbean swimming pool the note on uSubsurface below already warns
  // about, arriving from the other side. Warmed toward the ground it covers,
  // a shelf reads as sand under water and the step against the deep water
  // beside it drops from two stops to under one.
  vec3 body = mix(mix(uShallow, uRefGround, 0.40), uDeep, deepT);
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
  vec3 lit = wTint(irr * bodyY, pow(absorb, vec3(absorbPow)), uAbsorb) * uBodyGain;

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
  // Streaked, not blobbed. The plate's bright masses are long marks lying along
  // the water, not isotropic patches — a rippled surface hands back sky in
  // *bands* because the roughness that does it is combed by the wind. Sampling
  // the mass anisotropically along the wind axis costs nothing and is most of
  // what makes this read as water rather than as mottling.
  vec2 sdir = normalize(uWind + vec2(1e-4, 1e-4));
  vec2 sperp = vec2(-sdir.y, sdir.x);
  vec2 sq = vec2(dot(p, sdir) * 0.0042, dot(p, sperp) * 0.019);
  float sheenMass = 0.14 + 0.86 * smoothstep(0.28, 0.72,
                    wFbm2(sq + vec2(uTime * 0.004, 0.0)) * 0.5 + 0.5);
  // Withdrawn in the shallows for the same reason the mirror is: a rim you can
  // see the bed through does not hand back a sheet of sky.
  float sheen = uSheen * sheenMass * smoothstep(0.10, 1.4, depth);
  float mirror = clamp(max(fres * 0.90, sheen), 0.0, 0.88)
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
  // The depth window the waterline lives in has to grow with the pixel. Fixed
  // at 1.5-36 cm it is sub-pixel on any bank more than a few dozen metres off,
  // so the lace vanishes exactly where it is most needed and the shoreline
  // resolves into a bare stair-stepped polygon edge — visible at 3x on any
  // mid-distance bank. A waterline is a couple of pixels wide at every range,
  // which is a statement about the footprint, not about depth.
  float laceScale = 1.0 + min(foot, 6.0) * 1.7;
  float laceD = smoothstep(0.015, 0.10 * laceScale, depth)
              * (1.0 - smoothstep(0.09 * laceScale, 0.36 * laceScale, depth));
  float laceW = 1.0 - smoothstep(0.8, 3.6, distShore);
  // The floor was rationed to 0.26 against a continuous white fringe reading as
  // pack ice. That was the right worry and the wrong number: plate 3 draws the
  // margin of its river as a *bright* cream ribbon several metres wide along
  // most of its length, and the shelves this map is made of put nearly every
  // shoreline in the game on the floor rather than at the peak.
  float lace = laceD * mix(0.42, 1.0, laceW);
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
  // The governor runs on the *body*, before the foam is laid over it. Foam is
  // near-neutral by construction, so a governor that treats neutral as a miss
  // would tint every whitecap in the game blue.
  col = wCoolGovern(col, absorb, uCoolGain);
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
