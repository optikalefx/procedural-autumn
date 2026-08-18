// ─────────────────────────────────────────────────────────────────────────────
//  animal_brain — what an animal decides, and how it gets there.
//
//  The animation layer is a pure function of (position, heading, speed, graze,
//  alert). This file is the only thing that writes those five numbers, so the
//  whole behaviour of the cast is legible in one place.
//
//  Two rules shape everything below:
//
//  1. **The player must be able to read the state from a moving car.** A deer
//     that is grazing has its head in the grass. A deer that has noticed you
//     stands bolt upright and stares. A deer that has decided to leave shows
//     you a white tail and goes. Anything subtler than that is invisible at
//     40 km/h and is therefore not worth simulating.
//
//  2. **The steering never fights the world.** Wander targets are rejected in
//     water and on cliffs before they are ever adopted, and a short probe fan
//     re-checks the ground ahead while moving, so an animal cannot walk into a
//     river or up a rock face and then have to be teleported out.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp, clamp01, lerp, wrapAngle, mulberry32 } from '../core/MathUtils.js';

export const ST = {
  IDLE:   0,   // standing, shifting weight, looking about
  GRAZE:  1,   // head down in the grass
  WANDER: 2,   // walking to a chosen spot
  ALERT:  3,   // has noticed you: frozen, head up, facing you
  FLEE:   4,   // leaving
  PATROL: 5,   // bears only: ambling along a river
};

// Water deeper than this is off limits to everything, always. Placement, wander
// targets and the per-step probe all use the same number, because "the deer is
// standing in the river" has been shipped by other authors here more than once.
export const WATER_MAX = 0.15;

// Probe fan for local avoidance. Straight ahead first so it wins ties.
const FAN = [0, -0.42, 0.42, -0.95, 0.95, -1.7, 1.7];

/** Move a scalar toward a target at a bounded rate. */
const toward = (v, t, rate) => (v < t ? Math.min(t, v + rate) : Math.max(t, v - rate));

export class Brain {
  /**
   * @param {string} key       species key
   * @param {object} sp        SPECIES[key] — gait + brain numbers
   * @param {number} seed      deterministic per individual
   * @param {object} group     shared herd record (see Wildlife.js)
   * @param {number} slot      index within the herd; 0 is the leader
   */
  constructor(key, sp, seed, group, slot) {
    this.key = key;
    this.cfg = sp.brain;
    this.gait = sp.gait;
    this.rnd = mulberry32(seed >>> 0);
    this.group = group;
    this.slot = slot;
    this.leader = slot === 0;

    this.pos = new THREE.Vector3();
    this.home = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.hasLook = false;

    this.heading = 0;
    this.wantHeading = 0;
    this.speed = 0;
    this.wantSpeed = 0;

    this.state = ST.IDLE;
    this.timer = 1;
    this.graze = 0;
    this.alert = 0;
    this.flag = 0;             // deer tail-up alarm flash
    this.spent = 0;            // flee stamina, so a chase does not last forever
    this.done = false;         // fled far enough to be recycled

    // Local avoidance is expensive (it samples the heightfield seven times), so
    // it runs at ~7 Hz on a per-animal offset rather than every frame. At a
    // deer's top speed that is still under a metre of travel per re-plan.
    this._probeT = this.rnd() * 0.14;
    this._stuck = 0;
    this._patrolDir = this.rnd() < 0.5 ? -1 : 1;
    this._patrolI = 0;
    this._stepT = 0;
    this._grazeStep = 0;
    this._avoid = 0;
    this._scale = 1;
  }

  /**
   * Re-point an existing brain at a new herd. Brains live in the animal pool
   * and are recycled, so a spawn costs one closure and no object churn.
   */
  bind(group, slot, seed) {
    this.group = group;
    this.slot = slot;
    this.leader = slot === 0;
    this.rnd = mulberry32(seed >>> 0);
    this._patrolI = 0;
    this._patrolDir = this.rnd() < 0.5 ? -1 : 1;
    this._stuck = 0;
    this._avoid = 0;
  }

