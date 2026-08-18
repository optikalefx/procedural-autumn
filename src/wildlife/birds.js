// ─────────────────────────────────────────────────────────────────────────────
//  birds — the two bird moments the valley needs.
//
//  1. **Flocks wheeling over the valley.** Always somewhere in the sky, always
//     turning. They are the thing that stops a wide establishing shot from
//     being a still life, and they cost one draw call each.
//
//  2. **A burst out of a tree as you drive past.** Pure reactivity: the world
//     noticed you. This is the cheapest, highest-value piece of game feel in
//     the whole wildlife system, so it gets its own pooled mesh.
//
//  Both are instanced. A bird is nine triangles — body, two wings, a tail — and
//  the flap happens in the vertex shader off a per-instance phase, so the CPU
//  only ever writes a matrix per bird.
//
//  Birds do not cast shadows. A 1 m wingspan at 60 m altitude casts about two
//  pixels of shadow and doubles the draw call cost of the whole flock.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp, clamp01, lerp, mulberry32 } from '../core/MathUtils.js';

const FLOCKS = 2;            // wheeling flocks alive at once
const FLOCK_MAX = 34;        // birds per flock
const BURSTS = 3;            // simultaneous startle bursts
const BURST_MAX = 13;        // birds per burst

/**
 * One bird, nose along +Z, wings along ±X. `aWing` is 0 on the body and ±1 on
 * the wing sheets; the vertex shader rotates the wing verts about the body
 * axis, which is the entire animation.
 */
function birdGeometry() {
  const pos = [], nor = [], wing = [], col = [];
  const push = (x, y, z, nx, ny, nz, w) => {
    pos.push(x, y, z); nor.push(nx, ny, nz); wing.push(w);
    // Vertex colour is the identity here; it exists so that USE_COLOR is on and
    // three multiplies the per-instance colour in. Wing sheets sit a shade
    // darker than the body, which keeps them readable at ten pixels.
    const v = w === 0 ? 1.0 : 0.86;
    col.push(v, v, v);
  };
  const tri = (a, b, c, w) => {
    // Flat-shaded: one normal per triangle, computed from the winding.
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    push(a[0], a[1], a[2], nx, ny, nz, w);
    push(b[0], b[1], b[2], nx, ny, nz, w);
    push(c[0], c[1], c[2], nx, ny, nz, w);
  };

  // Body: a four-sided spindle, deliberately deeper than it is wide. A bird
  // seen from the side is mostly body, and the first pass was a flat sliver
  // that vanished at anything past twenty metres.
  const nose = [0, 0.010, 0.32], tail = [0, 0.015, -0.26];
  const ring = [[0.058, 0.005, 0.02], [0, 0.082, 0.02], [-0.058, 0.005, 0.02], [0, -0.062, 0.02]];
  for (let i = 0; i < 4; i++) {
    const a = ring[i], b = ring[(i + 1) % 4];
    tri(nose, a, b, 0);
    tri(tail, b, a, 0);
  }
  // Tail fan, tilted up a little so it is never perfectly edge-on.
  tri([0.085, 0.020, -0.24], [-0.085, 0.020, -0.24], [0, 0.048, -0.44], 0);
  tri([-0.085, 0.020, -0.24], [0.085, 0.020, -0.24], [0, 0.048, -0.44], 0);

  // Wings: a broad swept quad each side with real dihedral. The first pass
  // tapered to a point, which gave an aspect ratio of four to one — at fifty
  // metres that is a dash, not a bird. Corvid wings are short and broad.
  for (const s of [-1, 1]) {
    const r0 = [s * 0.050, 0.028, 0.115];
    const r1 = [s * 0.050, 0.028, -0.170];
    const t0 = [s * 0.500, 0.086, 0.030];
    const t1 = [s * 0.465, 0.086, -0.215];
    tri(r0, t0, t1, s);
    tri(r0, t1, r1, s);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

/**
 * Standard material so birds get the shared fog and stylised lighting; the only
 * custom work is the wingbeat. Per-instance phase and rate ride in on an
 * instanced attribute so one mesh can hold a whole flock out of sync.
 */
function birdMaterial(shared) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    flatShading: true,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBirdTime = shared.time;
    mat.userData.shader = shader;
    // Only the position moves. The material is flat-shaded, so three derives
    // the normal from screen-space derivatives in the fragment shader and the
    // flapped wing is lit correctly with no normal maths here at all.
    shader.vertexShader = /* glsl */`
      attribute float aWing;
      attribute vec3 aBeat;       // x phase, y rate (Hz), z amplitude
      uniform float uBirdTime;
      // Downstroke fast and deep, upstroke slow and shallow. A plain sine
      // reads as a flapping toy; this reads as a bird.
      float birdBeat() {
        float ph = uBirdTime * aBeat.y * 6.2831853 + aBeat.x;
        float s = sin( ph );
        return ( s > 0.0 ? s * s : -abs( s ) * 0.62 ) * aBeat.z;
      }
    ` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */`#include <begin_vertex>
       if ( abs( aWing ) > 0.5 ) {
         float beat = birdBeat();
         float ca = cos( beat ), sa = sin( beat );
         float px = transformed.x, py = transformed.y;
         transformed.x = px * ca - py * sa * aWing;
         transformed.y = px * sa * aWing + py * ca;
         // Fold the wing back a touch at the extremes of the stroke.
         transformed.z -= abs( beat ) * 0.06;
       }`
    );
  };
  mat.customProgramCacheKey = () => 'birdWing';
  return mat;
}

