# Roasting marshmallows — the build contract

Five files, five authors, one mechanic. This document is the **only** thing the
five have in common: it names who owns what, and the exact shape of every value
that crosses a file boundary. If your work needs something not written here,
change this document first and say so — do not guess, and do not reach into
another author's file.

## The feature, in one paragraph

A whittled stick with a marshmallow speared on the end leans against the camp
table. Click it and the camera steps to the fireside and takes the stick: a
first-person view over the flames, the stick coming in low from the right, the
marshmallow held over the fire. Drag (or A/D) to **twirl** the stick, drag
vertically (or W/S) to raise and lower it over the heat. The marshmallow
toasts where the fire actually reaches it, so a marshmallow that is not turned
goes black on one side and stays white on the other. Turned patiently it goes
gold all over, swells, and sags. `E` (or a click) eats it. Escape steps back.
There is no timer, no score bar and no fail state — a marshmallow that catches
fire is blown out with a tap, and a marshmallow dropped in the fire is simply
gone, and you go and get another stick.

## The look it is judged against

`docs/DESIGN_BRIEF.md` is the law. Three things specific to this feature:

1. **The fire owns the value range at dusk.** A white marshmallow is the only
   object in this game that can out-value the flame. Author the raw sugar well
   below white (≈`0xe8e0cf`) and let the fire's own light carry it up.
2. **A marshmallow is translucent.** It is not a white cylinder. The single
   detail that makes it read is light coming *through* the far side — a
   wrap/back-scatter term with the fire behind it. Without that it is a pill.
3. **Toast is a gradient with a hard edge inside it.** Sugar caramelises over a
   narrow temperature band: the sweep from cream to gold is slow and smooth,
   the sweep from deep amber to black char is fast and blotchy. A single linear
   ramp reads as a stain. Blisters, bubbles and cracked char are what sell it.

## File ownership — do not edit a file you do not own

| file | owner | may also touch |
|---|---|---|
| `src/camp/camp_marshmallow.js` | geometry | nothing |
| `src/camp/marshmallow_toast.js` | toast sim + material | nothing |
| `src/camp/camp_roast_view.js` | the view and the mini-game | nothing |
| `src/camp/Camp.js`, `camp_site.js`, `src/game/Stats.js`, `src/ui/hud_stats.js`, `src/audio/camp_props.js` | integration | nothing |
| `tools/roastshot.mjs` | the capture harness | nothing |

`docs/ROAST_CONTRACT.md` (this file) is owned by the lead. Anyone may propose a
change to it in their report; nobody edits it.

---

## 1. `src/camp/camp_marshmallow.js` — the geometry

