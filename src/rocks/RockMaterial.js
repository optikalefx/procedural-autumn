// ─────────────────────────────────────────────────────────────────────────────
//  RockMaterial — MeshStandardMaterial hijacked at compile time.
//
//  Going through the standard material (rather than a bespoke ShaderMaterial)
//  buys the shared atmosphere, the shadow plumbing and the light rig for free —
//  the same trick TerrainMaterial.js uses. Everything below only rewrites
//  albedo/roughness and then applies the warm-key / cool-shadow split.
//
//  Art rules encoded here, in priority order:
//    1. WARM-grey and near-neutral. Measured on the plates, a boulder's chroma
//       is 10/255 against a meadow's 119/255 while their luminances are within
//       15% of each other. Chroma, not value, is what separates stone from a
//       patch of snow in a gold field — see uRockDesat.
//
//       Two corrections to that rule, both measured, both of which have now
//       cost this file a round each. First, "neutral" does not mean grey: rock
//       in the plates is consistently RED-LED. Plate 5's boulder, left cliff
//       and top cliff measure 1:0.981:0.975, 1:0.947:0.922 and 1:0.932:0.902;
//       plate 3's two massifs 1:0.803:0.891 and 1:0.750:0.794. Not one of them
//       puts blue above red. This material did, for several rounds — see
//       uRockCast. Second, the numbers above came off plate 1, which is the
//       hazy aerial vista the brief names as an outlier, and the brief says to
//       judge eye-level views against plates 3/4/5 instead. The chroma the
//       plates want on near rock is 0.05-0.07 (plate 5) to 0.11-0.15 (plate 3),
//       not zero.
//
//       And a warning about how rock gets measured here, because the same
//       mistake has now been made twice from opposite directions. A rect drawn
//       by eye over "the rock" in a frame is worthless in this game: plate 5's
//       rock reads srgb(206,167,130) 1:0.81:0.63 with 44.7% vivid pixels if the
//       rect catches the gold grass around the boulder, and srgb(186,183,182)
//       1:0.98:0.98 with 0% vivid if it does not. Those are the same boulder.
//       Use tools/_scratch/rockpaintstats.mjs, which masks by painting the
//       material, and quote the mask coverage with the number.
//    2. per-facet tonal separation — each plane gets its own value, so the
//       faceting reads even when two facets face the sun almost equally
//    3. bedding planes, lichen and wet rock are *quiet*; the reference is
//       painted planes, not textured rock. Every one of these is a few percent
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { PALETTE } from '../world/WorldConfig.js';
// Camera occlusion: the volume that takes away whatever the camera is standing
// inside (src/render/Occlusion.js). Opt-in, and only on the second material —
// see the note on `opts.occlude` below. Call sites are marked OCCLUDE. The fade
// is the INSTANCE's, computed once in the vertex shader, so a rock goes whole
// rather than opening a porthole in the middle of itself.
import { occlusionUniforms, OCCLUDE_PARS, OCCLUDE_DITHER } from '../render/Occlusion.js';

/**
 * @param opts.occlude   build the variant that dithers out of the way of the
 *   chase camera. It is a SECOND material and not a uniform on the first, for
 *   the same reason bark has two programs (see vegetation/tree_material.js):
 *   rock is opaque, this shader is a full MeshStandard plus per-pixel value
 *   noise, and one `discard` anywhere in a program turns early-Z off for all of
 *   it — so every rock behind the crag in front of you would start shading
 *   itself. Rocks.js swaps a mesh onto this one only while one of its instances
 *   is actually inside the volume, which in most frames is none of them.
 * @param opts.uniforms  share another rock material's uniform block, so the two
 *   variants cannot drift and `Rocks.update` still writes the sun once.
 */
