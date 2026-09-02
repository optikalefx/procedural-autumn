// ─────────────────────────────────────────────────────────────────────────────
//  bigfoot — the nineteenth line of the scavenger sheet, and the only one that
//  is not on it until you have earned it.
//
//  The player's spec: "After the user finds all the stuff in the journal, a new
//  mystery entry will appear. That will allow bigfoot to spawn somewhere in the
//  forest. If you get a picture of him, you win."
//
//  ── what this file owns ─────────────────────────────────────────────────────
//
//  When one exists, where, and what it does. The BODY is one folder over in
//  `bigfoot_model.js`; this is the layer `Wildlife.js` is for every other
//  animal — habitat, streaming, behaviour — collapsed into one object, because
//  there is at most one of him and the machinery that keeps six hundred home
//  sites in a capped table has nothing to offer a cast of one.
//
//  He is `camp_dog.js`'s cousin in that respect and it is worth saying which
//  parts of that precedent apply. Like the dog he is not in `SPECIES`, has no
//  `Brain`, and owns his own loop. Unlike the dog he is a WILD animal in open
//  country, so the two things the dog gets for free — a fire to orbit and a
//  camp that cannot move — are exactly the two things this has to solve.
//
//  ── the encounter, and why he stands still first ────────────────────────────
//
//  The brief is a glimpse: he shows up, and he leaves. Built literally, that is
//  a creature who spawns already walking away, which fails on its own terms —
//  a glimpse you never get is not a glimpse. So the sequence has a beat in
//  front of it:
//
//    WAIT   he is out there in the timber, standing, not yet noticed. Placed
//           OUT of frame, because `Wildlife`'s rule that nothing may appear
//           inside the player's view is the whole reason a valley full of deer
//           feels like a valley rather than a spawner.
//    SEEN   the camera has held him for `NOTICE` seconds. He does nothing for
//           a beat, which is the beat the player uses to reach for the lens.
//    LEAVE  he turns and walks away, and looks back once on the way.
//
//  What that buys is the shape of every story anybody tells about seeing one:
//  it was standing there, and then it wasn't. Standing still is also what makes
//  the photograph POSSIBLE — see the range table below — so the difficulty of
//  the line is reaching for the right lens in time rather than a coin flip.
//
//  ── the range table, which decides most of the numbers here ─────────────────
//
//  `hunt_detect.MIN_SHARE` wants a subject 13.96% of the frame's height. The
//  common variant is 2.88 m of mesh, so the furthest a photograph of him can
//  count from is a function of the glass, and it is a wide function:
//
//      24mm    24 m         200mm   204 m
//      50mm    51 m         300mm   306 m
//      70mm    71 m         400mm   407 m
//
//  **These grew by 1-7% when `share` went planar** (24 / 48 / 67 / 191 / 286 /
//  382 before), and the spread of that correction is the whole reason the
//  rewrite happened: the old angular share ran `tan(vfov/2)/(vfov/2)` over the
//  planar one, which is 6.9% at 24 mm and 0.03% at 400 mm, so the long glass
//  was quietly being asked to put more Bigfoot in the frame than the short.
//  Now the reach is exactly `1.019 * f` millimetres-to-metres, because a planar
//  share IS proportional to focal length — which is the kind of table that
//  tells you the rule underneath is the right shape.
//
//  So: he arrives between `SPAWN_MIN` and `SPAWN_MAX` (58-92 m), which is
//  inside the 200-400's reach from the first frame and outside the 24-70's
//  until you both zoom to 70 and close to 71 m. **Bigfoot is a long-lens shot
//  by construction**, exactly like the great horned owl, and the journal's hint
//  says so for the same reason `hunt_items.js` rule 4 gives: a hint that sends
//  somebody to take a photograph the rules will refuse is worse than no hint.
//
//  He is gone by `FAR_GONE` (165 m), which is inside the 200mm end of the long
//  lens: a player who kept the tele on him has the shot for the whole of the
//  encounter, right up to the frame he leaves on. Nothing is ever taken away
//  from somebody who was still holding the camera.
//
//  ── he does not read the journal ────────────────────────────────────────────
//
//  Nothing under `src/wildlife/` imports `src/game/`, and this does not break
//  that: whether the mystery is open is a fact about the PLAYER'S PROGRESS, and
//  the layer that owns progress is the HUD (see `HUD.update`, which already
//  reads `hunt.target` and `hunt.animalCount()` and hands them down). So this
//  exposes `armed` and somebody above sets it. A world system that reached up
//  into the save file to decide whether to exist would be the first one.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp01, lerp, damp, wrapAngle, mulberry32 } from '../core/MathUtils.js';
import { bigfootProtos, pickBigfootVariant, BIGFOOT, BigfootRig }
  from './bigfoot_model.js';
