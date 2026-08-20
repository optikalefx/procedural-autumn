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
  float laceScale = 1.0 + min(foot, 6.0) * 1.7;
  float laceD = smoothstep(0.02, 0.14 * laceScale, depth)
              * (1.0 - smoothstep(0.12 * laceScale, 0.50 * laceScale, depth));
  float laceW = 1.0 - smoothstep(shoreBand * 0.8, shoreBand * 3.0, distShore);
  float lace = laceD * mix(0.35, 1.0, laceW) * smoothstep(0.18, 0.62, abs(vSide));
  // Scaled by the channel. On a 1.5 m brook the depth window the waterline
  // lives in is the whole creek, so the line on each bank meets in the middle
  // and the stream reads as a white cord lying on dry ground rather than as
  // water. A trickle gets a hint of a waterline; a river gets the full mark.
  lace *= 0.42 + 0.58 * smoothstep(1.5, 5.5, vWidth);
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
  // Same floor as the lake, and for the same measurement — see the sheen block
  // in LAKE_FRAG. Weaker here: a river is genuinely broken up and half aerated,
  // and its foam carries value the lake has to get from the sky. Withdrawn
  // inside foam and inside turbulence, where the surface is no longer a mirror
  // of anything.
  // Same widening as the lake — see the note there. A channel already has an
  // anisotropic frame to sample in (fp runs across and along the flow), so this
  // one only needed its range opening up.
  float sheenMass = 0.16 + 0.84 * smoothstep(0.28, 0.72,
                    wFbm2(fp * vec2(0.09, 0.02) - vec2(0.0, uTime * speed * 0.05)) * 0.5 + 0.5);
  float sheen = uSheen * 0.62 * sheenMass * (1.0 - foam * 0.9) * (1.0 - vTurb * 0.45);
  vec3 col = mix(lit, env, clamp(max(fres, sheen), 0.0, 0.42));

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
  col = wCoolGovern(col, absorb, uCoolGain);
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
