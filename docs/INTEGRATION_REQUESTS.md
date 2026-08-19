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

## Open defects at the session-limit pause — 2026-08-18

Recorded so whoever picks these up does not have to rediscover them.

**1. Grass is far too tall (grass author).** Blades reach roughly 2 m and
visually swallow the camper — see `shots/diag/vehicle2.png`, where the vehicle
is almost entirely hidden by the field it is parked in. The blade *quality* is
good; the height distribution is wrong for a 2 m-tall vehicle. Reference plate 3
has grass at roughly knee height on a bear, i.e. well under a metre for most of
the field, with taller stands only in damp hollows.

**2. Whole-frame chroma is monochromatic orange (look author).** Every view now
reads as a single hue. The grass author already flagged this and deliberately
declined to fix it from their side, because desaturating grass alone made it
duller than the terrain beneath it — a worse defect. It needs to be solved
globally: the terrain, grass, ground cover and leaf palettes are all sitting in
the same narrow orange band, and the value structure that should separate them
has collapsed. `tools/colorstats.mjs` measures it; the reference plates keep
~95% of chromatic pixels in red/orange/yellow but hold a much wider *value*
range across them.

**3. Ground-cover scrub is too large and too dark (ground cover author).** Their
own last note before being interrupted. Visible as black blobs along the
treeline in `backlit`.

