# Agent guide — Procedural Autumn

A procedural autumn driving/camping game: three.js + Rapier, one `src/` tree,
no build step beyond Vite. Art direction, world constants and quality tiers
live in `src/world/WorldConfig.js`; the long-form design and findings docs are
in `docs/` — start with `docs/PERF_FINDINGS.md` for performance and
`docs/DESIGN_BRIEF.md` for the look.

This file documents the **performance measurement toolbox**, because it is the
part of the repo where an agent can most easily produce confidently wrong
numbers. Read this before measuring anything.

## The one rule

**Never quote an absolute frame time from a busy machine, and never compare
two numbers taken in different page loads.** This machine is shared: several
agents run captures concurrently, the GPU is contended without warning, and
thermals drift a parked baseline from 36 ms to 70 ms over a long session. The
only numbers worth trusting are *paired deltas measured inside one page load*,
which is exactly what `tools/ablate.mjs` produces.

## Dev servers and worktrees

The dev server on **port 5178 serves the main checkout**. If you are working
in a git worktree, `curl http://localhost:5178/src/<your new file>` returns
`index.html` (the SPA fallback) — your measurements would silently test main's
code. Start your own server (`npx vite --host 127.0.0.1 --port <free port>
--strictPort`) and point every tool at it (`--port` for ablate, `AUTUMN_URL`
for perf/shot/probe/tod). Ports 5178–5181 are typically taken.

Boot with `?seed=20261018` (or `--seed 20261018`): the committed bakes match
that seed, and a mismatched seed bakes a whole world live before the first
frame — minutes of wall clock holding the capture lock.

## There is more than one car, and the page picks at random

`src/vehicle/vehicle_models.js` holds the table of vehicles. **With nothing
pinning it, a page load picks one at random** — which is what the player should
get, and is poison for a measurement: the cars are not the same triangle count,
so two runs of the same gate would be measuring two different vehicles.

`?car=<id>` pins it (`camper`, `roamer`). **ablate, perf, shot and vshot all
default to `--car camper`** and pass it through, so an unadorned run of any of
them is already deterministic; pass `--car roamer` to look at the other one.
Anything else you drive the page with — a scratch harness, a hand-rolled
playwright script — has to pin it itself.

Adding a car is one entry in `CARS` plus a model file; the header of
`vehicle_models.js` is the whole contract, and `src/vehicle/model_kit.js` is
the shared parts bin every model is built from. The one rule is that every car
rolls on `CHASSIS` — the wheelbase, track and wheel radius VehiclePhysics, the
camera boom and the suspension tune are all built around.

## The toolbox

| tool | what it answers | trust level |
|---|---|---|
| `tools/ablate.mjs` | **which** system/feature the frame time belongs to | ground truth — the only attribution instrument |
| `tools/perf.mjs` | did a change regress frame pacing, hitches, black frames, leaks over a real drive | regression gate, not attribution |
| `tools/dprtest.mjs` | frame time at a real display's pixel ratio, with `--gate` | gate |
| `tools/shot.mjs` | deterministic posed captures of canonical views | visual A/B |
| `tools/probe.mjs` | one JS expression evaluated in a booted game | scouting |
| `tools/health.mjs` | is the app bootable, and whose module broke it | smoke |
| `src/ui/PerfOverlay.js` | in-game readout (F3; Shift+F3 detail). Shows effective pixel ratio AND internal render scale | player-facing |
| `tools/gputime.mjs` | per-pass GPU timers | **broken on ANGLE/Metal — do not trust; its header explains** |

Typical invocations:

```bash
node tools/ablate.mjs --port 5187 --seed 20261018 --mode still --rounds 3 \
    --only fx.postAll,px.iscale100          # price two things, paired baselines
node tools/ablate.mjs --port 5187 --seed 20261018 --mode still --ladder
AUTUMN_URL=http://127.0.0.1:5187 node tools/perf.mjs --seconds 45 --dpr 2
node tools/shot.mjs --url 'http://127.0.0.1:5187/?seed=20261018&iscale=0.74' \
    --out /tmp/x.png --view drive
```

Raw run archives live in `review/perf/*.json`.

## How ablate.mjs works, and why every part is there

Its header is the authoritative method description; the short version:

- **One page load** — same world, same compiled shaders for every arm.
- **Paired baselines** — the schedule is `base, arm, base, arm, base…` and
  each arm is scored against the mean of its own two neighbouring baselines.
  Drift cancels; drift that doesn't cancel shows up as the printed `spread`,
  and a saving smaller than its own spread is marked "(within noise)" and
  must not be ranked.
