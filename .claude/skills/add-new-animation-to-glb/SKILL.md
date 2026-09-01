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
    tools/build_raccoon_blend.py the simple case — one mesh, everything solved
    tools/build_deer_blend.py    two meshes re-parented onto one skeleton
    tools/build_bear_blend.py    a PHASED graze, and two meshes already shared
    tools/export_pack_glb.py     the generic export, one script for all animals
    tools/build_bear_reference.py  superseded as an asset, kept as the fullest
                                   worked example of solving a gait by hand

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

**Check the rest GEOMETRY, not just the names.** The same pack's `Deer_Cub_01`
carries the identical 33 bone names at 0.467 of the adult's total bone length,
with bone heads up to 0.683 apart. Moving that mesh onto the adult skeleton
stretches the fawn to adult proportions, and the names alone say it is fine. A
differently-sized animal needs its own build and its own GLB.

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

## Speed is sweep over the STANCE, and duty is the whole story

    speed = sweep / (duty * cycle)

Not `sweep / cycle`. A planted foot covers `sweep` relative to the body while it
is down, and being down takes `duty * cycle`. Dividing by the cycle underreports
by exactly the duty factor, and it is easy to do — this solver did it for two
animals before anyone noticed.

It matters most where duty is lowest, which is exactly where speed matters most.
The deer's three gaits, from identical sweeps:

| gait | sweep | duty | cycle | speed |
|---|---|---|---|---|
| walk | 0.630 | 0.62 | 0.750 s | 1.36 |
| trot | 0.697 | 0.45 | 0.458 s | 3.38 |
| bound | 0.691 | **0.20** | 0.375 s | **9.22** |

Nearly the same sweep produces seven times the speed, purely from duty. **That
is what makes a bound fast, and it is not a trick** — a hoof down a fifth of the
time spends its reach five times faster. The legs never ask for more than they
have; the solver still refuses any sweep that would clamp one.

This is also `measureExcursion`'s error, which is why `measure: 'contact'`
exists: excursion reads the swing and divides by the cycle, so it underreports
by duty. The same deer clips read 0.62 / 1.11 / 1.70 on the excursion path and
1.09 / 2.71 / 7.40 on the contact path. **Solve all three locomotion clips and
you earn the right to `measure: 'contact'`** — the claim is that every paw of
every moving clip is genuinely planted, which is only true once nothing is
inherited from the pack.

It is **all-or-nothing**, and that is worth saying plainly because it costs a
good clip. The pack's raccoon walk is genuinely planted — duty 0.47-0.53, better
than anything the deer ships — and it was still dropped and re-solved, because
one inherited gait beside two solved ones forces the whole species back onto
excursion and every gait loses its duty factor. Keeping the artist's walk would
have made the raccoon's run measure three times too slow.

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

**Probe finer than you key, AND probe the instants that matter.** This bit
twice, in opposite directions.

First: `solve_sweep` checked the reach limit at the keyframes, so the answer
moved with the frame count — 0.593 at 8 frames, 0.524 at 10 — because a coarse
cycle never landed on the worst instant. Fixed with a uniform 64-point probe.

Then a uniform probe turned out not to be enough either, and it **tore a mesh**.
The worst load on a leg is always at the END of its stance, where the foot is
furthest back under a hip that has swung forward. At a bound's duty of 0.20 the
stance spans only 13 of 64 uniform samples, so that endpoint falls BETWEEN them.
The solver returned a sweep whose own keyframes stretched the deer's fore leg to
0.479 against a 0.466 limit; the IK clamped, the leg went straight, the forelegs
collapsed under the belly and the chest skin tore.

Probe **all three**: the uniform grid, every keyframe the clip will hold, and
each leg's stance entry and exit exactly (`probe_times`).

And assert it on the KEYED result, because a paw can track its path perfectly
while the leg carrying it is clamped:

```python
assert extension <= 1.001, "the IK clamps and the mesh tears"
```

The deer's three gaits now sit at 0.968 / 0.990 / 0.981 of reach — close to the
limit, which is where a stride should be, and provably under it.

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

## Assert on the MESH, not only on the rig

    stretch, where = max_edge_stretch(meshes, frames)
    assert stretch < 1.25

The most direct check there is, and the one that catches every cause at once:
whatever the rig does, if the skin ends up longer than it was, the player sees
it. Every bone-space check is a proxy with a blind spot.

Both mesh faults in this work read **above 1.8x** here and were invisible to the
proxies being asserted at the time — a leg passed its path check while the leg
carrying it was clamped, and a neck arrived at its target by a route that
stretched every vertex on the way. Both were found by a person looking at the
animal, not by the build. Solved gaits and a well-targeted graze come out at
exactly 1.000.

## A muzzle moves on a SPHERE, not to a point

Before choosing a graze target, measure the neck's rest extension. If it is near
1.0 the chain is straight already and **cannot reach** — it can only rotate, so
the muzzle's reachable set is a sphere of the neck's own radius about its base.
The bear's neck is at 0.972 at rest. Targets picked off the ground rather than
off that sphere sat at 1.307 and 1.045 of the arc and tore the mesh.

And do not assume the chest can make up the difference. On the bear, pitching
the chest swings the neck base AWAY from a low target, so extension gets *worse*
with more pitch — 1.045 at 30 degrees against 1.273 at 75. Whether pitch helps
depends on where the neck base sits relative to the chest pivot and it differs
per animal, which is why `solve_chest` **scans** the range rather than bisecting
it. Bisection needs a monotonicity nothing here guarantees.

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

## What "done" looks like

Both finished animals, measured in game, against the real thing:

| | walk | trot | run | real animal |
|---|---|---|---|---|
| raccoon | 0.673 | 1.670 | 4.936 | ~0.7 / — / ~6 |
| deer | 1.089 | 2.728 | 7.716 | 1.15 / 3.48 / 11.9 |
| bear | 0.977 | 2.198 | 6.292 | 1.05 / 2.6 / 6.2 |

Both on `measure: 'contact'`, no `glb.drive` anywhere, every planted paw within
0.001 mm of its authored path and every cycle closing to 0.000 mm. That is the
bar: a species that needs a `drive` override has an asset problem that has not
been solved yet.

## Tune against the SHIPPED size, not the model's

`glb.height` sets a fit factor, and every solved speed is multiplied by it. The
bear ships at 1.18 against a 1.563 model, so its fit is 0.755 — a first pass
cadenced to look right in the build log landed 25% low in the game. Read the
number `loadGlbSpecies` prints, not the one the solver prints.

## A phased graze, when the species declares one

`grazeIn` + `grazeOut` turns on `GlbRig`'s sequencer, and the split earns its
keep: the Brain holds a graze 10-26 s, so one looping clip raises the head every
time it repeats. `build_phased_graze` is the generic version.

Reaching the ground is a forehand problem, not a neck one. Pitch the chest,
which lowers the shoulders; CCD the neck at the target; then put the forefeet
back with two-bone IK so the pitch costs no contact. Bisect the chest pitch for
the SMALLEST value that brings the target into reach — that is monotonic, where
a shared neck angle is not.

Five joins have to be exact and the validator fails the build on any of them:
`in` starts at rest, `in` ends where `graze` starts, `graze` loops, `out` starts
where `graze` ends, and **`out` ends at the rest pose** — the sequencer parks on
its clamped final frame as the idle carrier, so a carrier that is not rest is an
animal that never quite straightens up.

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
