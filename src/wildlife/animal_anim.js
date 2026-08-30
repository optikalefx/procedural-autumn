// ─────────────────────────────────────────────────────────────────────────────
//  animal_anim — procedural locomotion.
//
//  There are no clips. Every pose in the game comes out of this file, driven by
//  the animal's actual ground speed.
//
//  The one idea that makes it work: **a foot in stance is a fixed point in the
//  world.** It is not animated at all. The body moves over it and the leg
//  solves backwards. Skating is not "tuned out" here, it is structurally
//  impossible — if the animal stops moving, the feet simply stay where they
//  are, and the gait clock stops with them.
//
//  Legs are solved as a two-link chain from the hip to the *hock*, with the
//  cannon below it holding its bind-pose relationship to the foot. That is not
//  a shortcut: it is how a real leg behaves, and it is why a deer's lower leg
//  stays vertical and a bear's stays flat on the ground with no special case.
//
//  Units: the SkinnedMesh carries the individual's size on `mesh.scale`, so all
//  bone-space maths below is in unscaled model units and only world-space
//  quantities (stride, foot arcs, ground samples) are multiplied by `scale`.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, wrapAngle } from '../core/MathUtils.js';

// ── gaits ────────────────────────────────────────────────────────────────────
//
// `off` is indexed [hindL, hindR, foreL, foreR]; `duty` is the fraction of the
// cycle a foot spends planted; `flight` is the share of the cycle with no foot
// down at all, which is where the ballistic arc lives.
//
//   walk    lateral sequence, three feet down — the cozy default
//   trot    diagonal pairs — "moving with purpose"
//   gallop  transverse gallop, short gathered suspension
//   bound   hind pair then fore pair, long float — a deer running for its life
//   hop     fore pair first, hinds swing past — the rabbit half-bound
// `pitch` scales how much the barrel rocks nose-up / nose-down over the cycle.
// A walking quadruped is almost level; a bounding one rotates through most of a
// radian, and without that a bound is just a body sliding along on bent legs.
const GAITS = {
  walk:   { off: [0.00, 0.50, 0.25, 0.75], duty: 0.64, lift: 0.055, bobHz: 2, flight: 0.00, flightAt: 1.00, pitch: 1.0 },
  trot:   { off: [0.50, 0.00, 0.00, 0.50], duty: 0.52, lift: 0.095, bobHz: 2, flight: 0.00, flightAt: 1.00, pitch: 1.3 },
  // ── flightAt is derived, not authored ──────────────────────────────────────
  // A leg is down while (phase + off) mod 1 < duty, so the phase at which the
  // animal is genuinely airborne falls straight out of `off` and `duty` and is
  // not free to choose. Work the union of the four stance windows and take the
  // gap:
  //
  //   gallop  down [.60,1) + [0,.34)   airborne [0.34, 0.50)   width .16
  //   bound   down [.60,1) + [0,.30)   airborne [0.30, 0.60)   width .30
  //   hop     down [.74,1) + [0,.26)   airborne [0.26, 0.74)   width .48
  //
  // All three were originally authored as `1 - flight`, which gets the *width*
  // right and the *placement* wrong — it parks the float at the end of the
  // cycle instead of where it is. The cost is not cosmetic: the barrel launches
  // while a foot is still planted, so that leg has to span the whole flight
  // lift on top of its own stride reach, blows past what the chain can cover
  // and locks dead straight. On the bear that read as the forelegs vanishing
  // into the body.
  //
  // Placed correctly, every leg lifts off and touches down *outside* the
  // window, so the arc starts and ends at zero and there is no step to hide.
  gallop: { off: [0.00, 0.08, 0.42, 0.50], duty: 0.34, lift: 0.135, bobHz: 1, flight: 0.14, flightAt: 0.34, pitch: 2.0 },
  bound:  { off: [0.00, 0.06, 0.34, 0.40], duty: 0.30, lift: 0.150, bobHz: 1, flight: 0.30, flightAt: 0.30, pitch: 2.4 },
  hop:    { off: [0.20, 0.26, 0.00, 0.06], duty: 0.26, lift: 0.120, bobHz: 1, flight: 0.48, flightAt: 0.26, pitch: 1.6 },
  // A dog's amble. The offsets are the same lateral sequence as `walk` — left
  // hind, left fore, right hind, right fore — but the DUTY is much higher, and
  // that one number is the whole point of having a separate entry.
  //
  // At `walk`'s 0.64 each foot swings for 0.36 of the cycle while the offsets
  // are only 0.25 apart, so two feet are off the ground together for 44% of
  // it. That is correct for a deer and it is what a deer looks like. On a dog
  // pottering around a fire at less than a metre a second it reads as a stagger
  // — and at the moment the two FRONT feet overlap it reads as impossible.
  // At 0.76 the swing is 0.24, just inside the offset, so exactly one foot is
  // in the air at any instant and the dog puts them down one at a time.
  dogwalk: { off: [0.00, 0.50, 0.25, 0.75], duty: 0.76, lift: 0.048, bobHz: 2, flight: 0.00, flightAt: 1.00, pitch: 0.85 },
};

// Which gait a species uses at which of its three speed tiers.
const LADDER = {
  deer:   ['walk', 'trot', 'bound'],
  bear:   ['walk', 'trot', 'gallop'],
  rabbit: ['hop', 'hop', 'hop'],
  // The camp dog had NO entry here and fell through to the deer's, which is
  // wrong twice over: a deer's walk is too quick-footed for a dog (see
  // `dogwalk`), and a deer's top gear is a BOUND — both hind feet together,
  // then both fore. Dogs gallop.
  dog:    ['dogwalk', 'trot', 'gallop'],
  // No `fox` row, and its absence is not an oversight. The fox is the one
  // hand-authored animal in the cast — `mammals/fox.js` carries a `glb` block
  // instead of a blueprint — so its gaits are six clips on an AnimationMixer
  // and this solver never runs for it at all. See `glb_rig.js`.
  //
  // A squirrel never walks — ground travel is a bound at every speed, like the
  // rabbit. (Every species needs its own row: a missing key falls through to
  // the deer's ladder, and a squirrel that trots is a rat.)
  squirrel: ['hop', 'hop', 'hop'],
  // A raccoon ambles and bounds, and does neither of the two things the rest of
  // the cast does in the middle gear. It does not trot like a fox — a trot is
  // diagonal pairs on a level back, and this animal's back is not level and its
  // legs are not the same length front to back. And it does not gallop like a
  // dog at the top; a frightened raccoon lollops, hind pair over fore pair, and
  // that is `bound`.
  //
  // So both lower rungs are lateral-sequence walks and only the DUTY changes
  // between them: `dogwalk` at 0.76 puts exactly one foot in the air at a time,
  // which is the rolling plantigrade amble, and `walk` at 0.64 is the same
  // sequence hurried up. The entry is named for the dog because that is who
  // needed it first; the gait is not a dog's, it is a slow heavy quadruped's.
  raccoon: ['dogwalk', 'walk', 'bound'],
  // A goat walks and trots like any short-legged ungulate, and at the top it
  // BOUNDS rather than gallops. That is not a stylisation: the ground a
  // mountain goat runs on is broken rock, and what it does there is hop from
  // stance to stance with the hind pair together. It is also the only top gear
  // that reads at all on a 20 m ledge, where a gallop would be two strides and
  // a cut.
  goat: ['walk', 'trot', 'bound'],
  // A yak is a bovid and does neither of those. Both lower rungs are
  // lateral-sequence walks with only the DUTY between them — the raccoon's
  // trick, and for the raccoon's reason: this animal ambles, it does not trot.
  // The top is a gallop, because a frightened cow gallops; it does not bound.
  yak: ['dogwalk', 'walk', 'gallop'],
};

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Matrix4();

