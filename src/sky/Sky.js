// ─────────────────────────────────────────────────────────────────────────────
//  Sky — an art-directed gradient dome with a physically-motivated sun,
//  Mie forward-scatter halo and horizon haze. Tuned for golden hour.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { PALETTE } from '../world/WorldConfig.js';

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w;   // always at the far plane
}`;

const FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;

uniform vec3  uSunDir;
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uGround;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform float uTurbidity;
uniform float uTime;
uniform float uExposure;

float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
vec2 hash22(vec2 p){
  p = vec2(dot(p, vec2(127.1,311.7)), dot(p, vec2(269.5,183.3)));
  return fract(sin(p) * 43758.5453) * 2.0 - 1.0;
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(dot(hash22(i+vec2(0,0)), f-vec2(0,0)), dot(hash22(i+vec2(1,0)), f-vec2(1,0)), u.x),
             mix(dot(hash22(i+vec2(0,1)), f-vec2(0,1)), dot(hash22(i+vec2(1,1)), f-vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){
  float a=0.5, s=0.0, n=0.0;
  for(int i=0;i<6;i++){ s += a*vnoise(p); n += a; a*=0.5; p*=2.13; }
  return s/n;
}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;

  // ── base gradient: horizon cream -> zenith blue, with a soft below-horizon
  float t = pow(clamp(h * 0.5 + 0.5, 0.0, 1.0), 0.62);
  float horizonBand = pow(1.0 - clamp(abs(h), 0.0, 1.0), 3.2);
  vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, t));
  col = mix(col, uHorizon, horizonBand * 0.85);
  col = mix(col, uGround, smoothstep(0.02, -0.14, h));

  // ── sun scattering ───────────────────────────────────────────────────────
  float cosT = dot(dir, uSunDir);
  // Mie forward scattering (Henyey–Greenstein)
  float g = 0.76;
  float hg = (1.0 - g*g) / pow(1.0 + g*g - 2.0*g*cosT, 1.5);
  vec3 mie = uSunColor * hg * 0.055 * uTurbidity;

  // Broad warm bloom around the sun, hugging the horizon
  float halo = pow(max(cosT, 0.0), 5.0) * 0.55 + pow(max(cosT, 0.0), 48.0) * 1.4;
  col += uSunColor * halo * uSunIntensity * 0.75;
  col += mie * uSunIntensity;

  // Sun disc with a soft limb
  float disc = smoothstep(0.99955, 0.99988, cosT);
  col += uSunColor * disc * 12.0 * uSunIntensity;

  // Warm the whole sky toward the sun azimuth near the horizon
  float azWarm = pow(max(cosT, 0.0), 1.6) * horizonBand;
  col = mix(col, uSunColor * 1.05, azWarm * 0.42);

  // ── thin high cirrus, drifting ───────────────────────────────────────────
  if (h > 0.015) {
    vec2 sp = dir.xz / max(h, 0.02);
    float c = fbm(sp * 0.55 + vec2(uTime * 0.0055, uTime * 0.0021));
    float c2 = fbm(sp * 1.35 - vec2(uTime * 0.0091, 0.0));
    float cloud = smoothstep(0.10, 0.52, c * 0.72 + c2 * 0.38);
    cloud *= smoothstep(0.0, 0.30, h) * (1.0 - smoothstep(0.72, 1.0, h) * 0.5);
    vec3 cloudCol = mix(vec3(1.0, 0.93, 0.86), uSunColor * 1.12, pow(max(cosT,0.0), 2.0));
    col = mix(col, cloudCol, cloud * 0.55);
  }

  // Subtle dithering kills banding in the big smooth gradient.
  float dither = (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col * uExposure + dither, 1.0);
}`;

export class Sky {
  constructor(scene) {
    this.uniforms = {
      uSunDir:       { value: new THREE.Vector3(0.4, 0.35, 0.85).normalize() },
      uZenith:       { value: PALETTE.skyZenith.clone() },
      uHorizon:      { value: PALETTE.skyHorizon.clone() },
      uGround:       { value: PALETTE.fogFar.clone().multiplyScalar(0.85) },
      uSunColor:     { value: PALETTE.sunDisc.clone() },
      uSunIntensity: { value: 1.0 },
      uTurbidity:    { value: 2.4 },
      uTime:         { value: 0 },
      uExposure:     { value: 1.0 },
    };

    const geo = new THREE.SphereGeometry(1, 64, 32);
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
    this.uniforms.uTime.value = elapsed;
    if (sunDir) this.uniforms.uSunDir.value.copy(sunDir);
    this.mesh.position.copy(camera.position);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.scene.remove(this.mesh);
  }
}
