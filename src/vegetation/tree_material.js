// ─────────────────────────────────────────────────────────────────────────────
//  Tree materials.
//
//  All of these are raw ShaderMaterials rather than hijacked MeshStandard
//  because foliage does not obey a PBR BRDF: it is a translucent mass that has
//  to glow when backlit, occlude itself from the inside, and shade off a crown
//  normal that has nothing to do with the geometry it is drawn on. What they
//  do borrow from three is the shadow plumbing (`lights: true` + the shadowmap
//  chunks) and the shared atmosphere (`fog: true` + `fogUniforms()`), because
//  a tree that invents its own fog floats in front of the mountains.
//
//  Each material ships with a matching depth material so shadows are cast from
//  the *wind-displaced, billboarded* geometry rather than from the rest pose.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { fogUniforms } from '../render/Atmosphere.js';
import { stylizeUniforms, STYLIZE_PARS } from '../render/Stylize.js';
// Camera occlusion: the transparent frustum between the chase camera and the
// camper. Opt-in only — every call site in this file is marked OCCLUDE. The
// depth materials deliberately do not take it, so a canopy you can see through
// still casts its shadow.
//
// BARK TAKES IT THROUGH A SECOND PROGRAM, AND THE SECOND PROGRAM IS THE WHOLE
// POINT. The player's frame that opened this round is a trunk floor to ceiling
// down the middle with the camper a sliver behind it — the near foliage around
// it fading correctly, and the bark not — so bark has to fade. What it cannot
// do is fade unconditionally. Measured on the gate configuration, same tree,
// three runs:
//
//   feature off                                46.3 fps
//   leaves + cover, bark discarding            31.9 fps
//   leaves + cover, bark untouched             51.3 fps
//
// Bark is opaque and BARK_FRAG is one of the most expensive shaders in the game
// — multi-octave value noise, lenticels, chevron scars, all per pixel. One
// 'discard' anywhere in it turns early-Z off for the whole program, so every
// trunk fragment in a forest runs that shader even when a nearer trunk already
// owns the pixel. Twelve milliseconds, for the smaller half of the problem.
// (The canopy pays nothing for its discard: it is alpha-tested and had given
// early-Z up long ago, which is why the feature is a net WIN there — it throws
// away near-camera overdraw.)
//
// So `createBarkMaterial` builds two of them. `{ occlude: true }` adds the
// dither and gives up early-Z; the default does not and is bit-identical to
// what shipped before. Trees.js owns the choice and makes it per instanced
// mesh per frame, from a CPU-side copy of the same volume — see
// `_gateOcclusion` there, and `occlusionTouchesColumn` in render/Occlusion.js.
// A near slot holds one species-variant's trunks inside 84 m, a handful of
// instances, and in the overwhelming majority of frames NO slot has anything
// in the frustum and every mesh keeps the cheap program. The 12 ms is a bill
// that now arrives only on the frames that are actually hiding the camper, and
// only for the one slot that is doing the hiding.
//
// The obvious alternative, shrinking the trunk toward its own axis in the
// vertex shader, was built and photographed: shots/occlude/bark-on.png. It is
// free, and it is wrong. Branch tubes are modelled offset from the trunk axis,
// so scaling local.xz drags every branch toward the centre and the per-vertex
// fade shears them into long diagonal streaks across the frame. Any real fix
// wants a per-branch axis this material does not carry.
//
// See src/render/Occlusion.js.
import { occlusionUniforms, OCCLUDE_PARS, OCCLUDE_DITHER } from '../render/Occlusion.js';
import { PALETTE } from '../world/WorldConfig.js';

// ── shared GLSL ──────────────────────────────────────────────────────────────

const WIND = /* glsl */`
uniform vec3  uWindDir;        // unit, horizontal
uniform float uWindStrength;   // metres of tip travel at weight 1
uniform float uTime;

// Whole-tree sway. Two detuned oscillators plus a slow gust envelope, all
// phase-shifted along the wind direction so gusts visibly *travel* across a
// hillside instead of every tree pumping in lockstep.
vec3 windSway(vec3 worldOrigin, float weight, float phase) {
  float travel = dot(worldOrigin.xz, uWindDir.xz) * 0.022;
  float gust = 0.5 + 0.5 * sin(uTime * 0.19 - travel + phase * 0.6);
  gust *= gust;
  float sway = sin(uTime * 0.78 - travel + phase) * 0.72
             + sin(uTime * 1.41 - travel * 1.6 + phase * 2.3) * 0.28;
  float amp = uWindStrength * (0.32 + 0.9 * gust) * weight;
  vec3 o = uWindDir * (sway * amp);
  // Shorten as it leans: the tip travels on an arc, not a rubber band. Without
  // this the whole tree visibly stretches and the wind reads as jelly.
  o.y -= abs(sway) * amp * 0.24;
  return o;
}

// Per-clump flutter — small, fast, and deliberately not aligned with the wind
// so the canopy simmers instead of throbbing.
vec3 leafFlutter(float phase, float weight) {
  float g = 0.55 + 0.45 * sin(uTime * 0.19 + phase * 0.6);
  float a = uWindStrength * weight * (0.22 + 0.78 * g) * 0.17;
  return vec3(sin(uTime * 2.6 + phase * 6.1),
              sin(uTime * 3.2 + phase * 3.7) * 0.55,
              cos(uTime * 2.2 + phase * 4.9)) * a;
}
`;

