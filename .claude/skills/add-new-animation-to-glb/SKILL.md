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
it is much cheaper than modelling an animal, and this skill is the account of
doing it three times — a phased graze, a solved trot and an alert pose — on the
Animals_FREE deer. Worked examples live on branch `pack-deer`:
`tools/pack_deer_graze.py`, `tools/pack_deer_trot.py`, `tools/pack_deer_alert.py`.

## The rule still holds, and it binds harder here

**A GLB's animations are read-only** (CLAUDE.md). A bought clip is no more
editable than an authored one — *less*, because there is no .blend of yours to
fix it in. Adding a NEW action alongside them is not editing them. Never retime,
resample or scale a clip that shipped with the asset.

## Never write to the download

Author in memory, inside the export script's session, and let the export be the
only thing that produces a file. The download stays pristine and the whole
animal is reproducible from one command — which is the build script the skill
`import-animal` says every animal needs, obtained without owning the .blend.

```
Blender -b ~/Downloads/Pack.blend --python tools/export_<x>_glb.py
```

Do write a **review .blend** at the end, with every clip pushed to an NLA track
in whatever layout the pack itself uses, so there is a consistent file to open
and scrub. Write it **after** `export_scene.gltf` — strips present during an
`ACTIONS`-mode export risk every clip being emitted twice.

## Survey the rig before you pose anything

Every real decision below came out of measurement, and each took minutes. Do all
of it first; guessing costs a rebuild.

**1. What hangs off what.** This is the one that reorganises the whole plan.
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
