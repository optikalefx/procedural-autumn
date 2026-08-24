// Keyboard / gamepad / pointer input, normalised into a small action set.

// ── the press gesture ────────────────────────────────────────────────────────
// How long a press has to sit still before it becomes a HOLD, and how far a
// finger may wander and still count as "in place".
//
// A touch screen has no hover, and half this game's interactions were built on
// one: the camp ring, its green/red validity and every prompt in the game come
// from pointing at something without committing to it. So on touch the press
// IS the hover — hold and the preview appears under your thumb, release and it
// happens, slide off a red spot first and it does not.
//
// HOLD_TIME is under the ~500 ms at which iOS fires its own long-press callout,
// so the gesture resolves before the browser tries to take it. The slop is per
// pointer type on purpose: a mouse that moves 7 px was aiming somewhere else, a
// thumb that moves 7 px was holding still.
const HOLD_TIME = 0.42;    // s pressed in place before a hold is live
const TAP_TIME = 0.55;     // s pressed that still counts as a tap on release
const SLOP_MOUSE = 6;      // px of travel that is still "in place"
// Exported because the drive stick's dead zone must BE this number: a finger
// that has left the dead zone is a stick deflection, a finger inside it is
// still a press that could become a tap or a hold. Two numbers here would give
// the game a band where it is doing both or neither.
export const SLOP_TOUCH = 14;

export class Input {
  constructor(domElement = window) {
    this.dom = domElement;
    this.keys = new Set();
    this.axes = { throttle: 0, brake: 0, steer: 0, handbrake: 0, lookX: 0, lookY: 0, zoom: 0 };
    this.pressed = new Set();
    // `down` is the look drag (left, and historically right — see `_bind`);
    // `mid` is the middle button on its own, which the free photo camera pans
    // with. They are separate flags rather than a button mask because every
    // reader of this asks a yes/no question about one gesture.
    this.mouse = { x: 0, y: 0, dx: 0, dy: 0, down: false, mid: false, wheel: 0 };
    // Written by ui/TouchControls.js; merged in update() exactly the way the
    // gamepad is, so nothing downstream knows touch exists.
    this.touch = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    // The one press gesture, fed by pointer events so a mouse click and a thumb
    // are the same thing to everything downstream. See HOLD_TIME above.
    //
    //   down     a pointer is down on the world (not on a control)
    //   t        seconds it has been down
    //   moved    px it has travelled from where it went down
    //   holding  down, in place, past HOLD_TIME — the placement preview is live
    //   tap      ONE frame: released in place, quickly. Picking a thing.
    //   commit   ONE frame: released after `holding`. Committing to a place.
    //
    // `tap` and `commit` are cleared by update() the same frame `pressed` is,
    // so a system that misses its frame misses the press — which is the same
    // contract `justPressed` has always had.
    // `x/y` are NDC for the aim ray; `px/py` and `ox/oy` are client pixels —
    // where the finger is and where it landed. The stick wants pixels: a
    // deflection measured in NDC would steer harder than it accelerates purely
    // because the screen is taller than it is wide.
    this.press = {
      down: false, x: 0, y: 0, t: 0, moved: 0,
      px: 0, py: 0, ox: 0, oy: 0,
      holding: false, tap: false, commit: false,
    };
    this.suppressed = false;
    this._bind();
  }

  _bind() {
    const kd = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    };
    const ku = (e) => this.keys.delete(e.code);
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', () => this.keys.clear());

    window.addEventListener('mousemove', (e) => {
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    });
    // A drag or a wheel only reaches the camera when it starts on the world.
    // The HUD root is pointer-events:none, so anything else under the cursor is
    // a real control — a slider being scrubbed, a chip being clicked — and that
    // gesture belongs to the control, not to the look. Without this, dragging
    // the time-of-day slider also swings the camera behind the sheet.
    // The type test alone is not enough now that the HUD has a canvas of its
    // own that takes clicks: the minimap is an HTMLCanvasElement, so a click
    // placing a warp point also read as a grab on the world and swung the
    // camera. `#pa-hud` is the one root the HUD ever appends to, so anything
    // inside it is interface by definition.
    const onWorld = (e) => e.target instanceof HTMLCanvasElement
      && !e.target.closest('#pa-hud');

