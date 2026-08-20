// ─────────────────────────────────────────────────────────────────────────────
//  VehiclePhysics — Rapier chassis + raycast suspension + streamed terrain.
//
//  Two decisions worth explaining:
//
//  1. The ground collider is a *streamed heightfield* sampled straight from
//     world.getHeight(), not a mesh handed over by the Terrain system.  The
//     terrain renders at several LODs and swaps them as you drive; if physics
//     followed that, the ground would silently move under the wheels.  Sampling
//     the authoritative height function means the collider can never disagree
//     with what the player sees.
//
//  2. The patch is rebuilt incrementally (a few rows per frame) into a spare
//     buffer and swapped in when complete.  A 129² patch costs ~6 ms to sample
//     in one go, which is a visible hitch every few seconds otherwise.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { VEHICLE } from '../world/WorldConfig.js';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils.js';

const PATCH_SIZE = 176;       // metres across the collider patch
const PATCH_DIV = 128;        // cells; 1.375 m per cell — finer than the wheelbase
const REBUILD_AT = 46;        // metres of drift from the patch centre before rebuild
const ROWS_PER_FRAME = 14;    // incremental sampling budget

// Wheel-brake gain applied when the throttle is held against a reversing
// camper (see the drivetrain block in `step`).  The service brake runs at
// `brakeForce * 0.02`; this is deliberately a shade softer, because it fires
// without the player having asked for a brake and a cozy camper should settle
// onto its nose rather than stand on it.
const REV_BRAKE = 0.017;

// ── suspension geometry ─────────────────────────────────────────────────────
// Spring rate in Bullet/Rapier's per-unit-mass units.  Static sag is then
// g/4 / SPRING_K metres, which fixes the loaded ride height below.
const SPRING_K = 26.0;
const CONNECT_Y = 0.04;                                   // hard point, body local
const STATIC_SAG = 9.81 / 4 / SPRING_K;                   // ~0.094 m
const RIDE_HEIGHT = -CONNECT_Y + (VEHICLE.suspensionRest - STATIC_SAG) + VEHICLE.wheelRadius;

export const WHEELS = [
  { x: -1, z: +1, front: true },
  { x: +1, z: +1, front: true },
  { x: -1, z: -1, front: false },
  { x: +1, z: -1, front: false },
];

export class VehiclePhysics {
  constructor(world) {
    this.world = world;                    // WorldData
    this.ready = false;
    this.speed = 0;                        // signed forward speed, m/s
    this.wheels = [];
    this.waterDepth = 0;
    this.airborne = false;
    this.upDot = 1;

    this._tmp = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._accum = 0;
    this._invertedFor = 0;
    this._stuckFor = 0;
    this.recoveries = 0;
  }

