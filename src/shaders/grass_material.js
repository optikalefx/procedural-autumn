// ─────────────────────────────────────────────────────────────────────────────
//  Grass blade material.
//
//  A MeshStandardMaterial hijacked at compile time (same trick as
//  TerrainMaterial) so we keep three's shadow receiving, the shared atmosphere
//  fog and the hemisphere fill, while driving the blade's *shape* entirely from
//  the vertex shader and its *look* from a handful of art-directed rules:
//
//    · one shared blade strip, bent along a length-preserving arc
//    · a coherent, travelling wind field  (gusts you can watch cross a meadow)
//    · vertical colour gradient — dark olive root, hot amber tip
//    · shading normal blended toward the terrain normal so a million slivers
//      shade as one soft surface instead of salt-and-pepper noise
//    · thin-sheet translucency so backlit grass glows, which at golden hour is
//      the defining image of the game
//    · a distance-driven *density* fade (never a height fade) so LOD rings
//      hand over to each other without a pop
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { stylizeUniforms, STYLIZE_PARS } from '../render/Stylize.js';
import { PALETTE } from '../world/WorldConfig.js';
import { campSite, CAMP_CLEARING_GLSL } from '../camp/camp_clearing.js';

/**
 * Shared blade strip. Local `position` carries (side, v, 0):
 *   side ∈ [-1,1] across the blade, v ∈ [0,1] along it.
 * The last row collapses to a single tip vertex so the silhouette comes to a
 * point rather than a chisel end.
 *
 * `tipBias` < 1 packs the rows toward the tip. This is not a nicety. With three
 * segments at uniform spacing the top third of the blade is one unbroken
 * straight-sided quad, and both of the things that give a blade its outline —
 * the taper and the arc — do nearly all their work inside it. What rasterised
 * was a straight-sided isoceles triangle with its base on the dirt, which is
 * precisely what the near field was judged as. Vertices have to be where the
 * curvature is.
 */
