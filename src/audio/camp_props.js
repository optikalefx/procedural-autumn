// ─────────────────────────────────────────────────────────────────────────────
//  CampProps — the sound of a camp assembling itself.
//
//  The camp does not get carried in and set down. It *appears*: the clearing
//  eases open, then eight props scale up out of nothing over about half a
//  second, each on its own delay (see `Camp._applyRaise`). Striking runs the
//  same thing backwards in half the time.
//
//  That is a fantasy, and the temptation with a fantasy is to score it as one —
//  a sparkle, a whoosh, a rising synth arpeggio. Every one of those would be
//  the first sound in this game that admits it is a game. So the rule here is
//  the opposite: **each object makes the noise that object makes.** Nylon
//  snaps, aluminium tube ticks, a plastic cooler knocks hollow, dry logs clack
//  against each other, a tripod rings thinly. Play them a beat apart and the
//  brain assembles the fiction on its own — somebody pitched a camp very fast,
//  which is exactly what the eye is being shown.
//
//  Three things this had to get right, and each one cost a rewrite:
//
//   1. **Density.** Eight props over a 1.15 s raise land ~69 ms apart, and a
//      strike compresses the same eight into 0.23 s. Eight equally loud clacks
//      at that spacing is a rattle, not a camp. So every cue is *timbrally*
//      distinct (nothing shares a band with its neighbour), every cue is
//      jittered by up to 22 ms so the sequence is never metronomic, and cues
//      duck each other when they crowd — see `_crowd`.
//   2. **Level.** The reference is not "can I hear it", it is the fire's own
//      crackles, which this sits beside on the same bus. The player's standing
//      note about this game's ambience is "very loud. Not calming at all", and
//      a camp is pitched dozens of times in a session. A pop you *notice* every
//      time is a pop you resent by the tenth.
//   3. **Packing away is not pitching in reverse.** Reversed audio is the
//      cheapest possible tell. It is the same object either way, so it is the
//      same voice — just darker, shorter, quieter and with a softer attack,
//      because you fold a chair and you snap it open. One table (`SHAPE`)
//      rather than sixteen hand-written cues.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, mulberry32 } from '../core/MathUtils.js';
import { noiseBuffer, noiseSource, filter, gain, ping, stopLater, panner } from './synth.js';

// How far a prop carries. Shorter than the fire's 26 m would be honest for a
// tick this small, and wrong for the game: the player commits a camp from
// 8–18 m away and then watches it from there. A cue they cannot hear at the
// distance they always stand is a cue that does not exist.
const REACH = 30;
const NEAR = 3.0;
// Gentler than the fire's square. A square law over 30 m spends its whole top
// half on distances closer than anyone ever parks, so every real listening
// position lands in the quiet tail and the whole layer reads as broken.
const FALLOFF = 1.4;

// Below this the cue is dropped rather than scheduled. A dozen inaudible
// one-shots per camp is a dozen node graphs built and torn down for nothing.
const FLOOR = 0.02;

// One trim for the whole layer, so its level is a decision in one place rather
// than eight numbers in the voice table.
//
// Set by ear, then measured — in that order, because this is the one number
// here that is a taste question and the meter cannot answer it.
//
//   1.0  the first draft. Inaudible in the game.
//   1.8  chosen against the ambience floor: about -37 dBFS peak at the master
//        for a cue at 8 m, a few dB under the wind's own peaks. Reasoned, and
//        wrong — the player's report was "I can actually hear them, but they
//        are low".
//   3.6  +6 dB on that. A doubling of perceived loudness, which is the step
//        size that reads as "louder" rather than as "did that change?".
//
// The lesson is worth more than the number: "a few dB under the wind" was a
// model of audibility, not a measurement of it. A transient that measures
// close to a broadband bed is not heard close to it, because the bed is
// continuous and the ear stops attending to it. Sitting cues UNDER the floor
// they punctuate was the mistake.
//
// Still nowhere near loud: at 3.6 a cue at 8 m peaks about -31 dBFS at the
// master, and a whole camp raising leaves ~16 dB of headroom before the
// limiter has anything to do.
//
// This was very nearly set by comparing against the camp fire's crackles
// instead — the obvious neighbour, and the one layer whose loudness the code
// argues about at length. Do not. The fire had never played at all (`Camp` was
// missing the `fire` getter that `CampAudio.update` gates on), so nothing about
// its level had ever been heard by anyone, and its crackle gains turn out to be
// about 25 dB above what they actually produce. Calibrating to it would have
// buried this layer against a number nobody had checked.
const CUE_GAIN = 3.6;

