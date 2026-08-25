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
import { setHearth, clearHearth } from '../render/Hearth.js';
import {
  groundRay, scoreSite, bestSite, clampToSite, layoutCamp, standOn, groundLift, siteRng,
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
import { CampDog, warmDog, disposeDogProtos } from './camp_dog.js';
import { picked, placed, placing, pointing } from '../core/Pointer.js';
import { pickVerb, placeVerb, actVerb, touchCapable } from '../core/verbs.js';
import { posthog } from '../posthog.js';

const STATE = { IDLE: 'idle', AIMING: 'aiming', RAISING: 'raising', PITCHED: 'pitched', STRIKING: 'striking' };

// How long the camp takes to appear. Long enough to read as an event, short
// enough that it never feels like waiting for a loading bar.
const RAISE_TIME = 1.15;
const STRIKE_TIME = 0.55;

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

// ── the tent's own ground ────────────────────────────────────────────────────
//
// The player, on a capture of a compact camp pitched on a hillside: "looks like
// it's possible for grass to be inside the tent when it spawns."
//
// It is, and the clearing cannot be the thing that prevents it — see the long
// note beside `uCampPads` in camp_clearing.js for the arithmetic. So the tent
// carries a small clearing of its own, published alongside the camp's.
//
// PAD_CLEAR is the radius that ends up genuinely bare. 1.30 m, from the fly's
// own reach: `tools/_scratch/tentreach.mjs` measures the built fabric — cords
// and pegs excluded, because a guy line lying in grass is what a guy line does
// — at 1.26 m from the tent's centre across both styles, and the layout
// separates against a declared 1.45 that the geometry is dimensioned to stay
// inside. 1.30 covers the fabric on every bearing with 4 cm to spare, and does
// not spend a centimetre of the compact camp's small dirt patch on ground no
// tent is standing on.
//
// PAD_FEATHER is what stops the pad reading as a disc where it pokes out past
// the clearing on a small camp. It is much shorter than the camp's own — 1.16 m
// on a full camp — for the same reason `CLEARING_FEATHER_K` is a fraction
// rather than a constant: a 1.16 m feather on a 1.3 m pad is not an edge, it is
// the whole pad.
const PAD_CLEAR = 1.30;
const PAD_FEATHER = 0.45;

/**
 * The clearing a laid-out camp's tent needs, or null for a camp that somehow
 * has no tent.
 *
 * `radius` is the outer edge — where the meadow is back to full height — so
 * that it means the same thing as a camp's own radius and `campPadOne` can
 * take the pair without knowing which it was handed.
 */
function tentPad(items) {
  const t = items.find((it) => it.kind === 'tent');
  if (!t) return null;
  return { x: t.x, z: t.z, radius: PAD_CLEAR + PAD_FEATHER, feather: PAD_FEATHER };
}

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

// ── the camp dog ────────────────────────────────────────────────────────────
//
// The player: "When you setup camp, 80% chance you get a camp dog."
//
// Rolled off the SITE's rng rather than a fresh one, so whether a given patch
// of ground comes with a dog is a property of the place. Pack up and pitch
// again in the same spot and the same dog is there; that is the difference
// between a companion and a slot machine.
const DOG_CHANCE = 0.80;

// ── clicking a fire ─────────────────────────────────────────────────────────
//
// The sphere that says "the pointer is on THIS fire". `FIRE_RING` is 0.58 m of
// stone and the flame stands about a metre out of it, so 1.15 m is the whole
// object with a little air — generous enough to hit without hunting for it,
// tight enough that it is unmistakably the fire and not the camp.
//
// Tight matters here for a reason the camp sphere cannot give: two camps stand
// at least their radii plus CAMP_GAP apart, which is 9.8 m at the very
// closest, so 1.15 m spheres can never contest each other. Clicking a
// particular fire picks that camp and no other, at any range and from any
// angle. The camp-sized spheres in `_updateFocus` overlap generously and are
// the coarse fallback, not the fine one.
const FIRE_PICK_R = 1.15;
// Centred where the camera is asked to look, so the affordance and the shot
// agree about where the fire is.
const FIRE_PICK_LIFT = 0.55;

// The offer, when the pointer is on a fire the camera is not already on.
const FIRE_PROMPT = () => `${pickVerb()}&nbsp; look at the camp`;

// ── the hearth mask, published to the grade ─────────────────────────────────
//
// The mask's radius is READ OFF THE LIGHT rather than authored here, and that
// is the whole of its tuning. It was a constant first — 7 m, a camp's own
// radius, which sounds like the right size for "by the fire" — and the frames
// said otherwise the moment the light was opened up to reach the tent: the
// grade then un-purpled a 7 m disc inside a 10 m pool, so the outer ring of lit
// ground kept the violet and the boundary drew itself across the dirt as a
// visible arc. Two numbers that have to agree and are edited in different files
// will not agree for long.
//
// So the fire's own cutoff IS the radius — `fireLight.distance`, passed
// straight through with no factor on it. Outside that the point light
// contributes exactly nothing, so there is no warmth there to protect and the
// night is simply the night, which is the whole of "the purple is fine away
// from the campfire". Inside it, whatever the light reaches the mask covers,
// however the light is later retuned.
//
// The intensity a fire burning normally after dark reaches, used only to
// normalise the published strength — see `_carryFireLight`. Under it the mask
// eases in with the build-in; at or above it the mask is simply on. Set below
// the night peak on purpose, so an ordinary flicker never modulates it.
const HEARTH_FULL = 1.6;

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
    this._suppressAim = false; // parked at a camp: no placement affordance at all
    this.root = null;

    this.reticle = null;
    this.prompt = null;
    this.scope = null;       // the telescope eyepiece view, when one is open

    this._aim = { x: 0, z: 0, y: 0, ok: false, score: 0, reason: '' };
    this._holdT = 0;
    this._click = false;   // a PICK this frame — see `_pollClick`
    this._place = false;   // …and a COMMIT to a spot
    this._focusCamp = null;  // which camp the camera is on, or null for the camper
    this._firePick = null;   // the fire a click this frame would be sent to
    this._hoverFire = null;  // …and whether that is worth OFFERING (see `_pickHoverFire`)
    this._ringAt = null;     // which camp the hover ring is currently shaped to
    this._cursor = '';       // last cursor we wrote to the canvas
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

    // The damped hearth strength that rides on it. See `_carryFireLight`.
    this._hearthS = 0;

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
    // The dog's geometry, built here for the same reason as everything else in
    // this list. Its MATERIAL needs no warming: `createHideMaterial` pins
    // `customProgramCacheKey` to 'animalHide', which Wildlife's own pool has
    // already linked at boot, so the first dog reuses that program.
    try { warmDog(); } catch (e) { console.warn('[camp] dog prewarm failed', e); }
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
    this._hearthS = 0;
    clearHearth();
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

  /**
   * The newest camp's firepit — same reasoning as `site`.
   *
   * This was missing, and `CampAudio.update` gates its ENTIRE layer on it:
   *
   *     const lit = camp?.fire && camp.site ? clamp01(camp.raise) : 0;
   *
   * `camp.fire` was `undefined` on the system (only on each camp *record*), so
   * `lit` was always 0, so the bed's target gain was always 0 and the crackles
   * returned at the `_level < 0.015` guard before they were ever scheduled. The
   * camp fire has never made a sound. Nothing caught it because the thing that
   * would have — the `camp` metering tap, added specifically so this layer
   * could be measured — is not read by `audiotest.mjs`, and the Sound Lab had
   * no camp entry to select. Found by a scratch harness that expected the fire
   * to be the loud neighbour it was levelling prop cues against, and measured
   * -inf instead.
   */
  get fire() { return this.camps.length ? this.camps[this.camps.length - 1].fire : null; }

  update(dt, t) {
    const { input, camera } = this.ctx;
    const veh = this.ctx.systems?.vehicle;
    if (this._warm) this._finishPrewarm();
    this._pollClick();

    // Photo mode counts as not holding, which takes the whole placement machine
    // out of the frame in one line.
    //
    // Hiding the reticle was half a fix and the wrong half. The ring is the
    // part that READS as UI; the clearing is the part that is actually in the
    // photograph — `setCampAim` publishes a vec4 the grass and cover shaders
    // thin themselves against, so a 5.8 m disc of scrubbed ground cover was
    // sliding around the meadow under the cursor while the player composed,
    // with the ring no longer there to explain it. Measured at 11 937 of 90 000
    // sampled pixels changing on a pointer move, against a 3 061-pixel wind
    // baseline.
    //
    // And `_interact` is where a click builds. A left click in photo mode
    // pitched a camp — `camps 0 -> 1` mid-compose — and `_pitch` hands it the
    // focus, so leaving photo mode cut the chase camera to a camp nobody asked
    // for, evicting the furthest one at MAX_CAMPS. `_click` reads `mouse.down`,
    // which the input suppression deliberately does not touch, because that is
    // the same button the free camera looks around with.
    //
    // Both are one question — "is the player playing, or photographing" — and
    // the not-holding branch below already answers it correctly: state to IDLE,
    // `clearCampAim()`, prompt cleared, no `_interact`.
    const photographing = !!this.ctx.systems?.hud?.photo?.active;
    const holding = !!veh?.enabled && !!veh.brakeHold && !photographing;

    // ── every camp advances on its own clock ────────────────────────────────
    // Raising and striking are per-camp now, not states of the player. The
    // player is only ever doing one of two things — aiming, or not — and a camp
    // three hundred metres away finishing its build-in is none of their
    // business.
    for (const c of this.camps.slice()) {
      if (c.striking) {
        c.raise = Math.max(0, c.raise - dt / STRIKE_TIME);
        this._applyRaise(c, true);
        if (c.raise <= 0) { this._strike(c, true); continue; }
      } else if (c.raise < 1) {
        // ONE per frame. Eight props over a 1.15 s raise leaves enormous
        // headroom even at 20 fps, and two per frame was measurably worse for
        // no benefit: the frames straddling a pitch measured 92 and 74 ms
        // against a 20 ms baseline, which is two prop builds landing together.
        if (c.queue.length) this._buildNext(c);
        c.raise = Math.min(1, c.raise + dt / RAISE_TIME);
        this._applyRaise(c, true);
      }
      // The dog arrives with the FINISHED camp, not during the build: props
      // are still popping in one per frame and a dog milling through them
      // clips, and one that fades up alongside the tent reads as part of the
      // furniture rather than as something that wandered over.
      //
      // Tested outside the `raise < 1` branch on purpose. It lived inside it
      // first, which meant an INSTANT pitch — `pitchAt({instant:true})`, the
      // path every capture harness and the whole debug surface uses — set
      // `raise` to 1 without ever entering that branch, so the camp had
      // `hasDog` true and no dog, forever. Seven of eight camps rolled a dog
      // and none of them had one.
      if (!c.striking && c.raise >= 1 && c.hasDog && !c.dog) this._makeDog(c);
      if (c.dog) c.dog.update(dt, this.ctx.camera.position);
    }
    if (this.camps.length) this._publishSlots();

    // Which fire the pointer is on, decided ONCE and before anything reads it.
    // `_interact` needs it to know what to say and what a click means, the
    // reticle needs it to know what to draw, and `_updateFocus` needs it to
    // know where a click is going; three separate answers to the same question
    // is how an affordance ends up highlighting one thing and clicking
    // another.
    this._firePick = this._fireTarget(veh);
    // A finger that has lifted is not hovering anything. Without this the fire
    // prompt sticks wherever the player last touched, because `mouse.x/y` keeps
    // the last press's position — see `pointing` in core/Pointer.js.
    this._hoverFire = pointing(input) && this._pickHoverFire(veh);

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
      // The brake is not latched, so `_interact` is not running and nothing
      // else is speaking. The fire is still clickable — `_updateFocus` runs
      // every frame — so it still has to say so.
      this._say('');
    } else {
      this.state = STATE.AIMING;
      this._interact(dt, veh);
    }

    this._updateFocus(veh);
    this._paintCursor();
    // The reticle's visibility is driven from HERE, not from `_interact`, so
    // suppressing the aim in `_interact` was not enough on its own: the ring
    // simply stayed wherever it last was, lit, through every frame of a
    // capture. A shared assertion in campshot.mjs found it in the first two
    // frames it ever ran on, having been present in every dusk sheet this
    // round. Borrowed from procedural-fall-73, who added the same check to
    // their own harness for the same reason.
    // …and not in photo mode either. A capture harness hides this because
    // eleven authors judge art through it; photo mode is the player's own
    // capture harness and the same argument is stronger there, because the
    // ring is world-space geometry lying on the ground and the placement
    // affordance is not what anyone is photographing. Parked at a camp this
    // was already covered by `_suppressAim`; parked anywhere else it was not.
    // …and on touch, only while a hold is actually in progress. There the
    // press IS the hover, so a ring parked under a thumb that lifted a minute
    // ago is describing an intention nobody has.
    const aimVisible = this.state === STATE.AIMING && !this.scope?.active
                    && !this._suppressAim
                    && placing(input)
                    && !this.ctx.systems?.hud?.photo?.active
                    && (!window.__forceCamera || !!window.__campForceAim);

    // The hover highlight, and it is the SAME ring rather than a second one.
    //
    // The camper has no hover affordance at all — clicking it works and nothing
    // ever says so — and copying that would be copying the defect. The ring is
    // already this game's world-space word for "this is the thing you are
    // pointing at", it costs no new geometry and no new shader program (a
    // second CampReticle would allocate two materials at runtime, which is the
    // hitch the whole pre-warm above exists to avoid), and it is drawn around
    // the camp, so the highlight names the place the click will take you rather
    // than the object you happened to hit.
    //
    // Placement wins when both apply: a live placement ring is mid-gesture and
    // the hover is not. `_pickHoverFire` already returns null under a capture,
    // so this cannot put a ring in a contact sheet.
    let ringOn = aimVisible;
    if (!ringOn && this._hoverFire) {
      // The camp does not move, so reshape only when the hovered one changes —
      // `place` walks 194 vertices over the heightfield.
      if (this._ringAt !== this._hoverFire) {
        this._ringAt = this._hoverFire;
        this.reticle.place(this._hoverFire.x, this._hoverFire.z, true, 1, this._hoverFire.radius);
      }
      ringOn = true;
    } else if (aimVisible) this._ringAt = null;
    this.reticle.update(dt, t, ringOn);
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

    // The telescope, if the player is pointing at one.
    //
    // Three conditions, and the third is the one that makes it feel deliberate.
    //
    //  1. The pointer is on a telescope. Found FIRST and then checked against
    //     its OWN camp, rather than the other way round: gating on "near any
    //     camp" would let a player parked at camp A click a telescope forty
    //     metres away in camp B and send the camera across the valley.
    //  2. They are parked at that telescope's camp.
    //  3. **The camera is already looking at that camp, not at the camper.**
    //
    // Rule 3 costs one comparison and buys the whole feel of the interaction.
    // The camera's focus is the game's existing statement of what the player is
    // paying attention to — clicking the camper takes it back, clicking the camp
    // gives it away, and driving takes it back always. Offering the eyepiece
    // while the shot is still on the camper means the click both swings the
    // focus and drops the player inside a telescope, which is two moves for one
    // input and reads as the game grabbing the camera. Requiring the camp to
    // have focus first makes it a sequence the player performed: look at the
    // camp, then step up to the telescope.
    //
    // It also removes a real trap. The camper and the camp are both click
    // targets and `_updateFocus` picks between them by which one the click is
    // CENTRED on; a telescope standing between the two could otherwise take a
    // click that was meant to bring the camera back to the car.
    const scope = this._scopeUnderPointer();
    if (scope && veh && this._focusCamp === scope.camp &&
        Math.hypot(veh.position.x - scope.camp.x, veh.position.z - scope.camp.z) < SITE_MAX + 6) {
      this.prompt.set(`${pickVerb()}&nbsp; look through the telescope`);
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

    // ── a finger that has lifted is not pointing at anything ────────────────
    // With a mouse this is never true. On touch it is true most of the time,
    // and it is what keeps the screen quiet: press to ask what is under your
    // thumb, hold to commit, lift and the game stops narrating.
    if (!pointing(input)) {
      this._packTarget = null;
      this._aim.ok = false;
      clearCampAim();
      this._say('');
      return;
    }

    // ── the boat has the pointer ────────────────────────────────────────────
    // Boat is registered BEFORE Camp (see SYSTEMS in main.js), so this claim
    // is same-frame: it is true while the pointer is over a boat, over a valid
    // launch aim at the water's edge, or while the player is aboard. One guard
    // keeps a shore click from also pitching a camp, and suppresses the
    // placement affordance the same way being parked at a camp does.
    if (this.ctx.systems?.boat?.pointerClaim) {
      this._suppressAim = true;
      clearCampAim();
      this._aim.ok = false;
      this.prompt.set('');
      return;
    }

    // ── you are AT a camp; you are not shopping for another one ─────────────
    //
    // The player: "I know we can allow another camp without packing up, but
    // that needs to be when you're farther away. Right now, I can't reselect
    // the fire because my cursor is 'make another campsite'."
    //
    // The separation rule existed already, but it was about the AIM POINT —
    // it refused ground that overlapped a camp and allowed everything else. So
    // parked ten metres from your own fire, most of the screen was still
    // offering to build, the placement ring was drawn over the meadow beside
    // the camp, and the one thing the player actually wanted to do there — put
    // the camera back on the fire — was competing with it.
    //
    // The honest rule is about where the CAMPER is, not where the pointer is.
    // Parked at a camp, you are using that camp: the pointer belongs to the
    // fire, the telescope and the pack-up. Making another one is something you
    // do somewhere else, and driving there is how you say so.
    const home = this._homeCamp(veh);
    if (home) {
      this._suppressAim = true;
      this._packTarget = this._campUnderPointer();
      clearCampAim();
      this._aim.ok = false;
      if (this._packTarget) {
        this._say(`${actVerb()}&nbsp; pack up this camp`);
        if (this._packPressed()) this._strike(this._packTarget);
      } else {
        // Nothing. No ring, no label, no cursor state — the absence IS the
        // answer, and a permanent "you cannot build here" caption parked over
        // your own camp is exactly the kind of chore list this game does not
        // have. (…the fire is the one exception, and `_say` is where it goes.)
        this._say('');
        // …except when they ask. Pressing the build key is the moment, and the
        // only moment, that a player wants to know why it did nothing.
        if (this._packPressed()) {
          this.ctx.systems?.hud?.toast?.('Too close to your camp — drive on to make another');
        }
      }
      return;
    }
    this._suppressAim = false;

    this._aimAt(veh);

    // Pointing at a camp is how you pack it up. `scoreSite` refuses a site that
    // overlaps an existing camp, and `_blocked` hands back which one — so the
    // rule falls out of the placement test rather than needing its own.
    if (this._packTarget) {
      this._say(`${actVerb()}&nbsp; pack up this camp`);
      // Never a plain click. A CLICK on a camp means "look at that one" and is
      // handled by `_updateFocus`; giving it a second meaning here would make
      // packing up something you could do by accident while choosing what to
      // look at. On touch that same split is a tap against a hold, which is why
      // `_packPressed` is a hold there and E here.
      if (this._packPressed()) this._strike(this._packTarget);
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
    //
    // `_hoverFire` is the same guard for the same reason, one target further
    // out: a click on a fire is the player choosing what the camera looks at,
    // and it must not also pitch a camp on the meadow behind it. E is left
    // alone here too — a gamepad player aims down the camera axis and would
    // otherwise lose the build key every time a fire drifted under the middle
    // of the screen.
    const onCar = this._place && this._pointerOnCamper();
    if (this._aim.ok && ((this._place && !onCar && !this._firePick) || input.justPressed('KeyE'))) {
      this._pitch();
    }
  }

  /**
   * "Pack this up" — the deliberate gesture, whichever device is asking.
   *
   * E with a keyboard; a HOLD on touch, never a tap, for the same reason E was
   * never a click: a tap on a camp is the player choosing what the camera looks
   * at, and striking a camp by accident while doing that is unrecoverable.
   */
  _packPressed() {
    const { input } = this.ctx;
    return input.justPressed('KeyE') || (touchCapable() && input.press.commit);
  }

  /**
   * The camp the camper is parked AT, or null.
   *
   * `radius + SITE_MAX + 4`, because that is the geometry of the feature read
   * backwards: a camp is built between SITE_MIN and SITE_MAX from wherever the
   * camper stood, so any camp within SITE_MAX of you is one you could have just
   * made from here — which is exactly the sense of "this is my camp". About
   * 28 m for a full camp, so driving thirty metres up the track gives the
   * placement affordance back.
   */
  _homeCamp(veh) {
    if (!veh) return null;
    let best = null, bestD = Infinity;
    for (const c of this.camps) {
      if (c.striking) continue;
      const d = Math.hypot(veh.position.x - c.x, veh.position.z - c.z);
      if (this._atCamp(veh, c) && d < bestD) { best = c; bestD = d; }
    }
    return best;
  }

  /**
   * The camp the pointer is on, by the same centred-on test the camera focus
   * uses — nearest miss as a fraction of each camp's own radius.
   *
   * Deliberately NOT `_packTarget` from the placement scorer. That is set as a
   * side effect of scoring a site, and once placement is suppressed no site is
   * scored, so the pack-up affordance would have vanished along with the ring.
   * Pointing at a camp to strike it has to work on its own terms.
   */
  _campUnderPointer() {
    // Where the pointer meets the GROUND, and then which camp that point is
    // inside. Not "does the ray pass near the camp's centre in 3D", which was
    // the first version and was wrong in a way that made the fix nearly
    // pointless: from a chase camera behind the camper, a ray to almost any
    // patch of lower screen passes within five metres of a camp eight metres
    // away, so every pointer position on the meadow claimed to be on the camp
    // and "E pack up this camp" replaced the build prompt everywhere instead
    // of leaving the neutral state the player asked for.
    //
    // The ground point cannot be argued with, and it costs the same
    // heightfield march `_aimAt` was doing before placement was suppressed.
    const g = this._pointerGround();
    if (!g) return null;
    let best = null, bestD = Infinity;
    for (const c of this.camps) {
      if (c.striking) continue;
      const d = Math.hypot(c.x - g.x, c.z - g.z);
      if (d < c.radius && d < bestD) { best = c; bestD = d; }
    }
    return best;
  }

  /**
   * The pointer ray, in `this._ray`.
   *
   * The mouse ray if the pointer is over the canvas, and the camera's own
   * forward ray otherwise — which is what a gamepad player gets, and what the
   * capture harness gets.
   *
   * Was six identical lines copied into four methods. That is fine until the
   * day one of them needs a depth as well as a direction, which is exactly what
   * `_fireBlocked` needed: three of the four copies would have been right and
   * the fourth would have been the one somebody edits next year.
   */
  _pointerRay() {
    const { input, camera } = this.ctx;
    const o = this._ray.o.copy(camera.position);
    const d = this._ray.d;
    if (input.mouse && Number.isFinite(input.mouse.x) && !window.__forceCamera) {
      d.set(input.mouse.x, input.mouse.y, 0.5).unproject(camera).sub(o).normalize();
    } else {
      camera.getWorldDirection(d);
    }
    return this._ray;
  }

  /** Where the pointer meets the heightfield, or null for the sky. */
  _pointerGround() {
    const { o, d } = this._pointerRay();
    return groundRay(this.ctx.world, o, d, 220);
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
   *     any real throttle hands it straight back.
   *
   * ── the bug rule 2 had, and the two lines that were causing it ─────────────
   *
   * Rule 2 was written down, commented, and did not work in the direction that
   * mattered. The method returned at the top the moment `_focusCamp` was null:
   *
   *     if (!focus || focus.striking) { rig.setFocus(null); ...; return; }
   *
   * — so once the camera was back on the car, the click test below it was
   * unreachable and there was no way to send it back to the camp. The very
   * trap the comment above warns about, guarded against in prose and then let
   * in by control flow. The click test now runs whether or not anything
   * currently has focus, which is the whole of the fix; everything else here
   * is about making the fire an honest target.
   *
   * Rule 3's second half — a distance release — was deleted outright in the
   * first pass at this and that was wrong. It was the WRONG DISTANCE, not a
   * distance too many: `SITE_MAX + 8`, 26 m, fires two metres inside
   * `_homeCamp`'s own 28 m, so parking on the far side of your own fire let
   * the camera go while the game still thought you were standing in the camp.
   * Removing it instead let focus be taken at any range at all, and the
   * consequence is not symmetric with the click that took it: once the camera
   * is on a camp far enough away, the CAMPER is off the screen and there is no
   * click that gets you back. The release is `_atCamp` now — the same
   * expression that bounds the pick and the same one `_homeCamp` uses — so a
   * camp can only hold the camera while you are standing at it, and while you
   * are standing at it both the fire and the camper are things you can point
   * at.
   */
  _updateFocus(veh) {
    const rig = this.ctx.systems?.cameraRig;
    if (!rig?.setFocus || !veh) return;
    // The eyepiece view owns the camera outright while it is open; moving the
    // boom's subject under it would have the rig cut to a different shot on the
    // frame the player steps back out.
    if (this.scope?.active) return;

    // Rule 3, first so nothing below can override it.
    const moving = Math.abs(veh.speed) > 1.2 || (this.ctx.input.axes.throttle ?? 0) > 0.05;
    if (moving) this._focusCamp = null;
    // `_focusCamp` is a camp record, not a flag. A struck camp clears it in
    // `_strike` too; this is the belt to that brace, so a camera cannot be left
    // pointing at ground where a camp used to be.
    if (this._focusCamp?.striking) this._focusCamp = null;
    // …and you have to still be at it. See the note above: this is the release
    // that makes the click bounded in both directions rather than one.
    if (this._focusCamp && !this._atCamp(veh, this._focusCamp)) this._focusCamp = null;

    // Photo mode composes with the free camera and the pointer is how it is
    // aimed, not how a subject is chosen. A click that silently moved
    // `_focusCamp` here would not be visible at all while composing and would
    // then decide where the camera cuts to on the way out.
    if (this.ctx.systems?.hud?.photo?.active) { rig.setFocus(this._focusTarget()); return; }

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
    // …and not while the boat owns the click (a boarding click, or any click
    // made from the water — a fire picked from mid-lake would drag the boom's
    // subject off the boat the player is sitting in).
    if (this._click && !moving && !this._justPitched
        && !this.ctx.systems?.boat?.pointerClaim) {
      // The fire first, and it beats everything.
      //
      // The camp spheres below are 5.2 m across and overlap the camper's, so
      // with several camps in sight "which camp did they mean" is decided by a
      // margin of a metre or two — fine for a shrug, wrong for an affordance
      // the player was shown. A 1.15 m sphere on the fire itself cannot be
      // ambiguous: the nearest two fires in this world are 9.8 m apart. If the
      // player was pointing at a fire, that fire is the answer, and the coarse
      // test never gets to disagree.
      const fire = this._firePick;
      if (fire) this._focusCamp = fire;
      else {
        // How far along the ray the camper's own triangles are. Infinity when
        // the pointer is not on it at all, which is most clicks.
        const carHit = this._camperHit();
        const car = this._rayMiss(veh.position, 2.8);
        // Every camp competes, not just the focused one, so clicking a second
        // camp walks the camera over to it — the same affordance in both
        // directions, which is the rule this whole method is built on.
        let best = null, bestMiss = car;
        for (const c of this.camps) {
          if (c.striking) continue;
          // Only a camp you are AT can take the camera, for the same reason
          // only a camp you are at can keep it: the release above uses
          // `_atCamp`, so without this the click sets focus and the next
          // frame's release takes it away again — a one-frame flicker that
          // does nothing, at 306 m, on a fire four pixels across.
          if (!this._atCamp(veh, c)) continue;
          const p = this._v.set(c.x, c.y + 0.4, c.z);
          // …but a camp standing BEHIND the camper cannot take a click that
          // landed on the camper's own geometry.
          //
          // This is a defect the sphere test always had and it is not small.
          // A camp is pitched 8-18 m out and the chase camera sits behind the
          // camper, so "the camp is directly behind the car" is not a corner
          // case, it is the shot the game gives you when you make a camp and
          // then look at it. Measured in that framing — parked, camp 8.5 m
          // beyond the camper, both projecting to the same pixel, 81 pointer
          // positions swept across the camper's body — the camp took the click
          // at 67 of the 77 positions that were ON the camper. The player
          // clicks the car and the camera does not come back.
          //
          // A 5.22 m sphere at 17 m loses to a 2.8 m sphere at 9 m on
          // normalised miss almost everywhere, which is exactly what the
          // "which is the click CENTRED on" rule is supposed to give you, and
          // here it gives the wrong answer because both are centred. Depth
          // breaks the tie, and the camper's own triangles are the one thing
          // in this system that can measure it — `_interact` reached the same
          // conclusion about the same object for the same reason.
          if (carHit < p.distanceTo(this.ctx.camera.position)) continue;
          const m = this._rayMiss(p, c.radius * 0.9);
          if (m < bestMiss) { bestMiss = m; best = c; }
        }
        if (bestMiss < Infinity) this._focusCamp = best;   // null = the camper won
      }
    }
    this._justPitched = false;

    rig.setFocus(this._focusTarget());
  }

  /** Where the boom should pivot: the focused camp's fire, or null for the camper. */
  _focusTarget() {
    const f = this._focusCamp;
    return f ? this._v.set(f.x, f.y + 0.55, f.z) : null;
  }

  /**
   * The fire the pointer is on, or null.
   *
   * A tight sphere on the fire itself rather than the camp — see `FIRE_PICK_R`
   * for why tight is what makes "clicking a particular fire picks that camp"
   * true rather than usually true.
   *
   * A striking camp is not a target: the click would land, focus would be
   * taken, and `_strike` would hand it straight back a moment later.
   */
  _fireUnderPointer() {
    let best = null, bestMiss = 1;
    for (const c of this.camps) {
      if (c.striking) continue;
      const miss = this._rayMiss(this._v.set(c.x, c.y + FIRE_PICK_LIFT, c.z), FIRE_PICK_R);
      if (miss < bestMiss) { bestMiss = miss; best = c; }
    }
    return best;
  }

  /**
   * The fire a click would actually be sent to — the raw pick above, with the
   * three things that make it honest rather than merely cheap.
   *
   * Computed ONCE per frame in `update` and read from `_firePick`, so the
   * cursor, the prompt, the ring, the click and the build-suppression are all
   * answering the same question. An affordance that highlights one thing and
   * clicks another is worse than no affordance.
   *
   *  1. **Range.** The camp has to be one you are AT, by the game's own
   *     definition of that — `_atCamp`, the same expression `_homeCamp` uses.
   *     The first version had no bound at all and would take a click at 306 m,
   *     where the fire is four pixels across. That is not the worst of it: once
   *     the camera is on a camp much further than this the CAMPER is off-screen
   *     and cannot be clicked, so the player is left on the camp with only the
   *     throttle to get back. An affordance whose reciprocal is unreachable is
   *     a trap, which is the thing this method's own docs are built around.
   *
   *  2. **The camper.** If its triangles are nearer along the ray, the click
   *     is the camper's. See `_camperHit`.
   *
   *  3. **The hillside.** A pure sphere test hits through anything. The march
   *     is only run once the cheap test has already found a fire, so the common
   *     frame pays nothing for it.
   *
   * Trees are NOT tested and a fire behind a trunk is still clickable. That is
   * a known and deliberate gap: the trunk field belongs to `CameraRig`
   * (`BoomClearance.TrunkField`), reaching into another system's private state
   * for a cursor is not a trade worth making, and a bole is 0.7 m wide against
   * a 1.15 m target — the fire is nearly always visible past it.
   */
  _fireTarget(veh) {
    const c = this._fireUnderPointer();
    if (!c || !veh) return null;
    if (!this._atCamp(veh, c)) return null;
    const fire = this._v.set(c.x, c.y + FIRE_PICK_LIFT, c.z);
    const depth = fire.distanceTo(this.ctx.camera.position);
    if (this._camperHit() < depth) return null;
    if (this._fireBlocked(depth)) return null;
    return c;
  }

  /**
   * Is the ground in front of the fire?
   *
   * `groundRay` marches the heightfield, which is what the reticle uses and
   * therefore what the player's eye has already agreed with. The margin is a
   * little under the pick radius: a ray that reaches a fire standing on flat
   * ground never meets that ground first — it is still above it right up to the
   * flame — so only a genuine rise between the two trips this.
   */
  _fireBlocked(depth) {
    const { o, d } = this._pointerRay();
    const g = groundRay(this.ctx.world, o, d, Math.min(depth, 220));
    return !!g && g.dist < depth - 1.0;
  }

  /**
   * Is the camper standing at this camp?
   *
   * `radius + SITE_MAX + 4` — see `_homeCamp`, which is the same question asked
   * about the nearest camp rather than about a given one. Hoisted so the three
   * places that need "you are at this camp" cannot drift apart: the placement
   * suppression, the fire pick's range, and the focus release below. The
   * previous release used `SITE_MAX + 8`, 26 m, which fired two metres INSIDE
   * this one — parking on the far side of your own fire let the camera go while
   * the game still thought you were standing in the camp.
   */
  _atCamp(veh, c) {
    return Math.hypot(veh.position.x - c.x, veh.position.z - c.z) < c.radius + SITE_MAX + 4;
  }

  /**
   * The fire to OFFER, which is not the same question as the one above.
   *
   * A fire the camera is already on is not an offer — the click would do
   * nothing and highlighting it would promise something. Neither is any fire
   * while the player is driving, because `_updateFocus` would refuse the click
   * (rule 3) and an affordance that lights up for a click that will be thrown
   * away is worse than no affordance.
   *
   * Null under a capture, for the reason the whole reticle is: eleven authors
   * judge art through the harness and none of them asked for a ring around the
   * camp. `campshot.mjs`'s assertion is what found the last one of these.
   *
   * Null in photo mode for the same reason with a different audience. The
   * player is composing a photograph; a ring drawn on the ground around the
   * camp would be in it, and the camera in photo mode is the free camera, so
   * pointing at a fire is how you AIM, not how you choose a subject.
   */
  _pickHoverFire(veh) {
    if (window.__forceCamera) return null;
    if (this.ctx.systems?.hud?.photo?.active) return null;
    if (this.scope?.active) return null;
    const moving = Math.abs(veh?.speed ?? 0) > 1.2 || (this.ctx.input.axes.throttle ?? 0) > 0.05;
    if (moving) return null;
    const c = this._firePick;
    return c && c !== this._focusCamp ? c : null;
  }

  /**
   * Say something, unless the fire has something better to say.
   *
   * Every prompt in this system goes through here so exactly one line of text
   * is chosen per frame. The alternative — `_interact` writing its line and
   * this feature writing over it afterwards — makes the two alternate every
   * frame, because `_interact` runs again next frame and puts its own line
   * back. One writer, decided from `_hoverFire`, which was decided once at the
   * top of `update`.
   *
   * The fire wins over the pack-up hint on purpose. It is a 1.15 m target
   * inside a 5.8 m camp, so the hint is one small mouse movement away, and of
   * the two things you can do to a camp you are pointing at, looking at it is
   * the reversible one.
   */
  _say(text) {
    this.prompt.set(this._hoverFire ? FIRE_PROMPT() : text);
  }

  /**
   * The pointer's own affordance.
   *
   * The camper has never had one — clicking it has worked since the camp
   * shipped and nothing on screen has ever said so — so there was no existing
   * behaviour here to copy, only a gap to stop widening. The fire gets the
   * three signals this game can afford: the ring around the camp, the line of
   * text, and this.
   *
   * Deliberately not extended to the camper in the same change. The only
   * honest "is the pointer on the camper" test is the geometry raycast in
   * `_pointerOnCamper` — the spheres were tried and both failed, see
   * `_interact` — and that runs on the frame of a click today. Running it every
   * frame for a cursor is a different cost with a different measurement behind
   * it, and it is not this change's to make.
   */
  _paintCursor() {
    const want = this._hoverFire ? 'pointer' : '';
    if (want === this._cursor) return;
    this._cursor = want;
    const el = this.ctx.renderer?.domElement;
    if (el) el.style.cursor = want;
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
  _pointerOnCamper() { return this._camperHit() < Infinity; }

  /**
   * How far along the pointer ray the camper's own triangles are, or Infinity.
   *
   * The distance, not a boolean, and that is the whole of the fix for the worst
   * regression this feature shipped with. `_updateFocus` let a fire win a click
   * outright, so a camper parked in front of its own fire — the ordinary case,
   * the camper is 8-18 m from the camp and the eye is behind the camper —
   * handed the click to the camp instead. Sixteen of forty-two pointer
   * positions that were ON the camper's geometry were claimed by the fire
   * behind it, and because a fire that already has focus is not offered, the
   * player got no cursor, no prompt and no effect: they clicked the car and
   * nothing happened. "Click the car to come back" is the affordance this whole
   * feature is the mirror of, and it was broken by the mirror.
   *
   * A boolean cannot fix it, because the ray hits the camper in BOTH cases —
   * clicking the camper in front of the fire, and clicking the fire in front of
   * the camper (the camp is often between the eye and the car once the camera
   * has walked over). Only the depth tells those apart.
   */
  _camperHit() {
    const rig = this.ctx.systems?.vehicle?.rig;
    if (!rig) return Infinity;
    const { o, d } = this._pointerRay();
    const ray = (this._caster ??= new THREE.Raycaster());
    ray.set(o, d);
    ray.far = 60;
    const hits = ray.intersectObject(rig, true);
    return hits.length ? hits[0].distance : Infinity;
  }

  _rayMiss(centre, r) {
    const { o, d } = this._pointerRay();
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
    const { world } = this.ctx;
    const { o, d } = this._pointerRay();
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
    this._say(s.ok
      ? `${placeVerb()}&nbsp; make camp here`
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
          // 0.15, not the 0.30 this started at. `size` is a radius, so the old
          // threshold handed the layout every rock over 60 cm across and left
          // it blind to everything from 30 to 60 — which is precisely the band
          // that is invisible on open dirt and unmistakable under a tent floor.
          // Anything smaller than 30 cm across is mostly planted in the ground
          // and is not worth constraining a placement for.
          if (inst.size < 0.15) continue;
          if (Math.hypot(inst.x - x, inst.z - z) > R + inst.size) continue;
          out.push({ x: inst.x, z: inst.z, r: inst.size * 0.8 });
        }
      }
    }
    return out;
  }

  /**
   * Read this frame's press.
   *
   * This used to track the gesture itself, sampling `mouse.down` once a frame —
   * which is why a phone could never pitch a camp: the synthetic mouse events a
   * browser fires after a tap all land inside a single task, so no frame ever
   * saw the button down. core/Input.js owns the press now and this reads the
   * two halves of it that the camp cares about.
   *
   *   `_click`  a PICK — look at that camp, look through that telescope. Still
   *             consumed mid-frame by the scope branch (`this._click = false`),
   *             which is why it stays a field rather than a call.
   *   `_place`  a COMMIT to a spot — pitch here, pack that up. On touch this is
   *             the release of a hold and never a stray tap; with a mouse it is
   *             the same click it always was.
   */
  _pollClick() {
    this._click = picked(this.ctx.input);
    this._place = placed(this.ctx.input);
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
      // Rolled here, off the site's own rng, so it is decided before anything
      // else consumes from that stream and stays stable for the site.
      hasDog: rnd() < DOG_CHANCE, dog: null,
    };
    camp.root.name = 'camp_props';
    this.root.add(camp.root);
    this.camps.push(camp);

    const wind = this.ctx.systems?.weather?.windDir
              ?? this.ctx.systems?.grass?.windDir
              ?? new THREE.Vector2(0.86, 0.51);

    // ── the layout runs FIRST, and the ground is built around its answer ────
    //
    // It used to be the other way round, and that ordering is what let the
    // grass stand up inside the tent. The dirt derives its own outline by
    // bisecting `campCoverAt`, so whatever the clearing field says is bare at
    // build time is what the mesh covers — and at build time the field knew
    // about the clearing only, because the tent had not been placed yet. Give
    // the tent its pad first and the dirt follows it for free, exactly as
    // camp_ground's decision 1 promises: one shape function, two readers.
    //
    // The rng ordering this inverts was deliberate, and inverting it is an
    // improvement rather than a cost. camp_ground draws a fixed count from the
    // shared stream precisely so that retuning its scatter would not re-roll
    // where the tent goes; running it after the layout means it cannot, by
    // construction, whatever it draws.
    const items = layoutCamp(rnd, world, x, z, {
      radius: R, small: camp.small, windDir: wind,
      obstacles: this._obstacles(x, z),
    });
    camp.pad = tentPad(items);

    // Publish the clearing BEFORE building the dirt: the mesh reads
    // `campCoverAt` back to shape its own alpha, so the two are the same edge
    // by construction rather than by two authors agreeing on a formula.
    this._publishSlots();
    camp.ground.build(x, z, R, rnd, camp.feather, camp.pad ? [camp.pad] : []);

    if (typeof camp.fire?.rebuild === 'function') {
      // Optional and additive: a Firepit that can re-roll its stones for a new
      // site gets to, and one that cannot is simply reused as it is.
      try { camp.fire.rebuild(rnd); } catch (e) { console.warn('[camp] fire.rebuild threw', e); }
    }
    camp.fire?.setPosition(new THREE.Vector3(x, y + 0.02, z));
    // The pit lies along the ground; the flame does not. `setOrientation` is
    // the fire's own split — see the note on it in camp_fire.js. Guarded so an
    // older Firepit without it still works, just level.
    if (camp.fire?.setOrientation) {
      standOn(world, x, z, 0, 1, this._q);
      camp.fire.setOrientation(this._q);
    }

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
    posthog.capture('camp_pitched', {
      camp_radius: camp.radius,
      camp_small: camp.small,
      camp_has_dog: camp.hasDog,
      camps_active: this.camps.length,
    });
    return camp;
  }

  /**
   * Give a camp its dog.
   *
   * The props are the dog's obstacle set, and they exist by now because the
   * queue drains during the raise and this only runs once the raise is done.
   * Each is its own footprint plus a little, so the dog walks round the cooler
   * rather than through it — see `CampDog._orbitPoint`, which is a two-pass
   * relaxation rather than a solver, because the failure it prevents is a dog
   * clipping a chair and the cost of a real one is not worth paying for that.
   */
  _makeDog(camp) {
    // ── measure the props, do not ask them ────────────────────────────────
    //
    // `userData.footprint` is the number `_buildNext` uses to decide how far to
    // LIFT a prop out of the ground, and it is not a clearance radius. Measured
    // against the real bounds: the tent declares 1.45 and is actually 3.3 m
    // across, the telescope declares 0.29 and is actually 1.14. Trusting it
    // let the dog walk through the side of the tent — visibly, in game, while
    // an obstacle test that used the same wrong number reported no overlap at
    // all. So take the bounding box of what was actually built.
    const box = new THREE.Box3();
    const size = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const obstacles = camp.props.map((p) => {
      box.setFromObject(p.obj);
      box.getSize(size); box.getCenter(mid);
      return {
        x: mid.x, z: mid.z,
        // Half the widest horizontal extent, plus half a dog.
        r: Math.max(size.x, size.z) * 0.5 + 0.20,
      };
    });
    try {
      camp.dog = new CampDog(camp.root, camp, camp.rnd, this.ctx.world, {
        obstacles,
        // The dog lies down ON THE DIRT, and the dirt is not the heightfield:
        // it is the drawn lattice plus the skin's own lift. Rest planning has
        // to measure the surface the player can see or the dog reads as
        // buried to the brisket — see CampGround.surfaceAt.
        surfaceAt: (sx, sz) => camp.ground.surfaceAt(sx, sz),
      });
    } catch (e) {
      // A dog that fails to build must not take the camp with it.
      console.warn('[camp] dog failed to build', e);
      camp.hasDog = false;
    }
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

    // Lift whatever the tilt still leaves under the ground. Capped at 8 cm:
    // beyond that the cure is worse than the disease, because a lift big
    // enough to rescue a badly-tilted prop opens a visible gap on its downhill
    // side, and a floating tent is not an improvement on a buried one. This is
    // a finishing touch on a tilt that is already nearly right — if a prop
    // needs more than 8 cm, its `tilt` is wrong and that is the thing to fix.
    const foot = obj.userData?.footprint ?? it.foot ?? 0.5;
    obj.position.y += Math.min(groundLift(this.ctx.world, it.x, it.z, this._q, foot), 0.08);
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
      // Whether this prop was visible last frame, so `_applyRaise` can sound
      // the edge. Explicit rather than left undefined: `shown !== p.shown`
      // would otherwise be true on the first comparison and sound a pop-OUT
      // for a prop that has never been seen.
      shown: false,
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
      .map(({ c }) => {
        const k = smoothstep(0, 0.55, c.raise);
        return {
          x: c.x, z: c.z, feather: c.feather,
          radius: c.radius * k,
          // The tent's pad opens on the same curve, so the ground under it
          // sweeps clear with the rest rather than snapping bare at the end.
          pad: c.pad
            ? { x: c.pad.x, z: c.pad.z, radius: c.pad.radius * k, feather: c.pad.feather * k }
            : null,
        };
      });
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

    // ── tell the grade where the fire is ────────────────────────────────────
    //
    // The night grade rotates warm pixels onto a blue-violet axis, and without
    // this it does it to the firelight too — see the header of Hearth.js for
    // why that is the defect and not the fix. The record is published from
    // here rather than from Firepit because THIS is the method that already
    // knows which of several fires is the one the viewer is standing at, which
    // is the same question the mask has to answer.
    //
    // Strength rides on the light's own intensity, normalised against a fire
    // burning normally after dark, so it eases up with the build-in and dies
    // with the fire. It is damped rather than read raw: the intensity carries
    // the flame's flicker, and a mask edge that flickers is a ring of colour
    // pulsing on the ground several metres from anything that is moving. The
    // fire may flicker; the fact that there IS a fire may not.
    const want = near ? clamp01(this.fireLight.intensity / HEARTH_FULL) : 0;
    this._hearthS = damp(this._hearthS, want, 6, dt);
    if (this._hearthS > 0.002) {
      const p = this.fireLight.position;
      setHearth(p.x, p.y, p.z, this.fireLight.distance, this._hearthS);
    } else {
      clearHearth();
    }
  }

  /**
   * Drive the build-in.
   *
   * The clearing radius eases open ahead of the props, which is what makes the
   * sequence read as "the ground was cleared, then things were put on it"
   * rather than as a group fading in. Props scale up from their own base, with
   * a small overshoot — a prop that settles is a prop that was set down.
   *
   * `sound` is off by default and passed only from the two call sites in
   * `update` that are actually animating something. Every other caller either
   * has no props yet (`_pitch`), has just added one that has not appeared yet
   * (`_buildNext`), or is the harness slamming a finished camp into place
   * (`pitchAt`) — and that last one would otherwise fire eight cues on one
   * frame every time `campshot.mjs` took a picture.
   */
  _applyRaise(camp, sound = false) {
    const k = camp.raise;
    camp.ground?.setReveal(smoothstep(0.02, 0.62, k));
    camp.fire?.setReveal(smoothstep(0.30, 0.95, k));
    // The clearing and the fire are objects too, and they bracket the whole
    // event: earth first, fire last on the way in, and the reverse on the way
    // out. Their thresholds are the same numbers the reveal above uses, so the
    // cue can never drift away from the picture it belongs to.
    this._cueAt(camp, 'ground', k > 0.02, sound);
    this._cueAt(camp, 'fire', k > 0.30, sound);

    for (const p of camp.props) {
      const t = clamp01((k - p.delay) / Math.max(0.08, 1 - p.delay));
      // Back-ease with a gentle overshoot; never below zero, because a prop
      // that inverts for one frame is a flash of inside-out geometry.
      const e = t <= 0 ? 0 : 1 - Math.pow(1 - t, 2.2) * (1 - 0.14 * Math.sin(t * Math.PI));
      const shown = t > 0.001;
      // The ease is steep at the start — a prop is at two thirds of its size
      // within 0.15 of its own `t` — so the frame it becomes visible IS the
      // frame it arrives, and there is no better moment to put the sound on.
      if (sound && shown !== p.shown) {
        this.ctx.systems?.audio?.camp?.cue(p.item.kind, { x: p.item.x, z: p.item.z, out: !shown });
      }
      p.shown = shown;
      p.obj.visible = shown;
      p.obj.scale.setScalar(Math.max(0.001, e));
    }
  }

  /**
   * Edge-trigger one non-prop cue — the clearing, or the fire.
   *
   * These have no per-prop record to hang a flag on, so the camp carries the
   * last state each one was seen in. Edge-triggered rather than level-
   * triggered because `_applyRaise` runs every frame of the raise and
   * `k > 0.02` is true for nearly all of them.
   *
   * The state is tracked on EVERY call, and only *sounded* when `sound` is set.
   * Both halves of that matter, and each was a bug on its own:
   *
   *  - Tracking only when sounding lost the clearing's own cue below about
   *    30 fps. `_pitch` leaves the camp at raise 0, so the first frame the
   *    update loop sees is already at `dt / 1.15` — which is 0.014 at 60 fps
   *    and 0.035 at 25 fps. Above the 0.02 threshold on a slow machine, so the
   *    first observation WAS the edge, and a first observation is never
   *    allowed to be one. The clearing simply never spoke.
   *  - Sounding on every call would make `pitchAt(instant)` fire the lot in
   *    one frame, and would then have the camp it left at raise 1 announce its
   *    fire *lighting* on the first frame of the player's strike.
   *
   * Tracking always, sounding selectively, gets both: the harness's instant
   * camp records `true` silently, so striking it later reads as the falling
   * edge it actually is.
   */
  _cueAt(camp, kind, on, sound) {
    const was = (camp.sounded ??= {})[kind];
    if (was === on) return;
    camp.sounded[kind] = on;
    if (!sound || was === undefined) return;
    this.ctx.systems?.audio?.camp?.cue(kind, { x: camp.x, z: camp.z, out: !on });
  }

  /**
   * Take a camp down.
   *
   * `now` skips the animation, which is what the cap-recycle and the harness
   * want; the player's own pack-up runs `camp.striking` and comes back here
   * once the raise has eased to zero.
   */
  _strike(camp, now = false) {
    if (!now) {
      camp.striking = true;
      posthog.capture('camp_struck', {
        camp_radius: camp.radius,
        camp_small: camp.small,
        camps_remaining: this.camps.length - 1,
      });
      return;
    }

    // Never leave the player inside a prop that has been packed away. The
    // eyepiece view owns the camera outright, so if the geometry goes the view
    // has to go with it — and only if the open telescope was in THIS camp.
    if (this.scope?.active && camp.props.some((p) => p.obj === this.scope.subject)) {
      this.scope.leave();
    }

    // The dog goes with the camp. Its geometry is a shared prototype and is NOT
    // disposed here — only its own material and its place in the scene graph.
    camp.dog?.dispose();
    camp.dog = null;

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
    // Not left to the damped follower in `_carryFireLight`: a teardown may be
    // the last thing that happens before update() stops being called, and a
    // hearth mask that outlives every fire is a warm hole in the night grade
    // sitting over an empty meadow.
    this._hearthS = 0;
    clearHearth();
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
    disposeDogProtos();
  }
}