  /** Place the animal for the first time (or after a long absence). */
  reset(x, y, z, heading, scale) {
    this.pos.set(x, y, z);
    this.home.set(x, y, z);
    this.target.set(x, y, z);
    this.heading = this.wantHeading = heading;
    this.speed = this.wantSpeed = 0;
    this.state = this.rnd() < this.cfg.grazeChance ? ST.GRAZE : ST.IDLE;
    if (this.cfg.patrol && this.rnd() < 0.6) this.state = ST.PATROL;
    this.timer = 1 + this.rnd() * 4;
    this.graze = this.state === ST.GRAZE ? 1 : 0;
    this.alert = 0; this.flag = 0; this.spent = 0; this.done = false;
    this._scale = scale;
  }

  // ── the frame ──────────────────────────────────────────────────────────────

  /**
   * @param {number} dt
   * @param {WorldData} W
   * @param {?{x,z,speed}} threat  the camper, or null
   * @param {?Brain} lead          the herd leader, if this animal is not it
   */
  update(dt, W, threat, lead) {
    const S = this._scale;
    const c = this.cfg;

    // ── how frightening is the camper right now ─────────────────────────────
    // Speed matters as much as distance: a camper crawling past at walking pace
    // barely registers, one coming at 20 m/s is an event. Folding speed into an
    // effective distance keeps every threshold below a single number.
    let d = Infinity, dEff = Infinity;
    if (threat) {
      d = Math.hypot(threat.x - this.pos.x, threat.z - this.pos.z);
      dEff = d - Math.abs(threat.speed) * 1.15;
    }
    // One animal spooking spooks the herd. This is the single cheapest thing
    // that makes a group of deer read as a group rather than as four soloists.
    const herdAlarm = this.group ? this.group.alarm : 0;

    this.timer -= dt;
    this._stepT -= dt;

    switch (this.state) {
      case ST.IDLE:   this._idle(dt, W); break;
      case ST.GRAZE:  this._graze(dt, W); break;
      case ST.WANDER: this._wander(dt, W, lead); break;
      case ST.ALERT:  this._alert(dt, threat, d); break;
      case ST.FLEE:   this._flee(dt, W, threat, d); break;
      case ST.PATROL: this._patrol(dt, W); break;
    }

    // ── threat overrides ────────────────────────────────────────────────────
    if (this.state !== ST.FLEE) {
      if (dEff < c.fleeDist || (herdAlarm > 0.5 && this.state !== ST.ALERT && dEff < c.alertDist)) {
        // Deer and rabbits freeze first — that beat of stillness before the
        // bolt is the whole reason a deer sighting feels like a sighting.
        if (this.state !== ST.ALERT) this._enterAlert();
      } else if (dEff < c.alertDist && this.state !== ST.ALERT) {
        this._enterAlert();
        this.timer = lerp(c.freezeTime[0], c.freezeTime[1], this.rnd()) * 1.6;
      }
    }

    // ── smoothed pose channels ──────────────────────────────────────────────
    const wantGraze = this.state === ST.GRAZE ? 1 : 0;
    const wantAlert = this.state === ST.ALERT ? 1
      : this.state === ST.FLEE ? 0.55
      : this.group && herdAlarm > 0.5 ? 0.4 : 0;
    this.graze = toward(this.graze, wantGraze, dt * (wantGraze ? 1.6 : 4.5));
    this.alert = toward(this.alert, wantAlert, dt * (wantAlert > this.alert ? 6 : 2.2));
    this.flag = toward(this.flag, this.state === ST.FLEE && this.key === 'deer' ? 1 : 0, dt * 5);

    this._steer(dt, W, S);
  }

  // ── states ─────────────────────────────────────────────────────────────────

  _idle(dt, W) {
    this.wantSpeed = 0;
    // An idle animal looks around. Nothing else about IDLE is visible, so this
    // is the only thing keeping it from reading as a statue.
    if (this.timer < 0) {
      const r = this.rnd();
      if (r < this.cfg.grazeChance) { this.state = ST.GRAZE; this.timer = this._span(this.cfg.grazeTime); }
      else { this._pickWander(W); }
    } else if (!this.hasLook || this.rnd() < dt * 0.35) {
      this._lookSomewhere();
    }
    void dt;
  }

