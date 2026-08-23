// ─────────────────────────────────────────────────────────────────────────────
//  boat_physics — an analytic paddle-craft model. No Rapier body, on purpose:
//  rigid-body physics only exists in a 176 m heightfield patch streamed around
//  the CAMPER (VehiclePhysics PATCH_SIZE), and water has no colliders at all —
//  a Rapier boat would fall through the world the moment it left the patch.
//
//  Everything here is integrated directly:
//    · y is the drawn water level (levelAt, getWaterHeight fallback) plus a
//      few centimetres of bob;
//    · heading/speed come from paddle strokes — each forward stroke is a
//      ~1.5 s impulse cycle with a surge-glide velocity profile, alternating
//      sides, with a small yaw wobble per stroke. The rhythm is the feel;
//      constant thrust reads as an electric trolley motor.
//    · drag is quadratic (plus a small linear term so the glide dies out
//      rather than asymptoting);
//    · the shore is a wall: the hydro sdf supplies a signed distance and a
//      gradient, motion into the shore is projected onto the shoreline
//      tangent, and shallow water beaches the boat softly.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, damp } from '../core/MathUtils.js';
import { sdfGrad } from './boat_site.js';

// Stroke cycle. The surge occupies the front ~35% of the cycle; the rest is
// glide. Cadence quickens a little with effort.
const STROKE_PERIOD = 1.5;         // s per forward stroke at full effort
const BACK_PERIOD = 1.15;          // back-paddling is choppier
const SURGE = 0.35;                // fraction of the cycle that is the pull

// Where the hull stops being able to move.
const SHORE_SDF = 1.2;             // m inside the waterline: hard stop
const SHORE_PUSH = 3.5;            // m: gentle steer-away pressure begins
const BEACH_MARGIN = 0.15;         // m of water over the draft that still floats

export class BoatPhysics {
  /**
   * @param world  WorldData
   * @param dim    { length, beam, draft } from the model's userData
   * @param opts   { maxSpeed } — 3.2 canoe, 3.8 kayak
   */
  constructor(world, dim, opts = {}) {
    this.world = world;
    this.dim = dim;
    this.maxSpeed = opts.maxSpeed ?? 3.2;
    this.draft = dim.draft ?? 0.15;

    this.x = 0; this.z = 0; this.y = 0;
    this.heading = 0;
    this.speed = 0;              // m/s along heading, signed
    this.yawRate = 0;
    this.roll = 0;               // + banks starboard
    this.pitch = 0;              // + bow up
    this.beached = false;
    this.depth = 99;

    // Stroke state.
    this._phase = 1;             // 1 = between strokes; wraps 0..1 during one
    this._side = 1;              // which side the NEXT forward stroke pulls on
    this._stroking = false;
    // Visual-only phase, but still deterministic: the caller hands in a draw
    // from the site rng, so the same launch spot bobs the same way.
    this._bobSeed = opts.bobSeed ?? 0;

    // Quadratic drag sized so full-effort cruise sits just under maxSpeed.
    // The surge envelope's mean over a full cycle is SURGE * 2/pi (a half-sine
    // pull over the surge window, silence for the glide), so:
    //   thrust * MEAN_ENV = k2 * vmax^2  =>  choose thrust, derive k2;
    // the small linear term then keeps equilibrium a shade under vmax.
    const MEAN_ENV = SURGE * (2 / Math.PI);                // ≈ 0.223
    this._thrust = 6.0;                                    // m/s^2 peak surge
    this._k2 = (this._thrust * MEAN_ENV) / (this.maxSpeed * this.maxSpeed);
    this._k1 = 0.10;                                       // slow-glide decay

    this.onStroke = null;        // fn(side, strength) — audio / wake hooks
    this.onBeach = null;         // fn() — fired once per beaching
  }

  place(x, z, heading) {
    this.x = x; this.z = z; this.heading = heading;
    this.speed = 0; this.yawRate = 0; this.roll = 0; this.pitch = 0;
    this.beached = false;
    this._surface(0, 0);
  }