- **Adaptation frozen** — `engine.adaptive` and `autoQuality` off, so a heavy
  arm cannot be rescued by the scaler drawing fewer pixels.
- **Deterministic pose** — teleports to a named anchor, prints the pose, and
  warns if the camper won't come to rest. A number without its frame is not
  evidence; pass `--shot <dir>` to keep the frames.
- **Settle on convergence** — waits for draw call/triangle counts to stop
  moving before measuring, so early arms aren't compared against a
  still-streaming world.
- **`SLOW_FLIP` warm-ups** — knobs that recompile shaders or reallocate
  buffers get a longer warm-up so the transition isn't measured as the state.

### Knob families

`draw.<system>` hides geometry; `cpu.<system>` stops an update();
`fx.<feature>` toggles a render feature; `px.<scale>` / `tier.<name>` change
pixel count or preset. Two families deserve special care:

- **`fx.flatShade` is a broken instrument.** It uses `scene.overrideMaterial`,
  which replaces vertex shaders too — grass, ground cover and the tree canopy
  are *built* in their vertex shaders, so under the override they don't
  rasterise at all. Its number is "shading plus the whole near field
  vanishing". Use **`fx.shadeOnly`** (a define that dead-strips the lighting
  chain and keeps every vertex shader and overlapping fragment). This exact
  confusion produced the inflated 17.75 ms headline in an earlier revision of
  `docs/PERF_FINDINGS.md`.
- **`px.iscale100/85/74/63`** set the internal render scale (the shipped
  mechanism — see below). **`px.half` / `px.native`** resize the *drawing
  buffer*, the pre-2026-08-22 mechanism; under the internal-resolution
  pipeline they compound with the internal scale, so use them only for
  "is this fill-bound" style questions, not to price shipping configurations.
- **`draw.*` knobs carry an occlusion confound**: hiding an object exposes
  whatever it occluded (`draw.trees` measures *negative* — trees pay for
  themselves). Prefer the global diagnostics for ranking.

## The internal-resolution pipeline (what the px.iscale knobs measure)

Since 2026-08-22 the scene and the entire post chain render at
`engine.internalScale` × the canvas and are reconstructed to the canvas by a
Catmull-Rom + contrast-adaptive-sharpen pass (`src/render/UpscalePass.js`).
The default is one device pixel per CSS pixel of internal cost, presented at
the tier's `pixelRatioCap`; the adaptive scaler moves the internal scale (no
drawing-buffer reallocation, so no freeze per step; floor
`Engine.minEffectiveInternalRatio`).

URL parameters every harness can use:

- `?iscale=0.74` — pin the internal scale AND freeze the adaptive scaler
  (bypasses the floor; the frame measured is the frame asked for).
- `?sanity=1` — re-arm the HDR NaN-guard pass (off by default; its NaN source
  was fixed in grass; `perf.mjs` counts black frames on every run as the
  tripwire).
- `?matte=1` — compile the GGX specular lobe out of matte materials
  (measured at 0.7 ± 0.75 ms — noise; kept as the machinery that proved it).
- `?quality=high` — force a tier; also disables automatic tier stepping.

## Known contaminations of historical data

- **Every measurement taken before 2026-08-22 contains PerfOverlay's sync
  burst**: a 6-frame `readPixels` GPU drain every 2 s that ran even when the
  overlay was hidden and under every harness. It inflated p95s everywhere,
  produced the "p95 74 ms parked" mystery, and reached 850–966 ms per hit on
  a loaded GPU. It is now 10 s cadence, visible-only, never under webdriver.
  Paired *deltas* from old runs remain roughly valid (both arms were hit
  equally); old absolute p95/hitch counts are not.
- `perf.mjs`'s triangle budget (4.5 M) predates the tree LOD rounds, which
  peak at 7–8 M while driving. The budget line fails on every current run;
  triangle count is near-free on this GPU (see PERF_FINDINGS), so treat that
  line as stale until someone re-derives the budget rather than as a
  regression.
- `review/perf/opt-*.json` and `upscale-*.json` were taken on a heavily
  contended day (baseline drift 9–28 ms); their deltas agree with the clean
  2026-08-21 attribution but quote them as direction, not gospel.

## Etiquette

Captures take a cross-checkout lock (`tools/_lock.mjs`) — ablate takes it
exclusively. Don't run two timing tools at once; don't edit files mid-capture
(the harnesses stub HMR, but a reload aborts the run); let the GPU rest
between long runs or the thermal drift eats your spread.
