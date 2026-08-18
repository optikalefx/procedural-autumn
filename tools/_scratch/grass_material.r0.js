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
import { PALETTE } from '../world/WorldConfig.js';

/**
 * Shared blade strip. Local `position` carries (side, v, 0):
 *   side ∈ [-1,1] across the blade, v ∈ [0,1] along it.
 * The last row collapses to a single tip vertex so the silhouette comes to a
 * point rather than a chisel end.
 */
export function makeBladeGeometry(segments) {
  const pos = [];
  for (let i = 0; i < segments; i++) {
    const v = i / segments;
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
    uSunDir:      { value: new THREE.Vector3(0.4, 0.6, 0.3) },
    uSunColor:    { value: new THREE.Color(1, 0.88, 0.72) },

    // Wind: a low-frequency gust envelope advected across the world, plus a
    // fast flutter that only bites where the gust is already strong.
    uWindDir:     { value: new THREE.Vector2(0.86, 0.51) },
    uWindSpeed:   { value: 5.6 },     // m/s the gust *pattern* travels
    uWindBase:    { value: 0.16 },    // constant lean, radians at the tip
    uWindGust:    { value: 0.62 },    // extra lean at the crest of a gust
    uFlutter:     { value: 0.085 },

    // Colour
    uGold:        { value: new THREE.Color().setHex(0xf0a63e, THREE.SRGBColorSpace) },
    uOlive:       { value: new THREE.Color().setHex(0x9fae4a, THREE.SRGBColorSpace) },
    uDry:         { value: new THREE.Color().setHex(0xecc06d, THREE.SRGBColorSpace) },
    uTipCol:      { value: new THREE.Color().setHex(0xffc45e, THREE.SRGBColorSpace) },
    uRootCol:     { value: new THREE.Color().setHex(0xa96f2a, THREE.SRGBColorSpace) },
    uShadowTint:  { value: new THREE.Vector3(0.84, 0.88, 1.16) },

    uRootMix:     { value: 0.22 },    // how far the base drifts to uRootCol
    uTipMix:      { value: 0.55 },
    uBaseAO:      { value: 0.80 },    // occlusion at the blade root
    uNormalUp:    { value: 0.50 },    // blend of face normal -> terrain normal
    uCurve:       { value: 0.20 },    // cross-blade rounding of the normal
    uTrans:       { value: 1.15 },    // backlit translucency strength
    uSheen:       { value: 0.30 },
    uLift:        { value: 1.18 },    // the meadow is the brightest thing in frame
    uWrap:        { value: 0.85 },    // wrapped diffuse: a blade scatters light

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
  float bend = aShape.z + breeze * ( 0.62 + 0.38 * aShape.w ) + flut * uFlutter * gust;
  bend = clamp( bend, 0.03, 1.15 );

  // Blades swing toward the wind as the gust builds.
  vec2 ownDir = vec2( sin( aTint.x ), cos( aTint.x ) );
  vec2 leanDir = normalize( mix( ownDir, uWindDir, clamp( breeze * 0.85, 0.0, 0.72 ) ) );
  vec3 lean3 = vec3( leanDir.x, 0.0, leanDir.y );
  vec3 side3 = vec3( leanDir.y, 0.0, -leanDir.x );

  // Terrain normal, and the direction the blade actually grows: mostly up,
  // leaned a little into the slope so hillside grass does not look glued on.
  float nx = aMisc.x, nz = aMisc.y;
  vec3 upN = normalize( vec3( nx, sqrt( max( 1.0 - nx * nx - nz * nz, 0.04 ) ), nz ) );
  vec3 growDir = normalize( mix( vec3( 0.0, 1.0, 0.0 ), upN, 0.38 ) );

  // Length-preserving circular arc: a blade that bends does not get shorter.
  float sB = sin( bend * t ), cB = cos( bend * t );
  vec3 spine = lean3 * ( bh * ( 1.0 - cB ) / bend ) + growDir * ( bh * sB / bend );

  float taper = pow( max( 1.0 - t, 0.0 ), 0.85 );
  vec3 bladePos = aPos + spine + side3 * ( side * bw * 0.5 * taper );

  vec3 tangent = normalize( lean3 * sB + growDir * cB );
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

const FRAG_HEAD = /* glsl */`
uniform vec3  uGold;
uniform vec3  uOlive;
uniform vec3  uDry;
uniform vec3  uTipCol;
uniform vec3  uRootCol;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uShadowTint;
uniform float uRootMix;
uniform float uTipMix;
uniform float uBaseAO;
uniform float uNormalUp;
uniform float uTrans;
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
          vec3 base = mix( uGold, uOlive, vTone );
          base = mix( base, uDry, vDry );
          // Vertical gradient: this single move does more for the look than
          // any amount of lighting work — dark cool root, hot amber tip.
          // At range the root darkening has to go: a dark blade base over gold
          // ground is what turns a distant meadow into speckle instead of a
          // continuous field. uAOScale rolls it off ring by ring.
          vec3 rootC = mix( base, uRootCol, uRootMix * uAOScale );
          vec3 tipC  = mix( base, uTipCol, uTipMix );
          vec3 col = mix( rootC, tipC, smoothstep( 0.0, 0.92, vT ) );
          // Occlusion at the root grounds the field into the terrain.
          col *= mix( mix( 1.0, uBaseAO, uAOScale ), 1.0, smoothstep( 0.0, 0.22, vT ) );
          col *= vShade * uLift;
          diffuseColor.rgb *= col;
        }`)

      .replace('#include <tonemapping_fragment>', /* glsl */`
        {
          vec3 V = normalize( cameraPosition - vWorldPos );
          vec3 L = normalize( uSunDir );
          float sh = getShadowMask();

          // ── thin-sheet translucency: the money shot at golden hour ───────
          // Light transmitted through a blade leaves roughly along -L, so the
          // glow peaks when the camera is looking into the sun.
          float back = clamp( dot( -V, L ), 0.0, 1.0 );
          float trans = pow( back, 2.6 );
          trans *= mix( 0.35, 1.0, smoothstep( 0.05, 0.75, vT ) );   // tips are thinner
          trans *= 1.0 - 0.55 * clamp( dot( normalize( vUpN ), L ), 0.0, 1.0 );
          vec3 glowCol = mix( uTipCol, uSunColor, 0.45 );
          gl_FragColor.rgb += glowCol * ( trans * uTrans * sh * diffuseColor.rgb * 2.2 );

          // ── wrapped diffuse ─────────────────────────────────────────────
          // A blade is a thin scatterer, not a Lambertian chip. Without this
          // the field goes to mud the moment the sun drops toward the horizon
          // — exactly the hour this game is set at.
          float wrapN = clamp( ( dot( normalize( vUpN ), L ) + 0.45 ) / 1.45, 0.0, 1.0 );
          gl_FragColor.rgb += diffuseColor.rgb * uSunColor * ( wrapN * uWrap * sh );

          // ── sheen: raking light picks the field out in bands ─────────────
          vec3 H = normalize( L + V );
          float sheen = pow( clamp( dot( normalize( mix( vFaceN, vUpN, 0.35 ) ), H ), 0.0, 1.0 ), 22.0 );
          gl_FragColor.rgb += uSunColor * ( sheen * uSheen * sh * smoothstep( 0.1, 0.8, vT ) );

          // ── warm/cool split, matching the terrain's shadow tint ──────────
          float ndl = clamp( dot( normalize( vUpN ), L ), 0.0, 1.0 );
          float shade = ( 1.0 - smoothstep( 0.0, 0.40, ndl ) ) * 0.5 + ( 1.0 - sh ) * 0.5;
          gl_FragColor.rgb = mix( gl_FragColor.rgb, gl_FragColor.rgb * uShadowTint,
                                  clamp( shade, 0.0, 1.0 ) * 0.30 );
        }
        #include <tonemapping_fragment>`);
  };

  mat.customProgramCacheKey = () => 'procedural-autumn-grass-v1';
  return mat;
}