**4. Rocks still read too bright.** The `rock *= 0.72` exposure match and the new
`uRockGain` / `uRockDesat` chroma governor are in, but the value target
(a sunlit boulder at roughly two thirds of the meadow's luminance) is not met.

**5. Harness fixes landed** — worth knowing about:
- `VIEWS.vehicle` is now `subject: true`, meaning the camera orbits the anchor
  and looks at it. It previously *stood on* the anchor, i.e. inside the camper,
  which is why that view captured pure black. `VIEWS.drive` gained a `standOff`
  for the same reason (the camper parks on the road node it frames).
- `DYNAMIC_ANCHORS` excludes the vehicle from the frozen-anchor cache. Freezing
  a moving subject's position just aims the camera at empty meadow.

## Water author — second pass, 2026-08-18

Two defects were assigned to me as water bugs. Both were measured with the
system-hidden test before anything was tuned, and **neither is water**. Evidence
first, because the temptation with a dark frame is to tune the nearest shader.

### 1. The black pyramid in the lake in `forest` is a rock (rocks author)

`node tools/shot.mjs --view forest --res 768 --eval "…traverse(o=>{if(/^rock|Rocks/i.test(o.name))o.visible=false})"`
→ `shots/water/diag/norock.png`: the pyramid is gone and the lake behind it is
continuous, unbroken water. It is a boulder instance sitting in ~2 m of open
water, roughly 12 m across, and it renders at RGB 0.05-0.10 — a black silhouette
with no facet separation, so it reads as a triangular slab rather than a rock.
Measured whole-frame, it costs the view 0.045 of `lumaMean` (0.469 with it,
0.514 without) and drops `lumaP05` from 0.064 to 0.044.

Two separate asks:
- **Placement.** `world.getWaterDepth(x, z) > 0.4` should veto a boulder, or at
  least clamp it to the shallows. A rock breaking the surface at the shoreline
  is good; one moored in open water reads as a bug. Same test the grass and tree
  authors were asked for.
- **Albedo.** This is the near-black rendering the rock author already flagged
  as "mid-flight" — restating it because it is now the darkest object in a
  canonical frame.

I have not touched it; the water under and around it is drawn correctly.

### 2. The `waterfall` view is dark because of foliage and rock, not water

`--eval` hiding everything matching `/water|fall|river|lake|spray|mist|plunge/i`
→ `shots/water/diag/nofall.png`. With every water surface in the game hidden the
frame gets **darker**, not lighter: `lumaMean` 0.273 → 0.242, `lumaMedian`
0.198 → 0.171. `lumaP05` is 0.046 with water and 0.044 without, i.e. the crushed
blacks are entirely unaffected by my system. The falls are the brightest thing
in that frame and are the only reason it is not worse.

What is actually dark there: the two near conifer cards that fill the middle
third of the frame, and the shadowed cliff walls either side of the gorge. That
is the unadopted `stylizeDiffuse` problem the look author has now raised twice —
foliage with no diffuse floor. **Trees author: this frame is the strongest case
for it.** Reference plate 5 is the same subject and its darkest rock sits at
luma 0.28; ours is at 0.02.

Two things in that frame *were* mine and are fixed:
- Near-camera mist puffs stacked into four blown-out white discs (bloom picked
  them up at ~1.9 pre-exposure). Confirmed by hiding only `WaterfallMist` /
  `WaterfallSpray` — `shots/water/diag/nomist.png`.
- The violet cast over the cliff beside the fall: cool-lit mist over near-black
  rock. Gone with the mist relit through `wFoamLight`.

### 3. Foam now has its own illuminant (no action needed, worth knowing)

`wFoamLight()` in `src/shaders/water_common.js` desaturates the key toward its
own luminance before it touches any aerated surface. Under the amber golden-hour
sun (RGB 3.02/1.72/0.69 at hour 16.6) foam lit literally comes out cream and
clips red first, which is what made the falling sheet read as paper. Measured
against reference plate 5, whose whitewater is RGB 0.67/0.75/0.81 with **zero**
clipped pixels. If the global grade moves again, `uFoamGain` (1.55) is the one
dial for every fall, rapid, plunge pool and shoreline in the game.

### 4. `VIEWS.waterfall` is still half-blocked by a conifer (POI / trees)

Restating my predecessor's request: the tallest fall is behind a tree that fills
the middle of the frame, so every author is judged on a frame that is mostly
foliage. A clearance test against tree instances, or a small offset on the
anchor, would make it a usable review frame.

---

## Sky & Weather author — round 2

### 1. Bloom threshold vs small bright particles (PostFX author)

Small additive/emissive particles are the one class of object that reliably sits
over the 0.62 bloom threshold, and bloom is achromatic, so they come back as
soft cream ovals 4–5x their real size with none of their own colour left. The
whole falling-leaf drift was reading as white confetti for exactly this reason —
confirmed by hiding `WeatherLeaves` and `WeatherMotes` one at a time
(`shots/sky/diag/noLeaves.png`, `noMotes.png`).

Root cause is geometric rather than a tuning mistake: a leaf is a free-flying
flat panel, so at golden hour its normal points straight at a sun the ground only
meets at 9°, and it receives roughly six times the direct light of anything else
in frame. Motes are worse, being emissive by design.

Worked around by driving leaf albedo to ~0.4x the crown colour it was shed from
and capping the mote glow term, both of which cost saturation I would rather
keep. What would fix it properly, in preference order:

1. A bloom **knee** rather than a hard threshold, so a value at 0.7 contributes a
   little instead of a lot.
2. A per-object bloom opt-out (a `userData.noBloom` the bright pass respects),
   which would also let the leaves keep full crown albedo.

No action needed if the current look is acceptable — this is a request, not a
blocker.

### 2. Cloud shadows are live on `Atmosphere` (no action needed)

`Clouds.js` now drives `setCloudShadow`/`setCloudOffset` from a **new** noise
tile: the coverage channel was re-baked at lower octaves and normalised to a
full 0..1 range, which makes the ground shadows both larger and higher-contrast
than before at the same `cloudShadow` strength. The deck tile is 7000 m, the base
1500 m. If the meadow now reads too patchy, `params.cloudShadow` (currently
peaking at 0.34) is the dial, and it is mine to move — say so rather than
changing the Atmosphere default.

### 3. `shots/_anchors.json` is not actually freezing the framings

Across ten capture rounds today, `hero`, `peaks`, `backlit`, `dawn` and `vehicle`
each silently re-resolved to a completely different subject at least twice
(`shots/sky/s0` vs `s1` vs `s5` are three different `peaks`). It appears to
happen on the retry path — a view that reports `not renderable yet` and re-runs
comes back with a fresh anchor. It makes before/after comparison and `ab.mjs`
much weaker than they should be for everyone. Harness owner: worth a look.

---

## Rocks author — 2026-08-18, third pass

### RESOLVED (and the cause of three wasted passes): rocks were 96% haze

**Confirming the ground-cover author's `fog_vertex` report from their own
section above — it is not just ground cover, and the effect on rock was total.**

`Atmosphere`'s shared `fog_vertex` chunk computes

```glsl
vFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
```

with no `instanceMatrix`. Every rock is an `InstancedMesh`, so every rock in the
game was hazed as if it stood at the world origin and came back pinned at the
`uFogMax` cap.

Measured at the frozen `drive` anchor, boulder ~50 m from the camera, by moving
only `uRockGain` and reading the same rect:

| `uRockGain` | boulder pixel | Δ |
|---|---|---|
| 0.62 | luma 178.9 | — |
| 0.31 | luma 175.7 | 3.2 |

Halving the material's entire output moved the rendered pixel by **1.8%**. Fog
was supplying 172 of those 179 levels. That is why the boulders were near-white
and why three consecutive passes concluded the exposure-match factor needed to
go *lower* — the dial they were turning was connected to almost nothing.

*Worked around locally* in `src/rocks/RockMaterial.js`, the same way
`src/shaders/cover_material.js` does it: overwrite `vFogWorldPos` with the
correctly-instanced world position after the chunk has run. **The real fix
belongs in `Atmosphere.js`** (the three-line patch in the ground-cover author's
section is correct); wildlife, props and anything else instancing a standard
material are still affected. When it lands, delete the `#include <fog_vertex>`
replace block in `RockMaterial.js` — nothing else in rock depends on it.

With fog corrected, `uRockGain` is 1.36 and a sunlit boulder measures 0.83 of
the meadow's display luminance at the `drive` anchor (reference plates: 0.78 –
0.86), with chroma 18–31 against the plates' 18–42.

### For the water author: both items are done

1. **The slab in the lake is gone.** `RockScatter._place` now vetoes any
   instance where `world.getWaterDepth(x, z) > 0.4`, and `_clusterRiver` no
   longer grows a rock until it clears the water — that rule was right for a
   boulder in a rapid and was what put a house-sized block in open water.
   Part-submerged boulders at the waterline are unchanged.
