// ─────────────────────────────────────────────────────────────────────────────
//  CameraRig — chase / photo-orbit / cockpit.
//
//  The chase camera is the single thing the player looks through for hours, so
//  it is built like a camera operator rather than a boom arm:
//
//   · it follows a *damped* heading, not the instantaneous one, so the world
//     swings through frame on a turn instead of snapping;
//   · it aims at a look-ahead point that leads the vehicle into the corner;
//   · distance, height and FOV all open up with speed, which is most of the
//     sensation of going fast;
//   · it samples the terrain along its own boom and lifts over anything in the
//     way, so it never buries itself in a hillside.
//
//  All of it is frame-rate independent exponential damping (`damp`), never
//  `lerp(a, b, 0.1)` — that would change feel with framerate.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { clamp, clamp01, lerp, smoothstep, damp, dampAngle, wrapAngle } from '../core/MathUtils.js';

const MODES = ['chase', 'orbit', 'cockpit'];

export class CameraRig extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'CameraRig';
    this.active = false;
    this.mode = 'chase';

    this.camPos = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.followYaw = 0;
    this.fov = 52;
    this.roll = 0;
    this.orbitAngle = 0.7;
    this._up = new THREE.Vector3(0, 1, 0);
    this._t = new THREE.Vector3();
    this._t2 = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._primed = false;
    this._shake = 0;
  }

  async init() {
    this.vehicle = this.ctx.systems.vehicle;
  }

  lateUpdate(dt) {
    const v = this.vehicle ?? this.ctx.systems.vehicle;
    if (!v?.phys?.ready) return;
    this.vehicle = v;

    if (this.ctx.input.justPressed('KeyC')) {
      this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
      if (this.mode === 'cockpit') this._primed = false;
    }
    // The capture harness poses the camera itself; do not fight it.
    this.active = true;
    if (window.__forceCamera) { this._primed = false; return; }

    dt = Math.min(dt, 1 / 20);
    if (this.mode === 'chase') this._chase(dt, v);
    else if (this.mode === 'orbit') this._orbit(dt, v);
    else this._cockpit(dt, v);
  }

  // ── shared: keep a point clear of the ground ──────────────────────────────
  _clearGround(p, clearance) {
    const w = this.ctx.world;
    const h = w.getHeight(p.x, p.z);
    const wh = w.getWaterHeight(p.x, p.z);
    const floor = Math.max(h, wh ?? -1e9) + clearance;
    if (p.y < floor) p.y = floor;
    return p;
  }

  _chase(dt, v) {
    const speed = Math.abs(v.speed);
    const fast = smoothstep(2, 21, speed);

    // ── boom geometry ───────────────────────────────────────────────────────
    const dist = lerp(7.4, 10.4, fast);
    const height = lerp(2.75, 3.35, fast);

    // Follow a damped heading. Reversing keeps the camera behind the *nose*,
    // which is what players expect when backing out of a ditch.
    const targetYaw = v.heading;
    this.followYaw = dampAngle(this.followYaw, targetYaw, lerp(1.9, 3.6, fast), dt);
    // ...but let the tail slide: blend a little of the velocity direction in so
    // a drift shows the flank of the camper rather than its number plate.
    let slideYaw = this.followYaw;
    if (speed > 4) {
      const vy = Math.atan2(v.velocity.x, v.velocity.z);
      const d = wrapAngle(vy - v.heading);
      if (Math.abs(d) < 1.4) slideYaw = this.followYaw + d * 0.35;
    }

    const anchor = this._t.copy(v.position).addScaledVector(this._up, 1.05);

    const desired = this._t2.set(
      anchor.x - Math.sin(slideYaw) * dist,
      anchor.y + height,
      anchor.z - Math.cos(slideYaw) * dist,
    );

    if (!this._primed) { this.camPos.copy(desired); this._primed = true; }

    // Horizontal follow is looser than vertical: a soft trailing camera that
    // still refuses to drop into the terrain.
    this.camPos.x = damp(this.camPos.x, desired.x, lerp(3.0, 5.0, fast), dt);
    this.camPos.z = damp(this.camPos.z, desired.z, lerp(3.0, 5.0, fast), dt);
    this.camPos.y = damp(this.camPos.y, desired.y, 5.4, dt);

    // ── terrain clearance along the boom ────────────────────────────────────
    const w = this.ctx.world;
    let need = -1e9;
    for (let i = 1; i <= 5; i++) {
      const t = i / 5;
      const sx = lerp(anchor.x, this.camPos.x, t);
      const sz = lerp(anchor.z, this.camPos.z, t);
      need = Math.max(need, w.getHeight(sx, sz) + lerp(0.6, 1.7, t));
    }
    if (this.camPos.y < need) this.camPos.y = damp(this.camPos.y, need, 22, dt);
    this._clearGround(this.camPos, 1.4);

    // ── look-ahead ─────────────────────────────────────────────────────────
    const lead = lerp(3.0, 9.5, fast);
    const target = this._t2.copy(anchor)
      .addScaledVector(v.forward, lead)
      .addScaledVector(v.right, -(v.phys.steerAngle ?? 0) * lerp(2.0, 9.0, fast))
      .addScaledVector(this._up, lerp(0.35, -0.15, fast));
    this.lookAt.x = damp(this.lookAt.x, target.x, 6.5, dt);
    this.lookAt.y = damp(this.lookAt.y, target.y, 5.0, dt);
    this.lookAt.z = damp(this.lookAt.z, target.z, 6.5, dt);

    // ── grade: FOV opens, a hint of roll, and a shake on hard landings ──────
    this.fov = damp(this.fov, lerp(50, 63, fast), 3.2, dt);
    const bank = clamp((v.phys.lateral ?? 0) * -0.006, -0.045, 0.045);
    this.roll = damp(this.roll, bank, 4.0, dt);

    const land = v.wheels.filter((wl) => wl.grounded).length;
    if (v._wasAirborne && land >= 3) this._shake = Math.min(0.4, Math.abs(v.velocity.y) * 0.035);
    v._wasAirborne = v.phys.airborne;
    this._shake = damp(this._shake, 0, 6, dt);

    this._apply(dt);
  }

  _orbit(dt, v) {
    this.orbitAngle += dt * 0.14;
    const r = 9.6, h = 3.0;
    const anchor = this._t.copy(v.position).addScaledVector(this._up, 1.0);
    const desired = this._t2.set(
      anchor.x + Math.sin(this.orbitAngle) * r,
      anchor.y + h,
      anchor.z + Math.cos(this.orbitAngle) * r,
    );
    if (!this._primed) { this.camPos.copy(desired); this._primed = true; }
    this.camPos.x = damp(this.camPos.x, desired.x, 4.0, dt);
    this.camPos.y = damp(this.camPos.y, desired.y, 4.0, dt);
    this.camPos.z = damp(this.camPos.z, desired.z, 4.0, dt);
    this._clearGround(this.camPos, 1.3);
    this.lookAt.lerp(anchor, 1 - Math.exp(-6 * dt));
    this.fov = damp(this.fov, 44, 3, dt);
    this.roll = damp(this.roll, 0, 4, dt);
    this._apply(dt);
  }

  _cockpit(dt, v) {
    // Driver's eye, right-hand drive to match the modelled steering wheel.
    this._t.set(0.42, 0.80, 0.30).applyQuaternion(v.quaternion).add(v.position);
    if (!this._primed) { this.camPos.copy(this._t); this._primed = true; }
    this.camPos.copy(this._t);

    const bob = Math.sin(performance.now() * 0.004) * 0.006 * clamp01(Math.abs(v.speed) / 8);
    this.camPos.y += bob;

    const look = this._t2.copy(v.position)
      .addScaledVector(v.forward, 22)
      .addScaledVector(v.right, -(v.phys.steerAngle ?? 0) * 9)
      .addScaledVector(v.up, 1.2);
    this.lookAt.x = damp(this.lookAt.x, look.x, 9, dt);
    this.lookAt.y = damp(this.lookAt.y, look.y, 9, dt);
    this.lookAt.z = damp(this.lookAt.z, look.z, 9, dt);
    this.fov = damp(this.fov, 66, 4, dt);
    this.roll = damp(this.roll, 0, 5, dt);
    this._apply(dt);
  }

  _apply(dt) {
    const cam = this.ctx.camera;
    cam.position.copy(this.camPos);
    if (this._shake > 0.001) {
      const t = performance.now() * 0.001;
      cam.position.y += Math.sin(t * 58) * this._shake * 0.1;
      cam.position.x += Math.sin(t * 47 + 1.3) * this._shake * 0.06;
    }
    this._m.lookAt(cam.position, this.lookAt, this._up);
    this._q.setFromRotationMatrix(this._m);
    if (this.roll) {
      this._t.set(0, 0, -1).applyQuaternion(this._q);
      this._q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.roll));
    }
    cam.quaternion.copy(this._q);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    void dt;
  }

  dispose() { this.active = false; }
}
