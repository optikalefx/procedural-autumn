// Keyboard / gamepad / pointer input, normalised into a small action set.
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

    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
    this.pressed.clear();
  }
}
