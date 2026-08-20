# The water round — file ownership and the data contract

Three authors are working on water at the same time. This file is what stops
them from clobbering each other. Read it before your first edit.

## File ownership — do not edit a file you do not own

| author | owns |
|---|---|
| **CONNECT** | `src/world/TerrainGen.js`, `src/world/Water.js` |
| **LOOK** | `src/shaders/water_river.js`, `src/shaders/water_lake.js`, `src/shaders/water_common.js` |
| **BANKS** | `src/vegetation/cover_scatter.js`, `src/vegetation/cover_forms.js`, `src/rocks/RockScatter.js` |

Anything not listed is nobody's: if you need a change there, append it to
`docs/INTEGRATION_REQUESTS.md` and say so in your report. **LOOK in particular
must not edit `Water.js`** — that is where uniforms are declared, and a
concurrent read-modify-write of that file loses one author's work silently.
If you need a new uniform, file the request; every uniform the current shaders
use already exists and most of the look budget is in how they are combined.

## The polyline contract

`world.riverPolylines` is serialised through `JSON.stringify` in
`bakeFormat.js`. **Properties attached to the array object are silently
dropped by that round-trip** — anything you need on the other side has to live
on the point objects. It is consumed by `Water.js`, `audio/water.js` and
`wildlife/Wildlife.js`, all of which read `x`, `y`, `z`, `w`, `flow`.

Shape, after this round:

```js
riverPolylines: Array<Array<{
  x, y, z,     // metres, world space. y is the WATER SURFACE, not the bed.
  w,           // channel width, metres
  flow,        // 0..1 discharge
  lake,        // 0..1 — NEW. 0 = free-flowing channel, 1 = standing water.
}>>
```

`lake` is the whole river↔lake join, expressed as one number:

- **0** through a normal reach.
- Ramps **0 → 1** over the last ~25–40 m of a reach entering a lake. Those
  points are the *mouth*: the channel flares wide, the bed shallows, `y`
  converges onto the lake surface height so there is no step, and the ribbon
  hands over to the lake surface instead of ending in mid-air.
- Ramps **1 → 0** over the first ~25–40 m of a reach leaving a lake at its
  spill point, so an outlet river is born at lake level and accelerates away.
- No point may sit in the *interior* of a lake with `lake < 1`. A reach that
  crosses open water is the defect this round exists to remove: today the
  trace follows D8 straight through the lake at `riverMask == 0`, which emits
  a dead 1.2 m ribbon at zero flow across the surface, and that is the pale
  stripe visible in `shots/w-base/river.png`.

Consumers use it as: ribbon width flare, `aFlow → 0`, foam → 0, and alpha
handover to the lake surface.

## Guarantees the geometry side may rely on

1. **Centrelines are smooth.** The raw trace is a D8 staircase at 2 m texels —
   45°/90° zigzag — and nothing downstream smooths the *position*, only the
   width and the discharge. After this round a centreline carries no feature
   sharper than the channel is wide.
2. **The carve follows the same smoothed centreline the ribbon does.** They are
   currently derived from two different things, which is why a tan channel bed
   runs alongside the water instead of under it.
3. **Surface height is continuous across a junction.** River surface is
   `bed + 0.22 + rm*0.9`; lake surface is `filled + 0.05`. Those two do not
   meet, and the step is visible where a channel reaches standing water.

## How to check your work

```bash
node tools/lint.mjs          # 1 s. Refuses to let a bad backtick reach a capture.
node tools/health.mjs        # boots the app; shaderFailures must be 0
node tools/winding.mjs       # triangle winding vs normals
node tools/shot.mjs --view river --out shots/<you>/river.png --w 1600 --h 900
```

The canonical framings for this round are **`mouth`**, `river`, `waterfall`,
`hero` and `drive`. `tools/shot.mjs` takes a lock, so captures from three
authors serialise rather than fighting; a capture may sit waiting for a minute.

## `--view mouth` — read this before you capture anything else

`mouth` is a new framing added for this round: a bank looking along the last
reach of a river into the standing water it arrives at. Nothing else in the
harness covered the junction — `river` scores standing water *down* because it
wants a dry flowing bank, and `hero` and `peaks` are far too distant to read a
waterline — so the junction was only ever judged by accident.

