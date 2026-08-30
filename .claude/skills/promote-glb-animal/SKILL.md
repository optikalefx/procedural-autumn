---
name: promote-glb-animal
description: Make a hand-authored Blender animal a first-class species in the game — placed by habitat, streamed by the site table, credited by the logbook, photographable, and with coat variants — or replace an existing procedural animal with a GLB one. Use when the user wants a GLB animal to "be a real animal", "replace the procedural one", "show up in the world properly", "count in the logbook", "be photographable", when the old procedural version should be deleted, or when a GLB animal exists beside the cast and should join it. For getting a model and its clips out of Blender in the first place, use import-animal. For the procedural blueprint cast, use create-animal.
---

# Promote a GLB animal to a real species

`import-animal` gets a mesh and its clips out of Blender and playing in the
world. This skill closes the rest of the gap: making that animal a **species**
rather than a demo beside the cast — placed by the habitat field, streamed on
the site table, counted in the logbook, detected by the camera, hinted at by the
compass paw, and wearing coat morphs.

The fox is the worked example. Read `src/wildlife/glb_rig.js` before touching
anything here; its header is the contract.

## The idea that makes this cheap

**Two backends, one of everything else.** There is no "GLB system" running
beside `Wildlife`. There is one cast, and a species declares which backend draws
it by carrying a `glb` block or a `blueprint` in `mammals/<species>.js`:

| | procedural | hand-authored |
|---|---|---|
| geometry | `quadruped.js` lofts profile arrays | the artist's mesh |
| motion | `animal_anim.js` solves a gait per frame | `AnimationMixer` plays clips |
| rig class | `AnimRig` | `GlbRig` |
| everything else | *identical* | *identical* |

Both rig classes answer the same contract, so `Wildlife` branches in exactly two
places (`_buildProtos`, `_buildPool`) and nowhere else:

```
new Rig(proto, scale, gaitCfg, key)
rig.mesh                    the object Wildlife positions and hides
rig.reset(pos, heading, W)  place it, feet on the ground
rig.update(dt, drive, W)    one frame, from Brain.fill's drive block
rig.setLod(0|1)             geometry LOD
rig.setShadow(bool)         shadow LOD
rig.gaitName                what it is doing, for the debug dumps
rig._warm                   false until reset has run once
```

If you find yourself adding a third branch somewhere, that is the signal the
seam is in the wrong place — fix the seam, do not add the branch.

## The recipe

### 1. Write the species file

`mammals/<species>.js` carries everything true about the **animal**, and nothing
about how it is drawn. Replace `blueprint` and the procedural `gait` numbers
with a `glb` block; **keep `brain` exactly as it was** — where it lives, what
frightens it, how far off it notices you did not change when the model did.

```js
glb: {
  url: '/models/<x>.glb',
  height: 0.62,                       // ear-tip to paw, metres
  feet: ['fore_footL', 'hind_footL'], // exporter strips dots from hind_foot.L
  clips: {
    stand: { name: 'Stand' },
    walk:  { name: 'Walk', rate: 2.2 },
    trot:  { name: 'Trot', rate: 1.0 },
    run:   { name: 'run', rate: 1.0, strides: 3 },
    graze: { name: 'graze' },
    alert: { name: 'alert' },
  },
},
```

- A clip with a `rate` is a **cycle**: measured, rate-driven, part of the speed
  ladder. A clip without one is a **pose**: never measured, entered at frame 0.
- `strides` is how many strides the clip contains. Get it wrong and the animal
  travels at a fraction or a multiple of what its legs do. The fox's run is
  three rotary-gallop strides in one clip.
- `rate` is a playback speed, never an edit. See the read-only rule below.

### 2. Coats

If the asset is untextured — flat `baseColorFactor` per material, no images —
morphs are a recolour of one mesh, not a second export. Key them by **Blender
material name** and give **linear** RGB triples, because that is the space glTF
stores `baseColorFactor` in and the space `GLTFLoader` hands three. sRGB hex here
shifts every morph quietly, and it looks like an art choice rather than a bug.