// Pitching versus striking. See rule 3 in the header.
const SHAPE = {
  in:  { pitch: 1,    dur: 1,    peak: 1,   attack: 1   },
  out: { pitch: 0.86, dur: 0.72, peak: 0.6, attack: 1.7 },
};

// Crowding. `_crowd` counts cues inside this window and ducks the next one.
const CROWD_WINDOW = 0.28;
const CROWD_K = 0.18;
const CROWD_MAX = 5;

// ── making `peak` mean one thing ─────────────────────────────────────────────
//
// The voice table above is only readable — and only tunable by reading it — if
// `peak: 0.05` sounds about as loud in one voice as in the next. Left alone it
// does not, for two reasons, and the first version of this file was 17 dB apart
// between its quietest and loudest cue because of them:
//
//  1. **A band-pass throws most of a noise source away**, and how much depends
//     on its own bandwidth. The table's woody ring (380 Hz at Q 9) passes about
//     66 Hz of noise; the chair's tube tick (2850 Hz at Q 6.5) passes 689 Hz.
//     Ten times the energy for the same number in the table.
//  2. **Pink noise and white noise are not the same size.** Kellet's filter
//     ends on a ×0.11 trim, so the pink bed the sweeps use is an order of
//     magnitude below the white the ticks use, before either reaches a filter.
//
// Neither is a taste question, so neither belongs in the table. `_srcNorm`
// measures the buffers and levels them; `bwGain` is a first-order correction
// for the filter — good to a few dB, not exact, because the peak of a short
// noise burst is not its rms and a two-pole band-pass is not a brick wall.
//
// So the table was then *trimmed against the meter*, not against this model:
// `tools/_scratch/camppop.mjs` reads every kind off the `camp` tap at a fixed
// 8 m and the numbers above were moved until they landed inside a 6 dB band.
// The model's job is to stop a change of Q from silently becoming a change of
// level; the measurement's job is to say what the levels actually are.
const NOISE_REF = 900;   // Hz of pass-band that needs no correction
const bwGain = (f, q) => Math.sqrt(NOISE_REF / clamp((Math.PI / 2) * f / q, 30, 6000));

/** RMS of a buffer's first channel. Used once per buffer, at construction. */
function rmsOf(buf) {
  const d = buf.getChannelData(0);
  // Every 17th sample. A 1.2 s buffer is 58k samples and the answer is the same
  // to three decimal places, for a twentieth of the work at start-up.
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 17) { sum += d[i] * d[i]; n++; }
  return Math.sqrt(sum / Math.max(1, n));
}

/**
 * The voices.
 *
 * One function per prop kind, each receiving the cue context `c` — level, pan
 * and the in/out shape — and scheduling its own little graph through the three
 * helpers below. `this` is the CampProps instance.
 *
 * Offsets and durations are written as the *pitch-in* values; `SHAPE` scales
 * them, so nothing here has to know which direction it is being played in.
 */
