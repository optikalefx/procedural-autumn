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
//  Colour: a *tint*, not a neutral. Brief §2, CORRECTED AGAIN — an occluded
//  patch of gold meadow goes high-value violet, not darker gold. The multiply
//  target attenuates red hardest and blue least, so the darkened ground rotates
//  toward periwinkle as it drops in value instead of going to mud.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { fogUniforms } from '../render/Atmosphere.js';
import { clamp01 } from '../core/MathUtils.js';
import { DIM } from './CamperModel.js';

// Grid resolution and footprint. 15×15 is 225 height samples a frame, which is
// under a tenth of what the tyre ribbons already cost, and it is fine enough
// that a 4 m patch follows the micro-detail of the meadow without faceting.
const N = 15;
const HALF_X = 2.5;    // metres either side of the camper's centreline
const HALF_Z = 4.0;    // metres fore and aft
const LIFT = 0.055;    // above the sampled surface, same as the tyre ruts

const SHADOW_VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  attribute vec2 aLocal;      // metres in the camper's own frame
  varying vec2 vLocal;
  void main() {
    vLocal = aLocal;
    vec3 transformed = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    #include <fog_vertex>
  }`;

const SHADOW_FRAG = /* glsl */`
  #include <common>
  #include <fog_pars_fragment>
  uniform vec4 uWheels;       // xz half-spacing: wheelX, wheelZ, radius, feather
  uniform vec2 uBody;         // body half-extent in x, z
  uniform float uStrength;
  uniform float uWheelLoad;
  uniform vec3 uTint;
  varying vec2 vLocal;

  // Squared-distance falloff of an axis-aligned ellipse, 1 at the centre.
  float lobe( vec2 p, vec2 halfExtent, float feather ) {
    vec2 q = p / max( halfExtent + feather, vec2( 1e-3 ) );
    return 1.0 - smoothstep( 0.08, 1.0, length( q ) );
  }

  void main() {
    // Body: the underside of the shell, wide and soft.
    float a = lobe( vLocal, uBody, 1.15 ) * 0.38;

    // Wheels: four tighter, darker lobes. This is the part that actually reads
    // as contact — the eye places an object by where its feet meet the ground,
    // and a uniform blob under the whole vehicle does not tell it that.
    vec2 w = abs( vLocal ) - vec2( uWheels.x, uWheels.y );
    float wl = 1.0 - smoothstep( 0.0, uWheels.z + uWheels.w, length( w ) );
    a = max( a, wl * wl * 0.70 * uWheelLoad );

    a *= uStrength;
    if ( a < 0.004 ) discard;

    // Multiply. An opaque patch laid over the ground glows once the ground
    // itself falls into shadow, which is the mistake the tyre ruts already
    // documented; a multiply cannot ever be brighter than what it lies on.
    gl_FragColor = vec4( mix( vec3( 1.0 ), uTint, a ), 1.0 );
    // Distance fades a multiply toward the haze, i.e. toward no darkening —
    // which is what aerial perspective should do to a contact shadow anyway.
    #include <fog_fragment>
  }`;

export class VehicleShadow {
  /**
   * @param scene  THREE.Scene
   * @param world  WorldData (for getHeight)
   */
  constructor(scene, world) {
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

    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([fogUniforms(), {
        uWheels: { value: new THREE.Vector4(DIM.wheelX, DIM.wheelZ, DIM.wheelR * 0.92, 0.78) },
        uBody: { value: new THREE.Vector2(DIM.halfWidth * 0.92, (DIM.front - DIM.rear) * 0.44) },
        uStrength: { value: 1 },
        uWheelLoad: { value: 1 },
        // Attenuates red hardest, blue least: gold meadow rotates toward
        // periwinkle as it darkens. Never below ~0.4 — a contact shadow in the
        // reference is a high-value mass, and the brief is explicit that a
        // shadow which has gone to black (or to saturated blue) is a bug.
        uTint: { value: new THREE.Color(0.56, 0.55, 0.67) },
      }]),
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
      fog: true,
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
    this.material.uniforms.uStrength.value = 0.35 + 0.65 * g;
    this.material.uniforms.uWheelLoad.value = g;
    this.mesh.visible = g > 0.02;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