  _graze(dt, W) {
    this.wantSpeed = 0;
    this.hasLook = false;
    // Grazing animals drift: a mouthful here, two steps, another mouthful. The
    // steps are what stop a meadow of deer looking like a diorama.
    if (this._stepT < 0) {
      this._stepT = 2.5 + this.rnd() * 5;
      this.wantHeading = this.heading + (this.rnd() - 0.5) * 1.1;
      this._grazeStep = 0.9 + this.rnd() * 1.4;
    }
    if (this._grazeStep > 0) {
      this._grazeStep -= dt;
      this.wantSpeed = this.gait.walk * 0.30 * this._scale;
    }
    if (this.timer < 0) {
      if (this.rnd() < 0.45) { this.state = ST.IDLE; this.timer = this._span(this.cfg.idleTime); }
      else this._pickWander(W);
    }
  }

  _wander(dt, W, lead) {
    // Followers do not choose destinations; they keep station on the leader.
    // Cohesion by station-keeping (rather than by a cohesion force) means the
    // herd holds a loose formation instead of collapsing into a pile.
    if (lead && !this.leader) {
      const ang = this.slot * 2.4 + 0.7;
      const r = this.cfg.herdRadius * (0.45 + 0.55 * ((this.slot * 37 % 13) / 13));
      this.target.set(
        lead.pos.x + Math.sin(lead.heading + ang) * r,
        0,
        lead.pos.z + Math.cos(lead.heading + ang) * r,
      );
    }

    const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    this.wantHeading = Math.atan2(dx, dz);
    this.hasLook = false;

    const arrive = lead && !this.leader ? 1.4 : 2.2;
    if (dist < arrive) {
      if (lead && !this.leader) {
        this.wantSpeed = 0;                       // in station: stand and wait
        if (lead.state === ST.GRAZE || lead.state === ST.IDLE) {
          this.state = this.rnd() < this.cfg.grazeChance ? ST.GRAZE : ST.IDLE;
          this.timer = this._span(this.state === ST.GRAZE ? this.cfg.grazeTime : this.cfg.idleTime);
        }
        return;
      }
      this.state = this.rnd() < this.cfg.grazeChance ? ST.GRAZE : ST.IDLE;
      this.timer = this._span(this.state === ST.GRAZE ? this.cfg.grazeTime : this.cfg.idleTime);
      return;
    }

    // Catch-up: a straggler trots, everyone else walks. Same trick every herd
    // animal uses, and it makes the group's shape breathe as it moves.
    const far = lead && !this.leader && dist > this.cfg.herdRadius * 1.9;
    this.wantSpeed = (far ? this.gait.trot * 0.85 : this.gait.walk) * this._scale
      * (far ? 1 : 0.85 + this._bias * 0.3);

    if (this.timer < 0) { this.state = ST.IDLE; this.timer = this._span(this.cfg.idleTime); }
    void dt; void W;
  }

  _enterAlert() {
    this.state = ST.ALERT;
    this.timer = this._span(this.cfg.freezeTime);
    this.wantSpeed = 0;
    if (this.group) this.group.alarm = 1;
  }

  _alert(dt, threat, d) {
    this.wantSpeed = 0;
    if (threat) {
      // Turn to face it. Prey square up to what they are watching so both eyes
      // and both ears are on it; that pose is unmistakable at any distance.
      this.lookAt.set(threat.x, this.pos.y + 1.4 * this._scale, threat.z);
      this.hasLook = true;
      const want = Math.atan2(threat.x - this.pos.x, threat.z - this.pos.z);
      // Rabbits and deer keep the threat off the shoulder rather than dead
      // ahead — squared up but ready to turn and run.
      this.wantHeading = want + (this.slot & 1 ? 0.75 : -0.75);
    }
    if (this.timer < 0) {
      if (d < this.cfg.fleeDist * 1.25) {
        this.state = ST.FLEE;
        this.timer = this._span(this.cfg.fleeTime);
        this.spent = 0;
        // Prey do not ramp up from a standstill; the first bound is already
        // most of the speed. Without this kick the freeze-to-flight transition
        // reads as a car pulling away rather than an animal launching.
        this.speed = Math.max(this.speed, this.gait.trot * this._scale * 0.85);
        if (threat) {
          const away = Math.atan2(this.pos.x - threat.x, this.pos.z - threat.z);
          // The herd leaves as one body, in one direction.
          if (this.group) {
            if (this.group.fleeH === null) this.group.fleeH = away + (this.rnd() - 0.5) * 0.5;
            this.wantHeading = this.group.fleeH + (this.rnd() - 0.5) * 0.35;
          } else {
            this.wantHeading = away + (this.rnd() - 0.5) * 0.5;
          }
          this.heading = this.wantHeading;   // the launch is instant, not a turn
        }
      } else if (d > this.cfg.calmDist * 0.55) {
        this.state = ST.IDLE;
        this.timer = this._span(this.cfg.idleTime) * 0.5;
        if (this.group) this.group.alarm = 0;
      } else {
        this.timer = 0.6 + this.rnd();       // still watching
      }
    }
    void dt;
  }

