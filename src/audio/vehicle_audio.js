// ─────────────────────────────────────────────────────────────────────────────
//  The camper.
//
//  The thing that separates a vehicle that sounds alive from one that sounds
//  like a looped drone is that *nothing here is driven by speed*. Everything is
//  driven by a small engine model — an RPM that runs through a gearbox, a load
//  term that knows whether you are climbing, and an overrun state when you lift
//  off. Speed is an output of that, not the input.
//
//  Layers:
//    · combustion   a harmonic-rich oscillator at the firing frequency
//    · intake       resonant noise that opens with throttle
//    · overrun      the hollow rush when you lift off at revs
//    · tyres        surface noise, band and grit from getSurfaceWeights
//    · suspension   one-shot knocks off wheel compression spikes
//    · water        continuous ford hiss + a splash on entry
//    · mechanical   handbrake ratchet, door thunk
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, lerp, smoothstep, damp, mulberry32 } from '../core/MathUtils.js';
import { VEHICLE } from '../world/WorldConfig.js';
import {
  noiseBuffer, noiseSource, filter, gain, Smooth, ping, stopLater, tanhCurve, panner,
} from './synth.js';
import { TyreContact } from './tyre.js';

const IDLE_RPM = 760;
const MAX_RPM = 4200;
// Engine revolutions per wheel revolution, first through fifth. A camper is
// geared low and long: first is a crawler, fifth is 90 km/h at 2 500 rpm.
const GEARS = [15.2, 9.4, 6.3, 4.5, 3.4];

/**
 * A 4-stroke four's spectrum: strong 1st and 2nd order, a short soft tail.
 *
 * The exponent is the whole character. At 1/h^1.15 over 26 harmonics this was
 * within a hair of a sawtooth, and a sawtooth is the definition of buzzy — the
 * 24th order was still only 32 dB down, which at an idle firing frequency of
 * 25 Hz puts real energy at 600 Hz and above with nothing asking it to be
 * there. 1/h^1.9 over 16 keeps the even-order lead that makes it read as a
 * four and lets the tail actually end.
 */
function engineWave(actx) {
  const n = 16;
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let h = 1; h < n; h++) {
    // Even orders lead — that is the half-order firing pattern of a four.
    const even = h % 2 === 0 ? 1.5 : 0.75;
    im[h] = (even / Math.pow(h, 1.9)) * (1 + 0.18 * Math.sin(h * 2.4));
  }
  return actx.createPeriodicWave(re, im, { disableNormalization: false });
}