const ease = (u) => u * u * (3 - 2 * u);

// The neck chain's speed limit, radians/second summed over both neck joints.
// See "the neck speed limit" in _poseHead.
const NECK_MAX_RATE = 8;

// How far an alert animal raises its carriage, as an ANGLE about the base of
// the neck. See "the alert lift is an angle, not an offset" in _poseHead.
const ALERT_LIFT = 0.26;
// And how much it extends as it does — an animal craning to look at you
// straightens its neck. Beyond the chain's reach the distance knee compresses
// it back, which is what the up-necked species were already doing.
const ALERT_REACH = 1.10;

// The skull's own pitch stop, measured in the chest's frame as the neck chain
// plus the atlas: down is positive. See "the skull stop" in _poseHead.
const SKULL_UP = -0.70, SKULL_DOWN = 1.55;

/**
 * Planar two-link IK in the (z, -y) plane of the parent's space.
 *
 * Angles come back measured as "radians from straight down, positive forward",
 * the same convention the bind pose is measured in, so a local bone rotation is
 * always just `bind - desired` minus whatever the chain above already applied.
 */
function solve2(hipY, hipZ, tY, tZ, l1, l2, bend, out) {
  let dy = tY - hipY, dz = tZ - hipZ;
  let d = Math.hypot(dy, dz);
  const dMax = (l1 + l2) * 0.998;
  const dMin = Math.abs(l1 - l2) + 1e-4;
  if (d > dMax) { const s = dMax / d; dy *= s; dz *= s; d = dMax; }
  else if (d < dMin) { const s = dMin / Math.max(d, 1e-5); dy *= s; dz *= s; d = dMin; }

  const base = Math.atan2(dz, -dy);
  const ca = clamp((d * d + l1 * l1 - l2 * l2) / (2 * d * l1), -1, 1);
  out.upper = base + bend * Math.acos(ca);

  // Derive the second link from the resolved knee rather than a second law of
  // cosines — same answer, no sign traps.
  const kz = hipZ + Math.sin(out.upper) * l1;
  const ky = hipY - Math.cos(out.upper) * l1;
  out.hockY = hipY + dy; out.hockZ = hipZ + dz;
  out.lower = Math.atan2(out.hockZ - kz, -(out.hockY - ky));
  return out;
}

const _ik = { upper: 0, lower: 0, hockY: 0, hockZ: 0 };

/** Angle-from-straight-down of a bind-pose child offset. */
const bindAngle = (y, z) => Math.atan2(z, -y);

// ── the rig instance ─────────────────────────────────────────────────────────

