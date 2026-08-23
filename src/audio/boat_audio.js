// ─────────────────────────────────────────────────────────────────────────────
//  BoatAudio — the canoe and the kayak, heard from the water line.
//
//  A small boat is almost silent, and that is the design constraint rather
//  than a problem: the paddle stroke is the hero sound and everything else is
//  the quiet that makes it land. Three continuous layers and five one-shots:
//
//    glide   speed-scaled water on the hull. The same three-band pink voice
//            as water.js — low body, a wandering band-pass for the gurgle, a
//            top band kept to a garnish — because filtered noise that does
//            not wander is what the ear files under "hiss" (see the river
//            voice's history). The band centre also rises with speed: a hull
//            at cruise is a laminar "shhh", a hull barely moving is a burble.
//    laps    sparse "plip" taps against a moored hull, on a cluster-free
//            0.8–2.5 s clock, with an occasional very quiet hull resonance —
//            wood for the canoe, hollow rotomoulded poly for the kayak.
//    drips   tiny high plips off the paddle for a couple of seconds after a
//            stroke, only while the player is actually aboard.
//
//  One-shots ride `cue(kind, opts)` exactly like the camp props, because the
//  camp props got the hard parts right already: distance/pan computed once
//  into a cue context, ±6% pitch and ±8% length jitter so nothing ever
//  repeats bit-identically, a crowding duck so a launch (scrape + splash +
//  settle laps) is one event rather than a pile of simultaneous peaks, and
//  one CUE_GAIN so the layer's loudness is a single decision.
//
//  The layer reads `ctx.systems.boat` DEFENSIVELY. The boat gameplay system
//  may not exist yet (it is being built in parallel), and per Audio rule 1 a
//  missing peer must cost nothing: no boat, no sound, no exception.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, lerp, smoothstep, mulberry32 } from '../core/MathUtils.js';
import { noiseBuffer, noiseSource, filter, gain, lfo, swell, Smooth, ping, stopLater, panner } from './synth.js';

// How far a stroke carries. 40 m rather than the camp's 30: it happens on open
// water with nothing between it and the listener, and the follow camera sits
// 6–10 m from the hull — the cue has to be present there and gone from shore.
const REACH = 40;
const NEAR = 4.0;
const FALLOFF = 1.5;

// Below this a cue is dropped rather than scheduled — same economy as the camp.
const FLOOR = 0.02;

// One trim for every one-shot and tap event in the layer. Calibrated the way
// CUE_GAIN in camp_props.js was, and against it: a camp prop at 8 m peaks
// about -20 dBFS on its tap, and a stroke should sit within a few dB of that
// — audible and tactile at the boat camera, inaudible past ~40 m.
//
//   3.2  the first guess. Measured: stroke at 8 m peaked -14.5 dBFS on the
//        boat tap, ~5 dB proud of the camp anchor — a stroke the player
//        repeats hundreds of times was the loudest transient in the mix.
//   2.0  -4.1 dB. Stroke at 8 m ≈ -19 dBFS on the tap (≈ -30 at the master),
//        beside the camp props where it belongs, and the laps/drips under it
//        scale down with it.
const CUE_GAIN = 2.0;

// Loudness bookkeeping copied from camp_props.js (see the long note there): a
// band-pass throws away pass-band-proportional energy, and the pink and brown
// beds are much smaller per unit amplitude than white. Neither is a taste
// question, so neither is allowed to hide inside the voice tables.
const NOISE_REF = 900;
const bwGain = (f, q) => Math.sqrt(NOISE_REF / clamp((Math.PI / 2) * f / q, 30, 6000));

function rmsOf(buf) {
  const d = buf.getChannelData(0);
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 17) { sum += d[i] * d[i]; n++; }
  return Math.sqrt(sum / Math.max(1, n));
}

// Crowding — identical numbers to the camp. A launch schedules five bursts
// inside a second and a half; they should mask each other, not stack.
const CROWD_WINDOW = 0.28;
const CROWD_K = 0.18;
const CROWD_MAX = 5;

