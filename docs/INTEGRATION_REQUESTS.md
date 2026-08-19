# Integration requests

System authors: append here when you need a change to a file you do not own
(`src/main.js`, `src/core/*`, `src/world/WorldData.js`, another module).
Include: what you need, why, and how you worked around it meanwhile.

---

## Sky / Atmosphere / Lighting

**1. Renderer shadow-map type.** `Lighting` needs to choose the shadow filter
(it owns the light, the bias and the cascade extent) but `renderer` lives in
`Engine`, which system authors do not edit. Right now `Lighting._configureShadows()`
late-binds through `globalThis.__engine` on the first frame and forces a
material recompile, which costs one hitch at boot. Request: pass the renderer
(or an `engine` handle) to `new Lighting(scene, quality)`, or move
`shadowMap.type` into a value Engine reads from Lighting.
*Workaround in place; no action needed to ship.*

**2. Wrap / half-Lambert term on the key light.** The reference art has a soft
shadow terminator on foliage and terrain. That needs a `dot(N,L)` wrap in the
lighting chunks, which no single system author can add without editing
`THREE.ShaderChunk` lighting code that everyone shares. Atmosphere already owns
the global `fog_*` chunk patch; if the team agrees, the same file could patch
`lights_lambert_*` / `lights_physical_*` to add a wrap factor driven by one
uniform. Not done unilaterally. Currently approximated by lifting the
hemisphere fill and adding a counter-key directional.

**3. Bloom threshold vs. the sky.** `PostFX` runs bloom *after* AgX with
`luminanceThreshold: 0.62`, so any large sky area brighter than ~0.62 display
self-blooms and clips to white. The sky and cloud keyframes are authored under
that ceiling. If PostFX ever raises the threshold or moves bloom before tone
mapping, the sky keyframes in `Lighting.js` should be re-brightened by ~20%.

**4. (terrain, FYI)** As of this writing the terrain `MeshStandardMaterial`
fails to compile: `ERROR: 0:105: 'patch' : Illegal use of reserved word` —
`patch` is a reserved word in GLSL ES. Renaming the helper fixes it. Not my
file, flagged here because it blanks the ground in every capture.
> **Terrain author: fixed.** Helper renamed to `massEdge`. Thank you — that
> saved a whole round. Ground compiles and renders again.

## Terrain author — 2026-08-18

**`tools/terrain-lab.mjs` droplet count.** Bumped the lab's erosion budget from
`RES*RES*0.14` to `RES*RES*0.22` so it matches what `TerrainGen.generate()` now
runs. The lab is only useful as an instrument if it bakes the shipped world.

**Water surface flatness (`Water.js` owner).** `TerrainGen` now only marks a
cell as lake when the priority-flood had to raise it by more than 0.55 m (was
0.12 m), so the epsilon flats no longer sheet water across level meadow. Lake
count is down ~4x. Remaining small lakes still render as hard-edged flat quads
floating above the ground in wide shots — worth a shoreline fade.

**Distant terrain shadows.** Terrain chunks now cast shadows out to LOD 2
(~720 m) instead of LOD 1, because valley-crossing massif shadows are a
signature of the reference art. If the shadow-map budget gets tight, this is a
cheap thing to pull back.

## Trees author — 2026-08-18

**Fog density reaches ShaderMaterials but not MeshStandardMaterials, so the
frame renders with two different haze depths.**

`Atmosphere.update()` walks `this._materials` and does:

```js
const u = m.userData?.shader?.uniforms ?? m.uniforms;
if (!u || !u.uFogDensity) continue;
```

For a `ShaderMaterial` (trees, water, waterfalls) `m.uniforms` is the merged
block from `fogUniforms()`, so `uFogDensity` is there and gets driven. For a
`MeshStandardMaterial` (terrain, rock, grass, the camper) the custom fog
uniforms live in the *program's* merged uniform block, cloned out of
`THREE.UniformsLib.fog` when it compiled — `userData.shader.uniforms` does not
contain them, so the `continue` fires and those materials keep the compile-time
default forever.

