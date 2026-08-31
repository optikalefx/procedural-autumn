---
name: import-animal
description: Bring a hand-authored Blender animal into the game as a GLB with its own animation clips, or add/retune a clip on one that is already in. Use whenever the user has modelled or animated a creature in Blender and wants to see it in the game — "put the fox in the game", "add the trot to the fox", "import my model", "wire up the GLB", "why is my animation not showing" — and when a clip's stride, speed, looping or gait blending needs judging. Also covers BOUGHT and downloaded assets — an animal pack, someone else's .blend — including the NLA-not-actions layout they arrive in, facing, and when contact measurement cannot be trusted. To author a clip the pack did not ship, use add-new-animation-to-glb. This is the hand-authored track; for the procedural blueprint cast (deer, rabbit, squirrel, raccoon, goat, yak — profile arrays, no model files) use create-animal instead.
---

# Import Animal

Two completely separate tracks put an animal in this valley, and the first job
is knowing which one you are on. The procedural cast (`create-animal`) has no
model files and no clips: a page of profile numbers is lofted into a skeleton
and the gait is *solved* against the ground every frame. This track is the
opposite — a mesh and its clips are authored by hand in Blender, exported to
one GLB, and played back by three's `AnimationMixer`. `src/wildlife/glb_rig.js`
is the whole worked example, and its header is required reading before you
touch anything here.

This skill covers getting the model and its clips **out of Blender and playing
correctly**. Making that animal a real species — placed by habitat, streamed,
logged, photographable, with coat morphs — is `promote-glb-animal`.

## The rule that outranks everything else

**A GLB's animations are read-only.** It is written up in CLAUDE.md; the short
version is that you may change *playback* and never *poses*:

| allowed | forbidden |
|---|---|
| `action.timeScale` — play faster or slower | editing `AnimationClip.tracks[].values` |
| blend weights and crossfades | resampling or retiming by rewriting keys |
| where the object is and how fast it travels | posing bones by hand over a playing clip |
| transforms on a parent node — scale, facing, terrain tilt | "widening" a stride at load |

This has already cost a round. A fox walk was widened by scaling its leg
keyframes, and it was wrong twice: it silently changed what the artist authored,
and glTF stores **absolute** bone rotations (rest × pose), not pose deltas — so
scaling a bone resting at 125.9° carrying a ±13° swing scales the rest pose too,
and past 180° the slerp wraps and the limb goes somewhere nobody designed.

When a clip cannot carry what the game needs, **measure it, name the number and
hand it back**. Derive the game from the clip, never the reverse.

## Every animal needs a build script, and one of them does not have one

**One deterministic script must rebuild the .blend from scratch — mesh, rig,
weights, every clip, the presentation camera and lights — and it must be checked
in.** `tools/build_bear_reference.py` is the shape: clear the scene, build
everything, `validate()`, save.

This is not tidiness. It is the difference between an animal you can work on and
one you cannot, and the two are side by side in this repo:

- The **bear**'s script is the source of truth, so the asset is disposable. Over
  one afternoon it was regenerated from scratch a dozen times: its rig gained
  four bones mid-session, all three locomotion clips were re-solved against the
  ground and re-verified, and every intermediate version was thrown away without
  a thought. Nothing was at risk because nothing was unique.
- The **fox** was rigged and animated in a live Blender session that was never
  captured back into code. `tools/build_fox_reference.py` refuses to run and
  says why: it would destroy a rig and clips that "exist nowhere else". So when
  its gaits turned out to need exactly the same rebuild — its Walk sinks 30 mm
  through the floor, its run's fore paws never come within 5 mm of the ground on
  any frame of 48 — the work could not be started with any confidence, and was
  left undone.

The debt is invisible until the animal needs real work, and then it is total.
Write the script on the way in, while the asset is still small.

### If you must change an asset that has no build script