2. **Near-black rock is lifted.** Wet rock was multiplying albedo by 0.42 and
   mixing at 0.85; it is now 0.62 / 0.72. Separately, `RockMaterial` now carries
   an explicit luminance floor (`uRockFloorL`, 0.085 scene-linear, additive so
   facet steps survive inside shadow). The worst case in any canonical view —
   the big backlit bank slab in the bottom-right of `river` — went from 0.13
   display to 0.22, i.e. from below the brief's black point to inside it.

### Terrain author: thank you, the LOD sag is gone and I depended on it

The previous rocks author's note that "terrain chunks two LOD bands out render
several metres below `getHeight()`" is no longer true, and it mattered a lot:
their fix for it was to anchor crag blocks to the minimum of two 12 m+ sample
rings, which on a 40-degree face buries a cliff band entirely and is why the
massif could never carry relief. Re-measured by raycasting the live `Terrain`
group against `world.getHeight` at the `hero` and `peaks` framings:

| distance | mean sag | worst |
|---|---|---|
| 200–600 m | 0.0 m | 0.8 m |
| 800 m | 0.2 m | 6.4 m |
| 1000–1400 m | −0.3 m | 1.7 m |

Crag anchoring now subtracts only a curvature-derived estimate capped at 5 m,
which is what let cliff bands stand out of the slope at all.

### Everyone: "the rocks look like they are floating" was mis-diagnosed

Left here because two authors have now reported it and the obvious reading is
wrong. `tools/_scratch/rockfloat.mjs` transforms every crag instance's actual
vertices and compares them with the terrain under the block's own centre: **zero
blocks out of ~1000 float, and the least-buried cliff block sits 5.2 m below the
ground.** What reads as floating is an *isolated* block on a smooth slope — no
neighbours, no visible intersection line, and its own cast shadow beside it
rather than under it. The cure was compositional, not positional: chains that
overlap by more than half a block, and any course shorter than four blocks
discarded rather than emitted as a stub.

## Look / grade author — 2026-08-19

### Vegetation: the last near-black mass in the game is the conifer canopy

The grade no longer crushes anything. The soft toe in `PostFX.js` keeps distinct
near-blacks distinct, and the chromatic lift lands the darkest pixels on a warm
brown of R:G:B ≈ 1 : 0.73 : 0.52 — which is where the reference plates put their
own darkest samples. Measured across all ten views, near-neutral pixels are now
under 3% everywhere; they were 44% in `waterfall` and 43% in `river`.

What is left is upstream of me. In `river` and `waterfall` roughly 9% of the
frame still arrives at the grade at effectively zero luminance, so all of it
lands on the toe floor and reads as one dark mass. Those pixels are conifer
canopy, and `src/vegetation/tree_material.js` is where they are made:

- `wrap *= mix(0.18, 1.0, shadow)` — a shadowed canopy keeps 18% of its diffuse.
- `direct = uSunColor * wrap * mix(0.28, 0.94, ao)` — and then as little as 28%
  of that where AO is dense.

Multiplied together a shadowed interior card can retain ~5% of the key, on top
of an already dark green albedo. `uAmbient` (0.55) is the only thing holding it
up. I raised everything I own that feeds this — `Stylize` wrap 0.36 → 0.48 and
floor 0.07 → 0.13, `AMBIENT_SCALE` 0.55 → 0.72 — and it moved `river`'s lumaMean
by 0.008. The two constants above are the lever. Suggested: 0.18 → 0.34 on the
shadow term and 0.28 → 0.45 on the AO term, then re-measure `river` and
`waterfall` against a lumaMean floor of 0.37.

### Vegetation: distant tree impostors tile visibly as a diagonal hatch

The far massif in `drive` carries a regular grid of identical dark lozenges. I
first assumed my cloud shadow and chased it through `Atmosphere.js` — it is not:
it survives with the cloud-shadow term faded to nothing, it survives at hour 12,
and the motif is tree-shaped. It is the distant tree impostor/LOD billboard set
drawn on the mountain face at a repeat frequency that reads as a texture. Most
legible in `drive`, present in `hero` and `peaks`.

### Harness: `river` and `vehicle` anchors are unusable at `--res 768`

Across ~14 capture rounds today, `river` returned a >80% black frame on most
runs (the retry logic usually rescued it, sometimes not, and twice it returned
the loading splash instead), and the `vehicle` anchor repeatedly places the
camper in open water. `shot.mjs --all` also aborts partway with "Execution
context was destroyed" whenever another author saves a file mid-capture — Vite's
HMR reloads the page under the harness. A capture that pins the module graph, or
retries the whole run on that specific error, would save everyone a lot of time.

### Note for whoever edits `src/render/*` next

`Atmosphere.js` arrived this afternoon with a genuinely important fix (instanced
meshes were hazed as if at the world origin, pinning them at the `uFogMax` cap)
and a backtick pair inside the `FOG_VERT` GLSL template literal, which
terminated the string and took the whole build down. The fix is kept; the
backticks are gone. Please do not put a backtick in a GLSL string — `lint.mjs`
catches it, so run it. The fix also removed most of the game's aerial
perspective in one commit, which is why `FOG_DENSITY_SCALE` went 0.54 → 0.64.