// The painterly lighting model, shared by leaves and impostors so the LOD
// transition does not change how a tree is lit.
const CANOPY_LIGHT = STYLIZE_PARS + /* glsl */`
uniform vec3  uSunDir;        // world space, points toward the sun
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uGroundColor;
uniform float uAmbient;
uniform vec3  uTransTint;
uniform float uTransStrength;
uniform float uTransDepth;      // Beer-Lambert scale on the optical depth
uniform float uTransChroma;     // how far transmitted light takes the leaf's hue
uniform float uTransSpread;     // dot(V, sunDir) at which forward scatter starts
uniform float uBands;
uniform float uCanopyGain;
uniform float uCanopyAmbient;
uniform float uRimBoost;

vec3 canopyShade(vec3 albedo, vec3 N, vec3 V, float ao, float thin, float shadow) {
  float ndl = dot(N, uSunDir);

  // Wrapped diffuse: a canopy is a translucent mass, so light bleeds well past
  // the terminator. A hard N·L makes it read as painted plastic.
  // Shared stylised response rather than a local wrap: this is where the
  // diffuse *floor* comes from. Without it foliage — the largest, darkest mass
  // in the river/forest/waterfall frames — was the only thing in the game with
  // no floor, and those frames measured lumaP05 0.02 against a reference band
  // of 0.16-0.42. The grade was then lifting the whole shadow end of the image
  // just to catch this one hole.
  float wrap = stylizeDiffuse(ndl);
  // Gentle posterisation — the reference art bands, it does not ramp.
  wrap = mix(wrap, floor(wrap * uBands + 0.5) / uBands, 0.38);
  // The shadow mask already carries the light's own shadowIntensity (0.66), so
  // it arrives in 0.34..1 and has *already* been softened for us. Multiplying a
  // second 0.18 on top of it double-counted the same darkening: combined with
  // the AO term below, a shadowed interior card kept roughly 5% of the key and
  // reached the grade at effectively zero. Nothing downstream can rescue that.
  // Keep only enough range that a cast shadow is still legible across a crown.
  wrap *= mix(0.56, 1.0, shadow);

  // uCanopyGain sits near unity. It used to be 0.82 to hold the canopy below
  // the sunlit meadow, but measurement said the opposite was the problem: in
  // the eye-level frames the canopy *is* most of the frame, and holding all of
  // it below the ground left river with lumaP95 0.46 and contrastStd 0.07
  // against reference bands of ~0.60 and 0.13-0.18. A lit crown in the plates
  // is as bright as the gold it stands in; it is the *shaded* crown that sits
  // below, and that separation now comes from AO and shadow rather than from a
  // flat scale on the whole species.
  // AO is a *modulation* of the key, not a second occluder. At mix(0.28, 0.94)
  // an interior clump threw away nearly three quarters of the light before the
  // shadow term had even been applied. A conifer reads as a solid mass because
  // of its albedo and its normals; it does not also need the light removed.
  //
  // The window is wide and it is deliberately *asymmetric*. Fixing the dark
  // hole left the opposite defect: measured over 165k pixels of pure canopy the
  // river frame's crowns spanned luma 0.32 to 0.46, where the same crowns in
  // plates 1 and 3 span 0.21-0.63 and 0.18-0.78. A canopy compressed into a
  // seventh of the reference's value range is a flat orange mat — it has no
  // lit tops, no shaded undersides, and no individual trees in it, which is
  // exactly what the river anchor came back as. Almost all of the correction
  // belongs at the top: the shaded end already measures close to the plates
  // and is the end that turns into a hole if it is pushed.
  vec3 direct = uSunColor * wrap * mix(0.42, 1.62, ao) * uCanopyGain;
  // Sky dominates from above: without the extra lift the tops of crowns go as
  // dark as their undersides and the canopy loses all vertical form. The
  // constant term is the part that matters for the dark-hole defect — it is
  // what guarantees a fully occluded, fully shadowed clump still arrives at the
  // grade carrying its own hue instead of as a neutral silhouette.
  // uCanopyAmbient > 1 is not a fudge. uAmbient arrives as three's hemisphere
  // irradiance for a single-sided Lambert surface; a leaf card is double-sided,
  // translucent, and sits in a crown that sees most of the sky dome from both
  // faces, so it collects appreciably more than that convention allows. This is
  // the term that decides whether a shadowed crown is a dark green mass or a
  // hole, because in shadow it is nearly the whole signal.
  // Backlit self-shading.
  //
  // A crown is an opaque mass a few metres thick. The face of it turned toward
  // a camera that is looking into the sun is the face standing in the tree's
  // own shadow — in the reference that face is the darkest thing in the frame,
  // and the contrast between it and the blazing edge around it *is* the backlit
  // effect. We were giving it full hemisphere ambient, which is why the near
  // conifer in the backlit anchor read as lit on the side facing the camera
  // with the sun plainly behind it, and why the whole view came back as one
  // pale wash with no silhouette in it.
  //
  // Note this deliberately does *not* touch the transmission term below. Losing
  // reflected light and gaining transmitted light is exactly what a backlit
  // leaf does; running both at full strength at once is what washed it out.
  // 0.46, not 0.58, after measuring the relationship the reference actually
  // holds. Plate 3's near crowns sit *below* the gold meadow they stand in —
  // the crimson maple reads srgb(153,49,9) and a gold crown srgb(106,92,56)
  // against sunlit grass at srgb(130-149, 91-100, 45-56). Ours came back at
  // srgb(161,86,57) beside grass at srgb(199,114,81): the same hue at a similar
  // value, so the near crown in the backlit anchor did not separate from the
  // field behind it at all. This is the term that owns that separation.
  float faceCam = clamp(-dot(N, V), 0.0, 1.0);
  float intoSun = clamp(dot(V, uSunDir) * 1.3, 0.0, 1.0);
  float backFace = faceCam * intoSun;
  float selfShade = mix(1.0, 0.46, backFace);

  vec3 hemi = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5)
            * uAmbient * uCanopyAmbient * (0.36 + 1.00 * ao) * selfShade
            // The downward end of this used to be 0.80. A crown seen from
            // underneath — which is most of what the backlit and drive
            // anchors look at, standing under a stand at eye level — then came
            // back as a flat dark brown-red ceiling. Physically a leaf facing
            // down is the one collecting the bounce off a sunlit gold meadow,
            // so it should be the *least* starved of ambient, not the most. The
            // lit end is unchanged, so this lifts undersides without touching
            // the crown tops that now measure on the plates.
            * (0.92 + 0.36 * clamp(N.y, 0.0, 1.0));
  direct *= mix(1.0, 0.80, backFace);

  // ── Transmission ──────────────────────────────────────────────────────────
  //
  // Rewritten. What was here before was measured by critic pass 6 and found to
  // be a tip gradient rather than a translucency: the frond tips ran +35 to
  // +48% over the crown body, only +12% of that varied with the sun, the
  // brightest needle reached 72% of the sky behind it, and the crown interior
  // was opaque at the same value as its shaded side. Three separate causes,
  // all of them in these dozen lines, all fixed here.
  //
  // 1. THE TRANSMITTED LIGHT WAS MULTIPLIED BY THE ALBEDO. This is the exact
  //    mistake the look author warned about for the rim, one term further down
  //    the same function: a spruce needle's albedo is the darkest thing in the
  //    frame (linear luma ~0.12), so multiplying the glow by it left 12% of the
  //    light on the species whose whole job in this frame is to glow. A leaf's
  //    transmittance is not its reflectance — chlorophyll passes far more light
  //    than it bounces — so transmitted light takes the leaf's HUE and not its
  //    VALUE. That is what the normalisation below does, and it is worth about
  //    six stops on a conifer and about one on a gold aspen, which is the right
  //    ratio: the dark species is the one that has somewhere to go.
  //
  // 2. THERE WAS NO OPTICAL DEPTH. The old term keyed thickness off 'thin',
  //    which is a per-brush-mark texture channel — high at the edge of every
  //    dab, everywhere in the crown, dead centre included. So the glow fired
  //    just as hard three metres inside the crown as it did on the silhouette.
  //    A backlit crown reads the way it does because it THINS toward its edge;
  //    that is the whole effect. Three depth signals go into a Beer-Lambert
  //    exponent now, and the third of them is the honest one: the shadow map
  //    already answers 'how much leaf is between the sun and this card' by
  //    actually tracing it, and near-LOD canopy casts, so a near crown
  //    genuinely self-shadows.
  //
  // 3. IT WAS NOT SUN-DEPENDENT. (0.46 + 0.54 * ...) x (0.30 + 0.70 * ...)
  //    floors at 13.8% of peak, so the term fired in every frame in the game
  //    whether the sun was behind the foliage or in front of the camera. The
  //    smoothstep below reaches zero for a sun behind the viewer while keeping
  //    a broad lobe, which is what the old comment about the base term was
  //    really after: a backlit STAND glows across its whole width, but a
  //    front-lit one must not glow at all.
  //
  // Forward scatter: light that entered the far side of the crown, bounced
  // around inside the leaf and carried on toward the camera. It peaks when the
  // camera is looking along the sun's own direction of travel, which is
  // dot(V, sunDir) with V pointing camera -> surface.
  float toward = dot(V, uSunDir);
  float fwd = smoothstep(uTransSpread, 0.92, toward);
  // ...and it is seen on the face turned AWAY from the sun. The crown normal
  // points out of the crown, so this is the honest 'am I on the shaded side of
  // this tree' question rather than a billboard-facing artefact.
  float back = clamp(-ndl, 0.0, 1.0);

  // Optical depth: how much leaf material the light had to cross to get here.
  //   · (1.12 - ao)     radial depth in the crown. ao runs ~0.35 at the trunk
  //                     to ~1.14 at a bough tip.
  //   · (1.28 - thin)   depth inside the individual brush mark. thin is 1.28 at
  //                     a mark's edge and 0.40 at its core.
  //   · (1.0 - shadow)  measured occlusion. shadow arrives in 0.34..1 carrying
  //                     the light's own shadowIntensity; a card buried in the
  //                     crown is the one the sun did not reach.
  float depth = uTransDepth * (
        clamp(1.12 - ao, 0.0, 1.0)
      + 0.90 * clamp(1.28 - thin, 0.0, 1.0)
      + 1.60 * clamp(1.0 - shadow, 0.0, 1.0));
  float through = exp(-depth);

  float trans = uTransStrength * fwd * (0.12 + 0.88 * back) * through;

  // Transmitted light carries the leaf's hue at unit luminance. Mixing two
  // unit-luminance vectors keeps the result at unit luminance, so this is a
  // pure hue rotation with no value in it: every species transmits the same
  // amount of light and a different colour of it. uTransTint stays a nudge
  // (see makeSharedUniforms) rather than a fourth warm multiplier.
  float lum = max(dot(albedo, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
  vec3 chroma = mix(vec3(1.0), albedo / lum, uTransChroma);
  vec3 transC = uSunColor * uTransTint * chroma;

  // Rim — the shared golden-hour edge from Stylize, which every
  // MeshStandardMaterial in the game gets through the patched direct-lighting
  // term and which a raw ShaderMaterial has to opt into. This replaces a local
  // rim that was multiplied *through* the albedo: on a conifer, whose albedo is
  // the darkest thing in the frame, that produced a dark rim, which is the one
  // thing a backlit edge must never be. It is added to the light now, not to
  // the surface.
  //
  // Two adaptations to the documented call, both because a leaf card is a
  // double-sided billboard rather than a solid:
  //   · V here points camera -> surface, so the helper's view vector is -V;
  //   · the fresnel is fed |N.V| rather than N.-V. The sign of a billboard's
  //     crown normal carries no facing information — a card on the far side of
  //     the crown has an outward normal pointing away from us — so the raw form
  //     would return a full rim for roughly half of every canopy instead of for
  //     its silhouette. |N.V| is zero at the true grazing band from either
  //     side, which is where the edge actually is.
  float rim = stylizeRim(abs(dot(N, V)), dot(-V, uSunDir)) * uRimBoost;
  // A rim needs the light to physically reach the edge, but a canopy edge is
  // exactly where the shadow map is least reliable (it is a cutout billboard
  // one texel wide), so this keeps most of the rim inside a shadowed crown.
  // Gated on the clump's own exposure as well. A conifer's needle normals point
  // outward and horizontally, so on the left and right thirds of a spire the
  // fresnel is near its peak even for cards buried well inside the crown —
  // ungated, the rim lit the whole tree pale cream and the spire stopped being
  // the dark mass the palette needs from it.
  //
  // The ao gate is now multiplied by 'through' as well, and uRimBoost has come
  // down from 6.0. ao is BOUGH-local on a conifer — it runs 0.35 at the trunk
  // to 1.14 at the tip of every whorl, including the whorls buried in the
  // middle of the spire — so on its own it is a per-frond fringe and not a
  // silhouette. That is precisely the orientation-independent pale sage tip
  // gradient critic pass 6 photographed and measured at +35-48% with only +12%
  // of it moving with the sun. 'through' is the term that knows the difference
  // between a bough tip on the outside of the crown and one three metres in.
  rim *= mix(0.55, 1.0, shadow) * clamp(ao * ao * 1.05, 0.0, 1.25)
       * mix(0.30, 1.0, through);

  vec3 col = albedo * (direct + hemi) + transC * trans + uSunColor * rim;

  // A *gentle* per-channel shoulder, and no more than that. This used to be an
  // aggressive roll-off because the post chain ran AgX, a filmic curve that
  // deliberately desaturates highlights and turned a lit gold crown to cream.
  // The chain is Khronos PBR Neutral now, which holds hue into the highlights
  // and has its own knee; stacking a second hard curve on top of it is what was
  // flattening the backlit glow into brown cardboard. Keep just enough to stop
  // two channels clipping together.
  return col / (1.0 + col * 0.09);
}
`;