import { createHideMaterial } from './mammals/hide.js';

// ── where he lives ───────────────────────────────────────────────────────────
//
// Deep timber, and nothing else. The moisture field IS the tree field in this
// world (see `Wildlife._suit`, where the squirrel's "wood" term is the same
// band), so `WOOD` is a threshold on it — and it is set ABOVE the squirrel's
// 0.48-0.76 band on purpose. The squirrel lives where the trees are; this lives
// where the trees are and nobody else goes.
const WOOD = 0.70;
// He will not stand on a slope a person could not walk up, and never in water.
const SLOPE_MAX = 0.62;
const ALT_MAX = 260;

// ── the distances ────────────────────────────────────────────────────────────
// See the range table in the header. Every one of these is a metre count in the
// same space `hunt_detect` measures the photograph in.
const SPAWN_MIN = 58, SPAWN_MAX = 92;
// Closer than this and he has "gone into the trees" — but only out of frame,
// see the despawn block in `update`. 18 m is deliberately under the 24-70's
// 24 m reach at the WIDE end, so a player who abandons the tele entirely and
// simply runs at him still has a shot. It is a bad plan and it can be made to
// work, which is the best kind of bad plan.
const NEAR_GONE = 18;
const FAR_GONE = 165;
// How far the compass paw will point at him, once the journal's mystery line is
// ringed. It is `FAR_GONE` plus a margin rather than a taste number: he only
// leaves at 165 m AND out of frame, so a player tracking him from behind can
// legitimately be holding him a little past it, and a pin that blinked out
// while he was still on screen would read as the compass being wrong.
//
// Wider than any mammal's — the bear's is 185 m and the birds' 190 — which is
// the point the user made when this was wired: he is met at a distance nothing
// else in the valley is, so the reach that finds him has to be.
const QUARRY_R = FAR_GONE + 30;
// Seconds the camera must hold him before he counts as noticed. Long enough
// that swinging the view past a tree line does not trip it, short enough that
// looking AT him feels like it did something.
const NOTICE = 0.55;
// …and how much of the frame he has to occupy while it does, so that swinging
// the view across a distant ridge does not count as looking at him.
//
// It has to reach further than the ring he spawns in, and the first cut did
// not: at 0.035 and the game's 50-degree default he was noticed inside 72 m and
// he arrives out to 92, so better than a third of all encounters were a
// creature standing in the trees being stared at and never reacting, until
// `WAIT_LIFE` took him away 75 seconds later. `tools/_scratch/bfsim.mjs` found
// it on the first run and it would have been very hard to see in the game.
//
//     share = 2 * atan(1.44 / d) / vfov
//
// 0.018 at a 50-degree vertical fov reaches 183 m, which covers `SPAWN_MAX`
// twice over; at 400 m the same sweep measures 0.0082 and does not count. On
// the long lens it is satisfied everywhere he can exist, which is right — a
// player with a 400 on is looking, not glancing.
const NOTICE_SHARE = 0.018;
// The beat between being noticed and turning away. The whole feature lives in
// this number: too short and nobody ever gets the lens up, too long and he is
// a statue. Two and a bit seconds is about one grab for the camera key.
const STARTLE = [1.8, 2.9];
// How long he will stand there unnoticed before giving up and dissolving back
// into the timber, and the hard cap on one whole encounter.
const WAIT_LIFE = 75;
const MAX_LIFE = 170;
// After he goes, how long before another can be out there. Generous: a missed
// glimpse must not cost the player ten minutes.
const COOLDOWN = 42;
// How often the spawner even tries, and how many places it looks each time.
const TRY_EVERY = 2.6;
const CANDIDATES = 14;

