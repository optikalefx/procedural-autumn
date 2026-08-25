// ─────────────────────────────────────────────────────────────────────────────
//  hide — the material every mammal wears.
//
//  One program for the whole cast (see `customProgramCacheKey`), a four-way
//  region blend resolved from a vertex attribute, and the distance-silhouette
//  ramp that flattens an animal into a readable shape once it is small on
//  screen. Split out of the blueprints because it is shading, not anatomy.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

/**
 * How much of the distance-silhouette treatment is live, expressed as a scale
 * on the view depth that feeds the ramp. One object, shared by reference with
 * every hide material, so a single write moves all of them — the usual warning
 * about sharing uniform objects is about doing it by accident; here it is the
 * point.
 *
 * The ramp below is written in metres, but the thing it is actually correcting
 * is *apparent size*: a deer that is sixteen pixels tall has no internal detail
 * to lose, so flattening it costs nothing and the value contrast is all it has.
 * Magnify the same deer through the telescope and every part of that argument
 * inverts — it is now a large, detailed subject that the player has gone out of
 * their way to look at closely. Metres are only a proxy for pixels, and the
 * proxy is exact right up until something changes the field of view.
 *
 * So `Wildlife.update` divides the depth by the camera's magnification against
 * `SIL_FOV_REF`, and the same lever goes to 0 for photo mode, whose output is a
 * full-resolution still that will be looked at large. See `setHideSilScale`.
 */
const SIL = { uSilScale: { value: 1 } };

/** The field of view the metre-denominated ramp below was tuned at. */
export const SIL_FOV_REF = 52;

/**
 * Set the depth scale for every hide at once. 1 is the tuned behaviour, 0
 * disables the treatment outright.
 */
export function setHideSilScale(v) { SIL.uSilScale.value = v; }

/**
 * A standard material so it inherits the global stylised lighting, the shared
 * fog and shadows, plus a four-way region blend resolved from a vertex
 * attribute. Flat shading is doing real work here: it keeps the forms carved
 * and faceted like the rest of the world instead of smoothly airbrushed.
 *
 * All hide materials share one program (see customProgramCacheKey) — twelve
 * animals alive means twelve materials but one compile.
 */
