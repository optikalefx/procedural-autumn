# Water art-direction spec — measured targets

_Measured 2026-08-20 against `reference-art/` and `shots/w-base/`._

This exists so that a verdict on water can be a number. "The body reads flat" is
not actionable; "the body has two value masses 0.32 stops apart and the plate has
four, 0.7–1.0 stops apart" is. Everything below was measured, not estimated, and
§0 says exactly how so a critic can re-run it on any frame.

The plates, by the short names used throughout:

| | file | what it is for |
|---|---|---|
| **P1** | `Zight 2026-08-18 at 10.28.48 AM.jpg` | A-frame vista. The only plate with a clean sky. |
| **P3** | `Zight 2026-08-18 at 10.29.49 AM.jpg` | **The water plate.** Blue river through gold meadow, golden hour. |
| **P4** | `Zight 2026-08-18 at 10.29.36 AM.jpg` | Valley with an alpine creek. Has sky. |
| **P5** | `Zight 2026-08-18 at 10.30.57 AM.jpg` | **The waterfall plate.** Curtain, plunge, foam torrent, standing pool. |

P3 and P5 — the two plates that actually matter here — contain **no sky**. Every
water number is therefore quoted relative to two things that *are* in frame: the
sunlit gold meadow, and the sky measured in P1/P4 which share the illuminant
family. The meadow is the more useful anchor and is used for the primary
normalisation, because our frames match it almost exactly already (see §1.1).

---

## 0. The measurements, and how to recompute them

Five numbers per sample. All from 8-bit sRGB, no colour management beyond the
sRGB EOTF.

```js
const lin = v => v <= 0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
// r,g,b are 0..1 sRGB (gamma-encoded), i.e. the byte value / 255
const R = lin(r), G = lin(g), B = lin(b);

Y    = 0.2126*R + 0.7152*G + 0.0722*B          // relative luminance, LINEAR
L    = 0.2126*r + 0.7152*g + 0.0722*b          // gamma luma, as tools/colorstats.mjs
C    = max(r,g,b) - min(r,g,b)                 // chroma, sRGB, 0..1
S    = C / max(r,g,b)                          // saturation, value-independent
cool = (B - R) / Y                             // the wCoolGovern metric, LINEAR
```

**`C` is the primary chroma measure**, because it is what `tools/colorstats.mjs`
already reports as `chromaMean` and a critic can get a whole-frame figure with
`node tools/colorstats.mjs <frame> "reference-art/Zight … 10.29.49 AM.jpg"`.
`S` is quoted alongside it because value-dark water always has a small `C`
whatever its hue, and `S` separates the two.

`cool` is the same quantity `wCoolGovern` in `src/shaders/water_common.js`
computes, in the same units, so a target here converts straight into a shader
floor. It is signed: **positive is blue, negative is warm. Any water pixel with
`cool < 0` is mud.**

### Terminology warning — "chroma" means two things in this codebase

The existing shader comments use one word for two measures, and reading them
together produces nonsense unless you know which is which:

- `wCoolGovern` in `water_common.js`: "ours measured `#4a4344` at chroma 0.027".
  `#4a4344` → max−min = 7/255 = 0.027. That is **`C`**.
- `wEnvReflect` in `water_common.js`: "measured mid-channel at `#5c6077`, chroma
  0.107". 119−92 = 27/255 = 0.106. Also **`C`**.
- The `lit` block in `water_river.js`: "a grey-blue at chroma 0.22 against
  reference water measured at 0.48–0.78". No water in any plate reaches `C` 0.48;
  the maximum measured is 0.40. Those are **`S`** values (P3's bend reach has mean
  `S` 0.752, its foreground reach 0.467). Confirmed by the `uSubsurface` note in
  `water_lake.js` — "chroma 0.46 against the palette's own shallow tone at 0.24":
  `waterSubsurface #63a9b8` has `S` = 0.462 and `waterShallow #9dc4d8` has `S` =
  0.273. Both are `S`, neither is `C`.

Likewise "luma" in those comments is the **gamma** luma `L`, not `Y` — the
`sheen` block's "plate 3's river runs srgb(107,119,135) at luma 0.46" checks out
as `L` = 0.461 and `Y` = 0.19. This spec always says which.

### Value masses

For "how many masses" the water region is masked, its `Y` values are collected,
and 1-D k-means is run for k = 2…5 seeded on quantiles. The reported structure is
the k at which the within-cluster RMS stops falling meaningfully. Separations are
quoted in **stops**, `log2(Y_i / Y_{i-1})`.

Masks are a colour rule inside a bounding box: for blue water `B_srgb − R_srgb ≥
0.02`; for aerated water in P5, `B − R ≥ −0.01` and `C ≤ 0.20`. Every mask was
rendered back as a preview and eyeballed before its statistics were used.

> **Do not use a blue-leaning mask to test for the mud failure.** The rule
> excludes warm pixels by construction, so it will always report 0% warm. Test
> mud with hand-placed patches on the water, or with a geometric mask.

### Scale

