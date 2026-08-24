// ─────────────────────────────────────────────────────────────────────────────
//  Ground-cover material.
//
//  A `MeshStandardMaterial` hijacked at compile time, exactly as
//  `world/TerrainMaterial.js` does. That is deliberate and it is the whole
//  reason this file is short: going through three's standard program gets us
//  the shared atmospheric fog, real shadow receive/cast, and — most importantly
//  — `render/Stylize.js`'s global cel-ish lighting response for free. A custom
//  ShaderMaterial here would have to re-opt-in to all three and would drift out
//  of step with the rest of the game the first time any of them was retuned.
//
//  What the patch adds on top:
//
//   · per-instance colour, from two palette entries blended by a per-vertex
//     channel, so one material paints dark shrubs, bronze ferns, crimson
//     berries and mossy logs;
//   · wind, as a sway weighted by the per-vertex height rank, in the instance's
//     own local frame (the wind direction is pre-rotated on the CPU, which is
//     cheaper than inverting the instance basis per vertex);
//   · a distance shrink-out, so a plant leaving its visibility radius collapses
//     into the ground over the last quarter of it instead of vanishing;
//   · backlit transmission, which is the one thing golden-hour foliage cannot
//     do without.
//
//  The depth material shares the vertex displacement so shadows track the wind
//  and the fade rather than ghosting the un-swayed pose.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
// Camera occlusion — the volume that takes away whatever the camera is standing
// inside (src/render/Occlusion.js). Two call sites here, both marked OCCLUDE.
// Note this material takes the *shrink* form, not the dithered discard the
// tree canopy takes: cover is opaque, and a discard would cost it early-Z on a
// surface that currently has it. Shrinking toward the root is free, it is
// already exactly what coverFade does at the visibility limit below, and a
// shrub sinking into the ground is a nicer read than one dissolving in place.
import { occlusionUniforms, OCCLUDE_PARS } from '../render/Occlusion.js';
import { campSite, CAMP_CLEARING_GLSL } from '../camp/camp_clearing.js';

