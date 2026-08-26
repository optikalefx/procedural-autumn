# The journal — notes

Owner A of the scavenger hunt (`docs/HUNT_CONTRACT.md`). This is the record of
what the book is, what it costs, what was tried and thrown away, and what the
integrator has to wire.

---

## 1. What was built

`src/journal/` — five modules, and the split is by *what changes together*:

| file | what it owns |
|---|---|
| `Journal.js` | the public class, the overlay scene/camera/lights, the ceremony script, input, `render()` |
| `journal_model.js` | `buildJournal(rnd, opts)`, `poseJournal`, `deformPage`, `samplePage`, materials, `JOURNAL_COLORWAYS` |
| `journal_page.js` | `JournalPage` — one leaf, painted to a CanvasTexture: layout, pencil, tape, photos |
| `journal_textures.js` | procedural leather (albedo + normal + roughness from one height field), endpaper, contact shadow, blank stock |
| `journal_fonts.js` | the two self-hosted faces and the promise everything paints behind |

Plus `public/fonts/caveat.woff2`, `public/fonts/caveat-brush.woff2`,
`public/fonts/OFL.txt`.

The model is discovered by `gallery.html` through the `build<Thing>(rnd, opts)`
convention with no registry edit: three colourways from `JOURNAL_COLORWAYS`, and
an `open` slider from `clamp01(opts.open ?? 0)`. Verified — see §6.

## 2. Public API (as built)

Exactly the contract, plus three additions, all additive:

```js
export class Journal {
  constructor(ctx)
  get active()
  get wantsInput()              // NEW — true while the journal owns input
  get sheets()                  // NEW — leaf count, for harnesses
  get studying()                // NEW (r4) — leaning in on one entry
  onClose = null                // NEW — integrator hook, fired once by close()
  open({ award = null } = {})   // award: { id, photoDataURL } | null
  close(); toggle()
  study(page, row); unstudy()   // NEW (r4) — see §13.1. The pointer drives
                                //   these itself; an integrator needs neither.
  studyClose(); zoomOut()       // NEW (r5) — the third zoom level, and the
                                //   one-level-at-a-time way back out. §14.
  get closeUp(); get zoomLevel() // NEW (r5) — 0 spread, 1 row, 2 print
  update(dt)                    // REAL seconds
  render(renderer)              // straight after postfx.render(dt)
  dispose()
}
```

`ctx` is used for exactly two things: `ctx.renderer ?? ctx.engine.renderer` (to
bake the environment map once) and `ctx.systems.audio?.cue(name)`. Everything
else it needs it reads from the hunt store directly. It never touches the
world, the camera, PostFX or the HUD.

## 3. The four things that make it read as a book

Measured by covering each one up in a capture and seeing what dies, in order of
what it was worth:

1. **The square** — covers overhanging the text block by 4.2 mm on three edges.
   Without it the closed book is a box with a texture on it.
2. **The rounded spine** — an ellipse, not a circle (`SPINE_FLAT = 0.52`), with
   three raised cords and a headband at head and tail. A circular spine as
   proud as the block is thick reads as a log. **And it is POSED** — see §10,
   B2. Shut, it is the rounded back of the block; open flat, a book rests *on*
   its spine and the leather is a shallow band underneath, not a ridge above.
3. **The fore edge is 26 sheets**, individually jittered in width, height,
   offset and cream, with a slightly concave stack profile. One cream box for
   the text block was the loudest tell in the first pass.
4. **The blind-tooled border and the stamped emblem**, both debossed into the
   cover's height field rather than modelled. A 0.4 mm groove as polygons is
   sub-pixel at every distance this is ever seen from.

Blind-stamped *text* was tried for the emblem and thrown away: a title at this
size is four pixels of cap height, which reads as a scratch rather than as
words, and a title nobody can read is worse than no title because the eye keeps
returning to it.

## 4. The four bugs worth remembering

Each of these presented as something other than what it was, which is why they
are written down rather than just fixed.

**The scrim on top of the book.** The world-dimming quad was a transparent mesh
inside the book's own scene with `renderOrder: -100`. three renders the entire
transparent queue *after* the opaque one, so renderOrder never got a look in and
the scrim landed over the book. The symptom is a book uniformly the colour of
the scrim with the type gone — which reads as a lighting bug. It now gets its
own scene and its own pass.

**The gutter dive sank the whole page.** `deformPage` adds an angle to an
*integrated* tangent, so a 0.62 rad dive at the spine does not tilt the leaf near
the fold — it displaces the entire rest of the sheet down by the integral of
itself, 9 mm, well under the text block. It looked exactly like a texture that
had failed to load. `deformPage` now re-levels the fore edge (`zShift`), and
`GUTTER` only sets how deep the fold is.

**Every checkbox on a recto came out as a bracket.** The leaves dive into the
gutter; the stack slabs are flat boxes that run all the way to the fold; so the
inner ~15 mm of every right-hand page was inside the block. Versos were fine
(their fold is on the other side of the canvas), which made it look like a font
or mip-filtering problem. Fixed by three numbers together — `GUT_INSET` steps
each slab's inner edge away from the fold as it goes up the stack, `PAGE_LIFT`
floats the printed leaf higher, and `GUTTER` is shallower.

**The photograph arrived as a ghost.** The flying print's material took its own
canvas as `alphaMap` "so the corners could be cut". `alphaMap` reads the green
channel, so every dark pixel in the photograph became a hole. The card is a
solid rectangle and needs no alpha at all.

A fifth, from the model: `instanceColor` is only multiplied into the fragment
when `USE_COLOR` is also defined, so the slab geometry carries a white `color`
attribute it appears not to need. Without it the whole text block renders black.

## 5. Type

**Caveat** (body) and **Caveat Brush** (headings), both SIL OFL 1.1,
self-hosted in `public/fonts/`, 126 KB for the two. `journal_fonts.js` loads
them with the `FontFace` API — no `@font-face` rule and therefore no edit to
`index.html` or `hud.css`.

**Correction (round 2).** This section used to cite
`shots/journal/00_font_specimen.png` as "a specimen of four candidates over the
real page layout". That capture shows **two** panels, cropped at the right edge,
and — worse — `tools/_scratch/_journalfont.html` referenced woff2 files for
three of the four candidates that were never kept in `public/fonts/`, *and* had
the shipped Caveat Brush at the wrong filename. Every panel in it was therefore
drawn in a system fallback. **The four-way comparison does not exist and never
did.** The old capture is no longer cited by anything.

What replaces it is honest and smaller: `_journalfont.html` now draws the
shipped pairing only — Caveat Brush heading over Caveat body, on a real page at
the real aspect and real sizes — captured as
`shots/journal/round2/00_type_specimen.png`. It settles the question a specimen
can settle (does the hierarchy hold at page size) and claims nothing else.

The pick itself was a **judgement, not a measurement**, and stands on one
argument: read at real size, a typewriter heading over a handwritten list says
"a printed form somebody filled in", where a personal field journal is one
person's hand throughout. Caveat Brush is the same skeleton as the body with a
fatter pen. Special Elite is Apache-2.0 rather than OFL, which was previously
written down as if it were a reason — **no doc in this repo requires OFL**;
`HUNT_CONTRACT.md` only says fonts are the asset exception. Licence is a
tiebreaker between two faces that are otherwise level, and it was not close
enough to need one.

The trap this guards: **a CanvasTexture drawn before the webfont loads renders
in the fallback face and never redraws.** Nothing paints before
`journalFontsReady()` resolves, and every page can repaint.