export function createRockMaterial(opts = {}) {
  const occlude = !!opts.occlude;             // OCCLUDE
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.93,
    metalness: 0.0,
    dithering: true,
    flatShading: false,   // normals are already exact per facet
  });
  // OCCLUDE. A define rather than a second string, because three puts it in the
  // prefix of BOTH stages and the varying that carries the instance's fade has
  // to be declared in step in the two of them or the program will not link.
  if (occlude) mat.defines = { ROCK_OCCLUDE: '' };

  const uniforms = opts.uniforms ?? {
    uRockLit:    { value: PALETTE.rockLit.clone() },
    uRockMid:    { value: PALETTE.rockMid.clone() },
    uRockShadow: { value: PALETTE.rockShadow.clone() },
    // Bottom of the working ramp. PALETTE.rockShadow is a *crevice* colour and
    // is strongly violet; using it as the ramp base gave mid-value facets a
    // pink-lilac cast, and the brief is explicit that a shadow which has become
    // saturated violet is a bug rather than the style. This is the same hue,
    // pulled toward neutral, and rockShadow stays for creases and contact only.
    uRockDeep:   { value: new THREE.Color().setHex(0x6e6b7c, THREE.SRGBColorSpace) },
    uRockWarm:   { value: PALETTE.rockWarm.clone() },
    // A *hint* of golden-hour cast on sun-facing planes, and no more than a
    // hint. An earlier pass pushed this hard on the theory that a desaturated
    // object in a 95%-warm frame reads as chalk. Measurement says the opposite
    // (see uRockDesat below): in the plates the boulder is the one genuinely
    // neutral thing in the picture, and that is *why* it reads as stone.
    uRockSun:    { value: new THREE.Color().setHex(0xc9b6a6, THREE.SRGBColorSpace) },
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

    // ── the chroma governor ──────────────────────────────────────────────────
    //
    //  This is the fix for "the boulders read as patches of snow", and it is
    //  not the fix the previous three passes were reaching for.
    //
    //  Measured with a difference mask (capture with Rocks on and off at a
    //  frozen anchor, then average only the pixels that changed) against the
    //  same pair measured on reference plate 1:
    //
    //                       rock           meadow beside it   rock/meadow
    //    reference     (149,139,139) C 10  (170,119, 51) C119   luma 1.13
    //    ours, before  (200,145, 90) C110  (195,121, 52) C144   luma 1.16
    //
    //  The luminances are the *same story* in both images — the reference
    //  boulder is if anything brighter than the grass it sits in. What is not
    //  the same is chroma: the reference rock is essentially neutral (10/255)
    //  and ours was two thirds of the way to being grass (110/255). A pale,
    //  low-chroma, same-hue object in a gold field is exactly what snow looks
    //  like; a neutral one is what stone looks like. Chasing luminance alone
    //  would have given us dark grey lumps that match nothing in the plates.
    //
    //  So the material governs the *rendered* chroma directly rather than
    //  trying to cancel a warm light with an inverse-tinted albedo: mix the lit
    //  colour toward its own luminance. That is stable under any sun colour,
    //  any time of day and any global grade — all of which are other authors'
    //  dials and all of which move.
    //  Raised from 0.80. See uRockRamp: the reason the rendered pixel came back
    //  as a red-led brown (1:0.746:0.656) despite an 80% pull to neutral is that
    //  the 20% which survived was a *very* warm pixel and the grade downstream
    //  warms dark pixels harder than bright ones. Both halves of that are fixed
    //  here — this raises the neutral fraction, the ramp raises the value.
    uRockDesat:  { value: 0.90 },
    // The neutral is not pure grey. Rock is the one place the brief allows the
    // cool complementary note, and a whisper of lavender is what stops a
    // desaturated object reading as dead cardboard. Luma-normalised, so this
    // rotates hue without touching value.
    //
    // ── 0.925/0.985/1.165 -> 0.95/0.924/0.888: the cast was calibrated on the
    //    one view where rock is mostly haze ───────────────────────────────────
    //
    // The old value was derived at `hero` — "a surface the shader hands over as
    // pure grey comes back as 1:0.837:0.813, so the grade costs ~0.16 of the
    // blue ratio, so leave it bluer by that much." The compensation is sound;
    // the *view* is the problem. `hero` is a vista, its rock is at 0.34 luma
    // under heavy aerial perspective, and the grade's cost there is not the
    // grade's cost on a rock 60 m away. Calibrating the material's one hue dial
    // on the frame where the material contributes least to the pixel put every
    // eye-level rock in the game 0.25 of blue ratio off.
    //
    // Measured on a paint mask (uRockDesat 1, uRockCast 6,0,0 marks rock by
    // hue), so every number below is rock pixels only, against exactly the host
    // pixels each rock covers, all inside one page load:
    //
    //   view        region              rock (base)     rock (this)     host
    //   waterfall   crag chain on massif 1:1.007:1.139  1:0.930:0.892  1:0.925:0.893
    //   waterfall   big near boulder     1:1.031:1.177  1:0.955:0.933  (plate 5)
    //   drive       all rock in frame    1:0.529:0.388  1:0.526:0.357  1:0.523:0.339
    //   hero        all rock in frame    1:0.685:0.591  1:0.670:0.519  1:0.699:0.597
    //
    // The `waterfall` crag chain is the necklace, and it was a hue mismatch of
    // 0.246 in the blue ratio against the terrain massif the blocks are bedded
    // in. This lands it at 0.001. `drive` improves from 0.049 to 0.018.
    //
    // Against the plates, per plate, never averaged: plate 5's actual rock —
    // its big near boulder, its left cliff, its top cliff — measures
    // 1:0.981:0.975, 1:0.947:0.922 and 1:0.932:0.902. Our big `waterfall`
    // boulder was 1:1.031:1.177, outside that band by a quarter of the blue
    // ratio and on the wrong side of neutral (blue *above* red, where every
    // rock in every plate is red-led). It now sits at 1:0.955:0.933, inside the
    // band on both channels.
    //
    // The cost, stated because it is real: `hero` regresses. Its rock/host blue
    // agreement goes from +0.056 to -0.065 (measured with cloudShadowGain
    // forced to 0; at the shipped 0.85 the same pair reads +0.007 and -0.149,
    // which is why the control matters). Two eye-level views improve and one
    // vista gets slightly worse, and the brief judges per plate: at `hero`
    // distance rock hue is set by the haze in front of it, not by this dial —
    // our `hero` rock is 1:0.685:0.591 against plate 1's far massif at
    // 1:0.847:0.779 either way, which is blocker #4's missing aerial recession
    // and is not fixable from this file.
    //
    // Still not pure grey, and still the brief's one licensed cool note — but
    // the neutral is now warm-leaning, which is what every rock in every plate
    // measures, rather than lavender.
    uRockCast:   { value: new THREE.Vector3(0.95, 0.924, 0.888) },
    // Single exposure-match dial, applied to the surface colour *before* fog,
    // so the far field still resolves into the haze rather than glowing out of
    // it. It is above 1 because the key light reaching rock in this build is
    // dimmer than in the plates: at gain 1.0 a boulder measures 0.47 of the
    // meadow's display luminance where the plates put it at 0.78-0.86.
    //
    // Every earlier value of this dial (0.72, then 0.62) was tuning against the
    // instanced-fog bug fixed in the vertex shader below — the rock pixel was
    // 96% haze, so the dial moved the frame by ~2% and each pass concluded it
    // needed to go lower. Measured at the frozen `drive` anchor, with the fog
    // corrected, the response is very nearly linear in this dial:
    //
    //     gain 0.62 -> boulder luma  38   (meadow 132, ratio 0.29)
    //     gain 2.00 -> boulder luma 127   (meadow 126, ratio 1.01)
    //     gain 1.65 -> boulder 0.88 of the meadow, just over the band
    //     gain 1.45 -> 0.88 of the meadow, still at the top of the band
    //     gain 1.36 -> 0.83, mid-band, and the distant crags stop reading pale
    //
    // Kept only as the fallback end of `uRockAnchor` — the ramp below is what
    // actually sets the value now. A single multiplicative gain cannot fix this
    // system, and that is why three passes of moving it did not: it scales the
    // lit end and the shadow end by the same factor, so the shadow end stays at
    // a quarter of the shadow anchor no matter where it is set, and pushing it
    // far enough to rescue the shadows blows the lit facets out.
    uRockGain:   { value: 1.36 },
    // ── the value ramp ───────────────────────────────────────────────────────
    //
    // This is the fix for the #1 blocker: "every crag renders near-black warm
    // brown", measured srgb(66,49,43), a quarter of the *shadow* anchor.
    //
    // Rather than gain the rendered luminance, remap it. (lo, hi) is where the
    // material's own shading actually lands, in scene-linear before the gain;
    // (shadowL, litL) is where the brief's two anchors sit in the same units.
    // Everything between is a straight line, so the facet-to-facet steps and
    // the cast shadows survive as a *compressed* range rather than being
    // clamped — and low internal contrast on stone is reference-correct, not a
    // compromise: plate 2's foreground boulder measures lumaP05 0.571 against
    // lumaP95 0.595, i.e. essentially one flat value across the whole rock.
    //
    // The endpoints were derived from the two scene-linear measurements the
    // previous pass left behind (a deep shaded slab at 0.036 post-gain, a
    // sunlit facet at 0.54 post-gain, rendering at 0.13 and 0.61 display).
    // Fitting display = 0.867 * linear^0.571 through that pair and asking for
    // 0.32 and 0.72 display — the brief's lifted black point and a value that
    // sits just under the sunlit meadow, which is where all five plates put
    // their rock — gives 0.17 and 0.72 linear.
    //
    //   x = lo        scene-linear luminance of the darkest shaded facet
    //   y = hi        …and of a facet in full sun
    //   z = shadowL   target for x
    //   w = litL      target for y
    //
    // litL was 0.720 for one round. Measured against the terrain's own rock at
    // the frozen `peaks` anchor, that put a sunlit crag facet at 1.02–1.26 of
    // the hillside it is cut out of (mean 1.08), and a rock brighter than the
    // mountain reads as pasted onto it — the "torn paper" / white-chip failure
    // this system has hit from the other direction twice before. 0.60 lands the
    // same facets at 0.88–1.08, i.e. stone of the same body as the massif, with
    // the brightest tops still the brightest thing on the rock.
    //
    // ── 0.170/0.600 -> 0.130/0.560: the necklace is a value offset ───────────
    //
    // "0.88–1.08, mean 1.08" was measured on facets picked by eye. Measured
    // instead against *exactly the pixels each rock covers* — capture the frame
    // with the rock group hidden and difference the two, so every rock is
    // compared with the hillside behind that rock and nothing else — the block
    // chain on `hero` (region 0.46,0.50,0.16,0.16) sat at:
    //
    //     rock/host luma   dark third 1.068   lit third 1.096
    //
    // i.e. uniformly 7-10% brighter than the face it is bedded in, at every
    // value band. Its *hue* over the same pixels is 1:0.765:0.671 against the
    // host's 1:0.769:0.671 — a match to 0.004 and 0.000. So the necklace is not
    // the hue mismatch pass 6 diagnosed; it is a value offset, and a hard-edged
    // block 9% brighter than its hill with no contact shadow is exactly the
    // "pasted chip" read. Sweeping the two dials that could produce a uniform
    // offset, same page load, same rock pixels:
    //
    //     dial                          dark   lit
    //     base 0.170/0.600 anchor 0.85  1.068  1.096
    //     uRockAnchor 0.70              1.039  1.041
    //     uRockAnchor 0.55              0.987  0.978
    //     uRockFloorL 0.045             1.097  1.113   (wrong direction)
    //     ramp 0.130/0.560              1.013  1.010
    //
    // The ramp wins over uRockAnchor: it seats the whole ladder 0.04 lower
    // without weakening the remap that closed the near-black-rock blocker, and
    // it lands the blocks at parity with their hill instead of overshooting
    // dark. Frame-wide on `hero` rock luma is 0.399 -> 0.409, so nothing went
    // dark; 0.130 linear is ~0.27 display, still well clear of the brief's
    // 0.16 black point.
    uRockRamp:   { value: new THREE.Vector4(0.0265, 0.397, 0.130, 0.560) },
    // How much of the ramp to believe. Below 1 the surface keeps some of the
    // light rig's own response, so a rock still dims at dawn and still darkens
    // going into a cast shadow rather than being pinned to a constant.
    uRockAnchor: { value: 0.85 },
    // Luminance floor, in scene-linear units, applied after the gain.
    //
    // The global cel-shading in Stylize.js floors the *direct* diffuse term, so
    // nothing is unlit by facing away from the sun — but a surface inside a cast
    // shadow is multiplied down after that floor, and a big shaded slab has no
    // other light source in this rig. The water author measured one of them
    // costing a frame 0.045 of lumaMean; it renders at 0.13 display against the
    // brief's black point of 0.16-0.42. This lifts only pixels below the floor
    // and leaves anything lit untouched. Calibrated by capture at the frozen
    // `river` anchor, where a big backlit bank slab is the darkest rock in any
    // canonical view: floor 0.030 moved it not at all (it already sat at 0.036
    // scene-linear), floor 0.300 took it to 0.36 display — far too far — and
    // 0.085 lands it at ~0.19, just inside the brief's band. A sunlit facet
    // measures 0.54 scene-linear, so it is nowhere near this.
    uRockFloorL: { value: 0.085 },
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    // Object.assign, never UniformsUtils.merge — merge() deep clones, and the
    // occlusion block has to arrive by reference or the volume never engages.
    Object.assign(shader.uniforms, uniforms, occlude ? occlusionUniforms() : {});   // OCCLUDE
    mat.userData.shader = shader;

    shader.vertexShader = (occlude ? OCCLUDE_PARS : '') + /* glsl */`
      attribute vec3 aBake;      // ao, upward exposure, height in rock
      attribute vec4 aRockA;     // wetness, moisture, tint jitter, size
      attribute vec3 aRockB;     // water surface Y, frost factor, ground Y
      attribute vec2 aRockC;     // ground gradient dY/dX, dY/dZ under the rock
      varying vec3 vBake;
      varying vec4 vRockA;
      varying vec3 vRockB;
      varying vec3 vWPos;
      varying vec3 vWNrm;
      varying vec3 vLPos;
      varying float vAbove;      // metres above the hillside plane under the rock
      #ifdef ROCK_OCCLUDE
      varying float vOcc;        // OCCLUDE — one value for the whole rock
      #endif
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
          // Height above the hillside plane through the rock's anchor. Linear
          // in world position, so interpolating it is exact and the fragment
          // shader does not have to carry the instance origin.
          vec3 iw = vec3( 0.0 );
          #ifdef USE_INSTANCING
            iw = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
          #endif
          vAbove = vWPos.y - ( aRockB.z
                 + aRockC.x * ( vWPos.x - iw.x )
                 + aRockC.y * ( vWPos.z - iw.z ) );
          #ifdef ROCK_OCCLUDE
            // OCCLUDE. Once per INSTANCE, at the rock's own origin, so a rock
            // the camera has been backed into leaves the frame whole. The first
            // build did it per fragment off vWPos, which takes a soft-edged
            // bite out of the middle of a boulder and leaves the rest of it
            // standing — the porthole this round removed. See the header of
            // render/Occlusion.js.
            //
            // aRockA.w is the instance's own size in metres, which the scatter
            // already writes for the shading, so the test can ask "is any of
            // this stone in my face" rather than "is its centre". Halved to
            // read as a radius, and CAPPED, which is the load-bearing part: a
            // crag block is house-sized, and a house-sized rock that dissolves
            // because the camera brushed one corner of it is a cliff going
            // transparent. Past the cap a big rock only goes when the camera is
            // properly inside it, which is the one case where seeing through it
            // beats seeing its backfaces.
            vOcc = occludeFadeAt( iw, min( aRockA.w * 0.5, 2.0 ) );
          #endif
        }`)
      // Atmosphere's `fog_vertex` chunk now applies `instanceMatrix` itself, so
      // the local workaround that used to overwrite `vFogWorldPos` here is gone.
      // Every rock in the game was previously hazed as if it stood at the world
      // origin, which pinned it at the `uFogMax` cap and is why three passes of
      // albedo tuning moved the rendered pixel by ~2%.
      ;

    // OCCLUDE. The fragment stage is handed the instance's fade as a varying and
    // only needs the dither; the shape itself lives in the vertex shader above.
    shader.fragmentShader = (occlude ? `${OCCLUDE_DITHER}\nvarying float vOcc;\n` : '') + /* glsl */`
      uniform vec3 uRockLit, uRockMid, uRockShadow, uRockDeep, uRockWarm, uRockSun, uLichen, uMoss, uBounce;
      uniform vec3 uSunDir, uShadowTint, uSunTint, uRockCast;
      uniform vec4 uRockRamp;
      uniform float uAOStrength, uTime, uRockDesat, uRockGain, uRockFloorL, uRockAnchor;
      varying vec3 vBake;
      varying vec4 vRockA;
      varying vec3 vRockB;
      varying float vAbove;
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
    ` + (occlude
      // OCCLUDE. First thing in main(), before the noise and before the
      // lighting: this program has already given up early-Z by containing a
      // discard at all, so the only thing left to save is the rest of the
      // shader, and every fragment the volume takes out skips all of it.
      //
      // The fade is the instance's, constant over the whole rock, so nothing is
      // interpolated across a facet and a twenty-metre crag face carries one
      // dither density rather than a gradient.
      ? shader.fragmentShader.replace('#include <clipping_planes_fragment>', /* glsl */`
        #include <clipping_planes_fragment>
        occludeCut( vOcc );`)
      : shader.fragmentShader)
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
        //
        // The frequency used to be 1.15/(0.5 + size*0.5), which is a *fixed
        // number of bands per rock* — so a cobble got its stripes and a 55 m
        // cliff block got one 70 m wavelength across a face 55 m tall, i.e.
        // nothing. That is the untextured slab the critic found intersecting
        // the mountainside in the starting view: at close range the largest
        // instance in the game presented a bare, flat, unbroken plane.
        //
        // Bedding is a property of the *rock mass*, not of the block cut out of
        // it, so the wavelength is now set in metres and only clamped by size.
        // A 25 m block gets four or five courses across its face; a 0.4 m
        // cobble still gets one, and nothing anywhere runs above ~2 cycles per
        // metre, which is the speckle limit this material has to respect.
        float bedLambda = clamp( size * 0.55, 0.55, 7.0 );
        float bedF = 6.2832 / bedLambda;
        float bed  = sin( vWPos.y * bedF + rnoise( vWPos.xz * 0.05 ) * 3.0 );
        bed *= 1.0 - abs( N.y );          // only visible on near-vertical faces

        // ── joints ────────────────────────────────────────────────────────
        // The cross set: near-vertical fractures that divide a long face into
        // panels. Bedding alone gives a big wall horizontal structure and
        // leaves it reading as one continuous ribbon; the joints are what make
        // it read as blocks of a bed rather than as a painted stripe.
        // Panels are metres wide, again independent of the block, so a chain of
        // neighbouring blocks shares one joint pattern across the whole cliff.
        float jointS = rnoise( vWPos.xz * ( 0.115 / max( bedLambda * 0.16, 0.10 ) )
                             + vWPos.y * 0.02 );
        float joint = smoothstep( 0.02, 0.30, abs( jointS ) ) - 0.5;
        joint *= 1.0 - abs( N.y );
        // Both of these are procedural and unmipped, so they must fade out
        // before they become sub-pixel or the far field crawls. Past ~250 m a
        // 5 m band is under two pixels and its only contribution is aliasing.
        float camD = distance( vWPos, cameraPosition );
        float detailFade = 1.0 - smoothstep( 130.0, 340.0, camD / max( bedLambda * 0.35, 1.0 ) );
        // The facet hash is a whole plane rather than a pattern inside one, so
        // it survives much further than the three above and is measured against
        // the block, not against the bedding wavelength: a facet is of order
        // 'size' metres. At camD/size = 28 a 12 m block is ~50 px and its
        // planes read as planes; by 75 it is under 20 px and they are noise.
        float facetFade = 1.0 - smoothstep( 28.0, 75.0, camD / max( size, 1.0 ) );

        // ── weathering on horizontal faces ────────────────────────────────
        // Both terms above are multiplied by (1 - |N.y|), i.e. they exist only
        // on vertical faces — which leaves the one surface that most needs
        // help completely bare. The largest instance in the game is a 60 m
        // slab, and what the player sees of it at close range is its *top*:
        // one plane, one facet hash, one flat value, no bedding and no joints.
        // That is the untextured slab the critic found in the starting view.
        // Broad weathering mottle in plan, gated the other way round.
        float wearN = rnoise( vWPos.xz * ( 1.05 / max( bedLambda * 0.62, 0.45 ) ) )
                    + rnoise( vWPos.xz * ( 0.34 / max( bedLambda * 0.62, 0.45 ) ) ) * 0.7;
        float wear = wearN * abs( N.y );

        // ── base lavender-grey ────────────────────────────────────────────
        //
        // The value here was measured off the plates, not guessed, because
        // every intuition about it turned out to be wrong. In the reference a
        // sunlit foreground boulder sits at about (168,153,148) with the gold
        // meadow beside it at (241,166,85): the rock is roughly two thirds of
        // the meadow's luminance and very close to neutral. An earlier pass
        // had it *brighter* than the meadow and warm-tinted, which is exactly
        // why the rocks read as polystyrene chips and patches of snow rather
        // than as stone. Dark neutral masses in a bright gold field is the
        // whole effect.
        //
        // So the working ramp is rockShadow → rockLit, not rockMid → rockLit.
        // rockLit is the top of the range, reached only by the brightest
        // facets; most of the rock lives in the lower half of it.
        //
        // The up-term is sky exposure, not a second copy of the key light: a
        // horizontal plane sees the whole dome, a vertical one sees half of it.
        // It is carried in the albedo because the thing it has to produce is a
        // hard *value step* at every horizontal edge — the reference boulder
        // has one bright top plane and one clearly darker side, and that step
        // is most of what makes it read as cut rather than as a lump. It was
        // weighted at 0.06 before and the boulders came out uniform.
        float val = 0.13
                  + up * 0.17                 // sky exposure: tops, not sides
                  // Per-facet tone, the main split — but faded toward its own
                  // mean at range. 'bed', 'joint' and 'wear' are all faded
                  // because unmipped procedural detail crawls once it is
                  // sub-pixel; this one was left in at full strength and it is
                  // the largest of the four. On the 'peaks' massif a crag block
                  // is ~18 px across at 800 m and its facets are 4-6 px, so
                  // what a *random* per-plane value does there is give every
                  // block in a chain a different tone — which is precisely the
                  // "spilled polystyrene" read, and it is why the blocks carry
                  // more internal contrast than the entire mountain behind
                  // them. Aerial perspective compresses local contrast as well
                  // as lifting value, and a term that never fades escapes it.
                  //
                  // Faded toward 0.5, NOT toward 0: 'facet' is fract(), so its
                  // mean is a half, and fading it to zero would darken every
                  // distant rock by a tenth of the albedo ramp. The mean is
                  // exactly preserved at every distance, which is what keeps
                  // this out of the colour half of blocker #1 — the sky-
                  // exposure step above is geometric and stays at full weight
                  // at any range, so a far block still has a light top and a
                  // dark side.
                  + mix( 0.5, facet, facetFade ) * 0.24
                  + bed * 0.075 * detailFade
                  + joint * 0.13 * detailFade
                  + wear * 0.085 * detailFade
                  // Per-instance value jitter, raised from 0.07. A bank of
                  // cobbles all at one value is a texture; the field needs an
                  // internal value range before any single stone in it reads
                  // as an object.
                  + tint * 0.11
                  - (1.0 - hN) * 0.08;        // bases sit a little darker
        vec3 rock = mix( uRockDeep, uRockLit, clamp( val, 0.0, 1.0 ) );
        // Creases: multiplied, not tinted. The floor was 0.52, which stacked
        // with the contact band below to take a crease on a shaded face to a
        // third of an already dark albedo — a big backlit riverside slab
        // measured 0.13 display against the brief's lifted black point of
        // 0.16-0.42, i.e. a hole in the picture rather than a dark object.
        rock *= mix( 0.66, 1.0, ao );

        // A hint of the key light's warmth on sun-facing planes, and no more.
        // The reference rock is near-neutral even in full golden hour; pushing
        // this further turned it mustard, which is the brown-grey the brief
        // bans outright.
        float sunFace = clamp( dot( N, normalize( uSunDir ) ), -1.0, 1.0 );
        float warmM = smoothstep( -0.25, 0.60, sunFace );
        rock = mix( rock, uRockSun * uSunTint, 0.02 + warmM * 0.05 );

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
        // Kept deliberately faint: the chroma governor below pulls 80% of the
        // colour out of everything this material renders, so anything authored
        // at full strength here only survives as a value blotch anyway.
        rock = mix( rock, uLichen, lichenM * 0.26 );
        rock = mix( rock, uMoss,   mossM  * 0.34 );

        // ── wet rock ──────────────────────────────────────────────────────
        // Below the waterline the rock is soaked and much darker; just above it
        // there is a damp band. Both are what sells a boulder as *in* a river.
        float waterY = vRockB.x;
        float band = waterY < -9000.0 ? 0.0
                   : smoothstep( waterY + 0.55, waterY - 0.25, vWPos.y );
        float soak = clamp( max( wet, band ), 0.0, 1.0 );
        // 0.42 x 0.85 took a shaded riverside slab to within a few percent of
        // black. The water author measured a single one of these costing the
        // forest frame 0.045 of lumaMean, and the brief's floor is a lifted
        // black (lumaP05 0.16-0.42), so wet rock is now a clear step darker
        // rather than a hole in the picture.
        vec3 wetRock = rock * 0.62;
        wetRock = mix( wetRock, wetRock * vec3( 0.86, 0.96, 1.10 ), 0.55 );
        rock = mix( rock, wetRock, soak * 0.72 );

        // Frost-shattered high ground reads cooler — but NOT paler. Anything
        // that lifts value at altitude compounds with aerial haze and turns a
        // 700 m crag into a white speck, which is the "snow on the massif"
        // read we are trying to kill.
        rock = mix( rock, rock * vec3( 0.96, 0.99, 1.07 ), clamp( vRockB.y, 0.0, 1.0 ) * 0.6 );

        // ── contact with the ground ───────────────────────────────────────
        // A band of occlusion just above the terrain line. Cheap, and it is
        // the single strongest cue that a heavy object is bedded *into* the
        // ground rather than pasted on top of it — the baked AO cannot know
        // about the hillside the rock is half buried in, only about the rock.
        // Height of the band scales with the rock so a cobble gets a few
        // centimetres and a crag block gets a couple of metres.
        float contact = 1.0 - smoothstep( 0.0, 0.45 + size * 0.55, max( vAbove, 0.0 ) );
        rock *= mix( 1.0, 0.76, contact );

        // ── the exposed underside of a block that stands out of the hill ──
        //
        // The band above is about the ground *line*: it reaches half a block
        // up and no further, which is right for the join and useless for the
        // face over it. A block seated on a bank presents a downward-facing
        // facet metres clear of the hillside plane, and until now that facet
        // got nothing at all — no baked AO (which knows about the rock and not
        // about the hill it sits in), no contact band, and the meadow bounce
        // below it was *added*, so the one plane on the block that should be
        // its darkest came out its flattest and lightest. That is the untreated
        // grey facet the review keeps finding in 'river'.
        //
        // A plane pointing down at a hillside a few metres under it is looking
        // at the hill, not at the sky, and that is occlusion. Keyed on -N.y so
        // a vertical or upward facet at the same height is untouched, and it
        // reaches several block-heights up because that is how far the hill
        // keeps subtending most of the hemisphere below a downturned plane.
        // How much of this plane's hemisphere the hillside takes: none for a
        // face turned up at the sky, a share of it for a vertical face, all of
        // it for a face turned down at the slope.
        float underG = clamp( 0.30 - 0.85 * N.y, 0.0, 1.0 );
        float under = underG
                    * ( 1.0 - smoothstep( 0.0, 1.2 + size * 2.4, max( vAbove, 0.0 ) ) );
        rock *= mix( 1.0, 0.60, under );

        diffuseColor.rgb *= rock;
      }`)
      // Hooked at the fog include, not at dithering, so everything below
      // happens to the *surface* and the shared aerial perspective is then
      // layered on top of it. The bounce used to be added after fog, which
      // meant a rock at 600 m still got its full meadow bounce painted on
      // over the haze.
      .replace('#include <fog_fragment>', /* glsl */`
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

        // ── chroma governor (see uRockDesat) ──────────────────────────────
        // Pull the lit colour toward its own luminance, tinted a hair cool.
        // Done here rather than in the albedo because the thing that has to
        // come out neutral is the *rendered* pixel, and everything between
        // albedo and pixel — sun colour, hemisphere fill, Stylize, the global
        // grade — belongs to other authors and moves without warning.
        float rockL = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
        gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( rockL ) * uRockCast, uRockDesat );

        // ── value ramp (see uRockRamp) ────────────────────────────────────
        // Remap the rendered luminance onto the brief's shadow→lit anchors
        // instead of scaling it. Purely a scale on the colour we already have,
        // so the hue set by the governor above is untouched.
        float L0 = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
        float t  = clamp( ( L0 - uRockRamp.x ) / max( uRockRamp.y - uRockRamp.x, 1e-4 ), 0.0, 1.0 );
        // Linear inside the band, and let anything brighter than the sunlit
        // anchor keep going rather than clamping — a specular-ish top facet or
        // a snow-lit crest should still be the brightest thing on the rock.
        // Anything brighter than the sunlit anchor keeps going rather than
        // clamping, so a specular-ish top facet is still the brightest thing on
        // the rock — but at a third of its own slope, or the few facets past
        // the top of the ramp punch out of the massif as white chips.
        float over = max( L0 - uRockRamp.y, 0.0 );
        float Lt = mix( uRockRamp.z, uRockRamp.w, t ) + over * 0.30;
        gl_FragColor.rgb *= mix( uRockGain, Lt / max( L0, 1e-5 ), uRockAnchor );

        // Lifted black point (see uRockFloorL). Additive rather than a max() so
        // the facet-to-facet steps survive inside the shadow instead of all
        // clamping to one flat value, which would turn a shaded boulder into a
        // silhouette — the failure the brief calls out as crushed blacks.
        float litL = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
        gl_FragColor.rgb += uRockCast * max( 0.0, uRockFloorL - litL ) * 0.85;
      }
      #include <fog_fragment>`);
  };

  mat.customProgramCacheKey = () => 'procedural-autumn-rock-v3';
  return mat;
}