  async init(startX, startZ, heading = 0) {
    await RAPIER.init();

    this.P = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.P.timestep = 1 / 120;

    // ── terrain patch ────────────────────────────────────────────────────────
    const n = PATCH_DIV + 1;
    this._heights = new Float32Array(n * n);
    this._scratch = new Float32Array(n * n);
    this._cell = PATCH_SIZE / PATCH_DIV;
    this._patchCX = startX;
    this._patchCZ = startZ;
    this._fillRow = n;                    // n == "no rebuild in progress"
    this._pendingCX = startX;
    this._pendingCZ = startZ;
    this._sampleAll(this._heights, startX, startZ);
    this._makeGround(startX, startZ, this._heights);

    // ── chassis ──────────────────────────────────────────────────────────────
    // Spawn at exactly the loaded ride height: dropping the camper in from a
    // metre up just makes the springs ring before the player ever sees it.
    const y = this.world.getHeight(startX, startZ) + RIDE_HEIGHT;
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(startX, y, startZ)
      .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
      .setLinearDamping(0.08)
      .setAngularDamping(0.55)
      .setCanSleep(false)
      // Roll inertia is deliberately inflated over the true box value: a real
      // 4x4 resists roll through its springs, which a rigid chassis does not.
      .setAdditionalMassProperties(
        VEHICLE.mass,
        { x: 0, y: VEHICLE.comHeight, z: 0 },
        { x: 3700, y: 3900, z: 2100 },
        { x: 0, y: 0, z: 0, w: 1 },
      );
    this.body = this.P.createRigidBody(bodyDesc);

    // Collider sits above the sill so it never scrapes on ordinary bumps; the
    // suspension rays do the ground work.
    const col = RAPIER.ColliderDesc.roundCuboid(0.86, 0.52, 2.18, 0.06)
      .setTranslation(0, 0.34, -0.02)
      .setDensity(0)
      .setFriction(0.35)
      .setRestitution(0.05);
    this.chassisCollider = this.P.createCollider(col, this.body);

    // ── raycast vehicle ──────────────────────────────────────────────────────
    this.vc = this.P.createVehicleController(this.body);
    this.vc.indexUpAxis = 1;
    this.vc.setIndexForwardAxis = 2;

    const conY = CONNECT_Y;
    for (const w of WHEELS) {
      this.vc.addWheel(
        { x: w.x * 0.93, y: conY, z: w.z * VEHICLE.wheelBase * 0.5 },
        { x: 0, y: -1, z: 0 },
        { x: -1, y: 0, z: 0 },
        VEHICLE.suspensionRest,
        VEHICLE.wheelRadius,
      );
    }
    // Rapier inherits Bullet's per-unit-mass spring units, so the damping that
    // gives a chosen ratio z is 2*z*sqrt(stiffness). Anything much under z=0.5
    // and the camper pogos off its own landing; the force clamp is what stops a
    // single hard bump turning into a launch.
    this.tuning = {
      stiffness: SPRING_K, zComp: 0.62, zRelax: 0.85,
      travel: 0.24, maxForce: VEHICLE.mass * 9.81 * 0.7,
    };
    for (let i = 0; i < WHEELS.length; i++) {
      this.vc.setWheelFrictionSlip(i, WHEELS[i].front ? 2.6 : 2.9);
      this.vc.setWheelSideFrictionStiffness(i, 0.72);
      this.wheels.push({
        ...WHEELS[i],
        pos: new THREE.Vector3(),
        contact: new THREE.Vector3(),
        grounded: false,
        compression: 0,
        spin: 0,
        steer: 0,
        slip: 0,
        load: 0,
      });
    }

    this.tune();
    this.velocity = new THREE.Vector3();
    this.steerAngle = 0;
    this.syncBasis();
    this.ready = true;
  }

  /** Refresh the cached body basis + velocity. Safe to call before the first step. */
  syncBasis() {
    const r = this.body.rotation();
    this._q.set(r.x, r.y, r.z, r.w);
    this._fwd.set(0, 0, 1).applyQuaternion(this._q);
    this._right.set(1, 0, 0).applyQuaternion(this._q);
    this._up.set(0, 1, 0).applyQuaternion(this._q);
    this.upDot = this._up.y;
    const lv = this.body.linvel();
    this.velocity.set(lv.x, lv.y, lv.z);
    this.speed = this.velocity.dot(this._fwd);
    this.lateral = this.velocity.dot(this._right);
  }

  /** Live suspension tuning hook (used by tools/drive.mjs sweeps). */
  tune(o = {}) {
    Object.assign(this.tuning, o);
    const t = this.tuning;
    for (let i = 0; i < 4; i++) {
      this.vc.setWheelSuspensionStiffness(i, t.stiffness);
      this.vc.setWheelSuspensionCompression(i, 2 * t.zComp * Math.sqrt(t.stiffness));
      this.vc.setWheelSuspensionRelaxation(i, 2 * t.zRelax * Math.sqrt(t.stiffness));
      this.vc.setWheelMaxSuspensionTravel(i, t.travel);
      this.vc.setWheelMaxSuspensionForce(i, t.maxForce);
    }
    return t;
  }

  // ── terrain patch ─────────────────────────────────────────────────────────
  _sampleAll(buf, cx, cz) {
    const n = PATCH_DIV + 1;
    for (let i = 0; i < n; i++) this._sampleRow(buf, cx, cz, i);
  }

  /** Row i runs along +X at a fixed Z. Heights are stored column-major. */
  _sampleRow(buf, cx, cz, i) {
    const n = PATCH_DIV + 1;
    const h = PATCH_SIZE * 0.5;
    const z = cz - h + i * this._cell;
    const W = this.world;
    for (let j = 0; j < n; j++) {
      const x = cx - h + j * this._cell;
      // Column-major (i = row = Z, j = column = X) matches Rapier's DMatrix.
      buf[i + j * n] = W.getHeight(x, z);
    }
  }