Metres in §3 come from two anchors in P3: the jeep (Land-Rover-class body width
1.79 m, measured 57.5 px at image row y = 465) and the bear (nose-to-rump ≈ 1.5 m,
measured 146 px at y = 690). Fitting `px_per_m(y) = k·(y − y_horizon)` gives
`y_horizon = 354`, `k = 0.288`, implying an eye height of ≈ 3.5 m — plausible for
this framing, which is the check on the fit. Depth-direction scale is
`dD/dy = f·h/(y−354)²` with `f·h ≈ 4790 px·m` (a 50° vertical FOV on a 1288-px
frame). Shoreline bands are crossed mostly in the depth direction, so the
depth scale is the one used. **Treat every metre figure as ±50%.** The band
widths expressed as a fraction of channel width are the more reliable form.

---

## 1. Measured target values, and ours beside them

### 1.1 The illuminant, so nothing below is quoted in the absolute

| sample | hex | Y | C | cool |
|---|---|---|---|---|
| P1 sky zenith | `#f4e3d7` | 0.790 | 0.114 | −0.29 |
| P1 sky horizon | `#e0c8bc` | 0.607 | 0.141 | −0.40 |
| P4 sky | `#efd0c1` | 0.673 | 0.177 | −0.48 |
| P1 gold meadow | `#f5a75a` | 0.479 | 0.606 | −1.69 |
| P3 gold meadow (open) | `#a86a2f` | 0.188 | 0.475 | −1.93 |
| P4 gold meadow | `#f5ab5f` | 0.493 | 0.586 | −1.62 |
| P5 gold meadow | `#df9b53` | 0.396 | 0.549 | −1.64 |
| — ours — | | | | |
| `hero` sky zenith | `#ddcac5` | 0.616 | 0.096 | −0.27 |
| `hero` sky horizon | `#ecd1c2` | 0.671 | 0.163 | −0.44 |
| `waterfall` sky | `#bcc6dc` | 0.563 | 0.124 | **+0.37** |
| `river` gold meadow | `#946530` | 0.158 | 0.393 | −1.69 |
| `waterfall` gold meadow | `#c18544` | 0.285 | 0.490 | −1.67 |
| `mouth` gold meadow | `#c09d4c` | 0.357 | 0.453 | −1.27 |
| `hero` gold meadow | `#906132` | 0.147 | 0.370 | −1.69 |

**The land is right.** Our meadow lands at `cool` −1.67 to −1.69 against the
plates' −1.62 to −1.93, and its `C` sits inside the plates' range. Nothing below
can be blamed on the grade or the key. The water is the variable.

One exception worth handing to whoever owns Atmosphere: **`waterfall`'s sky is
`cool` +0.37 where every plate sky is between −0.29 and −0.48.** A blue sky is
not a water defect, but it is the source term for `wSkyTilt`, the sheen floor and
the whole environment reflection, so every water dial in that frame is being
driven by an illuminant the plates do not have.

### 1.2 Water, by role

`Δ` is ours minus target; stops are `log2`.

| role | plate target | ours | Δ |
|---|---|---|---|
| **Deep body, lit reach** (mask median) | P3 fg reach `#4c668a` · Y 0.105 · C 0.245 · S 0.467 · cool 1.55 mean | `mouth` open water `#5f7b9f` · Y 0.195 · C 0.253 · S 0.395 · cool 1.20 mean | **+0.89 stops**, C ok, **cool −0.35** |
| **Deep body, shaded reach** (mask median) | P3 bend reach `#193e63` · Y 0.041 · C 0.288 · S 0.752 · cool 2.56 mean | `river` `#313b51` · Y 0.037 · C 0.124 · S 0.390 · cool 1.18 mean | value ok (−0.15 st), **C −0.164**, **cool −1.38** |
| Deep body, darkest single patch | P3 `#183f65` · Y 0.047 · C 0.303 · cool 2.58 | `river` `#2e354c` · Y 0.037 · C 0.118 · cool 1.23 | C is 39% of target |
| Deep body, lit single patch | P3 `#194e7e` · Y 0.071 · C 0.398 · cool 2.82 | `river` best `#344967` · Y 0.065 · C 0.200 · cool 1.55 | C is 50% of target |
| **Shallow shelf / sandbar** | P3 `#536684` · Y 0.130 · C 0.194 · S 0.374 · cool 1.12 | **no identifiable shelf mass in any framing** | absent |
| **Bright waterline lace, peak** | P3 `#e2c7d3` · Y 0.616 · C 0.107 · cool −0.18 | `waterfall` distant bank `#87807b` · Y 0.220 · C 0.045 · cool −0.19 (2.5 px wide) | **−1.49 stops**; absent entirely in `river` and `mouth` |
| Lace, alternate form (blue not cream) | P3 `#73a0c0` · Y 0.327 · C 0.302 · cool 1.09 | — | absent |
| **Damp bank band** | P3 `#4c3d13` · Y 0.050 · C 0.224 · cool −1.34 | `mouth` mud band `#6c5d5c` · Y 0.118 · C 0.060 · cool −0.35 | **C −0.164**; ours is grey where the plate is dark olive |
| **Dry gold meadow at the bank** | P3 `#665123` · Y 0.089 · C 0.265 · cool −1.32 | `river` `#804828` · Y 0.093 · C 0.344 · cool −2.08 | value ok, ours is redder |
| **Falling curtain** | P5 `#b4cadb` · Y 0.571 · C 0.151 · **1:1.12:1.21** · cool 0.44 | `waterfall` `#cbd6e4` · Y 0.663 · C 0.101 · **1:1.06:1.13** · cool 0.28 | **+0.22 stops, C −0.050, cool −0.16** |
| **Plunge whitewater** | P5 `#d6dde3` · Y 0.715 · C 0.054 · **1:1.03:1.06** · cool 0.14 | `waterfall` `#ccd9e7` · Y 0.682 · C 0.105 · **1:1.06:1.13** · cool 0.29 | value ok, **C +0.051 — ours is twice as blue** |
| Foam torrent (broken water in a channel) | P5 `#d1d5da` · Y 0.663 · C 0.035 · 1:1.02:1.04 · cool 0.10 | — | none in frame |
| **Standing pool / distant lake** | P5 pool `#9fadb0` · Y 0.405 · C 0.068 · cool 0.22 | `hero` lakes `#998b97` · Y 0.276 · C 0.054 · **cool −0.03** | **cool sign flip — this is mud** |

