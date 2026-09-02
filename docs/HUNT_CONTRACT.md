# The scavenger hunt — module contract

Five features land in parallel. This file is the ONE source of truth for the
seams between them. If your module needs something not written here, do not
invent a call into someone else's file: add the need to the "Open questions"
section at the bottom and design around a stub.

## Ownership — who may edit what

| owner | files |
|---|---|
| **A — journal** | `src/journal/**` (new), `docs/JOURNAL_NOTES.md` |
| **B — focus** | `src/render/PostFX.js`, `src/photo/photo_focus.js` (new) |
| **C — lenses** | `src/photo/lens_models.js` (new), `docs/LENS_NOTES.md` |
| **D — hunt** | `src/game/hunt_items.js`, `src/game/hunt_store.js`, `src/game/hunt_detect.js`, `src/audio/journal_audio.js` (all new) |
| **integrator (main session)** | `src/ui/hud_photo.js`, `src/ui/HUD.js`, `src/ui/hud.css`, `src/main.js`, `src/audio/Audio.js`, `src/game/Stats.js` |

**Nobody but the integrator touches `hud_photo.js`, `HUD.js` or `main.js`.**
Three of you need something wired there; you get it by exporting a clean API and
saying so in your report. Editing it yourself means three agents rewriting the
same 40 lines.

`src/render/PostFX.js` belongs to B alone.

## The world you are building in

- three.js r180 + `postprocessing` 6.37, Vite, no build step. No TypeScript.
- Everything is procedural — there are no mesh or texture assets in this repo.
  Fonts are the one exception being introduced (see A).
- Systems get `ctx`: `{ THREE, engine, input, scene, camera, renderer, world,
  poi, terrain, lighting, sky, postfx, quality, preset, systems }`.
  `ctx.systems` has `wildlife, vehicle, boat, camp, cameraRig, audio, hud, stats`.
- Photo mode (`src/ui/hud_photo.js`) sets `ctx.worldPaused = true`, pins the
  render resolution to native, takes driving input away, and hands the camera to
  `CameraRig`'s free mode. Read that file's header before you assume anything.
- House style: dense, honest header comments that explain *why* — including the
  wrong thing that was tried first. Read two or three neighbouring files and
  match them. Terse code with no comment is off-style here; so is a comment that
  restates the code.

## Dev server

Port **5199** serves this worktree (`http://127.0.0.1:5199`). 5178 serves a
DIFFERENT checkout — measuring or screenshotting against it silently tests
someone else's code. Every tool takes the port:

```
AUTUMN_URL=http://127.0.0.1:5199 node tools/health.mjs
node tools/shot.mjs --url 'http://127.0.0.1:5199/?seed=20261018' --out /tmp/x.png --view drive
```

`tools/shot.mjs` takes `--eval "<js>"` after the pose, and hides the HUD unless
you pass `--eval "window.__hudForce = true"`. `window.__ctx`, `window.__systems`,
`window.__postfx` are on the page.

Do not run two timing tools at once; captures take a cross-checkout lock.

---

## The seams

### D — `src/game/hunt_items.js`

```js
export const HUNT_ITEMS = [
  { id: 'deer', subject: 'a white-tailed deer', hint: 'meadow edges, at dawn' },
  ...
];
```

`id` is stable forever (it is a localStorage key). `subject` is the noun phrase
the journal prints after "Photo of ". Order is the order on the page.

