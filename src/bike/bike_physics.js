// ─────────────────────────────────────────────────────────────────────────────
//  bike_physics — an analytic mountain-bike model.
//
//  No Rapier body, and for exactly the reason `boat_physics` gives: rigid-body
//  physics in this game only exists inside a 176 m heightfield patch streamed
//  around the CAMPER (`VehiclePhysics.PATCH_SIZE`). A bike is something you ride
//  AWAY from the camper — that is the whole point of it — so a Rapier bike would
//  fall through the world the moment it left the patch, which is roughly ninety
//  seconds into the first ride.
//
//  Everything here is integrated directly against the height field.
//
//  ── what a bicycle is, as a model ──────────────────────────────────────────
//
//  A car is an engine and a gearbox. A bicycle is a person, and the whole feel
//  of one comes out of two facts about people:
//
//   1. **Gravity is the biggest term.** A 90 kg bike-and-rider on a 10% grade is
//      fighting 88 N of gravity against maybe 150 N of sustainable pedalling. So
//      grade is not a modifier here, it is the dominant force: this model reads
//      the ground slope along the direction of travel and applies g·sin θ
//      directly. Riding uphill is slow and riding downhill is fast, and neither
//      needs a special case — it falls out.
//   2. **Power is capped, not force.** A rider does not have "more accelerator"
//      at 8 m/s; they have the same watts spread over more speed. Pedal thrust
//      is therefore `POWER / max(speed, v0)`, which gives a strong shove off the
//      line and a soft ceiling on the flat without a single clamp.
//
//  Cornering is the other half. `LEAN` is not decoration and it is not tuned:
//  a bike in a steady turn leans at atan(v²/(r·g)) = atan(ω·v/g), so the lean is
//  computed from the yaw rate and the speed it was earned at. That is why it
//  feels right at both ends — a slow pivot barely tips, a fast sweeping turn
//  lays the bike over — and why nobody has to tune it per speed.
//
//  ── the world is a wall, not a suggestion ──────────────────────────────────
//
//  Three things stop a bike, and all three are resolved by the same slide: work
//  out the surface normal of whatever refused the step, take the component of
//  velocity into it away, and try again. That means a bike scrubbing along a
//  boulder keeps going along it instead of stopping dead, which is both what
//  happens and what a player expects.
//
//    · **Water does NOT stop you** — see WADE_REF. It is drag, like the
//      camper's, and nothing else.
//    · **Slope** above `MAX_GRADE`. Not a cliff-detector — the grade term above
//      has already brought a climb to walking pace long before this bites. This
//      is the backstop that stops the bike creeping up a rock face.
//    · **Trunks**, via `Trees.trunksNear` — documented as cheap enough to call
//      every frame, which is exactly what this does.
//    · **Boulders**, via `Rocks.boulderNear`, live cells only. That is the right
//      query here and not `rocksAround`: a rock that has not streamed in is a
//      rock the player cannot see, and the bike is always at the player's feet.
//
//  Convention: +Z is heading 0, `heading` increases the way `Math.atan2(sin,
//  cos)` does everywhere else in this project, y is the ground under the
//  wheels, and `pitch`/`roll` are the frame's attitude in radians.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, damp, lerp, smoothstep } from '../core/MathUtils.js';

