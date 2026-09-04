// ─────────────────────────────────────────────────────────────────────────────
//  rhythm — the beat a player can keep to go faster than holding the key.
//
//  Written for the kayak and now shared with the bike, which is the whole
//  reason it is here rather than in `boat_physics`: the two craft want the same
//  GAME and different NUMBERS. A paddle stroke is a one-second thing and a
//  pedal stroke is not, so the tempo is a parameter; everything about how a tap
//  is judged, and how a streak builds and decays, is the same mechanic and is
//  written once.
//
//  ── what it does ────────────────────────────────────────────────────────────
//
//  The auto-repeating stroke that makes simply holding W work is the FLOOR, not
//  the game. On top of it, a player who releases and re-presses to their own
//  beat earns a meter: each RELEASE-then-PRESS edge is timed against the last
//  one, and an interval inside `tol` of `target` builds the meter, while a
//  double-tap or a lazy gap knocks it back. A badly-timed tap is worse than not
//  tapping at all.
//
//  Only EDGES are judged. Holding the key down produces exactly one edge (the
//  first), so holding is never punished and never rewarded — this is a bonus
//  stacked on the existing feel, not a replacement for it.
//
//  ── what it deliberately does NOT do ────────────────────────────────────────
//
//  It owns no physics. What a landed beat is WORTH — the kick, the raised
//  ceiling, the drag it cancels — belongs to the craft, because those numbers
//  only mean something against that craft's own drag model and top speed. This
//  answers one question, "is the player on the beat, and how long a streak",
//  and hands back a 0..1 meter.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp01 } from './MathUtils.js';

export class RhythmMeter {
  /**
   * @param {object} o
   * @param {number} o.target  s between taps for an on-beat stroke
   * @param {number} o.tol     s either side of target that still counts
   * @param {number} o.gain    meter gained per on-beat tap, 0..1
   * @param {number} o.punish  fraction of the meter lost on an off-beat tap
   * @param {number} o.decay   1/s ambient fade — a banked bonus does not
   *                           outlive the rhythm that earned it. Net of gain
   *                           and one beat's worth of decay must stay positive
   *                           or no streak can ever build.
   */
  constructor({ target, tol, gain, punish, decay }) {
    this.target = target;
    this.tol = tol;
    this.gain = gain;
    this.punish = punish;
    this.decay = decay;
    this.reset();
  }

  reset() {
    this.value = 0;      // 0..1 meter, published for HUD/audio
    this.since = 0;      // s since the last press edge — the HUD flashes on this
    this.taps = 0;       // press edges seen, so the FIRST one is never judged
    this.hit = false;    // did a good beat land on this frame
    // The meter AS THE BEAT LANDED — after that tap's gain and before the
    // frame's ambient decay. It exists because the caller scales its kick by
    // the meter, and reading `value` after `update` has already taken a frame
    // of decay off it makes the kick quietly smaller than the tuning says.
    // Worth one field: it is the difference between a refactor that is
    // identical to what it replaced and one that is only nearly.
    this.hitValue = 0;
    this._held = false;
  }

  /**
   * One frame.
   *
   * @param {number} dt
   * @param {boolean} active  is the player asking for effort right now — after
   *   whatever gate the craft applies (a beached hull has no stroke to time
   *   from, and neither has a bike nobody is on).
   * @returns {boolean} true on the frame a good beat landed, so the caller can
   *   pay the kick out on the spot — scaled by `hitValue`, not by `value`.
   */
  update(dt, active) {
    this.hit = false;
    this.hitValue = 0;
    if (active && !this._held) {
      // The first press has nothing to be timed against, so it only starts the
      // clock. Every one after it is a beat.
      if (this.taps > 0) {
        if (Math.abs(this.since - this.target) <= this.tol) {
          this.value = clamp01(this.value + this.gain);
          this.hit = true;
          this.hitValue = this.value;
        } else {
          this.value *= (1 - this.punish);
        }
      }
      this.taps++;
      this.since = 0;
    }
    this._held = active;
    this.since += dt;
    this.value = Math.max(0, this.value - this.decay * dt);
    return this.hit;
  }

  /** What a HUD needs to draw the beat, without importing anyone's constants. */
  beat() {
    return { t: this.since, target: this.target, tol: this.tol };
  }
}
