# Lenses — `src/photo/lens_models.js`

Owner C of the scavenger-hunt effort. One file, no edits anywhere else.

Two lenses for photo mode, the optics that make swapping between them mean
something, and a small self-contained 3D preview for the rail.

Everything below is the *contract*. The reasoning, and the several separate
things that were wrong before they were right, live in the file's own header and
in the comment above each function — that is where to look before changing a
number. Where this file used to assert something the code did not do, the claim
has been replaced with the measurement rather than softened.

---

## 1. What is exported

### Optics

```js
FRAME_W = 36                          // full-frame, mm
FRAME_H = 24

fovForFocal(mm)          -> degrees   // HORIZONTAL angle of view off a 36 mm frame
focalForFov(deg)         -> mm        // inverse
cameraFovForFocal(mm, aspect) -> deg  // VERTICAL, i.e. what three wants
focalForCameraFov(v, aspect)  -> mm   // inverse; round-trips exactly

APERTURE_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22, 32]
stopsFor(lens)           -> the subset this lens can be set to
```

`fovForFocal` is horizontal because that is the number a photographer means by
"a 24 mm lens", and because it is aspect-independent. `PerspectiveCamera.fov` is
**vertical**, so anything writing the camera must go through
`cameraFovForFocal(mm, camera.aspect)` — matching the horizontal angle and
deriving the vertical from the real viewport means a 24 mm lens frames the same
amount of valley left-to-right on every monitor, and a taller window shows more
sky rather than silently becoming a wider lens.

Measured:

| mm | horizontal fov | vertical fov at 16:9 |
|---|---|---|
| 24 | 73.7° | 45.8° |
| 35 | 54.4° | 32.0° |
| 70 | 28.8° | 16.4° |
| 200 | 10.3° | 5.8° |
| 400 | **5.15°** | 2.9° |

**The game's normal camera is a 22 mm lens.** `CameraRig` runs about 50° vertical
in chase, which at 16:9 is 79° across, which is 21.7 mm. So the wide lens at its
wide end is almost exactly the view the player already had — putting it on
changes nothing, which is the right default, and every step from there is a
change they asked for.

### The bag

```js
LENSES = [
  { id: 'wide', name: '24-70mm',  display: '24-70mm f/2.8',
    mmMin: 24,  mmMax: 70,  mmDefault: 35,
    fStop: 2.8, fStopMin: 22, stops: [2.8, 4, 5.6, 8, 11, 16, 22],
    minFocus: 0.38, filter: 82,
    fovWide: 73.74, fovTight: 28.84,
    blurb: '…', build: buildWideZoomLens },

  { id: 'tele', name: '200-400mm', display: '200-400mm f/4',
    mmMin: 200, mmMax: 400, mmDefault: 200,
    fStop: 4,   fStopMin: 32, stops: [4, 5.6, 8, 11, 16, 22, 32],
    minFocus: 2.0, filter: 52,
    fovWide: 10.29, fovTight: 5.15,
    blurb: '…', build: buildTeleZoomLens },
]

lensById(id) -> lens          // never returns undefined; falls back to LENSES[0]
```

`id` is stable forever — it is what a saved setting would hold.

`fStop` is the **maximum aperture** (both are constant-aperture zooms, like the
lenses they are modelled on) and `minFocus` is metres. Both exist for B's
`PhotoFocus`: `setAperture` should be clamped to `stopsFor(lens)` and
`setDistance` to `>= lens.minFocus`.

### The switching state machine

```js
new LensKit({ lens = 'wide', focal, onChange })

kit.lens          // the LENSES entry
kit.focal         // mm
kit.t             // 0..1 position of the zoom ring on the fitted lens
kit.fov           // horizontal degrees
kit.cameraFov(aspect)
kit.label()       // "24-70mm · 35mm · f/2.8"

kit.setFocal(mm)
kit.setT(t)                       // what a slider drives
kit.setLens(id, { at, focal })    // at: 'wide' | 'tight' | undefined (keep ratio)
kit.cycle(dir)                    // next lens in the bag, wrapping
kit.zoom(steps) -> 'zoom' | 'end' | null
```