### 1.3 The normalisation that matters: water against the meadow in its own frame

Stops relative to the sunlit gold meadow measured in the same image, from the
water mask's `Y` percentiles (p02 / p50 / p98) so the comparison is like-for-like.

| frame | p02 | p50 | p98 | span | where it sits |
|---|---|---|---|---|---|
| **P3** foreground reach | **−1.82** | −0.85 | **+1.20** | **3.02** | **straddles the meadow** |
| **P5** pool → whitewater | −0.13 | +0.88 | +1.06 | 1.19 | at and above |
| `river.png` | −2.57 | −2.08 | −0.02 | 2.55 | **all below** |
| `mouth.png` | −1.96 | −0.87 | −0.62 | 1.34 | **all below** |
| `waterfall.png` distant reach | −1.39 | −0.54 | −0.19 | 1.20 | all below |
| `hero.png` lakes | **+0.52** | **+1.05** | **+1.27** | 0.74 | **all above** |

P3's *lace* reaches `Y` 0.616 = **+1.72 stops** over its meadow; it is past p98
because it covers so little area, which is the point — a small, very bright mass.

Read the last column. P3 puts water on both sides of the meadow — that is what
makes it read as a reflective surface with depth in it. Our frames each pick one
side and stay there, and `hero` picks the wrong one.

### 1.4 `cool`, including its spread

The LOOK author's re-measurement in `wCoolGovern` records point values (plate
1.74 / 1.90 / 2.38, ours 1.15). **Independently confirmed** — but the mean is only
half the story; the *spread* is collapsed too.

| region | mean | p10 | p50 | p90 | p90−p10 |
|---|---|---|---|---|---|
| P3, all water in frame | 1.80 | 0.55 | 1.79 | 2.95 | **2.40** |
| P3, foreground reach | 1.55 | 0.50 | 1.39 | 2.72 | **2.22** |
| P3, bend reach (shaded) | 2.56 | 1.47 | 2.79 | 3.06 | 1.59 |
| P5, all aerated water | 0.19 | 0.06 | 0.16 | 0.32 | 0.26 |
| P5, falling curtain | 0.42 | 0.25 | 0.40 | 0.63 | 0.38 |
| `river.png` | 1.18 | 0.86 | 1.21 | 1.53 | **0.67** |
| `mouth.png` | 1.15 | 0.70 | 1.11 | 1.63 | **0.93** |
| `waterfall.png` distant reach | 0.78 | 0.36 | 0.73 | 1.26 | 0.90 |
| our falling curtain | 0.22 | 0.23 | 0.27 | 0.30 | **0.07** |

The `wCoolGovern` floor as rewritten will fix the mean. It cannot fix the spread,
because it is a floor — it can only push pixels up to a line. The plate's water
runs from `cool` 0.5 in a sunlit sheet to 3.0 in a shaded deep, and that variation
*is* the surface. Our curtain has a `cool` spread of 0.07 across its whole height.

---

## 2. The value structure of water in these plates

Squint at P3. The river does not resolve into one shape. It resolves into
**four**, and this is the single thing our build most obviously lacks.

k-means over relative luminance of the masked water in P3's foreground reach:

| k | RMS | centres (Y) | share | separations (stops) |
|---|---|---|---|---|
| 2 | 0.0526 | 0.096 · 0.295 | 74 / 26 | 1.63 |
| 3 | 0.0340 | 0.084 · 0.212 · 0.377 | 65 / 25 / 11 | 1.33 · 0.83 |
| **4** | **0.0256** | **0.073 · 0.149 · 0.246 · 0.391** | **52 / 23 / 16 / 9** | **1.02 · 0.72 · 0.67** |
| 5 | 0.0211 | 0.070 · 0.127 · 0.200 · 0.278 · 0.400 | 47 / 21 / 15 / 10 / 8 | 0.86 · 0.65 · 0.47 · 0.53 |

