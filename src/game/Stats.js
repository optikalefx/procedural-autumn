// ─────────────────────────────────────────────────────────────────────────────
//  Stats — the system that watches, so the logbook can be written.
//
//  Registered LAST in main.js's SYSTEMS list, and that is the whole of its
//  integration contract: every peer it reads has already run this frame, so
//  what it samples is what the player saw rather than what they saw a frame
//  ago. It writes to `stats` (src/game/stats_store.js) and to nothing else. It
//  owns no scene objects, adds no draw calls, and if it throws, main.js
//  disables it and the game carries on.
//
//  ── polling, not events ─────────────────────────────────────────────────────
//
//  Almost everything here is derived by WATCHING the other systems rather than
//  by asking them to report. A camp appearing in `camp.camps` is a camp made; a
//  boat appearing in `boat.boats` is a boat launched. That is deliberate: this
//  is the first feature of a game layer that will grow, and the alternative —
//  a `stats.add()` sprinkled through eleven other authors' files — makes every
//  one of those files a place where the logbook can be silently broken.
//
//  Object identity is what makes polling exact. A `WeakSet` of records already
//  counted turns "is this array longer than it was" (wrong the moment a boat is
//  recycled) into "have I seen this object before" (right always, and it frees
//  itself).
//
//  Two things cannot be watched, because they are instants that leave no state
//  behind. A paddle stroke is hooked from in here, by wrapping the callback on
//  a hull the first time this file sees it — contained, and the one file that
//  breaks if `Boat` changes shape is this one. A saved photo is the single
//  exception written from its own call site (`src/ui/hud_photo.js`), because
//  there is nothing on the PhotoMode object to wrap or to poll.
//
//  ── what counts as seeing something ─────────────────────────────────────────
//
//  An animal sighting is: in frame, within SIGHT metres of where the player
//  actually is, and not already credited for this animal's streamed-in
//  lifetime.
//
//  The distance gate is the whole of it, and it is short on purpose (user,
//  2026-08-24: "only if that deer is actually within like 20 m of where I
//  am"). The first version ran to 150 m for a deer and 175 m for a bear, which
//  is the range at which the animal is legible — and that turned out to be the
//  wrong question. At 150 m a deer is a detail in the landscape you drove past;
//  at 20 m it is an encounter, which is the thing the logbook is a record of.
//  A generous rule quietly turns the wildlife section into a measure of how far
//  you drove.
//
//  "Where the player is" is the camper — or the boat, when they are in one —
//  not the camera, which in the chase view sits several metres back and would
//  make the reach in FRONT of the player noticeably shorter than the number
//  says. The frustum test still uses the camera, because that is what "in
//  frame" means.
//
//  There is still no occlusion test, so an animal 15 m away behind a boulder
//  counts. At this range that is a rare and forgivable failure; a raycast per
//  animal per tick is not worth paying for it.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { SEED } from '../world/WorldConfig.js';
import { SKY_STATE } from '../render/Lighting.js';
import { stats } from './stats_store.js';
import { skyTargetAt } from './sky_objects.js';

// The expensive half — frustum tests over every animal, flock and waterfall —
// runs at this rate rather than per frame. At 6 Hz a deer must be in view for
// a sixth of a second to be seen, which is under the time it takes to notice
// one, and the whole pass costs a few hundred distance compares.
const SLOW_HZ = 6;

// How close an animal has to come. One number for every species, because the
// gate is about the encounter and not about how big the animal is — see the
// header.
const SIGHT = 20;

// Birds are the exception, and have to be: the flocks wheel between 24 m and
// 104 m up, so a 20 m rule would mean no player ever saw a bird. Seeing one at
// a distance is what a flock of birds IS.
const FLOCK_SIGHT = 260;
const FALL_SIGHT = 420;

// An individual perched bird sits between the two rules above: you cannot get
// 20 m from something twenty-five metres up a spruce, but a lone eagle is not
// a flock to be credited at the horizon either. 130 m is roughly where a two-
// metre bird stops being "a bird" and starts being "an eagle" — inside the
// spawn ring, so driving toward a perched one, or having one cross the road
// ahead, is what earns the line in the book.
const TREE_BIRD_SIGHT = 130;