Required items: every mammal (`deer, bear, rabbit, fox, squirrel, raccoon`),
every perch-and-fly bird (`baldEagle, heron, flamingo, duck, owl`), plus
`highCamp` ("a high mountain campsite"), `burntMallow` ("an over-roasted
marshmallow"), `fireflies`, `waterfall`.

### D — `src/game/hunt_store.js`

```js
export const hunt = new HuntStore();      // module singleton, like stats_store
hunt.items                 // HUNT_ITEMS
hunt.isDone(id) -> bool
hunt.photoFor(id) -> dataURL | null
hunt.award(id, dataURL) -> bool           // false if already done; persists
hunt.doneCount() / hunt.total
hunt.reset()
```

Persistence is localStorage under `pa.hunt`, same forgiving-parse discipline as
`src/game/stats_store.js`. Photos are downscaled before storage — a native-res
PNG is megabytes and localStorage is ~5 MB. Budget: longest edge ≤ 512 px,
JPEG q≈0.72, and drop the oldest photo rather than throw when a write fails.

### D — `src/game/hunt_detect.js`

```js
export function detectSubjects(ctx) -> string[]   // item ids in frame RIGHT NOW
```

Called synchronously from `PhotoMode.capture()` on the frame the shutter fires.
Reuse the frustum + distance discipline in `src/game/Stats.js:_look` — that file
already resolves "in frame", "how close counts", and where the player actually
is. A photo is a deliberate act, so it may be more generous than a sighting, but
say what you chose and why in the header.

### A — `src/journal/Journal.js`

```js
export class Journal {
  constructor(ctx)
  get active()
  open({ award = null } = {})   // award: { id, photoDataURL } | null
  close()
  toggle()
  update(dt)                    // REAL time — called while the world is paused
  render(renderer)              // draws the overlay; integrator calls this
                                // right after postfx.render(dt)
  dispose()
}
```

`open({award})` runs the full ceremony: book rises, cover opens with the page
turn, then the item is crossed off and the photo is taped in. `open()` with no
award just opens it to the checklist. The store is read through `hunt` (D) —
until D lands, code against the API above and stub it.

### B — `src/photo/photo_focus.js`

```js
export class PhotoFocus {
  constructor(ctx)
  enable()  / disable()          // disable() restores PostFX exactly
  setDistance(m) / get distance
  nudge(steps)                   // one wheel detent, log-scaled
  focusAtCentre()
  setAperture(f) / get fStop
  update(dt)
}
```

`disable()` putting PostFX back exactly as found is not optional — see how
`hud_photo._readGrade/_saved` handles exposure, and the bug in that file's
comment about what happens when a mode restores the wrong number.

### C — `src/photo/lens_models.js`

```js
export const LENSES = [
  { id: 'wide', name: '24-70mm', mmMin: 24, mmMax: 70, ... },
  { id: 'tele', name: '200-400mm', mmMin: 200, mmMax: 400, ... },
];
export function fovForFocal(mm) -> degrees        // 36 mm full-frame horizontal
export function buildWideZoomLens(rnd, opts) -> THREE.Group
export function buildTeleZoomLens(rnd, opts) -> THREE.Group
```

The `build<Thing>(rnd, opts) -> THREE.Group` naming is a real convention: the
object gallery (`gallery.html`, `src/tools/gallery/registry.js`) discovers props
by that shape with no edit to the registry. `src/photo/` is inside the glob, so
your lenses appear in the gallery for free. Check that they do.

## Audio

Every sound in this game is synthesised — `src/audio/synth.js` is the toolkit
and `src/audio/camp_props.js` is the best worked example of one-shot voices.
There are no sample assets. D writes `src/audio/journal_audio.js` exporting the
three journal voices (`page`, `cross`, `slap`); the integrator wires them into
`Audio.cue`. `sound.html` is a lab page for auditioning cues.

## Open questions
(append here)

- **2026-08-25 — the marshmallow item is no longer dormant.** The roasting
  mechanic landed on `main` and main has been merged into this branch, so
  `camp_marshmallow.js`, `marshmallow_toast.js` and `camp_roast_view.js` are
  real here. `ctx.systems.camp.roast` exposes `.active`, `.mallow`, `.toast`
  (`.doneness`, `.evenness`, `.burning`), `.result` and the counters
  `.roasted/.dropped/.burnt`. `marshmallow_toast.js`'s header is the authority
  on what "over-roasted" means numerically — `grade()`'s outright-charred
  threshold is 0.84 mean doneness. Photo mode already stands the stick in the
  world and pauses the cook on entry (`RoastView.handOff`), so the intended
  capture is: burn one, press F, photograph it on the stick. Detect the
  marshmallow **in the world**, not the grade of one already eaten.