k=2→3 cuts the RMS 35%, 3→4 cuts it 25%, 4→5 cuts it 18% and starts splitting the
dominant mass in half rather than finding anything new. **Four masses** is the
honest reading. Total range p02→p98 = **3.02 stops**; p10→p90 = 2.29.

Named, from dark to light:

1. **Deep body** — 52% of the water. `Y` ≈ 0.073, `C` 0.30–0.40, `cool` 2.2–2.8.
   Saturated blue-violet. This is the mass that carries the frame's coolest note.
2. **Mid channel** — 23%. `Y` ≈ 0.149, one stop up. `cool` 1.5–2.0.
3. **Silver sheet** — 16%. `Y` ≈ 0.246, `C` 0.19, `cool` 0.8. Broad soft masses of
   reflected sky lying *along* the flow, not isotropic patches.
4. **Waterline / lace** — 9%. `Y` ≈ 0.391 as a mass, peaking at 0.616 on the
   near bank. `C` 0.07–0.11, `cool` ≈ 0 to −0.18 — a faintly *warm* white.

P5's water, which is mostly aerated, still shows three: `Y` 0.400 / 0.634 / 0.788
at 14 / 32 / 54% with separations 0.66 and 0.31 stops. Even the falling curtain
**alone** is three masses — 0.360 / 0.592 / 0.754 at 21 / 31 / 48%, separated 0.72
and 0.35 stops, spanning 1.15 stops p10→p90. `wSteps` in `water_common.js` exists
for exactly this and the comment there ("near-white, a mid blue-grey and a dark
teal, with *edges* between them") is confirmed by measurement.

### Ours

| frame / region | masses | centres (Y) | share | separation | p10→p90 |
|---|---|---|---|---|---|
| `river.png` water | **effectively 1** | 0.032 · 0.040 · 0.068 · 0.176 | 40/38/19/3 | 0.32 · 0.77 · 1.37 | **1.19 st** |
| `mouth.png` open water | **2** | 0.098 · 0.176 · 0.221 | 5/47/48 | 0.79 · 0.33 | **0.58 st** |
| `waterfall.png` distant reach | **2** | 0.143 · 0.212 | 36/64 | 0.57 | **0.80 st** |
| `hero.png` lakes | **2** | 0.240 · 0.314 | 32/68 | 0.39 | **0.55 st** |
| our falling curtain | **2** | 0.618 · 0.760 | 57/40 | 0.30 | **0.51 st** |

`river.png`'s two largest clusters hold 78% of the water and sit **0.32 stops
apart** — inside a third of a stop, which is below the threshold at which a viewer
reads two masses at all. It is one tint. The 3% at `Y` 0.176 is the thin pale rim
on the far bank, not a mass.

**Target to hit: ≥ 3 masses, each ≥ 0.5 stops from its neighbour, spanning
≥ 1.5 stops p10→p90, with no single mass holding more than ~60% of the water.**
The plates run 1.15–3.02 stops of span; we run 0.51–1.19.

---

## 3. The shoreline

Perpendicular scans across the bank, sampled with a 5×5 box every step. Widths in
px are exact; metres are the ±50% conversion from §0.

### 3.1 P3 — gold meadow meeting **blue** water (near bank, 7.94 px steps, ≈150 px/m)

| # | band | px | ≈ m | colour | Y | C | cool |
|---|---|---|---|---|---|---|---|
| 1 | dry gold meadow | — | — | `#665123` | 0.089 | 0.265 | −1.32 |
| 2 | **damp band** — the grass darkening, hue kept | ~105 | 0.7 | `#4c3d13` → `#413814` | 0.050 → 0.041 | 0.22–0.24 | −1.15 to −1.40 |
| 3 | tide line — one dark near-neutral step | ~8 | 0.05 | `#383640` | 0.039 | 0.039 | +0.33 |
| 4 | shallow rim, dark blue rising fast | ~40 | 0.27 | `#384567` → `#8093b2` | 0.060 → 0.286 | 0.19–0.27 | 1.61 → 0.80 |
| 5 | **lace** — near-white, faintly *warm* | ~48 | 0.32 | `#c2b4c6` → `#e2c7d3` | 0.481 → 0.616 | 0.07–0.11 | −0.05 to −0.18 |
| 6 | inner pale band | ~40 | 0.26 | `#a39aa4` → `#888ea8` | 0.335 → 0.275 | 0.04–0.14 | 0.02 → 0.60 |
| 7 | body ramp | ~72 | 0.5 | `#7080a1` → `#406995` | 0.215 → 0.133 | 0.19 → 0.34 | 0.89 → 1.88 |
| 8 | deep body | — | — | `#315f90` | 0.105 | 0.37 | 2.29 |

**Seven bands, ~1.5 m from dry grass to full-value deep water.** The dry→wet
crossing is band 3 and it is a *dark* note, not a bright one; the bright note is
band 5, on the wet side, and it is 2.6 stops above the meadow behind it.

### 3.2 P3 — the same transition at a sandbar (5 px steps, ≈74 px/m)

Gold `#976025` (Y 0.151) → **damp band 80 px ≈ 1.1 m**, `#6c4f17` → `#534e22`,
Y 0.09 → 0.07, C 0.33 → 0.19, cool −1.60 → −0.95 → **neutral crossover ~10 px
≈ 0.14 m**, `#52594f`, C 0.043 → **lace 30 px ≈ 0.4 m, but PALE BLUE not cream**:
`#73a0c0`, Y 0.327, C 0.302, cool 1.09 → body, Y 0.07–0.13, cool 1.5–2.3.

The lace has two forms in one plate: near-white and faintly warm on one bank,
saturated pale blue on another. What is constant is that it is **~2 stops brighter
than the water immediately inside it** and 0.3–0.4 m wide.

### 3.3 P3 — the far bank (3 px steps, ≈11 px/m)

Sunlit gold `#d57f39` (Y 0.296) → 12 px ≈ 1.1 m of fall-off → **damp band 33 px
≈ 3.1 m**, Y 0.06–0.09, C 0.23–0.27, cool −1.1 to −1.3 → one neutral sample
≈ 0.3 m → water `#253c59`, Y 0.044, cool 1.82.

**No lace at all on this bank.** The bright waterline is a feature of some banks,
not a fringe round every body of water in the frame. The damp band here is ~3 m
against ~1 m on the steeper near bank, which is the physical expectation: the
shallower the bank, the wider the damp band. `uWetBand = 3.1` in `Water.js` is
therefore at the *top* of the plate's range, not the middle.

### 3.4 P5 — gold meadow meeting **white** water

Two scans, both ≈2.5 px steps:

- **At the truck (≈150 px/m):** meadow `#ffbe77` Y 0.595 C 0.53 → a **pale sand
  margin ~30 px ≈ 0.2 m** in which the meadow *brightens and desaturates*
  (`#fecc9d` Y 0.667 C 0.38 → `#efdfd1` Y 0.756 C 0.12) → whitewater Y 0.75–0.81,
  C 0.03–0.10, cool +0.10 to +0.24.
- **Near the fall (≈70 px/m):** meadow `#ffb76b` Y 0.562 C 0.58 → a **warm-grey
  margin ~35 px ≈ 0.5 m** in which chroma collapses 0.58 → 0.02 while value stays
  flat (0.562 → 0.551) → whitewater Y 0.72–0.75.

### 3.5 The rule the two plates state together

**The damp band takes its polarity from what the water is doing next to it.**

- Against **blue** water, the band goes **dark and keeps the meadow's hue** —
  1.0–1.9 stops down, `C` held at 0.19–0.27, `cool` held at −0.95 to −1.40. Then
  a separate bright lace supplies the light note, on the wet side.
- Against **white** water, the band goes **pale and loses its chroma** — value
  flat or up, `C` 0.58 → 0.02. There is no separate lace, because the whitewater
  is the light note.

This corrects the wet-margin comment in `src/shaders/water_lake.js`, which says
"**Pale, not dark.** Wet sand in the world is darker than dry sand; wet sand in
*these plates* is not." That is true of P5 and false of P3. P3's margin has
**both** — a dark olive damp band on the dry side *and* a bright cream ribbon on
the wet side — and the comment collapses two bands into one. The measurement is
in §3.1: band 2 is `Y` 0.050 against a meadow at `Y` 0.089, i.e. 0.8 stops down,
and band 5 is `Y` 0.616, 2.8 stops up.

### 3.6 Ours

**`river.png`, right bank (5 px steps):**

| band | px | colour | Y | C | cool |
|---|---|---|---|---|---|
| gold grass → dark red-brown earth | ~75 | `#b38e3d` → `#804828` | 0.294 → 0.093 | 0.46 → 0.34 | −1.38 → −2.08 |
| desaturating smear | ~15 | `#795c58` → `#4f322c` | 0.125 → 0.041 | 0.13 → 0.14 | −0.75 → −1.29 |
| one dark neutral step | ~5 | `#372b2c` | 0.027 | 0.045 | −0.45 |
| water, immediately at full depth | — | `#302f3d` → `#2e364d` | 0.030 → 0.037 | 0.056 → 0.122 | 0.60 → 1.27 |

**Three bands over 25 px** against the plate's seven over 220. No lace, no
shallow rim, no shelf. The water starts *darker* than the dry ground it meets, so
the shoreline is a step down in value as well as a step in hue — which is why it
reads as a cut hole rather than as an edge.

**`mouth.png`, near bank (2.5 px steps):** bank `#894b2b` Y 0.105 cool −2.14 →
**8 px pale desaturated band** `#786c74` Y 0.159 C 0.048 → **20 px mud band**
`#74514a` → `#524348`, Y 0.101 → 0.062, C 0.163 → 0.059 → neutral `#4a424d` →
water Y 0.053 → 0.132, C 0.08–0.125, cool 0.70–0.86.

The elements exist and are in the **wrong order and the wrong polarity**: the
pale band is *inland* of the mud band, where the plates put it on the water side;
and the mud band loses its chroma (0.163 → 0.059) where the plate's damp band
holds it (0.22–0.27).

**`waterfall.png`, distant bank:** one 2.5 px pale grey sample `#87807b` Y 0.220
C 0.045, then water. A hairline, not a band — this is the closest thing to a lace
in the whole capture set, and it is 2.5 px wide.

---

## 4. Named failure modes, and the measurement that detects each

Several of these are already recorded in the shader comments; where they are,
the source is named and the number here is the independent confirmation or the
correction.

### F1 — Khaki / muddy water

**Detector:** any water pixel with `cool < 0`, or a water mask whose `p10` of
`cool` is below +0.3 while `C` > 0.10. Plate water: **0.0%** of P3's pixels and
1.9% of P5's are `cool < 0` (P5's are edge pixels against warm rock).