  /**
   * The height of the *collider* at (x, z), which is not `world.getHeight`.
   *
   * The patch is a 1.375 m grid sampled from `getHeight`, so between samples
   * the surface the wheels actually touch is a straight line across whatever
   * the terrain does in between — below the rendered ground over a convex
   * cell, above it over a concave one. `Vehicle._groundSettle` already covers
   * the cosmetic half of that; this covers the half that matters to physics.
   *
   * In this world the two agree to under a millimetre at the sampled points —
   * measured, after this was written on the assumption that they would not —
   * so this is belt and braces rather than a fix for anything observed. It is
   * kept because the assumption it removes is the kind that quietly becomes
   * true later: a finer heightfield, a rougher terrain octave, or a coarser
   * PATCH_DIV would all open the gap, and a body placed into one arrives
   * falling.
   */
  _patchHeight(x, z) {
    const n = PATCH_DIV + 1;
    const h = PATCH_SIZE * 0.5;
    const fx = (x - (this._patchCX - h)) / this._cell;
    const fz = (z - (this._patchCZ - h)) / this._cell;
    const j0 = clamp(Math.floor(fx), 0, n - 2);
    const i0 = clamp(Math.floor(fz), 0, n - 2);
    const tx = clamp(fx - j0, 0, 1), tz = clamp(fz - i0, 0, 1);
    const H = this._heights;
    // Column-major, matching `_sampleRow`.
    const a = lerp(H[i0 + j0 * n], H[i0 + (j0 + 1) * n], tx);
    const b = lerp(H[(i0 + 1) + j0 * n], H[(i0 + 1) + (j0 + 1) * n], tx);
    return lerp(a, b, tz);
  }

  _makeGround(cx, cz, heights) {
    if (this.groundCollider) this.P.removeCollider(this.groundCollider, false);
    if (!this.groundBody) {
      this.groundBody = this.P.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    }
    this.groundBody.setTranslation({ x: cx, y: 0, z: cz }, false);
    const desc = RAPIER.ColliderDesc
      .heightfield(PATCH_DIV, PATCH_DIV, heights, { x: PATCH_SIZE, y: 1, z: PATCH_SIZE })
      .setFriction(1.0)
      .setRestitution(0.0);
    this.groundCollider = this.P.createCollider(desc, this.groundBody);
    this._patchCX = cx;
    this._patchCZ = cz;
  }

  _streamGround(x, z) {
    const n = PATCH_DIV + 1;
    if (this._fillRow >= n) {
      const dx = x - this._patchCX, dz = z - this._patchCZ;
      if (dx * dx + dz * dz > REBUILD_AT * REBUILD_AT) {
        this._pendingCX = x; this._pendingCZ = z; this._fillRow = 0;
      }
      return;
    }
    const end = Math.min(n, this._fillRow + ROWS_PER_FRAME);
    for (let i = this._fillRow; i < end; i++) {
      this._sampleRow(this._scratch, this._pendingCX, this._pendingCZ, i);
    }
    this._fillRow = end;
    if (this._fillRow >= n) {
      const swap = this._heights;
      this._heights = this._scratch;
      this._scratch = swap;
      this._makeGround(this._pendingCX, this._pendingCZ, this._heights);
    }
  }

