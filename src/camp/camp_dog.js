// ─────────────────────────────────────────────────────────────────────────────
//  camp_dog — the dog that shows up when you make camp.
//
//  The player's spec: "When you setup camp, 80% chance you get a camp dog. The
//  camp dog's animations would mainly be walking around the camp fire in a
//  smooth slow meandering around the fire as the center point. Then find a spot
//  near the fire to curl its body up and lay down. Occasionally the dog will lay
//  down normally and not curled up. Sometimes it will sit instead."
//
//  ── what this file owns, and what it borrows ────────────────────────────────
//
//  The dog's BODY is not here, and neither is a single one of its poses any
//  more. It is a bought model with seven hand-authored clips
//  (`mammals/dog.js`, `public/models/dog_pack.glb`) played by `GlbRig` — the
//  same backend the fox, bear, deer, raccoon, goat and ram are on.
//
//  It used to be a lofted quadruped walking on the procedural gait solver, with
//  the three rest poses authored HERE as tables of signed bone rotations and
//  blended over the solver's output after it ran. That was the only way to get
//  a sit: `AnimRig` solves each leg by IK to a foot planted on the ground, and
//  a sitting dog has its hocks flat along the ground and its pelvis resting
//  between them. It cannot work one out, so ~40 numbers per pose were written
//  by hand and judged by running the game.
//
//  They are clips now, built by `tools/build_dog_blend.py`, and this file is
//  400 lines shorter for it. What is left here is the ONE thing no rig backend
//  can supply:
//
//    · **the loop.** Meander, choose a spot, settle, sleep, get up. A camp dog
//      is not a wild animal and must not be given a `Brain` — that state
//      machine is about a threat and a home range, and its whole vocabulary
//      (flee, alert, graze) is wrong for an animal whose entire world is a
//      three-metre ring around a fire.
//
//  ── why the dog orbits ──────────────────────────────────────────────────────
//
//  "Smooth slow meandering around the fire as the center point" is a specific
//  motion and it is not a random walk. A random walk with a leash reads as an
//  animal repeatedly changing its mind; what the brief describes is an animal
//  circling something it is attached to. So the wander target is polar — an
//  angle that advances at a drifting rate and a radius that breathes in and out
//  — and the dog steers toward it. The fire is the origin of that coordinate
//  system, which is the whole trick: every path it walks is *about* the fire.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, wrapAngle } from '../core/MathUtils.js';
import { loadCampDog, DOG_SPECIES } from '../wildlife/mammals/dog.js';
import { GlbRig } from '../wildlife/glb_rig.js';

// ── the rest poses ───────────────────────────────────────────────────────────
//
// Three CLIPS now, not three tables of bone rotations. They live in
// `public/models/dog_pack.glb`, are built by `tools/build_dog_blend.py`, and
// each is a loopable hold with the dog breathing on it. `GlbRig` blends the
// named one in against `drive.restW` and spends the whole standing budget on
// it — see the `rest poses` block in its constructor.
//
// What was here before was ~40 signed bone rotations per pose, applied over the
// gait solver's output after it had run, plus the conventions needed to read
// them (which way is +x on a leg, which bones the neck lags on, why `push` is
// assigned where `drop` accumulates). All of it is gone. The poses can now be
// judged by opening the .blend and looking at the dog, which is the whole
// reason to build an animal in Blender.
//
// One thing genuinely went with it: a settled dog used to ease a little `alert`
// in — the neck lifting and the ears pricking — because a frozen pose reads as
// a prop. A standing alert cannot be blended over a curl (it would lift the
// body off the ground by exactly its weight), so the clips carry their own
// breathing instead and `drive.alert` is left at zero while the dog is down.

// How the three are chosen, and by clip name. The brief is explicit about the
// ranking: curling up is what the dog mainly does, lying flat is occasional,
// sitting is sometimes.
const POSE_PICK = [
  { key: 'curl', w: 0.55 },
  { key: 'lie', w: 0.27 },
  { key: 'sit', w: 0.18 },
];

// ── timings ──────────────────────────────────────────────────────────────────
//
// A camp dog is scenery with a pulse. It should be settled far more often than
// it is moving — a dog that is always up and circling reads as agitated, and
// the payoff of the whole feature is glancing over and finding it asleep by the
// fire. So: long rests, short wanders.
const REST_TIME = [26, 75];      // s asleep / sitting before getting up
const WANDER_TIME = [7, 18];     // s milling about before settling again
const SETTLE_TIME = 1.05;        // s to fold down into a pose
// Longer than the settle, and it stays longer even though the reason changed.
// It used to be that the head unwound on its own lagged clock and needed the
// room; now it is a crossfade from a rest clip back to the idle, and a dog that
// stands up faster than it lies down is the wrong way round for the animal.
const RISE_TIME = 1.25;          // s to stand back up
const APPROACH_TIME = 16;        // s before abandoning an unreachable bed

// Both of these were the hand-authored poser's, and both are gone with it: a
// per-bone head lag on the way down (HEAD_LAG / HEAD_BONES) and the
// shortest-arc angle mix it needed (`mixAngle`). A crossfade between two whole
// clips has neither problem — three's `AnimationMixer` slerps quaternions, so
// there is no branch cut to cross and no chain to hold back. The `sit`, `lie`
// and `curl` clips each fold the head as part of the pose, in the .blend, where
// it can be watched.

// A dog in a moving state is CONSTANTLY covering ground — walking is 0.78 m/s
// and even the slow cases (backing out of a corner at 0.27, creeping the last
// step to a bed at 0.19, walking a tight arc at forty percent speed) all put
// a few tenths of a metre behind them every couple of seconds. So stuck is
// not a diagnosis that needs patience: fail to get one step-length away from
// where you were two seconds ago and no walking gait is in progress — only
// oscillation against something solid. Detect it at that timescale and put
// the dog back on its orbit somewhere clear, rather than letting the player
// watch it grind while a longer fuse burns down. (An earlier 13 s fuse
// existed to let slow escape arcs finish; the honest reading is that a
// manoeuvre slow enough to look stuck for two seconds is better cut short
// too — the respawn prefers a spot away from the camera either way.)
const STUCK_MOVE = 0.12;         // m of net displacement that counts as progress
const STUCK_TIME = 2;            // s without progress before respawning
// The anchor test above has a blind spot: a dog PACING inside a pocket moves
// more than STUCK_MOVE on every crossing and resets its anchor forever while
// going nowhere (found by walling a test dog into a 0.4 m pen — it paced for
// twenty seconds without ever reading as stuck). So a second, slower test
// watches the bounding box of everywhere the dog has recently been: a walking
// dog's six-second box spans metres, a penned or churning one's spans half a
// metre. Either test firing respawns the dog.
const PEN_TIME = 6;              // s of history the box covers
const PEN_SPAN = 0.55;           // m; a box no bigger than this is a cage
const RESPAWN_CLEAR = 0.20;      // clearance a respawn point must offer
const NAV_CELL = 0.16;           // m; the walkable-space raster — see _buildNav
// The one number that keeps the planner and the body honest with each other:
// a step is only taken into space with at least this much clearance, and the
// raster calls a cell free by the same test. Letting the body accept a hair
// less than the raster (0 vs 0.05, as it originally did) let the dog walk
// into slivers — the pinch between the fire ring and the tent — that no route
// would ever pass through, and every stuck report in the sim ended there.
const WALK_CLEAR = 0.05;
// Routes are planned through COMFORTABLE space, a stricter set than the body
// strictly fits in. The damped-heading steering cannot thread a corridor two
// hand-spans wide — measured, the cooler-telescope gap (0.18 m of clearance)
// read as a legal shortcut to the router and cost a recovery spiral every time
// the dog was sent through it. A passage tighter than this is treated as no
// passage at all, and the plan goes round the long way.
const ROUTE_CLEAR = 0.14;

