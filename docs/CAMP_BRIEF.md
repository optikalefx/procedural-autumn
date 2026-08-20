# Camp — brief and module contract

_Round opened 2026-08-20._

The player parks, holds the park brake, picks a patch of ground near the camper,
and a camp appears there: a fire burning at the centre, one tent, a couple of
chairs facing the flame, a cooler, a table. The ground under it is scuffed to
bare dirt. That is the whole feature.

The feeling to hit is **calm**, not "props placed". A camp reads as calm when
the fire is the only bright thing, everything else leans toward it, and the
spacing looks like people chose it rather than a Poisson disc did.

## Reference art

`reference-art/chairs`, `/cooler`, `/table`, `/tents` are **product photographs
of real gear**, not concept art. Read them as shape and colour references:

| prop | what the plates actually show |
|---|---|
| tents | a 1P orange dome with a vestibule; a grey/blue cabin tent; a cream + red A-frame; a teal/sage/rust 4P dome. All have **guy lines to stakes**, a **visible pole arc under fabric**, and a **darker door aperture**. |
| chairs | a teal butterfly-sling packable (black tube frame, splayed feet); a green mesh-back armchair; a teal/orange/black colour-blocked packable; a red mesh-back armchair. The frame is **thin black tube**, the sling is **fabric that sags**. |
| cooler | a burgundy YETI Tundra-style rotomould: **thick rounded walls**, a lid seam with a **step**, two dark **rubber T-latches**, recessed side handles. |
| table | a folding table: **black anodised slat top with gaps between the slats**, a bright **silver aluminium X-frame**, black plastic joint collars and feet. |

Colour is the thing to get right first. These are saturated manufactured
objects sitting in a desaturated autumn valley, and that contrast is most of
what makes them read as *someone's kit* rather than as terrain decoration.

## Where this lives

```
src/camp/
  Camp.js            the System — state machine, placement, instancing, update
  camp_materials.js  shared material set + geometry helpers every prop uses
  camp_clearing.js   the clearing record: dirt disc + grass/cover suppression
  camp_site.js       site validity + the layout solver (where each prop goes)
  camp_ground.js     the dirt decal mesh
  camp_fire.js       fire pit: stones, logs, flame, embers, smoke, flicker light
  camp_tent.js       buildTent()
  camp_chair.js      buildChair()
  camp_cooler.js     buildCooler()
  camp_table.js      buildTable()
  camp_ui.js         placement reticle + prompt
```

**One author per file.** Nobody edits `Camp.js`, `camp_materials.js`, or any
file that is not theirs. If you need something from a peer module, ask for it in
`docs/CAMP_REQUESTS.md` rather than reaching in.

## The prop contract

Every prop module exports exactly one builder with this shape:

```js
/**
 * @param {(…)=>number} rnd   seeded RNG — call it for every random choice, never Math.random
 * @param {object} opts       per-instance variation (colourway index, wear, …)
 * @returns {THREE.Group}     see the rules below
 */
export function buildChair(rnd, opts = {}) { … }
```

Rules the integrator relies on, all of them load-bearing:

1. **Origin is the ground contact point**, centred on the footprint. `y = 0` is
   the dirt. Nothing may dip below `y = -0.01` except a stake or a foot that is
   deliberately sunk.
2. **`+Z` is the front.** The chair seat faces `+Z`, the tent door faces `+Z`,
   the cooler latches face `+Z`. `Camp.js` yaws each prop so its `+Z` points at
   the fire (or away, for the tent).
3. **Metres, at real gear sizes.** A camp chair seat is 0.38 m off the ground; a
   Tundra 45 is 0.66 × 0.40 × 0.40 m; a 2P dome is about 2.2 × 1.4 × 1.05 m. The
   camper beside it is 4.7 m long. Scale errors are the fastest way to make a
   frame read as amateur and they are invisible in a studio capture — always
   check a framing that has the camper in it.
4. **Set `userData.footprint`** — the radius in metres the layout solver must
   keep clear around the origin.
5. **`castShadow = true` on everything solid**, `receiveShadow = true` on
   anything with an upward face. The contact shadow is what glues a prop to the
   ground; a prop that does not cast one floats.
6. **Every geometry goes through `sanitizeNormals()`** from `camp_materials.js`
   before it is merged or attached. This is not optional — see the black-square
   note in `CamperModel.js`. `node tools/nanhunt.mjs` is the gate.
7. **Merge by material.** A prop should be a handful of draw calls, not fifty.
   `mergeGroup()` in `camp_materials.js` does this for you.
8. **No new textures, no loaders.** Everything is procedural geometry plus
   vertex colours, exactly like the camper.
9. **Triangle winding must match the normals.** `node tools/winding.mjs` is the
   gate; three authors on this project have shipped inverted geometry.

## What "beautiful and calming" is being judged against

The critic protocol is `docs/CRITIC_PROTOCOL.md` and it applies unchanged. The
standard is a shipping first-party Nintendo cozy title. Specific to this round:

- **Silhouette first.** Squint until the prop is black. A camp chair must still
  read as a camp chair. If the sling and the frame merge into one blob, the
  frame is too thick or the sling is not deep enough.
- **Thin things must stay thin.** Chair tube is 12–16 mm; table frame is 22 mm.
  The temptation under a shadow map is to fatten them so they do not alias. Do
  not; fix it with geometry (a hexagonal tube reads better than a cylinder at
  8 px) rather than with mass.
- **Fabric sags.** A tent wall stretched between poles is a catenary, not a
  plane. A chair sling under nobody's weight still bows. Flat fabric is the
  single loudest tell of programmer art in this set.
- **Every prop needs a wear story.** Dust up the lower 100 mm, a scuff on the
  cooler lid, one guy line slightly slack. Factory-new gear in a wild valley
  reads as a shop display.
- **The fire owns the value range.** At dusk and at night nothing else in the
  camp may be brighter than the flame. Check `--hour 20.5` as well as midday.

## Ground rules for the clearing

The clearing is a **dirt disc** the camp sits on: grass and ground cover
suppressed inside it, a scuffed earth decal drawn over the terrain, with a soft
irregular edge. It is not a hard circle — a hard circle reads as a decal, and
`review/` has forty rounds of evidence that hard edges are what a critic sees
first. Suppression is driven by `camp_clearing.js`, which publishes the
clearing to the grass and ground-cover shaders as a uniform so no tile rebuild
is needed.

## Harness

```bash
node tools/campshot.mjs --dir shots/camp/r1              # every framing
node tools/campshot.mjs --dir shots/camp/r1 --only chair # one prop, studio + in-situ
node tools/campshot.mjs --dir shots/camp/r1 --hour 20.5  # firelight
node tools/sheet.mjs --dir shots/camp/r1 --out shots/camp/sheet-r1.png --cols 4 --cell 480
node tools/ab.mjs --a shots/camp/r1 --b shots/camp/r2 --out shots/camp/ab-1 --stitch
```

Gates, all of which must pass before a round is called done:

```bash
node tools/lint.mjs
node tools/winding.mjs
node tools/health.mjs
node tools/nanhunt.mjs
node tools/dprtest.mjs --dpr 2 --w 1170 --h 870 --gate
```
