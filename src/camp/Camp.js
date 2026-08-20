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
import { setCampSite, campOuterRadius } from './camp_clearing.js';
import { campMaterials, disposeCampMaterials } from './camp_materials.js';
import {
  groundRay, scoreSite, clampToSite, layoutCamp, standOn, siteRng,
  SITE_MIN, SITE_MAX, CAMP_RADIUS,
} from './camp_site.js';
import { CampGround } from './camp_ground.js';
import { CampReticle, CampPrompt } from './camp_ui.js';
import { Firepit, buildWoodpile } from './camp_fire.js';
import { buildTent } from './camp_tent.js';
import { buildChair } from './camp_chair.js';
import { buildCooler } from './camp_cooler.js';
import { buildTable } from './camp_table.js';

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

// The clearing's soft edge, in metres.
const CLEARING_FEATHER = 1.4;

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

export class Camp extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Camp';
    this.loadLabel = 'Unpacking the camp';

    this.state = STATE.IDLE;
    this.site = null;          // { x, z, y } once pitched
    this.raise = 0;            // 0..1 build-in
    this.props = [];
    this.root = null;
    this.fire = null;
    this.ground = null;
    this.reticle = null;
    this.prompt = null;

    this._aim = { x: 0, z: 0, y: 0, ok: false, score: 0, reason: '' };
    this._holdT = 0;
    this._mouseDown = false;
    this._downAt = { x: 0, y: 0, t: 0 };
    this._click = false;
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

    this.ground = new CampGround(scene, world);
    this.reticle = new CampReticle(scene, world, CAMP_RADIUS);
    this.prompt = new CampPrompt();

    // Debug / harness surface. `tools/campshot.mjs` drives the whole feature
    // through this, because a capture harness that has to synthesise mouse
    // moves and clicks to photograph a tent is a harness that breaks every time
    // the input mapping is touched.
    window.__camp = this;
    // The site maths, so tools/_scratch/campdiag.mjs can sweep it without
    // reaching through a bundler that has already renamed everything.
    window.__campSiteMod = { scoreSite, clampToSite, layoutCamp, groundRay, CAMP_RADIUS };
  }

  // ── the one thing the rest of the game asks this system ────────────────────
  get pitched() { return this.state === STATE.PITCHED || this.state === STATE.RAISING; }

  update(dt, t) {
    const { input, camera, world } = this.ctx;
    const veh = this.ctx.systems?.vehicle;
    this._pollClick(dt);

    const holding = !!veh?.enabled && !!veh.brakeHold;

    switch (this.state) {
      case STATE.IDLE:
        if (holding) this.state = STATE.AIMING;
        break;

      case STATE.AIMING: {
        if (!holding) {
          this.state = STATE.IDLE;
          this.prompt.set('');
          // Retract the preview. Without this, releasing the brake and driving
          // away leaves a ghost-thinned disc of meadow behind you forever.
          setCampSite(0, 0, 0, 1);
          break;
        }
        this._aimAt(veh);
        if (this._aim.ok && (this._click || input.justPressed('KeyE'))) this._pitch();
        break;
      }

      case STATE.RAISING:
        this.raise = Math.min(1, this.raise + dt / RAISE_TIME);
        this._applyRaise();
        if (this.raise >= 1) { this.state = STATE.PITCHED; this.prompt.set(''); }
        break;

      case STATE.PITCHED:
        // Packing up is offered only while parked, and only while parked *at*
        // the camp — a "pack up camp" prompt visible from across the valley is
        // a chore list, and this game does not have one.
        if (holding && veh && this.site &&
            Math.hypot(veh.position.x - this.site.x, veh.position.z - this.site.z) < SITE_MAX + 6) {
          this.prompt.set('<b>E</b>&nbsp; pack up camp');
          if (input.justPressed('KeyE')) { this.state = STATE.STRIKING; this.prompt.set(''); }
        } else this.prompt.set('');
        break;

      case STATE.STRIKING:
        this.raise = Math.max(0, this.raise - dt / STRIKE_TIME);
        this._applyRaise();
        if (this.raise <= 0) { this._teardown(); this.state = holding ? STATE.AIMING : STATE.IDLE; }
        break;
    }

    this.reticle.update(dt, t, this.state === STATE.AIMING);
    if (this.fire) this.fire.update(dt, t, camera);
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

    const c = clampToSite(px, pz, vx, vz);
    const s = scoreSite(world, c.x, c.z, { blocked: (x, z, r) => this._blocked(x, z, r) });

    this._aim.x = c.x; this._aim.z = c.z; this._aim.y = s.y;
    this._aim.ok = s.ok; this._aim.score = s.score; this._aim.reason = s.reason;

    this.reticle.place(c.x, c.z, s.ok, s.score);

    // Ghost the clearing open under the reticle. Only where the site is
    // actually buildable: a preview that appears over a lake or a cliff is
    // promising something that will not happen, and the whole job of this
    // affordance is to be trustworthy.
    setCampSite(c.x, c.z, CAMP_RADIUS, CLEARING_FEATHER, s.ok ? AIM_FLOOR : 1);

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
    const R = CAMP_RADIUS * 1.15;
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

  _pitch(x = this._aim.x, z = this._aim.z) {
    const { world, scene } = this.ctx;
    this._teardown();

    const y = world.getHeight(x, z);
    this.site = { x, z, y };
    const rnd = siteRng(x, z, this.ctx.world?.seed ?? 0);

    // Publish the clearing first: the dirt mesh reads it back to shape its own
    // alpha, so the two are the same edge by construction rather than by two
    // authors agreeing on a formula.
    setCampSite(x, z, CAMP_RADIUS, CLEARING_FEATHER);
    this.ground.build(x, z, CAMP_RADIUS, rnd);

    // The fire is the origin of the arrangement, so it is placed first and
    // everything else is placed relative to it.
    this.fire = new Firepit(scene, rnd, {});
    this.fire.setPosition(new THREE.Vector3(x, y + 0.02, z));

    const wind = this.ctx.systems?.weather?.windDir
              ?? this.ctx.systems?.grass?.windDir
              ?? new THREE.Vector2(0.86, 0.51);

    const items = layoutCamp(rnd, world, x, z, {
      radius: CAMP_RADIUS, windDir: wind, obstacles: this._obstacles(x, z),
    });
    const BUILD = {
      tent: buildTent, chair: buildChair, cooler: buildCooler,
      table: buildTable, woodpile: buildWoodpile,
    };
    let tents = 0;
    for (const it of items) {
      // One tent. The layout only ever emits one, and this is the belt to that
      // braces: a second tent in a camp this size is the difference between
      // "somebody is staying here" and "this is a campground".
      if (it.kind === 'tent' && tents++ > 0) continue;
      const build = BUILD[it.kind];
      if (!build) { console.warn('[camp] no builder for', it.kind); continue; }
      let obj;
      try { obj = build(rnd, it.opts ?? {}); }
      catch (e) { console.error(`[camp] ${it.kind} builder threw`, e); continue; }
      if (!obj) continue;
      obj.position.set(it.x, it.y, it.z);
      standOn(world, it.x, it.z, it.yaw, it.tilt ?? 1, this._q);
      obj.quaternion.copy(this._q);
      obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      obj.userData.campItem = it;
      this.root.add(obj);
      this.props.push({ obj, item: it, delay: 0 });
    }

    // Stagger the build-in outward from the fire, so the camp assembles from
    // its centre rather than all at once. Ordering by distance and not by kind
    // means the same rule produces a different, correct order for every layout.
    this.props.sort((a, b) =>
      Math.hypot(a.item.x - x, a.item.z - z) - Math.hypot(b.item.x - x, b.item.z - z));
    for (let i = 0; i < this.props.length; i++) {
      this.props[i].delay = 0.06 + (i / Math.max(1, this.props.length - 1)) * 0.42;
    }

    this.raise = 0;
    this.state = STATE.RAISING;
    this._applyRaise();
    this.ctx.systems?.hud?.toast?.('Camp made');
  }

  /**
   * Drive the build-in.
   *
   * The clearing radius eases open ahead of the props, which is what makes the
   * sequence read as "the ground was cleared, then things were put on it"
   * rather than as a group fading in. Props scale up from their own base, with
   * a small overshoot — a prop that settles is a prop that was set down.
   */
  _applyRaise() {
    const k = this.raise;
    const clear = smoothstep(0, 0.55, k);
    if (this.site) setCampSite(this.site.x, this.site.z, CAMP_RADIUS * clear, CLEARING_FEATHER);
    this.ground?.setReveal(smoothstep(0.02, 0.62, k));
    this.fire?.setReveal(smoothstep(0.30, 0.95, k));

    for (const p of this.props) {
      const t = clamp01((k - p.delay) / Math.max(0.08, 1 - p.delay));
      // Back-ease with a gentle overshoot; never below zero, because a prop
      // that inverts for one frame is a flash of inside-out geometry.
      const e = t <= 0 ? 0 : 1 - Math.pow(1 - t, 2.2) * (1 - 0.14 * Math.sin(t * Math.PI));
      p.obj.visible = t > 0.001;
      p.obj.scale.setScalar(Math.max(0.001, e));
    }
  }

  _teardown() {
    for (const p of this.props) {
      this.root.remove(p.obj);
      p.obj.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
    }
    this.props.length = 0;
    this.fire?.dispose(); this.fire = null;
    this.ground?.dispose();
    setCampSite(0, 0, 0, 1);
    this.site = null;
    this.raise = 0;
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
    this._pitch(x, z);
    if (instant) { this.raise = 1; this.state = STATE.PITCHED; this._applyRaise(); }
    return this.site;
  }

  /** Pitch a camp on decent ground near a point — used by the harness. */
  pitchNear(x, z, { instant = true, radius = 12 } = {}) {
    const { world } = this.ctx;
    let best = null;
    for (let i = 0; i < 96; i++) {
      // Golden-angle spiral outward: covers the annulus evenly without ever
      // sampling the same bearing twice, and finds the near cases first.
      const a = i * 2.39996;
      const r = SITE_MIN + (radius - SITE_MIN) * Math.sqrt(i / 96);
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      const s = scoreSite(world, px, pz, { blocked: (bx, bz, br) => this._blocked(bx, bz, br) });
      if (s.ok && (!best || s.score > best.score)) best = s;
      if (best && best.score > 0.86) break;
    }
    if (!best) return null;
    return this.pitchAt(best.x, best.z, { instant });
  }

  strike() { this._teardown(); this.state = STATE.IDLE; }

  dispose() {
    this._teardown();
    this.reticle?.dispose();
    this.prompt?.dispose();
    this.ctx.scene.remove(this.root);
    disposeCampMaterials();
  }
}