Measured in the running game: ShaderMaterials `uFogDensity = 0.00256`,
MeshStandardMaterials still `0.0015`. That is 70% more optical depth on half
the frame.

It shows up worst on foliage, because a crown is the darkest thing in the far
field: at ~0.8 fogFactor instead of ~0.6 a dark conifer stops being a dark mass
and simply *becomes* the haze colour, so distant stands rendered as bright
cream popcorn sitting on gold ground that had kept its colour. Same cause will
be quietly desaturating water and waterfalls relative to their banks.

Suggested fix (Atmosphere owner): have `register()` also stash the standard
material's program uniforms — e.g. set `material.onBeforeCompile` to record
`shader` in `userData` *and* merge the fog uniforms into that shader's
`uniforms` — or drive the values by writing into `THREE.UniformsLib.fog` and
letting `refreshUniformsCommon` pick them up.

*Workaround in place:* `Trees.lateUpdate()` copies
`THREE.UniformsLib.fog.uFogDensity.value` — the value the majority of the frame
is actually rendering with — into the tree materials each frame, so trees sit in
the same aerial perspective as the terrain they stand on. It self-cancels once
Atmosphere drives standard materials, and can be deleted then
(`Trees._syncFogDensity`).

### Correction / escalation — the fog wiring is worse than the above

The `userData.shader` note above is a symptom. The actual cause, verified in the
running game with `tools/probe.mjs`:

```
THREE.UniformsLib.fog          has uFogDensity  -> true   (0.0015)
THREE.ShaderLib.physical.uniforms has uFog*     -> false  (no keys at all)
```

`THREE.ShaderLib.physical.uniforms` is built by `UniformsUtils.merge([...,
UniformsLib.fog, ...])` at **three's own module-init time**, which is before
`Atmosphere.patchFogChunks()` runs its `Object.assign(THREE.UniformsLib.fog,
{...})`. Merging copies; adding keys to the library afterwards does not
retroactively add them to an already-merged ShaderLib entry.

So every `MeshStandardMaterial` / `MeshPhysicalMaterial` in the game — terrain,
rock, grass, the camper — compiles the patched `fog_fragment` chunk, declares
`uniform float uFogDensity`, and is **never given a value**. It defaults to 0,
`fogFactor` is 0, and those surfaces receive **no atmospheric fog whatsoever**.

Only materials that opted in via `fogUniforms()` — trees, water, waterfalls —
are actually hazed. That is why the valley reads as fully saturated gold ground
out to 900 m with pale, washed-out trees and water standing on it: the aerial
perspective is being applied to about a fifth of the frame.

**Fix (Atmosphere owner):** merge the custom uniforms into the ShaderLib entries
after patching, e.g.

```js
for (const name of ['physical', 'standard', 'lambert', 'phong', 'basic',
                    'points', 'sprite']) {
  const lib = THREE.ShaderLib[name];
  if (lib) Object.assign(lib.uniforms, THREE.UniformsUtils.clone(customFogUniforms));
}
```

before any material compiles, and then have `register()`/`update()` reach them
through `renderer.properties.get(material).uniforms` (or keep driving them via
`onBeforeCompile` + `userData.shader`).

This is worth fixing centrally rather than per-system: it is the whole game's
depth cue, and every author is currently tuning their distance falloff against a
frame where half the surfaces have none.

*Workaround in place (trees only):* `Trees._syncFogDensity()` renders the canopy
at `FOG_MATCH = 0.37` of the authored density, measured against the terrain in
the `peaks` and `hero` views, so trees recede at roughly the rate the ground
does. Delete `FOG_MATCH` and the method once the wiring is fixed.

## Vehicle / CameraRig — 2026-08-18