const SHADOW_SAMPLE = /* glsl */`
float canopyShadow() {
  float s = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    s = getShadow(
      directionalShadowMap[ 0 ],
      directionalLightShadows[ 0 ].shadowMapSize,
      directionalLightShadows[ 0 ].shadowIntensity,
      directionalLightShadows[ 0 ].shadowBias,
      directionalLightShadows[ 0 ].shadowRadius,
      vDirectionalShadowCoord[ 0 ] );
  #endif
  return s;
}
`;

// Coverage-preserving alpha cutout.
//
// generateMipmaps averages coverage, so a mark that is solid at 1:1 loses alpha
// from its edges inward as it minifies. Against a fixed threshold that carves a
// crown boundary into thousands of single-pixel islands — the "dissolve noise"
// the critic photographed — because the boundary is exactly where coverage is
// already marginal. Estimating the mip level from the UV derivatives and easing
// the threshold down with it keeps a mark's *area* roughly constant as it
// shrinks, which is what lets it still read as a brush stroke at 200 m.
const CUTOUT = /* glsl */`
uniform float uAtlasTexels;
float atlasLod(vec2 uv) {
  vec2 ddx = dFdx(uv) * uAtlasTexels;
  vec2 ddy = dFdy(uv) * uAtlasTexels;
  return 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy)) + 1e-8);
}
float cutoutThreshold(float base, vec2 uv) {
  float lod = clamp(atlasLod(uv), 0.0, 6.0);
  return base / (1.0 + 0.40 * lod);
}
`;

