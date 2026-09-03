---
name: create-animal
description: >-
  Add a new wildlife species (a wild ground mammal) to the game, or retune an
  existing one. Use this whenever the user asks to add any animal — "add
  squirrels", "let's have wolves", "put some elk in", "new species", "more
  wildlife" — and also when they want to change where animals live, how often
  they appear, how they move, or how they look (habitat, spawn rates, gaits,
  coats, silhouettes). Covers the full recipe: blueprint geometry, gait ladder,
  streaming/habitat, audio, and the verification harnesses. Not for birds
  (src/wildlife/birds/ is a separate instanced system), the camp dog
  (camp_dog.js owns it), or hand-authored Blender models exported as GLB (use
  import-animal).
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
| `mammals/squirrel.js` | tiny, hunched, big-tailed (marten, marmot) |
| `mammals/raccoon.js` | identified by markings rather than by proportions |

`mammals/dog.js` used to be on this list as the light canid/felid frame, and it
is not any more: the camp dog is a bought GLB now. Its blueprint's reasoning is
still worth reading and is in the history — `git log -p src/wildlife/mammals/dog.js`
— particularly the body-length-over-withers ratio note, which is the single
measurement that separates a dog from a small deer.

Every blueprint's comments explain *why* each number is what it is — mine them
before inventing your own.

**Not `mammals/fox.js`.** The fox is the one hand-authored animal in the cast:
it carries a `glb` block instead of a blueprint, so there are no profile arrays
in it to copy. Its `brain` block is still a good model for a wary mid-sized
mammal. For a new animal built in Blender rather than lofted, use
`promote-glb-animal` instead of this skill.

### Variable-duration behavior contract

When routing a Blender/GLB animal to `promote-glb-animal`, carry this into the
asset brief: a state the brain may hold for an arbitrary duration must not be
one clip containing enter, activity, and exit. A repeating monolithic clip
would replay its entrance and exit throughout the hold.

Author three actions instead: `<state>_in` plays once from idle to the exact
hold pose, `<state>` is a seamless activity loop, and `<state>_out` plays once
from that exact hold pose back to idle. The two phase joins must be identical,
the hold loop's first and last frames must match, and the outer idle endpoints
must match the idle action. Graze, drink, sleep, forage, and scratch are common
examples. Prefer an authored exit over reversing the entrance; negative
playback is a fallback, not the asset contract. The runtime owns how long the
middle action repeats and how an interruption crossfades.

### Skin-weight continuity contract

Also for the asset brief: **skin weights must be a continuous field over the
mesh surface.** Two vertices sharing an edge must never be driven by sets of
bones with nothing in common.

This is the bear's buckling shoulder, and it cost a round. Its weights were
painted by a rule that picked a *candidate bone list* per vertex from hard
spatial gates — `z < 1.34 and abs(x) > 0.20` selected the forelimb chain, the
`else` selected `pelvis/spine/chest`. Each gate is a plane through the mesh,
and across that plane the weight field steps. At rest the model is perfect,
which is exactly why it passed review. The moment the two bones disagree by a
few degrees the edge between them shears, and the surface creases, buckles,
and finally folds through itself. The bear had **455 such edges** on five
planes at once (`z=1.34`, `|x|=0.20`, `y=-0.10`, the ear gate, the head gate),
so the artifact surfaced somewhere different in every clip — which is the tell
that a rule, not a spot, is wrong.

The same trap sits behind Blender's own **Automatic Weights** wherever two
limbs pass close (armpit, groin, tail root, ear base), and behind any
hand-painted group whose boundary was drawn with a hard brush.

**How to check.** Disjointness across every edge: `1 - sum(min(w_a, w_b))`.
Zero means the neighbours agree, one means they share no bone at all. Under
~0.5 is fine; near 1.0 will tear. Then measure what it costs — deform the mesh
through every frame of every action and take each edge's `len / rest_len`,
plus the absolute metres it moved. Ratio alone over-reports on short edges.

**How to fix** — `assign_weights`, `anatomical_bias` and `relax_weight_field`
in `tools/build_bear_reference.py` are the worked example:

- Score **every** deform bone for every vertex. Never build a candidate list.
- Express anatomy — ears drive ears, a forepaw is not a jaw, a hind leg does
  not drive the shoulder — as a **smooth multiplicative bias** of `smoothstep`
  ramps, never a threshold. Keep ramps wide (0.2–0.4 m) and place them where
  the anatomy changes, not through a joint: the old `z < 1.34` plane cut
  straight through the shoulder it was trying to describe.
- **Relax the finished field across mesh topology** — average each vertex
  against its edge neighbours, ~12 iterations at 0.55. This is what turns
  continuity from a hope into a guarantee, because it works on the mesh rather
  than in world space. It moves no vertex, so the rest silhouette stays
  bit-identical; verify with a hash of the vertex coordinates.
