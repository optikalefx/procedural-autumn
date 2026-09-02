// ─────────────────────────────────────────────────────────────────────────────
//  camp_sleep — turning in for the night.
//
//  Point at your tent once the evening is on and the camp offers a night's
//  sleep: the valley falls to black, the clock is wound on to morning while
//  there is nothing on the screen to see it happen, and the world comes back at
//  first light. Camp.js owns the pointer test and the prompt; this file owns the
//  transition and the clock.
//
//  ── 1. Why the black is a DOM element ────────────────────────────────────
//
//  The obvious place for a fade is PostFX — it is already grading the frame and
//  a black lerp is two instructions. It is the wrong place for three reasons,
//  and the eyepiece mask in camp_scope_view.js gives the same three: it must
//  not be graded by the tonemapper (a "black" that the filmic curve lifts back
//  to charcoal is not black), it must not appear in a `tools/shot.mjs` capture,
//  and it must be opaque at any adaptive-resolution scale — the post chain
//  draws at the scaled buffer size and this has to cover the whole window.
//
//  It also has to cover the HUD, which is DOM. A speedometer glowing over a
//  black screen is the one thing that would break the illusion outright, and no
//  amount of work inside the render target can put a rectangle over it.
//
//  ── 2. The hour moves while the screen is fully black ────────────────────
//
//  Not on the click, and not on the way down. Winding the clock eight hours
//  makes SkyProbe re-bake (`REBAKE_HOUR_DELTA` in render/SkyProbe.js), re-samples
//  the whole keyframe table, and swings the shadow camera through a half-turn of
//  azimuth — the frame that lands on is not a frame anybody should watch. So it
//  happens at the top of the hold, with a beat of black either side of it: the
//  hitch is free, and the pause reads as the night passing rather than as a cut.
//
//  ── 3. This clock is wall time, on purpose ───────────────────────────────
//
//  Camp is not in main.js's `LIVE_WHILE_PAUSED` set, so every dt it is handed
//  is zero the moment photo mode opens — which is exactly the trap
//  `CampReticle.hide` exists to work around, one layer down. A fade held at
//  0.4 opacity for as long as a menu stays open is worse than either end of it,
//  and a sleep that never finishes leaves `controlsHeldBy` pinned and the camper
//  parked forever. `performance.now()` cannot be stopped by anything in this
//  game, and the engine's rAF is what stops when the tab goes away.
// ─────────────────────────────────────────────────────────────────────────────
import { smoothstep } from '../core/MathUtils.js';

// The three beats, in seconds.
//
// Out is slower than a cut and faster than a wipe; the hold is a single beat,
// long enough to feel like time passed and short enough that nobody wonders
// whether the game has died; the way in is the longest of the three because a
// sunrise arriving over a second and a half reads as light coming up, and the
// same curve at 1.1 s reads as the screen being switched back on. Total 3.65 s,
// which is about as long as this game should ever take the frame away from
// somebody who only clicked a tent.
const FALL = 1.10;
const DARK = 0.85;
const RISE = 1.70;

// Not pure black — see the palette rules at the top of ui/hud.css, which the
// eyepiece's field stop follows too. This is the HUD's own plum taken almost to
// zero: on screen it is black, and the two centimetres of it that are still a
// colour keep the transition in the same hand as everything else.
const NIGHT_INK = '#0a0710';

// When the tent starts offering, and when it stops — an hour either side of the
// sun, so **18:00 to 05:18** on the shipping curve (sunset 18.9, sunrise 6.2).
//
// The first version gated on `SKY_STATE.nightFactor >= 1`, which is Lighting's
// own statement of "the night is fully down" and reads beautifully in the
// abstract. It opened the offer at 20:42, and the player's answer to that was
// one line: "I don't see the tooltip to sleep until morning. It should be
// visible after 1800." They are right and the reasoning behind the old gate was
// looking at the wrong thing. Astronomical night is when the SKY is finished;
// turning in is a thing people do in the EVENING, while there is still colour on
// the hills, and a camp that will not let you go to bed until quarter to nine is
// a camp arguing with its player about bedtime.
//
// Still derived rather than typed as 18.0, and the derivation is the mirror of
// `WAKE_AFTER_SUNRISE` below: you may turn in about an hour before the sun goes,
// and you wake about an hour after it comes back. On the authored curve that
// lands exactly on the hour the player named, and if sunset is ever re-authored
// the offer moves with the evening instead of drifting away from it.
//
// The far end closes at 05:18 — the same lead, before sunrise. Past that the
// night is nearly over and "sleep until morning" would be advancing the clock by
// less than two hours, which is a nap, not a night.
const TURN_IN_BEFORE_SUNSET = 0.9;

// What "morning" is, measured from wherever sunrise happens to be rather than
// written down as a number. On the shipping curve (sunrise 6.2) this is 7.1 —
// the sun about 5 degrees up, which is the bottom of the same band the brief
// calls golden hour, and the amber end of the keyframe table. Waking at sunrise
// itself was tried on paper and is wrong: 6.2 is the moment the disc touches
// the horizon, the key is at a fifth of its strength, and the player would open
// their eyes on a scene darker than most of the night they just skipped.
const WAKE_AFTER_SUNRISE = 0.9;

/**
 * The fade, the clock, and the one question Camp asks before offering it.
 *
 * One instance for the whole session, built with the camp and never rebuilt —
 * the element it owns is a full-screen layer and creating one at the moment it
 * is needed is a style recalculation on the frame that can least afford it.
 */