`onChange({ lens, focal, reason })` fires on every change; `reason` is
`'zoom' | 'swap' | 'set'`. It fires whenever the focal actually moves, including
the move that ends against a stop.

`setFocal` and `setT` reject non-finite input and return `false`. `clamp` is
`Math.min`/`Math.max` and both propagate NaN, so `setFocal(NaN)` used to return
`true` and hand `fov`, `cameraFov` and then `rig.fov` a NaN — a NaN projection
matrix and a black screen, two systems away from here.

### The models

```js
buildWideZoomLens(rnd, opts) -> THREE.Group
buildTeleZoomLens(rnd, opts) -> THREE.Group

opts.hood  // fit the hood, default true
opts.wear  // 0..1, default 0.35
opts.zoom  // 0..1 initial ring position, default 0
```

Both are found by the object gallery with no registry edit (they match
`build<Thing>(rnd, opts)` and `src/photo/` is inside its glob) — confirmed:
they appear as **Photo props · lens_models**.

Group space: the lens lies on a table. `+Z` out of the front, `+Y` up as the
lens hangs on a camera, `y = 0` the table — the wide rests on its hood and
mount, the tele on its tripod foot. Published on the group:

```js
userData.anchors = { axisY, length, mount, front, entry }   // Vector3s, group space
                                  // axisY is MEASURED off the posed model, not
                                  // predicted from the spec: both lenses rest
                                  // with their lowest vertex at y = 0 exactly,
                                  // hood on or off, ring at either end.
userData.lens                     // the LENSES entry
userData.parts = { rig, body, zoom, focus, front, hood }
userData.setZoom(t)               // turns the zoom ring 69° AND slides the
                                  // front group out (wide 22 mm, tele 38 mm).
                                  // The printed focal scale rides the ring, so
                                  // the number under the red index at noon is
                                  // the focal length t stands for.
userData.setFocus(t)              // turns the focus ring
userData.dispose()                // the print textures/materials this build owns
```

`disposeLensMaterials()` frees the shared set. Nothing calls it yet; the game
never needs to.

### The rail preview

```js
new LensPreview({ width = 188, height = 128, dpr, lens })
p.ok           // false if a GL context could not be had — degrade to text
p.canvas       // append this to the rail
p.setLens(id, { animate })
p.setZoomT(t)
p.update(dtRealSeconds)
p.dispose()
```

---

## 2. The switching mechanic, and why

The user asked to "switch between the lenses in photo mode". The interesting
design fact is that **the two ranges do not meet**: 70 mm to 200 mm is a real
gap in a real bag, and it is the whole reason owning these two lenses is
different from owning one 24-400 superzoom.

**The ring stops where the barrel stops.** `zoom()` walks the FITTED lens and
parks at its own limits, returning `'end'` at either one. It never changes the
body. `cycle()` — the `L` key and the rail's swap button — is the only way
across the gap.

### What this replaced, and why it went

This section used to describe the opposite, at length, because the opposite was
argued for and shipped: **one ladder across both lenses**, 49 distinct focal
lengths from 24 to 400 in 49 calls, crossing the gap on a second deliberate
call after a banked detent of resistance so a fast flick could not do it by
accident. It was a nice mechanic and a critic liked it.

The person the mode is for did not: *"the zoom ring should not change lenses
automatically. It should just toast saying 'cannot zoom out further, switch
lenses' same in the max direction."* That settles it. A control that swaps the
glass on your camera without being asked is doing something you did not ask for,
however well it is signposted, and the signposting was a tick and a hint line
in a legend nobody read.

The gap-crossing machinery is **removed**, not disabled — `_gap` is gone from
`LensKit` and `'swap'` is gone from `zoom()`'s return type. A verb no path can
produce is a verb the next reader has to prove is dead.

### What the caller is expected to do about `'end'`

