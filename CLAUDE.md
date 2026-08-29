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
the *clip* rather than the other way round: `src/wildlife/glb_fox.js` measures
the ground one authored cycle covers and sets the animal's travel speed from it,
so the paws keep pace at any playback rate and the clip is never touched.