export class SleepFade {
  constructor(ctx) {
    this.ctx = ctx;
    // -1 is "not sleeping". A single elapsed clock rather than a phase enum:
    // there are three beats and they are strictly ordered, so a number says
    // everything an enum would and cannot get out of step with itself.
    this.t = -1;
    this._last = 0;
    this._warped = false;

    const el = document.createElement('div');
    el.className = 'pa-sleep-fade';
    el.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none',
      // Above the HUD (40) and above the touch layer (9998), because this is
      // the player's eyes being closed and nothing is exempt from that. Below
      // PerfOverlay (9999), which is a measuring instrument and should stay
      // readable through anything.
      'z-index:9998',
      `background:${NIGHT_INK}`, 'opacity:0', 'display:none',
      // No CSS transition. The opacity is written every frame from `update`,
      // and a transition would be a second animation fighting the first —
      // the element would chase a target that had already moved, and the
      // curve authored above would never be the curve on screen.
      'transition:none', 'will-change:opacity',
    ].join(';');
    document.body.appendChild(el);
    this.el = el;
  }

  /** Is a sleep running? While this is true, nothing in the camp is listening. */
  get active() { return this.t >= 0; }

  /**
   * Is it late enough to offer this at all?
   *
   * Camp calls this BEFORE its pointer test, so through the daylight hours the
   * whole feature costs three compares and never walks a prop list.
   */
  ready() {
    // Never under a capture. Every art tool poses the camera and raises
    // `__forceCamera`, and `_pointerRay` falls back to the camera's own forward
    // ray when there is no pointer — so a night contact sheet framed on the
    // tent would otherwise match this branch and take the camp's prompt away
    // from the frame it was measuring. Same first line, same reason, as
    // `Camp._pickHoverFire`.
    if (window.__forceCamera) return false;
    if (this.active) return false;
    const L = this.ctx.lighting;
    if (!L) return false;
    const wrap = (h) => (((h % 24) + 24) % 24);
    const h = wrap(L.hour);
    const opens = wrap(L.sunset - TURN_IN_BEFORE_SUNSET);
    const shuts = wrap(L.sunrise - TURN_IN_BEFORE_SUNSET);
    // The window crosses midnight, so it is "after it opens OR before it shuts"
    // rather than a plain between. Written to survive a curve where it does not
    // cross — a world with a sunset before noon would take the other branch —
    // because a wrapping range that silently assumes it wraps is a trap for
    // whoever re-authors the sun.
    return opens < shuts ? (h >= opens && h < shuts) : (h >= opens || h < shuts);
  }

  /** The hour the player will wake at. */
  wakeHour() {
    const L = this.ctx.lighting;
    return ((L?.sunrise ?? 6.2) + WAKE_AFTER_SUNRISE) % 24;
  }

  /** Close your eyes. A no-op if they are already closed. */
  begin() {
    if (this.active) return;
    this.t = 0;
    this._last = performance.now() / 1000;
    this._warped = false;
    this.el.style.display = '';
    this.el.style.opacity = '0';
    // Nobody drives in their sleep. `Vehicle.controlsHeldBy` is the mechanism
    // for exactly this and the boat, the bike and the roast view are the other
    // holders: the pedals reach the physics as zeros and the park brake cannot
    // release, so the camper stays exactly where it was parked for the whole
    // three seconds. Without it, W held down through the black is a camper
    // rolling out of its own camp while the sun comes up.
    //
    // Camp refuses to offer the tent unless this is null, so this can never be
    // taking the claim off a boat or a bike.
    const veh = this.ctx.systems?.vehicle;
    if (veh) veh.controlsHeldBy = 'sleep';
  }

  /**
   * One frame of the transition. Takes no dt — see section 3 of the header.
   *
   * Called unconditionally from `Camp.update`, including on the frames the
   * player is not holding the brake: the sleep is under way and releasing the
   * handbrake mid-fade must not strand it half black.
   */
  update() {
    if (!this.active) return;
    const now = performance.now() / 1000;
    // Clamped, because a tab that was hidden for a minute comes back with a
    // sixty-second step and would skip the whole transition in one frame.
    const dt = Math.min(0.1, Math.max(0, now - this._last));
    this._last = now;
    this.t += dt;

    if (!this._warped && this.t >= FALL) {
      this._warped = true;
      const L = this.ctx.lighting;
      if (L) L.hour = this.wakeHour();
    }

    let a;
    if (this.t < FALL) a = smoothstep(0, FALL, this.t);
    else if (this.t < FALL + DARK) a = 1;
    else a = 1 - smoothstep(0, RISE, this.t - FALL - DARK);
    this.el.style.opacity = a.toFixed(3);

    if (this.t >= FALL + DARK + RISE) this._end();
  }

  /** Wake up: hand the controls back and take the layer out of the compositor. */
  _end() {
    this.t = -1;
    this._warped = false;
    this.el.style.opacity = '0';
    this.el.style.display = 'none';
    this._release();
  }

  /**
   * Give the pedals back — but only if they are still ours.
   *
   * The holder's contract in Vehicle's constructor is "clear it unconditionally
   * on exit and in its dispose", and the check is how that is honoured without
   * stealing: a player who somehow got onto the bike during the fade owns the
   * claim now, and clearing it would leave them riding a camper that steers.
   */
  _release() {
    const veh = this.ctx.systems?.vehicle;
    if (veh && veh.controlsHeldBy === 'sleep') veh.controlsHeldBy = null;
  }

  dispose() {
    this._release();
    this.el.remove();
  }
}
