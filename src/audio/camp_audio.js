// ─────────────────────────────────────────────────────────────────────────────
//  CampAudio — the fire.
//
//  A camp fire is two sounds and they are almost unrelated. There is a **bed**,
//  which is the roar: a broad low hiss of hot gas that barely changes, and
//  which you stop hearing after about ten seconds. And there are the
//  **crackles**, which are sharp, brief, unpredictable, and are the entire
//  reason a fire is nice to sit next to.
//
//  Almost every synthesised fire gets this backwards and leans on the bed,
//  because the bed is easy — one noise source and a filter — and the result is
//  a hairdryer. The bed here is deliberately quiet and dull; the budget is
//  spent on making the crackles behave, and that means two things:
//
//   1. **Clusters, not a Poisson process.** Real fires pop in bursts: a log
//      shifts, a pocket of sap goes, and three or four snaps arrive inside half
//      a second, then nothing for four seconds. An exponential inter-arrival
//      time produces an even sprinkle that reads as a synthesiser ticking.
//   2. **Every crackle is a different size.** A drawn-from-one-envelope
//      crackle is a rimshot. These span a soft tick, a wooden knock and an
//      occasional loud snap with a short tail on it, and the loud ones are
//      rare enough to be startling in the way a real one is.
//
//  Loudness matters more than usual here. The player's own words about this
//  game's ambience were "very loud. Not calming at all", and a fire is the one
//  sound a player will sit inside for minutes at a time. It is mixed to sit
//  under the wind, not over it.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, lerp, mulberry32 } from '../core/MathUtils.js';
import { noiseBuffer, noiseSource, filter, gain, ping, stopLater, panner } from './synth.js';

// How far the fire carries. 26 m is generous for a camp fire in still air and
// is chosen from the game rather than from acoustics: the player parks 8–18 m
// away, and the sound has to be there when they arrive rather than switching
// on as they walk in.
const REACH = 26;
const NEAR = 3.0;      // inside this, the fire is at full level

export class CampAudio {
  constructor(actx, bus, reverb, ctx) {
    this.actx = actx;
    this.ctx = ctx;
    this.rnd = mulberry32(0xf14e);

    this.bus = gain(actx, 1);
    this.bus.connect(bus);
    // A little of the valley's tail, but much less than the wildlife takes: a
    // fire six metres away is a near-field sound and a wet one sounds like it
    // is at the bottom of a well.
    this.wet = gain(actx, 0.16);
    this.bus.connect(this.wet).connect(reverb);

    this.noise = noiseBuffer(actx, 3, 'pink', 0x77c1);

    // ── the bed ───────────────────────────────────────────────────────────
    // Pink noise through a gentle band-pass, plus a low shelf of the same
    // noise for the body. Two filters rather than one because a single
    // band-pass at this Q is either hissy or muddy and never both-ish.
    this.bedSrc = noiseSource(actx, this.noise, 1);
    this.bedBp = filter(actx, 'bandpass', 620, 0.55);
    this.bedLow = filter(actx, 'lowpass', 240, 0.7);
    this.bedGain = gain(actx, 0);
    this.bedLowGain = gain(actx, 0.55);
    this.pan = panner(actx, 0);

    this.bedSrc.connect(this.bedBp).connect(this.bedGain);
    this.bedSrc.connect(this.bedLow).connect(this.bedLowGain).connect(this.bedGain);
    this.bedGain.connect(this.pan).connect(this.bus);
    // No start() here — `noiseSource` already starts the node. Calling it a
    // second time throws, and because every layer is constructed inside
    // `Audio._start`'s try block, that one exception took down the ENTIRE
    // audio graph: no wind, no water, no engine, no music, and the only
    // symptom was a console line reading "[audio] unavailable".

    this._level = 0;          // smoothed distance gain
    this._breath = 0;         // slow swell, so the bed is never a constant
    this._cluster = 0;        // crackles left in the current burst
    this._next = 0.4;         // seconds to the next crackle
    this._t = 0;
    this.state = { crackles: 0, level: 0 };
  }

