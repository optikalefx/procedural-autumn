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
   proud as the block is thick reads as a log.
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

The brief recommended **Special Elite**, a distressed typewriter. A specimen of
four candidates over the real page layout is in the report. Two things argued it
down: it is Apache-2.0, not OFL; and read at real size, a typewriter heading
over a handwritten list says "printed form somebody filled in", where a personal
field journal is one person's hand throughout. Caveat Brush is literally the
same skeleton with a fatter pen. Amatic SC was the other OFL candidate and goes
wiry at heading weight on a cream ground.

The trap this guards: **a CanvasTexture drawn before the webfont loads renders
in the fallback face and never redraws.** Nothing paints before
`journalFontsReady()` resolves, and every page can repaint.

## 6. What was verified, and how

- `gallery.html` on 5199 lists **Journal** as its own group with three
  colourways, an `open` slider, `buildJournal(rnd, {"colorway":1})` on the info
  panel, `5,982 triangles · 22 meshes · 14 materials`, size `0.32 × 0.38 × 0.03 m`.
- `tools/_scratch/_jingame.mjs` boots the real game on 5199, constructs a
  Journal against the real `ctx`, chains `render` behind `postfx.render`, runs
  the whole ceremony and closes it. **No console errors.** Renderer state after
  close: render target null, scissor test off, `toneMapping` NoToneMapping,
  `shadowMap.enabled` true — all as found.
- `AUTUMN_URL=http://127.0.0.1:5199 node tools/health.mjs` — `shaderFailures: 0`,
  every system up; the only console error is the pre-existing
  `VITE_POSTHOG_KEY` warning.
- `tools/_scratch/_jceremony.mjs` films the ceremony as a strip on a
  hand-stepped clock, so a timing change can be A/B'd frame for frame.

## 7. Cost

5,982 triangles, 22 draw calls, 14 materials for the book. The overlay scene has
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
- **The contact shadow plane is inside the model's bounding box**, so the
  gallery reports the journal as 0.32 × 0.38 m rather than the book's own
  0.16 × 0.22 m. Cosmetic, on a dev page.
- **A repaint is ~40 ms.** `strikeAt`/`tickAt`/`tapeAt` avoid it with partial
  blits, but anything that calls `JournalPage.paint()` mid-ceremony will drop a
  frame. Today only `_armAward` and `_bakePhoto` do, both at moments where the
  book is still.
- **The cover swing borrows the page voice.** `src/audio/journal_audio.js`
  ships exactly `page`, `cross`, `slap`, so the cover open cues `journal.page`
  rather than a name nobody wrote. A dedicated leather-and-board `cover` voice
  would be better and it is one line in `Journal.update`.
- **Fifteen items is four list pages**, so the last page carries three lines and
  a lot of white. It looks deliberate rather than broken, but a sixteenth item
  would make the sheet square.
