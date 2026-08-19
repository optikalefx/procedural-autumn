// ─────────────────────────────────────────────────────────────────────────────
//  LightShafts — god rays through the canopy, done as geometry.
//
//  The post chain belongs to another author, so this cannot be a radial blur
//  pass, and that turns out to be the better answer anyway: a screen-space
//  god-ray filter smears the *whole* frame toward the sun and needs the sun on
//  screen. What golden hour in a wood actually looks like is a small number of
//  discrete beams, anchored to the gaps between specific crowns, that slide
//  past each other as you drive — and that only works if they are real objects
//  standing in the world.
//
//  Each shaft is one quad billboarded about the sun axis: it rotates around
//  the beam to face the camera but never rotates *off* the light direction, so
//  it always reads as a solid column of lit air rather than as a card.
//
//  Two deliberate departures from the shared contract, both because a shaft is
//  emissive rather than reflective:
//   · additive blending, so a beam brightens what it crosses;
//   · no `fog_fragment` — mixing an additive beam toward the haze colour makes
//     it *brighter* with distance, which is backwards. Distance attenuation is
//     done explicitly below instead.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mulberry32 } from '../core/MathUtils.js';

const VERT = /* glsl */`
attribute vec3 aOrigin;
attribute vec4 aParams;   // x halfWidth, y length, z intensity, w phase

uniform vec3  uCamPos;
uniform vec3  uSunDir;    // toward the sun
uniform float uTime;
uniform float uFar;

varying vec2  vUv;
varying float vFade;

void main() {
  // position.x in [-0.5, 0.5] across the beam, position.y in [0,1] along it.
  vUv = vec2(position.x + 0.5, position.y);

  vec3 axis = -uSunDir;                    // the way the light is travelling
  vec3 toCam = uCamPos - aOrigin;
  float dist = length(toCam);
  vec3 view = toCam / max(dist, 1e-3);

  // Billboard about the beam axis only.
  vec3 side = cross(axis, view);
  float sl = length(side);
  // Looking straight down the beam there is no stable side vector; collapse
  // the quad instead of letting it snap to an arbitrary orientation.
  side = sl > 1e-3 ? side / sl : vec3(0.0);

  // Beams spread as they travel, and breathe slowly so the wood never looks
  // frozen even when the camera is still.
  float spread = mix(1.0, 2.1, position.y);
  float breathe = 1.0 + 0.10 * sin(uTime * 0.5 + aParams.w * 6.283);
  vec3 world = aOrigin
             + axis * (position.y * aParams.y)
             + side * (position.x * aParams.x * spread * breathe);

  // Forward scattering: a shaft is only visible when it sits between you and
  // the sun. Without this the wood is full of glowing bars from every angle.
  float fs = max(dot(view * -1.0, uSunDir), 0.0);
  float phase = pow(fs, 4.0);

  // Explicit distance attenuation (see the header: no fog chunk here).
  float far = 1.0 - smoothstep(uFar * 0.45, uFar, dist);
  // ...and a near fade, so driving through a beam does not flash the screen.
  float near = smoothstep(3.0, 11.0, dist);

  vFade = aParams.z * phase * far * near * (sl > 1e-3 ? 1.0 : 0.0);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const FRAG = /* glsl */`
precision highp float;
uniform vec3  uColor;
uniform float uOpacity;
varying vec2  vUv;
varying float vFade;

