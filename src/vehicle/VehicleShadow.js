// ─────────────────────────────────────────────────────────────────────────────
//  VehicleShadow — the contact occlusion under the camper.
//
//  WHY THIS EXISTS, AND WHAT IT IS NOT
//
//  It is not a fake cast shadow. The sun's shadow map casts the camper
//  perfectly well when the shadow camera is sane, and a second, hand-drawn
//  directional lobe would fight it the moment it is. This term is *ambient*
//  occlusion: the sky and the ground bounce cannot reach the strip of meadow
//  the camper is parked on, and no shadow map in the game models that. It is
//  the reason a vehicle in the reference plates reads as resting on the grass
//  rather than hovering a hand's width over it — the darkening is directly
//  under the tyres, in every light, at every hour, including noon and overcast
//  when the sun shadow is nearly underneath the body and contributes nothing to
//  the read.
//
//  Because it is occlusion and not a shadow, it has no direction, does not move
//  with the sun, and layers correctly with the real cast shadow.
//
//  Shape: a soft body ellipse plus four tighter wheel lobes, evaluated in the
//  camper's own frame so the pattern stays glued to the vehicle instead of
//  swimming across the grid. The grid itself samples `world.getHeight` so the
//  patch follows the ground it lies on — a flat quad tilted to the terrain
//  normal floats at the corners on anything but a billiard table, and the whole
//  point of this thing is not to float.
//
//  Colour: NEARLY NEUTRAL, and this is the correction that matters.
//
//  It was authored as a violet tint on the reasoning from brief §2 (CORRECTED
//  AGAIN) that an occluded patch of gold meadow goes high-value violet rather
//  than darker gold. That reasoning is right about the *frame* and wrong about
//  *this term*, because it was written while the sun's cast shadow was missing
//  from every eye-level view — the frustum bug now fixed in Lighting.js — so
//  this patch was the only shading under the camper and it was being asked to
//  do the cast shadow's job as well as its own.
//
//  With the cast shadow back, the ground under the camper is already rotated
//  cool by `stylizeShadowCool()`, and a second violet multiply on top of it
//  compounded: measured at hour 12 on gold meadow the patch came out a
//  saturated cobalt while every other cast shadow in the same frame — the
//  scrub, the rocks, the ridge conifers — sat at a warm olive-brown. It read
//  as a puddle of water under the vehicle, which is the exact failure the
//  brief names ("a shadow that has become saturated blue is a bug", and the
//  Lighting note about a dark shadow reading as water).
//
//  So this term now only *darkens*, with a lean so slight it cannot fight the
//  grade, and it is weak enough to layer under a real cast shadow without
//  doubling it. The hue belongs to the look system; the bite under the tyres
//  belongs here.
//
//  Fog: deliberately NOT `#include <fog_fragment>`. The shared chunk mixes the
//  fragment toward the haze *colour*, which for a multiply mask means mixing
//  toward a value well above 1.0 — i.e. at distance it would start *brightening*
//  the ground it lies on. What aerial perspective should do to a multiply is
//  fade it toward white (no darkening), so it does that explicitly.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp01 } from '../core/MathUtils.js';
import { DIM as CAMPER_DIM } from './CamperModel.js';

// Grid resolution and footprint. 15×15 is 225 height samples a frame, which is
// under a tenth of what the tyre ribbons already cost, and it is fine enough
// that the patch follows the micro-detail of the meadow without faceting.
// (The occlusion itself is evaluated per fragment from an interpolated local
// coordinate, so the grid only has to resolve the *ground*, not the shape.)
//
// The footprint used to be 5 × 8 m for a vehicle that is 1.9 × 4.66 m, and the
// body lobe's feather pushed real darkening out to 2.0 m either side of a
// centreline 0.95 m from the flank. Half the visible patch was outside the
// vehicle. It is now sized to the camper.
const N = 15;
const HALF_X = 1.7;    // metres either side of the camper's centreline
const HALF_Z = 3.1;    // metres fore and aft
const LIFT = 0.055;    // above the sampled surface, same as the tyre ruts

