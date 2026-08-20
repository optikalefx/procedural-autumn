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

The canonical framings for this round are `river`, `waterfall`, `hero` and
`drive`. `tools/shot.mjs` takes a lock, so captures from three authors
serialise rather than fighting; a capture may sit waiting for a minute.

Do not commit. The integrator commits, so that a bad round is one revert.