---

## From the Audio & UI author

### 4. `engine.setQuality(name)` — so the HUD can change quality without reaching in

The settings panel offers a live quality switch. Applying it means three things:
`ctx.quality` / `ctx.preset`, `renderer.setPixelRatio(...)`, and calling
`onQuality(preset)` on every system — the first and third are clean, the second
is not. `Engine._onResize` re-reads `this.preset.pixelRatioCap` on every resize,
so a HUD that only calls `setPixelRatio` has its change reverted the next time
the window moves. `src/ui/HUD.js#applyQuality` therefore assigns
`engine.quality` and `engine.preset` directly, which is reaching into another
author's object.

A two-line `Engine.setQuality(name)` that updates both fields and re-applies the
pixel ratio would remove that. Not a blocker — the current code works — but it is
the one place the HUD touches something it does not own.

Related, and lower priority: `Lighting`, `PostFX` and `Terrain` do not implement
`onQuality`, so a live switch changes pixel ratio and per-system density but not
shadow map size, SSAO or DOF. The HUD calls the hook defensively on all three
already; it starts working the moment any of them implements it.

### 5. Gamepad button 0 is the handbrake, so menus cannot use it (no action needed)

`Input.update` maps `buttons[0]` (A / cross) to `handbrake` unconditionally, and
`Input.update` runs *after* every system's update, so a UI layer cannot suppress
it for the frame a menu is open. The HUD works around this by using button 2
(X / square) to activate menu items and leaving button 0 alone — worth knowing
before anyone adds a second gamepad-driven panel and wonders why the camper
lurches. If `Input` ever grows a `consume('handbrake')` or a UI-modal flag, the
HUD would switch to the conventional button.

### 6. Two harness notes for whoever owns `tools/`

* `tools/shot.mjs` runs `main()` at module scope, so `import { VIEWS } from
  './shot.mjs'` silently takes a capture slot and writes a stray `hero.png`.
  Anything importing from it needs the views split into their own module (or an
  `import.meta.main` guard). `tools/hudshot.mjs` duplicates the five views it
  needs as a workaround.
* The intermittent all-black frame that `shot.mjs` already retries for also hits
  any other harness. `tools/hudshot.mjs` and `tools/audiotest.mjs` both carry
  their own copy of that check; a shared `ensureFrame(page)` helper would be
  better than three copies.

## RESOLVED — Engine.setQuality() and input suppression

**Requested by:** audio/UI author. **Fixed by:** engine owner.

1. **`Engine.setQuality(name)`** now exists and is the supported way to change
   tier at runtime. It updates `quality`/`preset`, reapplies the pixel-ratio cap,
   forces a resize, and calls every registered handler. `main.js` wires it to
   each system's optional `onQuality(preset, name)` plus `postfx`, `lighting` and
   `terrain`. The settings panel should call `ctx.engine.setQuality(q)` instead
   of assigning `engine.preset` directly.

   **System authors:** implement `onQuality(preset, name)` if your system has
   anything worth changing per tier. Right now `Lighting` (shadow map size),
   `PostFX` (SSAO / DOF / bloom) and `Terrain` (LOD distances) do not, so
   switching tiers still leaves the most expensive settings untouched.

2. **`ctx.input.suppressed`** — set it true while a menu or photo-mode overlay
   owns input, and gameplay axes read zero for that frame. Gamepad button 0 is
   the handbrake and is also the natural confirm button; this is how a UI layer
   takes priority without either side hard-coding the other's bindings.

## Rocks author — 2026-08-19, fourth pass

Nothing is requested of anyone here. This is a correction to the record: the
previous rocks section told the whole team that "the rocks look like they are
floating" was mis-diagnosed. It was not. It was mis-*measured*, three times, by
me and by my predecessors, and the frame was right every time.

### The crags really were floating, and every audit said they were not

`peaks` and `hero` both showed crag blocks standing clear of the mountainside.
Three separate checks said nothing floated:

* `tools/_scratch/rockfloat.mjs` compared each block's lowest vertex with the
  terrain **at the block's own centre**. On a 40-degree face the centre is
  twenty metres of ground drop away from where that vertex is, so the test
  passes for a block whose entire downhill half is in the air.
* Rewriting it as `min over vertices of (vertex.y − ground under that vertex)`
  looked airtight and was not. A crag block is a wedge driven into a hillside:
  its uphill corner ends up sixty to ninety metres *inside* the hill and owns
  the minimum. 100 % of blocks passed.
* Raycasting the live `Terrain` group from the `peaks` camera agreed with both,
  and confirmed the previous author's LOD finding: **the drawn mesh is not the
  problem.** Mean sag below the heightfield 0.2–0.6 m, worst 6.4 m at 800 m,
  across LOD2 and LOD3. Nobody needs to change terrain for this.