// Where it walks. The fire ring is 0.58 m of stone, so nothing here may come
// inside about a metre and a half of the centre.
// The fire ring is 0.58 m of stone with a flame standing about a metre out of
// it; this is that plus room for a dog to pass without singeing itself.
const FIRE_CLEAR = 1.25;
const ORBIT_MIN = 1.9;
const ORBIT_MAX = 3.4;
const REST_MIN = 1.7;            // …and where it chooses to lie down
const REST_MAX = 2.8;
// A camp on a hillside must still get a resting dog. The slope and relief
// gates below are PREFERENCES, enforced strictly while flat ground exists and
// relaxed step by step when repeated searches find none — the same courtesy
// every other camp object gets from standOn. At full relaxation the limits
// are wherever the rest poses' own ground-fitting clamps live (pitch 0.60,
// roll 0.45): the dog beds across the slope and the pose tilts with it.
const REST_RELAX_SLOPE = 0.52;   // fully relaxed slope gate
const REST_RELAX_RELIEF = 0.10;  // fully relaxed relief gate
const REST_CROSS_SLOPE = 0.15;   // above this, beds prefer the contour line
const WALK_SPEED = 0.78;         // m/s. A dog pottering, not going anywhere.
const DOG_CLEAR = 0.25;          // body radius used for path clearance
const REST_CLEAR = 0.12;         // extra empty ground around a sleeping dog
const REST_MAX_SLOPE = 0.18;     // tan(angle), about ten degrees
// Tuned against the DRAWN camp floor (see `surfaceAt` above), which carries
// ±2 cm of authored hummock texture the analytic field does not — the old
// 0.032, tuned against the smooth field, rejected honest beds for the crime
// of having the dirt's own detail under them.
const REST_MAX_RELIEF = 0.048;   // metres away from the fitted ground plane
const BACK_SPEED = 0.27;         // a careful two- or three-step retreat
const BACK_TIME = 1.15;          // long enough to open a useful reverse arc

const ST = { WANDER: 0, APPROACH: 1, SETTLE: 2, REST: 3, RISE: 4 };
const ST_NAME = ['wander', 'approach', 'settle', 'rest', 'rise'];

/**
 * One dog, belonging to one camp.
 *
 * Built from a shared prototype (see `dogProto`) so the geometry and the
 * skeleton description cost nothing per camp; only the bones and the material
 * are per-instance.
 */
export class CampDog {
  /**
   * @param {THREE.Group} parent    the camp's own root, so striking the camp
   *                                takes the dog with it
   * @param {object} site           { x, y, z } the fire
   * @param {function} rnd          the camp's seeded RNG — the dog a given camp
   *                                gets is a property of the site, not of when
   *                                you happened to pitch it
   * @param {object} world          needs `getHeight`
   */
  constructor(parent, site, rnd, world, opts = {}) {
    const protos = dogProto();
    if (!protos) throw new Error('[camp_dog] the model is not loaded; await warmDog()');
    const vi = pickDogVariant(rnd());
    this.proto = protos[vi];
    this.world = world;
    this.fire = { x: site.x, y: site.y, z: site.z };
    // The FIRE is an obstacle too, and listing it first is not decoration.
    // Everything else here works by pushing the dog away from props, and with
    // nothing standing at the centre those pushes happily shoved it inward —
    // measured at 0.90 m from the fire, which is inside the stone ring. A dog
    // is the one thing in this camp that must never be walked into the fire.
    this.obstacles = [{ x: site.x, z: site.z, r: FIRE_CLEAR }, ...(opts.obstacles ?? [])];
    // The surface to REST on. Walking rides the analytic heightfield like
    // every other animal — a paw sunk a centimetre into the dirt skin is
    // invisible — but a lying body is measured against the camp floor as
    // drawn (CampGround.surfaceAt), which sits centimetres proud of the
    // field on uneven sites.
    this.surfaceAt = opts.surfaceAt ?? ((x, z) => world.getHeight(x, z));

    // Every dog in the session shares one mesh, one skeleton and one set of
    // clips; only the bones and the mixer are per-animal. There is no material
    // per dog any more — the pack's dogs are painted, not tinted, so a coat is
    // a choice of which of the six meshes to wear (`variant.hide`) and all six
    // share the one `Color` material the GLB ships.
    const jit = 0.94 + rnd() * 0.12;
    this.scale = this.proto.scale * jit;
    this.rig = new GlbRig(this.proto, this.scale, DOG_SPECIES.gait, 'dog');
    this.mesh = this.rig.mesh;
    this.mesh.name = `camp_dog:${this.proto.variant.name}`;
    parent.add(this.mesh);

    // How much room a lying dog takes, for the ground-plane fit below. Off the
    // prototype's own bounds carrier — `GlbRig` has no `bodyLen`, and would be
    // the wrong place for one: it is a property of the model, measured once at
    // load, not of the animal playing it.
    const bb = this.proto.geoms[0].boundingBox;
    this.bodyLen = (bb.max.z - bb.min.z) * jit;
    this.bodyW = (bb.max.x - bb.min.x) * jit;

    this.rnd = rnd;
    this._t = 0;
    this.state = ST.WANDER;
    this.timer = rand(rnd, WANDER_TIME);
    this.pose = null;          // the pose being blended toward, or null
    this.blend = 0;            // 0 = up on its feet, 1 = fully settled

    // Polar wander state — see the note at the top of the file.
    this.ang = rnd() * Math.PI * 2;
    this.orbitDir = rnd() < 0.5 ? -1 : 1;
    this.angV = this.orbitDir * (0.16 + rnd() * 0.14);
    this.orbit = lerp(ORBIT_MIN, ORBIT_MAX, rnd());
    this.orbitT = 0;

    // Avoidance has memory. Without it an obstacle crossing the centre line
    // changes from "pass left" to "pass right" every other frame, which is the
    // visible shake the old stateless push-out produced.
    this.avoidSide = 0;
    this.avoidTimer = 0;
    this.blockedTime = 0;
    this.recovering = false;
    this.recoverTimer = 0;
    this.recoverStartX = 0;
    this.recoverStartZ = 0;
    this.restPlan = null;
    this.restGround = null;
    this.approachFinal = false;
    this.restRelax = 0;        // 0..1, eases the bed gates on slope-bound camps

    // The stuck watchdog: an anchor position, and how long the dog has failed
    // to get a body length away from it while supposedly going somewhere.
    this.stuckX = 0;
    this.stuckZ = 0;
    this.stuckT = 0;
    this.recoverCount = 0;
    this.respawns = 0;
    // The pen detector's position history: [t, x, z, t, x, z, ...] — and the
    // times of recent wall-contact recoveries, its second requirement.
    this.penTrail = [];
    this.penT = 0;
    this.recentRecover = [];

    this._buildNav();

    // Start it somewhere sensible on its own orbit, standing.
    const p = this._orbitPoint(this.ang, this.orbit);
    this.pos = new THREE.Vector3(p.x, world.getHeight(p.x, p.z), p.z);
    this.heading = this.ang + this.orbitDir * Math.PI * 0.5;
    this.speed = 0;
    this.target = new THREE.Vector3(p.x, 0, p.z);
    this.nearestClearance = this._clearanceAt(this.pos.x, this.pos.z);

    this.drive = {
      pos: this.pos, heading: this.heading, speed: 0,
      graze: 0, alert: 0, flag: 0, look: null, lod: 0,
      // Which rest clip to hold, and how far into it. `null` is a dog on its
      // feet; `GlbRig` spends the whole standing budget on the named one.
      rest: null, restW: 0,
    };
    this.rig.reset(this.pos, this.heading, world);
  }

  /** Human-readable state for the observation harness and diagnostics. */
  get stateName() { return ST_NAME[this.state] ?? 'unknown'; }

  /** Signed distance from the dog's body to the nearest camp obstacle. */
  _clearanceAt(x, z, pad = DOG_CLEAR) {
    let nearest = Infinity;
    for (const o of this.obstacles) {
      nearest = Math.min(nearest, Math.hypot(x - o.x, z - o.z) - o.r - pad);
    }
    return nearest;
  }

