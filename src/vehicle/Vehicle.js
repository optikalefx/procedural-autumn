// ─────────────────────────────────────────────────────────────────────────────
//  Vehicle — the camper: model, suspension, drivetrain, physics and juice.
//
//  Owns three things and keeps them in step:
//    · CamperModel     procedural geometry (see that file for the shape logic)
//    · VehiclePhysics  Rapier chassis + raycast suspension + streamed ground
//    · VehicleFX       dust, leaves, spray, exhaust, tyre tracks
//
//  Everything the rest of the game needs is read off this object: `position`,
//  `heading`, `speed`, `forward`, `up`, `wheels`.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { VEHICLE } from '../world/WorldConfig.js';
import { clamp, clamp01, lerp, smoothstep, damp } from '../core/MathUtils.js';
import { buildCamper, buildWheel, buildMaterials, buildEnvMap, DIM } from './CamperModel.js';
import { VehiclePhysics } from './VehiclePhysics.js';
import { ParticleField, TrackRibbons, surfaceDust, KIND } from './VehicleFX.js';
import { VehicleShadow } from './VehicleShadow.js';

const LEAF_COLORS = [0xe8622a, 0xf09a2c, 0xf3cf45, 0x9e2b28, 0xb8471f];

// The most the visual rig may be dropped to meet the rendered ground. See
// `_groundSettle`. One physics cell (1.375 m) across a 0.3 gradient sags about
// 0.10 m, so this has headroom over the worst case and is still far short of
// anything that could read as the body sitting on its bump stops.
const MAX_SETTLE = 0.14;

// ── rescue (R) ───────────────────────────────────────────────────────────────
// The player's own spec, and it is deliberately this simple: "we need some kind
// of rescue button if the user is stuck. Something that puts them on a nearby
// surface. Lets just random 20m away, random angle. The user can just hit it
// again if they are stuck again."
//
// So: no pathfinding, no search for the "best" place in the valley, no memory
// of where you have been. One ring, random bearings on it, and the first
// landing that is genuinely somewhere a camper could be parked.
// The rings, in metres. 20 is the player's number and is always tried first;
// the wider two exist only because a ring that yields nothing would otherwise
// be a button that visibly does nothing, and a dead rescue button is worse
// than one that moves you 30 m. In practice the first ring wins almost always
// — see the ring histogram in tools/_scratch/rescuetest.mjs.
const RESCUE_RINGS = [20, 30, 42];
// And when even 42 m holds nothing. A camper wedged at the bottom of a gorge,
// or boxed in by boulders since the rocks were made solid, can have every one
// of the near rings land on a cliff face — measured at 4% of all reachable
// ground and 13% of the steep or wet ground where the button actually gets
// pressed (tools/_scratch/rescuediag.mjs). Those presses used to decline, and
// a decline there means the player closes the tab. The wide rings walk out to
// a third of the map, which is further than any pocket this terrain makes.
const RESCUE_WIDE = [60, 85, 120, 170, 240, 340];
const RESCUE_TRIES = 28;        // bearings sampled on the 20 m ring
// Wider rings get proportionally more of them: 28 samples on a 340 m ring is
// one every 76 m, which would step over whole meadows. Sampling at a fixed arc
// instead keeps the resolution of the search constant no matter how far out it
// has had to reach. The cap is what stops the outer rings dominating the cost.
const RESCUE_ARC = 4.5;         // m between samples along a ring
const RESCUE_TRIES_MAX = 200;
const RESCUE_COOLDOWN = 1.0;    // s between presses; see `rescue()`
const RESCUE_WATER = 0.05;      // m — anything deeper is standing water
const RESCUE_FOOT = 2.2;        // m — footprint radius the checks are run over
const RESCUE_CLEAR = 2.8;       // m of clear ground the camper needs around it
const RESCUE_STEP = 1.1;        // m of height change across a footprint = a ledge
// How far out the openness probes look, and how many of the four have to come
// back drivable. This is the check that stops a rescue solving nothing: a 6 m
// shelf halfway up a gorge passes every footprint test there is and is still
// somewhere you press R again from.
const RESCUE_OPEN = 12;         // m
const RESCUE_OPEN_MIN = 2;      // of 4 probes, for an ideal site
// Slope limits, and these are measured numbers rather than taste.
//
// `init` picks the camper's *spawn* with `getSlope > 0.42`. Reusing that alone
// was too strict: this valley's median footprint slope is 0.72, so a single
// 20 m ring at 0.42 found nothing at all from 23% of reachable ground, and
// from 57% of the steep or wet ground that is exactly where the button gets
// pressed. A rescue that declines more than half the time it is needed is not
// a rescue. (tools/_scratch/rescuediag.mjs)
//
// The first attempt at fixing that relaxed the limit to a *mean* footprint
// slope of 0.85 with a max of 1.25, and that was worse, not better: over 100
// rescues 12% of landings on ground whose mean slope was under 0.3 slid more
// than 2.5 m in the two seconds after landing, some of them into the river.
// The mean is the wrong statistic. A footprint can average 0.25 and still have
// a 1.2 sample in it — flat ground beside a drop — and the camper finds the
// drop. The limit is on the WORST sample in the footprint, and the extra reach
// comes from the ring stepping outward instead. (tools/_scratch/rescuetest.mjs)
const RESCUE_SLOPE = 0.42;      // ideal: flat enough to be a nice place to stop
const RESCUE_SLOPE_OK = 0.65;   // acceptable: still holds, measured (see above)
// The last resort, and it is not a fourth opinion about what good ground is —
// it is the answer to "there is no good ground". These loosen the two checks
// that are about comfort rather than about staying put (a tighter squeeze
// between boulders, a bigger step across the footprint) and the slope only as
// far as the measurements above still support. A site here is somewhere you
// have to drive carefully away from. That beats a button that does nothing.
const RESCUE_SLOPE_LAST = 0.75;
const RESCUE_CLEAR_LAST = 2.5;  // m — chassis half-diagonal is 2.4
const RESCUE_STEP_LAST = 1.6;

