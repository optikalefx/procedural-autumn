# Marshmallow roasting — critic findings, round 3

Judged against `docs/CRITIC_PROTOCOL.md`, `docs/ROAST_CRITIC_ROUND.md`,
`docs/ROAST_CONTRACT.md`, `docs/DESIGN_BRIEF.md`.
Material: `shots/roast/r1` (25 frames), `shots/roast/r3` (34 frames),
`shots/roast/sheet-r3.png`, `shots/roast/ab-r1r3/`.

**Verdicts: 1 prop REJECT · 2 composition REJECT · 3 marshmallow REJECT ·
4 fire relationship REJECT · 5 feel CLOSE.**

The headline is not any single defect. It is that **round 3 loses the blind A/B
on the money shot and on the discovery test** — the two views the round exists
to produce — and it loses them for one identifiable reason that is documented in
the source and can be undone in an afternoon.

---

## 0. Method notes, including one against this round's own protocol

- The round doc orders **read every frame → then blind A/B**. Those two steps
  are incompatible for one critic: by the time I reached step 3 I could
  identify every r3 frame on sight. I recorded per-view calls before revealing
  and my side-identification was correct 8/8, so the A/B tested my *preference*
  under a hidden key, not my *recognition*. Treat the calls below as honest
  preferences, not as blind ones. If the lead wants a real blind A/B, it has to
  be run by someone who has not read the round's frames.
- Measurements below come from `tools/colorstats.mjs` and from three ad-hoc
  probes over `tools/_pngread.mjs` (region luma, high-pass correlation,
  local-gradient area). Every controlled comparison uses frames that differ in
  exactly one variable, with a background control region measured alongside.

### One claim of my own that I withdraw

Reading `strip-0..7` at 3× I was certain the blister stipple was screen-locked —
that the surface detail did not rotate and only the char decal slid. It is not
true. High-pass (detail-only) correlation of the pink near face between
`strip-0` and `strip-1` (a 45° step, doneness held constant at 0.28) is
**r = 0.049**; against `strip-4` it is **r = −0.005**. The stipple decorrelates
completely across a rotation step. The surface *does* turn with the mesh. What
my eye read as "identical" is the real defect and it is a different one — see
element 5.

---

## 1. Blind A/B: r1 (`a`) against r3 (`b`) — calls, then the reveal

Calls written before `--reveal`; the key is `a = shots/roast/r1`,
`b = shots/roast/r3`.

| view | my call, before reveal | reveal | result |
|---|---|---|---|
| `held-clean` | **LEFT wins, decisively.** LEFT has three depth planes (ring stones / tent + woodpile / grass + trees); RIGHT has one plane of boulders against a featureless wash. LEFT's fire ring reads as *a ring of stones round a fire*; RIGHT's stones are so close and so large they read as a boulder field. LEFT's marshmallow is a small bright bead that reads as sugar and takes the eye instantly; RIGHT's is a brown blob the eye skips. LEFT has a red tent, green grass patches and gold grass; RIGHT is one hue. | LEFT = r1 | **r3 LOSES** |
| `prop-wide` (discovery test) | **LEFT wins, decisively.** LEFT is an open readable camp — three chairs, tent, fire, dog, forest, mountains. RIGHT has the camper's flank eating the left third of frame and hiding the half of camp the stick is in. *Neither side contains a findable roast stick — both fail the stated question.* | LEFT = r1 | **r3 LOSES** |
| `ladder-5` (char) | **LEFT wins.** LEFT's marshmallow is a black disc with hot veins and reads as burnt. RIGHT's, at doneness 0.95, is a pale pink pom-pom with brown flecks — it reads as a slightly dirty *raw* marshmallow. | LEFT = r3 | r3 wins |
| `ladder-2` (gold) | **Split.** LEFT keeps value discipline (does not out-value the flame); RIGHT's marshmallow is the brightest object in frame with a magenta bloom halo — it breaks the standing rule. But RIGHT wins composition, depth and sense of place by a wide margin. *Neither reads as gold*: LEFT is walnut-brown, RIGHT is white-hot. | LEFT = r3 | split |
| `burning` | **Split, slight tilt LEFT.** LEFT at least sits the marshmallow in contact with the flame column; RIGHT has it at the fire's edge with nothing happening. RIGHT wins the picture. *Neither side shows a marshmallow that is on fire.* | LEFT = r3 | split |
| `prop-fq` | **Narrow tilt RIGHT** on frame quality (composed camp, mountains, sky). LEFT wins prop legibility — its stick is thicker and lighter-valued and its marshmallow reads as a tan cylinder; RIGHT's is a black hairline with a grey blob. Both fail "does it read as a whittled stick". | LEFT = r1 | r3 wins, narrowly |
| `dusk-held-clean` | **RIGHT wins the assignment.** LEFT is not a first-person roast frame at all — it is a third-person night camp with the full driving HUD (speedometer, trip meter, compass, minimap, three toolbar buttons). RIGHT is at least the shot that was asked for. **LEFT is the better picture**, and it proves this game has a beautiful violet-blue night that RIGHT throws away entirely. | LEFT = r1 | r3 wins on the brief only |
| `held-enter` | **Split.** LEFT is the useful frame — actually mid-move, stick in hand, destination visible. RIGHT is a far prettier picture but it is the *pre*-transition camera, contains no stick, and proves nothing about the step-in. | LEFT = r1 | split |

