// ─────────────────────────────────────────────────────────────────────────────
//  Music — mostly silence.
//
//  A cozy game does not have a soundtrack, it has moments. This plays a short
//  phrase on a soft, slightly detuned bell-ish voice when the player *arrives*
//  somewhere: crests a ridge, reaches a vista, comes over the lip of a big
//  waterfall, or drives into sunset. Then it stops, and will not speak again
//  for at least a minute and a half no matter what happens.
//
//  Everything is pentatonic, so any two notes that land together consonate and
//  the generator never needs to know about harmony.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, mulberry32 } from '../core/MathUtils.js';
import { filter, gain, ping, stopLater, panner } from './synth.js';

// F major pentatonic across two and a half octaves. Warm, no leading tone,
// nothing that can sound like a question.
const ROOT = 174.61;                                    // F3
const STEPS = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
const SCALE = STEPS.map((s) => ROOT * Math.pow(2, s / 12));

const MIN_GAP = 92;          // seconds of enforced silence between phrases

export class Music {
  constructor(actx, bus, reverb, ctx) {
    this.actx = actx;
    this.ctx = ctx;
    this.rnd = mulberry32(0x5c0e);

    this.bus = gain(actx, 0.9);
    this.bus.connect(bus);
    this.wet = gain(actx, 0.55);
    this.bus.connect(this.wet).connect(reverb);

    this._since = MIN_GAP * 0.45;   // do not open the game with music
    this._queue = [];
    this._phrase = 0;
    this._lastY = null;
    this._climb = 0;
    this._visited = new Set();
    this._lastHour = null;
    this.state = { phrases: 0, since: 0, lastTrigger: 'none' };
  }

  update(dt, L) {
    this._since += dt;
    this.state.since = this._since;

    // ── play out anything already scheduled ────────────────────────────────
    if (this._queue.length) {
      const now = this.actx.currentTime;
      while (this._queue.length && this._queue[0].at <= now + 0.4) {
        const n = this._queue.shift();
        this._note(n.f, n.at, n.level, n.pan);
      }
      return;                       // never evaluate triggers mid-phrase
    }

    if (this._since < MIN_GAP) return;

    const trigger = this._trigger(dt, L);
    if (!trigger) return;
    this._play(trigger, L);
  }

  /**
   * What counts as a moment. Ordered by how much it deserves music: arriving
   * at a curated landmark beats merely gaining height.
   */
  _trigger(dt, L) {
    // 1. A named landmark, once each. `poi` already knows the good places, so
    //    music lands where the game itself thinks the view is.
    const poi = this.ctx.poi;
    if (poi) {
      for (const kind of ['vista', 'peak', 'waterfall']) {
        const list = poi.list?.[kind];
        if (!list) continue;
        for (let i = 0; i < Math.min(list.length, 6); i++) {
          const p = list[i];
          const key = `${kind}${i}`;
          if (this._visited.has(key)) continue;
          const d = Math.hypot(p.x - L.x, p.z - L.z);
          if (d < (kind === 'waterfall' ? 70 : 55)) {
            this._visited.add(key);
            return kind === 'waterfall' ? 'waterfall' : 'vista';
          }
        }
      }
    }

    // 2. Cresting: a sustained climb that then levels off. Rising ground alone
    //    is a hill; rising then flattening with a view is a ridge.
    if (this._lastY === null) this._lastY = L.y;
    const dy = L.y - this._lastY;
    this._lastY = L.y;
    this._climb = clamp(this._climb + dy - dt * 1.6, 0, 60);
    if (this._climb > 34 && dy < 0.02 && L.open > 0.35) {
      this._climb = 0;
      return 'ridge';
    }

    // 3. The sun going down, once per crossing.
    const h = L.hour;
    if (this._lastHour !== null) {
      const crossed = (a, b, x) => a < x && b >= x;
      if (crossed(this._lastHour, h, 17.6) || crossed(this._lastHour, h, 6.4)) {
        this._lastHour = h;
        return 'sun';
      }
    }
    this._lastHour = h;
    return null;
  }

  /** Build a phrase: three to five notes with air between them. */
  _play(trigger, L) {
    const r = this.rnd;
    const actx = this.actx;
    this._since = 0;
    this._phrase++;
    this.state.phrases++;
    this.state.lastTrigger = trigger;

    // Register by moment. A ridge is high and bright; a waterfall answers low.
    const base = trigger === 'waterfall' ? 0 : trigger === 'sun' ? 1 : 3;
    const n = 3 + ((r() * 3) | 0);
    let t = actx.currentTime + 0.25;
    let step = base + ((r() * 3) | 0);

    for (let i = 0; i < n; i++) {
      const idx = clamp(step, 0, SCALE.length - 1);
      const level = (i === 0 ? 0.115 : 0.085) * (1 - i * 0.09);
      this._queue.push({ f: SCALE[idx], at: t, level, pan: (r() * 2 - 1) * 0.35 });
      // Small melodic steps with the occasional leap; never a scale run.
      step += r() < 0.62 ? (r() < 0.5 ? 1 : 2) : (r() < 0.5 ? -1 : 3);
      t += 0.75 + r() * 1.25;
    }
    // A low root underneath, entering late so it reads as the room answering.
    this._queue.push({ f: SCALE[0] * 0.5, at: actx.currentTime + 0.9, level: 0.055, pan: 0 });
    this._queue.sort((a, b) => a.at - b.at);
    void L;
  }

  /**
   * One note. Two detuned sines an octave apart plus a third at a twelfth,
   * under a slow attack and a very long release — a glass-harmonica sort of
   * sound that sits above wind and water without ever cutting through them.
   */
  _note(f, at, level, pan) {
    const actx = this.actx;
    const out = gain(actx, 0);
    const tone = filter(actx, 'lowpass', 2600, 0.7);
    const p = panner(actx, pan);
    out.connect(tone).connect(p).connect(this.bus);

    const oscs = [];
    for (const [mul, amp, det] of [[1, 1, 0], [2, 0.42, 6], [3, 0.16, -8], [1, 0.5, -5]]) {
      const o = actx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mul;
      o.detune.value = det;
      const g = gain(actx, amp);
      o.connect(g).connect(out);
      o.start(at);
      o.stop(at + 6.5);
      oscs.push(o, g);
    }

    const g = out.gain;
    g.setValueAtTime(0.0001, at);
    g.linearRampToValueAtTime(clamp01(level), at + 0.28);     // soft mallet
    g.exponentialRampToValueAtTime(0.0001, at + 5.6);         // long tail
    stopLater([...oscs, out, tone, p], actx, at + 7);
  }
}
