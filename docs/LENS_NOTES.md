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
kit.zoom(steps) -> 'zoom' | 'end' | 'swap' | null
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
different from owning one 24-400 superzoom. So the mechanic leans on the gap
rather than papering over it.

**One ladder, one control.** `zoom()` walks a single log-spaced ladder of focal
lengths across *both* lenses. Turn the ring past 70 and the next call changes
the lens. Counted by walking it, not by dividing logs: **49 distinct focal
lengths from 24 to 400 in 49 calls** — 28 detents up the wide, one of
resistance at 70, one swap, 18 detents up the tele and one clamp onto 400. The
tele's own 200 → 400 is **19 calls and 20 distinct focal lengths**, not the 26
an earlier draft of this file claimed. The spacing is even in *ratio*, which is
the only spacing that feels even, because 24 → 26 is a visible change and
380 → 400 is not, so a linear ring is dead for its whole top half.

(The constant is `RING_DETENTS`. It was `DETENTS_PER_STOP`, in a file that also
models aperture stops, which read as "detents per f-stop". It is detents per
ring.)

**The stop is felt before it is crossed, and a flick cannot spend the feeling.**
A call that runs into the limit *parks against it*: the focal clamps, `'end'`
comes back, and the rest of the steps are discarded. Crossing takes a **separate
call** that begins at the stop. So `zoom(3)` from 65 mm returns `'end'` at 70,
`zoom(-3)` from 205 returns `'end'` at 200, and `zoom(30)` from 24 returns
`'end'` at 70 — all measured. One more call in the same direction swaps.

That matters because §3 binds `[` and `]` to `_ring(±3)`: the key that actually
turns the ring is a multi-step call, and the previous version banked and spent
the detent of resistance inside its own loop, so the one control the resistance
existed for was the one control it never applied to.

Walking the ladder one call at a time, both ways:

```
up:    zoom:wide@25 … end:wide@70   swap:tele@200 … end:tele@400
down:  end:tele@200  swap:wide@70   … zoom:wide@24
```

**A clamped focal still fires `onChange`.** `zoom()` emits on whether the focal
MOVED, not on which verb it returns. `zoom(2)` from 65 mm lands on 70 and
reports it; it used to move the focal and emit nothing, which left the camera at
65 while `kit.focal` said 70 and the rail label said 70.

**Swapping keeps your place — including on the `L` key.** `setLens` with no `at`
preserves the ring's *ratio* position, so a deliberate swap at the tight end of
the wide arrives at the tight end of the tele, and `cycle()` now does the same:
wide at t 0.5 (41 mm) → `cycle(1)` → tele 283 → `cycle(1)` → wide 41. It used to
pass `at: 'wide'`/`at: 'tight'` and ratchet the ring to an end of the range on
every press. Crossing the gap with the ZOOM RING still uses `at: 'wide'` going up
and `at: 'tight'` coming down, so the focal ladder stays continuous through the
change even though the numbers jump — that rule belongs to the ladder, not to a
deliberate swap.

**Wheel stays the dolly.** `CameraRig._free` owns the wheel and dollies the
camera along the view axis, and that is hours of muscle memory. The zoom ring is
a *different* axis and gets **Shift+wheel** plus a rail slider. Zooming and
dollying are not the same shot and the control should not pretend they are.

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

## 3. Wiring list for the integrator

Everything below is in `src/ui/hud_photo.js` unless noted. Nothing here needs a
change in `lens_models.js`.

**Import**

```js
import { LENSES, LensKit, LensPreview, cameraFovForFocal } from '../photo/lens_models.js';
```

**State — one object, built in the constructor**

```js
this.lensKit = new LensKit({
  lens: 'wide',
  onChange: ({ lens, focal, reason }) => this._applyLens(reason),
});
this.lensPreview = null;          // built lazily on first setActive(true)
```

**Apply — the only line that touches the camera**

```js
_applyLens(reason) {
  const rig = this.ctx.systems?.cameraRig;
  const cam = this.ctx.camera;
  if (rig && cam) rig.fov = cameraFovForFocal(this.lensKit.focal, cam.aspect);
  this.lensPreview?.setZoomT(this.lensKit.t);
  if (reason === 'swap') {
    this.lensPreview?.setLens(this.lensKit.lens.id);
    this.hud.audio()?.cue('door');        // or a new 'lens' cue if D adds one
    this.hud.toast(this.lensKit.lens.display);
  }
  this.lensEl?.set(this.lensKit.t);
  this.lensLabel.textContent = this.lensKit.label();
}
```

`rig.fov` is the right lever and the only one: `CameraRig._apply` writes
`cam.fov = this.fov` and calls `updateProjectionMatrix()` every frame in free
mode, so setting the rig's `fov` is picked up on the next frame and nothing
fights it. Do **not** write `camera.fov` directly — the rig overwrites it.

