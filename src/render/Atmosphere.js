// ─────────────────────────────────────────────────────────────────────────────
//  Atmosphere — physically-motivated aerial perspective.
//
//  Three's built-in fog is a flat exponential: it fogs a mountain peak and the
//  valley floor identically, which is exactly what makes stylised scenes read
//  as "washed out" instead of "deep". This replaces the fog chunks globally so
//  every material — terrain, trees, rock, water, the camper — shares one
//  atmosphere with:
//
//    · height falloff        haze pools in the valleys, thins over ridges
//    · analytic integration  correct optical depth along a slanted ray
//    · chroma falloff        distance eats saturation faster than it eats
//                            contrast — this is what separates ridgelines into
//                            clean layers instead of one flat wash
//    · Mie inscattering      looking toward the sun brightens the haze
//    · two-tone extinction   warm near, cool far, like real Rayleigh/Mie split
//    · cloud shadow          one tap of a tiling coverage map, projected along
//                            the sun. Lives here because the fog chunk is the
//                            one hook that reaches every material in the game
//                            without editing anyone else's shader.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { PALETTE } from '../world/WorldConfig.js';
import { injectUniforms, verifyUniforms, captureShader } from './uniformPatch.js';
import { SKY_STATE } from './Lighting.js';
import { MassifShadow, neutralMassifMap } from './MassifShadow.js';

const FOG_PARS = /* glsl */`
#ifdef USE_FOG
  uniform vec3  fogColor;          // near / ground haze colour
  uniform vec3  uFogFarColor;      // distant colour (cooler, bluer)
  uniform vec3  uFogSunColor;      // inscattered sunlight
  uniform vec3  uFogSunDir;        // sun, for the cloud-shadow column walk
  uniform vec3  uFogScatterDir;    // what the Mie lobe points at — see update()
  uniform float uFogDensity;       // extinction at base height, per metre
  uniform float uFogHeightFalloff; // 1 / scale-height
  uniform float uFogBaseHeight;
  uniform float uFogInscatter;     // Mie strength toward the sun
  uniform float uFogInscatterMax;
  uniform float uFogAnisotropy;    // Henyey–Greenstein g
  uniform float uFogFarStart;
  uniform float uFogOnset;         // clear distance before haze accumulates
  uniform float uFogMax;
  uniform float uFogDesat;         // how much chroma distance eats
  uniform sampler2D uCloudMap;
  uniform float uCloudShadow;      // 0 = off
  uniform float uCloudScale;       // world metres -> uv
  uniform float uCloudAltitude;
  uniform vec2  uCloudOffset;
  uniform vec3  uCloudShadowTint; // per-channel gain inside the shadow
  uniform float uCloudSoftLo;     // coverage where the shadow starts
  uniform float uCloudSoftHi;     // coverage where it reaches full strength
  uniform float uCloudScale2;     // second tap's scale, relative to the first
  uniform sampler2D uMassifMap;   // world-space terrain sun-visibility field
  uniform float uMassifShadow;    // 0 = off
  uniform float uMassifScale;     // 1 / worldSize
  uniform float uSunShadeNorm;    // 1 / sun.shadow.intensity
  uniform float uSunShadeWarm;    // hue push inside the sun's own cast shadow
  uniform float uSunShadeDeep;    // extra absorption inside it
  uniform vec3  uSunShadeMul;     // the hue axis, as a multiplier at w = 1
  varying vec3  vFogWorldPos;
  varying vec3  vFogCamPos;
#endif

// gSunShadow is Stylize's capture of the sun's shadow factor out of
// lights_fragment_begin, declared in <common>. Guarded exactly as Stylize
// guards it, and for the same reason: a custom ShaderMaterial that opts into
// the fog chunks without including <common> would fail to link without it, and
// one that includes both would redeclare it. Whichever chunk the preprocessor
// reaches first wins and the other is skipped, in either order.
#ifndef STYLIZE_SUN_SHADOW
#define STYLIZE_SUN_SHADOW
float gSunShadow = 1.0;
#endif`;

const FOG_VERT_PARS = /* glsl */`
#ifdef USE_FOG
  varying vec3 vFogWorldPos;
  varying vec3 vFogCamPos;
#endif`;

const FOG_VERT = /* glsl */`
#ifdef USE_FOG
  {
    // Must apply the instance and batch transforms, exactly as three's own
    // <worldpos_vertex> does.
    //
    // Without this every InstancedMesh in the game — rocks, trees, grass,
    // ground cover, wildlife; i.e. most of what you look at — is hazed as if
    // it stood at the world origin, because the transformed position is still in the
    // instance's local space here. With the camera hundreds of metres from
    // origin that pins them at the uFogMax cap regardless of where they
    // actually are. It cost the rocks author three passes: they measured that
    // halving their material's entire output moved the rendered pixel by 1.8%,
    // because fog was supplying 172 of 179 levels.
    vec4 fogWorld = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
      fogWorld = batchingMatrix * fogWorld;
    #endif
    #ifdef USE_INSTANCING
      fogWorld = instanceMatrix * fogWorld;
    #endif
    vFogWorldPos = ( modelMatrix * fogWorld ).xyz;
    vFogCamPos = cameraPosition;
  }
#endif`;

