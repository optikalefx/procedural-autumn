// ─────────────────────────────────────────────────────────────────────────────
//  goat — the white shape on the skyline.
//
//  Now the bought pack's, where it used to be a blueprint of profile arrays.
//  The mesh, rig and weights are ithappy's (`assets/models/Animals_v3.0.blend`);
//  the two clips this game needs and the pack does not ship are authored onto
//  that rig by `tools/build_goat_blend.py`, which saves
//  `assets/models/goat_pack.blend`. `tools/export_pack_glb.py` turns that into
//  `/models/goat_pack.glb`.
//
//  The `brain` block below is byte-for-byte the one the procedural goat used.
//  Where an animal lives and what it minds does not depend on who modelled it —
//  this is still the first of the two alpine species, it still lives above the
//  slope and altitude gates the rest of the cast is held to, it is still barely
//  frightened of a camper, and it still CLIMBs and PERCHes on the `rock` block
//  at the bottom.
//
//  ── two meshes, one skeleton, and the variant is a TEXTURE ─────────────────
//  `Goat_01` and `Goat_02` are both already parented to `Skeleton_Goat`, so
//  there was none of the re-parenting the deer needed. What is unusual is how
//  they differ: measured index-wise in their own local space the two meshes'
//  828 vertices are IDENTICAL to 0.000000 — same silhouette, same weights, same
//  39 vertex groups. Only the UVs differ, `Goat_01` reading 38 distinct UVs off
//  the shared palette and `Goat_02` reading 328. So `hide` buys a second COAT
//  here where for the deer it buys a second SILHOUETTE, and the four variants
//  below are two colours at four sizes.
//
//  Both meshes are nannies — each carries an udder, a beard and the same short
//  backswept horns. `billy` is therefore a larger nanny and `kid` a small one,
//  because neither is in the pack. Said plainly rather than hidden: the
//  alternative is a variant name that quietly promises a mesh nobody has.
//
//  ── what the swap costs, as art ───────────────────────────────────────────
//  The blueprint this replaces was drawn to `docs/DESIGN_BRIEF.md` and its own
//  header states the brief exactly: "the back line RISES to a hump over the
//  shoulders and the head is carried below it… read as a flat shape at 90 m it
//  is a pale brick with a bump on the front of it". That is Oreamnos, and it is
//  not what the pack ships. The pack's goat is a domestic dairy goat: level
//  back, no withers hump, a straight neck carried level with the spine, an
//  udder and a beard. At range it reads as a pale quadruped rather than as a
//  mountain goat specifically, and there is no fixing that at this layer —
//  the silhouette is the mesh. It is recorded here because it is the one thing
//  this animal lost that no number below can get back.
//
//  ── the clips ─────────────────────────────────────────────────────────────
//    idle   150f  the pack's. Every hoof dead still, duty 1.00.
//    graze  150f  the pack's `Gesture`, and a real graze — the muzzle drops
//                 0.640 -> 0.093 in model units with all four hooves planted.
//                 Measured before it was given a slot: this pack's Gesture is a
//                 graze on the deer, a forage on the raccoon and a REAR on the
//                 bear, so which of graze/alert it can fill is per-animal.
//    walk    30f  the pack's. Duty per hoof 0.50/0.37/0.40/0.43 — marginal
//                 against the 0.5 that DEFINES a walk, and the honest caveat on
//                 the 1.27 m/s below; it is also much better planted than the
//                 deer's 0.25/0.30/0.23/0.10, which ships.
//    run     18f  the pack's, and it is the LEAP: duty 0.06/0.11/0.28/0.44 is
//                 an animal in the air, which is what a bound is. Dropping a
//                 clip over that reading cost the deer most of a day and
//                 produced a worse animation.
//    trot    11f  SOLVED here — diagonal pairs, each hoof authored as a path
//                 over the ground and the leg solved to reach it. Nothing in
//                 the pack has a trot; checked across all 233 actions.
//    alert  120f  AUTHORED here — head up, ears forward, a slow scan either way
//                 with long holds. There is one Gesture per animal and it is
//                 the graze, so the alert had nowhere else to come from.
//
//  The rule that governs the asset is in CLAUDE.md and it is absolute: a GLB's
//  animations are read-only. The gait speeds below are MEASURED at load.
// ─────────────────────────────────────────────────────────────────────────────

