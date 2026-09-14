// ─────────────────────────────────────────────────────────────────────────────
//  Traces — one weekend of work for M., then they left.
//
//  Not a quest. No pins, no leave-gate. The prior camper was documenting
//  this valley for M.: usuals first (so a shadow is a shadow), the unnamed
//  thing later. Each leftover is a beat of that job — a fast haul-out, a
//  dropped bike, a dusk note — not camp dressing. Discover by standing
//  near them and looking. A faint parchment ribbon on the ground marks
//  the patch once you are close — not a pin, not a compass POI, not a
//  `!`. Player camp already speaks in dirt pads; leftover noticing
//  must not. Tiny grounding under a prop can stay. Do not grow a dirt
//  disc to mean "inspect here." About one in three crumbs is a short
//  scrap in the same hand as the journal.
//
//  The book on the dirt is the same journal the J key opens. They left it
//  for whoever came next. Clicking it goes through HUD.toggleJournal.
//  That leftover mesh is a closed leather prop (no page canvases). Opening
//  the overlay book is the existing 10×1024×1452 CanvasTexture path — a
//  Chrome tab discard on a small GPU is that path, not an extra WebGL
//  cost this system adds.
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
import { seedFeatures, pickWeekend, assignScraps } from './prior_notes.js';
import {
  buildColdRing, buildStakeHoles, buildCairn, seatJournal, placeOnGround,
  buildTreeNote, buildTippedBike, buildBeachedCanoe, buildLeanedPaddle,
  buildCoffeeTin, buildLaidStick, buildTireTracks, buildTrunkRope,
} from './trace_props.js';
import {
  buildNoticeHalo, updateNoticeHalo, disposeNoticeHalo,
} from './trace_halo.js';

// Small enough that it reads as "a tent was here", not as a player camp.
const START_R = 3.35;
const START_FEATHER = 0.78;

const LOOK_FAR = 28;
const LOOK_FAR_SMALL = 34;
const SMALL_LOOK = new Set(['tin', 'paddle', 'rope', 'tree-note', 'cairn']);
const MIN_FROM_START = 52;
const MIN_SEP = 70;
const PAIR_MIN = 16;
const MAX_FROM_START = 720;

// Distance-from-camp bands, in story order. Later beats want to sit farther
// out; a hop that doubles back toward the scuff is the wrong weekend.
const BAND = {
  water: [70, 300],
  ride: [120, 400],
  lip: [180, 540],
  trees: [150, 420],
  exit: [220, 660],
};
const PAIR_AT = { water: 36, ride: 62, lip: 52, exit: 88 };

// Metres from leftover centre to the ribbon midline. Start is one ring
// for the whole scuff (ring + stakes + journal), not three stacked.
const HALO_R = {
  start: 4.5,
  canoe: 2.5,
  bike: 2.0,
  tracks: 2.25,
  paddle: 1.55,
  cairn: 1.55,
  rope: 1.35,
  'tree-note': 1.25,
  tin: 1.55,
  stick: 1.2,
  'second-night': 2.2,
};

const _ray = { o: new THREE.Vector3(), d: new THREE.Vector3() };
const _ndc = new THREE.Vector3();

