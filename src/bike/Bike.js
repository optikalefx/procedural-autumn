// ─────────────────────────────────────────────────────────────────────────────
//  Bike — the mountain bike that comes off the camper when you make camp, and
//  the ride you get on it.
//
//  The player's loop: pitch a FULL camp, and a bike is leaning on its kickstand
//  at the edge of it. Click the bike to get on (camera swings to three-quarters
//  back, W/S pedal and brake, A/D steer — the same axes the camper reads, so
//  the touch controls work unchanged), ride it anywhere the ground will take a
//  wheel, click the camper to drive again, or press E to leave the bike where
//  it stands and have the camper brought round.
//
//  ── how it sits in the frame ────────────────────────────────────────────────
//  Registered between Boat and Camp (see SYSTEMS in main.js): it reads
//  `vehicle.brakeHold` the frame it is written, and publishes `pointerClaim`
//  BEFORE Camp runs, so Camp's click arbitration guard reads a same-frame
//  claim — one click can never mount a bike AND pitch a camp.
//
//  Controls ownership: mounting sets `vehicle.controlsHeldBy = 'bike'`, which
//  Vehicle honours by feeding its physics zeros. Cleared UNCONDITIONALLY on
//  dismount and in dispose — photo mode's discipline.
//
//  Camera: `RideCamera`, shared with the kayak. This file supplies only
//  `_mount` — where the eye sits on a bicycle — and the rest (wheel zoom, the
//  head turn, the damping, and the photo-mode hand-off in both directions) is
//  `core/ride_camera.js`, which was extracted from `Boat` when this arrived.
//
//  ── there is exactly one bike, and the camper carries it ────────────────────
//
//  Not a cap-and-recycle like the boats. The honest reading of a bike in a game
//  about a camper is that it travels on the back of the camper and comes off
//  when you stop — so making camp puts THE bike beside that camp, and making
//  camp somewhere else brings it along. There is never a second one to keep
//  track of, and a bike left forty minutes' ride away is not lost, because the
//  next camp has it again.
//
//  The one exception is a bike being ridden: making camp while you are on it
//  cannot take it out from under you, so the new camp simply does not get one.
//  See `park`.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { clamp01, damp, lerp, smoothstep } from '../core/MathUtils.js';
import { ClickTracker, pointerRay, rayMiss, objectHit, pointing } from '../core/Pointer.js';
import { pickVerb, actVerb, touchCapable } from '../core/verbs.js';
import { CampPrompt } from '../camp/camp_ui.js';
import { siteRng } from '../camp/camp_site.js';
import { RideCamera } from '../core/ride_camera.js';
import { SkyProbe } from '../render/SkyProbe.js';
import { buildBike, BIKE_DIM, BIKE_COLORWAYS } from './bike_model.js';
import { BikePhysics } from './bike_physics.js';
import { setBikeEnv, disposeBikeMaterials, bikeMaterials } from './bike_materials.js';

// How long the bike takes to appear when a camp is pitched, and how long the
// camera glances at it (only when nothing else holds focus — see lateUpdate).
const SPAWN_TIME = 0.7;
const PARK_FOCUS = 1.8;

// ── the parked pose ──────────────────────────────────────────────────────────
// A bike on its side stand leans onto it. 0.22 rad is 12.6°, measured off the
// stand geometry in `bike_model` (a 150 mm splay on a 290 mm leg), and it is
// what makes a parked bike read as PARKED rather than as a bike that happens to
// be standing up on its own in a meadow.
const STAND_LEAN = 0.22;
// How far the stand swings when somebody gets on, about the bike's LATERAL
// axis — backward and up, tucked along the chainstay, which is where a side
// stand goes. 1.35 rad lands the foot level with the hinge and 0.24 m behind
// it, which is the rear axle. See the note in `bike_model`'s header on why
// this is not a roll.
const STAND_FOLD = 1.35;
const FOLD_RATE = 7.0;

