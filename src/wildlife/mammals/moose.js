// ─────────────────────────────────────────────────────────────────────────────
//  moose — three of them on the whole map, and every one of them at a river.
//
//  The biggest animal in the valley and the rarest: `Wildlife._mooseSites` puts
//  down exactly three home sites for the entire 3072 m map, walked off the river
//  polylines and held at least 850 m apart, so meeting one is a place you went
//  rather than a thing that happens. Everything else in the cast is scattered by
//  the suitability field; this one is not scattered at all.
//
//  The mesh, rig and weights are ithappy's (`assets/models/Animals_v3.0.blend`);
//  the three clips this game needs and the pack does not usably ship — walk,
//  trot and alert — are solved or authored onto that rig by
//  `tools/build_moose_blend.py`, which saves
//  `assets/models/moose_pack.blend`. `tools/export_pack_glb.py` turns that into
//  `/models/moose_pack.glb`.
//
//  ── one mesh: every moose is a bull, and every bull has the rack ──────────
//  The pack ships `Moose_01` (bull, 2682 tris), `Moose_Female_01` (cow, 1832)
//  and `Moose_Cub_01` (calf). Only the bull is in the GLB.
//
//  That is the deer's trick deliberately NOT taken, and the arithmetic is the
//  argument. The cow's armature is identical to the bull's — same 32 bone
//  names, every bone head in the same place to four decimals, length ratio
//  1.000 — so she could ride his skeleton and `hide` could pick between them,
//  exactly as the doe does. She did, at weight 0.55, and the result is what
//  sent this back: with THREE animals on the whole map, a variant weight is not
//  a distribution, it is a coin toss. Two of the three came up hornless and all
//  three easily could have (user, on the shots: *"I want the moose with
//  horns"*).
//
//  The rack is not a decoration on this animal, it is the reason the animal
//  reads. The bull's bounding box is 2.069 units WIDE against the cow's 0.753
//  and all of that difference is antler — a moose is the one shape in this cast
//  recognisable as a dark rectangle with a pair of palms on the front of it,
//  which is what plate 3 of `docs/DESIGN_BRIEF.md` asks every animal to survive
//  being reduced to. Without it this is a large dark deer.
//
//  `tools/build_moose_blend.py` still measures the cow's skeleton against the
//  bull's on every build and prints the result, so bringing her back is one
//  line in each file. What it needs is a reason, and "some moose are cows" is
//  not one while there are three moose.
//
//  **The calf could not join even if it were wanted.** `Moose_Cub_01` carries
//  the same 32 bone NAMES at 0.595 of the adult's total bone length, with bone
//  heads up to 0.757 apart — a half-size rig, so its mesh on this skeleton
//  would be a calf stretched to bull proportions. The deer's fawn was caught by
//  the same check for the same reason: sharing a skeleton needs matching rest
//  GEOMETRY, and names alone say it is fine.
//
//  Nor is there a colour morph. The asset is one textured palette material, so
//  a `col` override would replace the palette rather than recolour the coat —
//  the same loss `mammals/deer.js` and `mammals/ram.js` record.
//
//  ── the clips ─────────────────────────────────────────────────────────────
//    idle   320f  the pack's. Hind hooves dead still.
//    walk    28f  SOLVED here, and the pack's own walk DROPPED. Its duty per
//                 hoof is 0.40/0.37/0.13/0.43, but duty is not the argument —
//                 the same reading on a run means the animal is airborne. The
//                 argument is that the clip contains no single ground speed:
//                 measured through this game's own loader it reports a stride
//                 of 4.25 m at 0.80 Hz, which is 3.29 m/s on an animal 3.75 m
//                 long that trots at 5.0 and walks, in life, at about 1.4.
//                 `measureGround` takes the densest cluster of hoof velocities
//                 and on a clip with no stance that cluster is the SWING.
//    graze  124f  the pack's `Gesture`, and a real graze: the muzzle drops
//                 1.624 -> 0.551 in model units — over a metre shipped — with
//                 all four hooves planted (duty 1.00/1.00/0.91/0.82, hoof
//                 travel under 5 mm). Measured before it was given a slot; this
//                 pack's Gesture is a graze on the deer and the goat, a forage
//                 on the raccoon and a REAR on the bear.
//    run     18f  the pack's, and it is the LEAP. Duty 0.39/0.39/0.22/0.28 is
//                 an animal in the air, which is what a bound is. Dropping a
//                 clip over that reading cost the deer most of a day and
//                 produced a worse animation.
//    trot    13f  SOLVED here — diagonal pairs, each hoof authored as a path
//                 over the ground and the leg solved to reach it. Nothing in
//                 the pack has a trot; checked across all 233 actions. 13
//                 frames rather than the deer's and goat's 11, because a moose
//                 is twice a deer's height and big animals cycle slower.
//    alert  120f  AUTHORED here — head up, ears turning, a slow scan each way
//                 with long holds. There is one Gesture per animal and it is
//                 the graze, so the alert had nowhere else to come from.
//
//  ── the legs are the reason the trot is the shape it is ───────────────────
//  Rest extension — hip-to-hoof over the summed segment lengths — is **0.735
//  hind and 0.899 fore**. Neither is inside the 0.82-0.88 band this work aims
//  for and they miss it in OPPOSITE directions, which is a fact about a moose
//  rather than a defect in the asset: the animal is built on long straight
//  forelegs and deeply folded hocks, and that is most of its silhouette. The
//  consequence is that the fore leg binds the stride while the hind has slack
//  it cannot spend, so the solved trot buys its ground with `crouch` (10.5 cm
//  of model, 14 cm shipped) rather than with reach.
//
//  The rule that governs the asset is in CLAUDE.md and it is absolute: a GLB's
//  animations are read-only. The gait speeds below are MEASURED at load.
// ─────────────────────────────────────────────────────────────────────────────

