// ─────────────────────────────────────────────────────────────────────────────
//  CameraRig — chase / photo-orbit / cockpit.
//
//  The chase camera is the single thing the player looks through for hours, so
//  it is built like a camera operator rather than a boom arm:
//
//   · it follows a *damped* heading, not the instantaneous one, so the world
//     swings through frame on a turn instead of snapping;
//   · it aims at a look-ahead point that leads the vehicle into the corner;
//   · height and FOV open up with speed, which is most of the sensation of
//     going fast;
//   · drag the mouse to orbit and roll the wheel to zoom, over a range that
//     goes from "admire the paintwork" to "frame the whole valley";
//   · a manual orbit eases back to trailing once you stop touching it — but
//     only while actually moving, so a parked player can look around freely;
//   · it samples the terrain along its own boom and lifts over anything in the
//     way, at every orbit angle and every zoom level.
//
//  All of it is frame-rate independent exponential damping (`damp`), never
//  `lerp(a, b, 0.1)` — that would change feel with framerate.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { clamp, clamp01, lerp, smoothstep, damp, dampAngle, wrapAngle } from '../core/MathUtils.js';

const MODES = ['chase', 'orbit', 'cockpit'];

// Boom length limits. The low end lets you inspect the roof rack; the high end
// is what the reference vista plates are shot at.
const ZOOM_MIN = 4.5;
const ZOOM_MAX = 52;
const ZOOM_DEFAULT = 12.5;
const PITCH_DEFAULT = 0.30;      // radians above the horizon
const PITCH_MIN = -0.16;         // just under the sill, looking up
const PITCH_MAX = 1.28;          // near-vertical, looking straight down
const RECENTER_DELAY = 2.0;      // seconds of no mouse before easing back

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

    // free-look state
    this.zoom = ZOOM_DEFAULT;
    this.orbitYaw = 0;             // offset from the trailing direction
    this.orbitPitch = PITCH_DEFAULT;
    this._idle = 99;               // seconds since the player last touched it

    this.orbitAngle = 0.7;         // photo mode's own slow sweep
    this._up = new THREE.Vector3(0, 1, 0);
    this._t = new THREE.Vector3();
    this._t2 = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._qr = new THREE.Quaternion();
    this._axis = new THREE.Vector3(0, 0, 1);
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
    this._readLook(dt, v);
    if (this.mode === 'chase') this._chase(dt, v);
    else if (this.mode === 'orbit') this._orbit(dt, v);
    else this._cockpit(dt, v);
  }

  /**
   * Mouse orbit + wheel zoom.  Drag rather than pointer lock: this is a cozy
   * game, and grabbing the cursor for a camera you only nudge occasionally is
   * hostile.  Gamepad right stick feeds in through input.axes.look*.
   */
  _readLook(dt, v) {
    const input = this.ctx.input;
    const m = input.mouse;
    let touched = false;

    if (m.down && (m.dx || m.dy)) {
      this.orbitYaw = wrapAngle(this.orbitYaw - m.dx * 0.0042);
      this.orbitPitch = clamp(this.orbitPitch + m.dy * 0.0032, PITCH_MIN, PITCH_MAX);
      touched = true;
    }
    const ax = input.axes;
    if (ax.lookX || ax.lookY) {
      this.orbitYaw = wrapAngle(this.orbitYaw - ax.lookX * 1.6 * dt);
      this.orbitPitch = clamp(this.orbitPitch + ax.lookY * 1.1 * dt, PITCH_MIN, PITCH_MAX);
      ax.lookX = 0; ax.lookY = 0;
      touched = true;
    }
    if (m.wheel) {
      // Multiplicative so a notch feels the same close-in and far out.
      this.zoom = clamp(this.zoom * Math.exp(m.wheel * 0.0011), ZOOM_MIN, ZOOM_MAX);
      touched = true;
    }

    this._idle = touched ? 0 : this._idle + dt;

    // Ease back behind the camper — but only when it is actually going
    // somewhere. Parked, the player is sightseeing; leave their framing alone.
    const moving = Math.abs(v.speed) > 1.6;
    if (moving && this._idle > RECENTER_DELAY) {
      const k = smoothstep(RECENTER_DELAY, RECENTER_DELAY + 1.2, this._idle) * 1.5;
      this.orbitYaw = dampAngle(this.orbitYaw, 0, k, dt);
      this.orbitPitch = damp(this.orbitPitch, PITCH_DEFAULT, k, dt);
    }
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

  /**
   * Lift the camera over anything between it and the camper. Sampling the boom
   * (rather than a single point under the camera) is what stops a ridge between
   * the two from cutting the vehicle out of frame — and it matters far more at
   * full zoom-out, where the boom can be 50 m of hillside.
   */
  _clearBoom(anchor, dt) {
    const w = this.ctx.world;
    const steps = this.zoom > 20 ? 9 : 5;
    let need = -1e9;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const sx = lerp(anchor.x, this.camPos.x, t);
      const sz = lerp(anchor.z, this.camPos.z, t);
      need = Math.max(need, w.getHeight(sx, sz) + lerp(0.7, 2.2, t));
    }
    if (this.camPos.y < need) this.camPos.y = damp(this.camPos.y, need, 22, dt);
    this._clearGround(this.camPos, 1.5);
  }

  _chase(dt, v) {
    const speed = Math.abs(v.speed);
    const fast = smoothstep(2, 21, speed);
    const wide = clamp01((this.zoom - 14) / (ZOOM_MAX - 14));

    // Follow a damped heading. Reversing keeps the camera behind the *nose*,
    // which is what players expect when backing out of a ditch.
    this.followYaw = dampAngle(this.followYaw, v.heading, lerp(1.9, 3.6, fast), dt);
    // ...but let the tail slide: blend a little of the velocity direction in so
    // a drift shows the flank of the camper rather than its number plate.
    let slideYaw = this.followYaw;
    if (speed > 4) {
      const vy = Math.atan2(v.velocity.x, v.velocity.z);
      const d = wrapAngle(vy - v.heading);
      if (Math.abs(d) < 1.4) slideYaw = this.followYaw + d * 0.35;
    }

    const anchor = this._t.copy(v.position).addScaledVector(this._up, 1.05 + wide * 1.2);

    // Spherical boom: yaw around the camper, pitch above the horizon.
    const yaw = slideYaw + this.orbitYaw;
    const dist = this.zoom * lerp(1.0, 1.10, fast);
    const cp = Math.cos(this.orbitPitch), sp = Math.sin(this.orbitPitch);
    const desired = this._t2.set(
      anchor.x - Math.sin(yaw) * dist * cp,
      anchor.y + dist * sp,
      anchor.z - Math.cos(yaw) * dist * cp,
    );

    if (!this._primed) { this.camPos.copy(desired); this._primed = true; }

    // While the player is dragging, track hard so the camera feels attached to
    // the mouse; otherwise trail softly.
    const grab = this._idle < 0.15 ? 16 : lerp(3.0, 5.0, fast);
    this.camPos.x = damp(this.camPos.x, desired.x, grab, dt);
    this.camPos.z = damp(this.camPos.z, desired.z, grab, dt);
    this.camPos.y = damp(this.camPos.y, desired.y, Math.max(grab, 5.4), dt);

    this._clearBoom(anchor, dt);

    // ── look-ahead: strong close in, almost none when zoomed way out (there,
    //    leading the vehicle just pushes it out of a very wide frame) ───────
    const lead = lerp(3.0, 9.5, fast) * (1 - wide * 0.85);
    const target = this._t2.copy(anchor)
      .addScaledVector(v.forward, lead)
      .addScaledVector(v.right, -(v.phys.steerAngle ?? 0) * lerp(2.0, 9.0, fast) * (1 - wide))
      .addScaledVector(this._up, lerp(0.35, -0.15, fast));
    this.lookAt.x = damp(this.lookAt.x, target.x, 6.5, dt);
    this.lookAt.y = damp(this.lookAt.y, target.y, 5.0, dt);
    this.lookAt.z = damp(this.lookAt.z, target.z, 6.5, dt);

    // ── grade: FOV opens with speed, a hint of roll, a shake on hard landings
    this.fov = damp(this.fov, lerp(50, 62, fast) - wide * 6, 3.2, dt);
    const bank = clamp((v.phys.lateral ?? 0) * -0.006, -0.045, 0.045) * (1 - wide);
    this.roll = damp(this.roll, bank, 4.0, dt);

    const landed = v.wheels.filter((wl) => wl.grounded).length >= 3;
    if (v._wasAirborne && landed) this._shake = Math.min(0.4, Math.abs(v.velocity.y) * 0.035);
    v._wasAirborne = v.phys.airborne;
    this._shake = damp(this._shake, 0, 6, dt);

    this._apply();
  }

  /** Photo mode: a slow sweep at whatever distance the player has dialled in. */
  _orbit(dt, v) {
    this.orbitAngle += dt * 0.11;
    const r = clamp(this.zoom, 6, ZOOM_MAX);
    const cp = Math.cos(this.orbitPitch), sp = Math.sin(this.orbitPitch);
    const anchor = this._t.copy(v.position).addScaledVector(this._up, 1.0 + r * 0.05);
    const a = this.orbitAngle + this.orbitYaw;
    const desired = this._t2.set(
      anchor.x + Math.sin(a) * r * cp,
      anchor.y + r * sp,
      anchor.z + Math.cos(a) * r * cp,
    );
    if (!this._primed) { this.camPos.copy(desired); this._primed = true; }
    const k = this._idle < 0.15 ? 16 : 4.0;
    this.camPos.x = damp(this.camPos.x, desired.x, k, dt);
    this.camPos.y = damp(this.camPos.y, desired.y, k, dt);
    this.camPos.z = damp(this.camPos.z, desired.z, k, dt);
    this._clearBoom(anchor, dt);
    this.lookAt.lerp(anchor, 1 - Math.exp(-6 * dt));
    this.fov = damp(this.fov, 46, 3, dt);
    this.roll = damp(this.roll, 0, 4, dt);
    this._apply();
  }

  _cockpit(dt, v) {
    // Driver's eye, right-hand drive to match the modelled steering wheel.
    this._t.set(0.42, 0.86, 0.34).applyQuaternion(v.quaternion).add(v.position);
    if (!this._primed) { this.camPos.copy(this._t); this._primed = true; }
    this.camPos.copy(this._t);
    this.camPos.y += Math.sin(performance.now() * 0.004) * 0.006 * clamp01(Math.abs(v.speed) / 8);

    // Mouse look works here too — glance out of the side window at the view.
    const cy = Math.cos(this.orbitYaw), sy = Math.sin(this.orbitYaw);
    const fx = v.forward.x * cy - v.right.x * sy;
    const fz = v.forward.z * cy - v.right.z * sy;
    const look = this._t2.set(
      this.camPos.x + fx * 22,
      this.camPos.y + 22 * Math.tan(clamp(this.orbitPitch - PITCH_DEFAULT, -0.5, 0.5)) - 1.0,
      this.camPos.z + fz * 22,
    ).addScaledVector(v.right, -(v.phys.steerAngle ?? 0) * 9);
    this.lookAt.x = damp(this.lookAt.x, look.x, 9, dt);
    this.lookAt.y = damp(this.lookAt.y, look.y, 9, dt);
    this.lookAt.z = damp(this.lookAt.z, look.z, 9, dt);
    this.fov = damp(this.fov, 66, 4, dt);
    this.roll = damp(this.roll, 0, 5, dt);
    this._apply();
  }

  _apply() {
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
      this._qr.setFromAxisAngle(this._axis, this.roll);
      this._q.multiply(this._qr);
    }
    cam.quaternion.copy(this._q);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  dispose() { this.active = false; }
}