**Net: r3 wins the marshmallow-object views and loses the two composition views
that the round is for.** A round whose new side loses the money shot did not
improve the money shot, whatever the report says.

### A defect r1's harness certified as clean

`shots/roast/r1/ROAST.json` records, for `dusk-held-clean`:
`{"overlayOK": true, "reticle": false, "prompt": ""}` — and it also records a
plausible roast `state` with `eyeH 1.12, seatOut 1.55, pitch 22°`. The frame it
certified is a third-person night camp **covered in driving HUD**. The view had
not entered; the check only interrogated the roast view's own overlay and never
looked at the game HUD, so it passed a frame that is nothing *but* HUD.
Textbook `CRITIC_PROTOCOL.md` "instrument that is confidently wrong": a clean
number attached to the wrong object.

**r3's harness fixed exactly this** — it added `uiCount`, `ui[]`, `hudOp`,
`camGap`, `mallowPx`, per-frame `fail[]` and a top-level `failures[]`, and all
34 r3 frames pass with `failures: []` and `uiCount: 0` on every clean frame.
That is the one piece of unambiguously SHIP-quality work in this round, and it
is what let me find the root cause in §3. Say so to its author.

---

## 2. Element verdicts

| # | element | verdict |
|---|---|---|
| 1 | the prop | **REJECT** |
| 2 | the composition | **REJECT** |
| 3 | the marshmallow | **REJECT** |
| 4 | the fire relationship | **REJECT** |
| 5 | the feel (twirl) | **CLOSE** |

---

## 3. Element 2 — the composition. REJECT.

This is first because it is the root cause of half of everything else, and
because it is the cheapest thing in the report to fix.

### D2-1 · The camera left the contract, and the contract was right *(rank 1)*

`docs/ROAST_CONTRACT.md` §3: *"Seated eye height at the fire's edge — 1.12 m
above the ground, 1.55 m out from the fire's centre, pitched down about 22
degrees."*

| | contract | r1 | r3 |
|---|---|---|---|
| eye height | 1.12 m | **1.12** | **0.86** |
| seat distance | 1.55 m | **1.55** | **0.86** |
| pitch | ~22° | **22.0°** | **30.0°** |
| vertical FOV | — | — | 34° |

r1 was on the contract exactly. r3 dropped the eye 0.26 m, moved in to **55% of
the specified distance**, pitched 8° further down and narrowed to a 34° FOV.
Four changes all pushing the same way. Frames: `held-clean`, `dusk-held-clean`,
every `ladder-*`, every `strip-*`, `uneven`, `burning`.