/** An InstancedMesh plus its per-instance beat attribute. */
function makeFlockMesh(geo, mat, count) {
  const m = new THREE.InstancedMesh(geo, mat, count);
  const beat = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  beat.setUsage(THREE.DynamicDrawUsage);
  m.geometry = geo.clone();
  m.geometry.setAttribute('aBeat', beat);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.castShadow = false;
  m.receiveShadow = false;
  m.frustumCulled = false;     // the flock centre moves; a stale sphere pops it
  m.count = 0;
  m.userData.beat = beat;
  return m;
}

export class Birds {
  constructor(ctx, seed) {
    this.ctx = ctx;
    this.rnd = mulberry32(seed >>> 0);
    this.group = new THREE.Group();
    this.group.name = 'Birds';
    this.shared = { time: { value: 0 } };

    this._dummy = new THREE.Object3D();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._v = new THREE.Vector3();
    this._col = new THREE.Color();
    this._lastCam = new THREE.Vector3();
    this._camVel = new THREE.Vector3();
    this._time = 0;
    this._burstCool = 3 + this.rnd() * 6;
    this._scan = 0;
  }

  build() {
    const geo = birdGeometry();
    this.geo = geo;
    this.mat = birdMaterial(this.shared);

    // ── wheeling flocks ──────────────────────────────────────────────────────
    this.flocks = [];
    for (let f = 0; f < FLOCKS; f++) {
      const mesh = makeFlockMesh(geo, this.mat, FLOCK_MAX);
      const n = 14 + ((this.rnd() * (FLOCK_MAX - 14)) | 0);
      const birds = [];
      for (let i = 0; i < n; i++) {
        birds.push({
          r: 14 + this.rnd() * 30,
          a: this.rnd() * Math.PI * 2,
          w: (0.16 + this.rnd() * 0.10) * (f % 2 ? -1 : 1),   // angular speed
          y: (this.rnd() - 0.5) * 16,
          bob: this.rnd() * 6.28,
          rw: 0.13 + this.rnd() * 0.2,
          sc: 0.85 + this.rnd() * 0.5,
        });
        // Corvid-dark with a couple of paler birds so the flock is not a
        // uniform stamp. Warm-dark, not black — black reads as a hole.
        // Against a bright sky a bird is a silhouette. Anything with real
        // albedo picks up the golden-hour key and renders as an orange flake,
        // which is what the first pass looked like.
        const pale = this.rnd() < 0.18;
        this._col.setHex(pale ? 0x4c4438 : 0x191410);
        mesh.setColorAt(i, this._col);
        const b = mesh.userData.beat.array;
        b[i * 3] = this.rnd() * 6.28;
        b[i * 3 + 1] = 2.3 + this.rnd() * 1.1;
        b[i * 3 + 2] = 0.78 + this.rnd() * 0.30;
      }
      mesh.count = n;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
      this.flocks.push({
        mesh, birds, n,
        cx: 0, cy: 0, cz: 0,          // flock centre
        tx: 0, tz: 0,                 // where the centre is drifting to
        t: this.rnd() * 20,
        placed: false,
      });
    }

    // ── startle bursts ───────────────────────────────────────────────────────
    this.burstMesh = makeFlockMesh(geo, this.mat, BURSTS * BURST_MAX);
    this.burstMesh.count = BURSTS * BURST_MAX;
    this.burstMesh.scale.setScalar(1);
    for (let i = 0; i < BURSTS * BURST_MAX; i++) {
      this._col.setHex(this.rnd() < 0.4 ? 0x5a4c36 : 0x241d16);
      this.burstMesh.setColorAt(i, this._col);
      const b = this.burstMesh.userData.beat.array;
      b[i * 3] = this.rnd() * 6.28;
      b[i * 3 + 1] = 6.5 + this.rnd() * 3.5;      // small birds flap fast
      b[i * 3 + 2] = 0.98 + this.rnd() * 0.30;
    }
    if (this.burstMesh.instanceColor) this.burstMesh.instanceColor.needsUpdate = true;
    this.group.add(this.burstMesh);

    this.bursts = [];
    for (let i = 0; i < BURSTS; i++) {
      const birds = [];
      for (let j = 0; j < BURST_MAX; j++) {
        birds.push({
          x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
          a: this.rnd() * 6.28, sc: 0.75 + this.rnd() * 0.40,
        });
      }
      this.bursts.push({ birds, life: 0, n: 0, base: i * BURST_MAX });
    }
    // Park every burst instance out of sight until it is used.
    this._dummy.position.set(0, -9000, 0);
    this._dummy.scale.setScalar(0.0001);
    this._dummy.updateMatrix();
    for (let i = 0; i < BURSTS * BURST_MAX; i++) this.burstMesh.setMatrixAt(i, this._dummy.matrix);
    this.burstMesh.instanceMatrix.needsUpdate = true;

    this.ctx.scene.add(this.group);
  }