// ── the look back ────────────────────────────────────────────────────────────
// Once per departure he stops and turns his head. It is the single most
// recognisable image the subject has, and it is also the player's second chance
// at the shot: he is stationary again for `LOOK_HOLD`, and by then he is far
// enough out that only the long lens will reach — which is the lesson the line
// is teaching. `LOOK_AFTER` seconds of walking is about 6-9 m of ground.
const LOOK_AFTER = [7.0, 10.0];
const LOOK_HOLD = 2.3;

// ── how fast he leaves ───────────────────────────────────────────────────────
// A playback RATE, not a second gait, and that is the whole point: `CLAUDE.md`'s
// rule is that speed comes from the clip and the clip is never touched, so
// `BigfootRig.speed` is `WALK * rate` and every pose on screen at 1.45x is a
// pose that exists at 1x. 0.93 m/s becomes 1.35 — a brisk walk, and not a run.
// A bigfoot that runs is a monster; one that walks away unhurried is the thing
// people claim to have seen.
//
// It also fixes the tail. At a flat 1x the sim measured 86 s from spawn to
// `FAR_GONE`, most of it him receding in a straight line, which is a long time
// for a glimpse to take.
const LEAVE_RATE = 1.45;

const ST = { WAIT: 0, SEEN: 1, LEAVE: 2, LOOK: 3 };

const _v = new THREE.Vector3();
const _pm = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _sphere = new THREE.Sphere();

/**
 * The one bigfoot, and the machinery that decides whether there is one.
 *
 * Built by `Wildlife` alongside `Birds`, `TreeBirds` and `Fireflies` — a fourth
 * sub-system of the same kind, and constructed the same way. Nothing is loaded
 * or allocated until `armed` first goes true, so a player who has not finished
 * the sheet pays for this feature with one null check a frame.
 */
export class Bigfoot {
  constructor(ctx, seed = 0) {
    this.ctx = ctx;
    /**
     * The id he answers to on the scavenger sheet.
     *
     * `hunt_items.js` rule 1: an item's id IS the owning system's own key, so a
     * lookup is an identity and there is no translation table to drift. This is
     * that key, kept here rather than written as a literal in `Wildlife` — the
     * one place outside this file that has to name him.
     */
    this.key = 'bigfoot';
    this.rng = mulberry32((seed ^ 0xb1f7) >>> 0);
    /** Set from above once the journal's mystery entry is open. See the header. */
    this.armed = false;
    this.group = new THREE.Group();
    this.group.name = 'bigfoot';
    this.rig = null;
    this.material = null;
    this.state = ST.WAIT;
    this.pos = new THREE.Vector3();
    this.heading = 0;
    /** True while one is out there. `hunt_detect` and the HUD read this. */
    this.present = false;
    this._t = 0;            // seconds in the current state
    this._life = 0;         // seconds this encounter has existed
    this._cool = 0;         // seconds until another may spawn
    this._tryT = 0;
    this._held = 0;         // seconds the camera has held him
    this._look = 0;         // 0..1, the head coming round
    this._looked = false;
    this._startle = 0;
    this._lookAt = 0;
    this._want = 0;         // heading he is steering toward
    this._moving = 0;
    /** Encounters begun and photographs earned, for a harness. */
    this.stats = { spawns: 0, seen: 0, sightSeconds: 0 };
  }

