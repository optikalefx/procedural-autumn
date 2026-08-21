// ─────────────────────────────────────────────────────────────────────────────
//  Camp — park, pick a patch of ground, and make camp on it.
//
//  The player's spec: "When the vehicle is in parking brake held, allow the
//  user to select an area on the ground near the vehicle. It should clear the
//  area with a bit of dirt, then place a random assortment of camping items,
//  use math, make it a bit of randomness centralized around a nice burning
//  fire. Make sure you only have 1 tent of course."
//
//  This file owns integration and the state machine only. The four things that
//  actually decide whether it is any good live elsewhere and each has one
//  author: what the props look like (camp_tent/chair/cooler/table), what the
//  fire looks like (camp_fire), what the ground looks like (camp_ground), and
//  where everything ends up (camp_site).
//
//  ── the state machine ───────────────────────────────────────────────────────
//
//    IDLE      no camp, brake not held. Nothing exists, nothing costs anything.
//    AIMING    brake held, no camp. Reticle live, following the mouse.
//    RAISING   committed; the clearing opens and the camp builds in over ~1.1 s
//    PITCHED   the camp exists. Driving away does not remove it.
//    STRIKING  packing up, the reverse of RAISING.
//
//  There is exactly one camp in the world at a time. That is a deliberate
//  simplification and it is the right one: the clearing is published to the
//  grass and cover shaders as a single vec4 (see camp_clearing.js), a second
//  camp would need a second uniform and a second dirt mesh for a feature whose
//  entire emotional payload is "this is where I stopped".
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { clamp, clamp01, lerp, smoothstep, damp } from '../core/MathUtils.js';
import { setCampSlots, setCampAim, clearCampAim, CAMP_SLOTS } from './camp_clearing.js';
import { campMaterials, disposeCampMaterials } from './camp_materials.js';
import {
  groundRay, scoreSite, bestSite, clampToSite, layoutCamp, standOn, siteRng,
  SITE_MIN, SITE_MAX, CAMP_RADIUS, CAMP_RADIUS_SMALL,
} from './camp_site.js';
import { CampGround } from './camp_ground.js';
import { CampReticle, CampPrompt } from './camp_ui.js';
import { ScopeView } from './camp_scope_view.js';
import { Firepit, buildWoodpile } from './camp_fire.js';
import { buildTent } from './camp_tent.js';
import { buildRidgeTent } from './camp_tent_ridge.js';
import { buildChair } from './camp_chair.js';
import { buildCooler } from './camp_cooler.js';
import { buildTable } from './camp_table.js';
import { buildTelescope } from './camp_telescope.js';

const STATE = { IDLE: 'idle', AIMING: 'aiming', RAISING: 'raising', PITCHED: 'pitched', STRIKING: 'striking' };

// How long the camp takes to appear. Long enough to read as an event, short
// enough that it never feels like waiting for a loading bar.
const RAISE_TIME = 1.15;
const STRIKE_TIME = 0.55;

// A click is a press and release in the same place. The camera look drag uses
// the same button, so the two have to be told apart, and the honest test is
// "did the pointer move" rather than a timer — a slow deliberate click is still
// a click, and a fast flick to turn the camera is not.
const CLICK_SLOP = 6;      // px of travel that still counts as a click
const CLICK_TIME = 0.55;   // s held that still counts as a click

// How much grass survives inside the ring while the player is only aiming.
// High enough that the meadow is obviously still there and nothing has been
// committed to; low enough that the reticle stops being buried in it. See the
// note on `uCampFloor` in camp_clearing.js.
const AIM_FLOOR = 0.42;

// The clearing's soft edge, as a fraction of its radius rather than a fixed
// distance. A 1.4 m feather on a 5.8 m clearing is a quarter of it; the same
// 1.4 m on the compact camp's 4.2 m would be a third, so the small camp would
// be almost all fringe and would never look like cleared ground at all.
const CLEARING_FEATHER_K = 0.20;
const featherFor = (r) => clamp(r * CLEARING_FEATHER_K, 0.45, 1.25);

// The fraction of the clearing radius that things actually stand on, and
// therefore the fraction that has to be clear of trunks and boulders.
//
// `layoutCamp` keeps every prop inside 0.72 R, and the tent's own footprint is
// 1.45 m, so 0.78 R covers the occupied ground with a margin. The rest of the
// clearing may contain whatever the valley put there — see `_blocked`.
const OCCUPIED = 0.78;

// The radius that must be genuinely empty: the fire ring plus room to stand
// round it. Everything outside this is handed to the layout as an obstacle
// rather than refused — see `_blocked` for the measurement that forced this.
const CENTRE_CLEAR = 2.3;

// How many camps may stand in the world at once.
//
// The player: "if I forget to pack up camp, I can't make a new camp elsewhere.
// Let's not make that a requirement. I can make as many camps as I want as long
// as they aren't right next to each other." The single camp was an
// implementation detail wearing a design decision's clothes — see the note at
// the top of camp_clearing.js for what actually forced it.
//
// Four is not a taste limit either, it is the fire pool. Every Firepit
// allocates its own materials, and a material built at runtime is a shader
// program linked at runtime — which is what froze the game for two seconds the
// first time a camp was ever pitched. So the fires are built during the boot
// pre-warm, under the loading screen, and there is a fixed number of them.
//
// Nothing is ever refused for hitting this. Pitching a fifth camp strikes the
// one FURTHEST from it, which is the one the player is least able to see and
// least likely to be thinking about. A cap that blocks you is the thing they
// asked to have removed; a cap that quietly recycles the far end is not.
const MAX_CAMPS = 4;

// How far apart two camps must stand: the sum of their radii plus this. Enough
// that their clearings never touch, so the ground between them stays meadow and
// the two read as two places rather than as one sprawl.
const CAMP_GAP = 3.0;

// How many engine frames the pre-warm props are held in the scene. Enough for
// the main pass and the shadow cascade to have drawn every one of them, and
// few enough to finish under the loading screen. See `_prewarm`.
const PREWARM_FRAMES = 8;

// How small the pre-warm props are drawn. Small enough to be sub-pixel even at
// six metres, large enough that nothing degenerates or falls out of the depth
// range. They are also buried, so this is the second of two reasons nobody can
// see them.
const PREWARM_SCALE = 0.025;