**Recorded in** `wEnvReflect`, `water_common.js`: *"hazing a gold hillside toward
cream leaves khaki, and khaki water is mud."* And in the shallows note in
`water_lake.js`: *"At 0.62 the gold bank read straight through the shelf and
every lake margin in the game came out khaki."*

**Live now:** `hero.png`'s distant lakes measure `#998b97`, `cool` **−0.03**.
That is over the line by sign, not by margin — it is grey with a red bias. Same
class as the `#8f7355` / `#8f6d47` peaks measurements the comments already record.

> Methodology trap: a blue-leaning mask cannot detect this, because the rule
> excludes exactly the pixels you are testing for. Use hand-placed patches.

### F2 — Cyan swimming-pool water

**Detector:** a shelf or shallow mass with `S > 0.42` **and** `cool > 2.5` **and**
`Y` at or above the frame's gold meadow. The plate's shelf is `#536684`, `S`
0.374, `cool` 1.12, and sits **0.53 stops below** the meadow.

**Recorded in** the `uSubsurface` note in `water_lake.js`: *"measured at chroma
0.46 against the palette's own shallow tone at 0.24"* — those are `S` values, and
`waterSubsurface #63a9b8` is `S` 0.462 exactly. Also the shallow-anchor note:
taking `waterShallow #9dc4d8` literally *"drew every sandbar in the map as a flat
pastel cyan island."*