// ── the rider ────────────────────────────────────────────────────────────────
//
// Sustainable output, as an acceleration rather than as watts, because the mass
// never appears anywhere else and carrying it would be arithmetic theatre.
//
// ── these four numbers are a SYSTEM, and they were tuned against the VALLEY ──
//
// The first pass wrote POWER 6.8 with ROLL_SOFT 1.55 and the bike could not
// move at all: on the 0.25 grade the camp sat on, thrust 3.4 − gravity 2.38 −
// rolling 1.2 came to a net −0.18 m/s². Full effort, eight seconds, zero
// metres, and no way for the player to tell why. The rolling term was the
// fault — 1.55 m/s² would stop a coasting bike from 27 km/h in five seconds,
// which is not grass, it is wet sand.
//
// The second pass fixed that and was still wrong, in a way only a measurement
// of the WORLD could show. Over 249 random points on seed 20261018 the median
// ground slope is 0.35 — a 19° hillside — and the 80th percentile is 1.16.
// This is a mountain valley, not a park. A rider who tops out at a 20° climb
// is stopped by half the map, and a two-minute helmsman run from the camp
// covered 21 m and spent 108 s of it going nowhere.
//
// ── so the ceiling is set from the TERRAIN, and then from the MAP ────────────
//
// The second tune aimed at the valley floor and stalled at 29°. A reachability
// flood fill from the road network, on a 10 m grid, says what that bought:
//
//   stall  reachable   highest   summits
//    24°     69.4%      227 m     0 / 40
//    31°     70.0%      227 m     0 / 40      ← the 29–31° tune
//    39°     87.4%      254 m    17 / 40      ← here
//    45°     91.7%      260 m    18 / 40
//    ∞       99.9%      291 m    25 / 40
//
// Two things fall out of that table and both are worth keeping. First, the
// terrain is genuinely bimodal — valley floor under 0.4, mountainside over 1.1
// — so dropping the stall from 31° to 24° costs SIX TENTHS OF A PERCENT of the
// map. Nothing here is on a knife edge. Second, there is a threshold just above
// 31°: going to 39° takes the bike from no summits at all to seventeen, and
// from 70% of the land to 87%. Going further buys map but almost no more peaks.
//
// 39° it is (user's call, 2026-09-01, asked as "how well can it climb
// mountains?"). It is not defensible as physiology — sustained off-road
// climbing tops out nearer 15°, and this was already past that — but this
// number was never physiology. It is the answer to "what should a player on a
// mountain bike be able to reach", and the honest version of that is: the
// ridgelines, not the spires.
//
// What the numbers satisfy, all at once:
//
//   flat, firm       thrust == roll + drag → 11/v = 0.25 + 0.016v²  → 8.2 m/s
//   flat, meadow     11/v = 0.80 + 0.016v²                          → 7.0 m/s
//   25% climb, grass 11/v = 0.80 + 2.38 + 0.016v²                   → 3.3 m/s
//   the stall        7.10 = 1.00 + 9.81·sinθ                        → 38.5°
//
// ── and the lever is NOT MAX_THRUST on its own ──────────────────────────────
//
// Low-speed thrust is `min(MAX_THRUST, POWER / V0)`, so whichever of those two
// is smaller sets the climb. Raising MAX_THRUST alone would have done nothing
// at all: POWER/V0 was 11/1.9 = 5.79 and already the binding one. Raising
// POWER instead would have worked and dragged the FLAT top speed up with it,
// because that is set where thrust meets drag, far above here. Lowering V0 is
// the surgical move — it shapes only the bottom gear — and MAX_THRUST comes up
// with it so the pair agree.
const POWER = 11.0;                // m²/s³ — divided by speed to get thrust; sets the TOP end
// The speed below which thrust stops rising — i.e. how much grunt the rider has
// at walking pace, which is a bottom gear. 2.4 left them a tenth of a m/s²
// short of climbing out of a river: measured across four failed crossings, all
// in ~0.9 m of water on a 30% bank, thrust 3.44–3.57 against gravity 2.78–2.96
// plus rolling — and NONE of them blocked on anything. A knife-edge stall reads
// as stuck rather than as hard, which is the worst of both.
//
// 1.9 was the surgical fix for that, and 1.55 is the same lever pulled again to
// reach the ridgelines — see the climb table above. `V0` only shapes the
// low-speed end, so the standing start and the grind out of a ford and up a
// mountainside all get their authority from here while the flat-ground top
// speed does not move at all.
const V0 = 1.55;
// The bottom gear's ceiling. Kept a hair ABOVE `POWER / V0` (7.10) so that
// ratio is what actually decides the climb and this stays what it is named for
// — a cap, not the operative limit. Ranked below it, the two would fight and
// the climb table above would be a fiction.
const MAX_THRUST = 7.2;            // m/s² — the standing-start cap
const DRAG = 0.016;                // per (m/s)² — air, and it is small
const ROLL_HARD = 0.25;            // m/s² — rolling resistance on packed dirt
const ROLL_SOFT = 0.80;            // m/s² — the same through meadow grass
const BRAKE = 7.2;                 // m/s² with the brakes on
const WALK_BACK = 1.1;             // m/s of walking the bike backwards
const G = 9.81;

// ── steering ─────────────────────────────────────────────────────────────────
//
// A bicycle's turn is limited by two things and NEITHER of them is a steering
// constant. The first pass wrote one anyway — a `lerp(2.30, 0.85)` ramp on
// speed — and it produced turns no bicycle can make: measured on seed
// 20261018, full lock at 2.3 m/s carved a **1.1 m radius**, which is tighter
// than the bike is long, and every sustained corner sat pinned at LEAN_MAX.
// (Found because the user looked at a capture and asked whether the bike was
// riding in circles or whether that was a bug. The circles were the harness's
// input; the radius was the bug.)
//
// The two real limits:
//
//   STEERING LOCK, which binds at low speed. The bars only turn so far, and a
//   mountain bike's minimum radius is about 1.35 m. ω = v / MIN_RADIUS.
//
//   LEAN, which binds at speed. A bike holds a turn by leaning, and the lean a
//   steady turn needs is tan(lean) = ω·v / g. Past LEAN_MAX the tyres let go,
//   so ω can be no more than g·tan(LEAN_MAX) / v — which falls with speed all
//   on its own and is why fast corners open out. Nothing has to ramp it.
//
// Take the tighter of the two and scale by TURN_TRIM, so full stick is a firm
// corner rather than a permanent slide at the limit of grip. That trim is the
// only taste number here: at 1.0 the bike rides every corner at maximum lean,
// which is exhausting to look at and leaves the player nothing in reserve.
const MIN_RADIUS = 1.35;           // m — the steering lock, at walking pace
const TURN_TRIM = 0.78;            // fraction of the grip limit full stick asks
const TURN_STILL = 0.55;           // rad/s standing still — walking it around
const LEAN_MAX = 0.62;             // rad — 35°, past which a tyre lets go
const TAN_LEAN_MAX = Math.tan(LEAN_MAX);
const LEAN_DAMP = 8.0;