  // ── construction, deferred ─────────────────────────────────────────────────

  /**
   * Build the mesh, the first time one is needed.
   *
   * ~14 ms of geometry and a material compile, on the frame the first bigfoot
   * spawns — which is a frame nobody is looking at him on yet, because he
   * spawns out of shot by construction. Doing it at `init` instead would put
   * that cost on every player of a game most of whom will never open this line.
   */
  _build() {
    if (this.rig) return;
    const vi = pickBigfootVariant(this.rng());
    const v = BIGFOOT.variants[vi];
    this.material = createHideMaterial(v.col);
    this.rig = new BigfootRig(bigfootProtos()[vi], this.material, v.scale);
    this.variant = v;
    this.group.add(this.rig.mesh);
    this.ctx.scene.add(this.group);
  }

  // ── the frame ──────────────────────────────────────────────────────────────

  /**
   * @param {number} dt
   * @param {THREE.Camera} cam
   *
   * ── the camera, and not `Wildlife`'s `threat` ──────────────────────────────
   *
   * Every other animal in the tree measures the player as the VEHICLE, because
   * what a deer is reacting to is a truck coming down a road. Every distance
   * this file cares about is a distance to a LENS: whether the photograph will
   * count (`hunt_detect` measures from the camera), whether he is close enough
   * to have been noticed, whether he has got away. So `Wildlife` still hands a
   * threat down for symmetry with its peers and this deliberately ignores it.
   *
   * The two are ten metres apart on a chase camera and identical on foot, so
   * this is not a behaviour difference anybody will see. It IS the difference
   * between a harness that can pose a camera and test this, and one that
   * cannot: a forced camera in the timber with the camper parked a kilometre
   * away made every spawn despawn on its first frame, at 1200 m from a
   * `threat` the feature has no opinion about.
   */
  update(dt, cam) {
    if (!this.armed) { if (this.present) this._despawn(); return; }
    const W = this.ctx.world;
    if (!W || !cam) return;

    if (!this.present) {
      this._cool -= dt;
      this._tryT -= dt;
      if (this._cool <= 0 && this._tryT <= 0) {
        this._tryT = TRY_EVERY;
        this._trySpawn(cam);
      }
      return;
    }

    this._life += dt;
    this._t += dt;
    const px = cam.position.x, pz = cam.position.z;
    const dist = Math.hypot(this.pos.x - px, this.pos.z - pz);
    const framed = this._framed(cam);
    if (framed) this.stats.sightSeconds += dt;

    switch (this.state) {
      case ST.WAIT: this._wait(dt, framed); break;
      case ST.SEEN: this._seen(dt); break;
      case ST.LEAVE: this._leave(dt, W, px, pz); break;
      case ST.LOOK: this._lookBack(dt); break;
    }

    // ── leaving for good ─────────────────────────────────────────────────────
    // Out of frame for all of them except the timeout. A creature that winks
    // out while somebody is watching him is a bug the player can SEE, and it is
    // the one thing that would take the whole encounter from eerie to cheap.
    const spent = dist < NEAR_GONE || dist > FAR_GONE
      || (this.state === ST.WAIT && this._life > WAIT_LIFE);
    if ((spent && !framed) || this._life > MAX_LIFE) { this._despawn(); return; }

    this.rig.place(this.pos, this.heading, W, dt);
    this.rig.update(dt, this._moving, this._look);
    // Shadows only while he is close enough for one to be worth a second draw
    // call — the same trade every animal in `Wildlife._step` makes.
    this.rig.setShadow(dist < 70);
  }

  // ── the states ─────────────────────────────────────────────────────────────

  /** Standing in the trees, waiting to be noticed. */
  _wait(dt, framed) {
    this._moving = damp(this._moving, 0, 6, dt);
    this._held = framed ? this._held + dt : Math.max(0, this._held - dt * 2);
    if (this._held >= NOTICE) {
      this.state = ST.SEEN; this._t = 0;
      this.stats.seen++;
      this._startle = lerp(STARTLE[0], STARTLE[1], this.rng());
      // He turns his head toward the camera on the way to turning his body,
      // which is the tell that he has clocked you.
      this._look = 0;
    }
  }

