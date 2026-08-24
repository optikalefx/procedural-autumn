// ─────────────────────────────────────────────────────────────────────────────
//  On-screen driving controls for touch devices.
//
//  The game was keyboard/gamepad only, which made it a spectator on phones.
//  This adds the smallest control set that actually drives the camper well
//  with two thumbs:
//
//    left thumb   a steering STRIP — press anywhere on it and the horizontal
//                 position inside the strip is the steer value, continuously.
//                 A strip rather than left/right buttons because analog steer
//                 is the difference between driving and bumper-car tapping,
//                 and rather than a joystick because the camper has no use for
//                 a vertical axis there.
//    right thumb  two pedals, gas above brake/reverse, plus a small handbrake
//                 chip for hills (VehiclePhysics holds the camper with it).
//
//  Everything feeds `input.touch`, a contribution Input.update() merges with
//  the keyboard and gamepad exactly the way the gamepad is merged — so all
//  the existing readers (vehicle, camera, HUD hints) see one normalised axis
//  set and nothing downstream knows touch exists.
//
//  Pointer events with per-pointer tracking, not touch events: one pointerId
//  per control, so steering and pedals are naturally concurrent and a thumb
//  sliding off a pedal releases only that pedal. `touch-action: none` on the
//  controls stops the browser turning a steer into a scroll or a
//  double-tap-zoom.
//
//  The layer only exists on coarse-pointer devices, and hides itself during
//  captures the same way the HUD does (`window.__forceCamera`) so review
//  sheets stay clean.
// ─────────────────────────────────────────────────────────────────────────────

import { touchCapable } from '../core/verbs.js';

export { touchCapable };

const BASE = [
  'position:fixed', 'z-index:9998', 'user-select:none', '-webkit-user-select:none',
  'touch-action:none', '-webkit-tap-highlight-color:transparent',
  'font:600 15px/1 ui-rounded,system-ui,sans-serif', 'color:#ffe9c8',
  'background:rgba(24,16,22,.44)', 'border:1px solid rgba(255,214,150,.28)',
  'backdrop-filter:blur(4px)', '-webkit-backdrop-filter:blur(4px)',
  'display:flex', 'align-items:center', 'justify-content:center',
].join(';');

export class TouchControls {
  constructor(input) {
    this.input = input;
    this.root = document.createElement('div');
    this.root.id = 'pa-touch';
    // The root is a pass-through container; only the controls take pointers.
    this.root.style.cssText = 'position:fixed;inset:0;z-index:9998;pointer-events:none';
    document.body.appendChild(this.root);
    // hud.css keys touch-device layout off this: the keyboard hint hides and
    // the dash lifts clear of the steering strip.
    document.body.classList.add('pa-touch');

    // Bottom inset: clear the hint bar and the home indicator.
    const bottom = 'calc(18px + env(safe-area-inset-bottom, 0px))';

    // ── steering strip ──────────────────────────────────────────────────────
    this.strip = this._el(
      `${BASE};left:calc(14px + env(safe-area-inset-left,0px));bottom:${bottom};` +
      'width:min(42vw,300px);height:84px;border-radius:42px;pointer-events:auto');
    this.strip.innerHTML =
      '<span style="opacity:.6;letter-spacing:.1em">◀&nbsp;&nbsp;steer&nbsp;&nbsp;▶</span>' +
      '<div id="pa-steer-dot" style="position:absolute;left:50%;top:50%;width:56px;height:56px;' +
      'margin:-28px 0 0 -28px;border-radius:50%;background:rgba(255,214,150,.28);' +
      'border:1px solid rgba(255,214,150,.4);transition:left .08s"></div>';
    this.dot = this.strip.querySelector('#pa-steer-dot');

    // A press anywhere on the strip steers; the value is the horizontal
    // position mapped to [-1, 1] with a small dead zone at centre. The strip
    // captures its pointer so a thumb wandering above it keeps steering.
    this._steerId = null;
    const steerFrom = (e) => {
      const r = this.strip.getBoundingClientRect();
      const t = ((e.clientX - r.left) / r.width) * 2 - 1;   // -1 left … +1 right
      const v = Math.max(-1, Math.min(1, t / 0.9));
      const dz = Math.abs(v) < 0.08 ? 0 : v;
      // Keyboard convention: steer +1 is LEFT (KeyA). Screen-left must steer left.
      this.input.touch.steer = -dz;
      this.dot.style.left = `${(Math.max(-1, Math.min(1, t)) * 0.5 + 0.5) * 100}%`;
    };
    this.strip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this._steerId = e.pointerId;
      this.strip.setPointerCapture(e.pointerId);
      steerFrom(e);
    });
    this.strip.addEventListener('pointermove', (e) => {
      if (e.pointerId === this._steerId) steerFrom(e);
    });
    const steerEnd = (e) => {
      if (e.pointerId !== this._steerId) return;
      this._steerId = null;
      this.input.touch.steer = 0;
      this.dot.style.left = '50%';
    };
    this.strip.addEventListener('pointerup', steerEnd);
    this.strip.addEventListener('pointercancel', steerEnd);

    // ── pedals ──────────────────────────────────────────────────────────────
    const right = 'calc(14px + env(safe-area-inset-right,0px))';
    this.gas = this._hold(
      `${BASE};right:${right};bottom:calc(${bottom} + 96px);width:96px;height:88px;` +
      'border-radius:26px;pointer-events:auto', '▲<br><span style="font-size:11px;opacity:.6">gas</span>',
      (on) => { this.input.touch.throttle = on ? 1 : 0; });
    this.brake = this._hold(
      `${BASE};right:${right};bottom:${bottom};width:96px;height:88px;` +
      'border-radius:26px;pointer-events:auto', '▼<br><span style="font-size:11px;opacity:.6">brake</span>',
      (on) => { this.input.touch.brake = on ? 1 : 0; });
    // Handbrake is a small chip inboard of the pedals — used rarely, so it
    // must not sit where a gas-reaching thumb lands.
    this.hand = this._hold(
      `${BASE};right:calc(${right} + 108px);bottom:${bottom};width:64px;height:56px;` +
      'border-radius:20px;font-size:11px;pointer-events:auto', 'park',
      (on) => { this.input.touch.handbrake = on ? 1 : 0; });

    this._wasCapturing = false;
  }

  _el(css) {
    const d = document.createElement('div');
    d.style.cssText = css;
    this.root.appendChild(d);
    return d;
  }

  /** A hold-to-press control: down = on, up/cancel/capture-loss = off. */
  _hold(css, html, set) {
    const d = this._el(css);
    d.innerHTML = `<span style="text-align:center">${html}</span>`;
    const down = (e) => {
      e.preventDefault();
      d.setPointerCapture(e.pointerId);
      d.style.background = 'rgba(255,214,150,.34)';
      set(true);
    };
    const up = () => {
      d.style.background = 'rgba(24,16,22,.44)';
      set(false);
    };
    d.addEventListener('pointerdown', down);
    d.addEventListener('pointerup', up);
    d.addEventListener('pointercancel', up);
    return d;
  }

  /** Per-frame: hide during captures/photo mode, like the HUD does. */
  update() {
    const capturing = !!window.__forceCamera || !!this.input.suppressed;
    if (capturing !== this._wasCapturing) {
      this._wasCapturing = capturing;
      this.root.style.display = capturing ? 'none' : 'block';
    }
  }

  dispose() {
    this.root.remove();
    document.body.classList.remove('pa-touch');
  }
}