  // ── control ───────────────────────────────────────────────────────────────
  /**
   * @param ctrl {steer, throttle, brake, handbrake} all 0..1 (steer -1..1)
   */
  step(dt, ctrl) {
    if (!this.ready) return;

    const t = this.body.translation();
    this._streamGround(t.x, t.z);

    // Cache the basis once per frame.
    this.syncBasis();
    // Rapier keeps user forces until they are explicitly cleared, so every
    // addForce/addTorque below must start from zero or it compounds each frame.
    this.body.resetForces(false);
    this.body.resetTorques(false);
    const absSpeed = Math.abs(this.speed);

    // ── water ───────────────────────────────────────────────────────────────
    const depth = this.world.getWaterDepth(t.x, t.z);
    this.waterDepth = depth;
    const wade = clamp01(depth / 1.25);

    // ── steering: speed-sensitive, so it is quick at walking pace and calm at
    //    speed, which is what makes an off-roader feel planted rather than
    //    twitchy.  Rate-limited for a bit of steering-box lag.
    const steerLimit = VEHICLE.maxSteer * lerp(1.0, 0.42, smoothstep(3, 22, absSpeed));
    const targetSteer = ctrl.steer * steerLimit;
    const rate = 3.6 * dt * lerp(1.0, 0.55, smoothstep(4, 20, absSpeed));
    this.steerAngle = this.steerAngle ?? 0;
    this.steerAngle += clamp(targetSteer - this.steerAngle, -rate, rate);
    // self-centring when the player lets go
    if (Math.abs(ctrl.steer) < 0.05) this.steerAngle *= Math.pow(0.02, dt);

    // ── drivetrain ──────────────────────────────────────────────────────────
    const reversing = ctrl.brake > 0.05 && this.speed < 0.7;
    const maxSpeed = 24;
    const fade = 1 - smoothstep(maxSpeed * 0.72, maxSpeed, absSpeed);
    const waterFade = 1 - wade * 0.55;
    let engine = 0, brake = 0;

    // ── which way are we actually travelling? ────────────────────────────────
    // 0 while rolling forwards or standing still, 1 once genuinely reversing at
    // 1.6 m/s.  A pedal pressed *against* this is a request to stop, not a
    // request for thrust — see the brake block below.  It is a ramp rather than
    // a test so the hand-over is a crossfade: right at the reversal point the
    // wheels are part braking and part driving, which is what stops the change
    // of direction reading as a jolt.
    const backward = clamp01((-this.speed - 0.25) / 1.35);

    if (ctrl.throttle > 0.02) {
      // ── low-range crawl ───────────────────────────────────────────────────
      // Standing in for a first gear: extra torque from rest, gone by ~9 m/s.
      // Without it the extra power only shows up as wheelspin on the flat,
      // which is the opposite of what a hill needs.
      const crawl = 1 + 0.55 * (1 - smoothstep(1.0, 9.0, absSpeed));

      // ── grade assist ──────────────────────────────────────────────────────
      // How much of the camper's own forward axis points uphill. On the flat
      // this is 0 and changes nothing; pointed up a 35-degree slope it is ~0.57
      // and adds most of the gravity component straight back. That is what
      // makes it *climb* rather than merely being faster everywhere — a cozy
      // game should not punish the player for pointing at an interesting hill.
      const grade = clamp(this._fwd.y, 0, 1);
      const assist = 1 + 1.15 * grade;

      engine = ctrl.throttle * VEHICLE.engineForce
             * (0.45 + 0.55 * fade) * waterFade * crawl * assist * (1 - backward);
    } else if (reversing) {
      engine = -ctrl.brake * VEHICLE.engineForce * 0.42 * waterFade;
    }
    if (ctrl.brake > 0.02 && this.speed > 0.7) brake = ctrl.brake * VEHICLE.brakeForce * 0.02;
    // ── forward pedal while still rolling backwards ─────────────────────────
    // This used to do *nothing at all*: the drive branch was gated on
    // `this.speed > -0.4`, and the service brake on `this.speed > 0.7`, so
    // between those two the throttle neither drove nor braked.  Backing out of
    // a ditch at 5 m/s and asking to go forwards left the player coasting on
    // linear damping alone — 5.5 seconds of nothing, which is why it read as
    // sticky and why they were braking by hand first.  A real car's brake pedal
    // does this for you; here the accelerator has to, because it is the only
    // "forwards" the player has.  Scaled by `backward` so it lets go smoothly
    // as the camper arrives at rest rather than slamming into the stop.
    if (ctrl.throttle > 0.02 && backward > 0) {
      brake = Math.max(brake, ctrl.throttle * VEHICLE.brakeForce * REV_BRAKE * backward);
    }
    if (ctrl.throttle < 0.02 && ctrl.brake < 0.02) brake = 220 * 0.02;   // engine braking

    // Anything above engine braking is the player actually slowing down, and
    // the tail lamps should say so — including the throttle-as-brake case
    // above, which is otherwise the one time the camper stops with no light on.
    this.braking = brake > 60;

    // ── park brake ──────────────────────────────────────────────────────────
    // Set after a rescue and released the moment the player touches a control.
    // Without it a rescue is only half of what was asked for: the camper is put
    // somewhere fine and then freewheels off it, because the only thing holding
    // it on a hill is the 4.4 of engine braking. Measured over 24 rescues with
    // no input at all, on ground whose worst footprint slope was under 0.5, the
    // median landing rolled 3.0 m in three seconds and the worst rolled 7.2 —
    // several of them into water the site check had specifically avoided.
    // Gravity down a 0.3 gradient is 2.7 m/s²; nothing in the drivetrain was
    // ever going to argue with that.
    if (ctrl.park) {
      engine = 0;
      brake = Math.max(brake, VEHICLE.brakeForce * 0.06);
      this.braking = false;      // parked is not braking; no tail lamps for it
    }
    this.parked = !!ctrl.park;

    const hb = ctrl.handbrake > 0.5;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      // permanent 4WD, biased rearward so it rotates rather than pushes
      const bias = w.front ? 0.42 : 0.58;
      this.vc.setWheelEngineForce(i, engine * bias * 0.5);
      this.vc.setWheelSteering(i, w.front ? this.steerAngle : -this.steerAngle * 0.06);
      let b = brake * (w.front ? 0.58 : 0.42);
      if (hb && !w.front) b = Math.max(b, 340);
      this.vc.setWheelBrake(i, b);

      // Grip: falls off in deep water and rises with load; the handbrake
      // deliberately kills the rear so the tail steps out in a controllable way.
      let slip = w.front ? 2.6 : 2.9;
      slip *= lerp(1.0, 0.55, wade);
      if (hb && !w.front) slip *= 0.30;
      this.vc.setWheelFrictionSlip(i, slip);
      this.vc.setWheelSideFrictionStiffness(i, (hb && !w.front) ? 0.22 : 0.72);
    }