Measured consequence: **77.2%** of `r3/held-clean` carries near-zero local
gradient — three-quarters of the money shot is image with nothing in it.
Comparison on the same measure: `r1/held-clean` 65.6%, `r3/held-enter` 28.7%,
`r3/prop-side` 36.9%.

Go back to 1.12 / 1.55 / 22°. If the fire needs to be bigger in frame, take it
from FOV, not from distance — distance is what buys the mid-ground.

### D3-2 · The fire's light is clamped to a hard edge, and the edge is visible *(rank 2)*

`camp_roast_view.js:1689` (`_dampHearth`) rewrites the campfire's light on
arrival: `decay 1.4 → 2.0`, `distance 8.6 → 4.2 m`, `intensity × 0.62`. It is
documented at length, restored on exit, and the *reasoning is correct* — the
stones genuinely do get lit and shaded faces back, which r1's frames do not
have. Credit that.

The instrument is wrong. A three.js point light with `distance` set does not
fall off smoothly to nothing; it **clamps to zero at exactly that radius**. On a
flat dirt clearing seen from 0.86 m at 30° down, that clamp projects as a
straight line, and it is measurable in every first-person frame at both hours:

| frame | seam row | horizontal extent | step |
|---|---|---|---|
| `dusk-held-clean` | y = 555 | x 314 → 1309 | 2 px |
| `burning` | y = 556 | x 329 → 1306 | 2 px |
| `uneven` | y = 561 | x 334 → 1310 | 2 px |
| `ladder-3` | y = 563 | x 332 → 1307 | 2 px |
| `held-clean` | y = 667 | x 395 → 1222 | 2 px |

At x = 700 in `uneven.png` the value drops from 163 to 105 across two rows.
That is a ~1000-px-wide hard edge sitting through the middle of the frame, and
in the contact sheet it is visible as the same flat cut across the fire's glow
in 22 of 34 tiles.

Above the line, `dusk-held-clean` measures mean linear luma **0.031** over a
500×240 sample — that is not "the frame's dark group", that is nothing. The
note's stated win, *"the far grass keeps its own colour"*, did not happen: the
far grass gets no light at all.

Also worth having: the stated goal was to recover contrast, and frame-wide
`contrastStd` went 0.151 (r1) → 0.148 (r3). Essentially unmoved.

Fix: keep the decay and intensity changes, drop the `distance` clamp back out
past the tent, and get the falloff from the exponent rather than from a cutoff.

### D2-3 · The frame is one hue, and it is measured *(rank 3)*

Cool half of chromatic pixels (cyan + azure + blue + violet + magenta + rose):

| frame | red | orange | **cool** |
|---|---|---|---|
| reference plate 3 (`10.29.49`) — the brief's own eye-level comparator | 37.3% | 24.5% | **35.5%** |
| reference plate 5 (`10.30.57`) | 47.6% | 39.2% | **13.2%** |
| `r3/held-clean` | 96.0% | 4.0% | **0.0%** |
| `r3/dusk-held-clean` | 96.2% | 3.6% | **0.2%** |
| `r1/dusk-held-clean` | 6.2% | 0.3% | **93.7%** |

`DESIGN_BRIEF.md` is explicit that eye-level views are judged against plate 3
and that driving the cool out is the error that "did real damage" last time.
r3's frames are the most hue-collapsed in the project: two buckets, 100% warm.

Note the r1 column. r1 was 93.7% cool and r3 is 99.8% warm. Nobody walked to
this from a considered position — the round swung from one wall to the other.
The answer is between them, and plate 3 says roughly where.

### D2-4 · The arrival throws away the best frame in the set *(rank 4)*

`held-enter.png` — trees, mountains, sky, gold grass, the whole camp reading at
a glance, 28.7% low-detail — is the finest frame either round produced, and it
is the frame the player sees for 0.75 s on the way to `held-clean`, which is
77.2% dirt. The transition currently reads as a downgrade. Whatever the arrival
pose becomes, it must keep some of what `held-enter` has: a horizon, a tent, a
tree line, one non-orange object.

