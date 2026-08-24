// ─────────────────────────────────────────────────────────────────────────────
//  Boat — launch a canoe or kayak from a lakeshore, paddle it, moor it.
//
//  The player's loop: park near a big-enough lake, click near the water's edge
//  to set a boat down beached at the shoreline, click the boat to board it
//  (camera follows, W/S paddle, A/D sweep-turn — the same axes the camper
//  reads, so touch controls work unchanged), click the camper to drive again.
//  The boat stays moored where it was left; clicking it again re-boards.
//
//  ── how it sits in the frame ────────────────────────────────────────────────
//  Registered BETWEEN Vehicle and Camp (see SYSTEMS in main.js): it reads
//  `vehicle.brakeHold` the frame it is written, and publishes `pointerClaim`
//  BEFORE Camp runs, so Camp's click arbitration guard reads a same-frame
//  claim — one click can never launch a boat AND pitch a camp.
//
//  Controls ownership: boarding sets `vehicle.controlsHeldBy = 'boat'`, which
//  Vehicle honours by feeding its physics zeros (throttle/brake/steer never
//  reach the camper, and the brake hold cannot release). Cleared
//  UNCONDITIONALLY on exit and in dispose — photo mode's discipline.
//
//  Camera: `rig.setFollow(duck)` swaps the chase boom's subject vehicle for a
//  duck-typed record driven from the boat's analytic physics. No Rapier body —
//  see boat_physics.js for why that would fall through the world.
//
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { clamp01 } from '../core/MathUtils.js';
import { ClickTracker, pointerRay, rayMiss, objectHit } from '../core/Pointer.js';
import { groundRay, siteRng } from '../camp/camp_site.js';
import { CampPrompt } from '../camp/camp_ui.js';
import { waterRay, sdfGrad, shoreSnap, validateLaunch, MAX_LAUNCH_DIST } from './boat_site.js';
import { BoatPhysics } from './boat_physics.js';
import { buildCanoe, CANOE_DIM } from './boat_canoe.js';
import { buildKayak, KAYAK_DIM } from './boat_kayak.js';

// Top speeds, per the design: a kayak is faster and twitchier than a canoe.
const MAX_SPEED = { canoe: 3.2, kayak: 3.8 };

// How many boats may exist at once. Spawning a third sinks the oldest —
// recycle, never refuse, same policy as the camp cap.
const MAX_BOATS = 2;

// How long the launch ease-in runs, and how long a sunk boat takes to go.
const SPAWN_TIME = 0.8;
const SINK_TIME = 1.5;

// The click has to land near the water's EDGE. Without this gate the shore
// snap would walk any meadow click within sight of a lake onto the waterline
// and hijack ordinary camp placement. sdf is signed metres to the waterline
// (positive inside the water), so this reads "on the water, or within 6 m of
// it on land".
const NEAR_SHORE_SDF = -6;

// How long the camera glances at a fresh launch before the player gets it
// back (only when nothing else holds focus — see lateUpdate).
const LAUNCH_FOCUS = 2.2;

// The mounted camera: eye height above the waterline at the stern-third
// mount, and how far along the hull (as a fraction of length) the mount sits
// behind the hull centre. A short chase boom was tried first and still read
// as "camera behind the canoe" (user, 2026-08-23) — with no paddler model the
// honest fix is to put the eye ON the boat, riding the back third of the
// deck and looking over the bow.
const CAM_MOUNT_AFT = 0.38;    // fraction of hull length behind centre
const CAM_MOUNT_UP = 1.12;     // metres above the waterline — a seated eye
const CAM_LOOK_UP = 0.5;       // look target height over the water ahead
// The wheel zooms about the mount: 1.0 is the seated pose above (the resting
// middle of the range), inward leans toward the coaming, outward eases a few
// metres off the stern without ever returning to the old drone framing.
const CAM_ZOOM_MIN = 0.55;
const CAM_ZOOM_MAX = 2.6;

// Prewarm hold, matching Camp's pattern: enough frames for the main and
// shadow passes to have drawn the warm props, all under the loading screen.
const PREWARM_FRAMES = 8;

