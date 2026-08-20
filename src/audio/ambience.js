// ─────────────────────────────────────────────────────────────────────────────
//  Ambience — the bed the whole game sits on.
//
//  Five continuous layers, cross-faded by *where the player is* rather than by
//  a timer: wind through dry grass, wind through conifers, a high thin hush at
//  altitude, birdsong by day and crickets at dusk. Nothing here loops in a way
//  you can hear: the noise beds are four-second seamless buffers under moving
//  filters, and the two voiced layers (birds, crickets) are scheduled events.
//
//  The mix rule that makes it feel like a place: the layers are *exclusive*.
//  Open meadow means grass and birds; forest means conifer hiss and closer,
//  softer birds; altitude means wind and nothing else. Playing all of it at
//  once is what makes ambience read as wallpaper.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, lerp, smoothstep, mulberry32 } from '../core/MathUtils.js';
import { noiseBuffer, noiseSource, filter, gain, lfo, swell, Smooth, ping, stopLater, panner } from './synth.js';

// Bird species as (pitch, shape) recipes rather than samples. `bend` is how far
// the note slides, in semitone-ish ratio; `n` is notes per call.
const BIRDS = [
  { f: 3400, bend: 1.22, n: [2, 4], dur: 0.055, gap: 0.085, kind: 'chirp' },
  { f: 2350, bend: 0.72, n: [3, 5], dur: 0.075, gap: 0.115, kind: 'trill' },
  { f: 4300, bend: 1.45, n: [1, 2], dur: 0.040, gap: 0.070, kind: 'chirp' },
  { f: 1750, bend: 0.86, n: [2, 3], dur: 0.130, gap: 0.180, kind: 'flute' },
];

/**
 * A field of crickets, rendered once into a looping buffer.
 *
 * Scheduling ten thousand 12 ms bursts a minute through the WebAudio graph is
 * real CPU for a texture nobody can pick individual insects out of. Rendering
 * a handful of individuals into a seamless eight-second bed costs nothing per
 * frame and sounds better, because the individuals can be dense.
 */
function cricketBed(actx, seed = 0x3f11) {
  const sr = actx.sampleRate;
  const secs = 8;
  const n = Math.floor(sr * secs);
  const buf = actx.createBuffer(2, n, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const rnd = mulberry32(seed);

  for (let ind = 0; ind < 9; ind++) {
    const f = 3900 + rnd() * 1500;                 // this insect's pitch
    const period = 0.30 + rnd() * 0.42;            // chirp group interval
    const pulses = 2 + ((rnd() * 3) | 0);
    const pulseLen = 0.011 + rnd() * 0.006;
    const pan = rnd() * 2 - 1;
    const amp = (0.05 + rnd() * 0.06) / (1 + Math.abs(pan));
    const gl = amp * Math.sqrt(0.5 * (1 - pan));
    const gr = amp * Math.sqrt(0.5 * (1 + pan));
    let t = rnd() * period;
    while (t < secs) {
      for (let p = 0; p < pulses; p++) {
        const t0 = t + p * pulseLen * 2.1;
        const i0 = Math.floor(t0 * sr);
        const len = Math.floor(pulseLen * sr);
        for (let i = 0; i < len; i++) {
          // Raised-cosine window: a hard-edged burst clicks, and a field of
          // clicks reads as static rather than as insects.
          const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len);
          const s = Math.sin((2 * Math.PI * f * i) / sr) * w;
          const j = (i0 + i) % n;
          L[j] += s * gl;
          R[j] += s * gr;
        }
      }
      t += period * (0.82 + rnd() * 0.36);
    }
  }
  return buf;
}

