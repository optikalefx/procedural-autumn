// ─────────────────────────────────────────────────────────────────────────────
//  prior_notes — William's field book, M.'s letter, and what this seed
//  can honestly host.
//
//  The journal on the dirt is William's. M. wrote him a letter (tucked in
//  the front) asking for wildlife photographs — the usuals — and, with
//  hesitation, for anything else he might find. The player is neither of
//  them. They found the book. William left a line for whoever did: finish
//  the usuals for M. if you can.
//
//  The player's own photographs fill those usuals slots. Later pages stay
//  William's failed almosts of that unnamed "anything else" until the
//  existing mystery leaf — unchanged — can close that last page. Traces
//  are one weekend of his work path. This module never uses a popular
//  name for the unnamed thing.
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
    lines: [
      'Had the camera up. Something in the trees, tall.',
      'Then it was a moose. I laughed. Then I did not.',
      'Wrote the moose down anyway. M. asked for usuals.',
    ],
  },
  {
    id: 'lip-prints',
    gated: true,
    need: (f) => f.hasRidge,
    lines: [
      'Waited at the lip till the light went.',
      'Prints on the way back. Too big for the dog.',
      'I put my hand next to them and then I packed.',
    ],
  },
  {
    id: 'wake',
    gated: true,
    need: (f) => f.hasWater,
    lines: [
      'Moose drink here. I know that part.',
      'A wake with nothing in it. I said it was a log.',
      'I hauled out. I did not go back on.',
    ],
  },
  {
    id: 'thumb',
    gated: false,
    need: () => true,
    lines: [
      'I had it. Frame went black. Thumb on the lens.',
      'Too dark, too slow — the usual excuses.',
      'Left the empty shot in here anyway.',
    ],
  },
  {
    id: 'treeline',
    gated: false,
    need: () => true,
    lines: [
      'Working the usuals and the treeline moved.',
      'I stood up. Trees. I sat back down.',
      'Did not finish the page. Hands were not steady.',
    ],
  },
  {
    id: 'camp-edge',
    gated: false,
    need: () => true,
    lines: [
      'Something at the edge of the light. I did not go out.',
      'Morning: nothing. Packed anyway.',
      'Left the book. For whoever finds this.',
    ],
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
  while (pick.length < 2 && always.length) take(always);
  return pick.slice(0, 2);
}

/** Seeded rng for the book's starter ink — same seed, same two lines. */
export function priorNotesRng(ctx) {
  const seed = (ctx?.world?.seed ?? SEED) >>> 0;
  return mulberry32(seed ^ 0x71ace);
}

/** Flyleaf of the found book — his name, then a line for whoever picks it up. */
export const WILLIAM = {
  name: 'William',
  tag: 'field notes',
  found: [
    'Left for whoever finds this.',
    'Finish the usuals for M. if you can.',
  ],
};

/**
 * M.'s letter to William, tucked in the front. Warm, slightly formal;
 * the unnamed ask sits in the hesitation, not in a name.
 */
export const LETTER_M = {
  to: 'My dearest William,',
  body: [
    'Thank you for heading out into the open wilderness for me. My compendium of wildlife will be complete with the photos you will bring back for me. I could not thank you enough for your work here.',
    'Please keep in mind, and I struggle to even put this in writing… If you find anything else while you\'re out there, well, I would be most interested in those photos as well. That is all I should say.',
  ],
  close: 'Yours truly,',
  sign: '— M.',
};

/** @deprecated title leaf now paints LETTER_M inside William's book. */
export const TITLE_CUE = {
  for: WILLIAM.name,
  lines: [LETTER_M.to, ...LETTER_M.body, LETTER_M.close, LETTER_M.sign],
};

/** Whisper on the map for the current beat — area, not a pin. */
export const BEAT_HINT = {
  water: 'out toward the water',
  ride: 'the path they covered',
  lip: 'up toward the lip',
  trees: 'out toward the trees',
  exit: 'where they left in a hurry',
};

/**
 * Charcoal scrap in the cold ring. The hinge: usuals as control, a direction
 * out of camp, and why William left the book. Seed-honest about water.
 */
export function ringNote(features) {
  if (features?.hasWater) {
    return [
      'Usuals first. M. was clear.',
      'Water in the morning — moose, a wake, maybe not.',
      'Left the book. For whoever finds this.',
    ];
  }
  return [
    'Usuals first. M. was clear.',
    'Covering ground in the morning. Path, then the trees.',
    'Left the book. For whoever finds this.',
  ];
}

// ── one weekend of work for M. ───────────────────────────────────────────────
//
// Each beat has a reason. A dry seed skips water (no moose, no wake). A
// flat one skips the lip. Nothing is replaced with unrelated junk.

export const WEEKEND_BEATS = [
  // Pitched here to work the book. Usuals first, other thing later.
  { id: 'camp', kinds: ['start'], need: () => true },
  // Moose drink here — a usual — and something bigger might leave a wake.
  // Canoe and paddle are a fast haul-out, not a wreck.
  { id: 'water', kinds: ['paddle', 'canoe'], need: (f) => f.hasWater },
  // Covering ground for sightings. The bike is dropped when the trees moved.
  { id: 'ride', kinds: ['tracks', 'bike'], need: () => true },
  // Dusk wait. Cairn is a patient marker. The note is for M.: a usual that
  // landed, and an almost they would not name.
  { id: 'lip', kinds: ['cairn', 'tree-note'], need: (f) => f.hasRidge },
  // No lip this seed — they wrote from the trees, same mix of usual and almost.
  { id: 'trees', kinds: ['tree-note'], need: (f) => !f.hasRidge },
  // Left in a hurry after the almost. The journal is still on the dirt.
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

// Same hand as the journal. Toggle: a useful usual, then an embarrassed
// almost. Never a "nice camp" line. Never a name for the unnamed thing.
const SCRAP_COPY = {
  'tree-note': (f) => f.hasRidge
    ? ['M. —', 'Fox for you. Honest one.', 'Prints by the lip. Not a deer.', 'Too dark. —']
    : ['M. —', 'Fox for you. Honest one.', 'Something at the trees. Too dark. —'],
  paddle: () => ['Moose drink here. I know.', 'A wake, then nothing.', 'I hauled out. Light going.'],
  canoe: () => ['Something on the far bank.', 'Just a log. I said it was a log.', 'Did not go back on.'],
  tin: () => ['Left the book. For whoever finds this.', 'I am walking back.', 'It was not nothing. — W.'],
  bike: () => ['The trees moved.', 'I thought I had it.', 'I left the bike.'],
};

/**
 * About a third of the placed kinds get a readable scrap.
 *
 * The tree note is the dusk letter to M. (usual that landed + an almost).
 * Water is moose, then a wake, then the haul-out. The tin is the hurried
 * leave after that almost; the bike scrap is the drop if there is no tin.
 * The journal is a different object — it is not a scrap.
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
