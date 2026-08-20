# Sky, night and sunlight — the brief and the contract
_opened 2026-08-20 · reference plates: `reference-art/morning-night-dawn-dusk/`_

## What is actually wrong, measured

Captured with the new `tools/tod.mjs` (one bake, many hours) and sampled with
`tools/ladder.mjs` (point samples at fixed normalised positions, reported as
linear R:G:B ratios — the same form the keyframe comments use).

### 1. The sun is not in the frame, ever

Every canonical framing in `shot.mjs` — `hero`, `drive`, `meadow`, `peaks`,
`river` — looks **away** from the sun. `backlit` faces it but is a 2.4 m meadow
shot with a tree line across the key. So in 44 archived review rounds **no
reviewed frame has ever contained the sun disc or its aureole**, and the brief
asks for "beautiful golden glows". Three sun-facing views now exist in
`tod.mjs`: `sunvista`, `sunlow`, `sunwater`.

With them pointed at the sun:

| hour | what is there |
|---|---|
| 7.4 | a flat cream wash. No disc, no aureole, no glow. |
| 17.1 | a small pale smudge, maybe 2% of frame width. |
| 19.0 | **nothing at all** — and stars are already visible over a salmon sky. |
| 19.8 | nothing; sky is a saturated magenta-crimson slab. |

`morning.jpg` puts a blown-white disc and a halo covering roughly a third of the
frame width over a near-white sky. `sunset2.jpg` is a full glare bloom through a
canyon mouth. We have neither.

### 2. Night is a navy slab with no moon and almost no stars

`dome-h0` — camera pitched up so the sky is the whole frame — is a flat navy
rectangle. Star count from `ladder.mjs --stars`: **9 per megapixel**. Reference
`night.jpg` is **174/Mpx**, `night3.jpg` **76/Mpx**, both with a magnitude
spread of ×8 (real faint-to-bright range) and a visible Milky Way band. There is
no moon in our sky at all.

### 3. Night is navy; the reference night is violet, and eight times brighter

Measured up the dome (linear R:G:B normalised to red, and luma):

| | zenith | horizon band | ratio | luma |
|---|---|---|---|---|
| `night.jpg` | `#483a54` | `#473e5d` | 1 : 0.72 : 1.60 | 0.050 → 0.056 |
| `night3.jpg` | `#48455a` | `#473e5d` | 1 : 0.79 : 1.62 | 0.064 → 0.056 |
| ours, `zen 0x0d1226` | `#0d1226` | `#1c2440` | 1 : 1.42 : 4.7 | **0.006** |

Two separate errors:
- **Hue.** The plates are *violet* — red sits **above** green, blue highest by
  only ~1.6×. Ours is *navy* — green above red, blue 4.7× red. A violet night
  and a navy night are not the same picture.
- **Value.** Ours is roughly **an eighth** of the plates' luminance, and the
  plates' vertical gradient is nearly flat (0.050 → 0.056), where ours triples
  from zenith to horizon.

### 4. You cannot see anything by moonlight

`camp-h0` (eye height in the meadow at midnight): the ground is black mud with
one patch of near-field grass lit **orange**, which reads as a light leak, not
as night. The reference plates put moonlit snow at `#0e2f58` — luma 0.028,
chroma 0.29, a clearly readable cool blue at roughly half the sky's luma — and
in `night2.jpg` the distant mountains still have full aerial perspective and
value separation *at night*.

There is no moon light source in `Lighting.js`. `hemiI` at h0 is 0.42 and
`sunI` is 0.10 pointed at a sun that is under the horizon.

### 5. Stars fade in while the sky is still salmon

`uNight = 1 - dayFactor`, and `dayFactor = smoothstep(-0.08, 0.10, elev)`, so
stars reach full strength the moment the sun touches the horizon — visible in
`sunvista-h19` over a bright pink sky. Stars need their own ramp, keyed much
later than sunset.

---

## Reference numbers to hit

All from `node tools/ladder.mjs <plate> --sky --stars`.

### Night (`night.jpg`, `night3.jpg`)
```
sky, zenith → horizon   #483a54 → #473e5d   luma 0.050 → 0.056   chroma 0.10–0.12
linear ratio            1 : 0.72 : 1.60  (violet: R above G, B highest)
gradient                nearly flat; the horizon is very slightly BRIGHTER and bluer
moonlit ground          #0e2f58   luma 0.028   chroma 0.29   (~0.5× sky luma)
stars                   76–174 per Mpx of sky
star magnitude          p50 0.09–0.13 over local sky, max 0.39, spread ×8
milky way               a soft, clearly visible diagonal band of unresolved haze
moon                    crescent, disc ~1.2° with a halo ~8–10× the disc radius
```

### Morning / low sun over water (`morning.jpg`)
```
zenith        #fefcf0   luma 0.970   chroma 0.055   ← a near-WHITE dome
mid sky       #fef9e6   luma 0.945   chroma 0.093
low sky       #ffb086   luma 0.541   chroma 0.475   ← the wedge, and it is strong
horizon band  #d5af9b   luma 0.470   chroma 0.227
far ground    #907165   luma 0.187
near water    #5f8494   luma 0.211   ratio 1 : 2.00 : 2.57  ← COOL, and it must stay cool
```
The read: a blown, near-white sky right down to a hard warm wedge at the
skyline, and a **cool** foreground. The warm/cool split is the whole picture.

### Sunset (`sunset.jpg`, `sunset2.jpg`)
```
zenith        #ffbf99   luma 0.608   chroma 0.400
mid sky       #ffc39d   luma 0.629
horizon band  #fe9c6f   luma 0.460   chroma 0.564   ← chroma peaks at the skyline
near ground   #733b2c   luma 0.070   ← and the ground goes genuinely DARK
```
Note the value range: sky 0.63, ground 0.07. A ×9 spread. Our `sunvista-h19`
runs sky 0.55 to ground 0.30 — a ×1.8 spread, which is why it reads as mush.

---

## Ownership — do not edit a file you do not own

Four authors work this round in one tree. File ownership is exclusive.

| author | owns | must not touch |
|---|---|---|
| **A · dome** | `src/sky/Sky.js`, any new `src/sky/star*.js` / `src/sky/moon*.js` | Lighting, PostFX, Atmosphere, Clouds |
| **B · light** | `src/render/Lighting.js` | Sky, PostFX, Atmosphere, Clouds |
| **C · post** | `src/render/PostFX.js`, `src/render/Atmosphere.js` | Sky, Lighting, Clouds |
| **D · cloud** | `src/sky/Clouds.js` | everything else |

`tools/` is shared and append-only: add a tool, do not rewrite one.
`docs/` — each author appends to their own section at the bottom of this file.

## The contract: `SKY_STATE`

`Lighting` is the single writer; `Sky` and `Clouds` are readers. These fields
exist **now**, with working values, so A and D can build against them before B
has finished re-authoring the curve. B may change the *values* and the shape of
the curves freely; B must not remove a field or change its meaning.

| field | type | meaning |
|---|---|---|
| `sunDir` | Vector3 | unit, world space |
| `sunElev` | number | `sunDir.y` |
| `dayFactor` | number | 0 night … 1 full day |
| `moonDir` | Vector3 | unit, world space. Rises as the sun sets. |
| `moonElev` | number | `moonDir.y` |
| `moonPhase` | number | 0 new … 0.5 full … 1 new. Drives the crescent. |
| `moonColor` | Color | the disc / halo colour |
| `moonIntensity` | number | 0 when the moon is down or the sun is up |
| `starAmount` | number | 0 … 1. **Its own ramp** — 0 until the sky is genuinely dark, not `1 - dayFactor` |
| `milkyWay` | number | 0 … 1, band strength; tracks `starAmount` but may lag it |
| `nightFactor` | number | 0 … 1, "how night is it" for readers that want a single scalar |

## The standard

`docs/CRITIC_PROTOCOL.md` applies unchanged. The bar is a shipping first-party
cozy title. Blind A/B against the previous round every time, and the plates
above are the target — not "better than last round".

---

## Author A requests

_Updated after B's re-author landed. Two of the three original requests are
resolved; the resolutions are kept here because the reasoning is the useful
part._

### RESOLVED — the night keys (to B)

Asked for: the night keys were navy (`zen 0x0d1226`, 1 : 1.42 : 4.7, luma 0.006)
against both plates' violet (1 : 0.72 : 1.60, luma 0.050).

B has landed `0x6e5a80` / `0x6c5f8e`. Measured through the chain the dome now
renders 1 : 0.745 : 1.87 at the zenith against the target 1 : 0.72 : 1.60 — the
hue is right.

The local fallback in `Sky.js` was built to target an absolute colour rather
than to apply a multiplier, specifically so it would become a no-op the moment
B published that colour. It has, so `NIGHT_KEY_OVERRIDE` is now **0** and the
constants are set to B's own values. The mechanism is left in the file at zero,
with the reasoning, rather than deleted.

### RESOLVED — `starAmount` (to B)

Asked for: the ramp handed the dome 0.41 at h 19.8, with the sun 5° down over a
sky at display luma 0.60.

B has rebuilt all three night ramps on hours-since-sunset and now publishes
0.00 at 19.0 and 0.12 at 19.8. The dome still cubes it, and B's table is written
knowing that, so the two agree at both ends.

### STANDING — `moonPhase = 0.32` is not a crescent under any standard mapping

