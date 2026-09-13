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

// ── crumbs ───────────────────────────────────────────────────────────────────
//
// The start scuff is always one. The rest of the pool is gated on the bake:
// a dry valley never gets a canoe, a flat one never gets a lip cairn. Stick
// is the fill so a typical seed still lands around eight to ten leftovers
// without stacking extras at spawn.

const ALWAYS_CRUMBS = [
  'start', 'tree-note', 'bike', 'tracks', 'rope', 'tin', 'second-night',
];

/**
 * Which leftover kinds this seed can honestly host.
 *
 * Order is the placement order, not a quest. Count varies a little with
 * gates: dry and flat is eight, water or a lip pushes toward ten.
 */
export function pickCrumbs(features) {
  const out = ALWAYS_CRUMBS.slice();
  if (features.hasWater) out.push('canoe', 'paddle');
  if (features.hasRidge) out.push('cairn');
  if (out.length < 10) out.push('stick');
  return out.slice(0, 10);
}

// Short human scraps. About one in three crumbs is readable; the rest are
// silent props. Never name the unnamed thing.
const SCRAP_COPY = {
  'tree-note': (f) => f.hasRidge
    ? ['M. — if you came this way.', 'I went up the lip.', 'The usuals first. —']
    : ['M. — if you came this way.', 'I kept to the trees.', 'The usuals first. —'],
  tin: () => ['grounds in the bottom.', 'still warm when I left it.', 'not really.'],
  bike: () => ['The chain slipped on the last bend.', 'I walked it from here.'],
  canoe: () => ['Too late to put in.', 'Something on the far bank.', 'just a log.'],
  paddle: () => ['Left it for whoever comes next.', 'I did not go back on.'],
  tracks: () => ['Heard it again past the trees.', 'nothing in the morning.'],
  'second-night': () => ['Stayed one more night.', 'Same quiet. Same nothing.'],
};

/**
 * About a third of the placed kinds get a readable scrap.
 *
 * The tree note is always one. Then one small camp leftover (tin or bike),
 * then a water line if the seed has water, else a dry almost. The journal
 * is a different object — it is not a scrap.
 */
export function assignScraps(kinds, features, rnd = Math.random) {
  const have = new Set(kinds);
  const out = new Map();
  const take = (k) => {
    const fn = SCRAP_COPY[k];
    if (!fn || !have.has(k) || out.has(k)) return;
    out.set(k, { lines: fn(features) });
  };
  take('tree-note');
  const small = ['tin', 'bike'].filter((k) => have.has(k));
  if (small.length) take(small[Math.min(small.length - 1, Math.floor(rnd() * small.length))]);
  if (features.hasWater) {
    const wet = ['canoe', 'paddle'].filter((k) => have.has(k));
    if (wet.length) take(wet[Math.min(wet.length - 1, Math.floor(rnd() * wet.length))]);
  } else {
    const dry = ['tracks', 'second-night'].filter((k) => have.has(k) && !out.has(k));
    if (dry.length) take(dry[Math.min(dry.length - 1, Math.floor(rnd() * dry.length))]);
  }
  return out;
}
