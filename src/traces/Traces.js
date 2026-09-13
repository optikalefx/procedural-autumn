// ─────────────────────────────────────────────────────────────────────────────
//  Traces — silent leftovers from a prior camper.
//
//  Not a quest. No pins, no timers, no "must read before you leave". A faded
//  start scuff opens the book; the rest of the pool is spread through the
//  valley, gated on what this seed actually has. Discover by standing near
//  them and looking. About one in three crumbs is a short readable scrap;
//  the others are just things someone left.
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
import { CampGround } from '../camp/camp_ground.js';
import { setCampSlots } from '../camp/camp_clearing.js';
import { CampPrompt } from '../camp/camp_ui.js';
import { picked, pointing } from '../core/Pointer.js';
import { pickVerb } from '../core/verbs.js';
import { FONT_HAND } from '../journal/journal_fonts.js';
import { SPECIES } from '../vegetation/tree_species.js';
import { seedFeatures, pickCrumbs, assignScraps } from './prior_notes.js';
import {
  buildColdRing, buildStakeHoles, buildCairn, seatJournal, placeOnGround,
  buildTreeNote, buildTippedBike, buildBeachedCanoe, buildLeanedPaddle,
  buildCoffeeTin, buildLaidStick, buildTireTracks, buildTrunkRope,
} from './trace_props.js';

// Small enough that it reads as "a tent was here", not as a player camp.
const START_R = 3.35;
const START_FEATHER = 0.78;

const LOOK_FAR = 22;
const MIN_FROM_START = 78;
const MIN_SEP = 82;
const MAX_FROM_START = 720;

const _ray = { o: new THREE.Vector3(), d: new THREE.Vector3() };

const LOOK = {
  journal: () => `${pickVerb()}&nbsp; open the journal`,
  ring: () => 'a cold fire ring. ashes gone grey.',
  stakes: () => 'stake holes. a tent was here.',
  cairn: () => 'a small cairn. three stones, maybe four.',
  'tree-note': () => `${pickVerb()}&nbsp; a note on the tree`,
  bike: () => 'a bike on its side. nobody coming back for it.',
  tracks: () => 'a tyre track, fading into the mud.',
  rope: () => 'a line still on the trunk.',
  tin: () => 'an empty tin. grounds in the bottom.',
  stick: () => 'a roasting stick. the fire is gone.',
  'second-night': () => 'grass laid down. someone slept here.',
  canoe: () => 'a canoe on the bank. too late to put in.',
  paddle: () => 'a paddle, leaned the wrong way.',
};

const ANCHOR_OF = {
  'tree-note': ['forest', 'meadow'],
  bike: ['road', 'meadow'],
  tracks: ['road', 'meadow'],
  rope: ['forest', 'meadow'],
  tin: ['meadow', 'forest'],
  stick: ['meadow', 'forest'],
  'second-night': ['meadow', 'forest'],
  canoe: ['mouth', 'river'],
  paddle: ['river', 'mouth'],
  cairn: ['vista', 'peak'],
};

