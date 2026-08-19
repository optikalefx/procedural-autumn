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

const IDLE_RPM = 760;
const MAX_RPM = 4200;
// Engine revolutions per wheel revolution, first through fifth. A camper is
// geared low and long: first is a crawler, fifth is 90 km/h at 2 500 rpm.
const GEARS = [15.2, 9.4, 6.3, 4.5, 3.4];

/** A 4-stroke four's spectrum: strong 1st and 2nd order, a long soft tail. */
function engineWave(actx) {
  const n = 26;
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let h = 1; h < n; h++) {
    // Even orders lead — that is the half-order firing pattern of a four.
    const even = h % 2 === 0 ? 1.5 : 0.75;
    im[h] = (even / Math.pow(h, 1.15)) * (1 + 0.18 * Math.sin(h * 2.4));
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
    this.engineHP = filter(actx, 'highpass', 55, 0.6);
    this.drive = actx.createWaveShaper();
    this.drive.curve = tanhCurve(2.4);
    this.drive.oversample = '2x';
    this.gEngine = gain(actx, 0);

    this.osc1.connect(this.gOsc1).connect(this.engineLP);
    this.osc2.connect(this.gOsc2).connect(this.engineLP);
    this.engineLP.connect(this.engineHP).connect(this.drive).connect(this.gEngine).connect(this.bus);
    this.osc1.start();
    this.osc2.start();

    // ── intake / induction ──────────────────────────────────────────────────
    const pink = noiseBuffer(actx, 4, 'pink', 0x44c1);
    const white = noiseBuffer(actx, 4, 'white', 0xb3e2);
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
    // Two bands: a soft roll under the vehicle, and a grit layer that only
    // exists on loose surfaces. Grass is nearly all roll; scree is nearly all
    // grit; a dirt track sits between and is where the game spends its time.
    this.tyreSrc = noiseSource(actx, white, 0.9);
    this.tyreBand = filter(actx, 'bandpass', 420, 0.8);
    this.gTyre = gain(actx, 0);
    this.tyreSrc.connect(this.tyreBand).connect(this.gTyre).connect(this.bus);

    this.gritSrc = noiseSource(actx, white, 1.31);
    this.gritHP = filter(actx, 'highpass', 2200, 0.7);
    this.gGrit = gain(actx, 0);
    this.gritSrc.connect(this.gritHP).connect(this.gGrit).connect(this.bus);

    // ── fording ─────────────────────────────────────────────────────────────
    this.waterSrc = noiseSource(actx, white, 1.07);
    this.waterBand = filter(actx, 'bandpass', 1600, 0.5);
    this.gWater = gain(actx, 0);
    this.waterSrc.connect(this.waterBand).connect(this.gWater).connect(this.bus);

    this.sm = {
      f1: new Smooth(this.osc1.frequency, 0.045, 0.15),
      f2: new Smooth(this.osc2.frequency, 0.045, 0.3),
      lp: new Smooth(this.engineLP.frequency, 0.07, 6),
      eng: new Smooth(this.gEngine.gain, 0.06, 0.002),
      intake: new Smooth(this.gIntake.gain, 0.08, 0.002),
      intakeF: new Smooth(this.intakeBand.frequency, 0.09, 4),
      over: new Smooth(this.gOver.gain, 0.10, 0.002),
      tyre: new Smooth(this.gTyre.gain, 0.09, 0.002),
      tyreF: new Smooth(this.tyreBand.frequency, 0.12, 6),
      grit: new Smooth(this.gGrit.gain, 0.09, 0.002),
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
      this.sm.tyre.set(0, actx); this.sm.grit.set(0, actx);
      this.sm.over.set(0, actx); this.sm.water.set(0, actx);
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
        ? (this._hardCurve ??= tanhCurve(4.2))
        : (this._softCurve ??= tanhCurve(2.2));
    }

    const engLevel = (0.055 + rpmN * 0.085 + this._loadSm * 0.055) * (1 - this._shiftDip * 0.75);
    this.sm.eng.set(engLevel, actx);

    // Intake: only really there when the throttle is open, and its resonance
    // climbs with revs.
    this.sm.intake.set(0.05 * this._throttleSm * (0.35 + rpmN), actx);
    this.sm.intakeF.set(180 + rpmN * 520, actx);

    // Overrun: lifted off, still spinning. The hollow rush plus a lost octave.
    const over = clamp01((1 - this._throttleSm) * rpmN * 1.5 - 0.15);
    this.sm.over.set(over * 0.045, actx);

    // ── tyres ───────────────────────────────────────────────────────────────
    const s = this.ctx.world.getSurfaceWeights(v.position.x, v.position.z, this._surf);
    const loose = clamp01((s.rock ?? 0) * 1.1 + (s.dirt ?? 0) * 0.8 + (s.sand ?? 0) * 0.5);
    const soft = clamp01((s.grass ?? 0) + (s.litter ?? 0) * 1.2 + (s.snow ?? 0));
    const speedN = clamp01(speed / 22);
    let slipSum = 0;
    for (const w of v.wheels) slipSum += w.slip ?? 0;
    const scrub = clamp01(slipSum / 4);

    const roll = smoothstep(0.4, 5, speed) * (0.055 + speedN * 0.075);
    this.sm.tyre.set(roll * lerp(0.7, 1.15, soft) * (1 + scrub * 0.5), actx);
    // Soft ground rolls low and dull; loose stone rattles high.
    this.sm.tyreF.set(300 + speedN * 520 + loose * 380, actx);
    this.sm.grit.set(roll * loose * 0.85 * (1 + scrub), actx);

    // ── fording ─────────────────────────────────────────────────────────────
    const depth = clamp01((v.waterDepth ?? 0) / 0.8);
    this.sm.water.set(depth * (0.05 + speedN * 0.16), actx);
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
    this.state.surface = loose > soft ? 'loose' : 'soft';
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

  /** Water entry. Bright, short, and it sweeps down as the bow wave collapses. */
  splash(strength = 0.6) {
    const actx = this.actx;
    const t = actx.currentTime + 0.01;
    const n = noiseSource(actx, this._splashBuf ??= noiseBuffer(actx, 1.2, 'white', 0x5a12));
    const bp = filter(actx, 'bandpass', 2600, 0.7);
    bp.frequency.setValueAtTime(3000, t);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.42);
    const g = gain(actx, 0);
    n.connect(bp).connect(g).connect(this.bus);
    ping(actx, g, t, clamp01(strength) * 0.22, 0.012, 0.45);
    stopLater([n, bp, g], actx, t + 0.7);
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
