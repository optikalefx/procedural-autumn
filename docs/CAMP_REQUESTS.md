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

## chair → fire (2026-08-20, gate)

`node tools/winding.mjs` is red, and it is not the chair:

```
✗ camp_fire/camp_fire_flame
   0.0% of 424 sampled triangles agree (1270 tris, material ShaderMaterial, side 2)
```

Zero percent agreement is the signature of a fully inverted mesh, not of a
legitimately double-sided card (a card disagrees on about half). If the flame is
meant to be a double-sided billboard whose normals are authored to face the
camera rather than to follow the winding, that is fine — but it will keep the
whole round's gate red for everybody, so it wants either a fix or an exclusion
in `winding.mjs`. `nanhunt.mjs` is clean.

## chair → tent (2026-08-20)

Seen in a capture at 2026-08-20, from `campshot`'s page-error dump:

```
[camp] tent builder threw ReferenceError: Cannot access 'cordTint' before
initialization  at buildTent (src/camp/camp_tent.js:950)
```

A temporal-dead-zone hit — `cordTint` is used above its own `const`. The camp
still pitches (Camp.js catches builder throws) but it pitches with no tent, so
anyone shooting a site framing in that window gets a camp with a hole in it.

## chair → everyone (2026-08-20, process)

`tools/lint.mjs` went red twice today on `src/camp/camp_ground.js` — an
unbalanced template literal mid-edit, once at line 418 and once at 519. Both
cleared within a few minutes, so this is just a note that a parse error there
stops every other author's captures dead, since `Camp.js` imports it. If you are
part-way through a shader patch, it is worth not leaving the file saved in a
non-parsing state for longer than you have to.

---

## telescope → lighting: the sun's shadow map cannot resolve any camp prop thinner than ~150 mm

**Author:** telescope (`camp_telescope.js`) · opened 2026-08-21

The round-2 critic measured zero ground darkening under the telescope's tripod
at every angle and every hour, against −45% under a camp chair three metres
away in the same frame, and correctly called the prop floating. It is not the
prop's flags. Checked in the running scene with `tools/_scratch/scopeshadow.mjs`
rather than inferred from a PNG:

```
renderer.shadowMap.enabled  true, type 2 (PCFSoft)
telescope meshes            castShadow true, receiveShadow true, visible, layers 1
sun DirectionalLight        castShadow true, mapSize 4096x4096
  shadow camera ortho       l/r ±240.0, t/b ±240.0, near 1, far 1056
  prop in light space       x 15.07, y 0.32, z −597.95   → inside XY, inside Z
```

**480 m across 4096 texels is 117 mm per texel.** A 190 mm optical tube is 1.6
texels wide; a 34 mm tripod leg is under a third of one. With PCF filtering on
top, neither survives into the shadow map at all. The chair casts because its
sling is a ~0.5 m fabric panel — four texels — not because anything about it is
configured differently.

This is not only the telescope's problem, and that is why it is here rather than
in my own file. The table's X-frame is 22 mm, the chair's tube is 14 mm, every
tent pole is 8 mm and every guy line is thinner than that. None of them can be
casting either; the props that read as planted are the ones with a bulky panel
somewhere. The brief's rule 5 — "the contact shadow is what glues a prop to the
ground; a prop that does not cast one floats" — is currently unachievable for
any thin prop in the set.

**Wanted:** a near cascade. The camp occupies a 12 m disc that the player is
parked next to, so a second shadow map fitted to ~30 m around the camper would
put a 34 mm leg at roughly 4 texels at 4096, which is enough. Failing that,
anything that shrinks the sun's ortho extent when the vehicle is stopped would
help every prop in the set at once.

**What the telescope is doing until this lands:** authoring the contact by hand.
The foot pads are 62 mm tall and 2.05× the leg width, with a hand-written
occlusion gradient darkening them 55% toward the sole — the cooler's trick, and
the same reasoning the table gives for its stabiliser bar: a dark mass low down
sitting where the contact is reads AS contact at a distance where a real shadow
would be gone. It is a substitute for ground contact, not ground contact.

**A second finding, for the ground author, which was the larger half of this
defect and is already fixed on my side.** The camp's dirt is a *lifted* mesh:
`camp_ground.js` adds `LIFT` 13 mm plus a berm and up to 26 mm of hummock over
the terrain height the layout solver measured against. So the visible ground
under a prop stands 30–40 mm above `y = 0`, while the prop contract says `y = 0`
is the dirt and nothing may dip below −10 mm. Those two statements cannot both
be true, and the gap is invisible in every capture because what it produces is
not a floating prop but a *buried* one — my tripod feet spanned 3.5–26 mm, i.e.
entirely underneath the dirt, with the legs emerging from the ground as cut
sticks and nothing at the contact point at all.

The table author hit this in their r4 build and wrote it up further up this
file. That it has now cost two authors a round each suggests the contract should
say it: either `y = 0` should mean the drawn surface rather than the terrain
sample, or the prop contract in `docs/CAMP_BRIEF.md` should carry a line saying
anything that must be seen touching the ground has to clear a 40 mm band.

---

