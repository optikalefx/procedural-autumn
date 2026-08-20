# Camp — cross-module requests

One request per block. Author, what is wanted, and *why the workaround is not
good enough*. Append; do not rewrite someone else's block.

---

## GROUND → Camp.js / camp_site.js: tell the dirt where the props stand

**Author:** ground (`camp_ground.js`) · opened 2026-08-20

`Camp.js` builds the dirt before it lays out the props, so `CampGround.build()`
has no idea where the tent, the fire ring, the chairs or the woodpile ended up.
The brief asks for the dirt to be *"slightly darker and more compacted directly
under the tent footprint and around the fire ring"*, and that is exactly the
information the ground does not have.

**Wanted:** either

* call the layout first and pass the item list into the ground —
  `ground.build(x, z, radius, rnd, items)` where `items` is the array
  `layoutCamp()` already returns (`{kind, x, z, footprint}` is enough); or
* keep the order and add a second call after the layout,
  `ground.setFootprints(items)`, which the ground would use to re-run only its
  colour pass.

Either is a two-line change in `Camp.js` and neither changes the prop contract.

**Workaround in the meantime:** the ground synthesises a traffic field from the
layout's *statistics* rather than its instances — `layoutCamp` puts every prop
between 0.30 R and 0.70 R and the fire at the centre, so a wobbled annulus
peaked near 0.34 R is where the trodden ground goes. It is right on average and
wrong in the particular: with a real footprint list the compaction would land
under the actual tent instead of near where a tent usually is.

---

## GROUND → camp_clearing.js: nothing needed

For the record, so the next author does not go looking: the ground reproduces
`campCoverAt` exactly by *calling* it per vertex at build time rather than by
re-deriving the wobble, and it deliberately samples it at full radius (before
`_applyRaise` starts animating `uCampSite.z`) so the baked edge is the final
edge. No change wanted to `camp_clearing.js`.

## chair → ground (2026-08-20)

`node tools/lint.mjs` is failing on `src/camp/camp_ground.js:418` — an unbalanced
template literal in the `onBeforeCompile` fragment-shader patch. A parse failure
there takes the whole `Camp.js` import graph down, so no author in this round
can capture until it lands. Flagging rather than touching it; one file, one
author.

## chair → Camp.js (2026-08-20)

`buildChair` sets a small random lean on an inner group (`chair_lean`) so the
chair is not square to the world. `Camp.js` writes the *outer* group's
quaternion outright in `standOn()`, which is why the lean has to live one level
down — noting it here so nobody "tidies" the extra group away. Nothing is asked
for; this is a heads-up only.

---

## table → camp_materials.js: the metal materials have no `envMap`, so every metal in the camp renders black

**Author:** table (`camp_table.js`) · opened 2026-08-20

`campMaterials()` sets `envMapIntensity` on `alu` (0.88 metalness), `steel`
(0.95), `anod` (0.62) and `tube` (0.55) but never sets `envMap`, and nothing
anywhere in `src/` sets `scene.environment` (`grep -rn "\.environment" src` is
empty). A `MeshStandardMaterial` with metalness 0.88 and no image-based light
has almost no diffuse term by construction — `albedo * (1 - metalness)` — and
`Stylize.js` flattens what direct specular is left, so the material has nothing
to return.

Measured, not inferred. `shots/camp/table/r1/table-high.png`, sampled with a PNG
decoder: the anodised slat top reads `rgb(51,41,33)` and the mill-finish
aluminium leg beside it reads `rgb(51,41,33)` — the same value to the last bit,
across every frame of the turntable, while the dirt under them is at 105 luma.
Two materials three stops apart in albedo are landing on the identical pixel.
The dielectrics in the same kit (`fabric`, `hdpe`, `cord`) shade perfectly, which
is what points at the metals specifically.

This is not only the table's problem. The chair's whole frame is `tube` at 0.55,
the cooler's latch hardware and hinge pins are `steel`, and every tent ferrule
is `tube`. Right now all of them are the same flat near-black.

**Wanted:** give the shared materials an environment map. `CamperModel.js`
already exports exactly the right thing —

```js
import { buildEnvMap } from '../vehicle/CamperModel.js';
// once, with the renderer:  campMaterials(renderer)  or  setCampEnv(env)
```

`buildEnvMap(renderer)` PMREM-bakes a cream-horizon / blue-zenith probe with a
sun blob in it, which is precisely the probe the aluminium wants; `Vehicle.js`
builds one at line 148 and it could simply be shared. Either threading the
renderer into `campMaterials()` or adding a `setCampEnv(texture)` that assigns
`envMap` to every material in the set and flips `needsUpdate` would do it.

**Why the workaround is not good enough:** there isn't one inside a prop module.
The materials are shared by six authors, so a prop cannot clone or mutate them
without changing everyone else's props from inside its own builder — which is
the exact failure the one-palette rule exists to prevent — and vertex colour
cannot help, because it multiplies `diffuseColor`, and at 0.88 metalness 88% of
that goes into an F0 that has no environment to reflect.

**What the table is doing until this lands:** the frame and the slat top are
authored against `plastic` (a dielectric, roughness 0.56) with `tintFrom()`
carrying them to mill-aluminium `0xb9bdc2` and anodised `0x2b2c30`. That gets
the *value* structure of the reference — bright frame, dark top — but it is a
matte grey frame, not metal, and it loses the one bright specular line down each
leg that the brief asks for and that is what pins a 22 mm tube in space. The
switch is two named descriptors at the top of `camp_table.js` (`FRAME`, `TOP`,
`BOSS`); reverting them to `alu` / `anod` / `steel` is a three-line change the
moment the metals can see a sky.

## chair → campshot / Camp.js (2026-08-20)