// ── the ground ───────────────────────────────────────────────────────────────
// ── water is DRAG, not a wall ────────────────────────────────────────────────
//
// It was a wall, at 0.28 m, and the wall could not be tuned into something
// good. Measured on seed 20261018, across 600 river transects taken
// perpendicular to the flow, the deepest point a rider must cross is:
//
//   p05 0.70 m   p25 1.42 m   p50 2.01 m   p75 3.24 m
//
// so **no river in this valley has a shallow ford** — at 0.28 m exactly 0% of
// crossings were passable, and even at a saddle-deep 0.75 m only 11% were.
// Raising the wall could not deliver "cross shallow rivers no problem" because
// there are no shallow rivers to cross; it could only pick which impassable
// barrier to draw.
//
// So the wall goes, and the bike does what the camper does: rides in, gets
// slow, and the water itself decides how far. `VehiclePhysics` has run that
// model since the beginning (`wade = depth / 1.25`, quadratic drag, engine
// faded, grip reduced, never refused) and there is no reason a bicycle should
// be more strictly fenced than a two-tonne van.
//
// WADE_REF is the depth at which the water is doing everything it can, not a
// limit. Smaller than the camper's 1.25 because a bicycle is a tenth its mass
// and its rider is standing in the river.
const WADE_REF = 0.90;
// ── and the drag is LINEAR IN SPEED, which is the part that matters ──────────
//
// The first version of this made water a constant deceleration — 5.0 m/s² at
// full wade — and it turned the hard wall into a soft one. Measured on the
// crossing at (-169, -76): the bike rode 33 m into a 38 m river, bogged to
// 0.02 m/s in the deep middle, and sat there. Being stopped in the river is
// worse than being stopped at the bank.
//
// `VehiclePhysics` does not have that problem and the reason is structural, not
// a tuning difference. Its water term is `force = -velocity · 1400·wade² ·
// 0.06` — proportional to SPEED. A constant deceleration is a friction model
// and friction can hold a body at rest; a speed-proportional one is a fluid
// model, and fluid drag falls to zero as the body slows. So it caps your speed
// and can never take it away. That is exactly why the camper wallows across
// rivers instead of parking in them.
//
// Same structure here, sized for a bicycle. 1.4 per m/s at full wade settles a
// rider at about 1.8 m/s — a walking wade they can always finish — while the
// quadratic depth curve keeps the shallow end genuinely free: 0.15 m of water
// at 6 m/s costs 0.23 m/s², against the 0.8 the grass beside it is already
// charging.
const WADE_DRAG = 1.4;
// How much of a pedal stroke is lost to being deep in a river.
//
// 0.5 — half the rider's power, matching the camper's 0.55 — was measured and
// it is the term that actually stopped the bike, not the drag. On the crossing
// at (-169, -76) the balance in 1.8 m of water while climbing the 16% far bank
// came to: thrust 2.29, gravity 1.55, rolling 0.72, water drag 0.018. Net
// **+0.02 m/s²** — a knife-edge equilibrium at 0.013 m/s, with every step
// succeeding on the first try and nothing blocked. The bike was not stuck on
// anything; it simply had no power left.
//
// The camper gets away with 0.55 because it has a two-tonne flywheel and an
// enormous torque reserve. A rider at half power on a climb has nothing, and
// the real physical picture is not "half the power" anyway — someone crossing
// a river deep enough to matter is pushing the bike, not pedalling it.
//
// 0.25 leaves enough to climb out and settles a deep wade at about 2.2 m/s.
const WADE_FADE = 0.25;
// ── what `getSlope` actually returns ────────────────────────────────────────
//
// Its own doc comment says "0 = flat, 1 = vertical", and that is not what it
// does. Measured over 249 random points on seed 20261018 against a central
// difference of `getHeight`, it is the GRADIENT MAGNITUDE — rise over run,
// i.e. tan θ — to two decimal places, and it runs well past 1:
//
//   slope   0.05   0.35   1.16   1.70   2.52   3.06
//   grad    0.08   0.33   1.09   1.77   2.51   3.04
//   angle     4°    18°    48°    61°    68°    72°
//   at pct   p10    p50    p80    p90    p97    p99
//
// So a threshold written as if 1 were vertical is wrong by a factor nobody
// would notice until a bike stopped on open ground. The distribution is also
// sharply bimodal — the valley floor is under 0.4 and the mountains are over
// 1.1, with very little between — which is why this number can be a CLIFF test
// and nothing more: 0.90 is 42°, it excludes 27% of the valley, and 0.72 (36°)
// excludes 30%. The three degrees buy almost no ground and cost the steep
// chutes a mountain biker would actually ride down.
//
// What stops a bike riding UP a bank is not this: it is the gravity term, which
// has taken a 20° climb to walking pace and a 25° one to a standstill long
// before this gets a vote.
//
// ── and the wall is NOT symmetric ──────────────────────────────────────────
//
// It shipped symmetric, and that was wrong in the way a rule is wrong when it
// answers a question nobody asked. A rider looking down a steep bank at a river
// rides DOWN it; that is what the bank is for. Refusing the descent because the
// same ground could not be climbed put the bike in a fence at the top of every
// interesting piece of terrain in the valley — "the bike gets stuck going down
// hills, it's like it's not allowed for some reason" (user, with a screenshot
// of a bike parked on a riverbank, 2026-09-01).
//
// So the limit depends on which way the step goes. Downhill it opens out to a
// 58° chute, which is a mountain biker's idea of steep and still well short of
// the 61°+ the valley's actual cliffs stand at (p90 of the slope distribution
// is 1.70). Uphill it stays where it was. The rule reads as one sentence: you
// can ride down things you could not ride up.
const MAX_GRADE = 0.90;            // 42° — the limit for entering LEVEL or rising ground
const MAX_GRADE_DOWN = 1.60;       // 58° — the same for a step that descends
const WHEEL_GRIP = 0.24;           // how hard the attitude tracks the ground

