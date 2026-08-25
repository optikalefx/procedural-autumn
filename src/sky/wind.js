// ─────────────────────────────────────────────────────────────────────────────
//  Wind — one coherent field the whole valley agrees on.
//
//  Every system that moves (trees, grass, leaves, motes, mist) needs to agree
//  about which way the air is going, or the frame reads as several unrelated
//  animations layered on top of each other. That agreement is what turns
//  "things are wiggling" into "it is windy".
//
//  The field is analytic and stateless in space: no grid, no allocation, and
//  any system can ask for the velocity at an arbitrary point without knowing
//  anything about the others. It has three parts:
//
//    · a prevailing direction that wanders slowly (minutes, not seconds)
//    · a squall envelope — whether it is blowing *at all* right now. Skewed
//      low, so the valley is calm most of the time and blustery in bursts;
//      without it the wind sits at one middling strength forever, which reads
//      as a setting rather than as weather
//    · gust cells that *advect* with that direction, so a gust visibly travels
//      across the meadow rather than the whole valley pulsing in unison
//    · a mild vertical term — thermals and lee-side lift — which is what makes
//      a falling leaf occasionally rise again instead of sinking like sand
//
//  Gust cells use plain sums of sines rather than a noise texture on purpose:
//  this is called a few thousand times a frame from the leaf integrator, and
//  eight sines is measurably cheaper than a bilinear fetch plus the branchy
//  wrap logic. Coherence, not spectral purity, is what the look needs.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mulberry32 } from '../core/MathUtils.js';

const TAU = Math.PI * 2;

export class WindField {
  constructor(seed = 0x5eed) {
    const rand = mulberry32(seed);

    // Prevailing direction, in radians. Randomised per seed so two worlds do
    // not have identical weather, but it changes only over minutes.
    this.baseAngle = rand() * TAU;
    this.dir = new THREE.Vector3(Math.cos(this.baseAngle), 0, Math.sin(this.baseAngle));

    // Base speed at ~10 m above ground, m/s. A cozy autumn afternoon: enough
    // to carry a leaf sideways faster than it falls, not enough to read as a
    // storm.
    this.baseSpeed = 3.4;

    // Gust envelope, 0..~1.6. Published so other systems can drive a sway
    // amplitude off the same number the leaves are riding.
    this.gust = 1.0;
    // Squall envelope, 0..1 — how windy this stretch of the afternoon is, on
    // the timescale of minutes. Deliberately biased low: see `update`.
    this.squall = 0.25;
    this.speed = this.baseSpeed;
    this.t = 0;

    // Phase offsets keep the sine lattices from lining up into a visible grid.
    this._p = new Float32Array(8);
    for (let i = 0; i < 8; i++) this._p[i] = rand() * TAU;

    this._scratch = new THREE.Vector3();
  }

  /** Advance the slow terms. Cheap; call once per frame. */
  update(dt, elapsed) {
    this.t = elapsed;
    // The prevailing direction wanders on two detuned periods (~55 s and
    // ~170 s) so it never settles into a loop the eye can learn.
    const a = this.baseAngle
            + 0.30 * Math.sin(elapsed * 0.0115 + this._p[0])
            + 0.16 * Math.sin(elapsed * 0.0372 + this._p[1]);
    this.dir.set(Math.cos(a), 0, Math.sin(a));
    this.angle = a;

    // Squall envelope: whether the afternoon is *currently* blowing at all,
    // on periods of ~4 min and ~1.7 min. Two detuned sines give a 0..1 ramp,
    // and the exponent is the whole point — raised to 2.4 the field spends
    // most of its time near the bottom of the range and only occasionally
    // climbs to the top. A valley is calm most of the time and gusty in
    // bursts; a constant mid-strength wind reads as an animation setting, not
    // as weather, and it is what made the drift look permanently blown.
    //
    // The two periods are chosen for the cadence they produce, not for the
    // numbers themselves: about sixteen blustery spells an hour, each running
    // a little over half a minute — long enough for the drift to actually fill
    // the air (a leaf lives ~30 s) and rare enough that the quiet between them
    // is the normal state.
    const raw = 0.5 + 0.5 * (0.64 * Math.sin(elapsed * 0.0262 + this._p[6])
                           + 0.36 * Math.sin(elapsed * 0.0630 + this._p[7]));
    this.squall = Math.pow(Math.min(Math.max(raw, 0), 1), 2.4);

    // Whole-valley gust envelope — the term Trees reads as `windScale`. The
    // fast detail (~76 s and ~30 s) rides *on* the squall rather than adding
    // to a fixed base, so a lull is genuinely quiet and a squall still crests
    // at the strength this used to hold all day.
    const detail = 0.86 + 0.20 * Math.sin(elapsed * 0.083 + this._p[2])
                        + 0.10 * Math.sin(elapsed * 0.211 + this._p[3]);
    this.gust = (0.50 + 0.70 * this.squall) * detail;
    this.speed = this.baseSpeed * this.gust;
    void dt;
  }

  /**
   * Local gust multiplier at a world point — roughly 0.2 … 1.5, scaled by the
   * squall envelope, so in a lull the whole lattice sits near the bottom.
   *
   * The lattice is advected by `-dir * t` so cells sweep downwind. That is the
   * whole trick: a *stationary* gust field makes the meadow breathe in place,
   * which reads as a shader effect; a moving one reads as weather.
   */
  gustAt(x, z) {
    const t = this.t;
    const dx = this.dir.x, dz = this.dir.z;
    // Advect at ~1.6x the air speed: gust fronts outrun the air they carry.
    const ax = x - dx * t * 5.6, az = z - dz * t * 5.6;
    // Two scales: ~130 m cells inside ~420 m cells.
    const a = Math.sin(ax * 0.0076 + az * 0.0031 + this._p[4]);
    const b = Math.sin(az * 0.0241 - ax * 0.0139 + this._p[5]);
    const c = Math.sin((ax + az) * 0.0053 + this._p[0] * 1.7);
    return this.gust * (0.62 + 0.26 * a + 0.16 * b + 0.14 * c);
  }

  /**
   * Wind velocity in m/s at a world position.
   *
   * `out` is optional; without it you get an internal scratch vector that is
   * valid only until the next call — fine for a tight integrator loop, wrong
   * to hold on to.
   */
  windAt(pos, t = this.t, out = this._scratch) {
    const x = pos.x, y = pos.y, z = pos.z;
    const g = this.gustAt(x, z);

    // Direction shear: gusts do not blow exactly along the prevailing wind,
    // they fan. Without this every leaf in frame travels on a parallel line.
    const swirl = 0.42 * Math.sin(x * 0.0138 - z * 0.0091 - t * 0.19 + this._p[1]);
    const a = this.angle + swirl;

    // Speed grows with height: near the ground the canopy and the grass eat
    // the wind, so leaves that have fallen out of the crown slow down. This is
    // absolute altitude rather than height-above-ground on purpose — it costs
    // no terrain lookup, and over the ±40 m a particle ever occupies the
    // difference between the two is not visible.
    const h = 0.72 + 0.0016 * Math.min(Math.max(y, 0), 400);
    const s = this.baseSpeed * g * h;

    // Vertical: thermals over sunlit ground plus lee-side lift, both advected
    // with the gust cells so an updraft belongs to a gust rather than hanging
    // in one spot.
    const wy = 0.62 * Math.sin(x * 0.0182 + z * 0.0121 - t * 0.28 + this._p[3])
             * (0.35 + 0.65 * g);

    out.set(Math.cos(a) * s, wy, Math.sin(a) * s);
    return out;
  }
}