Unchanged: under `illum = (1 - cos(2π·phase))/2`, 0.32 is 71% lit. Any monotone
mapping with the documented anchors (0→new, 0.5→full) gives ≥ 0.5 at 0.32. B has
kept the value and made it an authored constant (`MOON_PHASE`), so `moon.js`
treats the field as **art-directed rather than astronomical** and eases the
illumination curve (`MN_PHASE_SHAPE = 4.0`), which keeps all three documented
anchors exactly and spends most of the cycle in crescent territory. That is now
the agreed reading of the field and it should be written into the contract table
so the next author does not implement the astronomical mapping and get a blob.

### NEW — the night frame is seven times too bright, and that is a level, not a hue (to B and C)

This is the one number I could fix in one line in my own file and did not,
because the lead's rule says the frame's absolute level is C's.

Measured, `dome-h0` at 1280×720 through the current chain:

```
                ours          night.jpg      night3.jpg
zenith luma     0.343         0.050          0.064
zenith ratio    1:0.745:1.87  1:0.72:1.60    1:0.79:1.62
chroma          0.294         0.102          —
whole frame     lumaMean 0.603
```

The hue is right and the level is out by ×7. `0x6e5a80` decodes to scene-linear
(0.152, 0.102, 0.216), luma 0.121; the chain returns display luma 0.343, so its
gain at the night operating point is about ×2.8. To land on the plates the dome
would need roughly (0.021, 0.014, 0.021) scene-linear, i.e. a ×8 cut somewhere.

Whoever takes it: it can be taken as a key cut in `Lighting.js` **or** as night
exposure in `PostFX.js`, and the two are not equivalent for anything else in the
frame — a key cut darkens only the dome, exposure darkens the moonlit ground
with it, and `camp-h0` needs the ground at roughly **half** the sky's luma
(plates: ground 0.028 against sky 0.050–0.056). That argues for exposure.

Two knock-on effects, both mine and both re-measurable in one capture:

* **Star count.** `ladder.mjs --stars` counts local maxima more than 0.045
  display luma above their own neighbourhood, which is a *contrast* test, so it
  moves with the night level. Measured at a correctly-dark sky (zenith luma
  0.058) `SK_FILL 0.115` gave 316/Mpx; it is now 0.055, set for about 130. At
  today's over-bright sky the same settings measure 181 and 87 respectively.
  Ping me and I will re-measure rather than guess.
* **Magnitude spread.** ×9.5 at the correct level, ×3.7 at today's — the tone
  curve's shoulder squashes the bright stars against a bright sky. Nothing in
  the starfield changed between those two measurements.

### NOTE to C — the dome now writes over the bloom threshold on purpose, in a bounded solid angle

The aureole is deliberately over `luminanceThreshold 0.80` within a few degrees
of the sun, and deliberately **under** it everywhere else. Measured on
`sunvista-h19` (facing a sun 3.6° below the horizon):

```
              ours (A-r3)   BASELINE   sunset.jpg
lumaP05          0.257        0.291      0.247
lumaP95          0.944        0.614      0.927
lumaRange        0.687        0.322      0.680
contrastStd      0.226        0.097      0.221
```

That is the blown highlight the brief asks for, reached without lifting the
frame: P05 went *down* while P95 went up. If `EXPOSURE` (0.88), the bloom
threshold (0.80) or the PBR Neutral curve moves, the `broad` and `core`
amplitudes in `Sky.js` were calibrated against those three and will need
re-measuring — they are four numbers in one expression and the comment above
them says what each is for.


## Author D requests

### D1 · Night `cover` is wrong for this brief — and here is the number

`Lighting.js`'s keyframe table runs `cover` **0.35 at h0, 0.39 at h21, 0.37 at
h5**. Through the deck's threshold (`lo = 0.950 - 0.44 * cover`) that is the top
~22% of the coverage field by area, and because every view ray crosses the deck
at a grazing angle the *visible* fraction is far higher than the areal one — the
long note by `lo` in `Clouds.js` records the last time this was measured, at
50.7% areal reading as 84–99% of visible sky.

Both night plates are **essentially clear**. `night.jpg` and `night3.jpg` have no
cloud in them at all; `night2.jpg` has two soft banks over roughly a fifth of the
sky. The round's headline is a star field, a Milky Way and a moon, and a third of
the dome under opaque cloud deletes all three.

**Ask:** author the night block at `cover 0.10–0.13` (h21 through h5), ramping
back to the existing 0.32–0.36 by h19 and h6.3, where cloud *is* the event.

**Measured after the change**, with `cloudprobe.mjs`'s solid-cloud tier (a
pixel the deck moved by more than 24/255): `dome-h0` **2.6%** of the upper frame
and `hero-h0` **1.1%**, with every sky sample point *darker* with cloud than
without (dLuma −0.03 to −0.06). That is the plates' read. It is achieved by
scaling B's value down by a factor of four and a half, which is the wrong place
for the number to live.

**What I have shipped in the meantime**, so that my side works at whatever I am
handed: `Clouds.update()` scales the value it is given by
`(1 - 0.78 * SKY_STATE.starAmount)`, which lands h0 at an effective 0.077 and
leaves every daylight hour untouched. It is keyed to `starAmount` deliberately —
same ramp the stars fade in on, so the sky opens exactly as they arrive. If B
authors the table values above, delete that scale; two curves doing one job is
how this drifts.

### D2 · Negative result: the twilight magenta veil is **not** the cloud layer

The lead asked for the `cloudAmbient` measurement from the note at the end of
`Lighting.js`'s `update()` — hide the cloud dome, re-measure the top of the sky.
That method is now a tool: `tools/cloudprobe.mjs` captures each (view, hour)
twice, once with `Clouds.mesh.visible = false`, and reports both.

`node tools/cloudprobe.mjs --views dome,hero --hours 19,19.8` — linear **B:G** at
the sky points (>1 means blue leads green, i.e. magenta-led):

| | zenith with cloud | zenith **without** cloud |
|---|---|---|
| `dome-h19` | 1.055 | **2.295** |
| `dome-h19.8` | 1.445 | **3.950** |
| `dome-h7.4` | 1.474 | **1.676** |
| `hero-h19` | 0.857 | 0.854 |

Re-measured on the final build after the cloud rework, the gap is wider still:
`dome-h19.8` reads **2.852 with cloud against 12.371 without**. A twilight
zenith at blue 12x green is not a cloud artifact by any reading.

**The violet is in the dome, not in the deck.** Hiding the cloud layer makes the
zenith *more* magenta at every twilight hour measured, by more than a factor of
two — the cloud is currently the only thing pulling it back toward neutral. Same
story on chroma: `dome-h19` zenith reads 0.023 with cloud and **0.286** without.

This is the opposite of the 2026 golden-hour bug the note describes, and it is
not mine to fix. `Sky.js`'s night/twilight zenith and the `zen` keys at h19
(`0x4a6bb4`) and h19.8 (`0x33508e`) are where a twilight zenith with blue at
2.3–4.0× green is coming from. **Author A or B owns this.**

`Clouds.js` now also refuses to make it worse structurally rather than by
tuning: every cloud colour goes through `noViolet()`, which clamps linear blue
down to green whenever the sun is up. It cannot re-create the veil.

### D3 · For Author C — the deck cannot silhouette against the aureole

Not a blocker, an observation with a number. At 19:00 the sun-facing sky is at
or over 1.0 linear across a large part of the frame, so `sunvista-h19` and
`dome-h19` have no value headroom left for a cloud edge to read against: measured
whole-frame `lumaP95` at `dome-h19` is 0.992 **with** cloud and 0.949 without,
i.e. the deck is drawing into a region that is already blown. A silver lining is
a silhouette phenomenon and needs the background under ~0.85 to exist at all.
Nothing for me to do about it from this file — flagging it so it is not read as
a cloud defect.

---

## Author B requests

_2026-08-20 · everything below is measured, with the tool and the command that
measured it, so nobody has to take my word for it._

### B1 · Grass author — the meadow glows hot amber at midnight, and it is `uTrans`

This is the orange in `camp-h0`. It is **not** the camper's headlights and it is
**not** the light rig; I checked both before writing this.

`tools/_scratch/grassleak.mjs` shoots the identical posed `camp` frame at h0 four
times, changing one grass uniform between shots and nothing else:

```
                 grass patch           terrain beside it
as shipped       112,67,43  1:0.34:0.15  luma 0.076   52,42,31  1:0.69:0.41  luma 0.025
uTrans = 0        52,42,31  1:0.69:0.40  luma 0.025   52,42,31  1:0.69:0.41  luma 0.025
uSkyFill = 0 too  51,42,31  1:0.69:0.40  luma 0.025
uSkyFill = 0 only 115,66,44 1:0.32:0.15  luma 0.077
```

Zeroing `uTrans` takes the grass from three times the terrain's luminance and a
hot 1 : 0.34 : 0.15 to *exactly* the terrain's value and hue. The whole defect is
one term.

`tools/_scratch/nightdiag.mjs` rules out the other two candidates in the same
way: forcing every SpotLight and PointLight in the scene to zero intensity moves
that patch by less than the wind noise between two settles (118,68,44 →
126,71,46), and a white-hemisphere probe shows the grass albedo is 1 : 0.55 :
0.157 — warm, but nothing like 1 : 0.34 : 0.15.

The mechanism, in `src/shaders/grass_material.js`:

```glsl
vec3 glowCol = mix( uGlowCol, uSunColor, 0.35 );
gl_FragColor.rgb += glowCol * ( trans * uTrans * sh * diffuseColor.rgb * 2.2 );
```

