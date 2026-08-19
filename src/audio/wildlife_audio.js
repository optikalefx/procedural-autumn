// ─────────────────────────────────────────────────────────────────────────────
//  Wildlife — occasional, distant, and mostly absent.
//
//  Animals in a cozy game are punctuation. A deer that calls every twenty
//  seconds is a cuckoo clock; one that calls twice in a drive is a memory. So
//  the rate here is deliberately low and the cooldown long, and the only sound
//  that fires reliably is the one the player *caused*: a flock going up out of
//  a tree as the camper passes.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, lerp, mulberry32 } from '../core/MathUtils.js';
import { noiseBuffer, noiseSource, filter, gain, ping, stopLater, panner } from './synth.js';

export class WildlifeAudio {
  constructor(actx, bus, reverb, ctx) {
    this.actx = actx;
    this.ctx = ctx;
    this.rnd = mulberry32(0x0deb);

    this.bus = gain(actx, 1);
    this.bus.connect(bus);
    // Animals are always outdoors and usually far; the tail places them.
    this.wet = gain(actx, 0.4);
    this.bus.connect(this.wet).connect(reverb);

    this.noise = noiseBuffer(actx, 2, 'pink', 0x1c9f);
    this._callCool = 20 + this.rnd() * 40;
    this._burstLife = [];
    this._tick = 0;
    this.state = { calls: 0, wingbeats: 0 };
  }

  update(dt, L) {
    const w = this.ctx.systems?.wildlife;
    if (!w) return;

    // ── flock takeoff ───────────────────────────────────────────────────────
    // Birds.js keeps a fixed pool of startle bursts and sets `life > 0` when
    // one fires. Watching that transition is the cheapest possible hook and
    // needs nothing from its author.
    const bursts = w.birds?.bursts;
    if (bursts) {
      for (let i = 0; i < bursts.length; i++) {
        const live = (bursts[i].life ?? 0) > 0;
        const was = this._burstLife[i] ?? false;
        this._burstLife[i] = live;
        if (live && !was) {
          const b = bursts[i].birds?.[0];
          this._wingbeats(b ? b.x : L.x, b ? b.z : L.z, L, bursts[i].n ?? 6);
        }
      }
    }

    // ── occasional calls ────────────────────────────────────────────────────
    this._callCool -= dt;
    if (this._callCool > 0) return;
    this._tick++;
    let animals = null;
    try { animals = w.debugState?.(); } catch { animals = null; }
    if (!animals || !animals.length) { this._callCool = 12; return; }

    // Only animals that are settled call — a fleeing deer is silent, which is
    // what makes the alarm-free ones feel calm.
    const cands = [];
    for (const a of animals) {
      if (a.key === 'rabbit') continue;
      if (a.state === 'flee') continue;
      const d = Math.hypot(a.x - L.x, a.z - L.z);
      if (d > 240) continue;
      cands.push({ a, d });
    }
    if (!cands.length) { this._callCool = 15; return; }
    const pick = cands[(this.rnd() * cands.length) | 0];
    this._call(pick.a, pick.d, L);
    this._callCool = 26 + this.rnd() * 55;
  }

  /** A deer bleat or a bear huff — same generator, very different numbers. */
  _call(a, dist, L) {
    const actx = this.actx;
    const bear = a.key === 'bear';
    const t = actx.currentTime + 0.02;
    const f = bear ? 96 + this.rnd() * 26 : 380 + this.rnd() * 90;
    const dur = bear ? 0.42 : 0.28;
    const far = clamp01(dist / 240);
    const level = lerp(0.10, 0.022, far) * (bear ? 1.25 : 1);

    const o = actx.createOscillator();
    o.type = bear ? 'sawtooth' : 'triangle';
    o.frequency.setValueAtTime(f * 0.94, t);
    o.frequency.linearRampToValueAtTime(f, t + dur * 0.25);
    o.frequency.linearRampToValueAtTime(f * (bear ? 0.82 : 0.88), t + dur);

    // Breath. A pure tone reads as a synth; the noise is what makes it a throat.
    const n = noiseSource(actx, this.noise);
    const nb = filter(actx, 'bandpass', bear ? 320 : 1400, 1.1);
    const ng = gain(actx, 0);

    const body = filter(actx, 'lowpass', lerp(4200, 900, far), 1.0);
    const g = gain(actx, 0);
    const p = panner(actx, clamp(Math.sin(Math.atan2(a.x - L.x, a.z - L.z) - L.yaw), -0.9, 0.9));
    o.connect(g);
    n.connect(nb).connect(ng);
    ng.connect(g);
    g.connect(body).connect(p).connect(this.bus);

    ping(actx, g, t, level, 0.02, dur);
    ping(actx, ng, t, 0.5, 0.03, dur * 0.8);
    o.start(t); o.stop(t + dur + 0.2);
    stopLater([o, n, nb, ng, body, g, p], actx, t + dur + 0.6);
    this.state.calls++;
  }

  /**
   * Wingbeats: filtered noise pulsed at wing rate, decelerating as the flock
   * gets away. This is the sound the player will connect to something they saw,
   * so it is worth the handful of nodes.
   */
  _wingbeats(x, z, L, n = 6) {
    const actx = this.actx;
    const d = Math.hypot(x - L.x, z - L.z);
    if (d > 190) return;
    const far = clamp01(d / 190);
    const level = lerp(0.16, 0.02, far) * clamp01(0.4 + n / 13);

    const t0 = actx.currentTime + 0.02;
    const src = noiseSource(actx, this.noise);
    const bp = filter(actx, 'bandpass', lerp(900, 380, far), 0.9);
    const g = gain(actx, 0.0001);
    const p = panner(actx, clamp(Math.sin(Math.atan2(x - L.x, z - L.z) - L.yaw) * 0.8, -0.9, 0.9));
    src.connect(bp).connect(g).connect(p).connect(this.bus);

    // ~11 Hz at the panicked start, slowing to ~7 Hz as they settle into flight.
    let t = t0;
    let rate = 11;
    const gp = g.gain;
    gp.setValueAtTime(0.0001, t0);
    for (let i = 0; i < 16 && t < t0 + 1.7; i++) {
      const amp = level * (1 - i / 18) * (0.75 + this.rnd() * 0.5);
      gp.linearRampToValueAtTime(Math.max(amp, 0.0002), t + 0.018);
      gp.exponentialRampToValueAtTime(0.0002, t + 1 / rate * 0.8);
      t += 1 / rate;
      rate = Math.max(6.5, rate - 0.28);
    }
    gp.linearRampToValueAtTime(0.0001, t + 0.15);
    stopLater([src, bp, g, p], actx, t + 0.4);
    this.state.wingbeats++;
  }
}