export class AnimRig {
  constructor(proto, inst, scale, gaitCfg, speciesKey) {
    this.proto = proto;
    this.info = proto.info;
    this.bones = inst.bones;
    this.mesh = inst.mesh;
    this.scale = scale;
    this.cfg = gaitCfg;
    this.species = speciesKey;
    this.mesh.scale.setScalar(scale);

    this.phase = 0;
    this.gaitName = 'walk';
    this.gait = GAITS.walk;
    this.strideLen = gaitCfg.strideBase * scale;

    // Per-leg state, allocated once. update() never allocates.
    this.legs = this.info.legs.map((L) => {
      const upper = this.bones[L.iUpper];
      const lower = this.bones[L.iLower];
      const cannon = this.bones[L.iCannon];
      return {
        L, upper, lower, cannon,
        key: (L.front ? 2 : 0) + (L.side > 0 ? 1 : 0),
        p: 0, stepping: false, wasStance: true,
        anchor: new THREE.Vector3(), from: new THREE.Vector3(),
        to: new THREE.Vector3(), foot: new THREE.Vector3(),
        l1: L.l1, l2: L.l2,
        bindUpper: bindAngle(lower.position.y, lower.position.z),
        bindLower: bindAngle(cannon.position.y, cannon.position.z),
        bindCannon: bindAngle(L.footDY, L.footDZ),
        // hock -> foot in world units, for building the hock target
        footWY: L.footDY * scale, footWZ: L.footDZ * scale,
      };
    });

    // The neck is the same two-link chain as a leg, measured off its own bind.
    const nk = this.info.neck;
    this.neck = nk.length >= 2 ? {
      a: this.bones[nk[0]], b: this.bones[nk[1]],
      l1: this.bones[nk[1]].position.length(),
      l2: this.bones[this.info.iHead].position.length(),
      bindA: bindAngle(this.bones[nk[1]].position.y, this.bones[nk[1]].position.z),
      bindB: bindAngle(this.bones[this.info.iHead].position.y, this.bones[this.info.iHead].position.z),
    } : null;

    this.root = this.bones[this.info.iRoot];
    this.pelvis = this.bones[this.info.iPelvis];
    this.chest = this.bones[this.info.iChest];
    this.head = this.bones[this.info.iHead];
    this.spineB = this.info.spine.map((i) => this.bones[i]);
    this.earB = this.info.ears.map((i) => this.bones[i]);
    this.tailB = this.info.tail.map((i) => this.bones[i]);

    const hb = proto.skel.bones[proto.skel.idx('head')];
    this.neckRest = new THREE.Vector3(0, hb.y, hb.z);   // mesh-local, unscaled
    this.headTarget = this.neckRest.clone();
    // The head-carriage offsets below (nod, alert lift, nibble drift) are
    // authored in absolute model units, sized against the deer's 0.45-unit
    // neck. On a chain a third that long the same numbers are a third of the
    // whole neck, and every nod threw the IK target clear through the
    // straight-chain singularity — which is what the camp dog's head-snapping
    // was. Everything the target moves by scales with the chain it has to move.
    this.neckSpan = this.neck ? this.neck.l1 + this.neck.l2 : 0;
    this.neckK = this.neck ? Math.min(1, this.neckSpan / 0.45) : 1;

    // Where the poll goes when the animal crops.
    //
    // Held in POLAR form about the base of the neck — an angle below horizontal
    // and a length — because that is what a neck is. Two things follow, and
    // both of them were bugs:
    //
    //  · The base moves. Cropping pitches the whole barrel nose-down by
    //    0.20 rad and settles it onto flexed forelegs (see update()), which
    //    together walk the withers forward and down by more than a third of the
    //    chain's own length. A crop point pinned in mesh space ends up BEHIND
    //    the live base, so the chain folds back under the chest and the skull
    //    inverts — the head reads as sawn off. _poseHead re-hangs the polar
    //    offset off wherever the base actually is, each frame.
    //  · The swing is an arc, not a chord. Carriage-to-crop is nearly 140° of
    //    rotation, from up-and-forward to down-and-forward; sliding the target
    //    along the straight line between them passes it within |l1 - l2| of the
    //    base half way down, inside the dead zone where solve2 has to clamp.
    //    The chain pinned folded-flat for a fifth of a second and then snapped
    //    open. Interpolating the angle and the length separately sweeps the
    //    poll round the outside instead, the way the animal's does.
    //
    // The length is a reach the chain HAS, not a point on the ground: a
    // quadruped's neck is far too short to put the poll at grass height — a
    // deer's muzzle sits a metre below its withers and the chain spans less
    // than half of that. The rest of the distance comes from the crouch and the
    // nose-down body pitch in update().
    this.neckBase = new THREE.Vector3();
    this.restAng = 0; this.restLen = 0;
    this.grazeAng = 0; this.grazeLen = 0;
    if (this.neck) {
      const na = proto.skel.bones[this.info.neck[0]];
      this.neckBase.set(0, na.y, na.z);
      const dy = this.neckRest.y - na.y, dz = this.neckRest.z - na.z;
      this.restAng = Math.atan2(-dy, dz);                 // below horizontal
      this.restLen = Math.hypot(dy, dz);
      this.grazeAng = gaitCfg.grazeAng ?? 1.20;
      this.grazeLen = (this.neck.l1 + this.neck.l2) * 0.985;
    }
    // How far the withers drop as the forelegs flex to let the head down.
    this.crouch = this.info.legs[0].hipY * scale * 0.17;
    // Standing footprint, in world metres — the ground-plane probe uses it.
    this.bodyLen = Math.abs(this.info.legs[0].restZ - this.info.legs[2].restZ) * scale;
    this.bodyW = Math.abs(this.info.legs[0].restX) * 2 * scale;

    // ── how far off the ground this animal can get ──────────────────────────
    //
    // A body is launched by its legs extending against the ground, so the arc
    // is bounded by the leg: nothing out here pushes its belly higher than the
    // hip it pushes from. That single number is said three ways, because the
    // suspension code in `update` needs all three: the apex, the airtime that
    // reaches it, and the take-off speed that goes with it. They are the same
    // ballistic arc — g·t²/8 with the airtime below is exactly `apexMax`, and
    // sqrt(2·g·apexMax) is exactly the speed it leaves the ground at.
    //
    // `apexMax` is in model units (the root bone lives inside the scaled mesh,
    // as `bob` does); the other two convert through `scale` to get there.
    this.apexMax = this.info.legs[0].hipY;
    this.airMax = 2 * Math.sqrt(2 * this.apexMax * scale / 9.81);   // seconds
    this.riseMax = Math.sqrt(2 * 9.81 * this.apexMax / scale);      // units/s
    // Last frame's suspension height, so the rise can be rate-limited.
    this.flightY = 0;

    this.earFlick = [0, 0];
    this.earNext = [1.3, 2.7];
    this.headYaw = 0; this.headPitch = 0; this.headRoll = 0;
    this.carriageDelta = 0;
    this.neckPrevA = null;
    this.neckPrevB = null;
    // Last frame's unwrapped neck rotation. See the atlas counter-rotation in
    // _poseHead — the raw value is only defined modulo a turn.
    this.neckChain = 0;
    this.tailSway = 0; this.tailSwayV = 0; this.tailLift = 0;
    this.breath = 0;
    this.bodyPitch = 0; this.bodyRoll = 0; this.bodyY = 0;
    this.lastSpeed = 0; this.surge = 0;
    this._warm = false;
    // Was the animal standing still last frame? See the re-key in update().
    this._wasStill = true;
  }

  /**
   * Geometry LOD. Both geometries share one skeleton description, so the swap
   * is a single assignment and costs nothing at the moment it happens.
   *
   * This and `setShadow` exist so `Wildlife._step` can drive presentation
   * without knowing which backend it is holding — the hand-authored track
   * (`glb_rig.js`) answers the same two calls and does something different.
   */
  setLod(lod) { this.mesh.geometry = this.proto.geoms[lod]; }

  /** Shadow LOD — the second draw call per animal, dropped at range. */
  setShadow(on) { if (on !== this.mesh.castShadow) this.mesh.castShadow = on; }

  /** Place all four feet on the ground under a standing animal. */
  reset(pos, heading, world) {
    this.mesh.position.copy(pos);
    this.mesh.rotation.y = heading;
    for (const lg of this.legs) {
      this._neutral(lg, pos, heading, lg.anchor);
      lg.anchor.y = world.getHeight(lg.anchor.x, lg.anchor.z);
      lg.foot.copy(lg.anchor);
      lg.to.copy(lg.anchor);
      lg.from.copy(lg.anchor);
      lg.p = this.gait.off[lg.key];
      lg.wasStance = lg.p < this.gait.duty;
    }
    this.bodyY = world.getHeight(pos.x, pos.z);
    this.flightY = 0;
    this.breath = (pos.x * 0.7 + pos.z * 1.3) % 6.283;
    // Back to the canonical branch — a recycled rig would otherwise hand the
    // atlas a whole turn of stale unwrap and rake the muzzle at the sky.
    this.neckChain = 0;
    this.carriageDelta = 0;
    this.neckPrevA = null;
    this.neckPrevB = null;
    this._warm = true;
  }

  /** Neutral world contact point for a leg — where the foot rests when still. */
  _neutral(lg, pos, heading, out) {
    const S = this.scale;
    const c = Math.cos(heading), s = Math.sin(heading);
    const rx = lg.L.restX * S, rz = lg.L.restZ * S;
    return out.set(pos.x + rx * c + rz * s, 0, pos.z - rx * s + rz * c);
  }

  _pickGait(speed) {
    const ladder = LADDER[this.species] ?? LADDER.deer;
    const g = this.cfg, S = this.scale;
    // Hysteresis: switch up at the threshold, back down at 80% of it, so an
    // animal hovering at a boundary does not stutter between two gaits.
    const up = this.gaitName === ladder[2] || this.gaitName === ladder[1] ? 0.80 : 1.0;
    let want = ladder[0];
    if (speed >= g.trot * S * up) want = ladder[1];
    if (speed >= g.run * S * 0.62 * up) want = ladder[2];
    if (want !== this.gaitName) {
      this.gaitName = want;
      this.gait = GAITS[want];
      // Re-key the legs off the running phase so a foot mid-stance is not
      // teleported into mid-swing at the transition.
      for (const lg of this.legs) lg.p = (this.phase + this.gait.off[lg.key]) % 1;
    }
  }