## 6. What was verified, and how

- `gallery.html` on 5199 lists **Journal** as its own group with three
  colourways, an `open` slider, `buildJournal(rnd, {"colorway":1})` on the info
  panel, `5,566 triangles · 23 meshes · 15 materials`, size `0.16 × 0.23 × 0.03 m`
  shut (it was `0.32 × 0.38` and framed as a stamp — see §9).
- **`tools/_scratch/_jcritic.mjs` is the harness to use now.** It drives the
  REAL wiring (`window.__systems.hud.journal`) in the real game at gameplay
  framing, with the HMR client neutered and Chromium on ANGLE/Metal, and has
  five modes: `model` (posed stills), `beats` (the ceremony), `aspect` (B4),
  `timing` (how long the ceremony takes) and `cost` (what a repaint costs).
  The lab page and `_jshot.mjs` cannot answer the questions round 2 was about:
  both create their renderer with `antialias: true` and the game's is
  `antialias: false`, so **the aliasing blocker was invisible in every capture
  the lab ever produced.**
- `tools/_scratch/_jingame.mjs` boots the real game on 5199, constructs a
  Journal against the real `ctx`, chains `render` behind `postfx.render`, runs
  the whole ceremony and closes it. **No console errors.** Renderer state after
  close: render target null, scissor test off, `toneMapping` NoToneMapping,
  `shadowMap.enabled` true — all as found.
- **The black photograph in the round-1 captures was this harness, not the
  product**, and it is fixed at `_jingame.mjs:57`. The stand-in photo was read
  with `canvas.toDataURL()` from a *different task* than the one that drew the
  frame; the context has no `preserveDrawingBuffer`, so the buffer had been
  cleared and it returned a 12,435-byte fully black JPEG (probe mean luma 0.0).
  `PhotoMode.capture()` renders and reads in the SAME task and always did —
  4,246,826 bytes, mean luma 114.6. The harness now hooks the render callback,
  reads inside it and puts the callback back: **405,051 bytes** of real
  photograph at q 0.8. Same rule as `readPixels`: if you did not draw it in
  this task, it is not there.
- `AUTUMN_URL=http://127.0.0.1:5199 node tools/health.mjs` — `shaderFailures: 0`,
  every system up; the only console error is the pre-existing
  `VITE_POSTHOG_KEY` warning.
- `tools/_scratch/_jceremony.mjs` films the ceremony as a strip on a
  hand-stepped clock, so a timing change can be A/B'd frame for frame.

## 7. Cost

**5,566 triangles**, 23 meshes, 15 materials (was 5,982 / 22 / 14). The count
barely moved; the ALLOCATION did, which was the real complaint. The spine was
2,288 triangles — 38% of the whole model — on a uniform 26 x 44 grid over a
smooth tube whose 0.6 mm cords are invisible at every distance the book is seen
from, while the cover's corner radius staircased visibly at `curveSegments: 6`.
The spine's rows are now placed where the profile actually bends (a coarse
backbone, five rows across each cord, two at each turn-in) for ~900, the covers
went to `curveSegments: 12`, and the surplus also paid for a three-column slab
(the gutter gradient) and the ribbon's contact shadow. The overlay scene has
four lights, none of which cast, so no shadow pass runs for it. Construction
does ~90 ms of canvas work on the main thread (two leather map sets at 512²/256²,
one endpaper, one contact shadow) plus ~40 ms per page paint × 6 pages, all of
it behind the font promise and therefore off the first frame. Nothing allocates
in `update()` except the two `THREE.Vector3`s the ribbon poser builds per frame —
see §9.

## 8. What the integrator has to wire

1. **Construct it** — `const journal = new Journal(ctx);` once, at boot, after
   the renderer exists. Construction is cheap; the expensive half is async.
2. **Update it** — `journal.update(dt)` with **real** seconds, every frame,
   *including while `ctx.worldPaused` is true*. It runs its own clock.
3. **Render it** — immediately after `postfx.render(dt)`:
   ```js
   engine.setRenderCallback((dt) => { postfx.render(dt); journal.render(engine.renderer); });
   ```
4. **A key** — `J` is the obvious one and the journal already closes on `J`,
   `Escape` and `Enter` from its own capture-phase listener. The integrator only
   needs the *open* half.
5. **Award on capture** — from `PhotoMode.capture()`, once `hunt_detect` says
   what is in frame:
   ```js
   journal.open({ award: { id, photoDataURL } });
   ```
   It is safe to call `hunt.award(id, photo)` yourself first; the journal
   re-arms the row either way so the pencil still animates.
6. **Gate the HUD** on `journal.wantsInput` if you want the driving chrome to go
   away while the book is open. Nothing breaks if you do not — the journal's
   listeners are capture-phase and already take the events — but the HUD stays
   drawn over the book, which the capture in the report shows.
7. **Nothing for type.** No stylesheet change.

## 9. Known weak points

- **`poseJournal` allocates.** The ribbon and band posers build ~80
  `THREE.Vector3` per frame. It is an overlay over a paused world, so it has
  never shown up as a hitch, but it is against the house rule and it is the
  first thing to fix if the journal ever animates over live gameplay.
- **The elastic band renders lighter than its albedo suggests** — a near-black
  hide comes out mid-grey. It is the broad GGX lobe at roughness 0.86 plus the
  environment; it looks like a plausible elastic, but it was tuned by eye rather
  than understood.
- ~~The contact shadow plane is inside the model's bounding box~~ — fixed in
  round 2, and it was three things, not one. `gallery.html` unions every mesh's
  `geometry.boundingBox` and knows nothing about `visible` or about
  `instanceMatrix`, so the journal reported **0.32 × 0.38 m**: the contact
  shadow (three cover-widths across), the LEFT leaf (posed flat-open at all
  times and merely not drawn while the book is shut) and the text block's slab
  geometry (nominal size, centred on the mesh origin, which is the *hinge* — a
  whole page-width left of where any instance actually is). All three now carry
  an explicit box; the gallery reports **0.16 × 0.23 m** shut and the true
  spread open.
- **A repaint is NOT ~40 ms — that figure was wrong by an order of magnitude,
  and it is corrected here rather than quietly deleted.** Chromium *defers* 2D
  canvas raster, so a `performance.now()` either side of a `paint()` measures
  command recording and nothing else; the 40 ms that was once seen was a queue
  draining later, attributed to the call that filled it. Measured in the real
  game (`node tools/_scratch/_jcritic.mjs --mode cost`), per call, main thread:

  | call | recorded | with the raster forced (`getImageData` flush) |
  |---|---|---|
  | `JournalPage.paint()` | 0.167 ms | 4.77 ms |
  | `strikeAt()` | — | 2.29 ms |
  | `progressAt()` | — | 2.28 ms |

  The flush probe itself costs about 2.3 ms, so the partial blits are very
  nearly free and a full repaint is ~2.5 ms of actual raster. The partial-blit
  paths are still the right design — they touch a rectangle instead of 1.5 M
  pixels — but they were not saving a dropped frame, and the comments that said
  so have been corrected in place.
- **The journal has been playing in SILENCE, and that is now fixed.** It cued
  `journal.page` / `journal.cross` / `journal.slap`; `Audio.cue` dispatches the
  book's voices with `JOURNAL_CUES.includes(name)` against
  `['page', 'cross', 'slap']` (`src/audio/Audio.js:272`). Not one name ever
  matched. Nothing throws and nothing logs when a cue misses, which is why it
  survived a whole round of review — the only way to find it is to read the
  other end. The cues are bare names now.
