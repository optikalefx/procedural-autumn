---
name: add-new-animation-to-glb
description: Author a NEW animation clip onto a rig somebody else built — a bought asset pack, a downloaded .blend, or any GLB-track animal whose .blend has no build script. Use when a model already has a skeleton and weights but is missing a clip the game needs ("add a graze", "it has no idle/alert", "the pack only ships walk and run", "give it a trot", "model the alert pose", "add an animation to the deer"), and when a clip that exists is the wrong GAIT rather than the wrong speed. For getting a model out of Blender and playing in the first place, use import-animal. For the procedural blueprint cast, use create-animal.
---

# Add a new animation to a rig you did not build

A bought animal is a bargain with a hole in it. The pack supplies the expensive
parts — mesh, skeleton, weights, a coherent art style — and ships the clips
*its* author thought a game needs, which is reliably `idle`, `walk`, `run` and
maybe a gesture. This game's `GlbRig` wants six slots and a phased graze, and
the missing ones are not decoration: `brain.grazeChance` is 0.55, so a deer with
no graze stands with its head up for most of the time anybody looks at it.

The answer is to author the missing clips **onto the bought rig**. That works,
it is much cheaper than modelling an animal, and it is how the raccoon and the
deer are built.

Worked examples, in the order to read them:

    tools/pack_rig_kit.py        the machinery, and every trap it exists to fix
    tools/build_raccoon_blend.py the simple case — one mesh, two clips solved
    tools/build_deer_blend.py    three meshes on one skeleton, walk replaced
    tools/export_pack_glb.py     the generic export, one script for all animals

An earlier experiment against the FREE sample pack lives on branch `pack-deer`
(`pack_deer_graze.py`, `pack_deer_trot.py`, `pack_deer_alert.py`). It is where
the phased graze was worked out and is worth reading for that, but the pipeline
there is superseded by the two stages below.

## The rule still holds, and it binds harder here

**A GLB's animations are read-only** (CLAUDE.md). A bought clip is no more
editable than an authored one — *less*, because there is no .blend of yours to
fix it in. Adding a NEW action alongside them is not editing them. Never retime,
resample or scale a clip that shipped with the asset.

## The standard: two stages, and the working .blend is the artefact

    Blender -b assets/models/Animals_v3.0.blend --python tools/build_<x>_blend.py
    Blender -b assets/models/<x>_pack.blend    --python tools/export_pack_glb.py

The same split `build_bear_reference.py` / `export_bear_glb.py` already uses.
The build is the slow half: it opens the pack, isolates one animal, solves the
clips it needs and **saves** `assets/models/<x>_pack.blend`. The export is fast
and generic — it takes the single armature and every mesh parented to it, so one
script serves every animal.

Saving matters. An earlier cut authored everything inside the export and saved
nothing, which meant re-solving on every run and no file anyone could open and
tweak. The working .blend is where hand-adjustments belong.

**The bought pack itself is never written to.** It is licensed third-party
source, gitignored, and the only copy — so it stays exactly as downloaded and
can be re-derived if the vendor ships v3.1. Both .blends are gitignored; the GLB
is what the repo tracks.

`tools/pack_rig_kit.py` carries the shared machinery: `open_animal`,
`face_forward`, `gait_rest` / `solve_sweep` / `build_gait`, `purge`,
`frame_view`, `point`, `ik2`, `local_translation`.

### Four things `open_animal` has to fix before anything can be measured

Each produced confidently wrong numbers, and they mask one another — fix one and
the symptom merely changes.

* **Every armature ships in REST position.** All 57. The clips animate the bone
  channels and a rest-position armature ignores its pose, so nothing moves and
  nothing says why. It is not an animation setting and appears nowhere in the
  NLA or Action editors: `armature.pose_position`.
* **Every rig ships with its Idle NLA track SOLOED.** Solo overrides the other
  tracks *and* any action you assign. The tell is different clips reporting
  identical numbers.
* **The cast is on a grid**, so an animal sits at some large X.
* **Assigning an action is not enough in Blender 4.4+.** An action carries
  SLOTS, and `action_slot` left at None evaluates to nothing — which looks
  exactly like a broken clip.

### Leave the saved file ready to open

