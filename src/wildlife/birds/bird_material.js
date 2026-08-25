// ─────────────────────────────────────────────────────────────────────────────
//  bird_material — the one material every perch-and-fly bird wears.
//
//  Eagle, owl, heron and flamingo are four different models sharing one
//  program: the pose work happens in the vertex shader off two attributes, so
//  the CPU only ever writes a matrix and four floats per bird.
//
//    aWing   what a vertex IS, and how far out on it — 0 body, the leg / fan /
//            neck bands, then the wing's spanwise fraction. The band layout is
//            the contract between this file and every model in the folder; the
//            long version is in the header of `wader_kit.js`.
//    aPose   what the bird is DOING — see below.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

/**
 * Standard material — shared fog, shared stylised lighting — with the pose
 * work in the vertex shader. aPose is per-instance in the game and per-vertex
 * in the gallery; GLSL cannot tell the difference, which is the point.
 *
 *   aPose.x  flap phase        aPose.z  flap amplitude (rad at the tip)
 *   aPose.y  flap rate (Hz)    aPose.w  wing fold, 0 = spread, 1 = perched
 */
export function treeBirdMaterial(shared) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    flatShading: true,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTreeBirdTime = shared.time;
    mat.userData.shader = shader;
    shader.vertexShader = /* glsl */`
      attribute float aWing;
      attribute vec4 aPose;
      uniform float uTreeBirdTime;
      // The wing-fold turn, normalised. See the fold block below for why this
      // particular axis: a 120 degree turn about it is the one rotation that
      // sends span to back, chord to up and thickness to across, which is what
      // a closed wing is.
      const vec3 TB_FOLD_AXIS = vec3( -0.5773503, 0.5773503, 0.5773503 );
    ` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */`#include <begin_vertex>
      // aWing bands: 0 body, <0.105 tail fan, 0.105..0.111 legs, 0.111..0.119
      // neck, >=0.12 wing spanwise fraction. The leg and neck bands belong to
      // the waders (wader_kit.js) and pivot on shared authored points; the
      // eagle has no vertices in either.
      if ( abs( aWing ) > 0.001 && abs( aWing ) < 0.105 ) {
        // Tail feather: aWing encodes the feather angle (x5.1). Fold swings
        // each feather toward the centreline about the tail root, closing the
        // fan when the bird perches.
        float tfold = aPose.w;
        if ( tfold > 0.001 ) {
          float al = aWing * 5.1 * 0.80 * tfold;
          float ca = cos( al ), sa = sin( al );
          float tx = transformed.x, tz = transformed.z + 0.14;
          transformed.x = tx * ca + tz * sa;
          transformed.z = -tx * sa + tz * ca - 0.14;
        }
      }
      else if ( abs( aWing ) > 0.001 && abs( aWing ) < 0.111 ) {
        // Leg. Standing (fold 1) it hangs from the hip; in flight it trails
        // straight back. The negative-side leg also draws up toward the belly
        // when standing — shortened toward the hip rather than bent, which at
        // this fidelity reads as the tucked leg of the one-legged stance.
        float s = aWing > 0.0 ? 1.0 : -1.0;
        float fold = aPose.w;
        float py = -0.015, pz = -0.030;
        float tuck = s < 0.0 ? fold : 0.0;
        if ( tuck > 0.001 ) {
          float k = 1.0 - 0.72 * tuck;
          transformed.y = py + ( transformed.y - py ) * k;
          transformed.z = pz + ( transformed.z - pz ) * k;
        }
        // The tucked stub also angles back, so it reads as a folded shank
        // against the belly rather than a shortened leg pointing at the water.
        float ang = ( 1.0 - fold ) * 1.35 + tuck * 0.9;
        float ca = cos( ang ), sa = sin( ang );
        float ry = transformed.y - py, rz = transformed.z - pz;
        transformed.y = py + ry * ca - rz * sa;
        transformed.z = pz + ry * sa + rz * ca;
      }
      else if ( abs( aWing ) > 0.001 && abs( aWing ) < 0.119 ) {
        // Neck, graded 0 at the root to 1 at the bill tip. The authored pose
        // is the raised standing neck; in flight each vertex pitches forward
        // about the root by its own grade, so the curve unrolls into the
        // extended flight neck rather than hinging like a lamp arm.
        float wn = clamp( ( abs( aWing ) - 0.1115 ) / 0.007, 0.0, 1.0 );
        float ext = 1.0 - aPose.w;
        if ( ext > 0.001 ) {
          float py = 0.045, pz = 0.10;
          float ang = ext * 1.25 * wn;
          float ca = cos( ang ), sa = sin( ang );
          float ry = transformed.y - py, rz = transformed.z - pz;
          transformed.y = py + ry * ca - rz * sa;
          transformed.z = pz + ry * sa + rz * ca;
        }
      }
      else if ( abs( aWing ) > 0.001 ) {
        float w = abs( aWing );
        float s = aWing > 0.0 ? 1.0 : -1.0;
        // Shoulder pivot. Rotating every wing vertex about the SAME pivot by
        // an angle graded on its own spanwise fraction bends the wing into an
        // arc — two-segment articulation for free, no bones.
        float px = s * 0.048;
        float py = 0.030;
        float pz = 0.030;
        // Flap: downstroke fast and deep, upstroke slow and shallow, tip
        // lagging the arm — a plain sine reads as a wind-up toy.
        float ph = uTreeBirdTime * aPose.y * 6.2831853 + aPose.x - w * 1.1;
        float sn = sin( ph );
        float beat = ( sn > 0.0 ? sn * sn : -abs( sn ) * 0.58 ) * aPose.z;
        float ang = beat * ( 0.40 + 0.72 * w );
        float ca = cos( ang ), sa = sin( ang );
        float rx = transformed.x - px, ry = transformed.y - py;
        transformed.x = px + rx * ca - ry * sa * s;
        transformed.y = py + rx * sa * s + ry * ca;
        // Fold — ONE turn, not two.
        //
        // Work in the mirrored frame ( X outboard on either wing, Y up, Z
        // forward ). A closed wing is a single rigid picture: the span lies
        // back along the flank, the chord stands on edge with the leading
        // edge uppermost, and the sheet that was flat over the back is now
        // thin across the body. That is
        //     X -> -Z      Z -> +Y      Y -> -X
        // and that map is exactly a 120 degree turn about TB_FOLD_AXIS. Doing
        // it as one rotation is the whole fix. The previous version rolled
        // about Z and THEN swept about Y, and rolling first drags the span
        // itself downward: on the owl the wing tip left the shoulder at
        // y +0.05 and arrived at y -0.26, three times the body's own depth
        // below the feet. Every bird here was wearing a floor-length cape;
        // the eagle, with the longest span, wore the worst one.
        //
        // Before the turn the panel closes on itself the way a real wing
        // does: the hand shuts back over the forearm and the feathers stack,
        // so BOTH the span and the chord shrink toward the tip. Chord as well
        // as span is the part the old code missed — a chord carried through
        // at full width and then stood on edge is taller than the bird.
        float fold = aPose.w;
        if ( fold > 0.001 ) {
          vec3 v = vec3( s * transformed.x - 0.048, transformed.y - py,
                         transformed.z - pz );
          v.x *= 1.0 - 0.58 * fold * w;
          // The chord closes hard at the ROOT too, not only at the tip: the
          // root chord is the widest part of the wing and it sits well forward
          // of the shoulder, so a root carried through at full chord swings
          // its leading edge up over the bird's own back as a strap.
          v.z *= 1.0 - 0.66 * fold * ( 0.55 + 0.45 * w );
          // Graded on the spanwise fraction so the shoulder end blends into
          // the flank instead of hinging - but graded to SATURATE early, and
          // that matters more than it looks. Halfway round this turn the span
          // is pointing up and outward, so a wing graded smoothly from root to
          // tip parks its own middle out to the side like a flipper. Reaching
          // the full turn by about half the span keeps the outer wing, which
          // is all of the visible one, in the folded picture; only the short
          // inner run interpolates, and it is buried in the flank anyway.
          float fa = fold * min( 1.0, 0.02 + 1.85 * w ) * 2.0943951;
          float cf = cos( fa ), sf = sin( fa );
          v = v * cf + cross( TB_FOLD_AXIS, v ) * sf
            + TB_FOLD_AXIS * dot( TB_FOLD_AXIS, v ) * ( 1.0 - cf );
          // Lay the closed panel ON the flank rather than through it. The turn
          // alone lands it inboard of the shoulder by the wing's own camber,
          // because thickness maps to -X; this puts it back outside. Squared
          // in the span fraction so the root, which has not turned, does not
          // get pushed off the shoulder.
          v.x += 0.030 * fold * w * w;
          // ...and settle it. The shoulder the turn happens about is the joint,
          // which sits above the plane the wing sheet is authored in, so the
          // stood-up chord lands with its leading edge riding a millimetre or
          // two proud of the bird's own back — from behind that shows as a
          // strap slung across the spine. Dropping the closed panel by this
          // much tucks the leading edge under the back line and lets the
          // trailing edge hang just below the belly, which is where folded
          // primaries actually sit.
          v.y -= 0.018 * fold * w;
          transformed = vec3( s * ( 0.048 + v.x ), py + v.y, pz + v.z );
        }
      }`
    );
  };
  mat.customProgramCacheKey = () => 'treeBirdPose';
  return mat;
}
