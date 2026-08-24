// ─────────────────────────────────────────────────────────────────────────────
//  Driving on a touch screen: the whole world is the stick.
//
//  This started as four on-screen controls — a steering strip, two pedals and a
//  park chip — which drove the camper well enough and cost the bottom third of
//  a phone screen to do it. The player's direction was to throw them away:
//  "push your finger forward to go forward, and just slide it around as if the
//  whole screen is the control stick".
//
//  So there is no widget any more. Put a thumb anywhere on the valley and that
//  point becomes the stick's centre; push forward to drive, pull back to brake
//  and then reverse, slide sideways to steer, lift to let go. Nothing is drawn
//  until the stick is actually deflected, and then only a ring where the thumb
//  landed and a knob where it is now — so the game is on screen instead of a
//  control panel, which is the whole point.
//
//  ── how this does not fight the rest of the game ────────────────────────────
//
//  The same finger has to be able to pitch a camp and board a canoe, and those
//  are presses on the world too. The split is already built, in core/Input.js:
//  a press that stays STILL is an interaction (a tap picks a thing, a hold
//  commits to a place) and a press that SLIDES is a drag. This layer is what a
//  drag now means. The stick's dead zone is `SLOP_TOUCH`, the very number
//  Input uses to decide a press moved, so the two readings cannot disagree —
//  inside it you are aiming, outside it you are driving, and there is no band
//  where you are doing both.
//
//  ── and the park brake ─────────────────────────────────────────────────────
//
//  There is no park chip either, because the stick at rest already says it:
//  let go below walking pace and Vehicle latches the hold (see the touch branch
//  by `_holdEligible`). That is not a workaround for a missing button, it is
//  the auto-hold this camper already had, finally with a control that matches
//  it. It matters more than it sounds: camps and boats can only be started from
//  a parked camper, so on a phone "stop and let go" IS the gesture that opens
//  the rest of the game.
//
//  Everything still feeds `input.touch`, which Input.update() merges exactly
//  the way it merges the gamepad, so nothing downstream knows touch exists.
// ─────────────────────────────────────────────────────────────────────────────

import { touchCapable } from '../core/verbs.js';
import { SLOP_TOUCH } from '../core/Input.js';

export { touchCapable };

// Full deflection. Sized for a thumb pivoting from where it landed rather than
// for the screen: a stick you have to cross the phone to max out is one you
// steer with your whole arm, and one much smaller than this has no travel left
// to be gentle with.
const RANGE = 108;   // px from centre to full lock
const DEAD = SLOP_TOUCH;

export class TouchControls {
  constructor(input) {
    this.input = input;
    this.root = document.createElement('div');
    this.root.id = 'pa-touch';
    // Nothing here ever takes a pointer. The stick is fed by `input.press`,
    // which core/Input.js has already tracked for the placement gestures — so
    // this layer reads the same press the camp and the boat read, and cannot
    // swallow one from them.
    this.root.style.cssText =
      'position:fixed;inset:0;z-index:9998;pointer-events:none;' +
      'contain:strict;overflow:hidden';
    document.body.appendChild(this.root);
    // hud.css keys touch-device layout off this.
    document.body.classList.add('pa-touch');

    const shell = 'position:absolute;left:0;top:0;border-radius:50%;' +
      'will-change:transform;opacity:0;transition:opacity .12s ease;' +
      'pointer-events:none';
    // The ring is where the thumb landed; the knob is where it is now.
    //
    // An OUTLINE, with nothing inside it. The first version filled the ring
    // and blurred what was behind it, and a 216 px disc of murk sitting in the
    // middle of the valley was a worse intrusion than the four pedals it
    // replaced — the entire argument for the stick is that you get the
    // landscape back. What has to be legible is the pivot and the deflection,
    // and two thin circles say both.
    this.ring = this._el(`${shell};width:${RANGE * 2}px;height:${RANGE * 2}px;` +
      `margin:-${RANGE}px 0 0 -${RANGE}px;` +
      // Cream on a gold hillside is the one legibility problem this whole HUD
      // has (see the note by `.pa-label` in hud.css): the outer dark stroke is
      // what keeps the ring from vanishing entirely into lit grass at noon.
      'border:1.5px solid rgba(255,232,196,.34);' +
      'box-shadow:0 0 0 1px rgba(38,24,18,.14)');
    this.knob = this._el(`${shell};width:54px;height:54px;margin:-27px 0 0 -27px;` +
      'border:1.5px solid rgba(255,232,196,.55);background:rgba(255,232,196,.16);' +
      'box-shadow:0 1px 10px rgba(0,0,0,.18)');

    this._shown = false;
    this._wasCapturing = false;
  }

  _el(css) {
    const d = document.createElement('div');
    d.style.cssText = css;
    this.root.appendChild(d);
    return d;
  }

  /**
   * Read the press, drive the camper, draw the stick.
   *
   * Runs in `lateUpdate`, so the axes it writes are merged by the NEXT
   * `Input.update` — one frame behind the finger. That is deliberate rather
   * than tolerated: the alternative is a second set of pointer listeners
   * racing Input's, and a frame is 16 ms on a control whose input is a thumb.
   */
  update() {
    const capturing = !!window.__forceCamera || !!this.input.suppressed;
    if (capturing !== this._wasCapturing) {
      this._wasCapturing = capturing;
      this.root.style.display = capturing ? 'none' : 'block';
    }
    const t = this.input.touch;
    if (capturing) { t.throttle = 0; t.brake = 0; t.steer = 0; return; }

    const p = this.input.press;
    const dx = p.px - p.ox;
    const dy = p.py - p.oy;
    const len = p.down ? Math.hypot(dx, dy) : 0;

    if (len <= DEAD) {
      // Neutral — including the whole of a placement hold, which never leaves
      // the dead zone by definition.
      t.throttle = 0; t.brake = 0; t.steer = 0;
      this._draw(false);
      return;
    }

    // Subtract the dead zone rather than clamping through it, so the stick
    // starts from zero at the edge of the aiming band instead of jumping to
    // whatever fraction the band happened to be. Clamped as a VECTOR, so a
    // diagonal cannot ask for more than full lock on both axes at once.
    const k = Math.min(1, (len - DEAD) / (RANGE - DEAD)) / len;
    const ux = dx * k, uy = dy * k;

    // Screen-right steers right. The keyboard convention is that steer +1 is
    // LEFT (KeyA), hence the sign — the same flip the old steering strip made.
    t.steer = -ux;
    // Up the screen is forward. Pulling back is the brake, and the brake is
    // also reverse once the camper has stopped — VehiclePhysics already owns
    // that, so back-is-reverse costs nothing here.
    const fwd = -uy;
    t.throttle = Math.max(0, fwd);
    t.brake = Math.max(0, -fwd);

    this._draw(true, p.ox, p.oy, p.ox + ux * RANGE, p.oy + uy * RANGE);
  }

  _draw(on, ox = 0, oy = 0, kx = 0, ky = 0) {
    if (on) {
      this.ring.style.transform = `translate(${ox}px,${oy}px)`;
      this.knob.style.transform = `translate(${kx}px,${ky}px)`;
    }
    if (on === this._shown) return;
    this._shown = on;
    this.ring.style.opacity = on ? '1' : '0';
    this.knob.style.opacity = on ? '1' : '0';
  }

  dispose() {
    this.root.remove();
    document.body.classList.remove('pa-touch');
  }
}
