// ─────────────────────────────────────────────────────────────────────────────
//  LeafDrift — autumn leaves in the air, with real ballistics.
//
//  This is the single cheapest thing that makes the valley read as *alive*
//  rather than as a very good diorama, and the reason is motion parallax: a
//  leaf two metres from the camera crossing the frame in a second tells you
//  the world has air in it and that you are inside the world, not looking at
//  a picture of it.
//
//  The physics that matter, in order of how much they buy:
//
//   1. A leaf does not fall, it *flutter-tumbles*. It slips sideways, stalls,
//      flips over, and slips the other way. That is a coupled oscillation
//      between attitude and sideforce, and faking it with a sine on the
//      position alone is instantly readable as fake — the leaf swings while
//      pointing the wrong way. Here the sideforce is driven by the tumble
//      angle itself, so the leaf always slips the way it is leaning.
//   2. Terminal velocity ~1.2 m/s, against a 3–4 m/s wind. Leaves therefore
//      travel mostly *sideways*. Leaves that fall vertically read as snow.
//   3. Leaves come from trees. Spawning them uniformly around the camera is
//      the difference between "weather" and "particle effect", so most of the
//      spawn budget is spent in the crowns of nearby deciduous trees, and the
//      colour is taken from the tree it left.
//
//  Rendering is one InstancedMesh of a folded quad with a MeshStandardMaterial,
//  deliberately: that buys the shared Stylize lighting response, the shared
//  Atmosphere fog and shadow reception for free, so leaves sit in the same
//  light as everything else instead of reading as a separate render pass.
//  One draw call, no per-frame allocation, matrices composed in place.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mulberry32, clamp01 } from '../core/MathUtils.js';

// Terminal velocity = FALL / DRAG. Tuned so a leaf released from a 16 m crown
// takes ~12 s to reach the ground and covers ~40 m downwind doing it.
const DRAG = 2.15;       // 1/s, linear — a leaf is all drag and no inertia
const FALL = 2.55;       // m/s², effective gravity after buoyancy/lift
// Spawn radius is deliberately tight. A leaf is ~0.2 m: at 60 m it is under
// two pixels and contributes nothing but shimmer, while the *same* number of
// leaves packed into 34 m is seven times the volumetric density and reads as
// a real drift. Near beats numerous.
const SPAWN_R = 34;
const KILL_R = 46;