export const GOAT = {
  key: 'goat',
  plural: 'Mountain goats',

  glb: {
    url: '/models/goat_pack.glb',
    // Horn tip to hoof. `loadGlbSpecies` scales by the whole scene's bounding
    // box, and 1.306 is what the procedural goat this replaces measured off its
    // own built mesh (`tools/_scratch/_goatheight.mjs`) — so at every one of the
    // four variant scales the new animal fills exactly the space the old one
    // did, and nothing about placement, streaming or the photo gate shifts.
    //
    // What DOES shift is the back line, and it is a finding rather than a
    // setting: matching the box puts the withers near 1.005 m against the
    // blueprint joint's 0.885. A slightly taller goat.
    //
    // 1.370, not the 1.306 this shipped with, and it is not a tweak. The
    // reshape lengthened the horns, and the box top IS the horn tip — so
    // holding the box at 1.306 made the horns eat the difference and quietly
    // shrank the whole ANIMAL (fit x1.392 -> x1.370, and every gait speed with
    // it, since they are measured off the scaled model). 1.370 is 1.392 x the
    // reshaped model's own 0.984 units: the body keeps exactly the size it had
    // and the longer horn is added on top of it, which is what was meant.
    // Measure the dimension you are FITTING BY, not the one you are quoting —
    // `mammals/ram.js` carries the same warning for the same reason.
    //
    // Re-derive this whenever `HORN.tall` changes: the box top IS the horn tip.
    height: 1.370,
    // The four hooves. Dots stripped by three's `GLTFLoader`, not by Blender —
    // `PropertyBinding.sanitizeNodeName` strips what its own animation-path
    // syntax reserves, and the GLB really does carry `toe.L`. A name that does
    // not resolve is skipped and the clip then measures zero ground, which
    // throws as "check that the model faces -z" — a naming fault wearing a
    // facing fault's error message.
    feet: ['toeL', 'toeR', 'front_toeL', 'front_toeR'],
    // Read this animal's speed from where its hooves touch rather than from how
    // far they swing. `measureExcursion` divides a hoof's total swing by the
    // CYCLE, but a planted hoof covers that ground during its STANCE — so it
    // underreports by exactly the duty factor. The same three clips read
    // 0.63/1.37/1.20 on the excursion path and 1.27/3.10/2.57 on this one.
    //
    // The claim `contact` makes is that every hoof of every moving clip is
    // genuinely planted for a sustained stretch. It is fully true of the solved
    // trot and only mostly true of the pack's walk, whose duty is 0.37-0.50
    // against the 0.5 a walk is defined by — so the 1.27 m/s below is at the
    // generous end of what that clip contains. It lands inside a real mountain
    // goat's 1.0-1.5 m/s walking range, and the honest alternative (excursion,
    // 0.63) is wrong by more in the other direction on every gait at once.
    measure: 'contact',
    clips: {
      stand: { name: 'idle' },
      // The pack's own walk, at its authored tempo. 30 frames is 0.77 Hz, and
      // the stride it carries is a long 1.64 m — raising the cadence the way
      // the deer's needed would push the speed past what a goat walks at.
      walk: { name: 'walk', rate: 1.0 },
      // Solved. 11 frames at 24 fps is 2.18 Hz, diagonal pairs, sweep 0.638 m
      // at duty 0.45 — the largest stride no leg has to clamp for anywhere in
      // the cycle, which is a finding about this animal's proportions and not a
      // number anyone chose. Its rest extension is 0.815 hind / 0.874 fore,
      // inside the band that makes a stride possible at all.
      trot: { name: 'trot', rate: 1.0 },
      // ── the pack's leap, and the one clip that needed a cadence ────────
      // `rate` is cadence and nothing else; the 2.04 m of ground each leap
      // covers is the artist's. As authored the clip is 0.79 s — 1.26 leaps a
      // second — which measures 2.57 m/s and lands the run BELOW the trot's
      // 3.10, collapsing the crossfade band and skipping the middle gait
      // entirely. At 2.0x it makes 2.5 leaps a second for 5.14 m/s.
      //
      // That is also the right number: a mountain goat is a climber, not a
      // runner, and is credited with about 5.5 m/s flat out — where the
      // procedural goat this replaces was driven at 7.5.
      run: { name: 'run', rate: 2.0 },
      graze: { name: 'graze' },
      alert: { name: 'alert' },
    },
  },

  // Two coats at four sizes, `hide` picking the mesh. The weights are the
  // procedural goat's unchanged. No `col` on any of them: this asset is one
  // TEXTURED palette material, so a tint would multiply the map rather than
  // recolour a region, and every coat wears the material exactly as Blender
  // authored it — which is the promise of this track.
  //
  // What is lost against the blueprint is the distance treatment. That goat
  // carried `silFlat`/`silDark` turned down hard, because a mountain goat is
  // the one animal in the cast that is visible at range by being LIGHTER than
  // the rock behind it, and the cast default collapsed it to a grey blob. The
  // hide shader resolves its regions from a vertex attribute a GLB does not
  // carry, so this track has no silhouette ramp at all — the animal simply
  // stays pale with range, which for this species is the failure mode that
  // matters least.
  variants: [
    { name: 'nanny', scale: 0.94, weight: 0.44, hide: ['Goat_02'] },
    { name: 'billy', scale: 1.08, weight: 0.30, hide: ['Goat_02'] },
    { name: 'kid', scale: 0.68, weight: 0.16, hide: ['Goat_02'] },
    // The pack's second UV set: a brown goat off the same palette. It stands in
    // for the old summer coat, half shed and stained by the rock it lies on.
    { name: 'smoke', scale: 0.99, weight: 0.10, hide: ['Goat_01'] },
  ],

  // Measured off the clips at load and written back here by `loadGlbSpecies`.
  gait: { walk: 1.268, trot: 3.095, run: 5.142 },

  brain: {
    // ── barely frightened, and honestly so ──────────────────────────────────
    // A mountain goat lives where nothing can follow it, and it behaves like
    // it: it looks up, it watches, and it does not leave. So `noticeDist` is
    // short (there is no long-range wariness to model), `fleeDist` is the
    // shortest in the cast after the bear's, and `calmDist` is close behind it
    // — the whole encounter is meant to resolve into the animal standing there
    // looking at you, which is also the most legible thing it can do.
    //
    // No `standoff`: that lever walks a stand point out of canopy shadow, and
    // there is no canopy at 200 m of altitude to walk out of.
    alertDist: 30, fleeDist: 9, calmDist: 50, noticeDist: 55,
    // One step outside `noticeDist`, and well inside the 165 m spawn ring —
    // see the deer's note for why that ring is the real ceiling on this.
    hintDist: 78,
    freezeTime: [0.8, 1.8], fleeTime: [2.0, 4.0],
    grazeTime: [8, 22], idleTime: [3, 8], walkTime: [5, 14],
    herd: [1, 3], herdRadius: 7, wanderRadius: 22,
    grazeChance: 0.45,
    // ── the rock ────────────────────────────────────────────────────────────
    // The block that makes this species what it is. See `animal_brain.js`
    // (CLIMB / PERCH) for the machinery and `Wildlife._findPerches` for where
    // the boulder list comes from. None of it knows which backend draws the
    // animal: CLIMB and PERCH ride a ground override that `GlbRig` consumes
    // through the same `drive.pos` the procedural rig did.
    rock: {
      // Where a goat may stand at all. `slopeMax` widens the two hard gates
      // every other species is held to — placement, wander targets and the
      // probe fan all read it — and `slopeSoft` is where the fan starts
      // charging for steepness at all. A goat on 0.45 slope is a goat on a
      // lawn.
      slopeMax: 1.45, slopeSoft: 0.95,
      // Altitude band. Below the first number there is no goat at any
      // steepness; the ramp is what keeps them off the shoulders of the
      // valley and on the massif.
      // A goat wants the rock it is standing on, so the habitat raster is read
      // at the point itself — `nearCells: 0`. See `Wildlife._rockiness`.
      altBand: [140, 215], rockGain: 2.10, slopeBest: [0.45, 0.95], nearCells: 0,
      // ── what counts as a boulder worth standing on ────────────────────
      // Measured, not guessed. Within 48 m of a goat site the rock scatter
      // leaves about twelve instances over 0.6 m, and almost all of them fail
      // one of the three tests below — the crag bands are 15-25 m slabs, the
      // scree is ankle-deep rubble, and a great many rocks on a hillside have
      // their summit BELOW the ground level at their own centre because
      // placement buries them against the lowest corner of their footprint.
      // What survives is 0.8 boulders per site: a bit under half of all bands
      // get one, and that is the intent rather than a shortfall. A band with a
      // rock is a band with a rock; one without is grazing the scree like
      // anything else, and a mountain where every group is standing on a
      // plinth would be a diorama.
      //
      //   rise   summit above the ground under it. Under 0.60 m it is a kerb
      //          and standing on it reads as nothing at all.
      //   maxR   half-width in plan. A 20 m crag bench would become a 20 m
      //          mesa under `Brain._groundY`'s dome, which is a lie the eye
      //          catches instantly.
      //   steep  minimum rise per metre of half-width. This is the one that
      //          rejects the flat slabs: a rock has to actually stick up
      //          before climbing it is a thing the player can see happening.
      search: 48, minSize: 0.60, rise: [0.60, 3.00], maxR: 7.0, steep: 0.25,
      // How far an animal will walk to one. Generous, because the walk to the
      // rock is itself worth watching and because the alternative is a goat
      // that stands next to a boulder it has decided is too far away.
      reach: 45,
      // How far the band's stand point may be dragged to sit beside its
      // boulder — see `Wildlife._standAtRock`. Well inside the 40 m gap
      // between this species' spawn and despawn radii, which is the real
      // ceiling on it: the streaming tests are measured at the SITE, and a
      // stand point too far from one would let a group wake inside the view.
      snap: 25,
      // How often an animal with nothing else to do goes up, how long it
      // stays, and how often a wander is a lap of a boulder instead of a walk
      // across the hill. The lap is the other half of the brief: they climb
      // onto the rocks, and they climb *around* them.
      climbChance: 0.55, perchTime: [12, 34], orbit: 0.55,
    },
  },
};