Give the base coat **no** `col` at all: it then shares the authored material
uncloned, which is one less program to compile and nothing to drift out of sync
with the .blend.

### 3. Nothing else

Registration in `SPECIES`, the `CFG` streaming row, habitat suitability in
`Wildlife._suit`, the hunt item, the logbook — all of it is the same as for a
procedural species (`create-animal` covers those), and all of it already works
the moment the species file is right.

## The traps, all of which have been paid for

- **Two different "scale"s.** `proto.scale` is the ASSET fit — model units to
  metres, ~0.22 for the fox — and is what the rig transform needs.
  `Brain._scale` is how big the individual is **as an animal**, ~1, and the
  Brain multiplies every gait speed by it. Handing the Brain the fit factor
  multiplied the fox's flee speed by 0.22 and left it strolling away from the
  camper at 0.07 m/s playing the walk clip. The procedural track never noticed
  because its blueprints are authored in metres, so its fit is 1 and the two
  numbers coincide. Keep `proto.size` separate from `proto.scale`.
- **Measure the asset, then write the gait table.** `loadGlbSpecies` mutates
  `sp.gait`, deliberately: the honest walk/trot/run speeds are a property of the
  clips and cannot be authored in a file. This is why `_buildProtos` is awaited
  before `_buildPool` — a `Brain` built before that write steers at speeds the
  clips cannot carry, and the paws skate.
- **Bands as fractions, never as m/s.** Anchor every crossfade to the animal's
  own cruising speeds. Absolute numbers were written when the fox walked at
  0.44 m/s; when the clip's real 0.08 m/s took over, cruising speed landed
  *inside* the band and the fox walked permanently at 62% Walk / 38% Stand,
  never once playing the clip clean.
- **Weights must sum to 1.** An unnormalised set makes the mixer average toward
  the rest pose and the animal visibly sinks as it changes gait. Locomotion takes
  what it needs, the standing poses share what is left.
- **Let `Brain` own the pose channels.** It already ramps `graze` and `alert` as
  smoothed 0..1 floats and already answers the awkward case — an animal in WATCH
  sits at 0.62 alert while drifting and 0.85 while still, so the alert pose
  partial-blends over a walk exactly as much as the state deserves. Do not build
  a second state machine in the rig to disagree with the first.
- **Damp the blends and the rates on their own clock.** The Brain's accel is
  tuned for animals moving metres per second, so at a slow clip's speed every
  change of pace completes in one frame. Undamped, the fox's rate collapsed from
  1.87x to the clamp floor in a single frame underneath a crossfade that was
  taking 300 ms.
- **`mesh` is a Group, so two things do not propagate.** `castShadow` has to be
  traversed onto the child meshes (hence `setShadow`), and `hunt_detect`'s
  `meshHeight` reads `mesh.geometry.boundingBox` — so the Group carries an
  attribute-less `BufferGeometry` that exists only to hold the rest-pose box. A
  Group has no `isMesh`, so the renderer never visits it.
- **Terrain tilt is yours to do.** The procedural track gets it free from its
  per-paw ground queries. Without it a GLB animal on a hillside stands bolt
  upright through the ground.
- **`SkeletonUtils.clone`, not `Object3D.clone`.** A plain clone shares the
  original's bones, so every animal plays every other animal's animation.

## The rule that outranks everything

**A GLB's animations are read-only** (CLAUDE.md). Change *playback* — rate,
blend weight, where the animal is, transforms on a parent node — and never a
pose. glTF stores **absolute** bone rotations (rest × pose), so scaling keys
scales the rest pose too and past 180° the slerp wraps.