Say so. `hud_photo._ring` ticks on every press at the stop — that is the barrel
refusing to turn and you want to feel it each time — and TOASTS ONCE:

```
70 mm is all the reach this lens has — change lens for more
24 mm is as wide as this lens goes — change lens to go wider
```

Once, not per detent: `_atStop` remembers which end was announced and
`LensKit`'s `onChange` clears it the moment the focal actually moves. Measured:
forty presses of `]` from 24 mm end on `wide@70` with **one** toast and the body
unchanged; forty of `[` end on `wide@24` with one more.

**A gesture that runs into the stop stops there**, discarding whatever steps it
had left. That mattered when the next step could change the lens and it still
matters: without it a multi-step call would report `'end'` once per remaining
step and the caller would toast three times for one press.

**A clamped focal still fires `onChange`.** `zoom()` emits on whether the focal
MOVED, not on which verb it returns. `zoom(2)` from 65 mm lands on 70 and
reports it; it used to move the focal and emit nothing, which left the camera at
65 while `kit.focal` said 70 and the rail label said 70.

Detents are LOG-SPACED, which is the only spacing that feels even: 24 -> 26 is a
visible change and 380 -> 400 is not, so a linear ring is dead for its whole top
half. `RING_DETENTS` is 28 over the wide's 24-70, and the same ratio per detent
covers the tele's 200-400 in 19.

**Swapping keeps your place — including on the `L` key.** `setLens` with no `at`
preserves the ring's *ratio* position, so a deliberate swap at the tight end of
the wide arrives at the tight end of the tele, and `cycle()` now does the same:
wide at t 0.5 (41 mm) → `cycle(1)` → tele 283 → `cycle(1)` → wide 41. It used to
pass `at: 'wide'`/`at: 'tight'` and ratchet the ring to an end of the range on
every press. `at` is still a parameter of `setLens` and nothing in the shipped
tree passes it any more — it belonged to the ladder that used to cross the gap,
and it is kept because a caller wanting "swap and start at the wide end" is a
reasonable thing to want.

**Wheel stays the dolly.** `CameraRig._free` owns the wheel and dollies the
camera along the view axis, and that is hours of muscle memory. Zooming and
dollying are not the same shot and the control should not pretend they are, so
the ring gets `[` and `]` and a rail slider — and NOT shift+wheel, which this
file claimed for two rounds after `PhotoFocus` had taken it for the focus pull.

**And a preview, because otherwise nobody sees the lens.** Decided yes: a small
3D panel in the rail showing the fitted lens, turning slowly, with a bayonet
twist on the swap. Without it the models are decoration — the player would only
ever experience a lens as a number changing. `LensPreview` is deliberately
self-contained (its own canvas, renderer, scene, lights) rather than scissored
into the main renderer: photo mode has a scar in its own header about a mode
restoring the wrong number on the way out, and every frame of a shared-renderer
preview would be another chance to leave something set. It costs one extra GL
context, created lazily on first open and handed back on `dispose()` with
`forceContextLoss()` — `renderer.dispose()` alone frees three's objects and
leaves the context to the garbage collector, which is fine once and not fine for
a mode that can be opened all session.

**THE PANEL IS THE SHIPPING SURFACE, NOT THE GALLERY.** Three of the nine things
wrong with the first round were only wrong here, and all three were invisible in
a 700 px gallery view:

- The framing fitted a *bounding sphere* into the *smaller* half-angle, which on
  a 459 mm lens in a 188 × 128 slot put it 51% too far away: 8.5% of the panel
  covered. It now fits the yaw-invariant sweep radius horizontally and the
  tilted height vertically — 16-29% covered across a full turn, never clipped.
- The swap animation wrote `model.position.z` outright, over the framing offset
  the model had been recentred with, so from frame one the lens was mounted
  228 mm off the pivot it turns about and the idle *orbited* it. Each lens now
  hangs in a holder: centring on the model, animation on the holder.