/**
 * The two hulls. A kayak is sleeker and sits lower, so its glide is brighter
 * and its knocks are the duller, less ringing sound of rotomoulded poly;
 * the canoe is a bigger, woodier box and everything on it is a third lower.
 */
const HULL = {
  canoe: {
    bright: 1.0,          // glide band-centre multiplier
    hissG: 0.10,          // glide top-band ceiling
    lowG: 1.0,            // glide low-band scale
    stroke: 1.0,          // stroke pitch multiplier
    strokeBody: 1.0,      // stroke catch weight — the canoe digs deeper
    knock: [178, 318],    // hull resonances, Hz
    knockType: 'sine',    // wood rings on a near-pure partial
    knockDur: 1.0,
  },
  kayak: {
    bright: 1.22,
    hissG: 0.14,
    lowG: 0.82,
    stroke: 1.16,
    strokeBody: 0.78,
    knock: [152, 264],
    knockType: 'triangle', // odd harmonics — hollow plastic, same reasoning
    knockDur: 1.25,        //   as the camp cooler. Poly thunks longer, lower.
  },
};

/**
 * One-shot voices, camp_props style: each receives the cue context `c` —
 * level, pan, hull, jittered shape — and schedules its graph through the
 * helpers below. `this` is the BoatAudio instance.
 */
const VOICES = {
  /**
   * The paddle stroke — the hero sound. Three phases of one gesture:
   * the catch (blade entering: a soft low plunk, pitch falling as the water
   * closes over it), the drive (0.4 s of pink swash sliding down as the blade
   * accelerates), and the release (two or three staggered high drips off the
   * lifted blade). Panned to the stroke's side. The canoe digs deeper and
   * rounder; the kayak is lighter and a sixth higher.
   */
  stroke(c) {
    const s = 0.35 + c.strength * 0.65;
    const p = c.hull.stroke;
    const side = clamp(c.side * 0.30, -0.35, 0.35);
    // catch
    this._tone(c, 0.000, { f0: 250 * p, f1: 120 * p, peak: 0.150 * s * c.hull.strokeBody, attack: 0.006, dur: 0.13, pan: side });
    this._noise(c, 0.000, { f: 330 * p, q: 2.0, peak: 0.085 * s, attack: 0.003, dur: 0.07, pan: side });
    // drive
    this._sweep(c, 0.045, { f0: 680 * p, f1: 330 * p, q: 0.8, peak: 0.130 * s, attack: 0.045, dur: 0.38, pan: side });
    // release drips
    const n = 2 + (this.rnd() < 0.5 ? 1 : 0);
    let at = 0.34;
    for (let i = 0; i < n; i++) {
      this._noise(c, at, {
        f: 2100 + this.rnd() * 1300, q: 8, peak: 0.030 * s * (1 - i * 0.25),
        attack: 0.001, dur: 0.028 + this.rnd() * 0.02, pan: side + (this.rnd() - 0.5) * 0.12,
      });
      at += 0.09 + this.rnd() * 0.09;
    }
  },

  /**
   * Launch — the hull sliding off the bank into the water. A grainy brown
   * scrape (the keel over sand and grass), a generous splash on the
   * vehicle-splash recipe (pink, 1400 → 380 Hz over half a second), a low
   * body of displaced water, then two settle-laps as the hull stops bobbing.
   */
  launch(c) {
    this._grind(c, 0.000, { lp: 520, peak: 0.115, attack: 0.050, dur: 0.60 });
    this._sweep(c, 0.300, { f0: 1400, f1: 380, q: 0.7, peak: 0.200, attack: 0.022, dur: 0.50 });
    this._tone(c, 0.320, { f0: 130, f1: 68, peak: 0.050, attack: 0.020, dur: 0.26 });
    this._noise(c, 0.950, { f: 840, q: 1.4, peak: 0.036, attack: 0.006, dur: 0.10 });
    this._noise(c, 1.300, { f: 640, q: 1.4, peak: 0.022, attack: 0.008, dur: 0.12 });
  },

  /**
   * Boarding — a knee and a hand on the hull. Two resonant knocks on the
   * hull's own partials (wood vs poly per kind), the water answering
   * underneath, and the little creak of the hull taking weight.
   */
  board(c) {
    const [k1, k2] = c.hull.knock;
    const kd = c.hull.knockDur;
    this._tone(c, 0.000, { f0: k1, f1: k1 * 0.93, peak: 0.085, attack: 0.002, dur: 0.13 * kd, type: c.hull.knockType });
    this._tone(c, 0.075, { f0: k2, f1: k2 * 0.93, peak: 0.048, attack: 0.002, dur: 0.09 * kd, type: c.hull.knockType });
    this._sweep(c, 0.030, { f0: 700, f1: 420, q: 1.0, peak: 0.042, attack: 0.020, dur: 0.22 });
    // The creak: a narrow band swept UP with a soft attack — stressed material
    // rising in pitch, nothing else in this file moves that direction.
    this._sweep(c, 0.160, { f0: 410, f1: 560, q: 7.0, peak: 0.034, attack: 0.050, dur: 0.18 });
  },

  /** Beaching — sand and gravel under the keel, decelerating to a stop. */
  beach(c) {
    this._sweep(c, 0.000, { f0: 1500, f1: 620, q: 0.8, peak: 0.095, attack: 0.020, dur: 0.50 });
    // A few gravel ticks under the hiss, spaced further apart as the hull slows.
    let at = 0.04;
    for (const gap of [0.07, 0.13, 0.22]) {
      this._noise(c, at, {
        f: 1000 + this.rnd() * 900, q: 5, peak: 0.028 + this.rnd() * 0.012,
        attack: 0.001, dur: 0.03, pan: (this.rnd() - 0.5) * 0.15,
      });
      at += gap;
    }
    this._tone(c, 0.060, { f0: 95, f1: 58, peak: 0.030, attack: 0.030, dur: 0.30 });
  },

  /** A shoreline nudge — one hull knock and the plip of the water it moved. */
  bump(c) {
    const [k1] = c.hull.knock;
    this._tone(c, 0.000, { f0: k1 * 1.08, f1: k1 * 0.82, peak: 0.065, attack: 0.002, dur: 0.09 * c.hull.knockDur, type: c.hull.knockType });
    this._noise(c, 0.025, { f: 2500, q: 6, peak: 0.020, attack: 0.001, dur: 0.03 });
    this._noise(c, 0.055, { f: 880, q: 1.5, peak: 0.028, attack: 0.008, dur: 0.11 });
  },
};