export function createHideMaterial(c) {
  const uniforms = {
    uCoat: { value: new THREE.Color(c.coat) },
    uPale: { value: new THREE.Color(c.pale) },
    uDark: { value: new THREE.Color(c.dark) },
    uHorn: { value: new THREE.Color(c.horn ?? 0x9d8a6a) },
    // A fifth colour, for a marking that is not a region of the hide. The four
    // above are a blend and every hide tone is somewhere inside the tetrahedron
    // they span; the camp dog's pink nose patch is not — no mix of tan, cream,
    // dark brown and leather is pink. Carried on its own `aSpot` weight, which
    // is zero on every other animal in the game.
    uSpot: { value: new THREE.Color(c.spot ?? 0xc98a86) },
    uShadeLo: { value: c.shadeLo ?? 0.68 },
    // ── the distance silhouette ─────────────────────────────────────────────
    // Measured: off-road the median closest approach a player makes to an
    // animal is 77 m, where a deer is about sixteen pixels tall. At that size
    // the only thing an eye can use is the *shape*, and the shape only exists
    // if it holds a value the background does not. Left alone, a warm mid-brown
    // hide behind 80 m of aerial perspective lands on precisely the value of
    // the dark straw and litter patches in sunlit gold grass, which is why a
    // deer at 100 m reads as ground clutter.
    //
    // So with distance the four hide regions collapse toward one tone, the
    // shading gradient flattens out, and the whole thing is pulled down in
    // value *after* fog.
    //
    // Held on a short leash, because it is the one thing in the renderer that
    // uses value as a distance cue. Atmosphere.js is explicit that the depth
    // cue here is chroma and that value barely moves (see its DEFAULTS), and
    // DESIGN_BRIEF forbids per-material fog outright. A post-fog multiply is
    // per-material fog running backwards: everything else in the frame holds
    // its value and bleeds hue toward the haze with distance, so an animal that
    // instead drops 56% of its value does not read as far away, it reads as not
    // lit by the sun. That was the first cut, and it is the complaint that
    // brought this block back open.
    //
    // The ramp now starts past the whole chase-camera working range: the boom
    // tops out at 68 m (ZOOM_MAX), so an animal the player is actually near is
    // never touched at all. It used to start at 38 m, which is *inside* the
    // boom — animals a third of the way across an ordinary frame were already
    // losing their regions, which is how a treatment for hundred-metre
    // legibility ended up being noticed as a black cutout up close.
    uSilNear: { value: c.silNear ?? 70.0 },
    uSilFar:  { value: c.silFar  ?? 190.0 },
    // Scaled by the camera's magnification, and zeroed in photo mode. See SIL.
    uSilScale: SIL.uSilScale,
    // 0.44 / 0.85 previously, chasing plate 3's bear, which holds one near-black
    // value across its whole body. Two things were wrong with reading the plate
    // that way. A bear IS near-black, so the plate is not evidence for pushing a
    // tan deer there; and the same commit shipped two other fixes for the same
    // legibility problem — the freeze pose squaring up 43 to 69 degrees off the
    // threat, and a much shorter freeze — which are shape and motion cues and
    // which are the ones that carried measured numbers.
    //
    // The darkening never did. tools/_scratch/wlegib.mjs computes exactly the
    // right metric for it (punch: mean luma difference over just the pixels the
    // animal owns) and was never pointed at it; the A/B that justified 0.44 ran
    // through wsil.mjs, which only reports changedPixels — a check that the
    // camera was aimed at an animal at all, not that the animal got easier to
    // see. So these are set where the flattening does the work and the value
    // push is a nudge rather than the whole effect, which is also the reading of
    // plate 3 that survives: the bear is legible because it is one flat shape,
    // and flatness is uSilFlat.
    uSilDark: { value: c.silDark ?? 0.72 },   // post-fog value multiplier at full range
    uSilFlat: { value: c.silFlat ?? 0.55 },   // how far the regions collapse into uDark
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.97,        // matte hide; the reference has no sheen anywhere
    metalness: 0.0,
    flatShading: true,
  });

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    mat.userData.shader = shader;

    shader.vertexShader = /* glsl */`
      attribute vec4 aMix;
      attribute float aShade;
      attribute float aSpot;
      varying vec4 vMix;
      varying float vShade;
      varying float vSpot;
      varying float vHideDepth;
    ` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vMix = aMix;
       vShade = aShade;
       vSpot = aSpot;`
    ).replace(
      '#include <project_vertex>',
      `#include <project_vertex>
       // View depth, taken after the skinning has already moved the vertex, so
       // an animal mid-bound reports where it actually is.
       vHideDepth = -mvPosition.z;`
    );

    shader.fragmentShader = /* glsl */`
      uniform vec3 uCoat;
      uniform vec3 uPale;
      uniform vec3 uDark;
      uniform vec3 uHorn;
      uniform vec3 uSpot;
      uniform float uShadeLo;
      uniform float uSilNear;
      uniform float uSilFar;
      uniform float uSilScale;
      uniform float uSilDark;
      uniform float uSilFlat;
      varying vec4 vMix;
      varying float vShade;
      varying float vSpot;
      varying float vHideDepth;
    ` + shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       // Depth in metres, corrected to the apparent size the ramp was tuned
       // for. uSilScale is 1 at the reference field of view, shrinks as the
       // camera magnifies, and is 0 in photo mode.
       float hideSil = smoothstep( uSilNear, uSilFar, vHideDepth * uSilScale );
       vec3 hideCol = uCoat * vMix.x + uPale * vMix.y + uDark * vMix.z + uHorn * vMix.w;
       // The marking sits on top of the blend rather than inside it, and fades
       // out with distance along with everything else — a two-centimetre patch
       // has no business surviving into the distance silhouette.
       hideCol = mix( hideCol, uSpot, vSpot * ( 1.0 - hideSil ) );
       // Four regions near, one flat tone far.
       hideCol = mix( hideCol, mix( hideCol, uDark, uSilFlat ), hideSil );
       // ...and no internal shading gradient far, which is what makes a shape
       // read as a shape rather than as a smudge.
       float hideShade = mix( uShadeLo, 1.0, vShade );
       diffuseColor.rgb *= hideCol * mix( hideShade, 0.92, hideSil * 0.85 );`
    ).replace(
      '#include <fog_fragment>',
      `#include <fog_fragment>
       gl_FragColor.rgb *= mix( 1.0, uSilDark, hideSil );`
    );
  };
  // One program for every hide; only the uniform values differ.
  mat.customProgramCacheKey = () => 'animalHide';
  mat.userData.uniforms = uniforms;
  return mat;
}