export class Camp extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Camp';
    this.loadLabel = 'Unpacking the camp';

    this.state = STATE.IDLE;
    // Every pitched camp, newest last. See `_makeCamp` for a record's shape.
    this.camps = [];
    this._pool = [];           // idle { fire, ground } pairs, built at boot
    this._packTarget = null;   // the camp the pack-up prompt would strike
    this.root = null;

    this.reticle = null;
    this.prompt = null;
    this.scope = null;       // the telescope eyepiece view, when one is open

    this._aim = { x: 0, z: 0, y: 0, ok: false, score: 0, reason: '' };
    this._holdT = 0;
    this._mouseDown = false;
    this._downAt = { x: 0, y: 0, t: 0 };
    this._click = false;
    this._focusCamp = false; // is the camera looking at the camp or the camper?
    this._ray = { o: new THREE.Vector3(), d: new THREE.Vector3() };
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
  }

  async init() {
    const { scene, world } = this.ctx;
    campMaterials();                       // build the shared set once, up front
    this.root = new THREE.Group();
    this.root.name = 'camp';
    scene.add(this.root);

    // The pool. One { fire, ground } pair per camp slot, all of them built
    // during `_prewarm` so their shaders link under the loading screen — see
    // MAX_CAMPS for why that matters more than it sounds.
    for (let i = 0; i < MAX_CAMPS; i++) {
      this._pool.push({ fire: null, ground: new CampGround(scene, world) });
    }
    this.reticle = new CampReticle(scene, world, CAMP_RADIUS);
    this.prompt = new CampPrompt();
    this.scope = new ScopeView(this.ctx);

    // ── the fire's light, created once and never removed ──────────────────
    //
    // It lives here rather than inside Firepit for one reason, and it is a
    // load-bearing one: this scene contains NO other point light, so a light
    // appearing at runtime takes three's NUM_POINT_LIGHTS define from 0 to 1,
    // and every lit material in the world — terrain, rock, grass, cover,
    // trees, water, the camper — has to relink against the new define.
    //
    // Measured (tools/_scratch/camphitch.mjs): pitching a camp linked 36 new
    // programs and produced two consecutive frames of 986 ms and 898 ms, then
    // two more of 749 ms and 231 ms as further materials came into view. Two
    // seconds of frozen game at the exact moment the player is being shown
    // the thing they just asked for.
    //
    // So the light exists from boot at zero intensity and simply never goes
    // away. The count is 1 for the whole session, the programs link once under
    // the loading screen with everything else, and lighting a fire is a gain
    // ramp rather than a scene-graph change.
    this.fireLight = new THREE.PointLight(0xff9a3c, 0, 24, 2);
    this.fireLight.castShadow = false;
    this.fireLight.name = 'camp_fire_light';
    this.fireLight.position.set(0, -1000, 0);      // parked below the world
    scene.add(this.fireLight);

    this._prewarm();

    // Debug / harness surface. `tools/campshot.mjs` drives the whole feature
    // through this, because a capture harness that has to synthesise mouse
    // moves and clicks to photograph a tent is a harness that breaks every time
    // the input mapping is touched.
    window.__camp = this;
    // The site maths, so tools/_scratch/campdiag.mjs can sweep it without
    // reaching through a bundler that has already renamed everything.
    window.__campSiteMod = {
      scoreSite, bestSite, clampToSite, layoutCamp, groundRay,
      CAMP_RADIUS, CAMP_RADIUS_SMALL,
    };
  }

  /**
   * Link every shader the camp will ever need, now, under the loading screen.
   *
   * The point light above removes the relink of the *rest of the world*. This
   * removes the first-draw compile of the camp's own materials — measured at
   * 36 programs, and three does not link a program until the material is first
   * rendered, so without this they all arrive on the frame the camp appears.
   *
   * Builds one of everything at a hidden position, hands the scene to
   * `renderer.compile`, then throws the geometry away and keeps the materials.
   * The material set is shared and module-level (see camp_materials.js), so the
   * programs stay in three's cache keyed to those exact materials — a later
   * real camp reuses them without a link.
   *
   * A pre-warm that *renders* is the only kind that works. Constructing the
   * materials is not enough; three compiles lazily and an unrendered material
   * has no program at all.
   */
  _prewarm() {
    const { scene, renderer, camera } = this.ctx;
    const t0 = performance.now();
    const rnd = siteRng(0, 0, 1);
    const warm = new THREE.Group();
    warm.name = 'camp_prewarm';
    // Placed per frame by `_finishPrewarm`, in front of the camera and buried.
    // Not `visible = false` — three skips invisible objects when compiling,
    // which would defeat the whole exercise.
    warm.scale.setScalar(PREWARM_SCALE);
    scene.add(warm);

    // `buildRidgeTent` is deliberately NOT in this list, and the omission is not
    // an oversight. This warms PROGRAMS, and a program is keyed on the material
    // and the geometry's attributes, neither of which the A-frame differs in:
    // it draws out of the same `campMaterials()` set, with the same
    // position/normal/uv/color attributes, as the dome above it. Adding it would
    // cost a 37 000-triangle build under the loading screen and link nothing.
    const builders = [buildTent, buildChair, buildCooler, buildTable, buildWoodpile,
                        (r) => buildTelescope(r, { variant: 'reflector' })];
    try {
      // Every colourway, because a colourway is a vertex-colour change and not
      // a material change — one of each builder is enough for the programs.
      for (const build of builders) {
        const o = build(rnd, {});
        if (o) warm.add(o);
      }
      // The whole pool, built here and kept for the session.
      //
      // Every Firepit allocates its own materials, and a material built at
      // runtime is a program linked at runtime — the thing that froze the game
      // for two seconds the first time a camp was pitched. Building all of
      // them now costs a few tens of milliseconds under the loading screen and
      // means the fourth camp of a session is as cheap as the first.
      for (const slot of this._pool) {
        slot.fire = new Firepit(scene, rnd, { light: this.fireLight, prewarm: true });
        // The dirt has its own material with its own onBeforeCompile. One
        // build is enough to link it — the material is shared across the pool.
        slot.ground.build(0, 0, CAMP_RADIUS, rnd);
      }

      // HARVEST BEFORE COMPILING. This line is the difference between a
      // pre-warm that works and one that looks like it does.
      //
      // Atmosphere.register and Stylize.register both call `captureShader`,
      // which CHAINS a new function onto the material's `onBeforeCompile` —
      // and three folds `onBeforeCompile` into the program cache key. So a
      // material compiled before harvest and the same material compiled after
      // harvest are two different cache keys and therefore two different
      // programs. captureShader even sets `needsUpdate = true` to force that
      // second compile, and says so in its own comment.
      //
      // The first version of this pre-warm compiled first and harvested later,
      // cached 30 programs at boot, and still linked 32 at pitch time. The
      // programs it cached were for keys nothing would ever ask for again.
      this.ctx.atmosphere?.harvest?.();
      this.ctx.stylize?.harvest?.();
      renderer.compile(scene, camera);
    } catch (e) {
      // A prop author mid-edit must not stop the game booting. The cost of
      // failing here is a hitch on the first camp, not a broken build.
      console.warn('[camp] prewarm failed; the first camp will hitch', e);
    }

    // …and then leave it in the scene for a few real frames.
    //
    // `renderer.compile()` alone was not enough and the measurement says so:
    // it cached 32 programs and the first camp still linked 30. Two reasons.
    // It does not run the SHADOW pass, so every depth variant of every
    // shadow-casting prop was still uncompiled; and a program built outside
    // the real render path here produced a run of GL_INVALID_OPERATION from
    // glGetProgramiv, which is three's own bookkeeping disagreeing with the
    // driver about what it just built.
    //
    // Frames rendered by the engine itself have neither problem. The group is
    // parked 900 m below the world where nothing can see it, with frustum
    // culling off so it is genuinely submitted rather than skipped, and
    // `update()` takes it out again after a handful of frames — all of it
    // still under the loading screen.
    warm.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    for (const slot of this._pool) {
      if (slot.ground?.mesh) slot.ground.mesh.frustumCulled = false;
      if (!slot.fire) continue;
      slot.fire.group?.traverse?.((o) => { if (o.isMesh) o.frustumCulled = false; });
      slot.fire.setPosition(new THREE.Vector3(0, -900, 0));
      slot.fire.setReveal(1);         // reveal 0 may hide it, and hidden does not compile
    }
    this._warm = { group: warm, frames: 0 };
    console.log(`[camp] prewarm built in ${(performance.now() - t0).toFixed(0)} ms; ` +
                `holding for ${PREWARM_FRAMES} frames`);
  }

  /** Tear down the pre-warm once the engine has actually drawn it. */
  _finishPrewarm() {
    const w = this._warm;
    const { camera } = this.ctx;

    // ── where the pre-warm has to STAND ───────────────────────────────────
    //
    // The first version parked it 900 m below the world, which compiled the
    // main pass and nothing else: the shadow cascade's frustum does not reach
    // 900 m down, so every prop's DEPTH variant was still uncompiled and the
    // first camp linked seven programs and froze a frame for 465 ms.
    //
    // It has to be somewhere both the camera and the shadow cameras are
    // actually looking. So: six metres in front of the lens, three and a half
    // metres underground, at a fortieth of scale. Inside both frusta, and
    // invisible twice over — buried, and about a centimetre across.
    const d = this._v.set(0, 0, -1).applyQuaternion(camera.quaternion);
    w.group.position.set(
      camera.position.x + d.x * 6,
      camera.position.y + d.y * 6 - 3.5,
      camera.position.z + d.z * 6,
    );
    for (const slot of this._pool) {
      slot.fire?.setPosition?.(w.group.position);
      if (slot.ground?.mesh) slot.ground.mesh.position.copy(w.group.position);
    }

    if (++w.frames < PREWARM_FRAMES) return;
    this._warm = null;

    // ── the pool is KEPT ──────────────────────────────────────────────────
    //
    // Fires and dirt meshes are built once, here, and then moved to wherever a
    // camp is pitched — never rebuilt. `Firepit`'s constructor allocates its
    // own materials, four ShaderMaterials and three standard ones, and a
    // material built fresh is a program built fresh however thoroughly it was
    // pre-warmed, because the pre-warmed program belonged to an object that has
    // since been thrown away. Measured: with the fire rebuilt per camp, the
    // second frame after a pitch was 485 ms.
    //
    // The cost is that every camp's stone ring is the same ring. That goes away
    // the moment Firepit either hoists its materials to module scope or grows a
    // `rebuild(rnd)`, which `_pitch` already calls when it exists.
    for (const slot of this._pool) {
      slot.fire?.setReveal(0);
      slot.fire?.setPosition(this._v.set(0, -900, 0));
      slot.ground?.dispose();
    }
    for (const slot of this._pool) this._adoptFireLight(slot.fire);
    this.fireLight.intensity = 0;
    this.fireLight.position.set(0, -1000, 0);
    console.log(`[camp] prewarm released, ` +
                `${this.ctx.renderer.info.programs?.length ?? '?'} programs cached`);
  }

  // ── the one thing the rest of the game asks this system ────────────────────
  get pitched() { return this.camps.length > 0; }

  /**
   * The newest camp, as `{ x, z, y, radius, small }`.
   *
   * Kept because every capture tool and every scratch harness in this round
   * reads `__camp.site`, and because "the camp" still means something to a
   * caller who pitched exactly one. Anything that cares about all of them
   * should walk `camps` instead.
   */
  get site() { return this.camps.length ? this.camps[this.camps.length - 1] : null; }

  /** The newest camp's props — same reasoning as `site`. */
  get props() { return this.camps.length ? this.camps[this.camps.length - 1].props : []; }

  /** The newest camp's build-in, 0..1. */
  get raise() { return this.camps.length ? this.camps[this.camps.length - 1].raise : 0; }

  update(dt, t) {
    const { input, camera } = this.ctx;
    const veh = this.ctx.systems?.vehicle;
    if (this._warm) this._finishPrewarm();
    this._pollClick(dt);

    const holding = !!veh?.enabled && !!veh.brakeHold;

    // ── every camp advances on its own clock ────────────────────────────────
    // Raising and striking are per-camp now, not states of the player. The
    // player is only ever doing one of two things — aiming, or not — and a camp
    // three hundred metres away finishing its build-in is none of their
    // business.
    for (const c of this.camps.slice()) {
      if (c.striking) {
        c.raise = Math.max(0, c.raise - dt / STRIKE_TIME);
        this._applyRaise(c);
        if (c.raise <= 0) { this._strike(c, true); continue; }
      } else if (c.raise < 1) {
        // ONE per frame. Eight props over a 1.15 s raise leaves enormous
        // headroom even at 20 fps, and two per frame was measurably worse for
        // no benefit: the frames straddling a pitch measured 92 and 74 ms
        // against a 20 ms baseline, which is two prop builds landing together.
        if (c.queue.length) this._buildNext(c);
        c.raise = Math.min(1, c.raise + dt / RAISE_TIME);
        this._applyRaise(c);
      }
    }
    if (this.camps.length) this._publishSlots();

    // ── the player ──────────────────────────────────────────────────────────
    if (!holding) {
      if (this.state !== STATE.IDLE) {
        this.state = STATE.IDLE;
        this.prompt.set('');
        // Retract the preview. Without this, releasing the brake and driving
        // away leaves a ghost-thinned disc of meadow behind you forever.
        clearCampAim();
      }
      if (this.scope?.active) this.scope.leave();
    } else {
      this.state = STATE.AIMING;
      this._interact(dt, veh);
    }

    this._updateFocus(veh);
    // The reticle's visibility is driven from HERE, not from `_interact`, so
    // suppressing the aim in `_interact` was not enough on its own: the ring
    // simply stayed wherever it last was, lit, through every frame of a
    // capture. A shared assertion in campshot.mjs found it in the first two
    // frames it ever ran on, having been present in every dusk sheet this
    // round. Borrowed from procedural-fall-73, who added the same check to
    // their own harness for the same reason.
    const aimVisible = this.state === STATE.AIMING && !this.scope?.active
                    && (!window.__forceCamera || !!window.__campForceAim);
    this.reticle.update(dt, t, aimVisible);
    this._carryFireLight(dt, t, camera);
  }

  /**
   * Everything the player can do while parked: look through a telescope, make
   * a camp, or pack one up.
   *
   * These used to be separate states because there was one camp and it either
   * existed or it did not. With several, they are all live at once and the
   * pointer is what chooses between them — which is better anyway, and gives
   * `E` an unambiguous meaning it did not have before: **point at open ground
   * to make a camp, point at a camp to pack it up.**
   */
  _interact(dt, veh) {
    const { input } = this.ctx;

    // Inside the telescope, nothing else in the camp is listening. In
    // particular E must NOT reach the pack-up branch below: a player who
    // reaches for a key to get out of a view they have just entered would
    // otherwise strike the whole camp, which is the worst possible answer to
    // "how do I leave".
    if (this.scope?.active) {
      // Driving takes the camera back, always — the same rule `_updateFocus` is
      // built around, and it is about the VEHICLE, not about any camp. A player
      // who touches the throttle wants to be behind the wheel, not at an
      // eyepiece three metres away.
      if (Math.abs(veh?.speed ?? 0) > 0.6 || (input.axes.throttle ?? 0) > 0.05) {
        this.scope.leave();
      }
      this.scope.update(dt);
      // The eyepiece draws its own prompt. It has to: the view raises
      // `window.__forceCamera` so the HUD leaves the frame, and `CampPrompt`
      // hides itself under that global along with the rest of the UI.
      this.prompt.set('');
      return;
    }

    // The telescope, if the player is pointing at one. Found FIRST and then
    // checked against the distance to its OWN camp, rather than the other way
    // round: gating on "near any camp" would let a player parked at camp A
    // click a telescope forty metres away in camp B and send the camera across
    // the valley.
    const scope = this._scopeUnderPointer();
    if (scope && veh &&
        Math.hypot(veh.position.x - scope.camp.x, veh.position.z - scope.camp.z) < SITE_MAX + 6) {
      this.prompt.set('<b>click</b>&nbsp; look through the telescope');
      if (this._click) {
        this._click = false;      // do not also read as a click on the camp
        this.scope.enter(scope.obj);
      }
      return;
    }

    // ── the harness has the camera; do not aim with it ────────────────────
    //
    // Every capture tool poses the camera itself and sets `__forceCamera`, and
    // `_aimAt` falls back to the camera's own forward ray when there is no
    // usable pointer. So a harness that holds the park brake — which it now
    // must, or it photographs a lighting condition no player ever sees — would
    // silently publish a placement preview wherever it happened to be looking,
    // and thin a disc of grass out of the middle of every frame.
    //
    // Same rule and same reason as the HUD hiding itself under a capture, and
    // the same escape hatch: `__campForceAim` for the one capture that is OF
    // the placement UI.
    if (window.__forceCamera && !window.__campForceAim) {
      clearCampAim();
      this.prompt.set('');
      return;
    }

    this._aimAt(veh);

    // Pointing at a camp is how you pack it up. `scoreSite` refuses a site that
    // overlaps an existing camp, and `_blocked` hands back which one — so the
    // rule falls out of the placement test rather than needing its own.
    if (this._packTarget) {
      this.prompt.set('<b>E</b>&nbsp; pack up this camp');
      // E only. A CLICK on a camp means "look at that one" and is handled by
      // `_updateFocus`; giving it a second meaning here would make packing up
      // something you could do by accident while choosing what to look at.
      if (input.justPressed('KeyE')) this._strike(this._packTarget);
      return;
    }

    // A click that is centred on the CAMPER is the player choosing what the
    // camera looks at — see `_updateFocus` — and must not also build a camp.
    //
    // It did. With one camp the pitch branch could only run when no camp
    // existed, so this could not arise; now that a camp can always be made,
    // the click that takes the camera back to the car was landing on ground
    // eight metres beside it and pitching there. The interaction test caught
    // it: `after clicking the camper` came back with two camps.
    //
    // Only the click is gated, not E. A gamepad player has no pointer and aims
    // down the camera's own axis, which in the chase view very often passes
    // through the camper — gating E as well would take the feature away from
    // them entirely.
    // …and no sphere can answer that question. Two were tried and both were
    // wrong in opposite directions:
    //
    //  · "is the click centred on the camper" — in the chase view the camper
    //    sits near the middle of the screen and a 2.8 m sphere swallows most of
    //    the lower frame. This blocked the FIRST camp of the session outright.
    //  · "is the camper between the lens and the ground" — it almost always
    //    is. A camp must stand at least 8 m from the camper and the camera is
    //    behind the camper, so nearly every valid placement click passes it on
    //    the way. This blocked every camp.
    //
    // The camper is a specific object and the honest test is whether the
    // pointer is on it, so: raycast its actual geometry. It runs on the frame
    // of a click and nowhere else, against about fifteen merged meshes, and it
    // cannot be argued with.
    const onCar = this._click && this._pointerOnCamper();
    if (this._aim.ok && ((this._click && !onCar) || input.justPressed('KeyE'))) this._pitch();
  }

  // ── where the camera looks ────────────────────────────────────────────────

  /**
   * The camera's subject: the fire while you are camped and parked at it, the
   * camper otherwise.
   *
   * The player's request was "when camp is placed, you need to focus the
   * camera around the fire. Allow the user to click the car to change focus
   * back to the car." Three rules, and the third is the one that was not asked
   * for and is not optional:
   *
   *  1. Pitching a camp gives the fire focus. That is the payoff shot.
   *  2. Clicking the camper takes it back. Clicking the camp gives it away
   *     again, because an affordance that only works in one direction is a
   *     trap.
   *  3. **Driving takes it back, always.** A camera still pointed at a fire
   *     while the player is steering is not a camera, and nobody would think
   *     to click the car to fix it because nobody would connect the two. So
   *     any real throttle, or leaving the camp behind, hands it straight back.
   */
  _updateFocus(veh) {
    const rig = this.ctx.systems?.cameraRig;
    if (!rig?.setFocus || !veh) return;
    // The eyepiece view owns the camera outright while it is open; moving the
    // boom's subject under it would have the rig cut to a different shot on the
    // frame the player steps back out.
    if (this.scope?.active) return;

    // `_focusCamp` is a camp record now, not a flag. A struck camp clears it in
    // `_strike`, so a camera cannot be left pointing at ground where a camp
    // used to be.
    const focus = this._focusCamp;
    if (!focus || focus.striking) { rig.setFocus(null); this._focusCamp = null; return; }

    // Rule 3, and it comes first so nothing below can override it.
    const moving = Math.abs(veh.speed) > 1.2 || (this.ctx.input.axes.throttle ?? 0) > 0.05;
    const far = Math.hypot(veh.position.x - focus.x, veh.position.z - focus.z) > SITE_MAX + 8;
    if (moving || far) { this._focusCamp = null; rig.setFocus(null); return; }

    // Rule 2. Both are tested as spheres rather than against geometry: a 2.8 m
    // sphere is every pixel of a 4.7 m camper from any angle the player clicks
    // from, it costs one dot product, and it cannot be defeated by clicking
    // the gap between the roof rack's rails.
    //
    // The test is "which target is the click CENTRED on", not "which does the
    // ray reach first", and the difference is not academic — both of the
    // obvious tests were tried and both are wrong:
    //
    //  · camper first, camp second: the eye is usually behind the camper, so
    //    a ray aimed at the ground beyond it passes within 2.8 m of it on the
    //    way. The very click that pitched the camp counted as a click on the
    //    car and handed focus straight back on the same frame.
    //  · nearest entry point: once the camera has walked over to the camp, the
    //    camp's six-metre sphere sits BETWEEN the lens and the camper. A click
    //    dead on the camper measured 23.8 m to the car and 15.8 m to the camp,
    //    so the camp won every time and clicking the car did nothing at all.
    //
    // Perpendicular miss distance as a fraction of each target's own radius
    // has neither problem: a click on the camper is centred on the camper
    // (0.1 of its radius) even while it passes through the edge of the camp's
    // sphere (0.9 of that one). It is also just what the player means.
    if (this._click && !moving && !this._justPitched) {
      const car = this._rayMiss(veh.position, 2.8);
      // Every camp competes, not just the focused one, so clicking a second
      // camp walks the camera over to it — the same affordance in both
      // directions, which is the rule this whole method is built on.
      let best = null, bestMiss = car;
      for (const c of this.camps) {
        const m = this._rayMiss(this._v.set(c.x, c.y + 0.4, c.z), c.radius * 0.9);
        if (m < bestMiss) { bestMiss = m; best = c; }
      }
      if (bestMiss < Infinity) this._focusCamp = best;   // null = the camper won
    }
    this._justPitched = false;

    const f = this._focusCamp;
    rig.setFocus(f ? this._v.set(f.x, f.y + 0.55, f.z) : null);
  }

  /**
   * The telescope the player is pointing at, if any.
   *
   * The same perpendicular-miss test `_updateFocus` uses to choose between the
   * camper and the camp, at a much smaller radius: 0.62 m is a little wider
   * than the tripod and a little narrower than the tube, which makes the whole
   * object clickable without the click reaching past it to the ground behind.
   * A generous sphere is the right shape here for the same reason it is there —
   * an affordance that can be defeated by aiming at the gap between two tripod
   * legs is an affordance most players will never find.
   *
   * Returns the prop's Object3D, because that is what `ScopeView.enter` needs:
   * the eyepiece is published in the prop's own space and only its world matrix
   * can carry it out.
   */
  _scopeUnderPointer() {
    let best = null, bestMiss = 1;
    // Across every camp. It is a pointer test, not a camp test — which camp a
    // telescope belongs to is not something the player is expressing when they
    // click on it. Whether they are close enough to ITS camp is a separate
    // question, asked by the caller.
    for (const camp of this.camps) {
    for (const p of camp.props) {
      if (p.item.kind !== 'telescope' || !p.obj?.userData?.telescope) continue;
      const d = p.obj.userData.telescope;
      // Centred on the eyepiece's own height rather than on a constant: the two
      // variants are 0.75 m and 1.5 m tall, and a sphere sized for one of them
      // either floats over the small scope or clips through the big one's tube.
      const big = d.variant === 'reflector';
      const miss = this._rayMiss(
        this._v.set(p.item.x, p.item.y + (d.eye?.y ?? 0.7) * 0.86, p.item.z),
        big ? 0.70 : 0.50);
      if (miss < bestMiss) { bestMiss = miss; best = { obj: p.obj, camp }; }
    }
    }
    return best;
  }

  /**
   * How far the pointer ray misses a sphere's centre, as a fraction of that
   * sphere's radius: 0 is dead on, 1 is grazing the rim, Infinity is a miss or
   * behind the lens. Used to pick between click targets — see `_updateFocus`.
   */
  /**
   * Is the pointer actually on the camper's geometry?
   *
   * The one place in this system that does a real scene raycast. Everywhere
   * else it would be the wrong tool — the reticle marches the heightfield
   * rather than raycasting because the first thing a scene ray hits in this
   * world is a grass blade — but here the question really is "did the player
   * click THIS object", and only its triangles can answer it.
   *
   * Cheap because of when it runs: on the frame of a click, against the
   * camper's own rig and nothing else.
   */
  _pointerOnCamper() {
    const veh = this.ctx.systems?.vehicle;
    const rig = veh?.rig;
    if (!rig) return false;
    const { input, camera } = this.ctx;
    const o = this._ray.o.copy(camera.position);
    const d = this._ray.d;
    if (input.mouse && Number.isFinite(input.mouse.x) && !window.__forceCamera) {
      d.set(input.mouse.x, input.mouse.y, 0.5).unproject(camera).sub(o).normalize();
    } else camera.getWorldDirection(d);
    const ray = (this._caster ??= new THREE.Raycaster());
    ray.set(o, d);
    ray.far = 60;
    return ray.intersectObject(rig, true).length > 0;
  }

  _rayMiss(centre, r) {
    const { input, camera } = this.ctx;
    const o = this._ray.o.copy(camera.position);
    const d = this._ray.d;
    if (input.mouse && Number.isFinite(input.mouse.x) && !window.__forceCamera) {
      d.set(input.mouse.x, input.mouse.y, 0.5).unproject(camera).sub(o).normalize();
    } else camera.getWorldDirection(d);
    const ox = centre.x - o.x, oy = centre.y - o.y, oz = centre.z - o.z;
    const along = ox * d.x + oy * d.y + oz * d.z;
    if (along < 0) return Infinity;                    // behind the lens
    const px = ox - d.x * along, py = oy - d.y * along, pz = oz - d.z * along;
    const perp = Math.sqrt(px * px + py * py + pz * pz);
    return perp > r ? Infinity : perp / r;
  }

  // ── aiming ────────────────────────────────────────────────────────────────

  /**
   * Where is the player pointing?
   *
   * The mouse ray if the pointer is over the canvas, and the camera's own
   * forward ray otherwise — which is what a gamepad player gets, and what the
   * capture harness gets. Both land in the same place, so there is one code
   * path for validity and one for the reticle.
   */
  _aimAt(veh) {
    const { input, camera, world } = this.ctx;
    const o = this._ray.o.copy(camera.position);
    const d = this._ray.d;

    if (input.mouse && Number.isFinite(input.mouse.x) && !window.__forceCamera) {
      d.set(input.mouse.x, input.mouse.y, 0.5).unproject(camera).sub(o).normalize();
    } else {
      camera.getWorldDirection(d);
    }

    const hit = groundRay(world, o, d, 220);
    const vx = veh?.position.x ?? 0, vz = veh?.position.z ?? 0;
    // No hit means the player is looking at the sky. Rather than dropping the
    // reticle — which reads as a bug — park it at the far edge of the allowed
    // ring along the view direction, so it slides out to the limit and stays
    // put. The clamp below does the rest.
    const px = hit ? hit.x : o.x + d.x * 30;
    const pz = hit ? hit.z : o.z + d.z * 30;

    // Cleared before scoring, not inside `_blocked` — see the note there.
    this._packTarget = null;
    const c = clampToSite(px, pz, vx, vz);
    // `bestSite` falls back to a compact camp where a full one will not fit,
    // so the ring the player is holding is already the size they will get.
    const s = bestSite(world, c.x, c.z, { blocked: (x, z, r) => this._blocked(x, z, r) });

    this._aim.x = c.x; this._aim.z = c.z; this._aim.y = s.y;
    this._aim.ok = s.ok; this._aim.score = s.score; this._aim.reason = s.reason;
    this._aim.radius = s.radius; this._aim.small = s.small;
    // How far along the ray the ground is, so `_interact` can tell a click on
    // open meadow from a click on the camper standing in front of it.
    this._aim.dist = hit ? hit.dist : Infinity;

    // The ring shrinks to the camp that actually fits. That is the only signal
    // the player gets that this pitch will be a small one, and it is enough —
    // it is the shape of the thing, drawn on the ground they are choosing.
    this.reticle.place(c.x, c.z, s.ok, s.score, s.radius);

    // Ghost the clearing open under the reticle. Only where the site is
    // actually buildable: a preview that appears over a lake or a cliff is
    // promising something that will not happen, and the whole job of this
    // affordance is to be trustworthy.
    if (s.ok) setCampAim(c.x, c.z, s.radius, featherFor(s.radius), AIM_FLOOR);
    else clearCampAim();

    // `_packTarget` is set by `_blocked` while scoring, and `_interact` turns
    // it into the pack-up prompt — so nothing is said here about a site the
    // player is only pointing at because their own camp is on it.
    if (this._packTarget) return;
    this.prompt.set(s.ok
      ? '<b>Click</b> or <b>E</b>&nbsp; make camp here'
      : `no camp here — ${s.reason}`);
  }

  /**
   * Anything solid standing where the camp would go.
   *
   * The first version of this asked for a clear radius of the whole clearing
   * plus 0.8 m, and the result was that the feature could not be used at all:
   * driven through the real input path in a meadow at the forest edge, EVERY
   * aim point in reach of the camper came back "trees in the way", because in
   * this valley there is nearly always a trunk within seven metres of anywhere.
   * A rule that never lets you camp is worse than no rule.
   *
   * The clear radius the camp actually needs is not the clearing — it is the
   * part of the clearing things stand on. `layoutCamp` keeps every prop inside
   * 0.72 R and the tent's own footprint is 1.45 m, so OCCUPIED is what has to
   * be clear. A trunk at 5.5 m is standing at the *edge* of the clearing, and
   * that is not a defect: a camp pitched under the lee of a birch is a better
   * frame than a camp in the middle of an empty field, and it is the picture
   * the reference plates are full of.
   *
   * Trunks between OCCUPIED and the clearing edge are handed to the layout
   * instead, which walks its props around them.
   */
  _blocked(x, z, r) {
    // An existing camp first, because it is the one refusal that is also an
    // OFFER: `_interact` reads `_packTarget` and turns "you cannot build here"
    // into "press E to pack this up". Pointing at a camp is how you strike it,
    // and that affordance falls out of the placement test rather than needing a
    // rule of its own.
    //
    // The gap is the two radii plus CAMP_GAP, so two camps' clearings never
    // touch and the meadow between them survives — which is what makes them
    // read as two places rather than one sprawl.
    //
    // `_packTarget` is cleared by `_aimAt`, NOT here: this function is only
    // reached once a site has already passed the water, slope and bumpiness
    // tests, so clearing it here would leave a stale target — and therefore a
    // live pack-up prompt — every time the player swung the reticle from their
    // own camp onto a cliff.
    for (const c of this.camps) {
      if (c.striking) continue;
      if (Math.hypot(c.x - x, c.z - z) < c.radius + r + CAMP_GAP) {
        this._packTarget = c;
        return 'a camp is already here';
      }
    }

    const occupied = r * OCCUPIED;
    const trees = this.ctx.systems?.trees;
    const near = trees?.trunksNear?.(x, z, occupied) ?? [];
    // Only the fire's own ground has to be genuinely empty. A trunk at four
    // metres is standing at the edge of the clearing, the layout is told about
    // it and walks the props around it, and a camp pitched in the lee of a
    // birch is a better picture than a camp in the middle of an empty field —
    // it is the picture the reference plates are full of.
    //
    // Measured before this was relaxed: vetoing any trunk inside the occupied
    // ring refused 74% of a dead-flat meadow whose median was ONE tree within
    // five metres. The player could not build anywhere.
    for (const t of near) {
      if (Math.hypot(t.x - x, t.z - z) < CENTRE_CLEAR + t.radius) return 'trees in the way';
    }
    // …but a thicket is still a thicket. Four trunks inside the clearing is a
    // stand of trees, not a clearing with a tree in it, and the layout would
    // spend its whole search budget failing to place a tent.
    if (near.length >= 4) return 'too crowded';

    // Rocks are held to a much higher bar than trees. A half-metre cobble
    // inside a camp clearing is not an obstacle, it is a seat, and the layout
    // is already told about it. Only something genuinely in the way refuses.
    const rocks = this.ctx.systems?.rocks;
    if (rocks?.boulderNear?.(x, z, CENTRE_CLEAR, 0.8)) return 'rocks in the way';

    const veh = this.ctx.systems?.vehicle;
    if (veh && Math.hypot(veh.position.x - x, veh.position.z - z) < SITE_MIN - 0.5) return 'too close';
    return null;
  }

  /**
   * Everything the layout has to walk around: trunks and boulders standing
   * inside or just outside the clearing, as [{ x, z, r }].
   */
  _obstacles(x, z) {
    const out = [];
    const R = CAMP_RADIUS * 1.15;   // the widest a camp can be; obstacles are cheap to over-collect
    for (const t of this.ctx.systems?.trees?.trunksNear?.(x, z, R) ?? []) {
      // Generous by half a metre: a prop touching a trunk still reads as
      // clipping into it, and root flare is wider than the bole.
      out.push({ x: t.x, z: t.z, r: t.radius + 0.5 });
    }
    const rocks = this.ctx.systems?.rocks;
    if (rocks?.cells) {
      for (const c of rocks.cells.values()) {
        for (const inst of c.instances) {
          if (inst.size < 0.30) continue;
          if (Math.hypot(inst.x - x, inst.z - z) > R + inst.size) continue;
          out.push({ x: inst.x, z: inst.z, r: inst.size * 0.8 });
        }
      }
    }
    return out;
  }

  /** Press-and-release-in-place, told apart from a camera look drag. */
  _pollClick(dt) {
    const m = this.ctx.input.mouse;
    this._click = false;
    if (m.down && !this._mouseDown) {
      this._mouseDown = true;
      this._downAt.x = m.x; this._downAt.y = m.y; this._downAt.t = 0;
      this._travel = 0;
    } else if (m.down) {
      this._downAt.t += dt;
      this._travel += Math.abs(m.dx) + Math.abs(m.dy);
    } else if (this._mouseDown) {
      this._mouseDown = false;
      if (this._travel <= CLICK_SLOP && this._downAt.t <= CLICK_TIME) this._click = true;
    }
  }

  // ── raising ───────────────────────────────────────────────────────────────

  /**
   * Pitch a camp. Returns its record, or null if there was no free slot and
   * nothing could be recycled.
   */
  _pitch(x = this._aim.x, z = this._aim.z) {
    const { world } = this.ctx;

    // At the cap, strike the camp FURTHEST from the new one. Never refuse:
    // being blocked is the exact thing the player asked to have removed, and
    // the far end of the valley is the part of it they are least able to see.
    if (this.camps.length >= MAX_CAMPS) {
      let far = null, bestD = -1;
      for (const c of this.camps) {
        const d = (c.x - x) ** 2 + (c.z - z) ** 2;
        if (d > bestD) { bestD = d; far = c; }
      }
      if (far) {
        this._strike(far, true);
        this.ctx.systems?.hud?.toast?.('Your furthest camp was packed up');
      }
    }
    const slot = this._pool.find((sl) => !sl.busy);
    if (!slot) { console.warn('[camp] no free slot'); return null; }
    slot.busy = true;

    const y = world.getHeight(x, z);
    // Re-scored rather than trusting the aim: `pitchAt` is also called by the
    // harness, which never aimed at anything.
    const fit = bestSite(world, x, z, { blocked: (bx, bz, br) => this._blocked(bx, bz, br) });
    const R = fit.radius ?? CAMP_RADIUS;
    const rnd = siteRng(x, z, this.ctx.world?.seed ?? 0);

    const camp = {
      x, z, y, radius: R, small: !!fit.small, feather: featherFor(R),
      slot, fire: slot.fire, ground: slot.ground,
      props: [], queue: [], queueN: 0, rnd,
      raise: 0, striking: false,
      root: new THREE.Group(),
    };
    camp.root.name = 'camp_props';
    this.root.add(camp.root);
    this.camps.push(camp);

    // Publish the clearing BEFORE building the dirt: the mesh reads
    // `campCoverAt` back to shape its own alpha, so the two are the same edge
    // by construction rather than by two authors agreeing on a formula.
    this._publishSlots();
    camp.ground.build(x, z, R, rnd, camp.feather);

    if (typeof camp.fire?.rebuild === 'function') {
      // Optional and additive: a Firepit that can re-roll its stones for a new
      // site gets to, and one that cannot is simply reused as it is.
      try { camp.fire.rebuild(rnd); } catch (e) { console.warn('[camp] fire.rebuild threw', e); }
    }
    camp.fire?.setPosition(new THREE.Vector3(x, y + 0.02, z));

    const wind = this.ctx.systems?.weather?.windDir
              ?? this.ctx.systems?.grass?.windDir
              ?? new THREE.Vector2(0.86, 0.51);

    const items = layoutCamp(rnd, world, x, z, {
      radius: R, small: camp.small, windDir: wind,
      obstacles: this._obstacles(x, z),
    });

    // ── the props are built one per frame, not all at once ──────────────────
    //
    // Seven props of merged procedural geometry cost about 160 ms to build,
    // and paying that in one frame is a six-frame freeze on the frame the
    // player clicks. It is also completely unnecessary: the camp already
    // assembles over 1.15 s with each prop appearing on its own delay, so a
    // prop that does not exist for the first four frames is a prop nobody
    // could have seen anyway.
    //
    // Ordered outward from the fire, so the camp assembles from its centre.
    // Ordering by distance rather than by kind means the same rule produces a
    // different, correct order for every layout — and it happens to put the
    // build cost in the same order as the reveal, so each prop is constructed
    // just before it is needed.
    let tents = 0;
    camp.queue = items
      // One tent PER CAMP. The layout only ever emits one, and this is the belt
      // to that braces: a second tent in a camp this size is the difference
      // between "somebody is staying here" and "this is a campground".
      .filter((it) => !(it.kind === 'tent' && tents++ > 0))
      .sort((p, q) => Math.hypot(p.x - x, p.z - z) - Math.hypot(q.x - x, q.z - z));
    camp.queueN = camp.queue.length;

    // The payoff shot. Set before the raise so the camera is already drifting
    // across as the camp assembles rather than starting to move once it is
    // finished — the two motions read as one event.
    this._focusCamp = camp;
    // The click that pitched the camp must not also be read as a click on
    // something. See `_updateFocus`.
    this._justPitched = true;
    this._applyRaise(camp);
    this.ctx.systems?.hud?.toast?.('Camp made');
    return camp;
  }

  /**
   * Build the next queued prop. One per frame; see the note in `_pitch`.
   */
  _buildNext(camp) {
    const it = camp.queue.shift();
    if (!it) return;
    const BUILD = {
      // Two tents behind one kind. The layout decides which — see the `style`
      // draw in camp_site — and everything downstream of here (the one-tent
      // filter in `_pitch`, the 0.55 tilt, the reticle's footprint) is about a
      // TENT and does not care which shape it turns out to be. A second `kind`
      // would have had to be taught to all three.
      tent: (r, o) => (o.style === 'ridge' ? buildRidgeTent(r, o) : buildTent(r, o)),
      chair: buildChair, cooler: buildCooler,
      table: buildTable, woodpile: buildWoodpile, telescope: buildTelescope,
    };
    const build = BUILD[it.kind];
    if (!build) { console.warn('[camp] no builder for', it.kind); return; }
    let obj;
    try { obj = build(camp.rnd, it.opts ?? {}); }
    catch (e) { console.error(`[camp] ${it.kind} builder threw`, e); return; }
    if (!obj) return;
    obj.position.set(it.x, it.y, it.z);
    standOn(this.ctx.world, it.x, it.z, it.yaw, it.tilt ?? 1, this._q);
    obj.quaternion.copy(this._q);
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    obj.userData.campItem = it;
    camp.root.add(obj);
    // The delay is computed from the prop's place in the ORIGINAL queue, not
    // from how many have been built, so the reveal timing is identical whether
    // the build was spread over frames or not.
    const i = camp.queueN - camp.queue.length - 1;
    camp.props.push({
      obj, item: it,
      delay: 0.06 + (i / Math.max(1, camp.queueN - 1)) * 0.42,
    });
    this._applyRaise(camp);
  }

  /**
   * Which clearings the vegetation shaders are told about.
   *
   * There can be more camps than the shader has slots, and that is fine —
   * a clearing only has to suppress vegetation that exists, and grass stops at
   * about a hundred metres. So the nearest few win and the rest simply are not
   * uploaded: their dirt is still drawn, there is just no grass left out there
   * for them to hide.
   */
  _publishSlots() {
    const p = this.ctx.camera.position;
    const near = this.camps
      .map((c) => ({ c, d: (c.x - p.x) ** 2 + (c.z - p.z) ** 2 }))
      .sort((a2, b2) => a2.d - b2.d)
      .slice(0, CAMP_SLOTS)
      // The published radius follows the build-in, which is what makes the
      // ground sweep open ahead of the props rather than appearing under them.
      .map(({ c }) => ({
        x: c.x, z: c.z, feather: c.feather,
        radius: c.radius * smoothstep(0, 0.55, c.raise),
      }));
    setCampSlots(near);
  }

  _adoptFireLight(fire) {
    if (!fire?.light || fire.light === this.fireLight) return;
    if (!this._warnedLight) {
      this._warnedLight = true;
      console.warn('[camp] Firepit created its own light instead of using opts.light; ' +
                   'adopting it. See the note on this.fireLight in Camp.init().');
    }
    // Copy whatever the author tuned, then take their light out of the scene
    // and hand them the shared one. Their update() writes `this.light.intensity`
    // so it drives the shared light without knowing anything changed.
    const src = fire.light;
    this.fireLight.color.copy(src.color);
    this.fireLight.distance = src.distance;
    this.fireLight.decay = src.decay;
    src.parent?.remove(src);
    src.dispose?.();
    fire.light = this.fireLight;
  }

  /**
   * One point light in the world, always, wherever the nearest fire is.
   *
   * Every camp's Firepit writes to the SAME light — see `_adoptFireLight` — so
   * with several camps lit at once the last one to update would win, and the
   * light would sit at whichever fire that happened to be. Carrying it to the
   * nearest fire instead is both correct and free: a fire's light reaches about
   * 24 m, camps stand at least ten metres apart, and a light belonging to the
   * second-nearest fire could not have reached the viewer anyway.
   *
   * A second light is not an option. The scene has exactly one point light on
   * purpose; a second changes NUM_POINT_LIGHTS and relinks every lit material
   * in the valley, which is the two-second freeze this whole design exists to
   * avoid.
   */
  _carryFireLight(dt, t, camera) {
    let near = null, bestD = Infinity;
    for (const c of this.camps) {
      if (c.raise <= 0.02) continue;
      const d = (c.x - camera.position.x) ** 2 + (c.z - camera.position.z) ** 2;
      if (d < bestD) { bestD = d; near = c; }
    }
    // Every fire is stepped — they all animate, and a fire that stops flickering
    // because it is not the nearest is a fire that visibly freezes when you walk
    // past it. Only the nearest gets to own the light.
    for (const c of this.camps) {
      if (c.raise <= 0.02) continue;
      if (c === near) this.fireLight.position.set(c.x, c.y + 0.45, c.z);
      c.fire?.update(dt, t, camera);
    }
    if (!near) this.fireLight.intensity = 0;
  }

  /**
   * Drive the build-in.
   *
   * The clearing radius eases open ahead of the props, which is what makes the
   * sequence read as "the ground was cleared, then things were put on it"
   * rather than as a group fading in. Props scale up from their own base, with
   * a small overshoot — a prop that settles is a prop that was set down.
   */
  _applyRaise(camp) {
    const k = camp.raise;
    camp.ground?.setReveal(smoothstep(0.02, 0.62, k));
    camp.fire?.setReveal(smoothstep(0.30, 0.95, k));

    for (const p of camp.props) {
      const t = clamp01((k - p.delay) / Math.max(0.08, 1 - p.delay));
      // Back-ease with a gentle overshoot; never below zero, because a prop
      // that inverts for one frame is a flash of inside-out geometry.
      const e = t <= 0 ? 0 : 1 - Math.pow(1 - t, 2.2) * (1 - 0.14 * Math.sin(t * Math.PI));
      p.obj.visible = t > 0.001;
      p.obj.scale.setScalar(Math.max(0.001, e));
    }
  }

  /**
   * Take a camp down.
   *
   * `now` skips the animation, which is what the cap-recycle and the harness
   * want; the player's own pack-up runs `camp.striking` and comes back here
   * once the raise has eased to zero.
   */
  _strike(camp, now = false) {
    if (!now) { camp.striking = true; return; }

    // Never leave the player inside a prop that has been packed away. The
    // eyepiece view owns the camera outright, so if the geometry goes the view
    // has to go with it — and only if the open telescope was in THIS camp.
    if (this.scope?.active && camp.props.some((p) => p.obj === this.scope.subject)) {
      this.scope.leave();
    }

    for (const p of camp.props) {
      camp.root.remove(p.obj);
      p.obj.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
    }
    camp.props.length = 0;
    camp.queue.length = 0;
    this.root.remove(camp.root);

    // The fire and the dirt are NOT disposed — they are pool slots, built once
    // at boot and parked out of sight between camps. Only Camp.dispose() ends
    // them. See MAX_CAMPS.
    camp.fire?.setReveal(0);
    camp.fire?.setPosition(this._v.set(0, -900, 0));
    camp.ground?.dispose();
    camp.slot.busy = false;

    const i = this.camps.indexOf(camp);
    if (i >= 0) this.camps.splice(i, 1);
    if (this._focusCamp === camp) this._focusCamp = null;
    if (this._packTarget === camp) this._packTarget = null;
    this._publishSlots();
  }

  /** Every camp, gone. */
  _teardown() {
    for (const c of this.camps.slice()) this._strike(c, true);
    this.fireLight.intensity = 0;
    if (!this.fireLight.parent) this.ctx.scene.add(this.fireLight);
    this.fireLight.position.set(0, -1000, 0);
    clearCampAim();
    this._publishSlots();
  }

  /** The camp the player is parked at, if any. */
  _campAt(veh, reach = SITE_MAX + 6) {
    if (!veh) return null;
    let best = null, bestD = reach * reach;
    for (const c of this.camps) {
      const d = (c.x - veh.position.x) ** 2 + (c.z - veh.position.z) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  // ── harness surface ───────────────────────────────────────────────────────

  /**
   * Pitch a camp at a given place, instantly and fully built.
   *
   * `tools/campshot.mjs` calls this. It exists because the alternative — the
   * harness driving the camper to a spot, latching the handbrake, synthesising
   * a mouse move and a click — makes every capture in this round depend on the
   * input mapping and the physics settling, and a capture harness that can
   * break for reasons unrelated to what it is photographing is a harness that
   * costs more than it saves. `shot.mjs` learned this twice already.
   */
  pitchAt(x, z, { instant = true } = {}) {
    const camp = this._pitch(x, z);
    if (camp && instant) {
      // Drain the build queue in one go. The staged build exists to keep the
      // *player's* frame budget; a capture wants the finished camp now.
      while (camp.queue.length) this._buildNext(camp);
      camp.raise = 1;
      this._applyRaise(camp);
      this._publishSlots();
    }
    return camp;
  }

  /** Pitch a camp on decent ground near a point — used by the harness. */
  pitchNear(x, z, opts = {}) {
    const { instant = true, radius = 12 } = opts;
    const { world } = this.ctx;
    let best = null;
    for (let i = 0; i < 96; i++) {
      // Golden-angle spiral outward: covers the annulus evenly without ever
      // sampling the same bearing twice, and finds the near cases first.
      const a = i * 2.39996;
      const r = SITE_MIN + (radius - SITE_MIN) * Math.sqrt(i / 96);
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      const s = bestSite(world, px, pz, { blocked: (bx, bz, br) => this._blocked(bx, bz, br) });
      // `small` sites score lower by construction, so preferring the higher
      // score already prefers a full camp and falls back to a compact one only
      // where nothing better exists — which is the behaviour wanted here and
      // needs no special case. `opts.small` forces the compact one, for the
      // harness, which otherwise could never photograph it.
      if (s.ok && (!opts.small || s.small) && (!best || s.score > best.score)) best = s;
      if (best && best.score > 0.86 && !opts.small) break;
    }
    if (!best) return null;
    return this.pitchAt(best.x, best.z, { instant });
  }

  /** Strike every camp. The harness resets with this between captures. */
  strike() { this._teardown(); this.state = STATE.IDLE; }

  dispose() {
    this._teardown();
    for (const slot of this._pool) {
      try { slot.fire?.dispose(); } catch { /* already gone */ }
      slot.ground?.dispose();
    }
    this._pool.length = 0;
    this.reticle?.dispose();
    this.prompt?.dispose();
    this.scope?.dispose();
    this.ctx.scene.remove(this.root);
    disposeCampMaterials();
  }
}