**1. Depth of field focus distance (PostFX owner).** `PostFX` ships
`focusDistance: 0.02` (× `camera.far`) and nothing ever called `setFocus`, so
the focal plane sat at a fixed ~60 m: the camper was a blur at any close boom
length and the foreground was mush at any long one. `CameraRig._focus()` now
calls `postfx.setFocus(distanceToCamper * 1.15 + 4)` every frame, using the
public setter only. Flagging it because (a) if anything else ever wants to own
the focus plane we will fight over it, and (b) `bokehScale: 1.6` with
`focalLength: 0.20` is a very shallow lens — at the minimum chase distance
(5.5 m) everything past the camper is heavily defocused, which reads as
tilt-shift rather than cozy. A bokehScale nearer 1.0, or scaling it with the
focus distance, would suit the wider default framing.

**2. Bloom threshold vs. unlit particles.** Bloom's `luminanceThreshold` is
0.80. Vehicle dust is an unlit `ShaderMaterial`, so its colour is the *surface*
colour with no lighting applied — which sat right on the threshold and turned
the rooster tail into a string of glowing white beads. Worked around by
multiplying dust down to ~0.58 and dropping its alpha; no action needed, but
anyone else authoring unlit sprites should know the ceiling is there.

**3. Chase camera default framing changed (everyone).** The default chase
distance went from 12.5 m to 19 m, and the wheel now zooms 5.5–68 m. Captures
of the game will read noticeably wider than before, which is deliberate — the
reference plates frame the camper as a figure in a valley. Anything tuned to
the old framing (HUD scale, LOD switch distances, DOF, audio falloff) may want
a look.

**4. Cockpit camera is disabled.** Body panels are single-sided, so from the
driver's seat you see out through the roof and doors. Re-enabling it means
double-siding the camper shell, which costs the whole game a chunk of overdraw
for one optional view. Left behind `window.__cockpitCam = true` rather than
deleted. No action needed unless a cockpit view is wanted.

---

## From the terrain author

**1. Flat white quads on the valley floor (water?).** Visible in `peaks` and
`hero` at full bake resolution: several large, hard-edged, straight-sided white
polygons lying flat on the gold meadow, at valley altitude (~40 m). They are not
terrain — the terrain shader's only white is snow, gated above 268 m, and the
debug mask confirms those pixels are grass. They look like lake surfaces whose
mesh is a coarse polygon fitted to the lake cells and blown out past the bloom
threshold. `TerrainGen` reports 123 k cells with a fill depth over 0.12 m at
res 768, of which only those above 0.55 m become a water surface, so the lake
extents themselves are plausible; it is the shading and the silhouette that
read wrong. Whoever owns `Water.js` may want a look — a hard-edged white
rectangle in the middle of a meadow is the most conspicuous thing left in the
`peaks` frame.

**2. `waterfall` canonical view pitches down (capture harness).** The waterfall
anchor now picks a stand-off with a clear line of sight up to the lip, but the
`VIEWS.waterfall` entry in `tools/shot.mjs` uses a downward pitch, so the fall
lands at the very top of the frame and most of the shot is bank. The anchor
returns `lookY` but `shot.mjs` ignores it. Either honouring `lookY`, or giving
the waterfall view a positive pitch, would frame it properly. Not blocking.

**3. Camera anchors keep landing inside trees.** `PointsOfInterest` cannot see
the tree scatter, so the only lever available was to bias meadow/river/waterfall
anchors toward dry, open, level ground (trees follow moisture). That has fixed
the captures on this seed but it is a correlation, not a guarantee. If the tree
system can expose a cheap "is this point clear of trunks" query on
`ctx.systems.trees`, the POI scan would use it.

**4. Terrain LOD falls below the heightmap quickly.** `TERRAIN.lodResolutions`
over a 96 m chunk gives 1.5 m per vertex at LOD0 but 6 m by 380 m and 12 m by
720 m, while the heightfield is 2 m. The gully and spur relief the bake now cuts
on steep flanks is 10–20 m wide, so a good part of it is under-sampled in the
mid distance. Not changed unilaterally because it is a shared triangle budget:
the whole scene currently sits at ~1.2 M triangles against a 4.5 M budget, so
pushing `lodDistances` out to roughly `[260, 560, 1000, 1700]` looks affordable
and would visibly sharpen mid-distance mountains. Happy to make the change if
the budget owner agrees.

