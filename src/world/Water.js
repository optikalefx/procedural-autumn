// ─────────────────────────────────────────────────────────────────────────────
//  Water — river ribbons and lake surfaces.
//
//  Two very different characters share one shader library:
//
//    RIVERS  swept ribbons along the baked polylines. Everything the shader
//            needs to make water look like it is *going somewhere* lives in
//            vertex attributes: distance downstream drives the flow scroll, the
//            channel tangent rotates the ripple basis, discharge and surface
//            gradient drive foam. Nothing is a global scroll.
//
//    LAKES   flat tiles, two triangles each, masked per-pixel against the baked
//            heightfield. Calm, near-mirror at grazing angles, gentle wind
//            ripple. The geometry is trivial because the shoreline comes from
//            the terrain, not from the polygon edge.
//
//  The shoreline in both cases is a depth fade computed from the data texture,
//  so the water edge is soft and follows the carved bank rather than reading as
//  a cut polygon against the ground.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { PALETTE, WORLD } from './WorldConfig.js';
import { fogUniforms } from '../render/Atmosphere.js';
import { WATER_NOISE, WATER_ENV } from '../shaders/water_common.js';
import { clamp01 } from '../core/MathUtils.js';

// Cross-channel profile, in half-widths. Denser near the banks where the foam
// and the shoreline fade need the resolution; the outer ±1.5 columns run up the
// bank and are hidden by the terrain, which is what makes the edge crisp.
const COLS = [-1.5, -1.05, -0.72, -0.36, 0, 0.36, 0.72, 1.05, 1.5];
const RIVER_BUCKET = 1024;   // metres; coarse spatial split so culling can work
const LAKE_TILE = 48;        // metres per lake quad

// ── river surface ────────────────────────────────────────────────────────────
const RIVER_VERT = /* glsl */`
#include <fog_pars_vertex>
attribute float aSide;    // -1.5 … 1.5, in half-widths
attribute float aDist;    // metres travelled downstream
attribute float aFlow;    // 0..1 discharge
attribute float aTurb;    // 0..1 whitewater tendency (steep / narrow / fast)
attribute float aWidth;   // channel width, metres
attribute vec2  aTan;     // unit downstream direction in XZ

uniform float uTime;

varying vec3  vWPos;
varying float vSide;
varying float vDist;
varying float vFlow;
varying float vTurb;
varying float vWidth;
varying vec2  vTan;

void main() {
  vec3 transformed = position;

  // A slow swell riding downstream. Kept under ~12 cm: any more and the ribbon
  // pulls away from the bank and breaks the shoreline fade.
  float phase = aDist * 0.42 - uTime * (1.1 + 3.4 * aFlow);
  float swell = sin(phase) * 0.6 + sin(phase * 1.87 + aSide * 2.3) * 0.4;
  transformed.y += swell * (0.025 + 0.085 * aTurb) * (1.0 - abs(aSide) * 0.45);

  vWPos  = transformed;
  vSide  = aSide;
  vDist  = aDist;
  vFlow  = aFlow;
  vTurb  = aTurb;
  vWidth = aWidth;
  vTan   = aTan;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  #include <fog_vertex>
}`;