- **The cover swing has its own voice name and no voice behind it yet.** It
  asks for `cover`, which `journal_audio.js` does not ship — an unknown name is
  a no-op, so the beat is silent rather than speaking with a paper rustle 0.6 s
  before the first actual page turn. **Integrator: one leather-and-board voice
  in `src/audio/journal_audio.js` plus `'cover'` in `JOURNAL_CUES`.**
- **Fifteen items is four list pages**, so the last page carries three lines and
  a lot of white. It looks deliberate rather than broken, but a sixteenth item
  would make the sheet square. Not fixed here: `src/game/hunt_items.js` is D's
  file and the journal lays out whatever it is given.
- **`src/main.js` gates `journal.render()` on `journal.active`**, which goes
  false on the frame `close()` is called — so the 0.46 s put-down animation is
  never drawn in game and the book vanishes instead. `Journal` now exports
  `get visible()` for exactly this; the fix is `journal.active ||
  journal.visible` at `src/main.js:469`, and it is one word in a file this
  module does not own.

---

## 10. Round 2 — the six blockers, and what the evidence was

The critic panel rejected the feature. Every fix below was verified with a
capture taken through the real game wiring at gameplay framing
(`tools/_scratch/_jcritic.mjs`, plates in `shots/journal/round2/`), and where
the critic gave a number, the number was re-measured.

### B1 — the whole book was un-antialiased over an SMAA'd world

`src/core/Engine.js:17` builds the context with `antialias: false` (world AA is
SMAA inside the post chain) and the overlay draws *after* that chain into that
same raw framebuffer. Every silhouette on the hero object staircased over a
perfectly smooth meadow.

`Journal.render()` now draws the book into a **4x multisampled
`WebGLRenderTarget`** and blits it over the frame. Three things about it are
load-bearing:

- The **scrim stays on the direct path**. It is a flat full-screen quad with no
  silhouette, so it has nothing to antialias, and moving the world-dimming
  blend into the target's linear space would have changed how much it dims.
- The blit material is **`premultipliedAlpha: true`**. The book is drawn over a
  transparent clear with three's separate alpha blend, so the target's colour
  is already multiplied by coverage; composited with an ordinary source-alpha
  blend every edge pixel darkens twice and the book grows a grey halo.
- **RGBA8 tagged sRGB, not half float.** Same encoding and same 8 bits as the
  canvas, so the composite is identical to before except at the edges; half
  float would have been 46 MB of multisampled attachment for a book.

A driver that refuses a multisampled target falls back to the old direct path
with a warning rather than losing the journal. `clearDepth()` on the canvas is
gone — the book has its own depth buffer now, which also means the overlay has
stopped clobbering the *world's*.

### B2 — the spine was a rope, because it was never posed

`poseJournal` never touched it. It stayed a half-ellipse spanning z ±15.6 mm
forever, so an **11 mm leather ridge stood above the paper down the whole
gutter** of every spread. It was also **2,288 of 5,982 triangles — 38% of the
budget on the part that read worst.**

- `spineGeometry` now builds a **table** and `poseSpine(geo, open, zHinge)`
  re-lays it. The profile is always `x = -sin(a)·AX`,
  `z = CZ + cos(a)·AZ - sin(a)·DROP`; opening the book only moves those four
  numbers, so a tube standing over the block becomes a lens lying under it
  through one continuous family of shapes. Gated on the cover having actually
  moved, so it costs nothing at rest.
- **The headbands ride it.** Left alone they became two striped half-tori
  standing 11 mm above a flat spread — the same bug and twice as odd-looking,
  because they are the only saturated colour in the frame.
- **The rows are no longer uniform.** A coarse backbone, five rows across each
  cord, two at each turn-in: same silhouette, ~900 triangles instead of 2,288.
  The surplus went to the cover's corner radius (`curveSegments` 6 → 12), which
  was staircasing where anyone could see it.
- **The gutter gradient.** Cream running right up to the fold was half of why
  the spine read as a foreign object. The stack's slab is now three vertex
  columns with the middle one pushed in to 18 mm, carrying a ramp from 0.34 to
  1.0 — and the two stacks get *mirrored* geometries, because the left stack's
  fold is on its other side.

### B3 — the bright seam down the front hinge of the closed book

Two things, and the first one was not what it looked like. Probed by hiding one
mesh at a time and reading the framebuffer in the same task as the draw
(`tools/_scratch/_jslit.mjs`): **the bright pixels belonged to the cover
skin**, whose extruded hinge-side wall points straight down the key light at
(-0.62, 0.92, 0.72). Measured peak in the hinge strip: **0.50 luma against a
0.34 cover.** So the joint is now crushed, darkened and made matte in the cover
map (B5) — a real joint is the *dark* part of a book, being the strip a thumb
touches every time it is opened.

Second, the arc genuinely did stop dead at x = 0, abutting the skin's edge in a
T-junction that has nothing behind it. It now **overruns by `SPINE_LAP` at both
ends and sinks as it does**, so each end runs ~2.3 mm in +x and tucks under the
board. Nothing can leak through a crack with leather behind it.

**After: the peak in the same strip is 0.35, and the 0.44–0.46 spike at
x = 644–653 is flat 0.31–0.32.** (Honest note: the round-1 report described the
leak as *cream*, i.e. the text block showing through. It cannot be — the block
is gated invisible while the cover is shut — and a scan for bright,
low-saturation pixels over the closed book found **zero** before the fix as
well as after. The seam was real, the diagnosis of what was behind it was not.)

### B4 — the spread was clipped in any window narrower than ~1.15:1

`CAM_FOV` is vertical and only `camera.aspect` was written, so horizontal
coverage shrank with the viewport while the spread stayed two pages wide. At
0.75 the heading was cut to "p Scavenger Hunt" — on the branch whose whole
point is that the checklist is the interface on a device with no keyboard.

`_fitCamera(aspect)` now fits horizontally below `DESIGN_AR = 1.55`, and buys
the coverage in two stages: **open the lens up to `FOV_MAX = 54°`, then dolly
the camera back** for whatever is left. A 90° lens 600 mm from a spread laid
nearly flat turns the far page into a wedge, and a checklist you have to read
is the last place to spend perspective on drama.

It also **reclaims the margin as the window narrows** (`TIGHT_MAX = 1.30`): at
the design aspect the spread fills about two thirds of the width and the rest
is the frame the book sits in; on a phone held upright the frame is nothing but
margin, so the book grows into it to ~88%. Without that the fix was *correct*
and the hint lines were still unreadable.

| aspect | before | after |
|---|---|---|
| 1.78 | fine | unchanged, fov 30 |
| 1.33 | tight | fov 32.0 |
| 0.75 | **clipped — "p Scavenger Hunt"** | complete, fov 46.2 |
| 0.69 | **clipped** | complete, fov 49.7 |
| 0.46 | **mostly off-screen** | complete, fov 54 + dolly to z 0.815 |

### B5 — the hide read as cork at the size it is actually seen

Judged at opening framing, not at 4x zoom. Three faults, all in
`journal_textures.js`:

- The 40-cell (3.7 mm) octave entered through `smoothstep(0, 0.34, F2-F1)`,
  which **saturates over most of a cell interior** — so what it contributed was
  a second crease network, i.e. exactly the crazing its own comment said it was
  added to prevent. Widened to `(0, 0.72)` at weight 0.44 it stops clipping and
  becomes the dominant *dome*.
