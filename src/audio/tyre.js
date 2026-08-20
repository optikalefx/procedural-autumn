// ─────────────────────────────────────────────────────────────────────────────
//  The contact patch.
//
//  The player drove the sound lab and said: "the tyres sound like wind. Not an
//  offroad rubber tire with treads rolling." They were right, and no slider on
//  that page could have fixed it, because the tyre bed was white-then-pink
//  noise through a bandpass — and filtered continuous noise *is* wind. It is
//  the same signal a wind layer is made of. Turning its knobs moves it between
//  kinds of wind.
//
//  What is missing is not a frequency. It is the fact that gravel is not a
//  signal at all, it is a *sequence of events*:
//
//   1. **Granular, not continuous.** A tyre on gravel is a stream of discrete
//      stone impacts. Each one is a short enveloped burst ringing at a pitch
//      set by the stone's size. Measured on the old bed, the crest factor —
//      peak over RMS across 2.7 ms blocks — was 4.0-4.8 dB on rock and dirt,
//      which is Gaussian noise to two decimal places and cannot be moved by
//      filtering. Discrete impacts run three to four times that.
//   2. **The rate scales with speed, not just the gain.** A faster wheel hits
//      more stones per second. The old model's transient density measured
//      45-67/s and went *down* 8% as speed went up 5.5x — it was threshold
//      crossings in noise, not events. Gain was the only speed coupling there
//      was, so speed sounded like wind getting louder. That is the sentence the
//      player wrote, arrived at from the other end.
//   3. **A tread has a period.** Blocks passing the contact patch hum at
//      `speed / circumference x blocks`. That periodic component is the whole
//      difference between "off-road tyre" and "tyre", and there was no periodic
//      component anywhere in the old chain.
//   4. **The carcass rings.** A low thump under the granular layer, excited by
//      the impacts themselves. A bandpass on a noise bed cannot produce it,
//      because there is no impulse in a noise bed to excite anything.
//
//  So: four layers, of which only one is a noise bed.
//
//    grain    scheduled impacts, rate proportional to wheel rotation
//    bed      the continuous contact/brushing residual — real, but small, and
//             it is the *dominant* layer on grass and snow where the physics
//             genuinely is continuous rather than granular
//    tread    the block-passing hum, at speed x blocks / circumference
//    body     the carcass, driven by the grain envelopes so it is struck
//
//  ── on allocating nothing per grain ────────────────────────────────────────
//
//  At 22 m/s on rock this schedules ~370 impacts a second. A node per impact is
//  ~1100 node constructions a second and it will show up on the frame budget.
//  Instead there is a fixed pool of eight persistent channels — each one a
//  looping noise source, an envelope gain and a resonator — and a grain is
//  *automation*: five scheduled events on parameters that already exist. The
//  pool is built once in the constructor and nothing in `update` calls `new`.
//
//  ── on proving the layers are connected ────────────────────────────────────
//
//  Two bugs on this project were nodes whose parameters were written perfectly
//  every frame while the node reached nothing (an LFO summing into a gain as an
//  absolute amplitude; a duck node connected to no destination). Both were
//  invisible in the parameter values. So every gain here is reachable by name
//  from `layers()`, which is what the lab's per-layer trims and its zero test
//  drive — force one to zero and the bus has to move.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, smoothstep, damp, mulberry32 } from '../core/MathUtils.js';
import { noiseBuffer, noiseSource, filter, gain, Smooth, panner } from './synth.js';

/** How many impacts can be sounding at once.
 *
 *  Twelve, not eight. A channel that is retriggered while it is still ringing
 *  has its tail cut off, and the tail is the part that makes a stone read as a
 *  struck object rather than as a tick. On the slowest-decaying surfaces a
 *  grain runs ~60 ms against a per-channel interval of 30 ms at eight channels,
 *  so most grains were being truncated at exactly the surfaces whose character
 *  is the ring. These are persistent nodes built once, so the cost is 48 nodes
 *  standing still, not 48 more per second. */
const CHANNELS = 12;
/** Scheduler lookahead. Long enough to survive a dropped frame, short enough
 *  that a speed change is not audibly late. */
const LOOKAHEAD = 0.12;
/** Grains scheduled in one call, hard ceiling — a hitch must not queue a burst. */
const MAX_PER_CALL = 64;
/** The density the grain level is normalised against, so that density and
 *  loudness stay separable controls. See `_rateComp`. */