// A flock is not an individual — there are two of them and they follow the
// camera around the valley — so a flock sighting is re-credited only after this
// long out of view. Long enough that one drive is one sighting.
const FLOCK_COOLDOWN = 150;

// Airborne spells shorter than this are suspension travel over a cattle grid,
// not a jump. Landing from one is not an achievement and counting them turns
// "jumps" into a bumpiness meter.
const AIR_MIN = 0.35;
// A rescue and a map warp both drop the camper from a height, and the fall is
// genuinely airborne. Ignore everything for this long after a teleport, or the
// most-airtime record belongs to whoever clicked the map the most.
const AIR_TELEPORT_LOCKOUT = 2.5;

// Hold the eyepiece on something for this long before it is found. Long enough
// that a sweep across the sky does not collect the whole catalogue, short
// enough that it never feels like waiting.
const SKY_DWELL = 0.5;

// Parked within this of a camp's centre is "at camp". Matches the reach Camp
// itself uses to decide a camp is yours (`_homeCamp`), rounded.
const AT_CAMP = 30;

// Under this speed the camper is not driving, it is idling or being parked.
const DRIVING = 0.4;

const _v = new THREE.Vector3();
const _pm = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _dir = new THREE.Vector3();

export class Stats extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Stats';

    this._slow = 0;
    this._session = 0;

    // Records already counted. WeakSets, so a sunk boat takes its entry with
    // it when it is collected.
    this._campDogs = new WeakSet();
    this._boats = new WeakSet();
    // Camps are the exception and are held in a plain array, because packing
    // one up has to be detected by its ABSENCE — see _campsite. At most
    // MAX_CAMPS of them, and an entry outlives the camp by one frame.
    this._liveCamps = [];

    this._airs = {};             // current airborne spell per vehicle, seconds
    this._sinceTeleport = 99;
    this._teleportSeq = -1;
    this._aboard = null;
    this._boatPos = null;
    this._rescues = 0;
    this._scoped = false;
    // The roast view's own counters, as last seen. Plain numbers rather than a
    // WeakSet because what is being watched here is a tally, not a set of
    // objects — see `_roasting`.
    this._roasted = { made: 0, dropped: 0, burnt: 0 };
    this._skyId = null;
    this._skyHeld = 0;
    this._bursts = null;
    this._origin = null;         // where this session started, for the range record

    // The seed the running valley was baked from — the ?seed= the boot path
    // keyed everything else off, else the default. NOT `world.seed`: WorldData
    // takes a seed and never stores it, so that reads undefined and every
    // valley would share one keyspace. Same derivation as HUD.seed().
    const q = parseInt(new URLSearchParams(location.search).get('seed') ?? '', 10);
    this.seed = Number.isFinite(q) ? q : SEED;
  }

  async init() {
    stats.mark('seeds', this.seed);
    window.__stats = stats;
  }

  update(dt) {
    // A hidden tab still ticks in some browsers, and an hour of alt-tabbed
    // "time in the valley" is a lie the logbook does not need to tell.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      stats.tick(dt);
      return;
    }

    stats.add('time.total', dt);
    this._session += dt;
    stats.hi('session.long', this._session);

    this._drive(dt);
    this._bike(dt);
    this._water(dt);
    this._campsite(dt);
    this._telescope(dt);
    this._roasting(dt);
    this._photo(dt);

    this._slow -= dt;
    if (this._slow <= 0) {
      const step = 1 / SLOW_HZ;
      this._slow = step;
      this._look(step);
    }

    stats.tick(dt);
  }

  // ── driving ────────────────────────────────────────────────────────────────

  _drive(dt) {
    const veh = this.ctx.systems?.vehicle;
    // `phys.ready` is the gate, not `enabled`: the body exists a frame or two
    // before Rapier has placed it, and until then `position` is the origin —
    // which would make the first frame of every session a 900 m drive from
    // the middle of the map to the trailhead.
    if (!veh?.enabled || !veh.phys?.ready) return;

    // Teleports: a rescue or a map warp is not a drive and the fall from one is
    // not a jump. `teleportSeq` is the vehicle's own counter, bumped on every
    // one of them.
    if (veh.teleportSeq !== this._teleportSeq) {
      this._teleportSeq = veh.teleportSeq;
      this._sinceTeleport = 0;
      this._airs.camper = 0;
    } else {
      this._sinceTeleport += dt;
    }

    const id = veh.car?.id ?? 'camper';
    const sp = Math.abs(veh.speed ?? 0);
    const night = SKY_STATE.nightFactor > 0.5;

    if (sp > DRIVING) {
      const d = sp * dt;
      stats.add('drive.time', dt);
      stats.add(`drive.time.${id}`, dt);
      stats.add('drive.dist', d);
      stats.add(`drive.dist.${id}`, d);
      if (night) stats.add('drive.night', dt);
      stats.hi('speed.top', sp);
    }

    // Height and reach are about where the camper GOT to, so they are read
    // whether or not it is moving right now — a camper parked on a summit is
    // still parked on a summit.
    stats.hi('alt.high', veh.position.y);

    // How far from where this session began. Not a lifetime record of the same
    // shape as the others — a new seed is a new valley and a new origin — but
    // it is the number that answers "how far out did I get".
    this._origin ??= veh.position.clone();
    stats.hi('range.far', this._origin.distanceTo(veh.position));

    // `veh.rescues` counts this session; the logbook counts every session, so
    // what carries across is the delta, not the value.
    const r = veh.rescues ?? 0;
    if (r > this._rescues) { stats.add('drive.rescues', r - this._rescues); this._rescues = r; }

    // ── airtime ──────────────────────────────────────────────────────────────
    this._airtime('camper', !!veh.phys?.airborne && this._sinceTeleport > AIR_TELEPORT_LOCKOUT, dt);
  }

  /**
   * One airborne spell, for whichever thing the player is on.
   *
   * Shared between the camper and the bike because `air.jumps` and `air.long`
   * are one line in the logbook and mean the same thing either way — a jump is
   * a jump. The per-vehicle keys sit alongside them for the same reason
   * `drive.time.${id}` does: the total is the headline and the breakdown is
   * there when the leaderboard wants it.
   *
   * The spells are kept apart per vehicle, so dismounting mid-flight cannot
   * hand the bike's hang time to the camper.
   */
  _airtime(id, aloft, dt) {
    const held = (this._airs ??= {});
    const cur = held[id] ?? 0;
    if (aloft) {
      held[id] = cur + dt;
      stats.add('air.time', dt);
      stats.add(`air.time.${id}`, dt);
    } else if (cur > 0) {
      if (cur >= AIR_MIN) {
        stats.add('air.jumps');
        stats.add(`air.jumps.${id}`);
        stats.hi('air.long', cur);
        stats.hi(`air.long.${id}`, cur);
      } else {
        // Suspension travel, counted as airtime while it happened. Give it
        // back, or a washboard road reads as flying.
        stats.add('air.time', -cur);
        stats.add(`air.time.${id}`, -cur);
      }
      held[id] = 0;
    }
  }

  /**
   * The bike, which has no Rapier body and no teleport — it is ridden away from
   * the camper rather than warped, so there is nothing here matching the
   * lockout `_drive` needs.
   *
   * `Bike.current` is nulled the moment the player steps off, and `airborne` on
   * it is already gated on riding: a bike parked on a lip is not in flight, and
   * the physics refuses to launch an unridden one at all.
   */
  _bike(dt) {
    const cur = this.ctx.systems?.bike?.current;
    this._airtime('bike', !!cur?.airborne, dt);
    if (!cur?.riding) return;
    const sp = Math.abs(cur.speed ?? 0);
    if (sp > DRIVING) {
      stats.add('ride.time', dt);
      stats.add('ride.dist', sp * dt);
      stats.hi('ride.top', sp);
    }
  }

  // ── the water ──────────────────────────────────────────────────────────────

  _water(dt) {
    const boat = this.ctx.systems?.boat;
    if (!boat?.enabled) return;

    // New hulls in the water. `boats` holds every boat, moored or ridden, and
    // an entry appears exactly once — when it is launched.
    for (const b of boat.boats) {
      if (this._boats.has(b)) continue;
      this._boats.add(b);
      stats.add('boat.launch');
      stats.add(`boat.launch.${b.kind}`);
      // A stroke leaves nothing behind to poll, so it is the one thing here
      // that is hooked rather than watched. `Boat.spawn` assigns `onStroke`
      // once and never reassigns it, so wrapping it here is safe; the original
      // is called first so the wake and the cue are unaffected by us.
      const inner = b.phys.onStroke;
      b.phys.onStroke = (side, strength) => {
        inner?.(side, strength);
        stats.add('water.strokes');
      };
    }

    // `_aboard` is Boat's own record of the hull being ridden. `boat.state()`
    // is the public form and allocates an object per call, which is not a
    // per-frame thing to do.
    const ab = boat._aboard ?? null;
    if (ab !== this._aboard) {
      if (ab) {
        stats.add('boat.boarded');
        this._boatPos = { x: ab.phys.x, z: ab.phys.z };
      } else {
        this._boatPos = null;
      }
      this._aboard = ab;
    }
    if (!ab) return;

    stats.add('water.time', dt);
    stats.add(`water.time.${ab.kind}`, dt);
    if (this._boatPos) {
      const d = Math.hypot(ab.phys.x - this._boatPos.x, ab.phys.z - this._boatPos.z);
      // A hull that jumps further than a paddle stroke in one frame was
      // replaced or re-placed, not paddled.
      if (d < 2) stats.add('water.dist', d);
    }
    this._boatPos = { x: ab.phys.x, z: ab.phys.z };
  }

  // ── camps ──────────────────────────────────────────────────────────────────

  /**
   * Camps, by set difference against the frame before.
   *
   * A camp made is a record that has appeared in `camp.camps`; a camp packed up
   * is one that has gone. The obvious alternative — watch the `striking` flag —
   * is wrong, and quietly: `Camp._strike(camp, true)` splices the record out
   * without ever raising it, which is the path `Camp.strike()` and the camp cap
   * both take. Measured: pitching a camp and calling `strike()` logged one camp
   * made and zero packed up. Absence is the only signal that catches every
   * removal, so absence is what this watches.
   */
  _campsite(dt) {
    const camp = this.ctx.systems?.camp;
    if (!camp?.enabled) return;

    const veh = this.ctx.systems?.vehicle;
    const live = camp.camps;
    let atCamp = false;

    for (const c of live) {
      if (!this._liveCamps.includes(c)) {
        stats.add('camp.made');
        if (SKY_STATE.nightFactor > 0.5) stats.add('camp.night');
      }
      // The dog is decided at pitch time and can still be withdrawn if the
      // props leave it nowhere to walk (see Camp._makeDog), so it is credited
      // when the animal actually exists.
      if (c.dog && !this._campDogs.has(c)) { this._campDogs.add(c); stats.add('camp.dogs'); }
      if (!c.striking && veh?.position &&
          Math.hypot(veh.position.x - c.x, veh.position.z - c.z) < AT_CAMP) atCamp = true;
    }
    for (const c of this._liveCamps) if (!live.includes(c)) stats.add('camp.struck');

    // Rebuilt rather than mutated: `camps` holds at most MAX_CAMPS entries, so
    // this is a two-element copy, and a copy cannot drift out of step with the
    // array it is a copy of.
    this._liveCamps.length = 0;
    for (const c of live) this._liveCamps.push(c);

    if (atCamp) stats.add('camp.time', dt);
  }

  // ── the telescope ──────────────────────────────────────────────────────────

  _telescope(dt) {
    const scope = this.ctx.systems?.camp?.scope;
    const on = !!scope?.active;
    if (on && !this._scoped) stats.add('scope.uses');
    this._scoped = on;
    if (!on) { this._skyId = null; this._skyHeld = 0; return; }

    stats.add('scope.time', dt);

    // Only once the lean-in is over: the camera is still travelling before
    // that, and the sky it sweeps on the way is not sky the player aimed at.
    if (scope.t < 0.9) return;

    this.ctx.camera.getWorldDirection(_dir);
    const hit = skyTargetAt(_dir, this.ctx.camera.fov, SKY_STATE);
    const id = hit?.id ?? null;
    if (id !== this._skyId) { this._skyId = id; this._skyHeld = 0; return; }
    if (!id) return;

    this._skyHeld += dt;
    if (this._skyHeld < SKY_DWELL) return;
    // Recorded, not announced. The logbook is somewhere the player goes to
    // look; a game with no fail state and no objectives should not be
    // interrupting the view to tell them it has written something down (user,
    // 2026-08-24). Finding Jupiter is worth a line in the sheet, and the sheet
    // is where it goes.
    this._skyHeld = -1e9;                       // credited; do not fire again
    stats.mark('sky', id);
    void hit;
  }

  // ── marshmallows ───────────────────────────────────────────────────────────

  /**
   * The roasting stick, watched rather than asked.
   *
   * `Camp.roast` is the view; it keeps a running tally of what has happened to
   * the marshmallows that have been on it (`roasted`, `dropped`, `burnt`) and
   * the grade of the last one (`result`). None of those is an event and none of
   * them is a set of objects, so neither of this file's two existing tricks is
   * the right one — this is the third shape it already has, and `Stats._drive`
   * spells it out for `veh.rescues`: **what carries across is the delta, not
   * the value.** A view that is rebuilt starts its tally again, so a counter
   * that has gone backwards resets the watermark rather than crediting a
   * negative or, worse, waiting until the tally climbs back past it and then
   * crediting the same marshmallows twice.
   *
   * `result` is the one thing here that is a property of a single marshmallow
   * rather than of the session, so it is read ONLY on the frame its counter
   * moves. Reading it every frame and watching for changes would credit a
   * second 'perfect' the moment a player made two perfect ones in a row — the
   * value would not change, so the change test would never fire — and would
   * credit nothing at all on the second of two identical grades. Gating on the
   * counter has neither failure, and needs no identity trick to get there.
   */
  _roasting(dt) {
    const roast = this.ctx.systems?.camp?.roast;
    if (!roast) return;

    // Time with a marshmallow actually in hand. The view is the whole of the
    // mechanic — there is nothing to roast outside it — so its own `active` is
    // the honest bound, exactly as `scope.active` is for the eyepiece.
    if (roast.active) stats.add('roast.time', dt);

    const seen = this._roasted;
    const made = roast.roasted ?? 0;
    const dropped = roast.dropped ?? 0;
    const burnt = roast.burnt ?? 0;

    if (made > seen.made) {
      stats.add('roast.made', made - seen.made);
      // `RESULTS[0].key`. A string or the graded object; both are read, because
      // the contract names the field and not its shape.
      if ((roast.result?.key ?? roast.result) === 'perfect') stats.add('roast.perfect');
    }
    if (dropped > seen.dropped) stats.add('roast.dropped', dropped - seen.dropped);
    if (burnt > seen.burnt) stats.add('roast.burnt', burnt - seen.burnt);

    seen.made = made; seen.dropped = dropped; seen.burnt = burnt;
  }

  _photo(dt) {
    if (this.ctx.systems?.hud?.photo?.active) stats.add('photo.time', dt);
  }

  // ── what is in view ────────────────────────────────────────────────────────

  _look(step) {
    const cam = this.ctx.camera;
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    const eye = cam.position;

    this._wildlife(eye);
    this._treeBirds(eye);
    this._flocks(eye, step);
    this._waterfalls(eye);
    this._landmarks();
  }

  _wildlife(eye) {
    const wl = this.ctx.systems?.wildlife;
    if (!wl?.enabled || !wl.pool) return;
    const veh = this.ctx.systems?.vehicle;

    // Where the player is, which is not where the camera is. In a boat it is
    // the hull; otherwise the camper; and with neither — the fly camera, a
    // capture — the camera is the honest fallback.
    const ab = this.ctx.systems?.boat?._aboard;
    const me = ab ? { x: ab.phys.x, z: ab.phys.z } : (veh?.position ?? eye);
    const r2 = SIGHT * SIGHT;

    for (const key of Object.keys(wl.pool)) {
      for (const per of wl.pool[key]) {
        for (const a of per) {
          // Streamed out: the next animal in this slot is a different animal,
          // and is worth its own sighting.
          if (!a.active) { a._statSeen = false; continue; }
          const p = a.brain?.pos;
          if (!p) continue;

          // The closest a bear has ever come, whether or not it was ever in
          // view — being crept up on is the version of that number worth
          // keeping.
          if (key === 'bear' && veh?.position) {
            stats.lo('bear.near', Math.hypot(veh.position.x - p.x, veh.position.z - p.z));
          }

          if (a._statSeen) continue;
          // Flat distance, not 3D: an animal on the bank below a clifftop track
          // is not "far away" in the sense the player means.
          const dx = p.x - me.x, dz = p.z - me.z;
          if (dx * dx + dz * dz > r2) continue;
          // A metre up: `pos` is at the animal's feet, and an animal standing
          // just under the bottom edge of the frame is not in view.
          _v.set(p.x, p.y + 0.8, p.z);
          if (!_frustum.containsPoint(_v)) continue;

          a._statSeen = true;
          stats.add(`seen.${key}`);
          stats.add('seen.animals');
        }
      }
    }
  }

  /**
   * The perch-and-fly birds (birds/tree_birds.js) — the bald eagles, and whatever
   * species join them. Same shape as _wildlife: one credit per streamed-in
   * bird, reset when its slot recycles, keyed per species so the sheet can
   * say "eagle" and not "bird". Perched or mid-flight both count; the frustum
   * test is what says the player was actually looking.
   */
  _treeBirds(eye) {
    const tb = this.ctx.systems?.wildlife?.treeBirds;
    if (!tb?.slots) return;
    const veh = this.ctx.systems?.vehicle;
    const ab = this.ctx.systems?.boat?._aboard;
    const me = ab ? { x: ab.phys.x, z: ab.phys.z } : (veh?.position ?? eye);
    const r2 = TREE_BIRD_SIGHT * TREE_BIRD_SIGHT;

    for (const slots of tb.slots) {
      for (const b of slots) {
        if (!b.active) { b._statSeen = false; continue; }
        if (b._statSeen) continue;
        const dx = b.x - me.x, dz = b.z - me.z;
        if (dx * dx + dz * dz > r2) continue;
        _v.set(b.x, b.y, b.z);
        if (!_frustum.containsPoint(_v)) continue;
        b._statSeen = true;
        stats.add(`seen.${b.spec.key}`);
      }
    }
  }

  _flocks(eye, step) {
    const birds = this.ctx.systems?.wildlife?.birds;
    if (!birds) return;

    for (const F of birds.flocks ?? []) {
      if (F._statCool > 0) F._statCool -= step;
      if (!F.placed || F._statCool > 0) continue;
      _v.set(F.cx, F.cy, F.cz);
      if (eye.distanceToSquared(_v) > FLOCK_SIGHT * FLOCK_SIGHT) continue;
      if (!_frustum.containsPoint(_v)) continue;
      F._statCool = FLOCK_COOLDOWN;
      stats.add('seen.flocks');
    }

    // Startle bursts. `life` counts down from the moment something puts a
    // hedge full of songbirds into the air, so a rising edge is one startle.
    this._bursts ??= new WeakMap();
    for (const B of birds.bursts ?? []) {
      const was = this._bursts.get(B) ?? 0;
      if (B.life > 0 && was <= 0) stats.add('birds.startled');
      this._bursts.set(B, B.life);
    }
  }

  _waterfalls(eye) {
    const list = this.ctx.world?.waterfalls;
    if (!list?.length) return;
    for (let i = 0; i < list.length; i++) {
      const id = `${this.seed}:${i}`;
      if (stats.has('falls', id)) continue;
      const wf = list[i];
      // The middle of the drop, which is the part you can see from below and
      // from the rim both.
      _v.set((wf.top[0] + wf.bottom[0]) * 0.5,
             (wf.top[1] + wf.bottom[1]) * 0.5,
             (wf.top[2] + wf.bottom[2]) * 0.5);
      if (eye.distanceToSquared(_v) > FALL_SIGHT * FALL_SIGHT) continue;
      if (!_frustum.containsPoint(_v)) continue;
      stats.mark('falls', id);
    }
  }

  /**
   * Landmarks the compass has marked as found.
   *
   * The HUD already does this work — it is what the "found / total" figure on
   * the dash counts — but its tally resets with the page. A set keyed by PLACE
   * rather than a counter, and keyed by place rather than by index, so that
   * re-driving the same valley on another day cannot credit the same vista
   * twice. Waterfalls and seeds are sets for the same reason.
   */
  _landmarks() {
    const hud = this.ctx.systems?.hud;
    for (const m of hud?._all ?? []) {
      if (!m.found || m._statSeen) continue;
      m._statSeen = true;
      stats.mark('poi', `${this.seed}:${m.kind}:${Math.round(m.x)}:${Math.round(m.z)}`);
    }
  }

  dispose() {
    stats.flush();
    if (window.__stats === stats) delete window.__stats;
  }
}
