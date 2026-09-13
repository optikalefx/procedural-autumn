// ─────────────────────────────────────────────────────────────────────────────
//  Traces — silent leftovers from a prior camper.
//
//  Not a quest. No pins, no timers, no "must read before you leave". A cold
//  ring and a book at the start camp, and maybe a cairn on a lip this seed
//  actually has. Discover by standing near them and looking.
//
//  The book on the ground is the same journal the J key opens. Clicking it
//  goes through HUD.toggleJournal so the chrome comes off the same way a
//  click on a camp table does.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { SEED } from '../world/WorldConfig.js';
import { bestSite, siteRng } from '../camp/camp_site.js';
import { campMaterials } from '../camp/camp_materials.js';
import { CampPrompt } from '../camp/camp_ui.js';
import { picked, pointing } from '../core/Pointer.js';
import { pickVerb } from '../core/verbs.js';
import { seedFeatures } from './prior_notes.js';
import {
  buildColdRing, buildStakeHoles, buildCairn, seatJournal, placeOnGround,
} from './trace_props.js';

const LOOK_FAR = 22;
const _ray = { o: new THREE.Vector3(), d: new THREE.Vector3() };

const LOOK = {
  journal: () => `${pickVerb()}&nbsp; open the journal`,
  ring: () => 'a cold fire ring. ashes gone grey.',
  stakes: () => 'stake holes. a tent was here.',
  cairn: () => 'a small cairn. three stones, maybe four.',
};

