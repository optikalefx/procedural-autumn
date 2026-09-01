# CLAUDE.md

See **[AGENTS.md](AGENTS.md)** — it is the agent guide for this repo,
including the performance measurement toolbox, the dev-server/worktree traps,
and which instruments can and cannot be trusted. Follow it before running any
capture or quoting any frame-time number.

Deep dives referenced from there:

- `docs/PERF_FINDINGS.md` — where the frame time goes, what shipped, and
  which historical numbers were corrected.
- `docs/DESIGN_BRIEF.md` — the look the art tools judge against.

## Rule: a GLB's animations are read-only

**Never modify an imported animation in three.js.** When a model comes in from
Blender as a GLB, the clips it carries are the artist's work and the asset is
the source of truth. Do not scale, rewrite, retime by editing keys, resample,
or otherwise touch `AnimationClip.tracks[].values` — and do not pose bones by
hand on top of a clip that is playing.

This is not a style preference. It has already cost a round: a fox walk was
"widened" by scaling its leg keyframes to buy stride, and the result matched
nothing in the .blend. Two separate reasons it was wrong:

- It changed what the artist authored, silently, in a layer the artist cannot
  see. The whole reason to build an animal in Blender is that what you see in
  Blender is what ships.
- glTF bakes **absolute** bone rotations (rest × pose), not pose deltas. A bone
  resting at 125.9° carrying a ±13° swing is stored as 113°–139°, so scaling
  those numbers scales the rest pose too — and past 180° the slerp wraps and the
  limb goes somewhere nobody designed.

### What you may do instead

These change *playback*, not poses, and every pose on screen stays a pose that
is in the .blend:

- **Playback rate** (`action.timeScale`) — plays the clip faster or slower.
- **Blend weights** and crossfades between clips.
- **Where the object is**, and how fast it travels.
- **Placement transforms on a parent node** — scale, facing, terrain tilt.

### When the animation is wrong, say so — don't compensate

If a clip cannot carry what the game needs, that is a finding about the asset
and it belongs in a report, not in a workaround. Measure it, name the number,
and hand it back. The fox walk's stride was 7.6 cm per 2.042 s cycle — 0.037
m/s, against the 0.85 m/s a fox walks at. The right response is to widen the
stride in Blender, not to fake it at load.

Where the game must stay consistent with a short clip, derive the *game* from
the *clip* rather than the other way round: `src/wildlife/glb_rig.js` measures
the ground one authored cycle covers and writes the species' walk/trot/run
speeds from it, so the paws keep pace at any playback rate and the clip is never
touched.

## The two animal tracks

Wildlife has two backends and one of everything else. A species declares which
track it is on in its `mammals/<species>.js`, and nothing above that ever asks
again — habitat, streaming, the mesh pool, the logbook, photo detection and the
compass paw all walk one cast.

- **Procedural** (`blueprint:`) — profile arrays lofted by `quadruped.js`, gait
  solved against the ground every frame by `animal_anim.js`. Rabbit, squirrel,
  goat, yak.
- **Hand-authored** (`glb:`) — a mesh and its clips built in Blender, played by
  an `AnimationMixer` in `glb_rig.js`. Fox, bear, deer, raccoon — the last two
  out of the bought pack, via `tools/build_<x>_blend.py`.

`GlbRig` and `AnimRig` answer the same contract (`reset` / `update` / `setLod` /
`setShadow` / `gaitName` / `mesh`). Adding a hand-authored animal is a model and
a species file; see the `promote-glb-animal` skill.

### The birds are a third thing, and one of them is hand-authored too

`src/wildlife/birds/tree_birds.js` is not on either track above. It is the
birds' streaming, behaviour AND rig fused into one class, where the mammals
split those across `Wildlife.js`, `animal_brain.js` and a rig — so a bird has no
`Brain` to hand a drive block to, and its "rig" is `build`, `_park` and `_pose`.

Most of its species are instanced geometry flapped by a vertex shader
(`bird_material.js`). The **flamingo** is a skinned GLB out of the pack, played
by an `AnimationMixer` on a stand/fly crossfade with **no gait at all** — the
behaviour layer owns the position in both its states, so nothing ever measures
its feet. It reuses `GLTFLoader` and `SkeletonUtils.clone` inside `tree_birds`
rather than getting a backend of its own; `fitGlbBird` is the one place the
asset's facing, scale and foot-lift are decided, and the gallery builds through
it too so the card cannot disagree with the valley.

One rule that fell out of it and generalises: **a procedural model's origin sits
in its body, an exported one's sits between the feet**, and code that predates
the swap will have baked in whichever it grew up with without saying so. State
such rules about the anatomy — `_wadeY` clamps the *belly* — not about "the
origin". See the `import-animal` skill.
