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
  onClose = null                // NEW — integrator hook, fired once by close()
  open({ award = null } = {})   // award: { id, photoDataURL } | null
  close(); toggle()
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
  panel, `5,566 triangles · 23 meshes · 15 materials`, size `0.16 × 0.22 × 0.03 m`
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
  an explicit box; the gallery reports **0.16 × 0.22 m** shut and the true
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