  /**
   * @param dt   seconds
   * @param t    elapsed time (for the bob)
   * @param inp  { fwd 0..1, back 0..1, turn -1..1 }  (turn +1 = port/left,
   *             matching the camper's steer axis)
   */
  step(dt, t, inp) {
    dt = Math.min(dt, 1 / 20);
    const fwd = clamp01(inp.fwd ?? 0);
    const back = clamp01(inp.back ?? 0);
    const turn = clamp(inp.turn ?? 0, -1, 1);

    // ── strokes ────────────────────────────────────────────────────────────
    let accel = 0;
    let wobble = 0;
    if (fwd > 0.02 && !this.beached) {
      if (!this._stroking || this._phase >= 1) {
        // Catch: a new stroke begins, on the other side.
        this._phase = 0;
        this._side = -this._side;
        this._stroking = true;
        this.onStroke?.(this._side, fwd);
      }
      this._phase += dt / (STROKE_PERIOD / (0.75 + 0.25 * fwd));
      const p = clamp01(this._phase);
      // Surge-glide envelope: a half-sine pull, then nothing. The glide is
      // what makes the next surge read as a stroke.
      const env = p < SURGE ? Math.sin((p / SURGE) * Math.PI) : 0;
      accel += this._thrust * env * fwd;
      // Each stroke yaws the bow slightly AWAY from the paddling side, the
      // way a real J-less stroke does; alternating sides cancels it over two.
      wobble += this._side * env * 0.10 * fwd;
    } else if (back > 0.02 && !this.beached) {
      if (!this._stroking || this._phase >= 1) {
        this._phase = 0;
        this._side = -this._side;
        this._stroking = true;
        this.onStroke?.(this._side, back * 0.7);
      }
      this._phase += dt / BACK_PERIOD;
      const p = clamp01(this._phase);
      const env = p < SURGE ? Math.sin((p / SURGE) * Math.PI) : 0;
      // Back-paddling brakes first, then reverses, slowly.
      accel -= this._thrust * 0.55 * env * back;
    } else {
      this._stroking = false;
      this._phase = 1;
    }

    // ── drag + integrate speed ─────────────────────────────────────────────
    const v = this.speed;
    accel -= this._k2 * v * Math.abs(v) + this._k1 * v;
    this.speed = clamp(v + accel * dt, -this.maxSpeed * 0.4, this.maxSpeed);

    // ── yaw: sweep strokes + per-stroke wobble ─────────────────────────────
    // Sweep authority is decent at rest (you can spin a canoe in place) and
    // eases down as hull speed makes the boat track.
    const sweep = turn * (1.05 - 0.35 * clamp01(Math.abs(this.speed) / this.maxSpeed));
    // A sweep stroke turns the bow the same way whichever direction the hull
    // is drifting — this is a paddle, not a rudder, so no reverse-steer flip.
    this.yawRate = damp(this.yawRate, sweep + wobble, 3.2, dt);
    this.heading += this.yawRate * dt;

    // ── shore pressure + move ──────────────────────────────────────────────
    const g = sdfGrad(this.world, this.x, this.z);
    let mx = Math.sin(this.heading) * this.speed * dt;
    let mz = Math.cos(this.heading) * this.speed * dt;
    if (g.sdf < SHORE_PUSH) {
      // Gentle push into open water — enough to slide along a bank you graze,
      // not enough to fight a deliberate landing.
      const k = (SHORE_PUSH - g.sdf) / SHORE_PUSH * 0.5 * dt;
      mx += g.gx * k;
      mz += g.gz * k;
    }
    let nx = this.x + mx, nz = this.z + mz;
    const ng = sdfGrad(this.world, nx, nz);
    const nlv = this._levelAt(nx, nz);
    let pressed = false;                          // shoreward motion removed?
    if (nlv === null || ng.sdf < SHORE_SDF) {
      // The next point is off the water (or hugging the waterline): keep only
      // the motion ALONG the shore. ĝ points into the water, so the component
      // to remove is the one heading OUT of it (negative along ĝ).
      const into = mx * g.gx + mz * g.gz;
      if (into < 0) { mx -= into * g.gx; mz -= into * g.gz; pressed = true; }
      nx = this.x + mx; nz = this.z + mz;
      const g2 = sdfGrad(this.world, nx, nz);
      if (this._levelAt(nx, nz) === null || g2.sdf < SHORE_SDF) {
        nx = this.x; nz = this.z;                 // wedged: stay put
        this.speed *= Math.pow(0.05, dt);
      } else {
        this.speed *= Math.pow(0.4, dt);          // scrubbing along the bank
      }
    }
    this.x = nx; this.z = nz;

    // ── beaching ───────────────────────────────────────────────────────────
    // Two ways ashore, because banks come in two shapes. A shelving beach
    // beaches by DEPTH: sand under the hull long before the sdf wall. A steep
    // bank never gets shallow — the water is a metre deep at the wall — so
    // paddling the bow against it for a moment beaches by PRESSURE instead,
    // which is also just what nosing a canoe onto a bank feels like.
    this._surface(dt, t);
    const shallow = this.depth < this.draft + BEACH_MARGIN;
    if (shallow) {
      this.speed *= Math.pow(0.03, dt);           // sand under the hull
      if (Math.abs(this.speed) < 0.25 && !this.beached) this._beach();
    }
    if (pressed && fwd > 0.02) {
      this._pinT = (this._pinT ?? 0) + dt;
      if (this._pinT > 0.6 && !this.beached) this._beach();
    } else {
      // Decays SLOWER than it grows: near the wall the hull alternates between
      // pressed and free frames (the steer-away push buys it a few centimetres
      // back), and a symmetric decay left it sawing forever a boat-length off
      // the bank the player was clearly trying to land on.
      this._pinT = Math.max(0, (this._pinT ?? 0) - dt * 0.5);
    }
    // Beached is sticky: only the back-paddle escape below (or something
    // external moving the hull) clears it. An automatic "deep water again"
    // clear would flip-flop forever on a wall-beached boat floating in a
    // metre of water.
    if (this.beached && Math.abs(this.speed) > 0.3) this.beached = false;
    // Paddling backward off a beach is allowed: strokes above are gated on
    // !beached, so give a beached boat one escape — back-paddle.
    if (this.beached && back > 0.02) {
      this.beached = false;
      this._pinT = 0;
      this.speed = -0.45 * back;
    }

    // ── attitude ───────────────────────────────────────────────────────────
    const sp = clamp01(Math.abs(this.speed) / this.maxSpeed);
    // Bow rises slightly at speed; a low-frequency virtual swell breathes
    // under everything.
    const swellP = Math.sin(t * 0.55 + this._bobSeed) * 0.010;
    const swellR = Math.sin(t * 0.42 + this._bobSeed * 1.7) * 0.012;
    this.pitch = damp(this.pitch, sp * 0.045 * Math.sign(this.speed || 1) + swellP, 3, dt);
    // Bank INTO the turn, 3-5 degrees at full sweep. yawRate + (port turn)
    // banks to port: roll sign chosen so the hull leans toward the inside.
    this.roll = damp(this.roll, clamp(-this.yawRate * 0.09 * (0.4 + 0.6 * sp), -0.09, 0.09) + swellR, 3, dt);
  }

  _beach() {
    this.beached = true;
    this.speed = 0;
    this._pinT = 0;
    this.onBeach?.();
  }

  _levelAt(x, z) {
    const f = this.world._water;
    const lv = f?.levelAt ? f.levelAt(x, z) : null;
    if (lv !== null && lv !== undefined) return lv;
    return this.world.getWaterHeight(x, z);
  }

  _surface(dt, t) {
    const lv = this._levelAt(this.x, this.z);
    if (lv !== null && lv !== undefined) this._waterY = lv;
    // Two low-frequency sines, a couple of centimetres — under the harness's
    // own ±3 cm float assertion, deliberately.
    const bob = Math.sin(t * 0.9 + this._bobSeed) * 0.012
              + Math.sin(t * 1.7 + this._bobSeed * 2.3) * 0.008;
    this.depth = (this._waterY ?? 0) - this.world.getHeight(this.x, this.z);
    this.y = (this._waterY ?? 0) + bob;
  }

  state() {
    return {
      x: this.x, y: this.y, z: this.z,
      heading: this.heading, speed: this.speed, yawRate: this.yawRate,
      roll: this.roll, pitch: this.pitch,
      depth: this.depth, beached: this.beached,
    };
  }
}