  /** Noticed, and taking a moment about it. */
  _seen(dt) {
    this._moving = damp(this._moving, 0, 6, dt);
    this._look = damp(this._look, 0.55, 3.2, dt);
    if (this._t >= this._startle) {
      this.state = ST.LEAVE; this._t = 0;
      this._looked = false;
      this._lookAt = lerp(LOOK_AFTER[0], LOOK_AFTER[1], this.rng());
    }
  }

  /** Walking away, into cover. */
  _leave(dt, W, px, pz) {
    this._moving = damp(this._moving, 1, 2.2, dt);
    this._look = damp(this._look, 0, 3.0, dt);
    // Winding up over about four seconds, so the first two strides are the same
    // walk he was going to take anyway and the urgency arrives afterwards.
    this.rig.rate = damp(this.rig.rate, LEAVE_RATE, 0.55, dt);

    // Straight away from the player, bent by whatever the ground will take.
    const away = Math.atan2(this.pos.x - px, this.pos.z - pz);
    this._want = away + this._detour(W, away);
    this.heading += wrapAngle(this._want - this.heading) * (1 - Math.exp(-1.6 * dt));

    const step = this.rig.speed * dt;
    this.pos.x += Math.sin(this.heading) * step;
    this.pos.z += Math.cos(this.heading) * step;
    this.pos.y = W.getHeight(this.pos.x, this.pos.z);

    // One look back, once, on the way out. See LOOK_AFTER.
    if (!this._looked && this._t >= this._lookAt) {
      this._looked = true;
      this.state = ST.LOOK; this._t = 0;
    }
  }

  /** Stopped, head round over the shoulder. The photograph everybody wants. */
  _lookBack(dt) {
    this._moving = damp(this._moving, 0, 4.5, dt);
    // The rate unwinds while he is stopped, so he sets off again at a walk and
    // builds back up rather than snapping straight to 1.45.
    this.rig.rate = damp(this.rig.rate, 1, 1.2, dt);
    this._look = damp(this._look, 1, 2.6, dt);
    if (this._t >= LOOK_HOLD) { this.state = ST.LEAVE; this._t = 0; }
  }

  /**
   * How far off `want` he has to bend to keep his feet dry and his footing.
   *
   * A three-ray fan rather than a full steering solver: he is walking away in a
   * straight line through timber for thirty seconds, not living in the valley,
   * and the only two things that can actually go wrong are wading into a lake
   * and climbing a cliff. Returns a signed angle to add.
   */
  _detour(W, want) {
    const reach = 9;
    let best = 0, bestScore = -1;
    for (const off of [0, -0.5, 0.5, -1.0, 1.0]) {
      const a = want + off;
      const x = this.pos.x + Math.sin(a) * reach;
      const z = this.pos.z + Math.cos(a) * reach;
      if (W.getWaterDepth(x, z) > 0.25) continue;
      if (W.getSlope(x, z) > SLOPE_MAX) continue;
      // Prefer the straightest option that is legal, and prefer cover.
      const score = 1 - Math.abs(off) * 0.4 + clamp01(W.getMoisture(x, z)) * 0.3;
      if (score > bestScore) { bestScore = score; best = off; }
    }
    return best;
  }

  // ── spawning ───────────────────────────────────────────────────────────────