// How far ahead the wall test looks, as a multiple of the step. A step at 8 m/s
// and 60 Hz is 13 cm and a front wheel is 70 cm ahead of the origin, so testing
// only the destination lets the front wheel enter a trunk for five frames
// before the centre does.
const PROBE = 0.62;                // m ahead of centre the front contact sits

export class BikePhysics {
  /**
   * @param world  WorldData
   * @param dim    the model's own `BIKE_DIM`
   * @param opts   { ctx } — the game context, for the trunk and boulder queries.
   *               Optional: without it the bike simply rides through trees,
   *               which is what the headless unit harness wants.
   */
  constructor(world, dim, opts = {}) {
    this.world = world;
    this.dim = dim;
    this.ctx = opts.ctx ?? null;
    this.half = (dim.wheelbase ?? 1.1) * 0.5;

    this.x = 0; this.y = 0; this.z = 0;
    this.heading = 0;
    this.speed = 0;          // m/s along the heading, signed
    this.made = 0;           // m/s actually made good over the ground
    this.yawRate = 0;
    this.lean = 0;           // rad, the cornering roll — positive is a LEFT turn
    this.pitch = 0;          // rad, nose up positive
    // The frame's total roll, in the sense the model's Z euler wants: the
    // ground's cross-slope MINUS the lean. The two have opposite signs on
    // purpose — a left lean tips the top of the bike toward +X (the rider's
    // left) which is a negative z-euler, while ground that is higher on the
    // left tips it the other way. See `_settle`.
    this.roll = 0;
    this.wheelAngle = 0;     // rad the wheels have turned — the model spins by it
    this.crankAngle = 0;
    // What the RIDER is doing, kept because the audio layer needs the cause and
    // not just the effect: a bike coasting at 7 m/s and a bike being pedalled at
    // 7 m/s sound completely different (freewheel ratchet vs chain under load),
    // and `speed` alone cannot tell them apart.
    this.effort = 0;         // 0..1 — how hard the pedals are being turned
    this.braking = 0;        // 0..1
    this.wheelRate = 0;      // rad/s the wheels are turning, unsigned
    this.cadence = 0;        // rad/s the cranks are turning, unsigned
    // What the tyres are ON, 0 = bare ground, 1 = meadow. Computed here rather
    // than anywhere else because it is the SAME number the rolling resistance
    // is built from — so the ground that looks soft rides soft and sounds soft,
    // and the three can never disagree. Read by `bike_audio`.
    this.grassiness = 0.5;
    this._surf = {};
    this.steerAngle = 0;     // rad the fork is turned, for the model
    this.grade = 0;          // rise/run along the heading, published for the HUD
    this.wading = 0;         // m of water under the wheels
    this.wade = 0;           // …the same, normalised on WADE_REF, 0..1
    this.blocked = false;    // the last step hit a wall
    this.onGround = true;

    this._crossRoll = 0;     // the ground's cross-slope alone — see _settle
    this._probeT = 0;        // seconds since the obstacle list was refreshed
    this._trunks = [];
    this._rock = null;
  }