  // ── per frame ──────────────────────────────────────────────────────────────

  update(dt, cam, threat) {
    this._time += dt;
    this.shared.time.value = this._time;
    const W = this.ctx.world;

    for (let f = 0; f < this.flocks.length; f++) this._flock(this.flocks[f], dt, cam, W, f);
    this._burstScan(dt, cam, threat, W);
    for (const b of this.bursts) if (b.life > 0) this._burst(b, dt);
  }

  /**
   * A flock circles a centre that drifts. The centre is kept in a ring around
   * the camera — far enough that the birds read as distant, near enough that
   * they are more than one pixel — and re-homed whenever the player leaves it
   * behind, which is invisible because it only ever happens off screen.
   */
  _flock(F, dt, cam, W, fi) {
    const dx = F.cx - cam.position.x, dz = F.cz - cam.position.z;
    const dist = Math.hypot(dx, dz);
    if (!F.placed || dist > 400) {
      const a = this._time * 0.7 + fi * 2.6 + this.rnd() * 6.28;
      const r = 70 + this.rnd() * 110;
      F.cx = cam.position.x + Math.sin(a) * r;
      F.cz = cam.position.z + Math.cos(a) * r;
      F.tx = F.cx; F.tz = F.cz;
      F.placed = true;
    }
    // New drift target every so often, so the flock crosses the valley rather
    // than orbiting one fixed point forever.
    F.t -= dt;
    if (F.t < 0) {
      F.t = 14 + this.rnd() * 22;
      const a = this.rnd() * 6.28;
      const r = 60 + this.rnd() * 150;
      F.tx = cam.position.x + Math.sin(a) * r;
      F.tz = cam.position.z + Math.cos(a) * r;
    }
    const sp = 5.5 * dt;
    const tdx = F.tx - F.cx, tdz = F.tz - F.cz;
    const tl = Math.hypot(tdx, tdz) || 1;
    F.cx += (tdx / tl) * Math.min(sp, tl);
    F.cz += (tdz / tl) * Math.min(sp, tl);

    const ground = W.isInBounds(F.cx, F.cz) ? W.getHeight(F.cx, F.cz) : 20;
    const wantY = ground + 42 + fi * 13 + Math.sin(this._time * 0.11 + fi) * 8;
    F.cy = F.cy === 0 ? wantY : lerp(F.cy, wantY, 1 - Math.exp(-0.4 * dt));

    const D = this._dummy, E = this._e;
    for (let i = 0; i < F.n && i < F.birds.length; i++) {
      const b = F.birds[i];
      b.a += b.w * dt;
      // Radius breathes so the flock is a living smear rather than a ring.
      const r = b.r * (1 + Math.sin(this._time * b.rw + b.bob) * 0.22);
      const x = F.cx + Math.sin(b.a) * r;
      const z = F.cz + Math.cos(b.a) * r;
      const y = F.cy + b.y + Math.sin(this._time * 0.6 + b.bob) * 2.2;
      D.position.set(x, y, z);
      // Heading is the tangent; bank into the turn, which is what makes a
      // wheeling flock flash light and dark as it comes round.
      const yaw = b.a + (b.w > 0 ? Math.PI * 0.5 : -Math.PI * 0.5);
      E.set(Math.sin(this._time * 0.5 + b.bob) * 0.05, yaw, clamp(b.w * 4.2, -0.9, 0.9));
      D.quaternion.setFromEuler(E);
      // A wheeling bird has to survive being a dozen pixels a hundred metres
      // up, so the flock species is deliberately a big one — raven scale.
      D.scale.setScalar(b.sc * 2.1);
      D.updateMatrix();
      F.mesh.setMatrixAt(i, D.matrix);
    }
    F.mesh.count = F.n || F.birds.length;
    F.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Look for a tree just ahead of whatever is moving through the world and, on
   * a cooldown, empty it. Reading the tree placement off the Trees system means
   * the birds always come out of a real tree rather than out of thin air.
   */
  _burstScan(dt, cam, threat, W) {
    this._burstCool -= dt;
    if (this._burstCool > 0) return;

    // Prefer the camper; fall back to the camera so the effect still fires in
    // free-fly and in the capture harness.
    let px, pz, vx, vz, speed;
    if (threat && Math.abs(threat.speed) > 3.5) {
      px = threat.x; pz = threat.z; speed = Math.abs(threat.speed);
      vx = Math.sin(threat.heading ?? 0); vz = Math.cos(threat.heading ?? 0);
      if (threat.speed < 0) { vx = -vx; vz = -vz; }
    } else {
      this._camVel.subVectors(cam.position, this._lastCam).multiplyScalar(1 / Math.max(dt, 1e-3));
      this._lastCam.copy(cam.position);
      speed = Math.hypot(this._camVel.x, this._camVel.z);
      if (speed < 3.5) return;
      vx = this._camVel.x / speed; vz = this._camVel.z / speed;
      px = cam.position.x; pz = cam.position.z;
    }

    const T = this.ctx.systems?.trees?.trees;
    if (!T) { this._burstCool = 6; return; }

    // A point ahead, offset to one side — birds leaving the tree you are about
    // to pass, not the one you are already under.
    const side = this.rnd() < 0.5 ? -1 : 1;
    const ax = px + vx * (10 + speed * 0.8) - vz * side * 7;
    const az = pz + vz * (10 + speed * 0.8) + vx * side * 7;

    const gx = clamp(((ax + T.half) / T.BS) | 0, 0, T.BW - 1);
    const gz = clamp(((az + T.half) / T.BS) | 0, 0, T.BW - 1);
    let best = -1, bestD = 1e9;
    for (let j = -1; j <= 1; j++) {
      const zz = gz + j; if (zz < 0 || zz >= T.BW) continue;
      for (let i = -1; i <= 1; i++) {
        const xx = gx + i; if (xx < 0 || xx >= T.BW) continue;
        const b = zz * T.BW + xx;
        for (let k = T.bucketStart[b]; k < T.bucketStart[b + 1]; k++) {
          const t = T.order[k];
          if (T.pImpH[t] < 4.5) continue;                 // saplings hold no birds
          const ddx = T.px[t] - ax, ddz = T.pz[t] - az;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 < bestD) { bestD = d2; best = t; }
        }
      }
    }
    if (best < 0 || bestD > 220) { this._burstCool = 1.2; return; }

    const slot = this.bursts.find((b) => b.life <= 0);
    if (!slot) { this._burstCool = 2; return; }
    this._fire(slot, T.px[best], T.py[best] + T.pImpH[best] * 0.66, T.pz[best], vx, vz);
    this._burstCool = 7 + this.rnd() * 14;
    void W;
  }