  /**
   * drive = {
   *   pos, heading, speed   world position / yaw / ground speed (m/s)
   *   graze 0..1            head down into the grass
   *   alert 0..1            head up, ears forward, body stiff
   *   flag  0..1            tail up (deer alarm flash; half-mast when wary)
   *   look  Vector3|null    world point to watch
   *   lod   0 near | 1 mid
   * }
   */
  update(dt, drive, world) {
    const S = this.scale;
    const pos = drive.pos, heading = drive.heading, speed = drive.speed;
    if (!this._warm) this.reset(pos, heading, world);

    this._pickGait(speed);
    const G = this.gait;
    const cheap = drive.lod > 0;

    // ── gait clock ──────────────────────────────────────────────────────────
    // Stride grows with speed the way a real animal's does, so cadence does not
    // run away at a gallop. Cadence is *derived* from speed and never authored;
    // the entire no-skating guarantee is this one division.
    const sn = clamp01(speed / (this.cfg.run * S));
    // Stride grows steeply with speed, the way a real animal's does: a walking
    // deer takes a 1.2 m step and a bounding one covers three and a half metres
    // in a single cycle. The first pass grew it by only 23% across the entire
    // speed range, so a deer fleeing at 9.5 m/s ran at six and a half strides a
    // second — its legs read as a vibration rather than as a gait, and the
    // suspension window was too short to see at all.
    this.strideLen = this.cfg.strideBase * S * (0.70 + (this.cfg.strideGain ?? 2.6) * sn);
    const cadence = speed > 0.04 ? speed / this.strideLen : 0;
    this.phase = (this.phase + cadence * dt) % 1;

    // ── coming back from a standstill ───────────────────────────────────────
    //
    // Re-key every leg to its own offset the moment the animal starts moving
    // again. The standing shuffle below moves ONE leg at a time and parks it
    // wherever its little step ended, which is not where the gait wants it —
    // so an animal that stops and starts often accumulates legs sharing a
    // phase, and two legs on the same phase swing together. On the camp dog,
    // which stops and starts every few seconds, that produced a walk with both
    // front paws striding at once: not a gait any quadruped has.
    //
    // Same technique `_pickGait` uses at a gait change, and safe for the same
    // reason: it is keyed off the running body phase, so a foot in stance
    // stays in stance rather than being teleported into mid-swing.
    if (cadence > 0 && this._wasStill) {
      for (const lg of this.legs) lg.p = (this.phase + G.off[lg.key]) % 1;
    }
    this._wasStill = cadence === 0;

    const sh = Math.sin(heading), ch = Math.cos(heading);

    // ── the ground plane under the body ─────────────────────────────────────
    //
    // Measured over a *fixed* span, not over the animal's own wheelbase. A
    // rabbit's feet are sixteen centimetres apart, and dividing the height
    // difference between two heightfield samples that close together by
    // sixteen centimetres turned every clod of micro-detail into a 25° dive.
    // Four samples either way; the same cost as sampling under each foot.
    const spanZ = Math.max(this.bodyLen, 0.90) * 0.5;
    const spanX = Math.max(this.bodyW, 0.45) * 0.5;
    let gF, gR, gL, gRt;
    if (cheap) {
      gF = gR = gL = gRt = world.getHeight(pos.x, pos.z);
    } else {
      gF = world.getHeight(pos.x + sh * spanZ, pos.z + ch * spanZ);
      gR = world.getHeight(pos.x - sh * spanZ, pos.z - ch * spanZ);
      gL = world.getHeight(pos.x - ch * spanX, pos.z + sh * spanX);
      gRt = world.getHeight(pos.x + ch * spanX, pos.z - sh * spanX);
    }

    // ── feet ────────────────────────────────────────────────────────────────
    const duty = G.duty;
    const liftM = G.lift * this.cfg.liftScale * (0.55 + 0.75 * sn);   // model units
    const lift = liftM * S;

    // Ballistic suspension. During the flight window nothing is in stance, so
    // this is a genuine arc rather than a fudge — the animal really is airborne.
    // It is computed here, before the feet, because a swinging foot has to rise
    // with the body: leaving it tracking the ground while the barrel launches
    // leaves a bounding deer with its legs dangling straight down like a
    // helicopter's, which is exactly what the first motion strip showed.
    //
    // The apex has to come from the *airtime*, not from the foot lift. The
    // first cut scaled it off `liftM`, which knows nothing about how long the
    // gait is actually off the ground: a galloping bear got a 0.39-unit arc to
    // fly and land inside a 0.14-phase window, which at that cadence is fifty
    // milliseconds — three frames. Thirty-seven centimetres up and back down in
    // three frames does not read as a bound, it reads as the animation
    // snapping, and that is exactly what it was reported as.
    //
    // A body in the air is the one part of a gait that is not a style choice,
    // so take it from the only equation available: for airtime t the apex is
    // g·t²/8. Short window, low hop; a genuinely long float (a bounding deer)
    // earns a real one. It is in world metres, so divide by scale to land in
    // the model units the root bone and `bob` are in.
    //
    // The airtime the window asks for is `flight / cadence`, and THAT is the
    // half of it that has to be bounded, because cadence is derived from speed
    // and goes to nothing at a creep. A rabbit hops at every speed it has (see
    // LADDER), so at 0.04 m/s — the cadence floor, which every stop and start
    // sweeps through in a frame or two — the gait table claims 0.48 of a cycle
    // in the air and the cycle is nine seconds long. Four and a half seconds
    // of float is a 27 m apex, and the rabbit was reported doing exactly that
    // for a single frame every time it shuffled between crops.
    //
    // The animal is of course not airborne at a creep; the flight WINDOW is
    // the fiction, not the equation. So cap the airtime at what the legs can
    // launch and narrow the window to match, which leaves a real parabola of
    // the right duration sitting inside a wider swing phase, rather than a
    // slow float stretched across the whole of it. The cap only bites below
    // 0.59 m/s on the rabbit and 0.47 on the squirrel — under their own walks,
    // so the hop at any speed you actually watch one at is untouched (8 cm at
    // a walk, 1 cm at a bolt, the same as before). Nothing else can reach it
    // at all: every other species has suspension only in its top gear, and
    // does not shift into it until five metres a second.
    let flight = 0, apex = 0;
    if (G.flight > 0 && cadence > 1e-3) {
      const airtime = Math.min(G.flight / cadence, this.airMax);
      const u = (this.phase - G.flightAt) / (airtime * cadence);
      if (u >= 0 && u <= 1) flight = 4 * u * (1 - u);
      apex = (9.81 * airtime * airtime * 0.125) / S;
    }
    // ...and the body cannot get there faster than it left the ground. This
    // costs a legitimate arc nothing — a parabola of apex h rises at exactly
    // sqrt(2·g·h) at take-off, so anything at or under the cap is already
    // inside this limit — and it is what makes a one-frame pop structurally
    // impossible however the gait is edited later. The discontinuities are
    // real: `phase` freezes wherever it stopped when the animal stands still,
    // and the first moving frame can land mid-window with the arc's slowest
    // cadence and highest apex, which is a hip height of altitude between two
    // frames. Rate-limited it becomes a hop, and a stop mid-float becomes a
    // fall instead of a teleport to the ground.
    const rise = this.riseMax * dt;
    this.flightY = clamp(flight * apex, this.flightY - rise, this.flightY + rise);
    const flightY = this.flightY;
    const swingLift = lift + flightY * S;
    // How far ahead of neutral the foot lands. Falls straight out of "the foot
    // is planted for `duty` of the cycle while the body travels one stride".
    const reach = this.strideLen * (1 - duty * 0.5);

    let stanceN = 0, stanceY = 0;
    // One foot shuffles at a time. Tracked as a plain flag rather than by an
    // Array.some() with a closure, which allocated once per leg per frame.
    let anyStepping = false;
    for (let i = 0; i < this.legs.length; i++) {
      const lg = this.legs[i];
      if (lg.stepping) anyStepping = true;
    }
    for (const lg of this.legs) {
      if (cadence > 0) {
        lg.p = (lg.p + cadence * dt) % 1;
        lg.stepping = false;
      } else if (lg.stepping) {
        lg.p += dt / 0.34;
        // Back to this leg's OWN slot in the cycle rather than to zero, so a
        // standing animal's weight shifts leave the gait coherent.
        if (lg.p >= 1) { lg.p = G.off[lg.key]; lg.stepping = false; }
      }

      const inStance = lg.p < duty;

      if (!inStance && lg.wasStance) {
        lg.from.copy(lg.foot);
        this._neutral(lg, pos, heading, lg.to);
        lg.to.x += sh * reach;
        lg.to.z += ch * reach;
        lg.to.y = world.getHeight(lg.to.x, lg.to.z);
      }
      if (inStance && !lg.wasStance) lg.anchor.copy(lg.to);
      lg.wasStance = inStance;

      if (inStance) {
        lg.foot.copy(lg.anchor);
        stanceN++; stanceY += lg.anchor.y;
        // Standing still through a turn eventually leaves a foot out of place.
        // Shuffle it back, one leg at a time, which reads as a real weight shift.
        if (cadence === 0 && !lg.stepping && !anyStepping) {
          this._neutral(lg, pos, heading, _a);
          if (Math.hypot(lg.foot.x - _a.x, lg.foot.z - _a.z) > 0.17 * S) {
            lg.stepping = true; lg.p = duty + 1e-4; anyStepping = true;
          }
        }
      } else {
        const u = clamp01((lg.p - duty) / (1 - duty));
        const e = ease(u);
        // Re-sample the landing height late in the swing so a foot arriving on
        // a rise or into a hollow still finds it.
        if (!cheap && u > 0.5) lg.to.y = world.getHeight(lg.to.x, lg.to.z);
        lg.foot.x = lerp(lg.from.x, lg.to.x, e);
        lg.foot.z = lerp(lg.from.z, lg.to.z, e);
        // One arc covers both the step-over and the tuck: zero at lift-off and
        // at touchdown, so the foot still lands exactly on its planted target.
        lg.foot.y = lerp(lg.from.y, lg.to.y, e) + Math.sin(Math.PI * u) * swingLift;
      }
    }

    // ── body ────────────────────────────────────────────────────────────────
    // Divided by the same span the samples were taken over, so the body sits at
    // the true local slope rather than at an amplified one.
    const pitchGround = clamp(-Math.atan2(gF - gR, spanZ * 2), -0.60, 0.60);
    const rollGround = clamp(Math.atan2(gRt - gL, spanX * 2), -0.45, 0.45);

    const bob = -Math.cos(this.phase * Math.PI * 2 * G.bobHz) *
      this.cfg.bobAmp * (0.35 + 0.95 * sn);

    const accel = (speed - this.lastSpeed) / Math.max(dt, 1e-3);
    this.lastSpeed = speed;
    this.surge = damp(this.surge, clamp(accel * 0.028, -0.20, 0.20), 6, dt);

    this.breath += dt * (1.05 + 2.4 * sn + drive.alert * 0.8);
    const breathe = Math.sin(this.breath) * 0.011 * (1 - sn * 0.6);

    // Sit on the mean of the planted feet, biased toward the local ground
    // plane, then damp — an animal's mass does not teleport up a step.
    const groundMid = stanceN > 0 ? stanceY / stanceN : (gF + gR) * 0.5;
    // Cropping settles the animal onto flexed forelegs. The neck alone leaves
    // the muzzle a hand's breadth above the grass; this and the nose-down pitch
    // below are the rest of the distance, and they are what a real grazing
    // quadruped does anyway.
    const targetY = lerp((gF + gR) * 0.5, groundMid, 0.65) - drive.graze * this.crouch;
    this.bodyY = damp(this.bodyY, targetY, 20, dt);

    this.mesh.position.set(pos.x, this.bodyY, pos.z);
    this.mesh.rotation.y = heading;

    this.bodyPitch = damp(this.bodyPitch, pitchGround, 9, dt);
    this.bodyRoll = damp(this.bodyRoll, rollGround, 9, dt);

    this.root.position.set(0, bob + flightY, 0);
    this.root.rotation.set(
      this.bodyPitch + this.surge + drive.graze * 0.20 +
        Math.sin(this.phase * Math.PI * 2 - 0.55) * this.cfg.pitchAmp * (G.pitch ?? 1) * sn,
      0,
      this.bodyRoll,
    );

    // The camp dog's authored sit bends the pelvis itself. It is blended over
    // this solver after update(), so every joint the pose can touch must start
    // from a clean locomotion answer on the next frame. Pelvis was the sole
    // omission: its -0.44 rad sit bend accumulated, survived the rise, and made
    // the neck IK counter-rotate the head sharply backward on the following
    // walk. Resetting the joint here restores the same stateless contract the
    // spine, neck and legs already have.
    this.pelvis.rotation.set(0, 0, 0);

    // Spine flex: the back gathers and extends through a bound, and breathes at
    // rest. Small numbers — a quadruped's back barely moves, and overdoing it
    // reads as a cat rather than a deer.
    const flex = (G.flight > 0 ? Math.sin(this.phase * Math.PI * 2 - 1.2) * 0.125 * sn : 0) + breathe;
    for (let i = 0; i < this.spineB.length; i++) {
      const last = i === this.spineB.length - 1;
      this.spineB[i].rotation.set(
        flex * (last ? 0.65 : 1),
        G.flight > 0 ? 0 : Math.sin(this.phase * Math.PI * 2 + i) * 0.022 * sn,
        0,
      );
    }

    // Bones above the legs are now final, so world matrices are valid for both
    // the neck solve (needs the chest) and the leg IK (needs pelvis / chest).
    this.mesh.updateWorldMatrix(false, true);

    this._poseHead(dt, drive, sn, world);
    this._poseEars(dt, drive, sn);
    this._poseTail(dt, drive, sn);
    this._solveLegs(sh, ch);
  }