Do not pose it by hand. Write the **narrowest script that operates on the
existing .blend** and re-run it, so the change is at least reproducible even if
the asset is not. `build_gaits(rig)` in the bear's script is that shape — it
replaces three actions and touches nothing else, so it can be run against a
loaded file rather than a rebuilt one. Take a copy of the .blend first, and
verify what landed **on disk** afterwards rather than trusting the save (see the
session traps below).

### Traps around the file itself

- A live Blender session can revert underneath you and silently discard an
  hour's in-memory work — the tell is scratch objects you added disappearing.
  After saving through MCP, open the saved file headlessly and measure it.
  `is_dirty == False` proves nothing about what is in the file.
- `bpy.ops.render.opengl` needs a GUI; under `-b` there is no OpenGL context.
  Render strips from the interactive session, or use a real render engine.
- The export script needs the .blend saved in **OBJECT mode**, or
  `bpy.ops.object.select_all` fails its poll with a bare "context is incorrect".

## Solving a gait, rather than keying one

The bear's three locomotion clips were all hand-keyed as joint angles, and all
three were broken in the same way — the feet were not on the ground. Measured
off the shipped asset:

| clip | what it actually did |
|---|---|
| Walk | front paws **112 mm below the floor**, travelling **forwards** while planted |
| Trot | in contact for **1 frame in 16** |
| run | every paw airborne **14 frames in 16**, both legs of each pair in lockstep |

This is not a bear that skates a little. A foot that is not on the ground cannot
be measured, and a clip that cannot be measured cannot drive an animal at the
right speed. Rebuilt as solved gaits the same bear walks 0.98, trots 2.38 and
gallops 5.06 m/s — 93%, 91% and 82% of a real black bear — where it used to do
0.31 / 0.50 / 0.98.

**Author the PAW, in world space, on the ground; let the joints be whatever
reaches it.** A two-bone solve per limb against the hip position the spine
actually puts there that frame. Contact stops being something to check for
afterwards and becomes a property of the construction.
`tools/build_bear_reference.py` is the worked example — `GaitPoser`, `two_bone`
and one spec per gait.

### Why hand-keyed angles cannot win on a rig like this

Check `rest_extension` first; it is the number that governs everything and it is
invisible in a render. The bear stands at **0.97** of its own leg reach, so
three degrees at the hip is the difference between a planted paw and a paw
40 cm in the air. No amount of careful eyeballing survives that, and it is why
this cast is worth solving rather than keying.

It also sets a hard ceiling. Stride has to be bought by lowering the body, and
the trade is steep and worth measuring rather than guessing — calibrate by
posing only the trunk, recording the hip path, then solving for the largest
sweep whose worst stance reach stays under ~0.955:

| body drop | largest walk sweep | largest gallop sweep |
|---|---|---|
| 0 cm | **0.1** (nothing at all) | 3.6 |
| 8 cm | 1.74 | 5.3 |
| 16 cm | 2.27 | 6.2 |

Past about 5 cm on the gallop the bear starts reading as crawling, so the honest
answer is to fix the **rest pose's zigzag** (aim 0.82–0.88) and not to keep
dropping the body. See `procedural-fall-animal-kit`.

### Ground per cycle is `sweep`, and duty is therefore free speed

A planted paw sweeps at `sweep` per unit of limb phase for `duty` of the cycle,
so the ground a cycle covers is **`sweep` and nothing else**. Duty only decides
how far each individual foot travels while it is down. That makes duty the lever
nobody looks for: cutting the gallop from 0.32/0.27 to 0.27/0.23 and raising
`sweep` to match bought **23% more ground with every paw asking the leg for
exactly the same reach as before**. Faster gaits really do have lower duty
factors, so it is honest as well as convenient.

Every paw of every gait must use one `sweep`, or the fore and hind feet scrub
against each other. Assert it: four paws on one piece of ground have to agree.

### Five things that each cost a round

- **Key every frame.** The paw track is solved in world space but Blender
  interpolates the JOINT ANGLES between keys, and an angle midway between two
  solved poses does not put the paw midway between two solved positions. At one
  key in four the planted paw sank **55 mm** through the ground halfway to the
  next key. It is free downstream too — `export_bake_animation` resamples per
  frame into the GLB whatever the .blend holds.