`uGlowCol` is a constant `0xffa235` — a hot amber — and `uTrans` is a constant
2.10. Neither is scaled by the sun's *intensity* or by `dayFactor`, so the
backlit-translucency term fires at full golden-hour strength at midnight
whenever the camera looks down-sun. `uSunColor` is only 35% of the mix and it is
`lighting.sun.color`, which carries no brightness — the grass shader treats a
light's colour as its radiance, so nothing I can do from `Lighting.js` reaches
it. Setting `sunI` to zero at night does not help: 65% of that colour is the
constant amber. The same is true of `uSkyFill` / `uSkyCol` (`0xa9c6e8`, a fixed
daylight blue at a fixed 0.14) — it is small enough not to show, but it is the
same bug and it will show as soon as the night gets its value right.

**Ask:** scale both by how much light there actually is. `SKY_STATE.dayFactor`
is published for exactly this, and `SKY_STATE.nightFactor` is now a proper night
ramp rather than `1 - dayFactor` (see B4), so either works:

```js
u.uTrans.value   = 2.10 * SKY_STATE.dayFactor;
u.uSkyFill.value = 0.14 * SKY_STATE.dayFactor;
u.uSkyCol.value.copy(SKY_STATE.horizon);   // and let it track the sky at all
```

Until this lands, `camp-h0` cannot pass its "no orange leak" criterion no matter
what the light rig does, and it is the frame the whole "we should be able to see
by moonlight" complaint was raised against.

### B2 · Author C — the night dome cannot reach 1 : 0.72 : 1.60 while `uRodTint` runs

The lead's target for my night sky is a rendered linear ratio of 1 : 0.72 : 1.60.
The keys are authored at 1 : 0.70 : 1.62 — the plate's own hue — and the dome
comes back at **1 : 0.72 : 6.4**. Red against green is exactly right; blue is
four times over.

It is not the key, and this is provable from your own constants. The Purkinje
block in `PostFX.js` does

```glsl
vec3 rod = vec3(ln) * uRodTint;      // uRodTint = (0.958, 0.910, 2.012)
c = mix(c, rod, w);                  // w = uRodAmount(0.70) * uNight * dim
```

so at full night 70% of every dim pixel is replaced by an axis of
**1 : 0.95 : 2.10**. That axis is *bluer than the plate's sky* — your own note
says so, and says it is a compromise between the sky at 1 : 0.72 : 1.60 and the
moonlit snow at 1 : 13 : 46. The consequence is that no key colour can land the
dome on the sky end: 70% of it is already the compromise.

