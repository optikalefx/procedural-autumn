// ─────────────────────────────────────────────────────────────────────────────
//  BikeAudio — the mountain bike, heard from the saddle.
//
//  A bicycle is nearly silent and that is the whole design constraint, the same
//  one `BoatAudio` works under. What it is NOT is quiet in a uniform way: a
//  bicycle makes five completely different sounds, and which of them you are
//  hearing tells you exactly what the rider is doing and what they are riding
//  ON. That is the layer's job — not to be loud, but to be *legible*.
//
//    roll       tyre on BARE ground — dirt, scree, gravel, the shoulder of a
//               track. A dry granular patter: three bands off one pink source
//               under a shared air lowpass, the house anatomy (see water.js on
//               why filtered noise that does not wander reads as tape hiss).
//
//    grass      tyre through VEGETATION, and it is a different sound rather
//               than a filtered version of the one above (user, 2026-09-01).
//               A tyre on dirt is a rumble you hear through the frame; a tyre
//               through meadow is BLADES — hundreds of them a second whipping
//               the spokes, the fork and the down tube. That is bright, wide
//               and fluttery, it has almost no low end, and no amount of
//               moving a band centre on the rumble will produce it. So the two
//               are separate voices, crossfaded by how much grass is actually
//               STANDING under the wheels.
//
//               That last word is the whole of the 2026-09-02 fix. The
//               crossfade used to run on `grassiness` — the physics' 0..1
//               reading of what the ground is MADE of, off `getSurfaceWeights`
//               — and a wheel rut is cut through meadow, so its material is
//               still meadow. Sampled with the real `BikePhysics` at 24 points
//               along the road network, `grassiness` reads 0.892 there against
//               0.886 off it: a bare track is, to that number, INDISTINGUISH-
//               ABLE from open meadow, so riding one played the meadow whip at
//               89% and the rumble at 11%. It saturates as well — 63% of the
//               valley reads above 0.9 — so most of the map got one fixed
//               sound whatever the ground looked like.
//
//               The number it runs on now is `grassCover`: `grassCoverAt` in
//               grass_scatter.js, the same field the SCATTERER turns into
//               blades per tuft, road mask and drift octaves and all. On those
//               same 24 track points it reads 0.028, and off them 0.575 — a
//               30 dB drop on the whip. So the bed the player is looking
//               at is the bed they hear, and the two cannot drift, because
//               there is only one of them. Ride into a thin drift and the
//               whip thins with it; ride onto the track and the rumble takes
//               over, which is a wheel rut you can hear.
//
//               `grassiness` still owns the ROLLING RESISTANCE — a bare rut is
//               soft organic ground to ride on whatever is growing out of it,
//               and that number was tuned as a whole system against the
//               valley. So sound and handling no longer share one field; see
//               the note in bike_physics.js.
//
//    freewheel  the ratchet, and it is the hero sound. It is also the one that
//               carries information nothing else can: it plays when the rider
//               is COASTING and stops the instant they pedal, so the ear knows
//               whether the bike is being worked or is running away downhill
//               without a single visual cue. Its rate is the wheel's, so it
//               rises from a countable click at walking pace to a hard buzz at
//               speed — which is a speedometer you do not have to look at.
//
//    drive      chain and cranks under load. The opposite gate to the
//               freewheel: only while pedalling, wobbling at the cadence, and
//               deliberately dull — a chain is a low mechanical mutter and
//               anything bright there reads as a machine rather than a bike.
//
//    brake      disc rub. A high, narrow, slightly unstable band, scaled by
//               brake × speed, so a hard stop from 25 km/h squeals and a
//               feathered brake at walking pace does almost nothing.
//
//  Plus water: a wet band that fades in with the depth, AND a train of wheel
//  splashes that keeps sounding for as long as the bike is in it. The bed alone
//  was not enough — water off a spinning tyre is a series of discrete events,
//  and a smooth hiss reads as a hose rather than as a bicycle crossing a river.
//
//  Four one-shots ride `cue(kind, opts)` on the camp_props contract — distance
//  and pan computed once, pitch and length jittered, a crowding duck, one
//  CUE_GAIN so loudness is a single decision.
//
//  ── which bus, and why it matters ──────────────────────────────────────────
//
//  The VEHICLE bus, not ambience. Everything here is a machine the player is
//  operating, it has to duck with the camper rather than on top of it, and it
//  gets its own TAP for the reason the camp fire and the boat both got one: a
//  tyre bed measured off the vehicle bus is indistinguishable from the engine
//  it shares the bus with, and a layer nobody can measure is a layer nobody
//  can tune.
//
//  Reads `ctx.systems.bike` DEFENSIVELY throughout. Per Audio rule 1, a missing
//  peer costs nothing: no bike, no sound, no exception.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, lerp, smoothstep, mulberry32 } from '../core/MathUtils.js';
import { noiseBuffer, noiseSource, filter, gain, lfo, swell, Smooth, ping, stopLater, panner } from './synth.js';

