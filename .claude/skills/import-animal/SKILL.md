---
name: import-animal
description: Bring a hand-authored Blender animal into the game as a GLB with its own animation clips, or add/retune a clip on one that is already in. Use whenever the user has modelled or animated a creature in Blender and wants to see it in the game — "put the fox in the game", "add the trot to the fox", "import my model", "wire up the GLB", "why is my animation not showing" — and when a clip's stride, speed, looping or gait blending needs judging. This is the hand-authored track; for the procedural blueprint cast (deer, rabbit, squirrel, raccoon, goat, yak — profile arrays, no model files) use create-animal instead.
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

## The pipeline, end to end

### 1. Fix the clip in Blender, not in JavaScript

Everything about how the animation *looks* is settled before export. The tools
that do it live in `tools/`:

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

Blender's exporter strips dots from bone names: `hind_foot.L` becomes
`hind_footL`.

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

The journal auto-opens on first run and holds the sim. `hud.journal.close()`
starts the animation but does not finish it in one frame; pump it with
`for (let i = 0; i < 200 && j._visible; i++) j.update(0.05)` before capturing.