I swept it to be sure (`tools/_scratch/nightsweep.mjs --skysweep`, which pokes
Sky.js's night override to zero so the published key is what is on screen). The
rendered blue:red runs 1.81 at dome luma 0.30 and 3.2–6.8 at dome luma 0.045 —
i.e. the excess *grows* as the pixel gets dimmer, which is the signature of a
fixed axis being mixed in, not of a channel gain. Authoring around it means
publishing a mauve-brown as the night sky key, which I am not going to do.

**Ask:** exempt the sky from the rod shift, or gate `dim` on something the dome
is above. The physical argument is on your side — the dome at luma 0.05 is twice
the moonlit ground, and Purkinje is a property of the dark-adapted *scene*, not
of the sky you are looking at. A `dim` that keys off the local pixel's
luminance relative to the sky rather than absolutely would fix both ends.

**Second ask, smaller:** the night contrast crossing. `uContrast` 1.36 about a
0.18 linear pivot sends everything under **0.0476 linear** negative before the
toe, and the toe maps every negative to within a thousandth of the same number.
That is why the old night had twelve identical ladder points. My keys now clear
it, but any future night value under that crossing has no gradient at all, and
it is worth a comment beside the constant so the next author does not spend an
afternoon on it as I did.

### B3 · Author A — the moon arc changed, and your `NIGHT_ZENITH` renders dark

Two things you are building against moved.

**The arc.** `computeMoonDir` is re-authored. The placeholder put the moon
*under the horizon at 05:00*, which is one of the four night keyframes, so a
player out before dawn had no key light at all. It now has its own window sized
to the night — up from 18:00 to 06:42, culminating at 00:20 at 41°:

```
h        18.3   19.0   19.8   21.0    0.0    5.2    6.3    7.4
moonElev  1.8    7.3   14.2   24.6   41.1   11.6    2.5   down   (degrees)
```

It is also continuous and periodic now, where the old one stepped 0.22 in
`moonElev` at moonrise. Checked at 0.004 h resolution over the whole 24 h
(`tools/_scratch/arccheck.mjs`): no field on `SKY_STATE` moves more than 0.010
between adjacent samples anywhere, including across midnight. The *sun* had the
same class of defect and it was worse — a 0.045 step in `sunElev` at both
sunrise and sunset, and a 180° flip in the sun's azimuth at midnight. Both
fixed; see the notes in `computeSunDir` and `_sunAz`.

`moonPhase` stays an authored 0.32 rather than being derived from the sun–moon
angle. A moon that lights the ground the way the plates show is near full, and
deriving the phase would give you 0.5 every night and contradict the crescent
the plates actually draw. It is an art number and it is now labelled as one.

**`NIGHT_ZENITH`.** Your self-cancelling override is a good mechanism and I
matched my keys to your target hex on purpose so it would cancel — measured, the
CONTROL row and the override-off row agree to 0.0002 of luma, so it is already a
no-op. But `0x6e5a80` is not the plate: through the shipping chain it renders at
dome luma **0.30**, six times the plate's 0.050. The values that land on the
plate are the ones now in the table, and the sweep that found them is quoted in
the note above `KEYS`. Suggest dropping `NIGHT_KEY_OVERRIDE` to 0 now that the
keys are violet — two corrections in series is exactly what your comment warns
about.

**Star gate.** `starAmount` no longer comes off sun elevation at all. This
world's night is 11.3 h against a 12.7 h day, so the sun's depression only runs
to 18° and the useful part of that curve is a few hundredths wide; hours since
sunset is the quantity the astronomy is actually stated in. New shape:

```
h        19.0   19.8   20.4   21.0    0.0    4.6    5.2    5.6
star     0.00   0.12   0.44   0.86   1.00   0.86   0.20   0.02
milky    0.00   0.00   0.09   0.35   1.00   0.35   0.01   0.00
night    0.00   0.29   0.83   1.00   1.00   1.00   0.29   0.03
```

Your cube of it still composes — 0 and 1 are fixed points — but note the knee is
already much later than it was, so `starAmount³` may now be *too* late at 20:00.
Worth re-checking against a frame rather than against the old curve.

`nightFactor` changed meaning and this one matters to you: it used to be
`1 - dayFactor`, and on the new continuous sun curve that reads **0.69 at
19:00**, which would have lerped 69% of your night dome over a sunset. It is now
its own ramp reaching 1 about ninety minutes after sunset, per the table above.

Also: I deliberately did *not* add a `moonDir` field to the Lighting instance,
even though `_pose.mjs` prefers one. A field is written once per frame, and the
capture tools set `hour` and then pose in the same tick, so a field would hand
`faceMoon` the *previous* hour's direction. `computeMoonDir(hour)` is always
fresh. (`faceSun` has this bug today via `L.sunDir` — worth someone fixing in
`_pose.mjs`, which I must not rewrite.)

### B4 · Author D — B:G > 1 at a blue zenith is not magenta

Re D2. The test you are using flags any blue sky: a zenith with blue above green
is what "blue" *is*. The magenta signature the critic named is blue above green
**with green below red** — `hor 0xb59aa4` at h6.3 and `fogFar 0x92849e` at h19.8
were exactly that, and both are gone. Every twilight key in the table now obeys
one rule: a colour may be warm (R > G > B) or blue-violet (G ≥ R, B highest),
and may not be the third thing. `zen` at h19 is `0x4a6ebc` — G above R — so its
2.3× blue:green is a blue sky and not a veil.

The chroma number in your table is the real finding and I have acted on it from
my side: `fogFar` at 19.0 and 19.8 was pink (`0xc09084`, `0x92849e`) and past
`farStart * 5` the haze is entirely `fogFar`, so that was the colour of every
distant ridge. Both are warm-neutral now.

**Ask, since you asked for one:** yes, author the night `cover` down. I have left
it at 0.35–0.39 because cloud cover is not a lighting decision and I did not want
to make it one from this file. Take the table values; when you do, delete your
`starAmount` scale so there is one curve and not two.

---

## Author A — what landed

Files touched: `src/sky/Sky.js` (rewritten), `src/sky/starfield.js` (new),
`src/sky/moon.js` (new), `tools/starpan.mjs` (new). Nothing else.

Frames: `shots/A-r5/` (1600×900, 24 frames), contact sheet `shots/A-r5-sheet.png`,
star-stability strip `shots/A-pan/`.

**Read the caveat before the numbers.** Four authors were editing while these
were captured and the frame's absolute level moved three times in one afternoon
(`dome-h0` zenith luma: 0.343 → 0.144 → 0.121 across three of my own captures,
with nothing in `Sky.js` changing between the last two). Every level-dependent
number below is a snapshot. The ratios and the value *ranges* are not, and those
are the ones worth reading.

### Before / after

`dome-h0` — the night sky filling the frame:

| | BASELINE | A-r5 | night.jpg |
|---|---|---|---|
| zenith | `#232b3a` | `#675b88` | `#483a54` |
| linear ratio | 1 : 1.46 : 2.52 | **1 : 0.768 : 1.810** | 1 : 0.72 : 1.60 |
| luma, zenith → horizon | 0.024 → 0.024 (flat) | 0.121 → 0.126 | 0.050 → 0.056 |
| chroma | 0.090 | 0.177 | 0.102 |
| stars | 28 /Mpx | **82 /Mpx** | 174 /Mpx |
| mag spread | ×3.3 | ×4.8 | ×8.2 |

`moon-h0`: 127 /Mpx, spread ×5.1, p50 **0.076** against the plates' 0.085–0.13.

The hue is in: red is back above green and blue is no longer four and a half
times red. The gradient exists — it was *identically* 0.024 at all twelve ladder
points and now rises 4% from zenith to skyline, which is the plates' shape
(theirs is 12%; both ends of ours come from B's two keys, so the size of the
rise is B's to set, not the dome's).

Two things are not in, and both are the same thing: **level**. Luma is 2.4× the
plates and chroma is 1.7× — and the magnitude spread misses ≥6 only because of
it. Measured at a night sky of luma 0.058 the same starfield gave spread **×9.5**
and 316 /Mpx; against today's brighter sky the tone curve's shoulder squashes
the bright stars together. Nothing in the field changed between those numbers.
See the level request above.

Twilight and golden hour, whole-frame — the headline defect was "no blown
highlight anywhere in any frame", and quoting P05 beside P95 as the lead asked:

| | BASELINE | A-r5 | plate |
|---|---|---|---|
| `sunvista-h19` P05 / P95 / range | 0.291 / 0.614 / 0.322 | **0.236 / 0.941 / 0.706** | 0.247 / 0.927 / 0.680 |
| `sunvista-h19` contrastStd | 0.097 | **0.224** | 0.221 |
| `sunvista-h19p8` P05 / P95 / range | 0.181 / 0.469 / 0.288 | 0.164 / 0.801 / 0.637 | — |
| `sunlow-h7p4` P05 / P95 / range | 0.241 / 0.826 / 0.585 | 0.207 / 0.999 / 0.792 | 0.390 / 0.980 / 0.590 |
| `sunlow-h17p1` P05 / P95 / range | 0.338 / 0.914 / 0.576 | 0.356 / 0.961 / 0.606 | — |

The P05 column is the point: the range more than doubled at h19 and P05 went
**down** while it did. That is the difference between a bright source in an
unlifted frame and a lifted frame.

`sunlow-h7p4` against `morning.jpg` on the point ladder: zenith luma **0.996**
against 0.970 (Δ 0.026), upper sky 0.995 against 0.957.

Stars over a bright sky: `sunvista-h19` had **435 /Mpx** over salmon in the
baseline and now has none from the dome. (`ladder --stars` still reports counts
on `sunvista-h19p8`; those are cloud edges and ridge speckle inside the upper
45% of the frame, not stars — the frame is in `shots/A-r5/` and has none.)

Star stability, `tools/starpan.mjs` (new): 68–73 detected stars across yaw
offsets of 0, 0.01, 0.02, 0.04, 1 and 4 degrees — i.e. across three sub-pixel
steps and two gross ones. Spread **7.4%**. No aliasing, no crawl.

### What changed, and why

**The starfield is a different construction, not a tuned one.** The old field
was `floor(dir.xz / (|dir.y| + 0.35) * 340.0)` — a gnomonic projection onto the
ground plane with one hash and one threshold. Cells stretch without limit toward
the horizon, cell area varies more than 10× between the zenith and 15°, and
every star is exactly one cell wide, so it is a lattice with a single magnitude.
It is now an equi-angular cube-face parametrisation: after the `atan` remap one
uv unit is exactly 45° of arc, so a square cell is a square patch of *sky* and a
distance measured in uv *is* an angle. That is what lets stars have real angular
radii, a magnitude distribution, per-star colour, per-star twinkle rate and
phase, and a soft halo on the bright ones only — none of which the old field had
a place to put. Density is even to about 1.25× corner-to-centre.

**The aureole is exponentials in angle, not powers of cosine.** `pow(cos, n)` is
a much narrower family than aerosol forward-scattering actually is, which is why
every previous attempt at a wide halo had to be set so low it vanished — the old
20° lobe carried 0.055 of a unit-scale sky. Four exponential lobes at 37°, 10°,
1.7° and 0.25°, the two wide ones scaled by how low the sun is. It is over the
bloom threshold within a few degrees of the disc and under it everywhere else,
which is the shape that reads as a halo rather than as a fogged lens.

**The aureole is whitened toward the core and left warm in the skirt.** The
plate puts `#fefcf0`, chroma 0.055, immediately around the sun and only turns
peach several degrees out; whole-frame we measured chromaMean 0.35 against its
0.18. Pushing a saturated orange glow harder would have made the standing
"monochrome orange" complaint worse. `sunlow-h7p4` chromaMean is now 0.315
against the baseline's 0.348.

**The disc no longer switches off.** The old gate was `(elev + 0.01) / 0.03` —
1.7° of arc, so the sun did not set, it blinked out — and extinction kept only
30% of it at the horizon, which is the exact hour the brief calls the headline.
It is now a ~4° fade and 60% extinction, and the light the disc loses is handed
to the aureole, which is where scattering actually puts it.

**The night gradient exponent is a function of `nightFactor`.** 3.4 by day,
1.05 at full night. 3.4 spends the whole transition in the bottom 20°, which is
right for a daylight haze band and cannot produce the plates' near-flat night
dome at any pair of keys.

**Stars are gated on `starAmount³ × a directional guard`, never on
`1 - dayFactor`.** The cube keeps both of B's anchors exactly and moves the knee
out; B has since rebuilt their ramp knowing it is here. The guard is the part a
single scalar structurally cannot do — at sunset the sky is dark overhead and
blown ten degrees off the sun.

**The moon.** Elliptical terminator (`x_t = k·√(1-y²)`, meeting the limb
tangentially at both horns), lit side built from the projected sun direction so
the horns point the right way on their own, faint earthshine on the dark limb,
low-contrast maria, weak limb darkening, and a three-lobe halo. The halo is the
part that sells it: take the disc away and the halo alone still reads as a moon
behind haze.

### What did NOT work

1. **Calibrating the night sky's hue from inside the dome.** At luma 0.05 the
   *additive* terms in the grade are larger than the dome's own signal: PBR
   Neutral subtracts an offset equal to the minimum channel (which crushes the
   green of a violet almost to zero and doubles its saturation), then the toe
   (0.022) and the cool-tinted lift (0.020 × 0.78/1.02/1.48) add roughly
   (0.028, 0.031, 0.038) of display-linear back as a *constant*. I fitted a
   two-point power law through two measured captures and solved for the
   scene-linear colour that would land on the plates' violet: **(0.021, 0.011,
   0.006)** — a dark *brown*. It would have measured correctly and it would have
   been the wrong thing to ship. A sky shader that has to emit brown to render
   violet is not a sky shader, it is a chain calibration error hidden in the
   wrong file. It is recorded here instead. The useful form of the finding: at
   the night operating point the hue of the night sky is set by PostFX, not by
   the dome, and no amount of key authoring in `Lighting.js` will fully control
   it either.

2. **A circular aureole around a below-horizon sun.** The first pass had the
   right lobe *shape* and turned `sunvista-h19` into a flat white wash with no
   value structure — every visible direction sat over 1.4 linear. Two errors:
   the amplitudes were about 3× too high, and more importantly a halo centred on
   a sun that is below the skyline is the wrong *geometry*. The light arrives
   over the horizon, so the glow flattens into a band along it. Multiplying the
   broad lobes by `0.55 · (1 - up)^1.6` while the sun is under is what turned
   that frame from white paper into the sunset it now is, and it did more for
   the value range than the amplitude cut did.

3. **`amp = mix(MIN, MAX, pow(u, 6.6))` as a magnitude distribution.** It gave
   the right count and the right *maximum* — 0.373 against the plate's 0.394 —
   and a median of 0.190 against the plate's 0.085, for a spread of ×6.0 against
   ×8.2. The failure is not obvious from the expression: with a mix(), nearly
   every star sits at MIN, which is far *below* the visibility floor and so
   contributes nothing, while every star that clears the floor is already well
   clear of it. The population a real sky is made of — the one just barely
   visible — did not exist at any setting of the two constants. Replaced with a
   power law, `amp = MIN · u^(-1/2.2)`, whose defining property is that it is
   scale-free: the median *visible* star sits at 1.37× the visibility threshold
   whatever that threshold turns out to be. It took p50 from 0.190 to 0.069
   against the plate's 0.085 in one capture, and it is the one number in the
   starfield that will not need re-tuning when the night level moves.

4. **Isotropic noise on the Milky Way, and then too much anisotropy.** Round
   one was ordinary fbm of `dir` multiplied by a gaussian stripe, and the lead's
   read of the frame was exactly right — "a vague smudge with no structure and
   no direction, it looks like a smear on the lens". Round noise cannot describe
   a band, because the first thing the eye takes from a band is which way it
   runs. Round two stretched the noise 4.6× along the band and came back looking
   like a searchlight: parallel scratches running its whole length, worse than
   the smudge. 1.6× is the setting that reads as clouds drawn out along a band.
   The pole moved too, from a crown at 83° (essentially the zenith, which in a
   pitched-up view projects as a vertical column) to 60°, where the band arcs
   across the upper sky as a diagonal the way it does in both plates.