export class BoatAudio {
  constructor(actx, bus, reverb, ctx) {
    this.actx = actx;
    this.ctx = ctx;
    this.rnd = mulberry32(0xb0a7);

    this.bus = gain(actx, 1);          // the layer's tap point
    this.bus.connect(bus);
    // A small send — the stroke happens a metre from the listener's head, and
    // a wet near-field sound is at the bottom of a well (camp_audio, same call).
    this.wet = gain(actx, 0.14);
    this.bus.connect(this.wet).connect(reverb);

    // One-shots, laps and drips all funnel through one trim, so the layer's
    // cue loudness is one number (the CUE_GAIN lesson).
    this.cueBus = gain(actx, CUE_GAIN);
    this.cueBus.connect(this.bus);
    this.gLap = gain(actx, 1);
    this.gLap.connect(this.cueBus);
    this.gDrip = gain(actx, 1);
    this.gDrip.connect(this.cueBus);

    // Noise beds. Pink for water (the standing rule: white noise reads as tape
    // hiss — see water.js), white for ticks and drips where a high-Q band
    // throws nearly all of it away, brown lazily for the one launch scrape.
    this.pink = noiseBuffer(actx, 3, 'pink', 0xb0a1);
    this.hiss = noiseBuffer(actx, 1.2, 'white', 0xb0a2);
    this.brown = null;
    this._srcNorm = { pink: 0.5 / rmsOf(this.pink), hiss: 0.5 / rmsOf(this.hiss), brown: 0 };

    // ── the glide voice ─────────────────────────────────────────────────────
    // Same anatomy as a WaterVoice: three bands off one pink source under a
    // shared air lowpass, a multiplicative swell (never an LFO summed into a
    // gain — synth.js documents the floor bug), and a wandering band centre so
    // the bed is never stationary.
    const g = this.glide = {
      src: noiseSource(actx, this.pink, 1),
      low: filter(actx, 'lowpass', 260, 0.8),
      body: filter(actx, 'bandpass', 520, 0.6),
      hiss: filter(actx, 'highpass', 2400, 0.6),
      gLow: gain(actx, 0.8),
      gBody: gain(actx, 1.2),
      gHiss: gain(actx, 0),
      air: filter(actx, 'lowpass', 7000, 0.6),
      out: gain(actx, 0),
      pan: panner(actx, 0),
    };
    g.src.connect(g.low).connect(g.gLow).connect(g.air);
    g.src.connect(g.body).connect(g.gBody).connect(g.air);
    g.src.connect(g.hiss).connect(g.gHiss).connect(g.air);
    g.swell = swell(actx, 0.06 + this.rnd() * 0.03, 0.28);
    g.air.connect(g.swell).connect(g.out).connect(g.pan).connect(this.bus);
    // The gurgle: the body band wanders. Summing LFO on a *frequency* is the
    // right tool (the swing is in hertz) — a touch faster than a creek's,
    // because the stones here are the hull moving through its own bow wave.
    lfo(actx, 0.21, 110, g.body.frequency);

    this.sm = {
      out: new Smooth(g.out.gain, 0.20, 0.0012),
      body: new Smooth(g.body.frequency, 0.18, 4),
      low: new Smooth(g.gLow.gain, 0.3, 0.01),
      hiss: new Smooth(g.gHiss.gain, 0.3, 0.004),
      air: new Smooth(g.air.frequency, 0.35, 25),
      pan: new Smooth(g.pan.pan, 0.25, 0.01),
    };

    // Model terms the mix owns, reachable by name — the tyre `tune` pattern,
    // so the Sound Lab writes the real numbers rather than faking a node.
    this.tune = {
      glideDrive: 0.14,    // glide out gain at full speed, before distance
      glideRef: 14,        // m — how far the glide carries
      brightness: 1.0,     // scales the glide band centre
      lapRate: 1.0,        // scales the lap clock
      lapDrive: 1.0,       // scales lap peaks
      dripDrive: 1.0,      // scales paddle-drip peaks
    };

    this.L = null;               // last listener sample, for cue distance/pan
    this._recent = [];           // crowding window
    this._lapT = 0.6;            // s to the next idle lap
    this._dripT = 0.3;           // s to the next paddle drip
    this._sinceStroke = 99;      // s since the last stroke cue
    this._warned = null;
    this.state = { glide: 0, dist: Infinity, laps: 0, drips: 0, cues: 0, dropped: 0, last: '' };
  }