export class Traces extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Traces';
    this.loadLabel = 'Someone was here';
    this.root = null;
    this.prompt = null;
    this.scrap = null;
    this.spots = [];
    this.crumbs = [];
    this.origin = null;
    this.features = null;
    this.clearings = [];
    this.ground = null;
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
    this.scrap = new ScrapCard();

    const veh = this.ctx.systems?.vehicle;
    const home = veh?._home ?? { x: veh?.position?.x ?? 0, z: veh?.position?.z ?? 0 };
    const site = this._findStart(home);
    this.origin = { x: site.x, z: site.z };
    this.features = seedFeatures(this.ctx, this.origin);

    const seed = (this.ctx.world?.seed ?? SEED) >>> 0;
    const rnd = siteRng(site.x, site.z, seed);
    this._placeStart(site, rnd);
    this._placeSpread(rnd);
    this._publishClearings();

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

    // Grass and cover have to know about this scuff BEFORE the dirt mesh
    // reads campCoverAt for its own edge — same order Camp uses.
    this.clearings.push({ x: cx, z: cz, radius: START_R, feather: START_FEATHER });
    this._publishClearings();

    this.ground = new CampGround(this.ctx.scene, world);
    this.ground.build(cx, cz, START_R, rnd, START_FEATHER, [{ x: cx, z: cz, radius: 0.58 }]);
    this.ground.setReveal(1);

    const floor = (x, z) => this.ground.surfaceAt(x, z);

    const ring = buildColdRing(rnd);
    const ry = placeOnGround(world, ring, cx, cz, yaw, 0.9, 0.6, floor(cx, cz));
    this.root.add(ring);
    this._spot(ring, 'ring', cx, ry, cz);

    // Stake holes off to one side — the tent, packed and gone.
    const sa = yaw + 1.15;
    const sx = cx + Math.sin(sa) * 2.4;
    const sz = cz + Math.cos(sa) * 2.4;
    const stakes = buildStakeHoles(rnd);
    const sy = placeOnGround(world, stakes, sx, sz, sa, 0.7, 1.0, floor(sx, sz));
    this.root.add(stakes);
    this._spot(stakes, 'stakes', sx, sy, sz);

    // The book, on the ground beside the ring. Not on a table — nobody is
    // still sitting here.
    const jx = cx + Math.sin(yaw + 0.55) * 1.15;
    const jz = cz + Math.cos(yaw + 0.55) * 1.15;
    const pad = new THREE.Group();
    pad.name = 'trace_journal_pad';
    const jy = placeOnGround(world, pad, jx, jz, yaw + 0.4, 0.75, 0.2, floor(jx, jz) + 0.004);
    this.root.add(pad);
    const holder = seatJournal(rnd, pad);
    if (holder) this._spot(holder, 'journal', jx, jy + 0.02, jz);

    this._addCrumb('start', cx, cz, false);
  }

  _placeSpread(rnd) {
    const plan = pickCrumbs(this.features);
    const scraps = assignScraps(plan, this.features, rnd);
    this.plan = plan;
    this.scraps = scraps;
    const taken = [{ x: this.origin.x, z: this.origin.z }];

    for (const kind of plan) {
      if (kind === 'start') continue;
      const p = this._pickAnchor(kind, taken, rnd);
      if (!p) continue;
      if (!this._placeKind(kind, p, rnd, scraps.get(kind) ?? null)) continue;
      taken.push({ x: p.x, z: p.z });
      this._addCrumb(kind, p.x, p.z, scraps.has(kind));
    }
  }

  _pickAnchor(kind, taken, rnd) {
    const world = this.ctx.world;
    const origin = this.origin;
    const prefer = kind === 'second-night' ? 280 : 180;
    const raw = this._candidates(kind);
    const scored = [];
    for (const p of raw) {
      if (!world.isInBounds(p.x, p.z)) continue;
      const d0 = Math.hypot(p.x - origin.x, p.z - origin.z);
      if (d0 < MIN_FROM_START || d0 > MAX_FROM_START) continue;
      if (world.getWaterDepth(p.x, p.z) > (kind === 'canoe' ? 0.55 : 0.18)) continue;
      if (world.getSlope(p.x, p.z) > 0.85) continue;
      let near = false;
      for (const t of taken) {
        if (Math.hypot(p.x - t.x, p.z - t.z) < MIN_SEP) { near = true; break; }
      }
      if (near) continue;
      scored.push({ p, rank: -Math.abs(d0 - prefer) + rnd() * 8 });
    }
    scored.sort((a, b) => b.rank - a.rank);
    for (const { p } of scored) {
      if (kind === 'canoe') {
        const shore = this._shoreNear(p);
        if (shore && this._free(shore, taken)) return { ...p, ...shore };
        continue;
      }
      if (kind === 'paddle') {
        const bank = this._bankNear(p);
        if (bank && this._free(bank, taken)) return { ...p, ...bank };
        continue;
      }
      if (kind === 'tree-note' || kind === 'rope') {
        const tree = this._nearTree(p.x, p.z, 55);
        if (tree && this._free(tree, taken, 12)) return { ...p, ...tree, tree };
        continue;
      }
      if (kind === 'bike' || kind === 'tracks') {
        const off = this._offPath(p, rnd);
        if (this._free(off, taken)) return off;
        continue;
      }
      const nudged = this._nudgeClear(p.x, p.z, rnd);
      if (this._free(nudged, taken)) return { ...p, ...nudged };
    }
    return null;
  }

  _candidates(kind) {
    const keys = ANCHOR_OF[kind] ?? [];
    const out = [];
    for (const k of keys) {
      const list = this.features?.pois?.[k];
      if (!list) continue;
      for (const p of list) {
        if (Number.isFinite(p.x) && Number.isFinite(p.z)) out.push(p);
      }
    }
    return out;
  }

  _free(p, taken, pad = 0) {
    const need = MIN_SEP - pad;
    for (const t of taken) {
      if (Math.hypot(p.x - t.x, p.z - t.z) < need) return false;
    }
    return true;
  }

  _offPath(p, rnd) {
    const yaw = p.yaw ?? 0;
    const side = rnd() < 0.5 ? 1 : -1;
    const x = p.x + Math.cos(yaw) * (2.2 + rnd() * 1.4) * side;
    const z = p.z - Math.sin(yaw) * (2.2 + rnd() * 1.4) * side;
    return { ...p, x, z };
  }

  _shoreNear(p) {
    const world = this.ctx.world;
    const yaws = [p.yaw ?? 0, (p.yaw ?? 0) + 0.45, (p.yaw ?? 0) - 0.45, (p.yaw ?? 0) + Math.PI];
    for (const a of yaws) {
      for (let d = 2; d < 36; d += 1.4) {
        const x = p.x + Math.sin(a) * d;
        const z = p.z + Math.cos(a) * d;
        if (!world.isInBounds(x, z)) continue;
        const depth = world.getWaterDepth(x, z);
        if (depth >= 0.03 && depth <= 0.24 && world.getSlope(x, z) < 0.6) {
          return { x, z, yaw: a };
        }
      }
    }
    return world.getWaterDepth(p.x, p.z) < 0.3 ? { x: p.x, z: p.z, yaw: p.yaw ?? 0 } : null;
  }

  _bankNear(p) {
    const world = this.ctx.world;
    const yaws = [p.yaw ?? 0, (p.yaw ?? 0) + Math.PI, (p.yaw ?? 0) + 0.7];
    for (const a of yaws) {
      for (let d = 1; d < 22; d += 1.2) {
        const x = p.x + Math.sin(a) * d;
        const z = p.z + Math.cos(a) * d;
        if (!world.isInBounds(x, z)) continue;
        if (world.getWaterDepth(x, z) < 0.025 && world.getSlope(x, z) < 0.55) {
          return { x, z, yaw: a };
        }
      }
    }
    return world.getWaterDepth(p.x, p.z) < 0.05 ? { x: p.x, z: p.z, yaw: p.yaw ?? 0 } : null;
  }

  /**
   * Nearest tree by walking the 64 m buckets around a point — not the 120k
   * list. Trees init before Traces, so the arrays are already filled.
   */
  _nearTree(x, z, maxR = 48) {
    const T = this.ctx.systems?.trees?.trees;
    if (!T?.n) return null;
    const { BW, BS, half, order, bucketStart, px, pz, py, pscale, pspec, pImpH } = T;
    const bx = clampi(((x + half) / BS) | 0, 0, BW - 1);
    const bz = clampi(((z + half) / BS) | 0, 0, BW - 1);
    const rad = Math.ceil(maxR / BS);
    let best = -1, bestD = maxR * maxR;
    for (let j = -rad; j <= rad; j++) {
      const zz = bz + j;
      if (zz < 0 || zz >= BW) continue;
      for (let i = -rad; i <= rad; i++) {
        const xx = bx + i;
        if (xx < 0 || xx >= BW) continue;
        const b = zz * BW + xx;
        for (let o = bucketStart[b]; o < bucketStart[b + 1]; o++) {
          const t = order[o];
          const dx = px[t] - x, dz = pz[t] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD) { bestD = d2; best = t; }
        }
      }
    }
    if (best < 0) return null;
    const sp = SPECIES[pspec[best]];
    const trunkR = Math.max(0.07, (pImpH[best] ?? 10) * (sp?.trunkRadiusK ?? 0.02));
    return {
      x: px[best], y: py[best], z: pz[best],
      scale: pscale[best], trunkR, i: best,
    };
  }

  _placeKind(kind, p, rnd, scrap) {
    const world = this.ctx.world;
    const yaw = p.yaw ?? rnd() * Math.PI * 2;

    if (kind === 'tree-note') {
      const tree = p.tree;
      if (!tree) return false;
      const nx = Math.sin(yaw + 0.6), nz = Math.cos(yaw + 0.6);
      const note = buildTreeNote(rnd);
      const hx = tree.x + nx * (tree.trunkR + 0.02);
      const hz = tree.z + nz * (tree.trunkR + 0.02);
      const hy = (tree.y ?? world.getHeight(tree.x, tree.z)) + 1.36;
      note.position.set(hx, hy, hz);
      note.lookAt(tree.x, hy, tree.z);
      this.root.add(note);
      this._spot(note, 'tree-note', hx, hy, hz, scrap);
      return true;
    }

    if (kind === 'rope') {
      const tree = p.tree;
      if (!tree) return false;
      const rope = buildTrunkRope(rnd, tree.trunkR);
      const y = placeOnGround(world, rope, tree.x, tree.z, rnd() * Math.PI * 2, 0.15, tree.trunkR + 0.2);
      this.root.add(rope);
      this._spot(rope, 'rope', tree.x, y + 0.7, tree.z);
      return true;
    }

    if (kind === 'bike') {
      const bike = buildTippedBike(rnd);
      const y = placeOnGround(world, bike, p.x, p.z, yaw + 0.4, 0.28, 1.15);
      this.root.add(bike);
      this._spot(bike, 'bike', p.x, y + 0.25, p.z, scrap);
      return true;
    }

    if (kind === 'tracks') {
      this.clearings.push({ x: p.x, z: p.z, radius: 2.15, feather: 0.55 });
      const tracks = buildTireTracks(rnd);
      const y = placeOnGround(world, tracks, p.x, p.z, yaw, 0.55, 1.4);
      this.root.add(tracks);
      this._spot(tracks, 'tracks', p.x, y, p.z, scrap);
      return true;
    }

    if (kind === 'tin') {
      this.clearings.push({ x: p.x, z: p.z, radius: 1.15, feather: 0.42 });
      const tin = buildCoffeeTin(rnd);
      const y = placeOnGround(world, tin, p.x, p.z, yaw, 0.7, 0.18);
      this.root.add(tin);
      this._spot(tin, 'tin', p.x, y + 0.06, p.z, scrap);
      return true;
    }

    if (kind === 'stick') {
      const stick = buildLaidStick(rnd);
      const y = placeOnGround(world, stick, p.x, p.z, yaw, 0.55, 0.6);
      this.root.add(stick);
      this._spot(stick, 'stick', p.x, y + 0.02, p.z);
      return true;
    }

    if (kind === 'second-night') {
      // Flattened grass only — no second dirt pad, no second journal.
      this.clearings.push({ x: p.x, z: p.z, radius: 2.45, feather: 0.72 });
      const ring = buildColdRing(rnd);
      ring.userData.trace = { kind: 'second-night', pickR: 0.72 };
      const y = placeOnGround(world, ring, p.x, p.z, yaw, 0.88, 0.6);
      this.root.add(ring);
      this._spot(ring, 'second-night', p.x, y, p.z, scrap);
      return true;
    }

    if (kind === 'canoe') {
      const canoe = buildBeachedCanoe(rnd);
      const y = placeOnGround(world, canoe, p.x, p.z, yaw, 0.22, 1.8);
      this.root.add(canoe);
      this._spot(canoe, 'canoe', p.x, y + 0.2, p.z, scrap);
      return true;
    }

    if (kind === 'paddle') {
      const paddle = buildLeanedPaddle(rnd);
      const y = placeOnGround(world, paddle, p.x, p.z, yaw, 0.2, 0.35);
      this.root.add(paddle);
      this._spot(paddle, 'paddle', p.x, y + 0.45, p.z, scrap);
      return true;
    }

    if (kind === 'cairn') {
      const q = this._nudgeClear(p.x, p.z, rnd);
      this.clearings.push({ x: q.x, z: q.z, radius: 0.95, feather: 0.38 });
      const cairn = buildCairn(rnd);
      const y = placeOnGround(world, cairn, q.x, q.z, rnd() * Math.PI * 2, 0.88, 0.28);
      this.root.add(cairn);
      this._spot(cairn, 'cairn', q.x, y, q.z);
      p.x = q.x; p.z = q.z;
      return true;
    }

    return false;
  }

  _addCrumb(id, x, z, readable) {
    this.crumbs.push({ id, x, z, readable: !!readable });
  }

  _publishClearings() {
    const camp = this.ctx.systems?.camp;
    if (camp?._publishSlots) { camp._publishSlots(); return; }
    setCampSlots(this.clearings.map((t) => ({
      x: t.x, z: t.z, radius: t.radius, feather: t.feather, pad: t.pad ?? null,
    })));
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

  _spot(obj, kind, x, y, z, scrap = null) {
    const pickR = obj.userData?.trace?.pickR ?? 0.4;
    this.spots.push({ kind, obj, x, y, z, pickR, scrap });
  }

  /**
   * What the pointer is on, if anything. Camp asks this while the brake is
   * held so a click on the book does not also pitch a camp.
   */
  offer() {
    if (this.scrap?.open) return null;
    const hit = this._pick(this._pointerRay());
    if (!hit) return null;
    return {
      kind: hit.kind,
      prompt: this._look(hit),
      act: () => this._act(hit),
    };
  }

  _look(hit) {
    if (hit.scrap?.lines?.length && hit.kind !== 'journal') {
      const quiet = {
        'tree-note': 'a note on the tree',
        tin: 'the note under the tin',
        bike: 'a scrap by the bike',
        canoe: 'a scrap in the canoe',
        paddle: 'a scrap by the paddle',
        tracks: 'a scrap in the mud',
        'second-night': 'a scrap by the ring',
      };
      return `${pickVerb()}&nbsp; ${quiet[hit.kind] ?? 'the note'}`;
    }
    return LOOK[hit.kind]?.() ?? '';
  }

  _act(hit) {
    if (hit.kind === 'journal') {
      this.ctx.systems?.hud?.toggleJournal?.();
      return;
    }
    if (hit.scrap?.lines?.length) {
      this.scrap?.show(hit.scrap.lines);
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
    if (window.__forceCamera) this.scrap?.hide(true);
    const bookOpen = !!this.ctx.systems?.hud?.journal?.visible;
    if (bookOpen !== this._bookInHand) {
      this._bookInHand = bookOpen;
      for (const s of this.spots) {
        if (s.kind === 'journal') s.obj.visible = !bookOpen;
      }
    }
    if (bookOpen || this.scrap?.open) {
      this.prompt.set('');
      this.pointerClaim = false;
      return;
    }

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
      this.prompt.set(this._look(hit));
      if (picked(this.ctx.input)) this._act(hit);
    } else {
      this.prompt.set('');
    }
  }

  dispose() {
    this.prompt?.dispose();
    this.scrap?.dispose();
    this.ground?.dispose();
    this.ground = null;
    this.root?.parent?.remove(this.root);
    this.spots = [];
    this.crumbs = [];
    this.clearings = [];
    this._publishClearings();
    if (window.__traces === this) delete window.__traces;
  }
}