The number that matters is the clearance of the **base** — the highest clearance
among the vertices in the bottom quarter of the mesh. Measured that way, 45 % of
the crag blocks in `peaks` and 50 % in `hero` had part of their base standing in
open air, up to 44 m of it. Both audits now report it (`rockfloat.mjs` for a
region, `rockview.mjs` for a named view, with screen coordinates so a block in a
frame can be looked up).

### What it cost, and the general lesson

Two authors changed the anchoring rule against a metric that could not see the
defect, so both changes were tuned blind: one buried every cliff band out of
sight, the next left them hanging. If a measurement and a frame disagree,
the frame is the ground truth and the measurement is the thing to debug.

### Fixed in `src/rocks/` only — no other module touched

Crag blocks are now anchored on their own base rather than on a sampling ring of
arbitrary radius, and laid along the dip of the face instead of dead level (the
previous code's own comment prescribed exactly that and then set the alignment
to 0.10). `peaks` base-over-air 45 % → 2 %, `hero` 50 % → 3 %; the fraction of
each mesh inside the hill 0.48 → 0.60. Placement CPU and instance count are
unchanged (7 643 instances over 961 cells either way, 0.05 ms/cell).

### The `Atmosphere` fog fix landed and rock is in band

The local `vFogWorldPos` workaround in `RockMaterial.js` is deleted, as promised
— `fog_vertex` now applies `instanceMatrix` itself. Re-measured after removing
it: a sunlit boulder at the `drive` anchor sits at **0.80–0.83** of the meadow's
display luminance (reference band 0.78–0.86), so `uRockGain` stays at 1.36.

---

## Performance author — 2026-08-19

Four defects were reported from actually playing: flashing black frames,
freezing, a geometry leak, and being over budget. Everything below is either a
change I made in someone else's file for *performance and lifetime only*, or a
change I deliberately did **not** make because it would move the art.

### 1. Bloom mip chain is capped now — look author, please read (`src/render/PostFX.js`)

**This was the flashing black screen.** Measured two independent ways — an
in-page `readPixels` of the default framebuffer immediately after
`composer.render()`, and a CDP compositor screencast that never touches the page
— **7–9 % of presented frames during a drive came back entirely black**, canvas
only, with the HUD (a separate compositor layer) still drawn on top. Not a
capture artifact: draw calls, triangle count, viewport, scissor, framebuffer
binding and buffer sizes were all correct on those frames, `gl.getError()` was
0, the context was not lost, and re-running the whole composer inside the same
frame produced black again.

Bisecting the chain pinned it on `BloomEffect` alone:

| main pass contains | black frames |
|---|---|
| tone map only | 0.0 % (0/586) |
| tone + vignette + grade | 0.0 % |
| tone + SMAA | 0.0 % |
| tone + DOF | 0.0 % |
| **tone + bloom** | **7.9 % (65/824)** |

and then on the *depth* of the mipmap chain, not on bloom itself:

| `mipmapBlurPass.levels` | smallest mip | black frames |
|---|---|---|
| 8 (default) | 3×2 px | 7.7 % |
| 7 | 6×4 px | 1.4 % |
| 6 | 13×7 px | 0.3 % |
| 5 | 25×14 px | 0.2 % |

Binding a handful-of-pixels render target and then returning to the default
framebuffer intermittently loses the present. That is a driver bug (ANGLE/Metal),
not a bug in this file, but the cure is one line: `_capBloomMips()` now caps the
chain so no mip is under 12 px on its short side (5 levels at 1600×900). With
the cap in place the full chain measures **0/940 (readback) and 0/803
(screencast)**.

**What it costs you.** Only the widest, faintest part of the halo — the part the
deepest mips carry. Measured with `tools/colorstats.mjs`, before → after:

| | hero | backlit |
|---|---|---|
| lumaMean | 0.652 → 0.655 | 0.486 → 0.487 |
| contrastStd | 0.134 → 0.132 | 0.168 → 0.169 |
| chromaMean | 0.258 → 0.249 | 0.345 → 0.342 |
| vividPct | 18.7 → 16.9 | 51.4 → 50.6 |

i.e. a fraction of a percent everywhere, all still inside the reference bands. A
blind A/B (`shots/perf/ab`) reads as a very slightly crisper, very slightly less
veiled frame. **If you want the reach back, `radius` (currently 0.68) is the
knob** — it widens each upsample step and does not reintroduce tiny targets.
Please do not raise `levels` or delete the cap; that is the black screen.

### 2. Warm-up hitches in the first ~12 s (`src/main.js` — not mine to edit)

Every 30 s drive still shows two or three frames of 100–400 ms, and they cluster
in the first ten seconds. They are inside `renderer.render`, with no geometry
built, no texture uploaded and no system `update()` over 3.3 ms that frame —
the CPU profile puts the time in `getProgramInfoLog` under
`WebGLProgram.getUniforms → onFirstUse`, i.e. the driver finishing a pipeline
link on first use. `main.js` already calls `renderer.compile(scene, cam)` at
boot, but at that moment only the terrain exists: trees, rocks, water,
waterfalls, wildlife, weather and the vehicle are all still streaming in, and
none of the shadow-depth variants are covered.

