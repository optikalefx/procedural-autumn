// ─────────────────────────────────────────────────────────────────────────────
//  Waterfalls — falling sheet, spray, mist and plunge pool.
//
//  Every fall is built once as a *path*: a chain of points from lip to pool,
//  integrated with real gravity and clamped to the rock. That is what makes a
//  cliff read as a free-falling curtain and a 12° chute read as a cascade
//  hugging the stone, from the same code. The path is baked into a small float
//  texture so the sheet mesh, the spray particles and the mist all sample the
//  identical curve — spray that drifts off the sheet is the classic tell.
//
//  Advection is done in "time of flight": each point on the sheet knows how
//  many seconds ago the water there left the lip, so `flightTime - now` is
//  constant along a parcel's trajectory. Scrolling that coordinate gives flow
//  that accelerates and stretches exactly like falling water, with no
//  hand-tuned per-fall speeds.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { PALETTE } from './WorldConfig.js';
import { fogUniforms } from '../render/Atmosphere.js';
import { WATER_NOISE, WATER_ENV } from '../shaders/water_common.js';
import { clamp, clamp01, mulberry32 } from '../core/MathUtils.js';

const PATH_STEPS = 32;                       // texels along each fall
const SHEET_COLS = [-1, -0.7, -0.38, 0, 0.38, 0.7, 1];

// ── falling sheet ────────────────────────────────────────────────────────────
const SHEET_VERT = /* glsl */`
#include <fog_pars_vertex>
attribute float aU;
attribute float aSide;
attribute float aFlight;   // seconds since this water left the lip
attribute float aWidth;
attribute float aDisc;
attribute vec3  aNrm;

uniform float uTime;

varying vec3  vWPos;
varying vec3  vNrm;
varying float vU;
varying float vSide;
varying float vFlight;
varying float vWidth;
varying float vDisc;

void main() {
  vec3 transformed = position;
  vWPos = transformed;
  vNrm = aNrm;
  vU = aU; vSide = aSide; vFlight = aFlight; vWidth = aWidth; vDisc = aDisc;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  #include <fog_vertex>
}`;

const SHEET_FRAG = /* glsl */`
#include <fog_pars_fragment>
precision highp float;

uniform float uTime;
uniform vec3  uSunLight;
uniform vec3  uFoam;
uniform vec3  uShallow;

varying vec3  vWPos;
varying vec3  vNrm;
varying float vU;
varying float vSide;
varying float vFlight;
varying float vWidth;
varying float vDisc;

${WATER_NOISE}
${WATER_ENV}

const float PI = 3.14159265;

void main() {
  // Advection coordinate: constant along a falling parcel. Because flight time
  // compresses near the lip and spreads out below, the streaks automatically
  // stretch as the water accelerates.
  float ph = (vFlight - uTime) * 3.4;
  vec2 sp = vec2(vSide * vWidth * 1.15, ph);

  float streak = wFbm3(sp * vec2(1.5, 0.55)) * 0.5 + 0.5;
  float fine   = wFbm2(sp * vec2(4.5, 1.7) + 11.0) * 0.5 + 0.5;

  // The sheet is coherent at the lip and shreds into ribbons as it falls.
  float shred = smoothstep(0.10, 0.80, vU);
  float body = mix(1.0, smoothstep(0.34, 0.60, streak), shred * 0.92);
  body = max(body, smoothstep(0.55, 0.72, fine) * shred * 0.55);

  // Edges tear before the middle does.
  float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
  edge = mix(edge, edge * smoothstep(0.30, 0.62, streak), shred);

  float alpha = body * edge * (0.34 + 0.66 * vDisc);
  // Let go just before the pool so the sheet never clips through the foam.
  alpha *= 1.0 - smoothstep(0.93, 1.0, vU);
  alpha = clamp(alpha, 0.0, 1.0);
  if (alpha < 0.015) discard;

  vec3 V = normalize(cameraPosition - vWPos);
  vec3 N = normalize(vNrm);
  if (dot(N, V) < 0.0) N = -N;

  float shadow = wSunShadow(vWPos);
  float ndl = max(dot(N, uSunDir), 0.0);

  // Glassy and blue at the lip where the sheet is unbroken, white where the
  // water has aerated. Aeration is what turns water into foam, not speed.
  vec3 tint = mix(uShallow, uFoam, smoothstep(0.0, 0.35, vU) * 0.85 + 0.15);
  vec3 col = tint * (uSunLight * (0.30 + 0.55 * ndl) * shadow + uAmbient * 0.85) / PI * 2.2;

  // Backlight: a curtain of white water in front of a low sun glows.
  float back = pow(max(dot(-V, uSunDir), 0.0), 2.0);
  col += uFoam * uSunLight * back * 0.30 * shadow * (0.4 + 0.6 * vU);

  // A hard specular sliver on the unbroken lip reads as glass.
  vec3 H = normalize(uSunDir + V);
  col += uSunLight * pow(max(dot(N, H), 0.0), 60.0) * (1.0 - shred) * 0.5 * shadow;

  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ── spray / streak particles ─────────────────────────────────────────────────
const SPRAY_VERT = /* glsl */`
#include <fog_pars_vertex>
attribute vec3  aSideDir;
attribute vec3  aOutward;
attribute float aRow;      // v coordinate into the path texture
attribute float aPhase;
attribute float aRate;
attribute float aU0;
attribute float aSideOff;
attribute float aSize;
attribute float aSpread;
attribute float aSeed;

