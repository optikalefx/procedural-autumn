// ─────────────────────────────────────────────────────────────────────────────
//  lily_material — MeshStandardMaterial hijacked at compile time, the way
//  RockMaterial and TerrainMaterial are, so the pads get the shared atmosphere,
//  the shadow plumbing, the light rig and Stylize's soft response for free.
//
//  What this file adds on top:
//
//    vertex    · the BOB — each pad rides its own slow sine on the water,
//                amplitude in WORLD metres (the instance is scaled by its
//                radius, so the offset is divided back out), and the SAME
//                function LilyPads.padTop evaluates on the CPU. If the two
//                ever disagree a frog will hover; keep them in step.
//              · the SKIRT — the rim ring is pushed down a fixed world
//                distance so the pad has a visible thickness and the gap to
//                the drawn water (which sits 3 cm above its level) is closed
//                at a grazing angle.
//    fragment  · colour from two per-instance scalars, `tint` and `age`:
//                a green family with a hue jitter, turning toward gold and
//                then rust from the RIM inward as the pad ages — autumn is
//                the season, and a colony with a few turned leaves is what
//                keeps it from reading as a summer asset dropped in.
//              · a faint radial vein pattern and a darker stem eye. Both are
//                a few percent; the reference is painted planes.
//              · the underside, where the curl shows it, is the wine red a
//                real pad's underside is.
//
//  Per-instance data arrives in one instanced vec4, `aLily`:
//    x  bob phase     y  bob rate (rad/s)     z  age 0..1     w  tint 0..1
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

// World metres. Exported so the CPU-side surface query uses the same numbers.
export const LILY_LIFT = 0.055;     // pad plane above the water LEVEL (the
                                    // drawn sheet is lifted 0.03 — see
                                    // shaders/water_surface.js vLift)
export const LILY_BOB = 0.006;      // bob amplitude
export const LILY_SKIRT = 0.035;    // rim skirt depth

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

export function createLilyMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.62,        // waxy, not wet — Stylize scales specular anyway
    metalness: 0.0,
    side: THREE.DoubleSide,
    dithering: true,
  });

  const uniforms = {
    uTime:       { value: 0 },
    uLilyBob:    { value: LILY_BOB },
    uLilySkirt:  { value: LILY_SKIRT },
    // The green family. Two greens a hue apart and the jitter blends between
    // them; a blue-green and a yellow-green side by side is what a colony
    // looks like, and a single green is what a texture looks like.
    uLilyA:      { value: C(0x4f8a3e) },   // cool leaf green
    uLilyB:      { value: C(0x86a33c) },   // yellow-olive
    uLilyGold:   { value: C(0xd8b13a) },   // turning
    uLilyRust:   { value: C(0xa2502b) },   // turned, rim
    uLilyUnder:  { value: C(0x7c3a3d) },   // underside wine
    uLilyVein:   { value: 0.07 },
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    mat.userData.shader = shader;

    shader.vertexShader = /* glsl */`
      attribute vec4 aLily;
      uniform float uTime, uLilyBob, uLilySkirt;
      varying vec2 vLilyUv;
      varying vec4 vLily;
    ` + shader.vertexShader
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        vLilyUv = uv;
        vLily = aLily;
        {
          // Metres per unit of this instance: the Y column's length is the
          // radius (scale is r*sx, r, r).
          float rM = 1.0;
          #ifdef USE_INSTANCING
            rM = max( 1e-3, length( instanceMatrix[1].xyz ) );
          #endif
          float bob = uLilyBob * sin( uTime * aLily.y + aLily.x );
          // The skirt: only the flagged ring (uv.x > 1, see lily_forms
          // SKIRT_U) drops, straight down from the rim.
          float skirt = step( 1.001, uv.x ) * uLilySkirt;
          transformed.y += ( bob - skirt ) / rM;
        }`);

    shader.fragmentShader = /* glsl */`
      uniform vec3 uLilyA, uLilyB, uLilyGold, uLilyRust, uLilyUnder;
      uniform float uLilyVein;
      varying vec2 vLilyUv;
      varying vec4 vLily;
    ` + shader.fragmentShader
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        {
          float u = min( vLilyUv.x, 1.0 );     // 0 stem .. 1 rim
          // The skirt wall: interpolating toward the flagged ring puts the
          // whole outer strip above 1, so this is the wall and nothing else.
          float wall = smoothstep( 1.0002, 1.0015, vLilyUv.x );
          float age = vLily.z, tint = vLily.w;
          vec3 green = mix( uLilyA, uLilyB, tint );
          // Turning starts at the rim and walks inward with age; the last
          // stage rusts the rim itself. Quadratic in age and gated, so the
          // young half of a colony is plain green and only the older leaves
          // carry gold — the first cut gave every pad a gold rim at once and
          // the colony read as one repeated asset.
          float turn = smoothstep( 1.0 - age * age * 1.4, 1.0 - age * 0.2, u ) * smoothstep( 0.12, 0.30, age );
          vec3 col = mix( green, uLilyGold, turn );
          col = mix( col, uLilyRust, smoothstep( 0.55, 1.0, age ) * smoothstep( 0.86, 1.0, u ) );
          // Veins: radial, faint, fading out toward the stem where they bunch.
          float ang = vLilyUv.y * 6.2831853;
          float vein = smoothstep( 0.90, 1.0, abs( sin( ang * 9.0 ) ) ) * smoothstep( 0.18, 0.45, u );
          col *= 1.0 - uLilyVein * vein;
          // The stem eye and a slightly deeper centre.
          col *= 1.0 - 0.10 * ( 1.0 - smoothstep( 0.0, 0.16, u ) );
          // The rim catches the light: a hair brighter on the curl.
          col *= 1.0 + 0.10 * smoothstep( 0.88, 1.0, u );
          // The underside, wherever the curl shows it, and the skirt wall,
          // which is the leaf's edge seen from the side: darker, toward the
          // underside colour, so it reads as thickness in shadow and not as
          // a second rim.
          if ( !gl_FrontFacing ) col = mix( uLilyUnder, col, 0.25 );
          col = mix( col, uLilyUnder * 0.8 + col * 0.2, wall );
          diffuseColor.rgb *= col;
        }`);
  };
  mat.customProgramCacheKey = () => 'procedural-autumn-lily-v3';
  return mat;
}