/** Shared uniform block. One object drives every cover material. */
export function makeCoverUniforms() {
  return {
    // Shared by reference with camp_clearing.js; see the note there on why the
    // clearing is a shader fact rather than a re-scatter.
    uCampSites:    campSite.uCampSites,
    uCampPads:     campSite.uCampPads,
    uCampAim:      campSite.uCampAim,
    uCampAimFloor: campSite.uCampAimFloor,
    uTime:         { value: 0 },
    uSunDir:       { value: new THREE.Vector3(0.4, 0.7, 0.3) },
    uSunColor:     { value: new THREE.Color(1, 1, 1) },
    // Sun presence, 0..1. Both terms below are *transmitted or reflected
    // sunlight*; neither may exist when there is no sun. See Grass.js.
    uSunLev:       { value: 1 },
    uWindStrength: { value: 1.0 },
    uWindSpeed:    { value: 1.15 },
    // Backlight through a leaf. Generous, because it is only ever visible when
    // the camera is looking into the sun and the surface is turned away.
    //
    // Raised from 1.00 after measuring what the terms actually multiply out to
    // in the `backlit` frame. A shrub 40 deg off the sun axis takes
    // `pow(0.77, 2.4) = 0.53` from the view term and about 0.31 from the
    // surface term, so at 1.00 the whole effect was a 16% lift on the albedo —
    // present in the buffer and invisible on screen, which is why the critic
    // could write "no rim or translucency in the backlit frame" about a
    // material that has a transmission term. The brief asks for glowing tips at
    // golden hour and says to budget for it; 1.7 is what that costs.
    uTransmit:     { value: 1.70 },
    // Backlit RIM, and it is a separate term from transmission on purpose.
    //
    // Transmission multiplies the surface's own albedo, which is correct
    // physics for light coming *through* a leaf and useless for the thing the
    // brief actually asks for: "glowing grass tips and bright silhouette
    // edges". Our foliage albedos are dark by design — that is the whole job of
    // this layer — so 1.7x of a dark green is still a dark green, which is why
    // the critic could write "no rim or translucency in the backlit frame"
    // about a material that already had a transmission term. The look author
    // makes the same point in docs/INTEGRATION_REQUESTS.md about the global
    // rim: never multiply a rim by albedo.
    //
    // So this one is added as light. It is gated three ways and therefore costs
    // nothing outside the frame it exists for: the sun has to be behind the
    // surface (uRimBack), the surface has to be near its own silhouette
    // (uRimPow on the fresnel), and it is weighted by the vertex's height rank
    // so a tip glows and a root does not.
    // Swept on the `backlit` anchor with everything else held
    // (tools/_scratch/cover/rimsweep.mjs, shots/cover/rim1 and rim2), which is
    // the first time these two numbers have been looked at together — and they
    // only make sense together. The previous round found that 2.30 at exponent
    // 2.8 turns the shrubs into pale mint lumps floating on salmon grass, and
    // concluded the strength was too high. Half right: at exponent 2.8 the term
    // is not a rim at all. `1 - |dot(N,V)|` is high over most of a small clumpy
    // object, because a floret's normals sweep through every direction inside a
    // 20 cm ball, so a low exponent lights the whole bush and raising the gain
    // just washes it faster.
    //
    // Push the exponent instead and only normals within a few degrees of
    // perpendicular fire, which is a contour — and the gain can then go up by
    // 3.5x without the mass moving at all. The sweep is unambiguous:
    //   0    / 2.8   flat dark-green blobs, the critic's "no rim"
    //   2.5  / 1.6   pale wash, the previous round's failure
    //   3.0  / 8.0   green mass, bright edge — the reference's behaviour
    // uRimBack up from 0.12 so a frame that is not actually into the sun pays
    // nothing for it.
    uRim:          { value: 3.00 },
    uRimPow:       { value: 8.0 },
    uRimBack:      { value: 0.30 },
    // Hue of the rim. Not white: a rim on autumn foliage at golden hour is the
    // sun's own colour pushed a step toward the leaf's transmitted amber, and
    // a neutral one reads as a chalk outline.
    uRimTint:      { value: new THREE.Color(1.0, 0.82, 0.52) },
    // How dark the buried interior of a clump goes. Not zero — the brief is
    // explicit that shaded areas stay as tinted colour, never as holes.
    //
    // Raised 0.72 -> 0.84 against a measurement rather than a feeling. Critic
    // blocker 15 is "scrub reads as a black faceted scribble with no internal
    // value range", and matched crops of a bush in `meadow` against the same
    // subject in reference plate 2 say the bright end is already right and the
    // DARK end is the whole error:
    //
    //   ref bush lit  luma 0.267   body 0.426   shaded 0.307   chroma 0.155
    //   ours     lit  luma 0.274   body 0.307   shaded 0.190   chroma 0.091
    //
    // The reference's shaded side stays a saturated mid green; ours crushes to
    // a desaturated olive-brown — its green channel actually falls BELOW its
    // red (ratio 1:0.94:0.56), so it is not a dark green at all, it is a dark
    // neutral. That is the "no internal value range" reading: a bush whose
    // shadow side is a hole has one value and a silhouette, not three masses.
    // 0.16 of albedo was too much to take out of a surface the game then lights
    // at its stylised floor.
    uAoDepth:      { value: 0.84 },
  };
}

// Instancing may legitimately be absent while three compiles a warm-up program,
// so the instance matrix is reached through a macro rather than assumed.
const COVER_COMMON = /* glsl */`
#ifdef USE_INSTANCING
  #define COVER_IMAT instanceMatrix
#else
  #define COVER_IMAT mat4( 1.0 )
#endif
attribute vec4 cInfo;
attribute vec4 aCov;
attribute vec2 aWindDir;
uniform float uTime;
uniform float uWindStrength;
uniform float uWindSpeed;
${CAMP_CLEARING_GLSL}
`;

