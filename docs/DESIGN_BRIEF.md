# Procedural Autumn — System Author Brief

Read this in full before touching code. It is the contract that keeps eleven
people's work looking like one game.

---

## 1. What we are making

A cozy exploration driving game: you pilot a small camper through a
procedurally generated autumn valley. No combat, no fail state, no timers.
The pleasure is the drive, the light, and finding things.

The quality target is a first-party Nintendo Switch cozy title — the bar is
"a screenshot of this could be the store page hero image." Not "good for a web
demo." If a frame would embarrass a shipping game, it is not done.

## 2. Art direction (non-negotiable)

Reference plates live in `reference-art/`. **Look at them before you start.**

### The single most important idea
**Warm key light, cool complementary shadow.** Sunlit ground is gold/amber.
Shaded ground drifts violet/periwinkle. That complementary split is what gives
the reference its depth and its "expensive" feel. It is a *tint*, not a hue
replacement — a shadow that has become saturated blue is a bug, not the style.

### Palette anchors (see `src/world/WorldConfig.js` → `PALETTE`)
| Role | Colour | Notes |
|---|---|---|
| Sunlit meadow | `#f0ad46` gold | The dominant colour of the game. Olive is an *accent*. |
| Shadowed ground | violet-tinted gold, never pure blue | |
| Deciduous foliage | `#e8622a` orange, `#f09a2c` amber, `#f3cf45` gold, `#9e2b28` crimson | Use several per tree, in clumps. |
| Conifer | `#4e7346` → `#1f3527` | Deep, desaturated, cool. The visual "rest" in a hot palette. |
| Birch bark | `#e9e6dd` near-white with dark scars | High-value trunks are a signature of the reference. |
| Rock | `#c3bfcc` lavender-grey lit, `#5c5a75` shadow | Never brown-grey. |
| Water | `#9dc4d8` shallow → `#2f5f86` deep, white foam | |
| Sky | cream `#fbe3c8` at horizon → `#6f9fd8` zenith | |

### Rendering style
- **Painterly, not photoreal.** Shapes read as brush marks at distance.
  Foliage is *clumped masses*, not individually modelled leaves.
- **Flat-ish shading on rock and terrain**, with strong form. Faceting is fine
  and often desirable; noise-for-noise's-sake is not.
- **Aerial perspective is the depth cue.** Distant hills desaturate toward the
  horizon colour and lift in value. `src/render/Atmosphere.js` does this
  globally — do not add your own per-material fog.
- **Rim/backlight matters.** Golden hour means translucent leaves, glowing
  grass tips, and bright silhouette edges. Budget for it.
- **Silhouette first.** If a tree is unreadable as a black shape, the shader
  will not save it.

### Anti-patterns that will get your work rejected
- Grey-brown "default Unity" ground.
- Uniform noise as a substitute for structure.
- Every object the same size — no size hierarchy.
- Perfectly even scatter density (Poisson everywhere with no clumping).
- Sharp, un-graded specular hotspots.
- Foliage that reads as flat cardboard from any angle.
- 100% saturated anything.

## 3. Code contract

### Your system
Each system lives in one file and implements `src/core/System.js`:

```js
export class MySystem extends System {
  constructor(ctx) { super(ctx); }
  async init() {}                    // heavy setup; awaited during load
  update(dt, elapsed) {}
  lateUpdate(dt, elapsed) {}         // optional
  dispose() {}
}
```

`ctx` gives you: `THREE, engine, input, scene, camera, renderer, world, poi,
terrain, atmosphere, lighting, sky, postfx, quality, preset, systems`.

**You own exactly the files assigned to you. Do not edit `src/main.js`,
`src/core/*`, or another author's module.** If you need something from a peer,
read it off `ctx.systems.<name>` defensively (it may not exist yet).

If you genuinely need a shared change, write it in
`docs/INTEGRATION_REQUESTS.md` and work around it for now.

### Sampling the world
Never invent your own heightfield. Everything comes from `ctx.world`
(`src/world/WorldData.js`):

```js
world.getHeight(x, z)          // metres, includes micro-detail
world.getNormal(x, z, out)     // THREE.Vector3
world.getSlope(x, z)           // 0 flat … ~2 vertical (|gradient|)
world.getMoisture(x, z)        // 0..1
world.getRiver(x, z)           // 0 none … 1 main channel
world.getWaterHeight(x, z)     // null when dry
world.getWaterDepth(x, z)      // metres above the bed
world.getBiome(x, z)           // BIOME enum
world.getSurfaceWeights(x, z)  // { grass, dry, rock, dirt, snow, sand, litter }
world.waterfalls               // [{ top, bottom, height, discharge, width }]
world.riverPolylines           // [[{x,y,z,w,flow}, …], …]
world.roads                    // [[Vector3, …], …]  gentle dirt tracks
world.dataTexture              // RGBA float: height, waterY, river, moisture
world.auxTexture               // RGBA float: slope, hardness, sediment, log(flow)
```

