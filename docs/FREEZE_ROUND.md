# The freeze round — two unrelated multi-second stalls, and why the harness could not see either

Reported by the player: *"the entire rendering freezes for 4-5 seconds every so
often. It's not a frame drop, it's a full freeze. Even happened while trying to
change the sun in the menu."*

Two separate causes, found in that order. Both were invisible to every existing
instrument, for two different reasons, and both reasons are worth keeping.

## The instrument that was missing

`perf.mjs` answers "is the frame rate good" and answers it well. It cannot
answer "what ran during that freeze". Nor can any off-the-shelf three.js tool,
which is worth writing down once so nobody goes shopping again:

- **stats.js / r3f-perf / three-perf** are FPS and counter DISPLAYS. They report
  that a frame was slow. `perf.mjs` already does that, with better statistics.
- **Spector.js** captures a frame draw call by draw call. It is a GPU
  instrument, and during a main-thread stall there are no draw calls at all —
  that IS the defect.
- **DevTools Performance panel** is the right instrument and is interactive. It
  cannot run unattended, and a freeze that happens "every so often" is exactly
  the kind you fail to catch while hand-driving with a panel open.

`tools/stall.mjs` fills the gap: it drives the game unattended and runs Chrome's
own sampling CPU profiler over the run via CDP — the same profiler DevTools
uses, no new dependency, because Playwright is already here. Frames over a
threshold get the samples inside their window aggregated and the hottest stacks
printed. That turns "there was a 4 s freeze" into "1771 ms of it was in
getProgramInfoLog".

A stall with NO samples under it is itself a finding: the main thread was
blocked where the JS profiler cannot see — a synchronous GL call or a wait on
the GPU.

## Cause 1 — the shadow-caster count is part of the program cache key

`Lighting.js` set `castShadow` on the sun from `sunI > 0.35` and on the moon
from `!sun.castShadow && moonIntensity > 0.22`. The stated invariant was "never
both casting", and that held. What also held, at every dawn and dusk, was a
window where **neither** cast.

The number of shadow-casting directional lights is part of three's program cache
key. Drop it to zero and every material in the scene re-keys and relinks,
synchronously, on the main thread. Hence a total freeze rather than a dropped
frame, and hence the menu reproduction — the sun control walks the hour straight
through the dead zone.

Measured, camera still, nothing streaming, only the hour moving:

| hour | sun / moon casting | programs | worst frame |
|---|---|---|---|
| 5.0 | false / true | 109 -> 109 | 61 ms |
| 5.5 | **false / false** | 109 -> **128** | **6150 ms** |
| 6.0 | true / false | 128 -> 131 | 170 ms |

Fix: `moon.castShadow = !sun.castShadow`, making the invariant *exactly one*
rather than *never both*. Programs compiled over a full day/night cycle went
from 26 to 1; the crossing went from 6150 ms to 57 ms.

Second layer, in `Engine`: `renderer.debug.checkShaderErrors` off for players,
**on** under automation. It calls `getProgramInfoLog` right after `linkProgram`,
which is a hard sync point — 1771 ms of one 2053 ms freeze was inside it. It
stays on under automation because `tools/health.mjs` reads every program's
`diagnostics.runnable` to catch a material that silently failed to compile, and
three only attaches diagnostics when the check is on. `?shadercheck=0` forces
the player path so `stall.mjs` can measure it.

## Cause 2 — the resolution ladder, and a harness blind by construction

After cause 1 the drive measured a worst frame of 486 ms, and the player still
saw three freezes in two minutes. **The harness could not see this class at
all**, for two compounding reasons, both introduced by this project on purpose:

1. Every capture runs at **deviceScaleFactor 1**, where `floorScale` is 1, so
   `rungs` collapses to `[1]` and the resolution ladder can never fire. The
   player is at dpr 1.5-2, where it has four rungs.
2. `autoQuality` is gated on `!navigator.webdriver` so a tier change cannot
   invalidate a capture — which also means no capture can ever measure what a
   tier change costs.