/** Uniforms every tree material shares by reference, so one write drives all. */
export function makeSharedUniforms() {
  return {
    uTime:          { value: 0 },
    uWindDir:       { value: new THREE.Vector3(1, 0, 0) },
    uWindStrength:  { value: 0.45 },
    uSunDir:        { value: new THREE.Vector3(0.4, 0.7, 0.3) },
    uSunColor:      { value: new THREE.Color(1, 0.88, 0.72) },
    uSkyColor:      { value: PALETTE.ambientSky.clone() },
    uGroundColor:   { value: PALETTE.ambientGround.clone() },
    uAmbient:       { value: 0.55 },
    // Near-neutral, and this is a correction, not a preference. Transmission is
    // already tinted twice — by the leaf it passes through (albedo is in the
    // product) and by the sun (uSunColor, which at golden hour is about
    // 1 : 0.66 : 0.35 linear). The old 1.62 : 1.10 : 0.58 is itself
    // 1 : 0.68 : 0.36, i.e. a *third* warm multiplier of the same strength, and
    // stacking it gave transmitted light a net 1 : 0.44 : 0.13. That is the
    // crushed blue channel the critic measured on foliage, and — because
    // transmission is the dominant term in exactly the frame that exists to
    // test backlight — it is most of why the backlit view came back 68% red
    // against plate 3's 37% and read as one salmon wash rather than as
    // stained glass. It stays slightly warm because sunlight through a leaf
    // does pick up a little of the leaf's own warmth beyond its reflectance,
    // but it is a nudge now rather than a hue replacement.
    uTransTint:     { value: new THREE.Color(1.30, 1.13, 0.95) },
    // Overwritten every frame from Trees.update(), which ramps it with the
    // sun's elevation. The value here is only what the impostor bake sees.
    uTransStrength: { value: 1.0 },
    // Beer-Lambert scale on the optical depth: it passes ~100% on a crown's
    // fringe and ~10% on a card buried in an interior whorl and in the crown's
    // own shadow. Swept rather than picked: measured on the near maple crown in
    // `backlit`, transmission on minus transmission off, everything else held
    // inside one page load —
    //     depth 1.5  +7.6%      depth 0.9  +48%
    //     depth 0.6  +41%       depth 0.0  +110%
    // 1.5 was the first guess and it was wrong by an order of magnitude: it
    // spent nearly all of the exponent on the shadow term, which on foliage is
    // very nearly binary (the light's shadowIntensity pins the occluded value
    // at 0.34 however many leaves are in the way), so a self-shadowed backlit
    // crown — every crown this effect exists for — was cut fivefold before the
    // two continuous depth signals were even consulted.
    //
    // 0.8 -> 0.7 re-measured at the delivered uTransStrength (1.75, below), and
    // the sweep above was not: it was taken at the old strength, so it is kept
    // for the shape of the curve and not for its absolute numbers. Near maple
    // crown, mean luma, one page load, transmission+rim off = 0.3192 —
    //     depth 0.80  0.4244  (+33.0%)     depth 0.70  0.4432  (+38.8%)
    uTransDepth:    { value: 0.7 },
    // How far the transmitted colour takes the leaf's own hue. 1.0 is the full
    // chromaticity of the albedo; below that it is pulled toward white. Kept
    // under 1 because a crimson maple at full chromaticity transmits a red
    // three times its own luminance and clips before the tone curve sees it.
    uTransChroma:   { value: 0.85 },
    // dot(V, sunDir) at which forward scatter begins. Slightly negative so a
    // stand a little to the side of the sun still glows across its whole width,
    // and hard zero once the sun is behind the camera.
    uTransSpread:   { value: -0.12 },
    uBands:         { value: 4.0 },
    uCanopyGain:    { value: 1.34 },
    uCanopyAmbient: { value: 1.42 },
    // Multiplier on the shared rim, which Stylize holds at 0.22 globally. That
    // number is priced for grass: a blade is a thin card seen edge-on, so its
    // fresnel is near 1 across the whole field and a rim strong enough to draw
    // a tree edge lifts the entire meadow instead. A crown has a real
    // silhouette and is the subject of the backlit view, so it is allowed more.
    //
    // Down from 6.0. At 6.0 this was carrying the whole of what the backlit
    // frame had instead of translucency, and carrying it as an
    // orientation-independent pale sage fringe on every frond in the tree —
    // measured, not guessed (critic pass 6 §3). Now that transmission is a real
    // term the rim goes back to the job the look author priced it for: a
    // defined edge on the true grazing band.
    uRimBoost:      { value: 3.0 },
  };
}

const lightUniforms = () => THREE.UniformsUtils.clone(THREE.UniformsLib.lights);

// ── leaves ───────────────────────────────────────────────────────────────────

const LEAF_VERT = /* glsl */`
attribute vec2 aCorner;
attribute vec2 aSize;
attribute vec3 aCrownN;
attribute vec3 aData;      // ao, tone, flex
attribute vec3 aColA;      // instanced
attribute vec3 aColB;      // instanced
attribute vec2 aWind;      // instanced: phase, stiffness

varying vec2 vUv;
varying vec3 vColA;
varying vec3 vColB;
varying float vTone;
varying float vAO;
// OCCLUDE rides in vN.w rather than in a varying of its own. Under GLSL ES 3.00
// — which is what three compiles for WebGL2 — every declared varying takes a
// whole vec4 location whatever its type, so a lone 'varying float' costs a full
// interpolator across the largest fill in the game. vN had three of four
// components spare.
varying vec4 vN;
varying vec3 vWorld;

#include <common>
#include <shadowmap_pars_vertex>
#include <fog_pars_vertex>
${WIND}
${OCCLUDE_PARS}

void main() {
  float scale = length(instanceMatrix[0].xyz);
  vec3 worldOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  // Per-clump phase from its own position, so clumps on one tree do not move
  // as a rigid body while the whole tree still shares an instance phase.
  float phase = aWind.x + fract(dot(position.xz, vec2(0.1731, 0.3719))) * 6.2831853;
  float flex = aData.z * aData.z * aWind.y;
  vec3 disp = windSway(worldOrigin, flex, aWind.x) + leafFlutter(phase, aData.z * aWind.y);

  vec3 local = position + disp / max(scale, 1e-4);
  vec4 worldPosition = modelMatrix * instanceMatrix * vec4(local, 1.0);

  // OCCLUDE. Evaluated HERE, at the clump's centre, and deliberately not at the
  // billboard corner four lines down. A clump quad is several metres across, so
  // a corner-evaluated fade interpolates to roughly the mean of the corners
  // across the middle of the quad — and the middle is exactly the part lying
  // over the camper. Measured on the frame: boughs squarely across the vehicle
  // came back at half fade because their corners were outside the cone. It is
  // also the better read: a clump is one brush stroke, and half a stroke
  // dissolving looks like an error rather than like the camera getting out of
  // the way.
  //
  // The clump's own radius goes with it. A clump the camera is INSIDE has its
  // centre two or three metres away and still owns the whole screen, so tested
  // as a point it lands in the middle of the near feather and the frame comes
  // back as a 50% halftone over everything — better than a wall of green, and
  // not what this is for. Subtracting the radius makes the sphere test ask
  // 'is any part of this clump in my face', which is the question.
  float occ = occludeFadeAt(worldPosition.xyz, max(aSize.x, aSize.y) * scale);

  // Billboard in the *current* camera's basis. In the shadow pass that camera
  // is the sun, so each clump presents its full disc to the light and the
  // canopy casts a soft blob rather than a card edge.
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  worldPosition.xyz += camRight * (aCorner.x * aSize.x * scale)
                     + camUp    * (aCorner.y * aSize.y * scale);

  vec3 wn = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * aCrownN);
  vec3 transformedNormal = mat3(viewMatrix) * wn;

  vUv = uv;
  vColA = aColA;
  vColB = aColB;
  vTone = aData.y;
  vAO = aData.x;
  vN = vec4(wn, occ);
  vWorld = worldPosition.xyz;

  #ifdef USE_FOG
    vFogWorldPos = worldPosition.xyz;
    vFogCamPos = cameraPosition;
  #endif

  #include <shadowmap_vertex>
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const LEAF_FRAG = /* glsl */`
uniform sampler2D uAtlas;
uniform float uAlphaTest;
uniform float uBake;

