// ─────────────────────────────────────────────────────────────────────────────
//  CameraRig — chase / photo-orbit / cockpit.
//
//  The chase camera is the single thing the player looks through for hours, so
//  it is built like a camera operator rather than a boom arm:
//
//   · it follows a *damped* heading, not the instantaneous one, so the world
//     swings through frame on a turn instead of snapping;
//   · it aims at a look-ahead point straight down the camper's own nose — it
//     does NOT lead sideways off the steering angle, which is a panning
//     motion the player asked to have removed;
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

// Cockpit is built (see `_cockpit`) but not in the player-facing cycle: the
// body panels are single-sided, so from the driver's seat you see straight out
// through the roof and the doors, and the wipers sit in your face. Fixing it
// means double-siding the shell — a triangle cost the whole game pays for one
// optional camera — so it stays behind a flag until someone wants it enough.
// `window.__cockpitCam = true` before boot to get it back.
const MODES = ['chase', 'orbit'];

// Boom length limits. The low end lets you inspect the roof rack; the high end
// is what the reference vista plates are shot at.
const ZOOM_MIN = 5.5;
const ZOOM_MAX = 68;
const ZOOM_DEFAULT = 19;         // deliberately wide: the camper is a figure in
                                 // a landscape, not the subject of a portrait
const PITCH_MIN = -0.20;         // just under the sill, looking up into the trees
const PITCH_MAX = 1.30;          // near-vertical, looking straight down
const RECENTER_DELAY = 2.0;      // seconds of no mouse before easing back

/**
 * Where the camera settles when the player is not steering it. Close in you
 * want an over-the-shoulder eye-line; far out you want to be looking *down*
 * into the valley, which is how the wide reference plate is framed.
 */