**Not live in this capture set** — no framing currently shows a shelf at all,
which is F6 rather than F2. The guard stays because it is the failure that
re-appears the moment a shelf mass is added.

### F3 — Silver-sheet water

**Detector:** water `C < 0.09` while its `Y` is **above** the frame's gold meadow.
No plate water does this: P3's brightest water mass has `C` 0.07 but sits at `Y`
0.391 against a meadow at 0.188 — it is the *lace*, a band 0.3 m wide, not the
body. The test is therefore on **area**: more than ~15% of the water mask being
simultaneously `C < 0.09` and above the meadow is a silver sheet.

**Recorded in** `wSkyTilt`, `water_common.js`: *"Sampling the mirror direction
literally returns the cream horizon band and turns every lake into a sheet of
silver."*

**Live now:** `hero.png`'s lakes are `C` 0.054–0.075 at `Y` 0.276–0.304 against a
meadow at 0.147 — **+1.05 stops above the land, at a third of the plate's chroma,
across 100% of the water**. This is F1 and F3 at once, and it is the whole reason
distant water in `hero` reads as bare rock.

### F4 — Water that goes cream under a warm key

**Detector:** foam ratio `B/R < 1.00`, or foam `cool < 0`. Plate foam runs
`1:1.02:1.04` (torrent) to `1:1.12:1.21` (falling curtain), `cool` +0.10 to +0.44,
and **0.0%** of the curtain is `cool < 0`.

**Recorded in** `wFoamLight`, `water_common.js`, at length.

**Not live — the correction has overshot in one place and undershot in another.**
Measured:

| | plate | ours | |
|---|---|---|---|
| falling curtain | `1:1.12:1.21`, C 0.151, Y 0.571 | `1:1.06:1.13`, C 0.101, Y 0.663 | ours **less** blue, **brighter** |
| plunge whitewater | `1:1.03:1.06`, C 0.054, Y 0.715 | `1:1.06:1.13`, C 0.105, Y 0.682 | ours **twice** as blue |

The plate separates the curtain from the plunge by 0.15 in `B/R`, 0.10 in `C` and
0.30 in `cool`, and puts the curtain **0.32 stops darker** than the plunge. We
separate them by **0.00 on every axis** — our curtain and our plunge are the same
colour, 0.04 stops apart. A single `uFoamGain` and a single `wFoamLight` tilt
cannot express two surfaces, and the plates want two.