export function makeBladeGeometry(segments, tipBias = 1.0) {
  const pos = [];
  for (let i = 0; i < segments; i++) {
    const v = Math.pow(i / segments, tipBias);
    pos.push(-1, v, 0, 1, v, 0);
  }
  pos.push(0, 1, 0);                       // tip

  const idx = [];
  for (let i = 0; i < segments - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const last = (segments - 1) * 2;
  idx.push(last, segments * 2, last + 1);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

// Shared art-direction uniforms — one object, referenced by every ring's
// material, so a tweak moves the whole field at once.
export function makeGrassUniforms() {
  return {
    uTime:        { value: 0 },
    // Shared by reference with camp_clearing.js — Camp.js writes it, every ring
    // reads it, and there is deliberately only one clearing in the world.
    uCampSites:    campSite.uCampSites,
    uCampAim:      campSite.uCampAim,
    uCampAimFloor: campSite.uCampAimFloor,
    uSunDir:      { value: new THREE.Vector3(0.4, 0.6, 0.3) },
    uSunColor:    { value: new THREE.Color(1, 0.88, 0.72) },

    // Wind: a low-frequency gust envelope advected across the world, plus a
    // fast flutter that only bites where the gust is already strong.
    uWindDir:     { value: new THREE.Vector2(0.86, 0.51) },
    uWindSpeed:   { value: 5.6 },     // m/s the gust *pattern* travels
    uWindBase:    { value: 0.16 },    // constant lean, radians at the tip
    uWindGust:    { value: 0.62 },    // extra lean at the crest of a gust
    uFlutter:     { value: 0.085 },

    // Colour — anchored on PALETTE so the blades and the terrain shader that
    // paints underneath them are mixing the same four pigments.
    uGold:        { value: PALETTE.grassGoldLit.clone() },
    uOlive:       { value: PALETTE.grassOlive.clone() },
    uDry:         { value: PALETTE.grassDry.clone() },
    // A *pale* straw, not a hot amber. The tip pigment is what sets the top of
    // the field's value range, and a saturated tip drives chromaMean well past
    // the 0.28–0.42 the reference plates measure — the reference's brightest
    // grass is nearly cream, not nearly orange.
    // Reference meadow gold measures #f0ad46. The previous straw (#f9cd82) is a
    // full step paler and less saturated, and with uTipBias below 1 it carried
    // most of the way down every blade — which is why the field read as beige
    // sand rather than amber however the grade was tuned.
    uTipCol:      { value: new THREE.Color().setHex(0xf2b455, THREE.SRGBColorSpace) },
    // Transmission has its own pigment. It used to be derived from uTipCol,
    // which meant that paling the tip to fix chroma also drained the colour out
    // of the backlit glow — and backlit grass at golden hour is the defining
    // image of this game, so it gets its own hot amber and its own dial.
    uGlowCol:     { value: new THREE.Color().setHex(0xffa235, THREE.SRGBColorSpace) },
    // A deep ochre, not a brown: a brown root turns the band of field 5–20 m
    // out — where you look down into the canopy — into mud. Slightly duller
    // than PALETTE.grassGoldDeep, which is pure enough to clip red on its own.
    uRootCol:     { value: new THREE.Color().setHex(0xc57f3e, THREE.SRGBColorSpace) },
    // Warm, not violet. The CORRECTION section measured blue/violet/magenta at
    // ~1% of the reference's chromatic pixels; the cool note in this game
    // belongs to distant rock and to Atmosphere's haze, not to every shaded
    // blade. A shadow on gold meadow is a warm semi-transparent shape.
    uShadowTint:  { value: new THREE.Vector3(1.06, 0.97, 0.88) },

    uOliveMax:    { value: 0.78 },    // olive is an accent; gold always shows through
    uRootMix:     { value: 0.30 },    // how far the base drifts to uRootCol
    // Raised with uTipBias: confining the pale straw to the top of the blade
    // only reads as a ladder if the top is actually paler than it used to be.
    uTipMix:      { value: 0.54 },
    // Exponent on the root->tip mix. Below 1 the tip pigment carries most of
    // the way down the blade, which was the right call when a blade was a wide
    // wedge whose lower half was a large area of screen. Now that it is a hair,
    // that same setting flattened the whole blade to one pale value and the
    // root-to-tip ladder — which the critic names explicitly — stopped existing
    // at 2 m. Above 1 the pale straw is confined to the top third and the mid
    // and lower blade keep the base gold, so each blade has a value gradient
    // again and the field gets its internal structure back.
    //
    // Measured, because the first attempt overshot: a matched A/B on the fixed
    // meadow low view went srgb(160,129,55) -> srgb(135,103,45) at 1.30, a 16%
    // luma drop across the whole near field. The ladder is worth having; a dark
    // meadow is not, and the brief's floor is explicit about it. 1.05 keeps most
    // of the gradient and the tip pigment below carries the top of the range
    // instead of the exponent doing it.
    uTipBias:     { value: 1.05 },
    uBaseAO:      { value: 0.86 },    // occlusion at the blade root
    uAOHeight:    { value: 0.24 },    // how far up the blade that occlusion reaches
    // How far the shading normal is pulled from the blade's own face toward
    // the terrain normal. This is the single most important number in the file:
    // at low values every blade lights independently and a near field resolves
    // into bright-facing and near-black-facing blades — salt and pepper, and a
    // dead maroon mass wherever the sun is off to one side. High values make
    // the field shade as one soft surface, which is what the reference does.
    uNormalUp:    { value: 0.82 },    // blend of face normal -> terrain normal
    uCurve:       { value: 0.12 },    // cross-blade rounding of the normal
    // How far the bend is pushed up the blade. 0 is a circular arc — constant
    // curvature, the base tilting as much as the tip, which is the shape that
    // read as a shard. 1 puts the turn almost entirely in the top third.
    uCurl:        { value: 0.74 },
    uTrans:       { value: 2.10 },    // backlit translucency strength
    uTransPow:    { value: 1.6 },     // lower = the glow spreads over more of the field
    uSheen:       { value: 0.26 },
    // Lift multiplies before tone mapping, so pushing it hard does not make the
    // field brighter so much as clip the red channel — which is what took
    // chromaMean past 0.47 against a reference that measures 0.31.
    uLift:        { value: 1.06 },
    ...stylizeUniforms(),
    uWrap:        { value: 0.78 },    // wrapped diffuse: a blade scatters light

    // getShadowMask() is the *raw* 0/1 mask — it knows nothing about the
    // global sun.shadow.intensity (~0.52) that keeps this game's shadows
    // warm and semi-transparent. Multiplying the translucency / wrap / sheen
    // terms by it switched them fully off under any canopy, which is what
    // turned the shadowed midground into a maroon hole. Attenuate instead.
    uShadowSoft:  { value: 0.68 },

    // Sky fill. Measured on grass-only crops, our blades carried chroma ~0.72
    // where the reference plates measure 0.35–0.54 at comparable luminance —
    // the difference is almost entirely the blue channel, because sunlight at
    // this hour has very little blue in it and nothing else was reaching the
    // field. Real grass is also lit from the whole sky dome; adding that back
    // lowers chroma, lifts the shaded field, and gives the cool complementary
    // note the brief asks for without tinting any shadow violet.
    uSkyCol:      { value: new THREE.Color().setHex(0xa9c6e8, THREE.SRGBColorSpace) },
    uSkyFill:     { value: 0.14 },
    // Grass-only crops measure chroma ~0.60 where the reference plates measure
    // 0.35–0.54 at the same luminance, so this wants to be higher. It is not,
    // deliberately: at 0.20 the field went visibly duller than the terrain it
    // stands on, and a pale grass mat on vivid orange ground is a worse defect
    // than being over-saturated in company. The whole game grades hotter than
    // the plates (bare-terrain frames measure ~0.48 too); that is a global
    // grade question, logged in INTEGRATION_REQUESTS.md, not one grass should
    // solve unilaterally.
    uDesat:       { value: 0.07 },

    uDebug:       { value: 0 },       // see the diagnostics block in the fragment

    // Screen-space minimum blade width (world units per pixel at 1 m).
    // Distant blades thinner than a pixel are what makes grass crawl.
    uPxWorld:     { value: 0.0016 },
  };
}

const VERT_HEAD = /* glsl */`
attribute vec3 aPos;    // blade base, relative to the tile origin (y is world)
attribute vec4 aShape;  // height, width, static bend, phase
attribute vec4 aTint;   // yaw, tone(gold->olive), dryness, per-clump shade
attribute vec3 aMisc;   // terrain normal x, terrain normal z, fade rank

uniform float uTime;
uniform vec2  uWindDir;
uniform float uWindSpeed;
uniform float uWindBase;
uniform float uWindGust;
uniform float uFlutter;
uniform float uNormalUp;
uniform float uCurve;
uniform float uCurl;
uniform float uPxWorld;
uniform vec2  uFadeIn;    // ring hand-off: 0 blades below x, all above y
uniform vec2  uFadeOut;   // far edge: all blades below x, none above y
uniform float uWidthGain; // per-ring widening so far blades stay >1px

varying vec3  vWorldPos;
varying vec3  vFaceN;
varying vec3  vUpN;
varying float vT;
varying float vTone;
varying float vDry;
varying float vShade;
varying float vGust;

${CAMP_CLEARING_GLSL}

float gHash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float gNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash21(i), gHash21(i + vec2(1.0, 0.0)), f.x),
             mix(gHash21(i + vec2(0.0, 1.0)), gHash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

const VERT_BODY = /* glsl */`
  vec3 basePos = ( modelMatrix * vec4( aPos, 1.0 ) ).xyz;
  float dCam = distance( basePos, cameraPosition );

  // ── density fade ────────────────────────────────────────────────────────
  // Fading *height* makes a visible band of mown lawn at the LOD seam; fading
  // the *number* of blades reads as the field naturally thinning out. Each
  // blade owns a rank in [0,1] and pops out at its own distance.
  float cover = min( smoothstep( uFadeIn.x, uFadeIn.y, dCam ),
                     1.0 - smoothstep( uFadeOut.x, uFadeOut.y, dCam ) );
  float grow = smoothstep( aMisc.z - 0.22, aMisc.z + 0.02, cover );

  // ── the camp clearing ───────────────────────────────────────────────────
  // Stochastic removal, so the clearing thins out blade by blade instead of
  // mowing the field to an even stubble. The draw is aShape.w — the blade's
  // wind phase, an independent uniform in [0,1) — and NOT aMisc.z, the LOD
  // rank, which was the first attempt and did not work: grow thresholds cover
  // against a *window* around the rank, so a rank-0 blade survives a cover of
  // zero. The camp was pitched in knee-deep grass and the capture said so.
  //
  // The threshold is remapped past both ends of [0,1] rather than used raw,
  // for the same reason: at camp cover exactly 0 every blade must go, and a
  // smoothstep centred on a draw of 0.0 returns 0.5 at 0.0. 1.24/-0.12 gives
  // both ends a margin wider than the transition band.
  float campT = campCover( basePos.xz ) * 1.24 - 0.12;
  grow *= smoothstep( aShape.w - 0.06, aShape.w + 0.06, campT );

  float t    = position.y;
  float side = position.x;

  float bh = aShape.x * grow;
  // Never let a blade fall under a pixel wide — sub-pixel slivers are what
  // turns a distant meadow into crawling static.
  float bw = grow * max( aShape.y, dCam * uPxWorld * ( 1.0 + uWidthGain ) );

  // ── wind: a coherent field, advected, not per-blade noise ───────────────
  vec2 flow = basePos.xz - uWindDir * ( uTime * uWindSpeed );
  float gust = gNoise( flow * 0.017 ) * 0.65 + gNoise( flow * 0.058 + 31.7 ) * 0.35;
  gust = smoothstep( 0.22, 0.82, gust );          // crisper wave fronts
  vGust = gust;

  float breeze = uWindBase + gust * uWindGust;
  // Flutter is small and gated by the gust, otherwise the whole field jellies.
  float flut = sin( uTime * 5.1 + aShape.w * 39.5 ) * 0.6
             + sin( uTime * 9.3 - aShape.w * 61.2 ) * 0.4;
  // ── the blade's own frame ───────────────────────────────────────────────
  // A blade is a thin sheet: stiff in its own plane, floppy across it. So it
  // bends about its *width* axis, and that axis belongs to the blade, not to
  // the weather.
  //
  // The old code derived the width axis from the wind-blended lean direction,
  // which meant that at the crest of a gust — mix factor up to 0.72 toward a
  // single world wind vector — most of the field rotated its broad face into
  // alignment and every blade presented the same profile at once. That reads
  // as a stamped pattern rather than a stand of grass, and it is worst exactly
  // where the player is, because near blades are the only ones you can resolve
  // individually. It also made yaw unstable for blades lying against the wind,
  // where normalize() of a nearly-cancelling sum flips.
  //
  // Yaw is now fixed to the blade for its whole life. Only the *amount* of
  // bend follows the wind.
  vec2 ownDir = vec2( sin( aTint.x ), cos( aTint.x ) );
  vec3 lean3 = vec3( ownDir.x, 0.0, ownDir.y );
  vec3 side3 = vec3( ownDir.y, 0.0, -ownDir.x );

  // Terrain normal, and the direction the blade actually grows: mostly up,
  // leaned a little into the slope so hillside grass does not look glued on.
  float nx = aMisc.x, nz = aMisc.y;
  vec3 upN = normalize( vec3( nx, sqrt( max( 1.0 - nx * nx - nz * nz, 0.04 ) ), nz ) );
  vec3 growDir = normalize( mix( vec3( 0.0, 1.0, 0.0 ), upN, 0.38 ) );
  // The arc below only preserves length if its two basis vectors are
  // perpendicular. On a 30-degree slope growDir tilts ~11 degrees off vertical
  // and a purely horizontal lean3 costs the blade up to 10% of its length —
  // which showed on the 'vehicle' hillside as grass mysteriously shorter than
  // the grass beside it. lean3 is horizontal and growDir is within ~11 degrees
  // of up, so they can never be parallel and this normalize is always safe.
  lean3 = normalize( lean3 - growDir * dot( lean3, growDir ) );

  // ── how hard it bends ───────────────────────────────────────────────────
  // A blade lying along the wind is pushed over; one lying across it is barely
  // touched; one facing into it is straightened. Signing the gust by that
  // alignment is what lets a gust read as a wave crossing the field while
  // every blade keeps its own facing.
  float align = dot( ownDir, uWindDir );
  float bend = aShape.z + breeze * ( 0.62 + 0.38 * aShape.w ) * ( 0.34 + 0.66 * align )
             + flut * uFlutter * gust;
  bend = clamp( bend, -0.34, 1.55 );

  // ── the spine: curvature that grows toward the tip ──────────────────────
  // A circular arc has *constant* curvature, so a blade drawn on one is a
  // straight line with a slight tilt — its base leans exactly as much as its
  // tip, and at three vertices the sagitta is invisible. Real dry grass is
  // stiff at the sheath and floppy at the tip: the whole turn is concentrated
  // in the top third, and that asymmetry is what the eye reads as grass rather
  // than as a spike.
  //
  // phi(s) is therefore superlinear in s, and the spine is the integral of a
  // *unit* tangent, so a blade still cannot get shorter by bending. Simpson
  // over three samples is exact to well under a millimetre for a turn of a
  // radian and a half, and costs one extra sin/cos pair per vertex. It also
  // removes the old form's division by 'bend', which is why that one needed a
  // hard 0.03 floor and could never straighten or reverse.
  float phiH = bend * ( t * 0.5 ) * mix( 1.0, t * 0.5, uCurl );
  float phiT = bend * t * mix( 1.0, t, uCurl );
  float sH = sin( phiH ), cH = cos( phiH );
  float sT = sin( phiT ), cT = cos( phiT );
  float q = bh * t * ( 1.0 / 6.0 );
  vec3 spine = lean3   * ( q * ( 4.0 * sH + sT ) )
             + growDir * ( q * ( 1.0 + 4.0 * cH + cT ) );

  // ── the outline ─────────────────────────────────────────────────────────
  // The old profile was pow(1-t, 0.42): widest at the ground, near-straight
  // sided, sampled at three rows. A real blade is narrow at the sheath, widest
  // about a fifth of the way up, then a long concave taper to a hair. Pulling
  // the base in is what stops each blade reading as a shard planted in dirt —
  // the wide base corners were half of the triangle silhouette.
  float taper = pow( max( 1.0 - t, 0.0 ), 0.44 )
              * ( 0.58 + 0.42 * smoothstep( 0.0, 0.24, t ) );
  vec3 bladePos = aPos + spine + side3 * ( side * bw * 0.5 * taper );

  vec3 tangent = lean3 * sT + growDir * cT;      // unit: the basis is orthonormal
  vec3 faceN = normalize( cross( side3, tangent ) );
  faceN = normalize( faceN + side3 * ( side * uCurve ) );   // cup across the blade

  vWorldPos = ( modelMatrix * vec4( bladePos, 1.0 ) ).xyz;
  vFaceN = faceN;
  vUpN = upN;
  vT = t;
  vTone = aTint.y;
  vDry = aTint.z;
  vShade = aTint.w;

  vec3 objectNormal = normalize( mix( faceN, upN, uNormalUp ) );
`;

const FRAG_HEAD = STYLIZE_PARS + /* glsl */`
uniform vec3  uGold;
uniform vec3  uOlive;
uniform vec3  uDry;
uniform vec3  uTipCol;
uniform vec3  uGlowCol;
uniform vec3  uSkyCol;
uniform vec3  uRootCol;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uShadowTint;
uniform float uOliveMax;
uniform float uRootMix;
uniform float uTipMix;
uniform float uTipBias;
uniform float uBaseAO;
uniform float uAOHeight;
uniform float uNormalUp;
uniform float uTrans;
uniform float uTransPow;
uniform float uShadowSoft;
uniform float uSkyFill;
uniform float uDesat;
uniform float uDebug;
uniform float uSheen;
uniform float uWrap;
uniform float uLift;
uniform float uAOScale;

varying vec3  vWorldPos;
varying vec3  vFaceN;
varying vec3  vUpN;
varying float vT;
varying float vTone;
varying float vDry;
varying float vShade;
varying float vGust;
`;

/**
 * @param {object} shared  uniforms from makeGrassUniforms(), shared by all rings
 * @param {object} ring    { fadeIn:[a,b], fadeOut:[a,b], widthGain:number }
 */
export function createGrassMaterial(shared, ring) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0.0,
    side: THREE.DoubleSide,
    dithering: true,
  });

  const uniforms = Object.assign({}, shared, {
    uFadeIn:    { value: new THREE.Vector2(ring.fadeIn[0], ring.fadeIn[1]) },
    uFadeOut:   { value: new THREE.Vector2(ring.fadeOut[0], ring.fadeOut[1]) },
    uWidthGain: { value: ring.widthGain ?? 0 },
    uAOScale:   { value: ring.aoScale ?? 1 },
  });
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    mat.userData.shader = shader;

    shader.vertexShader = VERT_HEAD + shader.vertexShader
      .replace('#include <beginnormal_vertex>', VERT_BODY)
      .replace('#include <begin_vertex>', 'vec3 transformed = bladePos;');

    shader.fragmentShader = FRAG_HEAD + shader.fragmentShader
      // getShadowMask() needs the shadow uniforms, so define it after them.
      .replace('#include <shadowmap_pars_fragment>',
        '#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>')

      // The shading normal always faces the viewer (a blade is a thin sheet)
      // but is pulled most of the way to the terrain normal, so the field
      // shades as one soft surface.
      .replace('#include <normal_fragment_begin>', /* glsl */`
        float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
        vec3 gFace = normalize( vFaceN ) * faceDirection;
        vec3 normal = normalize( mix( gFace, normalize( vUpN ), uNormalUp ) );
        vec3 nonPerturbedNormal = normal;
      `)

      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        {
          // Gold always shows through: the terrain shader under these blades
          // never mixes more than ~45% olive, and a blade that goes fully olive
          // reads as a different plant sitting on gold ground.
          vec3 base = mix( uGold, uOlive, vTone * uOliveMax );
          base = mix( base, uDry, vDry * 0.78 );
          // Vertical gradient: this single move does more for the look than
          // any amount of lighting work — deep orange root, hot amber tip.
          // At range the root darkening has to go: a dark blade base over gold
          // ground is what turns a distant meadow into speckle instead of a
          // continuous field. uAOScale rolls it off ring by ring.
          vec3 rootC = mix( base, uRootCol, uRootMix * uAOScale );
          vec3 tipC  = mix( base, uTipCol, uTipMix );
          // pow(,<1) carries the warm tip colour a long way down the blade. A
          // linear (or smoothstep) ramp leaves the middle two-thirds at base
          // colour, which is what put a dead olive band across the midground.
          // max(), because vT is a varying and a varying can land a hair outside
          // the range its vertices span. pow(negative, 0.42) is NaN, and one NaN
          // pixel is not a dead pixel: the bloom mip chain averages it outward
          // until a whole block of the frame is NaN, which renders as the
          // hard-edged black square players reported. Measured: a single
          // fragment at the blade root, spread to 76x68 px at 1280x720.
          vec3 col = mix( rootC, tipC, pow( max( vT, 0.0 ), uTipBias ) );
          // Occlusion at the root grounds the field into the terrain. Keep it
          // *shallow* — deep enough to read as contact, not so deep that
          // looking down into the canopy shows a brown floor.
          col *= mix( mix( 1.0, uBaseAO, uAOScale ), 1.0, smoothstep( 0.0, uAOHeight, vT ) );
          col *= vShade * uLift;
          col = mix( col, vec3( dot( col, vec3( 0.2126, 0.7152, 0.0722 ) ) ), uDesat );
          diffuseColor.rgb *= col;
        }`)

      .replace('#include <tonemapping_fragment>', /* glsl */`
        {
          vec3 V = normalize( cameraPosition - vWorldPos );
          vec3 L = normalize( uSunDir );
          float shRaw = getShadowMask();
          // Shadow does not extinguish scattered light; it dims it. A blade in
          // a tree's shadow at golden hour still glows, just less.
          float sh = mix( uShadowSoft, 1.0, shRaw );

          // ── thin-sheet translucency: the money shot at golden hour ───────
          // Light transmitted through a blade leaves roughly along -L, so the
          // glow peaks when the camera is looking into the sun.
          float back = clamp( dot( -V, L ), 0.0, 1.0 );
          // A tight lobe confines the glow to a few degrees around the sun, but
          // a field you are driving *into* lights up right across the frame. So
          // the view lobe is broad, and the per-blade term does the shaping:
          // a blade whose face is turned away from the sun is the one you see
          // light through.
          float thru = clamp( -dot( gFace, L ), 0.0, 1.0 );
          float trans = pow( back, uTransPow ) * ( 0.40 + 0.60 * thru );
          trans *= mix( 0.30, 1.0, smoothstep( 0.02, 0.70, vT ) );   // tips are thinner
          trans *= 1.0 - 0.45 * clamp( dot( normalize( vUpN ), L ), 0.0, 1.0 );
          vec3 glowCol = mix( uGlowCol, uSunColor, 0.35 );
          gl_FragColor.rgb += glowCol * ( trans * uTrans * sh * diffuseColor.rgb * 2.2 );

          // ── sky fill ────────────────────────────────────────────────────
          // A blade sees more of the sky the higher up it is; the root sees the
          // ground. That gradient doubles as a soft ambient occlusion, which is
          // why the explicit uBaseAO term can stay as shallow as it is.
          float skyAcc = 0.28 + 0.72 * smoothstep( 0.0, 0.55, vT );
          // Flattened toward neutral before tinting, so what is added really is
          // sky-coloured light and not just more of the blade's own orange.
          gl_FragColor.rgb += mix( diffuseColor.rgb, vec3( 0.60 ), 0.55 )
                            * uSkyCol * ( uSkyFill * skyAcc );

          // ── wrapped diffuse ─────────────────────────────────────────────
          // A blade is a thin scatterer, not a Lambertian chip. Without this
          // the field goes to mud the moment the sun drops toward the horizon
          // — exactly the hour this game is set at.
          // Shared stylised response, so the field carries the same diffuse
          // floor and banding as everything else. A local wrap with no floor
          // let shaded grass fall to a hole that the global grade then had to
          // lift the whole image to rescue.
          float wrapN = stylizeDiffuse( dot( normalize( vUpN ), L ) );
          gl_FragColor.rgb += diffuseColor.rgb * uSunColor * ( wrapN * uWrap * sh );

          // ── sheen: raking light picks the field out in bands ─────────────
          vec3 H = normalize( L + V );
          float sheen = pow( clamp( dot( normalize( mix( vFaceN, vUpN, 0.35 ) ), H ), 0.0, 1.0 ), 22.0 );
          gl_FragColor.rgb += uSunColor * ( sheen * uSheen * sh * smoothstep( 0.1, 0.8, vT ) );

          // ── warm/cool split, matching the terrain's shadow tint ──────────
          float ndl = clamp( dot( normalize( vUpN ), L ), 0.0, 1.0 );
          float shade = ( 1.0 - smoothstep( 0.0, 0.40, ndl ) ) * 0.5 + ( 1.0 - shRaw ) * 0.5;
          gl_FragColor.rgb = mix( gl_FragColor.rgb, gl_FragColor.rgb * uShadowTint,
                                  clamp( shade, 0.0, 1.0 ) * 0.38 );

          // ── diagnostics ─────────────────────────────────────────────────
          // Driven from tools/grass_dev/*, zero cost when off (uniform branch).
          // Isolating "is this dark patch albedo, shadow, or lighting?" by eye
          // is guesswork; this answers it in one capture.
          if ( uDebug > 0.5 ) {
            if      ( uDebug < 1.5 ) gl_FragColor.rgb = diffuseColor.rgb;      // albedo
            else if ( uDebug < 2.5 ) gl_FragColor.rgb = vec3( vT );            // along-blade
            else if ( uDebug < 3.5 ) gl_FragColor.rgb = vec3( shRaw );         // shadow mask
            else if ( uDebug < 4.5 ) gl_FragColor.rgb = vec3( vTone, vDry, vShade * 0.5 );
            else                     gl_FragColor.rgb = normalize( vec3(
                                       mix( gFace, normalize( vUpN ), uNormalUp ) ) ) * 0.5 + 0.5;
            gl_FragColor.a = 1.0;
          }
        }
        #include <tonemapping_fragment>`);
  };

  mat.customProgramCacheKey = () => 'procedural-autumn-grass-v1';
  return mat;
}