/** Folded-leaf geometry: two panels meeting along a raised midrib. */
function leafGeometry() {
  // A flat quad is invisible edge-on, which makes a tumbling leaf strobe. The
  // fold guarantees one panel always faces the light, and — with flat shading
  // — the two panels read as different values, which is what gives a drifting
  // leaf its glitter.
  const tip = [0, 0.54, 0.10];
  const base = [0, -0.46, 0.10];
  const mid = [0, 0.05, 0.13];
  const left = [-0.33, 0.05, -0.10];
  const right = [0.33, 0.05, -0.10];
  const tris = [
    [base, left, mid], [base, mid, right],
    [mid, left, tip], [mid, tip, right],
  ];
  const pos = new Float32Array(tris.length * 9);
  let o = 0;
  for (const t of tris) for (const v of t) { pos[o++] = v[0]; pos[o++] = v[1]; pos[o++] = v[2]; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export class LeafDrift {
  constructor(ctx, wind, ground, near, count) {
    this.ctx = ctx;
    this.wind = wind;
    this.ground = ground;
    this.near = near;
    this.n = count;

    const rand = mulberry32(0x1eaf ^ count);
    this.rand = rand;

    // ── particle state, all flat typed arrays ────────────────────────────────
    this.p = new Float32Array(count * 3);
    this.v = new Float32Array(count * 3);
    this.axis = new Float32Array(count * 3);   // tumble axis, leaf-local
    this.q = new Float32Array(count * 4);      // attitude
    this.spin = new Float32Array(count);       // rad/s
    this.phase = new Float32Array(count);      // flutter phase
    this.size = new Float32Array(count);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.alive = new Uint8Array(count);
    this.grow = new Float32Array(count);       // 0..1 scale-in, hides the spawn

    for (let i = 0; i < count; i++) {
      this.q[i * 4 + 3] = 1;
      this.life[i] = 1;
    }

    // scratch
    this._w = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._scl = new THREE.Vector3();
    this._qt = new THREE.Quaternion();
    this._dq = new THREE.Quaternion();
    this._ax = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._col = new THREE.Color();
  }

  init() {
    const geo = leafGeometry();
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.86,
      metalness: 0.0,
      side: THREE.DoubleSide,
      flatShading: true,
      // Leaves are thin and backlit half the time. A little self-emission is
      // the cheapest stand-in for transmission and stops leaves in shadow
      // reading as black grit against a bright meadow.
      emissive: new THREE.Color(0x2a1105),
      emissiveIntensity: 1.0,
      fog: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;     // positions change every frame
    this.mesh.castShadow = false;        // 900 shadow casters for 3 px of shade
    this.mesh.receiveShadow = true;      // but a leaf crossing a tree shadow dims
    this.mesh.name = 'WeatherLeaves';
    this.mesh.renderOrder = 3;

    // Park everything at zero scale until it is spawned.
    this._m.makeScale(0, 0, 0);
    for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, this._m);
    this.mesh.instanceMatrix.needsUpdate = true;

    this.ctx.scene.add(this.mesh);
  }

  /** Put leaf `i` into the air. */
  _spawn(i, cam, t) {
    const rand = this.rand;
    const near = this.near;
    const T = near.data;
    const w = this.wind;
    let x, y, z;
    let cr = 0.55, cg = 0.28, cb = 0.10;

    if (near.decidN > 0 && T && rand() < 0.82) {
      // ── shed from a crown ─────────────────────────────────────────────────
      // Prefer a *close* crown: three tries, keep the nearest hit. Shedding
      // from the tree at the edge of the index puts every leaf in the far
      // field where it is two pixels wide.
      let t0 = near.idx[(rand() * near.decidN) | 0];
      let best = 1e9;
      for (let k = 0; k < 3; k++) {
        const c = near.idx[(rand() * near.decidN) | 0];
        const d2 = (T.px[c] - cam.x) ** 2 + (T.pz[c] - cam.z) ** 2;
        if (d2 < best) { best = d2; t0 = c; }
      }
      const cx = T.px[t0], cy = T.py[t0], cz = T.pz[t0];
      const ch = T.pImpH[t0], cw = T.pImpW[t0];
      // Anywhere in the upper two thirds of the crown, biased outward: the
      // outside of a canopy is where the wind actually gets at the leaves.
      const a = rand() * Math.PI * 2;
      const rr = cw * (0.35 + 0.65 * Math.sqrt(rand()));
      x = cx + Math.cos(a) * rr;
      z = cz + Math.sin(a) * rr;
      y = cy + ch * (0.42 + 0.55 * rand());
      // Take the colour off the tree it left. Trees stores two crown colours
      // per instance; a leaf is one or the other, never an average, which is
      // what keeps the drift as saturated as the canopy.
      const src = rand() < 0.5 ? T.pcolA : T.pcolB;
      cr = src[t0 * 3]; cg = src[t0 * 3 + 1]; cb = src[t0 * 3 + 2];
    } else {
      // ── ambient: blown in from upwind, so nothing appears in front of you ──
      const a = Math.atan2(-w.dir.z, -w.dir.x) + (rand() - 0.5) * 2.2;
      const rr = 9 + SPAWN_R * 0.85 * rand();
      x = cam.x + Math.cos(a) * rr;
      z = cam.z + Math.sin(a) * rr;
      y = this.ground.at(x, z) + 1.2 + rand() * 13;
      // No parent tree: use the palette's own autumn range.
      const k = rand();
      if (k < 0.34) { cr = 0.78; cg = 0.28; cb = 0.07; }        // orange
      else if (k < 0.68) { cr = 0.86; cg = 0.50; cb = 0.09; }   // amber
      else if (k < 0.88) { cr = 0.89; cg = 0.72; cb = 0.13; }   // gold
      else { cr = 0.45; cg = 0.10; cb = 0.08; }                 // crimson
    }

    const i3 = i * 3;
    this.p[i3] = x; this.p[i3 + 1] = y; this.p[i3 + 2] = z;

    // Start already moving with the air, or the first half second reads as the
    // leaf being dropped by an invisible hand.
    w.windAt(this._pos.set(x, y, z), t, this._w);
    this.v[i3] = this._w.x * (0.6 + 0.4 * rand());
    this.v[i3 + 1] = -0.3 * rand();
    this.v[i3 + 2] = this._w.z * (0.6 + 0.4 * rand());

    // Tumble axis: mostly through the leaf's long edge, which is what makes a
    // leaf flip end over end rather than spin like a coin.
    const ax = rand() - 0.5, ay = (rand() - 0.5) * 0.5, az = rand() - 0.5;
    const al = Math.hypot(ax, ay, az) || 1;
    this.axis[i3] = ax / al; this.axis[i3 + 1] = ay / al; this.axis[i3 + 2] = az / al;

    this._qt.set(rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    this._qt.toArray(this.q, i * 4);

    this.spin[i] = (1.6 + rand() * 3.4) * (rand() < 0.5 ? -1 : 1);
    this.phase[i] = rand() * Math.PI * 2;
    this.size[i] = 0.15 + rand() * 0.15;
    this.age[i] = 0;
    this.life[i] = 22 + rand() * 20;
    this.grow[i] = 0;
    this.alive[i] = 1;

    this._col.setRGB(cr, cg, cb);
    this.mesh.setColorAt(i, this._col);
    this._colorDirty = true;
  }

  /**
   * @param {number} density 0..1 — how full the air should be, before the
   *        local tree count scales it. Driven by time of day and preset.
   */
  update(dt, t, density) {
    if (!this.mesh) return;
    const cam = this.ctx.camera.position;
    const w = this.wind;

    // How many leaves the air should hold here. Open meadow gets a thin drift
    // (leaves travel a long way), forest gets a thick one.
    const treeFill = clamp01(this.near.decidN / 34);
    const target = Math.min(this.n, Math.round(this.n * density * (0.38 + 0.62 * treeFill)));

    const p = this.p, v = this.v, q = this.q, axis = this.axis;
    const KILL2 = KILL_R * KILL_R;
    let live = 0;

    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const i3 = i * 3;

      // ── forces ─────────────────────────────────────────────────────────────
      this._pos.set(p[i3], p[i3 + 1], p[i3 + 2]);
      w.windAt(this._pos, t, this._w);

      let vx = v[i3], vy = v[i3 + 1], vz = v[i3 + 2];
      // Linear drag toward the air velocity. A leaf has almost no inertia, so
      // this is by far the dominant term and the wind field is what you see.
      vx += (this._w.x - vx) * DRAG * dt;
      vy += (this._w.y - vy) * DRAG * dt;
      vz += (this._w.z - vz) * DRAG * dt;
      vy -= FALL * dt;

      // ── flutter-tumble ─────────────────────────────────────────────────────
      // The leaf slips toward whichever way it is currently leaning. Driving
      // the sideforce off the tumble angle (rather than an independent sine)
      // is what makes the swing and the flip read as one motion.
      const ang = t * this.spin[i] + this.phase[i];
      const s = Math.sin(ang), c = Math.cos(ang);
      // Slip axis is horizontal and perpendicular to travel.
      const hs = Math.hypot(vx, vz) || 1;
      const nx = -vz / hs, nz = vx / hs;
      const slip = 2.2 * s * this.size[i] * 9.0;
      vx += nx * slip * dt;
      vz += nz * slip * dt;
      // Stall/recover: the leaf briefly hangs at the top of each flip.
      vy += 1.35 * c * c * dt;

      p[i3] = this._pos.x + vx * dt;
      p[i3 + 1] = this._pos.y + vy * dt;
      p[i3 + 2] = this._pos.z + vz * dt;
      v[i3] = vx; v[i3 + 1] = vy; v[i3 + 2] = vz;

      // ── attitude ───────────────────────────────────────────────────────────
      this._ax.set(axis[i3], axis[i3 + 1], axis[i3 + 2]);
      this._qt.fromArray(q, i * 4);
      // Spin rate rises with airspeed — a leaf caught in a gust whirls.
      this._dq.setFromAxisAngle(this._ax, this.spin[i] * (0.7 + hs * 0.12) * dt);
      this._qt.multiply(this._dq).normalize();
      this._qt.toArray(q, i * 4);

      // ── retire ─────────────────────────────────────────────────────────────
      this.age[i] += dt;
      const dx = p[i3] - cam.x, dz = p[i3 + 2] - cam.z;
      const landed = p[i3 + 1] <= this.ground.at(p[i3], p[i3 + 2]) + 0.05;
      if (landed || this.age[i] > this.life[i] || dx * dx + dz * dz > KILL2) {
        this.alive[i] = 0;
        this._m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this._m);
        continue;
      }

      // Scale-in over the first ~0.4 s. Cheaper and far less noticeable than
      // an alpha fade, which would cost a transparent pass.
      if (this.grow[i] < 1) this.grow[i] = Math.min(1, this.grow[i] + dt * 2.6);
      // ...and scale back out at the end of life so nothing ever blinks off.
      const fade = Math.min(1, (this.life[i] - this.age[i]) * 1.4);
      const sc = this.size[i] * this.grow[i] * fade;

      this._pos.set(p[i3], p[i3 + 1], p[i3 + 2]);
      this._scl.set(sc, sc, sc);
      this._m.compose(this._pos, this._qt, this._scl);
      this.mesh.setMatrixAt(i, this._m);
      live++;
    }

    // ── top up ───────────────────────────────────────────────────────────────
    // Rate-limited: a burst of 400 spawns in one frame is both a hitch and a
    // visible pop of leaves appearing together.
    let budget = Math.min(40, target - live);
    for (let i = 0; i < this.n && budget > 0; i++) {
      if (this.alive[i]) continue;
      this._spawn(i, cam, t);
      budget--;
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this._colorDirty && this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
      this._colorDirty = false;
    }
    this.liveCount = live;
  }

  dispose() {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.ctx.scene.remove(this.mesh);
    this.mesh = null;
  }
}