Capture it and look at `shots/w-base/mouth.png` first. It is much harsher than
the `river` framing and it is where this round will be judged. What it shows
today, which no other view made obvious:

1. The water is a **pale, near-neutral grey-blue slab** — in places *brighter
   than the sky*, and brighter than the land. In every reference plate water is
   the darkest and coolest note in the frame. This is the "wet dirt" failure
   the comments in `water_common.js` already describe, arriving anyway.
2. The shoreline is a **hard cut against a wide flat brown mud band**. The
   plates have gold grass overhanging a bright broken waterline; there is no
   mud band in them at all.
3. **No lace waterline anywhere in the frame.** Not weak — absent.
4. A **hard-edged brown blob floats in the middle of the water** with a dark
   shadow under it, reading as a stain rather than as a rock in a lake.
5. Straight polygon segments where the water meets the bank, bottom-left and
   mid-right.
6. Dark smudges over the open water, which look like the reflection march
   returning banded results rather than anything on the surface.

Note the anchor cache. `review/anchors.json` pins the resolved framings so a
before/after comparison measures the change and not a different patch of map,
and **concurrent `shot.mjs` runs race on writing it** — if a framing moves
under you mid-round, that is why. Do not pass `--refresh-views`; it re-resolves
every anchor and invalidates the whole review archive.

Do not commit. The integrator commits, so that a bad round is one revert.

## Integrator's queue — landed findings still to be applied

Held here rather than in `docs/INTEGRATION_REQUESTS.md` because three authors
append to that file concurrently and one entry has already been lost to a
read-modify-write race on it.

1. **`uWetBand` is at 3.1 m and should be near 1.0.** `Water.js:171`. This is
   the pale band the banks author measured rasterising metres inland of the
   waterline, and it is the single largest remaining difference between our
   shoreline and reference plate 3. Their measurement is unambiguous: hiding
   every scatter layer moves those pixels under 1%, hiding the *water* moves
   blue by 16 points and restores a warm tan — so the band is the lake surface
   drawn over dry meadow, not the ground and not vegetation.
   `docs/WATER_ART_SPEC.md` §3.5 independently measured the plates' damp band
   at 0.7–1.1 m on ordinary banks, with 3.1 m reached only on the shallowest,
   and flagged our value as sitting at the *top* of the plate range rather than
   the middle. Two authors reached the same number from opposite directions.
   Blocked on `Water.js` being free.

2. **`distToWater` should be baked.** `TerrainGen._climate()` already computes
   the exact chamfer raster every shoreline rule needs and then discards it; it
   is not in `bakeFormat.js`, so nothing downstream can see it. What exists
   instead is `WorldData.distToShoreApprox`, which returns 0 or 8 and — because
   it reads the *channel* mask, which is identically zero over standing water —
   is blind to every lake in the world. It is live in `getSurfaceWeights`
   gating the `sand` term, which is why lake shores get no shore texel while
   river banks get a hard-edged one. The banks author has a working
   reimplementation (`ShoreField` in `cover_scatter.js`, cached on the world
   object) that `RockScatter` currently imports out of the vegetation module —
   the wrong direction for that dependency, and it goes away with this.
   Touches `bakeFormat.js`, `WorldData.js`, `TerrainGen.js`, `worldWorker.js`.

3. **Refresh the camera anchors, once, after the round lands.**
   `node tools/shot.mjs --refresh-views`. The carve follows a smoothed
   centreline now, so channels have moved and `review/anchors.json` resolves to
   different ground; a critic comparing against `review/048..051` is comparing
   two terrains. Do it once, for everybody, and never mid-round — three authors
   reported framings moving under them between captures, and concurrent
   `shot.mjs` runs additionally race on writing that file.

4. **Crag blocks float in clear sky** on the massif in `mouth`. Pre-existing,
   nothing in this round goes near crag placement, and the rock census reports
   `airborne: 0` near both water anchors — so it is the crag system, not the
   scatterer. Not a water defect; logged so it is not rediscovered as one.