  /**
   * Resolve a desired point onto empty ground.
   *
   * This is for TARGETS, never for the live dog. Moving the live position out
   * of every overlapping circle in sequence was the old vibration bug: one
   * prop pushed east, its neighbour pushed west, and steering supplied a third
   * answer every frame. A target may be relaxed as much as necessary; the dog
   * itself only moves through collision-checked steps below.
   */
  _resolvePoint(x0, z0, pad = DOG_CLEAR, out = { x: 0, z: 0 }) {
    let x = x0, z = z0;
    for (let pass = 0; pass < 10; pass++) {
      let worst = null, worstGap = Infinity, worstD = 0;
      for (const o of this.obstacles) {
        const d = Math.hypot(x - o.x, z - o.z);
        const gap = d - o.r - pad;
        if (gap < worstGap) { worst = o; worstGap = gap; worstD = d; }
      }
      if (!worst || worstGap >= WALK_CLEAR + 0.02) { out.x = x; out.z = z; return out; }
      let dx = x - worst.x, dz = z - worst.z;
      if (worstD < 1e-4) {
        const a = this.ang + pass * 2.39996;
        dx = Math.sin(a); dz = Math.cos(a); worstD = 1;
      }
      const need = worst.r + pad + WALK_CLEAR + 0.03;
      x = worst.x + dx / worstD * need;
      z = worst.z + dz / worstD * need;
    }

    // Overlapping prop circles can have no common projection. Search a small
    // deterministic rosette around the requested point and take the nearest
    // genuinely clear sample instead of oscillating between the two circles.
    let bestX = x, bestZ = z, bestScore = this._clearanceAt(x, z, pad) - 10;
    for (let ring = 1; ring <= 5; ring++) {
      const rr = ring * 0.28;
      for (let i = 0; i < 16; i++) {
        const a = i / 16 * Math.PI * 2;
        const sx = x0 + Math.sin(a) * rr, sz = z0 + Math.cos(a) * rr;
        const clear = this._clearanceAt(sx, sz, pad);
        const score = clear >= WALK_CLEAR + 0.02 ? 10 - rr : clear - rr;
        if (score > bestScore) { bestScore = score; bestX = sx; bestZ = sz; }
      }
      if (bestScore > 9) break;
    }
    out.x = bestX; out.z = bestZ;
    return out;
  }

  /** A point on the orbit, resolved away from anything solid there. */
  _orbitPoint(ang, r, out = { x: 0, z: 0 }) {
    this._resolvePoint(
      this.fire.x + Math.sin(ang) * r,
      this.fire.z + Math.cos(ang) * r,
      DOG_CLEAR + 0.08,
      out,
    );
    // Snap into the yard — OUTWARD first. The push-out above knows circles;
    // it does not know that the pocket it landed in is a dead-end bay. At a
    // bearing where the orbit band is swallowed by a prop blob, the honest
    // walkable ground is the blob's far side, so march the radial outward and
    // take the first genuinely open cell. That turns "dive into the bay and
    // churn" into "swing wide around the tent", which is also just what a
    // dog rounding a camp does. Nearest-open is only the fallback.
    if (this.navFree) {
      const here = this._navCell(out.x, out.z);
      if (!this.navFree[here] || this.navWall[here] > 1.3) {
        const sx = Math.sin(ang), sz = Math.cos(ang);
        const rMax = ORBIT_MAX + 1.8;
        let found = false;
        for (let rr = r; rr <= rMax; rr += NAV_CELL * 0.75) {
          const x = this.fire.x + sx * rr, z = this.fire.z + sz * rr;
          const c = this._navCell(x, z);
          if (this.navFree[c] && this.navWall[c] <= 1.3) {
            out.x = x; out.z = z;
            found = true;
            break;
          }
        }
        if (!found) {
          const c = this._navNearestFree(here, true);
          if (c >= 0) {
            const n = this.navN;
            out.x = this.navMinX + ((c % n) + 0.5) * NAV_CELL;
            out.z = this.navMinZ + (((c / n) | 0) + 0.5) * NAV_CELL;
          }
        }
      }
    }
    return out;
  }

  /** Fit a stable local ground plane under a whole resting dog. */
  _surfaceAt(x, z, yaw) {
    const spanZ = Math.max(this.bodyLen, 0.90) * 0.5;
    const spanX = Math.max(this.bodyW, 0.45) * 0.5;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    // Sampled from the camp floor as drawn, not the analytic field — beds are
    // chosen on, and the body laid onto, the surface the player can see.
    const height = (side, fore) => this.surfaceAt(
      x + rx * side + fx * fore,
      z + rz * side + fz * fore,
    );
    const y = height(0, 0);
    const hF = height(0, spanZ), hR = height(0, -spanZ);
    const hRt = height(spanX, 0), hL = height(-spanX, 0);
    const gradeF = (hF - hR) / (spanZ * 2);
    const gradeR = (hRt - hL) / (spanX * 2);
    let relief = 0;
    for (const side of [-spanX, 0, spanX]) {
      for (const fore of [-spanZ, 0, spanZ]) {
        const expected = y + gradeR * side + gradeF * fore;
        relief = Math.max(relief, Math.abs(height(side, fore) - expected));
      }
    }
    return {
      y,
      pitch: clamp(-Math.atan(gradeF), -0.60, 0.60),
      roll: clamp(Math.atan(gradeR), -0.45, 0.45),
      slope: Math.hypot(gradeF, gradeR),
      relief,
    };
  }