  /**
   * Look for somewhere to put one, and put one there if there is.
   *
   * Sampled rather than solved. The valley has no "deep timber" index and
   * building one for a cast of one would be `Wildlife._placeSites` all over
   * again for a single animal; fourteen darts thrown into an annulus finds a
   * spot most of the time and costs four field queries each, twice a second at
   * most, only while the mystery is open and nobody is out there.
   */
  _trySpawn(cam) {
    const W = this.ctx.world;
    const px = cam.position.x, pz = cam.position.z;
    // He belongs to the forest, so the player has to be in one. Checked at the
    // PLAYER rather than at the candidate: standing in a meadow and having one
    // materialise in the trees eighty metres off is the same feature with the
    // mystery taken out of it — you would know exactly where to drive.
    if (W.getMoisture(px, pz) < WOOD - 0.08) return;

    // Built before the search rather than after it, because the frustum guard
    // below has to know how tall THIS one is. It is idempotent and it happens
    // at most once a session; see `_build`.
    this._build();

    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);

    let best = null, bestScore = 0;
    for (let i = 0; i < CANDIDATES; i++) {
      const a = this.rng() * Math.PI * 2;
      const r = lerp(SPAWN_MIN, SPAWN_MAX, this.rng());
      const x = px + Math.sin(a) * r, z = pz + Math.cos(a) * r;
      if (W.getWaterDepth(x, z) > 0.1) continue;
      if (W.getSlope(x, z) > SLOPE_MAX) continue;
      const y = W.getHeight(x, z);
      if (y > ALT_MAX) continue;
      const m = W.getMoisture(x, z);
      if (m < WOOD) continue;
      // Out of shot. `STAND_H` rather than a guess, so the sphere that has to
      // clear the frustum is the one the player would actually see.
      // Sized off the variant that was actually built rather than off the
      // unit-scale constant: the three stand 2.64-2.91 m and a guard drawn at
      // 2.22 would let a spawn clip the top of the frame.
      const h = this.rig.height;
      _sphere.center.set(x, y + h * 0.5, z);
      _sphere.radius = h * 0.62;
      if (_frustum.intersectsSphere(_sphere)) continue;
      // Deeper cover wins, and so does further out — the encounter is better
      // when he is a shape rather than an animal, and it gives him room to
      // walk before `FAR_GONE` takes him.
      const score = m + (r - SPAWN_MIN) / (SPAWN_MAX - SPAWN_MIN) * 0.35;
      if (score > bestScore) { bestScore = score; best = { x, y, z }; }
    }
    if (!best) return;

