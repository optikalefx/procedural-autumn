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
//  The dog's BODY is not here. It is the same lofted quadruped every mammal in
//  the game is built from (`animal_species`/`animal_rig`), and it walks on the
//  same procedural gait solver they do (`animal_anim`) — which is what makes it
//  worth having at all: a dog that mills around a fire gets world-anchored feet
//  and a real four-beat walk for free, and cannot skate.
//
//  What is here is the two things that solver cannot do:
//
//    · **the rest poses.** `AnimRig` knows stand, graze, alert and three gaits.
//      It has no idea how to sit, and it structurally cannot work one out: it
//      solves each leg by IK to a foot planted on the ground, and a sitting dog
//      has its hocks flat along the ground and its pelvis resting between them.
//      So the poses below are authored per-bone and blended OVER the solver's
//      output, after it has run. See `POSES`.
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
import { buildCampDog, createHideMaterial } from '../wildlife/animal_species.js';
import { instantiate } from '../wildlife/animal_rig.js';
import { AnimRig } from '../wildlife/animal_anim.js';

// ── the rest poses ───────────────────────────────────────────────────────────
//
// Authored as local bone rotations in the rig's own convention, which is worth
// writing down once because every sign below depends on it and none of it is
// guessable:
//
//   root.position.y   sinks the whole animal. The root bone sits at ground
//                     level between the feet, so this is "how far the body
//                     drops", in unscaled model metres. `push` is the same
//                     thing along z.
//   root.rotation.x   NEGATIVE tips the rear down and the chest up. Useful in
//                     small amounts and a trap in large ones — see the sit.
//   leg .x            POSITIVE swings the limb backward, negative forward.
//                     (A leg bone points down; +X rotation carries -Y toward -Z.)
//   neck/head .x      POSITIVE is down. (Those bones point up and forward.)
//   tail .x           POSITIVE lifts. (The tail points down and back.)
//   .y                POSITIVE yaws toward the dog's right.
//
// `drop` and the leg angles have to agree with each other or the dog either
// floats or sinks through the ground — there is no IK here to catch it, which
// is the price of authoring the poses at all.
const POSES = {
  // ── curled ────────────────────────────────────────────────────────────────
  // The comma. Reference `curled-up-2.jpg`: the spine arcs through most of a
  // half-circle in the horizontal plane, the hindquarters make a high rounded
  // dome, and the nose comes all the way round to rest by the front paws. The
  // yaw is cumulative down the chain — each bone adds to its parent's — which
  // is why the numbers look small and the result is a 110° arc.
  curl: {
    drop: -0.250, pitch: 0.02, roll: -0.08, w: 1,
    bones: {
      // The BACK makes the C, not the neck. The first cut put most of the yaw
      // in the neck and the result was a straight dog with its head turned
      // round — a swan, not a comma. The spine carries 1.38 rad of it now and
      // the neck only finishes the arc.
      pelvis: [0.00, 0.30, 0], spine1: [0.03, 0.36, 0], spine2: [0.04, 0.38, 0],
      chest: [0.03, 0.34, 0],
      // Folded down and under rather than reaching out: the steep x brings the
      // head to the floor, the y wraps it back alongside the flank.
      neck1: [0.72, 0.62, 0], neck2: [0.66, 0.60, 0], head: [0.10, 0.40, -0.14],
      // Front paws folded FORWARD and drawn in under the chin, the way both
      // curl references show them — not folded backwards under the chest,
      // which put the elbows out sideways and left two pale legs sticking out
      // of the front of the curl. The elbow drops almost to the ground and the
      // forearm comes in short, so the paws end up beside the muzzle.
      foreL_upper: [-0.16, 0.12, 0.09], foreL_lower: [-1.12, 0, 0], foreL_cannon: [-0.22, 0, 0],
      foreR_upper: [-0.20, 0.16, -0.07], foreR_lower: [-1.06, 0, 0], foreR_cannon: [-0.18, 0, 0],
      // TUCKED UNDER, not folded behind. The femur has to swing hard forward
      // so the stifle comes up under the ribs and the whole leg packs into the
      // belly; at -0.30 it barely moved and the folded hind legs stuck out of
      // the back of the curl like a deckchair's. This is the difference between
      // a dog curled up and a dog that has been dropped.
      hindL_upper: [-1.15, 0, 0.20], hindL_lower: [2.15, 0, 0], hindL_cannon: [-0.95, 0, 0],
      hindR_upper: [-1.10, 0, -0.16], hindR_lower: [2.10, 0, 0], hindR_cannon: [-0.92, 0, 0],
      // Wrapped round the outside of the curl and lying flat.
      tail1: [-0.50, 0.95, 0], tail2: [-0.18, 0.75, 0], tail3: [-0.08, 0.55, 0],
    },
  },

  // ── lying, sphinx ─────────────────────────────────────────────────────────
  // Reference `laying-1.png`: chest and elbows on the ground, forelegs reaching
  // straight out in front, hind legs folded flat alongside, head up and awake.
  // The one that reads as "keeping an eye on you" rather than "asleep".
  lie: {
    // Deep enough that the brisket is ON the ground, which is what puts the
    // elbows there too — the shoulder ends up 0.16 up, the humerus hangs
    // straight down from it, and the forearm lies flat from the elbow.
    drop: -0.262, pitch: -0.03, roll: 0, w: 1,
    bones: {
      pelvis: [0, 0.04, 0], spine1: [0.01, 0.05, 0], spine2: [0.01, 0.03, 0], chest: [0, 0.02, 0],
      // Head carried up, so the neck has to come back against the body's drop.
      neck1: [-0.16, -0.05, 0], neck2: [-0.10, -0.04, 0], head: [0.06, -0.03, 0],
      // Humerus near vertical, forearm flat on the ground reaching forward past
      // the nose. Rotating the humerus forward RAISES the elbow, which is the
      // opposite of what this pose needs — the first cut had it at -0.42 and
      // the paws hovered four centimetres up.
      foreL_upper: [-0.10, 0, 0.05], foreL_lower: [-1.36, 0, 0], foreL_cannon: [0.06, 0, 0],
      foreR_upper: [-0.12, 0, -0.05], foreR_lower: [-1.34, 0, 0], foreR_cannon: [0.08, 0, 0],
      // Hind legs folded and splayed a little outward, the way they fall when a
      // dog drops onto its belly rather than tucking.
      hindL_upper: [-0.90, 0, 0.26], hindL_lower: [2.20, 0, 0], hindL_cannon: [-0.70, 0, 0],
      hindR_upper: [-0.88, 0, -0.24], hindR_lower: [2.16, 0, 0], hindR_cannon: [-0.68, 0, 0],
      tail1: [-0.30, 0.42, 0], tail2: [-0.10, 0.34, 0], tail3: [-0.02, 0.26, 0],
    },
  },

  // ── sitting ───────────────────────────────────────────────────────────────
  // Reference `sitting-side.jpg`: hocks flat on the ground, backside down
  // between them, forelegs straight and VERTICAL, topline sloping up at about
  // 38° to a level head.
  //
  // ── why this is not a root rotation ────────────────────────────────────────
  //
  // The obvious construction — sink the dog and pitch it back about the root —
  // is wrong, and wrong in a way worth recording because it looks nearly right
  // in the numbers. Pitching about the root swings the shoulder through an arc:
  // measured, a 30° pitch dropped the shoulder from 0.43 m to 0.35 and carried
  // it 0.25 m BACKWARD, so the chest ended up behind the front paws and the
  // forelegs raked forward like a deckchair.
  //
  // A sitting dog does not rotate. It keeps its rib cage upright over its front
  // paws and bends its LUMBAR SPINE — the back inclines, the shoulder stays
  // where it was. So the whole animal sinks by the full amount the rear has to
  // fall, and the spine chain then lifts everything forward of the loin back to
  // standing height. `drop` and the spine rotations are one measurement in two
  // halves and cannot be tuned apart.
  sit: {
    // `drop` and the incline are one solved pair: at this drop the front paws
    // plant at the same -0.02 the standing pose puts them at, and the croup
    // rides 0.11 up, which is where a dog's croup actually is when it sits —
    // it rests on the backs of its thighs and its hocks, not on its rump.
    drop: -0.210, push: 0.030, pitch: 0, roll: 0, w: 1,
    bones: {
      // The incline, spread across the three lumbar joints rather than jammed
      // into one — a dog's back curves into a sit, it does not hinge.
      pelvis: [-0.44, 0, 0], spine1: [-0.29, 0, 0], spine2: [-0.23, 0, 0], chest: [-0.04, 0, 0],
      // The neck inherits the chest's whole incline, so "hold the head up"
      // means rotating FORWARD against it. Not by all of it: a sitting dog
      // carries its head higher than a standing one, so about half is right.
      neck1: [0.34, 0, 0], neck2: [0.20, 0, 0], head: [0.08, 0, 0],
      // ── these cancel the spine, and that is the whole job ──────────────────
      // The forelegs hang off `chest`, so they inherit every radian of the
      // incline above and rake forward with it. Cancelling 0.62 of the 0.66
      // stands them vertical again, with the remainder left as the slight
      // forward lean a real sit has. Getting this wrong is not subtle — at
      // +0.04 the dog sat like a deckchair with its paws in the air.
      foreL_upper: [0.94, 0, 0.03], foreL_lower: [0.02, 0, 0], foreL_cannon: [0, 0, 0],
      foreR_upper: [0.94, 0, -0.03], foreR_lower: [0.02, 0, 0], foreR_cannon: [0, 0, 0],
      // Fully collapsed, and counter-rotated for the pelvis's own share of the
      // incline: femur forward, tibia folded hard back to drop the hock to the
      // ground, metatarsus raking down and forward to lie along it.
      hindL_upper: [-0.30, 0, 0.20], hindL_lower: [1.70, 0, 0], hindL_cannon: [-1.10, 0, 0],
      hindR_upper: [-0.28, 0, -0.18], hindR_lower: [1.68, 0, 0], hindR_cannon: [-1.08, 0, 0],
      // Swept round to one side on the ground, which is where it goes when the
      // rear end is sitting on it.
      tail1: [0.30, 0.55, 0], tail2: [0.10, 0.40, 0], tail3: [0, 0.30, 0],
    },
  },
};