const RIVER_FRAG = /* glsl */`
#include <fog_pars_fragment>
precision highp float;

uniform float uTime;
uniform vec3  uSunLight;
uniform vec3  uShallow;
uniform vec3  uDeep;
uniform vec3  uFoam;
uniform vec3  uSubsurface;
uniform float uFoamCut;
uniform float uBodyGain;
uniform vec3  uCoolTint;

varying vec3  vWPos;
varying float vSide;
varying float vDist;
varying float vFlow;
varying float vTurb;
varying float vWidth;
varying vec2  vTan;

${WATER_NOISE}
${WATER_ENV}

const float PI = 3.14159265;

void main() {
  vec4 D = wWorldData(vWPos.xz);
  float bed = D.r;
  float depth = vWPos.y - bed;

  // Shoreline: a depth fade, not a polygon edge. The band is wide enough to
  // swallow the ±0.4 m of micro-detail the terrain mesh adds on top of the
  // baked heightfield, so the water never shows a hairline of z-fight.
  float shoreFade = smoothstep(0.0, 0.62, depth);
  float alpha = shoreFade * smoothstep(1.52, 1.34, abs(vSide));
  if (alpha < 0.012) discard;

  // ── flow space: u across the channel, v downstream, both in metres ────────
  vec2 fp = vec2(vSide * vWidth * 0.5, vDist);
  float speed = 0.9 + 4.2 * vFlow + 3.0 * vTurb;

  // Two scales of travelling ripple, analytic gradients so nothing aliases.
  float rough = 0.35 + 0.65 * vTurb;
  vec2 g = vec2(0.0);
  g += wWaveGrad(fp, normalize(vec2( 0.16, 1.0)), 2.10, speed,        uTime, 0.030 * rough);
  g += wWaveGrad(fp, normalize(vec2(-0.28, 1.0)), 3.40, speed * 0.86, uTime, 0.018 * rough);
  g += wWaveGrad(fp, normalize(vec2( 0.85, 0.6)), 6.30, speed * 0.45, uTime, 0.008 * rough);
  g += wWaveGrad(fp, normalize(vec2(-0.90, 0.4)), 9.10, speed * 0.35, uTime, 0.005 * rough);
  // Cross-channel chop that builds against the banks, where the flow shears.
  float bankShear = smoothstep(0.35, 1.15, abs(vSide));
  g += wWaveGrad(fp, vec2(1.0, 0.0), 5.2, 0.7, uTime, 0.012 * bankShear);

  // Rotate the flow-space gradient back into world space.
  vec3 T = normalize(vec3(vTan.x, 0.0, vTan.y));
  vec3 B = vec3(-T.z, 0.0, T.x);
  vec3 N = normalize(vec3(0.0, 1.0, 0.0) - B * g.x - T * g.y);

  vec3 V = normalize(cameraPosition - vWPos);
  if (!gl_FrontFacing) N = -N;

  // ── foam ─────────────────────────────────────────────────────────────────
  // Scrolls downstream with the water, and is stretched along the flow so the
  // marks read as streaks rather than clouds. Thresholded hard: painted shapes,
  // not a soft dirt-map smear.
  vec2 sp = fp * vec2(1.15, 0.30) - vec2(0.0, uTime * speed * 0.30);
  float fn  = wFbm3(sp) * 0.5 + 0.5;
  float fn2 = wFbm2(sp * 2.7 + vec2(3.1, uTime * 0.12)) * 0.5 + 0.5;

  // How far, in metres, is this pixel from dry ground? Depth alone says
  // nothing — a wide shallow flat is not a shoreline, and treating it as one is
  // what turns river margins into big amorphous white blobs.
  float bedAcross = wBed(vWPos.xz + B.xz * 2.0);
  float across = abs(bedAcross - bed) * 0.5;
  float distShore = depth / max(across, 0.055);

  // 1. against the banks — the water piles up and aerates on the edge, but
  //    only within a couple of metres of it
  float bankFoam = smoothstep(0.80, 1.35, abs(vSide)) * (0.15 + 0.55 * vFlow);
  bankFoam *= 1.0 - smoothstep(0.8, 2.6, distShore);

  // 2. over obstacles — a bed rising into fast water is a standing wave. It is
  //    the *rise* that makes whitewater, not shallowness on its own; a calm
  //    ankle-deep run is glass, and treating depth alone as foam is what turns
  //    a whole river white.
  float bedAhead = wBed(vWPos.xz + vTan * (1.5 + vWidth * 0.35));
  float rise = clamp((bedAhead - bed) * 2.6, 0.0, 1.0);
  float obstacle = rise * (0.15 + 0.85 * vFlow) * smoothstep(1.8, 0.35, depth);

  // 3. steep, fast reaches go white all over
  float rapids = smoothstep(0.28, 0.85, vTurb) * (0.35 + 0.65 * vFlow);

  float drive = clamp(bankFoam * 0.75 + obstacle * 0.85 + rapids * 1.15, 0.0, 1.4);
  float cut = uFoamCut - drive * 0.40;
  float foam = smoothstep(cut, cut + 0.10, fn);
  foam = max(foam, smoothstep(cut + 0.12, cut + 0.21, fn2) * 0.7);
  foam *= smoothstep(0.04, 0.16, drive);
  // A crisp lace of foam on the waterline itself — a metre wide, never more.
  float lace = (1.0 - smoothstep(0.25, 1.3, distShore)) * shoreFade;
  foam = max(foam, lace * smoothstep(0.40, 0.56, fn) * 0.85);
  foam = clamp(foam, 0.0, 1.0);

  // ── colour ───────────────────────────────────────────────────────────────
  float deepT = smoothstep(0.25, 3.2, depth);
  vec3 body = mix(uShallow, uDeep, deepT);
  // Shallow water shows the bed through it; a warm bounce keeps the palette
  // from going cold and dead where the river is only ankle-deep.
  body = mix(body, uSubsurface * 1.05, (1.0 - deepT) * 0.35);

  float shadow = wSunShadow(vWPos + vec3(0.0, 0.4, 0.0));
  float ndl = max(dot(N, uSunDir), 0.0);
  // The gain is not a fudge: what we see coming out of a shallow gravel-bed
  // river is light that entered, scattered off the bed and came back up. A
  // plain Lambert term on the surface normal renders that far too dark, and
  // dark water is the fastest way to lose the reference's pale, airy channels.
  vec3 lit = body * (uSunLight * ndl * shadow + uAmbient) / PI * uBodyGain;

  // Fresnel-weighted environment. Rivers are broken up and half-aerated, so
  // they never mirror as hard as a lake does — and letting them try buries the
  // body colour under a sheet of reflected sky at every grazing angle.
  float fres = 0.024 + 0.976 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  fres *= 0.62 * (1.0 - foam * 0.9) * (1.0 - vTurb * 0.45);
  vec3 R = reflect(-V, N);
  vec3 env = wEnvReflect(vWPos, R);
  vec3 col = mix(lit, env * 0.92, clamp(fres, 0.0, 0.42));

  // Specular glints — tight, and killed inside foam so nothing sparkles on
  // what is meant to read as aerated white water.
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), 220.0) * (1.0 - foam);
  col += uSunLight * spec * 0.85 * shadow;

  // Foam is lit almost flat — it is a diffuse mass of bubbles, and flattening
  // it is what makes it read as a painted shape.
  vec3 foamCol = uFoam * (uSunLight * (0.35 + 0.65 * shadow) * 0.30 + uAmbient * 0.55) / PI * 2.3;
  col = mix(col, foamCol, foam * 0.94);

  // A whisper of cool in the whole channel. Water in the reference is never
  // the same hue as the cream sky it sits under, even where it reflects it.
  col *= uCoolTint;

  alpha = mix(alpha, min(1.0, alpha + 0.45), foam);

  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ── lake surface ─────────────────────────────────────────────────────────────
const LAKE_VERT = /* glsl */`
#include <fog_pars_vertex>
varying vec3 vWPos;
void main() {
  vec3 transformed = position;
  vWPos = transformed;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  #include <fog_vertex>
}`;

const LAKE_FRAG = /* glsl */`
#include <fog_pars_fragment>
precision highp float;