// Where the multiply has faded to nothing. A contact patch is a near-field
// read; past this it is a couple of pixels and only costs the haze contrast.
const FADE_NEAR = 55.0;
const FADE_FAR = 110.0;

const SHADOW_VERT = /* glsl */`
  attribute vec2 aLocal;      // metres in the camper's own frame
  varying vec2 vLocal;
  varying float vDist;
  void main() {
    vLocal = aLocal;
    vec4 world = modelMatrix * vec4( position, 1.0 );
    vDist = length( world.xyz - cameraPosition );
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

const SHADOW_FRAG = /* glsl */`
  uniform vec4 uWheels;       // wheelX, wheelZ, radius, feather
  uniform vec2 uBody;         // body half-extent in x, z
  uniform vec2 uFade;         // metres: full strength, gone
  uniform float uStrength;
  uniform float uWheelLoad;
  uniform vec3 uTint;
  varying vec2 vLocal;
  varying float vDist;

  // Falloff of an axis-aligned ellipse, 1 at the centre, 0 at the rim.
  float lobe( vec2 p, vec2 halfExtent, float feather ) {
    vec2 q = p / max( halfExtent + feather, vec2( 1e-3 ) );
    return 1.0 - smoothstep( 0.08, 1.0, length( q ) );
  }

  void main() {
    // Body: the underside of the shell, wide and soft — and weak. It is the
    // ambient term of an ambient term; all it has to do is stop the tyre lobes
    // reading as four separate smudges.
    float a = lobe( vLocal, uBody, 0.45 ) * 0.30;

    // Wheels: four tighter, darker lobes. This is the part that actually reads
    // as contact — the eye places an object by where its feet meet the ground,
    // and a uniform blob under the whole vehicle does not tell it that.
    vec2 w = abs( vLocal ) - vec2( uWheels.x, uWheels.y );
    float wl = 1.0 - smoothstep( 0.0, uWheels.z + uWheels.w, length( w ) );
    a = max( a, wl * wl * 0.62 * uWheelLoad );

    a *= uStrength * ( 1.0 - smoothstep( uFade.x, uFade.y, vDist ) );
    if ( a < 0.004 ) discard;

    // Multiply. An opaque patch laid over the ground glows once the ground
    // itself falls into shadow, which is the mistake the tyre ruts already
    // documented; a multiply cannot ever be brighter than what it lies on.
    gl_FragColor = vec4( mix( vec3( 1.0 ), uTint, a ), 1.0 );
  }`;

export class VehicleShadow {
  /**
   * @param scene  THREE.Scene
   * @param world  WorldData (for getHeight)
   */
  // `dims` is the DIM of whichever car is being driven (vehicle_models.js).
  // The lobes below are sized off it, so a second car with a different body
  // gets a patch that fits it rather than the camper's.
  constructor(scene, world, dims = CAMPER_DIM) {
    const DIM = dims;
    this.world = world;
    this.enabled = true;

    const verts = N * N;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    const local = new Float32Array(verts * 2);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        local[k * 2] = (i / (N - 1) * 2 - 1) * HALF_X;
        local[k * 2 + 1] = (j / (N - 1) * 2 - 1) * HALF_Z;
      }
    }
    g.setAttribute('position', this.pos);
    g.setAttribute('aLocal', new THREE.BufferAttribute(local, 2));
    const idx = [];
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i;
        idx.push(a, a + N, a + N + 1, a, a + N + 1, a + 1);
      }
    }
    g.setIndex(idx);
    this.geometry = g;

    this._dims = DIM;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        // Radius and feather now reach 0.76 m around a 0.44 m tyre rather than
        // 1.18 m — a halo nearly three tyre-widths across was most of what made
        // the patch read as standing water.
        uWheels: {
          value: new THREE.Vector4(DIM.wheelX + (DIM.wheelOut ?? 0), DIM.wheelZ,
            DIM.wheelR * 0.78, 0.42),
        },
        uBody: { value: new THREE.Vector2(DIM.halfWidth * 0.85, (DIM.front - DIM.rear) * 0.40) },
        uFade: { value: new THREE.Vector2(FADE_NEAR, FADE_FAR) },
        uStrength: { value: 1 },
        uWheelLoad: { value: 1 },
        // Very nearly neutral, a hair cool. At the deepest point of the wheel
        // lobe this multiplies the ground by (0.67, 0.67, 0.71) — a third of a
        // stop of darkening with a lean too small to move the hue. See the
        // header: the violet belongs to the cast shadow, which exists again.
        //
        // The first pass of this correction went too far the other way and the
        // term stopped existing: an on/off A/B at hour 12 was indistinguishable
        // (mean abs difference 1.6/255, and all of that on sub-pixel edges from
        // the camper drifting between frames, with no coherent blob anywhere
        // under the vehicle). A multiply laid over ground that is *already* in
        // the camper's own cast shadow has very little absolute room, so it has
        // to be worth drawing in the case that actually needs it — dawn and
        // overcast, where `sun.castShadow` is switched off below 0.35 intensity
        // and this patch is the only thing under the vehicle at all.
        uTint: { value: new THREE.Color(0.46, 0.47, 0.54) },
      },
      vertexShader: SHADOW_VERT,
      fragmentShader: SHADOW_FRAG,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      blendEquation: THREE.AddEquation,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      side: THREE.DoubleSide,
      fog: false,
    });

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'camperContactShadow';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // After the tyre ruts (renderOrder 4) so the two multiply in a stable order.
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  /**
   * @param x,z      camper centre in world space
   * @param heading  yaw, radians (atan2 of the forward vector)
   * @param grounded 0..1, how much of the vehicle is actually on the ground
   */
  update(x, z, heading, grounded) {
    if (!this.enabled) return;
    const s = Math.sin(heading), c = Math.cos(heading);
    const W = this.world;
    const p = this.pos.array;
    // Forward is +Z in the camper's frame, so the local->world rotation is the
    // same convention Vehicle.heading uses (atan2(forward.x, forward.z)).
    for (let j = 0; j < N; j++) {
      const lz = (j / (N - 1) * 2 - 1) * HALF_Z;
      for (let i = 0; i < N; i++) {
        const lx = (i / (N - 1) * 2 - 1) * HALF_X;
        const wx = x + lx * c + lz * s;
        const wz = z - lx * s + lz * c;
        const k = (j * N + i) * 3;
        p[k] = wx;
        p[k + 1] = W.getHeight(wx, wz) + LIFT;
        p[k + 2] = wz;
      }
    }
    this.pos.needsUpdate = true;
    // Off the ground, the occlusion goes with it — a jumping camper that keeps
    // a hard contact patch nailed under it is worse than no patch at all.
    const g = clamp01(grounded);
    this.material.uniforms.uStrength.value = 0.30 + 0.70 * g;
    this.material.uniforms.uWheelLoad.value = g;
    this.mesh.visible = g > 0.02;
  }

  /**
   * Re-size the patch for a different car. The lobes are the only thing in here
   * that knows the body's shape, so swapping vehicles is two uniforms — no
   * geometry is rebuilt and the grid never changes.
   */
  setDims(dims) {
    if (!dims || dims === this._dims) return;
    this._dims = dims;
    this.material.uniforms.uWheels.value.set(dims.wheelX + (dims.wheelOut ?? 0), dims.wheelZ,
      dims.wheelR * 0.78, 0.42);
    this.material.uniforms.uBody.value.set(dims.halfWidth * 0.85, (dims.front - dims.rear) * 0.40);
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
