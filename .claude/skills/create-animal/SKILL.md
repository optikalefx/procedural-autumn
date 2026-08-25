---
name: create-animal
description: Add a new wildlife species (a wild ground mammal) to the game, or retune an existing one. Use this whenever the user asks to add any animal — "add squirrels", "let's have wolves", "put some elk in", "new species", "more wildlife" — and also when they want to change where animals live, how often they appear, how they move, or how they look (habitat, spawn rates, gaits, coats, silhouettes). Covers the full recipe: blueprint geometry, gait ladder, streaming/habitat, audio, and the verification harnesses. Not for birds (src/wildlife/birds/ is a separate instanced system) or the camp dog (camp_dog.js owns it).
---

# Create Animal

Every mammal in this game is the same generic quadruped — a lofted barrel on a
spine, a neck, a head, four three-segment IK legs, a tail — and what separates
a deer from a bear is entirely the numbers in its blueprint. There are no model
files and no animation clips: **the profile arrays are the art**, and the gait
is solved from real ground speed. So "adding an animal" means writing one file
and registering it in a handful of tables. The rig, animator, brain, HUD
logbook, and object gallery are all generic and need no edits.

One animal is one file under `src/wildlife/mammals/`, holding everything that
animal is: blueprint, coat variants, gait ladder, brain numbers. The shared
builder they are all fed to is `mammals/quadruped.js` and nothing
species-specific belongs in it; `mammals/hide.js` is the material the whole
cast wears; `animal_species.js` is the table that names the cast.

Read the header of `src/wildlife/animal_species.js` first, then copy the
existing species file closest to your animal:

| start from | when the new animal is |
|---|---|
| `mammals/deer.js` | long-legged, read at 60–100 m (elk, pronghorn) |
| `mammals/bear.js` | heavy, low-headed, short-legged (boar, badger) |
| `mammals/rabbit.js` | small, crouched, read under 20 m (marmot) |
| `mammals/fox.js` | light canid/felid frame, read at 30–60 m (coyote, bobcat, wolf) |
| `mammals/squirrel.js` | tiny, hunched, big-tailed (marten, marmot) |
| `mammals/raccoon.js` | identified by markings rather than by proportions |

Every blueprint's comments explain *why* each number is what it is — mine them
before inventing your own.

## The six touchpoints

1. **`src/wildlife/mammals/<key>.js`** — a new file: the blueprint (`const
   BLUEPRINT = () => ({...})`) and one exported species object with `key`,
   `plural` (the logbook label — the one thing a table walk can't derive),
   `variants` (weights must sum to 1), `blueprint`, `gait`, and `brain`. Then
   two lines in **`src/wildlife/animal_species.js`**: the import, and the row
   in `SPECIES`. Nothing about your animal goes anywhere else in that folder —
   if a number of yours ends up in `quadruped.js`, it is in the wrong place
   (the stag's antler rack is the worked example: it is variant data in
   `deer.js`, and `buildVariants` grafts whatever rack a variant names).
2. **`src/wildlife/animal_anim.js`** — a row in `LADDER` naming the gait for
   each of the three speed tiers, e.g. `['walk', 'trot', 'gallop']`. A missing
   key silently falls through to the deer's `['walk','trot','bound']`, which is
   wrong for almost everything (dogs gallop, rabbits hop) and never errors.
3. **`src/wildlife/Wildlife.js`** — a `CFG` row (`spawn`/`despawn` stream band
   in metres, `live` mesh cap, `perKm2` density) and a branch in `_suit()`
   scoring habitat 0..1 from moisture/slope/height. The moisture field is
   effectively the tree field: high m = timber, the 0.3–0.5 band = forest
   edge, low m = dry open ground.
4. **`src/audio/wildlife_audio.js`** — decide the call. An unlisted key gets
   the **deer's bleat**, so a silent species must be added to the explicit
   skip list in `update()` (rabbit/fox/squirrel are the pattern). The design
   bar for adding a real call is high — read the file header first.
5. **`src/ui/hud_stats.js`** — nothing. The Wildlife logbook rows walk
   `SPECIES`; the `plural` field is all it needs. (Non-mammal one-offs like
   the bald eagle keep hand-written rows.)
6. **The gallery** (`gallery.html`) — nothing. Its animal adapter walks
   `SPECIES`, so every variant appears with stand/graze/alert/walk/trot/run
   poses the moment the entry exists.

## Blueprint traps (each of these shipped as a bug once)

- **Two neck bones, always.** The animator solves the neck as a two-link chain
  and silently disables the whole head — graze, look, alert — when a species
  has fewer. The bear and rabbit shipped with skulls welded to their
  shoulders this way. A rabbit "without a neck" still gets two bones.
- **Fatten the neck root.** A first `neckProfile` station narrower than the
  barrel's withers station looks fine standing, then becomes a discrete hump
  the moment graze folds the neck down and exposes the seam. Make the root as
  deep as the barrel station it meets, and keep `grazeAng` shallow (~0.95–1.1)
  on short steep necks.
- **Check leg reach.** Foot ground contact: `hip.y + knee.y + hock.y + foot.y`
  should land ≈ 0. Standing hip→hock distance should be ≤ ~85% of
  `|knee| + |hock|`; author the joints zigzagged (elbow back, stifle forward)
  or the IK clamps straight mid-stride and the legs visibly lock — the bear's
  "front legs disappear" bug. See the long comment over the bear's `hind`.
- **Tail markings ramp linearly by default**, so half the tail is half-pale —
  right for a deer's flag, wrong for a tip marking. Use `tailMixBias` (fox
  brush: 2.4) to hold the coat until the tip. `tailR` may *grow* toward the
  tip for a plume (squirrel), and the tail chain may be authored climbing
  instead of hanging — the arch itself can be the species' silhouette.
