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
import { clamp, clamp01, lerp, smoothstep, wrapAngle, mulberry32 } from '../core/MathUtils.js';

export const ST = {
  IDLE:   0,   // standing, shifting weight, looking about
  GRAZE:  1,   // head down in the grass
  WANDER: 2,   // walking to a chosen spot
  ALERT:  3,   // has noticed you: frozen, head up, facing you
  FLEE:   4,   // leaving
  PATROL: 5,   // bears only: ambling along a river
  // Long-range wariness. Between `noticeDist` and `alertDist` an animal has
  // seen you but is in no danger: it stops feeding, swings broadside, watches,
  // and drifts a few steps across your line. See `_watch` for why this state
  // exists at all — it is the only one of the six that is here for the
  // *player's* eyes rather than the animal's.
  WATCH:  6,
  // ── the alpine pair ────────────────────────────────────────────────────────
  // Goats and rams live on the crags, and the one thing they do that nothing
  // else in the cast does is treat a boulder as ground: they walk up onto one
  // and stand on top of it. CLIMB is the walk up, PERCH is standing there.
  //
  // Only a species with a `rock` block in its brain (see `mammals/goat.js`)
  // ever enters either, and while it is in them `Brain.rock` names the boulder
  // — which is what `_groundY` reads to lift the animal off the heightfield.
  CLIMB:  7,
  PERCH:  8,
};

// Water deeper than this is off limits to everything, always. Placement, wander
// targets and the per-step probe all use the same number, because "the deer is
// standing in the river" has been shipped by other authors here more than once.
export const WATER_MAX = 0.15;

// Probe fan for local avoidance. Straight ahead first so it wins ties.
const FAN = [0, -0.42, 0.42, -0.95, 0.95, -1.7, 1.7];