// How far a bike carries. Shorter than the boat's 40 m: this happens on ground,
// among trees and grass that absorb it, and the loudest thing about a bicycle
// is quieter than a paddle stroke. The ride camera sits 1.4–3.4 m behind the
// saddle, so the layer has to be present there and gone from a camp.
const REACH = 26;
const NEAR = 3.0;
const FALLOFF = 1.5;

// Below this a cue is dropped rather than scheduled — the camp's economy.
const FLOOR = 0.02;

// ── the ceiling on the ground beds, and why it is a HARD one ─────────────────
//
// The grass voice's level is a product of five things — a speed law, the
// surface mix, the build, the drive trim and the distance term — and a product
// has no ceiling. Ridden fast through deep meadow on the loaded build with the
// camera zoomed in, all five peak together and the bed arrives at roughly
// 0.12, which the user heard immediately: "the grass sound is fine but it can
// get too loud … remember, relaxing calm game" (2026-09-01).
//
// Turning the trim down would have fixed the peak by making the whole voice
// quieter, including the 90% of riding that was already right. What the peak
// needs is a CEILING, so the bed keeps its full dynamic range up to the point
// where it stops being pleasant and simply refuses to go past it. Riding
// faster past that point still changes the TIMBRE — the band centres and the
// tips band keep opening up with speed — so the ear still reads "faster"
// without the level climbing.
//
// 0.085 is where the cap sits and it is the loudest a bicycle is allowed to be
// in this game. It engages above about 6.5 m/s in full meadow and never
// otherwise, so the ordinary ride is untouched: at 4 m/s the grass bed computes
// 0.053 and nothing clamps.
//
// The rumble is held to the same ceiling, and since 2026-09-02 that is load
// bearing rather than symmetry. It used to peak around 0.06 because
// `(1 - grassiness)` was about 0.11 nearly everywhere and the voice was
// effectively never up; now the crossfade runs on grass COVER, a bare wheel rut
// reads 0.03, and the rumble gets the whole bed to itself. Measured at the ride
// camera's near stop (1.4 m, `near` 0.715) on a track it would compute 0.114 at
// full speed and the cap holds it to 0.085 above about 5.5 m/s — which is the
// same ceiling, in the same regime, that the grass voice already sat under.
// Riding a track is therefore no louder than riding a meadow was; it is a
// different sound at the same level, which is the entire point.
const GROUND_CEIL = 0.085;

// One trim for every one-shot in the layer, calibrated against the same anchor
// `BoatAudio` used: a camp prop at 8 m peaks about −20 dBFS on its own tap, and
// nothing a bicycle does should be louder than a paddle stroke (2.0 there). A
// kickstand is a smaller event than a stroke, so this sits under it.
const CUE_GAIN = 1.5;

// Crowding: mount fires a kickstand click, a frame creak and a gravel shift
// inside 300 ms, and without a duck that is one stacked peak rather than one
// event. Same shape as the boat's.
const CROWD_WINDOW = 0.35;
const CROWD_MAX = 4;
const CROWD_K = 0.30;

/**
 * Band-pass loudness bookkeeping, lifted verbatim in intent from camp_props
 * (see the long note there): a band-pass throws away pass-band-proportional
 * energy, so a peak asked for at Q 8 and a peak asked for at Q 1 are not the
 * same peak unless somebody compensates. Neither is a taste question, so
 * neither is allowed to hide inside the voice tables below.
 */
const bwGain = (f, q) => Math.sqrt(Math.max(0.02, 1400 / Math.max(40, f / Math.max(0.2, q))));
const rmsOf = (buf) => {
  const d = buf.getChannelData(0);
  let s = 0;
  for (let i = 0; i < d.length; i += 7) s += d[i] * d[i];
  return Math.sqrt(s / Math.ceil(d.length / 7)) || 1;
};

// ── the two builds, as sound ────────────────────────────────────────────────
//
// They differ in exactly one audible way and it is the right one: the packer
// is carrying luggage. A loaded rack rattles, and that is worth a voice of its
// own more than any amount of tyre-width modelling would be.
const BUILD = {
  trail:  { roll: 1.00, grass: 1.00, ratchet: 1.00, rattle: 0.0 },
  // Fatter tyres and a loaded frame: a little more rumble, and noticeably more
  // to whip — a rack and a bag give the grass twice as much bike to hit.
  packer: { roll: 1.08, grass: 1.22, ratchet: 0.92, rattle: 1.0 },
};

