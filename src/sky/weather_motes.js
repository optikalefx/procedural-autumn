// ─────────────────────────────────────────────────────────────────────────────
//  Motes — pollen, dust and seed fluff catching the low sun.
//
//  Look at plate 1 of the reference: a scatter of pale specks hanging in the
//  air over the meadow. There are maybe forty of them in the whole frame and
//  they are doing an enormous amount of work — they put a *volume* of lit air
//  between the camera and the trees, which is most of why the frame feels like
//  a place rather than a render.
//
//  So: sparse, bright, slow, and above all *few*. A dense field of these reads
//  instantly as a screensaver.
//
//  The whole system is one draw call with zero per-frame CPU work: motes live
//  at fixed positions in a box that is toroidally wrapped around the camera in
//  the vertex shader, so driving forward simply re-uses the ones behind you.
//  The only thing JS updates is a handful of uniforms.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mulberry32 } from '../core/MathUtils.js';
import { fogUniforms } from '../render/Atmosphere.js';

const VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>

attribute vec3 aSeed;    // position inside the unit box
attribute vec4 aRand;    // x size, y drift response, z phase, w kind (0 dust .. 1 fluff)

uniform vec3  uCamPos;
uniform vec3  uBox;      // half-extents of the wrap box, metres
uniform vec3  uDrift;    // integrated wind displacement, metres
uniform float uTime;
uniform float uPixelScale;
uniform vec3  uSunDir;
uniform float uOpacity;

varying float vAlpha;
varying float vGlow;

void main() {
  vec3 base = (aSeed * 2.0 - 1.0) * uBox;

  // Brownian-ish wander. Three detuned sines per axis is enough that no two
  // motes ever visibly share a path, and it costs nothing.
  float ph = aRand.z * 6.2831853;
  vec3 wander = vec3(
    sin(uTime * 0.29 + ph * 3.1),
    sin(uTime * 0.21 + ph * 5.7) * 0.55,
    cos(uTime * 0.25 + ph * 2.3)
  ) * mix(0.55, 1.9, aRand.w);

  // Fluff rides the wind almost perfectly; heavy dust lags behind it.
  vec3 p = base + uDrift * mix(0.55, 1.0, aRand.y) + wander;

  // Toroidal wrap around the camera: the box travels with the player and a
  // mote leaving the back re-enters at the front.
  vec3 rel = mod(p - uCamPos + uBox, uBox * 2.0) - uBox;
  vec3 world = uCamPos + rel;

  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;

  float dist = max(-mv.z, 0.1);
  // Minimum of ~1.3 px: below that a mote flickers on and off as it crosses
  // pixel centres, which is far more noticeable than the mote itself.
  gl_PointSize = clamp(aRand.x * uPixelScale / dist, 1.2, 3.4);

  // Fade at the wrap boundary so nothing ever pops in or out, and fade the
  // very near ones so a mote never smears across the whole screen.
  vec3 e = abs(rel) / uBox;
  float edge = 1.0 - smoothstep(0.72, 0.99, max(e.x, max(e.y, e.z)));
  // The near fade has to clear the depth-of-field near limit, not just avoid a
  // mote filling the screen: anything inside it is rendered as a bokeh disc.
  vAlpha = uOpacity * edge * smoothstep(3.0, 9.0, dist);

  // Forward scattering: a mote is only really visible when it is between you
  // and the sun. This is the entire reason they read as "catching the light"
  // instead of as white dots.
  vec3 vdir = normalize(world - uCamPos);
  float fs = max(dot(vdir, uSunDir), 0.0);
  // The ceiling here is a *bloom* budget, not a brightness preference. The post
  // chain blooms anything over ~0.62 display-referred, and a 4 px point pushed
  // to 1.3 comes back as a 20 px soft white oval — which is what the drift in
  // every wooded frame actually was: not leaves, not dust, just bloom halos
  // around over-bright points. Peaking a shade under the threshold keeps the
  // catch-the-light sparkle and loses the blobs.
  vGlow = 0.18 + 0.42 * pow(fs, 5.0);

  vec3 transformed = world;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>

uniform vec3 uTint;
varying float vAlpha;
varying float vGlow;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  // Soft-shouldered disc. A hard circle at 2 px reads as a square.
  float a = smoothstep(0.50, 0.08, length(d));
  if (a < 0.01) discard;
  gl_FragColor = vec4(uTint * vGlow, a * vAlpha);
  #include <fog_fragment>
}`;

// Half-extents of the wrap box, metres. Tall enough that motes read against
// the sky over a ridge, shallow enough that the density stays believable.
const BOX = [36, 18, 36];

export class Motes {
  constructor(ctx, wind, count) {
    this.ctx = ctx;
    this.wind = wind;
    this.n = count;
    this.drift = new THREE.Vector3();
    this._w = new THREE.Vector3();
  }

  init() {
    const rand = mulberry32(0xd057 ^ this.n);
    const seed = new Float32Array(this.n * 3);
    const rnd = new Float32Array(this.n * 4);
    for (let i = 0; i < this.n; i++) {
      seed[i * 3] = rand();
      // Squared vertical distribution: pollen pools low, where the grass and
      // the ground bounce actually light it, instead of hanging at ridge height.
      seed[i * 3 + 1] = rand() * rand();
      seed[i * 3 + 2] = rand();
      const fluff = rand() < 0.18 ? 1 : 0;
      // Seed fluff is bigger and slower; dust is fine and quick.
      rnd[i * 4] = fluff ? 0.055 + rand() * 0.05 : 0.016 + rand() * 0.022;
      rnd[i * 4 + 1] = 0.35 + rand() * 0.65;
      rnd[i * 4 + 2] = rand();
      rnd[i * 4 + 3] = fluff;
    }

    const geo = new THREE.BufferGeometry();
    // `position` is unused by the shader but three needs it to size the draw.
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.n * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 4));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.uniforms = THREE.UniformsUtils.merge([
      fogUniforms(),
      {
        uCamPos:     { value: new THREE.Vector3() },
        uBox:        { value: new THREE.Vector3(...BOX) },
        uDrift:      { value: new THREE.Vector3() },
        uTime:       { value: 0 },
        uPixelScale: { value: 600 },
        uSunDir:     { value: new THREE.Vector3(0, 1, 0) },
        uTint:       { value: new THREE.Color(0xffeed2) },
        uOpacity:    { value: 0.0 },
      },
    ]);

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
      toneMapped: true,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.name = 'WeatherMotes';
    this.ctx.scene.add(this.points);
  }

  /** @param {number} amount 0..1 overall visibility, from the time of day. */
  update(dt, t, amount) {
    if (!this.points) return;
    const u = this.uniforms;
    const cam = this.ctx.camera;

    // Integrate the wind at the camera rather than per-mote: over a 34 m box
    // the field barely varies, and this keeps the whole system at zero
    // per-particle CPU cost.
    this.wind.windAt(cam.position, t, this._w);
    this.drift.addScaledVector(this._w, dt * 0.35);

    u.uCamPos.value.copy(cam.position);
    u.uDrift.value.copy(this.drift);
    u.uTime.value = t;
    u.uOpacity.value = amount;
    u.uSunDir.value.copy(this.ctx.lighting?.sunDir ?? u.uSunDir.value);

    // Point size must track the actual framebuffer, or motes double in size
    // the moment anyone resizes the window or changes fov.
    const h = this.ctx.renderer.domElement.height;
    u.uPixelScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5));

    this.points.visible = amount > 0.004;
  }

  dispose() {
    if (!this.points) return;
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.ctx.scene.remove(this.points);
    this.points = null;
  }
}