- The lighting was the gallery stage's — warm key over a gold ground bounce —
  and at 188 px that is not "a dark grey lens in warm light", it is a brown
  lens. The ground bounce is a dim neutral here and the exposure is 1.0. The key
  stays warm; it was the fill on the shadow side that was choosing the colour.

`update(dt)` draws only when the pose has changed, so `update(0)` from a paused
rail costs a comparison. The idle turntable never stops, so a rail that ticks
with real time draws every frame — the way to stop paying for this panel is to
stop calling `update`.

---

## 3. How it is actually wired

This section used to be a **proposal** — a wiring list written for whoever would
integrate the kit, full of code the integrator was invited to paste. Every
snippet in it has since been overtaken: it named `_applyLens`, `_ring(±3)` and a
"Lens" slider that do not exist, it gave **shift+wheel** to the zoom ring (that
is the FOCUS control now — see `src/photo/photo_focus.js`), and it listed a
three-line rail hint for a hint column that has been deleted. This file has now
been caught twice describing behaviour the code does not have, so the proposal
is gone and what follows is the shipped wiring.

Everything is in `src/ui/hud_photo.js`; `lens_models.js` needs no caller-side
special cases.

**The kit** is one `LensKit` built in `PhotoMode`'s constructor. Its `onChange`
does five things and they are all in one place on purpose: write `rig.fov`,
drive the preview's ring and body, re-clamp the aperture to the fitted lens,
re-sync the rail (`_syncLens`), and play a cue. A `_fitting` flag silences the
cue while this file is fitting a lens on the way into the mode — that is not the
player turning anything.

**The camera lever is `rig.fov`, never `camera.fov`.** `CameraRig._apply` writes
the camera's fov from its own every frame in free mode, so anything written
straight onto the camera is gone by the next one. And it is the VERTICAL angle,
so it goes through `cameraFovForFocal(mm, camera.aspect)`.

**On entry** the ring is fitted to the frame the player pressed F on —
`focalForCameraFov(camera.fov, camera.aspect)`, then the lens whose barrel
contains that focal, then `setLens(id, { focal })`. Fitting only the focal
clamps it into whatever body happened to be on, which turned "leave at 272 mm,
come back" into a 200 mm five-degree view of an orange smear.

**Except from the telescope**, where the BODY is chosen for you: the eyepiece
rests at an 18° vertical fov, which is a 64 mm lens, so the fov rule fitted the
24-70 at the exact moment the player had walked to an instrument for reach. The
tele is fitted instead and the ring still comes from the fov, clamped into the
barrel — 200 mm. The sample is `ScopeView.handOff()`'s RETURN VALUE, because
that call is what makes `scope.active` false and anything asking afterwards gets
"no" every time.

**On exit** — nothing. `_saved` restores the camera mode and `rig.fov`, and the
kit persists across visits so the lens you left on is the lens you come back to.

**Controls.** `[` and `]` turn the ring one detent through `_ring`, which owns
the tick and the toast (§2). `L` is `cycle(1)`. Both are also visible controls
on the rail: a **Zoom** slider driving `setT`, and a **Swap** button beside the
lens plate. The slider only ever drives the fitted lens, which is now the same
rule the keys follow rather than a special case.

**The wheel is not a lens control.** Bare wheel is the free camera's dolly and
has been since photo mode existed; shift+wheel is focus and alt+wheel is the
aperture, both owned by `PhotoFocus`. A fourth wheel gesture would be a modifier
nobody could remember.

**The preview** is built on the FIRST `F`, not at boot — a second WebGL context
is not free and photo mode may never be opened — and its absence is survivable:
`LensPreview` returns `ok === false` with no `canvas`, and the lens plate stands
in. `tools/_scratch/_lensguard.mjs` tests exactly that, by refusing every
context after the first. `update(dt)` must be given REAL seconds; photo mode
runs the world at dt 0.