5. **`mix(warm, white, ci / 0.17)` for star colour.** Nominally a fifth of the
   field was warm; in the frame every star was blue-white. Writing the warm
   branch as a full fade to white means only the stars with `ci` near zero are
   amber at all, and most of those are too faint to see. Capping the fade at
   0.55 keeps the whole warm fifth visibly warm.

6. **`fwidth` of the cube-face uv for anti-aliasing.** It spikes to a full unit
   along all six cube seams, so star radii clamp huge there and a bright cross is
   drawn across the sky. `fwidth(dir)` is continuous everywhere and gives the
   same number. One line, an hour to find.

7. **Star density, four times.** `SK_FILL` 0.26 → 2315 /Mpx, 0.115 → 316,
   0.055 → 48, then the whole mapping changed under it. The metric is a
   *contrast* test (local maxima 0.045 display luma
   above their neighbourhood) so it moves with the night level and with capture
   resolution, and it is not a property of the field alone. It is now 0.085 —
   deliberately a compromise that sits inside 76–174 at both the current level
   and the darker one it is heading for, rather than optimal at either.

8. **The `Sky.js` header was wrong on all three counts.** It said the scene was
   AgX tone-mapped in the material with bloom at a 0.62 threshold on the
   display-referred result. `renderer.toneMapping` is `NoToneMapping`, PostFX
   moved to Khronos PBR Neutral, and bloom runs *before* the curve on the linear
   scene buffer at threshold **0.80**. Every amplitude in the old shader had been
   chosen against a constraint that no longer existed.

### Assumptions about B and C

* **Bloom threshold 0.80, in scene-linear units, applied before the tone curve;
  `EXPOSURE` 0.88; Khronos PBR Neutral.** All four aureole amplitudes were
  chosen against those three numbers. If any moves, they need re-measuring —
  they are four constants in one expression and the comment above them says what
  each is for.
* **B owns `zenith`, `horizon`, `sunHorizon`, `glow` and `glowIntensity`, and
  the dome never scales them.** The aureole is added on top of B's `glow` at
  B's `glowIntensity`; when B raised `glowI` at h19 from 1.32 to 1.60 the halo
  got 21% brighter and that is correct and intended.
* **C owns the frame's absolute level.** The one-line night-key override that
  would have hit the luma target is at zero, deliberately.
* **`moonPhase` is art-directed, not astronomical.** See the standing request.
* **`SKY_STATE.starAmount` is the only time-of-day gate for stars**, and the
  dome's own guard handles direction. The two are complementary; removing either
  breaks the other's assumption.

### Still not good enough

* The night sky is 2.4× too bright and 1.7× too saturated. Not mine to fix, but
  it is the first thing a reviewer will see.
* The Milky Way reads as haze rather than as a galaxy. It has a core, an
  envelope, lobes, clumping and a dark rift, and at the current sky level all of
  that is compressed into about three levels of grey. Worth re-judging once the
  night level lands; it may need more contrast between the rift and the spine
  rather than more brightness.
* Star magnitude spread is ×4.8 against ×8.2. Level-bound, as above.
* `sunlow-h7p4` reaches 31% near-neutral pixels against `morning.jpg`'s 7.4% —
  the blown region around the sun is slightly too large and slightly too white.
  The plate's sky is *nearly* white at chroma 0.055, not actually white.
* The sun disc is almost never visible in a canonical framing, because at the
  hours where it would read it is behind a ridge or a tree. The aureole carries
  the frame. That is faithful to the plates — neither `sunset.jpg` nor
  `sunset2.jpg` contains a disc — but it means the disc code is nearly untested.

## Author D — what landed

Owner of `src/sky/Clouds.js`. Nothing else was edited. Two tools added:
`tools/cloudprobe.mjs` and `tools/clouddrift.mjs`.

### The measurements

Before = `shots/BASELINE/` (pinned pre-round build). After = `shots/D-r4/`,
captured from the integrated tree. `colorstats.mjs`, whole frame:

| `hero-h19` | BASELINE | **D-r4** | `sunset.jpg` |
|---|---|---|---|
| lumaP05 | 0.263 | **0.233** | 0.247 |
| lumaP95 | 0.612 | **0.898** | 0.927 |
| lumaRange | 0.349 | **0.665** | 0.680 |
| contrastStd | 0.113 | **0.215** | 0.221 |
| chromaMean | 0.358 | **0.297** | 0.392 |
| violet + magenta + rose | 6.6% | **1.2%** | 0 |

| `dome-h19` | BASELINE | **D-r4** | `sunset.jpg` |
|---|---|---|---|
| lumaP05 | 0.329 | 0.476 | 0.247 |
| lumaP95 | 0.619 | **0.941** | 0.927 |
| lumaRange | 0.291 | **0.466** | 0.680 |
| chromaMean | 0.315 | 0.218 | 0.392 |

`cloudprobe.mjs` — the same frame captured twice, once with the cloud dome
hidden, so the deck's own contribution is isolated:

| | solid cloud, upper frame | lumaP95 with | without | zenith dLuma |
|---|---|---|---|---|
| `hero-h19` | 48.3% | **0.803** | 0.583 | +0.081 |
| `hero-h19.8` | 17.5% | **0.588** | 0.481 | +0.004 |
| `dome-h7.4` | 56.7% | **0.887** | 0.776 | −0.008 |
| `hero-h7.4` | 14.2% | 0.759 | 0.790 | −0.096 |
| `dome-h0` | **2.6%** | 0.118 | 0.168 | **−0.059** |
| `hero-h0` | **1.1%** | 0.114 | 0.143 | **−0.047** |

Read those last two rows together with the night plates: cloud covers 1–3% of
the night sky and every sample point is *darker* with it than without. That is
`night2.jpg` — a mass slightly under the sky value with a moonlit shoulder, not
a hole punched in the star field. `dome-h0` frame max also drops 1.000 → 0.956
with cloud in, which is the deck occluding the moon halo: the layers are one
picture now, not two stacked.

`clouddrift.mjs --view dome --hour 19` — cross-correlated sky band:

```
pair   dt     px/s   deg/s   dir    peak
  1  3.90s    1.85   0.213    56°   0.905
  2  3.57s    2.19   0.251    50°   0.892
  3  3.85s    2.76   0.317    49°   0.846
```
Direction holds within 7° across ten seconds; speed is 0.21–0.32 °/s (the
spread is ±0.5 px of integer-search quantisation on a 4–8 px displacement, not a
real variation). Correlation peak 0.91 → 0.85 across the run: the deck is
translating, and decaying slowly because the detail layer shears against the
mass — that decay *is* the evolution, and it is why it no longer reads as a
scrolling texture.

### Frame cost

**The absolute number is untrustworthy; the differential is not.**
`perf.mjs --seconds 25` on the integrated tree reports p50 42.8 ms / p95
100.4 ms and FAILs its budget — but it ran with three other authors' headless
captures resident on the same machine, and `docs/STATE.md` already attributes
this project's standing performance problem to pixel ratio and the post chain,
not to the scene.

So the deck was measured against *itself* instead, toggling one mesh on and off
inside one session and alternating the arms so any drift in machine load falls
on both equally (`tools/_scratch/cloudcost.mjs`), at h19 with the camera pitched
up so the deck fills the frame — its worst case:

```
clouds ON   median frame 31.60 ms
clouds OFF  median frame 31.80 ms
deck costs  -0.20 ms  (-0.6%)
```

A negative cost is obviously not real; it means the deck's cost is **below the
noise floor of this machine under this load**. It should still be re-run on a
quiet machine, but there is no regression here to find.

What can be stated without a timer at all:

- Draw calls and triangles are **unchanged**. The deck is still one 48x24 sphere,
  one draw call. `health.mjs` on the final tree: `ok: true`, 526 calls,
  3.75 M tris, 0 shader failures, all 13 systems up.
- Per fragment the shader gained roughly **15 ALU ops and one extra `hg()`** (a
  `pow`), and **zero additional texture taps** — `hs` was already being sampled
  for the self-shadow; the limb is the same subtraction read the other way. One
  per-slice multiply was removed.
- The noise tile went from `RGBA8` to `RGBA16F`: **1 MB to 2 MB**, and the taps
  per pixel are unchanged in count. That is the one real cost, and it is texture
  bandwidth on a tile small enough to stay resident.

### What changed, and why

1. **The lit limb was already being computed and thrown away.** The self-shadow
   test samples the column one step toward the light and clamps `hs - ht` at
   zero. The negative half of that same subtraction is the sunward shoulder of
   the mass — its limb. Un-clamping it is the whole directional lighting event
   and it cost one `clamp`.
2. **The belly, when the sun is under the deck.** `vert` was a fixed
   `0.50 + 0.50 * f`, i.e. crown-lit at every hour, which draws an 18:00–20:00
   cloud lit from the top. It now flips with `uBelow`, and the belly term is
   weighted by `(1 - ht)` so it glows where the cloud is *thin*.
3. **Body near-neutral, chroma on the rim only.** Handing `cloudLit` (#ffb078,
   chroma 0.53 at 19:00) straight to the shader tints the whole mass orange.
   The body is desaturated in JS; the saturated colour lives in `uRim`, which
   the shader spends only on the limb, the belly and the silver lining, and only
   through `warm` — down to a third away from the light's azimuth and a third by
   30° of elevation, which is the chroma-at-the-horizon rule made into a number.