**One correction to the source comment.** `wFoamLight` says the plunge in plate 5
is *"1:0.99:1.00, effectively neutral"*, and halved the residual cool tilt on that
basis. Re-measured: the plunge basin is `#cbced2`, **`1:1.01:1.03`** over the
masked basin and `1:1.03:1.06` at the bright core; the whole aerated mass in P5 is
`1:1.04:1.07`. Faintly cool, not neutral. The halving was directionally right —
our old `1:1.14:1.31` was far too blue — but it landed on a target 0.03–0.07 too
neutral in `B/R`, and it took the *curtain* down with it, which needed to stay at
1.21.

### F5 — A shoreline that reads as a cut-out

**Detector:** run a perpendicular scan across the bank and count bands with a
distinct `Y`, `C` or `cool` signature. Plate: **5–7 bands over 130–220 px**
(§3.1–3.4). Also check total transition width: the plates take 1–3 m to get from
dry meadow to full-value water.

**Recorded in** the wet-margin block of `water_lake.js`: *"in the plates a bank is
gold grass, then a band of dark damp substrate, then the waterline, then water.
We drew the first, third and fourth and skipped the second, which is why a
shoreline here has always read as a cut-out — a perfectly antialiased line is
still a line."* That diagnosis is confirmed. Its remedy is not: see §3.5, the band
is dark **and** the lace is bright, and a *pale* band drawn over dry ground is the
P5 recipe applied to a P3 situation.

**Live now:** `river.png` — **3 bands over 25 px**, no lace, no shallow rim, and
water darker than the ground it meets. `mouth.png` — 4 bands but in the wrong
order, and the mud band desaturates where the plate's holds its hue.

### F6 — A foam line that reads as pack ice

**Detector:** a near-white band (`Y > 0.45`, `C < 0.12`) that is **continuous**
along more than ~60% of a shoreline's length, or whose width exceeds ~0.5 m /
~8% of the channel width. The plate's lace is 0.3–0.4 m, is broken along its
length, and is **absent entirely** from the far bank in the same frame (§3.3).

**Recorded in** the lace block of `water_lake.js`, twice and in tension with
itself: first *"a continuous three-metre white fringe around every lake in the map
reads as pack ice rather than water lapping at a bank"*, then *"That was the right
worry and the wrong number: plate 3 draws the margin of its river as a bright
cream ribbon several metres wide along most of its length."*

**Both are right about different axes, and the measurement settles it.** The
lace's *brightness* was under-rationed at 0.26 — the plate peaks at `Y` 0.616,
which is brighter than P1's horizon sky. Its *width* and *continuity* were not:
0.3–0.4 m, not "several metres", and it is on some banks and not others. Ration
coverage and width, not value.

**Not live** — the opposite is: there is no lace anywhere in `river.png` or
`mouth.png`, and 2.5 px of one in `waterfall.png`.

### F7 — Water as a dark hole

Not on the original list; it is what `river.png` actually does.

**Detector:** the water mask's median `Y` more than 1.5 stops below the frame's
gold meadow **while** its `C` is under 0.15. The plate's shaded reach is 2.75
stops below the sunlit gold on its own bank — dark water is allowed — but it holds
`C` 0.288 and `S` 0.752 while it does it.

**Live now:** `river.png` at a median −2.08 stops with `C` 0.124 and `S` 0.390. The value
is defensible; the chroma is not. Half of `C`, half of `S`, and half of `cool`
against the plate's shaded reach. Also recorded in the `uDeep` note in `Water.js`:
*"Taken literally it makes every basin in the map a dark hole, which fails the
brief's lifted-blacks target."*

### F8 — One-tint water

The dominant failure across all four captures, and the subject of §2.

**Detector:** k-means over the water mask's `Y`. Fails if fewer than 3 masses
separate by ≥0.5 stops, or if p10→p90 span is under 1.5 stops, or if one mass
holds more than 60% of the water.

**Live now:** all four framings. `river.png` 78% of its water inside 0.32 stops;
`mouth.png` p10→p90 = 0.58 stops; our falling curtain p10→p90 = 0.51 stops against
the plate curtain's 1.15.

---

## 5. Checklist, ordered by how much each hurts the frame

Run against a `--w 1600 --h 900` capture. Each item names its measurement.

1. **Value masses.** k-means on the water mask's `Y`. **≥3 masses, ≥0.5 stops
   apart, ≥1.5 stops p10→p90, no mass over 60%.** Target P3: 4 masses, 0.67–1.02
   stops apart, 2.29 stops. *This is the largest single gap and it is present in
   every framing.*
2. **Water straddles the land in value.** Darkest mass ≥1.0 stop below the
   frame's gold meadow **and** brightest mass ≥0.5 stop above it. Target P3:
   p02 −1.82, p98 +1.20, lace peak +1.72. Fails now in all four: `hero` is entirely above, the other
   three entirely (or 98%) below.
3. **`cool` in the body.** Mean ≥1.5 with p90 ≥2.5 in a blue-water framing; and
   the **spread** p90−p10 ≥1.5. Target P3: mean 1.55–2.56, spread 1.59–2.40.
   Ours: mean 1.15–1.18, spread 0.67–0.93.