const RATE_REF = 200;

/**
 * What each surface does to the contact patch.
 *
 * `rate` is impacts per wheel revolution relative to the base; `hz` is the
 * centre a mid-sized stone rings at; `q` is how pitched that ring is (scree
 * is a click with a pitch, grass is a brush with none); `decay` is how long it
 * rings. The four level terms are the balance between the layers, and they are
 * the whole per-surface character.
 *
 * The level column is constrained by something already established and
 * measured: soft ground must be the *quietest* surface. A previous pass found
 * tyres 4.3 dB louder on grass than on bare rock — backwards — and fixed it to
 * 8.9 dB the right way round. Grass's grain level of 0.34 against rock's 1.00
 * keeps it there and then some, and it is checked, not asserted.
 */
export const SURFACE_CHARACTER = {
  //         rate    hz     q    decay   grain   bed  tread  body
  rock:   { rate: 1.25, hz: 2950, q: 3.4, decay: 0.0075, grain: 1.00, bed: 0.42, tread: 1.00, body: 0.85 },
  dirt:   { rate: 1.00, hz: 1750, q: 2.1, decay: 0.0125, grain: 0.86, bed: 0.62, tread: 0.88, body: 1.00 },
  sand:   { rate: 1.45, hz: 1050, q: 0.85, decay: 0.0190, grain: 0.52, bed: 0.95, tread: 0.34, body: 0.68 },
  dry:    { rate: 0.90, hz: 2150, q: 1.7, decay: 0.0105, grain: 0.62, bed: 0.72, tread: 0.58, body: 0.66 },
  litter: { rate: 1.05, hz: 2500, q: 1.2, decay: 0.0140, grain: 0.55, bed: 0.80, tread: 0.34, body: 0.52 },
  grass:  { rate: 0.72, hz: 1250, q: 0.70, decay: 0.0240, grain: 0.34, bed: 1.00, tread: 0.26, body: 0.58 },
  snow:   { rate: 0.62, hz: 780, q: 0.60, decay: 0.0280, grain: 0.26, bed: 0.92, tread: 0.18, body: 0.80 },
};

const CHAR_KEYS = ['rate', 'hz', 'q', 'decay', 'grain', 'bed', 'tread', 'body'];