### D2-5 · No size hierarchy in the fire ring *(rank 5)*

`dusk-held-clean`, `held-clean`: six near-identical smooth lumps around the rim,
all within about 15% of the same screen size, evenly spaced. `DESIGN_BRIEF.md`
names this: *"Every object the same size — no size hierarchy."* One big anchor
stone, two mid, three small, unevenly spaced, and one of them tucked partly
behind another.

### D2-6 · The logs inside the fire are pure black *(rank 6)*

`dusk-held-clean`, `held-clean`, `dusk-held`: the burning logs measure as
silhouette, unlit, in the middle of a fire. Logs sitting in a fire are the
brightest solid objects in the frame. This is the most physically wrong thing in
the composition and it is right at the optical centre.

---

## 4. Element 1 — the prop. REJECT.

### D1-1 · It is a black hairline, not a stick *(rank 1)*

`prop-fq`, `prop-side`, `prop-back`: a perfectly straight, perfectly uniform-
diameter, near-black rod. Zero taper, zero bend, zero bark, zero whittle facets,
zero knots. It reads as a TV aerial or a length of black wire. Nothing in the
silhouette says "somebody cut this off a hazel and shaved the end".

Give it: a slight bend (a real stick is never straight), a taper from ~14 mm at
the butt to ~7 mm at the tip, two or three flat whittle facets on the last
150 mm with a pale exposed-wood value against darker bark, and one knot stub.

### D1-2 · The stick has no mid-value; it goes black in daylight and pink in firelight *(rank 2)*

Same object, two rounds of the same frame set:
- `prop-fq` / `prop-side` / `prop-back` (hour 16.7, daylight): near-black against
  bright grass — a silhouette line.
- `mallow-backlit`, `dusk-held-clean`: a clean pale pink tube with a specular
  highlight running its entire length, and at dusk it is the brightest *linear*
  element in frame, pulling the eye harder than the marshmallow does.

The lead's "pale pink plastic tube" is confirmed at dusk and in the macro. But
it is the pair that matters: the albedo has no mid anchor, so it clips to black
under sun and to the light's colour under the fire. A whittled hazel stick wants
to sit around a mid warm tan (roughly `#8a6a45` bark, `#c8ab7e` shaved) and stay
there in both lights. It also wants roughness up — that full-length specular
line is the brief's "sharp, un-graded specular hotspot".

### D1-3 · It fails the discovery test *(rank 3)*

`prop-wide` is the discovery test and I cannot find the stick in it — the
camper's flank occupies the left third and occludes the part of camp the stick
and its table are in. **r1's `prop-wide` was a better camp frame and also
contained no findable stick.** So the prop has never passed its own test, in
either round. Frames: `prop-wide` both rounds.

Two things needed: reframe `prop-wide` so the table is actually in shot (it is
at `-1012.63, -1004.91`, the stick at `-1012.21, -1005.36`), and give the prop
something that catches at 8 m — the marshmallow being *white* would do it on its
own, see D3-1.

### D1-4 · From three of four angles the prop is occluded by a camp chair *(rank 4)*

`prop-side` and `prop-back`: all you can see is the marshmallow tip poking above
the chair back and a thread of stick. `prop-fq`: the stick's supported end runs
off the bottom-right corner, so there is no visible contact point at all and the
stick appears to float. The placement rule in `camp_site.js` passes the
separation tests but not a legibility test. Offset it along the table so it
clears the chair from the two most likely approach bearings.

### D1-5 · The prop's marshmallow is grey-tan, and it does not match the held one *(rank 5)*

In `prop-fq`/`side`/`back` at `toast = 0` the marshmallow is a small grey-brown
lozenge that reads as a cork or a wingnut. The held marshmallow at the same
`doneness = 0` (`mallow-0`) is pink-cream. Same object, two materials — the prop
is still wearing the placeholder `MeshStandardMaterial` the contract tells the
geometry author to build it with, and nobody replaced it on the prop path.

