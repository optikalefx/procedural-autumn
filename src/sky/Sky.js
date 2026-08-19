// ─────────────────────────────────────────────────────────────────────────────
//  Sky — an art-directed gradient dome with a bounded sun aureole.
//
//  The hard constraint here is the post chain: the scene is AgX tone-mapped in
//  the material, then bloom runs on the *display-referred* result with a 0.62
//  luminance threshold. So anything the dome writes above roughly 0.9 linear
//  blooms, and a sky that sits at 1.5 linear blooms *everywhere* and turns the
//  whole upper frame into white paper. That is exactly what the first pass did.
//
//  The rule this shader obeys: the gradient stays under ~0.85 linear, and only
//  the aureole and the ~0.6° disc are allowed over 1.0. Everything else is
//  hue, not headroom.
//
//  All colours come from the shared time-of-day record in Lighting.js.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { PALETTE } from '../world/WorldConfig.js';
import { SKY_STATE } from '../render/Lighting.js';

// A sky is at infinity, so the dome must be a *direction field* and nothing
// else. Dropping the translation column of the model-view (mat3(...)) does
// exactly that: the dome is rigidly attached to the camera's orientation and is
// completely unaffected by where the camera — or the mesh — happens to be.
//
// The obvious alternative, parking the mesh at the camera every frame, is what
// this used to do, and it is a trap. The dome's radius is 1 m, so a positional
// mismatch of Δ metres tilts the whole sky by about Δ radians: 0.3 m of drift
// is 17° of sky. And a mismatch is guaranteed, because CameraRig writes the
// camera pose in *lateUpdate*, after every system has already run — so the mesh
// was always parked at the previous frame's position, plus the camera-shake
// offset, which is why the sky swung about whenever the player drove or dragged
// the mouse. Measured at 22 m/s: one frame of travel displaced the sky ~2400x
// more than that frame's true parallax.
const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = vec4(mat3(modelViewMatrix) * position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w;   // always at the far plane
}`;

const FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;

uniform vec3  uSunDir;
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uSunHorizon;   // horizon colour in the sun's azimuth
uniform vec3  uGround;       // value multiplier applied below the skyline
uniform vec3  uGlow;
uniform vec3  uSunColor;
uniform float uGlowIntensity;
uniform float uDiscIntensity;
uniform float uNight;        // 1 at full night, 0 in daylight
uniform float uTime;

float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;
  float up = clamp(h, 0.0, 1.0);

  // ── base gradient ────────────────────────────────────────────────────────
  // Cream hugs the skyline, blue is well established by ~15°. The canonical
  // camera views only ever see up to about 15° of sky, so the whole gradient
  // has to happen inside that band or the frame reads as one flat cream wash.
  vec3 col = mix(uZenith, uHorizon, pow(1.0 - up, 3.4));
  col = mix(col, uHorizon, pow(1.0 - up, 11.0) * 0.45);
  // Below the skyline: keep the *same* hue and only lose value. A separate
  // ground colour here reads as a flat fake sea in any view that sees past
  // the last ridge, which is most vista shots.
  col = mix(col, col * uGround, smoothstep(0.01, -0.30, h));

  float cosT = dot(dir, uSunDir);
  float c = max(cosT, 0.0);

  // ── the warm wedge ───────────────────────────────────────────────────────
  // Haze scatters sunlight sideways, so the sky *toward* the sun and near the
  // horizon runs warm. Driven off cosT rather than azimuth so it follows the
  // sun up and down without a second set of numbers.
  float wedge = pow(c, 3.0) * pow(1.0 - up, 3.5);
  col = mix(col, uSunHorizon, clamp(wedge * 0.70, 0.0, 0.76));

  // ── aureole ──────────────────────────────────────────────────────────────
  // Three lobes: a ~20° lift, a ~7° glow, and the near-disc flare. Additive
  // but deliberately tight — a broad lobe here pushes the whole upper frame
  // over the bloom threshold and the sky turns to white paper.
  float aureole = pow(c, 14.0) * 0.13 + pow(c, 110.0) * 0.34 + pow(c, 1400.0) * 1.15;
  col += uGlow * aureole * uGlowIntensity;

  // ── sun disc: ~0.6° with a soft limb ─────────────────────────────────────
  float disc = smoothstep(0.99986, 0.99995, cosT);
  col += uSunColor * disc * uDiscIntensity;

  // ── stars, night only ────────────────────────────────────────────────────
  if (uNight > 0.01 && h > 0.0) {
    vec2 sp = floor(dir.xz / max(abs(h) + 0.35, 0.05) * 340.0);
    float r = hash21(sp);
    float star = smoothstep(0.9975, 0.9995, r) * (0.4 + 0.6 * hash21(sp + 7.3));
    // Gentle scintillation; the floor() cell keeps it from crawling.
    star *= 0.65 + 0.35 * sin(uTime * 1.7 + r * 40.0);
    col += vec3(0.85, 0.88, 1.0) * star * uNight * smoothstep(0.0, 0.25, h) * 0.9;
  }

  // Dithering kills banding across a very smooth 4000-pixel-wide gradient.
  float dither = (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(max(col + dither, 0.0), 1.0);
}`;

export class Sky {
  constructor(scene) {
    this.uniforms = {
      uSunDir:        { value: new THREE.Vector3(0.4, 0.35, 0.85).normalize() },
      uZenith:        { value: PALETTE.skyZenith.clone() },
      uHorizon:       { value: PALETTE.skyHorizon.clone() },
      uSunHorizon:    { value: PALETTE.skyHorizon.clone() },
      uGround:        { value: new THREE.Vector3(0.86, 0.87, 0.92) },
      uGlow:          { value: PALETTE.sunDisc.clone() },
      uSunColor:      { value: PALETTE.sunDisc.clone() },
      uGlowIntensity: { value: 1.0 },
      uDiscIntensity: { value: 9.0 },
      uNight:         { value: 0.0 },
      uTime:          { value: 0 },
    };

    const geo = new THREE.SphereGeometry(1, 64, 40);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: true,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'Sky';
    scene.add(this.mesh);
    this.scene = scene;

  }

  update(dt, elapsed, camera, sunDir) {
    const u = this.uniforms;
    const s = SKY_STATE;
    u.uTime.value = elapsed;
    u.uSunDir.value.copy(sunDir ?? s.sunDir);

    u.uZenith.value.copy(s.zenith);
    u.uHorizon.value.copy(s.horizon);
    u.uSunHorizon.value.copy(s.sunHorizon);
    u.uGlow.value.copy(s.glow);
    u.uSunColor.value.copy(s.glow);
    u.uGlowIntensity.value = s.glowIntensity;
    // Below the horizon the disc has to go, or the dome lights up from under
    // the terrain on any downhill view.
    const above = Math.min(Math.max((s.sunElev + 0.01) / 0.03, 0), 1);
    // A setting sun is an ember, not a searing point: extinction near the
    // horizon is what stops the disc punching a hole in the frame.
    const ext = 0.30 + 0.70 * Math.min(Math.max((s.sunElev - 0.0) / 0.28, 0), 1);
    u.uDiscIntensity.value = above * ext * 11.0;
    u.uNight.value = 1.0 - s.dayFactor;


    // Cosmetic only — the dome's *image* no longer depends on this (see VERT),
    // but keeping the mesh near the camera stops it being an outlier in any
    // bounds or sorting pass that walks the scene.
    this.mesh.position.copy(camera.position);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.scene.remove(this.mesh);
  }
}