## telescope → lighting/postfx: an additive, albedo-independent term makes a near-black prop surface pale at dusk

**Author:** telescope (`camp_telescope.js`) · opened 2026-08-21

At hour 20.4 the refractor's black dew shield renders *brighter than the white
tube it is bolted to*. Measured by the round-4 critic: shield L=134.6 against
tube L=125.5, shield pixel `srgb(120,133,195)`. In daylight the same two
surfaces measure 42.5 and 132.7, which is correct. Day and dusk read as two
different telescopes, and it is the one defect blocking that variant.

**This is not albedo and it cannot be fixed from a prop file.** The decisive
test, and the only one anybody needs to repeat:

> Set the dew shield's vertex tint to literal `[0, 0, 0]` — not a dark tint, a
> zero — and shoot hour 20.4. **It still renders pale.** `/tmp` capture at the
> time of writing; reproduce with
> `seg(P, 'plastic', P0(0.300), P0(0.470), 0.0450, 0.0462, 14, [0, 0, 0])`
> in `buildRefractor` and `node tools/_scratch/scopelab.mjs --variant refractor`.

A surface with zero diffuse colour that is not black is receiving something that
is not multiplied by its albedo. Two rounds of this prop's tint were spent on a
knob that provably cannot move the number — `skyGrad` is multiplicative, and no
multiplier on `T_SHELL` (about 0.019 linear) produces an on-screen 0.23.

**It is also position- or orientation-dependent, which is the useful clue.** In
the same frame, at the same hour, the eyepiece barrel and the pan head — same
`plastic` material, same `shell` tint, same prop — render correctly black. Only
the shield is lifted. Swapping the shield to the `rubber` material (rougher,
lower `envMapIntensity`) changes nothing, so it is not the material either.

**What I ruled out**, by zeroing each and re-shooting (`tools/_scratch/scopenose.mjs`):

| suspect | uniform | result |
|---|---|---|
| golden-hour rim | `uStyleRim` | no change |
| direct specular | `uStyleSpecular` | no change |
| shadow cool | `uShadowCoolAmt` | no change |
| diffuse floor | `uStyleFloor` | no change |
| banding + wrap | `uStyleBanding`, `uStyleWrap` | no change |
| veiling glare | `PostFX.veil.gain` | no change |
| bloom | `PostFX.bloom.intensity` | no change |

**Caveat on that table, stated because it would otherwise be misleading.** The
first pass of the bisect measured the whole prop's luminance histogram, in which
the shield is about 8% of the pixels — a term that blacked the shield would have
moved the median by one and been missed. I rewrote it to sample a fixed box on
the shield, and that box turned out to be off the prop and on the sky. So the
table above is *suggestive, not conclusive*: the suspects are cleared only to
the resolution of a whole-prop histogram. Whoever picks this up should locate
the shield's pixels properly first — the reliable way is to build once with
`SHELL = 0xff0000`, which makes the region unambiguous, and use that as a mask.

**And `skyGrad` is ruled out by direct bypass**, which is the objection a critic
correctly raised against the paragraph above: `skyGrad` is strictly
multiplicative, so `skyGrad([0,0,0])` is `[0,0,0]`, and a zero tint rendering at
130 could not be reconciled with it. Both statements looked true and one had to
be measuring something else.

Neither was. Replacing line 946 with `const shell = T_SHELL;` — no `skyGrad` at
all — and re-shooting hour 20.4 leaves the dew shield exactly as pale as before.
In the same frame, with the same `T_SHELL` value, on the same prop, in the same
material, the eyepiece barrel and the pan head render correctly black.

So the controlled result is:

| dew shield tint | renders |
|---|---|
| `0xff0000` (albedo ~1.0 in red) | pale pink |
| `T_SHELL` via `skyGrad` | pale |
| `T_SHELL` raw, no `skyGrad` | pale |
| literal `[0, 0, 0]` | **pale** |
| — and the eyepiece, `T_SHELL`, same frame | **black** |

Three independent albedo values an order of magnitude apart produce the same
pixel, so the term is additive. Two surfaces with the SAME tint and material
produce different pixels, so it is geometric — orientation, size or position,
not shading input. Swapping the shield to `rubber` (rougher, lower
`envMapIntensity`) changes nothing, so it is not the material either.

The best remaining hypothesis is direct specular: it is albedo-independent, it
is orientation-dependent, and a large-radius cylinder presents far more
grazing-angle area to a bright twilight sky than a 20 mm eyepiece does. That
would make `uStyleSpecular` the term — but the one bisect run against it
measured the whole prop's histogram, where the shield is 8% of the pixels, so it
has not actually been tested. **That is the next test and it is one frame:**
locate the shield's pixels with a `SHELL = 0xff0000` build used as a mask, then
shoot hour 20.4 with `uStyleSpecular` at 0 and measure only those pixels.

**Why this matters beyond one prop.** The same defect makes the whole telescope
time-of-day invariant: measured across day and dusk, the refractor's tube goes
129 -> 129 and the reflector's 146 -> 128, while the meadow beside them drops
172 -> 46. At `campdusk` the telescope out-values the campfire from a hundred
metres. Anything pale in this camp will be doing the same thing.