// `transformed` is in geometry space with the plant's base at the origin, so
// scaling it is a shrink toward the root — the plant sinks and closes rather
// than shrinking around its own middle, which would look like a balloon
// deflating in mid-air.
const COVER_DISPLACE = /* glsl */`
  vec3 coverOrigin = ( modelMatrix * COVER_IMAT * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  float coverDist = distance( cameraPosition, coverOrigin );
  float coverFade = 1.0 - smoothstep( aCov.w * 0.76, aCov.w, coverDist );
  #ifdef COVER_NEAR_FADE
    // Broad ground mats fade IN as well as out. Their job is the mid band,
    // where the substrate tier's 23 m props have already vanished and the
    // terrain albedo is the whole picture; inside that a 1.5 m lobe is a flat
    // slab and the fine substrate is the better answer. Shrinking toward the
    // root, so a mat sinks into the ground rather than dissolving in mid air.
    //
    // The fractions are of the instance's OWN radius, which is what makes one
    // number serve two jobs: the broad swathe carries the full 130 m and so
    // fades in over 8-20 m, and the small mat is emitted with visMul 0.34 (44 m)
    // and so fades in over 2.7-6.7 m. Big props stay out of the near field
    // where they read as slabs; small ones fill it.
    //
    // Removing the near fade altogether was tried and is a regression, and the
    // capture that says so is shots/cover/a10/drive.png against
    // shots/round46/drive.png: full-size swathes two metres from the camera put
    // dull olive plates all over the one meadow floor the critic scored as
    // close to shipping. That frame is on the brief's do-not-trade list.
    coverFade *= smoothstep( aCov.w * 0.062, aCov.w * 0.152, coverDist );
  #endif
  #ifdef COVER_OCCLUDE
    // OCCLUDE. Defined on the visible material only — createCoverDepthMaterial
    // shares this string and must NOT define it, or a shrub would stop casting
    // its shadow the moment the camera came up behind it and the ground would
    // flicker as you drove.
    //
    // Evaluated ONCE at the plant's root, with the plant's own size handed to
    // the near-sphere test, rather than per vertex at the transformed position.
    // The first version did the latter — two mat3 constructions and two matrix
    // multiplies per vertex, on one of the two largest geometry populations in
    // the game — to answer a question the root plus a radius answers just as
    // well. It also fixes a real defect: a per-vertex fade scales each vertex by
    // a different amount, so a shrub straddling the edge of the volume did
    // not shrink, it sheared. Every other consumer has since been moved onto
    // this same per-instance shape — see the header of render/Occlusion.js.
    //
    // aCov.w is the instance's visibility radius, which the scatter sets in
    // proportion to how big the prop is — 130 m for a full swathe, 44 m for a
    // small mat — so it is already a size signal and no new attribute is needed.
    // The constant turns those into roughly 1.6 m and 0.5 m of plant.
    coverFade *= occludeFadeAt( coverOrigin, aCov.w * 0.012 );
  #endif
  // The camp clearing. Applied to coverFade rather than to transformed
  // directly, because COVER_DISPLACE is shared with the depth material — so a
  // shrub inside the camp stops casting its shadow at the same instant it
  // stops being drawn. Doing this only on the visible material leaves a
  // perfect shrub-shaped shadow lying across the bare dirt, which is a
  // considerably worse bug than the one it would be fixing.
  coverFade *= campCover( coverOrigin.xz );
  transformed *= coverFade;
  float coverPh = aCov.y + uTime * uWindSpeed;
  // Two incommensurable rates so a field of plants never pulses in unison.
  float coverGust = sin( coverPh ) * 0.66 + sin( coverPh * 1.83 + 1.1 ) * 0.34;
  float coverSwing = cInfo.z * aCov.x * uWindStrength * coverGust * coverFade;
  transformed.x += aWindDir.x * coverSwing;
  transformed.z += aWindDir.y * coverSwing;
`;

/**
 * @param {object} uniforms  shared block from makeCoverUniforms()
 * @param {boolean} card     true for strip/blade geometry, which needs two sides
 * @param {boolean} nearFade true for the broad ground mats, which fade IN with
 *                           distance as well as out — see COVER_NEAR_FADE
 */
