// ─────────────────────────────────────────────────────────────────────────────
//  Water — the most rewarding sound in the game, and the only one the world
//  hands you for free: 28 waterfalls with a measured height and discharge, and
//  every river polyline with per-point flow.
//
//  Two things make it work:
//
//   · **Size, not distance, sets the character.** A big fall is mostly low
//     rumble and takes 600 m to disappear; a step in a creek is all hiss and is
//     gone in eighty. That difference is what makes the valley feel mapped by
//     ear — you can tell what is over the ridge before you crest it.
//   · **Air eats the top end.** Distance is modelled as a moving lowpass as
//     well as a gain. Without it a distant fall is a quiet near fall, which
//     reads as a volume slider rather than as somewhere else.
//
//  A small voice pool is re-targeted at whatever is loudest, so the cost is
//  five voices whether the player is beside one fall or twelve.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, lerp } from '../core/MathUtils.js';
import { noiseBuffer, noiseSource, filter, gain, lfo, Smooth, panner } from './synth.js';

const FALL_VOICES = 3;
const RIVER_VOICES = 2;

/** One water voice: three bands of noise under a shared distance lowpass. */
class WaterVoice {
  constructor(actx, bus, buf, rate, isFall) {
    this.actx = actx;
    this.src = noiseSource(actx, buf, rate);
    this.low = filter(actx, 'lowpass', 190, 0.9);
    this.body = filter(actx, 'bandpass', isFall ? 620 : 1150, isFall ? 0.5 : 0.7);
    this.hiss = filter(actx, 'highpass', isFall ? 2600 : 3400, 0.6);
    this.gLow = gain(actx, isFall ? 0.9 : 0.12);
    this.gBody = gain(actx, 0.8);
    this.gHiss = gain(actx, 0.5);
    this.air = filter(actx, 'lowpass', 16000, 0.6);
    this.out = gain(actx, 0);
    this.pan = panner(actx, 0);

    this.src.connect(this.low).connect(this.gLow).connect(this.air);
    this.src.connect(this.body).connect(this.gBody).connect(this.air);
    this.src.connect(this.hiss).connect(this.gHiss).connect(this.air);
    this.air.connect(this.out).connect(this.pan).connect(bus);

    // A slow swell so a held tone does not sit perfectly still. Real falling
    // water breathes as the sheet wanders.
    lfo(actx, 0.043 + Math.random() * 0.02, 0.09, this.out.gain);

    this.sm = {
      out: new Smooth(this.out.gain, 0.35, 0.0015),
      pan: new Smooth(this.pan.pan, 0.25, 0.01),
      air: new Smooth(this.air.frequency, 0.4, 25),
      low: new Smooth(this.gLow.gain, 0.5, 0.01),
      hiss: new Smooth(this.gHiss.gain, 0.4, 0.01),
    };
    this.target = -1;
    this.level = 0;
  }

  /** Re-point at a different source: silence first so we never hard-cut. */
  retarget(i) {
    this.target = i;
    this.sm.out.hard(0, this.actx);
    this.level = 0;
  }

  silence() { this.target = -1; this.sm.out.set(0, this.actx); this.level = 0; }
}

export class WaterAudio {
  constructor(actx, bus, world) {
    this.actx = actx;
    this.world = world;

    this.bus = gain(actx, 1);
    this.bus.connect(bus);

    const bufA = noiseBuffer(actx, 4, 'pink', 0x2277);
    const bufB = noiseBuffer(actx, 4, 'white', 0x91ab);

    this.falls = [];
    for (let i = 0; i < FALL_VOICES; i++) {
      this.falls.push(new WaterVoice(actx, this.bus, bufA, 0.88 + i * 0.09, true));
    }
    this.rivers = [];
    for (let i = 0; i < RIVER_VOICES; i++) {
      this.rivers.push(new WaterVoice(actx, this.bus, bufB, 0.97 + i * 0.06, false));
    }

    // ── source tables ───────────────────────────────────────────────────────
    // Flattened once so the per-frame scan is a tight numeric loop with no
    // property access and no allocation.
    const wf = world?.waterfalls ?? [];
    this.wfN = wf.length;
    this.wfX = new Float32Array(this.wfN);
    this.wfY = new Float32Array(this.wfN);
    this.wfZ = new Float32Array(this.wfN);
    this.wfSize = new Float32Array(this.wfN);
    this.wfRef = new Float32Array(this.wfN);
    for (let i = 0; i < this.wfN; i++) {
      const f = wf[i];
      const t = f.top, b = f.bottom;
      // Listen from the *base*, weighted a third of the way up the drop: that
      // is where the noise is actually made.
      this.wfX[i] = lerp(b[0], t[0], 0.33);
      this.wfY[i] = lerp(b[1], t[1], 0.33);
      this.wfZ[i] = lerp(b[2], t[2], 0.33);
      const disc = clamp01(f.discharge ?? 0.2);
      const h = clamp(f.height ?? 4, 1, 60);
      this.wfSize[i] = clamp01(disc * 0.62 + (h / 40) * 0.5);
      // Reference distance: how far this fall carries. Height matters more
      // than flow here, which matches how a big dry-season fall still booms.
      this.wfRef[i] = 26 + h * 1.7 + disc * 44;
    }

    // River points, thinned. Every third polyline vertex is plenty — the ear
    // cannot localise a stream to better than a few metres.
    const polys = world?.riverPolylines ?? [];
    const px = [], pz = [], pf = [];
    for (const line of polys) {
      if (!line || line.length < 2) continue;
      for (let i = 0; i < line.length; i += 3) {
        const p = line[i];
        if (!p) continue;
        const flow = clamp01(p.flow ?? p.w ?? 0.4);
        if (flow < 0.05) continue;
        px.push(p.x); pz.push(p.z); pf.push(flow);
      }
    }
    this.rvN = px.length;
    this.rvX = Float32Array.from(px);
    this.rvZ = Float32Array.from(pz);
    this.rvF = Float32Array.from(pf);

    this._tick = 0;
    this.state = { fallGain: 0, riverGain: 0, nearestFall: Infinity, voices: 0 };
  }