  /** Every gain the mixer owns, by name — the tyre.layers() contract. */
  layers() {
    return {
      boatGlide: this.glide.out,
      boatLap: this.gLap,
      boatDrip: this.gDrip,
      boatCue: this.cueBus,
    };
  }

  // ── frame ─────────────────────────────────────────────────────────────────

  update(dt, L) {
    this.L = L;
    this._sinceStroke += dt;
    const actx = this.actx;

    // Everything below is read defensively: the boat system may not exist,
    // may be mid-init, or may have no boat spawned. All of those are silence.
    const b = this.ctx?.systems?.boat;
    const cur = b?.current ?? null;
    if (!cur) {
      this.sm.out.set(0, actx);
      this.state.glide = 0;
      this.state.dist = Infinity;
      this._present = false;
      return;
    }
    if (!this._present) {
      this._present = true;
      // A boat that has just appeared (spawned, or the system just landed)
      // laps soon rather than after a full idle interval — the water it is
      // sitting in has just been disturbed.
      this._lapT = Math.min(this._lapT, 0.3 + this.rnd() * 0.4);
    }

    const hull = HULL[cur.kind] ?? HULL.canoe;
    const speed = Math.abs(cur.speed ?? 0);
    const dx = (cur.x ?? 0) - L.x, dz = (cur.z ?? 0) - L.z;
    const d = Math.hypot(dx, dz);
    this.state.dist = d;

    // ── glide ───────────────────────────────────────────────────────────────
    // Silent at rest, monotonic with speed. The gate keeps a drifting hull
    // (< ~0.3 m/s, the moored threshold) in the lap regime instead.
    // Normalised by the fastest hull's ceiling (boat_physics.js — maxSpeed
    // 3.2 canoe / 3.8 kayak), so "full speed" here is a speed a boat reaches.
    const sp = clamp01(speed / 3.8);
    const gate = smoothstep(0.12, 0.85, speed);
    const model = gate * (0.3 + 0.7 * sp) * this.tune.glideDrive;
    const ref = this.tune.glideRef;
    const gv = model * Math.pow(ref / (ref + d), 2.2);
    this.state.glide = gv;
    this.sm.out.set(gv, actx);
    // The band centre rises with speed — burble to laminar shhh — and the
    // kayak sits a fifth brighter than the canoe throughout.
    const bright = hull.bright * this.tune.brightness;
    this.sm.body.set(520 * bright * (1 + sp * 0.5), actx);
    this.sm.low.set(lerp(0.6, 0.95, sp) * hull.lowG, actx);
    // The top band is a garnish, near-field only, and quadratic in speed so a
    // slow hull has none of it (the river voice's hiss lesson).
    this.sm.hiss.set(hull.hissG * sp * sp * clamp01(1 - d / 25), actx);
    this.sm.air.set(clamp(7000 * Math.exp(-d / 70), 900, 7000), actx);
    const rel = Math.atan2(dx, dz) - L.yaw;
    this.sm.pan.set(clamp(Math.sin(rel) * clamp01((d - 3) / 12), -0.9, 0.9), actx);

    // ── idle lapping ────────────────────────────────────────────────────────
    if (speed < 0.3) {
      this._lapT -= dt;
      if (this._lapT <= 0) {
        this._lapT = (0.8 + this.rnd() * 1.7) / Math.max(0.1, this.tune.lapRate);
        this._lap(cur, hull);
      }
    } else {
      this._lapT = Math.max(this._lapT, 0.4);
    }

    // ── paddle drips ────────────────────────────────────────────────────────
    if (b?.active && this._sinceStroke < 2.4) {
      this._dripT -= dt;
      if (this._dripT <= 0) {
        this._dripT = 0.14 + this.rnd() * 0.42;
        this._drip(cur);
      }
    }
  }