  _poseHead(dt, drive, sn, world) {
    if (!this.neck) return;
    const S = this.scale;
    const graze = drive.graze, alert = drive.alert;

    // Target in mesh-local space. Because the goal is a *fixed local point*,
    // the head is automatically stabilised against the barrel's bob — the body
    // bounces underneath it. A fraction of the bob is added back so it is not
    // eerily locked.
    _c.copy(this.neckRest);

    const nk = this.neckK;
    if (graze > 0.001) {
      // Swing the poll down on an arc about the neck base as it sits THIS
      // frame — see the note in the constructor. At graze 0 this reproduces
      // `neckRest` exactly, so there is no step where the crop starts.
      _b.setFromMatrixPosition(this.neck.a.matrixWorld);
      this.mesh.worldToLocal(_b);
      _b.lerp(this.neckBase, 1 - graze);      // the base only moves as it crops
      const ang = lerp(this.restAng, this.grazeAng, graze);
      const len = lerp(this.restLen, this.grazeLen, graze);
      _b.set(0, _b.y - Math.sin(ang) * len, _b.z + Math.cos(ang) * len);
      // A nibbling drift so a grazing animal is never a statue.
      _b.z += Math.sin(this.breath * 0.55) * 0.05 * nk * graze;
      _b.y += Math.sin(this.breath * 1.9) * 0.022 * nk * graze;
      _c.copy(_b);
    }
    // ── the alert lift is an angle, not an offset ────────────────────────────
    // This used to raise the carriage by a fixed 0.16 up and 0.06 back, sized
    // against the deer and scaled by `nk`. A translation is the wrong thing to
    // author, for the same reason the crop is held in polar form: what the
    // chain has to DO with it depends entirely on which way the neck already
    // points.
    //
    // Measured, the split is exact and it is not about size. A deer, fox,
    // rabbit and squirrel carry the neck ABOVE horizontal, so lifting the
    // target moves it further out along the neck's own line — 124-128% of the
    // chain's reach, which the distance knee clips back to a straight neck
    // pointing a little higher. The skull barely turns. A bear and a raccoon
    // carry it BELOW horizontal, and there the same offset swings the target
    // up and *inward*: 79% and 87% of reach. The chain has to fold up hard to
    // meet it, and since nothing outside the graze path counter-rotates at the
    // atlas, the skull rode a 1.1 rad chain swing round with it — throat bared,
    // muzzle 50 degrees above the horizon, ears swung under the jaw. Filmed
    // side-on at 3.4 m the bear reads as having its head on upside down, which
    // is exactly what it was reported as.
    //
    // So: rotate the rest carriage up about the base of the neck and extend
    // it, which is what an animal craning to look at you actually does. Every
    // species then gets the same lift in the only units that mean the same
    // thing on all of them — degrees of neck — and the up-necked ones land
    // where they already were, because the knee was clipping their reach
    // anyway.
    if (alert > 0.001) {
      const ang = this.restAng - ALERT_LIFT;
      const len = this.restLen * ALERT_REACH;
      _b.set(0, this.neckBase.y - Math.sin(ang) * len, this.neckBase.z + Math.cos(ang) * len);
      _c.lerp(_b, alert);
    }
    // At speed the neck stretches out along the body. A running quadruped
    // reaches with its head; carrying it bolt upright is a carousel horse, and
    // that is exactly what the first bound strip looked like.
    if (sn > 0.01 && graze < 0.999) {
      const reach = (this.neck.l1 + this.neck.l2) * sn * (1 - graze);
      _c.z += reach * 0.60;
      _c.y -= reach * 0.34;
    }
    _c.y += this.root.position.y * 0.28;

    // A walking quadruped nods. The head reaches forward as the shoulder
    // unloads and settles back as it takes weight, one nod per stride. It is a
    // few centimetres, and its absence is most of what makes a procedural walk
    // read as a puppet sliding along a rail.
    if (sn > 0.001 && graze < 0.999) {
      const nod = Math.sin(this.phase * Math.PI * 2 * this.gait.bobHz - 0.9);
      const k = (1 - graze) * Math.min(1, sn * 3.2) * nk;
      _c.z += nod * 0.045 * k;
      _c.y -= Math.abs(nod) * 0.022 * k;
    }


    const lam = 7 + 11 * alert;
    this.headTarget.x = damp(this.headTarget.x, _c.x, lam, dt);
    this.headTarget.y = damp(this.headTarget.y, _c.y, lam, dt);
    this.headTarget.z = damp(this.headTarget.z, _c.z, lam, dt);

    // Into the chest's frame, where the neck chain lives.
    _b.copy(this.headTarget);
    this.mesh.localToWorld(_b);
    _m.copy(this.chest.matrixWorld).invert();
    _b.applyMatrix4(_m);

    const nb = this.neck;
    // Yaw is handled separately, so the planar solve uses the horizontal
    // distance rather than z alone or a sideways look would foreshorten it.
    let fz = Math.hypot(_b.x, _b.z) * Math.sign(_b.z || 1);
    let ty = _b.y;
    // ── the carriage pitches WITH the body ───────────────────────────────────
    // The target above is authored in the upright mesh frame — deliberate,
    // that is the bob stabilisation — but on sloped ground the chest pitches
    // AND swings on the root's pitch arc underneath it, and a target that
    // stays level makes the neck crane: walking downhill the muzzle ended up
    // sixty degrees above the horizon, pointed at the sky
    // (tools/_scratch/dogslope.mjs). So probe where the bind carriage POINT
    // lands in the live chest frame, take how far its elevation drifted from
    // the bind elevation, and rotate the target back by that much about the
    // neck base. The probe is a point, not a direction, because most of the
    // drift is the chest translating, not rotating. It therefore also sees
    // the gait bob — which must NOT be corrected, that is the stabilisation —
    // so the delta is damped at 4/s: stride-frequency bob averages out of it,
    // the quasi-static slope passes through. Flat ground reads zero; grazing
    // fades it out, that path solves its own geometry.
    // Driven by the LONG-BASELINE ground slope, nothing else. Two earlier
    // versions of this correction are worth their tombstones: probing the
    // carriage through the live chest matrices tracked surge and terrain
    // ripple as faithfully as slope, and with the ~5x geometric gain the head
    // visibly dove at every hollow the dog crossed and every hard brake
    // (filmed — tools/_scratch/dogfilm.mjs). A head stabilises through bumps
    // and accelerations; it only re-carries for the SUSTAINED grade under the
    // walk. So: sample the terrain a body-length-and-a-half fore and aft,
    // which averages the bumps out of the signal and keeps the hillside in
    // it, scale by the calibrated gain, and damp.
    //
    // Opt-in per species (cfg.carriageFollow): the graze arc handles its own
    // slope geometry and correcting across its boundary whipped the poll at
    // every crop transition (grazeslope.mjs). The camp dog never grazes,
    // lives wherever the camp was pitched, and is watched up close — exactly
    // the case this exists for. The delta decays when not applied so it
    // always re-engages cleanly.
    if (graze < 0.001 && this.cfg.carriageFollow) {
      const span = 1.6;
      const px = drive.pos.x, pz2 = drive.pos.z, hd = drive.heading;
      const hF = world.getHeight(px + Math.sin(hd) * span, pz2 + Math.cos(hd) * span);
      const hR = world.getHeight(px - Math.sin(hd) * span, pz2 - Math.cos(hd) * span);
      const longPitch = clamp(-Math.atan2(hF - hR, span * 2), -0.55, 0.55);
      // The elevation shift a given body pitch produces is the bind carriage
      // rotated about the root — evaluate that geometry directly rather than
      // linearising it: the true response is ~5x at small angles and
      // saturates at steep ones, and a straight gain overshot the steep ends.
      const cth = Math.cos(longPitch), sth = Math.sin(longPitch);
      const cy = this.neckRest.y * cth + this.neckRest.z * sth;
      const cz = -this.neckRest.y * sth + this.neckRest.z * cth;
      // Bounded: past this the correction is parking the target against its
      // anatomical clamp anyway, and a target held at a clamp is a frozen,
      // twitchy pose. Partial slope-following on extreme ground looks fine.
      const want = clamp(
        Math.atan2(cy - this.neckBase.y, cz - this.neckBase.z) + this.restAng,
        -1.0, 1.0,
      );
      this.carriageDelta = damp(this.carriageDelta, want, 2.2, dt);
      if (Math.abs(this.carriageDelta) > 1e-4) {
        const dy = ty - nb.a.position.y, dz = fz - nb.a.position.z;
        const d = Math.hypot(dy, dz);
        const e = Math.atan2(dy, dz) - this.carriageDelta;
        ty = nb.a.position.y + Math.sin(e) * d;
        fz = nb.a.position.z + Math.cos(e) * d;
      }
    } else {
      this.carriageDelta = damp(this.carriageDelta, 0, 2.2, dt);
    }
    // ── keep the solve off the straight-chain singularity ────────────────────
    // Every species binds its neck bones nearly colinear, so the rest target
    // already sits at ~100% of the chain's reach — where acos in the two-link
    // solve has infinite slope and a millimetre of target motion whips the
    // elbow through tens of degrees. solve2's own hard clamp cannot help: it
    // pins the pose AT the singular point. So compress the target's distance
    // smoothly toward a 0.985 ceiling instead — the mapping's slope goes to
    // zero exactly as the angular gain blows up, and the product stays tame.
    // Below 90% of reach nothing changes, so a bent grazing neck is untouched.
    {
      let dy = ty - nb.a.position.y, dz = fz - nb.a.position.z;
      const d = Math.hypot(dy, dz);
      const knee = this.neckSpan * 0.90, ceil = this.neckSpan * 0.985;
      if (d > knee) {
        const s = (ceil - (ceil - knee) * Math.exp(-(d - knee) / (ceil - knee))) / d;
        ty = nb.a.position.y + dy * s;
        fz = nb.a.position.z + dz * s;
      }
    }
    // ── the anatomical stop ──────────────────────────────────────────────────
    // Whatever upstream produced the target — a pitched body, a bad blend, a
    // future bug — the neck must never solve for a point outside the arc a
    // real neck covers. Measured from the chest, that is from steeply down
    // (the graze) to a little above the bind carriage; a target past vertical
    // toward the animal's own back is how the "head folded over the shoulders"
    // pose happened, and clamping the ELEVATION here (radius kept) makes that
    // pose unreachable by construction rather than merely unlikely.
    // Both bounds sit WELL AWAY from vertical (±π/2), and that placement is
    // the fix for a measured single-frame 2.3 rad mirror flip: the cap
    // originally worked out to 1.50 — the singularity itself — so a steep
    // slope could pin the target there, where forward-bow and backward-bow
    // solutions meet and a millimetre of lateral wobble flips between them.
    // A clamp must pin the pose on stable geometry, not on the knife edge.
    {
      let dy = ty - nb.a.position.y, dz = fz - nb.a.position.z;
      const elev = Math.atan2(dy, dz);
      const hi = Math.min(-this.restAng + 0.55, 1.25);
      const e = clamp(elev, -1.45, hi);
      if (e !== elev) {
        const d = Math.hypot(dy, dz);
        ty = nb.a.position.y + Math.sin(e) * d;
        fz = nb.a.position.z + Math.cos(e) * d;
      }
    }
    solve2(nb.a.position.y, nb.a.position.z, ty, fz, nb.l1, nb.l2, -1, _ik);
    let rA = nb.bindA - _ik.upper;
    let rB = nb.bindB - _ik.lower - rA;
    // ── the neck speed limit ─────────────────────────────────────────────────
    // The last line of defence, and the one that makes "the head snapped"
    // structurally impossible rather than merely fixed-for-now: however the
    // solve above was driven — a clamp edge, a mirror flip, a bug not yet
    // written — the JOINTS may not move faster than a real neck. The step is
    // wrapAngle'd, so a 2π branch re-labelling (same orientation, different
    // number) passes through freely and only genuine motion is limited. The
    // budget is far above everything measured in normal play (trot peaks
    // near 3 rad/s, the graze swing near 5) and far below any snap.
    if (this.neckPrevA !== null) {
      const dA = wrapAngle(rA - this.neckPrevA);
      const dB = wrapAngle(rB - this.neckPrevB);
      const total = Math.abs(dA) + Math.abs(dB);
      const budget = NECK_MAX_RATE * dt;
      if (total > budget) {
        const f = budget / total;
        rA = this.neckPrevA + dA * f;
        rB = this.neckPrevB + dB * f;
      }
    }
    this.neckPrevA = rA;
    this.neckPrevB = rB;
    nb.a.rotation.x = rA;
    nb.b.rotation.x = rB;

    // Looking at something: distributed down the neck so the animal turns to
    // look instead of the skull swivelling on a stick.
    let wantYaw = 0, wantPitch = 0;
    if (drive.look) {
      _a.copy(drive.look).sub(this.mesh.position);
      wantYaw = clamp(wrapAngle(Math.atan2(_a.x, _a.z) - this.mesh.rotation.y), -1.15, 1.15);
      wantPitch = clamp(Math.atan2(_a.y - (this.mesh.position.y + this.headTarget.y * S),
        Math.max(1, Math.hypot(_a.x, _a.z))), -0.45, 0.45);
    }
    this.headYaw = damp(this.headYaw, wantYaw * (1 - graze * 0.85), 5 + 7 * alert, dt);
    nb.a.rotation.y = this.headYaw * 0.30;
    nb.b.rotation.y = this.headYaw * 0.34;
    this.head.rotation.y = this.headYaw * 0.36;

    // A neck is a hinge, so swinging it down to crop carries the skull over
    // with it and ends up pointing the muzzle backwards and up. Real animals
    // counter-rotate at the atlas. `chain` is exactly how far the neck went, so
    // cancelling it and adding `grazeRake` aims the muzzle at an absolute angle
    // below horizontal, whatever the neck geometry underneath happens to be.
    //
    // Both neck angles come out of atan2, so the sum is only defined modulo a
    // turn and steps by 2π whenever the solve crosses a branch cut. The joints
    // do not care — a whole turn on an Euler component is the same orientation
    // — but this value is blended by `graze` and then damped, so a raw step put
    // a fraction of a revolution into the target and whipped the skull round
    // after it. Every deer lifting its head out of the grass crossed a cut, and
    // one grazing downslope crossed the other. Unwrap against last frame.
    const chain = this.neckChain + wrapAngle(rA + nb.b.rotation.x - this.neckChain);
    this.neckChain = chain;
    const grazePitch = (this.cfg.grazeRake ?? 1.40) - chain;
    this.headPitch = damp(this.headPitch, lerp(-wantPitch, grazePitch, graze), 6, dt);
    // ── the skull stop ───────────────────────────────────────────────────────
    // The neck has an anatomical stop; the atlas needs one too, and for the
    // same reason. `chain` is where the neck put the skull and `headPitch` is
    // what the atlas does about it, so their sum is the skull's own pitch in
    // the chest's frame — the number a viewer actually reads. Only the graze
    // path authors it; every other path lets the skull ride whatever the chain
    // did, which is how a short down-carried neck could crank the muzzle at
    // the sky. Measured across the cast the honest band is -0.54 (a fox with
    // its head up) to 1.43 (a bear with its nose in the grass), so these
    // bounds sit outside everything that reads correctly and make "the head is
    // on backwards" unreachable rather than merely unlikely — including for
    // species not written yet.
    this.headPitch = clamp(this.headPitch, SKULL_UP - chain, SKULL_DOWN - chain);
    this.head.rotation.x = this.headPitch;
    this.headRoll = damp(this.headRoll, -this.headYaw * 0.13, 5, dt);
    this.head.rotation.z = this.headRoll;
  }