  /**
   * Re-scan is staggered: the tables are static, the listener moves slowly
   * relative to a 3 km valley, and a full 28-fall + several-thousand-point scan
   * every frame would be the most expensive thing in the audio system for no
   * audible benefit.
   */
  update(dt, L) {
    this._tick++;
    if ((this._tick & 3) === 0) this._assign(L);
    this._drive(dt, L);
  }

  _assign(L) {
    // ── waterfalls: keep the three loudest ──────────────────────────────────
    let b0 = -1, b1 = -1, b2 = -1, s0 = 0, s1 = 0, s2 = 0;
    let nearest = Infinity;
    for (let i = 0; i < this.wfN; i++) {
      const dx = this.wfX[i] - L.x, dy = (this.wfY[i] - L.y) * 0.6, dz = this.wfZ[i] - L.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < nearest) nearest = d;
      const ref = this.wfRef[i];
      const s = this.wfSize[i] * Math.pow(ref / (ref + d), 1.6);
      if (s > s0) { s2 = s1; b2 = b1; s1 = s0; b1 = b0; s0 = s; b0 = i; }
      else if (s > s1) { s2 = s1; b2 = b1; s1 = s; b1 = i; }
      else if (s > s2) { s2 = s; b2 = i; }
    }
    this.state.nearestFall = nearest;
    const want = [b0, b1, b2];
    // Voices that are still on a wanted fall keep it; the rest are re-pointed.
    const held = new Set();
    for (const v of this.falls) if (want.includes(v.target)) held.add(v.target);
    let k = 0;
    for (const v of this.falls) {
      if (held.has(v.target)) continue;
      while (k < want.length && (held.has(want[k]) || want[k] < 0)) k++;
      if (k < want.length) { v.retarget(want[k]); held.add(want[k]); k++; }
      else v.silence();
    }
    // ── rivers: nearest point, and the nearest one well away from it ────────
    let n0 = -1, d0 = Infinity, n1 = -1, d1 = Infinity;
    for (let i = 0; i < this.rvN; i++) {
      const dx = this.rvX[i] - L.x, dz = this.rvZ[i] - L.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < d0) { d0 = d2; n0 = i; }
    }
    if (n0 >= 0) {
      const ax = this.rvX[n0], az = this.rvZ[n0];
      for (let i = 0; i < this.rvN; i++) {
        const ddx = this.rvX[i] - ax, ddz = this.rvZ[i] - az;
        if (ddx * ddx + ddz * ddz < 2500) continue;       // same stretch
        const dx = this.rvX[i] - L.x, dz = this.rvZ[i] - L.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < d1) { d1 = d2; n1 = i; }
      }
    }
    const pick = [n0, n1];
    for (let i = 0; i < this.rivers.length; i++) {
      const v = this.rivers[i];
      if (v.target !== pick[i]) {
        if (pick[i] >= 0) v.retarget(pick[i]); else v.silence();
      }
    }
  }

  _drive(dt, L) {
    const actx = this.actx;
    let fallSum = 0, riverSum = 0, active = 0;

    for (const v of this.falls) {
      const i = v.target;
      if (i < 0) continue;
      const dx = this.wfX[i] - L.x, dy = (this.wfY[i] - L.y) * 0.6, dz = this.wfZ[i] - L.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const ref = this.wfRef[i];
      const size = this.wfSize[i];
      const g = 0.62 * size * Math.pow(ref / (ref + d), 1.6);

      v.level = g;
      fallSum += g;
      if (g > 0.004) active++;
      v.sm.out.set(g, actx);
      // Air absorption. Also the cue that tells you a fall is *far*, not quiet.
      v.sm.air.set(clamp(17000 * Math.exp(-d / 210), 620, 16000), actx);
      // Close in, the low end takes over — standing under a fall is chest, not
      // hiss. Far out, the low end is all that survives anyway.
      v.sm.low.set(lerp(0.45, 1.25, clamp01(1 - d / (ref * 1.2))) * (0.35 + size), actx);
      v.sm.hiss.set(lerp(0.06, 0.75, clamp01(1 - d / 90)), actx);

      // Panning: a source you are standing in should surround you, so the pan
      // collapses to centre inside ~20 m.
      const rel = Math.atan2(dx, dz) - L.yaw;
      v.sm.pan.set(clamp(Math.sin(rel) * clamp01((d - 8) / 26), -0.92, 0.92), actx);
    }

    for (const v of this.rivers) {
      const i = v.target;
      if (i < 0) continue;
      const dx = this.rvX[i] - L.x, dz = this.rvZ[i] - L.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const flow = this.rvF[i];
      const ref = 16 + flow * 34;
      const g = 0.30 * (0.25 + flow) * Math.pow(ref / (ref + d), 1.9);
      v.level = g;
      riverSum += g;
      if (g > 0.004) active++;
      v.sm.out.set(g, actx);
      v.sm.air.set(clamp(16000 * Math.exp(-d / 70), 900, 15000), actx);
      v.sm.hiss.set(lerp(0.08, 0.9, clamp01(1 - d / 30)) * (0.3 + flow), actx);
      const rel = Math.atan2(dx, dz) - L.yaw;
      v.sm.pan.set(clamp(Math.sin(rel) * clamp01((d - 4) / 14), -0.9, 0.9), actx);
    }

    this.state.fallGain = fallSum;
    this.state.riverGain = riverSum;
    this.state.voices = active;
    void dt;
  }
}