void main() {
  // Soft across the width — a shaft has no edge, it has a falloff.
  float across = vUv.x * 2.0 - 1.0;
  float w = 1.0 - across * across;
  w *= w;
  // Along the beam: brightest just clear of the crown, gone by the far end.
  float along = smoothstep(0.0, 0.16, vUv.y) * (1.0 - smoothstep(0.30, 1.0, vUv.y));
  float a = w * along * vFade * uOpacity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * a, a);
}`;

const FAR = 105;   // metres; past this a shaft is haze, not a beam

export class LightShafts {
  constructor(ctx, near, count) {
    this.ctx = ctx;
    this.near = near;
    this.n = count;
    this.rand = mulberry32(0x5ada ^ count);
    this._timer = 0;
    this._sun = new THREE.Vector3(0, 1, 0);
  }

  init() {
    // Unit quad: x across the beam, y along it.
    const quad = new THREE.PlaneGeometry(1, 1, 1, 1);
    quad.translate(0, 0.5, 0);

    const geo = new THREE.InstancedBufferGeometry();
    // Borrow the quad's buffers rather than disposing it: the InstancedBuffer-
    // Geometry keeps referencing these attribute objects for its whole life.
    geo.setIndex(quad.index);
    geo.setAttribute('position', quad.attributes.position);
    this.aOrigin = new THREE.InstancedBufferAttribute(new Float32Array(this.n * 3), 3);
    this.aParams = new THREE.InstancedBufferAttribute(new Float32Array(this.n * 4), 4);
    this.aOrigin.setUsage(THREE.DynamicDrawUsage);
    this.aParams.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOrigin', this.aOrigin);
    geo.setAttribute('aParams', this.aParams);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.uniforms = {
      uCamPos:  { value: new THREE.Vector3() },
      uSunDir:  { value: new THREE.Vector3(0, 1, 0) },
      uTime:    { value: 0 },
      uFar:     { value: FAR },
      uColor:   { value: new THREE.Color(0xffe3b4) },
      uOpacity: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      // Depth-tested, so a beam is correctly cut off by the hillside it lands
      // on — that occlusion is most of what sells it as a volume.
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,            // pre-multiplied in the shader
      blendDst: THREE.OneFactor,            // additive: a beam only ever adds light
      fog: false,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'WeatherShafts';
    this.ctx.scene.add(this.mesh);
    this.geo = geo;
  }

  /**
   * Re-seat the beams on the current set of nearby crowns.
   *
   * Only trees that sit *toward the sun* from the camera are worth a beam:
   * those are the ones whose canopy gaps you can actually see light through.
   */
  _reseat(cam, sunDir) {
    const near = this.near, T = near.data;
    if (!T) { this.geo.instanceCount = 0; return; }
    const rand = this.rand;
    const oa = this.aOrigin.array, pa = this.aParams.array;
    let n = 0;

    for (let k = 0; k < near.n && n < this.n; k++) {
      const t = near.idx[k];
      const x = T.px[t], y = T.py[t], z = T.pz[t];
      const dx = x - cam.x, dz = z - cam.z;
      const d = Math.hypot(dx, dz);
      if (d < 6 || d > FAR * 0.8) continue;
      // Sun-ward test in plan: the crown must be roughly between the camera
      // and the sun's azimuth.
      if ((dx * sunDir.x + dz * sunDir.z) / d < 0.15) continue;
      // Only a fraction of crowns get a beam; a beam per tree is a light show.
      if (rand() > 0.42) continue;

      const h = T.pImpH[t], w = T.pImpW[t];
      oa[n * 3] = x + (rand() - 0.5) * w * 0.9;
      oa[n * 3 + 1] = y + h * (0.55 + 0.4 * rand());
      oa[n * 3 + 2] = z + (rand() - 0.5) * w * 0.9;
      // Narrow beams from a small gap; wide ones from a break in the stand.
      pa[n * 4] = w * (0.10 + 0.22 * rand());
      pa[n * 4 + 1] = 34 + rand() * 46;
      pa[n * 4 + 2] = 0.45 + 0.55 * rand();
      pa[n * 4 + 3] = rand();
      n++;
    }

    this.geo.instanceCount = n;
    this.aOrigin.needsUpdate = true;
    this.aParams.needsUpdate = true;
    this.count = n;
  }

  /** @param {number} amount 0..1 — golden-hour gate, computed by Weather. */
  update(dt, t, amount) {
    if (!this.mesh) return;
    this.mesh.visible = amount > 0.004;
    if (!this.mesh.visible) { this._timer = 0; return; }

    const cam = this.ctx.camera.position;
    const sun = this.ctx.lighting?.sunDir ?? this._sun;

    // Re-seat on a slow cadence. Beams that jump every frame read as flicker;
    // beams that never move slide off their trees as you drive.
    this._timer -= dt;
    if (this._timer <= 0) { this._reseat(cam, sun); this._timer = 0.8; }

    const u = this.uniforms;
    u.uCamPos.value.copy(cam);
    u.uSunDir.value.copy(sun);
    u.uTime.value = t;
    u.uOpacity.value = amount;
    const lc = this.ctx.lighting?.sun?.color;
    if (lc) u.uColor.value.copy(lc);
  }

  dispose() {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.ctx.scene.remove(this.mesh);
    this.mesh = null;
  }
}