  /** Choose a flat, clear bed and an approach line that arrives head-first. */
  _pickRestSpot() {
    let best = null, bestScore = -Infinity;
    const here = Math.atan2(this.pos.x - this.fire.x, this.pos.z - this.fire.z);
    const slopeMax = lerp(REST_MAX_SLOPE, REST_RELAX_SLOPE, this.restRelax);
    const reliefMax = lerp(REST_MAX_RELIEF, REST_RELAX_RELIEF, this.restRelax);
    for (let i = 0; i < 28; i++) {
      // Beds are searched AHEAD on the current meander, not at an arbitrary
      // bearing. The arbitrary draw often chose the far side of the fire, then
      // the shortest line to it ran through the furniture and sent avoidance
      // on a camp-wide detour. Walking another quarter-turn before settling is
      // both easier to solve and much more like an animal choosing a nearby pad.
      const a = here + this.orbitDir * lerp(0.38, 1.55, this.rnd());
      const r = lerp(REST_MIN, REST_MAX, this.rnd());
      const p = this._orbitPoint(a, r);
      const fireD = Math.hypot(p.x - this.fire.x, p.z - this.fire.z);
      const clear = this._clearanceAt(p.x, p.z);
      if (clear < REST_CLEAR || fireD < REST_MIN - 0.2 || fireD > REST_MAX + 0.7) continue;

      const toFire = Math.atan2(this.fire.x - p.x, this.fire.z - p.z);
      let yaw = toFire + (this.rnd() - 0.5) * 1.05;
      // On real slope, bed along the CONTOUR — the way a dog actually lies on
      // a hillside — so the pose carries the ground as roll (which its clamp
      // absorbs gracefully) rather than as head-down-the-hill pitch. Of the
      // two contour directions, keep the one nearer facing the fire.
      {
        const e = 0.35;
        const gx = (this.surfaceAt(p.x + e, p.z) - this.surfaceAt(p.x - e, p.z)) / (2 * e);
        const gz = (this.surfaceAt(p.x, p.z + e) - this.surfaceAt(p.x, p.z - e)) / (2 * e);
        const slope0 = Math.hypot(gx, gz);
        if (slope0 > REST_CROSS_SLOPE) {
          const cA = Math.atan2(gz, -gx);
          const cB = Math.atan2(-gz, gx);
          const contour = Math.abs(wrapAngle(cA - toFire)) <= Math.abs(wrapAngle(cB - toFire)) ? cA : cB;
          const s = clamp01((slope0 - REST_CROSS_SLOPE) / 0.12);
          yaw = yaw + wrapAngle(contour + (this.rnd() - 0.5) * 0.5 - yaw) * s;
        }
      }
      const ground = this._surfaceAt(p.x, p.z, yaw);
      if (ground.slope > slopeMax || ground.relief > reliefMax) continue;

      // Approach from behind the final pose. This is the animation fix as much
      // as it is path planning: the dog walks into its bed already facing the
      // way it will lie, rather than stopping and rotating like a turntable.
      const entryX = p.x - Math.sin(yaw) * 0.72;
      const entryZ = p.z - Math.cos(yaw) * 0.72;
      if (this._clearanceAt(entryX, entryZ) < WALK_CLEAR + 0.02) continue;

      const turn = Math.abs(wrapAngle(Math.atan2(entryX - this.pos.x, entryZ - this.pos.z) - this.heading));
      // |pitch| gets its own penalty on top of slope: lying nose-down the
      // hill is the reading that looks wrong, roll along it reads fine.
      const score = -ground.slope * 5 - Math.abs(ground.pitch) * 2.2 -
        ground.relief * 24 - turn * 0.16 +
        Math.min(clear, 0.5) * 0.2 + this.rnd() * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = { x: p.x, z: p.z, yaw, ground, entryX, entryZ, slopeMax, reliefMax };
      }
    }
    return best;
  }

  /** Minimum predicted clearance on a short straight feeler. */
  _pathClearance(heading, distance = 1.05) {
    const sx = Math.sin(heading), sz = Math.cos(heading);
    let clear = Infinity;
    for (const f of [0.28, 0.55, 0.82, 1]) {
      clear = Math.min(clear, this._clearanceAt(
        this.pos.x + sx * distance * f,
        this.pos.z + sz * distance * f,
      ));
    }
    return clear;
  }

  /**
   * Pick a clear heading while preserving the side already chosen around a prop.
   * Candidate headings are relative to the BODY, so even a target behind the
   * dog becomes a broad walking arc rather than an in-place rotation.
   */
  _chooseHeading(want, look = 1.05) {
    // The fan covers the FULL circle, not just the forward arc. The ±1.14
    // ceiling this had was the deep-pocket bug in person: a dog wedged between
    // the cooler and the tent could only escape on a heading ~1.5 rad off its
    // nose, no candidate that far round existed, and so it ground at the apex
    // until the watchdog teleported it. The wide offsets cost a little bias
    // (|off| term) and lose the cosine race whenever anything forward is clear,
    // so in the open they are never chosen — they exist for exactly the frame
    // where every forward candidate is blocked and "back the way I came" is
    // the only honest answer.
    const offsets = [0, 0.28, -0.28, 0.55, -0.55, 0.84, -0.84, 1.14, -1.14,
      1.5, -1.5, 1.9, -1.9, 2.4, -2.4, 3.0, -3.0];
    let best = this.heading, bestOffset = 0, bestScore = -Infinity;
    for (const off of offsets) {
      const candidate = this.heading + off;
      const clear = this._pathClearance(candidate, look);
      let score = Math.cos(wrapAngle(want - candidate)) * 1.55 +
        Math.min(clear, 0.65) * 1.15 - Math.abs(off) * 0.08;
      if (clear < WALK_CLEAR) score -= 30 + Math.abs(clear - WALK_CLEAR) * 20;
      if (this.avoidTimer > 0 && this.avoidSide && Math.sign(off) === -this.avoidSide) score -= 1.8;
      if (score > bestScore) { bestScore = score; best = candidate; bestOffset = off; }
    }

    if (Math.abs(bestOffset) > 0.2 && this._pathClearance(this.heading, look) < 0.38) {
      if (this.avoidTimer <= 0) this.avoidSide = Math.sign(bestOffset);
      this.avoidTimer = 1.15;
    }
    return best;
  }

  /**
   * The navigation grid, and why the dog stopped steering by feel.
   *
   * Every reactive scheme this file tried — stateless push-out, scored heading
   * fans, back-up-and-flip recovery, Bug-style wall-following — failed the
   * same measurable way: a camp's props form concave pockets, and a steerer
   * that re-scores against the target's pull every frame walks back into the
   * pocket it just left. The last reactive build still teleported a dog out
   * about once every ninety seconds on an ordinary layout.
   *
   * The obstacle set is at most a dozen static circles, so the honest answer
   * is cheap: rasterise walkable space once (about four thousand cells), and
   * A* over it whenever the target moves. The dog then chases the farthest
   * route point it has clear line of sight to, which straightens the grid
   * path into the same smooth arcs the old steering produced — but the route
   * is now guaranteed to exist, and a target with NO route is known
   * immediately and skipped instead of ground against.
   */
  _buildNav() {
    const R = ORBIT_MAX + 2.0;
    this.navMinX = this.fire.x - R;
    this.navMinZ = this.fire.z - R;
    this.navN = Math.ceil((R * 2) / NAV_CELL);
    const n = this.navN;
    this.navFree = new Uint8Array(n * n);
    this.navWall = new Float32Array(n * n);
    for (let iz = 0; iz < n; iz++) {
      const z = this.navMinZ + (iz + 0.5) * NAV_CELL;
      for (let ix = 0; ix < n; ix++) {
        const x = this.navMinX + (ix + 0.5) * NAV_CELL;
        const clear = this._clearanceAt(x, z);
        this.navFree[iz * n + ix] = clear > ROUTE_CLEAR ? 1 : 0;
        // Wall-adjacent cells are pricier, so routes run down the middle of
        // whatever space exists. Without this A* hugs every comfort boundary
        // — the shortest path always does — and the dog tracking it with a
        // damped heading oscillated below the boundary into blocked steps.
        this.navWall[iz * n + ix] = 1 + Math.max(0, 0.34 - clear) * 6;
      }
    }
    // Keep only the largest connected region — "the yard". On a cramped
    // layout the inflated prop circles merge with the fire ring into one
    // blob, and the comfort raster fragments into a big outer region plus
    // slivers pinched between props. A target in a sliver is reachable by
    // nobody; culling everything but the yard here means every point the
    // dog is ever ASKED to reach is connected to every other one, and A*
    // succeeds by construction. (Four-connected, which is never more
    // permissive than the A* neighbourhood below.)
    {
      const comp = new Int32Array(n * n).fill(-1);
      const stack = [];
      let bestComp = -1, bestCount = 0, id = 0;
      for (let i = 0; i < n * n; i++) {
        if (!this.navFree[i] || comp[i] !== -1) continue;
        let count = 0;
        stack.length = 0;
        stack.push(i);
        comp[i] = id;
        while (stack.length) {
          const c = stack.pop();
          count++;
          const cx = c % n, cz = (c / n) | 0;
          if (cx > 0 && this.navFree[c - 1] && comp[c - 1] === -1) { comp[c - 1] = id; stack.push(c - 1); }
          if (cx < n - 1 && this.navFree[c + 1] && comp[c + 1] === -1) { comp[c + 1] = id; stack.push(c + 1); }
          if (cz > 0 && this.navFree[c - n] && comp[c - n] === -1) { comp[c - n] = id; stack.push(c - n); }
          if (cz < n - 1 && this.navFree[c + n] && comp[c + n] === -1) { comp[c + n] = id; stack.push(c + n); }
        }
        if (count > bestCount) { bestCount = count; bestComp = id; }
        id++;
      }
      for (let i = 0; i < n * n; i++) {
        if (this.navFree[i] && comp[i] !== bestComp) this.navFree[i] = 0;
      }
    }
    // Scratch buffers for A*, reused across queries.
    this.navCost = new Float32Array(n * n);
    this.navFrom = new Int32Array(n * n);
    this.navOpen = [];
    this.navPath = [];
    this.navGoalX = 0;
    this.navGoalZ = 0;
    this.navTimer = 0;
  }

  _navCell(x, z) {
    const n = this.navN;
    const ix = clamp(Math.floor((x - this.navMinX) / NAV_CELL), 0, n - 1);
    const iz = clamp(Math.floor((z - this.navMinZ) / NAV_CELL), 0, n - 1);
    return iz * n + ix;
  }

  /**
   * Nearest free cell to `c`, searched in growing rings. With `open`, prefer
   * a cell with real elbow room — a target snapped to the first barely-free
   * cell sits against a wall, and a dog asked to stand against a wall arrives
   * fast, turns badly, and churns. Falls back to any free cell.
   */
  _navNearestFree(c, open = false) {
    const n = this.navN;
    if (this.navFree[c] && (!open || this.navWall[c] <= 1.3)) return c;
    let anyFree = this.navFree[c] ? c : -1;
    const cx = c % n, cz = (c / n) | 0;
    for (let ring = 1; ring <= 24; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const ix = cx + dx, iz = cz + dz;
          if (ix < 0 || iz < 0 || ix >= n || iz >= n) continue;
          const cc = iz * n + ix;
          if (!this.navFree[cc]) continue;
          if (!open || this.navWall[cc] <= 1.3) return cc;
          if (anyFree < 0) anyFree = cc;
        }
      }
    }
    return anyFree;
  }

  /**
   * A* from the dog to (tx, tz). Fills `navPath` with world-space points from
   * the dog outward and returns true, or returns false for "no route exists".
   */
  _route(tx, tz) {
    const n = this.navN;
    const start = this._navNearestFree(this._navCell(this.pos.x, this.pos.z));
    const goal = this._navNearestFree(this._navCell(tx, tz));
    this.navPath.length = 0;
    if (start < 0 || goal < 0) return false;
    if (start === goal) return true;

    const cost = this.navCost, from = this.navFrom, open = this.navOpen;
    cost.fill(Infinity);
    from.fill(-1);
    open.length = 0;
    const gx = goal % n, gz = (goal / n) | 0;
    const h = (c) => {
      const dx = Math.abs((c % n) - gx), dz = Math.abs(((c / n) | 0) - gz);
      return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
    };
    cost[start] = 0;
    open.push([h(start), start]);
    let found = false;
    while (open.length) {
      // The open list is tiny (a few hundred entries at worst on this grid);
      // a linear min-scan beats maintaining a heap at this size.
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
      const [, c] = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      if (c === goal) { found = true; break; }
      const cx = c % n, cz = (c / n) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const ix = cx + dx, iz = cz + dz;
          if (ix < 0 || iz < 0 || ix >= n || iz >= n) continue;
          const nc = iz * n + ix;
          if (!this.navFree[nc]) continue;
          // No cutting corners diagonally between two blocked cells.
          if (dx && dz && (!this.navFree[cz * n + ix] || !this.navFree[iz * n + cx])) continue;
          const g = cost[c] + (dx && dz ? 1.4142 : 1) * this.navWall[nc];
          if (g < cost[nc]) {
            cost[nc] = g;
            from[nc] = c;
            open.push([g + h(nc), nc]);
          }
        }
      }
    }
    if (!found) return false;
    for (let c = goal; c !== -1; c = from[c]) {
      this.navPath.push(
        this.navMinX + ((c % n) + 0.5) * NAV_CELL,
        this.navMinZ + (((c / n) | 0) + 0.5) * NAV_CELL,
      );
    }
    this.navPath.reverse();
    // reverse() on the flat array flipped each pair too; swap them back.
    for (let i = 0; i + 1 < this.navPath.length; i += 2) {
      const t = this.navPath[i];
      this.navPath[i] = this.navPath[i + 1];
      this.navPath[i + 1] = t;
    }
    return true;
  }

  /**
   * Is the straight run from the dog to (x, z) walkable?
   *
   * The pad is generous, but a dog already standing nearer a prop than the
   * pad allows must not have every sight line refused on its own account —
   * that failure mode disabled string-pulling exactly when the dog most
   * needed a good waypoint. A segment may pass a prop as closely as the dog
   * already is (never closer than the body's own walkable minimum), so lines
   * that hold distance or move away always count as clear.
   */
  _segmentClear(x, z) {
    const ax = this.pos.x, az = this.pos.z;
    const dx = x - ax, dz = z - az;
    const len2 = dx * dx + dz * dz;
    for (const o of this.obstacles) {
      const t = len2 > 1e-8
        ? clamp01(((o.x - ax) * dx + (o.z - az) * dz) / len2)
        : 0;
      const px = ax + dx * t - o.x, pz = az + dz * t - o.z;
      const startD = Math.hypot(ax - o.x, az - o.z);
      // The floor is the step-check's own minimum — a line the dog cannot
      // legally walk must never be reported as a clear sight line.
      const limit = Math.min(
        o.r + DOG_CLEAR + 0.08,
        Math.max(startD - 0.005, o.r + DOG_CLEAR + WALK_CLEAR),
      );
      if (Math.hypot(px, pz) < limit) return false;
    }
    return true;
  }

  /**
   * The heading to walk RIGHT NOW to reach the current target: straight at it
   * when the line is clear, else along a fresh A* route, else — no route at
   * all — the target is skipped and the dog aims where it was already going.
   */
  _navHeading(dt) {
    const tx = this.target.x, tz = this.target.z;
    this.navTimer -= dt;
    const moved = Math.hypot(tx - this.navGoalX, tz - this.navGoalZ);
    if (this._segmentClear(tx, tz)) {
      this.navPath.length = 0;
      this.navTimer = 0;
      this.navGoalX = tx; this.navGoalZ = tz;
      return Math.atan2(tx - this.pos.x, tz - this.pos.z);
    }
    if (this.navTimer <= 0 || moved > 0.35 || !this.navPath.length) {
      this.navGoalX = tx; this.navGoalZ = tz;
      this.navTimer = 0.55;
      if (!this._route(tx, tz)) {
        // Provably unreachable. Ask for something else instead of grinding.
        this.navPath.length = 0;
        if (this.state === ST.APPROACH) this._abandonRestSpot();
        else this.ang += this.orbitDir * 0.8;
        return this.heading;
      }
    }
    // Chase the farthest route point in clear line of sight — string-pulling,
    // one segment deep. Falls back to the nearest few cells when the route
    // hugs a wall too closely for the padded sight line.
    const P = this.navPath;
    let wx = tx, wz = tz, seen = false;
    for (let i = P.length - 2; i >= 0; i -= 2) {
      if (this._segmentClear(P[i], P[i + 1])) { wx = P[i]; wz = P[i + 1]; seen = true; break; }
    }
    if (!seen && P.length >= 2) {
      // No route point passes the padded sight line — the route bends hard
      // around something close. Chase the first point comfortably OUTSIDE the
      // turning circle: a nearer carrot is unreachable at the minimum turn
      // radius and the dog orbits it in place forever (measured — the little
      // circles all over the first trajectory plot were exactly this).
      wx = P[P.length - 2]; wz = P[P.length - 1];
      for (let i = 0; i + 1 < P.length; i += 2) {
        if (Math.hypot(P[i] - this.pos.x, P[i + 1] - this.pos.z) >= 0.60) {
          wx = P[i]; wz = P[i + 1];
          break;
        }
      }
    }
    return Math.atan2(wx - this.pos.x, wz - this.pos.z);
  }

  /** Score a curved reverse path. Positive `side` turns left, negative right. */
  _reverseClearance(side) {
    let x = this.pos.x, z = this.pos.z, heading = this.heading;
    let minClear = this._clearanceAt(x, z);
    const steps = 10;
    const stepTime = BACK_TIME / steps;
    for (let i = 0; i < steps; i++) {
      heading += side * 0.72 * stepTime;
      x -= Math.sin(heading) * BACK_SPEED * stepTime;
      z -= Math.cos(heading) * BACK_SPEED * stepTime;
      minClear = Math.min(minClear, this._clearanceAt(x, z));
    }
    const endClear = this._clearanceAt(x, z);
    return minClear * 2.5 + endClear;
  }

  _beginRecovery(sideHint = 0) {
    if (this.recovering) return;
    // Backing up only helps if the PULL changes too. The orbit target sweeps
    // past a big prop at a fraction of a radian per second, so for many
    // seconds after a recovery it goes on dragging the dog into the same
    // pocket it just backed out of — measured, that loop was a respawn every
    // couple of minutes. So each fresh recovery skips the wander target past
    // the blockage, and a pocket that survives repeated recoveries means this
    // whole side of the camp is a dead end: reverse the orbit. An approach
    // that needs rescuing twice gives its bed up rather than grinding at it.
    if (!sideHint) {
      this.recoverCount++;
      this.recentRecover.push(this._t);
      // The first recovery since real progress is ordinary behaviour — a dog
      // that touched a prop, braking and backing up — and its opening second
      // covers almost no ground on purpose. Restart the stuck clock for it so
      // the two-second fuse judges the RESULT of the back-up, not the back-up
      // itself. Only the first: a wedged dog fails this recovery inside 1.2 s
      // and every retry after that burns the fuse, so a dog that truly cannot
      // move is still gone in about three seconds.
      if (this.recoverCount === 1) {
        this.stuckX = this.pos.x;
        this.stuckZ = this.pos.z;
        this.stuckT = 0;
      }
      if (this.state === ST.APPROACH && this.recoverCount >= 2) {
        this._abandonRestSpot();
      } else if (this.state === ST.WANDER) {
        if (this.recoverCount >= 3) {
          this.orbitDir *= -1;
          this.angV = this.orbitDir * Math.max(0.16, Math.abs(this.angV));
          this.ang = Math.atan2(this.pos.x - this.fire.x, this.pos.z - this.fire.z) +
            this.orbitDir * 0.5;
        } else {
          this.ang += this.orbitDir * 0.55;
        }
      }
    }
    if (sideHint) {
      this.avoidSide = sideHint;
    } else {
      // This is a BACKING manoeuvre, so score the path the hindquarters will
      // actually take. Looking forward here chose the safe side for the nose
      // and often steered the rump straight into the tent behind it.
      const left = this._reverseClearance(1);
      const right = this._reverseClearance(-1);
      this.avoidSide = left >= right ? 1 : -1;
    }
    this.avoidTimer = 1.5;
    this.recovering = true;
    this.recoverTimer = BACK_TIME;
    this.recoverStartX = this.pos.x;
    this.recoverStartZ = this.pos.z;
    this.blockedTime = 0;
  }

  _resumeOrbitFromHeading() {
    const a = Math.atan2(this.pos.x - this.fire.x, this.pos.z - this.fire.z);
    const plus = Math.abs(wrapAngle(a + Math.PI * 0.5 - this.heading));
    const minus = Math.abs(wrapAngle(a - Math.PI * 0.5 - this.heading));
    this.orbitDir = plus <= minus ? 1 : -1;
    this.ang = a + this.orbitDir * 0.32;
    this.angV = this.orbitDir * Math.max(0.16, Math.abs(this.angV));
  }

  /**
   * The pathing gave up: put the dog somewhere clear on its orbit and carry on.
   *
   * Candidates are drawn round the whole ring and scored for clearance and for
   * distance from the camera — the pop is unavoidable, but it can at least
   * prefer to happen behind the player's back. The rig is reset so the dog
   * arrives standing on freshly planted feet rather than dragging four feet
   * anchored across the camp.
   */
  _respawn(camPos) {
    let bestX = 0, bestZ = 0, bestA = 0, bestScore = -Infinity;
    for (let i = 0; i < 40; i++) {
      const a = this.rnd() * Math.PI * 2;
      const r = lerp(ORBIT_MIN, ORBIT_MAX, this.rnd());
      const x = this.fire.x + Math.sin(a) * r;
      const z = this.fire.z + Math.cos(a) * r;
      const clear = this._clearanceAt(x, z);
      if (clear < RESPAWN_CLEAR) continue;
      if (!this.navFree[this._navCell(x, z)]) continue;
      const camD = camPos ? Math.hypot(x - camPos.x, z - camPos.z) : 10;
      const score = Math.min(clear, 0.8) + Math.min(camD, 14) * 0.15;
      if (score > bestScore) { bestScore = score; bestX = x; bestZ = z; bestA = a; }
    }
    if (bestScore === -Infinity) {
      // A camp so cluttered no ring point clears: take the least-bad answer
      // the target resolver can produce and let the watchdog try again.
      const p = this._orbitPoint(this.rnd() * Math.PI * 2, ORBIT_MAX);
      bestX = p.x; bestZ = p.z;
      bestA = Math.atan2(bestX - this.fire.x, bestZ - this.fire.z);
    }

    this.pos.set(bestX, this.world.getHeight(bestX, bestZ), bestZ);
    this.ang = bestA;
    this.orbitDir = this.rnd() < 0.5 ? -1 : 1;
    this.angV = this.orbitDir * 0.16;
    this.heading = bestA + this.orbitDir * Math.PI * 0.5;
    this.speed = 0;
    this.state = ST.WANDER;
    this.timer = rand(this.rnd, WANDER_TIME);
    this.blend = 0;
    this.pose = null;
    this.restPlan = null;
    this.restGround = null;
    this.approachFinal = false;
    this.recovering = false;
    this.avoidSide = 0;
    this.avoidTimer = 0;
    this.blockedTime = 0;
    this.navPath.length = 0;
    this.navTimer = 0;
    this.stuckX = bestX;
    this.stuckZ = bestZ;
    this.stuckT = 0;
    this.recoverCount = 0;
    this.penTrail.length = 0;
    this.penT = 0;
    this.recentRecover.length = 0;
    const p = this._orbitPoint(this.ang + this.orbitDir * 0.3, this.orbit);
    this.target.set(p.x, 0, p.z);
    this.rig.reset(this.pos, this.heading, this.world);
    this.respawns++;
  }

  _abandonRestSpot() {
    this.restPlan = null;
    this.approachFinal = false;
    this.state = ST.WANDER;
    this.timer = 3 + this.rnd() * 3;
    this._resumeOrbitFromHeading();
  }

  update(dt, camPos) {
    const W = this.world;
    this._t += dt;
    this.timer -= dt;
    this.avoidTimer = Math.max(0, this.avoidTimer - dt);

    // ── the loop ────────────────────────────────────────────────────────────
    switch (this.state) {
      case ST.WANDER: {
        // The rate breathes, but its SIGN stays fixed for this wander. The old
        // integrated sine crossed zero while the body's heading still pointed
        // around the other way; the target jumped behind it and the dog had no
        // choice but to pivot. A dog can change direction after a rest, when it
        // has a natural chance to pick the nearer tangent.
        const orbitRate = 0.17 + 0.12 * (0.5 + 0.5 * Math.sin(this._t * 0.37));
        this.angV = damp(this.angV, this.orbitDir * orbitRate, 1.1, dt);
        this.ang += this.angV * dt;
        this.orbitT += dt;
        this.orbit = lerp(ORBIT_MIN, ORBIT_MAX,
          0.5 + 0.5 * Math.sin(this.orbitT * 0.23 + this.ang * 0.7));
        const p = this._orbitPoint(this.ang, this.orbit);
        this.target.set(p.x, 0, p.z);
        if (this.timer <= 0) {
          const spot = this._pickRestSpot();
          if (spot) {
            this.restPlan = spot;
            this.approachFinal = false;
            this.target.set(spot.entryX, 0, spot.entryZ);
            this.state = ST.APPROACH;
            this.timer = APPROACH_TIME;
          } else {
            // No honest bed at the current standards: wander a little further
            // and ask again from another part of camp — with the standards
            // eased a step. On a hillside camp nothing ever passes the strict
            // gates, and a dog that can never lie down is worse than one bedded
            // across the slope; three failed searches reach full relaxation.
            this.restRelax = Math.min(1, this.restRelax + 0.34);
            this.timer = 2.5 + this.rnd() * 2.5;
          }
        }
        break;
      }
      case ST.APPROACH: {
        const plan = this.restPlan;
        if (!plan || this.timer <= 0) {
          // The old path settled when this timer expired, wherever the dog had
          // got stuck. That is how it lay down inside props and on bad ground.
          this._abandonRestSpot();
          break;
        }
        if (!this.approachFinal) {
          const entryD = Math.hypot(plan.entryX - this.pos.x, plan.entryZ - this.pos.z);
          if (entryD < 0.36) {
            this.approachFinal = true;
            // The outer route owns most of APPROACH_TIME. Once the entry is
            // genuinely reached, give the short walk-in its own small window
            // rather than abandoning a valid bed one stride before it.
            this.timer = Math.max(this.timer, 4);
            // Aim a hand-span THROUGH the bed. Crossing the point lines the
            // shoulders up with the rest pose; targeting the point itself makes
            // steering undefined exactly at the instant the dog must stop.
            this.target.set(
              plan.x + Math.sin(plan.yaw) * 0.12,
              0,
              plan.z + Math.cos(plan.yaw) * 0.12,
            );
          }
        } else {
          const spotD = Math.hypot(plan.x - this.pos.x, plan.z - this.pos.z);
          if (spotD < 0.24) {
            const ground = this._surfaceAt(this.pos.x, this.pos.z, this.heading);
            if (ground.slope > (plan.slopeMax ?? REST_MAX_SLOPE) ||
                ground.relief > (plan.reliefMax ?? REST_MAX_RELIEF) ||
                this._clearanceAt(this.pos.x, this.pos.z) < REST_CLEAR * 0.5) {
              this._abandonRestSpot();
              break;
            }
            this.restRelax = 0;
            this.state = ST.SETTLE;
            this.timer = SETTLE_TIME;
            this.pose = pickPose(this.rnd());
            this.restGround = ground;
            // Speed is NOT zeroed here. Cutting it in one frame put a full
            // -0.5 m/s step through everything the rig derives from speed —
            // surge, bob, the neck's reach — and the head visibly snapped at
            // the instant the dog began to fold. The not-moving branch below
            // damps it to nothing inside a couple of strides of the settle.
            this.recovering = false;
          }
        }
        break;
      }
      case ST.SETTLE:
        // Smoothstepped, and so is the rise below: a linear ramp starts the
        // whole-body fold at full speed in a single frame, and the head's share
        // of that step read as a snap at every transition boundary.
        this.blend = ease01(clamp01(1 - this.timer / SETTLE_TIME));
        if (this.timer <= 0) {
          this.blend = 1;
          this.state = ST.REST;
          this.timer = rand(this.rnd, REST_TIME);
        }
        break;
      case ST.REST:
        this.blend = 1;
        if (this.timer <= 0) { this.state = ST.RISE; this.timer = RISE_TIME; }
        break;
      case ST.RISE:
        this.blend = ease01(clamp01(this.timer / RISE_TIME));
        if (this.timer <= 0) {
          this.blend = 0;
          // `pose` and `restGround` are NOT cleared here: the head chain is
          // still unfolding on its own lagged blend and needs the pose to
          // finish against. The cleanup below drops both once it has.
          this.restPlan = null;
          this.state = ST.WANDER;
          this.timer = rand(this.rnd, WANDER_TIME);
          // Pick the tangent nearest the direction it is already facing, then
          // put the new target a little way along it. Standing up is followed
          // by a forward step, never a 180-degree turn in place.
          this._resumeOrbitFromHeading();
        }
        break;
    }

    // ── steering ────────────────────────────────────────────────────────────
    const moving = this.state === ST.WANDER || this.state === ST.APPROACH;
    if (moving) {
      const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (this.recovering) {
        this.recoverTimer -= dt;
        // Backing while turning opens a new forward arc. The locomotion rig is
        // deliberately given zero gait speed below, so its existing one-foot
        // standing shuffle supplies the little reverse steps instead of playing
        // a forward walk backwards.
        this.speed = damp(this.speed, -BACK_SPEED, 5, dt);
        const backTurn = Math.min(0.72, Math.max(0, -this.speed) * 2.8);
        this.heading += this.avoidSide * backTurn * dt;
        if (this.recoverTimer <= 0) {
          const moved = Math.hypot(
            this.pos.x - this.recoverStartX,
            this.pos.z - this.recoverStartZ,
          );
          this.recovering = false;
          if (moved < 0.04) {
            // Commit to one whole reverse arc before trying the other side.
            // The old 0.28 s flip reversed the turn before the body had moved,
            // producing the exact left-right wavering in the supplied video.
            this._beginRecovery(-this.avoidSide);
          } else {
            // Turning the body left while reversing moves the dog to its right,
            // and vice versa. Carry that SPATIAL side into the forward walk so
            // the target cannot immediately pull it back through the pocket it
            // just escaped. This turns back-up + walk-around into one manoeuvre.
            this.avoidSide *= -1;
            this.avoidTimer = 2.8;
            this.blockedTime = 0;
            // The dog physically hit something the raster judged walkable, so
            // its route is suspect: force a fresh one next frame.
            this.navTimer = 0;
          }
        }
      } else {
        // Where to aim is the router's answer, not the target's bearing —
        // straight at the target when the line is clear, along the A* route
        // when it is not. The fan below still smooths and locally avoids.
        const want = this._navHeading(dt);
        // On the last few steps, only inspect the path up to the bed. Looking
        // a full metre THROUGH it sees the fire beyond the intended stopping
        // point and makes avoidance turn away at the exact moment the dog is
        // lined up to settle.
        const look = this.approachFinal ? Math.min(0.55, d + 0.10) : 1.05;
        const chosen = this._chooseHeading(want, look);
        const turn = wrapAngle(chosen - this.heading);
        // Yaw is curvature: no ground speed means no heading change. Scaling
        // the turn limit from the speed structurally rules out a pivot after
        // rising or when a target changes behind the dog. The 4.0 sets the
        // minimum turn radius at 20 cm — tight enough to take a waypoint at
        // 0.6 m from any approach angle, still an arc and never a pivot.
        const turnRate = Math.min(1.35, Math.max(0, this.speed) * 5.0);
        this.heading += clamp(turn, -turnRate * dt, turnRate * dt);
        // Keep walking through a turn. Even the tightest allowed corner keeps
        // forty percent of walking speed, so the body's yaw describes an arc
        // in the ground plane instead of a pivot at zero speed.
        const turnScale = lerp(0.42, 1, clamp01(1 - Math.abs(turn) / 1.15));
        const nearScale = clamp01(d / (this.approachFinal ? 0.45 : 0.72));
        // Tight quarters get a careful walk. At full stride against a wall,
        // the damped heading overshoots into blocked steps and recovery; the
        // same passage threaded at half speed just works.
        const wallScale = lerp(0.45, 1,
          clamp01((this.nearestClearance - WALK_CLEAR) / 0.30));
        let wantSpeed = d < 0.12 ? 0 : WALK_SPEED * turnScale * nearScale * wallScale;
        // Keep a real creeping step under the last heading correction. The
        // transition test above will stop it at the bed; dropping to zero here
        // one frame earlier recreated the exact ugly pivot this path is meant
        // to remove.
        if (this.approachFinal && d < 0.28) wantSpeed = Math.max(wantSpeed, WALK_SPEED * 0.24);
        this.speed = damp(this.speed, wantSpeed, 3.5, dt);
      }
    } else {
      this.recovering = false;
      this.speed = damp(this.speed, 0, 6, dt);
    }

    // Collision is a rejected step, never a positional correction. That one
    // distinction removes the fight that made the dog shake against objects.
    if (moving && Math.abs(this.speed) > 1e-4) {
      const nx = this.pos.x + Math.sin(this.heading) * this.speed * dt;
      const nz = this.pos.z + Math.cos(this.heading) * this.speed * dt;
      const clearNow = this._clearanceAt(this.pos.x, this.pos.z);
      const clearNext = this._clearanceAt(nx, nz);
      // A dog already inside the margin — a settle plan gone marginal, a prop
      // footprint's rounding — must still be able to walk out. Any step that
      // monotonically improves its clearance is allowed; it remains
      // collision-safe and leaves visibly instead of being teleported.
      const escapingOverlap = clearNow < WALK_CLEAR && clearNext > clearNow + 1e-6;
      if (clearNext >= WALK_CLEAR - 0.002 || escapingOverlap) {
        this.pos.x = nx; this.pos.z = nz;
        this.blockedTime = Math.max(0, this.blockedTime - dt * 2);
      } else {
        this.blockedTime += dt;
        if (!this.recovering && this.blockedTime > 0.34) this._beginRecovery();
      }
    }
    this.nearestClearance = this._clearanceAt(this.pos.x, this.pos.z);
    this.pos.y = W.getHeight(this.pos.x, this.pos.z);

    // ── the stuck watchdog ──────────────────────────────────────────────────
    // Recovery above handles the ordinary pocket; this is the guarantee behind
    // it. A moving dog that has not managed a body length of net progress in
    // STUCK_TIME — recovery attempts included — is in a pocket the steering
    // cannot solve, and is respawned somewhere clear on its orbit.
    if (moving) {
      if (Math.hypot(this.pos.x - this.stuckX, this.pos.z - this.stuckZ) > STUCK_MOVE) {
        this.stuckX = this.pos.x; this.stuckZ = this.pos.z; this.stuckT = 0;
        this.recoverCount = 0;
      } else {
        this.stuckT += dt;
        if (this.stuckT > STUCK_TIME) this._respawn(camPos);
      }
      // The pen detector — see PEN_TIME. Sampled a few times a second; fires
      // when a full window of history fits inside a box no dog could walk in
      // AND the window saw repeated wall contact. Both halves matter: the box
      // alone also matches legitimate slow phases (the spawn ramp-up, a short
      // walk to a bed picked close by), but those never touch anything — a
      // caged dog bumps constantly. The final creep into a bed is deliberate,
      // slow and already bounded by its own timer, so it clears the history
      // rather than being judged by it.
      if (this.approachFinal) {
        this.penTrail.length = 0;
        this.penT = 0;
      }
      this.penT += dt;
      while (this.recentRecover.length && this.recentRecover[0] < this._t - PEN_TIME - 0.25) {
        this.recentRecover.shift();
      }
      if (!this.approachFinal && this.penT >= 0.25) {
        this.penT = 0;
        const T = this.penTrail;
        T.push(this._t, this.pos.x, this.pos.z);
        while (T.length && T[0] < this._t - PEN_TIME - 0.25) T.splice(0, 3);
        if (T.length >= 3 && this._t - T[0] > PEN_TIME && this.recentRecover.length >= 2) {
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
          for (let i = 0; i < T.length; i += 3) {
            if (T[i + 1] < minX) minX = T[i + 1];
            if (T[i + 1] > maxX) maxX = T[i + 1];
            if (T[i + 2] < minZ) minZ = T[i + 2];
            if (T[i + 2] > maxZ) maxZ = T[i + 2];
          }
          if (Math.max(maxX - minX, maxZ - minZ) < PEN_SPAN) this._respawn(camPos);
        }
      }
    } else {
      this.stuckX = this.pos.x; this.stuckZ = this.pos.z; this.stuckT = 0;
      this.penTrail.length = 0;
      this.penT = 0;
    }

    // ── the gait solver, then the pose over the top of it ───────────────────
    this.drive.heading = this.heading;
    this.drive.speed = Math.max(0, this.speed);
    // The rest pose, as a clip and a weight. `blend` is the same settle clock
    // it has always been — smoothstepped over SETTLE_TIME going down and
    // RISE_TIME coming up — and now it is a clip weight rather than the mix
    // factor of a hand-authored pose. Nothing about WHEN the dog settles
    // changed; only what happens when it does.
    this.drive.rest = this.pose;
    this.drive.restW = this.blend;
    this.drive.lod = camPos && camPos.distanceToSquared(this.pos) > 58 * 58 ? 1 : 0;
    this.rig.update(dt, this.drive, W);

    // A lying dog's support plane is chosen once, and it is the CAMP FLOOR as
    // drawn rather than the analytic field `GlbRig._tilt` rides — a body laid
    // on the second reads as buried to the brisket on an uneven site. So the
    // rig's own answer is overwritten here, on the same settle clock as
    // everything else, and only once there is a plane to overwrite it with.
    if (this.restGround && this.blend > 0.001) {
      const w = this.blend;
      this.mesh.position.y = lerp(this.mesh.position.y, this.restGround.y, w);
      this.mesh.rotation.x = lerp(this.mesh.rotation.x, this.restGround.pitch, w);
      this.mesh.rotation.z = lerp(this.mesh.rotation.z, this.restGround.roll, w);
    }
    // Let go of the pose once the dog is fully up. `GlbRig` damps its own
    // weights, so this waits for the clip to be gone rather than for the
    // clock — dropping `pose` while the crossfade is still running would
    // strand the dog half-curled.
    if (this.pose && this.blend <= 0.001 &&
        (this.state === ST.WANDER || this.state === ST.APPROACH) &&
        this.rig.bRest[this.pose] < 0.01) {
      this.pose = null;
      this.restGround = null;
    }
  }

  dispose() {
    this.rig.dispose();
  }
}