  // ── one-shots ─────────────────────────────────────────────────────────────

  /**
   * Sound one boat event.
   *
   * @param {string} kind  'stroke' | 'launch' | 'board' | 'beach' | 'bump'
   * @param {object} opts  x/z default to the live boat's position; `hull`
   *   ('canoe' | 'kayak') defaults to the live boat's kind. Stroke also takes
   *   `side` (-1 left, 1 right) and `strength` (0–1).
   */
  cue(kind, opts = {}) {
    const voice = VOICES[kind];
    if (!voice) {
      if (!(this._warned ??= new Set()).has(kind)) {
        this._warned.add(kind);
        console.warn('[boat:audio] no voice for', kind);
      }
      return;
    }
    if (kind === 'stroke') this._sinceStroke = 0;
    const c = this._cueCtx(opts, 1);
    if (!c) return;
    c.side = clamp(opts.side ?? 0, -1, 1);
    c.strength = clamp01(opts.strength ?? 0.7);
    voice.call(this, c);
    stopLater(c.nodes, this.actx, c.end + 0.12);
    this.state.cues++;
    this.state.last = kind;
  }

  /**
   * Distance, pan and jitter, computed once per cue — the camp_props context.
   * Returns null when the cue would be inaudible (dropped, not scheduled).
   */
  _cueCtx(opts, peakScale, dest = null) {
    const L = this.L;
    if (!L || !this.actx) return null;
    const cur = this.ctx?.systems?.boat?.current;
    const x = opts.x ?? cur?.x ?? L.x;
    const z = opts.z ?? cur?.z ?? L.z;
    const dx = x - L.x, dz = z - L.z;
    const d = Math.hypot(dx, dz);
    if (d > REACH) { this.state.dropped++; return null; }
    const k = clamp01(1 - (d - NEAR) / (REACH - NEAR));
    const level = Math.pow(k, FALLOFF) * clamp01(L.indoors ?? 1) * this._crowd() * peakScale;
    if (level < FLOOR) { this.state.dropped++; return null; }
    // `Boat._cue` passes the hull as `kind` ('launch'/'board' fire before or
    // without a `current`); the lab passes `hull`. Accept either.
    const hullName = opts.hull ?? opts.kind ?? cur?.kind;
    return {
      pan: clamp(Math.sin(Math.atan2(dx, dz) - L.yaw) * 0.7, -0.85, 0.85),
      level,
      hull: HULL[hullName] ?? HULL.canoe,
      side: 0,
      strength: 0.7,
      // ±6% pitch, ±8% length — enough that nothing repeats, too little to
      // read as a different object (the four-chairs rule).
      m: { pitch: 0.94 + this.rnd() * 0.12, dur: 0.92 + this.rnd() * 0.16 },
      t: this.actx.currentTime + 0.005 + this.rnd() * 0.02,
      dest: dest ?? this.cueBus,
      nodes: [],
      end: 0,
    };
  }

