// ─────────────────────────────────────────────────────────────────────────────
//  RideCamera — the camera you get when you are ON a thing rather than driving
//  one.
//
//  Extracted from `Boat` when the bike arrived, because the bike wanted the
//  same four behaviours and they are the fiddly ones — every constant below was
//  argued for in front of a capture, and a second hand-rolled copy would have
//  drifted from the first inside a week.
//
//  What it owns:
//
//    · **The takeover.** `CameraRig.takeCamera` outranks every mode the rig
//      has, including free mode. Taking it is easy; giving it back at the right
//      instant is the part that has bugs in it, so `handOff`/`endHandOff` live
//      here too and photo mode talks to one pair of methods per rideable.
//    · **Zoom about the mount.** The wheel, with the rig's own exponential
//      feel, clamped to a range the owner declares. The rig is taken over while
//      mounted, so nothing else is consuming the wheel.
//    · **Look around from the seat.** Drag turns your head, it does not turn
//      the vehicle — the eye stays where it is mounted and only the look target
//      swings. Same sensitivities as the chase camera (`CameraRig._readLook`)
//      so the gesture feels identical whichever thing you are steering, and the
//      same courtesy: it eases back over the nose only once you are actually
//      under way, because somebody stopped is looking at something on purpose.
//    · **The damping, and the snap.** Position tracks hard (the eye is IN the
//      vehicle); the look target trails a little more, so a turn reads as the
//      nose swinging through frame — except under the player's own hand, where
//      a head turn has to feel bolted to the mouse.
//
//  What it does NOT own: where the mount actually is. That is the one thing
//  that differs between a kayak deck and a bike saddle, and it is supplied as
//  the `mount` callback — `(zoom, lookYaw, lookPitch) => { eye, look, up? }`,
//  all in world space, recomputed every frame from the vehicle's live pose.
//  `up` is optional and only the bike uses it: a bicycle banks into a corner
//  and a camera that stays plumb reads as a tripod watching one. It is applied
//  UNDAMPED, because the caller has already damped whatever it derived the bank
//  from — a second filter here would put the horizon a beat behind the lean.
//
//  ── the contract ────────────────────────────────────────────────────────────
//
//    const ride = new RideCamera(ctx, { mount, speed, ...tuning });
//    ride.reset(); ride.take(rig);      // on mounting: a cut is a snap
//    ride.release(rig);                 // on dismounting: give everything back
//    ride.handOff(rig); ride.endHandOff(rig);   // photo mode, both directions
//
//  `mount` and `speed` are read every frame and must be cheap.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

// The look limits. Shared rather than per-vehicle: they are about a neck, and
// necks are the same on a boat and a bike.
const LOOK_PITCH_MIN = -0.55;   // looking up into the trees
const LOOK_PITCH_MAX = 0.75;    // looking down over the side

export class RideCamera {
  /**
   * @param ctx  the game context (needs `camera` and `input`)
   * @param o.mount   (zoom, lookYaw, lookPitch) -> { eye: Vector3-like,
   *                  look: Vector3-like }. Called once per frame, after the
   *                  zoom and the head turn have been advanced.
   * @param o.speed   () -> the vehicle's speed in m/s. Gates the recentre.
   * @param o.zoomMin/zoomMax   the zoom range; 1 is the resting mount.
   * @param o.moveLo/moveSpan   speeds between which "under way" ramps in, so
   *                  the recentre courtesy fits a 3.8 m/s hull and a 9 m/s bike
   *                  without either inheriting the other's numbers.
   * @param o.recenterDelay     seconds of no input before the head eases home.
   * @param o.posDamp/posDampY  how hard the eye tracks its mount.
   * @param o.lookDampHeld/Free how hard the look target tracks, under the
   *                  player's hand and not.
   */
  constructor(ctx, o = {}) {
    this.ctx = ctx;
    this.mount = o.mount;
    this.speed = o.speed ?? (() => 0);
    this.zoomMin = o.zoomMin ?? 0.55;
    this.zoomMax = o.zoomMax ?? 2.6;
    this.moveLo = o.moveLo ?? 0.6;
    this.moveSpan = o.moveSpan ?? 1.8;
    this.recenterDelay = o.recenterDelay ?? 2.0;
    this.posDamp = o.posDamp ?? 14;
    this.posDampY = o.posDampY ?? 10;
    this.lookDampHeld = o.lookDampHeld ?? 22;
    this.lookDampFree = o.lookDampFree ?? 7;

    this.zoom = 1;              // the applied zoom, damped
    this.zoomT = 1;             // where the wheel has put it
    this.lookYaw = 0;           // head turn off the nose line, radians
    this.lookPitch = 0;
    this.lookIdle = 0;          // seconds since the look was last touched
    this.handedOff = false;     // photo mode is holding the camera

    this._snap = true;
    this._camP = new THREE.Vector3();   // eye, damped
    this._camL = new THREE.Vector3();   // look target, damped
  }