- **`flag` is deer-only** (see `animal_brain.js`); other species' tails get
  only the small `alert * 0.35` lift. Don't design a tail signal around
  `flag` for a non-deer without touching the brain.
- **`rumpTip: false`** for animals whose backside is a rounded mass (deer,
  fox, dog); the default point-taper is right only for bear/rabbit-like rumps.
- **Scale small animals past life size.** The rabbit is hare-scaled and the
  squirrel ~1.1×: at true size in this grass they are invisible rather than
  shy, and the whole species exists for the sighting.

## Palette

Hides must survive being a flat silhouette against a `#f0ad46` meadow. Coats
go darker and less saturated than life (a real red fox is meadow-orange —
that's the disappearing act); identity is carried by near-white `pale`
against near-black `dark`, not by the coat. But never author the *near*
colour at silhouette value: the distance treatment (`uSilNear/Far/Dark`)
already darkens with range, and a coat under ~`0x30xxxx` shades to a hole up
close — the bear's palette comment (in `mammals/bear.js`) is the full story.

## Behaviour numbers

- `brain`: distances are legibility numbers, not ethology — the encounter
  beat is freeze → watch → leave, and each species picks how much of it the
  player can actually see at that animal's size. Big + far-readable animals
  get `noticeDist` and `standoff` (walks the stand point out of canopy
  shadow); tiny animals get neither (a 0.2 m animal past 30 m is nothing).
- `CFG`: the stream band scales with readable range — tight for small animals
  (squirrel 72/104) so high `perKm2` stays cheap; wide for big ones (bear
  185/230). `live` is taste, not perf — census first, then tune.
- **The site cap fails silently and unevenly.** `_placeSites` caps total home
  sites (see `const cap`), species place in key order, and the river bears
  place after everything — so a dense new species saturates the cap and
  deletes whatever comes later, bears first. The squirrel's first cut did
  exactly this (census: `sites` == cap, `bear: 0`). A console.warn now fires
  on saturation; still, keep the census's `sites` well under the cap, and
  keep one species from owning most of the table (squirrels settled at ~2.5×
  the rabbits' site count).
- Weighted `variants` double as the pool distribution; 2–4 with one common
  form is the pattern.

## Verify (all three, in this order)

Dev-server trap: port 5178 serves the **main checkout** — in a worktree,
start your own (`npx vite --host 127.0.0.1 --port 5187 --strictPort`), bake
first (`node tools/bake.mjs`, plus `--seed 20261018` if you'll run the
capture baselines), and point tools at it with `AUTUMN_URL` / `--port`. See
AGENTS.md.

1. **Gallery** — `http://127.0.0.1:<port>/gallery.html#animal%3A<key>%3A0`.
   Check every variant and every pose; graze is where neck-seam humps appear,
   walk/run where legs lock.
2. **Motion strips** — `AUTUMN_URL=http://127.0.0.1:<port> node
   tools/wstrip.mjs --species <key> --mode walk` (then `flee`, and `ladder`
   for the distance read). Look for: correct gait name in the frame headers,
   no skating, no straight-locked legs, silhouette reads at range.
3. **Census** — `node tools/wcensus.mjs` (same `AUTUMN_URL`). Confirms the
   new species actually spawns (`perSpecies`), nothing stands in water, and
   sighting cadence stayed "an event, not a zoo" — sight-fraction ~45%,
   median gap single-digit seconds.

If a change doesn't show after an edit, restart vite before debugging
further — and remember backticks in shader-comment prose close the template
literal (a guard plugin catches it; restart vite after fixing).