export class VehicleAudio {
  constructor(actx, bus, ctx) {
    this.actx = actx;
    this.ctx = ctx;
    this.rnd = mulberry32(0xca17);

    this.bus = gain(actx, 1);
    this.bus.connect(bus);

    // ── combustion ──────────────────────────────────────────────────────────
    // Two oscillators an octave apart: the fundamental gives the chug, the
    // octave gives the tone you actually hear as "revs". Slight detune between
    // them keeps it from sounding like a single synth note.
    const wave = engineWave(actx);
    this.osc1 = actx.createOscillator();
    this.osc1.setPeriodicWave(wave);
    this.osc2 = actx.createOscillator();
    this.osc2.setPeriodicWave(wave);
    this.osc2.detune.value = 9;
    this.gOsc1 = gain(actx, 0.9);
    this.gOsc2 = gain(actx, 0.35);

    // The load filter is the single most expressive control in the whole
    // system: a shut cutoff is a distant idle, an open one is a labouring
    // climb, and moving it with load is what makes hills audible.
    this.engineLP = filter(actx, 'lowpass', 420, 1.3);
    // 30 Hz, not 55. This exists only to keep DC and sub-audible rumble out of
    // the master; at 55 it was cutting the *second order* at idle (a four at
    // 760 rpm fires at 25 Hz, so the second order is 51 Hz), which left the
    // idle thin and made the dominant partial jump between the 2nd and 4th
    // order depending on load.
    this.engineHP = filter(actx, 'highpass', 30, 0.6);
    this.drive = actx.createWaveShaper();
    this.drive.curve = tanhCurve(1.5);
    this.drive.oversample = '2x';
    // The cab. Saturation *generates* harmonics, so a waveshaper sitting after
    // the only lowpass in the chain hands the mix a fresh top end that nothing
    // downstream is asked to remove. Measured, that showed up as an engine bus
    // whose octave bands stopped falling at 4 kHz and ran flat to 16 — a
    // rolloff that turns into a shelf is the signature, and a shelf up there is
    // exactly what "harsh" means. The load filter still opens with the hill;
    // this only says the sound reaches you through a van.
    this.cabLP = filter(actx, 'lowpass', 520, 0.5);
    this.gEngine = gain(actx, 0);

    this.osc1.connect(this.gOsc1).connect(this.engineLP);
    this.osc2.connect(this.gOsc2).connect(this.engineLP);
    this.engineLP.connect(this.engineHP).connect(this.drive).connect(this.cabLP)
      .connect(this.gEngine).connect(this.bus);
    this.osc1.start();
    this.osc2.start();

    // ── intake / induction ──────────────────────────────────────────────────
    const pink = noiseBuffer(actx, 4, 'pink', 0x44c1);
    this.intakeSrc = noiseSource(actx, pink);
    this.intakeBand = filter(actx, 'bandpass', 220, 2.6);
    this.gIntake = gain(actx, 0);
    this.intakeSrc.connect(this.intakeBand).connect(this.gIntake).connect(this.bus);

    // ── overrun ─────────────────────────────────────────────────────────────
    this.overSrc = noiseSource(actx, pink, 0.83);
    this.overLP = filter(actx, 'lowpass', 700, 0.9);
    this.gOver = gain(actx, 0);
    this.overSrc.connect(this.overLP).connect(this.gOver).connect(this.bus);

    // ── tyres ───────────────────────────────────────────────────────────────
    // Delegated in full to `TyreContact`, which is four layers of which only
    // one is a noise bed.
    //
    // What used to be here was two filtered noise beds — a `tyreBand` roll and
    // a `gritHP` bright layer — and the player drove the sound lab and reported
    // that the result "sounds like wind. Not an offroad rubber tire with treads
    // rolling." They were right, and it was not a setting: filtered continuous
    // noise *is* wind, it is the same signal the ambience layer is built from,
    // and the lab's sliders could only move it between kinds of wind. Measured,
    // the old bed's crest factor over 2.7 ms blocks was 4.1-4.8 dB on rock and
    // dirt — Gaussian noise to two decimal places — and its transient density
    // was flat to ×1.02 across a ×5.5 change in speed, so the only thing speed
    // did was raise the gain. That is the definition of wind getting louder.
    //
    // The replacement is granular: a scheduled stream of stone impacts whose
    // *rate* is proportional to wheel rotation, a tread hum at the block-passing
    // frequency, a struck carcass resonance, and a much smaller continuous bed
    // that is now the sliding-contact residual rather than the whole tyre. See
    // the header of `tyre.js` for why each of the four exists.
    this.tyres = new TyreContact(actx, this.bus, VEHICLE.wheelRadius);

    // ── fording ─────────────────────────────────────────────────────────────
    // White noise through a Q of 0.5 is barely filtered at all: the skirts are
    // two octaves wide, so most of the source's top end walked straight past
    // the band and the bed measured 44% of its energy in 2-5 kHz — the region
    // the ear is most sensitive to, and the one that fatigues. Dropping the
    // centre frequency could not fix that, because the problem was never where
    // the band sat; it was how much went around it. Pink at a narrower Q puts
    // the same bed at 8%. See `noiseBuffer` in synth.js, which has said pink is
    // the right bed for water since it was written.
    this.waterSrc = noiseSource(actx, pink, 0.85);
    this.waterBand = filter(actx, 'bandpass', 900, 0.9);
    this.gWater = gain(actx, 0);
    this.waterSrc.connect(this.waterBand).connect(this.gWater).connect(this.bus);

    this.sm = {
      f1: new Smooth(this.osc1.frequency, 0.045, 0.15),
      f2: new Smooth(this.osc2.frequency, 0.045, 0.3),
      lp: new Smooth(this.engineLP.frequency, 0.07, 6),
      cab: new Smooth(this.cabLP.frequency, 0.10, 8),
      eng: new Smooth(this.gEngine.gain, 0.06, 0.002),
      intake: new Smooth(this.gIntake.gain, 0.08, 0.002),
      intakeF: new Smooth(this.intakeBand.frequency, 0.09, 4),
      over: new Smooth(this.gOver.gain, 0.10, 0.002),
      water: new Smooth(this.gWater.gain, 0.10, 0.003),
    };

    // model state
    this.rpm = IDLE_RPM;
    this.gear = 0;
    this._gearHold = 0;
    this._shiftDip = 0;
    this._throttleSm = 0;
    this._loadSm = 0;
    this._compression = [0, 0, 0, 0];
    this._grounded = [true, true, true, true];
    this._knockCool = 0;
    this._wasHandbrake = false;
    this._wasWater = false;
    this._surf = {};
    this.state = { rpm: IDLE_RPM, gear: 1, f0: 0, load: 0, tyre: 0, surface: 'grass' };
  }

