// ─────────────────────────────────────────────────────────────────────────────
//  Soundtrack — the authored music bed.
//
//  Sits alongside the generative Music layer rather than replacing it. The two
//  have different jobs: the generative phrases mark *moments* (cresting a ridge,
//  reaching a landmark), while this is the bed you drive to.
//
//  Two things keep it cozy rather than wallpaper:
//
//   · **It stops.** A loop that never ends stops being music and becomes noise
//     you want to mute. This plays a stretch, then leaves a long silence, then
//     comes back. Silence is what makes the next entry feel like a choice.
//   · **It gets out of the way.** When a generative phrase fires the bed ducks
//     under it, so the two never compete for the same moment.
//
//  Loading is lazy and failure is silent: no soundtrack file, no problem, the
//  game still has its generative layer and its ambience.
//
//  Lazy means lazy. This used to fetch from the constructor, which put 4.9 MB
//  on the wire during the loading screen for a bed that does not enter for
//  20-45 s and never enters at all for someone who leaves first — about a
//  tenth of the bandwidth bill, spent on nothing. The fetch now waits until
//  the first entry is nearly due (LOAD_LEAD below).
// ─────────────────────────────────────────────────────────────────────────────
import { gain } from './synth.js';
import { clamp01 } from '../core/MathUtils.js';

const TRACK = '/audio/Maple Road Loop.mp3';

// A stretch of music, then quiet. Tuned so the bed is present for a bit under
// half the time — often enough to feel scored, rare enough to stay welcome.
const PLAY_MIN = 95;
const PLAY_MAX = 165;
const REST_MIN = 70;
const REST_MAX = 130;

// How long before the bed is due to enter we start fetching it. Enough for a
// 4.9 MB download and decode on an unhurried connection; if it is not enough
// the entry simply happens when the buffer lands, because `update` keeps the
// clock running while the fetch is in flight.
const LOAD_LEAD = 12.0;

const FADE_IN = 6.0;
const FADE_OUT = 7.5;

export class Soundtrack {
  constructor(actx, bus, ctx) {
    this.actx = actx;
    this.ctx = ctx;
    this.buffer = null;
    this.src = null;
    this.failed = false;

    // Separate from the fade so ducking and fading cannot fight each other —
    // but *in series with it*, which it was not. `out` connected straight to
    // the bus and also to `duck`, and `duck` connected to nothing, so the bed
    // reached the mix around the ducking stage and the duck node was a dead
    // end. Proved rather than read (tools/_scratch/musicbalance.mjs): forcing
    // duck.gain to zero with the bed playing moved the music bus by 0.0 dB.
    // The bed has never once ducked under a generative phrase.
    this.out = gain(actx, 0);
    this.duck = gain(actx, 1);
    this.out.connect(this.duck).connect(bus);

    // 0.21, not 0.46. The old value carried the comment "deliberately under the
    // ambience bed", and it was — but only because the ambience bed was running
    // about seven times its own model at the time, from the LFO bug fixed in
    // the ambience pass. This number was levelled against that bug. Measured
    // afterwards, the bed sat 16 dB over the world and a parked moment was
    // music with a valley faintly behind it.
    //
    // Not the full 11 dB the world came down. The player asked for a quiet
    // valley, not a quieter game, so the world sitting lower than the music is
    // correct and stays; this only closes the gap far enough that the bed is
    // something you hear the valley through rather than instead of.
    this.level = 0.21;
    this.playing = false;
    this._t = 0;
    this._until = 20 + Math.random() * 25;   // do not open the game with music
    this.state = { loaded: false, playing: false, plays: 0 };
    this._loading = false;
  }

  /**
   * Fetch and decode the bed. Safe to call repeatedly — the first call wins
   * and the rest are no-ops. `update` calls this when the entry is nearly
   * due; callers that need the buffer *now* (the sound lab) await it.
   */
  async ensureLoaded() {
    if (this.buffer || this.failed) return;
    if (this._loading) return this._loading;
    this._loading = this._load();
    return this._loading;
  }

  async _load() {
    try {
      const res = await fetch(TRACK);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const bytes = await res.arrayBuffer();
      this.buffer = await this.actx.decodeAudioData(bytes);
      this.state.loaded = true;
      this.state.duration = +this.buffer.duration.toFixed(1);
    } catch (e) {
      this.failed = true;
      console.warn(`[audio] no soundtrack (${e.message}) — generative music only`);
    }
  }

  _start() {
    if (!this.buffer || this.src) return;
    const a = this.actx;
    const s = a.createBufferSource();
    s.buffer = this.buffer;
    s.loop = true;
    // Enter at a different point each time so a returning bed does not always
    // announce itself with the same four bars.
    s.loopStart = 0;
    s.loopEnd = this.buffer.duration;
    s.connect(this.out);
    s.start(a.currentTime, Math.random() * this.buffer.duration);
    this.src = s;

    this.out.gain.cancelScheduledValues(a.currentTime);
    this.out.gain.setValueAtTime(Math.max(0.0001, this.out.gain.value), a.currentTime);
    this.out.gain.linearRampToValueAtTime(this.level, a.currentTime + FADE_IN);

    this.playing = true;
    this.state.plays++;
  }

  _stop() {
    if (!this.src) return;
    const a = this.actx;
    const s = this.src;
    this.src = null;
    this.playing = false;
    this.out.gain.cancelScheduledValues(a.currentTime);
    this.out.gain.setValueAtTime(this.out.gain.value, a.currentTime);
    this.out.gain.linearRampToValueAtTime(0.0001, a.currentTime + FADE_OUT);
    try { s.stop(a.currentTime + FADE_OUT + 0.3); } catch { /* already stopped */ }
  }

  /** @param musicActive whether a generative phrase is sounding right now. */
  update(dt, musicActive) {
    if (this.failed) return;

    this._t += dt;

    // Start the download once the entry is within LOAD_LEAD. The clock keeps
    // running either way, so a slow fetch delays the first entry rather than
    // losing it: `_t` stays past `_until` and the branch below fires as soon
    // as the buffer exists.
    if (!this.buffer && this._t >= this._until - LOAD_LEAD) this.ensureLoaded();

    if (!this.buffer) return;
    if (this._t >= this._until) {
      this._t = 0;
      if (this.playing) {
        this._stop();
        this._until = REST_MIN + Math.random() * (REST_MAX - REST_MIN);
      } else {
        this._start();
        this._until = PLAY_MIN + Math.random() * (PLAY_MAX - PLAY_MIN);
      }
    }

    // Duck under a generative phrase so the two never compete. 0.6, not 0.35:
    // now that the node is actually in the signal path and the bed is 7 dB
    // lower than it was, a 9 dB duck would put the bed under the ambience for
    // the length of every phrase — which is a hole, not a duck. 4.4 dB is
    // enough to open a space for the phrase and still leave the bed audible
    // underneath it.
    const want = musicActive ? 0.6 : 1;
    const g = this.duck.gain;
    const now = this.actx.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(want, now, musicActive ? 0.35 : 1.4);

    this.state.playing = this.playing;
  }

  setLevel(v) {
    this.level = clamp01(v);
    if (this.playing) {
      const now = this.actx.currentTime;
      this.out.gain.cancelScheduledValues(now);
      this.out.gain.setTargetAtTime(this.level, now, 0.5);
    }
  }

  dispose() { this._stop(); }
}
