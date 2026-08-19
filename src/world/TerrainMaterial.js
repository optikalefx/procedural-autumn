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
    uDirtDark:    { value: PALETTE.dirtDark.clone() },
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
    uRockLift:    { value: 0.30 },  // near-field, shaded rock only
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

    // Plane breaks on bare rock. See the block in the fragment shader.
    //
    // This is a LEDGE HEIGHT IN METRES, not a tilt. That is the whole
    // difference between this and the version it replaces: the shading normal
    // is bent by the surface gradient of a displacement, which is the ledge
    // height times the gradient of the field the ledge is cut from — so where
    // the field is locally flat the tilt goes to zero on its own instead of
    // sitting at a constant angle in an undefined direction.
    uBedRelief:   { value: 36.0 },
    // Levels of staircase per unit of the plane-break field, i.e. how many
    // plane traces cross a face. Median band pitch is BED_L / (2.7 * this).
    uBedLevels:   { value: 13.0 },
    // A whisper of value on the ledge itself. Deliberately tiny: the plane
    // break is carried by the light, and painted bands on rock are how this
    // file produced a contour map twice before.
    uBedAlbedo:   { value: 0.055 },

    // Dev only, always 0 in the shipped frame. Set from the console or the
    // capture harness to false-colour the surface masks:
    //   window.__terrain.material.userData.uniforms.uDebugMask.value = 1
    // 1 = rock(red) / grass(green) / scree(blue), 2 = curvature, 3 = talus /
    // hardness / slope, 4 = olive / dry / litter, 5 = steep / rockM / rim band.
    // Blitted over the lit colour, so what you see is the mask and not the mask
    // times the light.
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
      uniform vec3 uDirt, uDirtDark, uRockLit, uRockMid, uRockShadow, uRockWarm, uScree;
      uniform vec3 uSnow, uSand, uLitter;
      uniform vec3 uShadowTint;
      uniform vec3 uRockCastLit, uRockCastShade;
      uniform float uRockDesat, uRockGain, uRockLift, uGrassSat;
      uniform float uBedRelief, uBedLevels, uBedAlbedo;
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
      // 1 in the near field, 0 past the mid field. Carried forward so the
      // post-lighting blocks can keep their corrections off the distant
      // massifs, where the atmosphere is already doing the work.
      float gNear = 1.0;
      // World-space tangential bend applied to the shading normal by the
      // bedding/joint block, and how much of it to use. Carried forward for
      // the same reason gReliefN is: the plane sets are derived where the
      // heightfield is already being read, and the shading normal does not
      // exist until <normal_fragment_maps>.
      vec3  gBedDelta = vec3(0.0);
      float gBedW = 0.0;
      // Dev only. See the uDebugMask block; blitted unlit at the end.
      vec3 gDebug = vec3(0.0);

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

      // The same, with a floor on the width that is a real width in the field
      // rather than a token one. massEdge's 0.010 floor exists only to keep the
      // smoothstep from dividing by zero; it is not a feather, and on a field
      // whose gradient is small it resolves to a one-pixel contour whose SHAPE
      // is then dictated by whatever is quantised underneath — which is how the
      // rock mask came to draw a straight-edged polygon across a hillside. Use
      // this wherever the boundary is a boundary between materials, and pass a
      // floor wide enough to span visible ground.
      float softMass(float field, float threshold, float floorW){
        float w = max(fwidth(field) * 1.4, floorW);
        return smoothstep(threshold - w, threshold + w, field);
      }

      // ── one plane set, as a soft staircase in its own field coordinate ────
      // Returns (step, slope): the 0..1 position through the step, and the
      // derivative of the staircase DISPLACEMENT with respect to the field
      // coordinate, in units of displacement per unit of field.
      //
      // The step rises once per period, so its mean derivative over a period
      // is exactly 1; subtracting that leaves a zero-mean signal. That matters
      // more than it looks: a normal perturbation with a non-zero mean is a
      // brightness change dressed up as form, and it would tilt every rock
      // face in the game the same way at every distance. This tilts the riser
      // one way and the tread the other and leaves the face's average normal
      // exactly where the geometry put it.
      vec2 plateStep(float u, float e){
        float f = fract(u);
        float x = clamp((f - 0.5 + e) / (2.0 * e), 0.0, 1.0);
        float q  = x * x * (3.0 - 2.0 * x);
        float dq = 6.0 * x * (1.0 - x) / (2.0 * e);
        return vec2(q, dq - 1.0);
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
        // How far outside the playable square this fragment is. Terrain.js
        // builds an apron of ground beyond the boundary so the world does not
        // end in a vertical cliff against empty sky; the apron's surface is the
        // interior heightfield REFLECTED across the boundary, so reflecting the
        // lookup here is what makes its shading agree with its shape. Clamping
        // instead (the default wrap) smears the boundary texels radially for
        // 2.6 km, which is exactly the streak this replaces.
        float uOutM = max(0.0, max(abs(vWorldPos.x), abs(vWorldPos.z)) - uWorldSize * 0.5);
        float uOutside = smoothstep(0.0, 46.0, uOutM);
        // Past ~1.4 km out the apron's surface has left the reflection behind
        // and is its own landform, so the reflected lookup stops describing it
        // and everything keyed on the data texture has to hand over to the
        // geometry. Beyond this the far range is lit by its own mesh normal and
        // painted from its own slope and altitude.
        float uFarApron = smoothstep(320.0, 1400.0, uOutM);
        uvw = abs(uvw);
        uvw = clamp(mix(uvw, 2.0 - uvw, step(1.0, uvw)), 0.0, 1.0);
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
        // THE ROCK LINE IS A FUNCTION OF ALTITUDE AS WELL AS SLOPE, and that
        // is what fixes the river slab without stripping the massifs.
        //
        // Measured with debug mask 5 on the river frame, grade bypassed so the
        // numbers are the shader's own: steep 0.70 inside the grey slab and
        // 0.17-0.29 on the ochre ground either side of it — slope 1.19 against
        // 0.95-1.00, six degrees apart. A single global line resolved its whole
        // decision inside that six degrees, so an ordinary wooded valley flank
        // at 88 m altitude wore a 200 m2 plate of governed grey.
        //
        // Raising the line globally did clear the slab, but it also pushed the
        // peaks massif — 1.1 to 1.4 of slope over its whole face — into the
        // middle of the transition, which is the worst place for it to sit: the
        // gold ribbons wandering across that cone got longer, not shorter.
        //
        // Geology and the plates agree on the discriminator. A valley flank has
        // soil on it, holds trees and grass to a steep angle, and is gold in
        // every plate; an alpine face above the tree line is scoured and is
        // stone. So the angle at which soil gives out falls with altitude: ~53
        // degrees down in the valley, ~44 up on the massifs, interpolated
        // across the same band the tree line occupies.
        // ── THE SLOPE THE GRASS/ROCK LINE IS ALLOWED TO SEE ────────────────
        // NOT aux.r, and this is the gold contour ribbons. Three previous
        // rounds looked for a shading bug and all measured as exact no-ops,
        // because the defect is arithmetic and has nothing to do with light.
        //
        // rockM moves 1.26 for every 1.0 of steep, and steep used to cross
        // its whole range in 0.62 of slope, so the boundary resolved its entire
        // decision inside about 0.03 of slope — under one degree. Measured on
        // the bake (tools/_scratch/slopecal.mjs), the 2 m slope field on steep
        // massif faces carries an RMS wobble of 0.659 against its own 30 m
        // average: twenty times the width of the decision. 29.8% of steep
        // samples fall on the opposite side of the line from where the 16 m
        // slope puts them. Every micro-bench of the erosion grain therefore
        // dips under the cut and the mask paints a grass ribbon along it — an
        // isoline of the slope field, pixel-identical at every sun angle
        // because nothing about it is shading.
        //
        // So the line reads the slope at the scale the line is supposed to
        // describe: a two-ring disc average about 24 m across. Measured mean
        // falls 1.382 -> ~1.02 and the wobble falls to ~0.10, so the thresholds
        // below are re-scaled by the same ratio rather than re-guessed.
        // Eight taps on two rings, and the count is not padding — a four-tap
        // version with 28% of its weight on the centre texel put the streaks
        // back on the peaks shoulder in the same place at all three hours,
        // which is the isoline signature returning. The centre texel is the
        // one carrying the wobble, so it gets the smallest share.
        vec2 rA = vec2(11.0 / uWorldSize, 0.0);
        vec2 rB = vec2(17.0 / uWorldSize, 17.0 / uWorldSize);
        float slopeLP =
            slope * 0.20
          + (texture2D(uAuxTex, uvw + rA.xy).r + texture2D(uAuxTex, uvw - rA.xy).r
           + texture2D(uAuxTex, uvw + rA.yx).r + texture2D(uAuxTex, uvw - rA.yx).r) * 0.11
          + (texture2D(uAuxTex, uvw + rB).r + texture2D(uAuxTex, uvw - rB).r
           + texture2D(uAuxTex, uvw + vec2(rB.x, -rB.y)).r
           + texture2D(uAuxTex, uvw + vec2(-rB.x, rB.y)).r) * 0.09;

        float alpine = smoothstep(120.0, 250.0, vWorldPos.y);
        // Re-scaled with the field, not re-guessed: 1.02*0.71 and 0.72*0.71.
        // The ramp is left wider than the same rescale would give (0.72 against
        // 0.44), which is the second half of the fix — a blend wide enough to
        // swallow what wobble survives the low-pass.
        float soilHold = mix(0.72, 0.51, alpine);
        float steep = smoothstep(soilHold, soilHold + 0.72, slopeLP);
        float bench = 1.0 - smoothstep(0.10, 0.34, slope);   // flat shelf / meadow

        // ── plane breaks on bare rock ─────────────────────────────────────
        // BLOCKER 6: the massifs had no surface structure at any scale. Measured
        // on the peaks frame, the sunward flank of the main cone came back at
        // luma 0.569 and the shaded flank at 0.579 — ten thousandths apart,
        // over the largest mass in the picture. Debug mask 6 (albedo, no light)
        // showed why: everything this shader owns for rock — the jointing, the
        // weathering grain, the aspect facet — is faded to its own mean by
        // 520 m, and every massif in the game stands further away than that.
        // What is left at vista range is the mesh normal, which past 200 m is
        // 6-24 m per vertex over a landform the erosion bake left smooth.
        //
        // The reference plates do not paint rock with texture. They paint it as
        // PLANES, with a definite value step where one plane turns into the
        // next. That is a NORMAL and not an albedo, which is also why it is the
        // right answer at distance — aerial perspective washes chroma out of a
        // face and leaves its form alone, so form is the only cue that still
        // works through haze.
        //
        // A PERIODIC PLANE SET CANNOT DELIVER IT, AND THAT IS NOW SETTLED BY
        // TWO CAPTURES. Bedding written as a linear plane coordinate — u =
        // dot(worldPos, bedDir) / L through a staircase — has bedDir near
        // vertical by definition, because that is what "bedding" means. So u is
        // world HEIGHT over a constant, every step of the staircase is a level
        // curve, and a level curve drawn on a landform is a contour map. It
        // printed evenly spaced horizontal terraces across the distant massifs
        // in the peaks view; crossed with a vertical joint set it printed a regular
        // diamond weave over the main cone that reads as quilted fabric rather
        // than as stone. That is blocker 8's isolines arriving in grey — which
        // is the useful part of the evidence, because it proves the isoline
        // problem was never in the colour ramp.
        //
        // Phase-warping the ramp does not rescue it; it adds a third artefact.
        // A warp has to be worth about a period to break the tiling, and the
        // period is 34 m, so the warp's own spatial gradient is necessarily the
        // same size as the 1/L it is perturbing. Where the two nearly cancel
        // the local period collapses toward zero, the band pitch falls under a
        // pixel, and the far range in hero came back as a moire ripple. NO
        // DISTANCE FADE KEYED ON THE NOMINAL WAVELENGTH CAN CATCH THAT, because
        // the frequency that aliases is not the nominal wavelength — which is
        // exactly why the previous version's careful footM fade did nothing.
        //
        // So the coordinate is a BOUNDED FIELD instead of a ramp, and both
        // failure modes leave with the ramp:
        //
        //   · the field has no y term at all, so no level set of it can be a
        //     contour. The bands are the level sets of a 160 m noise: they
        //     wander, they pinch out, they vary in width, and where the field
        //     is locally flat there are no bands at all — which is the
        //     "part of this massif is massively bedded and part of it is not"
        //     that the previous version had to fake with a separate modulation.
        //   · the field is band-limited, so the band pitch is bounded, and —
        //     better — it is MEASURED here from the same finite differences
        //     that give the tilt direction. The fade is against the pitch this
        //     fragment actually has, not against a nominal wavelength.
        //
        // On a face steeper than the field is wide the level sets run down the
        // fall line, and that is also what the plates show on rock: gullies and
        // spurs running DOWN a slope, never ledges running across it.
        //
        // The tilt is the surface gradient of a displacement — ledge height in
        // metres times the field's gradient in levels per metre — and not a
        // fixed angle along a normalised direction. That is what makes it safe
        // where the field is flat: the direction is undefined there, but the
        // magnitude is zero, so nothing is drawn.
        vec2  bedS = vec2(0.5, 0.0);
        vec3  bedG = vec3(0.0);        // levels per metre, world space
        float fBed = 0.0;
        // Measured offline against this exact fbm (tools/_scratch/terrain/bedcal.mjs):
        // median band pitch is BED_L / (0.527 * uBedLevels), so 160 m of field
        // at 13 levels of swing gives 23 m — and, more to the point, a SPREAD
        // of pitches from about 13 m to 60 m, because the field's gradient is
        // not constant. That spread is the whole difference from a ramp.
        const float BED_L = 160.0, BED_E = 13.0, BED_FAR = 8.0;
        float BED_K = uBedLevels;
        // Coherent everywhere it matters: a screen region is all flank or all
        // valley floor, so the branch is taken or skipped by whole hillsides.
        // The footM half of the test is economy, and it is set to exactly
        // where the fade below reaches zero rather than to a round number —
        // an early-out that cuts a term still worth something draws a hard
        // edge across a hillside at whatever distance it happens to sit. The
        // fade's own thresholds are clamped to the same 8 m so the two agree by
        // construction and not by luck. Past that the three noise taps would be
        // computed only to be multiplied by zero, which in a vista frame is
        // most of the screen.
        if (steep > 0.02 && footM < BED_FAR) {
          vec2 Pb = vWorldPos.xz / BED_L;
          float dP = BED_E / BED_L;
          float b0 = fbm(Pb, 2);
          float bX = fbm(Pb + vec2(dP, 0.0), 2);
          float bZ = fbm(Pb + vec2(0.0, dP), 2);
          vec2 gxz = vec2(bX - b0, bZ - b0) * (BED_K / BED_E);
          bedG = vec3(gxz.x, 0.0, gxz.y);
          // The riser is deliberately 43% of the band and not the 26% a smaller
          // e would give. Tried at 0.150 with the amplitude rescaled to match:
          // the flutes stopped reading as planes and started reading as
          // scratches — thin bright lines on a grey face, which is the drawn
          // contour note arriving a fourth way. The brief asks for broad flat
          // masses separated by SOFT edges, and this is where that is bought.
          bedS = plateStep(b0 * BED_K, 0.215);
          // ── the anti-contour filter, and it is not optional ──────────────
          // A level set of a horizontal field is a closed curve, and near an
          // extremum of the field it is a NEST of closed curves. On a gently
          // domed summit seen obliquely that nest compresses into concentric
          // rings and reads as a fingerprint — measured on the pale peak left
          // of centre in hero, six rings across 40 px. Different arithmetic
          // from the ramp's terraces, same note to a player: contour map.
          //
          // What separates a trace that reads as geology from one that reads
          // as a contour is which way it runs relative to the slope. A trace
          // running DOWN the fall line is a flute, a spur, a gully — it is
          // what every reference plate paints on rock. A trace running ACROSS
          // it is a contour whatever drew it. The trace is perpendicular to
          // the field's gradient, so the test is one dot product: suppress the
          // band exactly where its gradient lines up with the fall line.
          //
          // This also earns the noise its keep on a cone. The level sets that
          // survive are the ones already running down the flanks, so the same
          // field that made rings on a dome makes fluting on a face.
          vec2 fallD = Nm.xz;
          float fallL = length(fallD);
          vec2 gN = gxz / max(length(gxz), 1e-6);
          float across = 1.0 - abs(dot(gN, fallD / max(fallL, 1e-6)));
          // Floored rather than cut to zero: a face whose fluting all runs one
          // way is its own kind of wrong, and the floor is what leaves the
          // occasional cross break.
          //
          // The second factor was first written as "only apply the filter
          // where there is a fall line", i.e. mix back to 1 on gentle ground.
          // That is backwards and the capture said so: gentle ground is where
          // the fingerprint lives, because a shallow dome shows the whole nest
          // of level sets at once. Gentle ground does not need the filter
          // relaxed, it needs the TERM off — a plane break is a property of a
          // face, and ground with no fall line has no face. So the same
          // quantity gates the term instead of gating the filter.
          float aniso = (0.12 + 0.88 * smoothstep(0.08, 0.68, across))
                      * smoothstep(0.10, 0.34, fallL);
          // THE DISTANCE BUDGET FOR A FORM CUE IS NOT THE ALIASING LIMIT, and
          // that is the correction the third capture forced. The first version
          // of this line held the band on until its riser was about three
          // pixels — the ordinary frequency budget this file applies to albedo
          // octaves. Measured on the pale shoulder in hero: at 2 km the pitch
          // is 34 m against a 4.8 m footprint, so six bands landed inside 40 px
          // and the peak came back as a fingerprint. Nothing was aliasing; the
          // bands were simply too small to be read as planes, and a nest of
          // small ones is a contour map by another route.
          //
          // A plane break has to be worth an AREA to read as a plane. Off under
          // about ten pixels of pitch, full over about twenty-two. Distant
          // massifs go back to being soft masses, which is what plate 1 shows
          // through haze anyway, and the cue is spent where it is legible.
          //
          // Everything here is in metres on the surface: footM comes
          // analytically from distance and grazing angle, never from fwidth of
          // an interpolated attribute, which is constant across a triangle and
          // would print the mesh.
          float pitchM = 1.0 / max(length(gxz), 1e-5);
          fBed = (1.0 - smoothstep(min(pitchM * 0.045, BED_FAR * 0.44),
                                   min(pitchM * 0.100, BED_FAR), footM)) * aniso;
        }

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
        // softMass, not massEdge, and for the same reason the rock line needed
        // it. moisture is a smooth field, so fwidth across the olive boundary
        // collapses to massEdge's 0.010 anti-divide-by-zero floor and the two
        // grass albedos meet on a 1-2 px cut — a saturated orange and a
        // desaturated olive-mustard sharing a hard edge in the middle of one
        // continuous meadow, with nothing in the ground to explain it. A floor
        // in field units spans real ground: about 6 m of transition here.
        float oliveM = softMass(wet + macro2 * 0.16, 0.84, 0.045);
        float dryM   = softMass(macro * 0.55 + macro2 * 0.45 - moist * 0.30, 0.56, 0.040);

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

        // ── ground masses ──────────────────────────────────────────────────
        // MEASURED, NOT ASSERTED. Five samples spread across the river
        // hillside came back rgb(147,90,42), (146,89,42), (141,77,42),
        // (146,90,42), (148,97,46): one colour, to within a few levels, over
        // the entire near field. The equivalent five samples in reference plate
        // 1 run (151,99,44) gold, (134,93,40) and (92,80,32) olive, (75,70,100)
        // violet in shade. Our hue is right — 147,90,42 against 151,99,44 is as
        // close as this is ever going to get — and our VARIETY is nil. That is
        // the whole of the "reads as bare clay" note; it was never a hue error.
        //
        // What fixes it is not finer noise. The grit band below already carries
        // that, it is correctly budgeted, and it is gone by 70 m. What is
        // missing is colour at the scale the eye reads as PLACES: patches of
        // bleached straw, damp olive and ground worn through to soil, several
        // metres to tens of metres across, with definite edges. That is what
        // the reference meadows are made of and it is the one band this shader
        // never had — everything here is either under 2 m (dead by 38 m) or
        // over 65 m (a constant across a whole hillside).
        //
        // Three decorrelated scales, each with its own distance budget, each
        // resolved as a mass rather than mixed as a gradient. The widest one
        // survives to 760 m because a 55 m patch is still eight pixels there;
        // the finest dies at 130 m for the same reason it would crawl past it.
        float fM55 = 1.0 - smoothstep(300.0, 760.0, camDist);
        if (fM55 > 0.004) {
          float fM18 = 1.0 - smoothstep(90.0, 260.0, camDist);
          float fM6  = 1.0 - smoothstep(40.0, 130.0, camDist);
          // Each octave sits behind its own gate rather than all three behind
          // the widest one. The branches are coherent — every fragment in a
          // screen region is at about the same range — so past 260 m this block
          // costs one fbm instead of three, which is most of the terrain in
          // every vista frame.
          float m55 = fbmTP(vWorldPos * 0.019 + 12.9, 2, tpw) * 0.5 + 0.5;
          float m18 = 0.5, m6 = 0.5;
          if (fM18 > 0.004) m18 = fbmTP(vWorldPos * 0.058 + 88.4, 2, tpw) * 0.5 + 0.5;
          if (fM6  > 0.004) m6  = fbmTP(vWorldPos * 0.170 + 51.2, 2, tpw) * 0.5 + 0.5;

          // Bleached straw on proud, dry ground.
          float straw = softMass(m18 + (m55 - 0.5) * 0.55 - moist * 0.24, 0.54, 0.030) * fM18;
          // Olive. LED BY ITS OWN OCTAVES, moisture only weighting them, and
          // that is a correction: gated on moisture alone at the strength the
          // reference shows, olive fired on nothing at all up a dry flank —
          // the whole term needed damp ground to exist and a dry hillside got
          // one flat gold. In plate 1 olive-green bands run through gold meadow
          // that is plainly not wet. It stays an accent because two
          // decorrelated fields have to agree at once, so it can never sheet
          // along a whole bank the way the old moisture-led version did.
          // Carried to the full 760 m. Cutting it back to a 200-480 m budget
          // was tried, on the theory that a low-chroma accent at vista range
          // only lowers the mean: measured over a full capture round it moved
          // peaks by nothing at all (lumaRange 0.376, contrastStd 0.123,
          // chromaMean 0.283 either way), so it was reverted rather than kept
          // as a change that costs mid-field hue variety and buys nothing.
          float olive = softMass(m55 * 0.44 + m18 * 0.26 + moist * 0.30
                                 + (m6 - 0.5) * 0.20, 0.56, 0.030) * fM55;
          // Deeper gold in the lee. Anti-correlated with the straw so the two
          // interleave instead of stacking.
          float deep  = softMass(1.0 - m18 + (m6 - 0.5) * 0.34, 0.58, 0.030) * fM18;
          // Worn through to soil. Small and infrequent, and the only one of the
          // four that changes material rather than tint — which is why it is
          // the one that reads as a place rather than as a wash.
          float worn  = softMass(m6 + (m18 - 0.5) * 0.42, 0.62, 0.035) * fM6;

          // PULLED BACK from 0.70. uGrassDry is a pale, low-chroma straw, and
          // at 0.70 it was doing to the meadow exactly what the rock governor
          // does to stone: measured, meadow chromaMean fell 0.392 to 0.351 and
          // peaks lumaP05 rose 0.447 to 0.473, i.e. the darks of the frame were
          // being lifted by a wash rather than the masses being separated. The
          // variety is worth having; buying it by bleaching the key colour is
          // not, and the plates are emphatic that gold is the dominant colour.
          grass = mix(grass, uGrassDry,   straw * 0.50);
          grass = mix(grass, uGrassOlive, olive * 0.38);
          grass = mix(grass, uGrassDeep,  deep  * 0.38);
          // The worn patches carry the dark end of the ground's value range,
          // and that is deliberate. Measured, the river view is the only
          // canonical framing still short of the reference contrast band
          // (0.112 against 0.13-0.18) and the shortfall is mass-to-mass value
          // difference on the ground, not a black point: lumaP05 is already
          // 0.244 against a reference floor of 0.16. Real soil showing through
          // real grass is a stop darker than the grass, and it is the one place
          // that value can come from without faking a shadow.
          grass = mix(grass, mix(uDirtDark, uGrassDeep, 0.30), worn * 0.50);
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
        // The ledges take a whisper of value with them, so a bed still reads
        // as a bed on the shadowed half of a massif where there is no key
        // light left to model it. Kept an order of magnitude below the normal
        // tilt on purpose — see uBedAlbedo.
        rock *= 1.0 + (bedS.x - 0.5) * uBedAlbedo * fBed;
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
        // What the geometry on its own says. The breakers are kept out of this
        // sum deliberately, so their amplitude can be scaled by how close the
        // *geometry* already is to the line.
        // The altitude term is domain-warped, for the same reason the snow line
        // is: an untouched smoothstep on world height is a level curve by
        // construction, and a level curve drawn across a cone is a contour map.
        // The gold ribbons wandering across the peaks massif are that term
        // meeting the drainage flutes.
        float altWarp = vWorldPos.y + (macro - 0.5) * 74.0 + (macro2 - 0.5) * 26.0;
        float rockBase = steep * 1.26 - 0.20
                       + smoothstep(232.0, 330.0, altWarp) * 0.34;
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
        // edgeBreak is deliberately NOT a factor here any more. It scaled the
        // ruffle by steepness, which is smallest exactly where the gold sits —
        // in the flutes and on the benches — so the one place the boundary most
        // needed breaking up was the one place the breakers were turned down,
        // and the peaks massif wore long parallel gold ribbons that read as a
        // contour map. nearLine does the job it was there for and does it
        // better: it is zero unless rockBase is within 0.34 of the threshold,
        // which already means sloped ground, so nothing on the valley floor can
        // be reached by it.
        float breakAmp = nearLine;
        // A breaker that survives to vista range. Past ~520 m meso and fine
        // are both at their means and the only octaves left were 240 m and
        // 65 m, which are too broad to break a line: between two of their blobs
        // the boundary is free to follow whatever the slope field says, and on
        // a cone that is a contour. This one is ~34 m, triplanar so it does not
        // compress into horizontal streaks on a steep face, and it holds until
        // a cycle is worth about two pixels at 2.2 km.
        float bream = fbmTP(vWorldPos * 0.029 + 19.6, 3, tpw) * 0.5 + 0.5;
        float fBream = 1.0 - smoothstep(1100.0, 2200.0, camDist);
        float rockM = clamp(rockBase
                          + ((macro - 0.5) * 0.52 + (macro2 - 0.5) * 0.46) * fMacro * breakAmp
                          + (bream - 0.5) * 0.42 * fBream * breakAmp
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
        // The floor is wide because the field behind it is steep: rockM moves
        // 1.26 for every 1.0 of steep, and steep itself crosses its whole
        // range in 0.72 of slope. A 0.26 feather buys about eight degrees of
        // transition, which is a band metres wide on real ground rather than
        // the pixel-wide contour a derivative width collapses to.
        // TAPERED WITH DISTANCE. The polygon was a near-field failure: a wide
        // feather there spans metres of visible ground and turns a torn edge
        // into a transition. At vista range the same width spans a third of a
        // massif and smears the grass/rock line into mush, which loses the
        // broad definite masses the reference is built from. Near wide, far
        // crisp — and far is where the derivative width is honest anyway,
        // because a distant face crosses the whole field inside a pixel.
        // THE FAR FLOOR IS NO LONGER A TOKEN WIDTH. At 0.045 the boundary
        // resolved inside 0.015 of slope — a fifth of a degree — at exactly the
        // distances (800-1500 m) where the massifs are, so whatever residual
        // structure the slope field carried was traced out as a 1-2 px hard
        // line. That is the other half of the ribbon defect: corrugated data
        // plus a zero-width cut. With the line now reading a 24 m disc average
        // the field behind it is smooth, so a real width can be afforded
        // without the mush the old taper was guarding against.
        float rockFeather = max(fwidth(rockM) * 1.4,
                                mix(0.26, 0.17, smoothstep(140.0, 520.0, camDist)));
        float rockCover = smoothstep(0.44 - rockFeather, 0.44 + rockFeather, rockM);
        albedo = mix(albedo, rock, rockCover);
        // Transition material along the line. A feather on its own only
        // cross-dissolves gold into grey, and across a chroma gap this wide
        // (0.43 against 0.07 measured) a cross-dissolve still reads as one
        // shape laid over another — a torn edge with a blurred border rather
        // than ground. Every reference plate mediates that meeting with a band
        // of paler, drier material: straw, grit and scoured dirt where the soil
        // thins out over stone. Giving the band its own colour turns the
        // boundary into a sequence of materials, which is what reads as a
        // hillside. Peaks at the half-way line and vanishes at both ends, so it
        // costs nothing anywhere else.
        // Near field only. A transition band is a thing you can walk up to and
        // see; at vista range it is sub-pixel and all it does is lay a third,
        // mid-value material between two masses that should be reading against
        // each other. Left on at distance it cost the peaks view 0.05 of luma
        // range and 0.02 of contrast in one round, measured.
        float rimBand = rockCover * (1.0 - rockCover) * 4.0
                      * (1.0 - smoothstep(120.0, 300.0, camDist));
        vec3 rimCol = mix(mix(uDirt, uScree, 0.34 + meso * 0.30), uGrassDry, 0.34);
        albedo = mix(albedo, rimCol, rimBand * 0.45);
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

        // ── alpine turf: the gold contour ribbons ──────────────────────────
        // THIS IS NOT A THRESHOLD PROBLEM, AND THAT IS THE FINDING. Measured on
        // the bake (tools/_scratch/terrain/rockcal.mjs): 28.5% of all ground
        // above 150 m is painted grass, and it is painted grass because the
        // erosion bake cuts treads into the massifs and a tread is gentle
        // ground. A slope threshold on a landform whose slope varies with
        // height IS a contour. Widening the low-pass the line reads makes it
        // WORSE, measured: at the shipped 11/17 m disc, 26.7% of that grass is
        // a band sandwiched between rock above and below; at 56/92 m it is
        // 44.2%, because smoothing removes the local wander that was breaking
        // the band up. Folding drainage curvature in was tried on the same
        // harness and also made it worse (26.7% -> 33.6% at unit weight).
        //
        // So the boundary is left where the geometry puts it and the MATERIAL
        // on the alpine side of it is corrected instead, which is what was
        // actually wrong. Above the tree line the ground lying in the folds of
        // a crag is not valley meadow: it is bleached turf, lichen and grit,
        // close in value and chroma to the stone it sits on. A pale grey-gold
        // band winding through rock reads as ground. Valley gold at 1.5 km —
        // measured here at chroma 0.42 against stone at 0.03 in the same frame
        // — reads as a drawn line, which is exactly the note.
        //
        // THE GATE IS REGIONAL SLOPE, AND TWO WRONG GATES WERE TRIED FIRST.
        //
        // Altitude does not work: the ribbons on the gorge walls sit at
        // 100-180 m, under any sensible tree line, and are wrong because of
        // what is around them rather than how high they are.
        //
        // rockM does not work either, and the reason is worth writing down
        // because it looks like it should. rockM is CLAMPED to 0..1, so every
        // piece of ground that is comfortably grass — a valley meadow and an
        // alpine tread alike — reads exactly 0 and there is no signal left to
        // gate on. Even unclamped they agree: a tread's local slope is as
        // gentle as a meadow's, which is the whole reason it is painted grass.
        //
        // What actually separates them is the NEIGHBOURHOOD. A tread is gentle
        // ground on a mountain; a meadow is gentle ground on a valley floor.
        // Nc is already in hand — the heightfield normal over the 62-96 m
        // coarse stencil the aspect facet uses — so its gradient is the
        // regional slope for free. Measured on the bake
        // (tools/_scratch/terrain/tread.mjs): 0.58 median on ribbon ground
        // against 0.40 on honest hillside meadow.
        //
        // Applied as a CONTINUOUS blend and never as a threshold, which is what
        // makes the weak separation usable and the stencil's own 62-96 m drift
        // with camera distance harmless: a 12% drift in a colour mix is
        // invisible, where the same drift across a cut would crawl. Nothing is
        // reclassified, no gold area is lost, and no new edge can be drawn —
        // the gold simply stops being valley gold as the ground under it
        // becomes a wall.
        //
        // This is the near-field rimBand generalised to every distance, and
        // deliberately so. rimBand was cut off at 300 m on the grounds that a
        // transition band is sub-pixel at vista range. A gold ribbon on a
        // massif is not sub-pixel — it is tens of pixels of chroma 0.42 lying
        // against stone at 0.03 — and mediating that meeting with a material is
        // what every reference plate does.
        float slopeReg = length(Nc.xz) / max(Nc.y, 1e-3);
        float alpTurf = (1.0 - rockCover) * (1.0 - screeM)
                      * smoothstep(0.34, 0.95, slopeReg)
                      * (0.55 + 0.45 * smoothstep(110.0, 240.0, altWarp));
        vec3 turfCol = mix(uGrassDry, mix(uScree, uRockMid, 0.45),
                           0.46 + macro2 * 0.30);
        albedo = mix(albedo, turfCol, alpTurf * 0.80);
        // Only genuinely rock-shaped ground gets the full chroma governor — see
        // the block after the lighting. A gravel shelf, a scoured bank or a
        // talus fan on gentle ground is stone, but it is stone lying in a warm
        // meadow; pulling all of it the whole way to neutral is what turned
        // patches of it into grey cut-outs with nothing but hue to distinguish
        // them from the ground they sit in.
        // The transition band is excluded outright: it is soil and grit lying
        // on stone, and greying it would undo the whole point of painting it.
        gNear = 1.0 - smoothstep(150.0, 520.0, camDist);
        gRockGov = gRockM * (0.62 + 0.38 * smoothstep(0.35, 0.90, slope))
                          * (1.0 - rimBand * 0.70);

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
        // The pale bar along the waterline. Raised from 0.30, and it is a
        // composition fix as much as a material one: river measures lumaP95
        // 0.606 against a reference band whose floor is 0.60, and it is the
        // only canonical view still short of the range band. Reference plate 1
        // puts a bright pale shore ribbon the whole length of its river, which
        // is where a good part of that plate's highlight range comes from.
        albedo = mix(albedo, uSand, shore * smoothstep(0.04, 0.22, river) * 0.46);
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
        // Never on the world-edge apron. Its far range crests above 700 m so
        // that no camera can see past it, which is a sightline number and not
        // an altitude the snow line was ever calibrated against; left alone it
        // caps the whole horizon white, and no reference plate has snow in it.
        snowSel *= 1.0 - uOutside;
        albedo = mix(albedo, uSnow, snowSel);

        // ── the far apron ──────────────────────────────────────────────────
        // Out here the data texture is describing ground 1.5 km away on the
        // other side of the reflection, not the range the fragment is actually
        // on, so every mask above is answering the wrong question — which is
        // what put soft orange meadow blotches on a mountainside and lit it
        // with a normal belonging to somewhere else. Painted from its own
        // geometry instead: rock on the faces, gold on the shoulders, nothing
        // finer, because at 2-4 km through the haze nothing finer survives.
        if (uFarApron > 0.001) {
          float slopeGeo = length(N.xz) / max(N.y, 1e-3);
          float soft = (1.0 - smoothstep(0.42, 0.96, slopeGeo))
                     * (1.0 - smoothstep(190.0, 330.0, vWorldPos.y));
          // Deliberately a stop darker than the near rock. A distant plane is
          // read by its VALUE relative to the sky as much as by its hue, and
          // painted at the near rock's albedo the range came back brighter than
          // the foreground once inscatter was added — an aerial perspective
          // that runs the wrong way and reads as snow.
          vec3 farRock = mix(uRockMid, uRockShadow, 0.40);
          farRock = mix(farRock, uRockLit, smoothstep(0.24, 0.78, macro) * 0.40);
          farRock = mix(farRock, uRockWarm, 0.10);
          // Relief comes from a noise field rather than from the mesh out here,
          // and it has to. The apron ring spends its vertex budget over 4.2 km,
          // so its radial pitch is ~70 m by the time it is a kilometre out —
          // coarser than the flanks it is drawing — and a mountain lit by a
          // normal that smooth is the waxy white dome that filled a third of
          // the hero frame. Three fbm taps at ~130 m put the flank structure
          // back into the light for a fraction of the cost of the geometry.
          // TWO octaves and a 60 m epsilon. At four octaves the finest band is
          // 17 m, which at 2 km is thirteen pixels and dominates the gradient:
          // the whole middle distance came back as a crumpled-foil ripple. A
          // distant flank is read by its big planes, so the field is held to
          // 133 m and 66 m and the derivative is taken wide enough to ignore
          // anything under it.
          float e = 60.0;
          vec2 P = vWorldPos.xz * 0.0075;
          float d0 = fbm(P, 2);
          float dX = fbm(P + vec2(e * 0.0075, 0.0), 2);
          float dZ = fbm(P + vec2(0.0, e * 0.0075), 2);
          float gK = 96.0 / e;
          vec3 Nfar = normalize(vec3(N.x + (d0 - dX) * gK, N.y, N.z + (d0 - dZ) * gK));
          vec3 farCol = mix(farRock, mix(uGrassGold, uGrassDeep, 0.46), soft * 0.62);
          farCol *= 0.90 + (d0 * 0.5 + 0.5) * 0.20;
          albedo = mix(albedo, farCol, uFarApron);
          gRockM = mix(gRockM, 1.0 - soft * 0.86, uFarApron);
          // Only at range. The synthetic normal stands in for flank structure
          // the apron mesh is too coarse to carry at 2-4 km; walked up to — a
          // camera can stand on the boundary and look straight out at it — the
          // same field resolves as a crumpled-foil ripple across the whole
          // middle distance, because it is a normal with no surface under it.
          float farN = uFarApron * smoothstep(500.0, 1500.0, camDist);
          gReliefN = normalize(mix(gReliefN, Nfar, farN));
          gReliefW = mix(gReliefW, 0.92, farN);
        }

        // ── hand the plane breaks to the lighting ──────────────────────────
        // Tangential projection of the displacement gradient, taken against the
        // geometric normal so the planes follow the real face rather than the
        // relief normal derived from a stencil that changes with distance.
        //
        // uBedRelief is metres of ledge and bedG is levels per metre, so the
        // product is a dimensionless slope — the honest surface gradient of the
        // displacement this staircase describes. It is zero wherever the field
        // is locally flat, which is what keeps a wrong answer off the parts of
        // a massif that have no plane structure, and it is zero on flat ground
        // for the same reason the gate below is: a meadow is neither rock nor
        // steep.
        float bedOn = gRockM * smoothstep(0.16, 0.58, slopeLP);
        if (bedOn > 0.003 && fBed > 0.003) {
          vec3 bedD = bedG * (bedS.y * uBedRelief * fBed);
          bedD -= dot(bedD, N) * N;
          // Soft-clipped, for the same reason curv is above. The staircase's
          // derivative peaks at 3.5 in the middle of a riser, so on the steeper
          // part of the field the honest displacement gradient reaches nearly
          // 4 — a 75 degree bend in the shading normal, which is not a ledge,
          // it is a face pointing somewhere the surface does not go. The tail
          // is compressed rather than cut, so the direction of every tilt
          // survives and only its magnitude is held.
          //
          // MEASURED, because the first draft of this comment claimed the
          // clamp was nearly a no-op and that was not true of the raw field.
          // Sampled offline against this exact fbm at uBedRelief 36 and
          // uBedLevels 13, with fBed left at 1: the median |bedD| is 1.66 —
          // a 59 degree bend — and the 90th percentile is 3.86, i.e. 75.5
          // degrees. What makes the clamp gentle in the frame is not the field,
          // it is fBed: bedD is already multiplied by the anisotropy filter and
          // the pitch fade before it gets here, and both are well under one
          // over most of a massif. So the honest claim is the capture's, not
          // the field's — clamped against unclamped, peaks moves 7.7% of its
          // pixels by more than 2/255, worst pixel 78, and what moves is the
          // middle of a riser going from a hard cut to a broad plane.
          //
          // A soft KNEE and not a plain 1/(1+x): that shape starts bending at
          // zero and would quietly take a third off every ordinary tilt in the
          // frame, which is a look change wearing a safety change's clothes.
          // Below 0.55 of slope this is the identity to the last bit; above it
          // the excess is compressed toward an asymptote near 1.08.
          float bedLen = length(bedD);
          float bedX = max(bedLen - 0.55, 0.0);
          gBedDelta = bedD * ((bedLen - bedX + bedX / (1.0 + bedX * 1.9))
                              / max(bedLen, 1e-5));
          gBedW = bedOn;
        }

        // Debug read-out. Written to gDebug and blitted OVER the lit colour at
        // the end of the shader rather than multiplied into the albedo, which
        // is how it used to work and which made it useless exactly where it was
        // needed: a mask painted into the albedo is still multiplied by the
        // light, so on a slope facing away from the sun every channel comes
        // back at the diffuse floor and two very different masks look the same
        // dark smudge. Half a round was lost reading a false answer off it.
        if (uDebugMask > 0.5) {
          if (uDebugMask < 1.5)      gDebug = vec3(rockCover, 1.0 - rockCover, screeM);
          else if (uDebugMask < 2.5) gDebug = vec3(max(0.0, curv), 0.0, max(0.0, -curv));
          else if (uDebugMask < 3.5) gDebug = vec3(loose, hardRock, slope * 0.5);
          else if (uDebugMask < 4.5) gDebug = vec3(oliveM, dryM, litterM);
          else if (uDebugMask < 5.5) gDebug = vec3(steep, rockM, rimBand);
          // 6 is the most useful of the lot: the finished albedo with no light
          // on it. "Is the ground flat because the paint is flat, or because
          // the light is flat?" is the first question in every one of these
          // investigations and this answers it in one capture.
          else if (uDebugMask < 6.5) gDebug = albedo;
          // 8 answers "is this ground the world, or the apron beyond it?".
          // Half a round has been lost twice to tuning a near-field mask for a
          // defect that turned out to be painted by the far-apron block.
          else if (uDebugMask < 7.5) gDebug = vec3(bedM, screeM, shelfM);
          else if (uDebugMask < 8.5) gDebug = vec3(uFarApron, uOutside, gRockM);
          // 9 is the plane-break budget, and it exists because every argument
          // about how much structure a massif should carry turns out to be an
          // argument about how many PIXELS a band is worth on that massif.
          // red = the surviving weight, green = the pixel footprint over 20 m,
          // blue = camera distance over 3 km. Guessing at these three numbers
          // is what produced two rounds of wrong amplitude.
          else                       gDebug = vec3(fBed, footM / 20.0,
                                                  camDist / 3000.0);
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
      }
      // Bedding and master joints, bent in after the relief mix rather than
      // folded into gReliefN. gReliefN is a heightfield normal and is weighted
      // to zero inside 110 m, where the drawn mesh is already finer than the
      // stencil; the plane sets are a property of the rock itself and have to
      // reach the near field too, so they get their own weight.
      if (gBedW > 0.001) {
        normal = normalize(normal - mat3(viewMatrix) * (gBedDelta * gBedW));
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
        shadeN = normalize(shadeN - gBedDelta * gBedW);
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
        // Weighted by sun-facing. Lit stone never had the problem — measured,
        // it sits where the plates put it — and lifting it too flattened every
        // massif toward white and cost the peaks view 0.04 of luma range in one
        // round. It is the unlit half that was falling to 0.217 against a
        // palette shadow anchor of 0.36, so the lift follows the shade term.
        // Weighted by sun-facing AND faded with distance. Lit stone never had
        // the problem — measured, it sits where the plates put it — and it was
        // the unlit half falling to 0.217 against a palette shadow anchor of
        // 0.36. Past the mid field the atmosphere is already lifting distant
        // rock toward the horizon colour, and lifting it again in albedo took
        // the peaks cone from luma 0.576 to 0.686 against a reference band of
        // 0.40-0.51 for hazy stone: a white cone against a cream sky, with the
        // silhouette gone. Aerial perspective is the depth cue; it should not
        // be paid for twice.
        float rlL = rl + max(0.0, 1.0 - rl) * uRockLift * gShade * gNear;
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
      if (uDebugMask > 0.5) gl_FragColor.rgb = gDebug;
      #include <dithering_fragment>`
    );
  };

  mat.customProgramCacheKey = () => 'procedural-autumn-terrain-v4';
  void opts;
  return mat;
}