// ── the shared prototype ─────────────────────────────────────────────────────
//
// Fetched on first use rather than at module load: this file is imported by
// `Camp`, and a 1.9 MB GLB on the boot path for a feature that one camp in five
// never reaches is the wrong trade. Fetched once and then shared by every dog
// in the session — one mesh, one skeleton, one set of clips.
//
// The await is the whole difference from the blueprint this replaces, and it is
// why `warmDog` exists: `CampDog`'s constructor is synchronous and is called
// mid-pitch, so the load has to have already happened. `Camp` awaits it under
// the loading screen with everything else it pre-warms.
let _protos = null;
let _loading = null;

/** The loaded prototypes, or null if `warmDog` has not finished. */
export function dogProto() { return _protos; }

/** Fetch the model — awaited by the camp pre-warm, under the loader. */
export function warmDog() {
  if (_protos) return Promise.resolve(_protos);
  if (!_loading) _loading = loadCampDog().then((p) => { _protos = p; return p; });
  return _loading;
}

export function disposeDogProtos() {
  if (!_protos) return;
  for (const p of _protos) for (const g of p.geoms) g.dispose();
  _protos = null;
  _loading = null;
}

// The gait ladder `GlbRig` bands against. `DOG_SPECIES.gait` is the record, and
// `loadGlbSpecies` overwrites its walk and run with what it measures off the
// clips at load — so this is a reference to the loaded numbers, not a copy of
// the written ones. The whole solver-shaped block that used to be here (stride,
// duty, bob, pitch, lift, graze rake, carriage follow) belonged to `AnimRig`
// and went with it: an authored clip carries all of that already.
function pickDogVariant(r) {
  // Off the species record rather than a copy of its numbers, which had already
  // drifted once: `DOG_SPECIES.variants` carried the weights and this carried
  // them again.
  const v = DOG_SPECIES.variants;
  let acc = 0;
  for (let i = 0; i < v.length; i++) { acc += v[i].weight; if (r < acc) return i; }
  return v.length - 1;
}

function pickPose(r) {
  let acc = 0;
  for (const p of POSE_PICK) { acc += p.w; if (r < acc) return p.key; }
  return POSE_PICK[0].key;
}

const rand = (rnd, [a, b]) => a + rnd() * (b - a);
const ease01 = (u) => u * u * (3 - 2 * u);

// `DOG_POSES` used to be the pose TABLES; it is the three clip names now, which
// is all anything outside this file ever wanted from it (the gallery offers
// them as buttons).
export const DOG_POSES = POSE_PICK.map((p) => p.key);
export { ST as DOG_ST };
export const DOG_GAIT_CFG = DOG_SPECIES.gait;
// Re-exported so the gallery adapter reads the record through this file's
// front door, the way every other camp entry does.
export { DOG_SPECIES };
