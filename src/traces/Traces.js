// ─────────────────────────────────────────────────────────────────────────────
//  Traces — one weekend of William's work for M., then he left.
//
//  Not a quest. No pins, no leave-gate. William was documenting this
//  valley for M.: usuals first (so a shadow is a shadow), the unnamed
//  "anything else" later. The player is neither of them — they found
//  his book. Each leftover is a beat of that job — a fast haul-out, a
//  dropped bike, a dusk note — not camp dressing. Discover by standing
//  near them and looking. Split noticing: the burned start camp keeps
//  its dirt pad (his leftover pitch — not player camp-placement UI).
//  Small crumbs (paddle, canoe, cairn, tin, rope, note, bike, …) get a
//  close ice-white notice — a short wall that stands out of the grass,
//  not a dirt-coloured ribbon on the dirt. A drive-by still does not
//  see it. After the table note, a pocket compass on
//  the HUD — his scrap of paper — follows the *next leftover* (paddle/canoe,
//  then bike, …) —
//  never the camp table, journal, ring, or scuff. The valley map no
//  longer carries that ring; the HUD chip is the source of truth.
//  Camp dirt stays
//  dirt-only: no UI halo on the burned scuff. No pin, compass POI, or `!`.
//  About one in three crumbs is a short scrap in the same hand as the journal.
//  At leftover hinges a thought tooltip (HUD.think) can fire once —
//  private, not a look prompt, never a "go here". First walk into a
//  beat's soft region fires one extra line so the circle is not empty.
//  The circle advances only when a leftover of that beat is noticed
//  (look prompt or click), never by standing in the pad.
//
//  A folding table at the scuff holds a physical note; clicking the
//  paper opens the scrap, not a click on the cold ring. The book on
//  the dirt is William's field book (the same overlay the J key opens).
//  He did not leave it as a handoff — he left in a hurry. Clicking it
//  goes through
//  HUD.openFoundJournal so the first leaf is M.'s letter, not the
//  checklist. That leftover mesh is a closed leather prop (no page
//  canvases). Opening the overlay book is the existing 10×1024×1452
//  CanvasTexture path — a Chrome tab discard on a small GPU is that
//  path, not an extra WebGL cost this system adds.
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
import { seedFeatures, pickWeekend, assignScraps, ringNote, BEAT_HINT, ENTER_THOUGHT } from './prior_notes.js';
import { buildTable } from '../camp/camp_table.js';
import {
  buildColdRing, buildStakeHoles, buildCairn, seatJournal, seatTableNote, placeOnGround,
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
// Current-beat leftovers only — still close, just readable once you're
// already in the region. A drive-by at speed does not get these.
const LOOK_FAR_NOW = 40;
const LOOK_FAR_SMALL_NOW = 44;
// Spawn guard: do not fire an enter thought while still on the scuff.
const CAMP_LEAVE = 22;
// Soft neighborhood around the *next leftover* — used for enter thoughts
// and as the HUD seek target, not drawn on the map. Tens of metres, not a
// valley pad — camp must not already be standing in it. Clamped down when
// the crumb sits close so the pad never wraps spawn.
const AREA_R = 80;
const AREA_R_MIN = 32;
const AREA_CAMP_GAP = 36;
// Preferred crumb for the HUD seek chip, in beat order. Water's paddle
// (else canoe); ride's bike (else tracks). Not a pin on the mesh.
const GUIDE_KIND = {
  water: ['paddle', 'canoe'],
  ride: ['bike', 'tracks'],
  lip: ['cairn', 'tree-note'],
  trees: ['tree-note'],
  exit: ['tin', 'rope', 'stick'],
};
const SMALL_LOOK = new Set(['tin', 'paddle', 'rope', 'tree-note', 'cairn', 'table-note']);
// Never a seek target — the HUD chip follows the next leftover ahead, not the scuff.
const GUIDE_SKIP = new Set(['start', 'ring', 'journal', 'table-note', 'stakes']);
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

// Small leftovers only — the start camp does not get a halo.
const HALO_SKIP = new Set(['start']);
// Metres from leftover centre to the ribbon midline.
const HALO_R = {
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
const _fwd = new THREE.Vector3();

const LOOK = {
  journal: () => `${pickVerb()}&nbsp; William's journal`,
  ring: () => 'the ring is cold.',
  'table-note': () => `${pickVerb()}&nbsp; William's note`,
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
    this._ringRead = false;
    this._ringOpenedBook = false;
    this._guideBeat = null;
    this._area = null;
    this.noticed = new Set();
    this._entered = new Set();
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
    this._refreshGuidance();

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
    this._placingBeat = 'camp';

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
    this._spot(ring, 'ring', cx, ry, cz, null, 'camp');

    // Stake holes off to one side — the tent, packed and gone.
    const sa = yaw + 1.15;
    const sx = cx + Math.sin(sa) * 2.4;
    const sz = cz + Math.cos(sa) * 2.4;
    const stakes = buildStakeHoles(rnd);
    const sy = placeOnGround(world, stakes, sx, sz, sa, 0.7, 1.0, floor(sx, sz));
    this.root.add(stakes);
    this._spot(stakes, 'stakes', sx, sy, sz, null, 'camp');

    // Folding table he left standing, with a note on it. The scrap is
    // the paper, not a click on the ring. Undressed — no mug, nobody
    // is still sitting here.
    const ta = yaw - 1.08;
    const td = 1.58;
    const tx = cx + Math.sin(ta) * td;
    const tz = cz + Math.cos(ta) * td;
    const table = buildTable(rnd, { wear: 0.62 });
    table.name = 'trace_table';
    const toward = Math.atan2(cx - tx, cz - tz);
    placeOnGround(world, table, tx, tz, toward, 0.55, 0.40, floor(tx, tz));
    this.root.add(table);
    const note = seatTableNote(rnd, table);
    if (note) {
      table.updateMatrixWorld(true);
      const np = new THREE.Vector3();
      note.getWorldPosition(np);
      this._spot(note, 'table-note', np.x, np.y, np.z, { lines: ringNote() }, 'camp');
    }

    // William's book, on the dirt beside the ring. Mid-job, not a
    // handoff. The table holds the note; the book is the found frame.
    const jx = cx + Math.sin(yaw + 0.55) * 1.15;
    const jz = cz + Math.cos(yaw + 0.55) * 1.15;
    const pad = new THREE.Group();
    pad.name = 'trace_journal_pad';
    const jy = placeOnGround(world, pad, jx, jz, yaw + 0.4, 0.75, 0.2, floor(jx, jz) + 0.004);
    this.root.add(pad);
    const holder = seatJournal(rnd, pad);
    if (holder) this._spot(holder, 'journal', jx, jy + 0.02, jz, null, 'camp');

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
        this._placingBeat = beat.id;
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
   * Close-only notice on small leftovers. The start camp is skipped
   * — its dirt pad is the leftover pitch, and that is the cue. Tree-note
   * / rope sit the halo on the ground at the tree, not at the paper.
   */
  _placeHalos() {
    const world = this.ctx.world;
    for (const c of this.crumbs) {
      if (HALO_SKIP.has(c.id)) continue;
      const r = HALO_R[c.id] ?? 1.2;
      const g = buildNoticeHalo(world, c.x, c.z, r);
      g.userData.kind = c.id;
      g.userData.beat = c.beat;
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

  _spot(obj, kind, x, y, z, scrap = null, beat = null) {
    const pickR = obj.userData?.trace?.pickR ?? 0.4;
    this.spots.push({
      kind, obj, x, y, z, pickR, scrap,
      beat: beat ?? this._placingBeat ?? 'camp',
    });
  }

  /** Soft region the HUD seek chip follows — neighborhood around the next leftover. */
  get guidance() {
    // Blank until the table note is read, so the chip *arrives* as the
    // handoff rather than pointing from boot.
    if (!this._ringRead) return null;
    return this._area;
  }

  /**
   * Fuzzy pad around the current beat's next un-noticed leftover.
   * Centered on that crumb (paddle/canoe, then bike, …) with a cozy
   * radius — a shore neighborhood, not a pin and not a map-wide AOE.
   * Camp is never inside it. Advances only in `_notice`.
   */
  _refreshGuidance() {
    const order = (this.beats ?? []).filter((id) => id !== 'camp');
    let i = this._guideBeat ? order.indexOf(this._guideBeat) : 0;
    if (i < 0) i = 0;
    for (; i < order.length; i++) {
      const id = order[i];
      const pt = this._targetOf(id);
      if (!pt) continue;
      this._guideBeat = id;
      this._area = this._areaOf(id, pt);
      return;
    }
    this._guideBeat = null;
    this._area = null;
  }

  /** Primary leftover for a beat — first preferred kind that actually placed. */
  _targetOf(beat) {
    const pts = this.crumbs.filter((c) => c.beat === beat && !GUIDE_SKIP.has(c.id));
    if (!pts.length) return null;
    for (const id of (GUIDE_KIND[beat] ?? [])) {
      const hit = pts.find((c) => c.id === id);
      if (hit) return hit;
    }
    return pts[0];
  }

  _areaOf(beat, pt) {
    const dCamp = Math.hypot(pt.x - this.origin.x, pt.z - this.origin.z);
    const r = Math.min(AREA_R, Math.max(AREA_R_MIN, dCamp - AREA_CAMP_GAP));
    return {
      beat,
      kind: pt.id,
      x: pt.x,
      z: pt.z,
      r,
      label: BEAT_HINT[beat] ?? '',
    };
  }

  /**
   * Leftover-only advance. Looking at or clicking a crumb of this beat
   * marks it noticed and the circle retargets the *next beat's* primary
   * leftover. Standing inside the region never advances.
   * Camp is always already-behind. A second call for a past beat is a no-op.
   */
  _notice(beat) {
    if (!beat) return;
    this.noticed.add(beat);
    if (beat === 'camp') return;
    const order = (this.beats ?? []).filter((id) => id !== 'camp');
    const i = order.indexOf(beat);
    const cur = order.indexOf(this._guideBeat);
    if (i < 0) return;
    if (cur >= 0 && i < cur) return;
    this._guideBeat = order[i + 1] ?? null;
    this._refreshGuidance();
  }

  /**
   * Once per beat: the player is approaching the next leftover's
   * neighborhood. The circle is around that crumb, not around camp, so
   * a circumference-cross is a real arrival. CAMP_LEAVE is only a spawn
   * guard. Sparse. One thought. Not while the book or a scrap is open.
   */
  _tickRegion(px, pz, quiet) {
    if (quiet) return;
    const a = this._area;
    const beat = this._guideBeat;
    if (!a || !beat || beat === 'camp') return;
    if (this._entered.has(beat)) return;
    const dx = px - a.x;
    const dz = pz - a.z;
    const reach = a.r * 1.2;
    if (dx * dx + dz * dz > reach * reach) return;
    if (Math.hypot(px - this.origin.x, pz - this.origin.z) < CAMP_LEAVE) return;
    const thought = ENTER_THOUGHT[beat];
    if (!thought) return;
    this._entered.add(beat);
    this.ctx.systems?.hud?.think?.(thought);
  }

  /**
   * One private thought per leftover hinge. Copy is in THOUGHTS; HUD latches
   * so a second click is silence. Ride has no line — covering ground is
   * the HUD chip's job.
   */
  _thinkBeat(hit) {
    const beat = hit?.beat;
    if (!beat || beat === 'camp' || beat === 'ride') return;
    const id = beat === 'trees' ? 'lip' : beat;
    this.ctx.systems?.hud?.think?.(id);
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
    if (hit.kind === 'ring') {
      if (!this._ringRead) return LOOK.ring();
      if (!this._ringOpenedBook) return `${pickVerb()}&nbsp; open William's journal`;
      return this.features?.hasWater
        ? 'the ring is cold. they went toward the water.'
        : 'the ring is cold. they went covering ground.';
    }
    if (hit.scrap?.lines?.length && hit.kind !== 'journal') {
      const quiet = {
        'table-note': "William's note",
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
    this._notice(hit.beat);
    if (hit.kind === 'journal') {
      this._ringOpenedBook = true;
      this.ctx.systems?.hud?.openFoundJournal?.();
      return;
    }
    if (hit.kind === 'table-note') {
      this._ringRead = true;
      this._refreshGuidance();
      const lines = hit.scrap?.lines?.length ? hit.scrap.lines : ringNote();
      this.scrap?.show(lines, {
        onHide: () => {
          const hud = this.ctx.systems?.hud;
          if (this._ringOpenedBook) {
            hud?.toast?.(this.features?.hasWater
              ? 'they went toward the water.'
              : 'they went covering ground.');
          } else {
            hud?.toast?.("William's book is on the dirt. J opens it.");
          }
          hud?.beginSeek?.();
          hud?.think?.('ring');
        },
      });
      return;
    }
    if (hit.kind === 'ring') {
      // The scrap is the note on the table, not a click on empty air.
      // After reading it, the ring can still open the found book.
      if (!this._ringRead) return;
      this._ringOpenedBook = true;
      this.ctx.systems?.hud?.openFoundJournal?.();
      return;
    }
    if (hit.scrap?.lines?.length) {
      this.scrap?.show(hit.scrap.lines, {
        onHide: () => this._thinkBeat(hit),
      });
      return;
    }
    this._thinkBeat(hit);
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
        const current = s.beat === this._guideBeat;
        const far = current
          ? (SMALL_LOOK.has(s.kind) ? LOOK_FAR_SMALL_NOW : LOOK_FAR_NOW)
          : (SMALL_LOOK.has(s.kind) ? LOOK_FAR_SMALL : LOOK_FAR);
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
    const hud = this.ctx.systems?.hud;
    const bookOpen = !!(hud?.journal?.visible || hud?.journal?.active);
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
    const veh = this.ctx.systems?.vehicle;
    const cam = this.ctx.camera;
    const px = window.__forceCamera ? cam.position.x : (veh?.position?.x ?? cam.position.x);
    const pz = window.__forceCamera ? cam.position.z : (veh?.position?.z ?? cam.position.z);
    this._tickRegion(px, pz, bookOpen || !!this.scrap?.open);

    if (bookOpen || this.scrap?.open) {
      this.prompt.set('');
      this.pointerClaim = false;
      return;
    }

    // While the brake is latched Camp owns the prompt (it calls offer()).
    // Here we cover the other half: parked by the game's own hold, or just
    // looking around before anyone has pressed Space.
    if (veh?.brakeHold) { this.prompt.set(''); this.pointerClaim = false; return; }
    if (this.ctx.systems?.hud?.photo?.active) { this.prompt.set(''); return; }
    if (!pointing(this.ctx.input)) { this.prompt.set(''); this.pointerClaim = false; return; }

    const hit = this._pick();
    this.pointerClaim = !!hit;
    if (hit) {
      // Look-prompt on a leftover of the *current* beat counts as
      // notice — that's when the circle advances, not standing in
      // the region. Click still fires the leftover thought.
      if (hit.beat === this._guideBeat && hit.beat !== 'camp') this._notice(hit.beat);
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
      const current = g.userData.beat === this._guideBeat;
      const hy = (world.getHeight?.(n.x, n.z) ?? 0) + 0.4;
      _ndc.set(n.x, hy, n.z).project(cam);
      const off = Math.max(Math.abs(_ndc.x), Math.abs(_ndc.y));
      const onScreen = 1 - THREE.MathUtils.smoothstep(
        off, current ? 1.0 : 0.85, current ? 1.38 : 1.15,
      );
      cam.getWorldDirection(_fwd);
      const tx = n.x - cam.position.x;
      const tz = n.z - cam.position.z;
      const tlen = Math.hypot(tx, tz) || 1;
      const flen = Math.hypot(_fwd.x, _fwd.z) || 1;
      const align = (_fwd.x * tx + _fwd.z * tz) / (flen * tlen);
      // Prefer looking toward it. Behind / hard-aside fades out.
      // Current-beat leftovers keep a looser facing so a shore roam
      // still reads the ribbon without a billboard at drive-by range.
      const facing = THREE.MathUtils.smoothstep(
        align, current ? -0.12 : 0.08, current ? 0.38 : 0.55,
      );
      updateNoticeHalo(g, dist, onScreen * facing, elapsed, current ? 1.65 : 1, cam.position);
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
    this._area = null;
    this._guideBeat = null;
    this._entered.clear();
    this.noticed.clear();
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

  show(lines, { onHide } = {}) {
    if (window.__forceCamera) return;
    this._onHide = onHide ?? null;
    this.card.replaceChildren();
    for (const line of lines) {
      const p = document.createElement('p');
      p.style.margin = '0 0 0.4em';
      p.style.whiteSpace = 'normal';
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
    const cb = this.open && !silent ? this._onHide : null;
    this.el.style.display = 'none';
    this.open = false;
    this._onHide = null;
    cb?.();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey, true);
    this.el.remove();
    this.open = false;
  }
}
