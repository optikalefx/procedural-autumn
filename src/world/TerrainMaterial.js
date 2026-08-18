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
    // The palette's rock colours are RENDERED targets, not albedos. Feed them
    // in raw and the scene's cool sky ambient carries them straight past
    // lavender-grey into saturated blue wherever the sun does not reach — which
    // is half of every massif and all of every gorge. Pre-warming the albedo by
    // a measured amount is what lands the *rendered* rock on the palette.
    uRockWarm:    { value: PALETTE.rockWarm.clone() },
    uScree:       { value: PALETTE.scree.clone() },
    uSnow:        { value: PALETTE.snow.clone() },
    uSand:        { value: PALETTE.sand.clone() },
    // Leaf litter under the deciduous canopy. Warm russet, low chroma — it has
    // to sit *under* the trees without competing with them.
    uLitter:      { value: new THREE.Color(0xb8814e).convertSRGBToLinear() },
    // Shade tint. This used to push violet, on the old "cool complementary
    // shadow" guidance, and it was measurably wrong: blue+violet+magenta ran
    // 17-41% of chromatic pixels across the canonical views where the reference
    // plates sit at about 1%. The ambient in this scene is already a cool sky
    // colour, so anything unlit drifts blue on its own; what shade needs from
    // the albedo is a *warm* nudge back, not more blue. Luminance-normalised so
    // it shifts hue without crushing value.
    uShadowTint:  { value: new THREE.Vector3(1.18, 1.07, 0.92) },

    uSnowLine:    { value: 268.0 },

    // Dev only, always 0 in the shipped frame. Set from the console or the
    // capture harness to false-colour the surface masks:
    //   window.__terrain.material.userData.uniforms.uDebugMask.value = 1
    // 1 = grass(green) / rock(red) / scree(blue), 2 = curvature, 3 = sediment.
    // Working out which of six overlapping masks owns a grey hillside by
    // reading the code is slow and unreliable; looking at it takes one capture.
    uDebugMask:   { value: 0 },
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
      uniform vec3 uDirt, uRockLit, uRockMid, uRockShadow, uRockWarm, uScree;
      uniform vec3 uSnow, uSand, uLitter;
      uniform vec3 uShadowTint;
      uniform float uSnowLine;
      uniform float uDebugMask;

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

        // ── macro form, read from the heightfield at a screen-sized stencil ──
        // Two things come out of this and both matter.
        //
        // First, the stencil GROWS WITH DISTANCE. Sampling the heightfield at a
        // fixed 8 m always aliases somewhere: by 800 m that is well under a
        // pixel and it crawls. Widening it to 60 m keeps the feature roughly
        // constant in screen space, so it cannot alias at any range — and as a
        // bonus a far massif gets its form from its big shapes rather than from
        // texel noise, which is what the reference does too.
        //
        // Second, it is read from the texture rather than from vWorldNormal.
        // The mesh normal is sampled with an epsilon that scales with the LOD
        // grid step, so it changes when a chunk swaps LOD; anything keyed on it
        // visibly pops on the LOD ring. This does not.
        float stencilM = mix(8.0, 60.0, smoothstep(90.0, 900.0, camDist));
        vec2 e2 = vec2(stencilM / uWorldSize, 0.0);
        float hL = texture2D(uDataTex, uvw - e2.xy).r;
        float hR = texture2D(uDataTex, uvw + e2.xy).r;
        float hD = texture2D(uDataTex, uvw - e2.yx).r;
        float hU = texture2D(uDataTex, uvw + e2.yx).r;
        vec3 Nm = normalize(vec3(hL - hR, stencilM * 2.0, hD - hU));
        // Positive in hollows, negative on ridge lips. Normalised by the
        // stencil so its magnitude means the same thing at every distance.
        float curv = ((hL + hR + hD + hU) * 0.25 - data.r) / (stencilM * 0.28);

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
        // Grass holds to about 36 degrees before rock starts winning. The old
        // 30-degree cut stripped every massif back to bare rock from mid-height
        // up, and a bare massif is a desaturated one: the peaks view measured
        // chromaMean 0.13 against a reference range of 0.28-0.42. In all five
        // reference plates gold climbs a long way up the hills and rock is
        // reserved for genuine faces and summits.
        float steep = smoothstep(0.72, 1.30, slope);
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
        // Olive has to clear a high bar. Moisture saturates along every
        // watercourse, so a 0.74 threshold handed 55% olive to every riverbank
        // in the valley — which is most of where the player drives — and with
        // the damp darkening on top the banks came out the colour of mud.
        float oliveM = massEdge(wet + macro2 * 0.16, 0.84);
        float dryM   = massEdge(macro * 0.55 + macro2 * 0.45 - moist * 0.30, 0.56);

        vec3 grass = uGrassGold;
        grass = mix(grass, uGrassOlive, oliveM * 0.45);
        grass = mix(grass, uGrassDry,   dryM * 0.62);
        // Slow tonal drift inside each mass, so a big flat area still has life.
        // Kept light: uGrassDeep is a dark orange, and leaning on it turns the
        // meadow the colour of brick once the cool shadow tint lands on top.
        grass = mix(grass, uGrassDeep, (1.0 - macro2) * 0.13 + meso * 0.10);
        // Close-range value life. The 16 m octave is the one that matters here:
        // at 15 m from the bonnet the 65 m octave above is a constant, and with
        // only that the meadow came out as a single unmodulated orange sheet
        // that read as flat vector art rather than as ground.
        grass *= 0.90 + meso * 0.13 + fine * 0.14;

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
        // Biased toward the light end and pre-warmed. Rock in the reference is
        // a HIGH-VALUE lavender-grey in sun and still high-value in shade; the
        // old mid-weighted base plus a 42% pull toward rockShadow (which is a
        // very dark violet) gave a massif whose shaded half was a low-value
        // blue slab — measured at 46% blue+violet on the peaks view against a
        // reference that runs about 1%.
        vec3 rock = mix(uRockMid, uRockLit, smoothstep(0.24, 0.80, macro));
        // Only a whisper of warm. At 0.30 the massifs came out peach and read
        // as sand dunes rather than rock, which the palette forbids outright.
        // The lavender has to survive a warm key light, so the albedo stays
        // cool and the shade rebalance below does the anti-blue work instead.
        rock = mix(rock, uRockWarm, 0.14);
        rock = mix(rock, uRockShadow, smoothstep(0.58, 0.16, macro2) * 0.22);
        float bedStep = (hardRock - 0.5) * 2.0;                  // -1 .. 1
        rock *= 1.0 + bedStep * 0.11 * smoothstep(0.60, 1.05, slope);
        // Jointing, as broad BLOCKS and not as drawn lines.
        //
        // A fracture-trace version of this lived here and was removed on the
        // evidence: however it was weighted — screen-space width, world-space
        // width, gated to steep ground — a thin dark curve wandering across a
        // shaded face is read by the eye as a contour line on a map, which is
        // precisely the artefact this whole pass exists to eliminate. The close
        // reference plate shows rock as almost untextured, and the relief that
        // genuinely breaks a face into plates is geometry (the crag pass), not
        // albedo. Two decorrelated fields at different angles giving a couple of
        // percent of value difference between blocks is all albedo should do.
        vec2 jr = vec2(vWorldPos.x * 0.94 - vWorldPos.z * 0.34,
                       vWorldPos.x * 0.34 + vWorldPos.z * 0.94);
        float j1 = fbm(jr * 0.085, 2);
        float j2 = fbm(jr.yx * 0.052 + 19.3, 2);
        rock *= 0.93 + smoothstep(-0.02, 0.02, j1) * 0.07 * fMeso
                     + smoothstep(-0.02, 0.02, j2) * 0.06 * fFine;

        // Faceting by aspect. The reference paints a massif as a handful of
        // planes at slightly different values, and the cue it uses is which way
        // each plane faces. The tone is put through a soft staircase rather
        // than left as a sine, because a sine is a gradient and the whole point
        // of the reference look is broad flat masses with definite edges
        // between them. Soft, not hard: a hard step would alias at range.
        float aspect = atan(Nm.z, Nm.x);
        float faceRaw = 0.5 + 0.5 * sin(aspect * 3.0 + macro * 5.0);
        float fq = faceRaw * 3.0;
        float faceTone = (floor(fq) + smoothstep(0.30, 0.70, fract(fq))) / 3.0;
        // Amplitude tapers in as the camera pulls back. Close up the real
        // geometry supplies the form and a strong aspect step just looks like
        // paint; at 500 m the form is gone and this is the only thing keeping a
        // massif from being one value. Floored well above zero so rock stays
        // the high-value material the reference makes it — it should read
        // lighter than the gold beside it, not darker.
        rock *= 0.88 + faceTone * (0.16 + 0.26 * (1.0 - fMeso));
        // Broad tonal drift so a big face is never one flat value.
        rock *= 0.92 + macro * 0.11 + macro2 * 0.08;
        // Crease and lip. This is the cue the close reference plates lean on
        // hardest: rock there is nearly untextured, and what makes it read is a
        // dark line where two planes meet and a bright edge where one turns
        // over. It is a cheap ambient-occlusion proxy off the same heightfield,
        // and because the stencil tracks screen size it never crawls.
        rock *= 1.0 - smoothstep(0.15, 1.10, curv) * 0.30;
        rock *= 1.0 + smoothstep(-0.20, -1.10, curv) * 0.16;
        // Close-range weathering grain. Both terms are already distance-faded
        // to their own mean, so this buys texture on the face you are standing
        // under without putting anything on the ridge two kilometres away —
        // which is where an unfaded octave of this strength would crawl.
        rock *= 0.90 + meso * 0.11 + fine * 0.12;

        // ── assemble ───────────────────────────────────────────────────────
        vec3 albedo = grass;

        // Dry stream beds and gullies: flow accumulation below the river
        // threshold, i.e. the rills the bake actually cut. Gravel, not dirt.
        //
        // The threshold used to open at ~65 upstream cells, which is nearly
        // every swale in the meadow — so more than half the drivable ground
        // wore a lavender-grey gravel wash and read as untextured plate rather
        // than as meadow. A dry bed is a feature, not a ground type: it starts
        // where a channel is genuinely established. The mix is also warmer now;
        // scree grey belongs on the mountain, not in the valley.
        float bedM = smoothstep(0.44, 0.60, logFlow) * (1.0 - steep);
        vec3 gravel = mix(uDirt, uScree, 0.18 + fine * 0.22);
        albedo = mix(albedo, gravel, bedM * 0.55);

        // Exposed bedrock. Two ways it reaches daylight on gentle ground:
        // a resistant bed standing proud of a shoulder, and a river scouring
        // its banks down to rock. The reference art leans hard on the second —
        // gold grass sitting in defined blobs on lavender bedrock is the whole
        // look of the gorge plates — and it never happens if rock is gated on
        // slope alone.
        //
        // Both need a slope gate. Scouring had none, so on the flat ground
        // beside a big channel — where the flow term saturates — it threw a
        // hard-edged mass edge across the whole bank, and with the 65 m octave
        // breaking the threshold the result was interlocking grey and gold
        // jigsaw pieces: camouflage, not geology. A river cuts rock where it has
        // a bank to cut, which means ground with a gradient.
        float ribM = massEdge(hardRock, 0.72) * smoothstep(0.30, 0.62, slope);
        float scourM = smoothstep(0.40, 0.62, logFlow)
                     * smoothstep(0.26, 0.60, slope)
                     * massEdge(hardRock + macro2 * 0.3, 0.62);
        albedo = mix(albedo, rock, max(ribM, scourM) * 0.72);

        // The main grass/rock line. Grass does not stop at a clean contour: it
        // climbs the gullies, holds on the benches, and gives out on the
        // buttresses between them. Breaking the threshold with two scales of
        // noise and resolving it as a mass edge is what turns a bare striped
        // cone back into a mountain with places on it.
        // The breaker is led by the 240 m octave rather than the 65 m one: the
        // reference puts gold on a hillside in a few big definite blobs, and
        // keying the boundary on the finer octave produced confetti — dozens of
        // small patches that read as speckle at any distance.
        // The noise may RUFFLE the boundary; it may not invent rock. Added
        // unconditionally it painted a 240 m plate of bare lavender across
        // whatever grassy hillside its blob happened to land on, which is
        // exactly the "flat grey shelf that reads as missing material" note
        // from the art review. Scaling the breakers by how close the slope
        // already is to rock keeps them working on the edge and nowhere else.
        float edgeBreak = smoothstep(0.06, 0.55, steep);
        float rockM = clamp(steep * 1.30 - 0.16
                          + ((macro - 0.5) * 0.62 + (macro2 - 0.5) * 0.20) * fMacro * edgeBreak
                          + (meso - 0.5) * 0.20 * fMeso * edgeBreak
                          + smoothstep(198.0, 300.0, vWorldPos.y) * 0.42, 0.0, 1.0);
        albedo = mix(albedo, rock, massEdge(rockM, 0.44));

        // Hollows and lips, applied to whatever ended up on the surface. On
        // rock this is the crease between two planes; on a grassy flank it is
        // the shading in the gullies, and it is the thing that stops a big
        // slope reading as one smooth painted ramp. Geometric, so it tracks the
        // real drainage the bake cut rather than inventing texture.
        albedo *= 1.0 - smoothstep(0.20, 1.15, curv) * 0.20;
        albedo *= 1.0 + smoothstep(-0.25, -1.15, curv) * 0.11;

        // Scree: the sim records where talus and alluvium came to rest. It
        // piles at cliff bases, which is exactly where the reference puts it.
        // Gated on slope as well as on the sediment map: the droplet sim drops
        // grit on plenty of flat valley ground too, and taking the sediment map
        // at face value laid a grey talus plate across the meadow.
        float screeM = smoothstep(0.34, 0.72, loose)
                     * smoothstep(0.18, 0.46, slope)
                     // Talus cannot cling to a cliff. The old cut-off at
                     // 45-55 degrees let scree sheet over entire gorge walls,
                     // and a wall of flat pale grit next to damp olive grass
                     // reads as camouflage rather than as rock and meadow.
                     // Debris comes to rest at the angle of repose, ~35 deg.
                     * (1.0 - smoothstep(0.62, 0.95, slope));
        vec3 screeCol = mix(uScree, uRockMid, meso * 0.45);
        albedo = mix(albedo, screeCol, screeM * 0.66);

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
        // The darkening itself is neutral-to-warm now. A cool multiplier here
        // stacked on top of a cool sky ambient, and the gorge and plunge-pool
        // views came back with a quarter of every chromatic pixel reading blue.
        // Wet rock is *darker*; the cool note is atmosphere's job, not albedo's.
        float damp = max(smoothstep(0.50, 0.02, depth) * step(0.001, depth),
                         smoothstep(0.34, 0.72, river) * 0.30);
        albedo = mix(albedo, albedo * vec3(0.70, 0.66, 0.62), damp);

        // ── snow: genuine high alpine only, wind-scoured off the steep faces ─
        float snowSel = smoothstep(uSnowLine, uSnowLine + 52.0,
                                   vWorldPos.y + fbm(vWorldPos.xz * 0.008, 3) * 30.0);
        snowSel *= 1.0 - smoothstep(0.85, 1.30, slope);
        albedo = mix(albedo, uSnow, snowSel);

        if (uDebugMask > 0.5) {
          float m = massEdge(rockM, 0.44);
          if (uDebugMask < 1.5)      albedo = vec3(m, 1.0 - m, screeM);
          else if (uDebugMask < 2.5) albedo = vec3(max(0.0, curv), 0.0, max(0.0, -curv));
          else if (uDebugMask < 3.5) albedo = vec3(loose, bedM, slope * 0.5);
          else                       albedo = vec3(oliveM, dryM, litterM);
        }

        diffuseColor.rgb *= albedo;
      }`
    ).replace(
      '#include <dithering_fragment>',
      /* glsl */`
      // Shade rebalance. The sky ambient is a cool blue, so anything turned
      // away from the sun drifts periwinkle on its own; this pulls it back
      // toward the warm end. It is a tint at low strength, not a hue
      // replacement — a shaded meadow should read as a deeper gold, and a
      // shaded cliff as lavender-grey, never as saturated blue.
      {
        float ndl = clamp(dot(normalize(vWorldNormal), normalize(uSunDir)), 0.0, 1.0);
        float shade = 1.0 - smoothstep(0.0, 0.38, ndl);
        gl_FragColor.rgb = mix(gl_FragColor.rgb,
                               gl_FragColor.rgb * uShadowTint,
                               shade * 0.34);
      }
      #include <dithering_fragment>`
    );
  };

  mat.customProgramCacheKey = () => 'procedural-autumn-terrain-v2';
  void opts;
  return mat;
}