`ctx.poi` gives curated landmarks: `poi.best('vista'|'meadow'|'forest'|
'river'|'waterfall'|'peak'|'road', i)`.

### Fog / atmosphere
Standard materials get the shared atmosphere for free. A **custom
`ShaderMaterial` must opt in**:

```js
import { fogUniforms } from '../render/Atmosphere.js';
const mat = new THREE.ShaderMaterial({
  uniforms: THREE.UniformsUtils.merge([fogUniforms(), { /* yours */ }]),
  fog: true,
  vertexShader: `#include <fog_pars_vertex>  … void main(){ … #include <fog_vertex> }`,
  fragmentShader: `#include <fog_pars_fragment> … void main(){ … #include <fog_fragment> }`,
});
```
Note the vertex chunk needs `transformed` in scope — set
`vec3 transformed = <your world-space position>;` before `#include <fog_vertex>`.

### Performance budget
Target **60 fps at 1600×900 on an M-series laptop** at `ultra`.
Whole-game budgets: **≤ 900 draw calls**, **≤ 4.5 M triangles**, **≤ 700 MB** GPU.
Per-system share is roughly: terrain 150 calls, trees 120, grass 60,
rocks 60, water 40, wildlife 60, everything else the remainder.

Use `THREE.InstancedMesh` / instanced attributes for anything appearing more
than ~20 times. Respect `ctx.preset` (`grassMul`, `treeMul`, `shadowMapSize`,
`ssao`, `dof`, `volumetric`, `reflections`).

Stream by distance, budget your per-frame build work (see `Terrain.update`'s
`budgetMs` pattern), and never allocate in `update()`.

### Determinism
The world is seeded. Same seed ⇒ same world, always. Use
`mulberry32(seed)` / `hash2i` from `src/core/MathUtils.js`, never `Math.random()`
for anything that places geometry.

## 4. How to verify your work

A dev server runs at `http://localhost:5178`. **Do not start your own** — it is
already up and shared. If it is down, `npm run dev`.

### Capture frames
```bash
node tools/shot.mjs --view meadow --out shots/mine/a.png --w 1600 --h 900
node tools/shot.mjs --all --dir shots/mine        # every canonical view
node tools/shot.mjs --pos 12,40,80 --look 0,20,0 --out shots/mine/b.png
```
Canonical views: `hero drive meadow forest river waterfall peaks vehicle
backlit dawn`. Always evaluate at ≥1600×900 — problems hide at low res.

### Terrain-only iteration (no browser)
```bash
node tools/terrain-lab.mjs --res 768 --stage full --out shots/lab.png
```

### Read the frame you produced
Use the Read tool on the PNG and actually look at it. Compare side by side with
`reference-art/`. Be specific about what is wrong.

### Check you did not break anything
```bash
node tools/probe.mjs "JSON.stringify({fps:window.__fps, err:window.__bootError})"
```
Console errors and a black frame both count as failure.

## 5. Definition of done

Your system is done when **all** of these hold:

1. It renders with no console errors and no visual artifacts (z-fighting,
   popping, seams, shimmer, aliasing crawl, clipping through terrain).
2. It holds the frame budget at `ultra` and degrades sensibly at `low`.
3. It reads correctly at three distances: 2 m, 40 m, 400 m.
4. It reads correctly in three lights: golden hour, backlit, overcast/dawn.
5. Side by side with `reference-art/`, an unbriefed observer would say it
   belongs to the same game.
6. A harsh critic, comparing your output blind against the previous version,
   picks yours — and cannot name a specific thing that looks amateur.

Ship nothing you would not put on a store page.

---

## Appendix: faster iteration

The full 1536² world bake costs ~25 s per browser load. For fast iteration pass
a lower heightmap resolution — the terrain shape is identical, just coarser:

```bash
node tools/shot.mjs --view meadow --res 640 --out shots/x.png     # ~4 s bake
node tools/shot.mjs --all --dir shots/x --res 768                 # mid
node tools/shot.mjs --all --dir shots/final --w 1600 --h 900      # full res
```

Always capture your **final** judgement frames at full resolution — river
density, waterfall count and rock placement all change with the bake res.

`--quality ultra|high|medium|low` forces a preset; `--seed N` bakes a different
world (worth checking your system on 2-3 seeds so it is not tuned to one map).