  _flee(dt, W, threat, d) {
    this.spent += dt;
    this.wantSpeed = this.gait.run * this._scale * (0.82 + this._bias * 0.25);
    this.hasLook = false;

    if (threat && this.spent < 1.6) {
      // Early in the flight, keep committing away from the threat; after that
      // the animal is just running and stops steering off the player.
      const away = Math.atan2(this.pos.x - threat.x, this.pos.z - threat.z);
      this.wantHeading = wrapAngle(this.wantHeading) * 0.6 + away * 0.4;
    }
    // A long run curves. A perfectly straight sprint reads as a bug.
    this.wantHeading += Math.sin(this.spent * 0.9 + this.slot) * dt * 0.5;

    if (this.timer < 0 || (d > this.cfg.calmDist && this.spent > 1.2)) {
      this.state = ST.ALERT;
      this.timer = 1.0 + this.rnd() * 1.6;
      if (this.group) { this.group.alarm = 0; this.group.fleeH = null; }
      // A rabbit that has run this far is gone — it went down a hole. Letting
      // it simply stop in the open would undo the whole effect.
      if (this.key === 'rabbit') this.done = true;
    }
    void W;
  }

  _patrol(dt, W) {
    // Bears walk a river. `line` is a polyline handed over at spawn.
    const line = this.group?.line;
    if (!line || line.length < 2) { this._pickWander(W); return; }
    let p = line[this._patrolI];
    const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
    if (dx * dx + dz * dz < 36) {
      this._patrolI += this._patrolDir;
      if (this._patrolI >= line.length) { this._patrolI = line.length - 2; this._patrolDir = -1; }
      if (this._patrolI < 0) { this._patrolI = 1; this._patrolDir = 1; }
      p = line[this._patrolI];
    }
    // Bears do not walk *in* the river, they walk the bank. Offsetting the
    // target sideways by a few metres is enough, and the probe fan handles the
    // rest wherever the channel wanders.
    const side = this._patrolDir * 4.5;
    this.wantHeading = Math.atan2(p.x - this.pos.x + side * 0.2, p.z - this.pos.z);
    this.wantSpeed = this.gait.walk * this._scale * 0.72;
    if (this.timer < 0) {
      this.state = this.rnd() < 0.5 ? ST.GRAZE : ST.IDLE;
      this.timer = this._span(this.state === ST.GRAZE ? this.cfg.grazeTime : this.cfg.idleTime);
    }
    void dt;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  get _bias() { return ((this.slot * 2654435761) % 97) / 97; }

  _span(r) { return lerp(r[0], r[1], this.rnd()); }

  _lookSomewhere() {
    const a = this.rnd() * Math.PI * 2;
    const r = 8 + this.rnd() * 25;
    this.lookAt.set(this.pos.x + Math.sin(a) * r, this.pos.y + 1.0 + this.rnd() * 1.5, this.pos.z + Math.cos(a) * r);
    this.hasLook = true;
  }

  /**
   * Choose somewhere to walk to. Rejected outright in water, on steep ground
   * and outside the home range, so nothing downstream ever has to rescue it.
   */
  _pickWander(W) {
    const c = this.cfg;
    for (let i = 0; i < 6; i++) {
      const a = this.rnd() * Math.PI * 2;
      const r = c.wanderRadius * (0.25 + 0.75 * this.rnd());
      const x = this.home.x + Math.sin(a) * r;
      const z = this.home.z + Math.cos(a) * r;
      if (!W.isInBounds(x, z)) continue;
      if (W.getWaterDepth(x, z) > WATER_MAX) continue;
      if (W.getSlope(x, z) > 0.85) continue;
      this.target.set(x, 0, z);
      this.state = ST.WANDER;
      this.timer = this._span(c.walkTime);
      return;
    }
    // Boxed in — stand still rather than march into a cliff.
    this.state = ST.IDLE;
    this.timer = this._span(c.idleTime);
  }

  /**
   * Heading / speed integration plus the probe fan. Everything that can put an
   * animal somewhere it should not be passes through here.
   */
  _steer(dt, W, S) {
    this._probeT -= dt;
    if (this._probeT <= 0) {
      this._probeT = 0.14;
      const reach = clamp(1.6 + this.speed * 0.55, 2.0, 9.0) * S;
      let bestScore = -1e9, bestA = 0;
      for (let i = 0; i < FAN.length; i++) {
        const a = FAN[i];
        const h = this.wantHeading + a;
        const x = this.pos.x + Math.sin(h) * reach;
        const z = this.pos.z + Math.cos(h) * reach;
        let s = -Math.abs(a) * 0.9;
        if (!W.isInBounds(x, z)) s -= 100;
        else {
          const depth = W.getWaterDepth(x, z);
          // Hard wall at the waterline; a soft cost in the shallows so animals
          // prefer to stay dry without being unable to cross a trickle.
          if (depth > WATER_MAX) s -= 100;
          else s -= depth * 6;
          const slope = W.getSlope(x, z);
          s -= Math.max(0, slope - 0.45) * 6;
        }
        if (s > bestScore) { bestScore = s; bestA = a; }
      }
      this._avoid = bestA;
      // Everything ahead is bad: turn hard and try again next tick. Fleeing
      // animals get pinned against rivers otherwise.
      if (bestScore < -50) { this._avoid = (this.slot & 1 ? 1 : -1) * 2.2; this._stuck += 1; }
      else this._stuck = 0;
      if (this._stuck > 6) { this.wantHeading += Math.PI; this._stuck = 0; }
    }

    const goal = this.wantHeading + (this._avoid ?? 0);
    // Turn rate falls with speed the way a real animal's does — a bounding deer
    // cannot pivot, which is what makes its flight path arc.
    const sn = clamp01(this.speed / (this.gait.run * S));
    const turnRate = lerp(3.0, 1.5, sn) * (this.state === ST.ALERT ? 0.55 : 1);
    const dh = wrapAngle(goal - this.heading);
    this.heading += clamp(dh, -turnRate * dt, turnRate * dt);

    // An animal will not accelerate into a turn it has not made yet.
    const facing = 1 - clamp01(Math.abs(dh) / 1.6) * 0.7;
    const want = this.wantSpeed * facing;
    // Explosive off the mark, then merely quick once it is running.
    const accel = this.state === ST.FLEE ? (this.spent < 1.0 ? 18 : 8) * S : 3.2 * S;
    const decel = 7 * S;
    this.speed = toward(this.speed, want, (want > this.speed ? accel : decel) * dt);
    if (this.speed < 0.02) this.speed = 0;

    if (this.speed > 0) {
      const nx = this.pos.x + Math.sin(this.heading) * this.speed * dt;
      const nz = this.pos.z + Math.cos(this.heading) * this.speed * dt;
      // Final guard. The probe fan should already have prevented this, but the
      // rule is that nothing stands in standing water, so it is enforced at the
      // point of motion rather than trusted to the layer above.
      if (W.isInBounds(nx, nz) && W.getWaterDepth(nx, nz) <= WATER_MAX) {
        this.pos.x = nx; this.pos.z = nz;
      } else {
        this.wantHeading = this.heading + 1.9;
        this.speed *= 0.35;
      }
    }
    this.pos.y = W.getHeight(this.pos.x, this.pos.z);
  }

  /** Fill an animation drive object. Reused every frame; never allocates. */
  fill(drive, lod) {
    drive.pos = this.pos;
    drive.heading = this.heading;
    drive.speed = this.speed;
    drive.graze = this.graze;
    drive.alert = this.alert;
    drive.flag = this.flag > 0.5;
    drive.look = this.hasLook ? this.lookAt : null;
    drive.lod = lod;
    return drive;
  }
}
