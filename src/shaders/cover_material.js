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

/** Shared uniform block. One object drives every cover material. */
export function makeCoverUniforms() {
  return {
    uTime:         { value: 0 },
    uSunDir:       { value: new THREE.Vector3(0.4, 0.7, 0.3) },
    uSunColor:     { value: new THREE.Color(1, 1, 1) },
    uWindStrength: { value: 1.0 },
    uWindSpeed:    { value: 1.15 },
    // Backlight through a leaf. Generous, because it is only ever visible when
    // the camera is looking into the sun and the surface is turned away.
    uTransmit:     { value: 1.00 },
    // How dark the buried interior of a clump goes. Not zero — the brief is
    // explicit that shaded areas stay as tinted colour, never as holes.
    uAoDepth:      { value: 0.64 },
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
`;

// `transformed` is in geometry space with the plant's base at the origin, so
// scaling it is a shrink toward the root — the plant sinks and closes rather
// than shrinking around its own middle, which would look like a balloon
// deflating in mid-air.
const COVER_DISPLACE = /* glsl */`
  vec3 coverOrigin = ( modelMatrix * COVER_IMAT * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  float coverDist = distance( cameraPosition, coverOrigin );
  float coverFade = 1.0 - smoothstep( aCov.w * 0.76, aCov.w, coverDist );
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
 */
export function createCoverMaterial(uniforms, card = false) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
    side: card ? THREE.DoubleSide : THREE.FrontSide,
    dithering: true,
  });
  mat.name = card ? 'coverCard' : 'coverSolid';
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    mat.userData.shader = shader;

    shader.vertexShader = COVER_COMMON + /* glsl */`
      attribute vec3 aColA;
      attribute vec3 aColB;
      uniform float uAoDepth;
      varying vec3 vCoverCol;
      varying vec3 vCoverNW;
      varying vec3 vCoverWP;
      varying float vCoverTrans;
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
        vCoverTrans = cInfo.w;
      `)
      // ── workaround: instanced fog ────────────────────────────────────────
      // Atmosphere's shared `fog_vertex` chunk computes
      //     vFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
      // with no `instanceMatrix`. For an InstancedMesh that is the *geometry*
      // position, i.e. a metre or two from the world origin, so every instance
      // in this system was hazed as if it stood 1 km from the camera: measured
      // at the meadow anchor the ground cover rendered at fogFactor ~0.76, the
      // cap, which is 76% flat cream over whatever albedo it was given. It made
      // dark shrubs invisible and turned ochre scrub into pale grey rags, and
      // it survived three rounds of palette changes because the albedo was
      // barely reaching the frame at all.
      //
      // Overwriting the varying after the chunk has run is the smallest local
      // fix. Logged in docs/INTEGRATION_REQUESTS.md — it affects every
      // instanced MeshStandardMaterial in the game, not just this one.
      .replace('#include <fog_vertex>', /* glsl */`
        #include <fog_vertex>
        #ifdef USE_FOG
          vFogWorldPos = vCoverWP;
        #endif
      `);

    shader.fragmentShader = /* glsl */`
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uTransmit;
      varying vec3 vCoverCol;
      varying vec3 vCoverNW;
      varying vec3 vCoverWP;
      varying float vCoverTrans;
    ` + shader.fragmentShader
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        diffuseColor.rgb *= vCoverCol;
      `)
      .replace('#include <opaque_fragment>', /* glsl */`
        {
          // Transmission needs two things to line up: the camera has to be
          // looking toward the sun, and the surface has to be turned away from
          // it. Wrapping the second term rather than clamping it keeps a soft
          // gradient across a lobe instead of a hard glowing rim.
          vec3 coverV = normalize( cameraPosition - vCoverWP );
          float coverToward = clamp( dot( -coverV, uSunDir ), 0.0, 1.0 );
          float coverThru = clamp( 0.5 - 0.62 * dot( normalize( vCoverNW ), uSunDir ), 0.0, 1.0 );
          totalEmissiveRadiance += uSunColor * diffuseColor.rgb *
            ( uTransmit * vCoverTrans * coverThru * pow( coverToward, 2.4 ) );
        }
        #include <opaque_fragment>
      `);
  };

  // Two variants of the same source; without a distinguishing key three would
  // share one compiled program between the front- and double-sided materials.
  mat.customProgramCacheKey = () => (card ? 'cover-card' : 'cover-solid');
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