    window.addEventListener('mousedown', (e) => {
      if (!onWorld(e)) return;
      // Button 1 is the middle wheel-click. It is kept out of `down` so the
      // look drag and the free camera's pan are never both live on the same
      // gesture, and buttons 0 and 2 both still set `down` — right-drag has
      // orbited since this file was written and nothing here needs to change
      // that.
      if (e.button === 1) {
        this.mouse.mid = true;
        // Chrome starts its autoscroll on middle mousedown and the scrolling
        // cursor then sits over the game for the whole drag. Cancelling it
        // here is the only place that works; `auxclick` below stops the paste
        // /new-tab default that fires on release.
        e.preventDefault();
      } else {
        this.mouse.down = true;
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 1) this.mouse.mid = false;
      else this.mouse.down = false;
    });
    // A drag that ends off the canvas (or over the HUD) still has to release.
    window.addEventListener('blur', () => { this.mouse.down = false; this.mouse.mid = false; });
    window.addEventListener('auxclick', (e) => { if (e.button === 1 && onWorld(e)) e.preventDefault(); });
    window.addEventListener('wheel', (e) => {
      if (onWorld(e)) this.mouse.wheel += e.deltaY;
    }, { passive: true });

    // ── the press gesture ───────────────────────────────────────────────────
    // Pointer events, not mouse events, because on a touch screen there are no
    // mouse events worth having: the browser synthesises a whole
    // mousemove/mousedown/mouseup/click burst AFTER touchend, all inside one
    // task, so anything that samples `mouse.down` once a frame — which is what
    // every click in this game used to do — never sees a finger at all. That
    // is the whole reason a phone could not pitch a camp or put a boat in the
    // water. One pointer path, and a mouse click and a thumb become the same
    // press.
    //
    // Only the FIRST pointer on the world starts a press: `_pressId` pins it,
    // so a thumb already on the gas pedal (a different pointer, and not on the
    // canvas anyway) cannot cancel a placement being held with the other hand.
    this._pressId = null;
    this._pressSlop = SLOP_MOUSE;
    this._pressAt = { x: 0, y: 0 };
    this._pressT0 = 0;                  // performance.now() at pointerdown — see below
    this._pressVoid = false;            // a press a menu ate; it resolves to nothing

    const setNdc = (e) => {
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    };

    window.addEventListener('pointerdown', (e) => {
      if (this._pressId !== null || !onWorld(e) || e.button > 0) return;
      this._pressId = e.pointerId;
      this._pressSlop = e.pointerType === 'mouse' ? SLOP_MOUSE : SLOP_TOUCH;
      this._pressAt.x = e.clientX;
      this._pressAt.y = e.clientY;
      const p = this.press;
      p.down = true; p.t = 0; p.moved = 0;
      p.ox = e.clientX; p.oy = e.clientY;
      p.px = e.clientX; p.py = e.clientY;
      this._pressVoid = false;
      // Wall clock, not the frame's `dt`. A hold is a HUMAN act — half a second
      // is half a second whether the valley is running at 60 fps or hitching
      // through a bake — and simulated time is neither: it is clamped per frame
      // and it stops when the tab does. Measured on `dt`, a hold on a phone
      // that dropped to 15 fps would have wanted a two-second press, and the
      // headless harness (which runs far below real time) could not perform the
      // gesture at all.
      this._pressT0 = performance.now();
      p.holding = false; p.tap = false; p.commit = false;
      // The aim ray reads `mouse.x/y` (see core/Pointer.js `pointerRay`), and a
      // finger produces no hover to have set it — so the press position IS the
      // aim from the instant it lands.
      setNdc(e);
      p.x = this.mouse.x; p.y = this.mouse.y;
      // NOTE: `mouse.down` and `mouse.dx/dy` are deliberately NOT written for
      // touch pointers. They are the LOOK DRAG, and CameraRig._readLook orbits
      // the chase camera with them — so feeding a finger into them made every
      // stick slide swing the camera as well, which put the camper off the side
      // of the screen the first time anyone steered. On touch a one-finger
      // slide means exactly one thing: the drive stick (ui/TouchControls.js).
      // Anything that genuinely wants a finger drag reads `press.px/py`
      // instead — see camp_scope_view.js.
    });

