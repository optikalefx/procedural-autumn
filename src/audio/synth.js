// ─────────────────────────────────────────────────────────────────────────────
//  Small DSP toolkit shared by every audio layer.
//
//  Everything in this game is synthesised — there are no audio assets — so the
//  primitives here are the ones a procedural soundtrack actually needs:
//  deterministic noise beds, one-shot envelopes, a cheap reverb, and a
//  parameter wrapper that keeps per-frame automation from zippering.
// ─────────────────────────────────────────────────────────────────────────────
import { mulberry32 } from '../core/MathUtils.js';

/**
 * Filling a noise buffer from Math.random() would make every session sound
 * subtly different and make the audio test unrepeatable. Seeded, like the rest
 * of the world.
 */
export function noiseBuffer(actx, seconds = 4, kind = 'pink', seed = 0x9e37) {
  const n = Math.max(1, Math.floor(actx.sampleRate * seconds));
  const buf = actx.createBuffer(2, n, actx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const rnd = mulberry32((seed ^ (ch * 0x2545f491)) >>> 0);
    const d = buf.getChannelData(ch);
    if (kind === 'white') {
      for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
    } else if (kind === 'brown') {
      let last = 0;
      for (let i = 0; i < n; i++) {
        last = (last + (rnd() * 2 - 1) * 0.06) * 0.998;
        d[i] = last * 3.2;
      }
    } else {
      // Paul Kellet's economical pink filter. Pink is the right bed for wind
      // and water: white noise reads as tape hiss and fatigues within seconds.
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < n; i++) {
        const w = rnd() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    }
    // Cross-fade the seam so a looping buffer has no periodic tick — a click
    // once every four seconds is the single most obvious "this is a loop" tell.
    const fade = Math.min(2048, (n / 4) | 0);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      d[i] = d[i] * t + d[n - fade + i] * (1 - t);
    }
  }
  return buf;
}

/** A looping noise bed. Started immediately; it costs nothing while muted. */
export function noiseSource(actx, buffer, rate = 1) {
  const src = actx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.playbackRate.value = rate;
  src.start(0);
  return src;
}

/** Biquad shorthand. */
export function filter(actx, type, freq, q = 0.7, gain = 0) {
  const f = actx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  if (gain) f.gain.value = gain;
  return f;
}

export function gain(actx, v = 0) {
  const g = actx.createGain();
  g.gain.value = v;
  return g;
}

/**
 * A slow sine LFO wired into `param`, for breathing gusts and wobble.
 *
 * `depth` is in the param's own units and **sums** with whatever the mixer
 * writes to that param — it does not scale it. That is what you want for a
 * filter cutoff (a 380 Hz swing on a 900 Hz band is a gust you can hear
 * arrive) and it is a trap for a gain. See `swell` below before reaching for
 * this on a `gain` AudioParam.
 */
export function lfo(actx, freq, depth, param, phaseSeconds = 0) {
  const o = actx.createOscillator();
  o.frequency.value = freq;
  const g = actx.createGain();
  g.gain.value = depth;
  o.connect(g).connect(param);
  o.start(actx.currentTime + phaseSeconds);
  return { osc: o, gain: g };
}

/**
 * A *multiplicative* slow swell: a gain node centred on 1.0 with an LFO moving
 * it by `depth` as a fraction, so 0.8 breathes between ×0.2 and ×1.8.
 *
 * This exists because `lfo()` on a gain param is a bug that hides in plain
 * sight. The LFO sums into the param, so its depth is an absolute amplitude
 * rather than a proportion of the level the mixer asked for — and if the depth
 * is larger than that level, the LFO simply *becomes* the level and everything
 * upstream of the gain stops mattering. Measured on this project: the ambience
 * bed's model was zeroed and the bed kept playing within 0.3 dB, because two
 * ±0.35 LFOs were sitting on gains the model was setting to 0.05.
 *
 * Put the breathing in its own node and the two stay separable: the mixer owns
 * the level, the swell owns the movement, and neither can eat the other.
 */
export function swell(actx, freq, depth, phaseSeconds = 0) {
  const g = gain(actx, 1);
  lfo(actx, freq, depth, g.gain, phaseSeconds);
  return g;
}

/**
 * Convolution reverb from a synthesised impulse — a noise burst under an
 * exponential decay, with the early part shaped so it reads as "valley" rather
 * than "cathedral". Two channels with independent noise gives it width.
 */
export function valleyImpulse(actx, seconds = 2.6, decay = 2.6, seed = 0x51f7) {
  const n = Math.floor(actx.sampleRate * seconds);
  const buf = actx.createBuffer(2, n, actx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const rnd = mulberry32((seed ^ (ch * 0x85ebca6b)) >>> 0);
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      // A short pre-delay of near-silence, then the tail. Real open valleys
      // answer late; an instant tail sounds like a small tiled room.
      const pre = t < 0.012 ? t / 0.012 : 1;
      d[i] = (rnd() * 2 - 1) * Math.pow(1 - t, decay) * pre;
    }
  }
  const c = actx.createConvolver();
  c.buffer = buf;
  return c;
}

/** Soft saturation curve — adds grit to the engine without buzzing. */
export function tanhCurve(amount = 2.2, n = 1024) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return c;
}

/**
 * A smoothed control parameter.
 *
 * Writing `param.value = x` every frame produces audible zipper noise, and
 * calling setTargetAtTime 60 times a second for every layer is wasteful. This
 * only schedules when the target has actually moved, and always with a time
 * constant, so every change arrives as a glide.
 */
export class Smooth {
  constructor(param, tc = 0.08, eps = 0.002) {
    this.p = param;
    this.tc = tc;
    this.eps = eps;
    this.last = param.value;
  }
  set(v, actx) {
    if (!(v >= 0) && !(v <= 0)) return;                  // NaN guard
    if (Math.abs(v - this.last) < this.eps) return;
    this.last = v;
    // setTargetAtTime is exponential and never overshoots, which matters for
    // gains that must reach true zero when a layer is faded out.
    this.p.setTargetAtTime(v, actx.currentTime, this.tc);
  }
  /** Jump without a glide — used when a voice is re-targeted to a new source. */
  hard(v, actx) {
    this.last = v;
    this.p.cancelScheduledValues(actx.currentTime);
    this.p.setValueAtTime(v, actx.currentTime);
  }
}

/**
 * One-shot percussive envelope. `attack` is deliberately never zero: a gain
 * step from 0 is a click, and a 3 ms ramp is inaudible as an attack but
 * completely removes it.
 */
export function ping(actx, node, when, peak, attack = 0.004, decay = 0.25) {
  const g = node.gain;
  g.cancelScheduledValues(when);
  g.setValueAtTime(0.0001, when);
  g.linearRampToValueAtTime(peak, when + attack);
  g.exponentialRampToValueAtTime(0.0001, when + attack + decay);
}

/** Frees a one-shot's nodes once it has finished sounding. */
export function stopLater(nodes, actx, at) {
  const delay = Math.max(0, at - actx.currentTime) * 1000 + 60;
  setTimeout(() => {
    for (const n of nodes) {
      try { n.stop?.(); } catch { /* already stopped */ }
      try { n.disconnect(); } catch { /* already gone */ }
    }
  }, delay);
}

/** Equal-power pan position from a listener-relative direction, -1 … 1. */
export function panner(actx, v = 0) {
  const p = actx.createStereoPanner();
  p.pan.value = v;
  return p;
}