    // ── water drag + buoyancy ───────────────────────────────────────────────
    if (depth > 0.05) {
      const k = wade * wade;
      const drag = 1400 * k;
      this.body.addForce({
        x: -this.velocity.x * drag * 0.06,
        y: 0,
        z: -this.velocity.z * drag * 0.06,
      }, true);
      // partial float: takes weight off the wheels so it wallows, never sinks
      this.body.addForce({ x: 0, y: VEHICLE.mass * 9.81 * 0.30 * k, z: 0 }, true);
    }

    // ── anti-roll: a cheap sway bar, applied as a torque proportional to the
    //    left/right suspension difference.  Without it the tall body tips over
    //    on any camber, which is miserable in a cozy game. ───────────────────
    let rollTorque = 0;
    for (const [l, r2] of [[0, 1], [2, 3]]) {
      const cl = this.vc.wheelSuspensionLength(l) ?? VEHICLE.suspensionRest;
      const cr = this.vc.wheelSuspensionLength(r2) ?? VEHICLE.suspensionRest;
      const gl = this.vc.wheelIsInContact(l), gr = this.vc.wheelIsInContact(r2);
      if (gl || gr) rollTorque += clamp((cl - cr), -0.3, 0.3) * 15000;
    }
    if (rollTorque) {
      const axis = this._fwd;
      this.body.addTorque({ x: axis.x * rollTorque, y: axis.y * rollTorque, z: axis.z * rollTorque }, true);
    }

    // ── airborne attitude control: nose the vehicle back to level so a jump
    //    lands on its wheels.  Forgiving, not simulation-accurate. ───────────
    let grounded = 0;
    for (let i = 0; i < 4; i++) if (this.vc.wheelIsInContact(i)) grounded++;
    this.airborne = grounded === 0;
    if (this.airborne) {
      const av = this.body.angvel();
      const corr = new THREE.Vector3().crossVectors(this._up, new THREE.Vector3(0, 1, 0));
      const k = VEHICLE.mass * 1.5;
      this.body.addTorque({
        x: corr.x * k - av.x * VEHICLE.mass * 0.28,
        y: -av.y * VEHICLE.mass * 0.05,
        z: corr.z * k - av.z * VEHICLE.mass * 0.28,
      }, true);
    }