```js
/**
 * The prop that leans against the table.
 *
 * Origin: on the ground, directly under the stick's butt end.
 * +Z faces the fire — Camp.js yaws every prop's +Z at the fire, so the stick
 * must be authored leaning ACROSS that axis (it leans on the table, which
 * stands beside it), not along it. See `opts.leanYaw`.
 */
export function buildRoastStick(rnd, opts = {}) -> THREE.Group
//   opts.restH   number  — the height of the edge it leans on, metres.
//                          The table's top is 0.42; default 0.42.
//   opts.leanYaw number  — bearing, in the prop's own space, of the direction
//                          the stick leans TOWARD (i.e. toward the table).
//                          Default 0 = +Z. Integration passes the real one.
//   opts.toast   0..1    — how used this stick's marshmallow looks. Default 0.
//   opts.wear    0..1    — whittling/char variation on the stick. Default rnd().
//
//   group.userData.roast = {
//     mallow: THREE.Vector3,   // marshmallow centre, prop space — the click target
//     butt:   THREE.Vector3,   // the ground end of the stick, prop space
//     len:    number,          // stick length, metres
//   };
//   group.userData.footprint = 0.28;

/**
 * The same stick, built for the hand.
 *
 * Origin: the GRIP — the point the player's fist would close on, about 0.10 m
 * from the butt. The stick runs along +Z from there, so the marshmallow is at
 * +Z * len. +Y is up when the stick is level. The view rotates this group about
 * its own +Z to twirl, so the marshmallow MUST be authored slightly off that
 * axis — a marshmallow perfectly concentric with the stick is invisible when it
 * spins, and the spin is the whole mechanic.
 *
 * ── AMENDED. Offset and tilt are not the same clause. ─────────────────────
 *
 * The original text asked for "5–12 mm of offset AND a few degrees of tilt",
 * and the two halves have opposite consequences. Measured on the real map
 * against the real pose (`tools/_scratch/mtilt.mjs`, which spins the mallow
 * about the stick's LINE rather than about its own centre, so the offset is
 * actually a variable):
 *
 *   evenness at golden costs  0.0139 per DEGREE of tilt
 *                             0.0010 per MILLIMETRE of offset
 *
 * and neither shrinks with spin rate — 2.0 rad/s and 9.5 rad/s agree to 0.01.
 * The reason is geometric: a lateral offset makes the marshmallow ORBIT the
 * roll axis, so a texel's distance to the fire varies through the turn and
 * averages out over a full rotation. A tilt makes every texel sweep a CONE, so
 * the texels on the far side of the cone are permanently colder and no amount
 * of turning can average that away.
 *
 * Shipped at 13.9 degrees, that capped `evenness` at about 0.81 against a
 * `perfect` threshold of 0.78 — the best a player could possibly do was three
 * hundredths clear of the bar, so the top grade was very nearly a coin toss
 * between camps rather than something skill earned.
 *
 * So the clause is now:
 *
 *   · **offset 5–12 mm — mandatory.** It does all the work of making the spin
 *     legible and costs almost nothing.
 *   · **tilt ≤ 2.5 degrees off the twirl axis.** `tools/_scratch/roastgeo.mjs`
 *     asserts this over 300 seeds; a re-added tilt fails the audit.
 *
 * The crooked-spear read survives on its own: the shaft's own S-bend and droop
 * already arrive at the marshmallow a few degrees off +Z, so the wood still
 * enters at an angle. The toast map does not care what the wood does — only
 * what the marshmallow's own axis does.
 *
 * The LEANING prop is exempt and keeps its larger tilt. It never turns, so its
 * crookedness is free, and a stick left against a table should look thrown down
 * rather than set down.
 */
export function buildHeldStick(rnd, opts = {}) -> THREE.Group
//   opts.rings  number — angular segments on the marshmallow. Default 32.
//   opts.bands  number — axial segments. Default 24. (Both must be generous:
//                        the toast map is sampled per-vertex-interpolated and
//                        the mallow swells and sags in the vertex shader.)
//   group.userData.held = {
//     mallow:  THREE.Mesh,     // the marshmallow. Its material is REPLACED by
//                              // the view with marshmallowMaterial(); build it
//                              // with a placeholder MeshStandardMaterial.
//     tip:     THREE.Vector3,  // marshmallow centre in stick space
//     len:     number,         // grip -> marshmallow centre, metres
//     radius:  number,         // marshmallow radius, metres (~0.021)
//     half:    number,         // marshmallow half-length along its own axis
//   };
```

**The marshmallow's UVs are a contract**, because they are the toast map's
parameterization: `u = angle / TAU` around the marshmallow's own axis measured
from its local +X, `v = 0` at the end nearest the grip and `v = 1` at the far
end, running linearly along the axis. The rounded end caps take the same `v`
extended past 0 and 1 by their own arc — clamped, so the caps read as the poles
of the map. A seam at `u = 0/1` is fine; duplicate the seam ring so it does not
smear.

Real marshmallow proportions: 25 mm long, 21 mm radius — a **squat cylinder,
slightly wider than it is long**, with a generous edge radius (≈5 mm) and flat
ends that dent slightly where the stick goes through. It is not a capsule and
it is not a sphere; both are the classic mistake and both read as candy.

## 2. `src/camp/marshmallow_toast.js` — the toast