4. **No water pixel warmer than neutral.** `cool < 0` anywhere in the water is
   F1. Check with hand-placed patches, not a blue-leaning mask. `hero` fails at
   −0.03.
5. **No silver sheet.** Under 15% of the water mask may be simultaneously
   `C < 0.09` and above the meadow's `Y`. `hero` is at 100%.
6. **Shoreline band count.** Perpendicular scan; ≥4 distinct bands, total
   transition ≥1 m / ≥60 px at mid-ground. `river.png` has 3 bands over 25 px.
7. **Damp band polarity.** Against blue water: `Y` 0.8–1.9 stops below the
   meadow with `C` ≥ 0.18 and `cool` ≤ −0.9 — it must keep the meadow's *hue*.
   Against white water: `Y` flat or up, `C` collapsing below 0.10. `mouth.png`
   fails the first (C 0.060, cool −0.35).
8. **Lace present, bright, narrow, broken.** Peak `Y` ≥ 0.40 (target 0.616,
   ≥2.5 stops over the meadow behind it), `C` 0.07–0.30, width ≤0.5 m or ≤8% of
   channel width, and **not** continuous — absent on at least some banks. Absent
   in 3 of 4 framings now.
9. **Foam separates curtain from plunge.** Curtain `1:1.12:1.21` at `C` 0.15 and
   **0.3 stops darker** than the plunge; plunge `1:1.02:1.06` at `C` 0.05. Ours
   are identical to each other at `1:1.06:1.13`.
10. **A shallow shelf mass exists at all**, at `C` ≈ 0.19, `S` ≤ 0.40, `cool`
    ≈ 1.1, and 0.5 stops *below* the meadow — not above it, and not cyan
    (F2 guard: `S` > 0.42 with `cool` > 2.5).
11. **Distant water is still water.** At 300 m+ the failure is F1/F3, and the
    measurement is the same as items 3–5. Note that `waterfall.png`'s sky is
    `cool` +0.37 where every plate sky is −0.29 to −0.48; that is an Atmosphere
    finding, but it is the source term for the sheen and the reflection in that
    frame and no water dial can be judged there without it.

---

## Appendix — what contradicts a source comment

| source | claim | measured | verdict |
|---|---|---|---|
| `wFoamLight`, `water_common.js` | plate 5's curtain is `1:1.12:1.21` | `1:1.12:1.21` | **exact** |
| `wFoamLight` | plate 5's plunge is `1:0.99:1.00`, "effectively neutral" | `1:1.01:1.03` masked basin; `1:1.03:1.06` bright core; `1:1.04:1.07` over all P5 whitewater | **0.03–0.07 too neutral**; faintly cool, and the correction pulled the curtain down with it |
| `wSteps` note, `water_common.js` | plate 5's curtain "spans luma 0.41 to 0.91" | over the curtain box: `L` p02→p98 ≈ 0.55 → 0.92, p10→p90 ≈ 0.63 → 0.90 (`Y` 0.358 → 0.795) | **confirmed at the top end**; the 0.41 low end is below my p02, so their sample reached a darker streak than the box used here — the range is at least as wide as they say |
| `sheen` block, `water_lake.js` | plate 3's river is srgb(107,119,135), luma 0.46, `1:1.11:1.27` | that patch is real; the reach's median is `#4c668a`, `L` 0.393 | **confirmed as a sample**, but it is the *silver sheet* mass, not the body — the body median is 0.6 stops darker |
| `sheen` block | plate 3 runs srgb(52,62,96) → srgb(205,216,232), "better than two stops" | p02 `Y` 0.053 → p98 `Y` 0.432, **3.02 stops** | **confirmed and understated** |
| `wCoolGovern`, `water_common.js` | plate `cool` 1.74 / 1.90 / 2.38; ours 1.15 | P3 mask mean 1.55–2.56, p90 2.72–3.06; `river.png` mean 1.18 | **confirmed**; adds that the *spread* is collapsed too (0.67 vs 2.22) |
| wet-margin block, `water_lake.js` | "Pale, not dark … wet sand in *these plates* is not [darker]" | true of P5 (C 0.58→0.02, value flat); **false of P3** (band 2 is 0.8 stops *down* at C 0.22) | **half right** — the polarity depends on whether the water beside it is blue or white |
| lace block, `water_lake.js` | "a bright cream ribbon several metres wide along most of its length" | 0.3–0.4 m, broken, and **absent** on P3's far bank | **wrong on width and coverage, right on brightness** (`Y` 0.616) |
| `uWetBand = 3.1`, `Water.js` | metres of damp margin | plates: 0.7–1.1 m on steep banks, ~3.1 m on the shallowest | **at the top of the range**, not the middle |
| `uSubsurface` note, `water_lake.js` | "chroma 0.46 against the palette's own shallow tone at 0.24" | `S` 0.462 and 0.273 | **confirmed** — but the units are `S`, not `C` |