  /** Put the bike down here, stopped and settled onto the ground. */
  place(x, z, heading) {
    this.x = x; this.z = z; this.heading = heading;
    this.speed = 0; this.made = 0; this.yawRate = 0; this.lean = 0;
    this._settle(1);
    return this;
  }

  /**
   * One step.
   *
   * @param inp { fwd, back, turn } — all in 0..1 / −1..1, exactly the axes the
   *            camper reads, so the touch controls work unchanged. `parked:
   *            true` is the moored case: nobody is on it, and it stays put on
   *            whatever slope it was left on.
   */
  step(dt, t, inp = {}) {
    const dtc = Math.min(dt, 1 / 30);
    const fwd = clamp01(inp.fwd ?? 0);
    const back = clamp01(inp.back ?? 0);
    const turn = clamp(inp.turn ?? 0, -1, 1);
    const W = this.world;

    // ── the grade, along the way we are pointed ─────────────────────────────
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const D = 1.2;
    const hA = W.getHeight(this.x + fx * D, this.z + fz * D);
    const hB = W.getHeight(this.x - fx * D, this.z - fz * D);
    this.grade = (hA - hB) / (2 * D);
    // sin of the slope angle, without the atan: g·sin θ = g·m/√(1+m²).
    const sinT = this.grade / Math.sqrt(1 + this.grade * this.grade);

    // ── surface ─────────────────────────────────────────────────────────────
    // Rolling resistance is where the world is felt. Meadow drags a mountain
    // bike down; the packed dirt of a track or a bare scree shoulder lets it
    // run. Read off `getSurfaceWeights` — the same call the TERRAIN MATERIAL
    // draws itself from — rather than off moisture, so the ground that LOOKS
    // like grass is the ground that rides like grass. Moisture alone could not
    // tell a wet rock slab from a wet meadow, and it is the vegetation that
    // slows a tyre, not the water.
    //
    // (An earlier version added a slope term reading `1 - slope*3`, which made
    // FLAT ground the softest thing in the valley — backwards, and it put a
    // floor of 0.35 under the softness everywhere, which is most of how the
    // bike ended up unable to climb its own campsite.)
    const w = W.getSurfaceWeights(this.x, this.z, this._surf);
    const bare = clamp01(w.rock + w.dirt * 0.85 + w.sand * 0.6);
    const veg = clamp01(w.grass + w.dry + w.litter * 0.5);
    this.grassiness = veg / Math.max(1e-3, veg + bare);
    // Wet grass is the slowest thing here and dry grass is not far behind, so
    // moisture still gets a say — as a modifier on the vegetation, which is
    // where it belongs, rather than as the whole model.
    const wet = clamp01(W.getMoisture(this.x, this.z));
    this.wading = W.getWaterContactDepth(this.x, this.z);
    this.wade = clamp01(this.wading / WADE_REF);
    const roll = lerp(ROLL_HARD, ROLL_SOFT, this.grassiness) * (1 + wet * 0.25);
    // Per (m/s) — applied against the speed below, never as a flat deceleration.
    const wadeDrag = WADE_DRAG * this.wade * this.wade;

    // ── longitudinal ────────────────────────────────────────────────────────
    const v = this.speed;
    const av = Math.abs(v);
    let a = 0;
    // …faded by the water, the camper's `waterFade`: a rider up to their knees
    // in a river cannot put a full stroke in. Together with the quadratic drag
    // above this is what makes deep water self-limiting without a wall.
    const waterFade = 1 - this.wade * WADE_FADE;
    if (fwd > 0) a += Math.min(MAX_THRUST, POWER / Math.max(av, V0)) * fwd * waterFade;
    // Braking, then walking it backwards. A bike has no reverse gear and this
    // is not pretending otherwise: hold the back axis at a stop and the rider
    // walks it back at `WALK_BACK`, which is how you get out of a dead end.
    if (back > 0) {
      if (v > 0.15) a -= BRAKE * back;
      else a -= (WALK_BACK + v) * 6.0 * back;
    }
    a -= G * sinT;                                   // the dominant term
    // Resistance always opposes motion, and must not be able to push the bike
    // backwards through zero in one step — hence the min against v/dt.
    if (av > 1e-4) {
      const res = roll + DRAG * v * v + wadeDrag * av;
      a -= Math.sign(v) * Math.min(res, av / dtc);
    } else if (inp.parked === true) {
      // A bike nobody is on does not roll down the hill it was left on. This is
      // the ONLY case that holds: a bike being ridden with nothing held coasts,
      // because letting go at the top of a bank and rolling away is the best
      // thing a bicycle does and the first version froze it solid instead.
      a = 0;
      this.speed = 0;
    }
    this.speed = v + a * dtc;
    // A rider does not pedal past a sensible cadence downhill; they coast, and
    // then they brake. This is a soft ceiling on the coast, not a clamp on the
    // physics — gravity may still exceed it briefly on a real plunge.
    if (this.speed > 13) this.speed = damp(this.speed, 13, 2.2, dtc);
    if (this.speed < -WALK_BACK) this.speed = -WALK_BACK;

    // ── steering and lean ───────────────────────────────────────────────────
    const sp = Math.abs(this.speed);
    // The two limits, and the tighter one wins. `Math.max(sp, 0.5)` keeps the
    // lean limit finite as the bike stops — at a standstill it is the steering
    // lock and then TURN_STILL that decide, not a division by zero.
    const geoRate = sp / MIN_RADIUS;                       // steering lock
    const leanRate = (G * TAN_LEAN_MAX) / Math.max(sp, 0.5);   // grip
    const rate = Math.max(TURN_STILL, Math.min(geoRate, leanRate) * TURN_TRIM);
    // Reversing steers the other way round, the same as the camper.
    this.yawRate = turn * rate * (this.speed < -0.05 ? -1 : 1);
    // The fork follows the turn, and the sign is NOT free. A positive `turn` is
    // a left turn: it raises `heading`, which swings `forward = (sin h, cos h)`
    // from +Z toward +X, and +X is the rider's left. The steer group spins
    // about the head tube's axis, which is within 22° of +Y, so a positive
    // rotation there sends the front wheel the same way — toward +X. Positive.
    //
    // It shipped negated, and the user caught it in one look: "the bike goes
    // the right way, the wheel turn is what is wrong." Which is the whole tell
    // — a sign error on the BODY steers the bike, a sign error here only ever
    // shows up as the front wheel countersteering into every corner.
    this.steerAngle = damp(this.steerAngle, turn * 0.42, 12, dtc);
    this.heading += this.yawRate * dtc;
    this.heading = Math.atan2(Math.sin(this.heading), Math.cos(this.heading));
    // The true banking angle: tan(lean) = ω·v / g. Damped, because a rider's
    // body takes a moment to come over, and because an undamped lean flickers
    // wildly at low speed where ω is largest.
    const wantLean = clamp(Math.atan2(this.yawRate * this.speed, G), -LEAN_MAX, LEAN_MAX);
    this.lean = damp(this.lean, wantLean, LEAN_DAMP, dtc);

    // ── move, and let the world refuse ──────────────────────────────────────
    this._refreshObstacles(dtc);
    const nfx = Math.sin(this.heading), nfz = Math.cos(this.heading);
    let vx = nfx * this.speed, vz = nfz * this.speed;
    const bx = this.x, bz = this.z;
    this.blocked = false;
    if (!this._advance(vx, vz, dtc)) {
      // Refused. Slide along whatever said no, then give up if that fails too.
      const n = this._blockNormal(this.x + vx * dtc, this.z + vz * dtc);
      if (n) {
        const into = vx * n.x + vz * n.z;
        if (into < 0) { vx -= n.x * into; vz -= n.z * into; }
        if (!this._advance(vx, vz, dtc)) { this.blocked = true; this.speed *= 0.25; }
        else this.speed *= 0.90;                     // scrubbing costs you
      } else { this.blocked = true; this.speed = 0; }
    }
    this.made = Math.hypot(this.x - bx, this.z - bz) / Math.max(dtc, 1e-5);

    // ── attitude, and the parts that go round ───────────────────────────────
    this._settle(1 - Math.exp(-WHEEL_GRIP * 60 * dtc));
    // The wheels turn with the ground the bike actually covered, not with the
    // speed it wishes it had — so a bike held against a boulder at full effort
    // has still wheels, which is the honest picture and the one that makes the
    // block readable without a word of UI.
    // ── the sign, which was wrong and is not a matter of taste ─────────────
    //
    // A wheel group sits at the hub with its axle on local X. Rotating about +X
    // sends a point at the BOTTOM of the wheel, (0, −r, 0), to (0, −r·cosθ,
    // −r·sinθ) — so a positive θ drags the contact patch toward −Z, which is
    // backward, which is what rolling FORWARD does. The angle therefore has to
    // INCREASE as the bike moves forward. It shipped decreasing, and a bicycle
    // whose wheels turn backwards is not subtle: "your wheels are spinning the
    // wrong direction" (user, 2026-09-01).
    const rolled = (this.made * Math.sign(this.speed || 1)) / (this.dim.wheelR ?? 0.35);
    this.wheelAngle += rolled * dtc;
    this.wheelRate = Math.abs(rolled);
    this.effort = fwd;
    this.braking = back;
    // Cadence: a rider in a sensible gear turns the cranks around 80 rpm at
    // speed and slows down with the bike. Tied to the wheels through a fixed
    // ratio would spin the legs at 300 rpm downhill.
    const cad = smoothstep(0.15, 4.5, this.made) * 8.2 * (this.speed < 0 ? -1 : 1);
    // Same axis, same sign, same argument: the top of the crank goes FORWARD.
    const turning = fwd > 0.02 ? cad * (0.55 + 0.45 * fwd) : 0;
    this.crankAngle += turning * dtc;
    this.cadence = Math.abs(turning);
    return this;
  }

