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