**Request:** move the `renderer.compile()` warm-up to *after* the systems have
had a few frames to populate, and warm the shadow pass too — something like
rendering 3–5 real frames (`postfx.render`) before setting `window.__ready`, and
calling `renderer.compile(scene, lighting.sun.shadow.camera)` as well as with
the main camera. That converts a player-visible freeze in the first seconds of
play into a slightly longer loading bar.

### 3. Grass is the single largest p95 contributor (grass author)

A/B'd *within one page load* (4 s blocks, alternating, so machine contention
hits both arms equally): hiding the grass moves **p50 −1.1 ms and p95 −7.6 ms**
for only 16 draw calls and 0.37 M triangles. That ratio is overdraw, not
geometry — the near ring's blades cover the lower half of the frame many layers
deep. Nothing to fix on the CPU side; `Grass.update()` is textbook (2 ms
resumable budget, no allocation in the steady state, distance-band culling).
If the frame ever needs another 5 ms, the near ring's blade *width* (which is
what buys coverage) is the cheapest place to find it — that is a density/art
call, so it is yours, not mine.

### 4. Trees are the biggest triangle load, in both passes (trees author)

Trees render 0.9 M triangles in the main pass **and** the same geometry again
into the shadow map — measured 43–47 shadow draws and 0.3–0.9 M shadow triangles
depending on the view, which is more than half of everything the shadow pass
draws. Hiding them is p50 −1.5 ms, p95 −5.1 ms.

**Suggestion (yours to judge):** near trees do not need near-LOD geometry to
cast a shadow. If the near slots carried a `customDepthMaterial` bound to the
*mid* prototype — or if the near meshes had `castShadow = false` and a parallel
mid-LOD instanced mesh cast for them — the shadow pass would lose roughly half
its triangles for a silhouette change nobody can see at 4096², 0.07 m/texel.
I did not do it because it changes what the shadow map contains.

### 5. Shadow map size vs. the driving extent (`WorldConfig.QUALITY_PRESETS`)

The shadow pass is the most expensive single feature in the frame: **p50
−3.5 ms, p95 −8.6 ms, 204 draw calls and 1.4 M triangles** with it switched off.
While driving, `Lighting._setShadowExtent()` settles at 150–190 m, and at `ultra`
that is a 4096² map over a 300–380 m square — **0.037–0.046 m per texel**, far
finer than PCF-soft can resolve or than a 1600×900 frame can show. The 4096 is
earned only by the vista views, where the extent opens to 900 m.

Rather than shrink the map for everyone, the natural fix is to *size the map to
the extent*: keep 4096 above ~500 m of extent and drop to 2048 below it. That is
a Lighting change with a visible consequence (softness changes with the switch),
so it is the lighting author's call, not mine. Flagged with the numbers.

### 6. `tools/perf.mjs` was measuring its own instrument (everyone)

Two changes to the tool, both so it reports the game rather than itself:

* **The black-frame analysis now runs in a separate blank page.** It used to
  decode a 1600×900 PNG data URL and run `getImageData` **inside the page under
  test**, on the same main thread as the render loop. That stalled the game for
  300–700 ms every single sample, and the tool then counted its own stalls as
  hitches: a clean run reported 12 frames over 100 ms, of which 8 were exactly
  the eight samples, evenly spaced 5.2–5.8 s apart. Same screenshots, same
  thresholds, same verdict logic — just analysed somewhere harmless.
* **The Vite HMR socket is stubbed for the duration of a run.** With eleven
  authors on one dev server, any save pushes a hot reload that throws away the
  recorder mid-drive; roughly one run in three died with
  `Cannot read properties of undefined (reading 'started')`. A capture is a
  one-shot page load and never wants hot reload. A navigation that gets through
  anyway now aborts with a clear message instead of a confusing crash.

### 7. What I changed in other people's files, and nothing else

* `src/world/Terrain.js` (terrain author) — batching and streaming only, no
  change to vertices, LOD radii, skirts, material or shadow flags. Detail below.
* `src/render/PostFX.js` (look author) — item 1 only.
* `tools/perf.mjs` — item 6.

Terrain: `viewDistance` (2400 m) is larger than the world's own half-diagonal,
so all 32×32 chunks are resident permanently — that was 910 meshes in the scene
graph and ~360 draw calls a frame at about a thousand triangles each. Chunks are
now batched into blocks (2×2 for the LOD-2 band, 4×4 beyond it), and the
wanted-set sweep is gated on 6 m of camera movement instead of running every
frame. Batching only ever *widens* a bounding volume, so it can only add a
caster or a visible surface, never remove one; the LOD-2/LOD-3 shadow-casting
boundary is respected exactly as the per-chunk rule stated it.

---

## From the TREES author — 2026-08-19

Fixing critic defects 8 (foliage silhouette), 11 (tree repetition / scatter) and
17 (birch trunk colour), plus the look author's "conifer canopy is a dark hole"
trace. Everything below is either a request against a file I do not own, or a
measurement another author needs.

### T1. Foliage no longer casts shadows from the mid LOD (no action needed, FYI)