const LOOK = {
  journal: () => `${pickVerb()}&nbsp; open the journal`,
  ring: () => 'a cold fire ring. they were working the book.',
  stakes: () => 'stake holes. packed in a hurry.',
  cairn: () => 'a cairn. someone waited here till dusk.',
  'tree-note': () => `${pickVerb()}&nbsp; a note for M.`,
  bike: () => 'a bike on its side. dropped, not parked.',
  tracks: () => 'a tyre track. they were covering ground.',
  rope: () => 'a line on the trunk. left as they went.',
  tin: () => 'an empty tin. they did not stay to finish it.',
  stick: () => 'a stick they left. they did not wait for morning.',
  canoe: () => 'a canoe on the bank. hauled out fast.',
  paddle: () => 'a paddle, leaned and left. they did not go back on.',
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
    this.halos = [];
    this.origin = null;
    this.features = null;
    this.clearings = [];
    this.ground = null;
    this._bookInHand = false;
    this.pointerClaim = false;
    this._rockMemo = new Map();
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
    this._placeStory(rnd);
    this._placeHalos();
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

    // The book, on the dirt beside the ring. They left it for M. — or for
    // whoever came next. Not on a table. Nobody is still sitting here.
    const jx = cx + Math.sin(yaw + 0.55) * 1.15;
    const jz = cz + Math.cos(yaw + 0.55) * 1.15;
    const pad = new THREE.Group();
    pad.name = 'trace_journal_pad';
    const jy = placeOnGround(world, pad, jx, jz, yaw + 0.4, 0.75, 0.2, floor(jx, jz) + 0.004);
    this.root.add(pad);
    const holder = seatJournal(rnd, pad);
    if (holder) this._spot(holder, 'journal', jx, jy + 0.02, jz);

    this._addCrumb('start', cx, cz, false, 'camp');
  }

  /**
   * Place the rest of the job along one roamable path out from camp.
   * Water is moose-and-wake, the bike is a drop, the lip is a dusk wait,
   * the exit is a hurry. Beats stay in authored order; a kind that cannot
   * land is skipped, not swapped for dressing.
   */
  _placeStory(rnd) {
    const weekend = pickWeekend(this.features);
    const scraps = assignScraps(weekend.kinds, this.features);
    this.plan = weekend.kinds;
    this.beats = weekend.list.map((b) => b.id);
    this.scraps = scraps;
    const taken = [{ x: this.origin.x, z: this.origin.z, beat: 'camp', id: 'start' }];
    let prev = { x: this.origin.x, z: this.origin.z, beat: 'camp', id: 'start' };
    let heading = this._openingHeading();

    for (const beat of weekend.list) {
      if (beat.id === 'camp') continue;
      for (const kind of beat.kinds) {
        const p = this._pickStoryAnchor(kind, beat.id, prev, heading, taken, rnd);
        if (!p) continue;
        if (!this._placeKind(kind, p, rnd, scraps.get(kind) ?? null)) continue;
        const row = { x: p.x, z: p.z, beat: beat.id, id: kind, yaw: p.yaw };
        taken.push(row);
        this._addCrumb(kind, p.x, p.z, scraps.has(kind), beat.id);
        heading = Math.atan2(p.x - this.origin.x, p.z - this.origin.z);
        prev = row;
      }
    }
  }

  /** First outing: the nearest honest water, or a road if the seed is dry. */
  _openingHeading() {
    const o = this.origin;
    const w = this.features.waterNear;
    if (w) return Math.atan2(w.x - o.x, w.z - o.z);
    let best = null, bestD = Infinity;
    for (const p of this.features.pois?.road ?? []) {
      const d = Math.hypot(p.x - o.x, p.z - o.z);
      if (d > 60 && d < 360 && d < bestD) { bestD = d; best = p; }
    }
    if (best) return Math.atan2(best.x - o.x, best.z - o.z);
    return 0.4;
  }

  _pickStoryAnchor(kind, beat, prev, heading, taken, rnd) {
    const world = this.ctx.world;
    const origin = this.origin;

    // Same-beat partners stay on the same feature: canoe off the paddle's
    // bank, bike farther along the tracks' road, note on the way up to the cairn.
    if (kind === 'canoe' && prev.id === 'paddle') {
      const shore = this._shoreFrom(prev, 26, 48);
      if (shore && this._free(shore, taken, MIN_SEP - PAIR_MIN)) return { ...prev, ...shore };
    }
    if (kind === 'bike' && prev.id === 'tracks') {
      const along = this._fartherAlongRoad(prev, heading, taken);
      if (along) return along;
    }
    if (kind === 'tree-note' && prev.id === 'cairn') {
      const mid = {
        x: prev.x * 0.62 + origin.x * 0.38,
        z: prev.z * 0.62 + origin.z * 0.38,
      };
      const tree = this._nearTree(mid.x, mid.z, 70);
      if (tree && this._free(tree, taken, MIN_SEP - PAIR_MIN)) return { ...tree, tree };
    }

    const raw = this._candidates(kind);
    const scored = [];
    for (const p of raw) {
      if (!world.isInBounds(p.x, p.z)) continue;
      const d0 = Math.hypot(p.x - origin.x, p.z - origin.z);
      const minD = beat === 'water' ? 48 : MIN_FROM_START;
      if (d0 < minD || d0 > MAX_FROM_START) continue;
      if (world.getWaterDepth(p.x, p.z) > (kind === 'canoe' ? 0.55 : 0.18)) continue;
      if (world.getSlope(p.x, p.z) > 0.85) continue;
      const pair = prev.beat === beat;
      const need = pair ? PAIR_MIN : MIN_SEP;
      let near = false;
      for (const t of taken) {
        if (Math.hypot(p.x - t.x, p.z - t.z) < need) { near = true; break; }
      }
      if (near) continue;
      scored.push({ p, rank: this._storyRank(p, kind, beat, origin, prev, heading) + rnd() * 4 });
    }
    scored.sort((a, b) => b.rank - a.rank);
    for (const { p } of scored) {
      const resolved = this._resolvePoint(kind, p, taken, rnd);
      if (resolved) return resolved;
    }
    return null;
  }

  _storyRank(p, kind, beat, origin, prev, heading) {
    const d0 = Math.hypot(p.x - origin.x, p.z - origin.z);
    const [lo, hi] = BAND[beat] ?? [80, 500];
    let s = 0;
    if (d0 < lo) s -= (lo - d0) * 0.08;
    else if (d0 > hi) s -= (d0 - hi) * 0.04;
    else s += 22;

    const dPrev = Math.hypot(p.x - prev.x, p.z - prev.z);
    if (prev.beat === beat) {
      s -= Math.abs(dPrev - (PAIR_AT[beat] ?? 50)) * 0.35;
    } else if (prev.id !== 'start') {
      if (dPrev < 70) s -= (70 - dPrev) * 0.45;
      else if (dPrev > 300) s -= (dPrev - 300) * 0.05;
      else s += 14;
      // Prefer not to walk back toward camp.
      const dPrev0 = Math.hypot(prev.x - origin.x, prev.z - origin.z);
      if (d0 + 18 < dPrev0) s -= (dPrev0 - d0) * 0.12;
    }

    if (heading != null) {
      const a = Math.atan2(p.x - origin.x, p.z - origin.z);
      const da = Math.abs(Math.atan2(Math.sin(a - heading), Math.cos(a - heading)));
      s -= da * 16;
    }
    if (kind === 'tracks') s -= Math.max(0, d0 - 230) * 0.04;
    if (kind === 'bike') s += Math.min(80, Math.max(0, d0 - 140)) * 0.05;
    if (beat === 'exit') s += Math.min(d0, 500) * 0.025;
    return s;
  }

  _resolvePoint(kind, p, taken, rnd) {
    if (kind === 'canoe') {
      const shore = this._shoreNear(p);
      if (shore && this._free(shore, taken, MIN_SEP - PAIR_MIN)) return { ...p, ...shore };
      return null;
    }
    if (kind === 'paddle') {
      const bank = this._bankClear(p);
      if (bank && this._free(bank, taken, MIN_SEP - PAIR_MIN)) return { ...p, ...bank };
      return null;
    }
    if (kind === 'tree-note' || kind === 'rope') {
      const tree = this._nearTree(p.x, p.z, 55, { skipConifer: kind === 'rope' });
      if (tree && this._free(tree, taken, 12)) return { ...p, ...tree, tree };
      return null;
    }
    if (kind === 'bike' || kind === 'tracks') {
      const off = this._offPath(p, rnd);
      if (this._free(off, taken, MIN_SEP - PAIR_MIN)) return off;
      return null;
    }
    if (kind === 'cairn') {
      const seat = this._seatCairn(p, rnd);
      if (seat && this._free(seat, taken, MIN_SEP - PAIR_MIN)) return { ...p, ...seat };
      return null;
    }
    const nudged = this._nudgeClear(p.x, p.z, rnd);
    if (this._free(nudged, taken)) return { ...p, ...nudged };
    return null;
  }

  /** Walk the waterline from a put-in so the canoe is the same visit. */
  _shoreFrom(from, lo, hi) {
    const world = this.ctx.world;
    const yaw = from.yaw ?? 0;
    for (const a of [yaw, yaw + 1.1, yaw - 1.1, yaw + Math.PI * 0.5]) {
      for (let d = lo; d <= hi; d += 3) {
        const x = from.x + Math.sin(a) * d;
        const z = from.z + Math.cos(a) * d;
        if (!world.isInBounds(x, z)) continue;
        const depth = world.getWaterDepth(x, z);
        if (depth >= 0.03 && depth <= 0.24 && world.getSlope(x, z) < 0.6) {
          return { x, z, yaw: a };
        }
      }
    }
    return this._shoreNear(from);
  }

  /** Next bend along the same track, farther from camp than the ruts. */
  _fartherAlongRoad(tracks, heading, taken) {
    const origin = this.origin;
    const dTracks = Math.hypot(tracks.x - origin.x, tracks.z - origin.z);
    const yaw = tracks.yaw ?? heading ?? 0;
    let best = null, bestS = -Infinity;
    for (const p of this.features.pois?.road ?? []) {
      const d0 = Math.hypot(p.x - origin.x, p.z - origin.z);
      if (d0 < dTracks + 28 || d0 > dTracks + 140) continue;
      const dy = p.yaw != null
        ? Math.abs(Math.atan2(Math.sin(p.yaw - yaw), Math.cos(p.yaw - yaw)))
        : 2;
      if (dy > 0.85) continue;
      const off = this._offPath(p, () => 0.35);
      if (!this._free(off, taken, PAIR_MIN)) continue;
      const s = -dy * 20 - Math.abs(d0 - (dTracks + 70)) * 0.08;
      if (s > bestS) { bestS = s; best = off; }
    }
    return best;
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
   * Bank leftover that a walk from camp to the water can actually see —
   * dry, near the waterline, out from under leaf clumps.
   */
  _bankClear(p) {
    const world = this.ctx.world;
    const origin = this.origin;
    const seed = this._bankNear(p);
    if (!seed) return null;
    const toCamp = Math.atan2(origin.x - seed.x, origin.z - seed.z);
    let best = null, bestS = -Infinity;
    for (const da of [-1.2, -0.7, 0, 0.7, 1.2, Math.PI]) {
      const a = (seed.yaw ?? toCamp) + da;
      for (let d = 0; d <= 28; d += 1.6) {
        const x = seed.x + Math.sin(a) * d;
        const z = seed.z + Math.cos(a) * d;
        if (!world.isInBounds(x, z)) continue;
        if (world.getWaterDepth(x, z) > 0.02) continue;
        if (world.getSlope(x, z) > 0.5) continue;
        if (!this._nearWater(x, z, 7)) continue;
        if (!this._leafClear(x, z)) continue;
        const toward = Math.cos(toCamp - Math.atan2(x - origin.x, z - origin.z));
        const s = toward * 8 - d * 0.08;
        if (s > bestS) { bestS = s; best = { x, z, yaw: a }; }
      }
    }
    return best ?? (this._leafClear(seed.x, seed.z) ? seed : null);
  }

  _nearWater(x, z, maxR) {
    const world = this.ctx.world;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      if (world.getWaterDepth(x + Math.sin(a) * maxR, z + Math.cos(a) * maxR) > 0.04) return true;
    }
    return world.getWaterDepth(x, z) > 0.01;
  }

  _leafClear(x, z) {
    const tree = this._nearTree(x, z, 16);
    if (!tree) return true;
    const d = Math.hypot(tree.x - x, tree.z - z);
    return d > (tree.crownR ?? 3.2) + 2.4;
  }

  /**
   * Nearest tree by walking the 64 m buckets around a point — not the 120k
   * list. Trees init before Traces, so the arrays are already filled.
   */
  _nearTree(x, z, maxR = 48, opts = {}) {
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
          if (opts.skipConifer && SPECIES[pspec[t]]?.conifer) continue;
          const dx = px[t] - x, dz = pz[t] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD) { bestD = d2; best = t; }
        }
      }
    }
    if (best < 0) return null;
    const sp = SPECIES[pspec[best]];
    const H = pImpH[best] ?? 10;
    const trunkR = Math.max(0.07, H * (sp?.trunkRadiusK ?? 0.02));
    const crownR = Math.max(2.2, H * (sp?.crownR ?? 0.22));
    return {
      x: px[best], y: py[best], z: pz[best],
      scale: pscale[best], trunkR, crownR, H, i: best,
    };
  }

  _placeKind(kind, p, rnd, scrap) {
    const world = this.ctx.world;
    const yaw = p.yaw ?? rnd() * Math.PI * 2;

    if (kind === 'tree-note') {
      const tree = p.tree;
      if (!tree) return false;
      // Face the paper toward camp so a walk out from the scuff finds it,
      // not the blank far side of the trunk.
      const dx = this.origin.x - tree.x, dz = this.origin.z - tree.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = dx / len, nz = dz / len;
      // A fat maple bole is ~0.35 m at note height; sit the paper outside it
      // so it cannot vanish inside the instance.
      const note = buildTreeNote(rnd);
      const hx = tree.x + nx * 0.50;
      const hz = tree.z + nz * 0.50;
      const hy = (tree.y ?? world.getHeight(tree.x, tree.z)) + 1.55;
      note.position.set(hx, hy, hz);
      note.lookAt(tree.x, hy, tree.z);
      this.root.add(note);
      p.x = hx; p.z = hz;
      this._spot(note, 'tree-note', hx, hy, hz, scrap);
      return true;
    }

    if (kind === 'rope') {
      const tree = p.tree;
      if (!tree) return false;
      const dx = this.origin.x - tree.x, dz = this.origin.z - tree.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = dx / len, nz = dz / len;
      const rope = buildTrunkRope(rnd, tree.trunkR);
      const hx = tree.x + nx * 0.36;
      const hz = tree.z + nz * 0.36;
      const y = placeOnGround(world, rope, hx, hz, Math.atan2(nx, nz), 0.08, 0.25);
      this.root.add(rope);
      p.x = hx; p.z = hz;
      this._spot(rope, 'rope', hx, y + 0.85, hz);
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
      this.clearings.push({ x: p.x, z: p.z, radius: 1.45, feather: 0.48 });
      const tin = buildCoffeeTin(rnd);
      const y = placeOnGround(world, tin, p.x, p.z, yaw, 0.55, 0.28);
      this.root.add(tin);
      this._spot(tin, 'tin', p.x, y + 0.10, p.z, scrap);
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
      const y = placeOnGround(world, paddle, p.x, p.z, yaw, 0.06, 0.4);
      this.root.add(paddle);
      this._spot(paddle, 'paddle', p.x, y + 0.75, p.z, scrap);
      return true;
    }

    if (kind === 'cairn') {
      if (!this._cairnClear(p.x, p.z)) return false;
      this.clearings.push({ x: p.x, z: p.z, radius: 1.85, feather: 0.55 });
      const cairn = buildCairn(rnd);
      const y = placeOnGround(world, cairn, p.x, p.z, rnd() * Math.PI * 2, 0.10, 0.42);
      this.root.add(cairn);
      this._spot(cairn, 'cairn', p.x, y + 0.4, p.z);
      return true;
    }

    return false;
  }

  _addCrumb(id, x, z, readable, beat = null) {
    this.crumbs.push({ id, x, z, readable: !!readable, beat });
  }

  /**
   * One faint notice halo per leftover AOI. The start scuff + stakes
   * + journal share a ring (they're one camp patch). Everything else
   * gets its own. Tree-note / rope sit the ribbon on the ground at
   * the tree, not up at the paper.
   *
   * This is the noticing cue. Do not add or grow dirt pads to do the
   * same job — that language is camp placement.
   */
  _placeHalos() {
    const world = this.ctx.world;
    for (const c of this.crumbs) {
      const r = HALO_R[c.id] ?? 1.2;
      const g = buildNoticeHalo(world, c.x, c.z, r);
      g.userData.kind = c.id;
      this.root.add(g);
      this.halos.push(g);
    }
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

  /**
   * Inland of the lip, on dirt you can see — not inside a slab. Searches
   * toward camp (the wait) out to ~70 m. Returns null if this POI is only
   * rock chaos; the caller then tries the next vista or skips the cairn.
   */
  _seatCairn(p, rnd) {
    const world = this.ctx.world;
    const origin = this.origin;
    const toCamp = Math.atan2(origin.x - p.x, origin.z - p.z);
    let downA = toCamp;
    let downDrop = -Infinity;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const hx = p.x + Math.sin(a) * 22;
      const hz = p.z + Math.cos(a) * 22;
      if (!world.isInBounds(hx, hz)) continue;
      const drop = world.getHeight(p.x, p.z) - world.getHeight(hx, hz);
      if (drop > downDrop) { downDrop = drop; downA = a; }
    }
    const inland = downA + Math.PI;
    const axes = [toCamp, inland, (toCamp + inland) * 0.5];
    let best = null, bestS = -Infinity;
    for (const axis of axes) {
      for (let d = 14; d <= 72; d += 4) {
        for (const da of [-0.85, -0.4, 0, 0.4, 0.85]) {
          const x = p.x + Math.sin(axis + da) * d;
          const z = p.z + Math.cos(axis + da) * d;
          const clear = this._cairnClear(x, z);
          if (!clear) continue;
          const towardCamp = -Math.hypot(x - origin.x, z - origin.z) * 0.01;
          const lower = Math.max(0, world.getHeight(p.x, p.z) - world.getHeight(x, z));
          const s = clear.score + towardCamp + lower * 0.15 - Math.abs(d - 32) * 0.04 + rnd() * 0.2;
          if (s > bestS) { bestS = s; best = { x, z }; }
        }
      }
    }
    return best;
  }

  /** Flat, dry, no slab overlap — the stack has to read against dirt/sky. */
  _cairnClear(x, z) {
    const world = this.ctx.world;
    if (!world.isInBounds(x, z)) return null;
    if (world.getWaterDepth(x, z) > 0.02) return null;
    const sl = world.getSlope(x, z);
    if (sl > 0.30) return null;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const h = world.getHeight(x + Math.sin(a) * 2.6, z + Math.cos(a) * 2.6);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    const here = world.getHeight(x, z);
    const rough = hi - lo;
    if (rough > 1.15) return null;
    if (hi - here > 1.4) return null;
    if (this._rockHit(x, z, 5.2)) return null;
    return { score: -sl * 40 - rough * 10 };
  }

  /**
   * True if a boulder *extent* (not just its origin) comes within `pad`
   * metres. Giant lip slabs are 10–20 m across; a 6 m origin check misses them.
   */
  _rockHit(x, z, pad = 5) {
    const key = `${(x / 3) | 0},${(z / 3) | 0},${pad | 0}`;
    if (this._rockMemo.has(key)) return this._rockMemo.get(key);
    const rocks = this.ctx.systems?.rocks;
    let hit = false;
    if (rocks?.rocksAround) {
      try {
        const list = rocks.rocksAround(x, z, 24, 0.7, []);
        for (const inst of list) {
          const reach = (rocks.reachOf?.(inst) ?? inst.size * 0.5) + pad;
          const dx = inst.x - x, dz = inst.z - z;
          if (dx * dx + dz * dz < reach * reach) { hit = true; break; }
        }
      } catch { hit = false; }
    }
    this._rockMemo.set(key, hit);
    return hit;
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
        'tree-note': 'a note for M.',
        tin: 'a scrap under the tin',
        bike: 'a scrap by the bike',
        canoe: 'a scrap in the canoe',
        paddle: 'a scrap by the paddle',
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
        const far = SMALL_LOOK.has(s.kind) ? LOOK_FAR_SMALL : LOOK_FAR;
        if (along > 0.4 && along < far) { bestMiss = miss; best = s; }
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

  update(_dt, elapsed) {
    if (window.__forceCamera) this.scrap?.hide(true);
    const bookOpen = !!this.ctx.systems?.hud?.journal?.visible;
    if (bookOpen !== this._bookInHand) {
      this._bookInHand = bookOpen;
      for (const s of this.spots) {
        if (s.kind === 'journal') s.obj.visible = !bookOpen;
      }
    }
    // Overlay scrap/journal covers the frame — don't billboard
    // through it. Forced-camera shots keep the halo; that's the
    // noticing cue QA is looking for.
    const overlay = (bookOpen || this.scrap?.open) && !window.__forceCamera;
    this._tickHalos(elapsed, overlay);
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

  _tickHalos(elapsed, overlay) {
    if (!this.halos.length) return;
    const cam = this.ctx.camera;
    const pos = this.ctx.systems?.vehicle?.position;
    // Forced-camera QA poses the view, not the van — measure from
    // the lens so a leftover shot still shows its own ring.
    const px = window.__forceCamera ? cam.position.x : (pos?.x ?? cam.position.x);
    const pz = window.__forceCamera ? cam.position.z : (pos?.z ?? cam.position.z);
    const world = this.ctx.world;
    for (const g of this.halos) {
      const n = g.userData.notice;
      if (!n) continue;
      if (overlay) {
        updateNoticeHalo(g, 1e6, 0, elapsed);
        continue;
      }
      const dist = Math.hypot(px - n.x, pz - n.z);
      const hy = (world.getHeight?.(n.x, n.z) ?? 0) + 0.4;
      _ndc.set(n.x, hy, n.z).project(cam);
      const off = Math.max(Math.abs(_ndc.x), Math.abs(_ndc.y));
      // Soft edge past the frame, not a hard clip — a leftover just
      // off-screen still whispers if you're standing in its range.
      const onScreen = 1 - THREE.MathUtils.smoothstep(off, 0.95, 1.35);
      updateNoticeHalo(g, dist, onScreen, elapsed);
    }
  }

  dispose() {
    this.prompt?.dispose();
    this.scrap?.dispose();
    this.ground?.dispose();
    this.ground = null;
    for (const g of this.halos) disposeNoticeHalo(g);
    this.halos = [];
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
      'max-width:min(360px,82vw)', 'min-width:260px', 'padding:22px 26px 20px',
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
      p.style.margin = '0 0 0.4em';
      p.style.whiteSpace = 'nowrap';
      // Caveat's space glyph is thin in the DOM; keep words apart by hand.
      for (const w of line.split(/\s+/)) {
        const s = document.createElement('span');
        s.textContent = w;
        s.style.marginRight = '0.42em';
        s.style.display = 'inline-block';
        p.appendChild(s);
      }
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