const PITCH_REST_NEAR = 0.20;
const restPitch = (zoom) =>
  PITCH_REST_NEAR + 0.35 * Math.pow(clamp01((zoom - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)), 0.7);

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
    this.zoom = ZOOM_DEFAULT;      // smoothed boom length
    this.zoomTarget = ZOOM_DEFAULT; // what the wheel actually sets
    this.orbitYaw = 0;             // offset from the trailing direction
    this.orbitPitch = restPitch(ZOOM_DEFAULT);
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
    this._boomFrac = 1;            // how much of the boom the terrain allows
  }

  async init() {
    this.vehicle = this.ctx.systems.vehicle;

    // Debug surface for tools/drive.mjs --scenario camera.
    window.__cameraState = () => {
      const w = this.ctx.world;
      const p = this.camPos;
      const g = Math.max(w.getHeight(p.x, p.z), w.getWaterHeight(p.x, p.z) ?? -1e9);
      return {
        mode: this.mode, zoom: this.zoom, zoomTarget: this.zoomTarget,
        yaw: this.orbitYaw, pitch: this.orbitPitch, fov: this.fov,
        x: p.x, y: p.y, z: p.z, ground: g, clearance: p.y - g,
        limits: { zoomMin: ZOOM_MIN, zoomMax: ZOOM_MAX, pitchMin: PITCH_MIN, pitchMax: PITCH_MAX },
      };
    };
  }

  lateUpdate(dt) {
    const v = this.vehicle ?? this.ctx.systems.vehicle;
    if (!v?.phys?.ready) return;
    this.vehicle = v;

    if (this.ctx.input.justPressed('KeyC')) {
      const modes = window.__cockpitCam ? [...MODES, 'cockpit'] : MODES;
      this.mode = modes[(modes.indexOf(this.mode) + 1) % modes.length];
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

    // Holding the button counts as touching it even with the mouse still —
    // otherwise the rig would start recentring under the player's own hand.
    if (m.down) {
      touched = true;
      if (m.dx || m.dy) {
        this.orbitYaw = wrapAngle(this.orbitYaw - m.dx * 0.0042);
        // Pull down to look down on the roof, push up to look at the treetops.
        this.orbitPitch = clamp(this.orbitPitch + m.dy * 0.0032, PITCH_MIN, PITCH_MAX);
      }
    }
    const ax = input.axes;
    if (ax.lookX || ax.lookY) {
      this.orbitYaw = wrapAngle(this.orbitYaw - ax.lookX * 1.6 * dt);
      this.orbitPitch = clamp(this.orbitPitch + ax.lookY * 1.1 * dt, PITCH_MIN, PITCH_MAX);
      ax.lookX = 0; ax.lookY = 0;
      touched = true;
    }
    if (m.wheel) {
      // Multiplicative so a notch feels the same close-in and far out. One
      // Chrome notch is ~100 deltaY, i.e. ~17% of the current boom.
      this.zoomTarget = clamp(this.zoomTarget * Math.exp(m.wheel * 0.0016), ZOOM_MIN, ZOOM_MAX);
      touched = true;
    }
    // Damped so a fast flick of the wheel dollies out instead of teleporting.
    this.zoom = damp(this.zoom, this.zoomTarget, 9, dt);

    this._idle = touched ? 0 : this._idle + dt;

    // Ease back behind the camper — but only when it is actually going
    // somewhere. Parked, the player is sightseeing; leave their framing alone.
    // Ramped with speed rather than switched, so rolling gently to a stop does
    // not yank the view around at the last moment.
    const moving = smoothstep(2.2, 7.0, Math.abs(v.speed));
    if (moving > 0.02 && this._idle > RECENTER_DELAY) {
      const k = smoothstep(RECENTER_DELAY, RECENTER_DELAY + 1.2, this._idle) * 1.5 * moving;
      this.orbitYaw = dampAngle(this.orbitYaw, 0, k, dt);
      this.orbitPitch = damp(this.orbitPitch, restPitch(this.zoom), k, dt);
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
   * Keep the boom out of the hillside.
   *
   * Two mechanisms, in this order, because they fix different failures:
   *
   *  1. **Shorten.** March along the boom from the camper outwards and stop at
   *     the first point that would be underground. A camera that slides in when
   *     a bank rises behind you keeps the camper framed; one that only rises
   *     ends up looking down at it from a corner of the screen.
   *  2. **Lift.** Whatever length survives, hold it clear of the ground under
   *     it, so a boom that is blocked all the way down still ends up in the air
   *     rather than inside the slope.
   *
   * Both matter far more at full zoom-out, where the boom is 68 m of hillside,
   * so the sample count follows the boom length rather than being fixed.
   */
  _boomFit(anchor, desired, dt) {
    const w = this.ctx.world;
    const dx = desired.x - anchor.x, dy = desired.y - anchor.y, dz = desired.z - anchor.z;
    const run = Math.hypot(dx, dz);
    const steps = clamp(Math.ceil(run / 2.0), 6, 30);
    // Required air under the boom, from "may skim the grass" near the camper to
    // a comfortable gap at the camera end.
    const nearCam = lerp(1.6, 4.0, clamp01((this.zoom - 12) / (ZOOM_MAX - 12)));
    const clr = (t) => lerp(0.35, nearCam, t);

    let free = 1;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const sx = anchor.x + dx * t, sz = anchor.z + dz * t;
      const g = Math.max(w.getHeight(sx, sz), w.getWaterHeight(sx, sz) ?? -1e9);
      if (anchor.y + dy * t < g + clr(t)) { free = (i - 1) / steps; break; }
    }
    // Never collapse all the way onto the camper — past this the shot is just
    // the roof rack, and lifting takes over instead.
    free = Math.max(free, 0.34);
    // Snap in hard (being inside a hill is a hard failure), ease back out slowly
    // so cresting a rise does not fling the camera backwards.
    this._boomFrac = free < this._boomFrac
      ? damp(this._boomFrac, free, 24, dt)
      : damp(this._boomFrac, free, 1.6, dt);
    return this._boomFrac;
  }

  /** How much air the camera itself wants under it, in metres. */
  _camClearance() {
    return lerp(1.6, 4.0, clamp01((this.zoom - 12) / (ZOOM_MAX - 12)));
  }

  _groundAt(x, z) {
    const w = this.ctx.world;
    return Math.max(w.getHeight(x, z), w.getWaterHeight(x, z) ?? -1e9);
  }

  /**
   * Raise a boom endpoint out of the ground it landed on, and report by how
   * much — the caller uses that to back off the look-ahead, because a camera
   * the terrain has shoved upwards is no longer where the shot was composed.
   */
  _liftEnd(p) {
    const floor = this._groundAt(p.x, p.z) + this._camClearance();
    const lifted = Math.max(0, floor - p.y);
    if (lifted > 0) p.y = floor;
    return lifted;
  }

  _chase(dt, v) {
    const speed = Math.abs(v.speed);
    const fast = smoothstep(2, 21, speed);
    const wide = clamp01((this.zoom - 16) / (ZOOM_MAX - 16));

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

    // Where the boom pivots and where the eye rests. Wound right in, aim at the
    // waistline so the whole camper sits in frame instead of the roof rack;
    // wound out, ride high above the roof so it reads as a figure in a valley.
    const close = clamp01((10 - this.zoom) / 4.5);
    const anchor = this._t.copy(v.position)
      .addScaledVector(this._up, lerp(1.05, 0.62, close) + wide * 2.4);

    // Spherical boom: yaw around the camper, pitch above the horizon.
    const yaw = slideYaw + this.orbitYaw;
    const dist = this.zoom * lerp(1.0, 1.10, fast);
    const cp = Math.cos(this.orbitPitch), sp = Math.sin(this.orbitPitch);
    const desired = this._t2.set(
      anchor.x - Math.sin(yaw) * dist * cp,
      anchor.y + dist * sp,
      anchor.z - Math.cos(yaw) * dist * cp,
    );

    // Pull the boom in past anything solid, then keep what is left in the air.
    const frac = this._boomFit(anchor, desired, dt);
    desired.lerpVectors(anchor, desired, frac);
    const lifted = this._liftEnd(desired);

    if (!this._primed) { this.camPos.copy(desired); this._primed = true; }

    // While the player is dragging, track hard so the camera feels attached to
    // the mouse; otherwise trail softly.
    const grab = this._idle < 0.15 ? 16 : lerp(3.0, 5.0, fast);
    this.camPos.x = damp(this.camPos.x, desired.x, grab, dt);
    this.camPos.z = damp(this.camPos.z, desired.z, grab, dt);
    this.camPos.y = damp(this.camPos.y, desired.y, Math.max(grab, 5.4), dt);

    // Hard safety, undamped: whatever the damping did, the camera does not get
    // to be underground for even one frame.
    this._clearGround(this.camPos, this._camClearance() * 0.7);

    // ── look-ahead: strong close in, almost none when zoomed way out (there,
    //    leading the vehicle just pushes it out of a very wide frame), and
    //    faded out entirely once the player has orbited off the tail — looking
    //    at the camper's flank, "ahead" is sideways and only spoils the shot.
    // A boom that had to be shortened or lifted is looking at the camper from
    // somewhere it did not choose; leading the shot from there throws the
    // subject into a corner, so fade the look-ahead out with the compromise.
    const composed = clamp01(1 - (1 - frac) * 1.6) * clamp01(1 - lifted * 0.25);
    const trail = clamp01(Math.cos(this.orbitYaw)) * composed;
    const lead = lerp(3.0, 9.5, fast) * (1 - wide * 0.85) * (1 - close * 0.8) * trail;
    // NOTE: there was a second term here, a *lateral* offset driven straight
    // off `phys.steerAngle`, which swung the aim point up to 9 m sideways the
    // instant the wheel moved — before the camper had changed heading at all.
    // The player: "when we go left and right, the camera does this panning
    // thing first. I don't like that. just take that bit out." Removed. The
    // camera now only follows where the camper actually goes; the damped
    // `followYaw` still lets the world swing through frame on a turn.
    const target = this._t2.copy(anchor)
      .addScaledVector(v.forward, lead)
      .addScaledVector(this._up, lerp(0.35, -0.15, fast));
    this.lookAt.x = damp(this.lookAt.x, target.x, 6.5, dt);
    this.lookAt.y = damp(this.lookAt.y, target.y, 5.0, dt);
    this.lookAt.z = damp(this.lookAt.z, target.z, 6.5, dt);

    // ── grade: FOV opens with speed, a hint of roll, a shake on hard landings
    this.fov = damp(this.fov, lerp(50, 62, fast) - wide * 9, 3.2, dt);
    const bank = clamp((v.phys.lateral ?? 0) * -0.006, -0.045, 0.045) * (1 - wide);
    this.roll = damp(this.roll, bank, 4.0, dt);

    this._focus(v);

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
    desired.lerpVectors(anchor, desired, this._boomFit(anchor, desired, dt));
    this._liftEnd(desired);
    if (!this._primed) { this.camPos.copy(desired); this._primed = true; }
    const k = this._idle < 0.15 ? 16 : 4.0;
    this.camPos.x = damp(this.camPos.x, desired.x, k, dt);
    this.camPos.y = damp(this.camPos.y, desired.y, k, dt);
    this.camPos.z = damp(this.camPos.z, desired.z, k, dt);
    this._clearGround(this.camPos, this._camClearance() * 0.7);
    this.lookAt.lerp(anchor, 1 - Math.exp(-6 * dt));
    this.fov = damp(this.fov, 46, 3, dt);
    this.roll = damp(this.roll, 0, 4, dt);
    this._focus(v);
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
      this.camPos.y + 22 * Math.tan(clamp(this.orbitPitch - PITCH_REST_NEAR, -0.5, 0.5)) - 1.0,
      this.camPos.z + fz * 22,
    );
    // No steer-driven lateral lead here either — same reason as `_chase`.
    // Cockpit is behind `window.__cockpitCam`, but if it is ever turned on it
    // should not reintroduce the pan the player rejected.
    this.lookAt.x = damp(this.lookAt.x, look.x, 9, dt);
    this.lookAt.y = damp(this.lookAt.y, look.y, 9, dt);
    this.lookAt.z = damp(this.lookAt.z, look.z, 9, dt);
    this.fov = damp(this.fov, 66, 4, dt);
    this.roll = damp(this.roll, 0, 5, dt);
    this._focus(v);
    this._apply();
  }

  /**
   * Depth of field focuses on the camper, not on a fixed distance. Nothing else
   * owns this: PostFX ships a default focus plane that was right for one boom
   * length, so at 6 m the subject was a blur and at 60 m so was the foreground.
   * Pushed a little past the camper so the ground it stands on stays sharp.
   */
  _focus(v) {
    const fx = this.ctx.postfx;
    if (!fx?.setFocus) return;
    const d = this.camPos.distanceTo(v.position);
    fx.setFocus(d * 1.15 + 4);
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