---

## 5. Element 3 — the marshmallow. REJECT.

### First, what is right, because it is worth protecting

- **The geometry is correct and the lead is wrong about it.** ROAST.json records
  the mesh bounding sphere at **r = 23.4 mm**; the contract's 25 mm × 21 mm
  squat cylinder has a bounding sphere of 24.4 mm. It is within a millimetre.
  And `mallow-0`, `mallow-1` and `mallow-uneven` at macro read plainly as a
  squat cylinder with a generous edge radius, *not* a capsule and *not* a
  sphere. The "small potato" read is real in `held`/`dusk-held`/`ladder-*` but
  it is caused by D3-1 and D3-2 below, not by the mesh. **Do not touch the
  geometry.**

### D3-1 · The toast ramp is a value collapse, not a colour ramp *(rank 1 — fix this first)*

Controlled: `mallow-0..5` are the same camera, same pose, same hour, differing
only in doneness. Background control measured alongside.

| doneness | body mean linear luma | background control |
|---|---|---|
| 0.00 raw | 0.2664 | 0.2215 |
| 0.20 warmed | 0.1694 | 0.2164 |
| 0.42 **gold** | **0.0747** | 0.2157 |
| 0.60 dark gold | 0.0441 | 0.2155 |
| 0.78 mahogany | 0.0313 | 0.2155 |
| 0.95 char | 0.0457 | 0.2155 |

Three separate failures fall out of that column:

1. **The marshmallow goes darker than the dirt behind it at about doneness
   0.15.** At the *target* result band — "gold", 0.42 — it is **2.9× darker than
   the ground**. A gold-toasted marshmallow is still a high-value object. It
   should be losing perhaps 25% of its value by 0.42, not 72%.
2. **The value ramp is non-monotonic.** Char (0.95) measures *brighter* than
   mahogany (0.78), because the char cracks light it back up. The contract says
   char is matte black.
3. **In the actual gameplay frame, four of the six rungs are the same blob.**
   Measured on the marshmallow's own box in `ladder-0..5`: 0.333 → 0.274 →
   0.123 → 0.057 → 0.033 → 0.044, against a frame background of 0.173. Rungs
   3, 4 and 5 lie within 0.024 of one another. The contract's own rule is *"That
   line is the ONLY score this game shows"* — the player is supposed to read
   doneness off the picture, and past 0.5 they cannot.

The whole perceptual range of the ramp is spent in the first 40% of its domain.

### D3-2 · There is no cream and no gold anywhere in the ramp *(rank 2)*

Hue histogram of the marshmallow body across the macro ladder (buckets are 15°
wide, chroma threshold 20):

| rung | dominant buckets |
|---|---|
| `mallow-0` raw | 15°: 98.4%, 30°: 1.6% |
| `mallow-1` | 15°: 85.0%, 30°: 14.5% |
| `mallow-2` gold | 15°: 59.6%, 0°: 38.4% |
| `mallow-3` | 0°: 81.6%, 15°: 18.4% |
| `mallow-4` | 15°: 84.4%, 0°: 15.3% |
| `mallow-5` char | 30°: 53.1%, 15°: 29.3%, 0°: 17.6% |

Every rung lives in the 0–30° red-orange band. **There is no yellow (45–60°) at
any point in a ramp whose contract reads "cream → gold → amber → mahogany →
black".** For scale: the *dirt background* in the same frames measures
`172,115,57` — hue ≈ 30° — so the marshmallow is redder than the mud it sits
against at every single rung, including raw.

The fire's light is orange and will pull everything warm, so some of this is
expected. It cannot account for raw sugar measuring 98.4% at hue 15° with an
average RGB of `197,121,76`. That is salmon. The contract asks for `≈0xe8e0cf`,
a cream that is very slightly *green*-of-neutral. Combined with D3-1, this is
the contract's own named failure verbatim: *"A single linear ramp reads as a
stain."* It is a value walk at a fixed hue.