export class TyreContact {
  /**
   * @param {AudioContext} actx
   * @param {AudioNode} out      the vehicle bus
   * @param {number} wheelRadius metres — sets both the impact rate and the
   *                             tread frequency, so it is not a magic number
   */
  constructor(actx, out, wheelRadius = 0.44, seed = 0x7ab1) {
    this.actx = actx;
    this.rnd = mulberry32(seed);
    this.circumference = 2 * Math.PI * wheelRadius;

    // Everything a person might want to move from the sound lab. Plain numbers,
    // not AudioParams, because most of them are model terms rather than node
    // settings — the lab writes them through explicit `apply` functions.
    this.tune = {
      stonesPerRev: 46,     // impacts per wheel revolution on the base surface
      rateScale: 1,         // global density multiplier
      maxRate: 460,         // ceiling, for the frame budget
      sizeSkew: 3.0,        // stone-size distribution: higher = mostly small
      hzScale: 1,           // brightness of the impacts
      qScale: 1,            // how pitched each impact is
      decayScale: 1,        // how long each impact rings
      jitter: 0.55,         // 0 = a metronome, 1 = fully irregular spacing
      grainDrive: 0.62,
      bedDrive: 0.42,
      treadDrive: 0.30,
      bodyDrive: 0.55,
      treadBlocks: 17,      // knobbles round the circumference
      bodyHz: 68,
      bodyQ: 3.0,
      spread: 0.55,         // stereo width of the impact pool
    };

    // ── the pool ────────────────────────────────────────────────────────────
    // Three uncorrelated buffers, staggered playback rates: eight channels
    // sharing one buffer at one rate sum coherently and comb as soon as two
    // grains overlap, which at 370 impacts a second is most of the time.
    const bufs = [
      noiseBuffer(actx, 2, 'white', 0x3f11),
      noiseBuffer(actx, 2, 'white', 0x91c7),
      noiseBuffer(actx, 2, 'white', 0xd20b),
    ];

    this.grainBus = gain(actx, 1);      // the bright, resonated side
    this.bodyBus = gain(actx, 1);       // the impulse feed for the carcass

    this.channels = [];
    for (let i = 0; i < CHANNELS; i++) {
      const src = noiseSource(actx, bufs[i % bufs.length], 0.82 + (i % 5) * 0.09);
      // Envelope *before* the resonator, not after. A gain envelope after a
      // filter is gated noise; before it, the filter is struck and rings past
      // the envelope, and the ring is what makes a stone a stone.
      const env = gain(actx, 0);
      const bp = filter(actx, 'bandpass', 2000, 2.0);
      const pan = panner(actx, 0);
      src.connect(env);
      env.connect(bp).connect(pan).connect(this.grainBus);
      // The same impulse also drives the carcass, tapped pre-resonator so
      // there is still low-frequency energy in it to excite anything with.
      env.connect(this.bodyBus);
      this.channels.push({ src, env, bp, pan });
    }
    this._spreadPan();
    this._next = 0;
    this._cursor = 0;

    this.gGrain = gain(actx, 0);
    this.grainBus.connect(this.gGrain).connect(out);

    // ── carcass ─────────────────────────────────────────────────────────────
    this.bodyBP = filter(actx, 'bandpass', this.tune.bodyHz, this.tune.bodyQ);
    this.bodyLP = filter(actx, 'lowpass', 220, 0.7);
    this.gBody = gain(actx, 0);
    this.bodyBus.connect(this.bodyBP).connect(this.bodyLP).connect(this.gBody).connect(out);

    // ── continuous bed ──────────────────────────────────────────────────────
    // What is left of the old model, and it keeps its old shaping for a reason:
    // pink under a Q 0.8 bandpass falls at a real 6 dB/oct where white would
    // cancel it to 3 and read as hiss. It is no longer the tyre; it is the
    // sliding contact under the impacts, and on grass it is most of the sound.
    const pink = noiseBuffer(actx, 4, 'pink', 0x6d19);
    this.bedSrc = noiseSource(actx, pink, 0.9);
    this.bedBand = filter(actx, 'bandpass', 360, 0.8);
    this.bedLP = filter(actx, 'lowpass', 1500, 0.6);
    this.gBed = gain(actx, 0);
    this.bedSrc.connect(this.bedBand).connect(this.bedLP).connect(this.gBed).connect(out);

    // ── tread ───────────────────────────────────────────────────────────────
    // Two orders, because a block passing is a pulse train rather than a sine,
    // and the second order is what stops it reading as a test tone. The lowpass
    // tracks the fundamental so the hum never gets edgy at speed.
    this.treadOsc = actx.createOscillator();
    this.treadOsc.type = 'triangle';
    this.treadOsc2 = actx.createOscillator();
    this.treadOsc2.type = 'sine';
    this.gTread1 = gain(actx, 1);
    this.gTread2 = gain(actx, 0.42);
    this.treadLP = filter(actx, 'lowpass', 400, 1.1);
    this.gTread = gain(actx, 0);
    this.treadOsc.connect(this.gTread1).connect(this.treadLP);
    this.treadOsc2.connect(this.gTread2).connect(this.treadLP);
    this.treadLP.connect(this.gTread).connect(out);
    this.treadOsc.start();
    this.treadOsc2.start();

    this.sm = {
      grain: new Smooth(this.gGrain.gain, 0.07, 0.0015),
      bed: new Smooth(this.gBed.gain, 0.09, 0.0015),
      tread: new Smooth(this.gTread.gain, 0.09, 0.0015),
      body: new Smooth(this.gBody.gain, 0.09, 0.0015),
      bedF: new Smooth(this.bedBand.frequency, 0.12, 6),
      treadF: new Smooth(this.treadOsc.frequency, 0.06, 0.4),
      treadF2: new Smooth(this.treadOsc2.frequency, 0.06, 0.8),
      treadLP: new Smooth(this.treadLP.frequency, 0.10, 8),
    };

    this._wander = 0;
    this._char = { ...SURFACE_CHARACTER.dirt };
    this.state = {
      rate: 0, grainHz: 0, treadHz: 0, scheduled: 0,
      grain: 0, bed: 0, tread: 0, body: 0, surface: 'dirt',
    };
  }

  /** Every gain the mixer owns, by name. The lab's trims and zero test use
   *  this, which is how "the node is actually in the path" gets proved. */
  layers() {
    return {
      tyreGrain: this.gGrain,
      tyreBed: this.gBed,
      tyreTread: this.gTread,
      tyreBody: this.gBody,
    };
  }