4. **Every colour is now a RATIO to the sky, never a level.** `reanchor()`
   anchors lit/dark/ambient/rim to `0.42·luma(zenith) + 0.58·luma(horizon)` in
   daylight and to `luma(zenith)` at night — 1.55 / 0.38 / 0.85 / 3.2 by day,
   0.88 / 0.42 / 0.68 / 1.55 at night. Author C owns absolute level; this file
   owns the ratios. It paid for itself twice in one afternoon: B re-authored the
   night keys ten times brighter and then dark again, and the deck tracked both
   without a number here moving.
5. **`noViolet()`.** A hard clamp pulling linear blue down to green on every
   cloud colour while the sun is up, off at night. The `cloudAmbient` bug cannot
   be re-created from this file by tuning; it is structurally excluded.
6. **Opacity 0.35 → 1.0 at night, cover scaled instead.** `uOpacity` was
   `0.35 + 0.65 * dayFactor`, and `dayFactor` is 0.03 by 19:00 — so the deck was
   being cross-faded out an hour before sunset was over, and a 35%-opaque layer
   cannot occlude a star. Grace at night is now `uCover * (1 - 0.78·starAmount)`.
7. **Two rendering bugs that the new contrast exposed.**
   - The noise tile was **8-bit**. Half a step is 0.00196 of the field, ÷ RAMP
     0.100 × the normal's k = 3.12 gives a **0.061 normal tilt at texel
     frequency** — a fur crawling over every shaded flank, invisible against the
     old 1.40-wide terminator and glaring against this one. Now RGBA16F: 2.44e-4
     round-trip, a 0.0076 tilt. 2 MB instead of 1 MB, built once.
   - The lattice fade was **smoothstep**, which is C1 with a kink in its
     gradient on every lattice line. Finite-differencing it for a normal turns
     those kinks into facets — a diagonal weave through the mid-tone of every
     cloud on `dome-h7.4`. Quintic (`6t⁵-15t⁴+10t³`) removes it; it is the same
     reason Perlin dropped his own cubic in 2002.
8. **Slice contouring.** Silhouette softness was a constant 0.085 against a
   slice spacing of 0.143, so each slice crossed its threshold in isolation and
   drew a contour line: concentric onion rings round every mass at 19:00. It is
   now `1.15 / (SLICES - 1)`, derived rather than guessed, which also fixes the
   low tiers. Parallax clamp 0.40 → 0.30, and the additive silver moved off the
   per-slice `inside` onto the per-pixel column height for the same reason.
9. **Aerial fade.** `smoothstep(0.022, 0.19)` had the deck 90% melted into haze
   at 3° of elevation — and 3° is where `hero` and `ridge` spend their entire sky
   budget. Now `(0.014, 0.14)`, it fades toward `sunHorizon` rather than a
   neutral haze on the light's side, and the alpha loss there drops to 0.34.
   That last number is what makes a silver lining possible at all: a rim needs
   an opaque cloud in front of the glare, and at 22% opacity the glare simply
   shone through.
10. **Drift.** Wind 4.4/2.1 → 6.2/3.0 m/s, and the detail and cirrus layers now
    ride their own vectors, sheared against the mass. The coarse field still
    moves on `uWind` exactly, because Atmosphere's ground-shadow map is scrolled
    by the same vector and the patch on the meadow has to be the cloud overhead.

### What did NOT work

- **Chasing the highlight with an absolute gain.** The first pass multiplied
  `cloudLit` by up to 1.58. It hit `lumaP95` but the lead's integrated capture
  showed why that was worthless: the composite's `lumaRange` came out at 0.269,
  *worse than the baseline's 0.291*, because everything had moved to the top of
  the histogram together. `sunset.jpg` reaches 0.927 while holding 0.247 at the
  bottom. Reverted in favour of ratios plus a genuinely dark core (`energy`
  floor 0.18 → 0.07, `dark` at 0.38× the sky).
- **Anchoring night cloud to the sky's mean.** Anchoring to
  `0.5·(zenith + horizon)` put the night deck at 3× the rendered sky, because
  the horizon key is several times the zenith and the night framing that matters
  is pitched *up*. Night now anchors to the zenith alone.
- **Weighting the sun→moon key swing on `moonIntensity`.** It is already 0.53 at
  19:00, and the moon is 104° of azimuth from the sun there, so the deck's
  shading visibly rolled over across the two money frames. Multiplying by
  `starAmount` defers the swing into the hours where the deck has no contrast
  left to roll — 0.08 at 19:00, 0.31 at 19:48, 0.79 at 21:00.
- **Warming the cloud shadow toward the zenith to get the "cool half" back.** At
  19:00 the zenith key is `0x4a6bb4`; pulling the shadow 22% toward it produced
  a desaturated mauve — R above B above G — which is the candy-pink complaint,
  not the cure. Desaturation plus `noViolet` was the answer instead.
- **Raising cover at golden hour to get cloud across the sun in
  `sunvista-h17p1`.** Tried and abandoned: the sun-facing sky at that hour is
  already at 1.0 linear from the aureole (see request D3), so more cloud there
  buys a grey slab over a white field, not a rim.

### Assumptions about A, B and C

- **A (dome).** I assume `Sky.js` keeps drawing at `renderOrder -1000` and that
  stars and the Milky Way are written into the dome's colour. That is what makes
  cloud occlusion free — the deck alpha-blends over them and needs nothing from
  A. If the starfield ever moves to its own pass drawn *after* `renderOrder
  -999`, occlusion breaks silently and this file has no way to know.
- **B (light).** I assume `cloudLit` / `cloudDark` / `cloudAmbient` keep their
  *hues* meaningful and stop being read for their levels — this file now uses B's
  hue and discards B's value in favour of a ratio. I also assume `starAmount`
  stays a genuine "is the sky dark yet" ramp, because both the night cover scale
  and the key-light swing hang off it. And see request D1: the night `cover`
  values are wrong for this brief and I am scaling them locally until they move.
- **C (post).** I assume the bloom threshold stays near 0.80 linear and that
  exposure is C's alone to set. The rim is authored to cross that threshold on a
  limb and nowhere else. If exposure moves, the deck moves with the sky and the
  relationship holds; if the *threshold* moves a long way down, the rim will
  bloom into the body and I would want to know.

### Still not good enough

1. `dome-h19` `lumaP05` is **0.476** against `sunset.jpg`'s 0.247. The dome
   framing has no dark foreground, so it is not a fair comparison — but the
   darkest cloud in that frame is still not dark enough, and `lumaRange` 0.466
   against 0.680 says the same thing from the other side.
2. **No silver lining at `sunvista-h17p1`.** Cover is at the day's minimum
   (0.22) at that hour and the sun-facing sky is blown; there is no cloud across
   the disc and no headroom for an edge if there were. Request D3.
3. **Faint slice contouring survives** on the largest masses at low elevation
   (`dome-h19`, mid-left). Much reduced, not gone. The real fix is more slices
   or a proper analytic integral through the deck, and neither is a
   frame-budget-free change.
4. **`dome-h7.4` reads 56.7% cloud.** That follows B's `cover 0.30` at that hour
   and it is more sky than `morning.jpg` covers. I did not override it — one
   author scaling another's curve is already happening once, at night, and twice
   is how a value stops being findable.
5. The deck's masses still have a **lenticular, stacked-plate silhouette** at
   grazing angles. It suits the plates' flat-mass look better than it has any
   right to, but it is not cumulus, and a critic who knows what a cloud looks
   like will name it.

---

## Author C requests

Three of these are **negative results** — measured, and useful precisely because
they stop someone else chasing a defect that is not in their file.

**To Author A (`src/sky/Sky.js`).**

1. **NEGATIVE RESULT: the night sky's residual blue excess is not the grade and
   not the tone curve.** Your analysis was right about the build you measured —
   the black lift and PBR Neutral's min-channel subtraction really were larger
   than the dome's own signal at luma 0.05 — and both are now scaled out at
   night (`nightLiftCut` 0.85, `nightOffset` 0.15). What is left over is yours.
   Measured on `dome-h0` by removing the remaining fraction of each and
   re-capturing in the same boot:

   | variant | zenith | linear ratio | chroma |
   |---|---|---|---|
   | shipping | `#433d61` | 1 : 0.826 : 2.127 | 0.142 |
   | lift removed entirely | `#443f64` | 1 : 0.864 : 2.206 | 0.142 |
   | tone-curve offset removed entirely | — | — | 0.145 |
   | **both** removed entirely | `#443f64` | 1 : 0.864 : 2.206 | 0.145 |
   | `night.jpg` | `#483a54` | 1 : 0.653 : 1.368 | 0.102 |

   Deleting *both* additive terms moves blue-to-red by 4% and moves it the
   **wrong way**, and moves chroma by 0.003. There is nothing left in this file
   to spend on that axis. The 55% blue excess and the 1.4× chroma are in the
   dome, and now that the level is right they can be authored against directly:
   `node tools/ladder.mjs shots/C-final/dome-h0.png --sky` reads the number
   through the whole chain.

2. **NEGATIVE RESULT: the star magnitude spread is not the curve either.** On
   the same captures, `ladder --stars`:

   | variant | count | p50 | max | spread |
   |---|---|---|---|---|
   | shipping | 101/Mpx | 0.057 | 0.189 | ×4.0 |
   | lift + offset removed | 109/Mpx | 0.065 | 0.170 | ×3.7 |
   | night bloom threshold 1.70 → 0.70 (stars allowed to bloom) | 109/Mpx | 0.058 | 0.167 | ×3.6 |
   | `night.jpg` | 174/Mpx | 0.085 | **0.394** | ×8.2 |

   Every intervention that removes compression makes the bright end *worse*, not
   better — bloom in particular spreads a star's energy out of its own core. So
   the shoulder is not squashing them: the field's brightest stars are not
   bright enough to begin with. The faint end is already right (p90 0.046
   against 0.048), so this is a magnitude *distribution* question, not a level
   one.