  /** The whole camper, in one number pair: firing frequency and load. */
  update(dt, L) {
    const actx = this.actx;
    const v = this.ctx.systems?.vehicle;
    if (!v || !v.phys?.ready) {
      // No camper yet (or it failed to init): make sure we are silent rather
      // than holding an idle drone over a system that does not exist.
      this.sm.eng.set(0, actx); this.sm.intake.set(0, actx);
      this.sm.over.set(0, actx); this.sm.water.set(0, actx);
      this.tyres.silence();
      return;
    }

    const speed = Math.abs(v.speed);
    const throttle = clamp01(v.throttle ?? 0);
    this._throttleSm = damp(this._throttleSm, throttle, 12, dt);

    // ── gearbox ─────────────────────────────────────────────────────────────
    const wheelRps = speed / (2 * Math.PI * VEHICLE.wheelRadius);
    this._gearHold -= dt;
    let g = this.gear;
    const rpmIn = (gi) => wheelRps * GEARS[gi] * 60;
    if (this._gearHold <= 0) {
      if (rpmIn(g) > 3050 && g < GEARS.length - 1) { g++; this._shift(); }
      else if (g > 0 && rpmIn(g) < 1250) { g--; this._shift(); }
    }
    this.gear = g;

    // ── rpm ────────────────────────────────────────────────────────────────
    // Below walking pace the clutch is slipping, so revs follow the throttle
    // rather than the wheels — without this the camper pulls away in silence
    // and only "starts" once it is already moving.
    const geared = clamp(rpmIn(g), IDLE_RPM, MAX_RPM);
    const slip = 1 - smoothstep(0.6, 4.2, speed);
    const flare = lerp(IDLE_RPM, 2500, this._throttleSm);
    let target = lerp(geared, Math.max(geared, flare), slip);
    // A real idle hunts by a few tens of rpm. Without this the camper sits at
    // exactly 760.0 rpm forever and reads as a held synth note rather than as
    // an engine ticking over.
    const t = actx.currentTime;
    target += (1 - smoothstep(0.4, 2.2, speed)) * (Math.sin(t * 3.1) * 15 + Math.sin(t * 7.7 + 1.3) * 9);
    // Revs hang a little on the way down; a step response sounds electric.
    this.rpm = damp(this.rpm, target, target > this.rpm ? 5.5 : 2.6, dt);
    this._shiftDip = damp(this._shiftDip, 0, 9, dt);

    // ── load ────────────────────────────────────────────────────────────────
    // Throttle plus the gradient the camper is actually on. `forward.y` is the
    // nose pitch, so climbing loads the engine and descending unloads it, which
    // is exactly the cue a driver listens for.
    const grade = clamp(v.forward?.y ?? 0, -0.6, 0.6);
    const rawLoad = clamp01(this._throttleSm * (0.6 + clamp01(grade * 2.2)) + clamp01(grade) * 0.35);
    this._loadSm = damp(this._loadSm, rawLoad, 6, dt);
    const rpmN = clamp01((this.rpm - IDLE_RPM) / (MAX_RPM - IDLE_RPM));

    // Firing frequency of a four-stroke four: two power strokes per rev.
    const f0 = (this.rpm / 60) * 2;
    this.sm.f1.set(f0, actx);
    this.sm.f2.set(f0 * 2, actx);

    // Cutoff opens with revs *and* load. At idle it is nearly shut, so the
    // camper ticks over instead of buzzing.
    this.sm.lp.set(340 + rpmN * 2600 + this._loadSm * 1500, actx);
    // Saturation follows load: a labouring engine gets harder-edged. Swapped
    // with hysteresis and only on a change — assigning `curve` rebuilds the
    // shaper's internal table, and doing that at 60 Hz would be pure waste.
    const wantHard = this._loadSm > (this._hardOn ? 0.45 : 0.62);
    if (wantHard !== this._hardOn) {
      this._hardOn = wantHard;
      this.drive.curve = wantHard
        ? (this._hardCurve ??= tanhCurve(2.6))
        : (this._softCurve ??= tanhCurve(1.5));
    }
    // The cab filter tracks the same two terms as the load filter, so effort
    // still opens the sound up — a climb is allowed to get brighter. What it
    // will not do any more is stay open when the camper is coasting on the
    // flat, which is where the player spends almost all of their time.
    this.sm.cab.set(520 + rpmN * 640 + this._loadSm * 1050, actx);

    // Measured against the rest of the mix: at the first pass the vehicle bus
    // sat at -19.6 dBFS rms while the whole ambience bed was at -33, i.e. the
    // engine *was* the game. This is a cozy driving game and the engine is
    // company, not the subject.
    // Re-measured against the rest of the mix a second time. The first pass
    // moved the engine from -19.6 to -25.5 dBFS rms, which was still 12 dB
    // above the entire ambience bed and, A-weighted, was the whole master on
    // its own: -42.5 dBA of engine inside a -42.0 dBA mix.
    //
    // The cut is deliberately uneven. Idle comes down 9 dB and a loaded climb
    // only 5, so the span from ticking over to labouring widens from 9.7 dB to
    // 13.9 — you notice the engine on a hill and forget it on the flat, which
    // is the opposite of turning one constant down.
    const engLevel = (0.0105 + rpmN * 0.021 + this._loadSm * 0.030) * (1 - this._shiftDip * 0.75);
    this.sm.eng.set(engLevel, actx);

    // Intake: only really there when the throttle is open, and its resonance
    // climbs with revs.
    this.sm.intake.set(0.016 * this._throttleSm * (0.35 + rpmN), actx);
    this.sm.intakeF.set(180 + rpmN * 520, actx);

    // Overrun: lifted off, still spinning. The hollow rush plus a lost octave.
    const over = clamp01((1 - this._throttleSm) * rpmN * 1.5 - 0.15);
    this.sm.over.set(over * 0.017, actx);

    // ── tyres ───────────────────────────────────────────────────────────────
    // The surface mix goes to `TyreContact` whole rather than being collapsed
    // to `loose`/`soft` scalars first. The granular model interpolates its own
    // per-surface character table by the same weights, so a tyre crossing from
    // grass onto scree crosses instead of switching, and each surface keeps a
    // stone size, a ring pitch and a decay rather than just a filter centre.
    const s = this.ctx.world.getSurfaceWeights(v.position.x, v.position.z, this._surf);
    const speedN = clamp01(speed / 22);
    let slipSum = 0;
    for (const w of v.wheels) slipSum += w.slip ?? 0;
    const scrub = clamp01(slipSum / 4);

    // `roll` stays here and stays exactly as it was: it is the one place the
    // speed/level relationship for the whole contact patch is decided, and it
    // was tuned against the mix. What changed underneath it is that level is no
    // longer the *only* thing speed does — impact rate is proportional to wheel
    // rotation, which is the difference between gravel and wind getting louder.
    const roll = smoothstep(0.4, 5, speed) * (0.016 + speedN * 0.026);
    this.tyres.update(dt, { speed, weights: s, scrub, roll });

    // ── fording ─────────────────────────────────────────────────────────────
    const depth = clamp01((v.waterDepth ?? 0) / 0.8);
    // Compensated x1.5 for the pink source, which carries far less energy per
    // unit amplitude than white; net, the bed lands ~7 dBA below the old one.
    this.sm.water.set(depth * (0.06 + speedN * 0.18), actx);
    if (depth > 0.12 && !this._wasWater) this.splash(clamp01(0.4 + speedN));
    this._wasWater = depth > 0.10;

    // ── suspension ──────────────────────────────────────────────────────────
    this._knockCool -= dt;
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      if (!w) continue;
      const c = w.compression ?? 0;
      const rate = (c - this._compression[i]) / Math.max(dt, 1e-3);
      const landed = w.grounded && !this._grounded[i];
      this._compression[i] = c;
      this._grounded[i] = w.grounded;
      // A knock is a *rate* event, not a position one: the axle hitting its
      // stop, not the wheel being compressed. 3.5/s is a real pothole and does
      // not fire on gentle undulation.
      if (this._knockCool <= 0 && (rate > 3.5 || (landed && speed > 2))) {
        this._knockCool = 0.075;
        this.knock(clamp01(rate * 0.14 + (landed ? 0.35 : 0)) * (0.35 + speedN * 0.65));
      }
    }

