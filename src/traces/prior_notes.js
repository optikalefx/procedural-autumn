// ─────────────────────────────────────────────────────────────────────────────
//  prior_notes — what this seed actually has, and the lines already in the book.
//
//  The left-behind journal is a field book addressed to someone at home. The
//  usuals (deer, fox, moose…) get empty slots the player's own photographs
//  fill. The last pages carry the prior camper's failed almosts of something
//  they would not name. Those lines are written at boot, gated on the baked
//  world — a dry seed does not get a river wake, a valley with no lip does
//  not get prints on one.
//
//  Animal photographs do not progress the creature pages. This module never
//  mentions the unnamed thing by any popular name; the existing mystery leaf
//  is still what closes that thread.
// ─────────────────────────────────────────────────────────────────────────────
import { mulberry32 } from '../core/MathUtils.js';
import { SEED } from '../world/WorldConfig.js';

const WATER_NEAR = 240;
const RIDGE_NEAR = 360;

/**
 * What this seed can honestly support, around `origin` (the start camp).
 *
 * Tags are facts about the bake, not about a live spawn. `hasWater` is "this
 * valley has a river, a fall or a mouth"; `waterNear` is the closest of those
 * that is actually walkable from camp. Same split for the ridge / lip.
 */
export function seedFeatures(ctx, origin = null) {
  const poi = ctx?.poi?.list ?? {};
  const world = ctx?.world;
  const hasRiver = (poi.river?.length ?? 0) > 0;
  const hasFalls = (poi.waterfall?.length ?? 0) > 0 || (world?.waterfalls?.length ?? 0) > 0;
  const hasLake = (poi.mouth?.length ?? 0) > 0;
  const hasWater = hasRiver || hasFalls || hasLake;
  const hasRidge = (poi.vista?.length ?? 0) > 0 || (poi.peak?.length ?? 0) > 0;

  return {
    hasWater,
    hasRiver,
    hasFalls,
    hasRidge,
    nearCamp: true,
    waterNear: nearestOf(origin, [poi.river, poi.mouth, poi.waterfall], WATER_NEAR),
    ridgeNear: nearestOf(origin, [poi.vista, poi.peak], RIDGE_NEAR),
    // Full landmark lists for placing crumbs away from spawn. Fail-line
    // picking still uses the nearest-* facts above; this is just the map.
    pois: {
      road: poi.road ?? [],
      meadow: poi.meadow ?? [],
      forest: poi.forest ?? [],
      river: poi.river ?? [],
      mouth: poi.mouth ?? [],
      waterfall: poi.waterfall ?? [],
      vista: poi.vista ?? [],
      peak: poi.peak ?? [],
    },
    // Habitat, not a census. Moose and heron want water; a dry seed should not
    // write as if they were just over the next rise.
    usuals: {
      moose: hasWater,
      deer: true,
      fox: true,
      heron: hasWater,
    },
  };
}