/**
 * One-shot voices. Each receives the cue context `c` — level, pan, jittered
 * shape — and schedules its graph through the helpers at the bottom. `this` is
 * the BikeAudio instance.
 */
const VOICES = {
  /**
   * Getting on. Three things in 300 ms, in the order they happen: the
   * kickstand's spring snapping the leg up (a bright metallic tick with a
   * shorter one behind it — a spring, not a hinge), the frame taking a rider's
   * weight (a narrow band swept UP, the only rising gesture in this file,
   * which is how stressed material reads), and the tyres settling into the
   * ground under the load.
   */
  mount(c) {
    this._noise(c, 0.000, { f: 3100, q: 9, peak: 0.055, attack: 0.001, dur: 0.030 });
    this._noise(c, 0.035, { f: 2350, q: 7, peak: 0.030, attack: 0.001, dur: 0.024 });
    this._tone(c, 0.010, { f0: 420, f1: 300, peak: 0.030, attack: 0.002, dur: 0.09, type: 'triangle' });
    this._sweep(c, 0.090, { f0: 380, f1: 520, q: 7.0, peak: 0.030, attack: 0.050, dur: 0.18 });
    this._grind(c, 0.120, { lp: 420, peak: 0.045, attack: 0.030, dur: 0.26 });
  },

  /**
   * Getting off. The reverse gesture and deliberately heavier than `mount`:
   * the stand comes down under gravity rather than up under a spring, so it is
   * a clunk with a dull body under it, and the bike then settles onto it.
   */
  dismount(c) {
    this._grind(c, 0.000, { lp: 460, peak: 0.040, attack: 0.020, dur: 0.20 });
    this._noise(c, 0.140, { f: 1750, q: 5, peak: 0.060, attack: 0.001, dur: 0.045 });
    this._tone(c, 0.140, { f0: 240, f1: 165, peak: 0.048, attack: 0.002, dur: 0.16, type: 'triangle' });
    // the frame rocking onto the stand and stopping
    this._tone(c, 0.290, { f0: 190, f1: 150, peak: 0.022, attack: 0.004, dur: 0.13, type: 'triangle' });
  },

  /**
   * Running into something — a bank the wheel will not climb, a trunk, a
   * boulder. A dull tyre-on-solid thud, the fork loading, and a scuff of the
   * knobs skating sideways as the bike is turned away from it.
   */
  bump(c) {
    this._tone(c, 0.000, { f0: 118, f1: 74, peak: 0.070, attack: 0.003, dur: 0.14, type: 'triangle' });
    this._noise(c, 0.005, { f: 620, q: 2.2, peak: 0.045, attack: 0.002, dur: 0.06 });
    this._sweep(c, 0.040, { f0: 1500, f1: 700, q: 1.0, peak: 0.038, attack: 0.014, dur: 0.28 });
  },

  /**
   * Coming back down. Not `bump` with a different gain: a bump is the bike
   * stopping against something and a landing is the bike CONTINUING, so there
   * is no scuff of knobs skating and no fork loading against a wall — it is two
   * tyres arriving a beat apart, the frame taking the load, and the rider's
   * weight coming back onto the saddle.
   *
   * `c.strength` is the impact measured against the slope landed on (see
   * `_vertical`), which is why a jump that meets a downslope is nearly silent
   * and casing the flat is not. It moves the rear wheel's delay as well as the
   * level: a heavy landing puts both wheels down almost together, a light one
   * rolls through front-then-back.
   */
  land(c) {
    const s = 0.35 + c.strength * 0.65;
    const gap = 0.075 - c.strength * 0.045;
    // front tyre
    this._tone(c, 0.000, { f0: 96, f1: 62, peak: 0.055 * s, attack: 0.002, dur: 0.13, type: 'triangle' });
    this._noise(c, 0.000, { f: 520, q: 1.6, peak: 0.038 * s, attack: 0.001, dur: 0.05 });
    // rear tyre, with the rider's weight on it
    this._tone(c, gap, { f0: 104, f1: 58, peak: 0.070 * s, attack: 0.002, dur: 0.17, type: 'triangle' });
    this._noise(c, gap, { f: 430, q: 1.6, peak: 0.050 * s, attack: 0.001, dur: 0.07 });
    // the frame and the fork taking it, only when there is something to take
    if (c.strength > 0.45) {
      this._sweep(c, gap + 0.02, { f0: 1250, f1: 520, q: 1.1, peak: 0.030 * s, attack: 0.010, dur: 0.24 });
    }
  },

  /**
   * Water off a wheel. The vehicle-splash recipe (pink, a high band falling),
   * twice, because a bicycle puts two wheels in a few tenths of a second apart.
   *
   * `c.strength` is what makes this one voice do two jobs. At 1 it is the
   * ENTRY — the moment the front wheel hits the river, and a real event. Below
   * that it is one of the repeats that keep sounding for as long as the bike is
   * in the water (see the splash clock in `update`), which have to be smaller
   * or a ford turns into a drum roll. The second wheel is dropped entirely on
   * the quiet ones: at a repeat's level it is not a separate sound, it is just
   * twice the density.
   */
  splash(c) {
    const s = 0.30 + c.strength * 0.70;
    this._sweep(c, 0.000, { f0: 1600 * (0.9 + c.strength * 0.2), f1: 460, q: 0.7,
      peak: 0.115 * s, attack: 0.016, dur: 0.34 * (0.7 + c.strength * 0.3) });
    this._tone(c, 0.020, { f0: 150, f1: 82, peak: 0.030 * s, attack: 0.016, dur: 0.20 });
    if (c.strength > 0.6) {
      this._sweep(c, 0.180, { f0: 1350, f1: 420, q: 0.7, peak: 0.075 * s, attack: 0.016, dur: 0.30 });
    }
  },
};