3. `dome-h19` has no highlight headroom and it is mostly not the glare. With
   bloom intensity and veil gain both forced to zero it still reads `lumaP95`
   **0.887**; with them on it is **0.937**, under the 0.95 ceiling the lead
   asked for. So 0.05 of it is mine and 0.89 is the dome's own radiance. At the
   same hour and the same exposure `sunvista-h19` reads 0.232 / 0.944 / range
   0.712, so the chain is not over-exposed — the pitched-up framing is simply
   filled with the part of the dome that has the most energy in it.

**To Author B (`src/render/Lighting.js`).**

1. **The night ground/sky ratio is the one thing left at night that a global
   lever cannot reach.** Measured on the shipping chain: `dome-h0` sky luma
   0.054 against the plate's 0.050 — a match — while `camp-h0`'s near ground
   sits at roughly 0.88 of the sky where the reference is nearer 0.50. Exposure,
   the tone curve and the grade are all global; none of them can change a ratio.
   The frame that shows it worst is `shots/C-final/camp-h0.png`, where the
   moonlit meadow is the brightest thing in the picture — the plates put their
   brightest 5% in a *practical* (a lit tent, a campfire, headlights) and their
   ground below the sky.

2. The moonlit ground's colour is now correct (`#313b5d`, chroma 0.170 against
   `night.jpg`'s 0.169) but it is being supplied by the grade's scotopic term,
   not by the light. With the term off the same pixel is a warm brown at
   1 : 0.534 : 0.492. A moon key carrying the plates' own ratio would let me
   take that term down, which would in turn stop it having to work on every
   surface in the frame indiscriminately.

3. `fogNear` / `fogFar` at night: `night2.jpg` puts its far ridge *lighter* and
   warmer than its mid slope. The falloff shape is mine and is doing its job —
   `ridge-h0` now has three separated value groups where it had a `lumaRange` of
   0.007 — but the far end wants a haze colour lighter than the terrain in front
   of it.

**To Author D (`src/sky/Clouds.js`).** Your D3 is confirmed from this end with
the number above: at h19 the upper dome reaches `lumaP95` 0.887 before any glare
at all, so a cloud edge genuinely has no value to silhouette against. It is not
a cloud defect and I did not try to fix it in post — a curve change that bought
you headroom there would cost `sunvista` the range it just gained.

---

## Author C — what landed

_`src/render/PostFX.js`, `src/render/Atmosphere.js`, and two new tools,
`tools/postsweep.mjs` and `tools/_scratch/veilcost.mjs`._

### The measurement that changed the plan, twice

**Twilight.** The brief said the defect was a missing black point. It was not.
On the pinned baseline `hero-h19` measured `lumaP05` 0.263 against
`sunset.jpg`'s 0.247 — our black point was already *lower* than the plate's.
What was missing was `lumaP95`: 0.61 against 0.93. The range was missing almost
entirely at the **top**, and a golden glow is, numerically, a blown highlight.

**Night.** `ridge-h0` measured `lumaP05` 0.161 and `lumaP95` 0.168 — a range of
**0.007 across the entire frame** — and `dome-h0` read luma 0.024 at all twelve
ladder points. The cause was arithmetic, not art: **three separate corrections
in this file are sized for a display-referred daylight frame, and at night they
are larger than the picture.**

| term | what it is for | what it does to a night pixel |
|---|---|---|
| the grade's black lift | keep a near-black leaf off zero | adds a spatially constant (0.014, 0.018, 0.027) — two thirds of the frame, and a constant has no gradient |
| PBR Neutral's black offset | a toe on a 0.1–1.0 subject | subtracts the pixel's minimum channel; the whole night frame is under its 0.04 ceiling |
| the grade's contrast pivot (0.18) | an S-curve about middle grey | every night pixel is far below the pivot, so contrast > 1 throws them all deep negative and the toe becomes the majority of what comes back |

Each one was scaled out with `nightFactor` in turn, and each time the exposure
needed less to do — the night arm of the exposure table came down from 2.10 to
1.28 as they went. Most of what looked like a night *exposure* problem was those
three constants.

### What changed

1. **The exposure arc has a low half.** `EXPOSURE_ELEV_START` was 0.40, so the
   ramp never fired below `sunElev` 0.40 and every hour this round is about sat
   on the flat part of it. `EXPOSURE_LOW` is a small monotone table,
   smoothstepped between rows. Every canonical daylight framing sits at
   `sunElev` ≥ 0.12 and the table returns 1.0 above 0.10, so **the exposure** at
   every shipping daylight hour is unchanged to the bit.

   **The glare is not**, and I want that stated plainly rather than buried: the
   bloom threshold at high sun went 0.80 → 1.05 linear, the pyramid is two
   levels deeper at every hour, and the veil runs at gain 0.10 even at noon. So
   the daylight sheet *will* move — less small-highlight bloom (0.80 linear was
   0.91 on screen, so a fair amount of ordinary sunlit rock was over it), and a
   faint broad wash that was not there before. I did not re-judge the daylight
   sheet against its own references this round; someone should before this
   ships.

2. **PBR Neutral's black offset scales out at night.** Measured on `dome-h0`,
   this term alone was worth ×3.3 of level and more than halved the
   blue-to-red ratio (1 : 0.651 : **5.07** → 1 : 0.699 : **2.45**), because
   subtracting the minimum channel *is* a saturation operator and the minimum
   channel of a night sky is red. It also flattens the transfer: with the offset
   live, the response of the rendered night sky to exposure measured a **3.4
   power** (base exposure 0.44 / 0.55 / 0.70 / 0.88 → zenith luma 0.014 / 0.033
   / 0.081 / 0.144), so a 2× exposure change was a 10× screen change and the
   night level was not really settable by anybody.

3. **The contrast pivot and the toe come down at night too** (1.36 → 1.05, toe
   ×0.40). This is what un-greyed the ground: one constant added to all three
   channels of a dark pixel *is* a desaturation.

4. **A scotopic term that moves the ground and not the sky.** A shift toward
   `luma * uRodTint` (a strong blue at 1 : 2.88 : 11.7), gated twice — a
   *highlight* knee set well ABOVE the moonlit ground so a campfire or a
   headlight keeps its own colour, and a taper on the pixel's own blue lead,
   because a surface that is already blue has nothing for a rod response to
   shift. The second gate is what makes it safe next to Author A's dome:

   | | with the term | without it |
   |---|---|---|
   | `camp-h0` near ground | `#241f2c`, 1 : 0.772 : 1.430 | `#2d1f1e`, 1 : 0.534 : 0.492 |
   | `camp-h0` zenith | `#292055` | `#282055` |
   | `dome-h0` (all sky) | every statistic | bit-identical |

   i.e. the meadow goes from a warm brown to a cool blue-violet and the sky
   moves by one level of blue. Swept on amount against the plates' own night
   `chromaMean` (0.157 / 0.164 / 0.172): 0.45 → 0.162, 0.60 → 0.188. Held at
   0.50. Past ~0.7 the autumn meadow stops being an autumn meadow and starts
   reading as frost.

5. **Glare.** Threshold, knee, intensity and mipmap radius ramp with `lowSun`,
   and a third arm ramps them back at night so the moon keeps its halo and the
   stars stay points. `MIN_BLOOM_MIP` 12 → 7, which buys two more pyramid levels
   and with them the wide lobe.

   The threshold is in **linear** light on the merged pass's *input* buffer.
   The header comment in `Sky.js` describing bloom as running on the
   display-referred result is wrong — `BloomEffect.update()` is handed the
   `EffectPass` input buffer, which is the HDR scene straight off the guard
   pass, and the tone curve is an effect further down the same merged shader.
   0.80 there was 0.91 on screen, which a dusk sky peaking near 0.4 linear could
   never reach at any intensity.

6. **A veiling-glare term, which a mip bloom structurally cannot produce.** What
   makes `morning.jpg` read as looking into the light is a low-frequency wash
   across a third of the frame, not the halo. `VeilEffect` samples the smallest
   level of the bloom's own pyramid — five taps of a texture a few dozen texels
   wide — and adds it in linear before the tone curve. It is occlusion-correct
   for free: put the sun behind a ridge and the bright pixels are not in the
   pyramid, so the wash is not there either, which an analytic flare centred on
   the sun's projected position would get wrong.

7. **A magenta governor in the grade**, the mirror of the existing green one:
   green as the minimum channel with red *and* blue above it is the
   magenta/rose/violet sector and nothing else. `sunvista-h19` went from 23.8%
   of chromatic pixels in that sector to **6.0%**. It also nudges the night dome
   *toward* the plate — at the zenith it lifts green from 0.649 to 0.707 of red,
   against a target of 0.72.

8. **Twilight contrast and vibrance.** The glare opens the top of the curve; a
   contrast term on the same `lowSun` ramp takes the bottom back down, so the
   range grows from both ends rather than the frame sliding up. Vibrance comes
   *down* at twilight — it boosts by (1 − sat), so its largest effect is on the
   least saturated thing in the frame, which at dusk is the sky, and it was
   amplifying a mildly purple dome into a strongly purple one.