varying vec2 vUv;
varying vec3 vColA;
varying vec3 vColB;
varying float vTone;
varying float vAO;
varying vec4 vN;           // xyz normal, w the OCCLUDE fade — see LEAF_VERT
varying vec3 vWorld;

#include <common>
#include <packing>
#include <shadowmap_pars_fragment>
#include <fog_pars_fragment>
${CANOPY_LIGHT}
${SHADOW_SAMPLE}
${CUTOUT}
${OCCLUDE_DITHER}

void main() {
  // OCCLUDE, first: this is the cheapest discard in the shader and it saves the
  // atlas fetch as well as the shading. Inert during the impostor bake, where
  // uOccAmount is unbound and reads 0.
  occludeCut(vN.w);
  vec4 t = texture2D(uAtlas, vUv);
  if (t.a < cutoutThreshold(uAlphaTest, vUv)) discard;

  // Per-mark value break-up. At 0.80 + 0.36 this spanned barely 15% and the
  // marks fused into one smooth mass — a crown read as cauliflower rather than
  // as brush strokes. The reference paints visibly different values dab to dab
  // inside a single crown; this is the only thing in the material that carries
  // that, so it has to be wide enough to see.
  float jitter = 0.62 + 0.74 * t.r;
  float core = t.g;                      // 1 deep in the clump, 0 at its rim
  // Each mark is modelled in its own right, not only positioned in the crown:
  // its rim catches light and its middle sits back. At 1.05/0.86 that was a
  // 20% swing and the marks fused; the reference paints a visible turn inside
  // every dab, which is what stops a canopy reading as one printed texture.
  float ao = clamp(vAO * mix(1.16, 0.72, core), 0.0, 1.35);

  if (uBake > 0.5) {
    // Impostor bake: encode palette weights, not colour, so a distant tree can
    // still be tinted per instance. b is reserved for bark.
    float shade = ao * jitter;
    gl_FragColor = vec4((1.0 - vTone) * shade, vTone * shade, 0.0, 1.0);
    return;
  }

  vec3 albedo = mix(vColA, vColB, vTone) * jitter;
  vec3 N = normalize(vN.xyz);
  vec3 V = normalize(vWorld - cameraPosition);
  vec3 col = canopyShade(albedo, N, V, ao, mix(1.28, 0.40, core), canopyShadow());

  gl_FragColor = vec4(col, 1.0);
  // Chunk order matters: three's own materials apply fog *before* the output
  // colour-space encode, and the atmosphere's haze colour is a linear value.
  // Encoding first and fogging second lifts a dark crown by more than 6x before
  // it is mixed with the haze, which turned every distant stand into white
  // popcorn while the near trees — where fogFactor is ~0 — looked correct.
  #include <tonemapping_fragment>
  #include <fog_fragment>
  #include <colorspace_fragment>
}
`;

const LEAF_DEPTH_VERT = /* glsl */`
attribute vec2 aCorner;
attribute vec2 aSize;
attribute vec3 aData;
attribute vec2 aWind;
varying vec2 vUv;
varying vec2 vHighPrecisionZW;
#include <common>
${WIND}
void main() {
  float scale = length(instanceMatrix[0].xyz);
  vec3 worldOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float phase = aWind.x + fract(dot(position.xz, vec2(0.1731, 0.3719))) * 6.2831853;
  float flex = aData.z * aData.z * aWind.y;
  vec3 disp = windSway(worldOrigin, flex, aWind.x) + leafFlutter(phase, aData.z * aWind.y);
  vec3 local = position + disp / max(scale, 1e-4);
  vec4 worldPosition = modelMatrix * instanceMatrix * vec4(local, 1.0);
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  worldPosition.xyz += camRight * (aCorner.x * aSize.x * scale)
                     + camUp    * (aCorner.y * aSize.y * scale);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
  vHighPrecisionZW = gl_Position.zw;
}
`;

const CUTOUT_DEPTH_FRAG = /* glsl */`
#include <packing>
uniform sampler2D uAtlas;
uniform float uAlphaTest;
varying vec2 vUv;
varying vec2 vHighPrecisionZW;
${CUTOUT}
void main() {
  if (texture2D(uAtlas, vUv).a < cutoutThreshold(uAlphaTest, vUv)) discard;
  float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;
  gl_FragColor = packDepthToRGBA(fragCoordZ);
}
`;

export function createLeafMaterial(atlas, shared, opts = {}) {
  const bake = !!opts.bake;
  const uniforms = Object.assign(
    bake ? {} : lightUniforms(), bake ? {} : fogUniforms(), bake ? {} : stylizeUniforms(),
    bake ? {} : occlusionUniforms(), shared,          // OCCLUDE
    {
      uAtlas: { value: atlas },
      uAlphaTest: { value: opts.alphaTest ?? 0.38 },
      uAtlasTexels: { value: opts.atlasTexels ?? 512 },
      uBake: { value: bake ? 1 : 0 },
    }
  );
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: LEAF_VERT,
    fragmentShader: LEAF_FRAG,
    lights: !bake,
    fog: !bake,
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
  });
  // three's shadow pass copies these onto the depth material; declaring them
  // keeps it from clobbering ours with `undefined`.
  mat.alphaTest = opts.alphaTest ?? 0.38;
  mat.shadowSide = THREE.DoubleSide;

  const depth = new THREE.ShaderMaterial({
    uniforms: Object.assign({}, shared, {
      uAtlas: { value: atlas },
      uAlphaTest: { value: (opts.alphaTest ?? 0.38) * 0.9 },
      uAtlasTexels: { value: opts.atlasTexels ?? 512 },
    }),
    vertexShader: LEAF_DEPTH_VERT,
    fragmentShader: CUTOUT_DEPTH_FRAG,
    side: THREE.DoubleSide,
  });
  return { mat, depth };
}

// ── bark ─────────────────────────────────────────────────────────────────────

const BARK_VERT = /* glsl */`
attribute vec2 aBark;      // style, wind weight
attribute vec3 aColA;      // instanced bark colour
attribute vec2 aWind;      // instanced: phase, stiffness

varying vec2 vUv;
varying vec3 vColor;
varying float vStyle;
varying vec3 vN;
varying vec3 vWorld;
varying float vHeight;

#include <common>
#include <shadowmap_pars_vertex>
#include <fog_pars_vertex>
${WIND}