  // ── the world's answers ───────────────────────────────────────────────────

  /**
   * Is (x, z) ground a bike may be on? The four refusals in the header, in the
   * order that costs least — bounds and water are two array reads, the trunk
   * list is already in hand, the boulder walk is the expensive one.
   *
   * `slope: false` asks the same question of a WHEEL rather than of the bike,
   * and drops the gradient test. That distinction is not a nicety, it is the
   * difference between a bike and a statue. A front wheel sits on steeper
   * ground than the bike's centre every time the bike is pointed uphill, which
   * is constantly; with the gradient in the probe, a bike standing at the foot
   * of a 42° face had NO heading it could move along, because every point 0.62 m
   * away was over the wall. Measured: 3600 consecutive frames reporting blocked
   * at (-588, 376) with 19 of the 24 bearings around it perfectly rideable.
   * What a wheel genuinely cannot do is be inside a tree or under a metre of
   * water, and those it is still asked about.
   */
  rideable(x, z, { slope = true, maxGrade = MAX_GRADE } = {}) {
    const W = this.world;
    if (!W.isInBounds(x, z)) return false;
    if (slope && W.getSlope(x, z) > maxGrade) return false;
    for (const tr of this._trunks) {
      const r = tr.radius + 0.34;
      const dx = tr.x - x, dz = tr.z - z;
      if (dx * dx + dz * dz < r * r) return false;
    }
    const b = this._rock;
    if (b) {
      const r = b.size * 0.75 + 0.34;
      const dx = b.x - x, dz = b.z - z;
      if (dx * dx + dz * dz < r * r) return false;
    }
    return true;
  }