Re-run at `--dpr 2 --autoquality` and it reproduced on the first attempt: eight
stalls in 120 s, every one of them `WebGLRenderer.setSize` at 650-800 ms.
Changing render resolution reallocates the drawing buffer and the post chain;
`_adapt`'s own comment already put that at 450-2500 ms.

Two things made it fire repeatedly:

- **`setQuality` reset `resolutionScale = 1`.** The tier only drops when
  resolution is already pinned at its floor and still over budget — the machine
  has *proven* it needs every rung. Resetting to full discarded that and made
  the ladder walk down again.
- **The ladder descended one rung per 6 s window**, paying a separate freeze per
  rung, for a destination the first measurement already implied.

The cascade, measured at dpr 2:

| t | change | freeze |
|---|---|---|
| 9.5 s | rs 1.0 -> 0.85 | 1018 ms |
| 15.7 s | -> 0.72 | 1128 ms |
| 21.5 s | -> 0.667 (floor) | 970 ms |
| 39.6 s | quality -> high, **rs reset to 1.000** | 913 ms |
| 45.8 s | -> 0.85 again | 1121 ms |
| 51.8 s | -> 0.741 again | 1013 ms |

Fixes: `setQuality(name, {keepResolution})`, passed by the automatic ladder and
not by a human choosing a tier from the menu; and the ladder jumps straight to
the rung the measurement implies, `scale * sqrt(target / p80)`, since frame time
goes with pixel count and pixel count with scale squared. Aim AT budget, not
above it — aiming 15% high left it one rung short and cost a second
reallocation 6 s later.

| dpr 2, ladder armed, 120 s | baseline | keepResolution | + aim at budget |
|---|---|---|---|
| resolution/tier changes | 6 | 2 | **1** |
| worst frame | 1128 ms | 584 ms | **696 ms** |
| frames > 900 ms | **6** | 0 | **0** |
| p50 / p95 | 24.4 / 59.1 | 24.9 / 51.9 | **22.6 / 48.6** |

## Cause 3, found while verifying — the bake was never cached

`main.js` fetched the bake with `cache: 'force-cache'` and treated `r.ok` as an
existence test. A dev server answers a missing path with `index.html` at status
200, so a bake that did not exist yet returned `ok` with a body of HTML — and
`force-cache` then stored that HTML under the bake's own URL and served it
forever, including after `tools/bake.mjs` wrote the real file. Symptom: a
permanent `cached bake unusable, baking live: not a Procedural Autumn bake` and
a **35-50 s live bake on every load**, on a machine with a perfectly good bake on
disk. Verified by hand: the `.pab` over HTTP begins `PAB1` and is byte-identical
to the file while the page reported the cache unusable.

Fix: require the format's magic before believing any response, and retry once
with `cache: 'reload'` to evict a poisoned entry. Load is now **181 ms**.

## Rules adopted

1. **A capture-time immunity is a measurement blind spot.** Both
   `!navigator.webdriver` on `autoQuality` and deviceScaleFactor 1 are correct
   for reproducible plates and each hid a multi-second player freeze.
   `stall.mjs` now prints `autoQuality OFF — this run cannot see a tier-change
   freeze` on every unarmed run, so this cannot be repeated silently.
2. **Measure at the player's dpr before believing a perf result.** dpr 1 cannot
   exercise the resolution ladder at all.
3. **`r.ok` is not an existence test** against a dev server with an SPA
   fallback, and a cache hit is not a valid payload. Check the magic.
4. **Anything that changes a material's program key at runtime costs seconds on
   this scene, not milliseconds.** Light-caster counts, shadow map type, define
   changes. Treat the key as frozen after load.

## Open

- One ~700 ms hitch remains, ~6 s in, when the ladder makes its single move. On
  a larger window it may reach the upper end of the documented 450-2500 ms.
  Removing it means not resizing the canvas at all: render the scene to a
  fixed-size target and vary the viewport, letting the post chain composite.
  That is a change to how `PostFX` owns its targets and has not been started.
- Startup still carries a ~450 ms hitch in the first five seconds from grass
  scatter and genuine first-use program compiles.
- Steady state is ~40 fps at `ultra` on an M3 Pro; `perf.mjs` fails its budget.
  Pre-existing, not a regression from this round.