const VOICES = {
  /**
   * Tent — nylon.
   *
   * Fabric is not one sound, it is a body of cloth moving through several
   * positions, and a single filtered burst reads as a "shh" sample rather than
   * as a tent. Three ruffles, each later, darker and quieter than the last,
   * with the band falling through each one as the fly loses its billow.
   */
  tent(c) {
    this._sweep(c, 0.000, { f0: 2700, f1: 950, q: 1.1, peak: 0.128, attack: 0.006, dur: 0.14, pan: -0.03 });
    this._sweep(c, 0.048, { f0: 2100, f1: 700, q: 1.0, peak: 0.094, attack: 0.008, dur: 0.16, pan: 0.05 });
    this._sweep(c, 0.104, { f0: 1500, f1: 520, q: 0.9, peak: 0.060, attack: 0.010, dur: 0.19, pan: -0.02 });
    // The air the fly displaces. Felt rather than heard, and the only reason a
    // tent reads as bigger than a chair rather than merely as more cloth.
    this._tone(c, 0.052, { f0: 124, f1: 68, peak: 0.045, attack: 0.010, dur: 0.17 });
  },

  /**
   * Chair — a tube frame with a sling in it.
   *
   * Two ticks, not one: a folding chair has four legs and they never land
   * together. The second is quieter and lower, which is what "the far one"
   * sounds like.
   */
  chair(c) {
    this._noise(c, 0.000, { f: 2850, q: 6.5, peak: 0.200, attack: 0.001, dur: 0.045, pan: 0.04 });
    this._noise(c, 0.055, { f: 2050, q: 5.0, peak: 0.123, attack: 0.001, dur: 0.055, pan: -0.06 });
    // The seat taking the frame's shape. Softer attack than the tube — cloth
    // has no transient of its own, it only ever answers something else.
    this._sweep(c, 0.022, { f0: 1900, f1: 900, q: 1.1, peak: 0.074, attack: 0.009, dur: 0.10 });
  },

  /**
   * Cooler — a hollow plastic box.
   *
   * A triangle at 205 Hz rather than noise through a resonant band, because
   * the odd-harmonic series is what makes moulded plastic sound like plastic
   * and not like a small drum. Decays fast: a cooler has no sustain, it is
   * full of foam.
   */
  cooler(c) {
    this._tone(c, 0.000, { f0: 205, f1: 168, peak: 0.046, attack: 0.002, dur: 0.11, type: 'triangle' });
    // The lid, landing on the rim a moment later.
    this._noise(c, 0.012, { f: 1150, q: 3.0, peak: 0.032, attack: 0.001, dur: 0.032, pan: 0.03 });
    this._noise(c, 0.086, { f: 780, q: 4.0, peak: 0.017, attack: 0.002, dur: 0.045 });
  },

  /**
   * Table — a wooden top on folding legs.
   *
   * The long, high-Q band at 380 Hz is the woody ring, and it is the whole
   * difference between this and the cooler. Sat next to a `triangle` it also
   * keeps the two mid-range props out of each other's way, which matters
   * because they frequently pop within 70 ms of each other.
   */
  table(c) {
    this._noise(c, 0.000, { f: 380, q: 9.0, peak: 0.084, attack: 0.002, dur: 0.16 });
    this._tone(c, 0.000, { f0: 188, f1: 172, peak: 0.032, attack: 0.003, dur: 0.13 });
    // A leg finding the ground.
    this._noise(c, 0.070, { f: 1520, q: 4.5, peak: 0.044, attack: 0.001, dur: 0.035, pan: -0.05 });
  },

  /**
   * Woodpile — dry logs settling against each other.
   *
   * The only cue with a random shape, and the only one that needs it: a stack
   * of logs is a *number* of impacts, and four identical clacks are a drum
   * roll. Pitch, spacing, level and pan all vary per clack, which is also what
   * keeps this from colliding with the table — no two runs sit in the same
   * band twice.
   */
  woodpile(c) {
    const n = 4 + Math.floor(this.rnd() * 3);
    let at = 0;
    for (let i = 0; i < n; i++) {
      // Later clacks are quieter: the pile is settling, not being thrown.
      const fall = 1 - i / (n + 1.5);
      this._noise(c, at, {
        f: 250 + this.rnd() * 520,
        q: 6.5 + this.rnd() * 3,
        peak: (0.126 + this.rnd() * 0.151) * fall,
        attack: 0.001,
        dur: 0.045 + this.rnd() * 0.055,
        pan: (this.rnd() - 0.5) * 0.18,
      });
      at += 0.028 + this.rnd() * 0.05;
    }
  },

  /**
   * Telescope — a metal tripod under glass.
   *
   * Two inharmonic partials, deliberately not an octave or a fifth apart: a
   * tuned interval is a bell and a bell is a UI sound. 1180 and 1735 is a
   * ratio of about 1.47, which rings without ever landing on a note. This is
   * the longest cue by a good margin, and it should be — it is the one prop in
   * the camp that is worth something.
   */
  telescope(c) {
    this._tone(c, 0.000, { f0: 1180, peak: 0.030, attack: 0.002, dur: 0.30, pan: 0.04 });
    this._tone(c, 0.006, { f0: 1735, peak: 0.017, attack: 0.002, dur: 0.24, pan: -0.05 });
    // Tripod feet, then the mount taking the tube's weight.
    this._noise(c, 0.000, { f: 3200, q: 7.0, peak: 0.042, attack: 0.001, dur: 0.030 });
    this._noise(c, 0.044, { f: 430, q: 5.0, peak: 0.030, attack: 0.002, dur: 0.075 });
  },

  /**
   * Roasting stick — a whittled hardwood switch, propped against something.
   *
   * The quietest cue in the table, and it should be: it is a stick. What it has
   * to do is not be mistaken for one of its neighbours, and it has two of them
   * to stay out of the way of — the table's woody ring at 380 Hz (it lands 70 ms
   * from this one whenever a camp has both) and the woodpile's clacks, which
   * are drawn anywhere from 250 to 770 Hz.
   *
   * So the tap sits at 1150 Hz: an octave and a half above the table, well
   * clear of the woodpile's band, and below the chair's 2050/2850 tube ticks. A
   * thin dry stick really is higher and shorter than a table leg — there is no
   * mass behind it — so the band is where the object is as well as where the
   * gap is. Q 7 rather than the table's 9: a stick rings, but it is 12 mm of
   * green wood and it damps almost at once.
   *
   * The scrape after it is the whole character. A stick is not set down, it is
   * leaned, and the sound of leaning one is the last 100 mm of it sliding
   * against whatever it fetched up on. Pink through a falling band with a soft
   * attack, at a third of the tap's level — under the threshold of being a
   * separate event, which is what makes it read as part of the same gesture.
   */
  roaststick(c) {
    this._noise(c, 0.000, { f: 1150, q: 7.0, peak: 0.086, attack: 0.001, dur: 0.055 });
    this._sweep(c, 0.014, { f0: 2600, f1: 1250, q: 1.3, peak: 0.030, attack: 0.012, dur: 0.10, pan: 0.04 });
    // The butt finding the dirt. Low, tiny, and the only part of this that says
    // the object has a bottom end standing on the ground rather than floating.
    this._noise(c, 0.040, { f: 320, q: 3.0, peak: 0.026, attack: 0.002, dur: 0.040, pan: -0.03 });
  },

  /**
   * The clearing itself — dry earth opening under the grass.
   *
   * The one cue with no transient at all. The ground does not pop; it eases
   * open over 0.6 s ahead of everything else, and an attack on it would put a
   * hit where the picture has a swell. A 90 ms attack is long enough to have
   * no onset you can point at, which is the point.
   *
   * It also frames the whole event: this is the first thing you hear and, on a
   * strike, the last, so the flurry of props has a beginning and an end rather
   * than just starting.
   */
  ground(c) {
    // Both directions fall — earth settling either way — but the closing one
    // starts lower and lands lower, so the clearing sounds like it is being
    // put back rather than opened again.
    const packing = c.out;
    this._sweep(c, 0, {
      f0: packing ? 420 : 700, f1: packing ? 150 : 215,
      q: 0.8, peak: 0.042, attack: 0.090, dur: 0.42,
    });
    this._tone(c, 0.02, { f0: 96, f1: 72, peak: 0.012, attack: 0.070, dur: 0.30 });
  },

  /**
   * The fire catching.
   *
   * Rises on the way in and falls on the way out — the only voice that flips
   * direction, because ignition and a fire going out are genuinely different
   * events rather than the same event at two speeds. Mixed low: `CampAudio`'s
   * own bed and crackles are already swelling underneath this on the same
   * bus, and the job here is only to give that swell a moment it starts at.
   */
  fire(c) {
    if (c.out) {
      this._sweep(c, 0, { f0: 460, f1: 165, q: 1.0, peak: 0.055, attack: 0.030, dur: 0.34 });
      // The hiss of a fire that has just stopped being one.
      this._sweep(c, 0.10, { f0: 2400, f1: 1500, q: 0.7, peak: 0.020, attack: 0.060, dur: 0.30 });
    } else {
      this._sweep(c, 0, { f0: 175, f1: 540, q: 1.1, peak: 0.062, attack: 0.140, dur: 0.52 });
    }
  },
};

