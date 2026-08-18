// ─────────────────────────────────────────────────────────────────────────────
//  RockMaterial — MeshStandardMaterial hijacked at compile time.
//
//  Going through the standard material (rather than a bespoke ShaderMaterial)
//  buys the shared atmosphere, the shadow plumbing and the light rig for free —
//  the same trick TerrainMaterial.js uses. Everything below only rewrites
//  albedo/roughness and then applies the warm-key / cool-shadow split.
//
//  Art rules encoded here, in priority order:
//    1. lavender-grey, never brown-grey; light enough that a lit face is nearly
//       the value of the sky, which is what makes the reference read "clean"
//    2. per-facet tonal separation — each plane gets its own value, so the
//       faceting reads even when two facets face the sun almost equally
//    3. bedding planes, lichen and wet rock are *quiet*; the reference is
//       painted planes, not textured rock. Every one of these is a few percent
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { PALETTE } from '../world/WorldConfig.js';

export function createRockMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.93,
    metalness: 0.0,
    dithering: true,
    flatShading: false,   // normals are already exact per facet
  });

  const uniforms = {
    uRockLit:    { value: PALETTE.rockLit.clone() },
    uRockMid:    { value: PALETTE.rockMid.clone() },
    uRockShadow: { value: PALETTE.rockShadow.clone() },
    uRockWarm:   { value: PALETTE.rockWarm.clone() },
    // Golden-hour cast for sun-facing planes. Measuring the reference plates,
    // lit rock sits around (185,145,119) — clearly warm — while shaded rock
    // stays neutral-to-cool. That split is the light, not the material, but
    // the global rig cannot know a plane is rock, so the albedo carries part
    // of it. Without this the rock is the only desaturated thing in a frame
    // that is 95% warm, and a desaturated mid-value object reads as chalk.
    uRockSun:    { value: new THREE.Color().setHex(0xd7ac7f, THREE.SRGBColorSpace) },
    // The key light's own colour, fed in each frame. Tinting the warm mix by
    // it means the rock is gold at golden hour and pink at dawn without any
    // per-time-of-day tuning here.
    uSunTint:    { value: new THREE.Color(1, 1, 1) },
    uLichen:     { value: new THREE.Color().setHex(0x9aa86a, THREE.SRGBColorSpace) },
    uMoss:       { value: new THREE.Color().setHex(0x5d7440, THREE.SRGBColorSpace) },
    uBounce:     { value: PALETTE.ambientGround.clone() },
    uSunDir:     { value: new THREE.Vector3(0.4, 0.6, 0.3) },
    uShadowTint: { value: new THREE.Vector3(0.91, 0.94, 1.10) },
    uAOStrength: { value: 0.55 },
    uTime:       { value: 0 },
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    mat.userData.shader = shader;

    shader.vertexShader = /* glsl */`
      attribute vec3 aBake;      // ao, upward exposure, height in rock
      attribute vec4 aRockA;     // wetness, moisture, tint jitter, size
      attribute vec2 aRockB;     // water surface Y, altitude/frost factor
      varying vec3 vBake;
      varying vec4 vRockA;
      varying vec2 vRockB;
      varying vec3 vWPos;
      varying vec3 vWNrm;
      varying vec3 vLPos;
    ` + shader.vertexShader
      .replace('#include <beginnormal_vertex>', /* glsl */`
        #include <beginnormal_vertex>
        {
          vec3 rn = objectNormal;
          #ifdef USE_INSTANCING
            mat3 im = mat3( instanceMatrix );
            rn /= vec3( dot( im[0], im[0] ), dot( im[1], im[1] ), dot( im[2], im[2] ) );
            rn = im * rn;
          #endif
          vWNrm = normalize( mat3( modelMatrix ) * rn );
        }`)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        vBake = aBake;
        vRockA = aRockA;
        vRockB = aRockB;
        vLPos = position;
        {
          vec4 rw = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            rw = instanceMatrix * rw;
          #endif
          vWPos = ( modelMatrix * rw ).xyz;
        }`);

    shader.fragmentShader = /* glsl */`
      uniform vec3 uRockLit, uRockMid, uRockShadow, uRockWarm, uRockSun, uLichen, uMoss, uBounce;
      uniform vec3 uSunDir, uShadowTint, uSunTint;
      uniform float uAOStrength, uTime;
      varying vec3 vBake;
      varying vec4 vRockA;
      varying vec2 vRockB;
      varying vec3 vWPos;
      varying vec3 vWNrm;
      varying vec3 vLPos;

      // Smooth value noise. Used only at large scales — this material must not
      // develop speckle, so nothing here runs above ~1 cycle per metre.
      vec2 rhash(vec2 p){
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
      }
      float rnoise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(dot(rhash(i + vec2(0,0)), f - vec2(0,0)),
                       dot(rhash(i + vec2(1,0)), f - vec2(1,0)), u.x),
                   mix(dot(rhash(i + vec2(0,1)), f - vec2(0,1)),
                       dot(rhash(i + vec2(1,1)), f - vec2(1,1)), u.x), u.y);
      }
    ` + shader.fragmentShader
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        // Wet rock is smoother; it is the only place this material is glossy.
        roughnessFactor = mix( roughnessFactor, 0.42, clamp( vRockA.x, 0.0, 1.0 ) );`)
      .replace('#include <color_fragment>', /* glsl */`
      #include <color_fragment>
      {
        vec3 N   = normalize( vWNrm );
        float ao = mix( 1.0, vBake.x, uAOStrength );
        float up = clamp( N.y, 0.0, 1.0 );
        float hN = vBake.z;
        float wet = clamp( vRockA.x, 0.0, 1.0 );
        float moist = clamp( vRockA.y, 0.0, 1.0 );
        float tint = vRockA.z;
        float size = max( vRockA.w, 0.35 );

        // ── per-facet tone ────────────────────────────────────────────────
        // A stable hash of the facet normal. Constant across the whole facet,
        // so it never shimmers, and it separates neighbouring planes even when
        // the light hits them at the same angle. This is the single biggest
        // reason the rock reads as *cut* rather than as a smooth lump.
        float facet = fract( sin( dot( N, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );

        // ── bedding planes ────────────────────────────────────────────────
        // Horizontal in world space so a boulder train shares one stratigraphy.
        // Frequency falls off with rock size or cobbles turn into liquorice.
        float bedF = 1.15 / (0.5 + size * 0.5);
        float bed  = sin( vWPos.y * bedF + rnoise( vWPos.xz * 0.05 ) * 3.0 );
        bed *= 1.0 - abs( N.y );          // only visible on near-vertical faces

        // ── base lavender-grey ────────────────────────────────────────────
        // Rock in the reference is a HIGH-VALUE material: a lit face sits close
        // to the sky's value and only genuine creases go dark. Everything here
        // stays between rockMid and rockLit; rockShadow is a crevice colour, not
        // a shading colour, and letting it into the open faces is what made the
        // first pass read as wet slate.
        // The up-term is weighted lightly on purpose. Global lighting already
        // brightens upward faces; baking a second big up-term into the albedo
        // double-counted it and blew every horizontal facet out to near-white,
        // which is what made the rocks read as polystyrene chips on the hill.
        float val = 0.38
                  + up * 0.06
                  + facet * 0.17              // per-facet tone, the main split
                  + bed * 0.07
                  + tint * 0.09
                  - (1.0 - hN) * 0.07;        // bases sit a little darker
        vec3 rock = mix( uRockMid, uRockLit, clamp( val, 0.0, 1.0 ) );
        rock = mix( rock, uRockShadow, ( 1.0 - ao ) * 0.34 );

        // Warm key / cool shadow, applied per facet in albedo. Doing it here
        // rather than in lighting is what keeps the flat cel look: a facet is
        // still one uniform colour, it just is not the same colour as the
        // facet beside it. This is also the fix for rocks reading as chalk —
        // a lit plane has to join the warm family the rest of the frame is in.
        float sunFace = clamp( dot( N, normalize( uSunDir ) ), -1.0, 1.0 );
        float warmM = smoothstep( -0.25, 0.60, sunFace );
        rock = mix( rock, uRockSun * uSunTint, 0.06 + warmM * 0.54 );
        rock = mix( rock, uRockShadow, ( 1.0 - warmM ) * 0.22 );

        // ── lichen and moss ───────────────────────────────────────────────
        // Big soft blotches, never speckle. Pale lichen crusts the sunny tops,
        // dark moss collects where the rock is damp, shaded and creased.
        float blotch = rnoise( vWPos.xz * 0.30 + vWPos.y * 0.12 ) * 0.5 + 0.5;
        float blotch2 = rnoise( vWPos.xz * 0.11 + 17.0 ) * 0.5 + 0.5;
        float lichenM = smoothstep( 0.42, 0.86, blotch * 0.65 + blotch2 * 0.45 )
                      * smoothstep( 0.20, 0.75, up )
                      * ( 0.30 + moist * 0.70 ) * ( 1.0 - wet );
        float mossM   = smoothstep( 0.50, 0.95, blotch2 * 0.8 + (1.0 - ao) * 0.5 )
                      * smoothstep( 0.05, 0.55, up )
                      * moist * moist * ( 1.0 - wet * 0.5 );
        rock = mix( rock, uLichen, lichenM * 0.34 );
        rock = mix( rock, uMoss,   mossM  * 0.42 );

        // ── wet rock ──────────────────────────────────────────────────────
        // Below the waterline the rock is soaked and much darker; just above it
        // there is a damp band. Both are what sells a boulder as *in* a river.
        float waterY = vRockB.x;
        float band = waterY < -9000.0 ? 0.0
                   : smoothstep( waterY + 0.55, waterY - 0.25, vWPos.y );
        float soak = clamp( max( wet, band ), 0.0, 1.0 );
        vec3 wetRock = rock * 0.42;
        wetRock = mix( wetRock, wetRock * vec3( 0.86, 0.96, 1.10 ), 0.55 );
        rock = mix( rock, wetRock, soak * 0.85 );

        // Frost-shattered high ground reads paler and cooler.
        rock = mix( rock, rock * vec3( 1.06, 1.05, 1.10 ), clamp( vRockB.y, 0.0, 1.0 ) * 0.5 );

        diffuseColor.rgb *= rock;
      }`)
      .replace('#include <dithering_fragment>', /* glsl */`
      {
        vec3 N = normalize( vWNrm );
        vec3 L = normalize( uSunDir );
        float ndl = clamp( dot( N, L ), 0.0, 1.0 );

        // Warm bounce from the gold meadow onto downward-facing planes. Small,
        // but it is the difference between "sitting in the grass" and "pasted".
        float down = clamp( -N.y, 0.0, 1.0 );
        gl_FragColor.rgb += uBounce * down * mix( 0.02, 0.09, vBake.x ) * (1.0 - clamp(vRockA.x,0.0,1.0));

        // Cool violet drift on unlit planes — a tint, never a hue replacement.
        float shade = 1.0 - smoothstep( 0.0, 0.34, ndl );
        gl_FragColor.rgb = mix( gl_FragColor.rgb, gl_FragColor.rgb * uShadowTint, shade * 0.30 );
      }
      #include <dithering_fragment>`);
  };

  mat.customProgramCacheKey = () => 'procedural-autumn-rock-v1';
  return mat;
}