  _fire(B, x, y, z, vx, vz) {
    B.n = 5 + ((this.rnd() * (BURST_MAX - 5)) | 0);
    B.life = 5.0;
    for (let i = 0; i < B.n; i++) {
      const b = B.birds[i];
      const a = this.rnd() * 6.28;
      const r = this.rnd() * 1.6;
      b.x = x + Math.sin(a) * r;
      b.y = y + (this.rnd() - 0.5) * 1.8;
      b.z = z + Math.cos(a) * r;
      // Away from the road and upward, with a good spread of energy so they
      // do not leave as a rigid formation.
      const sp = 5.5 + this.rnd() * 5.5;
      const spread = (this.rnd() - 0.5) * 1.5;
      b.vx = (vx * Math.cos(spread) - vz * Math.sin(spread)) * sp * 0.6 + (this.rnd() - 0.5) * 3;
      b.vz = (vz * Math.cos(spread) + vx * Math.sin(spread)) * sp * 0.6 + (this.rnd() - 0.5) * 3;
      b.vy = 4.5 + this.rnd() * 4.0;
      b.a = this.rnd() * 6.28;
    }
  }

  _burst(B, dt) {
    B.life -= dt;
    const D = this._dummy, E = this._e;
    // The last second is a shrink to nothing. At the distance they have reached
    // by then a bird is two pixels, and shrinking beats popping.
    const fade = clamp01(B.life / 1.0);
    for (let i = 0; i < B.n; i++) {
      const b = B.birds[i];
      // Climb, then level off and accelerate away — the shape of a real escape.
      b.vy = lerp(b.vy, 0.6, 1 - Math.exp(-1.3 * dt));
      const sp = Math.hypot(b.vx, b.vz) || 1;
      const push = 1 + 1.0 * dt;
      b.vx *= push; b.vz *= push;
      const cap = 9;
      if (sp > cap) { b.vx *= cap / sp; b.vz *= cap / sp; }
      // A jinking, uneven flight line.
      b.a += dt * 3.1;
      const jx = Math.sin(b.a) * 2.4, jz = Math.cos(b.a * 0.8) * 2.4;
      b.x += (b.vx + jx) * dt;
      b.y += (b.vy + Math.sin(b.a * 1.7) * 1.1) * dt;
      b.z += (b.vz + jz) * dt;

      D.position.set(b.x, b.y, b.z);
      E.set(clamp(-Math.atan2(b.vy, Math.hypot(b.vx, b.vz)) * 0.6, -0.6, 0.6),
        Math.atan2(b.vx + jx, b.vz + jz),
        Math.sin(b.a) * 0.45);
      D.quaternion.setFromEuler(E);
      D.scale.setScalar(b.sc * fade);
      D.updateMatrix();
      this.burstMesh.setMatrixAt(B.base + i, D.matrix);
    }
    if (B.life <= 0) {
      D.position.set(0, -9000, 0); D.scale.setScalar(0.0001);
      D.quaternion.identity(); D.updateMatrix();
      for (let i = 0; i < B.n; i++) this.burstMesh.setMatrixAt(B.base + i, D.matrix);
      B.n = 0;
    }
    this.burstMesh.instanceMatrix.needsUpdate = true;
  }

  /** Debug: fire a burst at a chosen point. */
  debugBurst(x, y, z) {
    const slot = this.bursts.find((b) => b.life <= 0) ?? this.bursts[0];
    this._fire(slot, x, y, z, 0, 1);
    return { x, y, z };
  }

  dispose() {
    this.group.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    for (const f of this.flocks) f.mesh.geometry.dispose();
    this.burstMesh.geometry.dispose();
  }
}