export function createCoverMaterial(uniforms, card = false, nearFade = false) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
    side: card ? THREE.DoubleSide : THREE.FrontSide,
    dithering: true,
  });
  mat.name = nearFade ? 'coverMat' : (card ? 'coverCard' : 'coverSolid');
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, occlusionUniforms());   // OCCLUDE
    mat.userData.shader = shader;

    shader.vertexShader = (nearFade ? '#define COVER_NEAR_FADE\n' : '')
      + '#define COVER_OCCLUDE\n'                   // OCCLUDE
      + COVER_COMMON + OCCLUDE_PARS + /* glsl */`
      attribute vec3 aColA;
      attribute vec3 aColB;
      uniform float uAoDepth;
      varying vec3 vCoverCol;
      varying vec3 vCoverNW;
      varying vec3 vCoverWP;
      varying vec2 vCoverTT;
    ` + shader.vertexShader
      .replace('#include <beginnormal_vertex>', /* glsl */`
        #include <beginnormal_vertex>
        vCoverNW = normalize( mat3( modelMatrix ) * ( mat3( COVER_IMAT ) * objectNormal ) );
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        ${COVER_DISPLACE}
        vCoverWP = ( modelMatrix * COVER_IMAT * vec4( transformed, 1.0 ) ).xyz;
        vCoverCol = mix( aColA, aColB, cInfo.x )
                  * ( uAoDepth + ( 1.0 - uAoDepth ) * cInfo.y )
                  * aCov.z;
        // x: translucency, y: height rank up the plant (0 root … 1 tip).
        vCoverTT = vec2( cInfo.w, cInfo.z );
      `)
      ;

    shader.fragmentShader = /* glsl */`
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uSunLev;
      uniform float uTransmit;
      uniform float uRim;
      uniform float uRimPow;
      uniform float uRimBack;
      uniform vec3 uRimTint;
      varying vec3 vCoverCol;
      varying vec3 vCoverNW;
      varying vec3 vCoverWP;
      varying vec2 vCoverTT;
    ` + shader.fragmentShader
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        diffuseColor.rgb *= vCoverCol;
      `)
      // Anchored on `emissivemap_fragment`, not on `opaque_fragment`. In this
      // three version `vec3 outgoingLight = totalDiffuse + totalSpecular +
      // totalEmissiveRadiance;` sits *above* the opaque chunk, so adding to
      // totalEmissiveRadiance there was writing to a value nothing read again
      // and the backlight has silently not been rendering. This anchor runs
      // before the lighting chunks, which is where three itself expects
      // emissive to be accumulated.
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        {
          // Transmission needs two things to line up: the camera has to be
          // looking toward the sun, and the surface has to be turned away from
          // it. Wrapping the second term rather than clamping it keeps a soft
          // gradient across a lobe instead of a hard glowing rim.
          vec3 coverV = normalize( cameraPosition - vCoverWP );
          vec3 coverN = normalize( vCoverNW );
          float coverToward = clamp( dot( -coverV, uSunDir ), 0.0, 1.0 );
          float coverThru = clamp( 0.5 - 0.62 * dot( coverN, uSunDir ), 0.0, 1.0 );
          totalEmissiveRadiance += uSunColor * diffuseColor.rgb *
            ( uTransmit * uSunLev * vCoverTT.x * coverThru * pow( coverToward, 1.9 ) );

          // Silhouette rim. Added as light, never through the albedo — see the
          // note beside uRim in makeCoverUniforms. coverBack is the same gate
          // the global stylizeRim() uses, so a front-lit frame pays nothing for
          // it, and the height-rank weight is what makes it read as glowing
          // tips rather than as a chalk line round the whole plant.
          float coverFres = 1.0 - clamp( abs( dot( coverN, coverV ) ), 0.0, 1.0 );
          float coverBack = smoothstep( uRimBack, 1.0, coverToward );
          float coverTip = 0.25 + 0.75 * vCoverTT.y;
          totalEmissiveRadiance += uSunColor * uRimTint *
            ( uRim * uSunLev * pow( coverFres, uRimPow ) * coverBack * coverTip * vCoverTT.x );
        }
      `);
  };

  // Two variants of the same source; without a distinguishing key three would
  // share one compiled program between the front- and double-sided materials.
  mat.customProgramCacheKey = () =>
    (nearFade ? 'cover-mat' : (card ? 'cover-card' : 'cover-solid'));
  return mat;
}

/**
 * Depth material for the shadow pass. Carries the same displacement so a
 * swaying shrub's shadow sways with it and a faded-out plant stops casting.
 */
export function createCoverDepthMaterial(uniforms) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    mat.userData.shader = shader;
    shader.vertexShader = COVER_COMMON + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n${COVER_DISPLACE}`
    );
  };
  mat.customProgramCacheKey = () => 'cover-depth';
  return mat;
}