- The 104-cell (1.4 mm) octave carried the largest weight (0.48) and is a
  single cell size, so the "size distribution" the comment claimed was not
  visually present. It is the crease network and nothing else now, at 0.34.
- The 248-cell (0.6 mm) octave is about **two screen pixels** at opening
  framing — below Nyquist, so it integrated to a uniform fizz that shimmered.
  0.22 → **0.08**.
- **There was no low-frequency albedo variation at all**, only a height
  undulation. Real leather pools dye over 15–40 mm, which on a 148 mm board is
  4–10 cycles across the map: two smooth octaves, ±8% of value, cover map only
  (the spine's map tiles, and a non-tiling term in a tiling map is a seam).
- **The grain crossed the blind-tooled fillet unchanged.** A hot brass wheel
  crushes grain flat; the tooling was subtracted from the height field and the
  pebble ran across it at full amplitude, which is why the fillet looked
  *painted on* rather than pressed in. The function now keeps `grain`,
  `deboss` and `tooled` as three fields and composes
  `h = grain·(1 − 0.8·crush) − deboss`, where `crush` is the tooling plus the
  joint mask. This is the single cheapest change in the round and the most
  visible one at 4x.

### B6 — the progress line was stale through the whole ceremony

`_armAward` updates `spec.progress` on **every** page and then repaints only
the page the *award* is on — and the count lives on page 1 and nowhere else. So
with the item struck off, ticked, photographed and taped, the line under the
heading still read **"none of fifteen found"**.

`JournalPage.progressAt(text)` is a partial blit alongside `strikeAt` /
`tickAt` / `tapeAt`, run from `Journal` on the tick beat — the moment the item
is "counted". It deliberately does **not** blit from `_clean`: the clean copy is
the page as it was *before* the ceremony and still has the old number in it, so
it re-lays the band from `paperBase` and the fold shadow instead, and then
patches `_clean` so the pencil animation's cache stays honest.

**Evidence: `shots/journal/round2/b8_progress.png` — leafed back to page 1
after the ceremony, the line reads "one of fifteen found".**

## 11. Round 2 — polish, in the order the critic asked for

1. **Endpaper river** — was ten `lineTo` points with no smoothing: a line
   chart, not water, and the first interior surface the cover reveals. Now
   quadratics through the midpoints with the weight tapering from source to
   mouth.
2. **Empty photo slots** — `setLineDash([10, 11])` over 30 px legs meant a dash
   *period* longer than the leg, so each leg was one or two dashes: a 1–2 px
   speck at gameplay resolution, and fifteen rows of them read as dirt. Solid
   now, longer legs, drawn with `inkLine` so they are in the same hand as the
   rest of the page. Still corners rather than a closed box — a closed dashed
   rectangle reads as a file-upload dropzone, which was right the first time.
3. **Tape shadow and sheen halved.** Masking tape is two hundredths of a
   millimetre thick and the old values made each strip a raised beige bar. The
   tape itself was praised and is untouched.
4. **The second tape strip was running out of its corner, not across it.** A
   strip taped over a corner is perpendicular to that corner's bisector; the
   two corners used are opposite ends of the same diagonal, so both want the
   same sign, and the second was at `tilt − 0.70` — parallel to its bisector.
   Both are positive now (0.60 and 0.86, still visibly different).
5. **The hint fades on a struck row.** It stays — leafing back should read as a
   list, not a scoreboard — but it drops to 0.26 alpha so completed rows go
   quiet.
6. **The ribbon.** It wanders (2.4 mm of lateral drift and a 0.7 mm bow off the
   paper), it curls and twists as it comes over the tail edge so the hanging
   end shows its back, its cross-section is cambered (`roll`) so the broad face
   has a satin gradient instead of one flat tone, the material went from 0.72
   roughness to 0.50 because a ribbon is woven silk, and **it casts a contact
   shadow** — a transparent strip a millimetre wider, depth-tested so only the
   millimetre that escapes the ribbon shows, and only over the on-page run.
7. **The cover has its own voice name** — and the three that already existed
   were never being heard at all. See §9.
8. **Gallery bbox** fixed (§9), **title-page rule** moved under the whole title
   block rather than between title and subtitle, **the squirrel hint's "here"
   widow** fixed by fitting the hint to one line before allowing a wrap
   (33 px down to 25 px), and the sixteenth item is D's call, not the
   journal's.

**Ceremony timing**, measured on the journal's own clock from `open()` to the
second piece of tape (`--mode timing`). `SCRIPT.seekLeaf` went 0.46 → 0.30 —
somebody riffling to a page they know the number of does not turn it at reading
speed:

| award | extra turns | taped at |
|---|---|---|
| `deer` (first page) | 0 | **3.57 s** (was 3.92) |
| `waterfall` | 1 | **3.84 s** |
| `burntMallow` | 1 | **3.88 s** (was reported 5.42) |

## 12. Round 3 — the paper's highlight headroom

Two items, both named by the round-2 critic in a pass that otherwise signed the
feature off. Nothing else was touched.

### 12.1 The page had no headroom, and the ribbon's shadow paid for it

The page material was `color: 0xffffff` under a 1.95 key with `NoToneMapping`
behind it. It overflowed. Measured on the settled spread at 1600×900 through
the real game (`__systems.hud.journal`, not the lab page):

| | R clipped at 255 | R **and** G clipped | page px clipped | page max R |
|---|---|---|---|---|
| before | 376,366 | 260,182 | 369,665 | 255 |
| after | **823** | **793** | **0** | **250** |

The 823 that remain are not paper: they are the bottom cut edge of the leaf
stack (rows 690–699) taking a grazing specular, and they sit at exactly 823 at
every gain from 1.0 down to 0.55. The fallback composite — `_rtFailed`, no MSAA
target, straight to the canvas — clipped identically before (380,667) and
clears identically now (3,636, all of it that same fore edge).

What the clipping cost, at the pixel the critic quoted. The band beside the
ribbon at y440 went from a dead-neutral **(160,158,137)** — R−G of 2 — to
**(145,134,117)**, R−G of 11. There were 1,034 pixels of that neutral strip;
there are now **zero**. The paper beside it went from (255,255,225), hue
surviving in blue only, to (231,218,193). Mean R−B over the bright paper: 32.4
→ 42.2.

**The fix is `PAPER_GAIN` in `journal_model.js` — 0.70, applied to the page's
albedo AND its emissive together.** `setJournalPages` hands the same canvas to
`map` and to `emissiveMap`, so both terms are proportional to the page art and
scaling both by one factor scales every page pixel by exactly that factor in
linear space: the ink-to-paper contrast ratio is arithmetically untouched and so
is the lit-to-emissive balance. The flying print card in `Journal.js` carries
the same gain, because it is swapped for the baked print the instant it lands
and a mismatch would pop on the one frame the award beat is built around —
measured across that swap, the print region differs by **0.24 / 255**.

**The type got better, not worse**, which is the opposite of the risk. The soft
hint ink was being washed into clipped paper. Michelson contrast, same boxes,
before → after:

| | before | after |
|---|---|---|
| headline | 0.596 | **0.613** |
| row label | 0.407 | **0.427** |
| smallest hint (left) | 0.168 | **0.194** |
| smallest hint (right) | 0.165 | **0.193** |
| running head | 0.098 | **0.124** |
| turning leaf, row label | 0.304 | **0.309** |

Ink-pixel counts rise with it (the hint line goes 235 → 275 surviving pixels).
The one number that falls is the headline's WCAG ratio, 10.23:1 → 9.77:1, from
the paper's absolute luminance dropping; AAA is 7:1.

Three other places the headroom could have come from were rejected — the key
light, the emissive alone, and a highlight shoulder on the overlay's own blit
(which composites premultiplied colour, so a curve there grades antialiased edge
pixels differently from their interiors and would put an artifact back on the
silhouettes the MSAA target exists to fix, and would not run on the fallback
path at all). The full argument is in the `PAPER_GAIN` header.

### 12.2 The endpaper contours were drawn with a compass

Every ring of a hill shared one wobble and one radius step, so each was an exact
scaled copy of the one inside it: perfectly concentric, perfectly evenly spaced.
Three small irregularities now, none of them amplitude — amplitude is what made
the round-1 version a spirograph:

- **the summit migrates**, so outer rings sit off to one side of the peak;
- **the spacing is uneven**, a per-hill steepening trend plus a small jitter;
- **the ring shape drifts with height**, phase and depth walking per ring.

Magnitudes are bounded so rings cannot touch: tightest step ~12.6 px at
size 512, jitter takes at most 3.6 and shape drift at most ~4.3.

It draws from a **second generator**. Taking these from `rnd()` would have
shifted every later value in the sequence and moved both the hill placement and
the river — the river was tuned last round and should not move because the
contours grew a wobble. Verified: hill positions and river are unchanged.

### 12.3 Noted, not touched

- The leaf stack's bottom cut edge clips ~800 px of grazing specular. It is a
  cut edge, not paper, and it is not what the critic reported.
- Phone portrait below ar ~0.55 is still a ceiling, not a break. The real fix is
  showing one page, which is a design change.
- The HUD hint bar visible for ~500 ms during the ceremony cross-fade was judged
  deliberately last round and stays.

---

## 13. Round 4 — three things the user asked for

Nothing in §§1–12 was retuned. The three items below are additive, and where one
of them touches something that was signed off, the note says so and says why it
is not a regression.

### 13.1 Click a taped photo to lean the book in and read that entry

*"you should be able to click a photo in the log book to essentially have the
book tilt more towards the user and zoom in on the book so the photo is larger
and easier to see that entry and photo."*

`Journal.study(page, row)` / `unstudy()` / `get studying`, driven from the
existing capture-phase pointer listener. Click a print, the book comes up
toward you centred on that row; click again, or Escape, and it goes back.

**The row is the frame, the print is the target.** A photograph in this book is
landscape and sits *beside* its line, so framing the print alone puts the entry
it belongs to off the side of the screen — which is the half of the pair
somebody leaning in is trying to read. The click target is the print's own slot
grown by `SLOT_PICK` (1.18), which is ~10 mm of page all round; the framed
rectangle is `JournalPage.rowUV(i)`, the whole band.

**The picking is `samplePage`, not a raycaster.** `samplePage` already answers
"where in the world is this bit of page", it reads the table `deformPage` left
behind rather than re-integrating the bend, and it is the same function the
flying print lands with. The four corners of the slot go out through it and
into the camera, and the test is point-in-quad on screen — two triangles, not a
winding test, because a bent page does not project to a convex quad. A
raycaster would have been a second, differently-wrong answer to a question that
already has one.

**The pose.** `STUDY_TILT` 0.42 rad added to the laid pose's `rotation.x`,
`STUDY_ZOOM` 2.55 on the book (not a dolly — `_fitCamera` owns the camera, and
the composition rule in `Journal`'s header still holds), eased in over 0.42 s
and out over 0.34 s. The offset that centres the row is recomputed from the
LIVE posed page every frame rather than baked at the click: at k = 0.5 the book
is half-tilted and half-scaled and the offset that centres the row then is not
half the offset that centres it at k = 1.

Measured through the real wiring, `tools/_scratch/_jstudy.mjs`, 1600×900:

| | at the spread | leaned in |
|---|---|---|
| the row's screen box | 0.219 × 0.094 of the frame | **0.569 × 0.298** |
| the row's centre | wherever it was | 0.500, 0.498 |
| the page, off face-on | 34° | **10.1°** |
| the print's own box | 0.070 × 0.070 | — |

At 700×1520 (phone portrait) the same click gives **0.839 × 0.114** and the
leaned-in view shows ONE page filling the width — which is the fix §12.3 named
as "the real fix is showing one page, which is a design change", arriving here
for free on the view that needs it most.

Going the whole way to face-on was rejected: a page exactly perpendicular to
the lens has no perspective in it and the book stops being an object in a room.
0.42 takes about seventy per cent of the 34°.

Everything backs out **one level at a time** — Escape from a leaned-in entry
returns to the spread and a second Escape shuts the book; a page key or a wheel
detent returns to the spread rather than teleporting back and turning a page in
one input. Dead keys while leaning were considered and rejected: a key that does
nothing is how a player decides a mode is stuck. The ceremony keeps right of
way on the same test `leaf()` uses — the flying print locates its page with
`samplePage` every frame and leaning the book underneath it would move the
target it is aiming at.

The one affordance: `zoom-in` on the canvas cursor over a print, `zoom-out`
while leaning, written the way `Camp._paintCursor` writes it and only on a
change. The journal has no chrome to say this with and the browser already has
the vocabulary.

Plates: `s0_spread`, `s2_lean_100ms` (fully legible mid-move — it leans, it does
not swing), `s4_leaned`, `s6_spread_again`.

### 13.2 The page turn is a recording now

`public/audio/page.mp3`, 25 KB, recorded by the user. **This is a departure from
the repo rule** — every sound in this game is synthesised and `public/audio/`
had held exactly one asset ever — so it is handled as one:

* **the synthesised voice stays and is the fallback.** Measured with the fetch
  rejected, `cue('page')` renders 0.1139 peak / 0.0212 rms / 372 ms /
  hp200 0.1146 — bit-identical to `synth page`. No asset, no silence.
* **it is TWO takes.** Measured in 20 ms windows: a lift and a snap at
  0 → 215 ms (peak 0.1680), 380 ms of room tone, a second turn at 585 → 700 ms
  (peak 0.1565), then 280 ms of near-silence. Fired whole it is two page turns
  for one call. The cue plays one take, drawn by the rng, which also supplies
  the "never bit-identical" the file's discipline asks for.
* **the level is measured on the same four columns the other voices are.**
  `tools/_scratch/_jaudio.mjs` reproduces the existing table to the last digit
  (cover 0.2298 / page 0.1139 / cross 0.0973 / slap 0.2689), which is what makes
  the new row comparable rather than merely adjacent.

Four columns wanted four different gains — peak 0.677, hp200 0.690, mono 0.596,
loudest-200 ms 1.491 — and `hp200` decides it, because the small-speaker order
(§ the header's block) is a rule and not a preference. The recording is almost
entirely above 200 Hz, so a gain chosen for loudness sails past cover (0.1319)
and slap (0.1356) through the 4th-order filter and inverts the ceremony; any
gain over 0.794 does. **0.68**, which agrees with the full-range peak to
0.16 dB. What it costs, stated: the loudest 200 ms lands 6.6 dB under the
synthesised page on take 0 and 8.9 under on take 1, because the recording's
crest factor is 20 dB against the synth's 13.

Ducking still holds: three turns 0.12 s apart peak 0.1279, **+0.7 dB** over one
turn against the synthesised voice's +2.4 dB.

### 13.3 The journal sits closed on the camp table

`camp_table.js` publishes `userData.journalRest` — a point and a yaw **in the
table's own space**, the way `camp_telescope.js` publishes `eye`/`aim` and for
the reason `camp_scope_view.js` gives at length. `Camp._seatJournal` builds the
closed book with `buildJournal` (reuse, not new geometry) and parents it to the
table group, so a table yawed by a jitter and tilted onto a slope carries the
book for free. `J` still opens it; clicking it opens it too, through
`hud.toggleJournal()` so the `pa-journal` class still takes the driving chrome
off the screen.

**Where it goes in the pick order: after the telescope, before the stick**, and
the argument is in `Camp._interact`. The stick's sphere is on the marshmallow,
0.34 m across and 294 mm above the table it leans on; the book's is 0.17 m and
lies flat on it. Measured off the placements, when the two take the same end of
the table their centres are ~0.34 m apart — so the marshmallow's sphere reaches
down over the book and the book's never reaches up to the marshmallow. The
padded sphere is the one that can steal, so it goes second. That is the opposite
conclusion to the telescope-versus-stick rule beside it and it is not the same
question; the rule that covers both is *the padded sphere loses to the one that
is not*.

**The still life had to move.** `dressTable`'s header says one or two objects,
never three, and the book has nowhere to go beside both: with its squares it is
157 × 218 mm on a top that is 536–586 × 420–462, and the mug's band (0.14W to
0.30W) and the paperback's (0.16W to 0.28W) both run through it. So the journal
takes the paperback's place — the still life stays at two objects and the second
one stops being a random novel and becomes the player's own book, which is
closer to "somebody stepped away for a minute" than the paperback ever was. The
`paperback()` builder is deleted rather than left dead. The mug moves outboard,
0.14W–0.30W → 0.26W–0.35W, and the numbers are off the two footprints: the
book reaches 0.123 m from centre at its worst yaw and the mug's inner reach —
centre minus the 56 mm its handle swings — is 0.090 m at the old band's near end
and 0.146 at the new one's. **This moves the table's rnd stream**, so camps look
different for a given seed; unavoidable, and written down in `journalRest` so
the next person comparing an old capture does not think something broke.

**It needed different leather.** The book was authored for the overlay's four
lights and its environment map, and the world has neither
(`src/render/SkyProbe.js`'s header states the problem for the whole game).
Measured in the real game with `tools/_scratch/_jlum.mjs`: the shadows are
innocent (mean luma 41.9 with cast and receive on, 41.9 with both off) and the
albedo map is the whole of it — removing it takes the same crop from 42 to 216,
and the cover map averages sRGB (60, 26, 9). `HIDE_LIFT = 2.6` multiplies the
leather's and the board's albedo in a **second cached material set that shares
every texture**; at `lift = 1` the arithmetic is unchanged, so the overlay's
book is what it always was (verified: `_jcritic --mode model`, `m0_closed`).
What the lift buys is not brightness — the atmosphere lays a pedestal no albedo
gain touches — it is the grain: over the cover's own crop at hour 13 the mean
goes rgb(56,40,30) → rgb(73,38,28) while the spread goes **1.48 → 3.79**, which
is the pebble, the fillet and the emblem coming back. 3.2 keeps climbing and
starts reading as orange against a yellow meadow. The full table, and the honest
limit at dusk where the sweep moves nothing, are in `HIDE_LIFT`'s header.

**Cost**, paired inside one page load (`_jtable.mjs --mode cost`): **+17 draw
calls and +4,440 triangles** per table. It was +20 and +5,464 before the shadow
trim in `_seatJournal`: a shut book is a slab, so only the two boards and the
spine cast and only the front cover receives — the endpapers are pasted inside
the covers, the thread is in the gutter, the ribbon's painted contact shadow is
on a page nobody can see, and the fore edge stands inside the square. The
overlay's own painted contact shadow is off entirely for the prop
(`buildJournal({ shadow: false })`): the overlay's lights do not cast and the
world's do, and the painted one is three cover-widths across — wider than the
table is deep.

**The prop hides while the book is open.** A player reading it is holding it,
and a second copy on the table under a 78% scrim is the kind of detail that is
invisible for a year and then impossible to unsee. Flipped on the edge, so it is
one boolean compare while driving.

### 13.4 New instruments

| tool | what it answers |
|---|---|
| `tools/_scratch/_jaudio.mjs` | the four voices and the mp3, offline, on the header's own column definitions |
| `tools/_scratch/_jstudy.mjs` | the lean-in, through the real wiring, with real pointer events |
| `tools/_scratch/_jtable.mjs` | the prop on the table: seat, pick, prompt, click, cost |
| `tools/_scratch/_jlum.mjs` | why the leather went dark, and the `HIDE_LIFT` sweep |
| `tools/_scratch/_jclose.mjs` | the third zoom level, and how many source pixels are stretched over how many screen pixels (§14) |

Three traps each of these had to learn the hard way and each now documents:

* **the hunt sheet must be SEEDED into `localStorage` before any module runs.**
  Reaching `hunt` with a dynamic `import()` from an evaluate hands back a second
  instance of the singleton whenever Vite has stamped `?t=` on the module — and
  mid-edit it always has. Every award went into that second store and the book,
  reading the first, came up empty. Two runs.
* **the camera cannot be pinned from the render callback.** `Camp._interact`
  builds its pointer ray from `e.camera` during the system update, so a pose
  written after the render is invisible to it: the pick misses inside the game
  and hits from an `evaluate()`. The symptom is an empty prompt beside a
  `_journalUnderPointer()` that returns true. One run.
* **`document.querySelector('.pa-camp-prompt')` is the wrong element.** There
  are two in a booted page and the first is not the live one. Read
  `window.__camp.prompt.el`. (`tools/campshot.mjs`'s own UI-in-frame guard has
  the same selector and therefore the same blind spot.) One run.

### 13.5 Noted, not done

* `hud.toggleJournal()` reports `source: 'key'` to posthog whichever way the
  book was opened, so a click on the table is indistinguishable from `J` in the
  stats. The fix is one argument in `src/ui/HUD.js`, which this round does not
  own.
* `Journal.dispose()` calls `disposeJournalMaterials()`, which now clears BOTH
  cached sets — so a teardown of the HUD's journal also frees the leather the
  camp props are drawn with. That only happens on a full teardown, at which
  point the camps are going too, but it is a coupling that did not exist before.
* Every camp table carries the journal. One in five full camps has no table and
  compact camps never do, so those have no book on them; `J` is the shortcut
  that makes that fine rather than a gap.
* At dusk the prop is as dark as the table it lies on. That is the camp's
  standing environment-map request (`docs/CAMP_REQUESTS.md`), not this book's.

---

## 14. Round 5 — a second zoom level, and what it exposed

*"I want another level of zoom here. if you click again on the photo it would
fill 80% of the screen with the photo on the book."*

Click a print, the book leans in on that entry (§13.1). Click the print **again**
and the book comes the rest of the way until the photograph is 80% of the
screen — still on the book, with the paper, the tape and the page around it in
frame. Escape, a page key, a wheel detent or a click off the print backs out one
level; a second backs out to the spread; a third shuts the book.

Nothing in §§1–13 was retuned. §13.1's lean is untouched and re-measured
unchanged (`_jstudy.mjs`: row 0.569 x 0.298 of frame, page 10.1 degrees off
face-on, cursor and Escape ladder as before).

### 14.1 What "80% of the screen" resolves to

**80% of whichever axis runs out first.** The print is 36.4 x 27.5 mm on the page
(a 252 x 190 px slot on a 148 x 210 mm leaf), i.e. 1.32:1 landscape, and it has
to sit inside anything from an ultrawide to a phone held upright. All three of
the obvious readings put it off the screen on some real display:

| reading | on 16:9 | on a 700 x 1520 phone |
|---|---|---|
| 80% of the **width** | 0.80 x **1.07** — clipped | fine |
| 80% of the **height** | fine | **2.30x** the width — clipped |
| 80% of the **area** | 0.77 x **1.04** — clipped | clipped, worse |

Area is the worst of the three rather than the cleverest: it is the only one
whose answer depends on the frame's aspect and still bounds neither axis.

So `CLOSE_FILL` is a contain-fit: the print's projected box, largest side
against the matching side of the frame, at 0.80. Measured through the real game
(`_jclose.mjs`), the print's own screen box:

| | at the spread | leaning in (§13.1) | the close look |
|---|---|---|---|
| 1600 x 900 | 0.070 x 0.070 | 0.173 x 0.223 | **0.629 x 0.800** |
| 700 x 1520 | — | 0.255 x 0.086 | **0.800 x 0.267** |

On 16:9 it binds on the height and leaves 297 px of page either side and 100/80
above and below; on the phone it binds on the width and leaves 70 px either
side. Neither ever clips, and both keep at least a tenth of the frame of paper
and tape around the print, which is the "still on the book" half of the brief.

**The scale is solved, not authored.** `STUDY_ZOOM` could be a constant because
it only had to look right; a fit cannot be, because the scale that satisfies it
moves with the window's aspect (through `_fitCamera`'s lens *and* its dolly),
with which page of the spread the print is on, and with where in the leaf's bend
it sits. `_trackCloseZoom` measures the projected box every frame and divides.
It is one division rather than a search because the relationship is linear by
construction — the print is held at `STUDY_LOOK`, a fixed world point, so its
distance from the camera does not change with the scale. Measured: it lands on
**9.094** at 1600 x 900 and **7.927** at 700 x 1520, and holds those to four
decimal places over eight consecutive frames (no oscillation), and re-solves for
free on a resize.

### 14.2 The bug this cost: which matrices is `samplePage` reading?

The first version passed the recentring offset down and added it to each sample
by hand, to save a second walk of the matrix tree. It put the print **a
screen-width off to the left**, and the reason is worth writing down because it
is invisible at the call site: `samplePage`'s quaternion branch ends in
`mesh.getWorldQuaternion`, and three implements that as
`updateWorldMatrix(true, false)` — **it silently refreshes the whole ancestor
chain mid-frame**. So one sampler in `_applyStudy` was reading pre-recentre
matrices and its neighbour four lines later was reading post-recentre ones, and
both looked correct in isolation. `_trackCloseZoom` survived it only because it
measures a SIZE, and a translation does not change one — which is why the print
was the right size in the wrong place.

The rule now is `root.updateMatrixWorld(true)` before anything reads the page,
and no offsets by hand. One walk of a 20-node tree, only while the close look is
up.

### 14.3 The resolution finding, which is the headline

**At this magnification the page texture is the binding constraint, not the
store**, and that is the opposite of what everyone assumed — including this
round's own brief, which asked whether 512 px was too small to save.

Measured at 1600 x 900, on the emulsion (the photograph inside the print's white
border), with a REAL photograph taken by the game and put through
`hunt_store.makeThumb`:

| | |
|---|---|
| the emulsion on screen | **878 CSS px** wide |
| what the page texture holds | **220 x 126 texels** (`_paste` draws into `cardW - 20`) |
| so, without a fix | **3.99x** magnification at dpr 1, **7.99x** at dpr 2 |
| what the store was holding all along | 1024 px |

The 1024 px the store pays quota for were being thrown away one step later, at
paint time, when `_paste` drew them into a 220 px box. **Raising `THUMB_MAX` on
its own would have changed nothing anybody could see.**

Raising the page's own resolution was the other way to fix it and is not an
option worth having: 2x on six leaves is 143 MB of canvas, and 2x still would
not carry a 1024 px photo — it would hold 440 of it.

So `JournalPage.printPatch(i)` draws the print **once more**, on its own
transparent canvas, at `px` device pixels per page pixel taken from the decoded
photo's own width, and `Journal` composites it over the leaf as a flat quad
placed with `samplePage` — the same trick and the same placement the flying
print already lands with. Nothing in either file names a resolution.

| | dpr 1 | dpr 2 |
|---|---|---|
| page texture only (`_jclose --nopatch`) | 3.99x | 7.99x |
| with the patch, store at 1024 | **0.86x** (a downscale) | **1.72x** |
| with the patch, store at 512 | 1.72x | 3.43x |

The A/B is `shots/journal/round5/z4_print_1to1.png` against
`z5_print_1to1_nopatch.png`, same crop, same frame: the page-texture version is
blocky to the point that the camper's roof rack is four brown smears, and the
patched one resolves the spare wheel, the ladder and individual trees. At dpr 2
(`z6_print_dpr2.png`) the patched version is visibly soft — bilinear, plus some
JPEG mush in the foliage — but has no blocking and everything in it is readable.

**How much source the print wants.** The emulsion's width on screen is
**~0.98 x the frame's height** in CSS px on 16:9 and wider (0.87 x the width on
portrait), so a 1:1 view needs `0.98 x viewport height x dpr` pixels of source:
878 at 1600 x 900 dpr 1, 1054 at 1920 x 1080, 1405 at 2560 x 1440, and **1757 on
any dpr-2 1600 x 900**. So **1024 is the right number**: it is native for every
dpr-1 window up to about 1050 px tall and lands at 1.72x on a retina one, which
is soft rather than broken. 2048 would be the only size that makes dpr 2 native,
for 4x the quota, on the deepest zoom of one feature — not worth it.

### 14.4 Three things about the patch that are not obvious

* **The baked print is HIDDEN, not covered** (`JournalPage.hidePrint`).
  Everything in the patch is translucent somewhere — the drop shadow, both
  pieces of tape, the tape's own shadow — so the copy underneath would show
  through every one of them and darken it twice.
* **There is no cross-fade.** The swap happens on the first frame of the dolly,
  when the print is still 17% of the frame, and the two images are the same
  drawing from the same seed at two resolutions. Fading would mean bare paper
  showing through a half-transparent print for a fifth of a second, which is a
  far louder artifact than a sharpness change nobody can see at that size. Same
  argument `_bakePhoto` makes for the flying card.
* **It is built one level early.** Drawing it is 14–28 ms of canvas raster,
  measured with the raster forced (`_jclose` prints it; Chromium defers 2D
  raster, and docs/JOURNAL_NOTES.md 9 is the standing warning about timing it
  any other way). Spent on the click into the close look that is a stutter at
  the start of the move, where the eye is. It is spent instead on the frame the
  LEAN lands — a still picture over a paused world — so the second click costs a
  page repaint (2.4–3.1 ms) and nothing else. Leaving the lean throws the canvas
  away; a second close look at the same row is free.

The canvas is **1825 x 1257, 9.2 MB**, transient, held only while the player is
leaning in on a photographed row. `DETAIL_PX_MAX` (4.7) is the cap and it is
what a 1024 px photo asks for (1024 / 220); at 512 the scale comes out 2.33 and
the canvas is 913 x 629.

One thing had to change in `journal_page.js` for the patch to be the same
drawing at a different size: **`g.filter = 'blur(6px)'` is in DEVICE pixels and
is not affected by the context transform.** Probed in Chromium — a 6 px blur
reaches 11 page px at scale 1, 5.5 at scale 2, 3.67 at scale 3 — so `_paste` and
`tapeStrip` take a `px` argument that scales the two blur radii and nothing
else. At `px = 1` the arithmetic is unchanged and the page is what it always was.

### 14.5 The ladder, and the one cap on it

`_studyTo` is 0, 1 or 2 and `_studyK` is a continuous position along that
ladder; every pose term is a piecewise function of the one scalar, and every way
in or out moves it by exactly one level. Verified in the real game: Escape from
the close look gives level 1, Escape again gives level 0 with the book still
open, Escape again shuts it.

The tilt does NOT move on the second segment. At full lean the page is already
10 degrees off face-on, so there is nothing left to win, and `STUDY_TILT`'s
argument against going face-on (a page perpendicular to the lens has no
perspective in it and the book stops being an object in a room) applies with
more force this close, not less. Level 2 is a pure move toward the print.

**`close()` caps the ease-out at `SCRIPT.close`.** The put-down is 0.46 s and
`_visible` goes false at the end of it; two levels at `STUDY_OUT` is 0.68 s, so
without the cap the third zoom level would have quietly broken the close
animation §13.1 was careful to get right — the book would vanish still
half-zoomed instead of going back and going down as one movement. Verified:
`close()` called from level 2 leaves `zoomLevel 0`, no patch, and **no leaf with
its print still hidden**.

### 14.6 The download was cancelled mid-round

The brief also asked for a "save this print" control. The user withdrew it —
*"Yea maybe 512 is too small, forget the download then"* — while it was still at
the design stage, so there is no half-wired control anywhere and nothing was
removed. What the design had settled on, in case it comes back: a real
`<a download>` element over the canvas rather than anything painted into the
book, because a download needs a user activation on an anchor either way, and
the honest place for a browser gesture is the browser's own vocabulary. The
journal's capture-phase pointer handler would have to return early for events
whose target is inside it, or `preventDefault` on `pointerdown` suppresses the
click.

### 14.7 Noted, not done

* **The wheel backs out rather than zooming in.** One detent is one level out,
  the same as a page key, which is consistent with §13.1 — but a wheel is the
  one input a player might reasonably expect to work in both directions. It was
  left alone rather than given a second meaning in this round.
* **A click on a DIFFERENT print while leaning in backs out** instead of hopping
  to that entry. At this framing the other print is a sliver at the edge of the
  frame and a sliver that teleports the book is a way to lose your place.
* **No stat and no posthog event** for reaching the close look. `src/game/` is
  not this module's to write to, and `Stats.js` has exactly one external writer
  today (`hud_photo`) which is flagged as unusual where it happens.
* At dpr 2 the print is a 1.72x upscale. The fix is a bigger stored photo and
  the number is in §14.3; nothing in `src/journal/` has to change for it.

---

## 15. Round 6 — the print that was not there, and replacing one

### 15.1 The close look was bare paper on half the sheet

*"I took a new photo, but when I zoom further its not there. The old photo is
though. Just not this new one."*

**It was never about new against old, and it was never about the store.** It was
about WHICH PAGE the print is on. Pages 1 and 3 are versos — the left-hand leaf
of a spread — and every print on one of them was bare paper at the close look.
That is eight of the fifteen lines: deer, rabbit, squirrel, raccoon, owl, heron,
flamingo, fireflies. The other seven (pages 2 and 4) were always fine, which is
why a player whose older print happened to be a waterfall and whose new one
happened to be a deer reads it as "the new one is broken".

**The mechanism.** `samplePage` hands back the LEAF's own basis. `poseJournal`
bends the left-hand leaf with `p = 1`, so `deformPage` writes it a normal of
(0, 0, -1) and a tangent that runs the other way — it is a sheet that has been
turned over, which is also why `journal_model` draws it `pageMat(BackSide)` and
why `journal_page._toUV` flips u on a verso. `_detailShow` copied that basis
onto the patch quad unchanged, so on a verso the quad was:

* **front-face culled** — its own +Z pointed away from the reader, and
* **0.9 mm UNDER the paper**, because the hold-off is applied along that same
  +Z and the leaf's opaque depth write then covered it.

And `hidePrint` had already taken the baked print out of the page texture (§14.4
— it is hidden rather than covered because the patch is translucent in three
places). Hidden print, invisible replacement: bare paper.

Measured through the real game with `tools/_scratch/_jsweep.mjs`, as the quad's
own +Z against the direction the camera is looking — negative is facing the
reader:

| | before | after |
|---|---|---|
| recto — fox (page 2), highCamp (page 4) | −0.985 | −0.985 |
| verso — deer (page 1), owl (page 3) | **+0.985** | **−0.985** |

The fix is a half-turn about the page's own vertical before the hold-off is
applied. It is one rotation rather than a sign on the lift because the basis
differs from a recto's by exactly that half-turn: X and Z reverse and Y does
not, so undoing it fixes the facing, the hold-off's direction and the print's
handedness in one move.

**Turning the material `DoubleSide` also makes the print reappear, and it is the
wrong fix.** Tried first, captured, and thrown away: seeing the back of a quad
reverses it, so the photograph came back MIRRORED — the plate is
`shots/journal/round6/` against `v1_verso_fixed.png`, same frame, same seat, the
treeline swapped from left to right. An absent print is a bug somebody reports
in a day; a flipped one is a bug nobody ever notices. The quad stays front-sided
on purpose, so a future disagreement between it and the paper is loud.

Plates: `shots/journal/round6/v0_verso_before.png` (bare paper, deer),
`v1_verso_fixed.png` (the same seat, same run of the same harness),
`v2_recto_unchanged.png` (fox, to show nothing moved on the side that worked).
`v0` is captured by `BROKEN=1`, which seeds `_flipY` with an identity quaternion
from the page rather than editing the fix out — the before and the after are the
same binary.

**What it was NOT, since two rounds of diagnosis went there first.** The row
state after an in-session award is correct: driven through the real shutter,
`{done: true, hasPhoto: true, photoW: 1024, patchW: 1825}` with no reload.
`printPatch` returns its 1825 px canvas on a verso exactly as on a recto. The
`THUMB_MAX` 512 → 1024 change is unrelated and touching it would have changed
nothing. The committed reproduction `tools/_scratch/_patchbug.mjs` reported an
empty row because it awards through a dynamic `import()` inside an evaluate and
therefore into a second instance of the singleton — §13.4's first trap, again.
Its header now says so.

**Adjacent, checked, not touched.** The flying print in the ceremony rides the
same basis and carries the same unsigned hold-off, so on a verso award it is
also a hair under the paper as it lands and is showing its back face for the
flight. It survives because it is `DoubleSide` and because `_bakePhoto` swaps it
for the baked copy within 60 ms of touchdown. Filmed at 90 ms per frame
(`FILM=1 FILM_T0=1700 FILM_DT=90`), the card is on screen mid-flight over the
deer row and lands correctly. The ceremony is signed off and the artifact is one
tumbling card ~50 px across; it is written down rather than fixed.
