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
    uDataRes:     { value: world.res },
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

    // Rock chroma governor — see the block at the end of the fragment shader.
    // uRockCast is deliberately the same vector the rocks system uses, so a
    // crag block and the massif it sits on read as the same substance.
    // Split warm/cool by sun-facing. The mean of the two is the rocks system's
    // single cast vector (0.965, 0.995, 1.085), so a crag block and the massif
    // it stands on still agree; what this adds is the palette's own lit/shadow
    // rock split, which a flat cast was averaging away.
    // REBALANCED AGAIN, and this time toward neutral on the LIT side too.
    // The warm lit cast was there to hold hero's chroma above the brief's 0.28
    // floor, and measurement says the trade did not pay: hero came back at
    // 0.273 anyway — still under the floor — while neutralPct sat at 0.1%
    // against reference plate 2's 28.4%, and a zoom on the massif showed a
    // warm putty tan where the palette specifies #c3bfcc lavender-grey and
    // says in as many words "never brown-grey". The plates are bimodal: nearly
    // neutral stone beside strongly coloured ground. Chroma is bought back on
    // the ground (uGrassSat) where it is on-palette, not on the rock where it
    // is a palette violation.
    //
    // The mean of the two is still (0.958, 0.993, 1.098) against the rocks
    // system's single cast of (0.965, 0.995, 1.085), so a crag block and the
    // massif it stands on continue to agree.
    uRockCastLit:   { value: new THREE.Vector3(0.985, 0.995, 1.045) },
    uRockCastShade: { value: new THREE.Vector3(0.930, 0.990, 1.150) },
    uRockDesat:   { value: 0.45 },
    // Value floor for governed rock, as a screen blend against 1.0. See the
    // governor block: the palette's rock is high-value lavender-grey lit and
    // still high-value in shade, and ours was rendering unlit stone at luma
    // 0.217 against a reference band of 0.40-0.70.
    uRockLift:    { value: 0.18 },
    // Pulling a colour to its own luminance loses the brightest channel, so
    // the governed result needs a gain or the massifs go a stop darker than
    // the boulders standing on them.
    uRockGain:    { value: 1.13 },
    // Counterweight to the governor. See the block at the end of the fragment
    // shader: the plates are bimodal — near-neutral stone against strongly
    // coloured ground — and greying the rock without lifting the ground gives
    // a frame that is uniformly mid-chroma instead.
    // Kept small on purpose. At 0.24 the measured chroma moved into band and the
    // frame got worse, not better: the grade already renders our gold nearer red
    // than the palette's #f0ad46, so a plain saturation gain amplifies the red
    // bias and the vehicle frame's bare slope came back a flat scarlet ramp. The
    // slope's real defect is that it has no marks on it, not that it is pale.
    // Raised with the governor. Greying the stone harder has to be paid for
    // somewhere, and the plates say it is paid on the meadow.
    uGrassSat:    { value: 0.19 },

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
      uniform float uDataRes;
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uGrassGold, uGrassDeep, uGrassOlive, uGrassDry;
      uniform vec3 uDirt, uRockLit, uRockMid, uRockShadow, uRockWarm, uScree;
      uniform vec3 uSnow, uSand, uLitter;
      uniform vec3 uShadowTint;
      uniform vec3 uRockCastLit, uRockCastShade;
      uniform float uRockDesat, uRockGain, uRockLift, uGrassSat;
      uniform float uSnowLine;
      uniform float uDebugMask;

      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying float vHeight;

      // Relief normal handed forward from the albedo block to the lighting
      // block. Declared at file scope because three's chunk order puts
      // <color_fragment> (where the heightfield is already being sampled)
      // well before <normal_fragment_maps> (where the shading normal exists),
      // and re-reading four height texels there would be pure waste.
      vec3  gReliefN = vec3(0.0, 1.0, 0.0);
      float gReliefW = 0.0;
      // Sun-facing, computed once in the shade block and reused by the rock
      // chroma governor below it.
      float gShade = 0.0;
      // How much of this fragment is bare rock. Needed after the lighting for
      // the chroma governor — see the uRockDesat block below.
      float gRockM = 0.0;
      // The same, weighted by how rock-shaped the ground under it is. The
      // governor uses this rather than gRockM so a gravel shelf in a meadow
      // keeps some of its warmth while a cliff does not.
      float gRockGov = 0.0;

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

      // ── triplanar projection ─────────────────────────────────────────────
      // Every procedural octave in this shader used to be indexed by world XZ
      // alone. That is a *planar* projection, and on a face steeper than about
      // 60 degrees a metre of surface travels only centimetres in XZ — so every
      // octave stretches into a vertical streak running the full height of the
      // face. That is the smear the critic measured across the whole drive
      // cliff and down the right of hero, and it is not a texture bug: there is
      // no texture, it is the noise itself being sampled through a projection
      // that collapses on vertical ground.
      //
      // Blending three planar samples weighted by the surface normal removes
      // it. It costs nothing on flat ground — the off-axis weights fall under
      // the cutoff and the branch is coherent across a whole hillside — and at
      // most two extra fbm evaluations on a genuinely diagonal face.
      vec3 tpWeights(vec3 n){
        vec3 w = max(abs(n) - 0.20, 0.0);
        w *= w; w *= w;                       // ^4: one axis dominates hard
        return w / max(w.x + w.y + w.z, 1e-4);
      }
      // Weights sum to 1 and anything under the cutoff contributes < 1% of a
      // signal that is itself only worth a few percent of value, so the dropped
      // terms are not renormalised.
      float fbmTP(vec3 p, int oct, vec3 w){
        float s = 0.0;
        if (w.y > 0.006) s += w.y * fbm(p.xz, oct);
        if (w.x > 0.006) s += w.x * fbm(p.zy + 61.7, oct);
        if (w.z > 0.006) s += w.z * fbm(p.xy - 24.3, oct);
        return s;
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
        // Half-texel correction. WorldData writes grid sample i at world
        // -half + i*texel, which is UV (i + 0.5)/res, not i/res. Without the
        // offset every height, slope and shoreline value the shader derives is
        // registered ~1 m off the mesh it is painted on. Measured at one point:
        // CPU 81.10 m, uncorrected sample 85.58 m, corrected 81.10 m exactly.
        vec2 uvw = (vWorldPos.xz / uWorldSize) + 0.5 + (0.5 / uDataRes);
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
        // Read from the texture rather than from vWorldNormal: the mesh normal
        // is sampled with an epsilon that scales with the LOD grid step, so it
        // changes when a chunk swaps LOD and anything keyed on it visibly pops
        // on the LOD ring. This does not.
        //
        // THE STENCIL WIDTH IS THE WHOLE DEFECT. It used to open from 8 m to
        // 60 m by 900 m, on the reasoning that a stencil should stay constant
        // in screen space. The arithmetic does not support 60 m. At the capture
        // framing one screen pixel covers about camDist * 0.0012 metres, so at
        // 900 m a 60 m stencil is *fifty pixels wide* — it blurs away every
        // bench and gully the erosion bake cut and leaves one smooth ramp, and
        // that is exactly why raking dawn light on the massifs revealed
        // nothing: there was nothing left in the signal to reveal.
        //
        // Sized at roughly six pixels instead, it resolves the 10-40 m relief
        // that is genuinely there while still being a wide enough low-pass that
        // 2 m texel noise cannot crawl through it.
        //
        // Distance alone is not enough, though. A face seen almost edge-on —
        // the whole upper half of the drive frame — has a screen footprint tens
        // of times its distance would suggest, and a stencil narrower than that
        // footprint aliases into a regular hatch of dashes. fwidth gives the
        // real world-space size of a pixel on *this* surface at *this* angle,
        // so taking the wider of the two makes the low-pass correct on a
        // grazing wall and on a face square to camera alike.
        // THE FOOTPRINT IS COMPUTED ANALYTICALLY, NOT WITH fwidth, AND THAT IS
        // THE FIX FOR THE HERRINGBONE. A screen-space derivative of an
        // interpolated attribute is *constant across a triangle* and jumps at
        // every triangle edge. Feeding it into the stencil width therefore made
        // the stencil — and so the curvature and the relief normal derived from
        // it — piecewise constant per triangle, and on a face seen edge-on that
        // printed the LOD grid onto the rock as a regular lattice of chevrons.
        // Measured on the drive cliff: pitch ~30 px at ~800 m, which is 14 m,
        // which is the LOD-3 vertex spacing exactly.
        //
        // The same quantity in closed form is continuous everywhere: a pixel
        // subtends a fixed angle, so it covers camDist * k metres square to the
        // eye and camDist * k / cos(view, normal) metres along a surface tilted
        // away from it. N is a smoothly interpolated attribute, so this varies
        // smoothly across a triangle boundary and cannot print the mesh.
        //
        // THE GRAZING TERM IS ALSO CAPPED HARD, and that is the other half of
        // the same defect. Opened to 64 m it did not merely blur — it changed
        // what the curvature below *means*. A 60 m Laplacian taken anywhere on
        // the concave lower half of a mountain flank is strongly positive over
        // the entire face, so curv saturated across the whole drive cliff and
        // the crease darkening — meant to be a crease — multiplied the largest
        // mass in that frame by 0.6 wholesale. Debug mask 2 showed it: the face
        // came back solid red, "everything here is a deep hollow". That is what
        // made it a dark muddy slab, and the chevrons were only the residual
        // structure showing through a term that was pinned everywhere else.
        vec3 Vv = normalize(cameraPosition - vWorldPos);
        float graze = max(abs(dot(Vv, N)), 0.30);
        float footM = camDist * 0.0012 / graze;
        float stencilM = clamp(max(camDist * 0.009, footM * 3.0), 7.0, 30.0);
        vec2 e2 = vec2(stencilM / uWorldSize, 0.0);
        float hL = texture2D(uDataTex, uvw - e2.xy).r;
        float hR = texture2D(uDataTex, uvw + e2.xy).r;
        float hD = texture2D(uDataTex, uvw - e2.yx).r;
        float hU = texture2D(uDataTex, uvw + e2.yx).r;
        vec3 Nm = normalize(vec3(hL - hR, stencilM * 2.0, hD - hU));

        // A second, deliberately coarse read of the same field. The aspect
        // faceting below quantises tone into three bands, and a three-step
        // staircase driven by a *fine* normal is not faceting — it is a
        // regular hatch of dashes, which is exactly what appeared across the
        // oblique cliff the moment the relief stencil was narrowed. Aspect is
        // a property of the massif's big planes, so it gets a stencil four
        // times wider and the fine relief is left to the lighting.
        // FLOORED IN WORLD UNITS, not just scaled off the fine stencil. Aspect
        // is a property of a massif's big planes — which buttress you are
        // looking at — and at vista range the fine stencil clamps to 7 m, so
        // 3.2x of it was 22 m: finer than the drainage flutes themselves. The
        // three-step aspect staircase below then quantised a signal that
        // oscillates left-right across every flute, and the result on the
        // oblique drive cliff was a regular herringbone of dark chevrons in
        // rows — measured across the entire upper third of that frame. A
        // stencil wider than the flutes cannot chevron on them.
        float coarseM = max(stencilM * 3.2, 62.0);
        vec2 e4 = vec2(coarseM / uWorldSize, 0.0);
        float cL = texture2D(uDataTex, uvw - e4.xy).r;
        float cR = texture2D(uDataTex, uvw + e4.xy).r;
        float cD = texture2D(uDataTex, uvw - e4.yx).r;
        float cU = texture2D(uDataTex, uvw + e4.yx).r;
        vec3 Nc = normalize(vec3(cL - cR, coarseM * 2.0, cD - cU));

        // Positive in hollows, negative on ridge lips. Normalised by the
        // stencil so its magnitude means the same thing at every distance.
        // Exactly zero on a plane at any steepness, so a flat cliff face is
        // untouched however severe it is — only real curvature registers.
        //
        // Read at TWO scales and blended. A Laplacian is a second derivative,
        // and a second derivative taken at one narrow radius over an eroded
        // face is dominated by the metre-scale rills the droplet sim cut: the
        // debug mask showed it flipping sign every few pixels across the whole
        // drive cliff, which is what put a regular lattice of dark dashes on it.
        // The wide read (the same taps the aspect facet uses, so it is free)
        // carries the benches and gullies that actually matter; the narrow one
        // is kept at minority weight for crispness at the lip.
        float curvF = ((hL + hR + hD + hU) * 0.25 - data.r) / (stencilM * 0.42);
        float curvC = ((cL + cR + cD + cU) * 0.25 - data.r) / (coarseM * 0.42);
        // Soft-clipped rather than weighted down to nothing. Weighting the fine
        // read to a third did stop the lattice, but it also took the gullies
        // with it and left the drive cliff a smooth grey curtain — trading one
        // "no structure" note for another. The lattice came from *outliers*:
        // isolated metre-scale rills whose Laplacian saturated the transfer and
        // flipped sign pixel to pixel. Compressing the tail keeps the ordinary
        // gully signal at full strength and stops only the spikes.
        curvF = curvF / (1.0 + abs(curvF) * 0.55);
        // THE WIDE READ IS NOW A MINORITY TERM, AND THAT IS A CORRECTION.
        // A Laplacian is only a crease detector at crease scale. Taken at 60 m
        // or more it is a landform detector, and a landform detector is not
        // zero-mean over a mountain flank: the whole concave lower half of any
        // massif reads strongly positive, so the crease darkening stopped being
        // a crease and became a flat brightness cut over the largest mass in
        // the drive frame. Debug mask 2 came back solid red across that entire
        // cliff. Held to a fifth, and soft-clipped like its narrow sibling, it
        // still carries the benches without being able to pin the transfer.
        curvC = curvC / (1.0 + abs(curvC) * 0.85);
        float curv = curvC * 0.20 + curvF * 0.80;

        // Hand the heightfield normal to the lighting block. Past ~200 m the
        // drawn mesh is 6-24 m per vertex, which is coarser than the relief it
        // is supposed to be carrying, so the massif is lit as a single smooth
        // mass no matter what the sun does. This is the only way to get that
        // relief back into the light without paying for the triangles, and
        // because it comes from the data texture it is identical across every
        // LOD — the shading does not change when a chunk swaps resolution.
        gReliefN = Nm;
        gReliefW = 0.88 * smoothstep(110.0, 300.0, camDist);

        // ── frequency budget ───────────────────────────────────────────────
        // Each band fades to its own mean once a cycle is worth about two
        // pixels. Without this the fine octaves crawl on every distant slope.
        float fFine = 1.0 - smoothstep(38.0, 130.0, camDist);
        float fMeso = 1.0 - smoothstep(150.0, 520.0, camDist);
        float fMacro= 1.0 - smoothstep(900.0, 2000.0, camDist);

        // Triplanar weights come from the geometric normal, so they follow the
        // real face rather than the relief normal derived below.
        vec3 tpw = tpWeights(N);

        // The 240 m octave stays planar: it is a regional selector (which side
        // of the valley you are on) and it has to agree between a cliff and the
        // meadow at its foot. At that wavelength the projection cannot streak
        // anything — 240 m across a 300 m face is a single soft gradient.
        float macro  = fbm(vWorldPos.xz * 0.0042, 4) * 0.5 + 0.5;        // ~240 m
        float macro2 = fbmTP(vWorldPos * 0.0155 + 31.4, 3, tpw) * 0.5 + 0.5; // ~65 m
        float meso   = mix(0.5, fbmTP(vWorldPos * 0.062 + 7.7, 3, tpw) * 0.5 + 0.5, fMeso);
        float fine   = mix(0.5, fbmTP(vWorldPos * 0.47, 3, tpw) * 0.5 + 0.5, fFine);

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
        // Raised from 0.72-1.30. Measured: with rock finally rendering as the
        // lavender-grey the palette asks for instead of as khaki, the same
        // coverage that used to look like a tan hillside now looks like a bare
        // one, and hero/peaks chromaMean fell to 0.241/0.246 against a
        // reference floor of 0.28. In plates 2 and 3 gold climbs a long way up
        // the flanks in big definite blobs and rock is reserved for genuine
        // faces; this holds grass to about 39 degrees to match.
        float steep = smoothstep(0.80, 1.42, slope);
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

        // Mid-range mass break, 4-8 m. Between about 15 m and 120 m the ground
        // had nothing but smooth gradients on it: every octave in this shader
        // is either finer than 2 m (and faded out by 38 m) or coarser than
        // 65 m (and therefore a constant across a whole hillside), which is
        // precisely the band the driver spends the most time looking at, and
        // it is why the mid-ground read as poured clay.
        //
        // Resolved as a mass edge rather than mixed as a gradient, because the
        // reference meadow is not a gradient: it is gold and straw in defined
        // patches with soft but definite boundaries between them, and the
        // patches are what give the ground its sense of surface. Fades to its
        // own mean by 170 m, where a 6 m patch is down to a couple of pixels.
        float fPatch = 1.0 - smoothstep(70.0, 170.0, camDist);
        if (fPatch > 0.004) {
          float pf = fbmTP(vWorldPos * 0.16 + 51.2, 2, tpw) * 0.5 + 0.5;
          float patchDry  = massEdge(pf + (macro2 - 0.5) * 0.30, 0.58);
          float patchDeep = massEdge(0.5 - (pf - 0.5) + (meso - 0.5) * 0.24, 0.62);
          grass = mix(grass, mix(grass, uGrassDry,  0.42), patchDry  * fPatch);
          grass = mix(grass, mix(grass, uGrassDeep, 0.28), patchDeep * fPatch);
        }

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
        // Biased brighter than it was. The palette's rock is a HIGH-value
        // lavender-grey and ours measured luma 0.55 in the hero vista where
        // reference plate 2's cliff sits at 0.60-0.75 — the massif was reading
        // as a dark substance under haze rather than as pale stone in it.
        vec3 rock = mix(uRockMid, uRockLit, smoothstep(0.14, 0.72, macro));
        // Only a whisper of warm. At 0.30 the massifs came out peach and read
        // as sand dunes rather than rock, which the palette forbids outright.
        // The lavender has to survive a warm key light, so the albedo stays
        // cool and the shade rebalance below does the anti-blue work instead.
        rock = mix(rock, uRockWarm, 0.07);
        rock = mix(rock, uRockShadow, smoothstep(0.58, 0.16, macro2) * 0.22);
        float bedStep = (hardRock - 0.5) * 2.0;                  // -1 .. 1
        rock *= 1.0 + bedStep * 0.15 * smoothstep(0.60, 1.05, slope);
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
        // Rotated about Y, then triplanar — jointing is the one field that
        // lives almost entirely on steep faces, so it was the worst offender in
        // the smear: two decorrelated 12-20 m blocks became two decorrelated
        // sets of vertical stripes.
        vec3 jr = vec3(vWorldPos.x * 0.94 - vWorldPos.z * 0.34,
                       vWorldPos.y,
                       vWorldPos.x * 0.34 + vWorldPos.z * 0.94);
        vec3 jw = tpWeights(vec3(N.x * 0.94 - N.z * 0.34, N.y, N.x * 0.34 + N.z * 0.94));
        float j1 = fbmTP(jr * 0.085, 2, jw);
        float j2 = fbmTP(jr.zyx * 0.052 + 19.3, 2, jw.zyx);
        rock *= 0.93 + smoothstep(-0.02, 0.02, j1) * 0.07 * fMeso
                     + smoothstep(-0.02, 0.02, j2) * 0.06 * fFine;

        // Faceting by aspect. The reference paints a massif as a handful of
        // planes at slightly different values, and the cue it uses is which way
        // each plane faces. The tone is put through a soft staircase rather
        // than left as a sine, because a sine is a gradient and the whole point
        // of the reference look is broad flat masses with definite edges
        // between them. Soft, not hard: a hard step would alias at range.
        float aspect = atan(Nc.z, Nc.x);
        float faceRaw = 0.5 + 0.5 * sin(aspect * 3.0 + macro * 5.0);
        float fq = faceRaw * 3.0;
        float faceTone = (floor(fq) + smoothstep(0.30, 0.70, fract(fq))) / 3.0;
        // Amplitude is much smaller than it was. This term existed as a stand-in
        // for form the far massif did not have: the mesh was 6-24 m per vertex
        // and the shading stencil was 60 m, so nothing but painted tone could
        // break a face up. The relief normal now puts the real form back into
        // the *light*, which is both more convincing and free of the artefacts
        // painted tone brings, so this drops to a hint of plane-to-plane
        // difference on top of it rather than carrying the whole load.
        // The distance boost is gone. It read "the far massif has no form, so
        // paint some", and it inverted into the worst artefact in the set: at
        // vista range the amplitude reached 0.35 of value, quantised to three
        // steps, on an aspect signal fine enough to flip across every flute.
        // Form at range is now the heightfield's job — the bench pass in
        // TerrainGen cuts real treads and risers and the relief normal lights
        // them — so this goes back to what it is honestly worth: a hint of
        // plane-to-plane difference laid on top of geometry that already reads.
        rock *= 0.91 + faceTone * 0.12;
        // Broad tonal drift so a big face is never one flat value.
        rock *= 0.92 + macro * 0.11 + macro2 * 0.08;
        // Crease and lip. This is the cue the close reference plates lean on
        // hardest: rock there is nearly untextured, and what makes it read is a
        // dark line where two planes meet and a bright edge where one turns
        // over. It is a cheap ambient-occlusion proxy off the same heightfield,
        // and because the stencil tracks screen size it never crawls.
        // Stronger than it was, because it is now reading a curvature field
        // that survives an oblique view: this is the "distinct planes with dark
        // crevice lines between them" of the close reference plate, and it is
        // earned from real geometry rather than painted as a line.
        rock *= 1.0 - smoothstep(0.22, 1.05, curv) * 0.50;
        rock *= 1.0 + smoothstep(-0.15, -0.95, curv) * 0.20;
        // The deepest hollows go to the crevice colour outright. Reference
        // plate 2's cliff gets its read from the near-black lines between
        // planes, and our massifs had no darks at all: measured lumaP05 0.42
        // against the plate's 0.18. rockShadow is a dark violet and would be
        // wrong over a whole face — used only where the curvature says a
        // genuine cleft is, it is exactly the crevice line the plate shows.
        rock = mix(rock, uRockShadow, smoothstep(0.48, 1.15, curv) * 0.44);
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
        // What the geometry on its own says. The breakers are kept out of this
        // sum deliberately, so their amplitude can be scaled by how close the
        // *geometry* already is to the line.
        float rockBase = steep * 1.26 - 0.20
                       + smoothstep(232.0, 330.0, vWorldPos.y) * 0.34;
        // THE BREAKERS MAY ONLY RUFFLE THE LINE, AND ONLY WHERE THE LINE IS.
        // Scaling by edgeBreak alone was not enough: edgeBreak is ~1 for every
        // slope past about 26 degrees, so the 240 m octave — worth ±0.39 of a
        // field whose threshold is 0.44 — could carry rockM across the cut
        // anywhere on a flank, not just near its boundary. When it did, it
        // opened a single ~200 m2 plate of bare rock in the middle of a soil
        // slope: the grey mass with hard straight edges that the river view has
        // been carrying since the mask was written, and which was mistaken for
        // a shadow artefact for two rounds.
        //
        // Scaling every breaker by proximity to the threshold keeps what the
        // breakers were for — a boundary that wanders tens of metres, climbs
        // the gullies and gives out on the buttresses — and makes opening a
        // plate away from the boundary arithmetically impossible.
        float nearLine = 1.0 - smoothstep(0.0, 0.34, abs(rockBase - 0.44));
        float breakAmp = nearLine * edgeBreak;
        float rockM = clamp(rockBase
                          + ((macro - 0.5) * 0.72 + (macro2 - 0.5) * 0.26) * fMacro * breakAmp
                          + (meso - 0.5) * 0.34 * fMeso * breakAmp
                          + (fine - 0.5) * 0.30 * breakAmp, 0.0, 1.0);
        // FEATHERED, NOT MASS-EDGED, AND THAT IS THE FIX FOR THE POLYGON.
        // massEdge takes its width from fwidth of the field, which is the right
        // answer when the field has a real gradient across the boundary: the
        // edge lands crisp and antialiases itself for free. rockM's gradient
        // across a uniform flank is almost nil, so the width collapsed to the
        // 0.010 floor — and the contour of a nearly-flat field is decided by
        // the 2 m texel structure of the slope map underneath it, which is
        // exactly why the boundary came out as long straight segments meeting
        // at corners rather than as a wandering line.
        //
        // A feather with a floor in FIELD units spans real ground wherever the
        // field is slow, and still resolves crisply wherever the slope
        // genuinely breaks, because fwidth wins there. The ruffle octaves above
        // supply the definite-mass character that the hard cut used to.
        float rockFeather = max(fwidth(rockM) * 1.4, 0.15);
        float rockCover = smoothstep(0.44 - rockFeather, 0.44 + rockFeather, rockM);
        albedo = mix(albedo, rock, rockCover);
        gRockM = max(rockCover, max(ribM, scourM) * 0.72);

        // Hollows and lips, applied to whatever ended up on the surface. On
        // rock this is the crease between two planes; on a grassy flank it is
        // the shading in the gullies, and it is the thing that stops a big
        // slope reading as one smooth painted ramp. Geometric, so it tracks the
        // real drainage the bake cut rather than inventing texture.
        albedo *= 1.0 - smoothstep(0.30, 1.15, curv) * 0.20;
        albedo *= 1.0 + smoothstep(-0.20, -1.00, curv) * 0.13;

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
        gRockM = max(gRockM, screeM * 0.66);
        // Only genuinely rock-shaped ground gets the full chroma governor — see
        // the block after the lighting. A gravel shelf, a scoured bank or a
        // talus fan on gentle ground is stone, but it is stone lying in a warm
        // meadow; pulling all of it the whole way to neutral is what turned
        // patches of it into grey cut-outs with nothing but hue to distinguish
        // them from the ground they sit in.
        gRockGov = gRockM * (0.62 + 0.38 * smoothstep(0.35, 0.90, slope));

        // Shelves. A terrace cut into a massif is nearly flat, so it misses
        // every slope-driven rule above and comes out as a bare grey plate —
        // the one place the terrain still reads as untextured. Anything that
        // lands on a ledge stays there: broken rock, wind-blown grit, and
        // enough tough grass to break the plane up.
        float shelfM = bench * smoothstep(0.30, 0.70, rockM) * (1.0 - screeM);
        albedo = mix(albedo, mix(screeCol, uGrassDry, 0.30 + macro2 * 0.34), shelfM * 0.62);

        // ── close-range substrate ──────────────────────────────────────────
        // At 2 m the ground between the grass blades was one untextured slab —
        // the critic measured it at 65% of the road close-up and 40% of the
        // vehicle frame — because the finest thing in this whole shader was a
        // single ~2 m octave worth about ±7% of value. Ground at arm's length
        // is pebbles, clods, scuffed dirt and damp shade, and none of that is a
        // gradient: it is a scatter of small marks with definite edges, which
        // is also how the close reference plate paints it.
        //
        // The entire band sits behind one distance gate and is gone by 34 m.
        // That is the trap this defect sets: albedo detail this fine crawls the
        // moment the camera moves unless it dies before its features drop under
        // a couple of pixels. 34 m at this framing is about 3 cm per pixel, so
        // the 12 cm pebbles are still four pixels across when they fade out.
        // The branch is coherent — every fragment in a screen region is at
        // roughly the same range — so the cost is real only in the near field.
        // THRESHOLDS ARE CALIBRATED TO THE FIELD'S ACTUAL DISTRIBUTION. A two
        // octave fbm mapped to 0..1 this way clusters hard around 0.5 with a
        // spread of roughly ±0.12, so a cut at 0.60 fires on a few percent of
        // the ground and a cut at 0.69 on almost none. The first version of
        // this block used exactly those numbers and produced a scatter of
        // isolated specks on a slab that still read as a slab — which is the
        // same "bare clay" note, not a fix for it.
        float fGrit = 1.0 - smoothstep(20.0, 70.0, camDist);
        if (fGrit > 0.004) {
          // Three scales, because ground at arm's length has three: grit,
          // clods, and larger patches worn through to bare dirt. One scale
          // however strong just looks like a noise texture.
          float pk = fbmTP(vWorldPos * 4.6, 2, tpw) * 0.5 + 0.5;         // ~22 cm
          float ck = fbmTP(vWorldPos * 1.25 + 4.1, 2, tpw) * 0.5 + 0.5;  // ~80 cm
          float sk = fbmTP(vWorldPos * 0.42 + 77.0, 2, tpw) * 0.5 + 0.5; // ~2.4 m

          // The finest band dies first — 22 cm is under two pixels by 38 m and
          // that is the frequency that crawls.
          float fPeb = 1.0 - smoothstep(14.0, 38.0, camDist);
          float peb  = smoothstep(0.55, 0.62, pk) * fPeb;
          float clod = smoothstep(0.47, 0.61, ck) - smoothstep(0.28, 0.42, ck) * 0.55;
          float bare = smoothstep(0.52, 0.66, sk);
          // Damp ground. Keyed on the real moisture field so it lands in the
          // hollows the bake says hold water, not at random, and broken up by
          // a metre-scale octave so its edge is not a contour.
          float dk   = moist * 0.66 + (fbmTP(vWorldPos * 0.30 + 19.0, 2, tpw) * 0.5 + 0.5) * 0.44;
          float damp2 = smoothstep(0.56, 0.82, dk) * bench;

          vec3 sub = albedo;
          sub *= 1.0 - clod * 0.26;
          // Worn through to dirt. This is the term that actually breaks a bare
          // slope up, because it is the only one whose features are big enough
          // to read as places rather than as texture.
          sub  = mix(sub, uDirt * 0.84, bare * 0.32 * (1.0 - damp2));
          sub  = mix(sub, mix(uScree, uDirt, 0.52) * 1.08, peb * 0.60);
          // Bleached straw on the dry, proud ground between them. Hue variety,
          // not just value: a slope carrying one hue reads as poured material
          // however much value noise is on it.
          sub  = mix(sub, uGrassDry, smoothstep(0.54, 0.68, pk) * fPeb * 0.32
                                     * (1.0 - damp2) * (1.0 - bare));
          sub  = mix(sub, sub * vec3(0.76, 0.73, 0.74), damp2 * 0.30);
          albedo = mix(albedo, sub, fGrit);
        }

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
          float m = rockCover;
          if (uDebugMask < 1.5)      albedo = vec3(m, 1.0 - m, screeM);
          else if (uDebugMask < 2.5) albedo = vec3(max(0.0, curv), 0.0, max(0.0, -curv));
          else if (uDebugMask < 3.5) albedo = vec3(loose, bedM, slope * 0.5);
          else                       albedo = vec3(oliveM, dryM, litterM);
        }

        diffuseColor.rgb *= albedo;
      }`
    ).replace(
      '#include <normal_fragment_maps>',
      /* glsl */`
      #include <normal_fragment_maps>
      // Put the heightfield's own relief back into the lighting.
      //
      // Past ~200 m the drawn mesh is 6 m per vertex and past 720 m it is 12 m,
      // both coarser than the 10-40 m benches and gullies the erosion bake
      // actually cut — so the massifs were lit as one smooth gradient mass and
      // the critic was right that raking dawn light revealed nothing, because
      // by the time the light reached them there was nothing left to reveal.
      // gReliefN is the true surface normal of the heightfield at a stencil
      // sized in screen space, so a distant face breaks into planes that catch
      // and lose the sun with real value difference between them. It is
      // LOD-independent, so unlike anything keyed on the mesh normal it cannot
      // pop on an LOD ring.
      //
      // vNormal is view space; gReliefN is world space.
      if (gReliefW > 0.001) {
        normal = normalize(mix(normal, normalize(mat3(viewMatrix) * gReliefN), gReliefW));
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
        // Keyed on the relief normal, not the mesh normal, so the warm shade
        // note lands on the same planes the lighting now breaks the face into.
        vec3 shadeN = normalize(mix(normalize(vWorldNormal), gReliefN, gReliefW));
        float ndl = clamp(dot(shadeN, normalize(uSunDir)), 0.0, 1.0);
        float shade = 1.0 - smoothstep(0.0, 0.38, ndl);
        gl_FragColor.rgb = mix(gl_FragColor.rgb,
                               gl_FragColor.rgb * uShadowTint,
                               shade * 0.34);
        gShade = shade;
      }

      // ── chroma governor on bare rock ───────────────────────────────────────
      // The palette is explicit that rock is lavender-grey and "never
      // brown-grey", and the terrain was breaking that rule everywhere: a
      // lavender albedo under a strongly warm key and a warm haze renders as
      // khaki. The proof was in our own frames — the rocks system's boulders
      // sat grey-lavender against terrain massifs that were tan, so the two
      // rock materials in the same shot did not look like the same substance,
      // and a crag block read as debris dumped on a sand dune.
      //
      // Cancelling a warm light with an inverse-tinted albedo does not work
      // (it goes green the moment the sun moves). The rocks system solves it
      // downstream of the lighting instead, by pulling the lit colour toward
      // its own luminance with a slightly cool cast, and this is deliberately
      // the same operator with the same cast vector so the two agree. It is
      // gated on the rock mask, so gold meadow keeps every bit of its chroma.
      //
      // Measured support: reference plate 2 is 28.4% neutral pixels and our
      // peaks frame was 2.7%; our drive frame ran chromaMean 0.435 against a
      // reference band of 0.28-0.42. Greying the rock moves both toward the
      // plates rather than away.
      // The cast is SPLIT by sun-facing rather than applied flat, and that is
      // not decoration: a flat cast pulls the whole massif to one neutral, and
      // hero's chromaMean fell to 0.262 against the brief's 0.28 floor because
      // three fifths of that frame is stone. The palette already specifies the
      // split — rock #c3bfcc lavender-grey lit, #5c5a75 violet in shadow — so
      // warming the governed colour on sunlit planes and cooling it on shaded
      // ones puts the chroma back where the plates put it, and it turns the
      // plane-to-plane value break the relief normal creates into a hue break
      // as well, which is the single strongest cue in the reference cliffs.
      // THE GOVERNOR ALSO NEEDS A VALUE FLOOR, and measured against the plates
      // that was the larger half of the "torn grey paper" defect in the river
      // view. Sampled off the shipped frame, the governed slab came back at
      // luma 0.217 with chroma 0.066; reference rock runs luma 0.40-0.51 where
      // it is hazy and 0.56-0.70 in the near field, and even the palette's own
      // *shadow* anchor #5c5a75 is luma 0.36. Stone that is both hueless and a
      // stop darker than the ground it lies in stops reading as a surface and
      // starts reading as a hole cut in the hillside — which is exactly the
      // note the look author wrote up. Chroma was never far off; value was.
      //
      // Applied as a screen blend so it lifts the shadow end hard and the
      // highlight end barely at all: a sunlit crag keeps its range and its
      // relation to the snow above it, and only the unlit half moves.
      if (gRockGov > 0.002) {
        float rl = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        float rlL = rl + max(0.0, 1.0 - rl) * uRockLift;
        vec3 governed = vec3(rlL) * mix(uRockCastLit, uRockCastShade, gShade) * uRockGain;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, governed, gRockGov * uRockDesat);
      }
      // ── ground chroma ─────────────────────────────────────────────────────
      // The rock governor above is a deliberate, measured desaturation, and it
      // cost the vista views real chroma: hero and peaks fell from 0.292/0.317
      // to 0.249/0.259 against the brief's 0.28 floor. The plates say the
      // answer is not less grey rock — plate 2 runs 28.4% neutral pixels and
      // still averages 0.284 chroma — but more saturated gold beside it. The
      // reference is bimodal: near-neutral stone against strongly coloured
      // ground, where ours had become a mush of mid-chroma everywhere.
      //
      // Gated by the same rock mask, so this lifts meadow and flank and leaves
      // the stone exactly where the governor put it.
      {
        float gsat = (1.0 - gRockM) * uGrassSat;
        if (gsat > 0.002) {
          float gl = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          gl_FragColor.rgb = max(vec3(0.0),
                                 mix(vec3(gl), gl_FragColor.rgb, 1.0 + gsat));
        }
      }
      #include <dithering_fragment>`
    );
  };

  mat.customProgramCacheKey = () => 'procedural-autumn-terrain-v3';
  void opts;
  return mat;
}