When a clip cannot carry what the game needs, **measure it, name the number and
hand it back**. The fox's measured gait is `walk 0.083, trot 0.249, run 0.377
m/s` against a real fox's 0.85 walking and 10 galloping — that is a stride to
widen in the .blend, recorded in `mammals/fox.js`, and explicitly not a number
to raise in code.

## Verify

Dev-server trap: port 5178 serves the **main checkout**, and other ports may be
serving a different worktree. Confirm the server is really serving your code
before you trust a single frame:

```bash
curl -s http://127.0.0.1:<port>/src/wildlife/glb_rig.js | head -2
```

1. **The load line.** `[glb_rig] <key>: model 2.83u -> 0.62 m (x0.219), 3 coats;
   Walk 7.6 cm / 2.00s at 2.2x -> 0.083 m/s; ... Clips unmodified.` A stride of
   0 means the `feet` bone names are wrong — remember the stripped dots.
2. **The look test.** Species-agnostic, and the whole instrument:
   ```bash
   AUTUMN_URL=http://127.0.0.1:<port> node tools/_scratch/glblook.mjs shots/<name> <species>
   ```
   Writes a broadside strip per gait, both pose clips, stand front and side, the
   coats together, and the animal at 12/25/45 m. It prints the clip weights at
   each gait and **fails loudly if they do not sum to 1**, and ends with the
   per-animal draw-call and triangle cost.
3. **The Habitat Pen** — `gallery.html#animal%3Apen`. A fenced 14 m meadow with
   rocks and a pond where the real `Brain` drives the real `GlbRig`, so the
   clips can be judged in motion, over time, against obstacles — which is the
   only way blend bands and derived travel speeds ever show themselves. **It
   stocks hand-authored species only**; a converted animal appears the moment
   its file grows a `glb` block, with no edit to `pen.js`.

   The `behaviour` dropdown rigs the dice without touching the machinery:
   `roam` works the fence and the rock maze, `graze` and `alert` hold those two
   pose clips, and **`spook` is the one that exercises the whole vocabulary** —
   measured on the fox, a 240 s spook run hit all six clips (stand, walk, trot,
   run, graze, alert) where `roam` only ever reached stand and walk, because the
   fox's authored speeds never leave the walk band unprovoked.

   Drive it headlessly through `built._animals` (live brains) and `built._world`:

   ```js
   const built = await __gallery.byId.get('animal:pen')
     .build(20261018, { species: 'fox', herds: 3, behaviour: 'spook' });
   for (let i = 0; i < 240 * 60; i++) built.update(1 / 60);
   ```

   Health, from a 400 s soak: max `brain._pinned` ≤ ~3 s and no animal
   stationary longer than its legal idle. The fox measured 0 s pinned in `roam`
   and 0.4 s in `spook`. A pinned figure in the tens of seconds is the
   vibrating-freeze class of bug.
4. **Weights and rates.** At a gait's cruising speed that clip's weight should be
   ~1 and its rate exactly its authored `rate`. A weight stuck part-way means a
   crossfade band is wrong. `wildlife.debugGait(key, 'trot')` pins the species so
   a clip can be judged without waiting for the Brain to choose that pace;
   `debugGait(null)` releases.
5. **The game hooks**, none of which are optional for a real species:
   ```js
   (await import('/src/game/hunt_detect.js')).detectSubjects(ctx)  // -> ['fox']
   wildlife.nearestHint(x, z)                                      // compass paw
   stats._look(1/6); a._statSeen                                   // logbook credit
   ```
6. **Cost.** A hand-authored animal is not free. The fox is 6 primitives and
   8,652 triangles, which is **12 draw calls and 17.3k triangles per animal**
   once the shadow pass is counted — against 7 calls and 4.7k triangles for the
   *entire* procedural cast at the busiest point on the map. Check it against
   `CFG[key].live` before shipping, and if it is too much the fix is merging
   same-material primitives in the export, not a code workaround.

Three harness traps worth knowing: `renderer.info` does not auto-reset in this
app, so reset it by hand or you will report a growing total; `Stats.update`
early-returns on a hidden tab, so a headless check must call `stats._look(step)`
directly; and the gallery page is driven by `requestAnimationFrame`, which does
NOT run while the pane is hidden — in an automated browser the pen sim and even
the stage turntable sit frozen, so step `built.update(dt)` and call
`stage.renderer.render(stage.scene, stage.camera)` yourself rather than
concluding the card is broken. The journal auto-opens on first run and holds the sim — pump it with
`for (let i = 0; i < 200 && j._visible; i++) j.update(0.05)` after `close()`.