function nearestOf(origin, lists, max) {
  if (!origin) return null;
  let best = null, bestD = Infinity;
  for (const list of lists) {
    if (!list) continue;
    for (const p of list) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      const d = Math.hypot(p.x - origin.x, p.z - origin.z);
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  return best && bestD <= max ? { x: best.x, z: best.z, y: best.y, dist: bestD } : null;
}

// ── the fail pool ────────────────────────────────────────────────────────────
//
// Short, plain, human. Each entry is one look that did not hold. `need` is
// the seed gate; a line that names a river or a lip is refused when the
// valley has neither.

const FAIL_POOL = [
  {
    id: 'trees-moose',
    gated: true,
    need: (f) => f.hasWater && f.usuals.moose,
    lines: ['Movement in the trees.', 'Just a moose when I looked again.'],
  },
  {
    id: 'lip-prints',
    gated: true,
    need: (f) => f.hasRidge,
    lines: ['Prints by the lip.', 'Too big for the dog. Probably not.'],
  },
  {
    id: 'wake',
    gated: true,
    need: (f) => f.hasWater,
    lines: ['A wake, then nothing. Just a log.'],
  },
  {
    id: 'thumb',
    gated: false,
    need: () => true,
    lines: ['Too dark. Thumb on the lens.'],
  },
  {
    id: 'treeline',
    gated: false,
    need: () => true,
    lines: ['Something at the tree line.', 'Gone when I stood up.'],
  },
  {
    id: 'camp-edge',
    gated: false,
    need: () => true,
    lines: ['At the edge of the light. Nothing in the morning.'],
  },
];

/**
 * One or two failed almosts for this seed.
 *
 * Feature-gated lines are preferred so a wet valley and a dry one do not
 * write the same book. The always-available lines fill when the bake is
 * sparse. Never more than two — the page has to stay half empty.
 */
export function pickPriorFails(features, rnd = Math.random) {
  const pool = FAIL_POOL.filter((e) => e.need(features));
  const gated = pool.filter((e) => e.gated);
  const always = pool.filter((e) => !e.gated);
  const pick = [];
  const take = (arr) => {
    if (!arr.length) return;
    const i = Math.min(arr.length - 1, Math.floor(rnd() * arr.length));
    pick.push(arr.splice(i, 1)[0]);
  };
  if (gated.length) take(gated);
  if (pick.length < 2 && gated.length) take(gated);
  if (pick.length < 2) take(always);
  if (pick.length < 1) take(always);
  return pick.slice(0, 2);
}

/** Seeded rng for the book's starter ink — same seed, same two lines. */
export function priorNotesRng(ctx) {
  const seed = (ctx?.world?.seed ?? SEED) >>> 0;
  return mulberry32(seed ^ 0x71ace);
}

export const TITLE_CUE = {
  for: 'for M.',
  lines: [
    'I will get the usuals first.',
    'Deer, fox — the ones we know.',
    'The other thing can wait.',
  ],
};

// ── one weekend ──────────────────────────────────────────────────────────────
//
// The leftovers are one prior camper's path, in order. A dry seed skips the
// water beat; a flat one skips the lip. Nothing is reshuffled to fill a
// quota — a sparse bake just tells a shorter story.

export const WEEKEND_BEATS = [
  { id: 'camp', kinds: ['start'], need: () => true },
  { id: 'water', kinds: ['paddle', 'canoe'], need: (f) => f.hasWater },
  { id: 'ride', kinds: ['tracks', 'bike'], need: () => true },
  { id: 'lip', kinds: ['cairn', 'tree-note'], need: (f) => f.hasRidge },
  // Same slot as the lip note when there is no lip — they wrote from the trees.
  { id: 'trees', kinds: ['tree-note'], need: (f) => !f.hasRidge },
  { id: 'exit', kinds: ['tin', 'stick', 'rope'], need: () => true },
];

/**
 * The beats this seed can honestly host, in story order.
 *
 * `kinds` is the placement list. Count varies with gates: a wet ridge
 * valley is ten crumbs, a dry flat one is seven. Fewer is the right
 * answer when the land cannot carry a beat.
 */
export function pickWeekend(features) {
  const list = [];
  const kinds = [];
  for (const beat of WEEKEND_BEATS) {
    if (!beat.need(features)) continue;
    list.push({ id: beat.id, kinds: beat.kinds.slice() });
    kinds.push(...beat.kinds);
  }
  return { list, kinds };
}

/** @deprecated use pickWeekend — kept so older probes still resolve. */
export function pickCrumbs(features) {
  return pickWeekend(features).kinds;
}

// Same hand as the journal. Each scrap is a beat of the weekend, not a
// caption on a prop. Never name the unnamed thing.
const SCRAP_COPY = {
  'tree-note': (f) => f.hasRidge
    ? ['M. — if you came this way.', 'I went up the lip after the bike.', 'The usuals first. —']
    : ['M. — if you came this way.', 'I kept to the trees.', 'The usuals first. —'],
  paddle: () => ['Too late to put in.', 'I left it leaned the wrong way.', 'The other thing can wait.'],
  canoe: () => ['Something on the far bank.', 'just a log.', 'I did not go back on.'],
  tin: () => ['grounds in the bottom.', 'walking back now.', 'still warm. not really.'],
  bike: () => ['The chain slipped on the last bend.', 'I walked it from here.'],
};

/**
 * About a third of the placed kinds get a readable scrap.
 *
 * The tree note is the letter home. The put-in gets one water line when
 * the seed has water. The tin (or the bike, if there is no tin) is the
 * walk back. The journal is a different object — it is not a scrap.
 */
export function assignScraps(kinds, features) {
  const have = new Set(kinds);
  const out = new Map();
  const take = (k) => {
    const fn = SCRAP_COPY[k];
    if (!fn || !have.has(k) || out.has(k)) return;
    out.set(k, { lines: fn(features) });
  };
  take('tree-note');
  if (have.has('paddle')) take('paddle');
  else take('canoe');
  if (have.has('tin')) take('tin');
  else take('bike');
  if (out.size < 3) take('bike');
  return out;
}