```js
/**
 * The toast map: how cooked every point on the marshmallow's surface is.
 *
 * A CPU grid, uploaded as a DataTexture. NOT a render target — the mini-game
 * needs the same numbers the shader draws (doneness, evenness, "is it on
 * fire") and a GPU readback for that is a stall per frame. RINGS x BANDS is
 * 24 x 12 = 288 texels; the fine grain (blisters, char cracks) is procedural
 * in the fragment shader, which is where fine grain belongs.
 */
export class ToastMap {
  constructor(opts = {})   // { rings = 24, bands = 12 }

  /**
   * Integrate one frame of heat.
   * @param dt    seconds
   * @param world THREE.Object3D — the marshmallow mesh, already at its final
   *              world matrix for this frame. The map reads its world matrix
   *              to know which way each texel faces.
   * @param fire  { pos: THREE.Vector3, top: number, power: number }
   *              pos = the fire's own centre in world space, top = the height
   *              of the flame's hottest point above it, power = 0..1 (the
   *              fire's own strength; Camp publishes it).
   * @returns nothing. Read the state off the getters.
   */
  update(dt, world, fire)

  get texture()   // THREE.DataTexture — RGBA8: R = toast 0..1,
                  //   G = wetness/melt 0..1, B = live heat 0..1, A = char 0..1
  get doneness()  // 0..1  mean toast over the whole surface
  get evenness()  // 0..1  1 = perfectly even, 0 = one side black one side white
  get peak()      // 0..1  the hottest texel's toast
  get burning()   // bool  a texel passed ignition and is alight
  get ruined()    // 0..1  fraction of the surface past char
  /** Grade the finished marshmallow. See `RESULTS` below. */
  grade()         // { key, label, doneness, evenness }
  reset()
  dispose()
}

/** The five outcomes, in the order they are ranked. */
export const RESULTS = [
  { key: 'perfect', label: 'golden all over' },   // doneness .55-.80, evenness > .78
  { key: 'good',    label: 'nicely toasted'  },
  { key: 'pale',    label: 'barely warmed'   },
  { key: 'uneven',  label: 'toasted on one side' },
  { key: 'burnt',   label: 'charred'         },
];

/**
 * The marshmallow's material.
 *
 * MeshStandardMaterial + onBeforeCompile, NOT a ShaderMaterial: it must get
 * this game's global fog (Atmosphere.js), its global stylised lighting
 * (Stylize.js) and its shadows for free, and every one of those is patched into
 * the physical shader. A ShaderMaterial here is how a prop ends up unfogged and
 * differently lit from the camp it stands in.
 *
 * It must do all five of these, and each is load-bearing:
 *   · the toast ramp — cream -> gold -> amber -> mahogany -> black, with the
 *     last two thirds compressed so char arrives suddenly
 *   · translucency — a wrap/back-scatter term, so the fire behind the
 *     marshmallow glows through its far side
 *   · blisters — the surface bubbles and puckers where it is toasted, in the
 *     vertex shader (small) and in the normal (large)
 *   · char cracks — a cellular break-up in the black, with dull orange in the
 *     splits when the live-heat channel is high
 *   · sag — the whole body slumps and stretches downward as it melts, driven
 *     by uniforms the view sets (`uSag`, `uSwell`)
 */
export function marshmallowMaterial(toastTex, opts = {}) -> THREE.MeshStandardMaterial
//   The returned material carries `.userData.roastUniforms = { uSag, uSwell,
//   uGlow, uTime, uFireDir }` — plain THREE.Uniform objects the view writes
//   every frame. uFireDir is the fire's direction in the mallow's LOCAL space.
```

## 3. `src/camp/camp_roast_view.js` — the view and the mini-game

Read `src/camp/camp_scope_view.js` first and steal its shape. It solved the
same four problems (where the eye goes, the rig has to let go, the HUD has to
leave, it has to READ as the thing) and this view inherits all four.

```js
export class RoastView {
  constructor(ctx)
  get active()          // bool — Camp.js gates on this
  get subject()         // the stick prop being held, or null
  enter(prop, camp)     // step to the fire and pick the stick up
  leave()               // ease back out
  update(dt)            // called from Camp.update; reads input
  dispose()
}
```

Behaviour, non-negotiable:

- **The camera.** Seated eye height at the fire's edge — 1.12 m above the
  ground, 1.55 m out from the fire's centre, pitched down about 22 degrees so
  the flame's top third and the far stones are in frame. It arrives from
  wherever the camera was over ~0.75 s, eased hard into the arrival. It leaves
  in 0.40 s to exactly the pose it came from. Bearing: from the fire toward the
  chair nearest the pointer, so the player ends up sitting where somebody would.
- **The stick is parented to the camera**, not to the world, and comes in from
  the lower right — grip off the bottom-right corner of frame, marshmallow at
  about the centre of frame over the flames. It must not be so central that it
  hides the fire, and it must never clip the near stones.
- **Twirl.** Horizontal drag, or A/D, rotates the stick about its own axis with
  real angular inertia (spin up, coast, gentle friction). A flick keeps
  spinning for a second or so. This is the verb of the whole mechanic and it
  has to feel good in the hand before anything else is judged.
- **Height.** Vertical drag, or W/S, raises and lowers the marshmallow over the
  flame between 0.10 m and 0.55 m above the flame top. Low is fast and risky;
  high is slow and safe. Show it in the picture (the marshmallow moving) and
  nowhere else.
- **Eat it.** `E`, or a click, when doneness > 0.15. A short, unhurried beat:
  the stick comes back toward the lens, the marshmallow leaves it, one line of
  text names the result, and the view steps back. That line is the ONLY score
  this game shows.
- **Fire.** If a patch ignites, a small flame sits on the marshmallow and the
  toast runs away fast. Tapping space (or shaking — a fast twirl reversal)
  blows it out. Calm, forgiving, no alarm.
- **Drop it.** If the marshmallow melts past its hold (doneness very high and
  the stick held level for too long), it slides off and falls in the fire, with
  a small flare. The view steps back and the stick returns to the table with a
  fresh marshmallow after a beat. This is a joke, not a punishment.
- **The overlay.** Its own DOM element like `Eyepiece`, at z-index 38: a
  vignette warm at the bottom (the fire's glow on the eye), and one line of tip
  text that names the controls and the way out. `window.__forceCamera` is
  raised on the way in and restored on the way out, exactly as ScopeView does.
  Nothing in the overlay may be a progress bar.
- Driving, or the camp being struck, ends the view. Photo mode gets the same
  hand-off treatment ScopeView has if it is cheap; if not, leave the view.

## 4. Integration

- **`camp_site.js`** — a `roaststick` item, placed against the table when the
  layout has one (at the table's own yaw, offset to one end of it), and against
  the woodpile or a chair otherwise. Every camp gets exactly one. The item
  carries `opts: { restH, leanYaw }` so the geometry knows what it is leaning
  on. It must pass the same separation tests as every other prop.
- **`Camp.js`** — `roaststick: buildRoastStick` in `BUILD`; a
  `_stickUnderPointer()` modelled exactly on `_scopeUnderPointer()` (sphere on
  `userData.roast.mallow`, radius ≈ 0.34); the prompt (`"<verb>  roast a
  marshmallow"`); the same three-condition gate the telescope uses (pointer on
  it, parked at ITS camp, camp already has focus); `this.roast = new
  RoastView(ctx)` beside `this.scope`; the same suppression in `_interact`,
  `_pickHoverFire`, `_strike` and `dispose`. The fire's world position and
  strength come from `camp.fire`.
