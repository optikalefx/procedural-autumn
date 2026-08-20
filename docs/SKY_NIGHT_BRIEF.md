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