export class CampProps {
  /**
   * @param {AudioContext} actx
   * @param {AudioNode} bus  where cues land — CampAudio's bus, so the camp
   *   metering tap sees these as well as the fire.
   * @param {AudioBuffer} pink  the fire's pink noise, reused. Fabric and earth
   *   want pink; white through those wide bands is tape hiss.
   */
  constructor(actx, bus, pink) {
    this.actx = actx;
    this.bus = gain(actx, CUE_GAIN);
    this.bus.connect(bus);
    this.rnd = mulberry32(0x2b17);
    this.pink = pink;
    // Short and white, for ticks and clacks. A high-Q band throws away almost
    // all of it, so 1.2 s is plenty of decorrelated material.
    this.hiss = noiseBuffer(actx, 1.2, 'white', 0x51ad);
    // Both sources levelled to the same rms, so a `peak` in the table above is
    // the same loudness whichever one the voice reaches for. 0.5 is arbitrary
    // and only has to be consistent — the voices were tuned against it.
    this._srcNorm = { hiss: 0.5 / rmsOf(this.hiss), pink: 0.5 / rmsOf(pink) };
    // The listener sample, handed down by CampAudio each frame. Null until the
    // first audio frame has run, which cannot precede a camp: pitching one
    // takes a click, and a click is what starts the context.
    this.L = null;
    this._recent = [];
    this._warned = null;
    this.state = { cues: 0, dropped: 0, last: '' };
  }

