// ─────────────────────────────────────────────────────────────────────────────
//  hunt_items — the checklist. Nineteen lines in a journal, and nothing else.
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
//     The three sky lines are the one place that rule is bent, and knowingly.
//     `moon` IS `SKY_OBJECTS`' own id; `planet` and `galaxy` are not ids at
//     all, they are CLASSES covering four and three of them — that is the
//     whole point of the block at the bottom of this header — so the detector
//     does carry a translation table for them. It is seven rows, it is in
//     `hunt_detect.js` under `SKY_ITEM`, and the note there says what would
//     retire it.
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
//    `src/wildlife/birds/tree_birds.js`    TREE_BIRD_SPECIES[].key — the five
//                                          perch-and-fly birds, the duck
//                                          included: it is on that table and
//                                          streamed by that file, and the only
//                                          thing separating it from the other
//                                          four is that it swims to where it is
//                                          going instead of flying
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
//  ── a hint has to describe a shot that counts ───────────────────────────────
//
//  Four lines on this sheet were rewritten after the detector was measured,
//  because a hint is not flavour text: it is the only instruction the player
//  gets, and a hint that sends somebody to take a photograph the rules will
//  refuse is worse than no hint at all. Each of the four was wrong in its own
//  way and the ways are worth keeping apart.
//
//  **The owl** said "only at night, and only in the headlights". Night is
//  right and the headlights are a lovely image and the shot does not count: a
//  great horned owl perches THIRTY METRES up a tree (measured on three live
//  ones: 13.5 m, 25.4 m, 31.0 m), and from the ground on the wide lens its
//  frame share never clears 0.055 at any distance, standing directly under it
//  included. Headlights do not reach it and neither does a 24-70. What does is
//  the long lens, which is why the hint now says so — see `hunt_detect.js`,
//  "the owl was never about the startle radius".
//
//  **The fireflies** said "a warm wet meadow, well after dusk", which promised
//  a search that did not exist: the old detector ticked the box on the first
//  night photograph taken anywhere, so the hint described a hunt the player had
//  already finished by accident. The detector now counts the swarm and the hint
//  carries the rule it enforces. "A few is not a photograph" is the whole
//  change of that item, in six words, and it is a promise the code keeps.
//
//  It moved once more, and the same rule is why. Counting the swarm took the
//  item from 83% of night photographs to about a third, and a third is still
//  not a find (user: *"yea we should dial back the fireflies, let them be more
//  rare"*), so `FF_MIN` went 110 to 375 — one night photograph in about eleven.
//  Measured against the anchors, "a wet meadow" no longer describes a shot that
//  counts and the middle of one does: five of the six meadow anchors clear 375
//  and they clear it on one to four of their four bearings, so where you stand
//  inside the meadow is now the whole question. The hint says so.
//
//  **The high camp** said "pitch camp above 100 m" and was the only hint on the
//  sheet quoting a constant at the player. Next to the bear's line it reads
//  like a spec, and it was also incomplete in a way that
//  cost people the shot: detection on a summit is tight (12 of 12 bearings at
//  10 m, 3 of 12 at 24 m, none by 80 m), so the portrait taken from where you
//  can see the drop is exactly the one that will not count. "Photograph it from
//  the fire" is the missing half, and it is where you are standing anyway.
//
//  **The raccoon and the flamingo** were database rows — "a raccoon", "a
//  flamingo" — sitting beside "a white-tailed deer" and "a great horned owl".
//  Every other line on the sheet earns its modifier, and the modifier is what
//  makes a checklist read like a field guide instead of a table. Both now carry
//  their own common name.
//
//  **The bear** is the fifth, and it is the only one that was wrong about the
//  WORLD rather than about the detector — which makes it the worst kind, because
//  nothing in this file or in `hunt_detect.js` could have caught it. It said
//  "deep forest. It will hear you first", and both halves sent the player the
//  wrong way.
//
//  The terrain half was simply not true of the valley. `Wildlife._placeSites`
//  puts bears down twice: a deep-wood pass scored on the suitability field, and
//  a second pass walking the river polylines, which exists because "bear beside
//  a river" is the whole point of plate 3. On the shipped seed the first pass
//  produces NOTHING — all 22 bear sites are river banks — because the `cover`
//  term times a 0.5/km2 density loses the draw essentially everywhere. So the
//  hint was describing a bear the generator does not currently make, and a
//  player following it searched the one habitat guaranteed to be empty. (That
//  is a finding about the placement, not about this line: lift the `cover` term
//  and the forest bear exists again. Until it does, the sheet says rivers.)
//
//  The manner half was backwards. "It will hear you first" asks for caution,
//  and caution is exactly what loses this photograph: the bear counts from 9.5
//  m — the shortest reach of any mammal on the sheet, because at 1.23 m on all
//  fours it is a LOWER animal than a deer with its head up, whatever it weighs
//  (see `hunt_detect.js`) — while its brain is the least skittish in the game,
//  minding you from 66 m against a deer's 108 and standing off at 4. The
//  bear is the one animal you can walk up to, and it has to be. So the second
//  clause now says to, in the register the animal deserves.
//
//  ── and two more, when the detector stopped measuring a sphere ──────────────
//
//  `hunt_detect.js` round three rewrote the size gate to read the animal's
//  height rather than its bounding sphere, and the mammal reaches roughly
//  halved: squirrel 5.0 m → 2.7, raccoon 10.4 m → 2.9. Whatever else that did,
//  it moved two hints out of true, and by this block's own rule that is a
//  defect rather than a nicety.
//
//  **The squirrel** said "the smallest animal here", which is a fact about the
//  squirrel and not an instruction. It sat next to the rabbit's "get close, it
//  is small" while being the tighter of the two — 2.7 m against 4.1 — so the
//  sheet was telling the player to close in on the easier one and saying
//  nothing about the harder. It now says "get right up to it", which is what
//  2.7 m means when you are holding the free camera.
//
//  **The raccoon** carried no distance signal at all and took the biggest cut
//  on the sheet, a factor of 3.6. The reason is worth putting in the hint
//  rather than in a comment, because it is a fact about the animal and not
//  about the rule: a raccoon is 0.82 m long and 0.38 m tall, so it is a large
//  animal that reads small, and the gate reads height. "Low to the ground, so
//  get close" is that, in seven words.
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
//
//  ── the night sky, and why it is three lines and not eight ──────────────────
//
//  (User, on seeing the telescope's own discovery list: *"it looks like the
//  objects in the night sky are not in the scavenger hunt, can they be
//  added?"*)
//
//  `src/game/sky_objects.js` holds eight: four planets, three galaxies and the
//  moon. Putting all eight on the sheet is the obvious reading of that request
//  and it is the wrong one, for three reasons that are worth separating.
//
//  **1. Eight is not eight finds; it is one.** The planets are on the ecliptic
//  ON PURPOSE — `planets.js`'s own header: "they line up, so one sweep finds
//  all four" — and the three galaxies are all in the upper sky within about a
//  quarter turn of each other. So the eight are a single act: fit the long
//  lens after dark and pan. A sheet that hands out eight ticks for one pan is
//  padding, and it would be 53% more sheet, every line of it the same line.
//
//  **2. The collection already exists, one system over.** `Stats._telescope`
//  marks each of the eight by id, at the eyepiece, on a half-second dwell, and
//  `hud_stats.js` prints all eight in the logbook. The "find every one"
//  instinct is served, in the feature built for it. Copying that list onto the
//  hunt sheet would make the two features one feature with two UIs.
//
//  **3. What IS distinct is the act, and there are three of them.** Fill the
//  frame with the moon; resolve a planet's disc; find a galaxy. They differ in
//  what the player has to know and in how far the lens has to go — measured,
//  in `hunt_detect.js`'s "the sky needed its own rule": the moon counts from a
//  38.5 deg field, the easiest galaxy from 19.3 and the hardest from 6.6, and
//  a planet from 10.7 deg at best. Three lines, fifteen to eighteen, a fifth
//  more sheet for a whole new direction to point the camera in.
//
//  **The strongest counter-argument, and why it loses.** The four planets
//  really are individually identifiable through this glass, and I have the
//  frames: at 400 mm Jupiter is a 56 px disc with four moons strung out beside
//  it, Saturn has rings and two moons, Mars is orange, Venus is a bare white
//  disc (`/tmp/skyshots/*-tele400.png`). "You can tell them apart" is a real
//  argument for four lines. It is an argument about IDENTIFICATION, though, and
//  a scavenger hunt line is a unit of SEARCHING — see point 1. The three
//  galaxies lose the same argument for the same reason, and they keep their
//  invented names where they are useful: in the hint, which is where a player
//  reads them.
//
//  **The moon is its own line and not part of "a planet".** It is the one
//  object up there that is not a find at all — it is up most of the night and
//  it is the brightest thing in the sky — so it is the sky's camp dog: the
//  gimme that teaches the mechanic. Without it a player has no way to learn
//  that the sheet wants them to look up.
//
//  It did not read as a gimme at first, because it shipped behind the same
//  threshold as the galaxies and so wanted the long lens like everything else
//  up there. That was corrected on a frame the user sent — a crescent over a
//  lake that the book refused — and the moon's cut now sits on the wide lens's
//  own zoom ring instead. The argument, the frame and what it costs are in
//  `hunt_detect.js` under "the moon may be a landscape"; the consequence here
//  is the hint, which used to send the player for the long lens and no longer
//  can.
//
//  They are grouped at the end under their own heading rather than folded into
//  the set-pieces, because rule 3 says the order is a walk and this is the
//  point where the walk stops and you stand still and look up. It also means
//  the last line on the sheet is the hardest one on it, which is where the
//  bear should have been.
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
    hint: 'Literally everywhere.',
    animal: true,
  },
  {
    id: 'rabbit',
    subject: 'a cottontail rabbit',
    hint: 'Small, loves the grass.',
    animal: true,
  },
  {
    id: 'squirrel',
    subject: 'a grey squirrel',
    hint: 'To the forest!',
    animal: true,
  },
  {
    id: 'raccoon',
    subject: 'a northern raccoon',
    hint: 'After dark, near water.',
    animal: true,
  },
  {
    id: 'fox',
    subject: 'a red fox',
    hint: 'Open fields.',
    animal: true,
  },
  {
    id: 'bear',
    subject: 'a black bear',
    hint: 'Banks of big rivers.',
    animal: true,
  },
  {
    id: 'moose',
    subject: 'Great Moose',
    hint: 'They love big rivers.',
    animal: true,
  },
  {
    id: 'campDog',
    subject: "Dog at camp",
    hint: 'Give camping a shot.',
    animal: true,
  },

  // ── the birds you stop the car for ────────────────────────────────────────
  {
    id: 'baldEagle',
    subject: 'Bald eagle',
    hint: 'In the tall trees.',
    animal: true,
  },
  {
    id: 'owl',
    subject: 'Great horned owl',
    hint: 'Only after dark and high in the trees.',
    animal: true,
  },
  {
    id: 'heron',
    subject: 'Great blue heron',
    hint: 'In the shallows.',
    animal: true,
  },
  {
    id: 'flamingo',
    subject: 'American flamingo',
    hint: 'Lovely little island fellows.',
    animal: true,
  },
  {
    id: 'duck',
    subject: 'White ducks',
    hint: '#Lakelife. Try a Canoe',
    animal: true,
  },

  // ── the set-pieces: places and moments, not animals ───────────────────────
  {
    id: 'fireflies',
    subject: 'Fireflies in the meadow',
    hint: 'Well after dark, in the middle of a wet meadow.',
  },
  {
    id: 'waterfall',
    subject: 'Waterfall',
    hint: 'Splish splash.',
  },
  {
    id: 'highCamp',
    subject: 'A high mountain campsite',
    hint: 'Climb to the tallest peaks.',
  },
  {
    id: 'burntMallow',
    subject: 'An over-roasted marshmallow',
    hint: 'Be patient.',
  },

  // ── the night sky: the three lines you take with a lens, not with your feet
  {
    id: 'moon',
    subject: 'The Moon',
    hint: 'Not made of cheese.',
  },
  {
    id: 'planet',
    subject: 'A planet',
    hint: 'Not quit a star...',
  },
  {
    id: 'galaxy',
    subject: 'A galaxy',
    hint: 'Look to a swirl in the sky.',
  },

  // ── and the one that is not on the sheet ───────────────────────────────────
  //
  // `mystery: true`, which means three things and they are all about SECRECY
  // rather than about difficulty:
  //
  //   · it is not on the checklist pages. It has a leaf of its own at the back
  //     of the book, blank until the eighteen above it are crossed off — see
  //     `journal_page._paintMystery`.
  //   · it does not count in "eighteen of eighteen found", and it does not
  //     count against the dash's paw, until it is open. A sheet that read
  //     "seventeen of nineteen" would announce the secret to somebody who has
  //     found seventeen animals, which is the exact player it is being kept
  //     from.
  //   · once it IS open it counts in both, so the last line of the game is a
  //     line you can watch yourself not have.
  //
  // `hunt_store` enforces all three off this one flag; nothing else in the tree
  // hard-codes the id.
  //
  // The subject reads oddly on purpose. Every other line names a species,
  // because every other line is a thing a field guide has a page for. This one
  // is what you would actually write under a photograph you could not explain,
  // and it is the only line on the sheet that is written in the first person of
  // somebody who was there.
  //
  // The hint is the owl's lesson applied a second time (see rule 4 above): he
  // arrives 58-92 m out and leaves at 165, and `hunt_detect`'s frame-share gate
  // puts the 24-70 at 54 m even wound all the way out. So the long lens is not
  // advice, it is the rule, and the hint says so in the words a hint is allowed.
  {
    id: 'bigfoot',
    subject: 'whatever that was',
    hint: 'deep timber, well off the road. Fit the long lens before you go looking — there will be no time to change it',
    animal: true,
    mystery: true,
  },
];