  /** Centre the head and cut rather than ease on the next frame. Called on
   *  mounting, and on coming back from photo mode — see `endHandOff`. */
  reset({ zoom = false } = {}) {
    this._snap = true;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.lookIdle = 0;
    if (zoom) { this.zoom = 1; this.zoomT = 1; }
  }

  /** Cut on the next frame, leaving the head where it is pointed. */
  snap() { this._snap = true; }

  /** Mount the camera. The rig eases nothing — `_tick` runs from the frame
   *  after this, and `reset()` decides whether its first frame is a cut. */
  take(rig) { rig?.takeCamera?.((dt) => this._tick(dt)); }

  /** Give the camera back to the rig, whatever state we are in.
   *
   *  `up` is put back to plumb unconditionally. It is shared mutable state on
   *  the camera object, so a rideable that banks it and does not restore it
   *  leaves the ENTIRE GAME tilted — the chase camera, photo mode and the map
   *  all read the same `camera.up`. Restoring it here rather than in the bike
   *  means no future rideable can forget. */
  release(rig) {
    this.handedOff = false;
    this.ctx.camera?.up?.set(0, 1, 0);
    rig?.takeCamera?.(null);
  }

  // ── the frame ─────────────────────────────────────────────────────────────

  _tick(dt) {
    const cam = this.ctx.camera;
    const input = this.ctx.input;
    // Wheel zoom, the same exponential feel as the rig's.
    const wheel = input.mouse.wheel;
    if (wheel) {
      this.zoomT = Math.min(this.zoomMax,
        Math.max(this.zoomMin, this.zoomT * Math.exp(wheel * 0.0016)));
    }
    // One clamped step for everything, so a hitched frame cannot fling the
    // camera through the vehicle it is bolted to.
    const k = Math.min(dt, 1 / 20);
    this._readLook(k);
    this.zoom = THREE.MathUtils.damp(this.zoom, this.zoomT, 9, k);

    const p = this.mount(this.zoom, this.lookYaw, this.lookPitch);
    if (!p) return;
    const e = p.eye, l = p.look;
    if (this._snap) {
      this._camP.set(e.x, e.y, e.z);
      this._camL.set(l.x, l.y, l.z);
      this._snap = false;
    } else {
      const dp = THREE.MathUtils.damp;
      const lk = this.lookIdle === 0 ? this.lookDampHeld : this.lookDampFree;
      this._camP.set(
        dp(this._camP.x, e.x, this.posDamp, k),
        dp(this._camP.y, e.y, this.posDampY, k),
        dp(this._camP.z, e.z, this.posDamp, k));
      this._camL.set(
        dp(this._camL.x, l.x, lk, k),
        dp(this._camL.y, l.y, lk, k),
        dp(this._camL.z, l.z, lk, k));
    }
    cam.position.copy(this._camP);
    if (p.up) cam.up.copy(p.up);
    cam.lookAt(this._camL);
  }