    // ── fixed-step integration ──────────────────────────────────────────────
    // The substep cap matches the dt clamp exactly (12 x 1/120 = 0.1 s) so the
    // simulation never silently runs in slow motion on a slow frame — which is
    // precisely what a headless capture is.
    this._accum += Math.min(dt, 0.1);
    let steps = 0;
    while (this._accum >= this.P.timestep && steps < 12) {
      this.vc.updateVehicle(this.P.timestep, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
      this.P.step();
      this._accum -= this.P.timestep;
      steps++;
    }
    if (steps === 12) this._accum = 0;

    this._readWheels(dt);
    this._recover(dt, ctrl);
    this._guardNaN();
  }

  _readWheels(dt) {
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const hp = this.vc.wheelHardPoint(i);
      const len = this.vc.wheelSuspensionLength(i) ?? VEHICLE.suspensionRest;
      w.grounded = this.vc.wheelIsInContact(i);
      w.compression = clamp01((VEHICLE.suspensionRest - len) / VEHICLE.suspensionRest);
      w.load = Math.abs(this.vc.wheelSuspensionForce(i) ?? 0);
      w.steer = this.vc.wheelSteering(i) ?? 0;
      w.spin = this.vc.wheelRotation(i) ?? 0;
      const fi = this.vc.wheelForwardImpulse(i) ?? 0;
      const si = this.vc.wheelSideImpulse(i) ?? 0;
      w.slip = clamp01((Math.abs(fi) * 0.0016 + Math.abs(si) * 0.0022));
      if (hp) {
        w.pos.set(hp.x, hp.y, hp.z).addScaledVector(this._up, -len);
        const cp = this.vc.wheelContactPoint(i);
        if (cp) w.contact.set(cp.x, cp.y, cp.z);
        else w.contact.copy(w.pos).addScaledVector(this._up, -VEHICLE.wheelRadius);
      }
      void dt;
    }
  }

  /** Auto-right on the roof, and unstick if the throttle is doing nothing. */
  _recover(dt, ctrl) {
    const t = this.body.translation();
    const inverted = this.upDot < 0.18;
    this._invertedFor = inverted ? this._invertedFor + dt : 0;

    const trying = ctrl.throttle > 0.4 || ctrl.brake > 0.4;
    const crawling = Math.abs(this.speed) < 0.45;
    this._stuckFor = (trying && crawling && !this.airborne) ? this._stuckFor + dt : 0;

    // Below the terrain means a tunnelling failure — put it straight back.
    const ground = this.world.getHeight(t.x, t.z);
    const buried = t.y < ground - 1.6;

    if (this._invertedFor > 1.6 || this._stuckFor > 4.5 || buried) {
      this.righting = 1;
      this._invertedFor = 0;
      this._stuckFor = 0;
      this.recoveries++;
      const yaw = Math.atan2(this._fwd.x, this._fwd.z);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
      this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      this.body.setTranslation({ x: t.x, y: ground + RIDE_HEIGHT + 0.15, z: t.z }, true);
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    } else {
      this.righting = Math.max(0, (this.righting ?? 0) - dt * 2);
    }
  }

  _guardNaN() {
    const t = this.body.translation();
    if (Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z)) return;
    const x = this._patchCX, z = this._patchCZ;
    this.body.setTranslation({ x, y: this.world.getHeight(x, z) + RIDE_HEIGHT + 0.1, z }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.nanEvents = (this.nanEvents ?? 0) + 1;
  }

  teleport(x, z, heading = 0) {
    if (!this.ready) return;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    // Ground first, then place on it: the body has to be set against the patch
    // it is about to stand on, not the one it is leaving. Height comes off the
    // collider rather than `world.getHeight` — see `_patchHeight`.
    this._sampleAll(this._heights, x, z);
    this._makeGround(x, z, this._heights);
    this._fillRow = PATCH_DIV + 1;
    const y = this._patchHeight(x, z) + RIDE_HEIGHT + 0.02;
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    // The accumulator can be holding most of a timestep from the frame that is
    // being interrupted; spending it on the frame after a teleport steps the
    // new pose forward before anything has been read from it.
    this._accum = 0;
    this.syncBasis();
  }

  dispose() {
    this.P?.free();
    this.P = null;
    this.ready = false;
  }
}
