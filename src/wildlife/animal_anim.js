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
  gallop: { off: [0.00, 0.08, 0.42, 0.50], duty: 0.34, lift: 0.135, bobHz: 1, flight: 0.14, flightAt: 0.86, pitch: 2.0 },
  bound:  { off: [0.00, 0.06, 0.34, 0.40], duty: 0.30, lift: 0.150, bobHz: 1, flight: 0.30, flightAt: 0.70, pitch: 2.4 },
  hop:    { off: [0.20, 0.26, 0.00, 0.06], duty: 0.26, lift: 0.120, bobHz: 1, flight: 0.48, flightAt: 0.52, pitch: 1.6 },
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
};

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Matrix4();

const ease = (u) => u * u * (3 - 2 * u);

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
    this.chest = this.bones[this.info.iChest];
    this.head = this.bones[this.info.iHead];
    this.spineB = this.info.spine.map((i) => this.bones[i]);
    this.earB = this.info.ears.map((i) => this.bones[i]);
    this.tailB = this.info.tail.map((i) => this.bones[i]);

    const hb = proto.skel.bones[proto.skel.idx('head')];
    this.neckRest = new THREE.Vector3(0, hb.y, hb.z);   // mesh-local, unscaled
    this.headTarget = this.neckRest.clone();

    // Where the poll goes when the animal crops, in the same mesh-local frame.
    //
    // It is built as a point the chain can *reach*, on a fixed forward-and-down
    // line, rather than as a point on the ground. A quadruped's neck is far too
    // short to put the poll at grass height — a deer's muzzle sits a metre
    // below its withers and the chain spans less than half of that — so a
    // ground target clamps to "straight down", folds the head back under the
    // chest, and reads as a decapitated animal. The rest of the distance comes
    // from the crouch and the nose-down body pitch in update().
    this.grazePoint = this.neckRest.clone();
    if (this.neck) {
      const na = proto.skel.bones[this.info.neck[0]];
      const ang = gaitCfg.grazeAng ?? 1.20;              // below horizontal
      const reach = (this.neck.l1 + this.neck.l2) * 0.985;
      this.grazePoint.set(0, na.y - reach * Math.sin(ang), na.z + reach * Math.cos(ang));
    }
    // How far the withers drop as the forelegs flex to let the head down.
    this.crouch = this.info.legs[0].hipY * scale * 0.17;
    // Standing footprint, in world metres — the ground-plane probe uses it.
    this.bodyLen = Math.abs(this.info.legs[0].restZ - this.info.legs[2].restZ) * scale;
    this.bodyW = Math.abs(this.info.legs[0].restX) * 2 * scale;

    this.earFlick = [0, 0];
    this.earNext = [1.3, 2.7];
    this.headYaw = 0; this.headPitch = 0; this.headRoll = 0;
    this.tailSway = 0; this.tailSwayV = 0; this.tailLift = 0;
    this.breath = 0;
    this.bodyPitch = 0; this.bodyRoll = 0; this.bodyY = 0;
    this.lastSpeed = 0; this.surge = 0;
    this._warm = false;
    // Was the animal standing still last frame? See the re-key in update().
    this._wasStill = true;
  }

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
    this.breath = (pos.x * 0.7 + pos.z * 1.3) % 6.283;
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
    let flight = 0;
    if (G.flight > 0) {
      const u = (this.phase - G.flightAt) / G.flight;
      if (u >= 0 && u <= 1) flight = 4 * u * (1 - u);
    }
    const flightY = flight * liftM * 2.4 * (0.45 + 0.85 * sn);
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

    this.root.position.y = bob + flightY;
    this.root.rotation.x = this.bodyPitch + this.surge + drive.graze * 0.20 +
      Math.sin(this.phase * Math.PI * 2 - 0.55) * this.cfg.pitchAmp * (G.pitch ?? 1) * sn;
    this.root.rotation.z = this.bodyRoll;

    // Spine flex: the back gathers and extends through a bound, and breathes at
    // rest. Small numbers — a quadruped's back barely moves, and overdoing it
    // reads as a cat rather than a deer.
    const flex = (G.flight > 0 ? Math.sin(this.phase * Math.PI * 2 - 1.2) * 0.125 * sn : 0) + breathe;
    for (let i = 0; i < this.spineB.length; i++) {
      const last = i === this.spineB.length - 1;
      this.spineB[i].rotation.x = flex * (last ? 0.65 : 1);
      this.spineB[i].rotation.y = G.flight > 0 ? 0 : Math.sin(this.phase * Math.PI * 2 + i) * 0.022 * sn;
    }

    // Bones above the legs are now final, so world matrices are valid for both
    // the neck solve (needs the chest) and the leg IK (needs pelvis / chest).
    this.mesh.updateWorldMatrix(false, true);

    this._poseHead(dt, drive, sn);
    this._poseEars(dt, drive, sn);
    this._poseTail(dt, drive, sn);
    this._solveLegs(sh, ch);
  }

  _poseHead(dt, drive, sn) {
    if (!this.neck) return;
    const S = this.scale;
    const graze = drive.graze, alert = drive.alert;

    // Target in mesh-local space. Because the goal is a *fixed local point*,
    // the head is automatically stabilised against the barrel's bob — the body
    // bounces underneath it. A fraction of the bob is added back so it is not
    // eerily locked.
    _c.copy(this.neckRest);

    if (graze > 0.001) {
      _b.copy(this.grazePoint);
      // A nibbling drift so a grazing animal is never a statue.
      _b.z += Math.sin(this.breath * 0.55) * 0.05;
      _b.y += Math.sin(this.breath * 1.9) * 0.022;
      _c.lerp(_b, graze);
    }
    if (alert > 0.001) {
      _b.copy(this.neckRest);
      _b.y += 0.16; _b.z -= 0.06;
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
      const k = (1 - graze) * Math.min(1, sn * 3.2);
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
    const fz = Math.hypot(_b.x, _b.z) * Math.sign(_b.z || 1);
    solve2(nb.a.position.y, nb.a.position.z, _b.y, fz, nb.l1, nb.l2, -1, _ik);
    const rA = nb.bindA - _ik.upper;
    nb.a.rotation.x = rA;
    nb.b.rotation.x = nb.bindB - _ik.lower - rA;

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
    const chain = rA + nb.b.rotation.x;
    const grazePitch = (this.cfg.grazeRake ?? 1.40) - chain;
    this.headPitch = damp(this.headPitch, lerp(-wantPitch, grazePitch, graze), 6, dt);
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