// ── how tightly an animal may turn ───────────────────────────────────────────
// The constraint on a body is the ARC it can describe, not the rate it can spin
// at, and getting that backwards is what made the cast pivot. A minimum turn
// radius of one body length is about right for a quadruped, and
// `TURN_TIME * gait.walk` IS that body length without adding a per-species
// number to keep in sync: walk speed already scales with body size across the
// whole cast, from a squirrel to a bear. `camp_dog.js` has steered this way all
// along (`Math.min(1.35, speed * 5.0)`), which is why the dog never pivoted.
const TURN_TIME = 1.2;
// A floor on that radius, in metres, and a guard rather than a tuning knob. It
// exists because the derivation above inherits whatever the gait table says,
// and one species' gait table is wrong: the fox's clips do not touch the
// ground, so it measures a 0.08 m/s walk and would be handed a 10 cm turn
// radius — the pivot, back again, for exactly one animal. Every correctly
// measured species is already well clear (squirrel 0.84 m is the smallest, the
// deer 1.50), so this can never reshape the cast; it stops binding by itself
// the day the fox's clips are rebuilt. See `glb.measure` in mammals/fox.js.
const MIN_RADIUS = 0.45;
// The on-the-spot shuffle, rad/s — what an animal that is NOT going anywhere
// turns at. At ~29 deg/s a half turn takes six seconds, slow enough that the
// residual foot slide reads as shifting weight rather than as a turntable. It
// has to exist: a deer that has just noticed you turns to face you without
// walking anywhere, and an animal pinned against a river has to be able to
// unwind on the spot or it is stuck there.
const PIVOT = 0.5;
// The states that are journeys. Only these insist on carrying a walk through a
// turn; see `_steer`.
const TRAVELLING = new Set([ST.WANDER, ST.FLEE, ST.PATROL, ST.CLIMB]);

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
    this.yawRate = 0;          // rad/s actually applied, for the rigs' bank
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
    this._lookT = 2 + this.rnd() * 5;
    this.headUp = false;
    this._watchMove = 0;       // seconds left of the current wary drift
    this._watchSide = 1;       // which way it is drifting across your line
    this._avoid = 0;
    // Seconds spent wanting to move and going nowhere, and the countdown that
    // says the way out is closed. See the blocked-step guard in _steer.
    this._pinned = 0;
    this._cornered = 0;
    this._fleeX = 0; this._fleeZ = 0;   // where this flight started from
    this._scale = 1;

    // ── standing on a rock ────────────────────────────────────────────────
    // `rock` is the boulder this animal is currently engaged with, taken from
    // its group's list (Wildlife._findPerches) — null for every species that
    // has no `rock` block, and null most of the time for the two that do.
    //
    // `ground` is the same override wearing the interface the gait solver
    // wants. `animal_anim` samples the world in exactly one way — six calls to
    // `getHeight(x, z)` and nothing else — so handing it something else that
    // answers that one question is all it takes to make the feet, the body
    // plane and the body height follow the rock instead of the hillside.
    // Built once, here, because the streaming path may not allocate.
    this.rock = null;
    this._W = null;
    this.ground = this.cfg.rock
      ? { getHeight: (x, z) => this._groundY(this._W, x, z) }
      : null;
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
    this._pinned = 0;
    this._cornered = 0;
    this._watchMove = 0;
    this._release();
  }

  /** Place the animal for the first time (or after a long absence). */
  reset(x, y, z, heading, scale) {
    this.pos.set(x, y, z);
    this.home.set(x, y, z);
    this.target.set(x, y, z);
    this.heading = this.wantHeading = heading;
    this.yawRate = 0;
    this.speed = this.wantSpeed = 0;
    this.state = this.rnd() < this.cfg.grazeChance ? ST.GRAZE : ST.IDLE;
    if (this.cfg.patrol && this.rnd() < 0.6) this.state = ST.PATROL;
    this.headUp = false;
    this._watchMove = 0;
    this._lookT = 1 + this.rnd() * 6;
    this.timer = 1 + this.rnd() * 4;
    this.graze = this.state === ST.GRAZE ? 1 : 0;
    this.alert = 0; this.flag = 0; this.spent = 0; this.done = false;
    this._pinned = 0; this._cornered = 0;
    this._release();
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
    // The gait solver reads the ground through `this.ground`, which closes over
    // the brain rather than over a world — so the world it should be asking is
    // whichever one was handed in this frame.
    this._W = W;

    switch (this.state) {
      case ST.IDLE:   this._idle(dt, W); break;
      case ST.GRAZE:  this._graze(dt, W); break;
      case ST.WANDER: this._wander(dt, W, lead); break;
      case ST.ALERT:  this._alert(dt, threat, d); break;
      case ST.FLEE:   this._flee(dt, W, threat, d); break;
      case ST.PATROL: this._patrol(dt, W); break;
      case ST.WATCH:  this._watch(dt, W, threat); break;
      case ST.CLIMB:  this._climb(dt, W); break;
      case ST.PERCH:  this._perch(dt, W, threat, d); break;
    }

    // ── threat overrides ────────────────────────────────────────────────────
    //
    // Three bands, not two, and the outer one is new. `alertDist` is a freeze,
    // and a freeze is the *worst* thing an animal can do for legibility: at a
    // hundred metres a motionless deer is thirteen pixels of brown in gold
    // grass and the eye reads it as a rock. So the freeze now happens only
    // where it is actually readable, and the band outside it — from
    // `alertDist` out to `noticeDist` — is WATCH: heads up, broadside, moving.
    const notice = c.noticeDist ?? c.alertDist;
    // An animal that tried to leave and found it could not has already made
    // its decision, and WATCH is that decision: head up, broadside, drifting,
    // eyes on you. Re-freezing it into ALERT because the threat is close would
    // undo it one frame later and every frame after, and it would spend the
    // whole encounter as a statue — which is the failure WATCH exists to
    // prevent. It holds until the corner times out and it tries again.
    // ── and the animal that will not be moved ───────────────────────────────
    // A goat on top of a boulder is doing the one thing this whole species
    // exists to do, and a threat band that pulled it off the rock at 30 m
    // would mean the player never sees it: the encounter would resolve into
    // an animal standing on the ground, which is every other animal. It is
    // also true — nothing standing on a rock above you is worried about you.
    // So the bands are suppressed while perched, right up until the camper is
    // inside `fleeDist`, at which point it comes down and leaves like anything
    // else. `_perch` does the watching in the meantime.
    const holding = (this._cornered > 0 && this.state === ST.WATCH)
      || (this.state === ST.PERCH && dEff > c.fleeDist);
    if (this.state !== ST.FLEE && !holding) {
      if (dEff < c.fleeDist || (herdAlarm > 0.5 && this.state !== ST.ALERT && dEff < c.alertDist)) {
        // Deer and rabbits freeze first — that beat of stillness before the
        // bolt is the whole reason a deer sighting feels like a sighting.
        if (this.state !== ST.ALERT) this._enterAlert();
      } else if (dEff < c.alertDist && this.state !== ST.ALERT && this.state !== ST.WATCH) {
        // `!== ST.WATCH` is the other half of the statue fix. An animal that
        // has already done its freeze and settled into watching must not be
        // re-frozen every frame just for standing inside `alertDist`; it has
        // already paid that beat. It re-freezes only by getting genuinely
        // closer, which is the `dEff < fleeDist` branch above.
        this._enterAlert();
        // Was * 1.6, which at 1.0-2.6 s of base freeze ran to 4.2 s. A player
        // closing at 13 m/s covers 55 m in that time, so the long freeze ate
        // essentially the whole encounter and the deer was motionless for all
        // of it. Held to roughly the honest freeze length, the stare still
        // reads as a stare and then resolves into wary movement while the
        // player is still in range to see it.
        this.timer = lerp(c.freezeTime[0], c.freezeTime[1], this.rnd()) * 1.05;
      } else if (dEff < notice && this.state !== ST.ALERT && this.state !== ST.WATCH) {
        this._enterWatch();
      } else if (this.state === ST.WATCH && dEff > notice * 1.2) {
        // Out of range again: back to whatever it was doing, and it goes back
        // to feeding rather than standing, because a meadow of statues is the
        // failure mode this state was added to avoid.
        this.state = (c.patrol && this.group?.line) ? ST.PATROL
          : this.rnd() < c.grazeChance ? ST.GRAZE : ST.IDLE;
        this.timer = this._span(this.state === ST.GRAZE ? c.grazeTime : c.idleTime);
        this.headUp = false;
      }
    }

    // ── smoothed pose channels ──────────────────────────────────────────────
    const wantGraze = (this.state === ST.GRAZE && !this.headUp) ? 1 : 0;
    const wantAlert = this.state === ST.ALERT ? 1
      : this.state === ST.WATCH ? (this.wantSpeed > 0.05 ? 0.62 : 0.85)
      : this.state === ST.FLEE ? 0.55
      // A perched animal that can see you is head-up and watching — the same
      // pose WATCH holds, and for the same reason: it is legible. One that
      // cannot see anybody is just standing on a rock, and stays soft.
      : this.state === ST.PERCH ? (d < notice ? 0.80 : 0.15)
      : this.group && herdAlarm > 0.5 ? 0.4 : 0;
    this.graze = toward(this.graze, wantGraze, dt * (wantGraze ? 1.6 : 4.5));
    this.alert = toward(this.alert, wantAlert, dt * (wantAlert > this.alert ? 6 : 2.2));
    // The white scut. It goes fully up in flight, and to half-mast the moment
    // the animal freezes — a stationary deer is the hardest thing in the game
    // to see, and this is the one high-value patch on it. Real deer do raise
    // the tail as they square up, before they commit to leaving.
    const wantFlag = this.key !== 'deer' ? 0
      : this.state === ST.FLEE ? 1
      : this.state === ST.ALERT ? 0.8
      : this.state === ST.WATCH ? 0.55 : 0;
    this.flag = toward(this.flag, wantFlag, dt * 5);

    this._steer(dt, W, S);

    // Let go of the boulder once the animal is genuinely clear of it. Held
    // until then rather than dropped the moment it leaves PERCH, so a goat
    // walking off the top rides its own flank down instead of falling through
    // it — and so a flight starts by coming down the rock, which is the only
    // way off one that does not look like a teleport.
    if (this.rock && this.state !== ST.CLIMB && this.state !== ST.PERCH) {
      const R = this.rock;
      const dx2 = this.pos.x - R.x, dz2 = this.pos.z - R.z;
      if (dx2 * dx2 + dz2 * dz2 > (R.r * 1.6) * (R.r * 1.6)) this._release();
    }
  }

  // ── states ─────────────────────────────────────────────────────────────────

  _idle(dt, W) {
    this.wantSpeed = 0;
    // An idle animal looks around. Nothing else about IDLE is visible, so this
    // is the only thing keeping it from reading as a statue.
    if (this.timer < 0) {
      if (this._maybeClimb()) return;
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
    // Every few mouthfuls a grazing animal lifts its head and scans. It is the
    // most recognisable thing deer do, and it is also the only moment a feeding
    // animal is legible at forty metres — head down it is a low dark blob among
    // the bushes, head up it is unmistakably a deer.
    this._lookT -= dt;
    if (this._lookT <= 0) {
      if (this.headUp) { this.headUp = false; this._lookT = 3.5 + this.rnd() * 7.5; }
      else { this.headUp = true; this._lookT = 1.3 + this.rnd() * 2.4; this._lookSomewhere(); }
    }
    if (!this.headUp) this.hasLook = false;
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
      if (this._maybeClimb()) return;
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
      // ahead — squared up but ready to turn and run. That angle is now near
      // enough side-on to matter: a deer seen head-on is about 0.5 m wide and
      // seen across the flank about 1.9 m, so widening the shoulder from 43 to
      // 69 degrees is most of a four-fold gain in silhouette area for nothing.
      // Reference plate 3 is the argument — its bear is legible at a hundred
      // metres because it is a flat dark shape presented broadside, and a deer
      // angled toward you is a narrow smudge no matter what its hide does.
      this.wantHeading = want + (this.slot & 1 ? 1.2 : -1.2);
    }
    if (this.timer < 0) {
      if (d < this.cfg.fleeDist * 1.25 && this._cornered <= 0) {
        this.state = ST.FLEE;
        this.timer = this._span(this.cfg.fleeTime);
        this.spent = 0;
        this._fleeX = this.pos.x; this._fleeZ = this.pos.z;
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
      } else {
        // The freeze is a *beat*, not a state, and it used to be neither.
        //
        // The exits here were written against `d`, but the override at the top
        // of `update` re-arms ALERT against `dEff`, which is `d` minus fifteen
        // metres at driving speed. So for every threat distance between those
        // two thresholds the animal fell out of ALERT and was slammed straight
        // back into it on the same frame, forever: head up, speed zero, for as
        // long as the player was anywhere near. That band — 43 to 77 m of
        // threat distance, 62 to 96 m from the eye — is precisely where the
        // measured median closest approach of 77 m lands. The one moment the
        // encounter was supposed to happen, the deer was a statue, and a
        // statue is the least visible thing in this game.
        //
        // So the freeze now resolves the way it reads in life: stand and
        // stare, then relax into wary movement while still keeping an eye on
        // you. WATCH is the resolution, not IDLE, because the player is still
        // there — and WATCH moves.
        this.state = ST.WATCH;
        this._enterWatch();
        if (this.group) this.group.alarm = 0.35;
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

    // ── a flight that gains no ground is not a flight ───────────────────────
    // The blocked-step guard in `_steer` catches an animal held against the
    // waterline; this catches the other shape of the same trap, where nothing
    // is ever *blocked* but there is nowhere to go — a river spit, an inside
    // bend, an island. There the animal sprints two seconds, runs out of land,
    // curves back past the threat and ends the flight no further away than it
    // started, whereupon ALERT re-arms FLEE and it does it again for as long
    // as the player stays parked. Traced with a kayak held three metres off a
    // bear (tools/_scratch/bearstuck.mjs): five of forty bank sites did this.
    //
    // Measured on the animal's OWN displacement, not on the range to the
    // threat: a deer being run down by a camper at 13 m/s is sprinting flat
    // out and closing anyway, and scoring that as a failed escape would stop
    // it dead in front of the car. Ground covered cannot be argued with.
    // Two seconds is long enough to tell a real escape from a lap of a pocket
    // of land — an unobstructed sprint clears twice this — and if it bought
    // nothing, stop running: stand, face it, watch.
    const gained = Math.hypot(this.pos.x - this._fleeX, this.pos.z - this._fleeZ);
    if (threat && this.spent > 2 && gained < this.gait.run * this._scale * 0.9) {
      this._cornered = 6;
      this._enterWatch();
      if (this.group) { this.group.alarm = 0.35; this.group.fleeH = null; }
      return;
    }

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

  _enterWatch() {
    this.state = ST.WATCH;
    // Weighted toward moving rather than standing. The first cut of this state
    // split the time about evenly, and `fractionMovingInView` measured *worse*
    // than no WATCH at all (24.2% -> 20.5%): it had replaced wandering animals
    // with standing ones. Motion is the entire reason the state exists, so the
    // drift is now the default and the pauses are the punctuation.
    this.timer = 0.5 + this.rnd() * 0.7;
    this.headUp = true;
    this.hasLook = true;
    this._watchMove = 0;
    this._grazeStep = 0;
    if (this.group && this.group.alarm < 0.35) this.group.alarm = 0.35;
  }

  /**
   * Wary, at a distance. This state exists for the *player*, not the animal.
   *
   * The measured problem it answers: off-road, the median closest approach to
   * an animal is 77 m, where a 1.5 m deer subtends about sixteen pixels of the
   * player's viewport — in gold grass, at a wide chase framing, while they are
   * steering. Nothing static survives that. Two things do, and both are here:
   *
   *   · **Motion.** Peripheral vision is a motion detector long before it is a
   *     contrast detector. A sixteen-pixel blob that walks is seen; the same
   *     blob standing still is not, however dark it is.
   *   · **Broadside.** A deer seen head-on is ~0.5 m wide; seen across the
   *     flank it is ~1.9 m. That is close to four times the silhouette area,
   *     for free, and it is also what a wary ungulate genuinely does — it
   *     drifts across your line keeping one eye on you rather than facing you
   *     down or turning tail.
   *
   * So: stop feeding, head up, swing side-on, watch, take a few steps, watch
   * again. It never carries the animal far — the drift alternates sides and is
   * reeled back toward home — so this does not thin the population out ahead
   * of the player the way a long-range flee response would.
   */
  _watch(dt, W, threat) {
    const bearing = threat
      ? Math.atan2(threat.x - this.pos.x, threat.z - this.pos.z)
      : this.heading;
    if (threat) {
      this.lookAt.set(threat.x, this.pos.y + 1.45 * this._scale, threat.z);
      this.hasLook = true;
    }

    if (this._watchMove > 0) {
      this._watchMove -= dt;
      this.wantHeading = bearing + Math.PI * 0.5 * this._watchSide;
      // A walk, not a trot. This is unhurried on purpose: an animal that
      // scurries at 120 m has already spent the reaction the close pass wants.
      this.wantSpeed = this.gait.walk * this._scale * (0.85 + this._bias * 0.35);
      if (this._watchMove <= 0) this.timer = 0.8 + this.rnd() * 1.2;
    } else {
      this.wantSpeed = 0;
      // Squared up but off the shoulder, so the head reads against the sky
      // and the flank still reads against the ground.
      this.wantHeading = bearing + (this.slot & 1 ? 1.15 : -1.15);
      if (this.timer < 0) {
        // Drift back toward home if the last few steps took it too far out,
        // otherwise alternate so the animal stays roughly where it lives.
        const hx = this.home.x - this.pos.x, hz = this.home.z - this.pos.z;
        const far = Math.hypot(hx, hz) > this.cfg.wanderRadius * 1.15;
        if (far) {
          const toHome = Math.atan2(hx, hz);
          this._watchSide = wrapAngle(toHome - bearing) > 0 ? 1 : -1;
        } else {
          this._watchSide = -this._watchSide;
        }
        this._watchMove = 2.0 + this.rnd() * 2.4;
      }
    }
    void W;
  }

  // ── the rocks ──────────────────────────────────────────────────────────────
  //
  // Everything below is the alpine pair's, and it is inert for every other
  // species: without a `rock` block in the brain, `_maybeClimb` returns false
  // on its first line and `this.rock` is never set, so `_groundY` is
  // `W.getHeight` and the two states are unreachable.
  //
  // What the player should see, in order: a goat leaves off feeding, walks to a
  // boulder, slows at the foot of it, walks *up* it, and stands on top looking
  // at you for half a minute. There is no climbing animation and there is no
  // collision — the whole effect is that while the animal is engaged with a
  // rock, the ground under it is that rock. See `_groundY`.

  /**
   * Take the rock, or don't. Called at the end of a feed or an idle, which is
   * where every other species picks a new wander target.
   */
  _maybeClimb() {
    const R = this.cfg.rock;
    if (!R) return false;
    if (this.rnd() > R.climbChance) return false;
    const list = this.group?.rocks;
    if (!list || !list.length) return false;

    // Nearest free boulder inside reach. One animal per rock — two goats
    // solving for the same summit stand inside each other, and a herd of three
    // on one boulder is a bug that looks exactly like a bug.
    let best = null, bestD2 = R.reach * R.reach;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r.taken >= 0 && r.taken !== this.slot) continue;
      const dx = r.x - this.pos.x, dz = r.z - this.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = r; }
    }
    if (!best) return false;

    this._release();
    this.rock = best;
    best.taken = this.slot;
    this.target.set(best.x, 0, best.z);
    this.state = ST.CLIMB;
    // A deadline, not a duration: if the way up is blocked the animal gives up
    // and walks off rather than grinding at the foot of the rock forever. It
    // scales with the walk, because `reach` is generous and a fixed ten
    // seconds would abandon every boulder further off than about fifteen
    // metres — which is most of them.
    const walk = Math.max(0.2, this.gait.walk * this._scale * 0.7);
    this.timer = 8 + Math.sqrt(bestD2) / walk;
    this.headUp = false;
    return true;
  }

  /** Walking to, and then up, the chosen boulder. */
  _climb(dt, W) {
    const R = this.rock;
    if (!R) { this._pickWander(W); return; }
    const dx = R.x - this.pos.x, dz = R.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    this.wantHeading = Math.atan2(dx, dz);
    this.hasLook = false;
    // Slow to a picking walk at the foot of it. That change of pace is what
    // reads as climbing — the body pitch and the leg lift come free, because
    // the ground the gait solver is standing on has genuinely tilted up.
    this.wantSpeed = this.gait.walk * this._scale * (d > R.r * 1.35 ? 0.85 : 0.42);
    if (d < R.r * 0.35) {
      this.state = ST.PERCH;
      this.timer = this._span(this.cfg.rock.perchTime);
      this.headUp = true;
      this._lookT = 1.5 + this.rnd() * 3;
      return;
    }
    if (this.timer < 0) this._offRock(W);
    void dt;
  }

  /**
   * Standing on top. The pose is the payoff, so it does almost nothing: no
   * drift, no feeding, just the head up and the animal turned across whatever
   * it is looking at.
   */
  _perch(dt, W, threat, d) {
    this.wantSpeed = 0;
    this.headUp = true;
    if (threat && d < this.cfg.noticeDist) {
      this.lookAt.set(threat.x, this.pos.y + 1.2 * this._scale, threat.z);
      this.hasLook = true;
      // Off the shoulder rather than dead ahead, for the reason `_alert`
      // gives: a broadside animal is four times the silhouette of a head-on
      // one, and up here it is standing against sky.
      const bearing = Math.atan2(threat.x - this.pos.x, threat.z - this.pos.z);
      this.wantHeading = bearing + (this.slot & 1 ? 1.05 : -1.05);
    } else {
      this._lookT -= dt;
      if (this._lookT <= 0) { this._lookT = 2.5 + this.rnd() * 5; this._lookSomewhere(); }
    }
    if (this.timer < 0) this._offRock(W);
  }

  /** Down, and away — a wander target off the far side of the rock. */
  _offRock(W) {
    const R = this.rock;
    if (!R) { this._pickWander(W); return; }
    for (let i = 0; i < 6; i++) {
      const a = this.rnd() * Math.PI * 2;
      const r = R.r * (1.6 + this.rnd() * 1.4);
      const x = R.x + Math.sin(a) * r, z = R.z + Math.cos(a) * r;
      if (!this._standable(W, x, z)) continue;
      this.target.set(x, 0, z);
      this.state = ST.WANDER;
      this.timer = this._span(this.cfg.walkTime);
      this.headUp = false;
      return;
    }
    this._pickWander(W);
  }

  /** Give up the current boulder so somebody else in the group can have it. */
  _release() {
    if (this.rock && this.rock.taken === this.slot) this.rock.taken = -1;
    this.rock = null;
  }

  /**
   * The ground, as far as this animal is concerned.
   *
   * A boulder is modelled as a dome: flat on top out to half its plan radius,
   * then falling to the real hillside by the time it is a little past the
   * edge. That is not the rock's actual mesh and it does not have to be —
   * nothing here is doing collision, and the two things the player can
   * actually see are that the animal is standing on the summit and that it
   * walked up the side to get there. Both come out of this one lerp.
   *
   * Which is also why `Wildlife._findPerches` rejects a rock taller than it is
   * wide: the dome's flank IS the ramp the animal walks up, so a boulder with
   * no flank would be a wall the goat strolls through.
   *
   * Never below the hillside, so a rock sitting in a hollow cannot sink an
   * animal into the ground.
   */
  _groundY(W, x, z) {
    const g = W.getHeight(x, z);
    const R = this.rock;
    if (!R) return g;
    const d = Math.hypot(x - R.x, z - R.z);
    const y = lerp(R.top, g, smoothstep(R.r * 0.50, R.r * 1.18, d));
    return y > g ? y : g;
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

  /** Can an animal stand here? The one definition of that, used everywhere. */
  _dry(W, x, z) { return W.isInBounds(x, z) && W.getWaterDepth(x, z) <= WATER_MAX; }

  /**
   * How steep this species will walk on. 0.85 is the whole cast's answer and
   * has been since there was a cast; the alpine pair raise it because their
   * entire habitat is above it, and a goat held to the deer's limit would
   * spend its life walking downhill off its own mountain.
   */
  get _slopeMax() { return this.cfg.rock?.slopeMax ?? 0.85; }

  /** Dry, in bounds, and not too steep for this animal. */
  _standable(W, x, z) {
    return this._dry(W, x, z) && W.getSlope(x, z) <= this._slopeMax;
  }

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
    // ── a lap of a boulder, rather than a walk across the hill ─────────────
    // The alpine pair climb ONTO the rocks and they also work their way
    // AROUND them, and the second is most of what the player actually sees:
    // a rock they never top out on is still the thing they are orbiting. So
    // some fraction of their wanders are aimed at a ring just outside a
    // boulder instead of at open ground, which keeps a band of goats circling
    // one outcrop instead of dispersing evenly across a hectare of scree.
    const rk = c.rock;
    const list = rk ? this.group?.rocks : null;
    if (list && list.length && this.rnd() < rk.orbit) {
      const R = list[(this.rnd() * list.length) | 0];
      for (let i = 0; i < 4; i++) {
        const a = this.rnd() * Math.PI * 2;
        const r = R.r * (1.25 + this.rnd() * 0.85);
        const x = R.x + Math.sin(a) * r, z = R.z + Math.cos(a) * r;
        if (!this._standable(W, x, z)) continue;
        this.target.set(x, 0, z);
        this.state = ST.WANDER;
        this.timer = this._span(c.walkTime);
        return;
      }
    }
    const slopeMax = this._slopeMax;
    for (let i = 0; i < 6; i++) {
      const a = this.rnd() * Math.PI * 2;
      const r = c.wanderRadius * (0.25 + 0.75 * this.rnd());
      const x = this.home.x + Math.sin(a) * r;
      const z = this.home.z + Math.cos(a) * r;
      if (!W.isInBounds(x, z)) continue;
      if (W.getWaterDepth(x, z) > WATER_MAX) continue;
      if (W.getSlope(x, z) > slopeMax) continue;
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
    // A standing animal is not steering, so it does not probe. This is both a
    // third of the wildlife CPU and a real bug fix: a frozen deer whose probe
    // fan preferred a neighbouring direction used to rotate slowly on the spot
    // forever, splaying its legs as the feet fell behind.
    const moving = this.wantSpeed > 0.05 || this.speed > 0.05;
    this._probeT -= dt;
    if (moving && this._probeT <= 0) {
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
          // Where steepness starts costing. 0.45 is right for everything that
          // lives on the valley floor and is nonsense on a talus fan, where
          // every direction is over it and the fan would simply pick the
          // downhill one every time — see the `rock` block in `mammals/goat.js`.
          s -= Math.max(0, slope - (this.cfg.rock?.slopeSoft ?? 0.45)) * 6;
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

    const goal = this.wantHeading + (moving ? this._avoid : 0);
    const dh = wrapAngle(goal - this.heading);

    // ── the turn ────────────────────────────────────────────────────────────
    // Two motions, not one, and conflating them is what produced the pivot.
    //
    // An animal that is GOING somewhere turns by walking round, and what bounds
    // that is the arc its body can describe — a radius, never an angular rate.
    // One that is standing still turns on the spot, slowly, by shuffling its
    // feet. The old rule had a single rate that went UP as speed went down
    // (`lerp(3.0, 1.5, speed)`, so 172 deg/s at a standstill) and a `facing`
    // brake that turned every animal wanting to turn into a stationary one
    // first. Together they were a machine for pivoting: a bear asked to reverse
    // settled at 0.29 m/s and 2.9 rad/s, a turn radius of 10 cm on an animal
    // two metres long.
    //
    // The rate ceiling stays speed-dependent for the reason it always was — a
    // galloping animal turns wider still — but it no longer sets what happens
    // at the bottom of the speed range, and that is the whole fix.
    // "Going somewhere" is a property of the STATE, not of the speed. Wander,
    // flee, patrol and climb are journeys and must arc. Watch and graze move
    // too, but their slowness is the point — a wary animal drifting across your
    // line is not travelling, and speeding it up to make its turns prettier
    // would trade away the one state that exists for the player's eyes.
    const blocked = this._pinned > 0.4;
    const going = TRAVELLING.has(this.state) && this.wantSpeed > 0.05 && !blocked;
    const sn = clamp01(this.speed / (this.gait.run * S));
    const ceiling = lerp(3.0, 1.5, sn) * (this.state === ST.ALERT ? 0.55 : 1);
    const radius = Math.max(TURN_TIME * this.gait.walk, MIN_RADIUS) * S;
    // A journey gets no floor: it has to carry speed to come round, which is
    // what makes it arc. Everything else keeps the shuffle, and still respects
    // the radius whenever it happens to be moving.
    // The shuffle fades out as the animal picks up speed, so a state that is
    // moving slowly but deliberately — a graze step, a wary drift — is governed
    // by its radius rather than by the on-the-spot allowance. Without the fade
    // a drifting deer still came round on a 0.64 m radius, which is a pivot
    // with a bit of translation under it.
    const shuffle = PIVOT * (1 - clamp01(this.speed / (0.5 * this.gait.walk * S)));
    const turnRate = going
      ? Math.min(ceiling, this.speed / radius)
      : Math.min(ceiling, Math.max(this.speed / radius, shuffle));
    const step = clamp(dh, -turnRate * dt, turnRate * dt);
    this.heading += step;
    // Published for the rigs, which lean into a turn by it. Nothing else reads
    // the heading's derivative, and recovering it in the rig by differencing
    // would have to survive teleports, respawns and pooling; this does not.
    this.yawRate = step / Math.max(dt, 1e-4);

    // An animal will not accelerate into a turn it has not made yet — but a big
    // turn is a REASON to keep moving rather than to stop. Braking to a crawl
    // is what left the radius above with nothing to work with: at `facing`'s
    // old 0.7 a reversing bear dropped to 30% of its walk, and at that speed
    // the tightest legal arc is still a pirouette. Past about 35 degrees of
    // error the animal now insists on carrying a walk through the turn, so it
    // comes round the long way like an animal does. A wary drift or a graze
    // step, whose heading error is small, keeps its own deliberate pace.
    const facing = 1 - clamp01(Math.abs(dh) / 1.6) * 0.45;
    const need = clamp01((Math.abs(dh) - 0.6) / 1.2);
    const want = Math.max(this.wantSpeed * facing,
                          going ? this.gait.walk * S * 0.85 * need : 0);
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
      if (this._dry(W, nx, nz)) {
        this.pos.x = nx; this.pos.z = nz;
        this._pinned = 0;
      } else {
        // ── blocked, and the fan did not see it coming ────────────────────
        // This guard used to be a per-frame reflex: `wantHeading = heading +
        // 1.9` and `speed *= 0.35`. Both are wrong at 60 Hz, and together they
        // are the "stuck in one spot, sort of vibrating" report.
        //
        // The speed cut compounds — 0.35 sixty times a second against an accel
        // that keeps rebuilding it — so the animal settles at a few
        // centimetres per second: never moving, never *stopped* either, legs
        // cycling on the spot. And re-aiming 1.9 rad off the CURRENT heading
        // every frame sets a target that runs away from the heading as fast as
        // the heading chases it, so the animal pivots forever and never adopts
        // a direction. Traced on a river spit (tools/_scratch/bearpin.mjs) a
        // bear spent fifteen seconds inside a four-metre box doing exactly
        // that while a kayak sat offshore.
        //
        // So: stop — properly, this frame — and turn along the edge instead of
        // away from it. The smallest turn with dry ground behind it is the
        // shoreline tangent, which is the direction the animal wanted anyway;
        // an animal that meets water walks the bank, it does not bounce off it
        // at a fixed angle. One decision, then the ordinary turn-and-go.
        this.speed = 0;
        this._pinned += dt;
        const look = 1.2 * S;
        let best = null;
        for (let i = 1; i <= 4 && best === null; i++) {
          for (const s of (this.slot & 1 ? [1, -1] : [-1, 1])) {
            const h = this.heading + s * i * 0.45;
            if (this._dry(W, this.pos.x + Math.sin(h) * look, this.pos.z + Math.cos(h) * look)) {
              best = h; break;
            }
          }
        }
        this.wantHeading = best ?? (this.heading + Math.PI);
        this._avoid = 0;
        // ── cornered ──────────────────────────────────────────────────────
        // Two seconds of that means the way out is not merely awkward, it is
        // closed: a spit, an inside bend, an animal between the water and the
        // thing it is running from. Sprinting into the bank for another five
        // seconds is not a flight, and FLEE would re-arm out of ALERT forever
        // while the threat stayed parked. A cornered animal stands and faces
        // instead — which is the *more* legible pose anyway, and for a bear it
        // is also the honest one.
        if (this._pinned > 2) this._cornered = 6;
      }
    }
    if (this._cornered > 0) this._cornered -= dt;
    // Not `W.getHeight` directly: an animal engaged with a boulder is standing
    // on the boulder. Identical for everything else — see `_groundY`.
    this.pos.y = this._groundY(W, this.pos.x, this.pos.z);
  }

  /** Fill an animation drive object. Reused every frame; never allocates. */
  fill(drive, lod) {
    drive.pos = this.pos;
    drive.heading = this.heading;
    drive.speed = this.speed;
    // Signed rad/s, for the lean into a turn. The rigs cannot difference the
    // heading themselves: it is copied into a pooled record that survives a
    // respawn, so a recycled animal would read one enormous spike.
    drive.yawRate = this.yawRate;
    drive.graze = this.graze;
    drive.alert = this.alert;
    // A float, not a boolean. The scut is at half-mast in ALERT and WATCH and
    // fully up in flight, and quantising that to on/off threw away the beat.
    drive.flag = this.flag;
    drive.look = this.hasLook ? this.lookAt : null;
    drive.lod = lod;
    return drive;
  }
}