// ── the ride camera ──────────────────────────────────────────────────────────
//
// "Camera set ¾ back on the bike" (user direction, 2026-09-01). Three quarters
// of the bike's length behind the origin puts the eye just behind and above the
// saddle: the whole bike is in the lower third of the frame, the bars and the
// front wheel are visible steering under you, and the trail ahead has the top
// two thirds. That is the framing this feature is for — the kayak's argument
// for putting the eye ON the boat was that there is no paddler to look at, and
// a bicycle is the opposite case: the object itself is worth seeing move.
const CAM_AFT = 0.75;              // fraction of BIKE_DIM.length behind centre
const CAM_UP = 1.34;               // m above the ground under the mount
const CAM_LOOK_UP = 0.80;          // m — where over the trail the eye is aimed
const CAM_LOOK_AHEAD = 1.6;        // × length, ahead OF THE BIKE, not of the eye
const CAM_CLEAR = 0.85;            // m the eye is kept above the ground behind
// …and above the WATER, which is a different floor. Both the mount height and
// CAM_CLEAR are measured from the ground, and in a river the ground is the
// riverbed — so a bike fording 3 m of water puts the eye 1.7 m UNDER the
// surface and the whole frame goes blue. Water is drag and not a wall now
// (bike_physics, WADE_REF), so deep crossings are something the player will
// actually do, and the camera has to survive them.
const CAM_WATER_CLEAR = 0.55;      // m the eye is kept above the water surface
// How the mount rises as the wheel pulls it back. Mostly it does NOT: the first
// version ran 0.62 + 0.38·zoom, so zooming out craned the camera upward as fast
// as it moved it back and the wide shot became a plan view of a bicycle. A
// zoom-out should become a chase, so the height barely moves and the distance
// carries it.
const CAM_RISE = 0.20;
// Zoom about the mount: in toward an over-the-shoulder shot, out to a wide
// chase that still never becomes a drone.
const CAM_ZOOM_MIN = 0.62;
const CAM_ZOOM_MAX = 2.40;
// A bike leans, and a camera that does not lean with it reads as a camera on a
// tripod watching a bike. Only a THIRD of the lean, though: matching it fully
// makes the horizon the only thing moving and is instantly sickening.
const CAM_BANK = 0.34;
// Under way, for the head-turn recentre. A bike is stopped below 0.8 m/s and
// properly moving by 4; the kayak's 0.6/1.8 would recentre while walking it.
const LOOK_MOVE_LO = 0.8;
const LOOK_MOVE_SPAN = 3.2;
const LOOK_RECENTER_DELAY = 1.6;   // shorter than the boat's: you are going
                                   // somewhere, not sightseeing

// ── the headlamp ─────────────────────────────────────────────────────────────
//
// A bicycle light, not a car's. `Vehicle._lights` runs two 190-intensity spots
// reaching 68 m; this is one spot at a tenth of that, reaching 26 m, because
// the thing a bar light actually does is put a pool on the trail six to ten
// metres ahead and leave the valley dark. Getting that wrong in the other
// direction would be worse than having no light at all — the camp brief's
// hardest rule is that after sundown nothing may out-value the fire, and the
// camper's own beam has already cost this project two rounds of chasing a
// blown-out meadow it turned out to have caused.
const LAMP_COLOR = 0xf6f2e6;       // an LED, cooler than the camper's halogens
const LAMP_RANGE = 26;             // m
const LAMP_ANGLE = 0.34;           // rad — tighter than a car's 0.52
const LAMP_PENUMBRA = 0.50;
const LAMP_DECAY = 1.4;            // matched to the camper's, so falloff reads alike
// Intensity at full night. Swept on seed 20261018 at hour 22 from the ride
// camera. 22 — a naive tenth of the camper's 190 — put an eight-metre pool of
// near-white across the meadow: the blown-out-ground defect this file's header
// warns about, reproduced on the first try. 8 puts a soft pool six to ten
// metres ahead that lights the trail and leaves the stars, the ridgeline and a
// tent four hundred metres away all still readable, which is the frame this
// game is for.
const LAMP_PEAK = 8;
// Where the beam is aimed, in the lamp mount's own frame (+Z forward). Down and
// out: a bar light aimed at the horizon lights nothing you are about to ride
// over. 10 m rather than 14 — at 14 the hotspot lands beyond the cone's useful
// throw and the near ground, which is the ground you steer by, stays dark.
const LAMP_AIM = { x: 0, y: -0.95, z: 10 };
// The lens' emissive, off and on. The floor is not zero — a fitted lamp with a
// dead grey eye reads as broken, and it is also how you find the bike in the
// dark once you have left it somewhere.
const LENS_OFF = 0.05;
const LENS_ON = 3.2;
const LENS_PARKED = 0.55;

// How long the "drive the camper" hint sits over the bars after mounting.
const DRIVE_HINT_TIME = 6.0;

// Prewarm hold, matching Camp's and Boat's pattern.
const PREWARM_FRAMES = 8;