- **`Stats.js`** — poll the view: `roast.made`, `roast.perfect`, `roast.burnt`,
  `roast.dropped`, `roast.time`. Written from the polling loop like everything
  else, never from a call in another author's file.
- **`hud_stats.js`** — one Camp-section row, `Marshmallows roasted`, plus a
  golden-count line. Match the existing rows exactly.
- **`camp_props.js` / `camp_audio.js`** — the sizzle. It rises with the live
  heat, it is quiet, and it is the only new sound. A gentle *fwoomp* when a
  marshmallow ignites; a soft crackle when it is eaten. Nothing chimes.

## 5. `tools/roastshot.mjs` — the harness

The critic loop lives on this. Copy `tools/campshot.mjs`'s scaffolding (lock,
HMR stub, park, brake, `pitchNear`) and add:

```
node tools/roastshot.mjs --dir shots/roast/r1            # the whole sheet
node tools/roastshot.mjs --dir shots/roast/r1 --only prop,held
node tools/roastshot.mjs --dir shots/roast/r1 --hour 20.4
node tools/roastshot.mjs --dir shots/roast/r1 --ladder   # one mallow, 6 doneness steps
```

Frames it must produce, all deterministic and all with no UI in frame unless
the frame is OF the UI:

| name | what it proves |
|---|---|
| `prop-fq`, `prop-side`, `prop-back` | the stick against the table reads, from every side |
| `prop-wide` | you can FIND it in the camp — the discovery test |
| `held-enter` | mid-transition, 0.4 through the step-in |
| `held` | the composed first-person frame. The money shot. |
| `ladder-0..5` | raw / warmed / gold / dark gold / mahogany / char |
| `uneven` | turned on one side only — the failure the mechanic is about |
| `burning` | alight |
| `dusk-held` | the same money shot at hour 20.4, lit only by the fire |

It drives the game through a debug surface the view exposes on
`window.__roast` — `enter()`, `setToast(u, v, amount)` / `setDoneness(k)`,
`setSpin(rad)`, `setHeight(m)`, `ignite()`, `step(dt)` — because a harness that
has to synthesise drags breaks the moment the input mapping is touched. The
view's author owns `window.__roast`; the harness author says what it needs.

## Verification every author owes

1. `node tools/health.mjs --port 5251` — the app still boots, and no console
   errors.
2. Your own frames, captured through `tools/roastshot.mjs` at the default hour
   AND at 20.4. Art claims without a frame are not claims.
3. A frame is judged against `docs/DESIGN_BRIEF.md` and against the rest of the
   camp in the same frame — a marshmallow that is beautiful alone and wrong
   beside the fire is wrong.

Dev server for this round: **http://127.0.0.1:5251** (`AUTUMN_URL`). The
default seed is baked; do not pass `--seed`.
