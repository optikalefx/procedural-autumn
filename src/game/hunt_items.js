// ─────────────────────────────────────────────────────────────────────────────
//  hunt_items — the checklist. Fifteen lines in a journal, and nothing else.
//
//  This is the only file in the hunt that a person would ever want to read as
//  prose, so it is written as prose: an `id` the machine uses, a `subject` that
//  finishes the sentence "Photo of ___", and a `hint` short enough to sit under
//  the line without turning the page into a quest log.
//
//  ── the rules this list is built under ──────────────────────────────────────
//
//  1. **`id` is forever.** It is a localStorage key (`pa.hunt`), so renaming
//     one silently un-ticks a box on somebody's real save. Change `subject`
//     freely; never change `id`. That is also why the ids are the systems' own
//     keys — `deer`, `baldEagle`, `owl` are exactly `SPECIES` and
//     `TREE_BIRD_SPECIES[].key`, so the detector's lookup is an identity and
//     there is no translation table to drift.
//
//  2. **`subject` completes "Photo of ".** "Photo of a white-tailed deer"
//     reads; "Photo of Deer" does not, and "Photo of the deer" is a lie the
//     first time (there is no particular deer). The indefinite article is doing
//     real work and every line carries it, except the camp dog — see below.
//
//  3. **Order is the order on the page**, and it is a walk rather than a
//     taxonomy: the animals you meet on the verge first, then the ones you have
//     to go and find, then the four set-pieces that are about being somewhere
//     rather than about seeing something. Sorting the mammals by size and the
//     birds after them would be tidier and would put the bear — the hardest and
//     best line on the sheet — at number six of six, where nobody reads it.
//
//  ── the cast, and where it was read from ────────────────────────────────────
//
//  Guessing the cast from memory is how a hunt ends up asking for an animal
//  that was cut. Every id below was read out of the file that owns it:
//
//    `src/wildlife/animal_species.js`      SPECIES — the six wild mammals
//    `src/wildlife/mammals/dog.js`         DOG_SPECIES — the camp dog, which is
//                                          deliberately NOT in SPECIES
//    `src/wildlife/birds/tree_birds.js`    TREE_BIRD_SPECIES[].key — the four
//                                          perch-and-fly birds
//    `src/wildlife/fireflies.js`           the night swarm
//    `src/world/TerrainGen.js:_waterfalls` the falls, baked into the world
//
//  ── two judgement calls ─────────────────────────────────────────────────────
//
//  **The flocks are not on the list.** `birds/flocks.js` is the other bird
//  system and it is genuinely animals in the game, so leaving it off needs a
//  reason: its own header gives one — "wheeling specks and a startle burst,
//  nine triangles each, never meant to be looked at". A scavenger hunt asks for
//  a photograph, and there is no photograph of a nine-triangle speck at 60 m
//  that anybody would want taped into a book. The stats sheet counts them,
//  because a sighting is a fair thing to count and a portrait is not.
//
//  **The camp dog IS on the list**, and it is the one addition beyond the
//  fourteen the module contract requires. The user asked for "every animal in
//  the game" and the dog is unarguably one; it is also the only line here the
//  player can *cause* — pitch camps until one comes with a dog — which makes it
//  the gimme that teaches the mechanic. Its subject drops the indefinite
//  article on purpose ("the dog at somebody's camp"): by the time you can
//  photograph it, it is a specific dog, standing by a specific fire.
//
//  ── the marshmallow, which was dormant for about an hour ───────────────────
//
//  `burntMallow` was written blind. When this file was drafted the roasting
//  mechanic did not exist on this branch — it was uncommitted work in a sibling
//  worktree on `claude/marshmallow-roasting-mechanic-1b8054` — so the line went
//  on the sheet anyway and its detector was written against the shape that
//  branch was going to land with, degrading to "never fires" until it did.
//  It landed mid-build (`94e1671`, "marshmallow: roast one over the fire") and
//  the item is now live with no edit to either file.
//
//  The reasoning is worth keeping even though the gamble came off, because it
//  is the reason the line is on the sheet at all: a checklist that GROWS a new
//  item when a feature ships is worse than one that has always had it. A player
//  who has ticked fourteen of fourteen and then finds themselves on fourteen of
//  fifteen has been robbed of a finished book. The cost of guessing wrong was
//  one dormant line; the cost of waiting was everybody's completed sheet.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} HuntItem
 * @property {string} id       stable forever; a localStorage key
 * @property {string} subject  the noun phrase printed after "Photo of "
 * @property {string} hint     where to look, in as few words as will do
 */

/** @type {HuntItem[]} */
export const HUNT_ITEMS = [
  // ── the verge: what you meet without going looking ────────────────────────
  {
    id: 'deer',
    subject: 'a white-tailed deer',
    hint: 'meadow edges, and the road at dawn',
  },
  {
    id: 'rabbit',
    subject: 'a cottontail rabbit',
    hint: 'the grass verge — get close, it is small',
  },
  {
    id: 'squirrel',
    subject: 'a grey squirrel',
    hint: 'under the hardwoods; the smallest animal here',
  },
  {
    id: 'raccoon',
    subject: 'a raccoon',
    hint: 'after dark, near water',
  },
  {
    id: 'fox',
    subject: 'a red fox',
    hint: 'open ground at either end of the day',
  },
  {
    id: 'bear',
    subject: 'a black bear',
    hint: 'deep forest. It will hear you first',
  },
  {
    id: 'campDog',
    subject: "the dog at somebody's camp",
    hint: 'most camps come with one',
  },

  // ── the birds you stop the car for ────────────────────────────────────────
  {
    id: 'baldEagle',
    subject: 'a bald eagle',
    hint: 'the top of the tallest spruce',
  },
  {
    id: 'owl',
    subject: 'a great horned owl',
    hint: 'only at night, and only in the headlights',
  },
  {
    id: 'heron',
    subject: 'a great blue heron',
    hint: 'standing still in the shallows',
  },
  {
    id: 'flamingo',
    subject: 'a flamingo',
    hint: 'they keep to two islands. Take the boat',
  },

  // ── the set-pieces: places and moments, not animals ───────────────────────
  {
    id: 'fireflies',
    subject: 'fireflies over the meadow',
    hint: 'a warm wet meadow, well after dusk',
  },
  {
    id: 'waterfall',
    subject: 'a waterfall',
    hint: 'follow any river uphill',
  },
  {
    id: 'highCamp',
    subject: 'a high mountain campsite',
    hint: 'pitch camp above 100 m',
  },
  {
    id: 'burntMallow',
    subject: 'an over-roasted marshmallow',
    hint: 'leave it in the flame and see',
  },
];

/** Lookup by id, for the journal and for anything that has an id in hand. */
export const HUNT_BY_ID = Object.fromEntries(HUNT_ITEMS.map((it) => [it.id, it]));

/** Every id, in page order. The detector returns a subsequence of this. */
export const HUNT_IDS = HUNT_ITEMS.map((it) => it.id);