The single largest cost in the whole frame was tree foliage in the **shadow**
pass, not the colour pass. A mid-LOD crown is ~140 alpha-tested double-sided
cards; the billboards turn to face the *light* during the shadow pass, so every
card presents its full disc, and with ~1700 mid instances on screen that is a
quarter of a million discarded-fragment quads rasterised into the shadow map
every frame. Measured in the `river` view, switching only that off took the
frame from **36 fps to 70 fps** — half the frame rate of the entire game — to
shadow trees 90–255 m away whose crowns mostly shadow other crowns.

Mid *trunks* still cast, and everything inside 96 m casts in full. Whole-run
numbers moved from p50 32.7 ms / 610 peak calls / 4.01 M peak tris to
p50 25–33 ms / 532–545 calls / 3.64–3.73 M. The triangle budget breach the
critic recorded (up to 6.37 M against a 4.5 M cap) is closed from the tree side.

If the grass or ground-cover authors have alpha-tested billboards in the caster
set, this is very probably the same win for them.

### T2. Request to the look author: the warm haze floor dominates shaded foliage

The darkest pixel anywhere in the `river` frame is `#483c2e` (srgb 72,60,46) and
it is the same value on every object, at every distance. In linear terms that is
about `(0.064, 0.045, 0.027)`, which matches the atmosphere's haze colour at a
fog factor of roughly 6% — i.e. it is the haze term, not a grade clamp.

That is fine for a distant hill. It is a problem for near shaded foliage: a
conifer's shaded side is legitimately a low-albedo surface, and its own
contribution has to *exceed* that floor before any hue survives. I have taken
the honest half of the fix — the material's shadow and AO multipliers no longer
double-count, and the shaded conifer albedo is a mid olive rather than
`PALETTE.coniferDeep` — and `river` chroma went 0.238 → 0.311 with green back in
the frame. But because the floor is warm and I cannot get under it, our shaded
conifer lands near `srgb(100,90,55)` where reference plate 3's shaded foliage is
`srgb(56,66,32)`: right value, still red-led rather than green-led.

No change requested blind — but if the near-field fog ramp starts later than
~40 m, that alone would let shaded greens read as greens.

### T3. `PALETTE.coniferDeep` (`#1f3527`) is not usable as an albedo

Linear luminance ≈ 0.02. Multiplied by any plausible light term it lands two
stops below the haze floor above, so it renders as a hueless hole regardless of
the lighting model — this is the direct cause of critic defect 8's dark canopy.
The spruce palettes now run `#86ae5e → #4a7040` and similar. They are still the
coolest, most desaturated masses in a hot frame, which is the job the brief
gives conifers, but they are masses and not absences. Flagging in case the
palette table wants updating so the next author does not re-adopt the anchor.

### T4. Harness: `shot.mjs` still writes partially-rendered frames

Roughly one capture in three at `--w 1280 --h 720 --res 768` comes back with a
large black rectangle over part of the frame while `drawCalls`/`triangles` look
healthy. It survived the retry loop in `shot.mjs` (the written-PNG check catches
the narrow-strip case but not a black block in the middle), it hit `river`,
`meadow` and `vehicle` in this session, and it poisons `colorstats` —
`neutralPct` jumps to 10–48% and `lumaP05` to 0. A cheap detector: reject a
frame whose `neutralPct` is above ~8% at golden hour, or scan for a large
axis-aligned pure-black region. `--all` also still aborts partway (3 of 6 runs
here) with `Execution context was destroyed`.

### T5. Not mine, spotted while diagnosing

* The dark specks scattered across the sky in `backlit` and `forest` are weather
  leaf particles, not foliage — confirmed by hiding the tree group; they are
  critic defect 10.
* The bare brown branch shapes lying in the meadow grass in `backlit`/`meadow`
  are also still there with the tree group hidden, so they belong to another
  system's deadfall props, not to my bark geometry.

## Terrain author — 2026-08-19, mountain structure pass

Fixed in `src/world/TerrainMaterial.js` and `src/world/Terrain.js` only. One
request, one warning, and one correction to the record.

### REQUEST — performance author: +0.072 M triangles, and the lever to take it back

Critic ship-blocker 6 ("mountain bodies have no structure") was in part a mesh
resolution problem. `TERRAIN.lodDistances` ships `[180, 380, 720, 1300]`, which
against a 96 m chunk and `lodResolutions [64,32,16,8,4]` is 1.5 / 3 / 6 / 12 / 24
metres per vertex. The erosion bake cuts benches and gullies at 10-40 m, so
everything past 720 m — which is exactly where the hero, peaks and dawn massifs
sit — was drawn on a 12 m grid that cannot represent them at all.

`WorldConfig.js` is not mine, so the schedule now lives in `Terrain.js` as
`LOD_DISTANCES`, set to **`[180, 380, 900, 1500]`**. Only the two far radii
move; the near bands are the expensive ones per chunk and were never the
problem. `Terrain` also accepts `opts.lodDistances`.

Costed before choosing (32x32 chunks, whole map resident):

| schedule | terrain triangles |
|---|---|
| `[180, 380, 720, 1300]` shipped | 0.388 M |
| `[180, 380, 900, 1500]` **this** | 0.460 M |
| `[240, 500, 900, 1500]` | 0.545 M |
| `[280, 600, 1100, 1800]` | 0.780 M |
| `[320, 700, 1300, 2100]` | 0.940 M |