  /**
   * Sound one prop appearing or disappearing.
   *
   * @param {string} kind   'tent' | 'chair' | 'cooler' | 'table' | 'woodpile'
   *                        | 'telescope' | 'roaststick' | 'ground' | 'fire'
   * @param {object} opts   `x`/`z` are the prop's own world position, not the
   *   camp's — the woodpile really is over on your left, and using the camp
   *   centre for all eight throws that away for nothing.
   */
  cue(kind, { x = 0, z = 0, out = false } = {}) {
    const voice = VOICES[kind];
    if (!voice) {
      // Silence with no explanation is how a new prop kind ships mute. One
      // line per kind, the same courtesy `Camp._buildNext` extends to a
      // missing builder.
      if (!(this._warned ??= new Set()).has(kind)) {
        this._warned.add(kind);
        console.warn('[camp:audio] no voice for', kind);
      }
      return;
    }
    const L = this.L;
    if (!L) return;

    const dx = x - L.x, dz = z - L.z;
    const d = Math.hypot(dx, dz);
    if (d > REACH) { this.state.dropped++; return; }

    const k = clamp01(1 - (d - NEAR) / (REACH - NEAR));
    const level = Math.pow(k, FALLOFF) * clamp01(L.indoors ?? 1) * this._crowd();
    if (level < FLOOR) { this.state.dropped++; return; }

    const c = {
      // Bearing relative to where the player is looking, same convention as
      // the fire's bed. Narrower than the fire's spread: these are point
      // sources a few metres apart, not a two-metre area of flame.
      pan: clamp(Math.sin(Math.atan2(dx, dz) - L.yaw) * 0.7, -0.85, 0.85),
      out,
      // A per-cue copy, because the pitch and length below are varied on it.
      m: { ...(out ? SHAPE.out : SHAPE.in) },
      level,
      // Up to 22 ms of jitter. Without it the props land on an exact 69 ms
      // grid — the raise is a fixed ramp and the delays are evenly spaced —
      // and a grid at that spacing is heard as a machine, not as a sequence.
      t: this.actx.currentTime + 0.006 + this.rnd() * 0.022,
      nodes: [],
      end: 0,
    };
    c.level *= c.m.peak;
    // ── no two of anything are the same object ──────────────────────────────
    // A full camp is eight props and four of them are CHAIRS, arriving ~69 ms
    // apart. Four bit-identical ticks in a quarter of a second is not four
    // chairs, it is one sample retriggered, and the ear names it instantly —
    // the same tell the fire's crackles avoid by drawing a size per pop.
    // ±6% of pitch and ±8% of length is far too little to hear as a change of
    // object and far too much to hear as a repeat.
    c.m.pitch *= 0.94 + this.rnd() * 0.12;
    c.m.dur *= 0.92 + this.rnd() * 0.16;

    voice.call(this, c);
    stopLater(c.nodes, this.actx, c.end + 0.12);
    this.state.cues++;
    this.state.last = `${kind}${out ? ' out' : ''}`;
  }