export class Traces extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Traces';
    this.loadLabel = 'Someone was here';
    this.root = null;
    this.prompt = null;
    this.spots = [];
    this.origin = null;
    this.features = null;
    this._bookInHand = false;
    this.pointerClaim = false;
  }

  async init() {
    campMaterials();
    this.root = new THREE.Group();
    this.root.name = 'prior_traces';
    this.ctx.scene.add(this.root);
    this.prompt = new CampPrompt();
    this.prompt.el.classList.add('pa-trace-prompt');

    const veh = this.ctx.systems?.vehicle;
    const home = veh?._home ?? { x: veh?.position?.x ?? 0, z: veh?.position?.z ?? 0 };
    const site = this._findStart(home);
    this.origin = { x: site.x, z: site.z };
    this.features = seedFeatures(this.ctx, this.origin);

    const seed = (this.ctx.world?.seed ?? SEED) >>> 0;
    const rnd = siteRng(site.x, site.z, seed);
    this._placeStart(site, rnd);
    this._placeAnchors(rnd);

    // Harness / probe seam. Same spirit as window.__camp.
    window.__traces = this;
  }

  /**
   * A campable patch near the camper, far enough that the ring is not under
   * the bumper and near enough that the first look out the window finds it.
   */
  _findStart(home) {
    const world = this.ctx.world;
    let best = null;
    for (const r of [10, 12, 14, 16, 18, 22]) {
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2 + 0.4;
        const x = home.x + Math.sin(a) * r;
        const z = home.z + Math.cos(a) * r;
        if (!world.isInBounds(x, z)) continue;
        const s = bestSite(world, x, z);
        if (!s.ok) continue;
        if (!best || s.score > best.score) best = { x: s.x, z: s.z, score: s.score };
      }
      if (best && best.score > 0.45) break;
    }
    return best ?? { x: home.x + 11, z: home.z + 3, score: 0 };
  }

  _placeStart(site, rnd) {
    const world = this.ctx.world;
    const cx = site.x, cz = site.z;
    const yaw = rnd() * Math.PI * 2;

    const ring = buildColdRing(rnd);
    const ry = placeOnGround(world, ring, cx, cz, yaw, 0.9, 0.6);
    this.root.add(ring);
    this._spot(ring, 'ring', cx, ry, cz);

    // Stake holes off to one side — the tent, packed and gone.
    const sa = yaw + 1.15;
    const sx = cx + Math.sin(sa) * 2.4;
    const sz = cz + Math.cos(sa) * 2.4;
    const stakes = buildStakeHoles(rnd);
    const sy = placeOnGround(world, stakes, sx, sz, sa, 0.7, 1.0);
    this.root.add(stakes);
    this._spot(stakes, 'stakes', sx, sy, sz);

    // The book, on the ground beside the ring. Not on a table — nobody is
    // still sitting here.
    const jx = cx + Math.sin(yaw + 0.55) * 1.15;
    const jz = cz + Math.cos(yaw + 0.55) * 1.15;
    const pad = new THREE.Group();
    pad.name = 'trace_journal_pad';
    const jy = placeOnGround(world, pad, jx, jz, yaw + 0.4, 0.75, 0.2);
    this.root.add(pad);
    const holder = seatJournal(rnd, pad);
    if (holder) this._spot(holder, 'journal', jx, jy + 0.02, jz);
  }

  _placeAnchors(rnd) {
    const world = this.ctx.world;
    const f = this.features;
    // A cairn on a lip this seed actually has. Dry / flat seeds skip it.
    if (f.ridgeNear) {
      const p = this._nudgeClear(f.ridgeNear.x, f.ridgeNear.z, rnd);
      const cairn = buildCairn(rnd);
      const y = placeOnGround(world, cairn, p.x, p.z, rnd() * Math.PI * 2, 0.88, 0.28);
      this.root.add(cairn);
      this._spot(cairn, 'cairn', p.x, y, p.z);
    }
  }

  _nudgeClear(x, z, rnd) {
    const world = this.ctx.world;
    let bx = x, bz = z, bestWet = Infinity;
    for (let i = 0; i < 8; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 2 + rnd() * 5;
      const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
      if (!world.isInBounds(px, pz)) continue;
      const wet = world.getWaterDepth(px, pz);
      const sl = world.getSlope(px, pz);
      if (wet < bestWet && sl < 0.7) { bestWet = wet; bx = px; bz = pz; }
    }
    return { x: bx, z: bz };
  }

  _spot(obj, kind, x, y, z) {
    const pickR = obj.userData?.trace?.pickR ?? 0.4;
    this.spots.push({ kind, obj, x, y, z, pickR });
  }

  /**
   * What the pointer is on, if anything. Camp asks this while the brake is
   * held so a click on the book does not also pitch a camp.
   */
  offer() {
    const hit = this._pick(this._pointerRay());
    if (!hit) return null;
    return {
      kind: hit.kind,
      prompt: LOOK[hit.kind]?.() ?? '',
      act: () => this._act(hit),
    };
  }

  _act(hit) {
    if (hit.kind === 'journal') {
      this.ctx.systems?.hud?.toggleJournal?.();
      return;
    }
    // A look, not a pickup. One quiet line; no log, no tick.
    const line = LOOK[hit.kind]?.() ?? '';
    if (line) this.ctx.systems?.hud?.toast?.(line.replace(/<[^>]+>/g, ''));
  }

  _pick(rayIn = null) {
    const ray = rayIn ?? this._pointerRay();
    if (!ray) return null;
    let best = null, bestMiss = 1;
    for (const s of this.spots) {
      if (!s.obj.visible) continue;
      if (s.kind === 'journal' && this._bookInHand) continue;
      const miss = rayMiss(ray, s.x, s.y + 0.04, s.z, s.pickR);
      if (miss < bestMiss) {
        const along = alongRay(ray, s.x, s.y, s.z);
        if (along > 0.4 && along < LOOK_FAR) { bestMiss = miss; best = s; }
      }
    }
    return best;
  }

  _pointerRay() {
    const { input, camera } = this.ctx;
    const o = _ray.o.copy(camera.position);
    const d = _ray.d;
    if (input.mouse && Number.isFinite(input.mouse.x) && !window.__forceCamera) {
      d.set(input.mouse.x, input.mouse.y, 0.5).unproject(camera).sub(o).normalize();
    } else {
      camera.getWorldDirection(d);
    }
    return _ray;
  }

  update() {
    const bookOpen = !!this.ctx.systems?.hud?.journal?.visible;
    if (bookOpen !== this._bookInHand) {
      this._bookInHand = bookOpen;
      for (const s of this.spots) {
        if (s.kind === 'journal') s.obj.visible = !bookOpen;
      }
    }
    if (bookOpen) { this.prompt.set(''); this.pointerClaim = false; return; }

    // While the brake is latched Camp owns the prompt (it calls offer()).
    // Here we cover the other half: parked by the game's own hold, or just
    // looking around before anyone has pressed Space.
    const veh = this.ctx.systems?.vehicle;
    if (veh?.brakeHold) { this.prompt.set(''); this.pointerClaim = false; return; }
    if (this.ctx.systems?.hud?.photo?.active) { this.prompt.set(''); return; }
    if (!pointing(this.ctx.input)) { this.prompt.set(''); this.pointerClaim = false; return; }

    const hit = this._pick();
    this.pointerClaim = !!hit;
    if (hit) {
      this.prompt.set(LOOK[hit.kind]?.() ?? '');
      if (picked(this.ctx.input)) this._act(hit);
    } else {
      this.prompt.set('');
    }
  }

  dispose() {
    this.prompt?.dispose();
    this.root?.parent?.remove(this.root);
    this.spots = [];
    if (window.__traces === this) delete window.__traces;
  }
}

function alongRay(ray, x, y, z) {
  return (x - ray.o.x) * ray.d.x + (y - ray.o.y) * ray.d.y + (z - ray.o.z) * ray.d.z;
}

function rayMiss(ray, x, y, z, r) {
  const ox = x - ray.o.x, oy = y - ray.o.y, oz = z - ray.o.z;
  const along = ox * ray.d.x + oy * ray.d.y + oz * ray.d.z;
  if (along < 0) return Infinity;
  const px = ox - ray.d.x * along, py = oy - ray.d.y * along, pz = oz - ray.d.z * along;
  const perp = Math.sqrt(px * px + py * py + pz * pz);
  return perp > r ? Infinity : perp / r;
}