  /**
   * Head turn while mounted: drag to look around, exactly the gesture that
   * orbits the chase camera when you are driving. The rig is handed over while
   * mounted, so nothing else is reading the mouse — without this, a rideable
   * would be the one place in the game where the mouse does nothing at all.
   *
   * A drag past the press slop is not a tap (core/Input `pressEnd`), so looking
   * around can never be mistaken for the click that reaches back to the camper.
   */
  _readLook(dt) {
    const input = this.ctx.input;
    const m = input.mouse;
    let touched = false;
    if (m.down) {
      touched = true;
      if (m.dx || m.dy) {
        this.lookYaw -= m.dx * 0.0042;
        this.lookPitch = Math.min(LOOK_PITCH_MAX,
          Math.max(LOOK_PITCH_MIN, this.lookPitch + m.dy * 0.0032));
      }
    }
    const ax = input.axes;
    if (ax.lookX || ax.lookY) {
      this.lookYaw -= ax.lookX * 1.6 * dt;
      this.lookPitch = Math.min(LOOK_PITCH_MAX,
        Math.max(LOOK_PITCH_MIN, this.lookPitch + ax.lookY * 1.1 * dt));
      ax.lookX = 0; ax.lookY = 0;
      touched = true;
    }
    // Keep the turn in (-pi, pi] so the ease home always takes the short way.
    this.lookYaw = Math.atan2(Math.sin(this.lookYaw), Math.cos(this.lookYaw));
    this.lookIdle = touched ? 0 : this.lookIdle + dt;

    // Ease back over the nose once you are going somewhere — and only then.
    // Stopped, the player is looking at the valley on purpose.
    const sp = Math.abs(this.speed());
    const moving = Math.min(1, Math.max(0, (sp - this.moveLo) / this.moveSpan));
    if (moving > 0.02 && this.lookIdle > this.recenterDelay) {
      const kk = 1 - Math.exp(-1.5 * moving * dt);
      this.lookYaw += (0 - this.lookYaw) * kk;
      this.lookPitch += (0 - this.lookPitch) * kk;
    }
  }

  // ── photo mode ────────────────────────────────────────────────────────────

  /**
   * Hand the camera to photo mode, where it stands.
   *
   * `take` mounts the ride camera through `rig.takeCamera`, and a takeover
   * outranks EVERYTHING in `CameraRig.lateUpdate` — including free mode, which
   * is what photo mode is. So pressing F while mounted opens the rail over a
   * camera that is still bolted to the vehicle, and every control on it is
   * quietly dead in a different way (user, on the kayak, 2026-08-29):
   *
   *  · the ZOOM ring writes `rig.fov` and nothing ever applies it — `_apply`
   *    only runs at the end of `_free`, which never ran;
   *  · MIDDLE-DRAG pan does nothing at all: that gesture lives in `_free` and
   *    `_tick` has no answer for it;
   *  · and the shot will not stay put. `_tick` damps the eye back onto the
   *    mount every frame, and `_readLook` eases the head back over the nose
   *    `recenterDelay` seconds after you stop dragging. Worse while paused: the
   *    speed is frozen at whatever it was when F was pressed, so the "only once
   *    you are actually under way" courtesy that gates the recentre never
   *    expires.
   *
   * The fix is the one the camp's two modal views already use: let go where we
   * stand, before `enterFree` reads the camera. No ease, no step-back, nothing
   * moved — photo mode's contract is that the frame you pressed F on is the
   * frame you compose from, and the mounted pose IS that frame.
   *
   * @returns true if this call is what let go (false if already handed off).
   */
  handOff(rig) {
    if (this.handedOff) return false;
    const cam = this.ctx.camera;
    // The rig has been returning early at its takeover for as long as the
    // player has been mounted, so BOTH the fields `enterFree` measures its arm
    // between are stale — `camPos` and `subject` are still wherever the player
    // got on, which can be most of a valley away. That arm is the free camera's
    // orbit pivot, its depth-of-field plane and the focus rail's first guess,
    // so hand it the truth before it reads it: the eye where it actually is,
    // and our own damped look target as the subject, which is the point this
    // shot has been aimed at all along.
    rig?.camPos?.copy(cam.position);
    rig?.subject?.copy(this._camL);
    // Level the lens before free mode reads it. Photo mode's own controls all
    // assume a plumb `camera.up` — an orbit around a banked up vector corkscrews
    // — and a shot composed off a moving bank is not a shot anybody framed.
    cam.up.set(0, 1, 0);
    this.handedOff = true;
    rig?.takeCamera?.(null);
    return true;
  }

  /** Back in the seat. Photo mode calls this on its way out.
   *
   *  A CUT (`snap`), not the damped ride back, and for the reason
   *  `CameraRig.exitFree` gives: the player may have flown sixty metres up the
   *  far bank to take the photograph, and easing home from there is a long
   *  slide through terrain nobody composed. The head turn is NOT re-centred —
   *  where the player was looking when they pressed F is where they still meant
   *  to be looking, and it eases home on its own once they are under way.
   *
   *  Idempotent, and the owner is expected to clear `handedOff` (via
   *  `release`) if the vehicle is lost while the shutter is open.
   *
   *  @returns true if a hand-off was actually ended. */
  endHandOff(rig) {
    if (!this.handedOff) return false;
    this.handedOff = false;
    this.snap();
    this.take(rig);
    return true;
  }
}