// How the three are chosen. The brief is explicit about the ranking: curling up
// is what the dog mainly does, lying flat is occasional, sitting is sometimes.
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
const RISE_TIME = 0.85;          // s to stand back up
const APPROACH_TIME = 16;        // s before abandoning an unreachable bed

// Where it walks. The fire ring is 0.58 m of stone, so nothing here may come
// inside about a metre and a half of the centre.
// The fire ring is 0.58 m of stone with a flame standing about a metre out of
// it; this is that plus room for a dog to pass without singeing itself.
const FIRE_CLEAR = 1.25;
const ORBIT_MIN = 1.9;
const ORBIT_MAX = 3.4;
const REST_MIN = 1.7;            // …and where it chooses to lie down
const REST_MAX = 2.8;
const WALK_SPEED = 0.78;         // m/s. A dog pottering, not going anywhere.
const DOG_CLEAR = 0.25;          // body radius used for path clearance
const REST_CLEAR = 0.12;         // extra empty ground around a sleeping dog
const REST_MAX_SLOPE = 0.18;     // tan(angle), about ten degrees
const REST_MAX_RELIEF = 0.032;   // metres away from the fitted ground plane
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

    // One material per dog. Three dogs in three camps is three materials and
    // one program — `createHideMaterial` pins the cache key, same as the wild
    // cast, so a second camp does not link a shader.
    this.mat = createHideMaterial(this.proto.variant.col);
    this.mat.name = `hide:dog:${this.proto.variant.name}`;

    const jit = 0.94 + rnd() * 0.12;
    this.scale = this.proto.scale * jit;
    this.inst = instantiate(this.proto, this.mat, 0);
    this.mesh = this.inst.mesh;
    this.mesh.name = `camp_dog:${this.proto.variant.name}`;
    this.rig = new AnimRig(this.proto, this.inst, this.scale, DOG_GAIT, 'dog');
    parent.add(this.mesh);

    // Bones the poser writes, resolved once by name. A pose naming a bone that
    // does not exist is a silent no-op rather than a crash — the blueprint may
    // grow or lose a tail segment and a pose table should not be able to break
    // the game over it.
    this.byName = this.inst.byName;

    this.rnd = rnd;
    this._t = 0;
    this.state = ST.WANDER;
    this.timer = rand(rnd, WANDER_TIME);
    this.pose = null;          // the pose being blended toward, or null
    this.blend = 0;            // 0 = the gait solver's pose, 1 = fully settled

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
      if (!worst || worstGap >= 0.015) { out.x = x; out.z = z; return out; }
      let dx = x - worst.x, dz = z - worst.z;
      if (worstD < 1e-4) {
        const a = this.ang + pass * 2.39996;
        dx = Math.sin(a); dz = Math.cos(a); worstD = 1;
      }
      const need = worst.r + pad + 0.02;
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
        const score = clear >= 0.015 ? 10 - rr : clear - rr;
        if (score > bestScore) { bestScore = score; bestX = sx; bestZ = sz; }
      }
      if (bestScore > 9) break;
    }
    out.x = bestX; out.z = bestZ;
    return out;
  }

  /** A point on the orbit, resolved away from anything solid there. */
  _orbitPoint(ang, r, out = { x: 0, z: 0 }) {
    return this._resolvePoint(
      this.fire.x + Math.sin(ang) * r,
      this.fire.z + Math.cos(ang) * r,
      DOG_CLEAR + 0.08,
      out,
    );
  }

  /** Fit a stable local ground plane under a whole resting dog. */
  _surfaceAt(x, z, yaw) {
    const W = this.world;
    const spanZ = Math.max(this.rig.bodyLen, 0.90) * 0.5;
    const spanX = Math.max(this.rig.bodyW, 0.45) * 0.5;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const height = (side, fore) => W.getHeight(
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
      const yaw = toFire + (this.rnd() - 0.5) * 1.05;
      const ground = this._surfaceAt(p.x, p.z, yaw);
      if (ground.slope > REST_MAX_SLOPE || ground.relief > REST_MAX_RELIEF) continue;

      // Approach from behind the final pose. This is the animation fix as much
      // as it is path planning: the dog walks into its bed already facing the
      // way it will lie, rather than stopping and rotating like a turntable.
      const entryX = p.x - Math.sin(yaw) * 0.72;
      const entryZ = p.z - Math.cos(yaw) * 0.72;
      if (this._clearanceAt(entryX, entryZ) < 0.03) continue;

      const turn = Math.abs(wrapAngle(Math.atan2(entryX - this.pos.x, entryZ - this.pos.z) - this.heading));
      const score = -ground.slope * 5 - ground.relief * 24 - turn * 0.16 +
        Math.min(clear, 0.5) * 0.2 + this.rnd() * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = { x: p.x, z: p.z, yaw, ground, entryX, entryZ };
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
    const offsets = [0, 0.28, -0.28, 0.55, -0.55, 0.84, -0.84, 1.14, -1.14];
    let best = this.heading, bestOffset = 0, bestScore = -Infinity;
    for (const off of offsets) {
      const candidate = this.heading + off;
      const clear = this._pathClearance(candidate, look);
      let score = Math.cos(wrapAngle(want - candidate)) * 1.55 +
        Math.min(clear, 0.65) * 1.15 - Math.abs(off) * 0.08;
      if (clear < 0) score -= 30 + Math.abs(clear) * 20;
      if (this.avoidTimer > 0 && this.avoidSide && Math.sign(off) === -this.avoidSide) score -= 1.8;
      if (score > bestScore) { bestScore = score; best = candidate; bestOffset = off; }
    }

    if (Math.abs(bestOffset) > 0.2 && this._pathClearance(this.heading, look) < 0.38) {
      if (this.avoidTimer <= 0) this.avoidSide = Math.sign(bestOffset);
      this.avoidTimer = 1.15;
    }
    return best;
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
            // No honest bed is better than lying on the least-bad hummock.
            // Wander a little further and ask again from another part of camp.
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
            if (ground.slope > REST_MAX_SLOPE || ground.relief > REST_MAX_RELIEF ||
                this._clearanceAt(this.pos.x, this.pos.z) < REST_CLEAR * 0.5) {
              this._abandonRestSpot();
              break;
            }
            this.state = ST.SETTLE;
            this.timer = SETTLE_TIME;
            this.pose = POSES[pickPose(this.rnd())];
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
          this.pose = null;
          this.restPlan = null;
          this.restGround = null;
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
          }
        }
      } else {
        const want = Math.atan2(dx, dz);
        // On the last few steps, only inspect the path up to the bed. Looking
        // a full metre THROUGH it sees the fire beyond the intended stopping
        // point and makes avoidance turn away at the exact moment the dog is
        // lined up to settle.
        const look = this.approachFinal ? Math.min(0.55, d + 0.10) : 1.05;
        const chosen = this._chooseHeading(want, look);
        const turn = wrapAngle(chosen - this.heading);
        // Yaw is curvature: no ground speed means no heading change. Scaling
        // the turn limit from the speed structurally rules out a pivot after
        // rising or when a target changes behind the dog.
        const turnRate = Math.min(1.35, Math.max(0, this.speed) * 3.0);
        this.heading += clamp(turn, -turnRate * dt, turnRate * dt);
        // Keep walking through a turn. Even the tightest allowed corner keeps
        // forty percent of walking speed, so the body's yaw describes an arc
        // in the ground plane instead of a pivot at zero speed.
        const turnScale = lerp(0.42, 1, clamp01(1 - Math.abs(turn) / 1.15));
        const nearScale = clamp01(d / (this.approachFinal ? 0.45 : 0.72));
        let wantSpeed = d < 0.12 ? 0 : WALK_SPEED * turnScale * nearScale;
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
      // A rounded prop footprint can leave the dog a few millimetres inside a
      // neighbouring circle. Rejecting every still-negative step makes that a
      // permanent prison. Let a backing step proceed only when it monotonically
      // reduces the overlap; it remains collision-safe and walks out visibly
      // instead of being projected or teleported.
      const escapingOverlap = clearNow < 0 && clearNext > clearNow + 1e-6;
      if (clearNext >= 0 || escapingOverlap) {
        this.pos.x = nx; this.pos.z = nz;
        this.blockedTime = Math.max(0, this.blockedTime - dt * 2);
      } else {
        this.blockedTime += dt;
        if (!this.recovering && this.blockedTime > 0.18) this._beginRecovery();
      }
    }
    this.nearestClearance = this._clearanceAt(this.pos.x, this.pos.z);
    this.pos.y = W.getHeight(this.pos.x, this.pos.z);

    // ── the gait solver, then the pose over the top of it ───────────────────
    this.drive.heading = this.heading;
    this.drive.speed = Math.max(0, this.speed);
    // A settled dog still looks around. `alert` lifts the head and pricks the
    // ears, and easing a little of it in while it rests is most of what keeps a
    // curled dog from reading as a prop. Eased for real: the old `blend > 0.5`
    // gate switched it on in a single frame halfway through every settle and
    // off halfway through every rise, and the ears and neck snapped with it.
    this.drive.alert = clamp01((this.blend - 0.55) / 0.4) *
      (0.12 + 0.1 * Math.sin(this._t * 0.4));
    this.drive.lod = camPos && camPos.distanceToSquared(this.pos) > 58 * 58 ? 1 : 0;
    this.rig.update(dt, this.drive, W);

    // A lying dog's support plane is chosen once. Re-solving its body height
    // from four independently shuffling gait feet every frame is correct while
    // walking and visibly wrong after the authored legs are folded away.
    if (this.restGround && this.blend > 0.001) {
      this.mesh.position.y = lerp(this.mesh.position.y, this.restGround.y, this.blend);
    }
    if (this.blend > 0.001 && this.pose) this._applyPose(this.blend);
  }

  /**
   * Blend an authored pose over whatever the gait solver just wrote.
   *
   * This runs AFTER `rig.update`, and it has to: `AnimRig` recomputes every
   * bone from scratch each frame out of world-anchored foot positions, so it
   * neither reads nor is disturbed by what is written here. Blending out simply
   * lets its own answer show through again, which is why standing up needs no
   * transition of its own.
   */
  _applyPose(w) {
    const P = this.pose;
    const root = this.rig.root;
    // `y` is ACCUMULATED and `z` is ASSIGNED, and the asymmetry is not a slip.
    // `AnimRig` writes `root.position.y` every frame (the gait bob), so adding
    // to it is idempotent; it never touches `z` at all, so adding to that
    // accumulated the push forever — 0.03 m per frame is 1.8 m/s, and the
    // sitting dog slid quietly out of the camp and over the horizon.
    root.position.y += P.drop * w;
    root.position.z = (P.push ?? 0) * w;
    const groundPitch = this.restGround?.pitch ?? 0;
    const groundRoll = this.restGround?.roll ?? 0;
    root.rotation.x = lerp(root.rotation.x, P.pitch + groundPitch, w);
    root.rotation.z = lerp(root.rotation.z, P.roll + groundRoll, w);

    for (const name in P.bones) {
      const b = this.byName[name];
      if (!b) continue;
      const [rx, ry, rz] = P.bones[name];
      b.rotation.x = lerp(b.rotation.x, rx, w);
      b.rotation.y = lerp(b.rotation.y, ry, w);
      b.rotation.z = lerp(b.rotation.z, rz, w);
    }
    // The solver's last act is a world-matrix update; having moved the bones
    // underneath it, we owe it another one or the skinning lags a frame.
    this.mesh.updateWorldMatrix(false, true);
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mat.dispose();
  }
}