`frame_view()` centres and zooms every 3D view on the animal, sets shading to
MATERIAL (Solid ignores materials, which is why the pack's animals first came up
flat grey), solos one clip and sets the frame range to it. A per-animal file is
only useful if opening it puts the animal in front of you.

`purge()` drops the datablocks the animal does not use. Deleting the objects is
not enough: the pack's materials and images survive unreferenced and Blender
writes them out. The raccoon's first working .blend was 34 MB, 33 of it
demo-scene textures including `Cat_Litter.png`, for a 619-vertex animal.

## Measure the clips before trusting any of them

Clip quality varies **per animal within one pack**. Duty per foot, sampled over
a cycle:

| clip | duty | verdict |
|---|---|---|
| raccoon walk | 0.47 / 0.53 / 0.47 / 0.53 | genuinely planted — keep it |
| deer walk | 0.25 / 0.30 / 0.23 / 0.10 | not planted; fore travels 0.52, hind 0.63 |

A walk is *defined* by a duty above 0.5. Where it does not hold there is no
single ground speed in the clip, so whichever number you measure, some foot
skates — drop it and solve one instead. Where it does hold, keep the artist's.

## Survey the rig before you pose anything

Every real decision below came out of measurement, and each took minutes. Do all
of it first; guessing costs a rebuild.

**1. What hangs off what, ON THIS RIG.** This is the one that reorganises the
whole plan, and it differs between animals in the same pack — carrying one
animal's hierarchy to another is how the raccoon's alert moved its paws 44 mm.
The forelegs hang off `spine.005` on the deer and `spine.007` on the raccoon, so
the neck chain has to start above whichever it is. Limb naming differs too: the
raccoon's fore leg has **no `foot` bone** where the hind has one, so the IK
targets a different bone per pair.

On the pack deer, `front_shoulder` parents to `spine.005` and the hind
`shoulder` to `spine.003` — so bending the *thorax* to lower the head drags the
forelegs through the floor, while bending the tail cannot disturb a hind leg
because `spine.002` and `shoulder.L/R` are siblings. Print parents and children
for every bone you intend to touch.

**2. Rest extension per limb** — straight-line hip-to-hoof over the summed
segment lengths. It is invisible in a render and it caps every stride you will
ever get. Aim 0.82–0.88. The bear's 0.97 is what made its stride nearly
impossible; the pack deer's fore leg at 0.843 from the shoulder is why its trot
tops out at 0.99 m/s.

**3. Chain reach against the distance you need.** The pack deer's neck arc is
0.684 from a base at z=0.986, so the muzzle cannot get within 0.30 of the ground
on neck alone — a real deer's neck reaches its own hooves. Knowing that before
posing is the difference between a design and a surprise.

**4. Bone axis sanity.** Do not assume. Every thigh bone on that rig has its
local X a full **180°** off world X. This never matters if you follow the next
rule and always matters if you do not.

## Check whether the pack ships variants as separate models

The single best thing found in this pack: it ships `Deer_01`, `Deer_Female_01`
and `Deer_Cub_01` as three models, and their armatures are **identical** — same
33 bone names, every bone head in the same place to four decimals.

So the build re-parents the doe and fawn onto the buck's rig, all three ride one
skeleton in one GLB, and `variants[].hide` picks between them. That gives three
genuinely different silhouettes off one set of clips, which is better than the
hand-authored deer managed with one mesh and droppable antlers.

Check for this before settling for scale-only variants. It is worth a minute:

```python
sorted(a.name for a in A.data.bones) == sorted(b.name for b in B.data.bones)
max((A.data.bones[n].head_local - B.data.bones[n].head_local).length for n in names)
```

Re-parent BEFORE `open_animal` deletes the other armatures, and re-point each
mesh's ARMATURE modifier as well as its parent — a mesh whose modifier still
names a deleted rig stops deforming.

## Author the contact point, not the joint angles

The same method `build_bear_reference.py` uses, for the same reason: a hoof is
either on the ground or it is not, and that is a property to **construct**
rather than to check for afterwards.

- Give each foot a path in armature space — for a gait, a straight sweep back at
  standing height while planted and a lifted arc forward while swinging; for a
  pose clip, simply its standing position.
- Solve the leg to reach it with two-bone IK.
- Re-aim the foot and toe bones at the **world directions they hold while
  standing**, or they inherit the shin's rotation and the hoof tips over.