    this.pos.set(best.x, best.y, best.z);
    // Facing across the player's line rather than at them or away: at rest he
    // is a profile, which is the readable silhouette, and it is also the pose
    // that has somewhere to turn FROM when he leaves.
    const toPlayer = Math.atan2(px - best.x, pz - best.z);
    this.heading = toPlayer + (this.rng() < 0.5 ? -1 : 1) * (1.0 + this.rng() * 0.5);
    this.rig.reset(this.pos, this.heading, W);
    this.group.visible = true;
    this.present = true;
    this.state = ST.WAIT;
    this._t = 0; this._life = 0; this._held = 0;
    this._look = 0; this._moving = 0; this._looked = false;
    this.stats.spawns++;
  }

  _despawn() {
    this.present = false;
    this.group.visible = false;
    this._cool = COOLDOWN;
    this._held = 0;
  }

  // ── what the rest of the game asks ─────────────────────────────────────────

  /**
   * Is he inside the frame and big enough in it to count as looked at?
   *
   * Deliberately NOT `hunt_detect`'s gate. That one decides whether a
   * photograph counts and is tuned for it (14.9% of frame height, a clear line
   * of sight, an edge margin); this only decides whether he has noticed being
   * noticed, and it wants to fire much earlier and much more cheaply — no
   * terrain march, and a quarter of the frame share. A creature that only
   * reacted once he was already photographable would never be a glimpse.
   */
  _framed(cam) {
    const r = this.rig.height * 0.5;
    _v.set(this.pos.x, this.pos.y + r, this.pos.z);
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    _sphere.center.copy(_v); _sphere.radius = r;
    if (!_frustum.intersectsSphere(_sphere)) return false;
    const dist = _v.distanceTo(cam.position);
    if (dist < 0.5) return true;
    const vfov = THREE.MathUtils.degToRad(cam.fov ?? 50) || 0.9;
    return (2 * Math.atan(r / dist)) / vfov >= NOTICE_SHARE;
  }

  /** The mesh the photo detector measures, or null when nobody is out there. */
  get mesh() { return this.present ? this.rig?.mesh ?? null : null; }

  /**
   * The compass paw's answer, in the shape `Wildlife._nearestQuarry` returns.
   *
   * Only ever reached through a RINGED target — `nearestHint`'s ambient walk
   * covers the `SPECIES` pool and this is not in it — which is the whole
   * design. An ambient paw that swung toward him would give him away to a
   * player who had not asked, and the one thing this creature has is that you
   * do not know he is there. Ring the line and the book will point; leave it
   * un-ringed and the valley says nothing.
   *
   * Null while nobody is out there, which is most of the time, and that null is
   * information too: the pin is absent until he exists, so it appearing IS the
   * "there is something over there" the compass is for.
   */
  nearest(x, z) {
    if (!this.present) return null;
    const d = Math.hypot(this.pos.x - x, this.pos.z - z);
    return d <= QUARRY_R ? { x: this.pos.x, z: this.pos.z, dist: d } : null;
  }

  /**
   * Console and harness surface: put one where he can be looked at, now.
   *
   * Two modes, and the difference matters.
   *
   *   `debugSpawn()` or `debugSpawn(camera)` runs the REAL search — deep
   *   timber, standable ground, out of frame — and returns null when the
   *   valley has nowhere to put him. That is the one worth calling when the
   *   question is "does placement work".
   *
   *   `debugSpawn({ dist, ahead })` skips the search and puts him on the
   *   ground in front of the camera. Every habitat rule is ignored: he will
   *   stand in a meadow, on a road, or in a lake. It is for LOOKING at him, and
   *   `hunt_debug.js`'s `__dbg.bigfoot()` is the caller.
   *
   * Either way he lands in WAIT with a full life ahead of him, so the four
   * beats play out from there exactly as they would have.
   */
  debugSpawn(opts = {}) {
    const o = opts?.isCamera ? { cam: opts } : (opts ?? {});
    const cam = o.cam ?? this.ctx.camera;
    this._cool = 0;
    this.armed = true;
    if (this.present) this._despawn();

    if (!(o.dist > 0)) {
      this._trySpawn(cam);
      return this.present ? { ...this.pos, variant: this.variant?.name } : null;
    }

    const W = this.ctx.world;
    if (!W || !cam) return null;
    this._build();
    // Straight down the camera's own forward axis, flattened. `ahead: false`
    // puts him behind you instead, which is how you check that he does not
    // simply appear the moment you turn round.
    const m = cam.matrixWorld.elements;
    const s = o.ahead === false ? 1 : -1;
    let fx = m[8] * s, fz = m[10] * s;
    const len = Math.hypot(fx, fz) || 1;
    fx /= len; fz /= len;
    const x = cam.position.x + fx * o.dist, z = cam.position.z + fz * o.dist;
    this.pos.set(x, W.getHeight(x, z), z);
    // Side-on to the camera, which is the readable silhouette — and the pose he
    // has somewhere to turn FROM when he leaves.
    this.heading = Math.atan2(cam.position.x - x, cam.position.z - z)
      + (this.rng() < 0.5 ? -1 : 1) * 1.2;
    this.rig.reset(this.pos, this.heading, W);
    this.group.visible = true;
    this.present = true;
    this.state = ST.WAIT;
    this._t = 0; this._life = 0; this._held = 0;
    this._look = 0; this._moving = 0; this._looked = false;
    this.stats.spawns++;
    return { ...this.pos, variant: this.variant?.name, forced: true };
  }

  dispose() {
    this.rig?.dispose();
    this.material?.dispose();
    this.group.parent?.remove(this.group);
    this.rig = null; this.material = null; this.present = false;
  }
}