  _spreadPan() {
    const s = this.tune.spread;
    // Alternate outward rather than sweep left-to-right, so consecutive grains
    // (which go to consecutive channels) land on opposite sides and the pool
    // reads as stones under the whole vehicle instead of a moving point.
    for (let i = 0; i < this.channels.length; i++) {
      const step = Math.ceil((i + 1) / 2) / Math.ceil(this.channels.length / 2);
      this.channels[i].pan.pan.value = clamp((i % 2 ? -step : step) * s, -1, 1);
    }
  }

  /**
   * Blend the character table by surface weight.
   *
   * Weighted mean, not a max: the world hands out mixtures and a tyre crossing
   * from grass onto scree should cross, not switch. `litter` is never zero in
   * the real world (`getSurfaceWeights` floors it at 0.2), which is why the
   * table has an entry for it rather than folding it into grass.
   */
  _blend(w) {
    const c = this._char;
    for (const k of CHAR_KEYS) c[k] = 0;
    let total = 0;
    for (const name in SURFACE_CHARACTER) {
      const weight = w[name] ?? 0;
      if (weight <= 0) continue;
      total += weight;
      const s = SURFACE_CHARACTER[name];
      for (const k of CHAR_KEYS) c[k] += s[k] * weight;
    }
    if (total > 1e-4) { for (const k of CHAR_KEYS) c[k] /= total; }
    else Object.assign(c, SURFACE_CHARACTER.dirt);
    return c;
  }

  /**
   * Keep density and loudness separable.
   *
   * Overlapping grains sum incoherently, so the RMS of the layer rises as
   * sqrt(rate) all on its own — which means turning the density up would also
   * turn the volume up by 7 dB across the speed range, and "more stones per
   * second" and "louder" would stop being two controls. Dividing most of that
   * back out leaves the level where the mix expects it and leaves the speed
   * expression to `roll`, which is where it was tuned.
   */
  _rateComp(rate) {
    return Math.pow(RATE_REF / Math.max(rate, 1), 0.35);
  }

  /**
   * Schedule every grain that falls inside the lookahead window.
   *
   * Nothing here allocates. A grain is `cancelScheduledValues` plus four
   * scheduled events on parameters that were built in the constructor.
   */
  _schedule(now, rate, drive, c) {
    const interval = 1 / rate;
    if (this._next < now) this._next = now + this.rnd() * interval;
    const horizon = now + LOOKAHEAD;
    const jitter = clamp01(this.tune.jitter);
    let n = 0;
    while (this._next < horizon && n < MAX_PER_CALL) {
      const t = this._next;
      const ch = this.channels[this._cursor];
      this._cursor = (this._cursor + 1) % this.channels.length;

      // Stone size. The cube of a uniform is mostly small stones with an
      // occasional big one, and that long tail is exactly the crest factor —
      // a flat distribution of amplitudes measures almost as smooth as noise.
      const u = this.rnd();
      const size = Math.pow(u, this.tune.sizeSkew);
      const amp = drive * (0.10 + size * 0.90);
      // Big stones ring low and long, small ones high and short.
      const hz = clamp(c.hz * this.tune.hzScale * (1.45 - size * 0.85)
        * (0.78 + this.rnd() * 0.44), 90, 15000);
      const decay = c.decay * this.tune.decayScale * (0.65 + size * 1.6);
      const attack = Math.min(0.0006 + decay * 0.05, 0.004);

      // Retriggering a channel that is still ringing.
      //
      // `cancelScheduledValues(t)` on its own is a click, and not a small one:
      // per spec it removes the in-flight exponential ramp *entirely*, so the
      // param snaps back to the value it held when that ramp was scheduled —
      // a jump upward, mid-decay. Channels do overlap here (on snow, grains run
      // to 60 ms against a 30 ms per-channel interval at speed), so it would
      // fire constantly. `cancelAndHoldAtTime` cancels the future and keeps the
      // present value, and the linear ramp then starts from wherever the decay
      // had got to — continuous, no discontinuity to click.
      const g = ch.env.gain;
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
      else { g.cancelScheduledValues(t); g.setValueAtTime(Math.max(g.value, 1e-4), t); }
      g.linearRampToValueAtTime(amp, t + attack);
      g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
      ch.bp.frequency.setValueAtTime(hz, t);

      this._next += interval * (1 - jitter * 0.5 + this.rnd() * jitter);
      n++;
    }
    return n;
  }