Clamp the *target*, never the chain: clamping the hip-to-ankle vector shortens
the drop as well as the reach, so the foot rises off the ground at the extremes
of its own stance.

This is what let the graze pitch the chest 26° while every hoof stayed planted
to **0.001 mm**.

### Aim bones in world space

Use `_point_bone`'s method — rotate the bone's REST orientation by the minimal
turn from rest-forward to the direction you want (`rotation_difference`). It
preserves roll, and the bone's own local axes never enter the arithmetic, which
is the only reason that 180°-flipped thigh does not matter.

Never write `rotation_euler.x` on a limb bone.

### Key every frame

Blender interpolates **joint angles** between keys, and an angle midway between
two solved poses does not put the hoof midway between two solved positions.
Solve and key every frame. It is free downstream — `export_bake_animation`
resamples per frame anyway.

## Do not share one angle across a chain and then bisect it

The first cut of the graze spread a single "neck pitch" across four bones as
fixed shares and bisected that angle for muzzle height. It saturated: at 170° the
muzzle was still 0.564 above the ground **and climbing back up**.

Sharing an angle across a chain curls it into a hook, so past roughly 90° of
total bend the tip returns toward the base and height stops being monotonic in
the angle. Bisection on a non-monotonic function finds nothing.

**Solve by reach instead.** A few CCD passes that aim each bone at the point the
end effector must get to, confined to the sagittal plane so the chain cannot
cheat by swinging sideways. Then bisect something that *is* monotonic — the
chest pitch, where more pitch lowers the neck base and strictly shortens the
remaining distance.

## Let the solver report the speed; do not tell it one

For a gait, do not pass a stride in. Find the **largest sweep no leg has to
clamp for at any point in the cycle** and report what speed that gives. A stride
the legs cannot carry is a finding about the animal's proportions, not something
for the script to hide.

Every hoof of a gait shares one sweep, or the feet scrub against each other, and
the shortest leg sets it. On the pack deer the fore caps it at 0.455 units
against the hind's 1.038.

## Three bugs that look like Blender and are not

All three produced "the solver will not converge" or "the clip is frozen", and
all three were mine.

* **`pose_bone.head` returns a live reference.** Appending it to a list without
  `.copy()` aliases every sample to the same vector, so a moving foot reports a
  travel of exactly 0.000. A float appended alongside it copies by value and
  reads correctly, which is what made it look like partial evaluation.
* **`pose_bone.location` is in the BONE's space.** A `Root` that points straight
  up has its local Y along world Z, so writing `location.z` slides the animal
  sideways. Crouching the body to buy stride made the solved sweep go DOWN,
  because the body never came down. `local_translation()` converts.
* **`is_solo` is exclusive.** Assigning False to a track after assigning True to
  another clears the whole solo state, so the tidy one-line loop
  `t.is_solo = (t.name == want)` silently does nothing whenever `want` is not
  last. Set the others down first and the one you want last.

## Two sampling traps, and they are the same mistake

Both of these produced confident, wrong numbers.

**Probe finer than you key.** `solve_sweep` originally checked the reach limit at
the keyframes, so the answer moved with the frame count — the same rig reported
0.593 at 8 frames and 0.524 at 10, because a coarse cycle never landed on the
worst instant. The limit is a property of the geometry. Probe it at a fixed,
fine resolution (64 points) that has nothing to do with how you key.

**Validate a phase-independent property.** The trot validator compared how far
each hoof travelled between keyframes and asserted the four agreed. At an odd
frame count the two diagonal pairs get sampled at different points of their
stance, so it reported travels of 0.337 to 0.450 while every hoof was tracking
its path perfectly. It was measuring the sampling, not the animal.

Ask instead: *while planted, is this hoof where the gait says it should be?*
That is true or false regardless of when you look. It comes back at 0.001 mm.

The general form: **a validator sampled at the same rate as the thing it
validates cannot see between its own samples.** If a number moves when you
change something that should not affect it, the measurement is the bug.

## Make the promises assertions

Fail the build rather than ship a clip that does not join up. Every one of these
is cheap and every one has caught something:

- **Phase joins are pose-exact.** For a sequenced clip: `in` starts at rest,
  `in`'s last frame IS `hold`'s first, `hold` loops, `out` opens on that pose and
  **ends on the exact rest pose** — the sequencer parks on `out`'s clamped final
  frame as its idle carrier, so a carrier that is not rest is an animal that
  never quite stands up straight again. All five measure 0.000 mm.
- **The cycle closes.** Frame 0 equals frame N, or the clip decelerates across
  its own seam every loop.
- **Nothing moved that should not have.** The alert touches nothing below
  `spine.006`, so the hooves cannot move by construction — assert 0.000 mm
  anyway, because "by construction" is a claim about code you might change.
- **The brief actually happened.** Head came up, tail came up, the scan reached
  both sides. These catch a pose that silently did nothing.
- **Tie assertions to the declared target, not to a constant.** A hard-coded
  `lowest < 0.15` was left over from a soil-level first cut and failed the build
  the moment the target was deliberately raised — an assertion asserting the old
  decision instead of the current one.

## Anatomy you inherit, and cannot fix at this layer

When you extend someone else's rig you inherit its proportions, and you find out
at pose time rather than at purchase time. Both of these were real:

- **A short neck.** Driving the deer's muzzle to soil level cost 52.8° of chest
  pitch and the forehand collapsed — it read as an animal buckling, not feeding.
  The honest fix was to stop higher (0.21, a level back at 26.4°) and let the
  autumn grass cover the 17 cm. *The grass hides what the proportions cannot fix*
  — and that is a real answer, not a dodge, as long as you say so.
- **A straight fore leg.** 0.843 of its own reach at rest, hip 0.694 above the
  hoof on an 0.823 chain. A leg with no bend in it has no stride in it, and no
  amount of solving recovers what the model does not have.

Write these down in the species file. They are the standing findings about the
asset, and the next person will otherwise re-derive them.

## Timing carries more than the pose

"Stiff" is a property of the schedule, not of the angles. A frightened deer
snaps to a heading and holds dead still, so the alert scan is fast turns
separated by ~1 s freezes. Authored as a sine wave the identical pose range
reads as grazing-curious. The hold is the whole tell.

Likewise, check what actually reads at range before spending effort: the tail is
the only element of a white-tail's alert big enough to carry past ~60 m, and
`noticeDist` is 108, so the tail goes up first and stays up.

And measure the read rather than trusting the number. The alert's first yaw was
38° and barely showed, because the lift pitches the neck toward vertical and a
vertical bone hardly moves when rotated about Z. Measured at the muzzle: 38°
bought 0.19 m of swing, 75° buys 0.34 m.

## Wire it up and check the ladder

Add the slot in `mammals/<species>.js`. Declaring **both** `grazeIn` and
`grazeOut` is what turns the sequencer on; declaring neither takes the plain
crossfade.

Then re-read the whole ladder, because a new clip changes its neighbours:

- **Monotonic.** `walk < trot < run`, or the crossfade band collapses.
- **Wide enough.** Adding a real trot at 0.99 m/s left the walk at 1.15 only
  0.15 apart, so `wTrot` — `(speed - walk) / (trot - walk)` — swung across its
  whole range at once and the deer flickered between clips. The walk came down
  to 0.567. Bands need room, not just order.
- **Cadence is the honest lever.** A short stride has to cycle fast to cover
  ground; slowing a clip to a believable cadence slows the animal, and that is
  the trade to state rather than hide.

## Verify

- `node tools/wstrip.mjs --species <key> --mode graze|alert|walk|flee` — the
  real simulation, tiled. **A fresh Playwright profile is a first-ever session**,
  so `HUD.maybeShowIntro` auto-opens the journal 400 ms in and the book fills
  every frame. Seed `pa.hud` `{introSeen: true, seenHint: true}` via
  `addInitScript`.
- **The gallery's Graze pose drives a cycle, not a constant.** A constant budget
  pins `_grazeAdvance` in `hold` and the two authored transitions are unreachable
  in the one place built for looking at them. If you add another sequenced pose,
  give it a cycle too.
- **Prove the phases rather than eyeballing them.** Drive a `GlbRig` headlessly
  and record `rig.gPhase` transitions: `out → in@1.21 → hold@2.46 → exit@8.50 →
  out@9.75`, repeating.
- Judge a gait **broadside**, never in 3/4.