export class Boat extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Boat';
    this.loadLabel = 'Waxing the hulls';

    this.boats = [];          // { kind, colorway, group, phys, spawnT, sinkT }
    this.active = false;      // player aboard (published for the audio layer)
    this.current = null;      // { kind, colorway, x, z, heading, speed, group } | null
    this.pointerClaim = false;

    this._aboard = null;      // the boat record being paddled, or null
    this._kind = 'canoe';     // K toggles; remembered for the session
    this._script = null;      // harness drive() override
    this._focusT = 0;         // seconds left of the launch glance
    this._focusP = new THREE.Vector3();
    this._cursorNow = '';
    this._camP = new THREE.Vector3();   // mounted-camera eye, damped
    this._camL = new THREE.Vector3();   // mounted-camera look target, damped
    this._camSnap = true;
    this._camZoom = 1;                  // 1 = the seated mount; wheel moves it
    this._camZoomT = 1;
    this._ray = { o: new THREE.Vector3(), d: new THREE.Vector3() };
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._e = new THREE.Euler();

    // The camera-follow duck: everything CameraRig reads off a subject
    // vehicle, driven from the boat's physics while aboard.
    this._duck = {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      forward: new THREE.Vector3(0, 0, 1),
      quaternion: new THREE.Quaternion(),
      heading: 0, speed: 0, up: 1,
      wheels: [],
      teleportSeq: 0,
      phys: { ready: true, lateral: 0, airborne: false },
    };
  }

  async init() {
    const { scene } = this.ctx;
    this.root = new THREE.Group();
    this.root.name = 'boats';
    scene.add(this.root);

    this.click = new ClickTracker(this.ctx.input);
    this.prompt = new CampPrompt();

    this.models = {
      canoe: { build: buildCanoe, dim: CANOE_DIM, placeholder: false },
      kayak: { build: buildKayak, dim: KAYAK_DIM, placeholder: false },
    };

    this._prewarm();

    // Harness surface — the visual-critic pipeline drives everything through
    // this. Nothing here runs on its own.
    window.__boat = this;
  }

  /**
   * Link the boats' shaders under the loading screen, Camp-style: build one of
   * each, harvest BEFORE compiling (Atmosphere/Stylize chain onBeforeCompile,
   * which changes the program cache key — see Camp._prewarm for the full
   * argument), then hold the props in the scene for a few real frames so the
   * shadow pass compiles its depth variants too.
   */
  _prewarm() {
    const { scene, renderer, camera } = this.ctx;
    const t0 = performance.now();
    const warm = new THREE.Group();
    warm.name = 'boat_prewarm';
    warm.scale.setScalar(0.03);
    const entries = [];
    try {
      const rnd = siteRng(0, 0, 2);
      for (const kind of ['canoe', 'kayak']) {
        const g = this.models[kind].build(rnd, { colorway: 0 });
        g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
        warm.add(g);
        entries.push({ group: g, placeholder: this.models[kind].placeholder });
      }
      scene.add(warm);
      this.ctx.atmosphere?.harvest?.();
      this.ctx.stylize?.harvest?.();
      renderer.compile(scene, camera);
      this._warm = { group: warm, entries, frames: 0 };
    } catch (e) {
      console.warn('[boat] prewarm failed; the first launch will hitch', e);
      warm.parent?.remove(warm);
    }
    console.log(`[boat] prewarm built in ${(performance.now() - t0).toFixed(0)} ms`);
  }

  _finishPrewarm() {
    const w = this._warm;
    const { camera } = this.ctx;
    // In front of the lens and buried — inside both the main and the shadow
    // frusta, invisible twice over. Same placement as Camp's.
    const d = this._v.set(0, 0, -1).applyQuaternion(camera.quaternion);
    w.group.position.set(
      camera.position.x + d.x * 6,
      camera.position.y + d.y * 6 - 3.5,
      camera.position.z + d.z * 6,
    );
    if (++w.frames < PREWARM_FRAMES) return;
    this._warm = null;
    w.group.parent?.remove(w.group);
    for (const { group, placeholder } of w.entries) {
      group.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry?.dispose?.();
        // Placeholder builds its own materials per call, so they die with the
        // warm prop; the real modules share a module-scope set (boat_materials)
        // that must survive for the session — that is what the prewarm cached.
        if (placeholder) o.material?.dispose?.();
      });
    }
  }

  // ── frame ─────────────────────────────────────────────────────────────────

  update(dt, t) {
    if (this._warm) this._finishPrewarm();
    this.click.poll(dt);
    const veh = this.ctx.systems?.vehicle;
    const rig = this.ctx.systems?.cameraRig;

    // Every boat advances: the active one on the player's paddle, moored ones
    // on zero input (they still bob, still get nudged off a bank by the shore
    // pressure, still cost a handful of field samples each).
    for (const b of this.boats.slice()) {
      if (b.sinkT !== null) {
        b.sinkT += dt;
        b.group.position.y -= dt * 0.55;
        b.group.rotation.z += dt * 0.25;
        if (b.sinkT >= SINK_TIME) this._remove(b);
        continue;
      }
      if (b !== this._aboard) b.phys.step(dt, t, {});
      b.spawnT = Math.min(1, b.spawnT + dt / SPAWN_TIME);
      this._pose(b, t);
    }

    const photographing = !!this.ctx.systems?.hud?.photo?.active;
    const scoped = !!this.ctx.systems?.camp?.scope?.active;
    const parked = !!veh?.enabled && !!veh.brakeHold && !photographing && !scoped;

    let claim = false;
    if (this._aboard) {
      claim = true;
      this._paddle(dt, t, veh, rig);
    } else if (parked && !window.__forceCamera) {
      claim = this._shoreside(veh);
    } else {
      this._say('');
      this._cursor('');
    }
    this.pointerClaim = claim;
    this.active = !!this._aboard;

    this._publish();
  }

  lateUpdate(dt) {
    // The launch glance. Done in lateUpdate so it lands AFTER Camp's per-frame
    // setFocus (Camp has no lateUpdate) and before CameraRig reads it — and
    // only while Camp itself holds no focus, so it never fights the fire shot.
    if (this._focusT > 0 && !this._aboard) {
      this._focusT -= dt;
      const rig = this.ctx.systems?.cameraRig;
      if (this.ctx.systems?.camp?._focusCamp) { this._focusT = 0; return; }
      if (this._focusT > 0) rig?.setFocus?.(this._focusP);
      else rig?.setFocus?.(null);        // Camp re-asserts its own next frame
    }
  }

  // ── shoreside: aiming, launching, boarding ────────────────────────────────

  /** Returns whether the boat system claims the pointer this frame. */
  _shoreside(veh) {
    const { world, camera, input } = this.ctx;
    const ray = pointerRay(input, camera, this._ray);

    // The camper's own triangles outrank everything — a click on the camper is
    // Camp's "look back at the car", never a boarding or a launch.
    const carHit = objectHit(ray, veh?.rig, 60);

    // ── over a moored boat? ───────────────────────────────────────────────
    let over = null, bestMiss = 1;
    for (const b of this.boats) {
      if (b.sinkT !== null) continue;
      const dim = b.group.userData.dim ?? this.models[b.kind].dim;
      const c = this._v.set(b.phys.x, b.phys.y + 0.25, b.phys.z);
      const depth = c.distanceTo(camera.position);
      if (carHit < depth) continue;
      const miss = rayMiss(ray, c, dim.length * 0.5);
      if (miss < bestMiss) { bestMiss = miss; over = b; }
    }
    if (over) {
      this._say(`<b>click</b>&nbsp; board the ${over.kind}`);
      this._cursor('pointer');
      if (this.click.clicked) this.board(this.boats.indexOf(over));
      return true;
    }

    // ── aiming at the water's edge? ───────────────────────────────────────
    if (carHit < Infinity) { this._say(''); this._cursor(''); return false; }
    const g = groundRay(world, ray.o, ray.d, 220);
    const w = waterRay(world, ray.o, ray.d, 220);
    const hit = (g && w) ? (g.dist < w.dist ? g : w) : (g ?? w);
    if (!hit) { this._say(''); this._cursor(''); return false; }
    // Near the shoreline only — see NEAR_SHORE_SDF. Clicks on open meadow
    // stay Camp's, however close the lake is.
    if (sdfGrad(world, hit.x, hit.z).sdf < NEAR_SHORE_SDF) {
      this._say(''); this._cursor(''); return false;
    }

    const v = validateLaunch(world, hit.x, hit.z, veh);
    // Kept for the harness: what the pointer path actually computed this frame.
    this._lastAim = { hx: hit.x, hz: hit.z, water: hit === w, ...v };
    if (input.justPressed('KeyK')) this._kind = this._kind === 'canoe' ? 'kayak' : 'canoe';
    if (v.ok) {
      const other = this._kind === 'canoe' ? 'kayak' : 'canoe';
      this._say(`<b>click</b>&nbsp; launch a ${this._kind} here&ensp;<b>K</b>&nbsp; ${other} instead`);
      this._cursor('pointer');
      if (this.click.clicked) {
        // Launch AND board in one act (user direction, 2026-08-23): you put a
        // boat in, you're in the boat — W paddles immediately, no second
        // click. board() cancels spawn()'s launch glance.
        const nb = this.spawn(v.x, v.z, { kind: this._kind, heading: v.heading, y: v.y });
        if (nb) this.board();
      }
      return true;
    }
    // A gentle reason, not silence — the reject the spec calls out is the
    // far side of the lake ("too far from the camper").
    this._say(`no boat here — ${v.reason}`);
    this._cursor('');
    return true;
  }

  // ── aboard ────────────────────────────────────────────────────────────────

  _paddle(dt, t, veh, rig) {
    const b = this._aboard;
    const ax = this.ctx.input.axes;
    let fwd = ax.throttle, back = ax.brake, turn = ax.steer;
    if (this._script) {
      fwd = clamp01(this._script.speed);
      back = clamp01(-this._script.speed);
      turn = this._script.turn ?? 0;
    }
    b.phys.step(dt, t, { fwd, back, turn });
    this._pose(b, t);
    this._animatePaddle(b, dt);

    // Feed the camera duck. The pivot sits over the boat's BACK THIRD, a hair
    // above the deck: with the close boarding zoom the camera rides just off
    // the stern with the bow filling the lower frame — "you are in the boat",
    // not a ghost hull observed from a chase drone (user direction,
    // 2026-08-23).
    const p = b.phys;
    const d = this._duck;
    const L = (b.group.userData.dim ?? this.models[b.kind].dim).length;
    d.forward.set(Math.sin(p.heading), 0, Math.cos(p.heading));
    d.position.set(
      p.x - d.forward.x * (L / 3),
      p.y + 0.35,
      p.z - d.forward.z * (L / 3));
    d.heading = p.heading;
    d.speed = p.speed;
    d.velocity.copy(d.forward).multiplyScalar(p.speed);
    d.quaternion.copy(b.group.quaternion);
    d.phys.lateral = p.yawRate * p.speed * 2.0;   // the chase bank reads this

    // ── leaving ───────────────────────────────────────────────────────────
    const { camera, input } = this.ctx;
    if (this.click.clicked) {
      const ray = pointerRay(input, camera, this._ray);
      // Generous reach: the camper can be most of a lake away.
      if (objectHit(ray, veh?.rig, 300) < Infinity) { this.exit(); return; }
    }
    if (p.beached && input.justPressed('KeyE')) { this._comeAshore(b); return; }

    this._say(p.beached
      ? '<b>E</b>&nbsp; step ashore&ensp;<b>click camper</b>&nbsp; drive'
      : '<b>click camper</b>&nbsp; drive');
    this._cursor('');
    void rig;
  }

  /** Dip the stowed paddle alternately with the stroke — a small rotation on
   *  top of the model's own stowed pose, so it works for either author's rig. */
  _animatePaddle(b, dt) {
    const u = b.group.userData;
    const p = b.phys;
    const env = p._stroking && p._phase < 0.35 ? Math.sin((p._phase / 0.35) * Math.PI) : 0;
    if (u.paddles) {
      // Canoe: a paddle per side. Only the stroke side's paddle dips — a
      // local-Z roll of −angle drops the blade (local +X) for both, since the
      // port one is yaw-mirrored. Stroke rings emit to port when _side > 0
      // (see onStroke's left-vector), so the paddle mapping matches.
      if (!b.paddleBase) {
        b.paddleBase = {
          starboard: u.paddles.starboard.quaternion.clone(),
          port: u.paddles.port.quaternion.clone(),
        };
      }
      const active = p._side > 0 ? 'port' : 'starboard';
      for (const k of ['port', 'starboard']) {
        this._q2.setFromAxisAngle(this._v.set(0, 0, 1), k === active ? -env * 0.5 : 0);
        u.paddles[k].quaternion.copy(b.paddleBase[k]).multiply(this._q2);
      }
    } else if (u.paddle) {
      // Kayak: one double blade, alternating tips.
      if (!b.paddleBase) b.paddleBase = u.paddle.quaternion.clone();
      this._q2.setFromAxisAngle(this._v.set(0, 0, 1), p._side * env * 0.45);
      u.paddle.quaternion.copy(b.paddleBase).multiply(this._q2);
    }
    void dt;
  }

  // ── shared plumbing ───────────────────────────────────────────────────────

  /** Write the group transform from the physics + the spawn ease. */
  _pose(b, t) {
    const p = b.phys;
    b.group.position.set(p.x, p.y, p.z);
    this._e.set(-p.pitch, p.heading, p.roll, 'YXZ');
    b.group.quaternion.setFromEuler(this._e);
    if (b.spawnT < 1) {
      // Back-ease with a small overshoot — set down, not faded in.
      const k = b.spawnT;
      const e = 1 - Math.pow(1 - k, 2.2) * (1 - 0.14 * Math.sin(k * Math.PI));
      b.group.scale.setScalar(Math.max(0.001, e));
    } else if (b.group.scale.x !== 1) b.group.scale.setScalar(1);
    void t;
  }

  /** Wake + boat state, published every frame for the water and audio agents.
   *  Optional-chained throughout so this works before either lands. */
  _publish() {
    const water = this.ctx.systems?.water;
    const b = this._aboard ?? this.boats.find((x) => x.sinkT === null) ?? null;
    if (b) {
      const p = b.phys;
      const dim = b.group.userData.dim ?? this.models[b.kind].dim;
      const speed = b === this._aboard ? p.speed : 0;
      water?.setBoat?.({ x: p.x, z: p.z, heading: p.heading, speed, beam: dim.beam });
      this.current = {
        kind: b.kind, colorway: b.colorway,
        x: p.x, z: p.z, heading: p.heading, speed, group: b.group,
      };
    } else {
      water?.setBoat?.(null);
      this.current = null;
    }
  }

  _cue(kind, data) {
    this.ctx.systems?.audio?.boat?.cue?.(kind, data);
  }

  _say(text) { this.prompt.set(text); }

  _cursor(want) {
    if (want === this._cursorNow) return;
    this._cursorNow = want;
    const el = this.ctx.renderer?.domElement;
    if (el) el.style.cursor = want;
  }

  _remove(b) {
    const i = this.boats.indexOf(b);
    if (i >= 0) this.boats.splice(i, 1);
    if (this._aboard === b) this.exit();
    this.root.remove(b.group);
    b.group.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
  }

  // ── the verbs (also the harness API) ──────────────────────────────────────

  /**
   * Put a boat down beached at the shore. Player path arrives here with a
   * validated pose; the harness path (`spawnAt`) passes `snap: true` to
   * bypass validity and snap the point to the nearest water instead.
   */
  spawn(x, z, opts = {}) {
    const { world } = this.ctx;
    const kind = opts.kind ?? this._kind;
    let sx = x, sz = z, heading = opts.heading, y = opts.y;
    if (opts.snap || heading === undefined) {
      const s = shoreSnap(world, x, z);
      sx = s.x; sz = s.z;
      heading = Math.atan2(s.gx, s.gz);
      y = world._water?.levelAt?.(sx, sz) ?? world.getWaterHeight(sx, sz) ?? world.getHeight(sx, sz);
    }

    // Deterministic colourway from the launch position — same spot, same boat.
    const rnd = siteRng(sx, sz, this.ctx.world?.seed ?? 0);
    const colorway = opts.colorway ?? Math.floor(rnd() * 3);

    // The cap: recycle the oldest, never refuse. Never the one being sat in.
    while (this.boats.filter((bb) => bb.sinkT === null).length >= MAX_BOATS) {
      const old = this.boats.find((bb) => bb.sinkT === null && bb !== this._aboard)
               ?? this.boats.find((bb) => bb.sinkT === null);
      if (!old) break;
      old.sinkT = 0;
      this.ctx.systems?.hud?.toast?.(`Your oldest ${old.kind} slipped under`);
    }

    const model = this.models[kind] ?? this.models.canoe;
    let group;
    try { group = model.build(rnd, { colorway }); }
    catch (e) { console.error('[boat] model builder threw', e); return null; }
    group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.root.add(group);

    const dim = group.userData.dim ?? model.dim;
    const phys = new BoatPhysics(this.ctx.world, dim,
      { maxSpeed: MAX_SPEED[kind] ?? 3.2, bobSeed: rnd() * 10 });
    phys.place(sx, sz, heading ?? 0);
    const b = { kind, colorway, group, phys, spawnT: 0, sinkT: null, paddleBase: null };

    // Stroke and beach hooks: one cue and one splash per stroke, on the
    // stroke's own side. The ring is born AT the gunwale — ±0.55 m off the
    // centreline, 0.4 m astern of midships, where the blade actually works —
    // so it visibly blooms from the hull's side instead of appearing in open
    // water beside a boat it never touches.
    phys.onStroke = (side, strength) => {
      const rx = -Math.cos(phys.heading), rz = Math.sin(phys.heading);
      const fx = Math.sin(phys.heading), fz = Math.cos(phys.heading);
      const px2 = phys.x + rx * side * 0.55 - fx * 0.4;
      const pz2 = phys.z + rz * side * 0.55 - fz * 0.4;
      this.ctx.systems?.water?.pushWake?.(px2, pz2, 0.8 * strength, 2.0);
      this._cue('stroke', { x: px2, z: pz2, side, strength });
    };
    phys.onBeach = () => this._cue('beach', { x: phys.x, z: phys.z });

    this.boats.push(b);
    this._pose(b, 0);

    // The launch splash, and a glance at it.
    this.ctx.systems?.water?.pushWake?.(sx, sz, 0.85, 2.2);
    this._cue('launch', { x: sx, z: sz, kind });
    this._focusT = LAUNCH_FOCUS;
    this._focusP.set(sx, (y ?? phys.y) + 0.4, sz);
    return b;
  }

  /** Board a boat (default: the newest). Takes the camper's controls and the
   *  camera; both are given back by exit(). */
  board(i = this.boats.length - 1) {
    const b = this.boats[i];
    if (!b || b.sinkT !== null) return false;
    const veh = this.ctx.systems?.vehicle;
    const rig = this.ctx.systems?.cameraRig;
    this._aboard = b;
    this.active = true;
    this._focusT = 0;
    if (veh) veh.controlsHeldBy = 'boat';
    // Matching the rig's last-seen teleportSeq means no cut: the damped chase
    // walks the camera from the camper to the boat, an operator's move.
    rig?.setFocus?.(null);
    // Mount the camera on the boat: full takeover, the same sanctioned
    // mechanism the telescope uses (rig.takeCamera outranks everything and
    // hands back cleanly). We do NOT raise __forceCamera — the HUD and the
    // prompts stay up. The mount eases in from wherever the camera was.
    this._camSnap = true;
    rig?.takeCamera?.((dt) => this._boatCam(dt));
    this._cue('board', { x: b.phys.x, z: b.phys.z, kind: b.kind });
    return true;
  }

  /** The mounted ride camera: seated at the back third of the deck, looking
   *  over the bow. Damped so the hull's bob reads as gentle sway, not shake. */
  _boatCam(dt) {
    const b = this._aboard;
    const cam = this.ctx.camera;
    if (!b) return;
    const p = b.phys;
    const dim = b.group.userData.dim ?? this.models[b.kind].dim;
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    const L = dim.length;
    // Wheel zoom, same exponential feel as the rig's. The rig is taken over
    // while aboard, so nothing else consumes the wheel.
    const wheel = this.ctx.input.mouse.wheel;
    if (wheel) {
      this._camZoomT = Math.min(CAM_ZOOM_MAX,
        Math.max(CAM_ZOOM_MIN, this._camZoomT * Math.exp(wheel * 0.0016)));
    }
    const k0 = Math.min(dt, 1 / 20);
    this._camZoom = THREE.MathUtils.damp(this._camZoom, this._camZoomT, 9, k0);
    const zf = this._camZoom;
    const mx = p.x - fx * L * CAM_MOUNT_AFT * zf;
    const mz = p.z - fz * L * CAM_MOUNT_AFT * zf;
    const my = p.y + CAM_MOUNT_UP * (0.55 + 0.45 * zf);
    const lx = p.x + fx * L * 1.7, lz = p.z + fz * L * 1.7;
    const ly = p.y + CAM_LOOK_UP;
    const k = Math.min(dt, 1 / 20);
    if (this._camSnap) {
      this._camP.set(mx, my, mz);
      this._camL.set(lx, ly, lz);
      this._camSnap = false;
    } else {
      // Position tracks hard (the eye is IN the boat); the look target trails
      // a little more so a sweep-turn reads as the bow swinging through frame.
      const dp = THREE.MathUtils.damp;
      this._camP.set(dp(this._camP.x, mx, 14, k), dp(this._camP.y, my, 10, k), dp(this._camP.z, mz, 14, k));
      this._camL.set(dp(this._camL.x, lx, 7, k), dp(this._camL.y, ly, 7, k), dp(this._camL.z, lz, 7, k));
    }
    cam.position.copy(this._camP);
    cam.lookAt(this._camL);
  }

  /** E on a beached bow: bring the camper around to the shore in front of the
   *  boat, then step off (user direction, 2026-08-23). The camper lands via
   *  Vehicle._land — the same full teleport a rescue uses (physics cut,
   *  camera cut, park brake held until the player drives). If no dry ground
   *  can be found off the bow, this is just exit(). */
  _comeAshore(b) {
    const veh = this.ctx.systems?.vehicle;
    const world = this.ctx.world;
    const p = b.phys;
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    let best = null;
    for (let d = 6; d <= 26 && !best; d += 2) {
      const x = p.x + fx * d, z = p.z + fz * d;
      if (!world.isInBounds(x, z)) break;
      const h = world.getHydro(x, z, {});
      if (h.sdf > -2.5) continue;                 // not solidly on land yet
      if (world.getSlope(x, z) < 0.35) best = { x, z };
    }
    if (!best) {
      // No gentle ground: take the first dry spot at all, or bail to a plain
      // exit — the camper stays where it was.
      for (let d = 6; d <= 26 && !best; d += 2) {
        const x = p.x + fx * d, z = p.z + fz * d;
        if (world.isInBounds(x, z) && world.getHydro(x, z, {}).sdf < -2.5) best = { x, z };
      }
    }
    if (best && veh?._land) veh._land(best.x, best.z, p.heading);
    this.exit();
  }

  /** Step off: moor the boat where it is, give everything back. Unconditional
   *  about the givebacks, whatever state it is called in. */
  exit() {
    const veh = this.ctx.systems?.vehicle;
    const rig = this.ctx.systems?.cameraRig;
    if (veh) veh.controlsHeldBy = null;
    rig?.setFollow?.(null);
    rig?.takeCamera?.(null);   // the chase re-primes behind the camper: a cut
    if (this._aboard) this._aboard.phys.speed = 0;
    this._aboard = null;
    this.active = false;
    this._script = null;
    this._say('');
    this._cursor('');
  }

  // ── harness API (window.__boat) ───────────────────────────────────────────

  /** The player-path validity test, callable from the harness. */
  validate(x, z) {
    return validateLaunch(this.ctx.world, x, z, this.ctx.systems?.vehicle);
  }

  /** Spawn ignoring validity; snaps to the nearest water. */
  spawnAt(x, z, opts = {}) {
    const b = this.spawn(x, z, { ...opts, snap: true });
    return b ? this.state() : null;
  }

  /** Scripted paddle input for headless captures: speed -1..1, turn -1..1.
   *  Pass null (or nothing) to clear. */
  drive(speed, turn = 0) {
    this._script = (speed === null || speed === undefined) ? null : { speed, turn };
    return this._script;
  }

  /** JSON-able snapshot. */
  state() {
    return {
      active: this.active,
      kind: this._aboard?.kind ?? null,
      pointerClaim: this.pointerClaim,
      boats: this.boats.map((b) => ({
        kind: b.kind, colorway: b.colorway, spawnT: b.spawnT,
        sinking: b.sinkT !== null, ...b.phys.state(),
      })),
      controlsHeldBy: this.ctx.systems?.vehicle?.controlsHeldBy ?? null,
    };
  }

  /** Spawn near the camper, board, and paddle a gentle arc. */
  demo() {
    const veh = this.ctx.systems?.vehicle;
    const p = veh?.position ?? { x: 0, z: 0 };
    this.spawnAt(p.x, p.z, {});
    this.board();
    this.drive(1, 0.15);
    return this.state();
  }

  dispose() {
    this.exit();                                    // controls + camera back, always
    for (const b of this.boats.slice()) this._remove(b);
    this.ctx.systems?.water?.setBoat?.(null);
    this.prompt?.dispose();
    this.root?.parent?.remove(this.root);
    if (window.__boat === this) delete window.__boat;
  }
}