- Cutting to glTF's four influences is *itself* a step wherever the 4th and
  5th bones are near-tied. Alternate the cut with short relaxations until
  neighbours settle on the same four. Do **not** soft-shrink by subtracting
  the 5th weight — that was tried and made it worse (0.44 → 0.69): a relaxed
  field is nearly flat, and subtracting a floor from a flat set magnifies the
  differences between neighbours instead of hiding them.

**Rigid regions are the exception that proves the rule.** A plantigrade paw
should read as one unit, but never enforce that with an exclusive group — that
is what forced the `z < 0.30` cliff which sheared the bear's ankle open.
Assert a *dominant* weight instead (≥ 0.85 on the foot bone below z = 0.16)
and let the remainder blend.

Keep both checks as assertions in the builder's `validate()` so the regression
cannot return. On the bear they moved worst-edge disjointness 1.00 → 0.43 and
the worst tear 0.605 m → 0.15 m; peak stretch per clip fell 22.8× → 5.5×
(graze), 15.7× → 3.8× (alert), 8.5× → 2.9× (trot), 5.9× → 2.5× (walk).

## Why this track is the cheap one: the animal is reproducible

Worth knowing before you envy the hand-authored cast. A procedural animal has
**no asset files at all** — the profile arrays in its species file *are* the
animal — so it is reproducible, diffable and reviewable by construction. Change
a number, reload, see it. Nothing can be lost and nothing has to be trusted.

The hand-authored track (`import-animal`) only has that property if someone
writes the build script, and one animal there does not have one: the fox was
rigged and animated in a live Blender session that was never captured back into
code, so its rig and clips exist nowhere but inside one binary .blend. When its
gaits later turned out to need real work, the bear's asset could be regenerated
from scratch a dozen times in an afternoon while the fox's could not be touched
with confidence at all — so the fox was left as it was.

**If an animal has any file a script does not produce, that is a debt, and it
comes due the first time the animal needs real work.** It applies here too the
moment a species stops being pure numbers.

## The seven touchpoints

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
5. **`src/game/hunt_items.js`** — a row on the scavenger sheet, and it is
   **required**. This is the touchpoint that looks like the two below it and is
   not, which is exactly how it gets skipped: `hunt_detect.mammals()` walks the
   pool and does `hit.add(key)` for every species it finds, so a new animal is
   detected the moment it exists — and then `detectSubjects` closes with
   `HUNT_IDS.filter(...)` and drops the hit, silently, because there is no row.
   The player frames the animal squarely, presses the shutter, and photographs
   nothing. That reads as a broken photo gate rather than as a missing line, so
   the diagnosis starts in the wrong file. The goat and the ram both shipped
   that way.

   The row's `id` must BE the `SPECIES` key — the detector's lookup is an
   identity and there is no translation table — and it is a localStorage key, so
   it is forever; rename one and you un-tick a box on somebody's real save.
   `animal: true` puts the line behind the dash's paw. `subject` completes the
   sentence "Photo of ___", so it carries the indefinite article. Add new rows
   in a block of their own rather than reordering lines a player has already
   ticked: order is only page order, and the book paginates itself.
6. **`src/ui/hud_stats.js`** — nothing. The Wildlife logbook rows walk
   `SPECIES`; the `plural` field is all it needs. (Non-mammal one-offs like
   the bald eagle keep hand-written rows.)
7. **The gallery** (`gallery.html`) — nothing. Its animal adapter walks
   `SPECIES`, so every variant appears with stand/graze/alert/walk/trot/run
   poses the moment the entry exists.

The list is done when this prints an empty array. It is the only check that
catches touchpoint 5, because nothing else in the tree will complain:

```bash
node --input-type=module -e "import { HUNT_IDS } from './src/game/hunt_items.js'; import { SPECIES } from './src/wildlife/animal_species.js'; const ids = new Set(HUNT_IDS); console.log(Object.keys(SPECIES).filter(k => !ids.has(k)))"
```

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
  right for a deer's flag, wrong for a tip marking. Use `tailMixBias` (the
  retired procedural fox's brush used 2.4) to hold the coat until the tip. `tailR` may *grow* toward the
  tip for a plume (squirrel), and the tail chain may be authored climbing
  instead of hanging — the arch itself can be the species' silhouette.
- **`flag` is deer-only** (see `animal_brain.js`); other species' tails get
  only the small `alert * 0.35` lift. Don't design a tail signal around
  `flag` for a non-deer without touching the brain.
- **`rumpTip: false`** for animals whose backside is a rounded mass (deer,
  dog); the default point-taper is right only for bear/rabbit-like rumps.
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
   walk/run where legs lock. (The gallery's **Habitat Pen** card is not for this
   track — it stocks hand-authored `glb` species only, because a solved gait is
   correct on any ground by construction and needs no behaviour sandbox to
   prove it. See `promote-glb-animal`.)
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