**Sizing.** `LensPreview` sets its canvas's pixel width inline, plus
`max-width: 100%` and `height: auto`. The inline width is a default; the other
two are the licence for a narrower host box to win. Without them the canvas drew
188 px inside a 138 px column and hung 25 px off both sides — an inline style
beats any stylesheet, so `hud.css`'s `width: 100%` had been losing silently.

## 4. Cost

Measured in the gallery, at `opts` defaults with the hood on:

| | triangles | meshes | size (zoom 0) |
|---|---|---|---|
| `buildWideZoomLens` | 16,416 | 21 | 0.10 × 0.10 × 0.17 m |
| `buildTeleZoomLens` | 20,328 | 22 | 0.14 × 0.16 × 0.46 m |

Ten materials each, seven of them the shared set. About 55% of the triangles
are the two grip rings, which are lathes at six facets per rib — that is what
buys ribbing you can see the light catch, and it is the one place worth spending
on a prop this size.

Both rest with their lowest vertex at **y = 0 exactly**, hood on or off, ring at
either end. That is measured at build time (`Box3.setFromObject(root, true)`,
after the pose, `precise` because a rotated ring's AABB is not its extent)
rather than predicted from the spec, which is how the tele came to float 3.9 mm
and the hoodless wide 5.6 mm.

These are UI-scale props. Neither is ever in the world: the only things that
draw them are the object gallery and `LensPreview`'s own renderer.

## 5. Honest weaknesses

- **The print is alpha-tested geometry, 0.4 mm proud of the barrel.** At the
  sizes it is actually seen (gallery, and a 188 px preview panel) it is clean,
  but an alpha-tested decal is the wrong tool if a lens ever ends up in the
  world under the upscale pass — it will crawl. If that happens, the answer is
  to bake the markings into the barrel's own material rather than to fight it.
- **The barrel still reads warm in the GALLERY**, under that stage's warm key
  plus its gold ground bounce. That is the game's light and every prop in the
  camp takes the same tint, so it is consistent rather than wrong — but a critic
  who wants a neutral grey lens will see it. The preview panel, which is the
  surface that ships, no longer does: it runs its own neutral ground bounce at
  exposure 1.0 and measures a red-minus-blue of 0 to 10 across a full idle turn,
  against 21 before. The lever for the gallery is `lensMaterials().barrel`, and
  the argument for not simply cooling it is in the comment above it.
- **The 200-400 extends 38 mm, and the lens it is modelled on does not.** A
  200-400 f/4 is an internal zoom. It was authored that way and it produced a
  zoom control with no visible response at the size the player sees it: the ring
  turning and the printed scale travelling under the index together moved 1.9%
  of the rail panel's pixels across the whole 200 → 400 range. Extension moves
  9.4%, because it changes the silhouette, and a silhouette is most of what a
  120 px lens has. The trade is deliberate and it is the wrong way round for
  anyone who knows the reference lens.
- **The 24-70 extends monotonically toward 70 mm.** The real lens it is modelled
  on is longest at both ends of its range and shortest in the middle. Modelling
  that would need `setZoom` to be non-monotonic for no gain anybody can see in a
  188 px panel.
- **The tripod collar sits at 15% of the tele's length**, so three quarters of
  the lens cantilevers forward of its own support. The foot is 118 mm now
  instead of 82, which puts more plate under it and reads better, but the collar
  itself cannot move without re-laying the whole barrel z-ladder — the rear
  barrel, the collar and the zoom ring are packed nose to tail between 4.5 mm
  and 147 mm, and there is nowhere for it to go. A real 200-400 carries its
  collar at about a third.
- **`LensPreview` opens a second WebGL context.** One is cheap and the budget is
  ~16; it is created on first entry to photo mode and released on `dispose()`.
  If a future mode wants a third and a fourth, they should share one offscreen
  renderer rather than each taking their own.
- **Neither lens has been seen under `Stylize`**, because nothing renders them
  in the game scene. The materials are authored for it (dielectrics only,
  `keepPhysicalSpecular` on the glass), but that is an argument, not a
  measurement.
