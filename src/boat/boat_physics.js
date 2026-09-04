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
//      constant thrust reads as an electric trolley motor. Holding W rides
//      that auto-repeating catch as a floor; releasing and re-pressing to a
//      ~1 s beat stacks a speed bonus on top of it — see RHYTHM below.
//    · drag is quadratic (plus a small linear term so the glide dies out
//      rather than asymptoting);
//    · the shore is a wall: the hydro sdf supplies a signed distance and a
//      gradient, motion into the shore is projected onto the shoreline
//      tangent, and shallow water beaches the boat softly.
//
//  ── rivers ──────────────────────────────────────────────────────────────────
//
//  Flowing water is the same model with three of its constants made a function
//  of `riverness` rather than fixed, plus the current itself. It is a blend and
//  not a branch on purpose: a river mouth is where every seam in this project's
//  history has been, and a boat that switched regimes at a mask boundary would
//  put one more there.
//
//  The reason a river needed anything at all is measured, not aesthetic. See
//  the note on SHORE_SDF below: the fixed 1.2 m sdf wall sits about a dozen
//  metres INSIDE the water a player can see on a river, so a kayak paddled
//  down a real reach parks against an invisible wall in open water and grinds.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, damp, lerp, smoothstep } from '../core/MathUtils.js';
import { RhythmMeter } from '../core/rhythm.js';
import { sdfGrad } from './boat_site.js';

// Stroke cycle. The surge occupies the front ~35% of the cycle; the rest is
// glide. Cadence quickens a little with effort.
const STROKE_PERIOD = 1.5;         // s per forward stroke at full effort
const BACK_PERIOD = 1.15;          // back-paddling is choppier
const SURGE = 0.35;                // fraction of the cycle that is the pull

// ── rhythm bonus ─────────────────────────────────────────────────────────────
//
// The auto-repeating catch above (a new stroke the instant `_phase` hits 1)
// is what makes simply holding W work at all — it is the floor, not the game.
// On top of it, a player who lets go and re-presses W to their own ~1 s beat
// can paddle faster than that floor: each RELEASE-then-PRESS edge is timed
// against the last one, and a beat inside `tol` of `target` builds a
// meter that (a) kicks the hull's speed directly, on the spot, and (b) raises
// how high that speed is allowed to sit. Too fast a double-tap or too slow a
// gap both read as off-beat and knock the meter back down rather than
// building it — a badly-timed tap is worse than not tapping.
//
// The kick is applied to `speed` directly, AFTER the stroke envelope below —
// not folded into `_thrust` — on purpose: a real keyboard tap is down for a
// handful of frames, far shorter than the ~0.5 s surge that envelope is built
// to reward, so a thrust multiplier would mostly starve on a tap that releases
// before the surge finishes. A direct kick pays off the instant the beat lands
// regardless of how briefly the key was down.
//
// Holding W through the whole paddle only ever produces ONE press edge (the
// initial one), so it is untouched: this is a bonus stacked on the existing
// feel, not a replacement for it.
// The judging itself — edges, timing, the meter's build and decay — lives in
// `src/core/rhythm.js`, because the BIKE plays the same game at its own tempo.
// What stays here is what a landed beat is worth, which only means anything
// against this hull's drag model and top speed.
//
// The HUD reads `beat()` off the meter rather than importing these, so a dial
// flashing for a kayak and a dial flashing for a bike are the same code reading
// two different tempos instead of two copies that can drift.
const RHYTHM = {
  target: 1.0,                     // s between taps for an on-beat stroke
  tol: 0.22,                       // s either side of target that still counts
  gain: 0.35,                      // meter gained per on-beat tap, 0..1
  punish: 0.5,                     // fraction of the meter lost on an off-beat tap
  decay: 0.15,                     // 1/s ambient fade — a banked bonus doesn't
                                   // outlive the rhythm that earned it. Net of
                                   // gain and a beat's worth of decay is still
                                   // positive, so ~5 on-beat taps in a row ramp
                                   // the meter from empty to full.
};
const RHYTHM_KICK = 3.2;           // m/s added on a good tap, scaled by the
                                    // meter AFTER that tap's gain — so the
                                    // kicks grow as the streak builds
