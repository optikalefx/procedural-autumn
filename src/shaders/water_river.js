// ─────────────────────────────────────────────────────────────────────────────
//  water_river — the swept-ribbon surface shader.
//
//  Split out of Water.js so the surface *look* and the surface *geometry* can
//  be worked on without two authors editing the same file. Water.js owns how
//  the ribbon is built and what attributes it carries; this file owns what the
//  pixels do with them. The attribute contract between them is the block of
//  `attribute` declarations below — change it on both sides or not at all.
// ─────────────────────────────────────────────────────────────────────────────
import { WATER_NOISE, WATER_ENV, WATER_FOAM_LIGHT } from './water_common.js';

export const RIVER_VERT = /* glsl */`
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

export const RIVER_FRAG = /* glsl */`
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
uniform float uSheen;
uniform float uWetBand;
uniform vec3  uCoolTint;
uniform float uCoolGain;
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
  // The band widens with the pixel so the bank is one soft pixel at any range
  // — but the widening has to be capped, and it was not. At four hundred
  // metres and a grazing angle a pixel spans eight metres of water, so the
  // fade ran over an eight-metre *depth* range and a metre-deep creek came
  // out at a tenth of an alpha. Every river in the valley then read as a pale
  // grey scar on the ground rather than as water, which is measurable in the
  // peaks view (water #8f7355 against #c57c40 for the land it lies on) and is
  // most of what makes distant water look like wet dirt.
  float shoreWide = 0.62 + min(foot, 3.0) * 0.55;
  // ...and the channel core does not take part in the shoreline fade at all.
  // Whether there is water in the middle of a river is not a question the
  // antialias band gets to answer.
  float core = 1.0 - smoothstep(0.35, 1.05, abs(vSide));
  float shoreFade = max(smoothstep(0.0, shoreWide, depth),
                        core * smoothstep(0.0, 0.14, depth));
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
  //
  // ...but the ceiling has to scale with the channel, and a flat 5 m did not.
  // A 3 m creek running 6 m above its bed has certainly left it; a 14 m river
  // in an incised gorge legitimately runs that deep, and so does every chute
  // immediately below a waterfall — which is where the recorded surface sits
  // highest above the bed. The fixed ceiling was therefore deleting the water
  // from exactly those reaches, leaving the bare tan channel bed running
  // parallel to the drop with nothing in it. That is the stray tan stripe
  // logged beside the falls, and the break at the foot of the column: the
  // water was not missing, it was being discarded. The guard still catches the
  // case it was written for, because a narrow ribbon keeps a low ceiling.
  float airLim = clamp(vWidth * 0.55, 5.0, 16.0);
  float airborne = 1.0 - smoothstep(airLim, airLim * 2.2, depth);
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
  // Widened with the pixel footprint, for the reason given in the lake shader.
  // Broken by a noise that rides downstream, so the line reads as painted marks
  // travelling with the current rather than a stencilled outline.
  //
  // ...and *scalloped*, which a smooth ramp cannot do. The old form ran a
  // 1.1 m fbm through smoothstep(0.34, 0.52) — a fine, soft, high-frequency
  // feather that thins the line evenly along its length instead of cutting it
  // into marks. Plate 3's waterline is a row of separate lobes two to four
  // metres long with hard shoulders between them, following the tufts of grass
  // it runs behind. That is a low frequency and a hard edge, which is what
  // wSteps is for: the noise is stretched to a real 0..1 first (raw fbm is a
  // bell that never leaves the middle third, so the quantiser would only ever
  // see one level), then cut into three.
  //
  // What it modulates is the band's *width*, not its opacity, and that is the
  // whole difference between a scallop and a fade. Multiplying a uniform band
  // by a mark mask gives a line that gets fainter and brighter along its length
  // — measured on the first pass at this, a continuous three-metre cream ribbon
  // on both banks with no gaps in it at all, which is the pack-ice failure the
  // lake shader already had to be rationed against. Driving the reach instead
  // makes the band bulge to a couple of metres at a mark and pinch to a
  // hairline between them, which is what the plate draws where the water runs
  // behind a tuft of grass and then out from under it.
  //
  // Band-limited on the footprint like every other detail term here: once a
  // step is smaller than a pixel 'wide' reaches 0.5 and wSteps degenerates
  // back to the linear ramp it was, so a far bank gets a continuous pale edge
  // and never a crawling dotted one.
  float laceN = smoothstep(0.34, 0.66,
                wFbm2(fp * vec2(0.30, 0.17) - vec2(0.0, uTime * speed * 0.22)) * 0.5 + 0.5);
  float laceWide = mix(0.10, 0.5, smoothstep(0.45, 2.2, foot));
  float scallop = wSteps(laceN, 3.0, laceWide);

  float laceScale = 1.0 + min(foot, 6.0) * 1.7;
  float laceD = smoothstep(0.02, 0.14 * laceScale, depth)
              * (1.0 - smoothstep(0.12 * laceScale, 0.50 * laceScale, depth));
  float laceW = 1.0 - smoothstep(shoreBand * 0.8, shoreBand * 3.0, distShore);
  // ...and depth on its own is why this has never been visible. The window it
  // opens is 2 cm to half a metre of *depth*, and on the incised banks the
  // carve actually produces that is two or three centimetres of ground — a
  // sub-pixel band at any range past arm's length, which is precisely the
  // "close to invisible" a critic measured. The pale band along the left bank
  // of shots/w-base/river.png reads at #443a3f against #33364a for the water
  // beside it: four levels out of 255, where plate 3 puts its waterline two
  // and a half stops *above* the body (#c3b2c3 at luma 0.72 against #2b5a8a
  // at 0.33) and makes it the brightest mass in the lower third of the frame.
  //
  // So the line gets a second placement, in metres of water rather than in
  // depth, and the two are unioned. They are complementary by construction:
  // on a steep bank the depth window is thin on screen and the metre skirt
  // carries the width, and on a flat shelf the metre skirt closes to nothing
  // while the depth window spreads — which is the case laceW already exists to
  // ration. Both are still anchored to depth, so neither can walk off the
  // alpha edge; the skirt keeps a depth gate of its own for the same reason.
  // Reach measured off the capture, not guessed. Plate 3 puts its waterline at
  // luma 0.72 against 0.33 for the body beside it, a factor of 2.18; the first
  // pass here landed at 0.543 against 0.244, a factor of 2.23 — so the *value*
  // was right first time and every remaining unit of the defect was coverage.
  // A base of 0.80 channel-fractions rather than 1.7, and the scallop swinging
  // it from a hairline to roughly twice that.
  float laceReach = max(shoreBand * 0.80, foot * 1.5) * (0.12 + 1.25 * scallop);
  float laceM = (1.0 - smoothstep(laceReach * 0.20, laceReach, distShore))
              * smoothstep(0.015, 0.05 + 0.09 * laceScale, depth);
  float lace = max(laceD * mix(0.35, 1.0, laceW) * (0.20 + 0.80 * scallop), laceM)
             * smoothstep(0.18, 0.62, abs(vSide));
  // Scaled by the channel. On a 1.5 m brook the depth window the waterline
  // lives in is the whole creek, so the line on each bank meets in the middle
  // and the stream reads as a white cord lying on dry ground rather than as
  // water. A trickle gets a hint of a waterline; a river gets the full mark.
  lace *= 0.42 + 0.58 * smoothstep(1.5, 5.5, vWidth);
  foam = max(foam, lace * (0.78 + 0.22 * vFlow));
  foam = clamp(foam, 0.0, 1.0);

  // ── colour ───────────────────────────────────────────────────────────────
  // One low-frequency mass field, stepped, and everything painterly below is
  // driven off it.
  //
  // Measured, the whole defect in one pair of numbers: plate 3's river spans
  // luma 0.29 (deep body) to 0.61 (a pale shelf) to 0.72 (the waterline) in
  // *flat masses with soft boundaries you can trace*. The same box on
  // shots/w-base/river.png spans 0.184 to 0.232 — five percent of a stop, one
  // paint-bucket fill. The old form had three separate smooth ramps trying to
  // supply that (band, lanes, sheenMass), all of them soft and two of them at
  // frequencies that put less than one feature across a channel, so their sum
  // was an average and never a mass.
  //
  // One field instead, because in the plate a pale patch is pale in its *body*
  // and bright in its *reflection* at the same time — a stretch of rougher,
  // shallower water is one physical thing, not two coincidences. Two
  // independent stepped fields multiply into a dozen levels and come back as
  // mottling. Frequencies are in metres of flow space: ~5 m across the channel
  // so a 12 m river carries two or three masses side by side, ~33 m along it
  // so they read as lanes rather than as blobs.
  float massRaw = wFbm2(fp * vec2(0.19, 0.030) - vec2(0.0, uTime * speed * 0.07)) * 0.5 + 0.5;
  float massWide = mix(0.13, 0.5, smoothstep(0.7, 3.0, foot));
  float mass = wSteps(smoothstep(0.26, 0.74, massRaw), 3.0, massWide);
  // The depth ramp is a contour generator — see the note in the lake, it is a
  // real trap and this is the same fix, kept: a smooth function of the bed
  // draws the bed's own isolines on the water wherever it flattens. Stepping
  // it makes three times as many boundaries to draw, so the perturbation goes
  // in *before* the quantiser and is worth more amplitude than the lake's.
  // What comes out is what the plate does with a shelf: a flat pale mass with
  // a ragged soft edge, not a gradient.
  float deepT = wSteps(smoothstep(0.15, 2.2, depth + (massRaw - 0.5) * 1.3), 3.0, massWide);
  vec3 body = mix(uShallow, uDeep, deepT);
  // The margins of a channel are always paler than its core, whatever the bed
  // happens to be doing — the water is thinner there and half full of air.
  // Driving it off the channel profile rather than off the sampled bed keeps
  // the read legible on the many reaches where the bed is nearly flat.
  // Ragged, though. A fixed 0.55 off a smooth profile ramp is a symmetric
  // gradient toward both banks, which is the "smooth offset outline" the brief
  // names as the thing the plate is emphatically not doing.
  body = mix(body, uShallow * 1.06,
             smoothstep(0.40, 1.20, abs(vSide)) * (0.26 + 0.48 * mass));
  // Broad soft bands riding downstream. This is the painted-water read in the
  // reference: the surface is never one flat tint, it is lanes of slightly
  // different value drifting with the current.
  float lanes = wFbm2(fp * vec2(1.30, 0.09) - vec2(0.0, uTime * speed * 0.30)) * 0.5 + 0.5;
  // Stretched to a real 0..1 first. Raw fbm is a bell that rarely leaves the
  // middle third, so used directly these lanes moved the surface by about a
  // seventh of a stop — under the tone curve, a satin ribbon with no current
  // in it. The same correction the falling sheet needed.
  //
  // 'lanes' is 0.8 m across the channel and was the one detail term in this
  // shader with no band-limit on it at all — at forty metres that is well
  // inside a pixel and it was contributing a third of a stop of undersampled
  // noise. Faded on the footprint like the ripples above it.
  body *= 0.62 + 0.46 * mass
        + 0.28 * smoothstep(0.34, 0.66, lanes) * (1.0 - smoothstep(0.35, 1.20, foot));
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
  // Hoisted: the cool governor at the bottom of the shader has to be handed
  // the same deepened hue this line tints with, or the two disagree about
  // what colour the water is. See wCoolGovern.
  vec3 absorbDeep = pow(absorb, vec3(uAbsorbPow));
  vec3 lit = wTint(irr * bodyY, absorbDeep, uAbsorb) * uBodyGain;

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
  // How much of the cone reaches past the bank, decided by the roughness mass.
  //
  // This is where the flat river actually came from, and it took a capture to
  // see it. A ribbon is looked at from its own bank at a grazing angle, so the
  // mirror direction points into the opposite bank over the *whole* visible
  // surface and the march returns hillside for every pixel of it. That
  // hillside is deliberately dark — wDesat 0.55 then times 0.58, argued at
  // length in wEnvReflect and correct — so env and lit end up within a few
  // percent of each other in value, and mixing between them by any amount at
  // all changes nothing. Measured on the previous capture: the body spanned
  // luma 0.180 to 0.262 across the whole channel with the mass field switched
  // on and stepped, against 0.29 to 0.61 in plate 3. The masses were being
  // computed and then mixed between two identical colours.
  //
  // A rough patch reflects a wider cone than a glassy one, and the top of that
  // cone clears the ridge line while the bottom of it does not. So roughness
  // decides how much sky is in the answer, which restores the range and is the
  // same physical fact the sheen floor above is already built on. It is also
  // what the plate draws: pale sheets lying between darker smears of reflected
  // bank, in flat masses, at better than a stop apart.
  float reach = marchOn * (0.30 + 0.70 * (1.0 - mass));
  vec3 envRaw = wSkyTilt(R);
  if (reach > 0.01) envRaw = mix(envRaw, wEnvReflect(vWPos, R), reach);
  // Rotated a fraction toward the channel's own hue, never multiplied by it: a
  // river has to pick up a dawn sky the same way the bank beside it does.
  vec3 env = wTint(envRaw, absorb, uEnvTint + 0.10);
  // Same floor as the lake, and for the same measurement — see the sheen block
  // in LAKE_FRAG. Weaker here: a river is genuinely broken up and half aerated,
  // and its foam carries value the lake has to get from the sky. Withdrawn
  // inside foam and inside turbulence, where the surface is no longer a mirror
  // of anything.
  // Same widening as the lake — see the note there. A channel already has an
  // anisotropic frame to sample in (fp runs across and along the flow), so this
  // one only needed its range opening up.
  // ...and it needed a frequency it could actually be seen at. At
  // fp * vec2(0.09, 0.02) the features were eleven metres across the channel
  // and fifty along, so on any river this map makes there was rather less than
  // one of them across the water and the term contributed a single slowly
  // drifting level — the mass that was supposed to carry most of the value
  // range delivered a flat tint. It comes off the shared 'mass' field now, at
  // a frequency chosen so a channel holds two or three of them, and stepped,
  // so the boundary between "this lane hands back sky" and "this one does not"
  // is an edge rather than a fade. That edge, not the average, is the read.
  float sheenMass = 0.10 + 0.90 * mass;
  float sheen = uSheen * 0.62 * sheenMass * (1.0 - foam * 0.9) * (1.0 - vTurb * 0.45);
  // ...and the mass has to reach the Fresnel term as well, or in the framing
  // this shader is actually judged in it does nothing at all. MEASURED on the
  // river capture: the view sits six metres above a channel forty metres out,
  // dot(N,V) is small over the whole visible surface, and fres runs into the
  // 0.42 ceiling everywhere. max(fres, sheen) is then 0.42 everywhere too and
  // the sheen mass — the term carrying most of the intended value range — was
  // masked out of the frame entirely. That is why the first capture came back
  // with the lace fixed and the body still one flat tint.
  //
  // The mass is a roughness field, so scaling the Fresnel sheet by it is the
  // honest reading rather than a second dial: a combed, wind-roughened lane
  // scatters the grazing reflection and hands back less of it than the glassy
  // lane beside it, which is exactly the flat pale-and-dark banding plate 3
  // draws across its river.
  float mirror = clamp(max(fres * (0.34 + 0.66 * mass), sheen), 0.0, 0.42);
  vec3 col = mix(lit, env, mirror);

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
  // Before the foam, for the reason given in the lake shader.
  //
  // In proportion to how much of this pixel is *body*, which is the only thing
  // the governor has an opinion about. A reflection is the sky's colour, not
  // the water's — wEnvReflect argues that at length — so rotating a pale
  // sheen lane toward the body hue would repaint it as bright saturated blue,
  // and the plate's pale masses are the opposite of that: it draws its shelves
  // near-neutral (#9c98ad, cool 0.31) beside a deep body at cool 2.38, and it
  // is that saturation *split* rather than an average chroma that reads as
  // water. Depth gates it the same way and for the same reason — a rim you can
  // see the bed through is not the water this floor is describing.
  col = wCoolGovern(col, absorbDeep,
                    uCoolGain * (1.0 - mirror * 1.15) * smoothstep(0.10, 1.20, depth));
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