### D3-3 · Translucency is not implemented in any measurable amount *(rank 3)*

`mallow-backlit` is the test frame for the contract's non-negotiable #2 —
*"The single detail that makes it read is light coming through the far side …
Without that it is a pill."*

Horizontal traverse at y = 430, entering from the bright background on the left:

```
x=540  0.541   ← background
x=570  0.338
x=600  0.204
x=630  0.122   ← LIMB. the darkest point of the entire traverse
x=690  0.182
x=840  0.322   ← centre, the brightest point of the body
x=960  0.139   ← far limb
x=1080 0.551   ← background again
```

Body mean 0.252 against a background of 0.503 — the marshmallow is exactly half
the value of the field it is silhouetted against, and it is **darkest at the
limbs and brightest in the middle**. That profile is the signature of an opaque
diffuse body lit from the front. A back-scattering body does the opposite: it
peaks at the limb where the path through the material is shortest. A separate
30-px sample of the left rim (`rimLeft`) measures 0.232, *below* the body mean —
there is no rim lift at all.

This is the single most important missing thing on the object. Every other
marshmallow defect is a tuning problem; this one is a term that is not there.

### D3-4 · The blisters are craters, and worse, they are homogeneous *(rank 4)*

The lead is right that they read as craters — `mallow-backlit` shows them
unambiguously as sharp dark elliptical pits, and `mallow-2` reads as a golf ball
or a lunar surface. Real toasting blisters are *raised* domes that catch a
highlight on their crown.

The more damaging property is the distribution. In `mallow-0` the raw
marshmallow already carries a full-density isotropic sandpaper stipple over its
entire surface — raw marshmallow does not blister at all, and this reads as
pumice or sandblasted foam, not powdered sugar. The density does not vary with
doneness, does not cluster, and has no size range: same pit, same spacing,
everywhere, on every rung.

That homogeneity is also what breaks the twirl — see D5-1.

What is wanted: **nothing** on raw; from about doneness 0.25, sparse raised
domes 1.5–4 mm across, clustered where the toast map is hottest, at maybe a
tenth of the current count, browner at their crowns than in the valleys between
them, growing in count and size with local toast.

### D3-5 · The near end face is a crater, so the object reads as a doughnut *(rank 5)*

`mallow-0`, `mallow-2`, `mallow-4`, `mallow-uneven`: the stick does not pierce a
flat end; it sits at the bottom of a deep countersunk dish about 40% of the
marshmallow's diameter across. From the composed macro angle this dish is the
dominant read and the object is a bagel. The contract says *"flat ends that
**dent slightly** where the stick goes through."* Take it to maybe 8% of
diameter and 2 mm deep.

### D3-6 · The mahogany rung is turned wood; the char rung is lava *(rank 6)*

- `mallow-4` (0.78): the surface is a set of **concentric ring ridges** centred
  on the stick hole. It reads as a lathe-turned wooden bowl or a tree's growth
  rings. Whatever is generating them is working in the raw `v`/radial parameter
  with no domain warp. Also scattered along those ridges are hard cream specular
  slivers — the brief's "sharp, un-graded specular hotspots".
- `mallow-5` (0.95, `burning: false`): the char cracks are long, smooth, curved,
  near-fully-saturated **red-orange worms**. Two things wrong. They are worms,
  not a cellular network — real char cracks are a polygonal break-up with
  three-way junctions. And they glow, on a marshmallow that is *not alight*
  (`burning: false`, and the contract puts the orange-in-the-splits behind a
  high live-heat channel). A cooled charred marshmallow is matte black with grey
  ash, full stop.

---

## 6. Element 4 — the fire relationship. REJECT.

### The standing rule PASSES. Check it off.

*"If the marshmallow is the brightest thing in the dusk frame, that is a
REJECT."* Measured on `dusk-held-clean`, linear luma:

| region | mean | p95 | p99 | max |
|---|---|---|---|---|
| marshmallow | 0.241 | 0.441 | 0.558 | **0.591** |
| flame core | 0.468 | 0.739 | 0.800 | **0.812** |
| whole frame | 0.097 | 0.394 | 0.667 | 0.812 |

The marshmallow's brightest pixel is below the flame's p95. The fire owns the
top of the range at dusk, comfortably, and the marshmallow still sits at 2.5×
the frame mean so it remains the subject. **This is r3's clearest win and it is
the one hard gate the round had. Do not regress it.**

One caveat: at the **default hour** it is a tie and slightly the wrong way.
`held-clean`: marshmallow max 0.7478 = flame core max 0.7478, and marshmallow
p99 **0.6605** against flame p99 **0.6318**. The raw sugar's upper range edges
past the flame's. Worth 10% off the raw albedo.

### D4-1 · The flame that sits on a burning marshmallow is a detached hard-edged cone *(rank 1)*

`mallow-burning`: a solid yellow-white **truncated cone with flat facets and a
hard silhouette**, floating clear of the marshmallow, above it and to its right,
not touching it. It reads as a low-poly party hat or a spotlight cone. It has no
soft edge, no taper to a point, no suggestion of flicker, and — decisively — it
casts no light on the marshmallow directly beneath it, which stays dark brown.
This is the single least shippable object in the whole round.

### D4-2 · Neither `burning` nor `mallow-burning` shows a marshmallow that is on fire *(rank 2)*

In `burning.png` (`burning: true`, height 0.35) the marshmallow sits entirely
*above* the campfire's flame tip, silhouetted against flat dirt, in contact with
nothing. The r1 side of that A/B pair shows the same thing from further out. The
frame that is supposed to prove "alight" proves the opposite: the marshmallow
looks like it is being held near a fire, not in one.

### D4-3 · At low height the marshmallow is occluded by the ring stones *(rank 3)*

`uneven.png` (height 0.14) puts the marshmallow at the bottom-right of the flame
and **behind a fire-ring stone**. `ROAST_CONTRACT.md` §3: *"it must never clip
the near stones."* The height band 0.10–0.55 m is fine; the seat position that
makes 0.14 m go behind a rock is not (see D2-1 — this goes away at 1.55 m out).

### D4-4 · The campfire mesh is a hard-edged translucent polyhedron *(rank 4)*

Clearest in `uneven.png` and `burning.png`: an octagonal lozenge with straight
edges, visible flat facets and a hard alpha silhouette, cut across the middle by
the D2-2 seam. In `dusk-held-clean` and `held-clean` the same mesh is bloomed
into a formless white smear with a ghost polygon edge still visible at
(930, 320)–(970, 430). The fire reads as glass at one exposure and as fog at the
other, and never as fire.

This is `camp_fire.js`, not a roast-author file — but element 4 is *the
relationship*, and no marshmallow work will land while the thing it is meant to
be lit by looks like this at 0.86 m. Raise it with the fire's author; it has
never before been seen from this distance.

### D4-5 · The marshmallow does not sit in the fire's light gradient *(rank 5)*

`dusk-held-clean`: the marshmallow is lit as a roughly uniformly-shaded ball. In
a real fireside frame the face toward the flame is a stop and a half hotter than
the face away, with a visible terminator running down the cylinder. There is no
such terminator here. `uFireDir` exists in the contract's uniform list; whatever
it is driving is not producing a directional read at this scale.

---

## 7. Element 5 — the feel (twirl). CLOSE.

Judged from `strip-0..7` read as a strip at 3× (`/tmp/strip-r3.png` method:
crop 180 px around the marshmallow, zoom 3, tile 4×2), plus two measurements.

**What works, and it is more than I expected:** the marshmallow is genuinely
eccentric to the twirl axis — its silhouette centre and its axis tilt both
visibly precess between `strip-1` and `strip-5`, which is exactly the contract's
*"5–12 mm of offset and a few degrees of tilt … a marshmallow perfectly
concentric with the stick is invisible when it spins."* Somebody read that
paragraph and did it. And the surface detail rotates with the mesh (r = 0.049
across a 45° step). And the char band does migrate: dark-pixel fraction peaks in
the left third at `strip-2` (11.3%), the middle at `strip-4` (18.3%) and the
right third at `strip-3` (16.8%). The rotation is real.