  /**
   * @param {number} dt
   * @param {object} p  { speed, weights, scrub, roll }
   *   `roll` is the level envelope the vehicle model already computes, so the
   *   speed/level relationship stays owned by one place.
   */
  update(dt, p) {
    const actx = this.actx;
    const speed = Math.max(0, p.speed ?? 0);
    const w = p.weights ?? {};
    const scrub = clamp01(p.scrub ?? 0);
    const roll = Math.max(0, p.roll ?? 0);
    const c = this._blend(w);

    const speedN = clamp01(speed / 22);
    const wheelRps = speed / this.circumference;

    // ── impact rate ─────────────────────────────────────────────────────────
    // This is the point of the whole file: rate is proportional to wheel
    // rotation. A faster wheel hits more stones per second. Scrub adds impacts
    // too — a sliding tyre is tearing at the surface rather than rolling over
    // it — which is why it appears here and not only in the gain.
    const rate = Math.min(
      wheelRps * this.tune.stonesPerRev * c.rate * this.tune.rateScale * (1 + scrub * 0.7),
      this.tune.maxRate,
    );

    // ── levels ──────────────────────────────────────────────────────────────
    const scrubGain = 1 + scrub * 0.5;
    const grain = roll * c.grain * this.tune.grainDrive * this._rateComp(rate) * scrubGain;
    const bed = roll * c.bed * this.tune.bedDrive * scrubGain;
    const body = roll * c.body * this.tune.bodyDrive;
    // The tread hum needs the wheel actually turning fast enough for the block
    // rate to be a pitch rather than a flutter, so it fades in over 4-9 m/s and
    // is absent at a crawl. That is also true of the real thing.
    const treadFade = smoothstep(4, 9, speed);
    const tread = roll * c.tread * this.tune.treadDrive * treadFade;

    if (rate > 1 && grain > 1e-5) {
      this.state.scheduled = this._schedule(actx.currentTime, rate, 1, c);
    } else {
      this.state.scheduled = 0;
    }

    this.sm.grain.set(grain, actx);
    this.sm.bed.set(bed, actx);
    this.sm.body.set(body, actx);
    this.sm.tread.set(tread, actx);

    // The bed keeps the old model's surface tilt: soft ground rolls low and
    // dull, loose stone sits higher.
    this.sm.bedF.set(clamp(200 + speedN * 300 + (c.hz - 1750) * 0.10, 120, 1400), actx);

    // ── tread frequency ─────────────────────────────────────────────────────
    // blocks per second = revolutions per second x blocks per revolution.
    // At 12 m/s on a 0.44 m wheel that is 74 Hz, and at 22 m/s it is 136 —
    // which is the range the knobbly hum actually lives in.
    this._wander = damp(this._wander, this.rnd() * 2 - 1, 1.1, dt);
    const fTread = clamp(wheelRps * this.tune.treadBlocks * (1 + this._wander * 0.015), 8, 600);
    this.sm.treadF.set(fTread, actx);
    this.sm.treadF2.set(fTread * 2, actx);
    this.sm.treadLP.set(clamp(fTread * 3.2 + 120, 120, 1600), actx);

    if (this.bodyBP.frequency.value !== this.tune.bodyHz) this.bodyBP.frequency.value = this.tune.bodyHz;
    if (this.bodyBP.Q.value !== this.tune.bodyQ) this.bodyBP.Q.value = this.tune.bodyQ;
    // Q is per-surface but not per-grain: a scheduled Q per impact would double
    // the automation traffic to buy a difference nothing measured could find.
    const q = clamp(c.q * this.tune.qScale, 0.1, 20);
    for (const ch of this.channels) {
      if (ch.bp.Q.value !== q) ch.bp.Q.value = q;
    }

    this.state.rate = rate;
    this.state.grainHz = c.hz * this.tune.hzScale;
    this.state.treadHz = fTread;
    this.state.grain = grain;
    this.state.bed = bed;
    this.state.tread = tread;
    this.state.body = body;
    this.state.surface = c.grain > 0.7 ? 'loose' : c.grain > 0.45 ? 'mixed' : 'soft';
  }

  /** Silence, without tearing the graph down. Used when there is no vehicle. */
  silence() {
    const actx = this.actx;
    this.sm.grain.set(0, actx);
    this.sm.bed.set(0, actx);
    this.sm.tread.set(0, actx);
    this.sm.body.set(0, actx);
    this.state.scheduled = 0;
  }
}