    window.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._pressId) return;
      const dx = e.clientX - this._pressAt.x;
      const dy = e.clientY - this._pressAt.y;
      // Distance from where it went down, not distance travelled: a thumb that
      // wobbles and comes back was holding still, and a press that has already
      // left cannot come back and be a tap again — hence the max.
      this.press.moved = Math.max(this.press.moved, Math.hypot(dx, dy));
      this.press.px = e.clientX; this.press.py = e.clientY;
      setNdc(e);
      this.press.x = this.mouse.x; this.press.y = this.mouse.y;
      // Not fed into `mouse.dx/dy` — see the note in pointerdown.
    });

    const pressEnd = (e, cancelled) => {
      if (e.pointerId !== this._pressId) return;
      this._pressId = null;
      const p = this.press;
      const inPlace = p.moved <= this._pressSlop && !this._pressVoid;
      // Resolved on release, not on a timer, so the two gestures can never both
      // fire from one press: past HOLD_TIME it was a hold and it commits, under
      // it, it was a tap. `TAP_TIME` is the old click contract and is only
      // reachable when `holding` never armed (a press suppressed mid-gesture).
      p.commit = !cancelled && inPlace && p.holding;
      p.tap = !cancelled && inPlace && !p.holding && p.t <= TAP_TIME;
      p.down = false;
      p.holding = false;
      p.t = 0;
      this._pressVoid = false;
    };
    window.addEventListener('pointerup', (e) => pressEnd(e, false));
    window.addEventListener('pointercancel', (e) => pressEnd(e, true));
    // A press that leaves the window never gets its pointerup.
    window.addEventListener('blur', () => {
      this._pressId = null;
      this._pressVoid = false;
      const p = this.press;
      p.down = false; p.holding = false; p.t = 0; p.tap = false; p.commit = false;
    });
    // iOS raises its own long-press callout at around half a second, over the
    // top of a placement being held. HOLD_TIME resolves first, but the callout
    // still has to be refused or the gesture ends in a share sheet.
    window.addEventListener('contextmenu', (e) => { if (onWorld(e)) e.preventDefault(); });
  }

  key(code) { return this.keys.has(code); }
  justPressed(code) { return this.pressed.has(code); }

  /** Call once per frame, after all systems have read input. */
  update(dt) {
    // A UI layer (menus, photo mode) sets this so gameplay does not act on the
    // same buttons it is using to navigate. Gamepad button 0 is the handbrake,
    // and is also the natural "confirm" — without this the two fight.
    if (this.suppressed) {
      this.axes.throttle = 0; this.axes.brake = 0;
      this.axes.steer = 0; this.axes.handbrake = 0;
      this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0;
      this.pressed.clear();
      // Same reason the axes are zeroed: a sheet opening over a held placement
      // must not leave the placement armed to fire when the sheet closes.
      //
      // Disarming `holding` is not enough on its own. A press that outlives the
      // sheet still has a finger on it, and when that finger finally lifts the
      // release has to resolve to SOMETHING — with the hold disarmed it
      // resolved to a tap, so opening the settings mid-hold and closing it
      // again ended in a pick the player never asked for. The press is void
      // from here until the pointer is lifted and a new one begins.
      this.press.holding = false;
      this.press.tap = false;
      this.press.commit = false;
      if (this.press.down) this._pressVoid = true;
      return;
    }

    const gp = navigator.getGamepads?.()[0];

    let throttle = 0, brake = 0, steer = 0, handbrake = 0;
    if (this.key('KeyW') || this.key('ArrowUp')) throttle = 1;
    if (this.key('KeyS') || this.key('ArrowDown')) brake = 1;
    if (this.key('KeyA') || this.key('ArrowLeft')) steer += 1;
    if (this.key('KeyD') || this.key('ArrowRight')) steer -= 1;
    if (this.key('Space')) handbrake = 1;

    if (gp) {
      const dz = (v) => (Math.abs(v) < 0.14 ? 0 : v);
      throttle = Math.max(throttle, gp.buttons[7]?.value ?? 0);
      brake = Math.max(brake, gp.buttons[6]?.value ?? 0);
      steer += -dz(gp.axes[0] ?? 0);
      handbrake = Math.max(handbrake, gp.buttons[0]?.value ?? 0);
      this.axes.lookX += dz(gp.axes[2] ?? 0) * dt * 2.2;
      this.axes.lookY += dz(gp.axes[3] ?? 0) * dt * 1.4;
    }

    const t = this.touch;
    this.axes.throttle = Math.max(throttle, t.throttle);
    this.axes.brake = Math.max(brake, t.brake);
    this.axes.steer = Math.max(-1, Math.min(1, steer + t.steer));
    this.axes.handbrake = Math.max(handbrake, t.handbrake);

    // A press becomes a HOLD by sitting still, which only a clock can notice.
    // Sampled here rather than on a timer so `holding` can only ever change
    // between frames — every reader of it asks once per frame and would
    // otherwise see the answer change underneath it mid-update.
    const p = this.press;
    if (p.down) {
      p.t = (performance.now() - this._pressT0) / 1000;
      const inPlace = p.moved <= this._pressSlop;
      if (!p.holding && p.t >= HOLD_TIME && inPlace) p.holding = true;
      // …and a hold that then MOVES stops being one. Without this, pressing,
      // pausing, and driving off left the placement ring lit on the meadow for
      // the whole drive: `commit` was already dead (the release is not in
      // place), but the preview the hold had armed never retracted.
      else if (p.holding && !inPlace) p.holding = false;
    }

    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
    this.pressed.clear();
    // One frame only, exactly like `pressed`.
    p.tap = false;
    p.commit = false;
  }
}
