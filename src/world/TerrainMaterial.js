// ─────────────────────────────────────────────────────────────────────────────
//  Terrain material — a MeshStandardMaterial hijacked at compile time so we keep
//  three's shadow/light plumbing but drive albedo, normal detail and the
//  warm/cool shadow split entirely from procedural rules.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { PALETTE, WORLD } from './WorldConfig.js';

export function createTerrainMaterial(world, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0,
    dithering: true,
    flatShading: false,
  });

  const uniforms = {
    uDataTex:     { value: world.dataTexture },
    uAuxTex:      { value: world.auxTexture },
    uWorldSize:   { value: world.worldSize },
    uTime:        { value: 0 },
    uSunDir:      { value: new THREE.Vector3(0.4, 0.6, 0.3) },

    uGrassGold:   { value: PALETTE.grassGoldLit.clone() },
    uGrassDeep:   { value: PALETTE.grassGoldDeep.clone() },
    uGrassOlive:  { value: PALETTE.grassOlive.clone() },
    uGrassDry:    { value: PALETTE.grassDry.clone() },
    uDirt:        { value: PALETTE.dirtPath.clone() },
    uDirtDark:    { value: PALETTE.dirtDark.clone() },
    uRockLit:     { value: PALETTE.rockLit.clone() },
    uRockMid:     { value: PALETTE.rockMid.clone() },
    uRockShadow:  { value: PALETTE.rockShadow.clone() },
    uSnow:        { value: PALETTE.snow.clone() },
    uSand:        { value: PALETTE.sand.clone() },
    // Luminance-normalised so tinting shifts hue without crushing values.
    uShadowTint:  { value: new THREE.Vector3(0.84, 0.88, 1.16) },

    uSnowLine:    { value: 262.0 },
    uMacroStrength: { value: 0.55 },
  };

  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    mat.userData.shader = shader;

    shader.vertexShader = /* glsl */`
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying float vHeight;
    ` + shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
       vec4 _wp = modelMatrix * vec4( transformed, 1.0 );
       vWorldPos = _wp.xyz;
       vWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
       vHeight = _wp.y;`
    );

    shader.fragmentShader = /* glsl */`
      uniform sampler2D uDataTex;
      uniform sampler2D uAuxTex;
      uniform float uWorldSize;
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uGrassGold, uGrassDeep, uGrassOlive, uGrassDry;
      uniform vec3 uDirt, uDirtDark, uRockLit, uRockMid, uRockShadow;
      uniform vec3 uSnow, uSand;
      uniform vec3 uShadowTint;
      uniform float uSnowLine, uMacroStrength;

      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying float vHeight;

      // ── cheap value-noise stack ──────────────────────────────────────────
      vec2 hash22(vec2 p){
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
      }
      float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(dot(hash22(i + vec2(0,0)), f - vec2(0,0)),
                       dot(hash22(i + vec2(1,0)), f - vec2(1,0)), u.x),
                   mix(dot(hash22(i + vec2(0,1)), f - vec2(0,1)),
                       dot(hash22(i + vec2(1,1)), f - vec2(1,1)), u.x), u.y);
      }
      float fbm(vec2 p, int oct){
        float a = 0.5, s = 0.0, n = 0.0;
        for (int i = 0; i < 7; i++){
          if (i >= oct) break;
          s += a * vnoise(p); n += a; a *= 0.5; p *= 2.07;
        }
        return s / n;
      }
      // Worley for rock cracking
      float worley(vec2 p){
        vec2 i = floor(p), f = fract(p);
        float d = 8.0;
        for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++){
          vec2 g = vec2(float(x), float(y));
          vec2 o = 0.5 + 0.5 * hash22(i + g);
          d = min(d, length(g + o - f));
        }
        return d;
      }
    ` + shader.fragmentShader.replace(
      '#include <color_fragment>',
      /* glsl */`
      #include <color_fragment>
      {
        vec2 uvw = (vWorldPos.xz / uWorldSize) + 0.5;
        vec4 data = texture2D(uDataTex, uvw);
        vec4 aux  = texture2D(uAuxTex, uvw);

        float slope   = aux.r;
        float hardRock= aux.g;
        float sedim   = aux.b;
        float river   = data.b;
        float moist   = data.a;
        float waterH  = data.g;
        float depth   = max(0.0, waterH - vWorldPos.y);

        vec3 N = normalize(vWorldNormal);
        float flat_ = clamp(N.y, 0.0, 1.0);
        float steep = 1.0 - smoothstep(0.55, 0.90, flat_);

        // ── macro variation: big painterly patches, like the concept art ────
        float macro  = fbm(vWorldPos.xz * 0.0042, 4) * 0.5 + 0.5;
        float macro2 = fbm(vWorldPos.xz * 0.0165 + 31.4, 4) * 0.5 + 0.5;
        float meso   = fbm(vWorldPos.xz * 0.075 + 7.7, 3) * 0.5 + 0.5;
        float micro  = fbm(vWorldPos.xz * 0.62, 3) * 0.5 + 0.5;

        // ── ground: gold meadow <-> olive damp grass <-> dry straw ─────────
        // Gold is the dominant key; olive is an accent that only wins where the
        // ground is genuinely wet. This is the single biggest colour decision.
        float goldSel = clamp(macro * 0.55 + macro2 * 0.35 - moist * 0.30 + 0.48, 0.0, 1.0);
        vec3 grass = mix(uGrassOlive, uGrassGold, smoothstep(0.12, 0.58, goldSel));
        grass = mix(grass, uGrassDry, smoothstep(0.62, 1.00, goldSel) * 0.45);
        grass = mix(grass, uGrassDeep, meso * 0.22);
        // damp riverbanks and shaded hollows keep their green
        grass = mix(grass, uGrassOlive, smoothstep(0.66, 0.95, moist) * 0.55);
        // fine tonal break-up so it never reads as flat vertex colour
        grass *= 0.90 + micro * 0.20;

        // ── rock: layered strata + worley cracking ─────────────────────────
        float strata = sin(vWorldPos.y * 0.42 + fbm(vWorldPos.xz * 0.02, 3) * 5.5) * 0.5 + 0.5;
        // Jointing at a believable scale — a few metres, not a few centimetres,
        // otherwise it reads as dirt specks sprayed over the rock.
        float crack  = smoothstep(0.03, 0.34, worley(vWorldPos.xz * 0.055 + vWorldPos.y * 0.012));
        vec3 rock = mix(uRockMid, uRockLit, strata * 0.65 + macro2 * 0.35);
        rock = mix(uRockShadow, rock, 0.58 + crack * 0.42);
        rock *= 0.88 + fbm(vWorldPos.xz * 0.9 + vWorldPos.y * 0.4, 3) * 0.24;
        rock = mix(rock, uRockLit * 1.04, smoothstep(0.55, 0.95, hardRock) * 0.35);

        // ── dirt / scree on medium slopes and eroded gullies ───────────────
        vec3 dirt = mix(uDirtDark, uDirt, meso * 0.7 + micro * 0.3);
        float dirtSel = smoothstep(0.30, 0.62, slope) * (1.0 - steep) + sedim * 0.45;

        // ── assemble ───────────────────────────────────────────────────────
        vec3 albedo = grass;
        albedo = mix(albedo, dirt, clamp(dirtSel, 0.0, 0.75));
        albedo = mix(albedo, rock, steep);
        // exposed bedrock ribs on hard bands even where it is not that steep
        albedo = mix(albedo, rock, smoothstep(0.82, 0.97, hardRock) * smoothstep(0.18, 0.42, slope) * 0.8);

        // river gravel bed + damp darkening near water
        float shore = smoothstep(1.6, 0.0, depth);
        vec3 gravel = mix(uSand, uRockMid, 0.45 + micro * 0.3);
        albedo = mix(albedo, gravel, smoothstep(0.02, 0.30, river) * 0.85);
        albedo = mix(albedo, albedo * 0.62, smoothstep(0.6, 0.02, depth) * step(0.001, depth));
        albedo = mix(albedo, uSand, shore * smoothstep(0.05, 0.25, river) * 0.35);

        // snow on high, flat ground with a wind-scoured edge
        float snowSel = smoothstep(uSnowLine, uSnowLine + 46.0, vWorldPos.y + fbm(vWorldPos.xz * 0.01, 3) * 26.0);
        snowSel *= smoothstep(0.62, 0.88, flat_);
        albedo = mix(albedo, uSnow, snowSel);

        diffuseColor.rgb *= albedo;
      }`
    ).replace(
      '#include <dithering_fragment>',
      /* glsl */`
      // Warm/cool split: shift unlit terrain toward violet without crushing it.
      {
        float ndl = clamp(dot(normalize(vWorldNormal), normalize(uSunDir)), 0.0, 1.0);
        float shade = 1.0 - smoothstep(0.0, 0.38, ndl);
        gl_FragColor.rgb = mix(gl_FragColor.rgb,
                               gl_FragColor.rgb * uShadowTint,
                               shade * 0.50);
      }
      #include <dithering_fragment>`
    );
  };

  mat.customProgramCacheKey = () => 'procedural-autumn-terrain-v1';
  return mat;
}