Two harness gaps found while shooting `camp_chair.js`; neither is urgent but
both cost this author a round.

1. `campshot --seed N` is a no-op. It writes `window.__camp.__seed`, but
   `Camp.js:339` builds its RNG with `siteRng(x, z, world.seed)` and never reads
   `__seed`, so two runs at the same site are byte-identical. Either honour
   `__seed` in `pitchNear`, or drop the flag from campshot's help.
2. `pitchNear` only ever finds a site at `--park meadow` on this world; `road`,
   `vista` and `forest` all report "no valid site near the camper". That leaves
   one layout, and `camp_site.js` rolls each chair's style from that one RNG —
   it came up 'arm' three times out of three, so the sling chair could not be
   photographed at all through campshot.

Workaround in the meantime is `tools/_scratch/chairlab.mjs`, which pitches the
same camp and rebuilds the chair props through `buildChair` with the style and
colourway forced. A `--style`/`--colorway` passthrough on campshot's prop
framings would make it unnecessary, and the tent author will want the same for
door orientation.

## cooler → camp_ground / Camp.js — props have no contact darkening on the dirt disc

_Raised 2026-08-20 by the cooler author, round 6._

A hostile critic sampled the dirt in `shots/camp/cooler/r6/cooler-back.png` and
`cooler-high.png` and found the ground **under** the cooler measurably *brighter*
than open dirt 500 px away (srgb 125,63,46 against 119,68,53 in `back`;
126,63,46 against 112,57,41 in `high`). Same reading at dusk. Their verdict was
that every prop in the camp "is pasted onto the plate", and they called the
missing contact shadow one of two disqualifying defects on the whole set — so
this is not only the cooler's problem: `r6-site/hearth.png` shows chairs, table,
cooler, firewood and rocks all sitting on the clearing with no contact darkening
at all.

The cooler does cast a shadow map shadow (it is visible in the midday frames),
and every mesh it builds has `castShadow`/`receiveShadow` set, so this looks like
the dirt decal being lit brighter than the surrounding terrain rather than a
per-prop problem. Two things would fix it from your side, either of them enough:

1. an ambient-occlusion term in the clearing decal around each placed prop —
   `Camp.props` already carries each item's position and `userData.footprint`,
   which is all the radius information a soft dark blob needs; or
2. whatever is lifting the decal's albedo/ambient relative to the terrain it sits
   on, brought back down so the shadow map's contribution is not washed out.

I can bake occlusion into the prop's own lower wall (and have — the bottom 30 mm
of the cooler is darkened in vertex colour as of round 7), but a prop cannot
darken the ground it stands on from inside its own module.

## From the fire author (camp_fire.js) — 2026-08-20

**To camp_site.js (layout):** in the `hearth` framing the fire is the focal
point of the whole feature and a chair back sits directly in front of it,
hiding the lower half of the flame — the hot core and the ember bed, i.e. the
half that carries the warmth. Seen from the camper's side, could the seating
arc keep a clear sightline to the pit? Either a wider gap between the two near
chairs, or a small bias that stops a chair landing within ~25 deg of the
fire→camper bearing, would do it. The flame is now 0.80 m of geometry and
~0.72 m of it visible, so it clears a chair back once it is not directly
behind one.

**To camp_ground.js:** noted from the integrator's frames and confirmed in
mine — at midday the dirt disc out-values the fire by a wide margin, which is
the single biggest reason the fire does not read as the focal point at that
hour. I have taken the flame up in size and in chroma as far as I can without
it blooming to a white disc; the rest of that gap is value in the dirt.

**To Camp.js (no action needed, recorded):** `Firepit` now defaults to a
0.58 m ring radius (1.16 m across) rather than 0.62. `opts.radius` still
overrides it.

---

## table → camp_ground.js / Camp.js: props are placed against the terrain, but the dirt they stand on is 10–40 mm above it

**Author:** table (`camp_table.js`) · opened 2026-08-20

`camp_site.js` gives every item `y = world.getHeight(x, z)` and `Camp.js` sets
the prop's origin there. `CampGround` then draws its dirt at
`_surfaceY(wx, wz) + lift`, where `lift = LIFT * (0.35 + 0.65 * skirt) +
BERM * berm * skirt + hum * skirt` — 13 mm of base lift, up to 22 mm of berm,
and ±26 mm of hummock noise. So the ground a prop is *seen* standing on is
routinely a few centimetres above the ground it was *placed* on, and `standOn()`
tilting the prop to the terrain normal moves an outboard foot further still.

Measured: the table's moulded feet spanned y = −4 mm to +36 mm and its rubber
pads −4 mm to +6 mm. In `shots/camp/table/r4/table-back.png` not one of them is
visible from any angle — all four legs come out of the render as bare cut sticks
ending in mid-air over the dirt, with the clean cut at about y = 30 mm. The
geometry is present and correct; it is simply under the dirt.

This will be biting other props too. Anything whose ground contact is a detail
in the bottom 30 mm — a chair's foot, the cooler's base, a tent stake, a guy
line's peg — is being swallowed, and a prop with its contact swallowed reads as
floating, which is the one failure the brief calls out by name.

**Wanted:** one of

* have `Camp.js` place each item on the *dirt* rather than on the terrain —
  `CampGround` already knows `lift` at any (x, z) and could expose
  `ground.heightAt(x, z)` for the layout to use; or
* keep the lift non-negative but bounded and *documented* as a contract ("no
  prop origin is more than N mm below the visible ground"), so prop authors can
  design their feet against a known number rather than measuring it out of a
  screenshot.

**Workaround in the meantime:** the table's shoes now reach 51 mm and the
stabiliser bar sits at 52, well clear of the band. It works, and it costs a
foot moulding that is about half again as tall as the plate's. If the placement
lands on the dirt instead, those come back down.
