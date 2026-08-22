# The smooth-water round — brief, ownership, and how you are judged

## The complaint, verbatim

> The water is pretty good, however, there are still rough spots in the terrain
> that the water doesn't know how to handle. We're looking for great looking
> water, not jagged, flowing smoothly, good shore lines, over top of terrain.
> I think you need to work on smoothing the terrain under the water placement,
> so it's less jagged.

The bar is a shipping first-party console title. Not "better than last round".

## The evidence — look at these before you touch anything

| file | what it shows |
|---|---|
| `shots/w0-base/waterfall.png` | bottom-left: the water is a set of scalloped, lobed blobs with crenellated outlines sprawling over rough ground. It reads as a spilled stain. |
| `shots/w0-base/hero.png` | the rivers are narrow jagged pale zigzags at valley scale |
| `shots/w0-base/river.png` | straight polygon segments and tan wedges intruding into the water |
| `shots/w0-base/mouth.png` | a flat grey-mauve slab across the foreground, a hard waterline, a facet crease over the open water |
| `shots/waterlab/base/talus.png` | **the diagnosis, as a map.** The carved main channel is smooth and sinuous. Every tributary head is a fractal spatter of lobed water with detached specks around it. Two different mechanisms, one frame. |

## Why it happens — the arithmetic, so nobody argues about it

The visible waterline is **not** the mesh boundary. `Water.js` cuts the mesh at
`SURF_ISO = -1.4 m`, deliberately out on the dry side, and the edge the player
sees is the fragment shader's depth test:

```
water exists where  S(x,z) - B(x,z) > 0
```

`S` is the water surface — smooth by construction, a lake exactly level and a
channel dropping a few percent. `B` is the bed, sampled bilinearly from the
baked heightfield at 2 m texels. **All of the waterline's shape comes from B.**

Perturb `B` by a bump of height `e` where the bed slope is `g`, and the
waterline moves `e/g` metres. On this map's aprons `g` is around 1:30, so eight
centimetres of bed noise — a tenth of what erosion leaves behind — swings the
waterline two and a half metres. That is the scalloped edge, and it is why the
brief says *smooth the terrain under the water*: the shape problem is a
conditioning problem, and it is upstream of every shader dial.

## The instrument

`node tools/waterlab.mjs` — nine hostile terrains driven through the **real**
pipeline (`TerrainGen`'s own `_fillDepressions`, `_flowAccumulation`,
`_carveChannels`, `_waterSurface`, verbatim), measured, in ~0.2 s per case.

```bash
node tools/waterlab.mjs --tag base            # metrics.json + per-case PNG + sheet.png
node tools/waterlab.mjs --tag mine
node tools/waterlab.mjs --compare base mine   # per-case deltas + mean improvement
node tools/waterlab.mjs --case talus --scale 4 --res 512
```

Read the header of that file for what each metric is and why. The short version:

| metric | is | target |
|---|---|---|
| `fine` | % of waterline whose curvature radius is under 3 m — detail finer than the texel that made it. **The jaggedness number.** | **< 12%** (base: 26–60%) |
| `speck` | tiny bodies + dry pinholes per km² | **< 25** (base: 190–1560) |
| `crenel` | contour length ÷ its own 4 m-smoothed length | **< 1.03** (base: 1.05–1.15) |
| `stair` | excess contour direction mass at the eight lattice angles | **< 1%** |
| `grad10` | 10th pct of \|∇depth\| at the waterline. Low = the line's position is hypersensitive, so it crawls in motion. | **> 0.25** (base: 0.09–0.17) |
| `bedRms` | RMS bed roughness in the shallow band, metres. The driver. | **< 0.15** (base: 0.37–0.62) |
| `area`, `chanWet`, `depth50` | regression guards. A "fix" that scores well by deleting water is caught here. | area within ±15% of base; `chanWet` ≥ 97% |

**The offline lab is necessary and not sufficient.** It measures the field. It
cannot see a facet, a shimmer, a pale slab or a colour. Finish in the browser.

## Browser captures

A vite dev server for this worktree runs at **http://localhost:5182**. Every
tool in `tools/` honours `AUTUMN_URL`. Do **not** start another server.

```bash
export AUTUMN_URL=http://localhost:5182
node tools/lint.mjs                                  # 1 s, refuses a broken tree
node tools/health.mjs                                # shaderFailures MUST be 0
node tools/shot.mjs --views river,mouth,waterfall,backwater,hero --dir shots/<you> --w 1600 --h 900
node tools/ab.mjs --a shots/w0-base --b shots/<you> --out shots/ab-<you> --stitch
```

`--views a,b,c` captures a subset in ONE page load. Use it: each invocation
re-bakes the world and the capture lock serialises everyone.

Do **not** pass `--refresh-views`. It re-resolves every camera anchor and
invalidates the whole review archive, including the baseline you are compared
against.

## File ownership — do not edit a file you do not own

| author | owns |
|---|---|
| **BED** | `src/world/TerrainGen.js` |
| **MESH** | `src/world/Water.js` |
| **PIXEL** | `src/shaders/water_surface.js`, `src/shaders/water_common.js` |
| **integrator** | everything else, `docs/`, `tools/` |

Three authors are editing concurrently. A read-modify-write of a file you do
not own silently destroys someone's round. If you need a change outside your
files, append it to `docs/INTEGRATION_REQUESTS.md` under a heading with your
name and say so in your report — do not make it yourself.

`tools/waterlab.mjs` is shared. You may **add** a metric or a case to it; you
may not change what an existing metric means, because the baseline was measured
with it and a redefinition turns every comparison in this round into a lie.

## Rules

1. **Nothing lands without a number.** Every constant you set, state what you
   measured to set it. "Looks better" is not a finding. The existing code does
   this throughout — match it.
2. **A regression guard is not optional.** If your change moves `area`,
   `chanWet` or `depth50`, say by how much and why that is correct.
3. **Perf is a constraint, not a follow-up.** State the cost of what you added,
   at bake time (ms, in the lab) and at frame time where it applies.
4. **Do not commit.** The integrator commits, so a bad round is one revert.
5. Report honestly. A defect you found and did not fix, named, is worth more to
   this round than a defect you papered over.