export class BikeAudio {
  constructor(actx, bus, reverb, ctx) {
    this.actx = actx;
    this.ctx = ctx;
    this.rnd = mulberry32(0xb1c7);

    this.bus = gain(actx, 1);            // the layer's tap point
    this.bus.connect(bus);
    // A small send. Less than the boat's 0.14: a bike is on ground among trees
    // rather than out on open water, and a wet near-field mechanical sound is a
    // bicycle at the bottom of a well.
    this.wet = gain(actx, 0.09);
    this.bus.connect(this.wet).connect(reverb);

    this.cueBus = gain(actx, CUE_GAIN);
    this.cueBus.connect(this.bus);

    // Pink for the tyre bed (the standing rule: white noise reads as tape hiss
    // — see water.js), white for the ratchet and the brake, where a high-Q band
    // throws nearly all of it away. Brown built lazily for the one grind.
    this.pink = noiseBuffer(actx, 3, 'pink', 0xb1c1);
    this.hiss = noiseBuffer(actx, 1.2, 'white', 0xb1c2);
    this.brown = null;
    this._srcNorm = { pink: 0.5 / rmsOf(this.pink), hiss: 0.5 / rmsOf(this.hiss), brown: 0 };

    // ── the roll voice ──────────────────────────────────────────────────────
    // A WaterVoice's anatomy: three bands off one pink source under a shared
    // air lowpass, a multiplicative swell (never an LFO summed into a gain —
    // synth.js documents the floor bug), and a wandering band centre so the bed
    // is never stationary. The wander is faster than water's: a knobbly tyre
    // hits the ground several times a metre and the texture is granular, not
    // liquid.
    const r = this.roll = {
      src: noiseSource(actx, this.pink, 1),
      low: filter(actx, 'lowpass', 220, 0.8),
      body: filter(actx, 'bandpass', 700, 0.9),
      grit: filter(actx, 'highpass', 2600, 0.6),
      gLow: gain(actx, 0.9),
      gBody: gain(actx, 1.1),
      gGrit: gain(actx, 0),
      air: filter(actx, 'lowpass', 7000, 0.6),
      out: gain(actx, 0),
      pan: panner(actx, 0),
    };
    r.src.connect(r.low).connect(r.gLow).connect(r.air);
    r.src.connect(r.body).connect(r.gBody).connect(r.air);
    r.src.connect(r.grit).connect(r.gGrit).connect(r.air);
    r.swell = swell(actx, 0.9 + this.rnd() * 0.4, 0.22);
    r.air.connect(r.swell).connect(r.out).connect(r.pan).connect(this.bus);
    lfo(actx, 0.63, 190, r.body.frequency);

    // ── the grass voice ─────────────────────────────────────────────────────
    //
    // Blades, not ground. Two bands and no low end at all: a wide bright band
    // for the whip against the spokes and a narrower higher one for the tips
    // catching the fork and the bag. What makes it read as GRASS rather than as
    // hiss is that it is never steady — a fast flutter on the band centre (a
    // stalk every few centimetres at speed) over a slower swell (the tyre
    // passing through thicker and thinner stands). Both are movement in
    // frequency and in a multiplicative gain respectively, which is the pairing
    // synth.js says to use and the one the river voice already proved.
    const gr = this.grass = {
      src: noiseSource(actx, this.pink, 1),
      body: filter(actx, 'bandpass', 2300, 0.55),
      tips: filter(actx, 'bandpass', 4800, 1.6),
      gBody: gain(actx, 1.0),
      gTips: gain(actx, 0.45),
      air: filter(actx, 'lowpass', 9000, 0.6),
      out: gain(actx, 0),
      pan: panner(actx, 0),
    };
    gr.src.connect(gr.body).connect(gr.gBody).connect(gr.air);
    gr.src.connect(gr.tips).connect(gr.gTips).connect(gr.air);
    gr.swell = swell(actx, 1.4 + this.rnd() * 0.5, 0.34);
    gr.air.connect(gr.swell).connect(gr.out).connect(gr.pan).connect(this.bus);
    // The flutter. Deliberately much faster than the roll voice's wander: that
    // one is the ground breathing, this one is individual stalks.
    lfo(actx, 6.4, 620, gr.body.frequency);
    lfo(actx, 9.1, 900, gr.tips.frequency);

    // ── the freewheel ───────────────────────────────────────────────────────
    //
    // Not a scheduled click train. At 7 m/s a 348 mm wheel turns 3.2 times a
    // second and a 30-tooth ratchet ticks ~96 times a second, which is four
    // hundred nodes a second to schedule and is ALSO not what it sounds like —
    // above about 30 Hz the ear stops counting and starts hearing a pitch. So
    // it is one persistent voice: white noise through a high band, amplitude-
    // modulated by a SAWTOOTH at the tick rate. Below 30 Hz that reads as
    // countable clicks, above it as the hard buzz of a coasting bike, and the
    // crossover happens on its own at the speed it happens in life.
    //
    // The modulation is the `swell` construction and not `lfo`-on-a-gain: the
    // centre is 1.0 and lives here, the mixer's level lives in `out`, and the
    // two cannot eat each other (synth.js, at length).
    const f = this.free = {
      src: noiseSource(actx, this.hiss, 1),
      band: filter(actx, 'bandpass', 3000, 1.6),
      mod: gain(actx, 1),
      out: gain(actx, 0),
      pan: panner(actx, 0),
    };
    f.tick = lfo(actx, 20, 0.92, f.mod.gain);
    f.tick.osc.type = 'sawtooth';
    f.src.connect(f.band).connect(f.mod).connect(f.out).connect(f.pan).connect(this.bus);

    // ── the drivetrain ──────────────────────────────────────────────────────
    // Chain and cranks under load: low, dull, and wobbling once per pedal
    // stroke. The wobble is the tell — a steady mutter is a motor.
    const d = this.drive = {
      src: noiseSource(actx, this.pink, 1),
      band: filter(actx, 'bandpass', 320, 1.1),
      mod: gain(actx, 1),
      out: gain(actx, 0),
      pan: panner(actx, 0),
    };
    d.beat = lfo(actx, 1.4, 0.42, d.mod.gain);
    d.src.connect(d.band).connect(d.mod).connect(d.out).connect(d.pan).connect(this.bus);

    // ── the brake ───────────────────────────────────────────────────────────
    // Disc rub: high, narrow, and unstable on purpose — the band centre
    // wanders, because a squeal that holds one pitch is a test tone.
    const b = this.brake = {
      src: noiseSource(actx, this.hiss, 1),
      band: filter(actx, 'bandpass', 2400, 9),
      out: gain(actx, 0),
      pan: panner(actx, 0),
    };
    lfo(actx, 5.3, 260, b.band.frequency);
    b.src.connect(b.band).connect(b.out).connect(b.pan).connect(this.bus);

    // ── water under the wheels ──────────────────────────────────────────────
    const w = this.wade = {
      src: noiseSource(actx, this.pink, 1),
      band: filter(actx, 'bandpass', 1300, 0.8),
      out: gain(actx, 0),
      pan: panner(actx, 0),
    };
    w.swell = swell(actx, 1.7, 0.35);
    w.src.connect(w.band).connect(w.swell).connect(w.out).connect(w.pan).connect(this.bus);

    // ── the loaded rack ─────────────────────────────────────────────────────
    // Only the packer has one. A dry knock band gated on speed AND roughness,
    // so a dry bag rattles over broken ground and is silent on a smooth run.
    const k = this.rattle = {
      src: noiseSource(actx, this.hiss, 1),
      band: filter(actx, 'bandpass', 900, 4.5),
      mod: gain(actx, 1),
      out: gain(actx, 0),
      pan: panner(actx, 0),
    };
    k.beat = lfo(actx, 7.0, 0.85, k.mod.gain);
    k.beat.osc.type = 'sawtooth';
    k.src.connect(k.band).connect(k.mod).connect(k.out).connect(k.pan).connect(this.bus);

    this.sm = {
      roll: new Smooth(r.out.gain, 0.16, 0.0010),
      rollBody: new Smooth(r.body.frequency, 0.18, 6),
      rollLow: new Smooth(r.gLow.gain, 0.3, 0.01),
      rollGrit: new Smooth(r.gGrit.gain, 0.3, 0.004),
      air: new Smooth(r.air.frequency, 0.35, 25),
      grass: new Smooth(gr.out.gain, 0.16, 0.0010),
      grassBody: new Smooth(gr.body.frequency, 0.18, 8),
      grassTips: new Smooth(gr.gTips.gain, 0.25, 0.006),
      free: new Smooth(f.out.gain, 0.10, 0.0008),
      freeRate: new Smooth(f.tick.osc.frequency, 0.06, 0.4),
      freeBand: new Smooth(f.band.frequency, 0.20, 10),
      drive: new Smooth(d.out.gain, 0.14, 0.0008),
      driveRate: new Smooth(d.beat.osc.frequency, 0.12, 0.02),
      brake: new Smooth(b.out.gain, 0.06, 0.0008),
      wade: new Smooth(w.out.gain, 0.18, 0.0010),
      rattle: new Smooth(k.out.gain, 0.20, 0.0008),
      pan: new Smooth(r.pan.pan, 0.25, 0.01),
    };
    // One pan for the whole machine — it is one object, and five independently
    // panned voices on one bicycle is a chorus of bicycles.
    this._pans = [r.pan, gr.pan, f.pan, d.pan, b.pan, w.pan, k.pan];

    // Model terms the mix owns, reachable by name — the tyre `tune` contract,
    // so the Sound Lab writes the real numbers rather than faking a node.
    this.tune = {
      rollDrive: 0.16,     // bare-ground roll gain at full speed, before distance
      grassDrive: 0.14,    // …and the same for the grass voice. Held UNDER the
                           // ceiling's reach for ordinary riding, so the cap is
                           // a limiter on the peak rather than a level control
      rollRef: 9,          // m — how far the tyre bed carries
      freeDrive: 0.055,    // the ratchet, which is small and must stay small
      driveDrive: 0.045,
      brakeDrive: 0.075,
      wadeDrive: 0.14,
      rattleDrive: 0.030,
      brightness: 1.0,
    };

    this.L = null;
    this._recent = [];
    this._wasWading = false;
    this._splashT = 0;         // s to the next wheel splash while in the water
    this._warned = null;
    this.state = { roll: 0, grass: 0, free: 0, drive: 0, dist: Infinity, cues: 0, dropped: 0, last: '' };
  }