9. **`Atmosphere`: the Mie lobe points at the moon at night** (new
   `uFogScatterDir`, kept separate from `uFogSunDir`, which the cloud-shadow
   column walk still needs). For about a third of the cycle the inscattering
   glow was aimed at a sun several degrees below the terrain, which is to say
   nowhere. `shots/C-final/moon-h0.png` is what it buys.

### Before / after

Whole-frame `colorstats.mjs` at 1600×900. Before is `shots/BASELINE/`, the
pinned pre-round build; after is `shots/C-final/`.

| frame | lumaP05 | lumaP95 | lumaRange | contrastStd | chromaMean |
|---|---|---|---|---|---|
| `sunvista-h19` before | 0.291 | 0.614 | 0.322 | 0.097 | 0.349 |
| `sunvista-h19` **after** | **0.232** | **0.944** | **0.712** | **0.229** | 0.289 |
| `sunset.jpg` | 0.247 | 0.927 | 0.680 | 0.221 | 0.392 |
| `hero-h19` before | 0.263 | 0.612 | 0.349 | 0.113 | 0.358 |
| `hero-h19` **after** | **0.216** | **0.894** | **0.678** | **0.220** | 0.288 |
| `sunlow-h7.4` before | 0.241 | 0.826 | 0.585 | 0.178 | 0.347 |
| `sunlow-h7.4` **after** | 0.207 | 0.999 | 0.793 | 0.251 | 0.316 |
| `morning.jpg` | 0.390 | 0.980 | 0.590 | 0.195 | 0.183 |
| `camp-h0` before | 0.162 | 0.394 | 0.232 | 0.076 | 0.127 |
| `camp-h0` **after** | **0.068** | 0.258 | 0.190 | 0.073 | 0.128 |
| `ridge-h0` before | 0.161 | 0.168 | **0.007** | 0.003 | 0.083 |
| `ridge-h0` **after** | 0.092 | 0.266 | **0.175** | 0.059 | 0.150 |
| `night.jpg` | 0.028 | 0.336 | 0.307 | 0.101 | 0.172 |
| `night2.jpg` | 0.024 | 0.340 | 0.316 | 0.123 | 0.157 |

Point samples, `ladder.mjs --sky`, `dome-h0` zenith:

```
before   #232b3a   1 : 1.46  : 2.52    luma 0.024  (flat: all twelve points identical)
after    #433d61   1 : 0.826 : 2.127   luma 0.054  chroma 0.142
plate    #483a54   1 : 0.653 : 1.368   luma 0.050  chroma 0.102
```

`camp-h0` near ground, `#663221` (1 : 0.239 : 0.117, a warm brown) → `#313b5d`,
chroma **0.170** against `night.jpg`'s **0.169**.

### What did NOT work

- **Raising exposure at twilight.** The first arc put ×1.34 at `sunElev` 0.00.
  It took `sunvista-h19`'s `lumaP05` from 0.305 to 0.369 while `lumaP95` went
  only 0.866 → 0.929 — it bought top-end by giving away the black point, which
  is exactly the trade the lead's mid-round correction forbids. Cut to ×1.00.
  With Authors A and B's twilight sky in place, dusk needs no exposure help at
  all: the top-end comes from the glare and the bottom from the contrast term.
- **A low bloom threshold.** At `GLARE_THRESH_LO` 0.34 the whole dusk sky is
  over the line and the frame goes to white paper — the failure the note at the
  top of `Sky.js` records, reproduced exactly, at 41% near-neutral pixels.
  Swept on `sunvista-h19`, `lumaRange` at thresholds 0.60 / 0.90 / 1.20 / 1.60
  is 0.696 / 0.680 / 0.645 / 0.636. 0.72 is the last setting that admits the
  aureole without admitting the sky.
- **A luminance knee on the scotopic term set *below* the moonlit ground.** The
  obvious reading of "Purkinje should hit the dim end" put the knee at 0.055
  linear. That reaches the sky and not the ground, so the dome went violet while
  the meadow stayed the khaki it is at noon — the exact inverse of the plates.
- **A warm/saturation exemption on the scotopic term.** Intended to protect a
  campfire; it protected the khaki meadow instead, because moonlit autumn ground
  is also warm and also saturated. Replaced with the blue-lead taper, which
  separates them on the axis that actually differs.
- **Chasing the night level by exposure alone.** With the tone-curve offset live
  the transfer is a 3.4 power, so the exposure that moved `dome-h0` from 0.016
  to 0.052 would have been wrong again the moment anybody's night radiance moved
  20%. Fixing the curve was the robust move; the exposure table then needed
  *less*, not more.
- **Two measurements that were both wrong because the tree moved under them.**
  Mid-round I twice tuned against a `sunvista-h19` that was measuring
  `lumaP95` 0.866 with all my terms off, where the pinned baseline measured
  0.614. Anything in this file that is calibrated against another author's
  radiance has to be re-derived when theirs settles; `tools/postsweep.mjs`
  re-derives the whole set in one boot, which is why it exists.

### Performance

**The wall-clock `perf.mjs` numbers this round are not usable as a delta and I
am not going to pretend otherwise.** Before: p50 23.2 ms / p95 49.9. After:
p50 36.2 / p95 83.3. Both runs are on a box that had four agents' headless
Chromium world bakes on it, and the "after" run had more of them — the note in
this file about how the per-effect cost table was measured says exactly why two
processes minutes apart cannot be compared here.

So the additions were measured the way that note prescribes: two arms
alternated **inside one page load**, every 45 frames, 14 blocks, so the
machine's load hits both arms equally and cancels in the ratio
(`tools/_scratch/veilcost.mjs`). Arms are the round's chain (two extra bloom
pyramid levels from `MIN_BLOOM_MIP` 12 → 7, veil live) against the pre-round
shape (two fewer levels, veil off):

```
ship  median 24.05 ms   blocks 39.93 23.60 21.34 23.59 23.76 23.87 23.49 …
prev  median 25.02 ms   blocks 36.22 22.07 24.05 22.99 24.05 25.02 24.91 …
paired ratio median 1.0025   delta +0.25%
```

**+0.25%, inside the noise**, and the block series shows why you have to pair:
the machine drifts from 21 ms to 35 ms across the run and both arms drift
together. Structurally this is what you would expect — the two extra mip levels
are a 14x8 and a 7x4 render target, about 130 texels of work between them, and
the veil is five taps of a texture small enough to be resident in cache for the
whole frame, inside a fragment program that already exists. Everything else
this round changed is a uniform write.

`perf.mjs`'s black-frame sampler reports **0 of 8** frames black during motion
with the deeper mip chain, which was the standing worry attached to
`MIN_BLOOM_MIP`. `tools/skystrip.mjs --view drive` over six frames at 0.23 s
intervals shows no bloom pumping: draw calls 463-466 and triangle counts stable
to five significant figures across the strip, and no frame-to-frame swing in
the glare.

### Assumptions about A's, B's and D's work

- **The frame's absolute level is authored against the tree as it stood at the
  end of this round**, not against the baseline. If A's or B's radiance moves
  again, the two numbers to re-derive are the low half of `EXPOSURE_LOW` and
  `nightOffset`, and `tools/postsweep.mjs --views dome,camp --hours 0` re-derives
  both against the plate targets in a single boot.
- I have assumed A owns the residual 1.5× blue and 1.4× chroma in the night dome
  and that they will **not** compensate for the three constants I scaled out
  underneath them. The number to author against is 1 : 0.72 : 1.60 at chroma
  0.102 measured *after* this chain.
- I have assumed B will bring the night ground down relative to the sky rather
  than the sky up to meet it, and that the scotopic term will eventually be able
  to come down as a moon key takes over supplying the cool cast.
- I have assumed the bloom threshold moving from 0.80 to a ramp is compatible
  with D's rim authoring. It is now 1.05 linear at midday and 0.72 at the
  horizon, so a rim authored to cross 0.80 will still cross it near sunset and
  will *not* near noon. If the deck's limb stops blooming at midday, that is
  this change and I would want to know.

### Still not good enough

1. **`sunlow-h7.4`'s zenith is clipped to pure white** — `#ffffff`, chroma
   0.000, against `morning.jpg`'s `#fefcf0` at chroma 0.055. The plate's sky is
   near-white too, but it is not *clipped*, and 15% of our frame is
   near-neutral against the plate's 7.4%. That view is the one place the glare
   is doing too much.
2. **The night meadow is the brightest thing in the night frame.** The
   distribution matches the plates on paper — `camp-h0` `lumaP95` 0.258 against
   `night.jpg`'s 0.336 — but the plates put their brightest 5% in a lit tent
   and ours is moonlit grass across the whole lower half. It reads as frost.
   That is a ratio, filed to B, but it is the biggest remaining night defect and
   it is visible in `shots/C-final/camp-h0.png` at a glance.
3. **Night `lumaRange` is short**: 0.190 and 0.175 on `camp-h0` and `ridge-h0`
   against the plates' 0.307 and 0.316. Same cause as (2) from the other end —
   with no practical in frame there is nothing at the top.
4. **The vehicle's meadow at h0 reads mauve-pink**, not blue. The scotopic term
   runs *after* the magenta governor in the grade, so it can push a pixel into
   the magenta sector after the governor has had its look. Reordering them is a
   one-line change I did not have the captures left to validate.
5. `dome-h19` `lumaP05` is 0.482. It is a sky-only framing so it is not directly
   comparable to `sunset.jpg`'s 0.247, but the `lumaRange` of 0.456 against
   0.680 says the upper dome still has no darks in it.