/** The eighteen printed lines: everything that is not the secret. */
export const HUNT_SHEET = HUNT_ITEMS.filter((it) => !it.mystery);
/** The secret, as a row. There is exactly one and this file owns that fact. */
export const HUNT_MYSTERY = HUNT_ITEMS.find((it) => it.mystery) ?? null;

/**
 * The animal lines, and only those: the twelve the dash's paw counts —
 * thirteen once the mystery is open, which is the one moment in the game that
 * number goes UP by a line rather than down by a find. `hunt_store.animalTotal` owns
 * the switch; this list carries all twelve and says nothing about when.
 *
 * The dash used to read "0 of 12" against the LANDMARK list in `HUD.js` — the
 * waterfalls and vistas you drive past — which was a second progress number
 * nobody could see the source of. It now reads the sheet, so the number beside
 * the paw is a number the player can go and look at in the journal.
 *
 * Marked per row with `animal: true` rather than gathered into a list down
 * here, because a list is a second cast to keep in step and the next animal
 * added will be written by copying the row above it.
 *
 * The boundary is this file's own section headers, not taxonomy, and the one
 * arguable case is the **fireflies** — genuinely animals, and deliberately not
 * flagged. Their line sits under "places and moments, not animals" because the
 * subject is "fireflies over the meadow": the detector counts a SWARM (see
 * `FF_MIN` in `hunt_detect.js`), so what the sheet asks for is a lit meadow
 * rather than a portrait of an insect. The paw counts the twelve lines where
 * you photograph a creature.
 */
export const HUNT_ANIMALS = HUNT_ITEMS.filter((it) => it.animal);
export const HUNT_ANIMAL_IDS = new Set(HUNT_ANIMALS.map((it) => it.id));

/** Lookup by id, for the journal and for anything that has an id in hand. */
export const HUNT_BY_ID = Object.fromEntries(HUNT_ITEMS.map((it) => [it.id, it]));

/** Every id, in page order. The detector returns a subsequence of this. */
export const HUNT_IDS = HUNT_ITEMS.map((it) => it.id);