  /** Every gain the mixer owns, by name — the tyre.layers() contract. */
  layers() {
    return {
      bikeRoll: this.roll.out,
      bikeGrass: this.grass.out,
      bikeFree: this.free.out,
      bikeDrive: this.drive.out,
      bikeBrake: this.brake.out,
      bikeWade: this.wade.out,
      bikeRattle: this.rattle.out,
      bikeCue: this.cueBus,
    };
  }

  // ── frame ─────────────────────────────────────────────────────────────────

  update(dt, L) {
    this.L = L;
    const actx = this.actx;

    // Read defensively: the bike system may not exist, may be mid-init, or may
    // have no bike parked. All three are silence.
    const cur = this.ctx?.systems?.bike?.current ?? null;
    if (!cur || !cur.riding) {
      // A parked bike makes no sound at all. That is not laziness — it is the
      // point: silence at the camp is what makes the first turn of the cranks
      // land. The one exception would be wind in the spokes, and a bicycle you
      // can hear from a chair is a bicycle nobody would believe.
      for (const k of ['roll', 'grass', 'free', 'drive', 'brake', 'wade', 'rattle']) this.sm[k].set(0, actx);
      this.state.roll = this.state.grass = this.state.free = this.state.drive = 0;
      this.state.dist = cur ? Math.hypot(cur.x - L.x, cur.z - L.z) : Infinity;
      this._wasWading = false;
      return;
    }

    const B = BUILD[cur.style] ?? BUILD.trail;
    const speed = Math.abs(cur.speed ?? 0);
    const dx = (cur.x ?? 0) - L.x, dz = (cur.z ?? 0) - L.z;
    const d = Math.hypot(dx, dz);
    this.state.dist = d;
    // Distance law, shared by every continuous voice below so they cannot drift
    // apart as the camera zooms out.
    const ref = this.tune.rollRef;
    const near = Math.pow(ref / (ref + d), 2.2);

    // How much grass is actually standing under the wheels — the scatterer's
    // own density field, sampled at the contact patch (see the header, and
    // `grassCoverAt`). NOT the surface mix: on a wheel rut that reads 0.88 and
    // this reads 0.03, and it is this one the whip has to follow.
    const cover = clamp01(cur.grassCover ?? 0.5);
    // And how WET it is, which is a second axis: wet grass hisses and dry grass
    // rattles, wet dirt is dull and dry dirt is granular.
    const wet = clamp01(this.ctx?.world?.getMoisture?.(cur.x, cur.z) ?? 0.4);

    // ── the two ground voices ───────────────────────────────────────────────
    // Normalised against the model's own flat-ground ceiling (bike_physics:
    // about 8 m/s), so "full speed" here is a speed a bike reaches.
    const sp = clamp01(speed / 8);
    const gate = smoothstep(0.15, 1.0, speed);

    // Bare ground: the rumble. Fades out as the stand thickens — and, now that
    // the crossfade runs on cover rather than on the surface mix, it is a voice
    // the player actually meets: the tracks, the gravel bars and the bald
    // drifts inside the meadow all hand the bed to it.
    const rv = Math.min(GROUND_CEIL,
      gate * (0.25 + 0.75 * sp) * (1 - cover) * this.tune.rollDrive * B.roll * near);
    this.state.roll = rv;
    this.sm.roll.set(rv, actx);
    // Dry dirt is granular and bright; wet dirt is dull.
    const bright = this.tune.brightness * lerp(1.25, 0.85, wet);
    this.sm.rollBody.set(700 * bright * (1 + sp * 0.55), actx);
    this.sm.rollLow.set(lerp(0.8, 1.05, wet), actx);
    // The grit band is the knobs, and it is quadratic in speed and near-field
    // only — the river voice's hiss lesson, which applies to every top band in
    // this project.
    this.sm.rollGrit.set(lerp(0.22, 0.06, wet) * sp * sp * clamp01(1 - d / 16), actx);
    this.sm.air.set(clamp(7000 * Math.exp(-d / 45), 900, 7000), actx);

    // Vegetation: the whip. Steeper in speed than the rumble — a stalk hits
    // harder AND more of them hit per second — and it is the sound that
    // dominates this valley, because most of it is meadow. Linear in cover and
    // not curved: half as many blades is half as much whip, which is what the
    // player asked for and also what a contact patch does.
    //
    // sp^1.7 rather than sp²: the square was a real curve for a real effect and
    // it was also most of why the top end ran away, because it stacks with the
    // build and the distance terms. 1.7 keeps the "a rush, not a louder hiss"
    // read and arrives at the ceiling more gently. Capped — see GROUND_CEIL.
    const gv = Math.min(GROUND_CEIL,
      gate * (0.18 + 0.82 * Math.pow(sp, 1.7)) * cover
      * this.tune.grassDrive * B.grass * near);
    this.state.grass = gv;
    this.sm.grass.set(gv, actx);
    // Wet grass lies down and hisses; dry autumn grass stands up and rattles,
    // which is brighter and has far more in the tips band.
    this.sm.grassBody.set(2300 * lerp(1.12, 0.86, wet) * (1 + sp * 0.28), actx);
    this.sm.grassTips.set(lerp(0.62, 0.24, wet) * sp * clamp01(1 - d / 14), actx);

    // ── the freewheel ───────────────────────────────────────────────────────
    // Coasting only. `effort` is the gate and not `speed`, which is the whole
    // reason the physics publishes it: this is the layer's one piece of real
    // information and it is thrown away the moment it is inferred from speed.
    const coasting = clamp01(1 - cur.effort * 2.2) * smoothstep(0.4, 1.4, speed);
    // Tick rate: wheel revolutions × a 30-tooth ratchet, clamped so a hitched
    // frame cannot put a 2 kHz whine on the bus.
    const revs = (cur.wheelRate ?? 0) / (Math.PI * 2);
    this.sm.freeRate.set(clamp(revs * 30 * B.ratchet, 4, 320), actx);
    this.sm.freeBand.set(clamp(2400 + revs * 260, 1800, 5200), actx);
    const fv = coasting * this.tune.freeDrive * near;
    this.state.free = fv;
    this.sm.free.set(fv, actx);

    // ── the drivetrain ──────────────────────────────────────────────────────
    // The opposite gate. Wobbles once per pedal stroke, which is `cadence`
    // over 2π — a chain tightening on the power phase.
    const dv = clamp01(cur.effort) * smoothstep(0.1, 1.2, speed) * this.tune.driveDrive * near;
    this.state.drive = dv;
    this.sm.drive.set(dv, actx);
    this.sm.driveRate.set(clamp((cur.cadence ?? 0) / (Math.PI * 2), 0.4, 4.0), actx);

    // ── the brake ───────────────────────────────────────────────────────────
    // Brake × speed, both. A brake held at a standstill is a hand on a lever
    // and makes no sound at all.
    this.sm.brake.set(clamp01(cur.braking) * smoothstep(0.6, 4.0, speed)
      * this.tune.brakeDrive * near, actx);

    // ── water ───────────────────────────────────────────────────────────────
    //
    // `wade` is the physics' own normalised depth (`bike_physics` WADE_REF), so
    // the bed and the drag the rider is feeling can never disagree about how
    // deep they are.
    const wade = clamp01(cur.wade ?? 0);
    this.sm.wade.set(wade * smoothstep(0.2, 2.5, speed) * this.tune.wadeDrive * near, actx);

    // Entering the water is an EVENT, and a bed that fades in does not read as
    // one. Edge-triggered, once, at full strength, on the way in only.
    if (wade > 0.12 && !this._wasWading) { this.cue('splash', { strength: 1 }); this._splashT = 0.22; }
    this._wasWading = wade > 0.06;

    // …and then it keeps splashing for as long as the wheels are in it. A bed
    // alone cannot do this: water off a spinning tyre is a train of discrete
    // events, and a smooth hiss reads as a hose rather than as a bicycle
    // crossing a river. The clock tightens with speed — more revolutions, more
    // water thrown — and the cues are quiet, so the crowding duck in `_crowd`
    // keeps a fast crossing from stacking into one peak.
    if (wade > 0.06 && speed > 0.7) {
      this._splashT -= dt;
      if (this._splashT <= 0) {
        this._splashT = lerp(0.40, 0.12, clamp01(speed / 7)) * (0.75 + this.rnd() * 0.5);
        this.cue('splash', { strength: 0.22 + wade * 0.42 });
      }
    } else {
      this._splashT = Math.min(this._splashT, 0.10);
    }

    // ── the rack ────────────────────────────────────────────────────────────
    // Rough ground only: a dry bag on a smooth run is silent, and it is the
    // BUMPS that make luggage sound like luggage.
    const rough = clamp01((this.ctx?.world?.getSlope?.(cur.x, cur.z) ?? 0) * 1.4);
    this.sm.rattle.set(B.rattle * rough * smoothstep(1.0, 5.0, speed)
      * this.tune.rattleDrive * near, actx);
    this.rattle.beat.osc.frequency.value = clamp(4 + speed * 1.6, 4, 16);

    // ── one pan for the whole machine ───────────────────────────────────────
    const rel = Math.atan2(dx, dz) - L.yaw;
    const pan = clamp(Math.sin(rel) * clamp01((d - 2) / 9), -0.9, 0.9);
    this.sm.pan.set(pan, actx);
    for (let i = 1; i < this._pans.length; i++) this._pans[i].pan.value = pan;
    void dt;
  }

