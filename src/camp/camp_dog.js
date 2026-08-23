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
import { clamp, clamp01, lerp, damp, mulberry32, wrapAngle } from '../core/MathUtils.js';
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

const ST = { WANDER: 0, APPROACH: 1, SETTLE: 2, REST: 3, RISE: 4 };

const _v = new THREE.Vector3();
const _e = new THREE.Euler();

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
    this.poseYaw = 0;          // heading the dog settled at, held while resting

    // Polar wander state — see the note at the top of the file.
    this.ang = rnd() * Math.PI * 2;
    this.angV = (rnd() < 0.5 ? -1 : 1) * (0.16 + rnd() * 0.14);
    this.orbit = lerp(ORBIT_MIN, ORBIT_MAX, rnd());
    this.orbitT = 0;

    // Start it somewhere sensible on its own orbit, standing.
    const p = this._orbitPoint(this.ang, this.orbit);
    this.pos = new THREE.Vector3(p.x, world.getHeight(p.x, p.z), p.z);
    this.heading = this.ang + Math.PI * 0.5;
    this.speed = 0;
    this.target = new THREE.Vector3(p.x, 0, p.z);

    this.drive = {
      pos: this.pos, heading: this.heading, speed: 0,
      graze: 0, alert: 0, flag: 0, look: null, lod: 0,
    };
    this.rig.reset(this.pos, this.heading, world);
  }

  /** A point on the orbit, pushed off anything solid standing there. */
  _orbitPoint(ang, r, out = { x: 0, z: 0 }) {
    let x = this.fire.x + Math.sin(ang) * r;
    let z = this.fire.z + Math.cos(ang) * r;
    // Two relaxation passes against the camp's own props. Not a solver — just
    // enough that the dog does not walk through the cooler.
    for (let pass = 0; pass < 2; pass++) {
      for (const o of this.obstacles) {
        const dx = x - o.x, dz = z - o.z;
        const d = Math.hypot(dx, dz);
        const need = o.r + 0.34;
        if (d > need || d < 1e-4) continue;
        const k = (need - d) / d;
        x += dx * k; z += dz * k;
      }
    }
    out.x = x; out.z = z;
    return out;
  }

  /** Choose somewhere to lie down: near the fire, clear of the props. */
  _pickRestSpot() {
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 10; i++) {
      const a = this.rnd() * Math.PI * 2;
      const r = lerp(REST_MIN, REST_MAX, this.rnd());
      const p = this._orbitPoint(a, r);
      // Prefer flat ground — a dog does not curl up on a slope — and prefer not
      // to walk right across the fire to get there.
      const slope = this.world.getSlope?.(p.x, p.z) ?? 0;
      const turn = Math.abs(wrapAngle(Math.atan2(p.x - this.pos.x, p.z - this.pos.z) - this.heading));
      const s = -slope * 3 - turn * 0.25 + this.rnd() * 0.3;
      if (s > bestScore) { bestScore = s; best = p; }
    }
    return best;
  }

  /**
   * How far to bend the heading to miss the props, in radians.
   *
   * Only obstacles roughly AHEAD count — something beside or behind the dog is
   * not in the way and steering around it would make the path wander for no
   * reason. The turn is away from whichever side the obstacle sits on, scaled
   * by how close and how central it is.
   */
  _dodge(want) {
    let turn = 0;
    const sx = Math.sin(want), sz = Math.cos(want);
    for (const o of this.obstacles) {
      const dx = o.x - this.pos.x, dz = o.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      const look = o.r + 0.85;
      if (d > look || d < 1e-4) continue;
      // Ahead? (dot with the desired heading)
      const ahead = (dx * sx + dz * sz) / d;
      if (ahead < 0.15) continue;
      // Which side, and how hard.
      const side = (dx * sz - dz * sx) / d;      // >0 means the prop is to the left
      const urgency = (1 - d / look) * ahead;
      turn += (side > 0 ? -1 : 1) * urgency * 1.5;
    }
    return clamp(turn, -1.2, 1.2);
  }

  /** Last line of defence: never actually stand inside a prop. */
  _clearProps() {
    for (const o of this.obstacles) {
      const dx = this.pos.x - o.x, dz = this.pos.z - o.z;
      const d = Math.hypot(dx, dz);
      const need = o.r + 0.22;
      if (d > need) continue;
      if (d < 1e-4) { this.pos.x += need; continue; }
      const k = (need - d) / d;
      this.pos.x += dx * k; this.pos.z += dz * k;
    }
  }

  update(dt, camPos) {
    const W = this.world;
    this._t += dt;
    this.timer -= dt;

    // ── the loop ────────────────────────────────────────────────────────────
    switch (this.state) {
      case ST.WANDER: {
        // The orbit angle advances at a rate that itself drifts, so the dog
        // speeds up and slows down and occasionally nearly stops, rather than
        // tracking round at a constant rate like a fairground ride.
        this.angV += (Math.sin(this._t * 0.37) * 0.10) * dt;
        this.angV = clamp(this.angV, -0.42, 0.42);
        this.ang += this.angV * dt;
        this.orbitT += dt;
        this.orbit = lerp(ORBIT_MIN, ORBIT_MAX,
          0.5 + 0.5 * Math.sin(this.orbitT * 0.23 + this.ang * 0.7));
        const p = this._orbitPoint(this.ang, this.orbit);
        this.target.set(p.x, 0, p.z);
        if (this.timer <= 0) {
          const spot = this._pickRestSpot();
          this.target.set(spot.x, 0, spot.z);
          this.state = ST.APPROACH;
          this.timer = 14;                       // give up and settle anyway
        }
        break;
      }
      case ST.APPROACH: {
        const d = Math.hypot(this.target.x - this.pos.x, this.target.z - this.pos.z);
        if (d < 0.28 || this.timer <= 0) {
          this.state = ST.SETTLE;
          this.timer = SETTLE_TIME;
          this.pose = POSES[pickPose(this.rnd())];
          // Face the fire, roughly, and hold that heading through the rest.
          // A dog lying with its back to the fire is a dog that has been placed
          // rather than one that chose the spot.
          const toFire = Math.atan2(this.fire.x - this.pos.x, this.fire.z - this.pos.z);
          this.poseYaw = toFire + (this.rnd() - 0.5) * 1.5;
        }
        break;
      }
      case ST.SETTLE:
        this.blend = clamp01(1 - this.timer / SETTLE_TIME);
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
        this.blend = clamp01(this.timer / RISE_TIME);
        if (this.timer <= 0) {
          this.blend = 0;
          this.pose = null;
          this.state = ST.WANDER;
          this.timer = rand(this.rnd, WANDER_TIME);
          // Re-key the orbit to wherever it woke up, so it carries on from here
          // instead of striking out across the camp for a stale angle.
          this.ang = Math.atan2(this.pos.x - this.fire.x, this.pos.z - this.fire.z);
        }
        break;
    }

    // ── steering ────────────────────────────────────────────────────────────
    const moving = this.state === ST.WANDER || this.state === ST.APPROACH;
    if (moving) {
      const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      let want = Math.atan2(dx, dz);
      // Steer AROUND the camp rather than through it. Pushing the target point
      // off the props (`_orbitPoint`) only fixes where the dog is going, not
      // the line it takes to get there — and the chairs and the cooler are
      // exactly the things standing between two points on a ring drawn round
      // the fire. This bends the desired heading away from anything close and
      // ahead, which is enough for a dog pottering at 0.78 m/s.
      want += this._dodge(want);
      // Damped turn, and the dog slows into a corner rather than pivoting on
      // the spot — the turn rate is what keeps the path smooth.
      this.heading += clamp(wrapAngle(want - this.heading), -1.6 * dt, 1.6 * dt);
      const align = Math.cos(wrapAngle(want - this.heading));
      const wantSpeed = d < 0.34 ? 0 : WALK_SPEED * clamp01(align) * clamp01(d / 0.9);
      this.speed = damp(this.speed, wantSpeed, 3.2, dt);
    } else {
      this.speed = damp(this.speed, 0, 6, dt);
      // Settle the heading onto the one it chose, so the fold-down and the turn
      // finish together.
      if (this.pose) {
        this.heading += clamp(wrapAngle(this.poseYaw - this.heading), -2.2 * dt, 2.2 * dt);
      }
    }
    this.pos.x += Math.sin(this.heading) * this.speed * dt;
    this.pos.z += Math.cos(this.heading) * this.speed * dt;
    this._clearProps();
    this.pos.y = W.getHeight(this.pos.x, this.pos.z);

    // ── the gait solver, then the pose over the top of it ───────────────────
    this.drive.heading = this.heading;
    this.drive.speed = this.speed;
    // A settled dog still looks around. `alert` lifts the head and pricks the
    // ears, and easing a little of it in while it rests is most of what keeps a
    // curled dog from reading as a prop.
    this.drive.alert = this.blend > 0.5 ? 0.12 + 0.1 * Math.sin(this._t * 0.4) : 0;
    this.drive.lod = camPos && camPos.distanceToSquared(this.pos) > 58 * 58 ? 1 : 0;
    this.rig.update(dt, this.drive, W);

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
    root.rotation.x = lerp(root.rotation.x, P.pitch, w);
    root.rotation.z = lerp(root.rotation.z, P.roll, w);

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

export { POSES as DOG_POSES, ST as DOG_ST, DOG_GAIT as DOG_GAIT_CFG };