  _crowd() {
    const now = this.actx.currentTime;
    while (this._recent.length && now - this._recent[0] > CROWD_WINDOW) this._recent.shift();
    const n = Math.min(this._recent.length, CROWD_MAX);
    this._recent.push(now);
    return 1 / (1 + CROWD_K * n);
  }

  /** One idle lap against the hull: a soft filtered tap, sometimes doubled,
   *  sometimes with the hull's own resonance answering very quietly. */
  _lap(cur, hull) {
    const c = this._cueCtx({ x: cur.x, z: cur.z }, this.tune.lapDrive, this.gLap);
    if (!c) return;
    const r = this.rnd;
    this._sweep(c, 0, {
      f0: 780 + r() * 320, f1: 420 + r() * 140, q: 1.2,
      peak: 0.030 + r() * 0.022, attack: 0.008 + r() * 0.01, dur: 0.09 + r() * 0.08,
    });
    if (r() < 0.4) {
      this._sweep(c, 0.10 + r() * 0.09, {
        f0: 640 + r() * 220, f1: 380, q: 1.2,
        peak: 0.016 + r() * 0.012, attack: 0.010, dur: 0.08 + r() * 0.06,
      });
    }
    // The hull answering — barely there, but it is what says "against a boat"
    // rather than "somewhere on the shore".
    if (r() < 0.35) {
      const f = hull.knock[0] * (0.85 + r() * 0.3);
      this._tone(c, 0.02, { f0: f, f1: f * 0.94, peak: 0.014, attack: 0.006, dur: 0.14 * hull.knockDur, type: hull.knockType });
    }
    stopLater(c.nodes, this.actx, c.end + 0.12);
    this.state.laps++;
  }

  /** One paddle drip: a tiny bright plip, 2–4 kHz, very quiet. */
  _drip(cur) {
    const c = this._cueCtx({ x: cur.x, z: cur.z }, this.tune.dripDrive, this.gDrip);
    if (!c) return;
    const fade = clamp01(1 - this._sinceStroke / 2.4);
    this._noise(c, 0, {
      f: 2000 + this.rnd() * 2000, q: 9,
      peak: (0.012 + this.rnd() * 0.014) * (0.35 + fade * 0.65),
      attack: 0.001, dur: 0.022 + this.rnd() * 0.02,
      pan: (this.rnd() - 0.5) * 0.3,
    });
    stopLater(c.nodes, this.actx, c.end + 0.12);
    this.state.drips++;
  }

  // ── voice helpers (camp_props', with a per-cue destination) ───────────────