// ── the shared prototype ─────────────────────────────────────────────────────
//
// Built on first use rather than at module load: this file is imported by
// `Camp`, and a top-level build would put a few hundred lofted rings on the
// boot path for a feature that four camps out of five never even reach. Built
// once and then shared by every dog in the session.
let _protos = null;
export function dogProto() {
  if (!_protos) _protos = buildCampDog(0xd06);
  return _protos;
}

/** Prebuild the geometry — called from the camp pre-warm, under the loader. */
export function warmDog() { return dogProto(); }

export function disposeDogProtos() {
  if (!_protos) return;
  for (const p of _protos) for (const g of p.geoms) g.dispose();
  _protos = null;
}

const DOG_GAIT = {
  walk: 0.95, trot: 2.6, run: 6.5,
  strideBase: 0.62, strideGain: 2.4, dutyWalk: 0.62, dutyTrot: 0.50, dutyRun: 0.32,
  bobAmp: 0.020, pitchAmp: 0.038, liftScale: 1.05,
  grazeAng: 1.32, grazeRake: 1.40,
};

function pickDogVariant(r) {
  const w = [0.60, 0.22, 0.18];
  let acc = 0;
  for (let i = 0; i < w.length; i++) { acc += w[i]; if (r < acc) return i; }
  return w.length - 1;
}

function pickPose(r) {
  let acc = 0;
  for (const p of POSE_PICK) { acc += p.w; if (r < acc) return p.key; }
  return POSE_PICK[0].key;
}

const rand = (rnd, [a, b]) => a + rnd() * (b - a);
const ease01 = (u) => u * u * (3 - 2 * u);

export { POSES as DOG_POSES, ST as DOG_ST, DOG_GAIT as DOG_GAIT_CFG };
