// ─────────────────────────────────────────────────────────────────────────────
//  VehicleFX — the stuff that turns a moving box into a vehicle.
//
//  · ParticleField: one GPU-simulated Points cloud shared by dust, kicked-up
//    leaves, river spray and exhaust.  Spawning writes a handful of attributes;
//    the shader integrates position, so the CPU never touches a live particle.
//  · TrackRibbons: four ribbons of quads laid under the wheels on soft ground,
//    ping-ponged between two buffers so a ring-buffer seam can never smear a
//    quad across the valley.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { fogUniforms } from '../render/Atmosphere.js';
import { clamp01 } from '../core/MathUtils.js';

export const KIND = { DUST: 0, LEAF: 1, SPRAY: 2, SMOKE: 3 };

const PARTICLE_VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  attribute vec3  aVel;
  attribute vec3  aColor;
  attribute float aBirth;
  attribute float aLife;
  attribute float aSize;
  attribute float aKind;
  attribute float aSeed;
  uniform float uTime;
  uniform float uScale;
  varying vec3  vColor;
  varying float vAlpha;
  varying float vKind;
  varying float vRot;

  void main() {
    float t = uTime - aBirth;
    float a = t / aLife;
    vKind = aKind;
    vColor = aColor;
    vRot = aSeed * 6.2831 + t * (aKind > 0.5 && aKind < 1.5 ? 3.4 : 0.7);

    // per-kind ballistics: drag then gravity (smoke drifts up, spray falls hard)
    float drag = aKind < 0.5 ? 1.7 : (aKind < 1.5 ? 2.5 : (aKind < 2.5 ? 0.9 : 1.3));
    float grav = aKind < 0.5 ? -0.45 : (aKind < 1.5 ? -1.5 : (aKind < 2.5 ? -8.2 : 0.85));

    vec3 p = position + aVel * ((1.0 - exp(-drag * t)) / drag);
    p.y += 0.5 * grav * t * t;
    if (aKind > 0.5 && aKind < 1.5) {            // leaves flutter sideways
      p.x += sin(t * 6.0 + aSeed * 21.0) * 0.30 * t;
      p.z += cos(t * 5.1 + aSeed * 17.0) * 0.30 * t;
    }
    if (aKind < 0.5 || aKind > 2.5) {            // dust/smoke billow outward
      p.xz += vec2(cos(aSeed * 39.0), sin(aSeed * 27.0)) * 0.22 * t;
    }

    float grow = aKind < 0.5 ? (0.40 + 1.55 * a)
               : aKind > 2.5 ? (0.35 + 1.90 * a)
               : (aKind < 1.5 ? 1.0 : (0.7 + 0.5 * a));
    float fadeIn = smoothstep(0.0, 0.10, a);
    float fadeOut = pow(clamp(1.0 - a, 0.0, 1.0), 1.5);
    vAlpha = fadeIn * fadeOut;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    if (a < 0.0 || a > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
    gl_PointSize = clamp(aSize * grow * uScale / max(-mv.z, 0.1), 1.0, 260.0);
    gl_Position = projectionMatrix * mv;

    vec3 transformed = p;
    #include <fog_vertex>
  }`;

const PARTICLE_FRAG = /* glsl */`
  #include <common>
  #include <fog_pars_fragment>
  varying vec3  vColor;
  varying float vAlpha;
  varying float vKind;
  varying float vRot;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float alpha = vAlpha;
    if (vKind > 0.5 && vKind < 1.5) {
      // a leaf: rotated, slightly pointed blade
      float s = sin(vRot), co = cos(vRot);
      vec2 r = vec2(c.x * co - c.y * s, c.x * s + c.y * co);
      float m = 1.0 - smoothstep(0.20, 0.30, max(abs(r.x) * 1.05, abs(r.y) * 2.3) + abs(r.x * r.y) * 1.4);
      alpha *= m;
    } else if (vKind > 1.5 && vKind < 2.5) {
      alpha *= smoothstep(0.50, 0.14, length(c));
    } else {
      // soft puff with a lightly broken edge so it is not a perfect disc
      float d = length(c);
      float wob = 0.5 + 0.5 * sin(atan(c.y, c.x) * 4.0 + vRot * 3.0);
      alpha *= smoothstep(0.50 - wob * 0.06, 0.08, d);
      // Dust is a haze, not a solid. At full opacity these read as a string of
      // hard white pearls behind the wheels — especially once bloom gets hold
      // of them — instead of a warm cloud the camper is dragging along.
      alpha *= vKind < 0.5 ? 0.42 : 0.62;
    }
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(vColor, alpha);
    #include <fog_fragment>
  }`;

export class ParticleField {
  constructor(scene, max = 1100) {
    this.max = max;
    this.head = 0;
    this.time = 0;

    const g = new THREE.BufferGeometry();
    const f = (n) => new THREE.BufferAttribute(new Float32Array(max * n), n);
    this.pos = f(3); this.vel = f(3); this.col = f(3);
    this.birth = f(1); this.life = f(1); this.size = f(1);
    this.kind = f(1); this.seed = f(1);
    // Park every slot in the far past so nothing draws before it is spawned.
    this.birth.array.fill(-1e6);
    this.life.array.fill(1);
    g.setAttribute('position', this.pos);
    g.setAttribute('aVel', this.vel);
    g.setAttribute('aColor', this.col);
    g.setAttribute('aBirth', this.birth);
    g.setAttribute('aLife', this.life);
    g.setAttribute('aSize', this.size);
    g.setAttribute('aKind', this.kind);
    g.setAttribute('aSeed', this.seed);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([fogUniforms(), {
        uTime: { value: 0 }, uScale: { value: 600 },
      }]),
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });

    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.points.name = 'vehicleParticles';
    scene.add(this.points);
    // Spawns land at consecutive ring slots, so a frame's writes are one run
    // (or two, across the wrap). Uploading the run instead of the whole pool
    // is the difference between 8 x 1100 slots a frame and 8 x however many
    // actually spawned, which on a drive is usually two or three.
    this._lo = -1;
    this._hi = -1;
    this._dirty = false;
  }

  /** @param p {x,y,z, vx,vy,vz, life, size, kind, color:THREE.Color} */
  spawn(x, y, z, vx, vy, vz, life, size, kind, color) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    if (this._lo < 0) { this._lo = i; this._hi = i; }
    else if (i === (this._hi + 1) % this.max) { this._hi = i; }
    else { this._lo = 0; this._hi = this.max - 1; }   // non-contiguous: give up, take the lot
    const p3 = i * 3;
    this.pos.array[p3] = x; this.pos.array[p3 + 1] = y; this.pos.array[p3 + 2] = z;
    this.vel.array[p3] = vx; this.vel.array[p3 + 1] = vy; this.vel.array[p3 + 2] = vz;
    this.col.array[p3] = color.r; this.col.array[p3 + 1] = color.g; this.col.array[p3 + 2] = color.b;
    this.birth.array[i] = this.time;
    this.life.array[i] = life;
    this.size.array[i] = size;
    this.kind.array[i] = kind;
    this.seed.array[i] = Math.random();
    this._dirty = true;
  }

  update(dt, pixelHeight) {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    this.material.uniforms.uScale.value = pixelHeight * 0.9;
    if (this._dirty) {
      const attrs = [this.pos, this.vel, this.col, this.birth, this.life, this.size, this.kind, this.seed];
      // One run, or two if the writes crossed the end of the ring.
      const runs = this._lo <= this._hi
        ? [[this._lo, this._hi - this._lo + 1]]
        : [[this._lo, this.max - this._lo], [0, this._hi + 1]];
      for (const a of attrs) {
        for (const [start, count] of runs) a.addUpdateRange(start * a.itemSize, count * a.itemSize);
        a.needsUpdate = true;
      }
      this._lo = this._hi = -1;
      this._dirty = false;
    }
  }

  dispose() {
    this.points.parent?.remove(this.points);
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tyre tracks
// ─────────────────────────────────────────────────────────────────────────────
const TRACK_VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  attribute float aBirth;
  attribute vec3  aColor;
  attribute float aFade;
  uniform float uTime;
  uniform float uLife;
  varying float vAlpha;
  varying vec3  vColor;
  varying vec2  vUv;
  void main() {
    float age = (uTime - aBirth) / uLife;
    vAlpha = clamp(1.0 - age, 0.0, 1.0) * aFade;
    vAlpha *= vAlpha;                      // slow start, quick tail-off
    vColor = aColor;
    vUv = uv;
    vec3 transformed = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <fog_vertex>
  }`;

