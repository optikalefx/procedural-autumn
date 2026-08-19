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

const FADE_IN = 6.0;
const FADE_OUT = 7.5;

export class Soundtrack {
  constructor(actx, bus, ctx) {
    this.actx = actx;
    this.ctx = ctx;
    this.buffer = null;
    this.src = null;
    this.failed = false;

    this.out = gain(actx, 0);
    this.out.connect(bus);

    // Separate from the fade so ducking and fading cannot fight each other.
    this.duck = gain(actx, 1);
    this.out.connect(this.duck);

    this.level = 0.46;          // deliberately under the ambience bed
    this.playing = false;
    this._t = 0;
    this._until = 20 + Math.random() * 25;   // do not open the game with music
    this.state = { loaded: false, playing: false, plays: 0 };

    this._load();
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
    if (this.failed || !this.buffer) return;

    this._t += dt;
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

    // Duck under a generative phrase so the two never compete.
    const want = musicActive ? 0.35 : 1;
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