- **Aim bones in world space; never write `rotation_euler.x` on a leg.** These
  bones' local X axes sit up to **16° off world X**, so a "swing forward" also
  swings the leg sideways — the old hind paws tracked **39 cm** laterally across
  one stride. Build the desired world orientation, then convert back through the
  parent's posed matrix. Write only the bone's own rotation, so the head keeps
  following the parent's tail.
- **Do not let the body lift off a planted paw.** The gathered flight raises the
  front of the animal, and at duty 0.32 the lead foreleg was still pinned to the
  ground while its own shoulder climbed **28 cm** away from it — the leg ran out
  of reach and the solver clamped, which is a foot sliding. Give the fores the
  shorter contact so they leave before the launch.
- **Split trunk flex so the loin arches and the chest takes it back out.** The
  shoulder is what the forelimbs hang from and it has to hold still while they
  carry weight. Levering the whole front of the animal upward is what put the
  foreleg out of reach above.
- **The neck carries flex with the OPPOSITE sign to the trunk.** A moving animal
  stabilises its head: the body oscillates underneath and the eyes stay level.
  Carried the same way as the trunk the terms compound down a 1.3 m chain of
  neck and skull — the muzzle swung **82 cm** and ploughed the ground at the
  bottom of the fore stance. Counter-rotated it swings 57 at a gallop, and at a
  walk 12.6 cm against the shoulder's 13.7: the head moving *less* than the body
  under it.

### Name the contact points in the rig

`glb.feet` decides what the loader samples, and **naming the ankle is not good
enough**. A plantigrade foot rolls over its planted toe through a stance, so the
ankle arcs forwards over the contact point and reads **23% fast at a walk**. The
tip of the paw is the only part of the leg that is genuinely stationary on the
ground — and glTF has no way to refer to a leaf bone's tail.

So the rig carries four zero-weight `*_tip` bones whose *origins* sit exactly on
the pads, children of the toe bones, and the species names those. Four extra
nodes, no skinning cost, and the measurement goes from 23% out to **0.0%**.

### Make the promises assertions

Both properties are cheap to check at build time, and `validate()` in
`build_bear_reference.py` now fails the build on either:

- no leg is asked for more reach than it has *while carrying weight* (a clamped
  leg under load is a sliding foot);
- every planted toe tip is on Z=0 to the millimetre, and all four paws agree on
  how fast the ground is moving.

That last one is what the old Walk could never have passed: its front paws
travelled forwards while its hind paws travelled back.

## Reading a clip's speed