const FOG_FRAG = /* glsl */`
#ifdef USE_FOG
{
  vec3 toFrag = vFogWorldPos - vFogCamPos;
  float dist = length(toFrag);
  vec3 dir = dist > 1e-4 ? toFrag / dist : vec3(0.0, 1.0, 0.0);

  // ── analytic height-fog optical depth ───────────────────────────────────
  // rho(y) = D * exp(-k * (y - baseY));  integrate along the ray.
  float k  = uFogHeightFalloff;
  float y0 = vFogCamPos.y - uFogBaseHeight;
  float dy = toFrag.y;
  float baseDensity = uFogDensity * exp(-k * y0);
  // Optical depth only starts accumulating past a clear near zone. There is no
  // such thing physically, but the reference's near field is emphatically
  // crisp — measured band by band down plate 1, its foreground holds chroma
  // 0.40 while its far ridges sit at 0.13 — and a plain exponential from zero
  // takes the saturated near plane that the whole look rests on with it.
  float hazeDist = max(dist - uFogOnset, 0.0);
  float integral;
  if (abs(dy) < 1e-3) {
    integral = baseDensity * hazeDist;
  } else {
    integral = baseDensity * hazeDist * (1.0 - exp(-k * dy)) / (k * dy);
  }
  integral = max(integral, 0.0);
  float fogFactor = 1.0 - exp(-integral);

  // ── cloud shadow ────────────────────────────────────────────────────────
  // Walk from the surface up the sun ray to cloud altitude and sample the
  // same coverage field the cloud dome marches. One tap, no extra passes.
  //
  // Applied *after* the optical depth is known, and faded out by it. A cloud
  // shadow two kilometres away is behind two kilometres of haze and cannot be
  // seen through it; drawing it there anyway is how the coverage map ended up
  // stencilled across the far massif in the drive frame as a repeating
  // lozenge hatch. The projection is a vertical column walk, so on a
  // near-vertical mountain face it smears the tile into stripes and the
  // repeat becomes legible as a texture — the one thing this term must never
  // read as. Near ground, where the shadow belongs and where the projection
  // is nearly flat, fogFactor is ~0 and the term is untouched.
  float cloudFade = clamp(1.0 - fogFactor * 1.6, 0.0, 1.0);
  float mShade = 0.0;
  // The massif mask kept as a 0..1 geometric term as well as an absorption, so
  // the hue rotation at the bottom of this block can treat it as what it is:
  // the same physical event as the sun's own cast shadow, arriving from a
  // caster the shadow camera cannot hold. The cloud mask is deliberately NOT
  // folded in there - it is a different occluder with its own authored tint,
  // and at the river view it covers the whole frame.
  float gMassif = 0.0;
  if (uCloudShadow * cloudFade > 0.001) {
    float sy = max(uFogSunDir.y, 0.16);
    float climb = clamp((uCloudAltitude - vFogWorldPos.y) / sy, 0.0, 4200.0);
    vec2 cuv = (vFogWorldPos.xz + uFogSunDir.xz * climb) * uCloudScale + uCloudOffset;
    // TWO TAPS, UNIONED — see the cloudScale2 note in DEFAULTS. The baked
    // silhouette covers about a sixth of the world, which at eye level means
    // the ground has no shadow in it far more often than it has one. A second
    // tap of the same map at a different scale and phase raises that to about a
    // third and, because max() of two soft fields is a soft field, it makes the
    // patches bigger and less regular rather than more numerous.
    vec2 cuv2 = mat2(0.8, 0.6, -0.6, 0.8) * cuv * uCloudScale2 + vec2(0.421, 0.137);
    float cov = max(texture2D(uCloudMap, cuv).r, texture2D(uCloudMap, cuv2).r);
    // Soft, wide edges: a hard-edged cloud shadow at this scale reads as a
    // texture crawling over the ground rather than as weather.
    mShade = uCloudShadow * cloudFade * smoothstep(uCloudSoftLo, uCloudSoftHi, cov);
  }

  // ── massif shadow ───────────────────────────────────────────────────────
  // A world-space field of terrain sun-visibility, built on the CPU by
  // MassifShadow.js and gated there to occluders BEYOND the sun shadow
  // camera's own reach — so this only draws the valley-crossing mass that the
  // 150-200 m eye-level shadow extent structurally cannot contain, and never
  // re-darkens a contact shadow the shadow map already drew. Faded by optical
  // depth on the same argument as the cloud term above: a mass two kilometres
  // out is behind two kilometres of haze.
  if (uMassifShadow * cloudFade > 0.001) {
    vec2 muv = vFogWorldPos.xz * uMassifScale + 0.5;
    // Outside the heightfield there is no terrain to be shadowed by, and the
    // clamped sampler would otherwise smear the border texel across the sky.
    vec2 edge = step(vec2(0.0), muv) * step(muv, vec2(1.0));
    gMassif = texture2D(uMassifMap, muv).r * edge.x * edge.y * cloudFade;
    float mMassif = uMassifShadow * gMassif;
    // UNIONED, not added. Two large soft masses multiplied together is how a
    // shadow becomes a hole, and X2 is explicit that this must not raise
    // contrast. max() keeps the deepest single mass and no more.
    mShade = max(mShade, mMassif);
  }

  // -- the sun's OWN cast shadow, reached from here -------------------------
  // The lead a predecessor left when a usage limit killed them: the fog chunk
  // is the one hook that lands after every material has finished shading, so it
  // is the only place a cast shadow can be given a hue that survives to the
  // final pixel. L3 is why that matters - stylizeShadowCool() runs at
  // lights_fragment_end and grass then adds translucency, sky fill, wrapped
  // diffuse and sheen on top of it in its own tonemapping hook, so on an
  // eye-level meadow the tint reaches a minority of the pixel. Measured there:
  // re-authoring shadowCool warm moved ground rects inside a cast shadow by
  // srgb(180,143,65) -> srgb(177,144,63). Nothing.
  //
  // And it costs no texture fetch. Stylize already patches
  // lights_fragment_begin to stash the shadow factor in gSunShadow, so the
  // value is in a register by the time this runs. Sampling the shadow map a
  // second time here would have been a full PCF_SOFT kernel on every fogged
  // fragment in the game.
  //
  // This is where the AREA is. X2's diagnosis, measured tile against tile, is
  // that round 040's mass was not larger than today's cast shadows - it was the
  // same shapes in a different HUE. These are those shapes.
  float sunShade = clamp((1.0 - gSunShadow) * uSunShadeNorm, 0.0, 1.0) * cloudFade;

  // Blue-led pixels are exempt from the hue treatment entirely. Recorded as L5
  // and in X6-reply: a blue cut on a gold pixel is a warm deepening, and the
  // same cut on a blue-led pixel is a hue change - it is what took the river
  // pool to murky olive when the tint was deepened toward its target, and it is
  // why X6 declined to spend the tint at all. Ground is R > G > B at every hour
  // of the cycle (the table beside cloudShadowTint), so this cannot fire on the
  // surface the tint is authored for. It fires on water.
  float chMax = max(gl_FragColor.r, gl_FragColor.g);
  float blueLed = smoothstep(0.0, 0.25, (gl_FragColor.b - chMax) / max(gl_FragColor.b, 1e-4));

  // Unioned into the same mask, so a pixel that is both cloud-shadowed and
  // sun-shadowed pays once and not twice.
  mShade = max(mShade, uSunShadeDeep * sunShade);

  if (mShade > 0.0) {
    // Per-channel absorption, not a grey multiply. uCloudShadowTint is how much
    // of 'mShade' each channel pays; vec3(1.0) is the old neutral darkening.
    // Biasing it toward blue takes the shadowed gold meadow to a deeper
    // amber-brown instead of a darker grey-gold, which is the hue the player
    // asked for and the hue plates 2 and 3 actually put under their big ground
    // masses. The triple is authored at luma 1.0 so hue and depth stay
    // independent knobs.
    vec3 absorb = mix(uCloudShadowTint, vec3(1.0), blueLed);
    gl_FragColor.rgb *= max(vec3(0.0), vec3(1.0) - mShade * absorb);
  }

  // The hue rotation, on its OWN axis, and the axis was found by measurement
  // rather than taken from the critic's numbers - which do not transfer here.
  //
  // Measured on the drive view in one boot, shadow.intensity forced to 0 and
  // then back to ship, over the near-field ground the cast shadow moves (21% of
  // the frame), all in DISPLAY space:
  //
  //                          luma vs lit   green vs red   blue vs red
  //     shipping                 0.650        -3.9%          -3.0%
  //     critic's plate target    0.640         held          -17%
  //     +green axis, w = 1.6     0.689        +5.2%          -0.1%
  //     -green axis, w = 0.8     0.636       -14.5%          -4.1%
  //
  // Two things fell out of that and both are worth the space.
  //
  // FIRST: THE BLUE HALF OF THE TARGET IS UNREACHABLE FROM A MULTIPLY HERE.
  // A 22% linear cut on blue moved the rendered blue by nothing - it sits at
  // 36 to 38 in every row above. Shadowed gold's blue is already down at the
  // grade's floor, where a multiply is swamped by the lift applied after it.
  // That is very likely why every attempt to move this hue by scaling blue,
  // from Stylize's cool tint onward, has measured as almost nothing. Anyone
  // quoting the -17% target should know it cannot be bought this way.
  //
  // SECOND: HOLDING GREEN, WHICH IS THE CRITIC'S OTHER AXIS, GOES THE WRONG WAY
  // ON OUR GROUND. Row three is that target met almost exactly, and the
  // shadowed meadow arrives olive - a step toward the grey the player's
  // constraint forbids - because on gold, lifting green against red is a move
  // toward yellow-green. Their plate's shadow is a different pigment from ours
  // and the ratio does not carry across.
  //
  // What does work is the opposite: take green DOWN against red, and a shadowed
  // gold meadow goes to srgb(117,78,38), a warm russet brown, against lit
  // srgb(164,128,56). That is hue separation on the axis gold actually has, it
  // is the player's own words for what they asked for, and it cannot approach
  // grey or mauve or rose from any direction because every step is toward red.
  // Luma goes 0.650 to 0.636, so it lands on the critic's depth target without
  // having been aimed at it, and X2's instruction not to deepen is respected to
  // within one and a half percent.
  if (uSunShadeWarm > 0.0) {
    float w = uSunShadeWarm * max(sunShade, gMassif) * (1.0 - blueLed);
    gl_FragColor.rgb *= mix(vec3(1.0), uSunShadeMul, w);
  }

  // ── Mie inscattering: the haze glows around the light ───────────────────
  // uFogScatterDir, not uFogSunDir. They are the same vector all day; after
  // sunset the sun is under the horizon and the only thing in the sky bright
  // enough to build a forward-scatter lobe out of is the moon, so this swings
  // to it as it rises. Pointed at a buried sun instead, the term put its lobe
  // *below* the ground for a third of the cycle, which is not a glow anywhere.
  // The cloud-shadow column walk above keeps the real sun: it is a projection
  // of a shadow, not a scatter.
  float cosT = dot(dir, uFogScatterDir);
  float g = uFogAnisotropy;
  float hg = (1.0 - g * g) / (4.0 * 3.14159265 * pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-4), 1.5));

  // ── colour ──────────────────────────────────────────────────────────────
  float farMix = smoothstep(uFogFarStart, uFogFarStart * 5.0, dist);
  vec3 hazeCol = mix(fogColor, uFogFarColor, farMix);
  hazeCol = mix(hazeCol, uFogSunColor, clamp(hg * uFogInscatter, 0.0, uFogInscatterMax));

  // Chroma goes before value does — that is what makes 400 m, 900 m and
  // 1500 m read as three distinct planes rather than one wash.
  //
  // But it must bleed toward the haze *hue*, not toward grey. Mixing to
  // vec3(lum) drove every distant surface neutral; measured, the far field
  // fell to chromaMean 0.21 against a reference band of 0.28–0.42, and the
  // reference's own distant ridges are emphatically not grey — they are pale
  // pink and lavender. Re-tinting at the pixel's own luminance removes the
  // local colour identity (which is the real aerial-perspective cue) while
  // keeping both the value structure and a chromatic frame.
  float lum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float hazeLum = max(dot(hazeCol, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeCol * (lum / hazeLum),
                         clamp(uFogDesat * fogFactor, 0.0, 1.0));

  gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeCol, clamp(fogFactor, 0.0, uFogMax));
}
#endif`;