const RHYTHM_BONUS = 1.3;          // speed ceiling raised at a full meter (130%)
// Quadratic drag alone would eat most of a kick between one beat and the
// next — the hull is back down near its old cruise before the following tap
// even lands, which is why a first pass at this (kick + ceiling only, no
// drag change) topped out barely above holding: the numbers LOOKED like a
// turbo but the sawtooth between kicks never let the hull live there. This
// cuts the quadratic term itself while charged, so a hot streak also GLIDES
// better, not just gets shoved harder — the boost is a state the hull is in,
// not a series of unrelated pushes.
const RHYTHM_SLIP = 0.65;          // fraction of quadratic drag cancelled at a full meter

// Where the hull stops being able to move.
//
// ── SHORE_SDF IS A WALL IN OPEN WATER ON A RIVER ─────────────────────────────
//
// On standing water 1.2 m inside the waterline is the right stop and stays it.
// On flowing water it is not a shoreline at all. The hydro sdf is a distance
// transform of a mask smoothed at 6-10 m, and against the water that is
// actually DRAWN it reads far too tight in a channel — measured on seed
// 20261018, across 297 river cross-sections taken perpendicular to the flow:
//
//   channel width by hydro sdf > 0 .......... p05  9.5   p50 18.5   p95 59.5 m
//   channel width by the DRAWN water mesh ... p05 24.0   p50 55.5   p95 90.0 m
//   drawn wider than sdf-wet by ............. p05  6.0   p50 24.0   p95 51.0 m
//
// So the sdf 1.2 contour lies roughly a dozen metres inside the waterline the
// player is looking at, on each bank. Paddling the shipping model down eight
// real reaches at full effort with a helmsman steering to the current, the
// kayak spent the whole run pinned at sdf 1.20 — p50 AND p05, i.e. never off
// the wall — in 1.24 m of water, with SHORE_PUSH active on 82-100% of frames
// and the bank scrub eating 60% of its speed per second. Median distance made
// good in 120 s: 83 m, against a 3.8 m/s hull. That is the "it won't let me go
// here" report, and it is not a tuning problem — 1.2 m is simply the wrong
// question to ask about a river.
//
// The honest question on flowing water is whether there is water under the
// hull, so `riverness` fades the sdf wall out and a float test in. The float
// floor is deliberately WELL BELOW the beaching depth: a kayak may still nose
// into the shallows and ground itself there, because landing on a riverbank
// has to keep working.
const SHORE_SDF = 1.2;             // m inside the waterline: hard stop (lakes)
const SHORE_PUSH = 3.5;            // m: gentle steer-away pressure begins
const RIVER_PUSH = 1.6;            // m: the same, in a channel — see RIVER_IN
export const BEACH_MARGIN = 0.15;  // m of water over the draft that still floats
const FLOAT_FLOOR = 0.5;           // fraction of draft: water too thin to enter

// ── riverness ────────────────────────────────────────────────────────────────
//
// How much this water counts as a channel, ramped off `getRiver`. The ramp has
// to be fully on across the WHOLE channel — including hard against both banks,
// which is exactly where the boat is when the shore rules matter — so it is
// calibrated on the mask where the sdf wall actually bites. Measured on seed
// 20261018 at hydro sdf 0.9-1.6 m (n = 48): river mask p05 0.37, p50 0.48; and
// mid-channel at sdf > 4 (n = 83) it reads p50 0.84. A ramp saturating at 0.25
// therefore reads 1.0 everywhere inside a river, and a boat that drifts within
// a hull-length of the bank does not flip back to lake rules mid-stroke.
const RIVER_IN = 0.06, RIVER_FULL = 0.25;
// Damped rather than sampled raw, so a hull crossing a low-mask slack pocket
// (an inside bend, a backwater behind a bar) keeps river rules for a beat
// instead of snapping to a 1.2 m wall for a few frames.
const RIVER_LAG = 2.0;             // 1/s
// Smoothing on the ground track (see `made`). 4/s settles a flickering
// pressed/free alternation in about a quarter second.
const MADE_LAG = 4.0;              // 1/s

// Current. `flowVX/VZ` already carry coherence and `q` is discharge, so the
// drift fades out on its own as a channel opens into a lake — no branch, and
// the few metres of current the flow field's blur carries into standing water
// at an inflow survive, which is the behaviour that field was built for.
//
// Sized against the hull, not against realism: the kayak tops out at 3.8 m/s,
// and on seed 20261018 the spine reads discharge p50 0.33 / p95 0.85 with
// coherence p50 0.57 / p95 0.85. The floor term keeps a lazy reach from
// reading as a lake. Together that lands a typical current near 0.5 m/s and a
// big fast reach near 1.2 m/s, which leaves 2.6-3.3 m/s of headway against the
// stream — deliberately: going up river already worked and must keep working.
const CURRENT_MAX = 1.6;           // m/s at full discharge and full coherence
const CURRENT_FLOOR = 0.35;        // share of it a zero-discharge channel keeps