`measureGround` in `glb_rig.js` takes **the most common paw velocity in the
clip**. A planted paw is the only thing on the animal that holds one velocity
for a sustained stretch, and every planted paw of every limb shares it exactly,
so the ground speed is the densest cluster of velocity samples — found by
sliding a tolerance band down the sorted list. A swinging paw is accelerating
the whole time and smears across the range instead of piling up anywhere. That
the cluster's share of the samples comes out as the gait's duty factor (64% for
the bear's walk, 25% for its gallop) is not a coincidence; it *is* the duty
factor.

It replaced a measurement of the paw's total **excursion** over a cycle, which
is the ground a cycle covers only if the foot is planted for the whole of it. A
gallop's paws are down for a quarter of theirs, so the bear was driven at a
third of the speed its own legs were cycling at, and skated.

**The experiment that found it is the transferable part.** The clip was rebuilt
to cover 23% more ground and the reported number moved 4%. A lever that big
moving that little is not a tuning problem — it says the measurement is blind to
whatever you just changed, and no further work in Blender can reach it. Reach
for that test whenever an asset change fails to show up downstream.

`glb.measure: 'contact'` opts a species in, and it is a claim about the ASSET:
every paw of every locomotion clip is genuinely planted for a sustained stretch.
Where that is not true there is no plateau to find and the answer is not merely
imprecise but meaningless — **the fox's trot measures a negative ground speed**,
because its fore and hind paws travel in opposite directions while they are
down. The fox therefore stays on the old excursion path, and `fox.js` records
why. Wrong in a stable, familiar way beats wrong in a way that throws at load.

## The pipeline, end to end

### 1. Fix the clip in Blender, not in JavaScript

Everything about how the animation *looks* is settled before export. If the clip
is a GAIT, solve it against the ground rather than keying angles — see above.
The rest of the tools live in `tools/`:

- `fix_fox_loops.py` — endpoint tangents across a loop seam
- `tune_fox_trot.py` — retime a stride, scale leg reach in angle space, author
  a hop, and `cyclic_auto_handles` (below)
- `fix_walk_seam.py` — the narrow seam-only fix
- `export_fox_glb.py` — the export itself

Run them headlessly against the asset and never against a file the artist has
open in Blender — Blender holds the whole .blend in RAM and will write its
version back over yours on the next save. Ask first, then have them **File →
Revert**:

```
/Applications/Blender.app/Contents/MacOS/Blender -b assets/models/<x>.blend --python tools/<script>.py -- --write
```

### 2. Make the cycle exact before blaming the engine

A clip that does not loop is almost never an engine problem. Three distinct
defects turned up in one fox, and they look identical in the viewport:

- **A duplicated half.** `pose(k) == pose(k+24)` for every k meant a 24-frame
  stride padded out to 48; the clip "stopped" halfway. Sample the pose every
  frame and compare — do not trust the key spacing.
- **A stall, not a pop.** Blender flattens the first and last key of *every*
  channel by construction, not because those keys turn around, so the whole rig
  decelerates at the loop point at once. Walk crossed its seam at 0.0012 against
  0.0459 mid-cycle: 38× slower, a hitch every cycle, with no discontinuity
  anywhere. Fix the two seam keys from the tangent the cycle implies.
- **Unequal beats.** Auto handles cannot see across a loop, so keys near the
  ends get tangents their mid-cycle twins never get. Rebuild every handle from
  *wrapped* neighbours (`cyclic_auto_handles` in `tune_fox_trot.py`) and frame 0
  stops being a special case.

Prefer the narrowest fix that works. Rebuilding all handles fixed Walk's seam
but dragged its mid-cycle velocity from 0.0463 to 0.0393 — a change to motion
that was already signed off. The seam-only version left frames 13–35
bit-identical.

### 3. Measure on the deformed mesh, not on `matrix_basis`

`matrix_basis` is the *input channel*, not the result. Sample the evaluated
mesh's vertices — that is what the player sees, and it catches constraints,
drivers and unkeyed axes that channel inspection misses.

Two traps that produced confidently wrong answers:

- **Ratios explode near zero.** "88% velocity discontinuity" was just a tiny
  error divided by a near-zero speed. Probe at several widths: an error that
  halves as the probe halves is curvature (C2, invisible); one that holds
  constant is a real tangent break.
- **Half-cycle comparison is necessary, not sufficient.** `max|pose(k) −
  pose(k+24)|` being large does *not* prove the second half moves — a half
  frozen at one pose scores high too. Sum the per-frame motion in each half.

### 4. Know which axis is up

Do not assume. On the fox rig, `root.location[2]` points along world **−Y** and
is a fore-aft surge; world up is `root.location[1]` and it was never keyed.
Derive the mapping and assert it:

```python
mw = (rig.matrix_world @ rig.pose.bones["root"].bone.matrix_local).to_3x3()
[mw @ Vector(a) for a in ((1,0,0), (0,1,0), (0,0,1))]
```

### 5. Export

`tools/export_bear_glb.py` is the fuller pattern and `export_fox_glb.py` the
older one. Select only the rig hierarchy so the studio lights, camera and ground
plane stay out; leave `export_optimize_animation_size` on. Verify by decoding the
GLB — each clip should carry its own duration and sample count, and its first and
last sample should be identical (that closing duplicate is what lets an engine
wrap without a hitch).

**Merge the rigid detail meshes first.** A source asset keeps its claws, eyes and
teeth as separate objects because that is what is editable in Blender, but glTF
gives every object its own primitive and every primitive its own draw call. The
bear's twelve claws and two eyes were seventeen primitives against the fox's six,
which the frame cannot carry at three live animals. Joining them costs nothing:
each detail is bone-parented by a single full-weight vertex group, so
`bpy.ops.object.join()` merges the groups **by name** and every claw stays welded
to its own foot bone. That took the bear to five primitives, 11.3k triangles and
ten draw calls. Do the join in the export script, in memory, and never save it —
the .blend stays as editable as it was.

**Set each action's manual frame range**, and assert it. The fox's clips all
happen to be one scene length, so `export_fox_glb.py` leans on the scene's 0-48
and gets away with it; follow that and a 16-frame Trot arrives three times too
long. Author the clips with `use_frame_range`, export with
`export_frame_range=False`, then check the decoded durations rather than trusting
it.

### 6. Wire it up

`glb_rig.js` is the template. `mammals/fox.js` is the plain case and
`mammals/bear.js` the one with sequenced pose clips. What the rig does that
matters:

- `SkeletonUtils.clone`, **not** `Object3D.clone` — a plain clone shares the
  original's bones, so every animal plays every other animal's animation.
- Two nested transforms: `fit` carries everything about the *asset* (facing,
  scale, the lift that puts paws on y=0) and never changes; `root` carries
  everything about the *animal* and is written every frame.
- `measureStride` per clip, sampling a foot bone's travel through one cycle,
  then the animal's speed for that gait **is** that number times its playback
  rate. This is the whole mechanism that keeps paws with the ground.
- **The derived ladder has to come out monotonic.** The crossfade bands are
  `(speed - walk) / max(trot - walk, 1e-4)` and the same one tier up, so a trot
  that measures *slower* than the walk collapses the band to nothing and the
  animal skips straight to the upper gait. Rate is a judgement about cadence,
  but it is constrained: the bear's first pass at walk 2.8x / trot 1.0x put the
  walk at 0.428 m/s against the trot's 0.387 and broke the ladder. Pick rates
  that keep walk < trot < run, then justify each one as a cadence in Hz.
- Blend weights normalised to sum to 1 — an unnormalised set makes the mixer
  average toward the rest pose and the animal sinks as it changes gait.
- Damped blends and rates. `Brain`'s accel is tuned for animals moving metres
  per second, so at a slow clip's speed every change of pace completes in one
  frame; damping gives the transition a duration of its own.
- **Sequenced pose clips, where the asset authors its own transitions.** A
  species that declares BOTH `grazeIn` and `grazeOut` slots gets
  `enter -> hold -> exit` played in order instead of a crossfade straight to the
  loop; declaring neither takes the plain damped path. This exists because the
  bear's .blend authors `graze_in` (1.5 s) -> `graze` (loop) -> `graze_out`
  (1.5 s) and says why in its own comment — the Brain holds a graze for a
  variable 10-26 s, so one long clip would raise the head every time it
  repeated. Do NOT "fix" that by folding the phases into one action in Blender;
  the split is the correct authoring and the sequencing belongs here. The first
  import mapped only `graze` and silently threw the 1.5 s descent away.

  Three things it took to get right, all of which will recur for any other
  enter/hold/exit pose: the idle phase parks on the exit clip's **clamped final
  frame** (which the .blend guarantees is the exact rest pose) so the phase
  weights always have a carrier and can never sum to zero and leave the budget
  unspent; the budget is **held up** while the exit plays, or the Brain's
  already-falling channel cuts the recovery halfway through its own authored
  lift; and the entry threshold is **low** (0.05, not 0.5), because the idle
  phase sits on a rest pose and a budget rising against it blends the head down
  before the enter clip starts.
- Terrain tilt on the parent, sampled fore/aft/left/right. The procedural track
  gets this free from its per-paw ground queries; without it a GLB animal on a
  hillside stands bolt upright through the ground.

**three.js strips dots from bone names, and Blender does not.** `glb.feet` must
say `hind_footL` where the rig says `hind_foot.L` — but be precise about which
layer does it, because the wrong story sends you hunting in the wrong file. The
GLB genuinely carries `hind_foot.L`; it is `GLTFLoader` that renames it, via
`PropertyBinding.sanitizeNodeName`, which strips the characters its own
animation-path syntax reserves. (This skill and `fox.js` both used to credit the
Blender exporter. They were wrong, and it cost a round.)

The failure is worse than it sounds. `measureExcursion` **skips a bone it cannot
find** and then reports zero ground, which throws as *"check that the model faces
-z"* — a naming fault wearing a facing fault's error message.

### What this track gets, now that it has won

Nothing here is a demo beside the cast any more. A species declaring a `glb`
block gets the site table and habitat suitability, streaming and the pool, the
animation-rate LOD, coat variants, audio, the logbook, the compass paw and photo
detection — all of it, unchanged, because `GlbRig` answers the same contract
`AnimRig` does. See `promote-glb-animal` for how, and for the traps.

The one thing it still does not get is the **hide material's distance
silhouette**, and that was a deliberate call rather than an omission: the hide
shader resolves its regions from a vertex attribute a GLB does not carry, and
keeping the Blender materials exactly as authored is the whole promise of this
track. The consequence is real and expected — past ~70 m a hand-authored animal
reads brighter and more detailed than the procedural cast, which collapses
toward one dark tone. Judge it in `glblook.mjs`'s `range_*` frames.

## Assert the facing; the excursion path cannot check it for you

This repo authors **+Y forward, +Z up, hooves on Z=0** (`build_new_deer.py`).
An asset that faces the other way galloped tail-first all the way into the game
and nothing upstream caught it, because `measureExcursion` returns a foot's
absolute range and an absolute range **has no sign**. Only `measureGround`
checks direction, and an asset on the excursion path has no facing check at all.

Turn the rig at export and assert a landmark bone's sign:

```python
rig.rotation_euler.z += math.pi
skull = rig.matrix_world @ rig.data.bones["scull"].head_local
assert skull.y > 0
```

This is a placement transform on the armature OBJECT — squarely inside what
CLAUDE.md allows. Clips animate pose bones in their parents' space and the mesh
is parented to the rig, so both ride the rotation untouched.

## Contact measurement lies UPWARD on an unsolved asset

`measure: 'contact'` is a claim about the asset: every paw of every locomotion
clip is genuinely planted for a sustained stretch. Where that is false there is
no plateau to find, and the failure is not a wobble — `measureGround` latches
onto the densest cluster it can see, which on a clip with no stance is the
*swing*, and reports a number **2.5x too high** with total confidence (run 3.34
against excursion's 1.31 on the pack deer).

So check duty in Blender before believing a contact number. Sample each foot
over the cycle and count the frames within 12% of its own lowest point:

| clip | duty per foot | verdict |
|---|---|---|
| pack deer walk | 0.23 / 0.10 / 0.25 / 0.29 | not planted; left disagrees with right 2.3x |
| pack deer run | 0.29 / 0.17 / 0.17 / 0.17 | airborne gait, no stance to measure |

A walk is *defined* by a duty above 0.5. Anything near 0.1 is a clip authored to
read in a turntable, not solved against a floor — stay on excursion, which is
wrong in a familiar way rather than wrong in a way that looks like free speed.

## `glb.drive`, and what declaring it admits

A species may override the measured ladder with speeds it states outright. It
exists for ONE case and the case has to be **demonstrated, not asserted**: an
asset whose feet are not on the ground in the first place. Measurement is a
promise between a clip and the floor, and a clip that never touches the floor is
not a party to it — so nothing is forfeited that was still true.

Where feet DO plant, this is a licence to skate and must not be used. The fox
walks at a tenth of a real fox and does not get one, because its stride is a
thing to widen in Blender.

Give up exactly as much as you must and not one gait more. On the pack deer,
walk and trot reach honest speeds on playback rate alone and only `run` is
driven — it needs 10.5x against `RATE`'s 3.2 ceiling. `loadGlbSpecies` prints the
skate ratio as a warning at every boot, because a cost that is not printed stops
being noticed.

## Third-party assets: a bought rig is a good deal with a hole in it

A pack supplies the expensive parts — mesh, skeleton, weights, a coherent style
at ~1.7K triangles — and ships the clips its author thought a game needs. That is
reliably `idle`, `walk`, `run`, against the six slots `GlbRig` requires.

Three things that differ from an asset built here:

- **The clips may live in NLA tracks with no assigned action.** `ACTIONS` export
  mode reads `bpy.data.actions`, so remove the strips and export the actions.
  The Action Editor showing "New" on every rig is this, not a broken file.
- **Other animals are in the .blend.** `ACTIONS` mode tries every action against
  the selected rig, so a `Tiger_001_run` left in `bpy.data` becomes a garbage
  clip on your deer. Delete everything else first, in memory.
- **Never alias two slots to one clip.** three.js caches `clipAction` by clip
  identity, so two slots sharing an `AnimationClip` get one action and fight over
  its weight. Duplicate the action if you must stand a slot in temporarily.

Standing a slot in is a stopgap, and a visible one: `graze` as a copy of idle
means a deer with its head up for the 55% of its life the Brain spends feeding.
**Author the missing clips onto the bought rig instead.**

That path is now the standard for pack animals and has its own skill,
`add-new-animation-to-glb`. Two stages:

    Blender -b assets/models/<pack>.blend   --python tools/build_<x>_blend.py
    Blender -b assets/models/<x>_pack.blend --python tools/export_pack_glb.py

The build isolates one animal, solves the clips the pack does not ship, and
SAVES a small per-animal working .blend; the export is generic. `raccoon.js` and
`deer.js` are both built this way. Read that skill before touching a bought rig:
the pack ships every armature in REST position and every Idle track SOLOED, and
either one alone will make you believe the clips are broken.

## Verify

Dev-server trap: port 5178 serves the **main checkout**. In a worktree, symlink
`node_modules` and `public/bakes` from main, start your own server, and point
tools at it with `AUTUMN_URL`. Confirm it is really serving your code:

```
curl -s <url>/src/wildlife/<file>.js | grep <a symbol you just added>
```

1. **Look test** — `AUTUMN_URL=<url> node tools/_scratch/glblook.mjs shots/foxlook fox`.
   Writes a strip per gait from broadside (the only angle a gait can be judged
   from), both pose clips, a stand pose, the coats together, and the same animal
   at 12/25/45 m. Species-agnostic — pass the species key. Add a strip per new
   clip.
2. **Gait weights** — the harness prints them per gait and fails loudly if they
   do not sum to 1. At a gait's cruising speed that clip's weight should be ~1
   and its rate exactly its authored rate. A weight stuck part-way means the
   crossfade band is wrong; anchor bands to the animal's own cruising speeds,
   never to absolute m/s, or they drift the moment a stride changes.
3. **Pin a gait** — `wildlife.debugGait('fox', 'trot')` holds the species at one
   gait so a clip can be judged without waiting for the Brain to choose that
   pace. `debugGait(null)` releases.
4. **Read the ladder against the real animal.** The harness prints `stride` and
   `speed` per gait; compare them to what the species does in the world before
   deciding anything looks right. A bear walks 1.05 m/s, trots 2.6 and gallops
   6.2, and the clips now measure 0.98 / 2.38 / 5.06 off strides of 0.98, 1.22
   and 2.70 m. A ladder an order of magnitude low is not a tuning problem — go
   back and check the feet are on the ground.
5. **Judge a gait from broadside with a ground line drawn on.** Render one
   stride at even frame spacing, composite a line at Z=0, and look at whether
   the paws meet it. Every defect in this document was visible in that one image
   and invisible in a 3/4 view.

The journal auto-opens on first run and holds the sim. `hud.journal.close()`
starts the animation but does not finish it in one frame; pump it with
`for (let i = 0; i < 200 && j._visible; i++) j.update(0.05)` before capturing.