  update(dt, L) {
    const camp = this.ctx.systems?.camp;
    const actx = this.actx;
    // `raise` is the camp's build-in, and using it here is free: the fire
    // fades up as it is lit rather than switching on at full volume the
    // instant the player clicks.
    const lit = camp?.fire && camp.site ? clamp01(camp.raise) : 0;

    let target = 0, panTo = 0;
    if (lit) {
      const dx = camp.site.x - L.x, dz = camp.site.z - L.z;
      const d = Math.hypot(dx, dz);
      // Inverse-ish rather than linear: a linear ramp over 26 m spends most of
      // its range on distances where the fire should already be inaudible, so
      // the sound "arrives" far too early and then barely grows.
      const k = clamp01(1 - (d - NEAR) / (REACH - NEAR));
      target = lit * k * k;
      panTo = clamp(Math.sin(Math.atan2(dx, dz) - L.yaw) * 0.7, -0.8, 0.8);
      // The same enclosure multiplier every other outdoor layer uses, so if
      // anything ever starts driving it the fire ducks with the wind and the
      // birds rather than staying loud on its own.
      target *= clamp01(L.indoors ?? 1);
    }

    // Damped, and slowly: the listener's distance changes fast when driving
    // past, and an undamped level swings audibly with the camera boom.
    this._level += (target - this._level) * Math.min(1, dt * 2.4);
    this.state.level = this._level;

    // The bed breathes. Two incommensurable rates, so it never settles into a
    // pulse — the same argument the fire's own flicker light makes.
    this._t += dt;
    this._breath = 0.82 + 0.13 * Math.sin(this._t * 0.37) + 0.05 * Math.sin(this._t * 0.91 + 1.3);

    // 0.055 is quiet on purpose. See the header.
    this.bedGain.gain.setTargetAtTime(this._level * this._breath * 0.055, actx.currentTime, 0.12);
    this.pan.pan.setTargetAtTime(panTo, actx.currentTime, 0.15);
    // A near fire is brighter as well as louder — you hear the hiss, not just
    // the roar. Sweeping the band-pass with distance does more for the sense of
    // proximity than the level does.
    this.bedBp.frequency.setTargetAtTime(lerp(430, 780, this._level), actx.currentTime, 0.2);

    if (this._level < 0.015) return;

    // ── crackles ──────────────────────────────────────────────────────────
    this._next -= dt;
    if (this._next > 0) return;

    this._crackle(L);
    if (this._cluster > 0) {
      // Inside a burst: 40–150 ms apart.
      this._cluster--;
      this._next = 0.04 + this.rnd() * 0.11;
    } else {
      // Between bursts. The gap is long — a fire this size pops a few times a
      // second at most and is often silent for several. Scaled by level so a
      // distant fire is also a sparser one, which is what the loud crackles
      // being the only ones that carry actually sounds like.
      this._next = (0.55 + this.rnd() * 2.6) / lerp(0.45, 1, this._level);
      // One burst in three has a tail of two to five more.
      if (this.rnd() < 0.34) this._cluster = 2 + Math.floor(this.rnd() * 4);
    }
  }

  /**
   * One crackle.
   *
   * Three sizes, drawn with very different weights. `size` picks the envelope
   * and the filter together, because a big crackle is not just a loud small
   * one — it is lower, longer, and has a short woody ring on the end of it.
   */
  _crackle(L) {
    const actx = this.actx;
    const t = actx.currentTime + 0.005;
    const r = this.rnd();
    // 62% ticks, 30% knocks, 8% snaps.
    const size = r < 0.62 ? 0 : r < 0.92 ? 1 : 2;

    const dur = size === 0 ? 0.018 + this.rnd() * 0.02
              : size === 1 ? 0.05 + this.rnd() * 0.06
              : 0.11 + this.rnd() * 0.13;
    const freq = size === 0 ? 1900 + this.rnd() * 2600
               : size === 1 ? 780 + this.rnd() * 900
               : 300 + this.rnd() * 420;
    const q = size === 0 ? 1.6 : size === 1 ? 3.2 : 5.5;
    const peak = (size === 0 ? 0.055 : size === 1 ? 0.13 : 0.26)
               * (0.6 + this.rnd() * 0.7) * this._level;

    const src = noiseSource(actx, this.noise, 0.8 + this.rnd() * 0.5);
    const bp = filter(actx, 'bandpass', freq, q);
    const g = gain(actx, 0);
    // Each crackle gets its own small pan offset around the fire's bearing.
    // A fire is a metre across and the pops come from all over it; pinning
    // every one to the same point is the tell that they are synthetic.
    const p = panner(actx, clamp(this.pan.pan.value + (this.rnd() - 0.5) * 0.22, -0.9, 0.9));

    src.connect(bp).connect(g).connect(p).connect(this.bus);
    // Near-instant attack. A crackle with a millisecond of ramp is a click; a
    // crackle with ten is a thump. The source is already running (see the note
    // in the constructor) — the envelope is what makes this a crackle, so
    // there is nothing to start, only something to stop.
    ping(actx, g, t, Math.max(peak, 0.0004), 0.0015, dur);
    src.stop(t + dur + 0.1);
    stopLater([src, bp, g, p], actx, t + dur + 0.3);
    this.state.crackles++;
  }

  dispose() {
    try { this.bedSrc.stop(); } catch { /* already stopped */ }
    for (const n of [this.bedSrc, this.bedBp, this.bedLow, this.bedGain,
                     this.bedLowGain, this.pan, this.bus, this.wet]) {
      try { n.disconnect(); } catch { /* already gone */ }
    }
  }
}
