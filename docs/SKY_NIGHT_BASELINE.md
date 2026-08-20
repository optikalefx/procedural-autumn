# Baseline numbers — the build before this round
_2026-08-20 · frames in `shots/BASELINE/` at 1600×900, captured from a pinned
worktree at `c80190c` so they cannot drift while four authors edit._

Kept in its own file rather than appended to `SKY_NIGHT_BRIEF.md` because four
authors are appending to that file concurrently.

**Correction to the brief:** the brief quotes 9 stars/Mpx. That was measured on a
1280×720 frame; at 1600×900 `dome-h0` gives **28/Mpx**. The target is unchanged —
the plates are 76–174/Mpx — but quote 28, not 9.

## `ladder.mjs --sky --stars`

### `dome-h0` — the night sky, filling the frame
```
              ours              target (night.jpg / night3.jpg)
sky           #232b3a           #483a54 → #473e5d
linear ratio  1 : 1.46 : 2.52   1 : 0.72 : 1.60     ← ours is navy, the plates are violet
luma          0.024 (flat)      0.050 → 0.056
chroma        0.090             0.10 – 0.12
stars         28 /Mpx           76 – 174 /Mpx
mag spread    ×3.3              ×8
```
The gradient is not merely wrong, it is *absent*: every one of the twelve sample
points reads luma 0.024. The dome is a single flat slab of one colour.

### `camp-h0` — eye height in the meadow at midnight
```
near ground   #663221   linear 1 : 0.239 : 0.117   luma 0.052   chroma 0.269
far ground    #50281c   linear 1 : 0.260 : 0.141   luma 0.033
sky           #242b3a   luma 0.024
```
The ground is **orange at midnight, and at twice the sky's luminance.** Diagnosis:
this is not a light leak. `hemiGnd` is `0x3a3c52` (a blue-grey) and `sun` is
`0x3b4a7a` (blue) at `sunI 0.10`, so nothing in the light rig is warm. What is
happening is that the ambient is close to neutral and *weak*, so the autumn
ground albedo survives the multiply unchanged and the frame reads as "orange
grass, dimmed". Real moonlight desaturates a scene toward blue-grey; there is no
term anywhere in this chain that does that. The plates put moonlit ground at
`#0e2f58` — linear 1 : 6.5 : 22, i.e. overwhelmingly cool — at roughly **half**
the sky's luma, not twice it.

### `sunvista-h19` — facing the sun at 19:00
```
zenith        #9e6a95   linear 1 : 0.425 : 0.881   ← blue ABOVE green: magenta-led
stars         435 /Mpx over a sky at mean luma 0.53
```
435 stars per megapixel over a bright salmon sky. `uNight = 1 - dayFactor` in
`Sky.js`, and `dayFactor` reaches 0 the moment the sun touches the horizon.

## `colorstats.mjs` — whole-frame distribution

|  | sunvista-h19 | hero-h19 | sunlow-h7.4 | **sunset.jpg** | **morning.jpg** |
|---|---|---|---|---|---|
| lumaP05 | 0.291 | 0.263 | 0.241 | 0.247 | 0.390 |
| lumaP95 | 0.614 | 0.612 | 0.826 | **0.927** | **0.980** |
| lumaRange | 0.322 | 0.349 | 0.585 | **0.680** | **0.590** |
| contrastStd | 0.097 | 0.113 | 0.178 | 0.221 | 0.195 |
| chromaMean | 0.349 | 0.358 | 0.348 | 0.392 | **0.183** |
| neutralPct | **0** | **0** | 2.9 | 0 | **7.4** |

### Two findings the point samples did not show

**1. There is no highlight.** Our twilight frames top out at `lumaP95` **0.61**.
Both plates reach **0.93–0.98**. The missing value range is mostly at the *top*,
not the bottom — the sky never blows out, because there is no sun in it. This is
the numeric form of "we should feel those beautiful golden glows": the glow is a
blown highlight, and we do not have one anywhere in the frame.

**2. The cool half of the picture is gone.** Hue histogram, share of chromatic
pixels:

| | red | orange | cyan | azure | violet+magenta+rose |
|---|---|---|---|---|---|
| **morning.jpg** | 42.7 | 17.8 | **24.6** | **12.8** | 1.7 |
| ours, sunlow-h7.4 | 78.6 | 14.5 | 0.9 | 0.9 | 4.0 |
| ours, sunvista-h19 | 74.7 | 1.0 | 0 | 0 | **23.8** |

`morning.jpg` is **37% cool pixels** — the water and the shadow side carry cyan
and azure against the warm sky, and that complementary split is what the frame
is *made of*. Ours has 1.8% cool and zero near-neutral pixels at any hour.

At 19:00 the cool third has been replaced by 23.8% magenta/rose/violet — which
is the fourth critic blocker from pass 3 ("the cool half is arriving as candy
pink instead of as blue-violet in the cast shadow") still unfixed, and now
measured at twilight rather than at golden hour.

Note also `chromaMean`: ours 0.35 against `morning.jpg`'s **0.18**, with **zero**
near-neutral pixels against its 7.4%. We are twice as saturated as the plate we
are trying to match. The standing "the game reads as monochrome orange"
complaint is this row.