    // ── handbrake ───────────────────────────────────────────────────────────
    const hb = (this.ctx.input?.axes?.handbrake ?? 0) > 0.5;
    if (hb && !this._wasHandbrake) this.ratchet();
    this._wasHandbrake = hb;

    this.state.rpm = this.rpm;
    this.state.gear = g + 1;
    this.state.f0 = f0;
    this.state.load = this._loadSm;
    this.state.tyre = roll;
    this.state.surface = this.tyres.state.surface;
    void L;
  }

  _shift() {
    this._gearHold = 0.55;
    // The dip is what sells a shift: a momentary loss of drive, not a pitch
    // jump. It decays back over ~120 ms.
    this._shiftDip = 1;
  }

  // ── one-shots ─────────────────────────────────────────────────────────────

  /** Suspension knock: a short low thump with a bit of hardware on top. */
  knock(strength = 0.5) {
    const actx = this.actx;
    const t = actx.currentTime + 0.005;
    const o = actx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
    const g = gain(actx, 0);
    const lp = filter(actx, 'lowpass', 900, 0.8);
    o.connect(g).connect(lp).connect(this.bus);
    ping(actx, g, t, clamp(strength, 0.02, 1) * 0.13, 0.003, 0.13);
    o.start(t); o.stop(t + 0.2);

    // The rattle of everything in the back of a camper.
    const n = noiseSource(actx, this._clickBuf ??= noiseBuffer(actx, 0.5, 'white', 0x7731));
    const nf = filter(actx, 'bandpass', 1400 + this.rnd() * 700, 1.6);
    const ng = gain(actx, 0);
    n.connect(nf).connect(ng).connect(this.bus);
    ping(actx, ng, t, strength * 0.05, 0.002, 0.06);
    stopLater([o, g, lp, n, nf, ng], actx, t + 0.35);
  }

  /** Water entry: a dropping whoomph as the bow wave collapses, not a hiss. */
  splash(strength = 0.6) {
    const actx = this.actx;
    const t = actx.currentTime + 0.01;
    // This was the sharp one. White noise swept 3000 -> 700 Hz starts inside
    // the ear's most sensitive octave and spends its whole decay there: 46% of
    // the transient's energy sat in 2-5 kHz, against 11% now. It is also the
    // sound the ford bed gets blamed for — the bed is continuous and shows up
    // on the meter, while this is 0.5 s and barely moves an RMS window.
    //
    // `splashPatch` is how the sound lab reaches a one-shot: there is no live
    // AudioParam to write, because the graph below does not exist until this
    // method runs. Absent the lab it is undefined and the shipped numbers win.
    const p = this.splashPatch ?? {};
    const f0 = p.f0 ?? 1400, f1 = p.f1 ?? 380;
    const n = noiseSource(actx, this._splashBuf ??= noiseBuffer(actx, 1.2, 'pink', 0x5a12));
    const bp = filter(actx, 'bandpass', f0, 0.7);
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.exponentialRampToValueAtTime(f1, t + 0.5);
    const g = gain(actx, 0);
    n.connect(bp).connect(g).connect(this.bus);
    // 0.4 against the old 0.22 is not a louder splash: pink is much quieter
    // per unit amplitude, and this measures ~3 dBA below what it replaces.
    ping(actx, g, t, clamp01(strength) * (p.peak ?? 0.4), p.attack ?? 0.022, 0.5);
    stopLater([n, bp, g], actx, t + 0.75);
  }

  /** Handbrake: four hard clicks on the ratchet. */
  ratchet() {
    const actx = this.actx;
    const t0 = actx.currentTime + 0.01;
    const nodes = [];
    for (let i = 0; i < 4; i++) {
      const t = t0 + i * 0.052;
      const n = noiseSource(actx, this._clickBuf ??= noiseBuffer(actx, 0.5, 'white', 0x7731));
      const bp = filter(actx, 'bandpass', 2300 + i * 180, 5.5);
      const g = gain(actx, 0);
      n.connect(bp).connect(g).connect(this.bus);
      ping(actx, g, t, 0.075, 0.001, 0.022);
      nodes.push(n, bp, g);
    }
    stopLater(nodes, actx, t0 + 0.4);
  }

  /** Door: a soft thunk plus the little rattle of a latch. Used by photo mode. */
  door() {
    const actx = this.actx;
    const t = actx.currentTime + 0.01;
    const o = actx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(72, t + 0.16);
    const g = gain(actx, 0);
    const lp = filter(actx, 'lowpass', 620, 0.7);
    o.connect(g).connect(lp).connect(this.bus);
    ping(actx, g, t, 0.10, 0.004, 0.19);
    o.start(t); o.stop(t + 0.3);

    const n = noiseSource(actx, this._clickBuf ??= noiseBuffer(actx, 0.5, 'white', 0x7731));
    const bp = filter(actx, 'bandpass', 1900, 3.0);
    const ng = gain(actx, 0);
    const p = panner(actx, -0.25);
    n.connect(bp).connect(ng).connect(p).connect(this.bus);
    ping(actx, ng, t + 0.01, 0.05, 0.002, 0.07);
    stopLater([o, g, lp, n, bp, ng, p], actx, t + 0.5);
  }

  /** Camera shutter for photo mode — mechanical, not a digital beep. */
  shutter() {
    const actx = this.actx;
    const t = actx.currentTime + 0.005;
    const nodes = [];
    for (const [dt2, f, amp] of [[0, 3200, 0.09], [0.055, 2400, 0.07]]) {
      const n = noiseSource(actx, this._clickBuf ??= noiseBuffer(actx, 0.5, 'white', 0x7731));
      const bp = filter(actx, 'bandpass', f, 4.0);
      const g = gain(actx, 0);
      n.connect(bp).connect(g).connect(this.bus);
      ping(actx, g, t + dt2, amp, 0.001, 0.03);
      nodes.push(n, bp, g);
    }
    stopLater(nodes, actx, t + 0.3);
  }
}