export class Ambience {
  constructor(actx, bus, reverb) {
    this.actx = actx;
    this.bus = bus;
    this.reverb = reverb;
    this.rnd = mulberry32(0x5eed ^ 0x11);

    const pink = noiseBuffer(actx, 4, 'pink', 0x1a2b);
    const pink2 = noiseBuffer(actx, 4, 'pink', 0x7c4d);

    // ── layer 1: wind over open dry grass ─────────────────────────────────
    // A band around 900 Hz is the "dry rustle"; the low shelf under it is the
    // body of moving air. The filter LFO and the swell run at different rates
    // and phases, so gusts brighten and swell at slightly different moments,
    // the way real ones do.
    //
    // The swell is a node in the chain, not an LFO on `grassGain.gain`. It was
    // the latter, at a depth of 0.35 against a model that sets that gain to
    // about 0.05, which meant the LFO *was* the wind and the model was
    // inaudible: zeroing every gain here left the bed playing within 0.3 dB of
    // normal (`tools/_scratch/lfoprobe.mjs`). That is why the bed ignored the
    // weather, why the conifer hiss played in open meadow, and why two rounds
    // of cutting the bus gain did not fix "the wind is too loud".
    this.grassSrc = noiseSource(actx, pink);
    this.grassBand = filter(actx, 'bandpass', 820, 0.55);
    // Two poles rather than one. Harshness is spectral before it is loud, and
    // a single 12 dB/oct skirt over a broad band left a fifth of this bed's
    // energy above 2 kHz — right in the ear's most sensitive octave.
    this.grassLow = filter(actx, 'lowpass', 1100, 0.7);
    this.grassLow2 = filter(actx, 'lowpass', 1500, 0.5);
    this.grassSwell = swell(actx, 0.037, 0.55, 0.4);
    this.grassGain = gain(actx, 0);
    this.grassSrc.connect(this.grassBand).connect(this.grassLow).connect(this.grassLow2)
      .connect(this.grassSwell).connect(this.grassGain).connect(bus);
    lfo(actx, 0.061, 210, this.grassBand.frequency);

    // ── layer 2: wind through conifers ────────────────────────────────────
    // Needles hiss higher than grass does and have almost no low end; the
    // separation between this and the grass band is most of what tells the
    // player they have driven into the trees. It is a *hiss*, so it is the
    // layer most able to fatigue — the band is narrower and capped than it
    // was, and it now genuinely plays only where there are conifers.
    this.coniferSrc = noiseSource(actx, pink2, 0.93);
    this.coniferBand = filter(actx, 'bandpass', 1850, 0.7);
    this.coniferHi = filter(actx, 'highpass', 620, 0.5);
    this.coniferCap = filter(actx, 'lowpass', 3200, 0.6);
    this.coniferSwell = swell(actx, 0.029, 0.58, 2.0);
    this.coniferGain = gain(actx, 0);
    this.coniferSrc.connect(this.coniferHi).connect(this.coniferBand).connect(this.coniferCap)
      .connect(this.coniferSwell).connect(this.coniferGain).connect(bus);
    lfo(actx, 0.048, 480, this.coniferBand.frequency, 1.1);

    // ── layer 3: the hush at altitude ─────────────────────────────────────
    // Almost no information — a low moving air mass with the top rolled off.
    // Its job is to make high ground feel *empty*, so it comes in as the other
    // layers are being taken away.
    this.hushSrc = noiseSource(actx, pink, 0.61);
    this.hushLow = filter(actx, 'lowpass', 320, 0.8);
    this.hushSwell = swell(actx, 0.023, 0.48, 1.4);
    this.hushGain = gain(actx, 0);
    this.hushSrc.connect(this.hushLow).connect(this.hushSwell).connect(this.hushGain).connect(bus);
    lfo(actx, 0.021, 110, this.hushLow.frequency, 0.7);

    // ── layer 4: crickets ─────────────────────────────────────────────────
    this.cricketSrc = noiseSource(actx, cricketBed(actx));
    this.cricketBand = filter(actx, 'bandpass', 4300, 1.1);
    this.cricketGain = gain(actx, 0);
    this.cricketSrc.connect(this.cricketBand).connect(this.cricketGain).connect(bus);

    // ── layer 5: birds (scheduled, not a bed) ─────────────────────────────
    // Birds go through the shared valley reverb: a call with no tail sounds
    // like it was recorded in a cupboard, and the tail is what places it out
    // among the trees.
    this.birdBus = gain(actx, 0.78);
    this.birdBus.connect(bus);
    this.birdWet = gain(actx, 0.34);
    this.birdBus.connect(this.birdWet).connect(reverb);
    this._birdTimer = 1.5;

    this.sm = {
      grass: new Smooth(this.grassGain.gain, 0.5),
      conifer: new Smooth(this.coniferGain.gain, 0.6),
      hush: new Smooth(this.hushGain.gain, 0.8),
      cricket: new Smooth(this.cricketGain.gain, 1.2),
      grassF: new Smooth(this.grassLow.frequency, 0.6, 8),
    };
    this.state = { grass: 0, conifer: 0, hush: 0, cricket: 0, birdRate: 0 };
  }