// The current straightens a free hull. Weathercocking is real, and it is also
// the thing that decides whether a 4.2 m boat photographs well in a channel:
// lying across the stream it reads as debris. Applied to the flow AXIS, not
// the flow vector, so paddling upstream is not fought 180 degrees; and scaled
// by (1 - |turn|) so a deliberate sweep always wins.
const WEATHERCOCK = 1.1;           // 1/s of yaw authority at full coherence

// Below this the stream is slack enough that touching bottom is a landing
// rather than a drag — see the grounding note in step().
const GROUND_CURRENT = 0.25;       // m/s
// Steepest surface the hull will follow, radians. See the trim block: the
// measured p95 slope along the flow is 11 degrees, so this only ever bites on
// a cascade, where following the water literally would stand the boat on end.
const TRIM_MAX = 0.42;

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
    // ── SPEED IS NOT THE SAME QUESTION AS "IS THIS BOAT GOING ANYWHERE" ──────
    // `speed` is what the paddle is doing to the hull; `made` is what the hull
    // is doing to the world — the smoothed length of its actual per-step ground
    // track. They diverge exactly where the shore rules bite: a kayak held bow-
    // on against a riverbank was measured (seed 20261018, 1200 sim frames)
    // frozen at one position to the tenth of a metre with `speed` still reading
    // 0.44-1.11 m/s, because the wall projects the motion away every step while
    // the stroke keeps refilling it. Anything that wants to ask "is the player
    // parked against something" has to read this and not `speed`.
    this.made = 0;               // m/s actually made good over the ground
    // River state, published for the audio/HUD layers and the harness.
    this.riverness = 0;          // 0 lake .. 1 channel
    this.current = 0;            // m/s of drift the water is adding
    this.turbulence = 0;         // 0..1 whitewater, straight off the flow field
    this._flow = { vx: 0, vz: 0, q: 0, turb: 0 };

    // Stroke state.
    this._phase = 1;             // 1 = between strokes; wraps 0..1 during one
    this._side = 1;              // which side the NEXT forward stroke pulls on
    this._stroking = false;
    // Rhythm-bonus state — see RHYTHM above and src/core/rhythm.js.
    this._beat = new RhythmMeter(RHYTHM);
    this.rhythm = 0;             // 0..1 meter, published for HUD/audio
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
    this.made = 0;
    this.riverness = clamp01(smoothstep(RIVER_IN, RIVER_FULL,
                                        this.world.getRiver?.(x, z) ?? 0));
    this.current = 0;
    this._beat.reset();
    this.rhythm = 0;
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

    // ── the water this hull is sitting in ──────────────────────────────────
    // Sampled once per step and reused by the yaw, the move and the attitude,
    // so all three agree about which way the river is going.
    const flow = this.world.getFlow
      ? this.world.getFlow(this.x, this.z, this._flow)
      : (this._flow.vx = this._flow.vz = this._flow.q = this._flow.turb = 0, this._flow);
    const rivTarget = clamp01(smoothstep(RIVER_IN, RIVER_FULL,
                                         this.world.getRiver?.(this.x, this.z) ?? 0));
    this.riverness = damp(this.riverness, rivTarget, RIVER_LAG, dt);
    const riv = this.riverness;
    this.turbulence = flow.turb;
    // Coherence is the flow vector's own length — see WorldData.getFlow.
    const coh = Math.hypot(flow.vx, flow.vz);

    // ── rhythm bonus: judge press edges, not the held level ──────────────────
    // A rising edge (fwd was slack, now isn't) is the player CHOOSING to pull
    // again, which is a different question from the auto-repeating catch below
    // firing on its own timer while the key stays down. Only edges are judged,
    // so holding W produces exactly one (the first) and is never punished or
    // rewarded by this — see src/core/rhythm.js. Gated on `!beached` the same
    // way the strokes below are: there is no paddling to time from a beach.
    const fwdActive = fwd > 0.02 && !this.beached;
    if (this._beat.update(dt, fwdActive)) {
      // The kick itself, scaled by the meter it just topped up — later taps in
      // a streak land bigger kicks than the one that started it.
      this.speed += RHYTHM_KICK * this._beat.hitValue;
    }
    this.rhythm = this._beat.value;
    // How far a full meter is allowed to push `speed` past the hull's usual
    // ceiling — without this the drag+integrate clamp below would clip every
    // kick straight back down to maxSpeed the instant it landed.
    const rhythmSpeedMul = 1 + RHYTHM_BONUS * this.rhythm;

    // ── strokes ────────────────────────────────────────────────────────────
    // Untouched by the rhythm bonus — it earns its speed by injecting a
    // direct kick after the drag+integrate step below, not by reshaping this
    // curve, so holding W keeps exactly the feel it always had. See RHYTHM_*
    // above for why the kick has to live outside this envelope: a real
    // keyboard tap is a handful of frames, far shorter than the surge this
    // loop is built to reward, so scaling accel here would starve tapping of
    // the very thing it is supposed to pay off.
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
    accel -= this._k2 * (1 - RHYTHM_SLIP * this.rhythm) * v * Math.abs(v) + this._k1 * v;
    this.speed = clamp(v + accel * dt, -this.maxSpeed * 0.4, this.maxSpeed * rhythmSpeedMul);

    // ── yaw: sweep strokes + per-stroke wobble ─────────────────────────────
    // Sweep authority is decent at rest (you can spin a canoe in place) and
    // eases down as hull speed makes the boat track.
    const sweep = turn * (1.05 - 0.35 * clamp01(Math.abs(this.speed) / this.maxSpeed));
    // A sweep stroke turns the bow the same way whichever direction the hull
    // is drifting — this is a paddle, not a rudder, so no reverse-steer flip.
    //
    // Plus the weathercock: the stream lines a free hull up with itself. Taken
    // on the flow AXIS — the nearer of the two directions along the channel —
    // because a boat pointed upstream is aligned with the current, not fighting
    // it, and steering the bow through 180 degrees would make paddling up river
    // impossible. Faded out by the player's own steer input so a sweep is never
    // argued with, and by coherence so it is gone on a lake.
    let cock = 0;
    if (coh > 0.05 && riv > 0.01) {
      let d = Math.atan2(flow.vx, flow.vz) - this.heading;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      if (d > Math.PI / 2) d -= Math.PI;          // point down the axis, either way
      else if (d < -Math.PI / 2) d += Math.PI;
      cock = clamp(d, -1, 1) * WEATHERCOCK * coh * riv * (1 - Math.abs(turn));
    }
    this.yawRate = damp(this.yawRate, sweep + wobble + cock, 3.2, dt);
    this.heading += this.yawRate * dt;

    // ── shore pressure + move ──────────────────────────────────────────────
    //
    // Two of these constants are interpolated by riverness rather than fixed;
    // both headline notes are on the constants themselves.
    //
    //   the wall  — sdf on a lake, "is there water under the hull" in a
    //               channel. The two are separate branches rather than one
    //               blended test, for a measured reason — see `room` below.
    //   the push  — SHORE_PUSH's 3.5 m is wider than the sdf half-width of a
    //               typical channel, so in a river it was on for 82-100% of
    //               frames, pressing the hull against a bank from a gradient
    //               that is degenerate on the channel's medial axis. In river
    //               mode it only reaches for a bank actually being grazed.
    const wallSdf = SHORE_SDF * (1 - riv);
    const floatFloor = this.draft * FLOAT_FLOOR * riv;
    const pushAt = lerp(SHORE_PUSH, RIVER_PUSH, riv);
    // How much margin a point has against the wall, in metres. Negative is
    // outside it.
    //
    // The lake path is EXACTLY the old test — the sdf wall, and "off the drawn
    // mesh" as an absolute veto — and not a degenerate case of the river one.
    // It was written as a degenerate case first, with the float floor simply
    // going to zero on standing water, and that quietly moved every lake boat:
    // `depth > 0` is a stricter gate than `levelAt !== null` on a shelving
    // beach, so hulls that used to glide into the shallows and ground there
    // were walled a few metres out instead. A/B against the base commit over
    // 24 scripted lake paddles caught it at up to 18 m of divergence in 60 s.
    // Lake feel is tuned and is not what this change is for.
    const room = (px, pz, gg) => {
      const bySdf = gg.sdf - wallSdf;
      if (riv < 0.02) {
        const lv = this._levelAt(px, pz);
        return (lv === null || lv === undefined) ? -1e3 : bySdf;
      }
      return Math.min(bySdf, this.depthAt(px, pz) - floatFloor);
    };

    const g = sdfGrad(this.world, this.x, this.z);
    // THE WALL MUST NEVER TRAP. A hull can find itself outside it without ever
    // having crossed it going in: riverness fades the sdf wall from 0 back up
    // to 1.2 m as a boat leaves a channel for a lake, so water that was open a
    // second ago is behind the wall now — and the first cut of this cost a test
    // boat 101 seconds of a 120 second run, wedged at sdf 0.9 with the wall at
    // 1.2 and no legal move in any direction. A falling water level would do
    // the same thing on a lake, which is a bug this file has always had.
    //
    // So the test is RELATIVE: a move is refused only if it is both outside
    // the wall and no better than where the hull already is. Anything that
    // improves the margin is always legal, in every regime, so the way out of
    // a bad spot is never closed.
    const hereRoom = room(this.x, this.z, g);
    const blocked = (px, pz, gg) => {
      const r = room(px, pz, gg);
      return r < 0 && r <= hereRoom;
    };
    let mx = Math.sin(this.heading) * this.speed * dt;
    let mz = Math.cos(this.heading) * this.speed * dt;
    if (g.sdf < pushAt) {
      // Gentle push into open water — enough to slide along a bank you graze,
      // not enough to fight a deliberate landing.
      const k = (pushAt - g.sdf) / pushAt * 0.5 * dt;
      mx += g.gx * k;
      mz += g.gz * k;
    }
    // The current.
    //
    // The DISCHARGE term is deliberately not gated on riverness: the flow
    // field's own blur carries a decaying drift a few metres into the standing
    // water a channel arrives at, and that inflow is what makes a river mouth
    // read as a join rather than an edge. Coherence and discharge fade it out
    // on their own, with no mask boundary to cross.
    //
    // The FLOOR term is gated, because it is the one part that does not fade.
    // It exists so a lazy channel still reads as moving water, and ungated it
    // invented a current on any lake texel holding residual coherence from
    // that same blur. Measured over 400 lake launch sites on seed 20261018,
    // coherence there is p50 0.006 / p90 0.016 — but max 0.615 beside an
    // inflow, which is exactly where a phantom half-metre per second would
    // have turned up and where it would have been hardest to attribute.
    this.current = CURRENT_MAX * (CURRENT_FLOOR * riv + (1 - CURRENT_FLOOR) * flow.q) * coh;
    if (coh > 1e-3) {
      const cs = this.current / coh;              // undo the coherence in vx/vz
      mx += flow.vx * cs * dt;
      mz += flow.vz * cs * dt;
    }
    let nx = this.x + mx, nz = this.z + mz;
    const ng = sdfGrad(this.world, nx, nz);
    let pressed = false;                          // shoreward motion removed?
    let wedged = false;                           // no legal move at all?
    if (blocked(nx, nz, ng)) {
      // The next point is off the water (or hugging the waterline): keep only
      // the motion ALONG the shore. ĝ points into the water, so the component
      // to remove is the one heading OUT of it (negative along ĝ).
      const into = mx * g.gx + mz * g.gz;
      if (into < 0) { mx -= into * g.gx; mz -= into * g.gz; pressed = true; }
      nx = this.x + mx; nz = this.z + mz;
      const g2 = sdfGrad(this.world, nx, nz);
      if (blocked(nx, nz, g2)) {
        nx = this.x; nz = this.z;                 // wedged: stay put
        wedged = true;
        this.speed *= Math.pow(lerp(0.05, 0.35, riv), dt);
      } else {
        // Scrubbing along the bank. Softened in a channel: a hull that glances
        // a bank in a current is turned by it and carries on, where the lake
        // number (60% of speed per second) is a boat being deliberately held
        // against a beach.
        this.speed *= Math.pow(lerp(0.4, 0.78, riv), dt);
      }
    }
    // Ground track, measured AFTER every term that can cancel motion — the
    // wall projection, the wedge, the current — has had its say. Smoothed
    // because near a bank the hull alternates pressed and free frames (see the
    // _pinT decay note below) and the raw per-step distance flickers between
    // zero and a few centimetres; MADE_LAG settles it inside a quarter second,
    // which is far quicker than a player can act on a prompt.
    const madeNow = dt > 1e-4 ? Math.hypot(nx - this.x, nz - this.z) / dt : 0;
    this.made = damp(this.made, madeNow, MADE_LAG, dt);
    this.x = nx; this.z = nz;
    // How long the hull has had nowhere legal to go. The current-drag
    // exemption below is about a boat the stream is still MOVING; a hull that
    // is in a current and going nowhere is aground on something, and has to be
    // allowed to know it — see the deadlock note there.
    this._wedgeT = wedged ? (this._wedgeT ?? 0) + dt : 0;

    // ── beaching ───────────────────────────────────────────────────────────
    // Two ways ashore, because banks come in two shapes. A shelving beach
    // beaches by DEPTH: sand under the hull long before the sdf wall. A steep
    // bank never gets shallow — the water is a metre deep at the wall — so
    // paddling the bow against it for a moment beaches by PRESSURE instead,
    // which is also just what nosing a canoe onto a bank feels like.
    this._surface(dt, t);
    //
    // ── A GRAVEL BAR IN A LIVE CHANNEL IS NOT A BEACH ────────────────────────
    //
    // The lake rule — any water thinner than draft + 15 cm scrubs 97% of the
    // hull's speed per second and then grounds it for good — fires constantly
    // on a river, where riffles and bars are most of the bed. Measured on seed
    // 20261018 over four sustained reaches: EVERY mid-river grounding happened
    // in 6 cm of water with 1.06-1.19 m/s of current still running past, and
    // since forward strokes are gated on `beached` and the only escape is a
    // back-paddle, each one ended the run — 66 and 81 second stalls inside a
    // 120 second paddle. A kayak there bumps, drags, and washes on downstream.
    //
    // So in a channel the scrub is much softer, and grounding needs SLACK
    // water as well as thin water: a hull with the stream still pushing it is
    // being dragged, not landed. Deliberately landing on a bar still works —
    // stop paddling, let the boat lose way, and the current on a bar shallow
    // enough to sit on is below GROUND_CURRENT anyway.
    //
    // `dragged` needs the wedge timer or it DEADLOCKS, and the deadlock is
    // real: a kayak that ran onto the lip of a steep chute — 1.37 m of water
    // to 0.06 m in a second, mid-channel, with 1.06 m/s still running past —
    // could not beach (the current exempted it) and could not move (every
    // neighbouring point was shallower, so the wall refused them all). It sat
    // at one position for 67 seconds of a 120 second run with the paddle still
    // cycling. A hull the stream cannot actually shift is aground, whatever
    // the flow meter says.
    const shallow = this.depth < this.draft + BEACH_MARGIN;
    const dragged = this.current > GROUND_CURRENT && riv > 0.3 && this._wedgeT < 0.5;
    if (shallow) {
      this.speed *= Math.pow(lerp(0.03, 0.55, riv), dt);   // sand under the hull
      if (Math.abs(this.speed) < 0.25 && !dragged && !this.beached) this._beach();
    }
    // And the stream takes a grounded hull back. Anything that grounds in a
    // current has to be able to leave in one, or the river collects boats.
    if (this.beached && dragged) {
      this.beached = false;
      this._pinT = 0;
    }
    // Pressure beaching is a LAKE gesture — you nose a canoe onto a bank and
    // step out. In a channel the same 0.6 s of contact is just the outside of
    // a bend, which every drifting boat touches, so a river-mode hull cannot
    // be beached by pressure at all: it slides off the bank and carries on.
    // Grounding by DEPTH is untouched and still works in a river, which is
    // what a player deliberately landing on a gravel bar gets.
    if (pressed && fwd > 0.02 && riv < 0.5) {
      this._pinT = (this._pinT ?? 0) + dt * (1 - riv * 2);
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
    // Forward escape too, but ONLY when the bow points at floatable water.
    // Since the launch depth gate was removed, a fresh launch on a shelving
    // beach starts beached with its bow already aimed at the lake — W must
    // paddle it straight out (the player should never need the S-then-W
    // dance). A bow nosed against the bank finds no depth ahead and stays
    // put, which keeps the step-ashore flow intact.
    if (this.beached && fwd > 0.02) {
      const ax = this.x + Math.sin(this.heading) * 3.0;
      const az = this.z + Math.cos(this.heading) * 3.0;
      const lv = this._levelAt(ax, az);
      const ahead = (lv === null ? -1e9 : lv) - this.world.getHeight(ax, az);
      if (ahead > this.draft + BEACH_MARGIN + 0.05) {
        this.beached = false;
        this._pinT = 0;
        this.speed = 0.45 * fwd;
      }
    }

    // ── attitude ───────────────────────────────────────────────────────────
    const sp = clamp01(Math.abs(this.speed) / this.maxSpeed);
    // Bow rises slightly at speed; a low-frequency virtual swell breathes
    // under everything.
    const swellP = Math.sin(t * 0.55 + this._bobSeed) * 0.010;
    const swellR = Math.sin(t * 0.42 + this._bobSeed * 1.7) * 0.012;
    // A river surface is NOT level, and a hull drawn flat on a sloping one
    // cuts into the water at one end and lifts clear at the other. Measured on
    // seed 20261018 along the flow, over 352 reaches: p50 0.3 degrees, p95
    // 11.0 degrees — most of the map does not care and the steep twentieth
    // very much does. Read off the DRAWN surface under the hull's own ends, so
    // the trim can never disagree with the water it is sitting on.
    // NOT gated on the river mask, and that is the fix rather than an
    // omission. The mask was standing in for "am I on a river and not a lake",
    // and it stopped being able to answer: the drawn water is now roughly
    // twice the width of the mask, so a hull floating perfectly normally sits
    // outside it, reads `riv` 0, and is drawn dead level on a surface falling
    // away at thirty degrees. Measured on the steepest reach: riv 0.000 against
    // a true surface slope of -30 to -37 degrees, hull pitch 0.7 degrees.
    //
    // The slope itself is the better proxy and needs no mask at all: standing
    // water is level by definition, so bow and stern read the same height and
    // the trim falls out at zero on its own.
    let trim = 0;
    {
      const hl = (this.dim.length ?? 4) * 0.5;
      const fx = Math.sin(this.heading) * hl, fz = Math.cos(this.heading) * hl;
      const bow = this._levelAt(this.x + fx, this.z + fz);
      const stern = this._levelAt(this.x - fx, this.z - fz);
      if (bow !== null && bow !== undefined && stern !== null && stern !== undefined) {
        // Clamped, because a cascade is not a trim angle. The measured p95
        // along the flow is 11 degrees and that should be felt in full; past
        // TRIM_MAX the hull is on something it would be swimming down, and
        // standing the boat on its nose reads as a bug rather than as drama.
        trim = clamp(Math.atan2(bow - stern, hl * 2), -TRIM_MAX, TRIM_MAX);
      }
    }
    // Whitewater chop, straight off the flow field's turbulence channel. Small
    // — this is a touring kayak on a river, not a rodeo boat — but it is the
    // difference between a rapid you can feel and a texture scrolling past.
    const chop = flow.turb * riv;
    const chopP = Math.sin(t * 3.1 + this._bobSeed * 3.7) * 0.030 * chop;
    const chopR = Math.sin(t * 2.3 + this._bobSeed * 1.3) * 0.055 * chop;
    this.pitch = damp(this.pitch,
      sp * 0.045 * Math.sign(this.speed || 1) + swellP + trim + chopP, 3, dt);
    // Bank INTO the turn, 3-5 degrees at full sweep. yawRate + (port turn)
    // banks to port: roll sign chosen so the hull leans toward the inside.
    this.roll = damp(this.roll,
      clamp(-this.yawRate * 0.09 * (0.4 + 0.6 * sp), -0.09, 0.09) + swellR + chopR, 3, dt);
  }

  _beach() {
    this.beached = true;
    this.speed = 0;
    this._pinT = 0;
    this.onBeach?.();
  }

  /** Water over the bed at (x, z), against the DRAWN surface. Negative where
   *  there is no water — including over the mesh's dry shoreline-fade ring,
   *  which has a level below the terrain and must not read as floatable. */
  depthAt(x, z) {
    const lv = this._levelAt(x, z);
    if (lv === null || lv === undefined) return -1;
    return lv - this.world.getHeight(x, z);
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
      depth: this.depth, beached: this.beached, made: this.made,
      riverness: this.riverness, current: this.current, turbulence: this.turbulence,
      rhythm: this.rhythm,
    };
  }
}