## RESOLVED — global fog uniforms never reached built-in materials

**Reported by:** trees author. **Fixed by:** engine owner.

**Symptom:** distant tree stands rendered as white popcorn and stood out from
the landscape; trees appeared to be the thing that was wrong.

**Actual cause:** `Atmosphere.patchFogChunks()` added its uniforms with
`Object.assign(THREE.UniformsLib.fog, …)`. Three clones every `ShaderLib` entry
from `UniformsLib` at module-init — before that runs. So every
`MeshStandardMaterial` in the game (terrain, rock, grass, the camper) declared
the fog uniforms in its shader and was never given a value: **they received no
atmospheric fog at all**, while opt-in `ShaderMaterial`s (trees, water,
waterfalls) were correctly hazed.

The same latent bug also silently disabled `Stylize`'s global cel-shading —
and separately, its `ShaderChunk` patch used an exact-string match that did not
match three's *bundled* build, which strips a blank line the source tree has.
So the stylised lighting was not running either.

**Fix:** `src/render/uniformPatch.js`.
- `injectUniforms(lib, uniforms)` writes to `UniformsLib` *and* to every
  already-built `ShaderLib` entry, cloning per entry so materials do not share
  uniform objects.
- `verifyUniforms(label, names)` asserts the injection reached the built-ins and
  logs loudly if not — this class of bug is silent, because a missing uniform
  reads as zero and the effect looks "subtle" rather than absent.
- `patchChunk(name, regex, replacement)` does whitespace-tolerant chunk patching
  and reports when the pattern stops matching a future three release.

**Action for authors:** `Trees.FOG_MATCH` is back to 1.0. If your system worked
around missing fog on standard materials, remove the workaround. If you patch
shader chunks or add uniforms to `UniformsLib`, use `uniformPatch.js`.

---

## Grass → PostFX: SSAO intensity/radius over the grass canopy

**From:** Grass author. **Owner needed:** `src/render/PostFX.js` (n8ao pass).

`tools/grass_dev/grass_diag.mjs` captures the `low` / `lowsun` meadow views with
`postfx.ao.enabled` toggled. Compare
`shots/grass/diag/low_on.png` against `shots/grass/diag/low_noao.png`, or the
magnified crops `shots/grass/crop/ao_on.png` / `ao_off.png`.

A grass field is hundreds of thousands of thin, mutually-occluding sheets, so
every blade pair generates an AO contact. With AO on, the canopy interior fills
with high-frequency dark speckle — the exact salt-and-pepper the CORRECTION
section rules out, and it is the largest remaining source of chroma/value noise
in a meadow frame. With it off the field reads as the flat painterly mass the
reference plates show.

**Request:** either

- reduce the AO pass's `intensity` (and/or `aoRadius` — the current radius is
  large enough to occlude between adjacent blades), or
- expose `postfx.ao.intensity` so quality presets can taper it, or
- restrict AO to the opaque pass before grass is drawn.

Terrain contact shadowing is worth keeping; it is specifically the sub-metre
radius over vegetation that hurts. **Not blocking** — the grass ships with AO on
and compensates with a lifted blade-base occlusion of its own
(`uBaseAO` in `src/shaders/grass_material.js`), which is why blade AO there is
deliberately shallower than it would otherwise be.

---

## Grass → whoever owns the grade: whole-frame chroma runs hot vs the plates

**From:** Grass author. **Owner needed:** `src/render/PostFX.js` grade / exposure.

Measured with `tools/colorstats.mjs` on matched grass-only crops (see
`shots/grass/crop/`, and `tools/grass_dev/crop.mjs` for the crop harness):

| region | lumaMean | chromaMean |
|---|---|---|
| reference plate 1, meadow | 0.62 | **0.54** |
| reference plate 3, mid meadow | 0.36 | **0.35** |
| ours, mid meadow | 0.39 | **0.63** |
| ours, foreground | 0.35 | **0.59** |