I first landed `[240, 500, 900, 1500]` and then cut it back to this once the
frame showed the near bands were not buying anything, so the delta is
**+0.072 M triangles, 1.6% of the 4.5 M cap**, not the +0.157 M I originally
took.

It also moves the shadow-casting band (`castShadow = lod <= 2`, and blocks at
`tier === 0`) from 720 m to 900 m: ~67 K extra triangles per cascade.

`tools/perf.mjs --seconds 45 --res 1536`, stashed A/B on the same tree, of my
two files together (LOD + the new shader work), at the earlier +0.157 M setting:

```
baseline   p50 29.6 ms  p95 63.6 ms  >50ms 184  >100ms 26  peak 3.54 M tris
+terrain   p50 29.8 ms  p95 66.0 ms  >50ms 196  >100ms 30  peak 3.80 M tris
```

The run fails its budget in **both** states — that is the pre-existing hitching
you are already on, not this change. Caveat on that A/B: stashing `Terrain.js`
also reverted your concurrent `BATCH_LOD`/`BATCH_NEAR` change, so the two rows
are not a clean isolation of mine. A later run on the trimmed setting came back
`p50 33.8  p95 68.9  >50ms 148  >100ms 7  peak 3.59 M`, so the >100 ms hitch
count is down sharply from where it was.

**If you need the triangles back, `LOD_DISTANCES` in `Terrain.js` is the single
lever.** Setting it to `TERRAIN.lodDistances` returns every one of them, and the
heightfield relief normal (below) keeps most of the visual win, because that
part is free.

### WARNING — the terrain fragment shader got more expensive

Per fragment it now does 4 extra `uDataTex` fetches (a second, coarser
heightfield stencil) and, on ground steeper than about 45 degrees only, up to
two extra `fbm` evaluations per octave for triplanar sampling. Flat ground pays
nothing for the triplanar part — the off-axis weights fall under a cutoff and
the branch is coherent across a whole hillside. The close-range substrate block
is behind a single `camDist` gate and is entirely off past 70 m.

Measured p50 delta across the two files together was +0.2 ms, so this is not
where the frame time is going, but it is a real fill-rate increase on the
largest material in the scene and you should know it is there.

### CORRECTION TO THE RECORD — rocks author, your crag blocks are fine

Mid-pass I was convinced from the frames that my newly-grey massifs no longer
matched your crag blocks, and I was about to file it. Sampling the actual pixels
where a block meets the hillside it sits on says otherwise:

```
peaks.png   crag block   #8a6843  chroma 0.277
            terrain 20px above it  #93724e  chroma 0.272
```

They agree. The apparent mismatch was simultaneous contrast against the pale
sunlit peak behind, not a material difference. Your note about the frame being
ground truth cuts both ways — an eyeball comparison of two objects at different
depths in a hazed frame is not a measurement. `tools/_scratch/px.mjs` reports
the mean sRGB of arbitrary rectangles in a PNG if anyone else wants it.

The terrain's rock now runs the same chroma governor your material does, with
`uRockCast` split into a warm `uRockCastLit` and a cool `uRockCastShade` whose
mean is your `(0.965, 0.995, 1.085)`. Nothing is asked of you; this is so the
next person who diffs the two shaders knows the agreement is deliberate.

### NOT REQUESTED, BUT NOTED — two numbers I cannot reach from terrain

* `contrastStd` on `peaks` is 0.105 against the brief's 0.13-0.22 band, and
  `lumaP05` is 0.413 against a reference 0.18-0.42. The frame has no darks. The
  terrain's own crevices now go to `PALETTE.rockShadow`, but the ambient floor
  and the haze put a hard bound on how dark anything can get. That is a
  lighting/atmosphere call, not an albedo one.
* `hero` sits at `chromaMean` 0.272 against a 0.28 floor. It was 0.292 before
  this pass, when the massif was khaki — the trade is a palette-correct
  lavender-grey rock for 0.02 of chroma in the one view that is three fifths
  stone. `drive` moved the other way and is now inside the band (0.436 -> 0.374,
  it was previously above it), and `waterfall` moved from 0.246 into band at
  0.325.

## Trees → look/grade: the blue channel is still crushed on foliage (measurement)

Not a request for a change to anything I own — a measured data point for the
critic's global finding 2, taken after the tree material was rebuilt, in case it
helps whoever picks that up.

Sampling a near conifer crown at golden hour:

| | R | G | B | ratio |
|---|---|---|---|---|
| plate 1, near-left spruce | 134 | 113 | 91 | 1 : 0.84 : 0.68 |
| ours, `river` near spruce | 100 | 86 | 38 | 1 : 0.86 : 0.38 |

R:G matches the plate almost exactly, so the foliage albedo and the key light
are right. B arrives at a little over half what it should. The same shortfall
shows on every surface I sampled, not only foliage, so it is downstream of the
material. Trees are not compensating for it locally — a per-material blue lift
would only make foliage disagree with the terrain it stands on.
