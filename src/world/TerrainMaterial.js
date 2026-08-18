// ─────────────────────────────────────────────────────────────────────────────
//  Terrain material — a MeshStandardMaterial hijacked at compile time so we keep
//  three's shadow/light plumbing but drive albedo, normal detail and the
//  warm/cool shadow split entirely from procedural rules.
//
//  Two principles run through the whole shader:
//
//  1. STRUCTURE COMES FROM THE BAKE, NOT FROM NOISE. Slope, bedded hardness,
//     talus/alluvium and flow accumulation are all real fields produced by
//     TerrainGen, and they are already at 2 m resolution. Painting from them
//     means the strata land on the actual benches and the gravel lands in the
//     actual stream beds. Procedural noise is used only to break up edges.
//
//  2. EVERY FREQUENCY HAS A DISTANCE BUDGET. Any albedo detail finer than a
//     couple of screen pixels crawls when the camera moves. Each octave here
//     fades to its own mean over a range chosen for its wavelength, so distant
//     slopes settle into flat colour masses — which is also exactly how the
//     reference art reads.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { PALETTE } from './WorldConfig.js';

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
    uRockLit:     { value: PALETTE.rockLit.clone() },
    uRockMid:     { value: PALETTE.rockMid.clone() },
    uRockShadow:  { value: PALETTE.rockShadow.clone() },
    uScree:       { value: PALETTE.scree.clone() },
    uSnow:        { value: PALETTE.snow.clone() },
    uSand:        { value: PALETTE.sand.clone() },
    // Leaf litter under the deciduous canopy. Warm russet, low chroma — it has
    // to sit *under* the trees without competing with them.
    uLitter:      { value: new THREE.Color(0xb8814e).convertSRGBToLinear() },
    // Luminance-normalised so tinting shifts hue without crushing values.
    uShadowTint:  { value: new THREE.Vector3(0.84, 0.88, 1.16) },

    uSnowLine:    { value: 268.0 },
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
      uniform vec3 uDirt, uRockLit, uRockMid, uRockShadow, uScree;
      uniform vec3 uSnow, uSand, uLitter;
      uniform vec3 uShadowTint;
      uniform float uSnowLine;

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

      // The reference art reads as broad colour *masses* with definite edges,
      // not as a gradient between two tints. Thresholding a smooth field with a
      // width taken from its own screen-space derivative gives exactly that:
      // a crisp boundary at any distance, antialiased for free, and it degrades
      // to a flat mass rather than to noise as the pixel footprint grows.
      float massEdge(float field, float threshold){
        float w = max(fwidth(field) * 1.4, 0.010);
        return smoothstep(threshold - w, threshold + w, field);
      }
    ` + shader.fragmentShader.replace(
      '#include <color_fragment>',
      /* glsl */`
      #include <color_fragment>
      {
        vec2 uvw = (vWorldPos.xz / uWorldSize) + 0.5;
        vec4 data = texture2D(uDataTex, uvw);
        vec4 aux  = texture2D(uAuxTex, uvw);

        float slope   = aux.r;          // |gradient|, 1.0 == 45 degrees
        float loose   = aux.b;          // talus / alluvium deposited by the sim
        float logFlow = aux.a;          // log(1 + upstream cells) / 14
        float river   = data.b;
        float moist   = data.a;
        float waterH  = data.g;
        float depth   = max(0.0, waterH - vWorldPos.y);

        vec3 N = normalize(vWorldNormal);
        float camDist = length(vWorldPos - cameraPosition);

        // ── frequency budget ───────────────────────────────────────────────
        // Each band fades to its own mean once a cycle is worth about two
        // pixels. Without this the fine octaves crawl on every distant slope.
        float fFine = 1.0 - smoothstep(38.0, 130.0, camDist);
        float fMeso = 1.0 - smoothstep(150.0, 520.0, camDist);
        float fMacro= 1.0 - smoothstep(900.0, 2000.0, camDist);

        float macro  = fbm(vWorldPos.xz * 0.0042, 4) * 0.5 + 0.5;       // ~240 m
        float macro2 = fbm(vWorldPos.xz * 0.0155 + 31.4, 3) * 0.5 + 0.5; // ~65 m
        float meso   = mix(0.5, fbm(vWorldPos.xz * 0.062 + 7.7, 3) * 0.5 + 0.5, fMeso);
        float fine   = mix(0.5, fbm(vWorldPos.xz * 0.47, 3) * 0.5 + 0.5, fFine);

        // ── bedded hardness, sampled defensively ───────────────────────────
        // The bake dips its bedding planes, so outcrop traces already cut
        // across a hillside rather than following a contour. Two extra guards,
        // because contour banding is the artefact that most loudly announces
        // "procedural" and it is cheap to make impossible:
        //   · a ~14 m domain warp, so a trace wanders like a real outcrop
        //     instead of drawing a clean level curve;
        //   · contrast that dies with distance, because at 2 m per texel one
        //     band is sub-pixel by ~500 m and would alias into moire.
        // Only the hardness lookup is warped — slope, sediment and flow must
        // stay registered to the geometry they describe.
        vec2 bedWarp = vec2(fbm(vWorldPos.xz * 0.011 + 11.3, 2),
                            fbm(vWorldPos.xz * 0.011 + 53.7, 2)) * (14.0 / uWorldSize);
        float hardRaw = texture2D(uAuxTex, uvw + bedWarp).g;
        float bandFade = 1.0 - smoothstep(240.0, 760.0, camDist);
        float hardRock = mix(0.5, hardRaw, bandFade);

        // Slope taken from the baked field rather than the vertex normal: it is
        // identical at every LOD, so the grass/rock line never crawls or pops
        // when a chunk swaps resolution.
        float steep = smoothstep(0.58, 1.12, slope);
        float bench = 1.0 - smoothstep(0.10, 0.34, slope);   // flat shelf / meadow

        // ── ground cover: gold meadow, olive damp grass, pale dry straw ─────
        // Gold is the key and must dominate; olive is an accent that only wins
        // where the ground is genuinely damp. Patch edges rather than gradients
        // are what make this read as painted masses.
        // Gold has to win by a wide margin. Keyed on moisture alone, olive took
        // every riverbank and hollow in the valley — which is most of where the
        // player drives — and the game stopped being gold. Olive is now a
        // genuinely wet-ground accent and it never fully replaces the key.
        float wet    = macro * 0.30 + moist * 0.70;
        float oliveM = massEdge(wet + macro2 * 0.16, 0.74);
        float dryM   = massEdge(macro * 0.55 + macro2 * 0.45 - moist * 0.30, 0.56);

        vec3 grass = uGrassGold;
        grass = mix(grass, uGrassOlive, oliveM * 0.55);
        grass = mix(grass, uGrassDry,   dryM * 0.62);
        // Slow tonal drift inside each mass, so a big flat area still has life.
        // Kept light: uGrassDeep is a dark orange, and leaning on it turns the
        // meadow the colour of brick once the cool shadow tint lands on top.
        grass = mix(grass, uGrassDeep, (1.0 - macro2) * 0.13 + meso * 0.07);
        grass *= 0.93 + meso * 0.08 + fine * 0.11;

        // Leaf litter accumulates on damp, sheltered, gently sloping ground —
        // which is where the forest will be. Patchy, because it drifts, and
        // restrained: this sits *under* the trees and must not read as mud.
        float litterM = massEdge(moist * 0.72 + macro2 * 0.28, 0.68)
                      * bench * (1.0 - smoothstep(150.0, 205.0, vWorldPos.y));
        grass = mix(grass, uLitter, litterM * 0.28);

        // ── rock ───────────────────────────────────────────────────────────
        // Value comes from the regional fields and from which way the face
        // points. Bedded hardness gets a *small* tonal step on top, and only
        // where a bed could genuinely outcrop.
        //
        // This is the important line in the whole shader. Hardness is a
        // periodic function of surface height, so mapping it across the full
        // rockShadow..rockLit range paints perfect level curves on every peak —
        // wood grain, or a contour map, and it announces "procedural" from
        // across the valley. Geology earns a tonal hint, not the value range.
        vec3 rock = mix(uRockMid, uRockLit, smoothstep(0.42, 0.88, macro));
        rock = mix(rock, uRockShadow, smoothstep(0.62, 0.20, macro2) * 0.42);
        float bedStep = (hardRock - 0.5) * 2.0;                  // -1 .. 1
        rock *= 1.0 + bedStep * 0.11 * smoothstep(0.60, 1.05, slope);
        // Jointing: two decorrelated low-frequency bands crossing at an angle.
        // Cheap, never axis-aligned, and it survives being fully faded out.
        vec2 jr = vec2(vWorldPos.x * 0.94 - vWorldPos.z * 0.34,
                       vWorldPos.x * 0.34 + vWorldPos.z * 0.94);
        float joint = fbm(jr * 0.085 + vHeight * 0.006, 2) * 0.5 + 0.5;
        rock = mix(rock, rock * 0.86, smoothstep(0.62, 0.86, joint) * fMeso * 0.55);

        // Faceting by aspect. The reference paints a massif as a handful of
        // planes at slightly different values, and the cue it uses is which way
        // each plane faces. Driving the tone from the surface normal gives that
        // for free, and because it is geometric it cannot shimmer or crawl at
        // any distance — unlike a texture at the same apparent frequency.
        float aspect = atan(N.z, N.x);
        float faceTone = 0.5 + 0.5 * sin(aspect * 3.0 + macro * 5.0);
        rock *= 0.88 + faceTone * 0.24;
        // Broad tonal drift so a big face is never one flat value.
        rock *= 0.90 + macro * 0.14 + macro2 * 0.10;
        // Close-range weathering grain. Both terms are already distance-faded
        // to their own mean, so this buys texture on the face you are standing
        // under without putting anything on the ridge two kilometres away —
        // which is where an unfaded octave of this strength would crawl.
        rock *= 0.88 + meso * 0.14 + fine * 0.12;

        // ── assemble ───────────────────────────────────────────────────────
        vec3 albedo = grass;

        // Dry stream beds and gullies: flow accumulation below the river
        // threshold, i.e. the rills the bake actually cut. Gravel, not dirt.
        float bedM = smoothstep(0.30, 0.46, logFlow) * (1.0 - steep);
        vec3 gravel = mix(uDirt, uScree, 0.35 + fine * 0.30);
        albedo = mix(albedo, gravel, bedM * 0.60);

        // Exposed bedrock. Two ways it reaches daylight on gentle ground:
        // a resistant bed standing proud of a shoulder, and a river scouring
        // its banks down to rock. The reference art leans hard on the second —
        // gold grass sitting in defined blobs on lavender bedrock is the whole
        // look of the gorge plates — and it never happens if rock is gated on
        // slope alone.
        float ribM = massEdge(hardRock, 0.72) * smoothstep(0.30, 0.62, slope);
        float scourM = smoothstep(0.40, 0.62, logFlow) * massEdge(hardRock + macro2 * 0.3, 0.62);
        albedo = mix(albedo, rock, max(ribM, scourM) * 0.78);

        // The main grass/rock line. Grass does not stop at a clean contour: it
        // climbs the gullies, holds on the benches, and gives out on the
        // buttresses between them. Breaking the threshold with two scales of
        // noise and resolving it as a mass edge is what turns a bare striped
        // cone back into a mountain with places on it.
        float rockM = clamp(steep * 1.12 - 0.08
                          + (macro2 - 0.5) * 0.50 * fMacro
                          + (meso - 0.5) * 0.26 * fMeso
                          + smoothstep(165.0, 255.0, vWorldPos.y) * 0.45, 0.0, 1.0);
        albedo = mix(albedo, rock, massEdge(rockM, 0.44));

        // Scree: the sim records where talus and alluvium came to rest. It
        // piles at cliff bases, which is exactly where the reference puts it.
        float screeM = smoothstep(0.10, 0.42, loose) * (1.0 - smoothstep(0.95, 1.35, slope));
        vec3 screeCol = mix(uScree, uRockMid, meso * 0.45);
        albedo = mix(albedo, screeCol, screeM * 0.72);

        // Shelves. A terrace cut into a massif is nearly flat, so it misses
        // every slope-driven rule above and comes out as a bare grey plate —
        // the one place the terrain still reads as untextured. Anything that
        // lands on a ledge stays there: broken rock, wind-blown grit, and
        // enough tough grass to break the plane up.
        float shelfM = bench * smoothstep(0.30, 0.70, rockM) * (1.0 - screeM);
        albedo = mix(albedo, mix(screeCol, uGrassDry, 0.30 + macro2 * 0.34), shelfM * 0.62);

        // ── water margins ──────────────────────────────────────────────────
        float shore = smoothstep(1.6, 0.0, depth);
        vec3 riverBed = mix(uSand, uRockMid, 0.42 + fine * 0.28);
        albedo = mix(albedo, riverBed, smoothstep(0.02, 0.26, river) * 0.85);
        albedo = mix(albedo, uSand, shore * smoothstep(0.04, 0.22, river) * 0.30);
        // Damp darkening: a band of wet ground either side of the waterline,
        // plus genuinely submerged bed. Wet rock is darker and a touch cooler.
        // Restrained: at 0.55 over the whole river mask this swallowed every
        // gorge and plunge pool in the game into one flat violet mass. Wet rock
        // is a band along the waterline, not a region.
        float damp = max(smoothstep(0.50, 0.02, depth) * step(0.001, depth),
                         smoothstep(0.34, 0.72, river) * 0.30);
        albedo = mix(albedo, albedo * vec3(0.62, 0.64, 0.71), damp);

        // ── snow: genuine high alpine only, wind-scoured off the steep faces ─
        float snowSel = smoothstep(uSnowLine, uSnowLine + 52.0,
                                   vWorldPos.y + fbm(vWorldPos.xz * 0.008, 3) * 30.0);
        snowSel *= 1.0 - smoothstep(0.85, 1.30, slope);
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
                               shade * 0.38);
      }
      #include <dithering_fragment>`
    );
  };

  mat.customProgramCacheKey = () => 'procedural-autumn-terrain-v2';
  void opts;
  return mat;
}