It still does not read as turning, for two nameable reasons.

### D5-1 · The blister field has no landmarks, so rotation is invisible *(rank 1)*

This is D3-4 cashing out in motion. Because the stipple is isotropic and uniform
in size, spacing and contrast, rotating it produces a field that is *different*
but *indistinguishable* — there is nothing for the eye to track. My own reading
of the strip was that the texture did not move at all, and I was measurably
wrong; if the critic staring at it at 3× cannot see the rotation, the player at
100 px will not.

Fix is the same fix: a handful of large blisters, clustered, with real value
contrast, so the eye has something to follow round the body. Three or four
landmarks is enough.

### D5-2 · The char sweeps across the rim but never crosses the near face *(rank 2)*

Through the full 2π of `strip-0..7`, at `evenness 0.305` — a marshmallow that is
supposed to be badly one-sided — the black band only ever occupies the upper-left
rim. The near face, which is most of the silhouette, never darkens. Peak dark
fraction anywhere in the box is 18.3%, and at `strip-6` and `strip-7` the char is
gone entirely (0.0% dark in all three column thirds). The contract's whole
premise — *"a marshmallow that is not turned goes black on one side and stays
white on the other"* — is never visible from the seat. Either the toasted patch
is anchored to the away-facing hemisphere, or the map's `u` is not being
advanced by the spin the way the render is.

### D5-3 · Raw goes to black in about six pixels *(rank 3)*

At 3× the boundary between the raw pink body and the black char band is roughly
6 px wide with a single thin brown line in it, and along it you can count the
bilinear steps of the 24×12 toast map — a stairstepped, aliased edge with a
lighter tan halo just outside it. The contract asks for the opposite shape:
*"the sweep from cream to gold is slow and smooth, the sweep from deep amber to
black char is fast and blotchy."* There is currently no cream→gold leg at all on
the uneven case, and the fast leg is a clean hard edge rather than a blotchy
one. Break the terminator up with the same noise field that drives the blisters.

### Not judged

The sag, the drop, the arrival ease and the eat beat have no captures in this
round. `sag` reads 0.000 at every doneness up to 0.60 and only reaches 0.429 at
0.95 — and `dusk-held-clean`, the money shot, is at doneness 0.565 with
**sag = 0**. So the money shot shows a marshmallow that has swollen (0.924) and
not slumped at all. A real one at that point is visibly drooping off the stick,
and that droop is most of what says "this is nearly ready". Bring the sag
forward into the 0.45–0.7 band and capture a stepped sequence of the drop.

---

## 8. Ranked, across the whole round

If four authors each take one thing, take these four:

1. **Composition** — put the camera back on the contract (1.12 / 1.55 / 22°) and
   replace the `distance: 4.2` light clamp with a smooth falloff. Two numbers
   and one line. It fixes the seam, the dead background, the boulder-field read,
   and most of the hue collapse.
2. **Marshmallow / toast** — re-author the ramp as a colour ramp with a value
   floor: raw stays high-value and slightly cream, "gold" holds roughly 75% of
   raw's value and actually passes through yellow, and only the last third
   crushes. Then add the wrap/back-scatter term, which is currently absent.
3. **Marshmallow / surface** — sparse, clustered, *raised* blisters with a size
   range and real contrast; nothing on raw; kill the concentric ring ridges and
   the countersunk end-face crater; re-do the char cracks as a cellular network,
   matte black, with the orange gated behind live heat.
4. **The prop** — bend it, taper it, whittle it, give it a mid-value bark that
   survives both lights, replace the placeholder material on the prop path, and
   move it clear of the chair. Then reframe `prop-wide` so the table is in it.

Everything else in this document is downstream of those four.