uniform float uTime;
uniform vec3  uSunLight;
uniform vec3  uShallow;
uniform vec3  uDeep;
uniform vec3  uFoam;
uniform vec3  uSubsurface;
uniform vec2  uWind;
uniform float uBodyGain;
uniform vec3  uCoolTint;

varying vec3 vWPos;

${WATER_NOISE}
${WATER_ENV}

const float PI = 3.14159265;

void main() {
  vec4 D = wWorldData(vWPos.xz);
  // The baked water channel is -9999 on dry ground; bilinear filtering smears
  // that over one texel, so anything under -400 is "at least a texel outside
  // the lake" and gets cut. The depth fade does the fine edge.
  if (D.g < -400.0) discard;
  float depth = vWPos.y - D.r;
  float shoreFade = smoothstep(0.0, 0.55, depth);
  if (shoreFade < 0.012) discard;

  // ── wind ripple: two crossed scales, very low amplitude ──────────────────
  vec2 p = vWPos.xz;
  vec2 wdir = normalize(uWind + vec2(1e-4));
  float wmag = length(uWind);
  vec2 g = vec2(0.0);
  g += wWaveGrad(p, wdir,                                 0.30, 1.45, uTime, 0.30 * wmag);
  g += wWaveGrad(p, normalize(wdir + vec2( 0.55, -0.35)), 0.72, 1.05, uTime, 0.15 * wmag);
  g += wWaveGrad(p, normalize(wdir + vec2(-0.62,  0.30)), 1.55, 0.72, uTime, 0.060 * wmag);
  g += wWaveGrad(p, normalize(wdir + vec2( 0.20,  0.90)), 3.40, 0.48, uTime, 0.022 * wmag);
  // Sheltered water near the shore is glassier than open water.
  float fetch = 0.35 + 0.65 * smoothstep(0.4, 6.0, depth);
  // Fade the fine scales out with distance or they turn into aliasing crawl at
  // the far end of a kilometre of lake.
  float dist = length(cameraPosition - vWPos);
  g *= fetch * (0.35 + 0.65 * exp(-dist * 0.006));

  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 V = normalize(cameraPosition - vWPos);
  if (!gl_FrontFacing) N = -N;

  float deepT = smoothstep(0.4, 9.0, depth);
  vec3 body = mix(uShallow, uDeep, deepT);
  body = mix(body, uSubsurface, (1.0 - deepT) * 0.30);

  float shadow = wSunShadow(vWPos + vec3(0.0, 0.4, 0.0));
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 lit = body * (uSunLight * ndl * shadow + uAmbient) / PI * uBodyGain;

  // Near-mirror at grazing angles: this is the whole point of a lake.
  float fres = 0.020 + 0.980 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  vec3 R = reflect(-V, N);
  // A real lake at a grazing angle is very nearly a mirror, and rendering that
  // faithfully gives a hole full of cream sky. Water is a coloured medium:
  // tinting the reflection with the body keeps the surface reading as water
  // even when it is mostly showing the sky back at you.
  vec3 env = wEnvReflect(vWPos, R) * mix(vec3(1.0), body * 2.6, 0.30);
  vec3 col = mix(lit, env, clamp(fres * 0.80, 0.0, 0.78));

  // Broad sun path plus a tight glitter, both riding the ripple normal.
  vec3 H = normalize(uSunDir + V);
  float nh = max(dot(N, H), 0.0);
  col += uSunLight * (pow(nh, 900.0) * 1.6 + pow(nh, 90.0) * 0.10) * shadow;

  // A thin lapping line where the water meets the ground. Measured in metres
  // from the shore, not in depth: a shallow shelf is not a beach.
  float foam = 0.0;
  float fn = wFbm3(p * 0.75 + vec2(uTime * 0.05, 0.0)) * 0.5 + 0.5;
  if (depth < 3.0) {
    float bx = wBed(p + vec2(2.0, 0.0)) - wBed(p - vec2(2.0, 0.0));
    float bz = wBed(p + vec2(0.0, 2.0)) - wBed(p - vec2(0.0, 2.0));
    float slope = length(vec2(bx, bz)) * 0.25;
    float distShore = depth / max(slope, 0.05);
    float lace = (1.0 - smoothstep(0.5, 2.4, distShore)) * shoreFade;
    foam = lace * smoothstep(0.42, 0.58, fn);
  }
  vec3 foamCol = uFoam * (uSunLight * shadow * 0.28 + uAmbient * 0.55) / PI * 2.3;
  col = mix(col, foamCol, foam * 0.85);

  col *= uCoolTint;

  float alpha = mix(shoreFade, 1.0, min(deepT * 1.6, 1.0));
  alpha = max(alpha, foam * 0.9);

  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Water extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Water';
    this.loadLabel = 'Filling the rivers';
    this.group = new THREE.Group();
    this.group.name = 'Water';
    this._meshes = [];
    this._materials = [];
    this._tmpC = new THREE.Color();
  }

  async init() {
    const { world, scene, preset } = this.ctx;
    if (!world) return;

    // Uniforms shared by every water material — one object, updated once.
    const reflectSteps = preset?.reflections ? 24 : 0;
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
      uRefGround:    { value: PALETTE.grassGoldDeep.clone().multiplyScalar(0.62) },
      uRefRock:      { value: PALETTE.rockMid.clone().multiplyScalar(0.72) },
      uSnowLine:     { value: 262.0 },
      uReflectSteps: { value: reflectSteps },
      uShallow:      { value: PALETTE.waterShallow.clone() },
      uDeep:         { value: PALETTE.waterDeep.clone() },
      uFoam:         { value: PALETTE.waterFoam.clone() },
      uSubsurface:   { value: PALETTE.waterSubsurface.clone() },
      uBodyGain:     { value: 2.4 },
      uCoolTint:     { value: new THREE.Vector3(0.94, 1.00, 1.05) },
    };

    this.riverMaterial = new THREE.ShaderMaterial({
      uniforms: Object.assign(fogUniforms(), this.shared, {
        uFoamCut: { value: 0.74 },
      }),
      vertexShader: RIVER_VERT,
      fragmentShader: RIVER_FRAG,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      fog: true,
    });

    this.lakeMaterial = new THREE.ShaderMaterial({
      uniforms: Object.assign(fogUniforms(), this.shared, {
        uWind: { value: new THREE.Vector2(0.62, 0.36) },
      }),
      vertexShader: LAKE_VERT,
      fragmentShader: LAKE_FRAG,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      fog: true,
    });
    this._materials.push(this.riverMaterial, this.lakeMaterial);

    this._buildLakes();
    this._buildRivers();

    scene.add(this.group);
  }

  // ── rivers ─────────────────────────────────────────────────────────────────
  _buildRivers() {
    const world = this.ctx.world;
    const polys = world.riverPolylines ?? [];
    const buckets = new Map();

    const bucketOf = (x, z) =>
      (Math.floor((x + world.half) / RIVER_BUCKET) << 4) | Math.floor((z + world.half) / RIVER_BUCKET);

    const getBucket = (k) => {
      let b = buckets.get(k);
      if (!b) {
        b = { pos: [], side: [], dist: [], flow: [], turb: [], wid: [], tan: [], idx: [], n: 0 };
        buckets.set(k, b);
      }
      return b;
    };

    for (const poly of polys) {
      if (!poly || poly.length < 6) continue;

      // ── repair the channel profile ────────────────────────────────────────
      // The baked polylines carry per-point width and discharge sampled off the
      // flow-accumulation grid, and roughly one point in eight drops out to the
      // headwater minimum where the trace strays a texel off the channel. Swept
      // straight, that turns a 12 m trunk into a row of paper darts. A windowed
      // maximum repairs the dropouts (discharge only ever grows downstream),
      // then a box blur takes the stairstep out of the confluences.
      const n0 = poly.length;
      const wRep = new Float32Array(n0), fRep = new Float32Array(n0);
      const RAD = 5;
      for (let i = 0; i < n0; i++) {
        let mw = 0, mf = 0;
        for (let k = Math.max(0, i - RAD); k <= Math.min(n0 - 1, i + RAD); k++) {
          if (poly[k].w > mw) mw = poly[k].w;
          if (poly[k].flow > mf) mf = poly[k].flow;
        }
        wRep[i] = mw; fRep[i] = mf;
      }
      const wSm = new Float32Array(n0), fSm = new Float32Array(n0);
      const BLUR = 8;
      for (let i = 0; i < n0; i++) {
        let sw = 0, sf = 0, c = 0;
        for (let k = Math.max(0, i - BLUR); k <= Math.min(n0 - 1, i + BLUR); k++) {
          sw += wRep[k]; sf += fRep[k]; c++;
        }
        wSm[i] = sw / c; fSm[i] = sf / c;
      }

      // ── resample: station spacing scales with the channel, so a 12 m trunk
      // is not tessellated at the same density as a 1.5 m brook.
      const stations = [];
      let maxW = 0;
      const push = (i, d) => {
        stations.push({ x: poly[i].x, y: poly[i].y, z: poly[i].z, w: wSm[i], flow: fSm[i], d });
        if (wSm[i] > maxW) maxW = wSm[i];
      };
      let travelled = 0, sinceStation = 0;
      push(0, 0);
      for (let i = 1; i < poly.length; i++) {
        const seg = Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z);
        travelled += seg;
        sinceStation += seg;
        const stepM = Math.min(12, Math.max(4, wSm[i] * 0.9));
        if (sinceStation >= stepM || i === poly.length - 1) {
          push(i, travelled);
          sinceStation = 0;
        }
      }
      if (stations.length < 3 || maxW < 1.5) continue;

      // Tangents + turbulence. Surface gradient is the honest signal for
      // whitewater: a reach that drops fast is a rapid, one that does not is a
      // pool, regardless of how much water is in it.
      const n = stations.length;
      for (let k = 0; k < n; k++) {
        const a = stations[Math.max(0, k - 1)];
        const b = stations[Math.min(n - 1, k + 1)];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        stations[k].tx = dx / len;
        stations[k].tz = dz / len;
        const ds = Math.max(b.d - a.d, 1e-3);
        const grad = Math.max(0, (a.y - b.y) / ds);
        // narrow + high discharge = fast; steep = broken
        const pinch = clamp01(stations[k].flow * 6 / Math.max(stations[k].w, 1));
        stations[k].turb = clamp01(grad * 14 + pinch * 0.35);
      }
      // Smooth turbulence along the reach — foam does not switch on per-vertex.
      const sm = stations.map((s) => s.turb);
      for (let k = 0; k < n; k++) {
        const a = sm[Math.max(0, k - 2)], b = sm[Math.max(0, k - 1)];
        const c = sm[k], d = sm[Math.min(n - 1, k + 1)], e = sm[Math.min(n - 1, k + 2)];
        stations[k].turb = (a + b * 2 + c * 3 + d * 2 + e) / 9;
      }

      // ── emit into spatial buckets. A station that straddles two buckets is
      // duplicated into both; a few thousand extra vertices is a cheaper price
      // than losing frustum culling on a 3 km river network.
      const placed = new Map();   // `${bucket}:${station}` -> first vertex index
      const put = (bk, si) => {
        const key = bk * 100000 + si;
        const hit = placed.get(key);
        if (hit !== undefined) return hit;
        const b = getBucket(bk);
        const s = stations[si];
        const base = b.n;
        const hw = s.w * 0.5;
        for (let c = 0; c < COLS.length; c++) {
          const off = COLS[c] * hw;
          b.pos.push(s.x - s.tz * off, s.y, s.z + s.tx * off);
          b.side.push(COLS[c]);
          b.dist.push(s.d);
          b.flow.push(s.flow);
          b.turb.push(s.turb);
          b.wid.push(s.w);
          b.tan.push(s.tx, s.tz);
        }
        b.n += COLS.length;
        placed.set(key, base);
        return base;
      };

      for (let k = 0; k < n - 1; k++) {
        const s = stations[k];
        const bk = bucketOf(s.x, s.z);
        const a = put(bk, k);
        const c = put(bk, k + 1);
        const b = getBucket(bk);
        for (let q = 0; q < COLS.length - 1; q++) {
          b.idx.push(a + q, c + q, a + q + 1);
          b.idx.push(a + q + 1, c + q, c + q + 1);
        }
      }
    }

    let tris = 0;
    for (const [, b] of buckets) {
      if (!b.idx.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('aSide', new THREE.Float32BufferAttribute(b.side, 1));
      geo.setAttribute('aDist', new THREE.Float32BufferAttribute(b.dist, 1));
      geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(b.flow, 1));
      geo.setAttribute('aTurb', new THREE.Float32BufferAttribute(b.turb, 1));
      geo.setAttribute('aWidth', new THREE.Float32BufferAttribute(b.wid, 1));
      geo.setAttribute('aTan', new THREE.Float32BufferAttribute(b.tan, 2));
      geo.setIndex(b.idx);
      geo.computeBoundingSphere();
      geo.boundingSphere.radius *= 1.1;
      const mesh = new THREE.Mesh(geo, this.riverMaterial);
      mesh.renderOrder = 6;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = 'RiverChunk';
      this.group.add(mesh);
      this._meshes.push(mesh);
      tris += b.idx.length / 3;
    }
    this.riverTriangles = tris;
  }

  // ── lakes ──────────────────────────────────────────────────────────────────
  /**
   * Any patch of baked water whose surface is *flat* is a lake; anything with a
   * gradient across it is a river reach and belongs to the ribbons. Classifying
   * by surface slope rather than by the river mask means ox-bows, ponds and
   * flooded basins all end up on the calm shader without a special case.
   */
  _buildLakes() {
    const world = this.ctx.world;
    const R = world.res;
    const half = world.half;
    const texel = world.texelSize ?? (world.worldSize / R);
    const cells = Math.max(1, Math.round(LAKE_TILE / texel));
    const tiles = Math.floor(R / cells);

    // Four quadrant meshes: enough for coarse culling, few enough that lakes
    // never cost more than four draw calls.
    const quads = [[], [], [], []];

    for (let tz = 0; tz < tiles; tz++) {
      for (let tx = 0; tx < tiles; tx++) {
        let wet = 0, riv = 0, lo = Infinity, hi = -Infinity, sum = 0;
        for (let j = 0; j < cells; j++) {
          const gz = tz * cells + j;
          const row = gz * R;
          for (let i = 0; i < cells; i++) {
            const v = world.water[row + tx * cells + i];
            if (v < -9000) continue;
            wet++; sum += v;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
            if (world.riverMask[row + tx * cells + i] > 0.35) riv++;
          }
        }
        if (wet < 3) continue;
        if (hi - lo > 1.0) continue;              // sloping water: that's a river
        if (riv > wet * 0.55) continue;           // channel: the ribbon owns it
        const y = sum / wet;

        const x0 = -half + tx * cells * texel;
        const z0 = -half + tz * cells * texel;
        const x1 = x0 + cells * texel;
        const z1 = z0 + cells * texel;
        const q = quads[(x0 > 0 ? 1 : 0) + (z0 > 0 ? 2 : 0)];
        q.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
      }
    }

    let count = 0;
    for (const q of quads) {
      if (!q.length) continue;
      const verts = q.length / 3;
      const idx = new Uint32Array((verts / 4) * 6);
      for (let t = 0, p = 0; t < verts / 4; t++) {
        const b = t * 4;
        idx[p++] = b; idx[p++] = b + 2; idx[p++] = b + 1;
        idx[p++] = b; idx[p++] = b + 3; idx[p++] = b + 2;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(q, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.lakeMaterial);
      mesh.renderOrder = 4;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = 'LakeQuadrant';
      this.group.add(mesh);
      this._meshes.push(mesh);
      count += verts / 4;
    }
    this.lakeTiles = count;
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
      // Match three's hemisphere irradiance for an up-facing surface: mostly
      // sky, a little bounce. Water lit any other way drifts out of step with
      // the terrain it sits in.
      u.uAmbient.value.copy(hemi.groundColor).lerp(hemi.color, 0.78)
        .multiplyScalar(hemi.intensity);
    }

    // Sky gradient for the reflection. Read defensively — Sky is another
    // author's module and its uniform names are not a contract.
    const su = sky?.uniforms;
    const zen = su?.uZenith?.value ?? su?.uSkyZenith?.value;
    const hor = su?.uHorizon?.value ?? su?.uSkyHorizon?.value;
    if (zen?.isColor) u.uSkyZenith.value.copy(zen);
    if (hor?.isColor) u.uSkyHorizon.value.copy(hor);
    else if (lighting?.fogNear) u.uSkyHorizon.value.copy(lighting.fogNear);

    // Reflected land is lit by the same sun; tie it to the key so a dawn lake
    // does not reflect a golden-hour hillside.
    if (sun) {
      const k = Math.min(1.6, 0.35 + sun.intensity * 0.22);
      u.uRefGround.value.copy(PALETTE.grassGoldDeep).multiply(sun.color).multiplyScalar(k * 0.9);
      u.uRefRock.value.copy(PALETTE.rockMid).multiply(sun.color).multiplyScalar(k * 0.95);
    }
    void dt;
  }

  dispose() {
    for (const m of this._meshes) m.geometry.dispose();
    for (const m of this._materials) m.dispose();
    this.ctx.scene?.remove(this.group);
    this._meshes.length = 0;
  }
}

void WORLD;