export class Bike extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Bike';
    this.loadLabel = 'Pumping the tyres';

    this.bike = null;          // { group, phys, spawnT, colorway, style } | null
    this.active = false;       // player is riding (published for HUD/audio)
    this.current = null;       // { x, z, heading, speed, group } | null
    this.pointerClaim = false;

    this._riding = false;
    this._script = null;       // harness drive() override
    this._focusT = 0;
    this._focusP = new THREE.Vector3();
    this._cursorNow = '';
    this._hintT = 0;
    this._standT = 0;          // 0 = down, 1 = folded up
    this._wasBlocked = false;  // for the one-shot bump cue
    this._preBlockSpeed = 0;
    this._nightMix = 0;        // 0 day, 1 night — damped, see _lamp
    this._ray = { o: new THREE.Vector3(), d: new THREE.Vector3() };
    this._v = new THREE.Vector3();
    this._e = new THREE.Euler();

    // The seat camera — shared with the kayak. See core/ride_camera.js.
    this.ride = new RideCamera(ctx, {
      mount: (z, yaw, pitch) => this._mount(z, yaw, pitch),
      speed: () => this.bike?.phys.made ?? 0,
      zoomMin: CAM_ZOOM_MIN, zoomMax: CAM_ZOOM_MAX,
      moveLo: LOOK_MOVE_LO, moveSpan: LOOK_MOVE_SPAN,
      recenterDelay: LOOK_RECENTER_DELAY,
    });
    this._mEye = { x: 0, y: 0, z: 0 };
    this._mLook = { x: 0, y: 0, z: 0 };
    this._mUp = new THREE.Vector3(0, 1, 0);
    this._mPose = { eye: this._mEye, look: this._mLook, up: this._mUp };
  }

  async init() {
    const { scene } = this.ctx;
    this.root = new THREE.Group();
    this.root.name = 'bike';
    scene.add(this.root);

    this.click = new ClickTracker(this.ctx.input);
    this.prompt = new CampPrompt();

    // ── the headlamp's SpotLight, created HERE and never removed ────────────
    //
    // Not when a bike is parked, which is when it is first needed. A light
    // appearing at runtime changes `NUM_SPOT_LIGHTS` and relinks every lit
    // material in the valley — `camp_fire.js` measured that as most of a second
    // of freeze on the frame the player clicks, and Camp's fire PointLight has
    // existed from boot ever since. Same rule, same reason.
    //
    // It lives in `this.root` at zero intensity from boot and is RE-PARENTED to
    // a bike's lamp mount when one is built (see `park`). Re-parenting inside
    // the same scene does not change the light count, so nothing relinks; the
    // one compile this costs happens in `_prewarm` below, under the loading
    // screen, and covers every material already in the scene.
    this.lamp = new THREE.SpotLight(LAMP_COLOR, 0, LAMP_RANGE, LAMP_ANGLE,
                                    LAMP_PENUMBRA, LAMP_DECAY);
    this.lamp.castShadow = false;      // a bike light casting shadows is a
                                       // shadow map nobody asked to pay for
    this.lamp.name = 'bike_lamp';
    this.lampTarget = new THREE.Object3D();
    this.lampTarget.position.set(LAMP_AIM.x, LAMP_AIM.y, LAMP_AIM.z);
    this.lamp.target = this.lampTarget;
    this.root.add(this.lamp);
    this.root.add(this.lampTarget);

    // The kit's shade fill — without it the rims, spokes and chain are black
    // cut-outs. See bike_materials' header. Before `_prewarm`, because envMap
    // is part of the program cache key and the prewarm is what links these
    // shaders under the loading screen.
    //
    // groundMix 0.55: a bike stands on dirt, so the bounce under it is most of
    // the way to the authored ground tint — unlike the boat, whose lower
    // hemisphere is water and takes dimmed sky.
    this._probe = new SkyProbe(this.ctx.renderer, { groundMix: 0.55, onBake: setBikeEnv });

    this._prewarm();

    // Harness surface — the visual-critic pipeline drives everything through
    // this. Nothing here runs on its own.
    window.__bike = this;
  }

  /** Link the bike's shaders under the loading screen, Camp-style: build one,
   *  harvest BEFORE compiling (Atmosphere/Stylize chain onBeforeCompile, which
   *  changes the program cache key), then hold it in the scene for a few real
   *  frames so the shadow pass compiles its depth variants too. */
  _prewarm() {
    const { scene, renderer, camera } = this.ctx;
    const t0 = performance.now();
    const warm = new THREE.Group();
    warm.name = 'bike_prewarm';
    warm.scale.setScalar(0.03);
    try {
      const rnd = siteRng(0, 0, 3);
      // Both builds: the suspension fork's lowers are the one part on a
      // `plastic` material that also carries a paint gradient, and a prewarm
      // that only saw the rigid fork would relink at the first camp.
      for (const style of ['trail', 'packer']) {
        const g = buildBike(rnd, { colorway: 0, style, susp: style === 'trail', rack: true });
        g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
        warm.add(g);
      }
      scene.add(warm);
      this.ctx.atmosphere?.harvest?.();
      this.ctx.stylize?.harvest?.();
      renderer.compile(scene, camera);
      this._warm = { group: warm, frames: 0 };
    } catch (e) {
      console.warn('[bike] prewarm failed; the first camp will hitch', e);
      warm.parent?.remove(warm);
    }
    console.log(`[bike] prewarm built in ${(performance.now() - t0).toFixed(0)} ms`);
  }

  _finishPrewarm() {
    const w = this._warm;
    const { camera } = this.ctx;
    // In front of the lens and buried — inside both the main and the shadow
    // frusta, invisible twice over. Same placement as Camp's and Boat's.
    const d = this._v.set(0, 0, -1).applyQuaternion(camera.quaternion);
    w.group.position.set(
      camera.position.x + d.x * 6,
      camera.position.y + d.y * 6 - 3.5,
      camera.position.z + d.z * 6,
    );
    if (++w.frames < PREWARM_FRAMES) return;
    this._warm = null;
    w.group.parent?.remove(w.group);
    // The geometry dies with the warm prop; the materials are the module-scope
    // set in bike_materials and must survive for the session — that is what the
    // prewarm cached.
    w.group.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
  }

  // ── frame ─────────────────────────────────────────────────────────────────

  update(dt, t) {
    if (this._warm) this._finishPrewarm();
    this.click.poll(dt);

    // Keep the shade fill on the same clock as the sky. Skipped entirely unless
    // the hour has actually moved, so a parked clock costs one subtraction.
    if (this.bike) this._probe?.update();
    this._lamp(dt);

    const veh = this.ctx.systems?.vehicle;
    const rig = this.ctx.systems?.cameraRig;
    const b = this.bike;

    if (b) {
      if (b.spawnT < 1) b.spawnT = Math.min(1, b.spawnT + dt / SPAWN_TIME);
      // The stand folds up the moment somebody is on it, and drops as they get
      // off. Damped rather than snapped: it is a 0.2 s move on a real bike and
      // an instant one reads as a glitch.
      this._standT = damp(this._standT, this._riding ? 1 : 0, FOLD_RATE, dt);
      const wasMoving = b.phys.made;
      if (this._riding) this._pedal(dt, t, veh, rig);
      else b.phys.step(dt, t, { parked: true });
      this._pose(b);
      // Running into something is an EVENT and the physics only publishes the
      // STATE, so the edge is detected here. Gated on the speed the bike was
      // carrying INTO the block, not on the speed after it — by the time
      // `blocked` is set the hull has already been scrubbed to a quarter, and
      // reading that would make every impact a tap.
      if (this._riding) {
        if (b.phys.blocked && !this._wasBlocked && this._preBlockSpeed > 1.6) {
          this._cue('bump', { x: b.phys.x, z: b.phys.z });
        }
        this._wasBlocked = b.phys.blocked;
        if (!b.phys.blocked) this._preBlockSpeed = wasMoving;
      }
    }

    const photographing = !!this.ctx.systems?.hud?.photo?.active;
    const scoped = !!this.ctx.systems?.camp?.scope?.active;
    // Somebody ELSE has the pedals — the player is out on the water. The
    // camper is still parked with its hold armed, so `brakeHold` alone would
    // happily offer "ride the bike" to a player sitting in a kayak halfway
    // across a lake. `controlsHeldBy` is the system of record for who is
    // driving what, so ask that instead, and it covers whatever gets added
    // next without this line changing.
    const held = veh?.controlsHeldBy;
    const free = held == null || held === 'bike';
    const parked = !!veh?.enabled && !!veh.brakeHold && free && !photographing && !scoped;

    let claim = false;
    if (this._riding) claim = true;
    else if (b && parked && !window.__forceCamera) claim = this._campside(veh);
    else { this._say(''); this._cursor(''); }
    this.pointerClaim = claim;
    this.active = this._riding;

    this._publish();
  }

  lateUpdate(dt) {
    // The glance at a freshly parked bike. In lateUpdate so it lands AFTER
    // Camp's per-frame setFocus and before CameraRig reads it — and only while
    // Camp itself holds no focus, so it never fights the fire shot.
    if (this._focusT > 0 && !this._riding) {
      this._focusT -= dt;
      const rig = this.ctx.systems?.cameraRig;
      if (this.ctx.systems?.camp?._focusCamp) { this._focusT = 0; return; }
      if (this._focusT > 0) rig?.setFocus?.(this._focusP);
      else rig?.setFocus?.(null);      // Camp re-asserts its own next frame
    }
  }

  /**
   * The headlamp, following the sun — `Vehicle._lights`' shape, at a bicycle's
   * scale.
   *
   * Three states rather than two, and the middle one is the interesting one:
   *
   *   day        beam off, lens a cold grey disc.
   *   parked     beam off, lens holding a small standby glow. A bike left in a
   *              meadow at dusk with a dead lamp reads as broken; a bike with
   *              one lit eye reads as YOURS, and it is how you find it again.
   *              The beam itself stays off — a parked bike throwing a 26 m spot
   *              across a camp is exactly the thing the camper dips its own
   *              lamps to avoid, and nothing may out-value the fire.
   *   riding     the beam, full.
   *
   * `beamCeil` is the camper's daylight guard, and it is not optional here
   * either: between about 17:00 and 18:30 the night mix is most of the way up
   * while the meadow is still at golden-hour exposure, and a spot cut for a
   * dark valley lands on ground already near the top of the range.
   *
   * ── the pool is graded COOL, and that is accepted ──────────────────────────
   *
   * `render/Hearth.js` explains the mechanism: PostFX's night grade rotates
   * warm pixels below `uRodKnee` toward a blue-violet axis, and only a pixel
   * bright enough to pass that knee keeps its own colour. The camper's beam
   * passes it because it is a floodlight. This one does not and never will,
   * because the only way to get it there is the near-white pool that was
   * rejected above.
   *
   * So the lamp is specified as an LED rather than fought: `LAMP_COLOR` is a
   * cool white, the pool grades a shade cooler still, and a cool pool on a
   * blue-graded night meadow is what a modern bar light actually looks like.
   * The warm end of the night belongs to the fire, which is the one thing in
   * this game allowed to own it — and hijacking `setHearth` to buy this lamp a
   * warm pool would take that away every time the player rode past camp.
   */
  _lamp(dt) {
    const sunY = this.ctx.lighting?.sunDir?.y ?? 1;
    const want = 1 - smoothstep(-0.02, 0.20, sunY);
    this._nightMix = damp(this._nightMix, want, 2.2, dt);
    const k = this._nightMix;
    const mats = bikeMaterials();

    if (!this.bike) {
      this.lamp.intensity = 0;
      mats.lens.emissiveIntensity = LENS_OFF;
      return;
    }
    const beamCeil = lerp(1, 0.45, smoothstep(-0.06, 0.10, sunY));
    // The beam is the rider's. `_riding` and not the bike's existence, so
    // getting on at night IS the switch — no control to find, no state to
    // remember, and it lands on the same frame as the mount cue.
    this.lamp.intensity = this._riding ? k * beamCeil * LAMP_PEAK : 0;
    mats.lens.emissiveIntensity = this._riding
      ? lerp(LENS_OFF, LENS_ON, k)
      : lerp(LENS_OFF, LENS_PARKED, k);
  }

  // ── campside: pointing at the bike ────────────────────────────────────────

  /** Returns whether the bike system claims the pointer this frame. */
  _campside(veh) {
    const { camera, input } = this.ctx;
    // A finger that has lifted is not pointing at a bike. Without this the
    // prompt would freeze wherever the player last touched — and worse, this
    // method's return value is `pointerClaim`, which Camp reads to stand down.
    if (!pointing(input)) { this._say(''); this._cursor(''); return false; }
    const ray = pointerRay(input, camera, this._ray);

    // The camper's own triangles outrank everything — a click on the camper is
    // Camp's "look back at the car", never a mount.
    const carHit = objectHit(ray, veh?.rig, 60);
    const b = this.bike;
    const p = b.phys;
    // Aimed at the middle of the frame, not at the ground point: a bicycle is
    // 1 m tall and its centre of mass is where the player points.
    const c = this._v.set(p.x, p.y + 0.62, p.z);
    if (carHit < c.distanceTo(camera.position)) { this._say(''); this._cursor(''); return false; }
    // A generous sphere. The object is mostly holes, so a miss test against its
    // triangles would refuse half the clicks that are visibly ON it.
    if (rayMiss(ray, c, 0.95) >= 1) { this._say(''); this._cursor(''); return false; }

    this._say(`${pickVerb()}&nbsp; ride the bike`);
    this._cursor('pointer');
    if (this.click.clicked) this.mount();
    return true;
  }

  // ── riding ────────────────────────────────────────────────────────────────

  _pedal(dt, t, veh, rig) {
    const b = this.bike;
    const ax = this.ctx.input.axes;
    let fwd = ax.throttle, back = ax.brake, turn = ax.steer;
    if (this._script) {
      fwd = clamp01(this._script.speed);
      back = clamp01(-this._script.speed);
      turn = this._script.turn ?? 0;
    }
    b.phys.step(dt, t, { fwd, back, turn });

    // ── getting off ───────────────────────────────────────────────────────
    // Not while the shutter is open. Photo mode composes with the same plain
    // left click that reaches back to the camper from the saddle, so without
    // this, framing a shot with the camper anywhere in it would drop the player
    // off the bike mid-photograph. E is the same argument.
    if (this.ride.handedOff) { this._say(''); this._cursor(''); return; }
    const { camera, input } = this.ctx;
    if (this.click.clicked) {
      const ray = pointerRay(input, camera, this._ray);
      // Generous reach: the camper can be most of a valley away.
      if (objectHit(ray, veh?.rig, 300) < Infinity) { this.dismount(); return; }
    }
    // Leaving the bike is a commit to a PLACE — this is where it will be — so
    // it is a hold on touch and E with a keyboard, the same split as pitching a
    // camp and stepping ashore. It deliberately does not take a plain tap: a
    // tap while riding is how you reach the camper.
    if (input.justPressed('KeyE') || (touchCapable() && input.press.commit)) {
      this._leaveHere();
      return;
    }

    // The drive hint is a greeting, not a label: it expires a few seconds after
    // mounting. "leave the bike" has no condition — you can get off anywhere —
    // so it stays.
    this._hintT = Math.max(0, this._hintT - dt);
    const drive = this._hintT > 0 ? `${pickVerb()} camper&nbsp; drive` : '';
    const off = `${actVerb()}&nbsp; leave the bike here`;
    this._say(drive ? `${off}&ensp;${drive}` : off);
    this._cursor('');
    void rig;
  }

  /**
   * Where the eye sits on a bicycle — the one thing `RideCamera` cannot know.
   *
   * Three quarters of the bike's length behind it and a rider's height up,
   * looking over the bars. Two things this does that the kayak's mount does
   * not, both because a bike is on ground rather than on a plane:
   *
   *  · **The eye is held clear of the ground BEHIND the bike.** Ride up a bank
   *    and the mount point is inside the hill; clamping to the ground there
   *    plus `CAM_CLEAR` keeps the shot instead of burying it. It is a max, not
   *    a lerp, so it costs nothing on flat ground.
   *  · **It banks.** A third of the bike's lean, through the camera's `up` —
   *    see CAM_BANK. Matching the lean fully is instantly sickening; ignoring it
   *    entirely reads as a tripod.
   *
   * Returns preallocated objects: this runs every frame inside the camera
   * takeover, and the rig is the last place in the loop that wants garbage.
   */
  _mount(zf, yaw, pitch) {
    const b = this.bike;
    if (!b) return null;
    const p = b.phys;
    const W = this.ctx.world;
    const L = BIKE_DIM.length;
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    const mx = p.x - fx * L * CAM_AFT * zf;
    const mz = p.z - fz * L * CAM_AFT * zf;
    // Height: above the bike, above the ground under the eye, and above any
    // water there. `getWaterHeight` is the level, not the depth, and is null on
    // dry ground — which costs nothing on the 99% of frames that are dry.
    const gy = W?.getHeight?.(mx, mz) ?? p.y;
    let my = Math.max(p.y + CAM_UP * (1 - CAM_RISE + CAM_RISE * zf), gy + CAM_CLEAR);
    const wy = W?.getWaterHeight?.(mx, mz);
    if (wy !== null && wy !== undefined && wy + CAM_WATER_CLEAR > my) my = wy + CAM_WATER_CLEAR;

    // The look target is a point on the TRAIL AHEAD OF THE BIKE — not a boom
    // off the eye, which is how the kayak does it and is wrong here. A boom off
    // the eye moves with the zoom, so pulling the camera back also pushed the
    // aim point back and the bike slid down out of frame exactly as fast as the
    // wide shot was trying to reveal it. Anchored to the bike, the bike holds
    // its place in frame at every zoom and the wheel does what a wheel should:
    // it changes how much of the world you can see around the same subject.
    const reach = L * CAM_LOOK_AHEAD;
    const a = p.heading + yaw;
    const cp = Math.cos(pitch);
    this._mEye.x = mx; this._mEye.y = my; this._mEye.z = mz;
    this._mLook.x = p.x + Math.sin(a) * reach * cp;
    this._mLook.z = p.z + Math.cos(a) * reach * cp;
    this._mLook.y = p.y + CAM_LOOK_UP - Math.sin(pitch) * reach;

    // Bank: tip the up vector about the direction of travel by a fraction of
    // the lean, WITH the bike and not against it. A positive `lean` is a left
    // turn and lays the bike's top over toward +X (the rider's left — see
    // bike_physics on the sign of `roll`), so the eye's up has to go the same
    // way; negated, the camera counter-rotates and the bike appears to lean
    // twice as far as it does.
    //
    // `p.lean` and not `p.roll` — the ground's cross-slope is the world's, not
    // the rider's, and rolling the camera with a hillside is the horizon-drift
    // complaint the chase camera already learned to avoid.
    const bank = p.lean * CAM_BANK;
    const sb = Math.sin(bank);
    // (cos h, 0, −sin h) is the bike's own +X. The up vector is that, times the
    // bank, plus plumb.
    this._mUp.set(Math.cos(p.heading) * sb, Math.cos(bank), -Math.sin(p.heading) * sb);
    return this._mPose;
  }

  // ── the verbs (also the harness API) ──────────────────────────────────────

  /**
   * Park a bike here. Called by `Camp` when a full camp's layout produces a
   * `bike` entry — see the note up top on why there is only ever one.
   *
   * @param it   the layout entry: { x, z, y, yaw }
   * @param rnd  the camp's own rng, so a given camp always gets a given bike
   */
  park(it, rnd = null) {
    // Never take the bike out from under a rider.
    if (this._riding) return null;
    const world = this.ctx.world;
    if (!world?.isInBounds?.(it.x, it.z)) return null;
    this._despawn();

    const r = rnd ?? siteRng(it.x, it.z, this.ctx.world?.seed ?? 0);
    const colorway = it.opts?.colorway ?? Math.floor(r() * BIKE_COLORWAYS.length);
    let group;
    try { group = buildBike(r, { ...(it.opts ?? {}), colorway }); }
    catch (e) { console.error('[bike] model builder threw', e); return null; }
    group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.root.add(group);

    // Hang the beam on the bars. Re-parented rather than created, so the light
    // count never changes — see the note in `init`.
    const mnt = group.userData.lampMount;
    if (mnt) { mnt.add(this.lamp); mnt.add(this.lampTarget); }
    this.lamp.position.set(0, 0, 0);
    this.lampTarget.position.set(LAMP_AIM.x, LAMP_AIM.y, LAMP_AIM.z);

    const phys = new BikePhysics(world, group.userData.dim ?? BIKE_DIM, { ctx: this.ctx });
    phys.place(it.x, it.z, it.yaw ?? 0);
    this.bike = {
      group, phys, spawnT: 0,
      colorway: group.userData.colorway, style: group.userData.style,
    };
    this._standT = 0;
    this._pose(this.bike);

    this._focusT = PARK_FOCUS;
    this._focusP.set(phys.x, phys.y + 0.6, phys.z);
    return this.bike;
  }

  /** Get on. Takes the camper's controls and the camera; both are given back by
   *  `dismount()`. */
  mount() {
    const b = this.bike;
    if (!b || this._riding) return false;
    const veh = this.ctx.systems?.vehicle;
    const rig = this.ctx.systems?.cameraRig;
    this._riding = true;
    this.active = true;
    this._focusT = 0;
    if (veh) veh.controlsHeldBy = 'bike';
    rig?.setFocus?.(null);
    // Mount the camera: full takeover, the same sanctioned mechanism the
    // telescope and the kayak use. We do NOT raise __forceCamera — the HUD and
    // the prompts stay up.
    this.ride.reset();
    this._hintT = DRIVE_HINT_TIME;
    this.ride.take(rig);
    this._cue('mount', { x: b.phys.x, z: b.phys.z });
    return true;
  }

  /** Get off: the bike stays where it is, everything else goes back.
   *  Unconditional about the givebacks, whatever state it is called in. */
  dismount() {
    const veh = this.ctx.systems?.vehicle;
    const rig = this.ctx.systems?.cameraRig;
    // Before the state is torn down, so `current` still names a live bike for
    // the cue's distance and pan.
    if (this._riding && this.bike) {
      this._cue('dismount', { x: this.bike.phys.x, z: this.bike.phys.z });
    }
    if (veh) veh.controlsHeldBy = null;
    rig?.setFollow?.(null);
    // The chase re-primes behind the camper: a cut. `release` also clears the
    // hand-off flag, which matters when photo mode is still open.
    this.ride.release(rig);
    if (this.bike) { this.bike.phys.speed = 0; this.bike.phys.lean = 0; }
    this._riding = false;
    this.active = false;
    this._script = null;
    this._say('');
    this._cursor('');
  }

  /**
   * E on the saddle: leave the bike standing here and bring the camper round to
   * ground beside it, then get off — the same move the kayak makes when you
   * step ashore, and for the same reason. The player is always the camper in
   * this game; getting off a bike two kilometres from it and being handed a
   * chase camera over an empty road is not an ending anybody wants.
   *
   * The camper lands via `Vehicle._land` — the full teleport a rescue uses
   * (physics cut, camera cut, park brake held until the player drives). If no
   * ground it can stand on is found, this is just `dismount()` and the camper
   * stays where it was.
   */
  _leaveHere() {
    const veh = this.ctx.systems?.vehicle;
    const world = this.ctx.world;
    const p = this.bike?.phys;
    if (!p) { this.dismount(); return; }
    // Search a ring around the bike rather than a line off its nose: the bike
    // stops wherever the rider stopped it, and its heading at that moment says
    // nothing about where a five-metre camper fits.
    let best = null, bestScore = Infinity;
    for (let ring = 8; ring <= 26 && !best; ring += 6) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const x = p.x + Math.cos(a) * ring, z = p.z + Math.sin(a) * ring;
        if (!world.isInBounds(x, z)) continue;
        if (world.getWaterDepth(x, z) > 0.05) continue;
        const slope = world.getSlope(x, z);
        if (slope > 0.35) continue;
        if (slope < bestScore) { bestScore = slope; best = { x, z, a }; }
      }
      if (best) break;
    }
    if (best && veh?._land) {
      // Face the camper at the bike, which is where the player is standing.
      veh._land(best.x, best.z, Math.atan2(p.x - best.x, p.z - best.z));
    }
    this.dismount();
  }

  // ── photo mode ────────────────────────────────────────────────────────────

  /** Hand the camera to photo mode, where it stands. The whole argument is in
   *  `RideCamera.handOff`. The bike is not touched or hidden — it is the thing
   *  the player wants in the photograph.
   *  @returns the bike handed over, or null if the player is not riding. */
  handOff() {
    if (!this._riding) return null;
    this.ride.handOff(this.ctx.systems?.cameraRig);
    return this.bike;
  }

  /** Back in the saddle. Photo mode calls this on its way out. A cut, not the
   *  damped ride back — see `RideCamera.endHandOff`.
   *  @returns true if a hand-off was actually ended. */
  endHandOff() {
    if (!this._riding) return false;
    return this.ride.endHandOff(this.ctx.systems?.cameraRig);
  }

  // ── shared plumbing ───────────────────────────────────────────────────────

  /** Write the group transform and every moving part from the physics. */
  _pose(b) {
    const p = b.phys;
    const g = b.group;
    g.position.set(p.x, p.y, p.z);
    // 'YXZ' is heading, then pitch about the bike's own lateral axis, then roll
    // about its own forward axis — which is the order these three actually
    // happen in. `-p.pitch` because a rotation about local +X tips the nose
    // DOWN; see bike_physics on the sign of `roll`.
    // The parked lean onto the kickstand rides in the same roll term rather
    // than as a second quaternion: it IS a roll, and composing two of them is
    // how a bike ends up leaning one way and its shadow the other. The stand is
    // on the LEFT (+X), so the bike tips left onto it, which is a NEGATIVE
    // z-euler — see bike_physics on the sign of `roll`.
    const onStand = STAND_LEAN * (1 - this._standT);
    this._e.set(-p.pitch, p.heading, p.roll - onStand, 'YXZ');
    g.quaternion.setFromEuler(this._e);

    const u = g.userData;
    if (u.wheels) {
      u.wheels.front.rotation.x = p.wheelAngle;
      u.wheels.rear.rotation.x = p.wheelAngle;
    }
    if (u.steer) u.steer.rotation.y = p.steerAngle;
    if (u.cranks) u.cranks.rotation.x = p.crankAngle;
    if (u.stand) u.stand.rotation.x = STAND_FOLD * this._standT;

    if (b.spawnT < 1) {
      // Back-ease with a small overshoot — set down, not faded in. The same
      // curve the boats use, so a bike and a canoe appear the same way.
      const k = b.spawnT;
      const e = 1 - Math.pow(1 - k, 2.2) * (1 - 0.14 * Math.sin(k * Math.PI));
      g.scale.setScalar(Math.max(0.001, e));
    } else if (g.scale.x !== 1) g.scale.setScalar(1);
  }

  /** Bike state, published every frame for the HUD and any audio layer. */
  _publish() {
    const b = this.bike;
    if (!b) { this.current = null; return; }
    const p = b.phys;
    // Everything the audio layer needs, and the same shape the boat publishes
    // so the HUD can read either without converting. `speed` is the GROUND
    // TRACK, not the effort: a rider grinding against a boulder should read
    // zero on the dial and sound like a stalled bike, which is what happens.
    this.current = {
      x: p.x, z: p.z, heading: p.heading,
      speed: this._riding ? p.made : 0,
      riding: this._riding,
      effort: this._riding ? p.effort : 0,
      braking: this._riding ? p.braking : 0,
      wheelRate: this._riding ? p.wheelRate : 0,
      cadence: this._riding ? p.cadence : 0,
      wading: p.wading, wade: p.wade, blocked: p.blocked, grade: p.grade,
      grassiness: p.grassiness,
      colorway: b.colorway, style: b.style, group: b.group,
    };
  }

  /** One bike event, handed to the audio layer. Optional-chained the whole way
   *  down: the audio system may not have started (it waits for a gesture) and a
   *  silent game is not a broken one. */
  _cue(kind, data) {
    this.ctx.systems?.audio?.bike?.cue?.(kind, data);
  }

  _say(text, onTap = null) { this.prompt.set(text, onTap); }

  _cursor(want) {
    if (want === this._cursorNow) return;
    this._cursorNow = want;
    const el = this.ctx.renderer?.domElement;
    if (el) el.style.cursor = want;
  }

  _despawn() {
    const b = this.bike;
    if (!b) return;
    // Take the beam back BEFORE the group goes: it is parented into the bike's
    // steer body, and letting it be removed with the model would drop it out of
    // the scene — which is the relink this whole arrangement exists to avoid.
    this.lamp.intensity = 0;
    this.root.add(this.lamp);
    this.root.add(this.lampTarget);
    this.bike = null;
    this.root.remove(b.group);
    b.group.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
  }

  // ── harness API (window.__bike) ───────────────────────────────────────────

  /** Park a bike at an arbitrary point, ignoring the camp. Harness only. */
  parkAt(x, z, opts = {}) {
    const y = this.ctx.world?.getHeight?.(x, z) ?? 0;
    const b = this.park({ x, z, y, yaw: opts.yaw ?? 0, opts });
    return b ? this.state() : null;
  }

  /** Scripted input for headless captures: speed −1..1, turn −1..1. Pass null
   *  (or nothing) to clear. */
  drive(speed, turn = 0) {
    this._script = (speed === null || speed === undefined) ? null : { speed, turn };
    return this._script;
  }

  /** JSON-able snapshot. */
  state() {
    return {
      active: this.active,
      riding: this._riding,
      pointerClaim: this.pointerClaim,
      bike: this.bike ? {
        colorway: this.bike.colorway, style: this.bike.style,
        spawnT: this.bike.spawnT, ...this.bike.phys.state(),
      } : null,
      controlsHeldBy: this.ctx.systems?.vehicle?.controlsHeldBy ?? null,
    };
  }

  /** Park near the camper, get on, and ride a gentle arc. */
  demo() {
    const veh = this.ctx.systems?.vehicle;
    const p = veh?.position ?? { x: 0, z: 0 };
    this.parkAt(p.x + 6, p.z + 6, {});
    this.mount();
    this.drive(1, 0.12);
    return this.state();
  }

  dispose() {
    this.dismount();                  // controls + camera back, always
    this._despawn();
    setBikeEnv(null);
    disposeBikeMaterials();
    this._probe?.dispose();
    this._probe = null;
    this.lamp?.dispose?.();
    this.prompt?.dispose();
    this.root?.parent?.remove(this.root);
    if (window.__bike === this) delete window.__bike;
  }
}