  /**
   * `L` is the shared listener sample built once per frame by Audio.js:
   * position, biome weights, moisture, altitude, hour, wind strength, and how
   * enclosed the player is.
   */
  update(dt, L) {
    const actx = this.actx;
    const wind = clamp(L.wind, 0.35, 2.2);

    // How hard it is blowing, 0.16 … 1.31.
    //
    // `wind` is Weather's whole-valley gust envelope, and in practice it runs
    // 0.35 … 1.26 — not 0 … 2. The old curve normalised it against 1.8 and
    // then lerped 0.55 … 1.5, which compressed the entire real range of the
    // weather into 4.4 dB. Normalised against the range the weather actually
    // produces, and squared, the same weather now spans 18 dB.
    //
    // That is deliberately *more* dynamic than before, not less. The player's
    // note was that the quiet moments are the good ones and the loud ones are
    // too much, which is a complaint about the floor being high rather than
    // the peak being high — so the answer is to widen the gap, not to flatten
    // everything toward the middle.
    const breeze = clamp01((wind - 0.32) / 0.94);
    const strength = 0.26 + 0.88 * breeze * breeze;

    // Open ground: gold meadow and dry grass. Fades out under canopy and above
    // the treeline, both of which have their own layer.
    const openness = clamp01(L.open) * (1 - L.altitude * 0.75);
    const grass = 0.235 * openness * strength * L.indoors;
    // Conifers: keyed off moisture/forest weight, which is what actually puts
    // the trees there. Lower than the grass bed because it is a hiss and sits
    // an octave higher, where the ear is roughly 1 dB *more* sensitive.
    const conifer = 0.165 * clamp01(L.forest) * strength * L.indoors;
    // Altitude hush ramps in over the last stretch below the treeline. It is
    // nearly all sub-500 Hz, where the ear gives up 9 dB, so it carries a
    // higher number for the same loudness.
    const hush = 0.180 * L.altitude * lerp(0.55, 1.15, breeze);

    // Crickets: dusk and the short hour before dawn, and never on bare rock or
    // snow — they live in the grass.
    const h = L.hour;
    const dusk = smoothstep(17.6, 19.6, h) * (1 - smoothstep(22.5, 24, h));
    const preDawn = smoothstep(2.5, 4.0, h) * (1 - smoothstep(5.4, 6.6, h));
    // Trimmed alongside the wind bed. Crickets were always modelled correctly,
    // so they were only ever quiet *relative* to a wind layer that was running
    // six times louder than its own model. Left alone they would simply have
    // inherited the problem.
    const cricket = 0.075 * Math.max(dusk, preDawn) * clamp01(L.open + L.forest * 0.4) * (1 - L.altitude) * L.indoors;

    this.sm.grass.set(grass, actx);
    this.sm.conifer.set(conifer, actx);
    this.sm.hush.set(hush, actx);
    this.sm.cricket.set(cricket, actx);
    // Wind gets brighter as it strengthens — a gust you can hear arrive. The
    // ceiling came down with it: at 1200 + wind*900 this sat near 1.9 kHz, and
    // a fifth of the bed's energy was above 2 kHz.
    this.sm.grassF.set(740 + breeze * 540, actx);

    this.state.grass = grass;
    this.state.conifer = conifer;
    this.state.hush = hush;
    this.state.cricket = cricket;

    // ── birdsong ────────────────────────────────────────────────────────────
    // Dawn chorus is the loudest hour of a real autumn morning by a wide
    // margin; midday is steady; after sunset there is nothing.
    const dawnChorus = smoothstep(5.2, 6.6, h) * (1 - smoothstep(8.4, 10.5, h));
    const day = smoothstep(6.4, 8.0, h) * (1 - smoothstep(17.2, 19.0, h));
    const habitat = clamp01(L.forest * 1.15 + L.open * 0.7) * (1 - L.altitude * 0.9);
    // Calls per second.
    const rate = (0.20 + dawnChorus * 1.5) * (0.35 + day * 0.65) * habitat * L.indoors;
    this.state.birdRate = rate;

    this._birdTimer -= dt;
    if (this._birdTimer <= 0 && rate > 0.02) {
      this._birdTimer = (0.4 + this.rnd() * 1.6) / clamp(rate, 0.05, 2.2);
      this._call(L, dawnChorus);
    } else if (this._birdTimer <= 0) {
      this._birdTimer = 1.2;
    }
  }