// A 4×4 mid-grey map so the cloud-shadow tap is never a null sampler for
// materials cloned before Clouds finishes building the real one.
function neutralCloudMap() {
  const d = new Uint8Array(4 * 4 * 4).fill(0);
  const t = new THREE.DataTexture(d, 4, 4, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

const DEFAULTS = {
  density: 0.0015,
  // ~180 m scale height. This is the single number that makes ridgelines
  // separate into layers, and it was previously set 2.7x too gentle on the
  // argument that raising it scales the whole vista frame down. It does — and
  // that is a *global* term you compensate with `density`, not a reason to
  // flatten the altitude profile that carries the whole depth cue.
  //
  // What layering actually needs is that a ridge *crest* and the valley floor
  // *below it*, at the same distance, receive different optical depth. Worked
  // out for the `hero` camera (367 m over the vista anchor) at 3 km:
  //
  //   k = 0.0020   crest at 350 m: fogFactor 0.88   valley at 40 m: 0.90
  //   k = 0.0055   crest at 350 m: fogFactor 0.49   valley at 40 m: 0.84
  //
  // The first is one flat cream wash — which is exactly what `hero` and `dawn`
  // measured (contrastStd 0.107 against a reference band of 0.13–0.22). The
  // second is the reference: crests standing clear of mist that pools in the
  // valleys, each successive ridge a little paler than the one in front.
  //
  // Eye-level frames are unaffected: with baseHeight at 20 m a driving camera
  // sits within a few metres of the base of the profile either way.
  heightFalloff: 0.0055,
  baseHeight: 20.0,
  inscatter: 1.35,
  // Capped lower than it was: at 0.62 a sun-facing vista pulled two thirds of
  // the haze toward the (bright) sun colour, which lifted the whole middle
  // distance to sky value and erased the horizon line.
  inscatterMax: 0.45,
  anisotropy: 0.60,
  // The near->far haze colour crossfade runs from farStart to farStart*5, so
  // this also sets how deep the frame is before the haze stops changing hue.
  // At 300 it finished at 1.5 km, and everything beyond that was one colour at
  // one density — the flat pale band that filled the middle third of `hero`.
  farStart: 400.0,
  // ── THE CLEAR NEAR ZONE IS THE VISTA BLACK POINT, NOT THE DENSITY ────────
  //
  // 260, up from 130, and this is critic blocker 10 ("the vistas are washed").
  // A predecessor established that the grade's toe and lift move `hero` P05 by
  // 0.004 across a 3.5x sweep and correctly concluded that the haze owns the
  // vista darks — but then reached for `FOG_DENSITY_SCALE`, which is a *global*
  // multiplier: it buys the black point by taking the far-field dissolve away
  // with it, which is why that sweep stopped at 0.42 with the frames still
  // washed. This knob buys the same thing selectively, because it subtracts a
  // constant from the path length: at 300 m it cuts the optical depth by 3.4x
  // and at 2.5 km by 5%.
  //
  // Swept in one boot against onset alone and onset with `desat`, cloud shadow
  // frozen (shots/look/haze/):
  //
  //            hero P05  range  std    peaks P05  range  std    drive P05 chroma
  //   130       0.377    0.447  0.145   0.423     0.419  0.132   0.287    0.364
  //   260       0.345    0.479  0.156   0.376     0.467  0.148   0.284    0.364
  //   380       0.313    0.511  0.167   0.336     0.506  0.161   0.286    0.366
  //   plate 1   0.157    0.710  0.219   (vistas are judged against plate 1)
  //
  // and the eye-level column is the reason this is the right knob rather than
  // density: `drive` does not move at all, because its whole subject is inside
  // the clear zone either way. Nothing else in the chain separates the two
  // framings like that.
  //
  // Taken to 260 and not to 380, on a blind A/B that went 1-1 rather than 2-0:
  // at 380 with a strong chroma falloff `hero` won and `peaks` lost, because
  // `peaks` is mostly middle distance and stripping both the haze and the
  // chroma there leaves its far ridges as pale grey cut-outs with no hue of
  // their own. At 260 the same blind pairing picked the new frame on every
  // view. The remaining distance to plate 1's 0.157 is partly composition —
  // plate 1 has a wall of near-black conifer across its foreground and our
  // vista anchors do not — and chasing the rest of it here would cost the
  // aerial perspective the brief names as the depth cue.
  onset: 260.0,
  // Never a perfect wash, and the exact number decides how many planes the far
  // field can show. Anything that reaches the cap renders identically to
  // everything else at the cap, so a high cap collapses every distant ridge
  // into one silhouette-free field — which is what filled the middle third of
  // the hero frame. At 0.76 a ridge keeps a quarter of its own value and
  // shading, and successive ridges separate again.
  max: 0.76,
  // High on purpose. Now that this bleeds toward the haze *hue* rather than
  // toward grey it cannot neutralise the frame, and the reference wants it
  // strong: its distant ridges measure chroma 0.13–0.26 against a foreground
  // meadow at 0.60. Chroma is the depth cue; value barely moves.
  // 1.35, up from 0.85, and it is the *rose* half of critic blocker 4 rather
  // than a depth change. The distance ramp crossfades a warm haze (hue ~28 deg)
  // over lavender-grey rock (hue ~250 deg), and the straight line between those
  // two hues passes through magenta — so at intermediate fog factors the middle
  // distance arrives pink, which is exactly "the cool half is arriving as candy
  // pink in the distance". Raising this makes the pixel adopt the haze hue
  // *earlier* in the ramp, so it spends less of the frame inside the crossing.
  // Measured on the same boot as `onset` above, as a share of chromatic pixels:
  //
  //                      hero rose+mgnt   peaks   dawn    hero chroma
  //   onset 260, 0.85        7.1%          4.3%    6.8%      0.253
  //   onset 260, 1.35        3.9%          1.2%    3.2%      0.255
  //   onset 380, 1.35        7.7%          6.9%    7.3%      0.249
  //   onset 380, 1.80        5.5%          2.3%    4.7%      0.251
  //   plate 1                0.1%
  //
  // It costs nothing measurable in chroma or in the black point — it is a
  // re-tint at the pixel's own luminance, not a desaturation, which is what the
  // note above this one is about. Held at 1.35 rather than 1.80 for the reason
  // recorded beside `onset`: past this the far ridges stop having a hue of
  // their own and `peaks` loses a blind A/B on it.
  desat: 1.35,
  cloudShadow: 0.0,
  cloudScale: 1 / 2600,
  cloudAltitude: 900.0,
  // ── THE LARGE SOFT WARM GROUND MASS (docs/INTEGRATION_REQUESTS.md X2) ─────
  //
  // Rounds 035-040 had a broad soft mass sweeping across the meadow in the
  // `drive` frame; 048 had none, and the blind A/B lost 8-18 to its own history
  // largely on that. Two literal readings of two legitimate player notes took
  // it out: Stylize.shadowCoolAmt 1.0 -> 0.30 (they asked for a warmer mass and
  // got no mass) and Clouds.COVER_BIAS 0.745 -> 0.950 (they asked for a calmer
  // sky and lost the ground patches with it). Neither is being reverted. The
  // mass comes back here, and the reason it has to come back *here* was
  // measured rather than assumed:
  //
  //   · The 035/040 mass was NOT bigger than today's cast shadows. Cropped and
  //     compared tile against tile, the shadow shapes on the meadow are the same
  //     shapes. What made them read was that they were a different HUE from the
  //     ground — royal blue at 035, mauve at 040. Today they are gold shadows on
  //     gold ground, so they read as texture and not as a shape.
  //   · Giving them a warm hue from Stylize does almost nothing, and this is
  //     worth recording because it is the obvious first move. Swept on `drive`
  //     with shadowCool re-authored warm (linear 1.42/0.92/0.36, srgb ratio
  //     1:0.82:0.55, a light brown) at amt 0.75 / lift 0.84 / keep 0.30, three
  //     ground rects inside a cast shadow moved srgb(180,143,65) ->
  //     srgb(177,144,63), srgb(166,132,58) -> srgb(166,133,57), srgb(184,144,64)
  //     -> srgb(186,147,65). That is nothing. stylizeShadowCool() runs at
  //     lights_fragment_end, and grass then ADDS its translucency, sky fill,
  //     wrapped diffuse and sheen on top of it in its tonemapping hook — so on
  //     an eye-level meadow, where most ground pixels are blades, the tint is
  //     applied to a minority of the final pixel. Ground cover and the tree
  //     canopy are the same story. That is the structural cap a predecessor
  //     recorded in Stylize and it is still real; it is filed as L3.
  //   · The sun's own shadow map cannot be widened either: it is 150-200 m of
  //     extent at eye level and the vehicle author proved (W1) that growing it
  //     deletes every contact shadow in the frame.
  //
  // The fog chunk is the one hook that reaches every material in the game --
  // terrain, grass, cover, canopy, rock, water -- after all of them have
  // finished shading. So the large mass is a cloud shadow, which is also what
  // the reference plates' large ground masses actually are.
  //
  // All of the knobs below are Atmosphere-side and multiply what Clouds hands
  // setCloudShadow(), so the cloud deck itself -- coverage, tile, strength --
  // is untouched and the calmer sky the player asked for stays exactly as it
  // is. Only its shadow on the ground changes.

  // Gain on the strength Clouds supplies. Clouds rewrites params.cloudShadow
  // every frame from its own sun-elevation ramp, so a constant here is the only
  // place a look author can scale the term without editing the sky.
  //
  // 0.85, and this is a REDUCTION in per-pixel depth, deliberately. Clouds
  // supplies 0.42 at full sun, so a fully shadowed pixel today is multiplied by
  // 0.58. The critic's target, measured off the one reference cast shadow that
  // falls on gold, is 0.64 of the lit luma. At this gain the shadowed meadow
  // lands at 0.645 (see the tint note for the arithmetic). The brief is
  // explicit that this change is about area and shape and must not raise
  // contrast; the area comes from cloudScale2 and cloudSoftHi below, and the
  // depth goes slightly the other way.
  //
  // ── HELD AT 0.85, AND THE TARGET IT MEETS IS A LINEAR ONE. FILED AS L5. ──
  //
  // The arithmetic above is correct and lands 0.645 of the lit LINEAR
  // luminance with blue 18% down. Both numbers match the critic's target
  // digit for digit, and that agreement is what makes the following worth
  // recording rather than quietly fixing: the critic's target was read off
  // sRGB plate pixels -- it quotes srgb(155,108,47) -- and this file's is
  // linear. They are not the same quantity.
  //
  // Measured rather than argued. Captured drive twice in one boot with the
  // coverage window forced fully open and then the term forced off
  // (tools/_scratch/x2sweep.mjs, variants full and none), which isolates this
  // term's transfer function in the final graded frame, and sampled three
  // ground rects:
  //
  //   at gain 0.85     display luma ratio   red:green      blue, relative
  //   rect g1                0.778          held -3.9%        -5.8%
  //   rect g3                0.775          held -4.9%        -5.0%
  //   rect g5                0.810          held +1.5%        -8.4%
  //   critic's target        0.640          held              -17%
  //
  // The mapping through the tonemap and grade fits display = linear^0.567
  // across this range, so linear 0.645 arrives on screen as 0.78 -- which is
  // the same 78% the critic separately measured and called the defect.
  //
  // NOT CHANGED HERE, deliberately, and this is the interesting part. The
  // setting that lands exactly on 0.64 on screen (gain 1.30, tint
  // 0.983/0.983/1.221) was captured, and the ground is right while the WATER
  // is not: with the window forced open the river pool goes from blue-grey to
  // a murky olive, because a 17% relative blue cut on gold is a warm deepening
  // and the same cut on an already blue-led pixel is a hue change. Deepening
  // this term is therefore not free, and it should not be spent until the
  // coverage below is a shadow rather than an exposure -- at which point the
  // depth needed on screen may be different again. Filed as L5.
  cloudShadowGain: 0.85,
  // Multiplier on the uv scale Clouds supplies (it passes 1/7000). Above 1 the
  // tile shrinks in world space and the patches get smaller and more frequent.
  //
  // 3.0, i.e. the patches get SMALLER, which is the opposite of the guess in the
  // request, and it was measured rather than argued (tools/_scratch/cloudframe.mjs
  // walks the 200 m ground fan an eye-level camera actually sees, at 600 world
  // positions, and bins the shadowed fraction):
  //
  //   mul   tile     no shadow   an edge in frame   whole frame shaded
  //   1.0   7000 m      76%            13%                12%
  //   2.2   3182 m      63%            18%                20%
  //   3.0   2333 m      60%            22%                18%
  //   5.5   1273 m      54%            36%                10%
  //
  // Coverage is a fixed fraction of the world, so patch size only trades
  // against how often a patch is near the eye. At 7000 m the features are
  // ~2.3 km across, which from a 4 m camera is either the whole visible meadow
  // or none of it. Not taken past 3.0: below a ~2 km tile the wrap starts to be
  // a thing you could learn while driving, and the fog-chunk note above this
  // block is right that a legible repeat is the one thing this term must never
  // become. The remaining 60% is the honest limit of a cloud silhouette and is
  // filed as L4 — the ground shadow is baked at the same threshold as the deck,
  // so the only way to raise coverage further without putting clouds back in
  // the sky is to bake it separately, which is Clouds' file and not this one.
  //
  // ── 5.5. THE TERM WAS AN EXPOSURE CUT, AND THE TABLE ABOVE SAYS WHY ──────
  //
  // A critic pass reported this term as "saturated: coverage >= 0.90 nearly
  // everywhere, so the window is pinned and the whole world is uniformly
  // darkened". That is half right, and the half that is wrong would have sent
  // the next author to the wrong file, so both halves are recorded.
  //
  // Reproduced with a per-view histogram of the raw two-tap coverage over the
  // ground fan each camera actually sees (tools/_scratch/x2sweep.mjs), binned
  // against the bake's own range where 0.38 is no cloud and 0.90 is solid:
  //
  //             <=.40  .40-.55  .55-.70  .70-.88  >.88    mask
  //   river        0       0        0      4.5    95.5    1.000
  //   vehicle    96.5     3.5       0        0       0    0.006
  //   drive      79.0    11.0     7.7      2.3       0    0.135
  //   meadow    100.0      0        0        0       0    0.000
  //
  // So the field is not saturated anywhere except at river, which is where the
  // critic measured it. It is BIMODAL PER VIEW: a camera is either deep inside
  // one patch or completely outside every patch. Note vehicle in particular --
  // the report has river and vehicle both sitting under this shadow, and
  // vehicle is 97% lit, so whatever ails that frame is not this term. Over the
  // whole tile the shipping window covers 21.1% (cloudmask.mjs), not ~100%.
  //
  // The cause is not the window and not the max() of the taps. It is that a
  // patch is far larger than a frame. The table above is the proof, read down
  // the MASS+EDGE column rather than the coverage one: at mul 3.0 only 6% of
  // world positions put a shadow EDGE in an eye-level frame, while 60% are
  // flat-lit and 18% are wholly shaded. A term that is all-or-nothing 78% of
  // the time is an exposure cut wearing a shadow's clothes, which is the
  // critic's conclusion reached from the other end.
  //
  // 5.5 is the best row available: flat 60 -> 54%, wholly shaded 18 -> 10%,
  // and MASS+EDGE 6 -> 10%. That is a strict improvement against the reported
  // defect on all three counts -- fewer frames dimmed as a whole, more frames
  // with an actual shape in them. The wrap worry that held it at 3.0 is real
  // but is about a single tap: the union of two decorrelated taps beats at a
  // much longer period than either, and at 1273 m nothing legible appears in
  // the drive or meadow frames.
  //
  // It is an improvement and not a fix, and the honest number is in the same
  // column: even at 5.5, 64% of positions still see no shape at all. A cloud
  // silhouette whose features are hundreds of metres across cannot reliably put
  // an edge inside a 200 m fan seen from a 4 m camera, at any scale -- push it
  // smaller and it stops reading as weather before it starts reading as shape.
  // The eye-level ground mass X2 asks for is not reachable from this term
  // alone. Filed as L6.
  cloudScaleMul: 5.5,
  // Scale of the second tap relative to the first, applied after a rotation so
  // the two taps are decorrelated rather than a resampling of the same blobs.
  // The union is what buys the area, and the area is X2's cleanest number:
  // shadow area in the ground region fell from 21.0% at round 040 to 10.9% now.
  // Measured over the tile (tools/_scratch/cloudmask.mjs):
  //
  //   one tap, ship window 0.38/0.90     9.3%
  //   one tap, window 0.38/0.62         14.2%
  //   two taps, window 0.38/0.90        14.7%
  //   two taps, window 0.38/0.62        21.1%   <- round 040
  //   three taps, window 0.38/0.62      29.9%
  //
  // Two taps and the narrower window land on 040 to within a tenth of a point.
  // The third tap is not taken: it costs a third texture fetch on every fogged
  // fragment in the game and overshoots the target.
  cloudScale2: 0.57,
  // Per-channel absorption inside the shadow, at luma 1.0 so it is a hue knob
  // and not a second depth knob. vec3(1,1,1) is the old neutral multiply.
  //
  // The player, of the mass this replaces: "adjust the colour of the 'gray'
  // ground ... it would be more cozy if that was a soft yellow or a light
  // brown". Two independent measurements say the same thing about HOW:
  //
  //   · plate 5's lit orange field is srgb(255,186,108), ratio 1:0.73:0.42, and
  //     the shadowed field under the birch is srgb(209,148,87), ratio 1:0.71:
  //     0.42 -- the same hue at 0.82x the value. Not a hue rotation.
  //   · the critic's measurement of plate 1's cast shadow on gold: 0.64 of the
  //     lit luma, red-to-green held (0.68 -> 0.70), BLUE down 17%. Ours pulled
  //     green and held blue, which is the axis that desaturates as it darkens
  //     and is exactly how a gold meadow arrives grey.
  //
  // So: hold red and green together, take the darkening out of blue. At the
  // shipping gain (m = 0.42 * 0.85 = 0.357) a fully shadowed pixel is
  // multiplied by (0.654, 0.654, 0.536): red-to-green held exactly, blue 18%
  // down on the other two, luma 0.645 of lit. That is the critic's target on
  // all three axes in linear; see the colour-space note on cloudShadowGain for
  // what it comes to on screen, which is not the same number.
  //
  // It cannot produce grey at any strength or any hour, and that is structural
  // rather than a tuning claim: every channel gain is positive, red and green
  // are attenuated identically and least, so a pixel can only move along its
  // own hue toward umber. There is no setting of this triple that walks gold
  // through neutral, which is what the cool target in Stylize could do and did.
  //
  // Checked rather than asserted, because the player's constraint on this is
  // absolute ("if it reads grey at any hour it is wrong"). Captured at 09:00
  // and 12:00 with the window forced fully open, which is the worst case this
  // term can reach and about five times the area it reaches in practice:
  //
  //          near ground        mid ground         far ground
  //   09:00  srgb(155,121,52)   srgb(113, 80,38)   srgb(181,149,64)
  //   12:00  srgb(152,119,51)   srgb(112, 82,38)   srgb(156,125,53)
  //
  // Every one of those is a light brown or a soft yellow-brown, which is the
  // player's own wording for what they wanted. The useful number is not the
  // chroma, which necessarily falls as a pixel darkens, but the SATURATION:
  // near ground goes 0.647 -> 0.663 at 09:00 and 0.619 -> 0.663 at 12:00. This
  // term gets MORE saturated as it darkens, which is the exact opposite of the
  // desaturating wash the critic measured, and it is why it cannot grey out.
  //
  // At dusk the question does not arise: Clouds fades params.cloudShadow to 0
  // on its own sun-elevation ramp, and it is already 0 by 18:36.
  cloudShadowTint: new THREE.Vector3(0.97, 0.97, 1.30),
  // The window the baked silhouette ramps across, and it is not free to choose:
  // Clouds.buildShadowTexture writes 0.38 + 0.52 * h, so 0.38 is "no cloud" and
  // 0.90 is "solid cloud". Setting the low end below 0.38 does not soften the
  // edge, it applies a fraction of the shadow to the entire world -- an
  // exposure change wearing a shadow's clothes, and the first thing I tried.
  // The edge softness comes from the bake ramp and the texel footprint (9.6 m
  // at a 512 map and this scale), not from here.
  //
  // The high end is 0.62 rather than 0.90 and that is the other half of the
  // area: the baked map is mostly penumbra (84% of texels sit at the 0.38
  // floor, and of the rest only a fifth reach 0.90), so mapping the ramp onto
  // the full 0.38-0.90 range spends most of the shadow's own body at partial
  // strength. Landing full strength at 0.62 turns a wide dim smudge into a
  // mass with a soft edge, which is the shape difference between round 040 and
  // now, and it costs no depth because the depth is set by the gain.
  cloudSoftLo: 0.38,
  cloudSoftHi: 0.62,

  // ── THE VALLEY-CROSSING MASSIF SHADOW (X2, and it is the one that reaches) ─
  //
  // Peak absorption of the terrain sun-visibility field MassifShadow.js builds.
  // Shares uCloudShadowTint, so the hue argument recorded above it — hold red
  // and green together, take the darkening out of blue, which cannot walk gold
  // through neutral at any strength — covers this term too, and the two masks
  // are unioned rather than stacked so a pixel can never pay both.
  //
  // 0.30, against the cloud term's 0.357 at full strength, and DELIBERATELY the
  // shallower of the two. This mass is much larger and much softer — its
  // penumbra takes 90 m of ground to close — so it is doing its work by area
  // rather than by depth, which is exactly the distinction X2 asks for and the
  // player's "too much contrast" note forbids getting wrong. Swept 0.22 / 0.30 /
  // 0.40 on `drive` and `meadow`; see the ladder in
  // docs/INTEGRATION_REQUESTS.md X7.
  massifShadow: 0.30,

  // -- THE CAST SHADOW'S OWN HUE, APPLIED WHERE IT SURVIVES (X2) ------------
  //
  // A pure hue rotation inside the sun's cast shadow, at constant luminance, on
  // the same axis as cloudShadowTint. See the note in the fog chunk for why it
  // has to be applied there and not in Stylize (L3), and for why it is free.
  // 1.0. Swept 0 / 0.8 / 1.4 / 2.2 on drive, and checked at nine views and six
  // hours. Below 0.8 the mass is present but not yet a shape; at 1.4 the
  // shadowed meadow is unmistakable and the frame as a whole has begun to go
  // red. 1.0 is the last setting at which only the shadow moves.
  sunShadeWarm: 1.0,
  // Extra absorption inside the cast shadow, unioned with the cloud and massif
  // masks. Held at 0 unless the ladder earns it: the shadow already carries
  // sun.shadow.intensity 0.62 and X2 forbids raising contrast.
  sunShadeDeep: 0.0,
  // The multiplier the cast shadow is mixed toward, at w = 1. Red up, green
  // down, blue untouched - blue cannot be moved from here at all (see the fog
  // chunk). Luma 0.960, so a full-strength shadow gives up 4% of its value to
  // buy the hue, and that is the entire depth cost of this term.
  sunShadeMul: new THREE.Vector3(1.15, 0.90, 1.00),

  // Amplitude of the moon's inscatter colour — see Atmosphere._moonScatter().
  // The night keys put the haze at linear luma ~0.013; this lands the halo's
  // own colour a little over that, which is a lift you can see against the sky
  // and nowhere near a fog bank.
  moonScatter: 0.055,
};

let patched = false;
let sharedCloudMap = null;
let sharedMassifMap = null;

export function patchFogChunks() {
  if (patched) return;
  patched = true;
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS;
  THREE.ShaderChunk.fog_fragment = FOG_FRAG;
  THREE.ShaderChunk.fog_pars_vertex = FOG_VERT_PARS;
  THREE.ShaderChunk.fog_vertex = FOG_VERT;

  sharedCloudMap = neutralCloudMap();
  sharedMassifMap = neutralMassifMap();

  // Register the extra uniforms so three uploads them for every fogged
  // material, and so fogUniforms() hands opt-in ShaderMaterials the same set.
  //
  // This MUST go through injectUniforms, not Object.assign. Three clones every
  // ShaderLib entry from UniformsLib at module-init, before this runs, so
  // writing to UniformsLib alone leaves MeshStandardMaterial declaring these
  // uniforms in its shader with no value behind them — and the entire
  // landscape silently renders with no aerial perspective while the opt-in
  // ShaderMaterials (trees, water) are correctly hazed.
  injectUniforms('fog', {
    uFogFarColor:      { value: PALETTE.fogFar.clone() },
    uFogSunColor:      { value: PALETTE.sunDisc.clone() },
    uFogSunDir:        { value: new THREE.Vector3(0, 1, 0) },
    uFogScatterDir:    { value: new THREE.Vector3(0, 1, 0) },
    uFogDensity:       { value: DEFAULTS.density },
    uFogHeightFalloff: { value: DEFAULTS.heightFalloff },
    uFogBaseHeight:    { value: DEFAULTS.baseHeight },
    uFogInscatter:     { value: DEFAULTS.inscatter },
    uFogInscatterMax:  { value: DEFAULTS.inscatterMax },
    uFogAnisotropy:    { value: DEFAULTS.anisotropy },
    uFogFarStart:      { value: DEFAULTS.farStart },
    uFogOnset:         { value: DEFAULTS.onset },
    uFogMax:           { value: DEFAULTS.max },
    uFogDesat:         { value: DEFAULTS.desat },
    uCloudMap:         { value: sharedCloudMap },
    uCloudShadow:      { value: DEFAULTS.cloudShadow },
    uCloudScale:       { value: DEFAULTS.cloudScale },
    uCloudAltitude:    { value: DEFAULTS.cloudAltitude },
    uCloudOffset:      { value: new THREE.Vector2() },
    uCloudShadowTint:  { value: DEFAULTS.cloudShadowTint.clone() },
    uCloudSoftLo:      { value: DEFAULTS.cloudSoftLo },
    uCloudSoftHi:      { value: DEFAULTS.cloudSoftHi },
    uCloudScale2:      { value: DEFAULTS.cloudScale2 },
    uMassifMap:        { value: sharedMassifMap },
    uMassifShadow:     { value: 0.0 },
    uMassifScale:      { value: 1 / 3072 },
    uSunShadeNorm:     { value: 1 / 0.62 },
    uSunShadeWarm:     { value: DEFAULTS.sunShadeWarm },
    uSunShadeDeep:     { value: DEFAULTS.sunShadeDeep },
    uSunShadeMul:      { value: DEFAULTS.sunShadeMul.clone() },
  });
  verifyUniforms('Atmosphere', ['uFogDensity', 'uFogFarColor', 'uFogSunDir', 'uCloudMap',
                                'uMassifMap', 'uMassifShadow']);
}

/**
 * Uniform block a custom ShaderMaterial must merge in to participate in the
 * shared atmosphere. Pair with `fog: true` and the standard fog shader chunks.
 */
export function fogUniforms() {
  return THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
}

export class Atmosphere {
  constructor(scene) {
    patchFogChunks();
    this.scene = scene;
    // A Fog instance is what makes three define USE_FOG; the near/far are unused.
    scene.fog = new THREE.Fog(PALETTE.fogNear.clone(), 1, 10000);

    this.params = {
      ...DEFAULTS,
      nearColor: PALETTE.fogNear.clone(),
      farColor: PALETTE.fogFar.clone(),
      sunColor: PALETTE.sunDisc.clone(),
      cloudMap: sharedCloudMap,
      cloudOffset: new THREE.Vector2(),
      cloudShadowTint: DEFAULTS.cloudShadowTint.clone(),
      sunShadeMul: DEFAULTS.sunShadeMul.clone(),
      massifMap: sharedMassifMap,
      massifScale: 1 / 3072,
    };
    this._materials = new Set();
    // Built lazily: Atmosphere is constructed before the world bake finishes,
    // and main.js is not ours to add a setter to. Same defensive late bind
    // Lighting uses for the renderer.
    this.massif = new MassifShadow();
  }

  /**
   * Hand the shared atmosphere a tiling cloud-coverage map (red channel) so
   * the landscape gets the shadows of the clouds actually drawn overhead.
   * Called by Clouds; safe to never call.
   */
  setCloudShadow({ map, scale, altitude, strength }) {
    if (map) this.params.cloudMap = map;
    if (scale !== undefined) this.params.cloudScale = scale;
    if (altitude !== undefined) this.params.cloudAltitude = altitude;
    if (strength !== undefined) this.params.cloudShadow = strength;
  }

  /** Scroll the projected cloud shadows with the cloud wind. */
  setCloudOffset(x, y) { this.params.cloudOffset.set(x, y); }

  /**
   * Track a material so its fog uniforms get driven each frame.
   * Never flips `fog` on: a ShaderMaterial that did not opt in has no fog
   * uniform block, and forcing it makes three throw inside refreshFogUniforms.
   * Custom shaders opt in with `fogUniforms()` + `fog: true`.
   */
  register(material) {
    if (!material || material.fog === false) return material;
    if (this._materials.has(material)) return material;
    this._materials.add(material);
    // Without this, a plain MeshStandardMaterial has no route from JS to its
    // compiled uniform block and update() below silently skips it forever.
    captureShader(material);
    return material;
  }

  /** Walk the scene and pick up anything new. Cheap; call occasionally. */
  harvest() {
    this.scene.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) this.register(m);
    });
  }

  /**
   * The moon's contribution to the inscatter colour.
   *
   * `moonScatter` is the amplitude, and it is small on purpose: the haze around
   * a moon is a *halo*, and a halo that reaches the value of the moonlit ground
   * is a fog bank. Held at roughly a fifth of the night sky's own luminance,
   * scaled by how far up the moon is, so it fades in with the moon rather than
   * switching on.
   */
  _moonScatter(moonColor, mi) {
    const c = (this._moonScatterCol ??= new THREE.Color());
    c.copy(moonColor ?? { r: 0.82, g: 0.86, b: 1.0 });
    return c.multiplyScalar(this.params.moonScatter * mi);
  }

  update(sunDir, sunColor, elevation01) {
    const p = this.params;
    this.scene.fog.color.copy(p.nearColor);

    // The massif field is world-space and sun-driven only, so it rebuilds when
    // the sun moves and not per frame. cycleSpeed is 0 by default, so in a
    // shipped run and in every capture this is one 0.5 ms build at boot.
    if (!this.massif.ready) {
      if (this.massif.bind(globalThis.__world)) {
        p.massifMap = this.massif.texture;
        p.massifScale = 1 / this.massif.worldSize;
      }
    }
    this.massif.update(sunDir, (typeof performance !== 'undefined') ? performance.now() : 0);
    // ── hand the frame back to the shadow map when the shadow map can hold it ─
    //
    // The field is gated to occluders 170-300 m away because that is what an
    // eye-level sun shadow camera (150-200 m of half-extent, W1) structurally
    // cannot contain. A vista camera is a different animal: Lighting ramps the
    // extent to 726 m at `dawn` and 894 m at `hero` and `peaks` precisely so the
    // distant ridge casters land, and measured, they do — `hero`'s ground fan is
    // 41.7% terrain-shadowed with 0% of its occluders outside the frustum. Drawn
    // there as well, this term would be a second copy of a shadow that is
    // already on screen. Fade it out over the range where the real map takes
    // over, and the two never both draw the same mass.
    //
    // Read off the debug global rather than passed in, because main.js owns the
    // Atmosphere.update() call signature and is not ours to change. Filed in
    // docs/INTEGRATION_REQUESTS.md; with no Lighting this falls back to full
    // strength, which is the eye-level case and the common one.
    const ext = globalThis.__lighting?.shadowExtent;
    const handover = Number.isFinite(ext)
      ? 1 - Math.min(1, Math.max(0, (ext - 200) / 220)) : 1;
    this._massifFade = handover * handover * (3 - 2 * handover);
    // getShadow() folds sun.shadow.intensity in, so a fully shadowed pixel
    // reads 1 - intensity rather than 0. Normalise with the live value and not
    // a constant: Lighting owns that number and has moved it three times.
    const si = globalThis.__lighting?.sun?.shadow?.intensity;
    this._sunShadeNorm = (Number.isFinite(si) && si > 0.05) ? 1 / si : 1 / 0.62;

    // ── what the Mie lobe points at, and what colour it is ──────────────────
    //
    // All day: the sun, unchanged. After it sets there is no sun to
    // forward-scatter and the lobe was still aimed at one, several degrees
    // under the terrain — so for roughly a third of the cycle this term drew
    // its glow below the ground, which is to say nowhere. The moon is the only
    // source left, and night.jpg is explicit that it wants this: the plate has
    // a soft halo around its crescent perhaps ten disc-radii across, sitting in
    // the sky rather than on the dome, which is what an inscattering haze looks
    // like around a light.
    //
    // Swung by `moonIntensity`, which Lighting already ramps to 0 whenever the
    // moon is down or the sun is up, so the crossover is smooth by
    // construction and there is no hour at which both are claimed.
    //
    // The colour has to move with the direction. `fogSun` is authored for
    // sunlight and at h0 it is 0x2a3358, a dark blue — mixing the haze toward
    // that around the moon is a hole, not a halo. Moonlight is the moon's own
    // colour at a small fraction of daylight, so this is moonColor scaled to
    // sit just above the night haze rather than at daylight amplitude.
    const s = SKY_STATE;
    const mi = Math.min(1, Math.max(0, s.moonIntensity ?? 0));
    (this._scatterDir ??= new THREE.Vector3()).copy(sunDir);
    (this._scatterColor ??= new THREE.Color());
    if (mi > 0.001 && s.moonDir) {
      this._scatterDir.lerp(s.moonDir, mi).normalize();
      this._scatterColor.copy(p.sunColor).lerp(
        this._moonScatter(s.moonColor, mi), mi);
    } else {
      this._scatterColor.copy(p.sunColor);
    }

    for (const m of this._materials) {
      const u = m.userData?.shader?.uniforms ?? m.uniforms;
      if (!u || !u.uFogDensity) continue;
      u.uFogDensity.value = p.density;
      u.uFogHeightFalloff.value = p.heightFalloff;
      u.uFogBaseHeight.value = p.baseHeight;
      u.uFogInscatter.value = p.inscatter;
      u.uFogAnisotropy.value = p.anisotropy;
      u.uFogFarStart.value = p.farStart;
      if (u.uFogOnset) u.uFogOnset.value = p.onset;
      u.uFogMax.value = p.max;
      u.uFogFarColor.value.copy(p.farColor);
      u.uFogSunColor.value.copy(p.sunColor);
      u.uFogSunDir.value.copy(sunDir);
      if (u.uFogScatterDir) u.uFogScatterDir.value.copy(this._scatterDir);
      if (this._scatterColor) u.uFogSunColor.value.copy(this._scatterColor);
      if (u.uFogInscatterMax) u.uFogInscatterMax.value = p.inscatterMax;
      if (u.uFogDesat) u.uFogDesat.value = p.desat;
      if (u.uCloudShadow) {
        // The gain and the scale multiplier are applied here rather than folded
        // into params, because Clouds rewrites params.cloudShadow every frame
        // and re-supplies params.cloudScale on every init. Applying them at
        // upload keeps this file's look decisions out of the sky's data flow.
        u.uCloudShadow.value = p.cloudShadow * p.cloudShadowGain;
        u.uCloudScale.value = p.cloudScale * p.cloudScaleMul;
        u.uCloudAltitude.value = p.cloudAltitude;
        // Offset scales with it too, or the patches would drift across the
        // ground at wind speed divided by cloudScaleMul.
        u.uCloudOffset.value.copy(p.cloudOffset).multiplyScalar(p.cloudScaleMul);
        if (u.uCloudMap.value !== p.cloudMap) u.uCloudMap.value = p.cloudMap;
        if (u.uCloudShadowTint) {
          u.uCloudShadowTint.value.copy(p.cloudShadowTint);
          u.uCloudSoftLo.value = p.cloudSoftLo;
          u.uCloudSoftHi.value = p.cloudSoftHi;
          u.uCloudScale2.value = p.cloudScale2;
        }
      }
      if (u.uSunShadeWarm) {
        u.uSunShadeWarm.value = p.sunShadeWarm;
        u.uSunShadeMul.value.copy(p.sunShadeMul);
        u.uSunShadeDeep.value = p.sunShadeDeep;
        u.uSunShadeNorm.value = this._sunShadeNorm ?? (1 / 0.62);
      }
      if (u.uMassifShadow) {
        u.uMassifShadow.value = this.massif.ready ? p.massifShadow * (this._massifFade ?? 1) : 0.0;
        u.uMassifScale.value = p.massifScale;
        if (u.uMassifMap.value !== p.massifMap) u.uMassifMap.value = p.massifMap;
      }
      if (u.fogColor) u.fogColor.value.copy(p.nearColor);
    }
    void sunColor; void elevation01;
  }
}