const TRACK_FRAG = /* glsl */`
  #include <common>
  #include <fog_pars_fragment>
  varying float vAlpha;
  varying vec3  vColor;
  varying vec2  vUv;
  void main() {
    // two ruts inside the tyre width, soft edges
    float e = smoothstep(0.0, 0.22, vUv.x) * smoothstep(1.0, 0.78, vUv.x);
    float a = vAlpha * e * 0.62;
    if (a < 0.005) discard;
    // Multiply, not paint. A rut is disturbed soil seen under the same light as
    // the ground around it; an opaque colour laid over the top glowed in
    // shadow, which read as ski tracks rather than tyre marks.
    gl_FragColor = vec4(mix(vec3(1.0), vColor, a), 1.0);
    // Fog fades a multiply toward the (bright) haze colour, i.e. toward no
    // darkening at all, which is what distance should do to a rut anyway.
    #include <fog_fragment>
  }`;

class Ribbon {
  constructor(lanes, segs) {
    this.lanes = lanes;
    this.segs = segs;
    this.head = new Int32Array(lanes);     // per-lane write cursor
    const verts = lanes * segs * 2;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.birth = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.fade = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.uv = new THREE.BufferAttribute(new Float32Array(verts * 2), 2);
    this.birth.array.fill(-1e6);
    for (let v = 0; v < verts; v++) this.uv.array[v * 2] = v & 1;
    g.setAttribute('position', this.pos);
    g.setAttribute('aColor', this.col);
    g.setAttribute('aBirth', this.birth);
    g.setAttribute('aFade', this.fade);
    g.setAttribute('uv', this.uv);
    const idx = [];
    for (let l = 0; l < lanes; l++) {
      const base = l * segs * 2;
      for (let s = 0; s < segs - 1; s++) {
        const a = base + s * 2;
        idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.geometry = g;
  }

  reset(lane) { this.head[lane] = 0; }

  /** Returns false when the lane is full. */
  push(lane, ax, ay, az, bx, by, bz, r, gg, b, fade, time) {
    const s = this.head[lane];
    if (s >= this.segs) return false;
    const v = (lane * this.segs + s) * 2;
    const p = this.pos.array, c = this.col.array;
    p[v * 3] = ax; p[v * 3 + 1] = ay; p[v * 3 + 2] = az;
    p[v * 3 + 3] = bx; p[v * 3 + 4] = by; p[v * 3 + 5] = bz;
    c[v * 3] = r; c[v * 3 + 1] = gg; c[v * 3 + 2] = b;
    c[v * 3 + 3] = r; c[v * 3 + 4] = gg; c[v * 3 + 5] = b;
    this.birth.array[v] = this.birth.array[v + 1] = time;
    this.fade.array[v] = this.fade.array[v + 1] = fade;
    // A fresh lane's first segment has no predecessor: collapse the quad that
    // would otherwise stretch from the previous (stale) vertex pair.
    if (s === 0) { this.fade.array[v] = this.fade.array[v + 1] = 0; }
    this.head[lane] = s + 1;
    return true;
  }

  flush() {
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
    this.birth.needsUpdate = true;
    this.fade.needsUpdate = true;
  }
}

export class TrackRibbons {
  constructor(scene, lanes = 4, segs = 190) {
    this.lanes = lanes;
    this.life = 17;   // ~250 m of trail at speed; longer and it reads as a road
    this.time = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([fogUniforms(), {
        uTime: { value: 0 }, uLife: { value: this.life },
      }]),
      vertexShader: TRACK_VERT,
      fragmentShader: TRACK_FRAG,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      blendEquation: THREE.AddEquation,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -6,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.buffers = [new Ribbon(lanes, segs), new Ribbon(lanes, segs)];
    this.active = new Int32Array(lanes);   // which buffer each lane writes to
    this.meshes = this.buffers.map((b) => {
      const m = new THREE.Mesh(b.geometry, this.material);
      m.frustumCulled = false;
      m.renderOrder = 4;
      m.name = 'tyreTracks';
      scene.add(m);
      return m;
    });
    this._last = [];
    for (let i = 0; i < lanes; i++) this._last.push(null);
  }

  /**
   * @param lane   wheel index
   * @param x,z    contact point
   * @param nx,nz  wheel lateral axis (unit, world)
   * @param width  half-width of the rut
   * @param color  THREE.Color
   * @param fade   0..1 strength
   * @param sample fn(x,z) -> ground height
   */
  emit(lane, x, z, nx, nz, width, color, fade, sample) {
    const last = this._last[lane];
    if (last) {
      const d = Math.hypot(x - last.x, z - last.z);
      if (d < 0.55) return;
    }
    const ax = x - nx * width, az = z - nz * width;
    const bx = x + nx * width, bz = z + nz * width;
    const buf = this.buffers[this.active[lane]];
    const ok = buf.push(lane,
      ax, sample(ax, az) + 0.055, az,
      bx, sample(bx, bz) + 0.055, bz,
      color.r, color.g, color.b, fade, this.time);
    if (!ok) {
      // Lane full: switch to the other buffer and start it clean.  By the time
      // we come back here the content we overwrite is two lane-lengths old.
      this.active[lane] ^= 1;
      this.buffers[this.active[lane]].reset(lane);
      this._last[lane] = null;
      return;
    }
    this._last[lane] = { x, z };
    buf._dirty = true;
  }

  update(dt) {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    for (const b of this.buffers) if (b._dirty) { b.flush(); b._dirty = false; }
  }

  dispose() {
    for (const m of this.meshes) { m.parent?.remove(m); m.geometry.dispose(); }
    this.material.dispose();
  }
}

/** Blend the surface weights at a point into a plausible dust colour. */
export function surfaceDust(weights, out) {
  const g = clamp01(weights.grass), d = clamp01(weights.dry);
  const r = clamp01(weights.rock), dt = clamp01(weights.dirt);
  const sn = clamp01(weights.snow), sa = clamp01(weights.sand);
  const total = g + d + r + dt + sn + sa + 1e-4;
  // gold meadow, tan dirt, lavender rock dust, white snow
  out.setRGB(
    (g * 0.72 + d * 0.85 + r * 0.66 + dt * 0.74 + sn * 0.95 + sa * 0.86) / total,
    (g * 0.60 + d * 0.70 + r * 0.63 + dt * 0.58 + sn * 0.95 + sa * 0.75) / total,
    (g * 0.34 + d * 0.44 + r * 0.70 + dt * 0.40 + sn * 0.98 + sa * 0.56) / total,
  );
  return out;
}