export const MOOSE = {
  key: 'moose',
  plural: 'Moose',

  glb: {
    url: '/models/moose_pack.glb',
    // Antler palm to hoof, and the palm is a long way above the animal.
    // `loadGlbSpecies` fits by the whole scene's rest-pose bounding box, which
    // the bull owns at 2.101 units, so this number is the height of the RACK
    // and not of the moose. Measure the dimension you are FITTING BY, not the
    // one you are quoting — `mammals/ram.js` and `mammals/goat.js` both carry
    // that warning and both earned it, and here the gap between the two is a
    // metre and a half. At this fit (x2.142) the animal measures:
    //
    //     antler palm   4.50 m      the box, and this number
    //     withers       3.01 m      spine.005, and what anyone means by "how
    //                               tall is it"
    //     nose to tail  5.62 m
    //     antler spread 4.43 m
    //
    // ── this animal is not to scale, and that is the brief ────────────────
    // A record Alaskan bull stands 2.1 m at the shoulder. This one stands 3.01,
    // which is half again the largest moose ever measured, and it got there in
    // two deliberate steps: 2.77 -> 3.00 ("I want it to be really tall, like 3
    // meters") and then 3.00 -> 4.50 ("he's still not big enough. Can we 1.5x
    // his size again. I want him to be taller then my car essentially").
    //
    // The camper measures **2.85 m** to the top of its roof rack, taken off the
    // built model's world bounding box against the road under it — NOT off
    // `CamperModel.DIM`, whose `roof: 1.16` is the steel shell measured from
    // the chassis origin and is a metre and a half short of the answer to "how
    // tall is my car". So the test the brief set is met at the SHOULDER (3.01
    // against 2.85) and comfortably beaten by the rack, which passes overhead
    // at 4.50 m — a moose you can drive under.
    //
    // Recorded rather than defended, because "accurate" was never what was
    // asked for: three of these exist on the whole map and the point of every
    // one of them is the moment it is standing in the river beside your car.
    //
    // Everything derived from the fit moves with it, and none of it is a
    // separate decision: the gait speeds below are the same clips over more
    // ground, and the photo gate's reach goes with the silhouette.
    height: 4.50,
    // The four hooves. Dots stripped by three's `GLTFLoader`, not by Blender —
    // `PropertyBinding.sanitizeNodeName` strips what its own animation-path
    // syntax reserves, and the GLB really does carry `toe.L`. A name that does
    // not resolve is SKIPPED, so getting this wrong reports as a facing fault.
    feet: ['toeL', 'toeR', 'front_toeL', 'front_toeR'],
    // Read this animal's speed from where its hooves touch rather than from how
    // far they swing. `measureExcursion` divides a hoof's total swing by the
    // CYCLE, but a planted hoof covers that ground during its STANCE — so it
    // underreports by exactly the duty factor, which on the leap's 0.22 is more
    // than four times too slow.
    //
    // The claim `contact` makes is that every hoof of every moving clip is
    // genuinely planted for a sustained stretch, and here it is earned rather
    // than assumed: the walk and the trot are both SOLVED against the floor
    // (validated to a planted hoof within 0.001 mm of its authored path), and
    // the pack's own walk — which is not planted, duty 0.13-0.43 — was dropped
    // for exactly this reason. The goat and the deer both ship an inherited
    // walk and both carry the caveat; this one does not have to.
    measure: 'contact',
    clips: {
      stand: { name: 'idle' },
      // Solved. 28 frames at 24 fps is 0.86 Hz — the slowest cadence in the
      // cast, and the number that was actually chosen, because the sweep is a
      // finding (0.760, the largest these legs can carry) and cadence is the
      // only honest lever on speed. A horse walks at about one stride a second
      // and a moose is bigger than a horse. At 22 frames the same stride made
      // 1.91 m/s, which is a moose in a hurry.
      walk: { name: 'walk', rate: 1.0 },
      // Solved. 13 frames at 24 fps is 1.85 Hz, diagonal pairs. A long
      // deliberate high-stepping trot is the gait a moose is known for — they
      // cover ground at it for miles — so this is the rung that does most of
      // the animal's travelling.
      trot: { name: 'trot', rate: 1.0 },
      // The pack's leap, kept, and `rate` is cadence and nothing else: the
      // ground each bound covers is the artist's. 18 frames is 1.33 leaps a
      // second as authored.
      run: { name: 'run', rate: 1.6 },
      graze: { name: 'graze' },
      alert: { name: 'alert' },
    },
  },

  // ONE variant, and no `hide` — see the header. There is one mesh in the GLB
  // and it is the bull, so every moose in the valley is 4.50 m to the antler
  // palm and 3.01 m at the shoulder, which is the size that was asked for.
  //
  // No scale ladder either, and `mammals/goat.js` is the precedent: that file
  // shipped `nanny` / `billy` / `kid` at 0.94 / 1.08 / 0.68 and deleted them,
  // because three names for one silhouette scaled is "a size distribution
  // wearing the costume of a cast". At three individuals a size ladder would be
  // even less visible than it was there — no player will ever see two moose in
  // one frame.
  //
  // No `col`. The asset is one TEXTURED palette material, so a tint would
  // multiply the map rather than recolour a region, and the coat is worn
  // exactly as Blender authored it — the promise of this track.
  variants: [
    { name: 'bull', scale: 1.00, weight: 1.00 },
  ],

  // Measured off the clips at load and written back here by `loadGlbSpecies`.
  // Strides of 2.62 / 4.07 / 6.27 m at a fit of x2.142.
  //
  // These went up by half when the model did, and that is arithmetic rather
  // than a decision: speed is ground-per-cycle times the fit, so a bigger
  // animal covers more ground with the same clip at the same cadence. It is
  // also the physically honest direction — stride scales with leg length — and
  // the numbers land where a real moose is anyway, which is the check worth
  // making: 8.1 km/h walking, 27 trotting (the gait a moose is known for and
  // covers ground at for miles) and 45.6 flat out, against a real one's roughly
  // 5, 35 and 56.
  //
  // What is NOT automatic is the walk, and it is the reason the pack's own walk
  // clip was dropped and re-solved: measured through this loader it reported a
  // 4.25 m stride, which at this fit would be a moose ambling at 4.9 m/s. See
  // `tools/build_moose_blend.py`'s KEEP block.
  gait: { walk: 2.249, trot: 7.522, run: 12.675 },

  brain: {
    // ── a moose does not care that you are there ────────────────────────────
    // The least skittish animal in the cast, and honestly so: a moose has no
    // predator worth the name and behaves like it. It lifts its head, it looks
    // at you for a long time, and it walks away when it feels like it. So the
    // freeze is the longest in the game and `fleeDist` is the shortest after
    // the bear's.
    //
    // `noticeDist` is a LEGIBILITY number rather than an ethology one, the way
    // the deer's is: the animal has to be readable well outside `alertDist`,
    // and 120 m on a 4.5 m silhouette with a four-metre rack is a shape you can
    // identify from the road without trying. Comfortably inside the 190 m spawn
    // ring, which is the real ceiling on this for every species.
    alertDist: 30, fleeDist: 12, calmDist: 52, noticeDist: 120,
    // One step outside `noticeDist`. The longest hint band in the cast, which
    // is the point: there are three of these animals on 9.4 km² and the compass
    // paw is most of how anybody finds one.
    hintDist: 150,
    // How far the stand point is walked toward the open side of a site — see
    // the deer's note. Wider than the bear's, because a moose at a river is
    // usually standing in the willow and this pushes it out to where the water
    // is behind it.
    standoff: 6.0,
    freezeTime: [2.0, 4.5], fleeTime: [2.5, 5.0],
    grazeTime: [12, 30], idleTime: [4, 11], walkTime: [10, 30],
    // Solitary. A cow with a calf would be the one exception and there is no
    // calf mesh on this skeleton — see the header.
    herd: [1, 1], herdRadius: 0, wanderRadius: 55,
    // Head down more than any other animal here. A moose eats 20 kg of willow
    // and pondweed a day and spends most of its life doing it, which is also
    // the pose that makes the rack read against the sky when it comes back up.
    grazeChance: 0.62,
    // Walks the river line it was placed on, like the bear. This is the whole
    // reason the placement is off the polylines: the walk IS the polyline.
    patrol: true,
    // ── the one number that is not the bear's ───────────────────────────────
    // How deep this animal will stand in. Everything else in the cast is held
    // to `WATER_MAX` (0.15 m) because everything else in the cast is a valley
    // mammal that keeps its feet dry; a moose is a wading animal whose whole
    // feeding strategy is standing in a river eating what grows in it.
    //
    // 0.75 m, and it did NOT scale with the animal when the animal got half
    // again bigger. That is deliberate: this number is a fact about the WORLD's
    // water and not about the moose's legs. Measured on the shipped seed, the
    // channels these three sites sit on run a MEDIAN of 1.17-1.19 m on the
    // centreline and up to 3.4 m, so the middle of a river is out of reach at
    // any believable wade depth — what 0.75 buys is the whole shallow margin,
    // which is where a moose actually feeds. Raising it further would only let
    // the animal wander out into water it would be swimming in.
    //
    // It is not decorative. Over a 120 s soak at each of the three sites with
    // the threat off the map, the animals reached 0.73 / 0.75 / 0.75 m and
    // picked wet wander targets (0.52-0.71 m) with zero pinning — see
    // `tools/_scratch/_moosewadeprobe.mjs`, which exists because the first
    // measurement of this said 0% and was wrong: the camper was parked 30 m
    // away, `noticeDist` is 120, and the whole soak was of a SPOOKED animal
    // standing still.
    wade: 0.75,
    // ── the cost of being the only animal that goes in the water ───────────
    // Clearance, in metres, that this animal keeps from a boulder. Nothing else
    // in the cast declares it, and the alpine pair must never: a goat CLIMBS
    // rocks, so for them a boulder is ground and this reading would fight the
    // other one.
    //
    // It exists because the wading created the problem rather than revealing
    // it. Every other mammal is kept off rocks by the terrain: boulders sit on
    // slopes and the probe fan already costs slope, and between them nothing
    // walks into one often enough to see. A river bed is FLAT and full of
    // midstream blocks, so the slope term has nothing to say, and a bull was
    // reported standing inside one.
    //
    // 1.4 m is a bit under half this animal's own body length, which is about
    // what it takes for a 5.6 m animal not to LOOK like it is brushing the
    // rock even when its origin is clear of it. `Brain._rockDepth` reads it as
    // a penetration depth rather than a wall, so it is also the gradient that
    // walks an animal out of a rock it has somehow ended up inside.
    //
    // Measured where it matters: 120 s at each of the three real sites with the
    // threat teleporting round the animal every six seconds — the gallery pen's
    // `spook`, on the actual riverbank — gives max `_pinned` of 0 / 1.3 / 0 s
    // and zero rock overlap, against the ~3 s that counts as healthy.
    //
    // **The gallery pen reads much worse and is not the check.** It is a fenced
    // 14 m meadow with a rock maze in it, and this animal is 5.6 m long with
    // 1.4 m of clearance round every boulder — 16 s pinned there is a 3 m moose
    // in a paddock, not a bug. Judge this species at a river.
    shun: 1.4,
    // How far a paw pin may reach when this animal is the journal's ringed
    // quarry. See `Wildlife._quarryHome`: with three home sites on 9.4 km2 the
    // ordinary rule — point only at an animal that has streamed in, within its
    // 190 m spawn ring — resolves 3.7% of the time, which is a targeting
    // feature that does not work. Measured on the shipped seed, the furthest
    // any in-bounds point sits from its nearest moose is 2502 m and the mean is
    // 846, so 4400 (the map's own corner-to-corner diagonal) is the value that
    // says "always". Nothing else in the cast declares this and nothing else
    // should: the deer has 261 sites and the same pin would be a GPS.
    trackDist: 4400,
  },
};