  /**
   * Try a step. Both the centre and the leading contact patch have to land on
   * rideable ground — see PROBE for why the centre alone is not enough.
   *
   * ── the probe follows the TRAVEL, not the heading ──────────────────────────
   *
   * It looked obvious to put the probe 0.62 m along `heading`, because that is
   * where the front wheel is. It is also a trap that welds the bike to any wall
   * it is pointed at, and it shipped: on seed 20261018 the bike rode into the
   * foot of a 38° face, and from then on EVERY slide the caller computed was
   * refused — the slid velocity ran along the face, the probe still ran into
   * it, and `_advance` failed on the probe alone. Measured: 225 frames pinned
   * at one spot to the tenth of a metre with seven of the eight bearings around
   * it rideable, the bike slowly turning, and never a centimetre of movement.
   * That is the same shape as the wildlife steering freeze and it is the same
   * cause — a test that cannot be satisfied by the escape it is refusing.
   *
   * Probing along the direction the bike is actually being moved keeps what the
   * probe is for (the leading edge arrives before the middle) and lets the
   * slide do its job. When the bike is going where it points — which is every
   * frame that is not against a wall — the two are the same vector anyway.
   */
  _advance(vx, vz, dt) {
    const nx = this.x + vx * dt, nz = this.z + vz * dt;
    if (!this.rideable(nx, nz, { maxGrade: this._gradeLimit(nx, nz) })) return false;
    const m = Math.hypot(vx, vz);
    if (m > 1e-5) {
      const px = nx + (vx / m) * PROBE, pz = nz + (vz / m) * PROBE;
      // The wheel's question, not the bike's — see `rideable`.
      if (!this.rideable(px, pz, { slope: false })) return false;
    }
    this.x = nx; this.z = nz;
    return true;
  }