  _poseEars(dt, drive, sn) {
    for (let i = 0; i < this.earB.length; i++) {
      const e = this.earB[i];
      if (!e) continue;
      this.earNext[i] -= dt;
      if (this.earNext[i] <= 0) {
        // Short, sharp, and uncorrelated between the two ears.
        this.earFlick[i] = 1;
        this.earNext[i] = 1.2 + i * 0.9 + Math.abs(Math.sin(this.breath * 3.1 + i * 2.1)) * 4.5;
      }
      this.earFlick[i] = Math.max(0, this.earFlick[i] - dt * 5.5);
      const f = this.earFlick[i];
      const flick = Math.sin(f * 24) * f * f * 0.6;
      const idle = Math.sin(this.breath * 0.7 + i * 3.0) * 0.07 * (1 - drive.alert);
      // Alert swivels forward; a hard run lays them back. Both signs were
      // inverted, which pinned a bolting hare's ears flat over its own nose —
      // the single most legible thing a frightened animal does, backwards.
      e.rotation.x = drive.alert * 0.42 + idle + flick * 0.5 - sn * 0.62;
      e.rotation.z = (i === 0 ? 1 : -1) * (0.12 - drive.alert * 0.18 + flick);
    }
  }

  _poseTail(dt, drive, sn) {
    if (!this.tailB.length) return;
    const swayTarget = Math.sin(this.phase * Math.PI * 2) * (0.10 + 0.24 * sn);
    this.tailSwayV += (swayTarget - this.tailSway) * 34 * dt;
    this.tailSwayV *= Math.exp(-7 * dt);
    this.tailSway += this.tailSwayV * dt;

    // The deer's alarm flag: tail up, white underside showing. That flash is
    // what makes a fleeing deer readable at two hundred metres.
    this.tailLift = damp(this.tailLift, Math.max(drive.flag ?? 0, drive.alert * 0.35), 9, dt);

    for (let i = 0; i < this.tailB.length; i++) {
      const t = this.tailB[i];
      // Positive X lifts: the tail chain runs down and back from the pelvis, so
      // a negative rotation tucked it under the animal instead of flagging it.
      // 1.30 rad only swung it from hanging to *horizontal*, which from behind
      // is a tail hidden against the rump — the flag has to go past vertical
      // before any of the white shows, and that flash is the one signal that
      // makes a fleeing deer readable at two hundred metres.
      t.rotation.x = this.tailLift * (i === 0 ? 2.30 : 0.45) + Math.sin(this.breath * 0.8 + i) * 0.035;
      t.rotation.y = this.tailSway * (1 - i * 0.25) * (i === 0 ? 1 : 0.8);
    }
  }