uniform sampler2D uPathTex;
uniform float uTime;
uniform float uCullDist;
uniform float uPathStep;   // 1 / PATH_STEPS

varying vec2  vUv;
varying float vFade;
varying float vSeed;

void main() {
  float f = fract(aPhase + uTime * aRate);
  float u = mix(aU0, 1.0, f);

  vec4 pathA = texture2D(uPathTex, vec2(u * (1.0 - uPathStep) + uPathStep * 0.5, aRow));
  vec3 p = pathA.xyz;
  float w = pathA.w;

  // Wander across the sheet, widening as the fall breaks up.
  float wob = sin(aSeed * 31.0 + u * 9.0) * 0.5 + sin(aSeed * 17.0 + u * 21.0) * 0.5;
  p += aSideDir * (aSideOff * w * (0.5 + u) + wob * aSpread * u);

  // The last quarter is the burst off the plunge pool: outward and up.
  float b = smoothstep(0.70, 1.0, u);
  p += aOutward * b * b * aSpread * 2.2;
  p.y += b * (1.0 - b) * 4.0 * aSpread;

  float size = aSize * (0.35 + 1.5 * u);
  vFade = smoothstep(0.0, 0.10, f) * (1.0 - smoothstep(0.72, 1.0, f));
  vSeed = aSeed;
  vUv = uv;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  if (-mv.z > uCullDist) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // Streaks are taller than wide — falling water is a line, not a dot.
  mv.xy += vec2(position.x * size * 0.55, position.y * size * (1.0 + u * 1.6));

  vec3 transformed = p;
  gl_Position = projectionMatrix * mv;
  #include <fog_vertex>
}`;

const SPRAY_FRAG = /* glsl */`
#include <fog_pars_fragment>
precision highp float;
uniform vec3  uSunLight;
uniform vec3  uFoam;
uniform vec3  uSunDir;
uniform vec3  uAmbient;
varying vec2  vUv;
varying float vFade;
varying float vSeed;

const float PI = 3.14159265;