  // ── one-shots ─────────────────────────────────────────────────────────────

  /**
   * Sound one bike event.
   *
   * @param {string} kind  'mount' | 'dismount' | 'bump' | 'land' | 'splash'
   * @param {object} opts  x/z default to the live bike's position.
   */
  cue(kind, opts = {}) {
    const voice = VOICES[kind];
    if (!voice) {
      if (!(this._warned ??= new Set()).has(kind)) {
        this._warned.add(kind);
        console.warn('[bike:audio] no voice for', kind);
      }
      return;
    }
    const c = this._cueCtx(opts, 1);
    if (!c) return;
    c.strength = clamp01(opts.strength ?? 1);
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
    const cur = this.ctx?.systems?.bike?.current;
    const x = opts.x ?? cur?.x ?? L.x;
    const z = opts.z ?? cur?.z ?? L.z;
    const dx = x - L.x, dz = z - L.z;
    const d = Math.hypot(dx, dz);
    if (d > REACH) { this.state.dropped++; return null; }
    const k = clamp01(1 - (d - NEAR) / (REACH - NEAR));
    const level = Math.pow(k, FALLOFF) * clamp01(L.indoors ?? 1) * this._crowd() * peakScale;
    if (level < FLOOR) { this.state.dropped++; return null; }
    return {
      pan: clamp(Math.sin(Math.atan2(dx, dz) - L.yaw) * 0.7, -0.85, 0.85),
      level,
      // ±6% pitch and ±8% length, so nothing ever repeats bit-identically —
      // which matters more here than anywhere else in the game, because
      // mounting and dismounting is something a player does dozens of times.
      m: { pitch: 0.94 + this.rnd() * 0.12, dur: 0.92 + this.rnd() * 0.16 },
      strength: 1,
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

  // ── voice helpers (the boat's, with a per-cue destination) ────────────────

  /** A band-passed noise burst at a fixed centre — ticks, knocks, clicks. */
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

  /** An oscillator, optionally swept — frame bodies and clunks. */
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

  /** Pink noise through a band that moves — splashes and scuffs. */
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

  /** Brown noise under a lowpass — gravel shifting under a tyre. */
  _grind(c, at, { lp = 460, peak, attack = 0.04, dur = 0.3, pan = 0 }) {
    const actx = this.actx;
    if (!this.brown) {
      this.brown = noiseBuffer(actx, 1.5, 'brown', 0xb1c3);
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
export const BIKE_CUE_KINDS = Object.keys(VOICES);