  _solveLegs(sh, ch) {
    for (const lg of this.legs) {
      const { upper, lower, cannon } = lg;
      const parent = upper.parent;

      // Hock target: the foot, stepped back along the bind-pose cannon, rotated
      // by heading only so the lower leg never tips with the body.
      _a.set(
        lg.foot.x - lg.footWZ * sh,
        lg.foot.y - lg.footWY,
        lg.foot.z - lg.footWZ * ch,
      );
      _m.copy(parent.matrixWorld).invert();
      _a.applyMatrix4(_m);
      _b.copy(lg.foot).applyMatrix4(_m);

      solve2(upper.position.y, upper.position.z, _a.y, _a.z, lg.l1, lg.l2, lg.L.bend, _ik);

      const rU = lg.bindUpper - _ik.upper;
      const rL = lg.bindLower - _ik.lower - rU;
      upper.rotation.x = rU;
      lower.rotation.x = rL;
      // The cannon aims at the actual foot point, which is what keeps a hoof
      // upright and a paw flat without either being a special case.
      const cAngle = Math.atan2(_b.z - _ik.hockZ, -(_b.y - _ik.hockY));
      cannon.rotation.x = lg.bindCannon - cAngle - rU - rL;

      // Small clamped splay so a turning animal does not cross its own legs.
      upper.rotation.z = clamp(
        Math.atan2(_a.x - upper.position.x, Math.max(0.05, lg.l1 + lg.l2)), -0.26, 0.26);
    }
    this.mesh.updateWorldMatrix(false, true);
  }
}

export { GAITS, LADDER };