Luminance, range and `contrastStd` all land inside the brief's table; chroma is
the one metric that does not, and it is ~0.15–0.25 high everywhere. It is not a
clipping artifact — dropping grass exposure by 15% moved luma but left chroma
unchanged — and it is not confined to grass: a bare-terrain `drive` frame
measures 0.478.

The difference is the blue channel. The reference's sunlit ochre carries
B ≈ 0.23 where ours carries B ≈ 0.13, at identical luminance.

**Not acting on it in grass alone.** I trialled a luminance-preserving
desaturation and a sky-coloured fill strong enough to hit the target
(`uDesat` 0.20, `uSkyFill` 0.22 — compare `shots/grass/r13/drive.png` against
`shots/grass/r7/drive.png`): the field then read visibly duller than the vivid
orange terrain underneath it, which is a worse and more obvious defect than
being saturated in company. Grass now ships at `uDesat` 0.07 / `uSkyFill` 0.14,
matching the terrain. If the global grade is ever pulled toward the reference,
`uDesat`/`uSkyFill` in `src/shaders/grass_material.js` are the two dials to
raise with it.

## Water author — 2026-08-18

**1. Half-texel offset when sampling `world.dataTexture` (terrain / grass authors).**
`WorldData._buildTextures` writes grid sample *i* at world `-half + i*texel`,
which is UV `(i + 0.5) / res`. The lookup used in `TerrainMaterial.js` (and
formerly in `water_common.js`) is `vWorldPos.xz / uWorldSize + 0.5`, i.e. UV
`i / res` — half a texel out in both axes. Measured against `getBaseHeight` at
one arbitrary point: CPU 81.10 m, uncorrected texture sample 85.58 m, corrected
sample 81.10 m exactly. On a 2 m grid that is a metre of horizontal slip, and on
a steep bank several metres of height error, so anything the terrain shader
derives from the height channel (slope, snow line, shore blending) is registered
slightly off the mesh it is drawn on. Fix is one term:
`xz / uWorldSize + 0.5 + (0.5 / res)`. Done in `water_common.js`; not touched in
files I do not own.

**2. Scatter does not respect standing water (grass / trees authors).**
Grass blades and some saplings are placed inside lakes and river channels — they
are clearly visible growing out of open water in the `drive` and `vehicle`
frames. `world.getWaterDepth(x, z) > 0.15` is the test; reeds *at* the waterline
would be very welcome, blades in two metres of water are not. I cannot fix this
from the water side: the water is drawn correctly and the grass is in front of
it.

**3. Two canonical views are blocked by a tree (POI / trees authors).**
`waterfall` puts the camera 8 m up and 46 m out from the tallest fall, and a
conifer occupies the entire right half of the frame; the `river` view at full
bake resolution is likewise half-blocked. Both frames are in the standard review
set, so every author is being judged on a frame that is mostly foliage. Either
the anchor wants a clearance test against tree instances, or the two views want
a small offset. Worked around by capturing the falls with explicit `--pos/--look`
frames (`tools/_scratch/water_xshot.mjs --frames`).

## Look / render author — 2026-08-18

**1. Custom `ShaderMaterial`s do not get the global cel-shading (trees, water,
waterfalls).** `Stylize` patches `lights_physical_pars_fragment`, which only
reaches materials that use Three's physical lighting. Anything rolling its own
lighting gets none of the wrap, the banding or — the one that shows — the
diffuse floor. Measured in the `waterfall` view, a near, shadowed conifer card
rendered at literal RGB zero, where the darkest foliage in the reference plates
sits at luma 0.37; the global grade then has to lift a black hole, which is a
much worse tool than not making the hole.

`Stylize.js` now exports the same thing `Atmosphere.fogUniforms()` does:

```js
import { stylizeUniforms, STYLIZE_PARS } from '../render/Stylize.js';
uniforms: THREE.UniformsUtils.merge([fogUniforms(), stylizeUniforms(), { … }]),
fragmentShader: STYLIZE_PARS + `
  …
  float nl = stylizeDiffuse( dot( N, L ) );   // wrapped, banded, floored
  vec3 direct = nl * shadowMask * uSunColor;
`,
```

No action needed from me; adopting it is a one-line change per material and it
will remove the black foliage. Trees, water and waterfall authors — this is
yours to take when convenient.

**2. `Engine.exposure` is now a fallback, not the value in force.** Exposure is
a look decision graded in the same pass as the tone curve, so `PostFX` owns it
(`const EXPOSURE`, currently 1.0). `Engine.exposure` is still read if that is
ever set to null. Flagging so nobody tunes `Engine.exposure` and wonders why
nothing moves. Moving it onto Engine properly would be fine by me.

**3. `VIEWS.waterfall` and `VIEWS.vehicle` capture unreliably.** Roughly one run
in three, `tools/shot.mjs --all` returns either a pure-black frame or the title
screen for those two views, and the whole batch sometimes aborts with
`Execution context was destroyed`. Some of that is HMR firing while other
authors save, but the black frames also happen on clean runs. It costs everyone
re-captures and it silently poisons any measurement taken from the batch. Worth
a settle-frames wait or a "is the frame non-trivial" retry in the harness.

**4. Renderer shadow-map type (restating request 1 above, still true).**
`Engine` sets `VSMShadowMap`; `Lighting` overrides it to `PCFSoftShadowMap` on
the first frame through `globalThis.__engine`, which costs one material
recompile at boot. `sun.shadow.radius` / `blurSamples` are therefore dead
values — PCF-soft ignores them. Harmless, but confusing to read.

---

## From the Rocks author

**5. Something outside `src/rocks/` is drawing near-white faceted boulders, and
they dominate the near field.**

Verified by two independent tests at fixed cameras (`--pos/--look`, so the
framing is identical between runs):

- forcing `RockMaterial`'s albedo to flat magenta, then to flat green, leaves
  those boulders unchanged;
- setting `Rocks.group.visible = false` removes only a couple of objects per
  frame — the pale boulder fields in `meadow`, `drive`, `river` and along every
  treeline are all still there.

So they belong to another system (they look like a ground-cover or terrain-decal
layer). Two things worth knowing about them:

- *Value.* Measured off the reference plates, a sunlit foreground boulder sits
  at about `(168,153,148)` with the gold meadow beside it at `(241,166,85)` —
  the rock is roughly two thirds of the meadow's luminance. These render at
  `(200-220, …)`, i.e. brighter than the meadow, which is why they read as
  patches of snow rather than as stone. `src/rocks/RockMaterial.js` now carries
  an explicit exposure-match factor (`rock *= 0.72`) derived from that
  measurement; whoever owns these may want the same.
- *Ownership.* If they were intended as rocks, they overlap this system and we
  should delete one of the two. Happy to take them over.

**6. POI anchors are not stable between runs.** `poi.best('meadow', 0)` and
`poi.best('river', 0)` returned visibly different places on consecutive
`tools/shot.mjs` runs against the same seed — different terrain, different tree
mix — which makes any before/after comparison from `--view` unreliable. Some of
it is `bake-watch` re-baking mid-session while the terrain author edits, but if
POI ranking has a non-deterministic tiebreak it is worth pinning. Working around
it with explicit `--pos/--look` for now.

## RESOLVED — the near-white boulders ARE `src/rocks/`

**Reported by:** rocks author (as belonging to another system). **Investigated by:** engine owner.

The rocks author concluded the pale faceted boulders were not theirs, on the
strength of a magenta-albedo test and a `Rocks.group.visible = false` test. That
conclusion is wrong, and it cost them several rounds of tuning against what they
believed was someone else's artifact.

Isolated with `tools/shot.mjs --eval`, at a frozen anchor so the framing is
identical between runs:

| capture | Rocks | GroundCover | pale boulders present |
|---|---|---|---|
| `shots/diag/base.png` | on | on | yes |
| `shots/diag/no-rocks-cover.png` | off | off | **no** |
| `shots/diag/no-cover-only.png` | **on** | off | **yes** |

Hiding GroundCover alone changes nothing; hiding Rocks removes them. They are
`src/rocks/`.

The value analysis in that report is still correct and still unapplied in
practice: measured off the reference plates a sunlit boulder sits at about
`(168,153,148)` against gold meadow at `(241,166,85)` — roughly two thirds of
the meadow's luminance. In the current build they render brighter than the
meadow, which is why they read as patches of snow rather than stone. The
`rock *= 0.72` factor in `RockMaterial.js` is not enough at the current global
exposure, and may not be reaching every archetype.

**Lesson for everyone:** when testing whether an artifact is yours, hide the
system *and* confirm the artifact disappears — a negative result from a material
override only proves that particular material path is not involved.
`tools/shot.mjs --eval "<js>"` runs arbitrary page code before capture and
`shots/_anchors.json` freezes view framings, so this kind of A/B is now cheap
and controlled.

## Ground-cover author — 2026-08-18

**`fog_vertex` ignores `instanceMatrix`, so every instanced
`MeshStandardMaterial` in the game is hazed as if it stood at the world
origin.** `src/render/Atmosphere.js`:

```glsl
const FOG_VERT = `
#ifdef USE_FOG
  vFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vFogCamPos = cameraPosition;
#endif`;
```

For a normal mesh `transformed` is geometry space and `modelMatrix` carries the
object into the world, so this is right. For an `InstancedMesh` the instance
transform lives in `instanceMatrix`, which three applies later in
`<project_vertex>` — so `vFogWorldPos` is the *prototype* position, a metre or
two from the origin, for every instance.

Measured in the running game at the `meadow` anchor (camera ~(815, 6, 551)):
ground-cover fragments 8–40 m from the camera computed `dist ≈ 990 m` and hit
`fogFactor` at the `uFogMax` cap of 0.76, i.e. 76% flat cream over their own
albedo, plus the 0.85 chroma bleed. Dark shrubs rendered as pale ground and
ochre scrub as grey rags; three rounds of palette work moved the frame almost
not at all, because the albedo was barely reaching it.

Suggested fix, which keeps every existing caller correct:

```glsl
#ifdef USE_FOG
  vec4 fogWP = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    fogWP = instanceMatrix * fogWP;
  #endif
  vFogWorldPos = ( modelMatrix * fogWP ).xyz;
  vFogCamPos = cameraPosition;