  /** One bird call: a short phrase of bent notes, placed somewhere off to a side. */
  _call(L, chorus) {
    const actx = this.actx;
    const r = this.rnd;
    const sp = BIRDS[(r() * BIRDS.length) | 0];
    // Distance is faked rather than positional: a bird is a point source you
    // never see, so all that matters is that it is *somewhere else*. Near calls
    // are rare, which is what makes them feel like an event.
    const near = r() < 0.18 + chorus * 0.12;
    const dist = near ? 0.25 + r() * 0.3 : 0.6 + r() * 0.4;
    const level = (near ? 0.16 : 0.055) * (1 - dist * 0.5);

    const out = gain(actx, 0);
    const pan = panner(actx, (r() * 2 - 1) * 0.85);
    // Distance eats the top first. A far bird through an open lowpass is the
    // single most artificial-sounding thing in a synthesised ambience.
    const tone = filter(actx, 'lowpass', lerp(7000, 1600, dist), 0.9);
    out.connect(tone).connect(pan).connect(this.birdBus);

    const notes = sp.n[0] + ((r() * (sp.n[1] - sp.n[0] + 1)) | 0);
    const t0 = actx.currentTime + 0.02;
    const oscs = [];
    for (let i = 0; i < notes; i++) {
      const when = t0 + i * (sp.gap + r() * 0.03);
      const o = actx.createOscillator();
      o.type = sp.kind === 'flute' ? 'sine' : 'triangle';
      const f = sp.f * (0.92 + r() * 0.16) * (1 - i * 0.02);
      const g2 = gain(actx, 0);
      o.connect(g2).connect(out);
      // The bend is the whole character: a chirp rises then falls inside 50 ms.
      o.frequency.setValueAtTime(f * (sp.kind === 'trill' ? 1 : 0.86), when);
      o.frequency.exponentialRampToValueAtTime(f * sp.bend, when + sp.dur * 0.4);
      o.frequency.exponentialRampToValueAtTime(f * 0.94, when + sp.dur);
      ping(actx, g2, when, 1.0, 0.006, sp.dur);
      o.start(when);
      o.stop(when + sp.dur + 0.12);
      oscs.push(o, g2);
    }
    out.gain.setValueAtTime(level, t0);
    stopLater([...oscs, out, tone, pan], actx, t0 + notes * (sp.gap + 0.05) + 0.6);
    void L;
  }
}