  /**
   * How much to duck this cue for the ones that just fired.
   *
   * Not a limiter — the master already has one, and a limiter would pull the
   * *fire* down every time a camp was struck near it. This is masking, applied
   * where masking belongs: eight props inside half a second are not eight
   * times as loud as one prop, and mixing them as though they were is what
   * turned the first version of this into a hailstorm.
   */
  _crowd() {
    const now = this.actx.currentTime;
    while (this._recent.length && now - this._recent[0] > CROWD_WINDOW) this._recent.shift();
    const n = Math.min(this._recent.length, CROWD_MAX);
    this._recent.push(now);
    return 1 / (1 + CROWD_K * n);
  }

  // ── voice helpers ─────────────────────────────────────────────────────────
  //
  // All three take the cue context and an offset in seconds from the cue's
  // start. Offsets, durations and attacks are scaled by the in/out shape, so a
  // struck camp is uniformly faster rather than merely quieter.

  /** A band-passed noise burst at a fixed centre — ticks, clacks, knocks. */
  _noise(c, at, { f, q = 4, peak, attack = 0.002, dur = 0.06, pan = 0, buf = null }) {
    const actx = this.actx;
    const t = c.t + at * c.m.dur;
    const src = noiseSource(actx, buf ?? this.hiss, 0.85 + this.rnd() * 0.35);
    const bp = filter(actx, 'bandpass', f * c.m.pitch, q);
    const g = gain(actx, 0);
    const p = panner(actx, clamp(c.pan + pan, -0.92, 0.92));
    src.connect(bp).connect(g).connect(p).connect(this.bus);
    const d = dur * c.m.dur;
    const a = peak * c.level * this._srcNorm.hiss * bwGain(f * c.m.pitch, q);
    ping(actx, g, t, Math.max(a, 0.0004), attack * c.m.attack, d);
    src.stop(t + d + 0.08);
    this._own(c, [src, bp, g, p], t + d);
  }

  /** An oscillator, optionally swept — bodies and rings. */
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
    o.connect(g).connect(p).connect(this.bus);
    ping(actx, g, t, Math.max(peak * c.level, 0.0004), attack * c.m.attack, d);
    o.start(t);
    o.stop(t + d + 0.05);
    this._own(c, [o, g, p], t + d);
  }

  /** Noise through a band that *moves* — cloth, and earth opening. */
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
    src.connect(bp).connect(g).connect(p).connect(this.bus);
    // The geometric mean of the swept band, because the sweep is exponential —
    // the arithmetic mean of 2700 and 950 would sit well above where the band
    // actually spends its time.
    const a = peak * c.level * this._srcNorm.pink * bwGain(Math.sqrt(f0 * f1) * c.m.pitch, q);
    ping(actx, g, t, Math.max(a, 0.0004), attack * c.m.attack, d);
    src.stop(t + d + 0.08);
    this._own(c, [src, bp, g, p], t + d);
  }

  /** Register a voice's nodes for the cue's single cleanup. */
  _own(c, nodes, end) {
    for (const n of nodes) c.nodes.push(n);
    if (end > c.end) c.end = end;
  }

  dispose() {
    try { this.bus.disconnect(); } catch { /* already gone */ }
  }
}

/** The kinds this module can sound. Exported so the Sound Lab can list them. */
export const CAMP_PROP_KINDS = Object.keys(VOICES);