  /** A band-passed noise burst at a fixed centre — plips, ticks, knocks. */
  _noise(c, at, { f, q = 4, peak, attack = 0.002, dur = 0.06, pan = 0 }) {
    const actx = this.actx;
    const t = c.t + at * c.m.dur;
    const src = noiseSource(actx, this.hiss, 0.85 + this.rnd() * 0.35);
    const bp = filter(actx, 'bandpass', f * c.m.pitch, q);
    const g = gain(actx, 0);
    const p = panner(actx, clamp(c.pan + pan, -0.92, 0.92));
    src.connect(bp).connect(g).connect(p).connect(c.dest);
    const d = dur * c.m.dur;
    const a = peak * c.level * this._srcNorm.hiss * bwGain(f * c.m.pitch, q);
    ping(actx, g, t, Math.max(a, 0.0004), attack, d);
    src.stop(t + d + 0.08);
    this._own(c, [src, bp, g, p], t + d);
  }

  /** An oscillator, optionally swept — hull bodies and knocks. */
  _tone(c, at, { f0, f1 = null, peak, attack = 0.003, dur = 0.1, type = 'sine', pan = 0 }) {
    const actx = this.actx;
    const t = c.t + at * c.m.dur;
    const d = dur * c.m.dur;
    const o = actx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0 * c.m.pitch, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * c.m.pitch), t + d);
    const g = gain(actx, 0);
    const p = panner(actx, clamp(c.pan + pan, -0.92, 0.92));
    o.connect(g).connect(p).connect(c.dest);
    ping(actx, g, t, Math.max(peak * c.level, 0.0004), attack, d);
    o.start(t);
    o.stop(t + d + 0.05);
    this._own(c, [o, g, p], t + d);
  }

  /** Pink noise through a band that moves — swashes, splashes, laps. */
  _sweep(c, at, { f0, f1, q = 0.9, peak, attack = 0.02, dur = 0.3, pan = 0 }) {
    const actx = this.actx;
    const t = c.t + at * c.m.dur;
    const d = dur * c.m.dur;
    const src = noiseSource(actx, this.pink, 0.9 + this.rnd() * 0.3);
    const bp = filter(actx, 'bandpass', f0 * c.m.pitch, q);
    bp.frequency.setValueAtTime(f0 * c.m.pitch, t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(30, f1 * c.m.pitch), t + d);
    const g = gain(actx, 0);
    const p = panner(actx, clamp(c.pan + pan, -0.92, 0.92));
    src.connect(bp).connect(g).connect(p).connect(c.dest);
    const a = peak * c.level * this._srcNorm.pink * bwGain(Math.sqrt(f0 * f1) * c.m.pitch, q);
    ping(actx, g, t, Math.max(a, 0.0004), attack, d);
    src.stop(t + d + 0.08);
    this._own(c, [src, bp, g, p], t + d);
  }

  /** Brown noise under a lowpass — the launch scrape. Grainy, no pitch. */
  _grind(c, at, { lp = 520, peak, attack = 0.04, dur = 0.6, pan = 0 }) {
    const actx = this.actx;
    if (!this.brown) {
      this.brown = noiseBuffer(actx, 1.5, 'brown', 0xb0a3);
      this._srcNorm.brown = 0.5 / rmsOf(this.brown);
    }
    const t = c.t + at * c.m.dur;
    const d = dur * c.m.dur;
    const src = noiseSource(actx, this.brown, 0.7 + this.rnd() * 0.25);
    const f = filter(actx, 'lowpass', lp * c.m.pitch, 0.7);
    const g = gain(actx, 0);
    const p = panner(actx, clamp(c.pan + pan, -0.92, 0.92));
    src.connect(f).connect(g).connect(p).connect(c.dest);
    ping(actx, g, t, Math.max(peak * c.level * this._srcNorm.brown, 0.0004), attack, d);
    src.stop(t + d + 0.08);
    this._own(c, [src, f, g, p], t + d);
  }

  _own(c, nodes, end) {
    for (const n of nodes) c.nodes.push(n);
    if (end > c.end) c.end = end;
  }

  dispose() {
    try { this.bus.disconnect(); } catch { /* already gone */ }
  }
}

/** The cue kinds this module can sound. For the Sound Lab. */
export const BOAT_CUE_KINDS = Object.keys(VOICES);