**On entry (`setActive(true)`, after `rig.enterFree()`)**

```js
// Fit the lens the player was already looking through, so the first frame of
// photo mode is still the frame they pressed F on.
const mm = focalForCameraFov(this.ctx.camera.fov, this.ctx.camera.aspect);
const l = LENSES.find((x) => mm <= x.mmMax) ?? LENSES[0];
this.lensKit.setLens(l.id, { focal: mm });
this._applyLens('set');
```

(`enterFree` copies the live camera fov into `rig.fov`, so this is a no-op in
practice on the wide lens — which is the point: the wide at 24 mm *is* the play
camera. It matters if a player exits at 400 mm and comes back.)

**On exit (`setActive(false)`)** — nothing. `_saved` already restores the camera
mode and `exitFree` re-primes the rig, which re-derives `fov` from the chase
grade on the next frame. Do not save/restore the focal length: the lens is a
property of photo mode, and coming back to the lens you left on is the nicer
behaviour anyway (`this.lensKit` persists across visits for free).

**Rail UI** — one slider and one label, above the shutter:

```js
this.lensEl = this._slider(rail, 'Lens', 'lens', () => '', (v) => this.lensKit.setT(v));
// RANGES.lens = [0, 1, 0.001]
this.lensLabel = el('div', 'pa-lens-label');   // shows kit.label()
```

The slider drives only the fitted lens (0..1 across its own range). Crossing the
gap is a deliberate act and belongs on the key and the swap button, not on a
drag that could cross it by accident.

**Keys** — inside the rail's existing `keydown` handler, beside `KeyP`/`KeyG`
(they need the same local path, for the reason that handler already documents):

```js
if (e.code === 'KeyL') { this.lensKit.cycle(e.shiftKey ? -1 : 1); e.preventDefault(); return; }
if (e.code === 'BracketLeft')  { this._ring(-3); e.preventDefault(); return; }
if (e.code === 'BracketRight') { this._ring(+3); e.preventDefault(); return; }
```

```js
_ring(steps) {
  const r = this.lensKit.zoom(steps);
  if (r === 'end') this.hud.audio()?.cue('tick');    // the ring hitting its stop
}
```

`_ring(±3)` is a multi-step call and it is safe: a gesture that reaches the end
of the lens parks there and returns `'end'` with the remaining steps discarded,
so `]` held down walks to 70 mm and stops. The *next* press crosses. The focal
change that happens on the way to the stop still fires `onChange`, so
`_applyLens` runs and the camera and the label agree with `kit.focal` — do not
gate the apply on the returned verb.

**Shift+wheel** — the zoom ring. `CameraRig._free` reads `input.mouse.wheel`
unconditionally, so the wheel has to be intercepted before the rig sees it.
Cleanest place is `PhotoMode`'s own listener on `this.node`, added in
`setActive(true)` and removed in `setActive(false)`:

```js
this._onWheel = (e) => {
  if (!e.shiftKey) return;                    // plain wheel stays the dolly
  e.preventDefault();
  this._ring(e.deltaY > 0 ? -1 : 1);
  if (this.ctx.input) this.ctx.input.mouse.wheel = 0;   // don't also dolly
};
this.node.addEventListener('wheel', this._onWheel, { passive: false });
```

**Preview** — build lazily, drive on real time:

```js
// in setActive(true):
if (!this.lensPreview) {
  this.lensPreview = new LensPreview({ lens: this.lensKit.lens.id });
  if (this.lensPreview.ok) this.lensSlot.appendChild(this.lensPreview.canvas);
}
// wherever the HUD gets a real-time tick while worldPaused:
this.lensPreview?.update(dtReal);
```

`update(dt)` must be given **real** seconds. Photo mode sets `ctx.worldPaused`,
which drives every world system at dt 0; the rail, the camera rig and the music
already run on real time and this belongs with them.

**Rail hint** — three lines to add to the existing hint block:

```
L      lens
[  ]   zoom ring
shift-wheel   zoom ring
```

**`hud.css`** — the preview canvas needs a slot; nothing else. Suggested:
`.pa-lens-slot { width: 188px; height: 128px; }` and
`.pa-lens-label { font-variant-numeric: tabular-nums; }`.

### What C does NOT need from anyone

No changes to `CameraRig`, `PostFX`, `main.js`, `Audio.js` or `Stats.js`. If D
adds a `lens` and a `tick` cue to `Audio`, `_applyLens`/`_ring` should use them
instead of `door`; until then `door` is a defensible stand-in and nothing breaks
if the cue does not exist (`audio()?.cue` is already optional everywhere).

---

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