void main() {
  float scale = length(instanceMatrix[0].xyz);
  vec3 worldOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  // Trunks bend, they do not flutter — half the weight of the foliage.
  vec3 disp = windSway(worldOrigin, aBark.y * aWind.y * 0.55, aWind.x);
  vec3 local = position + disp / max(scale, 1e-4);

  vec4 worldPosition = modelMatrix * instanceMatrix * vec4(local, 1.0);
  vec3 wn = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vec3 transformedNormal = mat3(viewMatrix) * wn;

  vUv = uv;
  vColor = aColA;
  vStyle = aBark.x;
  vN = wn;
  vWorld = worldPosition.xyz;
  vHeight = position.y * scale;

  #ifdef USE_FOG
    vFogWorldPos = worldPosition.xyz;
    vFogCamPos = cameraPosition;
  #endif

  #include <shadowmap_vertex>
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const BARK_FRAG_BODY = STYLIZE_PARS + /* glsl */`
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uGroundColor;
uniform float uAmbient;
uniform float uBake;

varying vec2 vUv;
varying vec3 vColor;
varying float vStyle;
varying vec3 vN;
varying vec3 vWorld;
varying float vHeight;

#include <common>
#include <packing>
#include <shadowmap_pars_fragment>
#include <fog_pars_fragment>
${SHADOW_SAMPLE}

float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

/** Smooth value noise. Bark grain has to be fibrous; a floor()ed hash is a grid. */
float vnoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h21(i), b = h21(i + vec2(1.0, 0.0));
  float c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/** One scale of birch lenticels: lens-shaped horizontal dashes on a jittered grid. */
float lenticel(vec2 uv, vec2 freq, float density, float strength) {
  vec2 g = uv * freq;
  vec2 cell = floor(g);
  vec2 f = fract(g) - 0.5;
  float r = h21(cell);
  if (r > density) return 0.0;
  f.x -= (h21(cell + 3.7) - 0.5) * 0.55;
  f.y -= (h21(cell + 9.1) - 0.5) * 0.6;
  float w = 0.16 + 0.28 * h21(cell + 5.3);      // half-length
  float t = 0.030 + 0.048 * h21(cell + 7.9);    // half-thickness at the middle
  float ex = clamp(abs(f.x) / w, 0.0, 1.0);
  float th = t * sqrt(max(0.0, 1.0 - ex * ex)); // lens profile
  return strength * smoothstep(th, th * 0.3, abs(f.y)) * (1.0 - smoothstep(0.80, 1.0, ex));
}

/**
 * A birch branch scar: the dark chevron under an old branch stub. This is the
 * mark that makes a white trunk read as *birch* rather than as a painted pole,
 * and it was missing — the bark carried lenticels only, which are a fine grain
 * and vanish past about 6 m, so at every range beyond arm's length our birches
 * were featureless sticks. In the plates the chevrons are the coarsest thing on
 * the trunk and are still legible at 30 m.
 *
 * Shape: a wide inverted V, fattest at the apex and tapering to the tips, with
 * the stub itself as a dark blot sitting inside the apex. Sparse and jittered
 * so no two trunks carry the same arrangement.
 */
float chevronScar(vec2 uv, vec2 freq, float density) {
  vec2 g = uv * freq;
  vec2 cell = floor(g);
  if (h21(cell + 17.31) > density) return 0.0;
  vec2 f = fract(g) - 0.5;
  f.x -= (h21(cell + 2.13) - 0.5) * 0.30;
  f.y -= (h21(cell + 6.47) - 0.5) * 0.60;
  // The cell is wildly anisotropic and that matters: vUv.x is 0..1 around the
  // whole trunk while vUv.y is arc length in *metres*, so at freq (2, 0.55) a
  // cell is half a circumference wide and 1.8 m tall — call it 1:10. Numbers
  // that look like a squat chevron in cell space came out as a vertical arrow
  // on the trunk. Everything below is therefore sized for that aspect: w is a
  // fraction of the circumference, rise and t are fractions of 1.8 m.
  float w = 0.20 + 0.09 * h21(cell + 4.21);          // half-width, in cell x
  float ex = abs(f.x) / w;
  float rise = 0.050 + 0.035 * h21(cell + 9.03);     // 9-15 cm of trunk
  float arch = rise * (1.0 - ex);                    // apex at the centre
  // Fat at the apex, thin at the tips — that taper is the whole read.
  float t = (0.0060 + 0.0060 * h21(cell + 11.53)) * (1.0 + 2.2 * (1.0 - ex));
  float v = smoothstep(t, t * 0.15, abs(f.y - arch));
  // The stub: a small blot just under the apex.
  float blot = 1.0 - smoothstep(0.55, 1.05,
    length(vec2(f.x / (w * 0.42), (f.y - arch * 0.30) / (rise * 0.55))));
  return clamp(max(v, blot) * (1.0 - smoothstep(0.86, 1.05, ex)), 0.0, 1.0);
}

void main() {
  // OCCLUDE, first, and only in the occluding variant of this program — see the
  // note at the top of the file for why there are two. Per FRAGMENT rather than
  // per vertex: a trunk is a five-sided tube with rings up to a metre apart, so
  // a vertex-side fade would carry the feather across the bark in flat bands,
  // and this program has already given up early-Z by containing the discard at
  // all. Being first is what makes that bearable — every discarded fragment
  // skips the noise, the lenticels and the scars below.
  #ifdef BARK_OCCLUDE
    occludeCut(occludeFadeAt(vWorld, 0.0));
  #endif
  // pat is the bark *pattern*, kept separate from the base colour so the
  // impostor bake can store shading without baking a species hue into it.
  // (Named pat, not mod: mod() is a GLSL builtin and shadowing it is illegal.)
  vec3 pat = vec3(1.0);
  float style = vStyle;

  if (style < 0.5) {
    // Birch / aspen: near-white paper bark with dark horizontal lenticels and
    // a smudged, darker base. The high-value trunk is a signature of the plates.
    // A lenticel is a lens, not a rectangle — tapering the dash at both ends is
    // the whole difference between "birch" and "trunk with black stickers".
    // vUv.y is arc length in metres, so these frequencies are per-metre: the
    // chevrons land roughly one every 1.7 m of trunk on a third of the
    // circumference, which is what the plates show.
    // One cell per circumference, so a row of the grid carries at most one
    // scar — which is what a branch scar is. Roughly one every 1.8 m, plus a
    // sparser finer octave.
    float chev = chevronScar(vUv, vec2(1.0, 0.55), 0.58)
               + chevronScar(vUv, vec2(1.0, 1.30), 0.30) * 0.85;
    float scar = lenticel(vUv, vec2(6.0, 2.6), 0.42, 1.0)
               + lenticel(vUv, vec2(11.0, 6.5), 0.30, 0.55);
    pat = mix(pat, pat * 0.20, clamp(scar, 0.0, 1.0));
    // Chevrons go darker than the lenticels and are what carries the trunk at
    // 3-30 m. 0.13 against a near-white base is srgb ~90 on srgb ~235, which is
    // the contrast plate 5 holds at that range.
    pat = mix(pat, pat * 0.13, clamp(chev, 0.0, 1.0));
    pat = mix(pat * 0.74, pat, smoothstep(0.0, 1.6, vHeight));
    pat *= 0.95 + 0.10 * h21(vUv * 40.0);
  } else if (style < 1.5) {
    // Rough bark: vertical fissures that wander up the trunk. The old version
    // took its ridge phase from floor(v * 6) and its grain from a floor()ed
    // hash grid, which at 2 m read as a woven basket rather than as bark — two
    // superimposed rectangular lattices are very hard for the eye to miss.
    // Drifting the phase with smooth noise turns the ridges into continuous
    // fibres and leaves nothing rectangular in the pattern.
    float wander = vnoise2(vec2(vUv.x * 4.5, vUv.y * 1.0)) * 3.4;
    float ridge = sin(vUv.x * 40.0 + wander) * 0.5 + 0.5;
    ridge = pow(ridge, 1.7);
    float grain = vnoise2(vec2(vUv.x * 26.0, vUv.y * 7.0));
    pat *= mix(0.45, 1.14, ridge) * (0.84 + 0.30 * grain);
  } else {
    // Conifer: dark, and *scaly* rather than merely noisy. Spruce bark is a
    // mosaic of loose plates, and at 3 m — which is where the forest anchor
    // stands — two octaves of smooth noise at 0.70+0.56 gave a value swing of
    // barely 25% on an already-dark albedo, so the near bole read as a
    // featureless red-brown pole. Sharpening one octave into plate edges and
    // widening the swing puts a readable texture on it without adding a
    // rectangular grid, which is what the previous version of the rough-bark
    // branch was rejected for.
    float flake = vnoise2(vec2(vUv.x * 13.0, vUv.y * 9.0)) * 0.62
                + vnoise2(vec2(vUv.x * 29.0, vUv.y * 24.0)) * 0.38;
    // Plate edges: the ridges of the noise field, not its value.
    float plate = smoothstep(0.42, 0.50, abs(flake - 0.5) * 2.0);
    pat *= (0.56 + 0.86 * flake) * (1.0 - 0.34 * plate);
  }

  if (uBake > 0.5) {
    gl_FragColor = vec4(0.0, 0.0, clamp(dot(pat, vec3(1.0 / 3.0)), 0.0, 1.0), 1.0);
    return;
  }

  vec3 albedo = vColor * pat;
  vec3 N = normalize(vN);
  float shadow = canopyShadow();
  float ndl = dot(N, uSunDir);
  float wrap = stylizeDiffuse(ndl) * mix(0.58, 1.0, shadow);
  vec3 key = uSunColor * wrap;
  // 1.40x on the hemisphere term, for the same reason the canopy carries
  // uCanopyAmbient > 1: uAmbient arrives as three's irradiance for a lone
  // Lambert surface, and a trunk stands in a bowl of sunlit gold meadow that
  // bounces into it from every side. Without it a conifer bole under its own
  // crown reached the grade at srgb ~25 — a flat black column with no bark on
  // it at two metres, which is the closest, most-looked-at trunk in the game.
  vec3 hemi = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5) * uAmbient * 1.40;

  if (style < 0.5) {
    // Birch is the one surface in this game the key light is not allowed to
    // tint. Near-white bark multiplied by a golden key is arithmetically tan,
    // and tan is exactly the muddy trunk the critic measured against the
    // plates' #e9e6dd signature — which those plates hold even at golden hour,
    // where every birch in frame stays paper-white with a faint cool cast.
    // Pulling the *light* toward neutral for this bark style (not the albedo,
    // which would flatten the scars) is what keeps the trunk high-value while
    // its lenticels, its taper and its shading all still read.
    //
    // What "neutral" means here had drifted. #e9e6dd is srgb(233,230,221) —
    // a ratio of 1 : 0.987 : 0.949, which is *warm* neutral, a paper cream. The
    // previous target (1 : 0.99 : 0.97 on the key, and a blue-pushed ambient
    // below) put the trunk on the cool side of grey, and cool grey plus this
    // game's violet cast-shadow mass is the "pale blue-grey" the trunks were
    // measuring. Neutralise the *hue* of the key, then re-tint it to the plate
    // colour rather than to nothing.
    float kl = dot(key, vec3(0.2126, 0.7152, 0.0722));
    key = mix(key, vec3(kl * 1.030, kl * 1.005, kl * 0.965), 0.93) * 1.10;
    // Paper bark is a very strong diffuse reflector and it stands in a gold
    // meadow that bounces into it, so its shaded side never falls anywhere near
    // as far as a brown trunk's. In the plates a birch is near-white on *both*
    // sides and the scars carry the form; without this lift ours went to srgb
    // 120 in shade and read as a grey stick.
    // The 1.95x lift and the 1.12 blue push were both compensation for the
    // trunk tubes being wound against their own normals: the visible wall was
    // the far one, its normal faced away from the camera, so the key never
    // landed and the only thing holding the trunk up was ambient — which in
    // this game is ambientSky #7d94c9, a cool blue. Turn a blue fill up
    // twice over and you get a blue-grey stick. With the winding fixed the key
    // arrives, so the ambient only has to keep the *shaded* side of a paper
    // trunk from falling as far as a brown one's, and it can keep the plates'
    // faint cool cast instead of being made of it.
    float hl = dot(hemi, vec3(0.2126, 0.7152, 0.0722));
    hemi = mix(hemi, vec3(hl * 0.995, hl * 1.010, hl * 1.065), 0.88) * 1.34;
  }
  vec3 V = normalize(vWorld - cameraPosition);
  // Shared golden-hour rim, same opt-in as the canopy. A trunk is a solid with
  // an honest normal, so this one takes the documented form directly (viewDir
  // is -V, pointing surface -> camera). It is added to the light, never
  // multiplied by the bark colour: a conifer's near-black bark needs the rim
  // more than a birch does, and through the albedo it would get it least.
  float rim = stylizeRim(dot(N, -V), dot(-V, uSunDir))
            * (style < 0.5 ? 3.0 : 5.0) * mix(0.5, 1.0, shadow);

  vec3 col = albedo * (key + hemi) + uSunColor * rim;
  gl_FragColor = vec4(col, 1.0);
  // Chunk order matters: three's own materials apply fog *before* the output
  // colour-space encode, and the atmosphere's haze colour is a linear value.
  // Encoding first and fogging second lifts a dark crown by more than 6x before
  // it is mixed with the haze, which turned every distant stand into white
  // popcorn while the near trees — where fogFactor is ~0 — looked correct.
  #include <tonemapping_fragment>
  #include <fog_fragment>
  #include <colorspace_fragment>
}
`;

const BARK_DEPTH_VERT = /* glsl */`
attribute vec2 aBark;
attribute vec2 aWind;
varying vec2 vHighPrecisionZW;
#include <common>
${WIND}
void main() {
  float scale = length(instanceMatrix[0].xyz);
  vec3 worldOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 disp = windSway(worldOrigin, aBark.y * aWind.y * 0.55, aWind.x);
  vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position + disp / max(scale, 1e-4), 1.0);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
  vHighPrecisionZW = gl_Position.zw;
}
`;

const OPAQUE_DEPTH_FRAG = /* glsl */`
#include <packing>
varying vec2 vHighPrecisionZW;
void main() {
  float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;
  gl_FragColor = packDepthToRGBA(fragCoordZ);
}
`;

/**
 * @param opts.bake     impostor-bake variant: no lights, no fog, no occlusion.
 * @param opts.occlude  the discarding variant. Costs early-Z on the whole
 *                      program — see the note at the top of this file — so a mesh
 *                      is only swapped onto it while something it draws is
 *                      actually between the lens and the camper.
 */
export function createBarkMaterial(shared, opts = {}) {
  const bake = !!opts.bake;
  const occlude = !bake && !!opts.occlude;      // OCCLUDE
  const mat = new THREE.ShaderMaterial({
    uniforms: Object.assign(
      bake ? {} : lightUniforms(), bake ? {} : fogUniforms(), bake ? {} : stylizeUniforms(),
      occlude ? occlusionUniforms() : {}, shared,          // OCCLUDE
      { uBake: { value: bake ? 1 : 0 } }),
    vertexShader: BARK_VERT,
    // OCCLUDE. The pars and the dither are concatenated in only for the
    // occluding variant, so the plain program does not so much as declare the
    // uniform block and stays byte-for-byte the shader that shipped.
    fragmentShader: (occlude
      ? `${OCCLUDE_PARS}\n${OCCLUDE_DITHER}\n#define BARK_OCCLUDE\n`
      : '') + BARK_FRAG_BODY,
    lights: !bake,
    fog: !bake,
    side: THREE.FrontSide,
  });
  const depth = new THREE.ShaderMaterial({
    uniforms: Object.assign({}, shared),
    vertexShader: BARK_DEPTH_VERT,
    fragmentShader: OPAQUE_DEPTH_FRAG,
    side: THREE.FrontSide,
  });
  return { mat, depth };
}

// ── distant impostor ─────────────────────────────────────────────────────────
//  One quad carrying a baked front view of the species. The bake stores palette
//  *weights* (r = colour A, g = colour B, b = bark) rather than colour, so a
//  distant stand still varies tree to tree, and it is shaded at runtime with
//  the same canopy model as the near geometry — which is what stops the LOD
//  change from reading as a colour pop.

const IMP_VERT = /* glsl */`
attribute vec2 aCorner;
attribute vec3 aColA;
attribute vec3 aColB;
attribute vec3 aColC;
attribute vec3 aImp;     // tile index, height (m), half-width (m)
attribute vec2 aWind;

varying vec2 vUv;
varying vec3 vColA;
varying vec3 vColB;
varying vec3 vColC;
varying vec3 vN;
varying vec3 vWorld;
varying float vFade;

#include <common>
#include <fog_pars_vertex>
${WIND}

uniform float uTileCount;
uniform float uFadeStart;
uniform float uFadeEnd;

void main() {
  vec3 base = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  // Cylindrical billboard: yaw toward the camera but keep the trunk vertical,
  // otherwise a hillside of impostors visibly tips as the camera pitches.
  vec3 toCam = cameraPosition - base;
  vec3 right = normalize(vec3(-toCam.z, 0.0, toCam.x));

  vec3 world = base
             + right * (aCorner.x * aImp.z)
             + vec3(0.0, aCorner.y * aImp.y, 0.0)
             + windSway(base, aCorner.y * aCorner.y * aWind.y * 0.5, aWind.x);

  float tile = aImp.x;
  vUv = vec2((tile + uv.x) / uTileCount, uv.y);
  vColA = aColA; vColB = aColB; vColC = aColC;
  vWorld = world;
  // A spherical-ish normal across the card keeps the mass turning in the light.
  vec3 nrm = normalize(right * (aCorner.x * 0.85)
                     + vec3(0.0, (aCorner.y - 0.55) * 0.5, 0.0)
                     + normalize(vec3(toCam.x, 0.0, toCam.z)) * 0.6);
  vN = nrm;
  vFade = 1.0 - smoothstep(uFadeStart, uFadeEnd, length(toCam));

  vec4 worldPosition = vec4(world, 1.0);
  #ifdef USE_FOG
    vFogWorldPos = world;
    vFogCamPos = cameraPosition;
  #endif
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const IMP_FRAG = /* glsl */`
uniform sampler2D uAtlas;
uniform float uAlphaTest;
varying vec2 vUv;
varying vec3 vColA;
varying vec3 vColB;
varying vec3 vColC;
varying vec3 vN;
varying vec3 vWorld;
varying float vFade;

#include <common>
#include <packing>
#include <fog_pars_fragment>
${CANOPY_LIGHT}
${CUTOUT}

void main() {
  vec4 t = texture2D(uAtlas, vUv);
  // Dissolve rather than pop: raising the cutout toward opaque as the card
  // reaches the draw distance eats the crown away from its thinnest marks
  // inward, which reads as a tree receding into haze.
  if (t.a < mix(1.02, cutoutThreshold(uAlphaTest, vUv), vFade)) discard;
  // The bake stores palette *weights*, and the mip chain averages them. Summing
  // the weighted colours means a minified texel whose weights total more than
  // one comes out brighter than any colour in the palette — and because the
  // near-white bark channel bleeds across the crown as the tile shrinks, that
  // is precisely what turned every distant birch stand into white popcorn.
  // Normalise by the total weight so the sum is a weighted *average*: hue then
  // survives minification and only the shading term varies with coverage.
  float w = t.r + t.g + t.b;
  vec3 albedo = (t.r * vColA + t.g * vColB + t.b * vColC) / max(w, 1e-3);
  // The haze desaturates by 0.72 x fogFactor, which is the shared depth cue and
  // not ours to change — but a canopy starts far less saturated than the gold
  // ground beside it, so it hits neutral grey while the meadow is still orange.
  // Pushing chroma before the haze eats it keeps a distant stand reading as
  // sage-green or dusty rust rather than as grey cones on an orange hill.
  albedo = mix(vec3(dot(albedo, vec3(0.2126, 0.7152, 0.0722))), albedo, 1.22);
  float ao = clamp(w * 0.95, 0.16, 1.0);
  vec3 N = normalize(vN);
  vec3 V = normalize(vWorld - cameraPosition);
  // A card has no shadow varyings, so the shadow term is a constant — and it is
  // deliberately well below 1. A stand seen at 400 m is mostly self-shadowed
  // canopy plus whatever the hillside is casting over it; lighting it as fully
  // exposed is what makes a far treeline sit *above* the meadow in value
  // instead of below it, which no landscape ever does. Transmission is pulled
  // back for the same reason: a crown that glows at 600 m has no depth.
  vec3 col = canopyShade(albedo, N, V, ao, 0.34, 0.72) * 0.86;
  gl_FragColor = vec4(col, 1.0);
  // Chunk order matters: three's own materials apply fog *before* the output
  // colour-space encode, and the atmosphere's haze colour is a linear value.
  // Encoding first and fogging second lifts a dark crown by more than 6x before
  // it is mixed with the haze, which turned every distant stand into white
  // popcorn while the near trees — where fogFactor is ~0 — looked correct.
  #include <tonemapping_fragment>
  #include <fog_fragment>
  #include <colorspace_fragment>
}
`;

export function createImpostorMaterial(atlas, shared, tileCount, fade, texels = 960) {
  const mat = new THREE.ShaderMaterial({
    uniforms: Object.assign(fogUniforms(), stylizeUniforms(), shared, {
      uAtlas: { value: atlas },
      uAlphaTest: { value: 0.45 },
      uAtlasTexels: { value: texels },
      uTileCount: { value: tileCount },
      uFadeStart: { value: fade[0] },
      uFadeEnd: { value: fade[1] },
    }),
    vertexShader: IMP_VERT,
    fragmentShader: IMP_FRAG,
    fog: true,
    side: THREE.DoubleSide,
  });
  return { mat, depth: null };
}
