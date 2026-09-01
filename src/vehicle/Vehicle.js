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
import { buildWheel, buildEnvMap, CHASSIS } from './model_kit.js';
import { pickCar, carById, CARS } from './vehicle_models.js';
import { VehiclePhysics } from './VehiclePhysics.js';
import { ParticleField, TrackRibbons, surfaceDust, KIND } from './VehicleFX.js';
import { VehicleShadow } from './VehicleShadow.js';
import { touchCapable } from '../core/verbs.js';
import { posthog } from '../posthog.js';

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

// ── swapping cars ────────────────────────────────────────────────────────────
// How far above its resting height a newly chosen car is dropped from. High
// enough that the suspension visibly takes the hit and rebounds — at 0.4 m the
// springs barely moved and the swap read as a teleport — and low enough that
// the landing cannot bottom out the travel or bounce a wheel off the ground.
const DROP_HEIGHT = 0.95;

/** Free every geometry under a model. Materials are owned by the car, not this. */
function disposeTree(root) {
  root?.traverse?.((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
}
// Debug warp only: how far inside the world edge a click is allowed to land.
// The physics patch is built *around* the arrival point, so a landing on the
// very edge stands on a patch that is half off the map.
const WARP_MARGIN = 24;
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
    this._dropping = false;    // a car swap is in the air; see `setCar`
    this._invQuat = new THREE.Quaternion();
    this._rescueCool = 0;
    this._rescueOffered = false;   // touch only: is the rescue toast up? see `update`
    this._rescueHold = false;
    this._brakeHold = false;
    this.brakeHold = false;      // what the HUD lamp reads
    // Who owns the driving inputs. null = the camper; 'boat' while the player
    // is paddling, 'bike' while they are riding. While held, the pedals and
    // steering are fed to the physics
    // as zeros and the brake hold cannot release — the camper stays parked
    // exactly as it was. Deliberately NOT input.suppressed (the holder needs
    // those same axes) and NOT enabled=false (Camp's gate reads this system).
    // The holder must clear it unconditionally on exit and in its dispose.
    this.controlsHeldBy = null;
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
    // Kept because it is the one place in the world the game has already
    // proved a camper can stand: the rescue search falls back to it when
    // everything else has been refused. See `_rescueLandmark`.
    this._home = { x: start.x, z: start.z };

    // ── materials + model ───────────────────────────────────────────────────
    // Which car, and therefore which DIM everything downstream measures itself
    // against. `?car=<id>` pins it; otherwise it is random per page load. See
    // vehicle_models.js for the table and for how to add the next one.
    this.car = pickCar();
    const DIM = this.car.dims;
    this.dims = DIM;
    this._lift = (DIM.wheelR ?? CHASSIS.wheelR) - CHASSIS.wheelR;
    this._poke = DIM.wheelOut ?? 0;
    this.env = buildEnvMap(renderer);
    this.materials = this.car.materials(this.env);
    const built = this.car.build(this.materials, this.car.seed);
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
      const spin = buildWheel(this.materials, this.car.wheel ?? {});
      hub.add(spin);
      this.rig.add(hub);                      // NB: not under `pivot` — wheels
      this.wheelNodes.push({ hub, spin });     // must not inherit body lean
    }

    // ── headlights ──────────────────────────────────────────────────────────
    this.headlights = [];
    for (const s of [-1, 1]) {
      const l = new THREE.SpotLight(0xfff0d2, 0, 68, 0.52, 0.55, 1.4);
      l.castShadow = false;
      // The lamp anchor is the model's, not a constant: the Roamer's round
      // headlights sit higher and wider than the camper's buckets, and a beam
      // that starts inside the bodywork lights the bonnet.
      l.position.set(s * DIM.lampX, DIM.lampY, DIM.front - 0.02);
      l.target.position.set(s * (DIM.lampX - 0.05), -1.1, DIM.front + 20);
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
    this.contactShadow = new VehicleShadow(scene, world, DIM);

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
    window.__setCar = (id) => this.setCar(id);
    window.__carId = () => this.car.id;
    window.__vehicleTune = (o) => this.phys.tune(o);
    // Test surface for tools/_scratch/rescuetest.mjs. `force` skips only the
    // cooldown, never a validity check.
    window.__vehicleRescue = (force = false) => {
      if (force) this._rescueCool = 0;
      return this.rescue();
    };
  }

  /** Warm post-target variants even if the parked model begins off camera. */
  precompileMaterials() {
    const { renderer, camera, scene } = this.ctx;
    // Do not compile `rig` as a child scene: it contains the two headlights,
    // and WebGLRenderer would gather those in addition to the same lights from
    // target `scene`, producing a four-spotlight key gameplay never uses.
    renderer.compile(this.root, camera, scene);
    for (const { spin } of this.wheelNodes) {
      renderer.compile(spin, camera, scene);
    }
  }

  // ── swapping cars ─────────────────────────────────────────────────────────
  /**
   * Change which vehicle the player is driving, live.
   *
   * The old model is torn down and the new one is dropped in from DROP_HEIGHT
   * above where it would have rested, so it lands on its own suspension and
   * bounces. Nothing about the bounce is animated: `phys.teleport` places the
   * body high, the wheels start outside their suspension rays, and the springs
   * catch it on the way down. See the note over `teleport`.
   *
   * Everything that measured itself against the old car has to be re-pointed in
   * the same breath — the contact shadow's lobes, the headlight anchors, the
   * exhaust tap. Those are the three places a DIM leaks out of the model, and
   * each of them reads `this.dims` or is reset here.
   */
  setCar(id) {
    const car = carById(id);
    if (!car) {
      console.warn(`[vehicle] no car with id "${id}" — known: ${CARS.map((c) => c.id).join(', ')}`);
      return false;
    }
    if (car === this.car || !this.phys?.ready) return false;

    // Old model out. Geometry is per-build and never shared, so it is ours to
    // free; the material set is per-car and goes with it.
    this.pivot.remove(this.root);
    disposeTree(this.root);
    for (const n of this.wheelNodes) { n.hub.remove(n.spin); disposeTree(n.spin); }
    for (const m of Object.values(this.materials ?? {})) m.dispose?.();

    this.car = car;
    this.dims = car.dims;
    this._lift = (car.dims.wheelR ?? CHASSIS.wheelR) - CHASSIS.wheelR;
    this._poke = car.dims.wheelOut ?? 0;
    this.materials = car.materials(this.env);
    const built = car.build(this.materials, car.seed);
    this.root = built.root;
    this.antenna = built.antenna;
    this.steeringWheel = built.steeringWheel;
    this.pivot.add(this.root);
    for (const n of this.wheelNodes) {
      n.spin = buildWheel(this.materials, this.car.wheel ?? {});
      n.hub.add(n.spin);
    }
    // The wheels were mid-rotation under the old model; the new hubs start at
    // zero, and _syncTransform will put them back where the physics says.
    this.contactShadow?.setDims(this.dims);
    for (let i = 0; i < this.headlights.length; i++) {
      const sx = i === 0 ? -1 : 1;
      this.headlights[i].position.set(sx * this.dims.lampX, this.dims.lampY, this.dims.front - 0.02);
      this.headlights[i].target.position.set(sx * (this.dims.lampX - 0.05), -1.1, this.dims.front + 20);
    }

    // And in it comes. Heading is kept: you are pointed where you were pointed.
    this.phys.teleport(this.position.x, this.position.z, this.heading, DROP_HEIGHT);
    // The settle term is a *downward* correction toward the rendered ground and
    // it is stale the moment the body is lifted — left alone it sinks the car
    // into the meadow for the whole fall.
    this._settle = 0;
    this._dropping = true;
    this._syncTransform();
    return true;
  }

  update(dt) {
    if (!this.phys?.ready) return;
    const { ctx } = this;
    const input = ctx.input;
    const ax = input.axes;
    // Another system (the boat or the bike) holds the controls: every axis
    // reads as zero to the camper, and R belongs to the holder's context too.
    // See the note on `controlsHeldBy` in the constructor.
    const held = this.controlsHeldBy != null;

    // ── camera cycling / input ──────────────────────────────────────────────
    this.throttle = held ? 0 : ax.throttle;
    this.steer = held ? 0 : ax.steer;

    // ── rescue ──────────────────────────────────────────────────────────────
    // `justPressed` is cleared by Input every frame and zeroed entirely while a
    // menu has focus, so this cannot fire from the settings sheet or fire twice
    // from one press.
    this._rescueCool = Math.max(0, this._rescueCool - dt);
    if (!held && input.justPressed('KeyR')) this.rescue();
    // Only after the player has genuinely been fighting it for a couple of
    // seconds: an offer you only need when stuck is no use if it arrives before
    // you are. `_stuckFor` is the physics' own measure — full throttle or full
    // brake, going nowhere, on the ground.
    //
    // The two devices get genuinely different behaviour here, and it is not
    // just wording. With a keyboard the toast TEACHES a key, so it says it once
    // per session and goes; you know R from then on. On touch the toast IS the
    // rescue — there is no key to learn — so it has to come back every time the
    // camper is stuck, and it has to stay up while the offer stands instead of
    // timing out under a player who is still rocking the throttle. Hence
    // sticky, and hence taking it down again the moment they drive out of it
    // under their own power.
    const stuck = this.phys._stuckFor > 2.4;
    if (touchCapable()) {
      if (stuck !== this._rescueOffered) {
        this._rescueOffered = stuck;
        const hud = ctx.systems.hud;
        if (stuck) hud?.toast?.('Touch to rescue', { action: () => this.rescue(), sticky: true });
        else hud?.hideToast?.();
      }
    } else if (!this._toldAboutRescue && stuck) {
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
    const driving = !held && (ax.throttle > HOLD_PEDAL || ax.brake > HOLD_PEDAL);
    if (driving) this._brakeHold = false;
    else if (!held && ax.handbrake > 0.5 && this._holdEligible()) this._brakeHold = true;
    // On touch there is no handbrake to press: the whole screen is the stick
    // (see ui/TouchControls.js) and letting go of it IS the park brake. So the
    // hold arms on release rather than on a button.
    //
    // This is the auto-hold the camper already had, not a new behaviour —
    // `_holdEligible` still refuses above 8.5 km/h and with wheels off the
    // ground, so releasing at speed coasts exactly as it did and only the last
    // walking-pace metre latches. It matters more than a convenience: camps and
    // boats can only be started from a parked camper, so "stop and let go" is
    // what opens the rest of the game on a phone.
    else if (!held && touchCapable() && this._holdEligible()) this._brakeHold = true;

    // A rescue leaves the park brake on. Any deliberate input releases it —
    // the player has taken over and the camper should behave normally from
    // that instant, with no "press again to release" ceremony. Steering counts
    // here, unlike the brake hold above, because a rescue was not something the
    // player chose and any sign of life should hand the camper back.
    if (driving || (!held && Math.abs(ax.steer) > 0.05)) this._rescueHold = false;

    this.phys.step(dt, {
      throttle: held ? 0 : ax.throttle,
      brake: held ? 0 : ax.brake,
      steer: held ? 0 : ax.steer,
      handbrake: held ? 0 : ax.handbrake,
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
   * at all — a lakeside, a gorge, a pocket walled in by boulders — the search
   * steps outward, and keeps stepping, and if the whole neighbourhood is a
   * trap it falls back to the road the camper spawned on. It does not decline.
   * That is the contract: a player who is stuck has no move left except
   * reloading the page, so the button has to work every time it is pressed,
   * even when working means moving them further than they would have liked.
   * See `_rescueSite` for the four passes that guarantee it.
   *
   * @returns {{x:number,z:number,range:number,relaxed:boolean}|null}
   */
  rescue() {
    if (!this.phys?.ready || this._rescueCool > 0) return null;

    const site = this._rescueSite();
    if (!site) {
      // Defensive only. `_rescueSite` runs out of options when there is no
      // world to search — no landmarks, no spawn — which is a capture harness
      // booting without a POI table, not a player in a gorge.
      this.ctx.systems.hud?.toast?.('Nowhere clear to move to — try again');
      // Still take the cooldown: a failed press must not let the search run
      // every frame while the key is held down.
      this._rescueCool = RESCUE_COOLDOWN;
      return null;
    }
    const moved = Math.hypot(site.x - this.position.x, site.z - this.position.z);

    // Heading is preserved rather than randomised. The *place* is random
    // because the player asked for that; spinning them as well would make an
    // already-disorienting jump worse, and the site checks have already
    // guaranteed there is nothing to be pointed into.
    this._land(site.x, site.z, this.heading);
    this._rescueCool = RESCUE_COOLDOWN;
    this.rescues++;
    // A 20 m hop needs no explanation; a 300 m one does, or the player reads
    // the jump as the game having lost them. The distance is the honest thing
    // to say — it is the cost of having been somewhere with no way out.
    this.ctx.systems.hud?.toast?.(
      site.landmark ? 'Moved you back to the road'
        : moved > 60 ? `Moved you ${Math.round(moved)} m to clear ground`
          : site.relaxed ? 'Moved you clear' : 'Moved you to open ground');
    posthog.capture('vehicle_rescued', {
      distance_moved_m: Math.round(moved),
      rescue_count: this.rescues,
      used_landmark: !!site.landmark,
      relaxed: !!site.relaxed,
    });
    return site;
  }

  /**
   * Put the camper down at a point that has already been chosen, and clear
   * everything on this side that belonged to where it came from.
   *
   * Shared by the rescue and by the debug warp, which differ only in how the
   * destination was arrived at: once a place has been picked, landing on it is
   * the same act either way, and the list of state that has to be cut is long
   * enough that keeping two copies of it is how one of them goes stale.
   */
  _land(x, z, heading) {
    this.phys.teleport(x, z, heading);
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
    this.teleportSeq++;
  }

  /**
   * Debug: drop the camper on an arbitrary point, no questions asked.
   *
   * Deliberately *not* `rescue()` with a destination. The rescue's whole job is
   * to find somewhere the camper can stand — dry, flat, clear — and moving the
   * player somewhere they did not point at is the correct answer to being
   * stuck. This is the opposite request: someone clicking a lake on the minimap
   * to see what the lake looks like is asking to be put in the lake, and
   * quietly nudging them onto the nearest beach would make the tool useless for
   * the thing it exists for. The only thing enforced is the world boundary,
   * because outside it there is no terrain patch to stand on at all.
   *
   * ── warping out of a boat, or off a bike ────────────────────────────────
   * The warp moves the CAMPER. Aboard a boat the player is not in the camper,
   * so without the giveback below they stayed sitting in a kayak on the far
   * side of the map, steering it, with the camper they had just "warped"
   * parked two kilometres away and no way back to it but paddling. Whatever
   * the warp is for, it is not that: it exists so a click on the map puts you
   * where you clicked, and "you" is the player, not the chassis.
   *
   * Why here and not in `HUD._warp`, the only player-facing caller: `warpTo`
   * is the entry point, and it already has other callers — half a dozen
   * scratch harnesses in `tools/_scratch/` drive it directly, and every one of
   * them would reproduce the bug on its own. A giveback that lives in the HUD
   * is a giveback the next caller forgets. Vehicle reaching sideways into
   * `ctx.systems` is not new here either — `rescue()` toasts through
   * `ctx.systems.hud` from three lines away — and this reaches for one
   * optional-chained public method, no import, no hard dependency.
   *
   * Why not in `_land`, which would cover `rescue()` too: `_land` is the
   * primitive "put the camper on this point", and `Boat._comeAshore` calls it
   * *itself* on its way out of the water. Dismounting is policy, and policy in
   * the primitive would mean the boat exiting from inside a call the boat made.
   * Rescue does not need it: `update()` gates R on `!held`, so the rescue key
   * is inert while the boat holds the controls.
   *
   * ── ordering: land, THEN exit; and both in the same synchronous step ─────
   * `_land` bumps `teleportSeq`; `Boat.exit()` hands the camera back with
   * `rig.takeCamera(null)`. In `CameraRig.lateUpdate` the takeover branch
   * returns ABOVE the `teleportSeq` check, so while the player is aboard the
   * rig cannot see a teleport at all — the giveback is what lets it see this
   * one, and it then re-primes the boom behind the camper at the warp point,
   * which is the cut we want. That is why these two calls must stay in one
   * step with no frame between them: exit the boat a frame late (or defer the
   * giveback) and the rig picks the camper up at its OLD position for a frame
   * first. Land first because everything past the `phys.ready` guard is a
   * committed warp — the boat should not be taken away by a warp that then
   * declines — and because `Boat._comeAshore` already sequences the same two
   * acts the same way.
   *
   * The boat is left moored where it was, not sunk: that is what `exit()` is
   * for, boats persist and re-board, and `MAX_BOATS` recycles the oldest, so
   * an abandoned hull costs the player nothing but a walk they were never
   * going to take. The caller gets its kind back so it can say so.
   *
   * ── and the same for the bike ───────────────────────────────────────────
   * Word for word the same argument and the same two calls, against
   * `Bike.dismount()`. Only two things differ, and neither changes the code:
   * the bike is left standing rather than moored, and it costs the player even
   * less to abandon, because the next full camp brings the bike along (see
   * `Bike.park`). At most one of the two can be active — both are gated on
   * `controlsHeldBy` — so the pair below can never both fire.
   *
   * @returns {{x:number,z:number,leftBoat:string|null,leftBike:boolean}|null}
   *          where it landed, and what (if anything) was stepped off on the way.
   */
  warpTo(x, z) {
    if (!this.phys?.ready) return null;
    const half = this.ctx.world.worldSize / 2 - WARP_MARGIN;
    const wx = Math.max(-half, Math.min(half, x));
    const wz = Math.max(-half, Math.min(half, z));
    const boat = this.ctx.systems?.boat;
    const bike = this.ctx.systems?.bike;
    // Read these BEFORE the exit: `Boat.current` is republished as null the
    // next time its update runs with nobody aboard, and `Bike.active` likewise.
    const leftBoat = boat?.active ? (boat.current?.kind ?? 'boat') : null;
    const leftBike = !!bike?.active;
    this._land(wx, wz, this.heading);
    if (leftBoat) boat.exit();
    if (leftBike) bike.dismount();
    return { x: wx, z: wz, leftBoat, leftBike };
  }

  /**
   * Find somewhere to put the camper down, and do not come back empty-handed.
   *
   * Four passes, in order of how much they cost the player, and the first one
   * that answers wins:
   *
   *   1. the near rings (20/30/42 m) — a short hop, which is what the button
   *      promises. An ideal site wins outright; failing that the best merely
   *      acceptable one across all three;
   *   2. the wide rings (60 m … 340 m) — the same standards, further away,
   *      for the gorge and the boulder pocket where the near rings are all
   *      cliff face. A long hop is a bad rescue; a declined one is not a
   *      rescue at all;
   *   3. the last-resort tier on the nearest ring that had anything at all —
   *      tighter clearance, a step across the footprint, steeper ground;
   *   4. and if the terrain has somehow beaten all of that, a landmark: the
   *      road the camper spawned on, which the game has already proved is
   *      somewhere a camper can stand.
   *
   * Pass 4 is why this returns null only when there is no world to search, and
   * why `rescue()`'s decline path is now a defensive branch rather than an
   * outcome a player can reach.
   */
  _rescueSite() {
    const near = this._rescueWalk(RESCUE_RINGS);
    if (near.site) return near.site;
    const wide = this._rescueWalk(RESCUE_WIDE);
    if (wide.site) return wide.site;
    // Nearest ring that produced anything at all, near rings before wide.
    const last = near.last ?? wide.last;
    if (last) return { ...last, relaxed: true, lastResort: true };
    return this._rescueLandmark();
  }

  /**
   * Sample bearings on each ring of one group in turn.
   *
   * Returns both the site chosen (ideal on the closest ring that has one,
   * otherwise the best acceptable one anywhere in the group) and, separately,
   * the best last-resort candidate on the closest ring that had one — the
   * caller only reaches for that once every group has come back empty.
   */
  _rescueWalk(rings) {
    const px = this.position.x, pz = this.position.z;
    let okBest = null, last = null;
    for (const range of rings) {
      // A random start angle plus an even stride covers the ring rather than
      // clumping, which independent draws do. Still random, still one line.
      const tries = clamp(Math.round((2 * Math.PI * range) / RESCUE_ARC),
        RESCUE_TRIES, RESCUE_TRIES_MAX);
      const a0 = Math.random() * Math.PI * 2;
      let best = null, ringLast = null;
      for (let i = 0; i < tries; i++) {
        const a = a0 + (i / tries) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
        const x = px + Math.sin(a) * range;
        const z = pz + Math.cos(a) * range;
        const s = this._siteScore(x, z);
        if (!s) continue;
        const site = { x, z, range, ...s };
        if (s.tier <= 2 && (!ringLast || s.score > ringLast.score)) ringLast = site;
        if (s.tier <= 1 && (!okBest || s.score > okBest.score)) okBest = site;
        if (s.tier === 0 && (!best || s.score > best.score)) best = site;
      }
      if (!last && ringLast) last = ringLast;
      // Good enough on this ring: stop here rather than reaching further out.
      if (best) return { site: { ...best, relaxed: false }, last };
    }
    return { site: okBest ? { ...okBest, relaxed: true } : null, last };
  }

  /**
   * The floor under the whole search: a place the game itself has vouched for.
   *
   * `init` picks the camper's spawn from the road landmarks and checks it is
   * flat, dry and in bounds before the world is ever handed to the player, so
   * that point is a standing proof that somewhere parkable exists. The road
   * and meadow landmarks around it are the same kind of ground. Nearest first,
   * because this is already a long way to be moved.
   *
   * The very last line returns the spawn *unchecked*. That is deliberate: at
   * that point every scored site in the world has been refused, and putting
   * the camper back where it started beats leaving the player wedged in a
   * gorge with a button that shrugs.
   */
  _rescueLandmark() {
    const px = this.position.x, pz = this.position.z;
    const poi = this.ctx.poi;
    const seen = new Set(), cands = [];
    for (const kind of ['road', 'meadow']) {
      for (let i = 0; i < 16; i++) {
        const p = poi?.best?.(kind, i);
        // `best` clamps its index, so walking past the end repeats the last.
        if (!p) break;
        const key = `${p.x.toFixed(1)},${p.z.toFixed(1)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cands.push(p);
      }
    }
    if (this._home) cands.push(this._home);
    cands.sort((a, b) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(b.x - px, b.z - pz));
    for (const p of cands) {
      const s = this._siteScore(p.x, p.z);
      if (!s) continue;
      return { x: p.x, z: p.z, range: Math.hypot(p.x - px, p.z - pz),
        ...s, relaxed: true, landmark: true };
    }
    if (!this._home) return null;
    const { x, z } = this._home;
    return { x, z, range: Math.hypot(x - px, z - pz), score: 0, tier: 2,
      ideal: false, slope: 0, mean: 0, step: 0, gap: Infinity, open: 4,
      relaxed: true, landmark: true };
  }

  /**
   * Grade one candidate landing, or return null if it is not a landing at all.
   *
   * Bounds and water are absolute — no tier of desperation puts the camper in
   * the lake or off the edge of the world. Everything else is graded into a
   * tier: 0 is somewhere you would choose to stop, 1 is somewhere that holds,
   * 2 is somewhere you can drive carefully away from and is only ever used
   * when the first two came back empty across every ring.
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
    // Hard, and in this order because each is cheaper than the next. Above
    // RESCUE_SLOPE_LAST the camper slides back down whatever tier asked for
    // it, and a rescue that does that has achieved nothing. A ledge inside the
    // footprint is the same failure wearing a different hat.
    if (worst > RESCUE_SLOPE_LAST) return null;
    if (step > RESCUE_STEP_LAST) return null;
    // Only now is the obstacle query worth paying for.
    const gap = Math.min(this._treeGap(x, z), this._rockGap(x, z));
    if (gap < RESCUE_CLEAR_LAST) return null;

    // Is there anywhere to go *from* here? Four probes at RESCUE_OPEN metres.
    // A shelf in a gorge passes every test above and is still a trap; what
    // separates it from a verge is that the verge has drivable ground leading
    // off it. Cheap terrain reads only — no obstacle query out here, because a
    // tree in the way is something the player can steer around.
    let open = 0;
    for (let k = 0; k < 4; k++) {
      const b = (k / 4) * Math.PI * 2 + Math.PI / 8;
      const ox = x + Math.sin(b) * RESCUE_OPEN;
      const oz = z + Math.cos(b) * RESCUE_OPEN;
      if (!W.isInBounds(ox, oz)) continue;
      if (W.getWaterDepth(ox, oz) > RESCUE_WATER) continue;
      if (W.getSlope(ox, oz) > RESCUE_SLOPE_OK) continue;
      open++;
    }

    // Flatter, roomier and more open is better; the terms are on comparable
    // scales here so a plain weighted sum is enough and needs no tuning.
    const score = -mean * 2 - worst * 2 - step * 0.8 + Math.min(gap, 8) * 0.3
      + open * 0.5;
    const tier = (worst <= RESCUE_SLOPE && step <= RESCUE_STEP
        && gap >= RESCUE_CLEAR && open >= RESCUE_OPEN_MIN) ? 0
      : (worst <= RESCUE_SLOPE_OK && step <= RESCUE_STEP
        && gap >= RESCUE_CLEAR && open >= 1) ? 1 : 2;
    return { score, tier, ideal: tier === 0, slope: worst, mean, step, gap, open };
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
   *
   * `rocksAround` rather than the streamed cell map, because the search now
   * asks about ground far outside the streaming radius and an unloaded cell
   * would otherwise read as empty ground — which is a landing inside a boulder
   * that appears a second later.
   */
  _rockGap(x, z) {
    const rocks = this.ctx.systems.rocks;
    if (!rocks?.rocksAround) return Infinity;
    const list = rocks.rocksAround(x, z, 12, 0.8, this._rockScratch ??= []);
    let best = Infinity;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const d = Math.hypot(r.x - x, r.z - z)
        - Math.max(r.sx ?? r.size, r.sz ?? r.size);
      if (d < best) best = d;
    }
    list.length = 0;
    return best;
  }

  // ── transform ─────────────────────────────────────────────────────────────
  _syncTransform() {
    const t = this.phys.body.translation();
    const r = this.phys.body.rotation();
    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
    this._invQuat.copy(this.quaternion).invert();
    this.rig.quaternion.copy(this.quaternion);
    this.forward.copy(this.phys._fwd);
    this.right.copy(this.phys._right);
    this.up.copy(this.phys._up);
    // Suspension lift for a car drawn on tyres bigger than the physics radius.
    // The rig carries the body AND the hubs, so lifting it puts the bottom of
    // the larger tyre back exactly on the contact patch and raises the body
    // over it — which is what a lift kit does. Along the body's up axis, not
    // world Y, so it stays glued when the vehicle is on its side on a bank.
    // See buildWheel's header for what this costs.
    this.rig.position.copy(this.position);
    if (this._lift) this.rig.position.addScaledVector(this.up, this._lift);
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
      // Visual track widening. Physics keeps VEHICLE.trackWidth; this pushes
      // the drawn wheel outboard of its suspension ray so the tyre stands proud
      // of the flare, which is most of what a wheel-and-tyre package looks like
      // from outside. Nothing reads the hub node back, so it is free.
      if (this._poke) this._tmp.x += Math.sign(this._tmp.x) * this._poke;
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

    // A car dropped in by the settings sheet lands silently otherwise, and a
    // silent landing reads as a pop-in rather than an arrival. One puff per
    // wheel, in whatever the ground under that wheel is made of.
    if (this._dropping && this.wheels.some((w) => w.grounded)) {
      this._dropping = false;
      for (const w of this.wheels) {
        if (!w.grounded || !Number.isFinite(w.contact.x)) continue;
        const weights = world.getSurfaceWeights(w.contact.x, w.contact.z, this._w);
        for (let k = 0; k < 7; k++) {
          surfaceDust(weights, c).multiplyScalar((0.85 + Math.random() * 0.3) * 0.62);
          const a = Math.random() * Math.PI * 2, r = 0.6 + Math.random() * 1.4;
          P.spawn(
            w.contact.x + (Math.random() - 0.5) * 0.4,
            w.contact.y + 0.05 + Math.random() * 0.15,
            w.contact.z + (Math.random() - 0.5) * 0.4,
            Math.cos(a) * r, 0.5 + Math.random() * 0.9, Math.sin(a) * r,
            0.8 + Math.random() * 0.8, 0.30 + Math.random() * 0.4, KIND.DUST, c,
          );
        }
      }
    }

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.grounded) continue;
      const cx = w.contact.x, cy = w.contact.y, cz = w.contact.z;
      if (!Number.isFinite(cx)) continue;

      const depth = world.getWaterContactDepth?.(cx, cz) ?? world.getWaterDepth(cx, cz);
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
      this._tmp.set(0.46, this.dims.floor - 0.06, this.dims.rear - 0.05).applyQuaternion(this.quaternion).add(this.position);
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

    // ── daylight ceiling ─────────────────────────────────────────────────
    //
    // `k` says the lamps are on. It does not say how much light the valley
    // already has, and between about 17:00 and 18:30 the two disagree: the
    // mix is most of the way up while the sun is still above the skyline and
    // the meadow is sitting at golden-hour exposure. A spot cut for a dark
    // valley then lands on ground already near the top of the range and clips
    // it to white. It is the park-brake hotspot again, only with the camper
    // moving, where the dip cannot help.
    //
    // So scale the beam by how much skylight is left: full 190 only once the
    // sun is properly under the horizon, which is where that number was
    // measured in the first place. Through the crossover the lamps read as
    // lamps throwing a pool rather than as a floodlight bleaching the grass.
    const beamCeil = lerp(1, 0.45, smoothstep(-0.06, 0.10, sunY));

    this._parkDip = damp(this._parkDip, this.brakeHold ? 1 : 0, 1.5, dt);
    const beam = k * beamCeil * lerp(1, 0.06, this._parkDip);
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