// ── brake hold (Space) ───────────────────────────────────────────────────────
// The player's spec: "Space bar is breaking, but it should have a break HOLD
// when you're below 5 mph … Simply moving the car removes break hold."
//
// Space keeps its handbrake job unchanged. What is new is that below the
// threshold it *latches*: let go of the key and the camper stays put, exactly
// like the auto-hold on a modern automatic. VehiclePhysics owns the mechanism
// (and the 8.5 km/h-not-5 mph argument); this file owns the policy — when it
// arms, and what makes it let go.
//
// Threshold matched to VehiclePhysics.HOLD_SPEED, and deliberately compared
// against `this.speed`, which is the number the speedo prints. A player who
// reads 8 and presses Space gets a hold; a player who reads 9 does not.
const HOLD_KMH = 8.5;
const HOLD_SPEED = HOLD_KMH / 3.6;          // 2.36 m/s
const HOLD_GROUNDED = 3;                    // wheels on the ground to arm at all
// A pedal is "moving the car". Steering deliberately is not: the player was
// specific that *moving* releases the hold, and turning the wheel on a parked
// camper is not moving it — it is lining up the shot you stopped to take.
const HOLD_PEDAL = 0.02;

export class Vehicle extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Vehicle';
    this.loadLabel = 'Packing the camper';

    this.position = new THREE.Vector3();
    this.heading = 0;
    this.speed = 0;
    this.velocity = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, 1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);
    this.quaternion = new THREE.Quaternion();
    this.wheels = [];
    this.waterDepth = 0;
    this.engineLoad = 0;
    this.throttle = 0;
    this.steer = 0;

    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._col = new THREE.Color();
    this._w = {};
    this._exhaustAcc = 0;
    this._headlightMix = 0;
    this._parkDip = 0;         // headlights dipped because the park brake is on
    this._lastSpeed = 0;
    this._accelSmooth = 0;
    this._lateralSmooth = 0;
    this._settle = 0;
    this._invQuat = new THREE.Quaternion();
    this._rescueCool = 0;
    this._rescueHold = false;
    this._brakeHold = false;
    this.brakeHold = false;      // what the HUD lamp reads
    this.rescues = 0;
    this.teleportSeq = 0;      // CameraRig watches this and re-primes its boom
  }

  async init() {
    const { ctx } = this;
    const { scene, renderer, world, poi } = ctx;

    // ── pick a start: the first road point that is flat, dry and in bounds ──
    let start = null;
    for (let i = 0; i < 24 && !start; i++) {
      const p = poi.best('road', i);
      if (!p) break;
      if (world.getWaterDepth(p.x, p.z) > 0.05) continue;
      if (world.getSlope(p.x, p.z) > 0.42) continue;
      start = p;
    }
    start = start ?? poi.best('meadow') ?? { x: 0, z: 0, yaw: 0 };
    const heading = start.yaw ?? 0;

    // ── materials + model ───────────────────────────────────────────────────
    this.env = buildEnvMap(renderer);
    this.materials = buildMaterials(this.env, 0xc4551f);
    const built = buildCamper(this.materials, 91);
    this.root = built.root;
    this.antenna = built.antenna;
    this.steeringWheel = built.steeringWheel;

    // A pivot between the physics transform and the model, used for the little
    // exaggerations physics alone will not give: idle shake and a touch of
    // extra weight transfer.
    this.pivot = new THREE.Group();
    this.pivot.add(this.root);
    this.rig = new THREE.Group();
    this.rig.name = 'vehicleRig';
    this.rig.add(this.pivot);
    scene.add(this.rig);

    this.wheelNodes = [];
    for (let i = 0; i < 4; i++) {
      const hub = new THREE.Group();          // steering
      const spin = buildWheel(this.materials);
      hub.add(spin);
      this.rig.add(hub);                      // NB: not under `pivot` — wheels
      this.wheelNodes.push({ hub, spin });     // must not inherit body lean
    }

    // ── headlights ──────────────────────────────────────────────────────────
    this.headlights = [];
    for (const s of [-1, 1]) {
      const l = new THREE.SpotLight(0xfff0d2, 0, 68, 0.52, 0.55, 1.4);
      l.castShadow = false;
      l.position.set(s * 0.60, 0.205, DIM.front - 0.02);
      l.target.position.set(s * 0.55, -1.1, DIM.front + 20);
      this.rig.add(l);
      this.rig.add(l.target);
      this.headlights.push(l);
    }

    // ── physics ─────────────────────────────────────────────────────────────
    this.phys = new VehiclePhysics(world);
    await this.phys.init(start.x, start.z, heading);
    this.wheels = this.phys.wheels;
    // Rocks are solid. `rocks` is built before the camper (see SYSTEMS in
    // main.js) so it is here to hand, but this is deliberately tolerant of its
    // absence — the capture harness and the sky tools run without it.
    this.phys.setRockSource(ctx.systems.rocks ?? null);

    // ── fx ──────────────────────────────────────────────────────────────────
    const budget = ctx.preset?.grassMul >= 0.8 ? 1100 : 550;
    this.particles = new ParticleField(scene, budget);
    this.tracks = new TrackRibbons(scene, 4, ctx.preset?.grassMul >= 0.8 ? 190 : 110);
    // Contact occlusion. One draw call, and it is the difference between the
    // camper resting on the meadow and hovering over it — see VehicleShadow.js
    // for why this is ambient occlusion and deliberately not a cast shadow.
    this.contactShadow = new VehicleShadow(scene, world);

    this._sample = (x, z) => world.getHeight(x, z);
    this._syncTransform();

    // Debug surface for tools/drive.mjs.
    window.__vehicle = this;
    window.__vehicleState = () => ({
      x: this.position.x, y: this.position.y, z: this.position.z,
      speed: this.speed, heading: this.heading,
      up: this.up.y, grounded: this.wheels.filter((w) => w.grounded).length,
      water: this.waterDepth, recoveries: this.phys.recoveries,
      rescues: this.rescues, slope: world.getSlope(this.position.x, this.position.z),
      revBrake: this.phys.revBrakeTime ?? 0,
      hold: this.phys.holdArmed, held: this.phys.holding,
      holdDrift: this.phys.holdDrift ?? 0,
      holdArmedFor: this.phys._armedFor, holdLatchV: this.phys.holdLatchV ?? 0,
      nan: this.phys.nanEvents ?? 0,
      rockColliders: this.phys.rocks?.count ?? 0,
      ground: world.getHeight(this.position.x, this.position.z),
    });
    window.__vehicleTeleport = (x, z, h = 0) => this.phys.teleport(x, z, h);
    window.__vehicleTune = (o) => this.phys.tune(o);
    // Test surface for tools/_scratch/rescuetest.mjs. `force` skips only the
    // cooldown, never a validity check.
    window.__vehicleRescue = (force = false) => {
      if (force) this._rescueCool = 0;
      return this.rescue();
    };
  }

  update(dt) {
    if (!this.phys?.ready) return;
    const { ctx } = this;
    const input = ctx.input;
    const ax = input.axes;

    // ── camera cycling / input ──────────────────────────────────────────────
    this.throttle = ax.throttle;
    this.steer = ax.steer;

    // ── rescue ──────────────────────────────────────────────────────────────
    // `justPressed` is cleared by Input every frame and zeroed entirely while a
    // menu has focus, so this cannot fire from the settings sheet or fire twice
    // from one press.
    this._rescueCool = Math.max(0, this._rescueCool - dt);
    if (input.justPressed('KeyR')) this.rescue();
    // Once per session, and only after the player has genuinely been fighting
    // it for a couple of seconds: a key you only need when stuck is no use if
    // you learn about it before you are. `_stuckFor` is the physics' own
    // measure — full throttle or full brake, going nowhere, on the ground.
    if (!this._toldAboutRescue && this.phys._stuckFor > 2.4) {
      this._toldAboutRescue = true;
      ctx.systems.hud?.toast?.('Stuck? Press R');
    }

    // ── brake hold ──────────────────────────────────────────────────────────
    // A pedal — either pedal — is the player moving the camper, and it lets go
    // of everything. Checked *first* so that holding Space and W together is a
    // request to drive rather than a fight: the hold cannot re-arm on the same
    // frame it was released, and by the next frame the camper is over the
    // threshold. Without that ordering the two inputs deadlock and the camper
    // sits there with the throttle open.
    const driving = ax.throttle > HOLD_PEDAL || ax.brake > HOLD_PEDAL;
    if (driving) this._brakeHold = false;
    else if (ax.handbrake > 0.5 && this._holdEligible()) this._brakeHold = true;

    // A rescue leaves the park brake on. Any deliberate input releases it —
    // the player has taken over and the camper should behave normally from
    // that instant, with no "press again to release" ceremony. Steering counts
    // here, unlike the brake hold above, because a rescue was not something the
    // player chose and any sign of life should hand the camper back.
    if (driving || Math.abs(ax.steer) > 0.05) this._rescueHold = false;

    this.phys.step(dt, {
      throttle: ax.throttle,
      brake: ax.brake,
      steer: ax.steer,
      handbrake: ax.handbrake,
      hold: this._brakeHold,
      park: this._rescueHold,
    });
    this.brakeHold = this.phys.holdArmed;
    // Once per session, the first time it engages: a latching handbrake is not
    // what Space does in any other driving game, and a player who does not know
    // it latched will read it as the camper having jammed.
    if (this.brakeHold && !this._toldAboutHold) {
      this._toldAboutHold = true;
      ctx.systems.hud?.toast?.('Brake hold on — press W to drive away');
    }

    this._syncTransform();
    this._groundSettle(dt);
    this._syncWheels(dt);
    this._body(dt);
    this._effects(dt);
    this._lights(dt);

    this.particles.update(dt, ctx.engine.height);
    this.tracks.update(dt);
    let onGround = 0;
    for (let i = 0; i < this.wheels.length; i++) if (this.wheels[i].grounded) onGround++;
    this.contactShadow.update(this.position.x, this.position.z, this.heading,
      onGround / Math.max(1, this.wheels.length));
    this._patchAnchor();
  }

  /**
   * May the handbrake latch right now?
   *
   * Two gates, and they cover different failures. The speed gate is the
   * player's ("below 5 mph") and is measured against `this.speed` because that
   * is what the dial prints. The grounded gate is the one that stops a hold
   * being engaged in mid-air or mid-bounce — the physics will not *latch*
   * until it has settled either way, but arming a hold on a camper that is
   * still falling would light the lamp several seconds before anything held.
   */
  _holdEligible() {
    if (Math.abs(this.speed) > HOLD_SPEED) return false;
    let onGround = 0;
    for (let i = 0; i < this.wheels.length; i++) if (this.wheels[i].grounded) onGround++;
    return onGround >= HOLD_GROUNDED;
  }

  // ── rescue ────────────────────────────────────────────────────────────────

  /**
   * Put the camper down somewhere it can drive away from.
   *
   * The destination is exactly what was asked for — `RESCUE_RANGE` metres away
   * on a random bearing — but the *landing* is checked, because a rescue that
   * drops you in the river or on a 40-degree face is not a rescue. A site has
   * to be, over the whole footprint and not just at the centre point:
   *
   *   · inside the world;
   *   · dry (`getWaterDepth` under 5 cm — no standing water);
   *   · gentle enough not to slide straight back — no sample in the footprint
   *     over 0.65, and preferably none over 0.42, which is somewhere you would
   *     choose to park rather than merely somewhere you can sit;
   *   · a continuous surface, not a step — no ledge or overhang inside the
   *     footprint, which is how you end up half inside a cliff;
   *   · clear of tree trunks and of boulders big enough to matter.
   *
   * Every bearing on the ring is scored and the best survivor wins, so a flat
   * clearing beats a passable-but-tilted verge. If the 20 m ring holds nothing
   * at all — a lakeside, a gorge — the search steps out to 30 and then 42 m
   * rather than declining, because a rescue button that does nothing is worse
   * than one that moves you further than advertised. Only if all three rings
   * come back empty does it decline and say so.
   *
   * @returns {{x:number,z:number,range:number,relaxed:boolean}|null}
   */
  rescue() {
    if (!this.phys?.ready || this._rescueCool > 0) return null;

    const site = this._rescueSite();
    if (!site) {
      this.ctx.systems.hud?.toast?.('Nowhere clear to move to — try again');
      // Still take the cooldown: a failed press must not let the search run
      // every frame while the key is held down.
      this._rescueCool = RESCUE_COOLDOWN;
      return null;
    }

    // Heading is preserved rather than randomised. The *place* is random
    // because the player asked for that; spinning them as well would make an
    // already-disorienting jump worse, and the site checks have already
    // guaranteed there is nothing to be pointed into.
    this.phys.teleport(site.x, site.z, this.heading);
    // The physics teleport zeroes linear and angular velocity; these are the
    // things on this side that would otherwise carry the old motion across.
    this.phys._stuckFor = 0;
    this.phys._invertedFor = 0;
    this.phys.righting = 0;
    this._syncTransform();
    this._lastSpeed = 0;
    this._accelSmooth = 0;
    this._lateralSmooth = 0;
    this._settle = 0;
    this.pivot.rotation.set(0, 0, 0);
    this.pivot.position.y = 0;
    // Otherwise a 20 m quad of tyre track is drawn across untouched ground.
    this.tracks?.cut();

    this._rescueHold = true;      // park brake on until the player drives away
    // The rescue's own hold supersedes the player's: they are the same latch,
    // but the rescue one also releases on steering, and leaving both set would
    // mean a steer released one and not the other.
    this._brakeHold = false;
    this._rescueCool = RESCUE_COOLDOWN;
    this.rescues++;
    this.teleportSeq++;
    this.ctx.systems.hud?.toast?.(site.relaxed ? 'Moved you clear' : 'Moved you to open ground');
    return site;
  }

  /**
   * Sample bearings on each rescue ring in turn and return the best landing.
   *
   * The 20 m ring is tried first and, if it holds anything decent, wins — the
   * wider rings exist only so that a bad neighbourhood produces a longer hop
   * rather than a button that does nothing.
   */
  _rescueSite() {
    const px = this.position.x, pz = this.position.z;
    let best = null, okBest = null;
    for (const range of RESCUE_RINGS) {
      // A random start angle plus an even stride covers the ring rather than
      // clumping, which independent draws do. Still random, still one line.
      const a0 = Math.random() * Math.PI * 2;
      for (let i = 0; i < RESCUE_TRIES; i++) {
        const a = a0 + (i / RESCUE_TRIES) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
        const x = px + Math.sin(a) * range;
        const z = pz + Math.cos(a) * range;
        const s = this._siteScore(x, z);
        if (!s) continue;
        const site = { x, z, range, ...s };
        if (!okBest || s.score > okBest.score) okBest = site;
        if (s.ideal && (!best || s.score > best.score)) best = site;
      }
      // Good enough on this ring: stop here rather than reaching further out.
      if (best) return { ...best, relaxed: false };
    }
    if (okBest) return { ...okBest, relaxed: true };
    return null;
  }

  /**
   * Hard checks (bounds, water, slope) return null — those sites are never
   * used. The comfort checks (ledge, obstacles) only clear the `clear` flag,
   * so a site that fails them is still available to the relaxed second pass.
   */
  _siteScore(x, z) {
    const W = this.ctx.world;
    if (!W.isInBounds(x, z)) return null;
    const h = W.getHeight(x, z);
    if (!Number.isFinite(h)) return null;
    if (W.getWaterDepth(x, z) > RESCUE_WATER) return null;

    // Eight points around the footprint plus the centre. The centre alone is
    // not enough: a 2 m wide camper straddles the lip of a bank quite happily
    // as far as a single sample is concerned.
    let worst = W.getSlope(x, z);
    let sum = worst;
    let step = 0;
    for (let k = 0; k < 8; k++) {
      const b = (k / 8) * Math.PI * 2;
      const sx = x + Math.sin(b) * RESCUE_FOOT;
      const sz = z + Math.cos(b) * RESCUE_FOOT;
      if (!W.isInBounds(sx, sz)) return null;
      if (W.getWaterDepth(sx, sz) > RESCUE_WATER) return null;
      const sh = W.getHeight(sx, sz);
      if (!Number.isFinite(sh)) return null;
      const sl = W.getSlope(sx, sz);
      worst = Math.max(worst, sl);
      sum += sl;
      step = Math.max(step, Math.abs(sh - h));
    }
    const mean = sum / 9;
    // Hard, and in this order because each is cheaper than the next.
    // Above RESCUE_SLOPE_OK the camper slides back down, and a rescue that
    // does that has achieved nothing. A ledge inside the footprint is the same
    // failure wearing a different hat.
    if (worst > RESCUE_SLOPE_OK) return null;
    if (step > RESCUE_STEP) return null;
    // Only now is the obstacle query worth paying for.
    const gap = Math.min(this._treeGap(x, z), this._rockGap(x, z));
    if (gap < RESCUE_CLEAR) return null;

    // Flatter and roomier is better; the terms are on comparable scales here so
    // a plain weighted sum is enough and needs no tuning.
    const score = -mean * 2 - worst * 2 - step * 0.8 + Math.min(gap, 8) * 0.3;
    return { score, ideal: worst <= RESCUE_SLOPE, slope: worst, mean, step, gap };
  }

  /**
   * Distance to the nearest tree trunk, minus that trunk's radius.
   *
   * Read straight off the Trees system's own bucketed placement table rather
   * than raycast against the scene: the buckets are a 64 m grid with a prefix
   * -summed index, so this touches a few dozen trees rather than 120 000, and
   * it sees trees that are currently drawn as far-field impostors too.
   * Defensive throughout — Trees may not have built yet, or may not exist.
   */
  _treeGap(x, z) {
    const T = this.ctx.systems.trees?.trees;
    if (!T?.n || !T.order || !T.bucketStart) return Infinity;
    const { px, pz, pscale, order, bucketStart, BW, BS, half } = T;
    const R = 8;
    const bi = (v) => clamp(((v + half) / BS) | 0, 0, BW - 1);
    const bx0 = bi(x - R), bx1 = bi(x + R), bz0 = bi(z - R), bz1 = bi(z + R);
    let best = Infinity;
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const b = bz * BW + bx;
        const end = bucketStart[b + 1];
        for (let i = bucketStart[b]; i < end; i++) {
          const t = order[i];
          const dx = px[t] - x, dz = pz[t] - z;
          // Trunk, not crown: parking under a canopy is fine, parking inside a
          // bole is not. A prototype trunk is ~0.35 m at scale 1.
          const d = Math.hypot(dx, dz) - (0.15 + 0.35 * (pscale?.[t] ?? 1));
          if (d < best) best = d;
        }
      }
    }
    return best;
  }

  /**
   * Distance to the nearest boulder, minus its horizontal half-extent. Rock
   * geometry is authored ~2 units across, so `sx`/`sz` are metres of radius.
   * Cobbles are ignored: the camper drives over those, and counting them would
   * reject most of a riverbed.
   */
  _rockGap(x, z) {
    const cells = this.ctx.systems.rocks?.cells;
    if (!cells?.size) return Infinity;
    let best = Infinity;
    for (const c of cells.values()) {
      const list = c?.instances;
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.size < 0.8) continue;
        const dx = r.x - x, dz = r.z - z;
        if (Math.abs(dx) > 12 || Math.abs(dz) > 12) continue;
        const d = Math.hypot(dx, dz) - Math.max(r.sx ?? r.size, r.sz ?? r.size);
        if (d < best) best = d;
      }
    }
    return best;
  }

  // ── transform ─────────────────────────────────────────────────────────────
  _syncTransform() {
    const t = this.phys.body.translation();
    const r = this.phys.body.rotation();
    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
    this._invQuat.copy(this.quaternion).invert();
    this.rig.position.copy(this.position);
    this.rig.quaternion.copy(this.quaternion);
    this.forward.copy(this.phys._fwd);
    this.right.copy(this.phys._right);
    this.up.copy(this.phys._up);
    this.heading = Math.atan2(this.forward.x, this.forward.z);
    this.speed = this.phys.speed;
    this.velocity.copy(this.phys.velocity);
    this.waterDepth = this.phys.waterDepth;
  }

  /**
   * Plant the camper on the ground you can actually see.
   *
   * The suspension rays run against a **streamed Rapier heightfield sampled at
   * 1.375 m per cell** (`PATCH_DIV` in VehiclePhysics), while the terrain you
   * look at carries `world.getHeight`'s micro-detail on top of that. Over a
   * concave cell the collider's linear interpolation is a chord across the dip,
   * so the tyre rests on a surface that is genuinely above the rendered meadow.
   * Measured on the `vehicle` anchor, the four wheels sat at +0.041, +0.031,
   * -0.020 and **+0.119 m** clear of `world.getHeight` — and 0.119 m at the
   * 9 m the hero framing shoots from is a 15 px band of daylight under a tyre.
   * That is the "camper floats" read; the physics is not wrong, the two
   * surfaces just are not the same surface.
   *
   * Fixing it in the collider means a finer patch, which is real CPU on a
   * budget that is already tight, for a difference no one can feel. So this is
   * a *visual* settle: drop the whole rig — body and wheels together — by the
   * SMALLEST clearance any grounded wheel has. The smallest, because that wheel
   * is the one that must not end up underground; every other wheel is on higher
   * ground and only gets closer. It can therefore never sink a tyre into the
   * meadow, only close a gap.
   *
   * Damped, because the offset is recomputed from a moving 1.375 m grid and a
   * hard per-frame value would jitter the model at rest.
   */
  _groundSettle(dt) {
    const W = this.ctx.world;
    let minClear = Infinity;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      if (!w.grounded) continue;
      const g = W.getHeight(w.pos.x, w.pos.z);
      if (!Number.isFinite(g)) continue;
      // The lowest point of a tyre in world Y. Using the full radius rather
      // than the radius projected on the chassis' up axis under-reads the
      // clearance on a side slope, which errs toward settling less — the safe
      // direction, since over-settling is the one failure that would look worse
      // than the gap.
      const clear = w.pos.y - VEHICLE.wheelRadius - g;
      if (clear < minClear) minClear = clear;
    }
    const want = Number.isFinite(minClear) ? clamp(minClear, 0, MAX_SETTLE) : 0;
    this._settle = damp(this._settle, want, 10, dt);
    this.rig.position.y -= this._settle;
  }

  _syncWheels(dt) {
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const n = this.wheelNodes[i];
      // Physics reports wheel centres in world space. Convert through the
      // *physics* transform, not `rig.worldToLocal` — the rig carries the
      // ground settle above, and going through its matrix would cancel the
      // settle out for the wheels and drop the body onto them instead of
      // moving the whole vehicle down.
      this._tmp.copy(w.pos).sub(this.position).applyQuaternion(this._invQuat);
      n.hub.position.copy(this._tmp);
      n.hub.rotation.y = w.steer;
      // Rapier's wheel rotation grows as the wheel rolls forward, and the axle
      // was registered as -X, which is the same as +rotation about +X here: a
      // positive angle carries the top of the tyre toward +Z, the way it rolls.
      n.spin.rotation.x = w.spin;
      void dt;
    }
  }

  /** Exaggerated weight transfer + idle shake, applied to the body only. */
  _body(dt) {
    const accel = (this.speed - this._lastSpeed) / Math.max(dt, 1e-3);
    this._lastSpeed = this.speed;
    this._accelSmooth = damp(this._accelSmooth, clamp(accel, -14, 14), 7, dt);
    this._lateralSmooth = damp(this._lateralSmooth, clamp(this.phys.lateral ?? 0, -12, 12), 6, dt);

    const idle = this.throttle > 0.05 ? 1.0 : 0.42;
    const t = performance.now() * 0.001;
    const shake = (this.wheels.some((w) => w.grounded) ? 1 : 0.2) * idle * 0.0016;

    // Physics already pitches through the springs; this adds ~25% on top so it
    // reads at a glance in a chase camera without feeling like a boat.
    this.pivot.rotation.x = damp(this.pivot.rotation.x, -this._accelSmooth * 0.012, 9, dt)
      + Math.sin(t * 41.0) * shake;
    this.pivot.rotation.z = damp(this.pivot.rotation.z, this._lateralSmooth * 0.010, 8, dt)
      + Math.sin(t * 33.0 + 1.7) * shake * 0.7;
    this.pivot.position.y = Math.sin(t * 37.0) * shake * 0.5;

    // Antenna trails the acceleration and whips in a turn.
    const aw = clamp(-this._accelSmooth * 0.03 + Math.sin(t * 3.1) * 0.02, -0.4, 0.4);
    this.antenna.rotation.x = damp(this.antenna.rotation.x, aw, 5, dt);
    this.antenna.rotation.z = damp(this.antenna.rotation.z,
      clamp(this._lateralSmooth * 0.035, -0.4, 0.4) + Math.sin(t * 2.3) * 0.03, 4, dt);

    // Steering wheel follows the road wheels, with a little lag.
    const target = -(this.phys.steerAngle ?? 0) * 3.4;
    this.steeringWheel.rotation.z = damp(this.steeringWheel.rotation.z, target, 10, dt);
  }

  // ── particles, spray, tracks ──────────────────────────────────────────────
  _effects(dt) {
    const { world } = this.ctx;
    const P = this.particles;
    const absSpeed = Math.abs(this.speed);
    const c = this._col;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.grounded) continue;
      const cx = w.contact.x, cy = w.contact.y, cz = w.contact.z;
      if (!Number.isFinite(cx)) continue;

      const depth = world.getWaterDepth(cx, cz);
      const weights = world.getSurfaceWeights(cx, cz, this._w);
      const soft = clamp01(weights.grass * 0.7 + weights.dry * 0.8 + weights.dirt * 1.0
        + weights.sand * 1.0 + weights.snow * 0.9 - weights.rock * 0.8);

      // spin-up and slide both throw material; so does simply moving fast
      const work = clamp01(absSpeed / 16) * 0.55 + w.slip * 0.9;

      if (depth > 0.06) {
        // ── water: spray sheets off the tyre, higher with speed ─────────────
        const n = Math.min(4, Math.floor(absSpeed * dt * 9 + Math.random() * 0.8));
        for (let k = 0; k < n; k++) {
          const sp = 1.2 + absSpeed * 0.22;
          c.setRGB(0.76, 0.82, 0.86);
          P.spawn(
            cx + (Math.random() - 0.5) * 0.3,
            cy + 0.1 + Math.random() * 0.2,
            cz + (Math.random() - 0.5) * 0.3,
            -this.forward.x * sp * (0.3 + Math.random() * 0.8) + (Math.random() - 0.5) * 2.2,
            1.6 + Math.random() * 2.6,
            -this.forward.z * sp * (0.3 + Math.random() * 0.8) + (Math.random() - 0.5) * 2.2,
            0.55 + Math.random() * 0.45, 0.10 + Math.random() * 0.10, KIND.SPRAY, c,
          );
        }
        continue;
      }

      if (work * soft < 0.05) continue;

      // ── dust / dirt ────────────────────────────────────────────────────────
      const rate = work * soft * (2.0 + absSpeed * 0.55);
      let n = Math.floor(rate * dt * 26);
      if (Math.random() < rate * dt * 26 - n) n++;
      for (let k = 0; k < Math.min(n, 5); k++) {
        surfaceDust(weights, c);
        // Particles are unlit, so the raw surface colour is *brighter* than the
        // lit ground it came off — right on the bloom threshold, which is what
        // turned the rooster tail into a string of glowing white beads. Bring
        // it down to roughly what that soil looks like in the frame.
        c.multiplyScalar((0.85 + Math.random() * 0.3) * 0.58);
        // Wide scatter around the contact patch: puffs spawned in a tight line
        // stay in a tight line, which reads as two rails of beads rather than a
        // cloud the camper is dragging.
        P.spawn(
          cx + (Math.random() - 0.5) * 0.62,
          cy + 0.06 + Math.random() * 0.26,
          cz + (Math.random() - 0.5) * 0.62,
          -this.forward.x * (0.8 + absSpeed * 0.16) * (0.4 + Math.random()) + (Math.random() - 0.5) * 1.1,
          0.5 + Math.random() * 1.1,
          -this.forward.z * (0.8 + absSpeed * 0.16) * (0.4 + Math.random()) + (Math.random() - 0.5) * 1.1,
          0.9 + Math.random() * 1.1, 0.28 + Math.random() * 0.4, KIND.DUST, c,
        );
      }

      // ── kicked-up leaves, only where litter actually lies ──────────────────
      if (Math.random() < weights.litter * work * dt * 16) {
        c.setHex(LEAF_COLORS[(Math.random() * LEAF_COLORS.length) | 0], THREE.SRGBColorSpace);
        P.spawn(
          cx + (Math.random() - 0.5) * 0.5, cy + 0.12, cz + (Math.random() - 0.5) * 0.5,
          -this.forward.x * (1.4 + absSpeed * 0.3) + (Math.random() - 0.5) * 2.4,
          1.4 + Math.random() * 2.4,
          -this.forward.z * (1.4 + absSpeed * 0.3) + (Math.random() - 0.5) * 2.4,
          1.6 + Math.random() * 1.4, 0.13 + Math.random() * 0.07, KIND.LEAF, c,
        );
      }

      // ── tracks in soft ground ─────────────────────────────────────────────
      if (soft > 0.28 && absSpeed > 1.0) {
        surfaceDust(weights, c);
        // The ribbon multiplies into the ground, so this is a *tint*, not a
        // colour: normalise the soil hue to a fixed value just under white so a
        // rut darkens whatever it lies on instead of painting over it.
        const l = Math.max(1e-3, c.r * 0.3 + c.g * 0.6 + c.b * 0.1);
        c.multiplyScalar(0.70 / l);
        this.tracks.emit(i, cx, cz, this.right.x, this.right.z, 0.19, c,
          clamp01(soft * 1.1) * clamp01(absSpeed * 0.5), this._sample);
      }
    }

    // ── bow wave when wading ────────────────────────────────────────────────
    if (this.waterDepth > 0.12 && absSpeed > 1.2) {
      const wl = world.getWaterHeight(this.position.x, this.position.z) ?? this.position.y;
      const n = Math.min(5, Math.floor(absSpeed * dt * 14));
      for (let k = 0; k < n; k++) {
        const s = (Math.random() - 0.5) * 2;
        this._tmp.copy(this.position)
          .addScaledVector(this.forward, 2.1 * Math.sign(this.speed || 1))
          .addScaledVector(this.right, s * 0.95);
        c.setRGB(0.80, 0.86, 0.90);
        P.spawn(this._tmp.x, wl + 0.08, this._tmp.z,
          this.forward.x * absSpeed * 0.28 + s * 1.6, 1.0 + Math.random() * 1.8,
          this.forward.z * absSpeed * 0.28 + s * 1.6,
          0.7 + Math.random() * 0.5, 0.16 + Math.random() * 0.16, KIND.SPRAY, c);
      }
    }

    // ── exhaust: a puff on throttle, a wisp at idle ─────────────────────────
    this._exhaustAcc += dt * (0.9 + this.throttle * 7.5 + clamp01(this._accelSmooth * 0.3) * 6);
    while (this._exhaustAcc > 1) {
      this._exhaustAcc -= 1;
      this._tmp.set(0.46, DIM.floor - 0.06, DIM.rear - 0.05).applyQuaternion(this.quaternion).add(this.position);
      c.setRGB(0.40, 0.385, 0.385);
      P.spawn(this._tmp.x, this._tmp.y, this._tmp.z,
        -this.forward.x * 1.6 + (Math.random() - 0.5) * 0.5,
        0.35 + Math.random() * 0.4,
        -this.forward.z * 1.6 + (Math.random() - 0.5) * 0.5,
        0.85 + Math.random() * 0.7, 0.13 + Math.random() * 0.12, KIND.SMOKE, c);
    }
  }

  // ── headlights + lamp emissives follow the sun ───────────────────────────
  _lights(dt) {
    const sunY = this.ctx.lighting?.sunDir?.y ?? 1;
    const want = 1 - smoothstep(-0.02, 0.20, sunY);
    this._headlightMix = damp(this._headlightMix, want, 2.2, dt);
    const k = this._headlightMix;

    // ── dip on the park brake ────────────────────────────────────────────
    //
    // Two 190-intensity spots reaching 68 m are the right headlights for
    // driving and the wrong ones for standing still. A peer session measuring
    // the camp telescope's dusk values found a pool 8-10 m across in which the
    // MEADOW ITSELF clipped to pure white, and spent two rounds darkening a
    // white telescope by a full stop before building an instrument good enough
    // to see that the hotspot owned fourteen of the seventeen points of
    // clipping they were chasing. It was this. Anything pale standing in that
    // beam reads blown out, and the camp brief's hardest rule is that after
    // sundown nothing may out-value the fire.
    //
    // Latching the park brake is the player saying they have stopped here, so
    // the lamps drop to a sidelight. It is also just what a person does at a
    // campsite: you do not sit around a fire with your high beams on. Any
    // deliberate input releases the hold and they come straight back up, so
    // there is nothing to switch and nothing to learn.
    //
    // Dipped, not extinguished. A camper parked at night with its lamps dead
    // reads as broken down rather than as camped, and the fire only lights the
    // few metres around itself.
    this._parkDip = damp(this._parkDip, this.brakeHold ? 1 : 0, 1.5, dt);
    const beam = k * lerp(1, 0.06, this._parkDip);
    for (const l of this.headlights) l.intensity = beam * 190;
    const m = this.materials;
    m.lensHead.emissiveIntensity = lerp(0.30, 2.4, k) * lerp(1, 0.42, this._parkDip);
    m.lensTail.emissiveIntensity = lerp(0.45, 1.7, k) +
      // The pedal still lights them, as before; `phys.braking` adds the one
      // case the pedal cannot see — the throttle being used to stop a reverse.
      (this.ctx.input.axes.brake > 0.05 || this.phys?.braking ? 1.6 : 0);
    m.lensAmber.emissiveIntensity = lerp(0.25, 0.9, k);
  }

  /**
   * The capture harness stands the camera *at* `vehicle.position`, which puts
   * it inside the cabin. Offset the anchor back along the view direction so
   * `--view vehicle` actually frames the camper. Logged in
   * docs/INTEGRATION_REQUESTS.md; harmless if the harness ever changes.
   */
  _patchAnchor() {
    if (this._anchorPatched || !window.__cameraAnchors) return;
    this._anchorPatched = true;
    window.__cameraAnchors.vehicle = () => {
      const w = this.ctx.world;
      const R = 9;
      // Rear three-quarter by preference, but swing round rather than stand in
      // a river or in a hole: the harness plants the camera 2.1 m above the
      // ground *at this point*, so a wet or sunken one buries the shot.
      let best = null;
      for (let i = 0; i < 15; i++) {
        const off = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.32;
        const a = this.heading + 2.30 + off;
        const x = this.position.x + Math.sin(a) * R;
        const z = this.position.z + Math.cos(a) * R;
        const drop = this.position.y - w.getHeight(x, z);
        const score = -Math.abs(off) * 0.7
          - w.getWaterDepth(x, z) * 8
          - Math.max(0, drop - 1.0) * 1.6      // camera below the camper
          - Math.max(0, -drop - 0.6) * 1.2;    // camera up a bank above it
        if (!best || score > best.score) best = { a, x, z, score };
      }
      return { x: best.x, z: best.z, y: this.position.y, yaw: best.a + Math.PI, lookY: 1.4 };
    };
  }

  dispose() {
    this.rig?.parent?.remove(this.rig);
    this.particles?.dispose();
    this.tracks?.dispose();
    this.contactShadow?.dispose();
    this.phys?.dispose();
    this.env?.dispose();
    for (const m of Object.values(this.materials ?? {})) m.dispose?.();
  }
}