void main() {
  vec2 d = vUv * 2.0 - 1.0;
  float r = length(vec2(d.x, d.y * 0.7));
  float a = (1.0 - smoothstep(0.25, 1.0, r)) * vFade;
  if (a < 0.01) discard;
  vec3 col = uFoam * (uSunLight * 0.55 + uAmbient * 0.8) / PI * 2.4;
  gl_FragColor = vec4(col, a * 0.55);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ── mist volume ──────────────────────────────────────────────────────────────
const MIST_VERT = /* glsl */`
#include <fog_pars_vertex>
attribute vec3  aCentre;
attribute float aPhase;
attribute float aRate;
attribute float aSize;
attribute float aRise;
attribute vec3  aDrift;
attribute float aSeed;

uniform float uTime;
uniform float uCullDist;

varying vec2  vUv;
varying float vFade;
varying float vSeed;
varying vec3  vWPos;

void main() {
  float f = fract(aPhase + uTime * aRate);
  vec3 p = aCentre + aDrift * f + vec3(0.0, aRise * f, 0.0);
  float size = aSize * (0.55 + 0.8 * f);
  // In and out slowly — mist has no edges, only densities.
  vFade = smoothstep(0.0, 0.35, f) * (1.0 - smoothstep(0.55, 1.0, f));
  vSeed = aSeed;
  vUv = uv;
  vWPos = p;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  if (-mv.z > uCullDist) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float s = sin(aSeed * 6.28), c = cos(aSeed * 6.28);
  vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
  mv.xy += q * size;

  vec3 transformed = p;
  gl_Position = projectionMatrix * mv;
  #include <fog_vertex>
}`;

const MIST_FRAG = /* glsl */`
#include <fog_pars_fragment>
precision highp float;

uniform vec3  uSunLight;
uniform vec3  uSunDir;
uniform vec3  uAmbient;
uniform vec3  uFoam;
uniform float uRainbow;

varying vec2  vUv;
varying float vFade;
varying float vSeed;
varying vec3  vWPos;

const float PI = 3.14159265;

// Cheap spectral ramp: 0 = violet, 1 = red.
vec3 spectrum(float t){
  t = clamp(t, 0.0, 1.0);
  return clamp(vec3(
    smoothstep(0.42, 0.86, t),
    sin(clamp(t, 0.0, 1.0) * PI) * 0.95,
    1.0 - smoothstep(0.16, 0.58, t)), 0.0, 1.0);
}

void main() {
  vec2 d = vUv * 2.0 - 1.0;
  float r = length(d);
  // Soft, fat falloff — a mist puff with a visible rim is a sprite, not fog.
  float a = pow(1.0 - smoothstep(0.0, 1.0, r), 2.2) * vFade;
  if (a < 0.004) discard;

  vec3 V = normalize(vWPos - cameraPosition);

  // Backlit mist is the whole reason this exists: forward scattering makes a
  // plume in front of a low sun glow far brighter than its albedo.
  float fwd = max(dot(V, uSunDir), 0.0);
  float glow = pow(fwd, 3.5) * 1.5 + pow(fwd, 12.0) * 2.4;
  vec3 col = uFoam * (uAmbient * 0.9 + uSunLight * (0.22 + glow)) / PI * 2.0;

  // Primary bow, 42° off the antisolar point. It shows up when the sun is
  // behind the camera, which is exactly when a real one would.
  float deg = degrees(acos(clamp(dot(V, -uSunDir), -1.0, 1.0)));
  float t = (deg - 40.2) / 2.4;
  float band = smoothstep(0.0, 0.18, t) * (1.0 - smoothstep(0.80, 1.0, t));
  col += spectrum(t) * band * uRainbow * uSunLight * 0.65;

  // Forward-scatter iridescence: the faint colour fringe you get looking
  // straight through spray toward a low sun.
  float fdeg = degrees(acos(clamp(fwd, -1.0, 1.0)));
  float ft = (fdeg - 3.0) / 7.0;
  col += spectrum(1.0 - ft) * smoothstep(0.0, 0.25, ft) * (1.0 - smoothstep(0.7, 1.0, ft))
       * uRainbow * uSunLight * 0.22;

  gl_FragColor = vec4(col, a * 0.30);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ── plunge pool ──────────────────────────────────────────────────────────────
const POOL_VERT = /* glsl */`
#include <fog_pars_vertex>
attribute vec2  aLocal;    // metres from the impact point
attribute float aRadius;
attribute float aPower;
varying vec3  vWPos;
varying vec2  vLocal;
varying float vRadius;
varying float vPower;
void main() {
  vec3 transformed = position;
  vWPos = transformed; vLocal = aLocal; vRadius = aRadius; vPower = aPower;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  #include <fog_vertex>
}`;

const POOL_FRAG = /* glsl */`
#include <fog_pars_fragment>
precision highp float;
uniform float uTime;
uniform vec3  uSunLight;
uniform vec3  uFoam;
uniform vec3  uShallow;
varying vec3  vWPos;
varying vec2  vLocal;
varying float vRadius;
varying float vPower;

${WATER_NOISE}
${WATER_ENV}

const float PI = 3.14159265;

void main() {
  vec4 D = wWorldData(vWPos.xz);
  if (vWPos.y - D.r < 0.02) discard;      // never paint foam onto dry rock

  float r = length(vLocal) / max(vRadius, 0.5);
  if (r > 1.0) discard;

  // Foam rides outward from the impact on expanding rings, breaking up as it
  // goes — the churn is strongest where the water lands and dies at the rim.
  float ring = sin(r * 14.0 - uTime * 2.1) * 0.5 + 0.5;
  vec2 sp = vLocal * 0.55 - normalize(vLocal + 1e-4) * uTime * 1.4;
  float n = wFbm3(sp) * 0.5 + 0.5;
  float churn = n * 0.7 + ring * 0.3;

  float density = (1.0 - smoothstep(0.0, 1.0, r)) * vPower;
  float cut = 0.68 - density * 0.55;
  float foam = smoothstep(cut, cut + 0.14, churn) * smoothstep(1.0, 0.72, r);
  foam = max(foam, (1.0 - smoothstep(0.0, 0.34, r)) * 0.95);

  vec3 col = mix(uShallow, uFoam, foam);
  col *= (uSunLight * 0.42 * wSunShadow(vWPos) + uAmbient * 0.7) / PI * 2.4;

  float alpha = clamp(foam * 1.05, 0.0, 1.0) * smoothstep(1.0, 0.80, r);
  if (alpha < 0.02) discard;

  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Waterfalls extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Waterfalls';
    this.loadLabel = 'Pouring the falls';
    this.group = new THREE.Group();
    this.group.name = 'Waterfalls';
    this._geoms = [];
    this._materials = [];
    this.falls = [];
  }

  async init() {
    const { world, scene, preset } = this.ctx;
    const list = world?.waterfalls;
    if (!list || !list.length) return;

    this.shared = {
      uTime:         { value: 0 },
      uDataTex:      { value: world.dataTexture },
      uWorldSize:    { value: world.worldSize },
      uSunDir:       { value: new THREE.Vector3(0.4, 0.5, 0.3) },
      uSunColor:     { value: new THREE.Color(1, 1, 1) },
      uSunLight:     { value: new THREE.Color(1, 1, 1) },
      uAmbient:      { value: new THREE.Color(0.4, 0.45, 0.55) },
      uSkyZenith:    { value: PALETTE.skyZenith.clone() },
      uSkyHorizon:   { value: PALETTE.skyHorizon.clone() },
      uRefGround:    { value: PALETTE.grassGoldDeep.clone() },
      uRefRock:      { value: PALETTE.rockMid.clone() },
      uSnowLine:     { value: 262.0 },
      uReflectSteps: { value: preset?.reflections ? 8 : 0 },
      uFoam:         { value: PALETTE.waterFoam.clone() },
      uShallow:      { value: PALETTE.waterShallow.clone() },
    };

    this._buildPaths();
    this._buildSheet();
    this._buildSpray();
    this._buildMist();
    this._buildPools();

    scene.add(this.group);
  }

  /**
   * Integrate each fall from lip to pool. Gravity decides how fast the water
   * can drop; the rock decides how fast it actually does. Where the ground
   * falls away faster than free-fall the water leaves the rock and arcs.
   */
  _buildPaths() {
    const world = this.ctx.world;
    const rng = mulberry32(0x77a7e2);
    const G = 9.81;

    for (const wf of world.waterfalls) {
      const top = wf.top, bot = wf.bottom;
      const hor = Math.hypot(bot[0] - top[0], bot[2] - top[2]);
      const H = Math.max(wf.height, 1.0);
      // A big river arrives at the lip moving fast; a trickle dribbles over.
      const v0 = clamp(2.2 + wf.discharge * 7.0, 2.2, 9.0);

      const dirX = hor > 1e-3 ? (bot[0] - top[0]) / hor : 1;
      const dirZ = hor > 1e-3 ? (bot[2] - top[2]) / hor : 0;
      const sideX = -dirZ, sideZ = dirX;

      const pts = [];
      let y = top[1], vy = 0, flight = 0;
      const dsH = hor / (PATH_STEPS - 1);
      const seed = rng();

      for (let i = 0; i < PATH_STEPS; i++) {
        const u = i / (PATH_STEPS - 1);
        // A little lateral meander so no fall is a perfectly straight ribbon.
        const wob = Math.sin(seed * 40 + u * 4.2) * Math.min(2.5, wf.width * 0.35) * u;
        const x = top[0] + dirX * hor * u + sideX * wob;
        const z = top[2] + dirZ * hor * u + sideZ * wob;

        if (i > 0) {
          let dt;
          if (hor > 0.6) {
            dt = dsH / v0;
            vy -= G * dt;
            let yNext = y + vy * dt;
            const ground = world.getHeight(x, z) + 0.35;
            if (yNext < ground) {
              yNext = ground;
              // Landed on rock: the water now slides, so its vertical speed is
              // whatever the slope gives it.
              vy = (yNext - y) / dt;
            }
            y = yNext;
          } else {
            // A clean vertical drop: solve the parabola directly.
            const drop = H * u * u;
            y = top[1] - drop;
            dt = Math.sqrt(Math.max(2 * H / G, 1e-3)) / (PATH_STEPS - 1);
          }
          flight += dt;
        }
        // Never let the path finish above the recorded plunge point.
        if (i === PATH_STEPS - 1) y = Math.min(y, bot[1] + 0.4);

        const w = wf.width * (0.8 + 1.5 * u);
        pts.push({ x, y, z, w, u, flight });
      }

      this.falls.push({
        wf, pts, sideX, sideZ, dirX, dirZ, hor,
        height: H,
        disc: clamp01(wf.discharge),
        width: wf.width,
      });
    }

    // Bake the paths into a float texture so spray and mist ride the same curve.
    const N = this.falls.length;
    const data = new Float32Array(PATH_STEPS * N * 4);
    for (let f = 0; f < N; f++) {
      const pts = this.falls[f].pts;
      for (let i = 0; i < PATH_STEPS; i++) {
        const o = (f * PATH_STEPS + i) * 4;
        data[o] = pts[i].x; data[o + 1] = pts[i].y; data[o + 2] = pts[i].z; data[o + 3] = pts[i].w;
      }
    }
    const tex = new THREE.DataTexture(data, PATH_STEPS, N, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.pathTex = tex;
  }

  // ── sheet ──────────────────────────────────────────────────────────────────
  _buildSheet() {
    const pos = [], u = [], side = [], flight = [], wid = [], disc = [], nrm = [], idx = [];
    let base = 0;
    const C = SHEET_COLS.length;

    for (const f of this.falls) {
      for (let i = 0; i < f.pts.length; i++) {
        const p = f.pts[i];
        const a = f.pts[Math.max(0, i - 1)], b = f.pts[Math.min(f.pts.length - 1, i + 1)];
        // Sheet normal: perpendicular to both the flow direction and the width
        // axis, i.e. facing out of the rock face.
        const tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
        let nx = ty * f.sideZ - tz * 0,
            ny = tz * f.sideX - tx * f.sideZ,
            nz = 0 * tx - ty * f.sideX;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        for (let c = 0; c < C; c++) {
          const off = SHEET_COLS[c] * p.w * 0.5;
          pos.push(p.x + f.sideX * off, p.y, p.z + f.sideZ * off);
          u.push(p.u); side.push(SHEET_COLS[c]); flight.push(p.flight);
          wid.push(p.w); disc.push(f.disc);
          nrm.push(nx, ny, nz);
        }
      }
      for (let i = 0; i < f.pts.length - 1; i++) {
        const a = base + i * C, b = base + (i + 1) * C;
        for (let c = 0; c < C - 1; c++) {
          idx.push(a + c, b + c, a + c + 1);
          idx.push(a + c + 1, b + c, b + c + 1);
        }
      }
      base += f.pts.length * C;
    }
    if (!idx.length) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aU', new THREE.Float32BufferAttribute(u, 1));
    geo.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
    geo.setAttribute('aFlight', new THREE.Float32BufferAttribute(flight, 1));
    geo.setAttribute('aWidth', new THREE.Float32BufferAttribute(wid, 1));
    geo.setAttribute('aDisc', new THREE.Float32BufferAttribute(disc, 1));
    geo.setAttribute('aNrm', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    this._geoms.push(geo);

    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign(fogUniforms(), this.shared),
      vertexShader: SHEET_VERT,
      fragmentShader: SHEET_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this._materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 8;
    mesh.frustumCulled = false;
    mesh.name = 'WaterfallSheets';
    this.group.add(mesh);
  }

  // ── spray ──────────────────────────────────────────────────────────────────
  _buildSpray() {
    const rng = mulberry32(0x5b0a11);
    const N = this.falls.length;
    const rows = [], phase = [], rate = [], u0 = [], sideOff = [], size = [],
          spread = [], seed = [], sideDir = [], outward = [];

    for (let f = 0; f < N; f++) {
      const fl = this.falls[f];
      const count = Math.round(clamp(14 + fl.disc * 110 + fl.height * 1.1, 12, 130));
      const row = (f + 0.5) / N;
      // Time of flight sets the loop rate: a 60 m fall must take much longer
      // to traverse than a 6 m one or the scale reads wrong.
      const tof = Math.max(fl.pts[fl.pts.length - 1].flight, 0.6);
      for (let i = 0; i < count; i++) {
        const burst = rng() < 0.42;
        rows.push(row);
        phase.push(rng());
        rate.push((1 / tof) * (burst ? 1.9 : 1.0) * (0.85 + rng() * 0.3));
        u0.push(burst ? 0.55 + rng() * 0.25 : rng() * 0.30);
        sideOff.push((rng() * 2 - 1) * 0.55);
        size.push((0.22 + rng() * 0.55) * (0.6 + fl.width * 0.12) * (burst ? 1.5 : 1.0));
        spread.push((0.5 + rng() * 1.6) * (0.6 + fl.disc * 2.2));
        seed.push(rng());
        sideDir.push(fl.sideX, 0, fl.sideZ);
        const a = rng() * Math.PI * 2;
        outward.push(Math.cos(a) * 0.8 + fl.dirX * 0.6, 0.15, Math.sin(a) * 0.8 + fl.dirZ * 0.6);
      }
    }
    if (!rows.length) return;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    geo.instanceCount = rows.length;
    const IA = (arr, n) => new THREE.InstancedBufferAttribute(new Float32Array(arr), n);
    geo.setAttribute('aRow', IA(rows, 1));
    geo.setAttribute('aPhase', IA(phase, 1));
    geo.setAttribute('aRate', IA(rate, 1));
    geo.setAttribute('aU0', IA(u0, 1));
    geo.setAttribute('aSideOff', IA(sideOff, 1));
    geo.setAttribute('aSize', IA(size, 1));
    geo.setAttribute('aSpread', IA(spread, 1));
    geo.setAttribute('aSeed', IA(seed, 1));
    geo.setAttribute('aSideDir', IA(sideDir, 3));
    geo.setAttribute('aOutward', IA(outward, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this._geoms.push(geo);

    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign(fogUniforms(), this.shared, {
        uPathTex:  { value: this.pathTex },
        uPathStep: { value: 1 / PATH_STEPS },
        uCullDist: { value: 420 },
      }),
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this._materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 9;
    mesh.frustumCulled = false;
    mesh.name = 'WaterfallSpray';
    this.group.add(mesh);
    this.sprayCount = rows.length;
  }

  // ── mist ───────────────────────────────────────────────────────────────────
  _buildMist() {
    const rng = mulberry32(0x2ee11c);
    const centre = [], phase = [], rate = [], size = [], rise = [], drift = [], seed = [];

    for (const fl of this.falls) {
      const b = fl.pts[fl.pts.length - 1];
      const energy = clamp01(fl.disc * 0.7 + fl.height / 70);
      const count = Math.round(clamp(4 + energy * 16, 4, 20));
      const spread = 3 + energy * 16;
      for (let i = 0; i < count; i++) {
        // Most of the mist boils off the plunge point; a little climbs the
        // lower third of the fall itself.
        const onFall = rng() < 0.3;
        const t = onFall ? 0.62 + rng() * 0.3 : 1.0;
        const p = fl.pts[Math.min(fl.pts.length - 1, Math.round(t * (fl.pts.length - 1)))];
        centre.push(
          p.x + (rng() * 2 - 1) * spread * 0.6,
          p.y + rng() * 2.5,
          p.z + (rng() * 2 - 1) * spread * 0.6
        );
        phase.push(rng());
        rate.push(0.045 + rng() * 0.055);
        size.push((4 + rng() * 9) * (0.6 + energy * 1.5));
        rise.push((3 + rng() * 9) * (0.5 + energy));
        const a = rng() * Math.PI * 2;
        drift.push(Math.cos(a) * spread * 0.5, 0, Math.sin(a) * spread * 0.5);
        seed.push(rng());
      }
    }
    if (!centre.length) return;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    geo.instanceCount = phase.length;
    const IA = (arr, n) => new THREE.InstancedBufferAttribute(new Float32Array(arr), n);
    geo.setAttribute('aCentre', IA(centre, 3));
    geo.setAttribute('aPhase', IA(phase, 1));
    geo.setAttribute('aRate', IA(rate, 1));
    geo.setAttribute('aSize', IA(size, 1));
    geo.setAttribute('aRise', IA(rise, 1));
    geo.setAttribute('aDrift', IA(drift, 3));
    geo.setAttribute('aSeed', IA(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this._geoms.push(geo);

    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign(fogUniforms(), this.shared, {
        uCullDist: { value: 700 },
        uRainbow:  { value: 0.55 },
      }),
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this._materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 11;
    mesh.frustumCulled = false;
    mesh.name = 'WaterfallMist';
    this.group.add(mesh);
    this.mistCount = phase.length;
  }

  // ── plunge pools ───────────────────────────────────────────────────────────
  _buildPools() {
    const world = this.ctx.world;
    const pos = [], local = [], rad = [], pow = [], idx = [];
    let base = 0;
    const RINGS = 3, SEG = 16;

    for (const fl of this.falls) {
      const b = fl.pts[fl.pts.length - 1];
      const surf = world.getWaterHeight(b.x, b.z);
      const y = (surf ?? fl.wf.bottom[1]) + 0.07;
      const radius = clamp(2.2 + Math.sqrt(fl.disc * fl.height) * 2.4, 2.5, 16);
      const power = clamp01(0.45 + fl.disc * 0.7);

      pos.push(b.x, y, b.z); local.push(0, 0); rad.push(radius); pow.push(power);
      for (let r = 1; r <= RINGS; r++) {
        const rr = radius * (r / RINGS);
        for (let s = 0; s < SEG; s++) {
          const a = (s / SEG) * Math.PI * 2;
          const lx = Math.cos(a) * rr, lz = Math.sin(a) * rr;
          pos.push(b.x + lx, y, b.z + lz);
          local.push(lx, lz); rad.push(radius); pow.push(power);
        }
      }
      for (let s = 0; s < SEG; s++) {
        idx.push(base, base + 1 + s, base + 1 + ((s + 1) % SEG));
      }
      for (let r = 0; r < RINGS - 1; r++) {
        const a0 = base + 1 + r * SEG, a1 = a0 + SEG;
        for (let s = 0; s < SEG; s++) {
          const n = (s + 1) % SEG;
          idx.push(a0 + s, a1 + s, a0 + n);
          idx.push(a0 + n, a1 + s, a1 + n);
        }
      }
      base += 1 + RINGS * SEG;
    }
    if (!idx.length) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aLocal', new THREE.Float32BufferAttribute(local, 2));
    geo.setAttribute('aRadius', new THREE.Float32BufferAttribute(rad, 1));
    geo.setAttribute('aPower', new THREE.Float32BufferAttribute(pow, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    this._geoms.push(geo);

    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign(fogUniforms(), this.shared),
      vertexShader: POOL_VERT,
      fragmentShader: POOL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this._materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 7;
    mesh.name = 'PlungePools';
    this.group.add(mesh);
  }

  // ── per frame ──────────────────────────────────────────────────────────────
  update(dt, elapsed) {
    const u = this.shared;
    if (!u) return;
    const { lighting, sky } = this.ctx;
    u.uTime.value = elapsed;

    const sun = lighting?.sun;
    if (sun) {
      u.uSunColor.value.copy(sun.color);
      u.uSunLight.value.copy(sun.color).multiplyScalar(sun.intensity);
    }
    if (lighting?.sunDir) u.uSunDir.value.copy(lighting.sunDir);
    const hemi = lighting?.hemi;
    if (hemi) {
      u.uAmbient.value.copy(hemi.groundColor).lerp(hemi.color, 0.78)
        .multiplyScalar(hemi.intensity);
    }
    const su = sky?.uniforms;
    const zen = su?.uZenith?.value ?? su?.uSkyZenith?.value;
    const hor = su?.uHorizon?.value ?? su?.uSkyHorizon?.value;
    if (zen?.isColor) u.uSkyZenith.value.copy(zen);
    if (hor?.isColor) u.uSkyHorizon.value.copy(hor);
    void dt;
  }

  dispose() {
    for (const g of this._geoms) g.dispose();
    for (const m of this._materials) m.dispose();
    this.pathTex?.dispose();
    this.ctx.scene?.remove(this.group);
  }
}