function clampi(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

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

/**
 * A cream card for a pinned scrap. Toast is too short for three handwritten
 * lines; this is still not a quest panel — Esc or a click puts it away.
 */
class ScrapCard {
  constructor() {
    const el = document.createElement('div');
    el.className = 'pa-trace-scrap';
    el.style.cssText = [
      'position:fixed', 'inset:0', 'display:none', 'place-items:center',
      'background:rgba(18,14,11,.28)', 'z-index:46', 'cursor:pointer',
    ].join(';');
    const card = document.createElement('div');
    card.style.cssText = [
      'max-width:min(320px,78vw)', 'padding:22px 26px 20px',
      'background:#efe4cc', 'color:#3a2b20',
      `font:400 22px/1.45 "${FONT_HAND}", "Bradley Hand", cursive`,
      'box-shadow:0 10px 28px rgba(20,14,10,.28)',
      'transform:rotate(-1.1deg)', 'border:1px solid rgba(90,70,48,.18)',
    ].join(';');
    el.appendChild(card);
    el.addEventListener('click', () => this.hide());
    this._onKey = (e) => {
      if (e.code === 'Escape' && this.open) {
        e.preventDefault();
        e.stopPropagation();
        this.hide();
      }
    };
    window.addEventListener('keydown', this._onKey, true);
    document.body.appendChild(el);
    this.el = el;
    this.card = card;
    this.open = false;
  }

  show(lines) {
    if (window.__forceCamera) return;
    this.card.replaceChildren();
    for (const line of lines) {
      const p = document.createElement('p');
      p.textContent = line;
      p.style.margin = '0 0 0.35em';
      this.card.appendChild(p);
    }
    this.el.style.display = 'grid';
    this.open = true;
  }

  hide(silent = false) {
    if (!this.open && silent) return;
    this.el.style.display = 'none';
    this.open = false;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey, true);
    this.el.remove();
    this.open = false;
  }
}