  /**
   * The outward normal of whatever refuses (x, z), as a unit XZ vector pointing
   * back toward where the bike may be. Sampled rather than derived: the four
   * refusals have four different gradients and one finite-difference of the
   * predicate itself covers all of them, including the case where two of them
   * overlap at a boulder on a lakeshore.
   */
  _blockNormal(x, z) {
    const E = 0.55;
    let sx = 0, sz = 0, n = 0;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const ox = Math.cos(a), oz = Math.sin(a);
      const px = x + ox * E, pz = z + oz * E;
      // The same directional limit `_advance` will apply, so the slide can
      // never steer the bike toward ground the step is then going to refuse.
      if (this.rideable(px, pz, { maxGrade: this._gradeLimit(px, pz) })) { sx += ox; sz += oz; n++; }
    }
    if (!n) return null;
    const len = Math.hypot(sx, sz);
    if (len < 1e-4) return null;
    return { x: sx / len, z: sz / len };
  }

  /**
   * Which slope limit applies to a step from here to (x, z) — see MAX_GRADE.
   * Measured against the bike's own settled height rather than the terrain
   * under it, so the answer does not flicker as the attitude damps.
   *
   * ── the escape clause, and why a wall needs one ────────────────────────────
   *
   * Making the wall directional fixed the fence at the top of every bank and
   * immediately created subtler versions of the same bug further down. Both
   * were measured on seed 20261018 and both are the same mistake: a test that
   * can refuse a bike the ground it is ALREADY STANDING ON.
   *
   *  1. A bike may legally descend onto ground at exactly the chute limit, and
   *     once there every neighbour is steeper. At (350.6, 994.2), standing on
   *     slope 1.60, the twelve bearings around it read 1.30–1.92 and not one
   *     passed.
   *  2. On a 49° riverbank the first 30 cm of a descent is often level or a
   *     hair uphill — a convex lip — so "is this step descending" answered NO,
   *     the 42° uphill limit was applied to 1.27 of bank, and the bike was
   *     welded to the top of a slope it had just ridden down onto. Two of eight
   *     river crossings died exactly there, one of them without ever reaching
   *     the water.
   *
   * One rule covers both, and it is simpler than either patch: **if the bike is
   * standing on ground this wall would not let it ENTER, the wall gets no vote
   * on it leaving** — in any direction. It got there legally, so stranding it is
   * never the right answer, and the climb out does not need policing anyway:
   * gravity already handles that, and handles it better. A 2.0 grade costs
   * 8.8 m/s² against a 5.6 m/s² peak thrust, so the bike simply cannot ride up
   * it, no wall required. Walls are for cliffs you might be dropped onto; this
   * is a bike that rode somewhere steep and has to be able to ride back out.
   */
  _gradeLimit(x, z) {
    if (this.world.getSlope(this.x, this.z) > MAX_GRADE) return Infinity;
    return this.world.getHeight(x, z) < this.y - 0.002 ? MAX_GRADE_DOWN : MAX_GRADE;
  }

  /** Refresh the trunk and boulder queries. Not every frame: `trunksNear` is
   *  cheap but not free, and a bike at 8 m/s covers 1.3 m in the interval, well
   *  inside the 6 m radius asked for. */
  _refreshObstacles(dt) {
    this._probeT -= dt;
    if (this._probeT > 0) return;
    this._probeT = 0.15;
    const sys = this.ctx?.systems;
    this._trunks = sys?.trees?.trunksNear?.(this.x, this.z, 6) ?? [];
    this._rock = sys?.rocks?.boulderNear?.(this.x, this.z, 2.4, 0.55) ?? null;
  }

  /**
   * Sit the bike on the ground: height from the two contact patches, pitch from
   * the line between them, roll from the cross-slope plus the cornering lean.
   *
   * Two contacts and not one. A single height sample under the origin puts a
   * 1.1 m wheelbase flat on the ground everywhere, so the bike floats over every
   * dip and buries its nose in every rise — the exact thing a wheelbase exists
   * to stop. Measuring where the wheels ARE is both cheaper than a normal fetch
   * and correct by construction.
   */
  _settle(k) {
    const W = this.world;
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const rx = Math.cos(this.heading), rz = -Math.sin(this.heading);   // to −X
    const h = this.half;
    const yF = W.getHeight(this.x + fx * h, this.z + fz * h);
    const yR = W.getHeight(this.x - fx * h, this.z - fz * h);
    const yL = W.getHeight(this.x + rx * 0.34, this.z + rz * 0.34);
    const yRt = W.getHeight(this.x - rx * 0.34, this.z - rz * 0.34);
    const y = (yF + yR) * 0.5;
    const pitch = Math.atan2(yF - yR, h * 2);
    // The ground's cross-slope, then the lean on top of it. The lean is the
    // rider's, so it is NOT damped toward the ground here — it is already
    // damped in `step` and adding a second filter makes the bike feel like it
    // is turning underwater.
    // …and the cross-slope is filtered SEPARATELY from the lean. Filtering the
    // sum would feed last frame's lean back into this frame's ground reading,
    // which turns a steady corner into a slow drift onto its side.
    //
    // `yL` is the height under the LEFT wheel line — local +X, which is where
    // (cos h, −sin h) points. Ground higher on the left stands the bike's top
    // over to the right, a POSITIVE z-euler; a left lean does the opposite.
    // Hence the minus, and hence `roll` is the composite the model can use
    // straight.
    const cross = Math.atan2(yL - yRt, 0.68);
    this._crossRoll = lerp(this._crossRoll, cross, k);
    this.y = lerp(this.y, y, k);
    this.pitch = lerp(this.pitch, pitch, k);
    this.roll = this._crossRoll - this.lean;
    this.onGround = true;
  }

  /** JSON-able snapshot, for the harness and the HUD. */
  state() {
    return {
      x: this.x, y: this.y, z: this.z,
      heading: this.heading, speed: this.speed, made: this.made,
      lean: this.lean, pitch: this.pitch, roll: this.roll,
      grade: this.grade, wading: this.wading, wade: this.wade, blocked: this.blocked,
      effort: this.effort, braking: this.braking,
      wheelRate: this.wheelRate, cadence: this.cadence,
      grassiness: this.grassiness,
    };
  }
}