#endif
```

*Worked around locally* in `src/shaders/cover_material.js`, which overwrites
`vFogWorldPos` after the chunk has run. Anyone else instancing a standard
material (rocks, wildlife, props) is silently affected and should check.

---

## Look / render author — 2026-08-18, second pass

Everything below is either a change I made inside my own files that other
authors need to know about, or something I need from a file I do not own.

### Answered: grass author's SSAO request — done

`aoRadius` 3.2 m -> **1.1 m**, `intensity` 1.7 -> **1.15**, `distanceFalloff`
1.4 -> 1.0. A metres-wide radius finds a contact between every pair of adjacent
blades, which is what filled the canopy interior with salt-and-pepper. At
roughly a blade-height the cue that reads — a rock or a trunk meeting the
ground — survives and the noise does not. `uBaseAO` in
`src/shaders/grass_material.js` can be re-judged against this; it was
deliberately shallow to compensate for the old radius.

### Grass author: the global grade *has* now been pulled toward the plates

Whole-frame chroma was the one metric outside the band, and it has been brought
down globally (`uSaturation` 0.96 -> 0.74 with `uVibrance` 0.16 -> 0.90; the
pair is a chroma *compressor*, so the pale hazed vistas came up while the
meadow came down). Nine of the ten canonical views now measure inside the
reference band for chroma.

`meadow` is the exception, at 0.41–0.51 against a band of 0.28–0.42, and it is
a grass-filled frame. Per your note, `uDesat` / `uSkyFill` are the dials to
raise with the global grade — this is that moment. The reason not to push the
global saturation any further is that `river`, `forest` and `waterfall` are
already at 0.25–0.28, i.e. at the *bottom* of the band; another global cut buys
the meadow at their expense.

### Terrain author: distant terrain needs to cast shadows further

`Lighting` now grows the shadow frustum with camera height at 4.0x rather than
2.4x, capped at 900 m, because at the old ramp the `peaks` camera (140 m)
covered only 470 m while the massif filling that frame sits 500–1500 m out.

The remaining half of that problem is yours: terrain casts to LOD 2 (~720 m).
In `peaks` the massif therefore receives no cast shadow at all and renders as a
single flat lit plane — measured `contrastStd` 0.12 against a reference band of
0.13–0.22, and it is the one canonical view still outside the band. Reference
plate 2 is a mountain valley whose entire read comes from ridge shadows falling
across the massif. Extending casting to LOD 3 would fix it; the shadow frustum
is already sized to receive them.

### Rock author: rock albedo is a long way from the brief

Measured off `meadow`, `backlit` and `river` over several rounds, boulders
render at roughly RGB 0.90/0.88/0.93 — an almost-white lavender that blows past
the tone curve's shoulder, so every facet lands within a few percent of every
other and the rock reads as a flat paper cut-out. The brief specifies
`#c3bfcc` lit (~0.77) and `#5c5a75` shaded (~0.36). At the correct albedo the
existing Stylize banding would give them real form.

In the most recent captures the same rocks render as near-black silhouettes
instead, so something is mid-flight — flagging the target either way, not the
current value. (The floating detached slabs on mountainsides are known; I
judged around them.)

### Trees / water / waterfall authors: `stylizeDiffuse` is still unadopted

Restating the request from my first pass because it is now the largest single
source of measured error in the eye-level frames. Nothing in the game currently
imports `stylizeUniforms` / `STYLIZE_PARS`, so foliage — the darkest and
largest mass in `river`, `forest` and `waterfall` — is the only thing in the
frame with no diffuse floor. Those frames measured `lumaP05` **0.02** against a
reference band of 0.16–0.42; they now measure 0.20, but only because the grade
lifts the whole shadow end of the image to catch them, which is a blunter tool
than not making the hole. Adopting it is a one-line change per material.

Also worth knowing: because trees and grass roll their own lighting, they do
not see `HemisphereLight` at all. Changing `AMBIENT_SCALE` in `Lighting.js`
moved the vistas and left the foliage frames untouched, so the ambient half of
the key/fill balance currently applies to about half the frame.

### Everyone: post-chain order changed

Now `render -> SSAO -> DOF -> bloom -> tone map -> vignette -> grade -> SMAA`.

- **Vignette moved before the grade.** It was darkening the corners by up to
  38% *after* the grade's black lift, which is why frames whose edges are dense
  conifer measured crushed blacks despite a lift designed to prevent exactly
  that.
- **DOF moved before bloom.** Bloom was turning every specular sparkle on a
  waterfall into a bright point and the DOF kernel then resolved each one as a
  hard white disc several percent of frame width across.
- `bokehScale` 1.6 -> **0.60**, `focalLength` 0.20 -> 0.26, and `focusDistance`
  now defaults to `55 / camera.far` instead of a hard-coded 0.02 (which was a
  fixed ~60 m plane and was also what every headless capture ran with, since
  nothing calls `setFocus` outside gameplay). Camera author: `setFocus` is
  unchanged and still yours; this only fixes the default and the vehicle-author
  note about the lens reading as tilt-shift.

### Correction to request 3 at the top of this file

That entry describes bloom running after **AgX** with `luminanceThreshold`
0.62. Both are stale: the curve is Khronos PBR Neutral and the threshold is
0.80. Scene exposure is `EXPOSURE` in `PostFX.js`, now **0.86** — `Engine.exposure`
is still only the fallback. Sky and cloud keyframes authored against the old
ceiling may want a look.
