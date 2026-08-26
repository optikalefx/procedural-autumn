// ─────────────────────────────────────────────────────────────────────────────
//  hunt_detect — what is actually in this photograph.
//
//  One function, called synchronously by `PhotoMode.capture()` on the frame the
//  shutter fires, returning the ids of the hunt items the photograph contains.
//  It reads other systems and writes nothing.
//
//  ── the first rule: never throw ─────────────────────────────────────────────
//
//  This runs inside the shutter path, between the forced render and
//  `toDataURL`, and the drawing buffer is gone by the next task. An exception
//  here does not lose a tick — it loses the player's photograph. So every
//  detector is wrapped, the whole body is wrapped, and every peer is reached
//  through optional chaining. A detector that cannot answer returns nothing;
//  it never takes the shot with it.
//
//  ── "in the photo" is not "in sight", and the units are the difference ──────
//
//  `Stats._look` answers a different question and answers it well: was this
//  animal in frame and within twenty metres of where the player actually was.
//  That is a *sighting* — an encounter you had — and its whole design argument
//  (see its header) is that a generous distance turns the wildlife log into a
//  measure of how far you drove.
//
//  A photograph is not an encounter, it is a picture, and a picture is judged
//  in the picture's own units. So the gate here is **apparent size**: the
//  subject's own HEIGHT must subtend at least `MIN_SHARE` of the frame's
//  height. That single rule replaces the three hand-tuned distances Stats needs
//  (20 m / 130 m / 420 m), and it lands in a different place in each direction,
//  which is exactly what it should do:
//
//  Everything below was measured in the running valley at fov 50, by planting
//  one animal, hiding the rest of its site, finding a bearing with a clear line
//  and then binary-searching the stand-off until the detector let go. Predicted
//  is the arithmetic; cut is what the game did, as camera-to-subject distance.
//
//     species        height   predicted   cut      (Stats' sighting gate)
//     deer           1.83 m     14.0 m    14.0 m     20 m — this is TIGHTER
//     bear           1.23        9.5       9.5       20
//     fox            0.69        5.3       5.4       20
//     rabbit         0.53        4.1       4.0       20
//     raccoon        0.38        2.9       3.0       20
//     squirrel       0.35        2.7       2.6       20
//     camp dog       0.84        6.5       6.5       20
//     heron          3.14       24.1      24.1      130 m — much tighter
//     eagle, perched 2.43       18.6      18.6      130
//     flamingo       2.10       16.2      16.2      130
//     owl, perched   1.41       10.9      10.9      130
//
//  A four-pixel deer in the corner is rejected by arithmetic rather than by a
//  distance somebody guessed. The "height" column is the subject's own, and
//  where it comes from per family is further down, under "the gate measured a
//  sphere" — it is the whole of what changed in round three.
//
//  Two of those rows are worth reading twice. **The bear counts from closer
//  than the deer**, which looks wrong until you notice the column it is sorted
//  on: a black bear on all fours is 1.23 m at the shoulder and a white-tailed
//  deer with its head up is 1.83 m. The bear is the bigger animal and the
//  shorter one, it fills the frame sideways instead, and a rule that reads
//  height says so. **The raccoon counts from closer than the rabbit** for the
//  same reason and it is the least comfortable row here: a raccoon is 0.82 m
//  long and 0.38 m tall, a rabbit 0.52 m long and 0.53 m tall with its ears up,
//  so the low animal has to be a metre nearer for the same apparent height even
//  though it is the larger creature. That is the price of a bearing-invariant
//  rule, and it is paid on purpose — the alternative quantities all vary as the
//  animal turns, and a gate that fires depending on which way a raccoon is
//  facing is worse than one that is a metre strict on raccoons.
//
//  **A testing note that cost a round.** `Wildlife.debugSpawn` plants a whole
//  SITE, not an animal: four deer, three bears, two foxes. A stand-off search
//  run against "the nearest active deer" measures whichever of the four happens
//  to be closest to the camera at each step, which is a different animal at
//  different distances and a meaningless number. Every row above was taken with
//  the other members of the site deactivated first. The `site of N` column of
//  the harness exists only to make that mistake loud.
//
//  It has a property a distance rule cannot have: **zooming in works.** Frame
//  share is computed against the live `camera.fov`, and photo mode's zoom ring
//  is a real lens (`src/photo/lens_models.js`, which has landed). Vertical fov
//  at 16:9: 24 mm 45.8 deg, 35 mm 32.3, 70 mm 16.5, 200 mm 5.8, 400 mm 2.9. So
//  the long lens is worth about seventeen times the reach of a 50 deg view, and
//  a deer that counts at 26 m on the wide counts at four hundred through the
//  tele. That is not a loophole, it is the mechanic: framing a distant deer
//  through a long lens genuinely makes it a photograph of a deer.
//
//  ── how MIN_SHARE was set, and the ceiling that turned out not to exist ─────
//
//  This file shipped 0.085 and defended it with an argument about birds. The
//  argument was wrong, and it is worth writing down exactly how, because it is
//  the most seductive kind of wrong: a table of real numbers answering a
//  question nobody was asking.
//
//  **The argument that was made.** `TREE_BIRD_SPECIES[].startle` is the
//  distance at which a perched bird flushes. A threshold demanding you crowd a
//  bird closer than that, the reasoning went, is a threshold no player can
//  satisfy — the shutter fires at an empty branch — so the startle radii put a
//  ceiling over MIN_SHARE, and the owl's 20 m was the tightest.
//
//  **Why it is not true.** Follow the flush through the code. A perched bird
//  leaves only for `threat && Math.abs(threat.speed) > 4`
//  (`tree_birds.js:908`), and `threat` is the VEHICLE (`Wildlife.js:850`).
//  Photo mode pauses the world (`main.js:543`) and hands over a free camera.
//  A parked player with a free camera has no speed, is not the threat, and
//  **cannot flush anything, ever.** Not one of the four numbers in that table
//  constrains a photograph. The startle radii are a driving mechanic, and this
//  file quoted them at a mode where the world is not moving.
//
//  So there is no ceiling. Nothing pushes back from above: the free camera is
//  unleashed (`CameraRig._free` — no boom, no length limit, 0.45 m of floor
//  clearance and nothing else), the world is frozen while you fly it, and the
//  lens goes to 400 mm. The threshold can be whatever a photograph needs.
//
//  ── the gate measured a sphere, and the sphere is not the animal ────────────
//
//  Two thresholds were set against the deer before this one — 0.085, then
//  0.155 — and both were argued from a photograph, honestly, and both were
//  wrong by the same mechanism, which is worth more space than either of them.
//
//  **They were applied to the geometry's bounding SPHERE.** A sphere's radius
//  is half the body diagonal, so it is set by whichever axis is longest. The
//  deer's is 1.76 m — a "diameter" of 3.52 m — for an animal 1.83 m tall. At
//  0.155 and 25.9 m the header claimed the deer measured "64 x 85 px". It did
//  not. 85 px is what the geometry's box PROJECTS to; 168 px is what the sphere
//  subtends; and the deer itself, measured by rendering the same pose twice
//  with the mesh shown and hidden and taking the largest changed blob, is 50 x
//  57 px. **The gate was reading a sphere three times the size of the thing
//  inside it**, and calling the result the animal's pixel size in a comment.
//
//  It is not a constant error that a threshold could absorb, either. The ratio
//  of drawn silhouette height to sphere diameter, measured on all six:
//
//     raccoon 0.22   bear 0.29   fox 0.34   squirrel 0.40   deer 0.42
//     rabbit 0.48
//
//  A factor of 2.2 between the tightest and the loosest. One number applied to
//  that quantity is six different promises.
//
//  **What tracks the animal is the bounding BOX's height.** Same measurement,
//  same six species, silhouette height over box height:
//
//     bear 0.81   deer 0.81   raccoon 0.81   squirrel 0.85   fox 0.87
//     rabbit 0.88
//
//  0.81 to 0.88 — a spread of 8%, against the sphere's 2.2x. The residual is
//  pose and grass: the box is the REST pose with the head up, and the animal in
//  the picture is grazing with its front legs in a meadow. So `meshHeight`
//  returns half the box's Y extent and `MIN_SHARE` is a share of the frame's
//  height taken by the subject's height. Same arithmetic, honest quantity.
//
//  **How "px" is measured, from here on.** Render the pose twice, with the
//  subject's mesh visible and hidden and its shadow off in both, and take the
//  largest connected blob of changed pixels. Nothing else counts as the
//  animal's size, and in particular a projection of eight bounding-box corners
//  does not — that is what produced "64 x 85". The world has to be paused
//  (`ctx.worldPaused`) for the two frames to be comparable; without it the
//  wind moves every blade of grass between them and the largest changed blob is
//  the meadow. That mistake produced a "deer" 12 m wide on the first run.
//
//  **Where the number came from: 14 metres.** A ladder of stand-offs around one
//  isolated deer — 11, 14, 17, 20, 24 m — four bearings each, twenty frames,
//  opened and looked at. At 20 m and 24 m the animal is a dark mark near the
//  treeline. At 17 m it depends on what is behind it: against pale grass it
//  reads, against the dark treeline it is genuinely hard to find, and one of
//  four failing is the whole test failing. At 14 m all four are photographs of
//  a deer — body, four legs, a head with ears, a tail — with the animal 82 to
//  99 px tall in a 1080 frame against the 166 px the box subtends. 0.149 is the
//  frame share at that distance, and it comes from those frames and nothing
//  else. The captures are `fix2/accept/deer_b*.png`.
//
//  **What it costs, per subject, is in the table above** — every cut was
//  re-measured rather than scaled, because the birds do not scale with the
//  mammals. Five consequences are worth stating out loud:
//
//   · Reach roughly halved for the mammals: the deer 25.9 → 14.0, the bear
//     29.5 → 9.5. Both are now well inside `Stats`' 20 m sighting gate, which
//     is the right way round — a photograph is a stronger claim than a
//     sighting.
//   · The squirrel counts from 2.7 m and the raccoon from 2.9. That is very
//     close, and it is still reachable, because the free camera flies, the
//     world is stopped and the animal is not going anywhere while you compose.
//     Checked in the frames: at 2.6 m the squirrel is 150 px tall with its
//     tail up its back, which is a photograph of a squirrel by anybody's
//     reckoning. Two hints moved with these two cuts — `hunt_items.js`, "and
//     two more, when the detector stopped measuring a sphere" — because a
//     sheet that does not say "get close" about the closest line on it is
//     lying by omission. The sheet stays completable; nothing here needs a
//     shot the camera cannot take.
//   · The birds barely moved (0.155 → 0.149 is 4%) and did not need touching,
//     for the reason in the note over `FOLD_R`: that branch was already
//     measuring a height.
//   · The camp dog moved twice — its size AND its centre, because the line
//     that placed it read `pos.y + r * 0.45` and `r` no longer means what it
//     meant. Re-derived and re-shot rather than reasoned about: `dog.pos.y` is
//     the ground under the dog to the last decimal (`camp_dog.js:405`), so mid
//     height is `pos.y + r`; the dog is 0.84 m tall against a 1.75 m sphere,
//     the cut goes 13.4 m to 6.5, and at 5.8 m the frame is a tent, a chair, a
//     telescope and a dog. `fix2/dog.png`.
//   · The owl is the line that changed character — see the next block.
//
//  ── the owl was never about the startle radius ──────────────────────────────
//
//  The old header claimed the owl was the tight line, cleared by a "-2 m
//  margin" that `startleDelay: 3` was said to buy back. Every part of that is
//  fiction: startle cannot bind a photographer at all, and there was no margin
//  to save.
//
//  What actually binds an owl is **height**. A great horned owl perches at the
//  top of a full-grown tree — measured on three live ones, 13.5 m, 25.4 m and
//  31.0 m up — and from the ground on the wide lens its frame share never
//  clears **0.055 at any distance, standing directly underneath included**,
//  because standing underneath is still thirty metres away. At 0.085 that was
//  equally true; the old "counts from 18 m" was a number computed as if the
//  bird were on the ground.
//
//  So the owl is not photographable from a car on the wide lens, and it never
//  was. It is photographable two ways, and both are things the game gives you:
//  fly the free camera up to the canopy (it counts from 10.9 m at perch
//  height), or fit the long lens.
//
//  **The tele reach is not one number, and the old sentence made it look like
//  one.** "Still 0.198 at 140 m" was true and irrelevant: 0.198 is a share, it
//  clears the threshold, and the round-two critic re-measuring the same bird
//  found the detector let go at 129 m — fifty metres short of where the size
//  arithmetic says. Something ahead of the size gate was binding and the header
//  did not say which.
//
//  Walked out on one owl, perched 15.5 m up, at both tele stops, reporting each
//  gate separately at each stand-off:
//
//     400 mm (vfov 2.9 deg)   fires to 187 m; at 200 m share is 0.140 and the
//                             march is still clear and the bird is dead centre
//     200 mm (vfov 5.8 deg)   fires to 91 m; at 94 m share is 0.147
//     the march                first fails somewhere between 300 and 400 m
//
//  So on THIS owl the size gate binds, exactly where `0.707 / tan(0.149 *
//  2.9deg / 2) = 187 m` says it should, and nothing else gets a word in. The
//  critic's 129 m came from a different bird — theirs was 33.9 m up — and the
//  binding gate there can be named by elimination rather than guessed at: a
//  stand-off harness aims the camera AT the subject, so `_ndc` is (0, 0) and
//  `EDGE` cannot be it. It is the terrain march. A bird thirty metres up on the
//  far side of a rise loses its line of sight long before it loses its size,
//  and the rest of this file exists to make exactly that not count.
//
//  What the sheet can promise, then, is a range and a reason: 175-200 m of
//  reach on the 400 mm from open ground (the spread is the wingspan draw, 2.6
//  to 3.0 m), less wherever the ground between you and the tree stands up. The
//  owl is comfortably in reach from the road, through the glass that is in the
//  bag for exactly this.
//
//  That is why the hint on the sheet now says "only after dark, and high up.
//  Fit the long lens" instead of "only at night, and only in the headlights".
//  The headlights version described a shot that cannot count.
//
//  ── the flamingo and the heron, which are now measured ──────────────────────
//
//  Both were guesses in the first version, because `debugPerchNear` refuses to
//  place a wader unless it can find a site the species' own `_findWade` accepts
//  and the camera was nowhere near one. Driving the camera to a river anchor
//  first places both, and the answer is the reassuring one: a wader stands in
//  the water, so it has no perch-height problem at all. Heron 1.6 m above the
//  bed, counts from 24.1 m; flamingo 1.9 m, counts from 16.2 m.
//
//  The flamingo takes finding: `_findWade` wants `minSpan: 7`, so most river
//  anchors refuse it. Walking `__anchorAt('river', i)` outward, the fifth is
//  the first that takes one. A run that gives up after one anchor reports "the
//  flamingo cannot be measured", which is a statement about the harness.
//
//  ── where the photographer is ───────────────────────────────────────────────
//
//  Every distance here is from `ctx.camera.position`, full stop, and Stats'
//  careful "the camper, or the boat, never the camera" logic is deliberately
//  NOT copied. It exists there because in the chase view the camera sits several
//  metres behind the player and a 20 m reach measured from it would be short in
//  front and long behind. Photo mode hands the camera to `CameraRig`'s FREE
//  mode: it is not attached to the camper, the camper is frequently not even in
//  the shot, and the camera IS the photographer. Asking where the camper was
//  standing when a free camera took a picture is asking about the wrong object.
//
//  (Called from the chase camera — nothing stops that — the answer is off by
//  the length of the boom, ~6 m in a 60 m budget. Acceptable, and noted so
//  nobody mistakes it for a claim.)
//
//  ── occlusion: paid for, unlike Stats ───────────────────────────────────────
//
//  Stats explicitly skips a raycast and takes the error: "an animal 15 m away
//  behind a boulder counts", which at 15 m is rare and forgivable. It is not
//  forgivable here. A sighting you did not really have is a wrong line in a
//  logbook; a photograph of a bear through a cliff is a photograph OF A CLIFF,
//  taped into a book, with "Photo of a black bear" written under it. That is the
//  single most embarrassing thing this feature could do.
//
//  What is paid for is the terrain and only the terrain: a march along the ray
//  sampling `world.getHeight` every ~3 m, rejecting the subject if the ground
//  ever stands more than `OCC_TOL` above the line of sight. That catches every
//  ridge, cliff and hillside — the whole class of "it is on the other side of
//  that" — for about twenty array reads per candidate, once per shutter press.
//
//  It does NOT catch trees, rocks, buildings or the camper. Those need a real
//  raycast against scene geometry, and a raycast against this scene is a
//  different order of expense: the trees are instanced with vertex-shader
//  canopies and the terrain is chunked LOD, so `Raycaster` would either miss
//  them or cost milliseconds. A deer half behind a trunk is also a photograph
//  of a deer, which the terrain case never is. Deliberate line, drawn where the
//  error stops being funny.
//
//  **How big that hole is, measured rather than predicted.** 256 poses around
//  one isolated deer — 64 bearings on rings at 8, 13, 18 and 24 m, inside the
//  range that now counts — with a real `Raycaster` against the scene, the deer
//  itself excluded. **3 of 256** had solid non-terrain geometry on the line,
//  and all 3 credited `deer`. At the old threshold, over rings at 16/24/34/44 m,
//  the same sweep found 35 — including a bush 1.4 m from the lens with the deer
//  34 m behind it. Raising MIN_SHARE shrank this hole by a factor of twelve for
//  free, because the poses where something gets between you and a subject are
//  overwhelmingly the long ones. Three in 256 is a player deliberately
//  photographing a bush, and it stays.
//
//  (Those rings were measured against the previous, looser threshold, and the
//  sweep has NOT been re-run since the deer's cut halved to 14 m. It is quoted
//  as a bound rather than as a current figure: the same rings at 8-24 m are now
//  entirely inside the range that counts where before the far two were not, and
//  the trend the paragraph above describes — the hole is made of long poses —
//  runs the right way. If it is ever re-run, re-run it; do not read 3 of 256 as
//  this build's number.)
//
//  Tried first and thrown away: reading the depth buffer at the subject's pixel
//  and comparing it to the subject's distance. It is exact, it costs one
//  `readPixels`, and it is unusable — the post chain does not keep a depth
//  target bound after `postfx.render`, and a synchronous readback in the
//  shutter task is the same pipeline stall `PerfOverlay`'s sync burst was
//  removed for (AGENTS.md, "known contaminations").
//
//  Measured in the running valley: a ring of 72 camera positions around a real
//  rabbit at 70% of its detection range, each on the ground at eye height. 64
//  of them had a clear line and the detector fired at all 64; 8 were blocked by
//  terrain and it fired at none. No disagreements in either direction. The same
//  ring around a deer at 33 m had no blocked positions at all and fired at all
//  72. That is the whole claim, and it is the reason this file is allowed to be
//  more confident than `Stats` is.
//
//  ── the fall behind the ridge, which was the one subject with no test ───────
//
//  `waterfalls()` used to skip the march entirely, and the note where the call
//  should have been argued that it did not need one: "a ridge tall enough to
//  hide a 40 m fall also takes its own share of the frame away; the size gate
//  is doing that work". That is a plausible sentence and it is false. Rings of
//  36 poses at 120 m around each of the six tallest falls: **86 of 216 had
//  terrain across the line by this file's own `clearLine`, and every single one
//  of the 86 credited `waterfall`** — one of them with the fall 27.9 m below
//  the sight line and no part of it anywhere on screen. That is the
//  photograph-of-a-cliff failure, the one this header calls the single most
//  embarrassing thing the feature could do, shipped in the one detector that
//  had opted out of the test written to prevent it.
//
//  The reason it opted out was real, though. `getHeight` at a fall's own
//  footprint returns the CLIFF the water is falling down, so a march to the
//  MIDDLE of the drop is blocked from almost everywhere — including from
//  directly in front of it. The midpoint is the one point of a waterfall that
//  is reliably behind something.
//
//  The fix is the one `AIM` already makes for the convex camp: ask about the
//  part that shows. The march now runs to the **lip** — `wf.top`, where the
//  river goes over — with `LIP_R` of slack, because a subject is visible when
//  any of it is and the top of a fall is the part a ridge does not eat. After:
//  86 blocked, **5** still credited. A 43x improvement, and it reproduces
//  exactly — 216 poses, 86 mid-blocked, 5 credited, twice, by two people.
//
//  ── what those five actually are, which is not what this header said ────────
//
//  The sentence that used to sit here said the five "are poses where the lip
//  clears the ridge and the plunge pool does not, which is a real if partial
//  view of a real waterfall". That is a nice sentence and it describes none of
//  them. Resolved — by replaying `waterfalls()`'s own loop to find WHICH fall
//  each pose is credited by, and then measuring how much waterfall is on screen
//  by rendering each frame twice with the `Waterfalls` group shown and hidden,
//  world paused:
//
//    pose                    credited by            water on screen
//    (141, -891) e230        fall #12, 284 m away    1384 px  (0.07% of frame)
//    (22.8, -1031.8)         fall #12, 261 m         4356 px  (0.2%)
//    (21, -1011)             fall #12, 279 m         3519 px  (0.2%)
//    (-367.1, -434.9)        the ring's own, 138 m     30 px
//    (-355.1, -452)          the ring's own, 136 m      2 px
//    — for scale, the same ring on a clear bearing —  18 959 px  (0.9%)
//
//  So **three of the five were not about the ring's fall at all**: they were
//  credited by a different, 40.7 m fall a quarter of a kilometre away, which is
//  on screen as a pale line on grey rock in a frame otherwise filled by a pine
//  branch or a cliff face. And the two the old sentence was actually about have
//  **thirty pixels and two pixels** of water in them — the lip clears the ridge
//  by the march's reckoning and does not clear it by the renderer's. "Lip
//  visible, pool hidden" describes neither group.
//
//  The three long ones are fixed, by `FALL_W` (see the constant): a fall 3.4 m
//  wide at 280 m is 14 px of width, and 14 px of width is not a photograph of
//  anything. That takes the mountain-ring residual from 5 to **2**, and the two
//  that remain are the two with almost no water on screen — which is the lip
//  test's own residual, is 0.9% of a deliberately contrived population of
//  mountain-ring poses, and stays. It is the honest cost of asking about the
//  lip instead of the middle, and the alternative — asking about the middle —
//  is the 86-out-of-86 failure this whole block exists to describe.
//
//  **The "25 of 120 road-level, before and after" figure is not checkable and
//  should not be quoted.** It was meant to show the ordinary case did not move,
//  which is the right thing to show; but nothing recorded which 120 poses or
//  how they were aimed, there is no road-node debug surface to reproduce them
//  from, and two later runs with their own aiming rules got 3 and 6. Those
//  numbers neither confirm nor refute it. What CAN be said, because it is
//  measured on a population anybody can rebuild, is in the false-positive block
//  below and in `FALL_W`'s own note: over the whole valley the `waterfall` line
//  is credited on 34 of 800 random photographs, and over the mountain rings on
//  117 of 216, against 121 before the width floor. The ordinary case moved by
//  3%; the contrived one lost three fifths of its residual.
//
//  ── the fireflies were not a find ───────────────────────────────────────────
//
//  The old rule asked two questions of the uniforms — is the dusk ramp past
//  0.35, is the damped habitat at the camera past 0.25 — and then whether three
//  of thirty-two ground samples landed in frame. Every one of those is true
//  almost everywhere on the valley floor after dark, so the line ticked itself
//  on the FIRST NIGHT PHOTOGRAPH the player took, of anything, anywhere:
//  measured, 25 of 30 random 21:30 poses (83%). They were real fireflies, so it
//  was not a false positive — it was worse than one. It was an item on a
//  scavenger hunt that could not be hunted, under a hint promising a search
//  that did not exist.
//
//  What makes a photograph a photograph OF fireflies is how many are in it, so
//  that is now the question. `ffCount` integrates the vertex shader's own
//  habitat product over a 72-point grid on the ground inside the wrap box —
//  `meadow`, `bank`, `open`, `shallow`, `low`, term for term out of
//  `fireflies.js` VERT — turns each sample's `want` into the share of the
//  population present there, and adds up the ones that land in frame with a
//  clear line to them. It is the shader's arithmetic on seventy-two points
//  instead of three thousand insects.
//
//  **Calibrated against frames, not against feel.** 34 random night poses, each
//  screenshotted twice and the flashes in the picture counted by a blob pass
//  over the greenish-yellow core colour. **The frames and the counting script
//  lived in a scratch directory that is not in this checkout**, so — by the
//  same standard this file applies to the road-level waterfall figure a few
//  hundred lines down — the numbers below are reported, not reproducible from
//  here. Re-shoot before leaning on them. At
//  FF_MIN = 110: ten poses credited, nine of the ten had five or more
//  countable flashes and the ten averaged 12.8; the best frame in the whole set
//  — a wooded meadow with 25 flashes in it — is credited, and the rejects top
//  out at 6.5. Roughly a fifth of the swarm is alight at any instant and much
//  of the rest is behind grass, which is why 110 insects reads as about a dozen
//  lights: the estimate is a population, the flashes are what the picture
//  shows, and the two are related by that measurement rather than by a guess.
//
//  **Three things about that calibration, said out loud because "ten poses
//  credited" is doing a lot of work.**
//
//   · "Ten credited" counts poses whose recorded `est` cleared 110, not poses
//     the detector answered yes to. On that run the two disagreed twice —
//     `rows.json` has poses 15 and 19 marked `hit: true` at est 88.1 and 78.4,
//     which is `ffCount` being asked before streaming had settled and answering
//     for a different bit of ground than the screenshot shows. A clean re-run
//     by a critic had zero disagreements between the two. So the ten are ten by
//     `est`, and `est` is the thing FF_MIN is a threshold on; if the two ever
//     disagree again the answer is a settle, not a constant.
//   · The one credited pose out of ten with fewer than five flashes is p7 —
//     est 163, 3.5 flashes — and it is a camera pointed into a slope. That is
//     precisely the case the per-sample line-of-sight test below exists for,
//     caught in the act and not fully caught: the march clears enough samples
//     to reach 163 while the near grass eats the lights. It is disclosed rather
//     than fixed because the fix is a per-sample occlusion test finer than a
//     3 m terrain march, and that is a different order of cost in the shutter
//     path.
//   · The rate below is a draw and the number quoted was one draw of it.
//
//  The per-sample line-of-sight test came out of the same calibration. Without
//  it, four of the thirty-four poses estimated between 60 and 270 insects and
//  had not one flash anywhere in the frame — every one of them a camera pressed
//  against a slope, crediting the meadow on the other side of the hill.
//
//  Where it lands: 18 of 40 (45%) of poses framed deliberately at the ground
//  the way the old sweep framed them, against 83% before; and **a fifth to a
//  quarter of random night photographs aimed anywhere** — 42 of 200 on one
//  draw of 200 poses, 56 of 200 on an independent one, so 21% and 28% of the
//  same underlying rate. Quote the range, not either end: two draws of 200
//  from a rate near a quarter differ by that much routinely, and the earlier
//  version of this line quoted 21% to two figures as though it were a
//  property of the rule. It is the number that matters, because it is the
//  accidental tick, and what it says either way is that the swarm really is a
//  valley-floor phenomenon and an honest rule cannot make it rarer than it is;
//  what changed is that a dark hillside, a dry ridge, an alpine shoulder or a
//  frame of night sky no longer counts as a photograph of fireflies.
//
//  ── false positives, which are the failure mode that would ruin this ────────
//
//  800 camera poses at random points across the whole 3072 m valley, at midday
//  with no camps pitched, each on a random bearing and a random pitch inside
//  +-0.25 rad: **zero** animals, zero camps, zero fireflies. The only id that
//  came back was `waterfall`, on **34** of them (4.3%) — which is not a false
//  positive, it is what a reach of a couple of hundred metres over twenty-eight
//  waterfalls looks like when you point a camera at random.
//
//  The aiming rule matters and this is the third set of numbers this paragraph
//  has carried, so: 56 of 800 on this pose set before `FALL_W`, 34 after. An
//  earlier run of the same sweep with the camera held level rather than pitched
//  got 44 of 800, and a critic's 400 level poses got 19 (4.8%) — level aiming
//  finds fewer skyline falls, which is the whole of the difference. The animal,
//  camp and firefly counts are zero under every one of them, which is the part
//  of this paragraph that is actually load-bearing, and the tighter `MIN_SHARE`
//  can only push those further down.
//
//  ── what it costs ───────────────────────────────────────────────────────────
//
//  (Not re-timed in round three, and quoted as unchanged rather than as
//  re-measured. What changed is a bounding sphere for a bounding box — the same
//  read off the same geometry — and one `atan` plus one distance per waterfall
//  candidate, against a `clearLine` march that is twenty array reads. If it is
//  ever re-timed, re-time it; do not read the range below as this build's.)
//
//  Two to nine microseconds per call, measured over 200 calls in a booted game
//  — 2.0 at a night pose with the firefly integral running, 9.0 at the boot
//  pose with a streamed-in animal pool to walk. The old header said 11.5, which
//  a critic re-measuring got 4.5-7.0 for; the range above is what it actually
//  spans, and the honest form of this number is a range.
//
//  The firefly count is the expensive part and it is worth knowing why it does
//  not matter: 72 samples of five world queries each is about four hundred
//  array reads, and it runs only after the two uniform early-outs, which are
//  false for every photograph taken in daylight. It runs once per shutter
//  press, in the same task as a `toDataURL` of a native-resolution frame that
//  takes tens of milliseconds. It is free.
//
//  ── the marshmallow detector was written against a branch that had not landed
//
//  When this file was drafted the roasting mechanic did not exist here; it was
//  uncommitted work in a sibling worktree, and `burntMallow` was written blind
//  against the shape that branch was going to land with, entirely through
//  optional chaining so a build without it returned nothing rather than
//  throwing into the shutter path. It landed mid-build (`94e1671`) and the
//  detector is now the real one, tested against the mechanic's own harness
//  (`window.__roast`, `tools/roastshot.mjs`) at every rung of its doneness
//  ladder — see the notes over `burntMallow` below.
//
//  The optional chaining stayed anyway, because it turns out to be load-bearing
//  for a different reason: `Camp.roast` exists but `roast.toast` and
//  `roast.mallow` are built in `enter()` and dropped in `leave()`, so for
//  almost every photograph anybody ever takes there is no marshmallow at all.
//  "This build has no roasting" and "nobody is at a fire right now" are the
//  same code path, and it is the one that runs 99% of the time.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { HUNT_IDS } from './hunt_items.js';

// ── the framing rules ────────────────────────────────────────────────────────

/**
 * How much of the frame's HEIGHT the subject's own HEIGHT must subtend.
 *
 * Not its bounding sphere. See the header's "the gate measured a sphere" for
 * the two thresholds that came before this one and what was wrong with the
 * quantity they were applied to. The short version: a deer's bounding sphere
 * is 3.52 m across and the deer inside it is 1.83 m tall, and every other
 * species has its own such ratio, spanning 0.22 to 0.48 — so a share taken on
 * the sphere is a different promise for every animal it is applied to.
 *
 * 0.149 is the frame share of the photograph that was judged acceptable: the
 * deer at 14 m, from four bearings, every one of them a picture a reader finds
 * the deer in without being told where to look. It is not round and it is not
 * meant to be.
 */
const MIN_SHARE = 0.149;

// The two set-pieces are not animals and do not answer to MIN_SHARE. A
// waterfall is enormous — the animal share would still count one at 380 m,
// which is a fall on the skyline rather than a fall you went to — and a camp is
// something you are standing next to. Both were set against their own subject
// and neither moved when MIN_SHARE did, because neither was ever derived from
// it: a rule tuned on a deer has nothing to say about an eighty-metre drop.
//
// FALL_SHARE reads the same way MIN_SHARE now does — the drop's HEIGHT over the
// frame's height — because `waterfalls()` hands `share` half the drop. It was
// already the silhouette rule; see the header.
//
// CAMP_SHARE is the one place in this file where the number in `share` is not a
// half-height. A camp is a clearing: it is wide and low, `c.radius` is a
// horizontal radius, and the thing a photograph of one has to contain is the
// ground it occupies rather than the height of a tent. Left as it was, and
// named here so nobody reads it as the same promise as the other two.
const FALL_SHARE = 0.12;
const CAMP_SHARE = 0.12;

/**
 * And the same question asked across the fall, which is the dimension that
 * decides whether it reads as water.
 *
 * Every fall in this valley is a ribbon: measured over all 28, the widths run
 * 3.3 to 8.1 m (median 4.5) against heights of 22 to 96 m — nine to one. So the
 * height gate is satisfied by falls that are, on screen, a scratch. Measured at
 * three of the mountain-ring poses the round-two critic photographed, a 40.7 m
 * fall 3.4 m wide at 261-284 m clears FALL_SHARE with a height share of 0.164 to
 * 0.178 and puts **13 to 16 pixels of width** on a 1920x1080 frame; the frames
 * are a pine branch and a cliff face with a pale line on the rock behind them.
 * That is the deer's brown lozenge again, in a raincoat.
 *
 * 0.02 of the frame height is ~22 px of width, and it is where the picture
 * turns: at 0.0138-0.015 the three poses above hold 1384, 3519 and 4356 pixels
 * of visible water in a 2.07 megapixel frame — 0.07% to 0.2% — while the
 * ordinary case, the same ring at a bearing where the fall is clear, holds
 * 18 959 (0.9%) at a width share of 0.032. An order of magnitude, and it is
 * visible as an order of magnitude when you open the two files.
 *
 * What it costs, measured on the same two populations as everything else:
 * random valley poses crediting `waterfall` go 56 of 800 to 34 of 800, and the
 * mountain-ring sweep goes 121 of 216 to 117. The reach for a median 4.5 m fall
 * becomes 258 m; for the widest, `FALL_MAX` still binds first.
 */
const FALL_W = 0.02;

// A marshmallow is 21 mm across, held at arm's length, in a view that frames it
// for you. The share rule that keeps a deer honest at 26 m has nothing useful
// to say about an object you are holding, so it gets its own floor — 3% of the
// frame, ~35 px in a 1080 shot, which is a marshmallow-sized marshmallow.
const MALLOW_SHARE = 0.03;

/**
 * How far off centre the subject may sit before it stops being in the picture.
 *
 * NDC units: ±1 is the edge of the frame in both axes. 0.84 leaves a margin of
 * about 8% of the frame all the way round, and it is NOT a rule-of-thirds
 * requirement — thirds put a subject at 0.33 and this game ships a thirds grid,
 * so demanding the centre would be arguing with the game's own composition aid.
 * It is only saying that a subject whose centre is past the edge is being cut in
 * half, and its apparent size is therefore a lie.
 *
 * Big subjects get their own size added as slack, so a waterfall filling the
 * left of the frame still counts even though its midpoint is off to one side.
 */
const EDGE = 0.84;

// Distance ceilings, for the two subjects where apparent size alone is not the
// whole question. Neither ever binds for an animal.
const FALL_MAX = 320;     // a little under Stats' 420 m sighting reach: a fall
                          // you can SEE from the far rim is not one you have
                          // photographed. Since `FALL_W` it is no longer the
                          // gate that usually ends the reach — a median 4.5 m
                          // fall runs out of width at 258 m — and it still
                          // binds for the widest, which is what it is for.
const CAMP_MAX = 140;
const MALLOW_MAX = 4;

/**
 * The radius the waterfall's line-of-sight march is drawn with — see the
 * header's "the fall behind the ridge". It is not the size of the fall; it is
 * `clearLine`'s handle on how much slack to leave, and `AIM` turns it into
 * 1.8 m of aim above the lip and about 6 m of ray excluded at the far end.
 *
 * Both of those are the same fact: the top of a drop is where the river is
 * still a river, so the ground for the last few metres of the ray IS the water
 * and stands exactly level with the target. Aiming a little over it and
 * stopping a little short of it is how you ask "can I see the lip" rather than
 * "is the lip above its own riverbed".
 */
const LIP_R = 3;

/**
 * Perched birds are drawn folded, and the geometry's bounding sphere is the
 * bird with its wings SPREAD (span is 1.0 in unit space and scale IS wingspan
 * — see `TREE_BIRD_SPECIES`). Halve the radius as the fold closes.
 *
 * 0.5 is a model, and an honest-sized one: measured against life, a perched
 * great horned owl is 0.39 of its own span tall, a bald eagle 0.44, a heron
 * 0.55 and a flamingo — all neck and leg — nearly 0.8. Half sits inside that
 * spread and errs generous for the squat birds and tight for the tall ones,
 * which is the right way round: the tall ones are the ones you meet at a
 * distance across water.
 *
 * **Read that paragraph again and notice what it is a model OF.** "0.39 of its
 * own span TALL" — this constant was always converting a wingspan into a
 * HEIGHT, which is exactly the quantity `MIN_SHARE` now asks for. The bird
 * branch needed no change when the mammal branch was rewritten, because the
 * bird branch had never been measuring a sphere: `unit * sc * FOLD_R` is half
 * the perched bird's height and has been since it was written. Measured on the
 * live birds, `unit` is 0.508-0.568 and `sc` is the wingspan in metres, so
 * `2 * r` comes out at 1.42 m for an owl, 2.43 m for an eagle and 3.14 m for a
 * heron — the perched heights of birds this game draws at 2-3x life on purpose.
 *
 * The sphere is the right handle HERE and the wrong one for a mammal for the
 * same reason in both cases: it is half the body diagonal, and a spread bird's
 * diagonal IS its span. The mammals' bounding box has a Y extent that means
 * something; these birds' does not — the bald eagle's is 0.142 of a span,
 * because a bird with its wings out is a flat thing.
 */
const FOLD_R = 0.5;

// ── occlusion march ──────────────────────────────────────────────────────────

const OCC_STEP = 3.0;     // metres between height samples
const OCC_MAX = 64;       // hard cap, so a 320 m waterfall ray is still cheap
// How far the ground may stand above the line of sight before it is calling
// the subject hidden. The heightmap is 2 m per texel and bilinear, so a ridge
// crest can read low by a few tens of centimetres; 0.75 m is above that noise
// and well below anything that actually blocks a view.
const OCC_TOL = 0.75;

// ── fireflies ────────────────────────────────────────────────────────────────
//
// The swarm has no objects to test. It is one draw call of GPU-resident points
// wrapped toroidally around the camera inside a 30 m box (`fireflies.js:BOX`),
// and the population that actually DRAWS is decided per insect in the vertex
// shader. So the only honest question is a count: how many insects are lit
// inside this frame? See the header block "the fireflies were not a find".
const FF_NIGHT = 0.35;    // uOpacity: the dusk ramp. 0.35 lands around 20:00
const FF_HAB = 0.12;      // uDensity: damped habitat at the camera. Both of
                          // these are early-outs now rather than the rule —
                          // they cost two reads and skip seventy world queries
                          // on every daylight photograph ever taken. 0.12 is
                          // low on purpose: it was 0.25 when it WAS the rule,
                          // and a gate that can veto a frame the count would
                          // have passed is a second opinion nobody asked for.

// The ground grid the count is integrated over: six rings of twelve, as
// fractions of the wrap box's half-extent, so it still fits if `BOX` changes.
// It covers the disc inscribed in the box — 81% of its area — which makes the
// estimate mildly conservative and is the reason the corners are not in it.
const FF_RINGS = [0.10, 0.27, 0.43, 0.60, 0.77, 0.93];
const FF_BEARINGS = 12;
// Height above the surface to project a sample at. `aSeed.y` arrives
// pre-squared (mean 0.25) into a 0.35 → 3.10 m band, so the population's mean
// height is ~1.05 m: knee-high, which is where they are.
const FF_H = 1.05;
// The spatial mean of the shader's `clump` term. The clumping is world-space
// value noise (`ffNoise`) and this file deliberately does not reproduce it —
// porting a hash into a second language is how two systems quietly disagree —
// so the count carries its average instead: clump = mix(0.16, 1.0, s) with s
// averaging ~0.5 over the field gives 0.52. The cost of the simplification is
// that standing in a dense cluster reads slightly low and standing in a gap
// slightly high, which is a smaller error than the one it avoids.
const FF_CLUMP = 0.52;
/**
 * How many insects in frame make a photograph OF fireflies. See the header for
 * the calibration — it is a count of the population present, not of the flashes
 * you can see, and the two are related by a measurement rather than by a guess.
 */
const FF_MIN = 110;

// ── scratch ──────────────────────────────────────────────────────────────────
// Module-level and reused. This runs once per shutter press, but it runs in the
// same task as a 2.5 MB `toDataURL` and there is no reason to hand the GC
// anything at all.
const _p = new THREE.Vector3();
const _view = new THREE.Vector3();
const _ndc = new THREE.Vector3();
const _inv = new THREE.Matrix4();
// A second world-space point, for the two subjects whose "is it visible" point
// is not the same as their "how big is it" point — see `waterfalls`.
const _aim = new THREE.Vector3();

/**
 * The per-call frame: everything the gates need, resolved once.
 *
 * `matrixWorldInverse` is rebuilt here rather than read off the camera. The
 * renderer maintains it, and by the time `capture()` runs it is correct — but
 * "correct because somebody else updated it this frame" is exactly the kind of
 * assumption that breaks silently when a render path changes, and inverting a
 * 4x4 once is free.
 */
function frameOf(ctx) {
  const cam = ctx?.camera;
  if (!cam?.isCamera) return null;
  cam.updateMatrixWorld?.();
  _inv.copy(cam.matrixWorld).invert();
  // Vertical field of view in radians. `fov` is the vertical one in three.js,
  // which is what makes frame-height share the natural unit here.
  const vfov = THREE.MathUtils.degToRad(cam.fov ?? 50) || 0.9;
  return {
    cam,
    eye: cam.position,
    // `_inv` itself, not a copy of it. It was `_inv.clone()` — one Matrix4 per
    // call, six lines under a comment promising the GC nothing at all — and
    // the clone bought nothing: `frameOf` runs once per `detectSubjects`, the
    // frame it returns dies at the end of that call, and no detector writes to
    // `view`. Anything that later wants two frames alive at once takes a copy
    // there, where the reason is visible.
    view: _inv,
    proj: cam.projectionMatrix,
    vfov,
    world: ctx.world ?? null,
  };
}

/**
 * Is a subject `2 * radius` tall, centred at `pos`, big enough — and far enough
 * inside the frame — to be the subject of this photograph?
 *
 * `radius` is a HALF-HEIGHT for everything that answers to `MIN_SHARE`: half a
 * mammal's bounding-box height, half a perched bird's modelled height, half a
 * waterfall's drop. `2 * atan(radius / dist)` is then the angle the subject's
 * height subtends and `s` is that over the frame's own vertical angle.
 *
 * That is an ANGULAR share, and a screen is planar — so it is not quite "15% of
 * the picture tall". A pinhole puts the subject at `h / (2·d·tan(vfov/2))` of
 * the frame, and the angular form runs about **7% high** at the mammal cut: the
 * deer at 14 m measures 0.140 of the frame while the gate reads 0.149. The gate
 * is not wrong — every threshold in this file was derived from frames THROUGH
 * this formula, so the number and the measure agree — but a table of
 * silhouette-over-height ratios computed the planar way will not reproduce from
 * it, and one published at 0.81-0.88 is 0.75-0.83 recomputed this way. Do not
 * mix the two. The one caller
 * that hands it something else is `highCamp`, whose subject is a clearing
 * rather than a standing object — see the note on `CAMP_SHARE`.
 *
 * Returns the frame share when it passes and 0 when it does not, so a caller
 * that wants "the best one" can compare — nothing does yet, and the flag is
 * cheaper to read than a boolean plus an out-parameter.
 */
function share(f, pos, radius, minShare, maxDist) {
  _view.copy(pos).applyMatrix4(f.view);
  const depth = -_view.z;
  // Behind the lens, or so close it is inside the near plane. 0.2 m rather than
  // 0 because the projection divides by this.
  if (!(depth > 0.2)) return 0;
  const dist = _view.length();
  if (dist > maxDist) return 0;

  // Standing inside the subject — the plume of a waterfall, a camp clearing you
  // parked in the middle of. Angular size stops meaning anything; you are in it.
  if (dist < radius) return 1;

  const s = (2 * Math.atan(radius / dist)) / f.vfov;
  if (s < minShare) return 0;

  // NDC. `applyMatrix4` does the perspective divide, and `depth > 0` above is
  // what makes that divide safe.
  _ndc.copy(_view).applyMatrix4(f.proj);
  // One NDC unit is half the frame height, and `s` is a diameter over a full
  // frame height — so the subject's own angular radius is `s` in these units,
  // which is the slack a large subject earns.
  const lim = EDGE + s;
  if (Math.abs(_ndc.x) > lim || Math.abs(_ndc.y) > lim) return 0;
  return s;
}

/**
 * Is there ground between the lens and `pos`?
 *
 * Marches the straight line in world space, sampling terrain height. Both ends
 * are excluded: the camera end because a free camera can sit a few centimetres
 * above a slope, and the subject end by the subject's own radius, because
 * everything here STANDS on the ground and the last metre of every ray is
 * therefore about to touch it.
 *
 * ── it aims at the top of the subject, not the middle ───────────────────────
 *
 * `AIM` is 0.6 of the radius above the sphere's centre, and it is not a fudge
 * factor — it is the fix for a false negative this test produced the first time
 * it was run against a real camp.
 *
 * A camp pitched at 193 m on a summit was rejected from 40 m away and accepted
 * from 15 m. The march was right and the question was wrong: a hilltop is
 * CONVEX, so the straight line between two points on it passes under the
 * surface, and the ground genuinely does stand above a chord drawn from a
 * camera downslope to the middle of a camp on the crown. What the photographer
 * can see over that bulge is the top of the tent, not the fire ring.
 *
 * So the ray is drawn to the part of the subject that shows: 0.6 of a radius up
 * is the tent ridge on a camp, the shoulder and head on a deer, and a few
 * centimetres on a rabbit — which is exactly the right amount, because a rabbit
 * that is behind something IS behind it. A subject is visible when any of it
 * is, and this is the cheapest honest approximation of "any of it".
 */
const AIM = 0.6;

function clearLine(world, from, to, radius) {
  const get = world?.getHeight;
  if (typeof get !== 'function') return true;    // no terrain query, no claim
  const dx = to.x - from.x, dy = (to.y + radius * AIM) - from.y, dz = to.z - from.z;
  const flat = Math.hypot(dx, dz);
  if (flat < 6) return true;                     // nothing fits in six metres

  const n = Math.min(OCC_MAX, Math.max(4, Math.ceil(flat / OCC_STEP)));
  const t0 = Math.min(0.25, 2.5 / flat);
  const t1 = 1 - Math.min(0.4, Math.max(0.04, (radius * 1.6 + 1.5) / flat));
  if (!(t1 > t0)) return true;

  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    const g = get.call(world, from.x + dx * t, from.z + dz * t);
    if (Number.isFinite(g) && g > from.y + dy * t + OCC_TOL) return false;
  }
  return true;
}

/** Both gates, in the order that rejects fastest. */
function visible(f, pos, radius, minShare = MIN_SHARE, maxDist = Infinity) {
  if (!share(f, pos, radius, minShare, maxDist)) return false;
  return clearLine(f.world, f.eye, pos, radius);
}

/**
 * HALF a mesh's world-space height, as (mid-height point in `_p`, half-height
 * returned) — the number `share` wants, for the reason in the header.
 *
 * The bounding BOX, not the bounding sphere. The sphere's radius is half the
 * body diagonal, so it is set by whichever axis is longest — the deer's is set
 * by its length and its antlers and comes out at 1.76 m for an animal 1.83 m
 * tall, a "diameter" of 3.52 m. The box's Y extent is the animal's height and
 * nothing else, and measured against the drawn silhouette (header table) it is
 * the height to within 11-20%, on every one of the six.
 *
 * The animals are skinned and animated in a rig, so the geometry's own box is
 * the REST pose — which is the right thing to use anyway: a deer mid-stride and
 * a deer standing still are the same size of deer, and a per-frame box would
 * make the gate flicker with the gait. It is also why the box reads a little
 * tall: the rest pose has the head up and a grazing deer does not.
 *
 * Only `.y` is carried across, because these objects rotate about Y — the
 * horizontal part of the offset would need the full transform, and height is
 * invariant under the one rotation they have.
 */
function meshHeight(mesh) {
  const g = mesh?.geometry;
  if (!g) return 0;
  if (!g.boundingBox) { try { g.computeBoundingBox(); } catch { return 0; } }
  const bb = g.boundingBox;
  if (!bb || !Number.isFinite(bb.min.y) || !Number.isFinite(bb.max.y)) return 0;
  const s = Math.abs(mesh.scale?.y) || Math.abs(mesh.scale?.x) || 1;
  _p.copy(mesh.position);
  _p.y += (bb.min.y + bb.max.y) * 0.5 * s;
  return (bb.max.y - bb.min.y) * 0.5 * s;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The detectors. One per family; each adds ids to `hit` and must not throw
//  past `detectSubjects`'s own guard.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The six wild mammals. `SPECIES` keys are the hunt ids by construction (see
 * `hunt_items.js` rule 1), so this walks the pool and needs no mapping.
 *
 * Unlike `Stats._wildlife` there is no per-animal "already credited" mark. A
 * sighting is once per streamed-in animal because seeing the same deer twice is
 * not two encounters; a photograph is once per ITEM and the store enforces
 * that, so the only question here is whether any deer at all is in this frame.
 * Which also means this can stop at the first one it finds.
 */
function mammals(f, wl, hit) {
  const pool = wl?.pool;
  if (!pool) return;
  for (const key of Object.keys(pool)) {
    if (hit.has(key)) continue;
    for (const per of pool[key]) {
      for (const a of per) {
        if (!a.active || !a.mesh) continue;
        const r = meshHeight(a.mesh);
        if (!r) continue;
        if (!visible(f, _p, r)) continue;
        hit.add(key);
        break;
      }
      if (hit.has(key)) break;
    }
  }
}

/** The camp dog — one per camp, and only some camps have one. */
function campDog(f, camp, hit) {
  for (const c of camp?.camps ?? []) {
    const dog = c.dog;
    if (!dog?.mesh || !dog.pos) continue;
    // `dog.mesh.position` is not the animal's place — `CampDog` keeps its
    // position in `pos` and poses the mesh through its rig — so the height is
    // taken from the geometry and re-centred on `pos` by hand. `pos.y` is the
    // GROUND under the dog (`camp_dog.js:405` sets it from `getHeight`), so
    // mid-height is one half-height up: `r`, exactly, rather than the 0.45 of
    // a sphere radius this line carried when `r` meant something else.
    const r = meshHeight(dog.mesh);
    if (!r) continue;
    _p.set(dog.pos.x, dog.pos.y + r, dog.pos.z);
    if (!visible(f, _p, r)) continue;
    hit.add('campDog');
    return;
  }
}

/**
 * The perch-and-fly birds. `spec.key` is the hunt id, again by construction.
 *
 * One InstancedMesh per species, so every slot of a species shares one geometry
 * and one bounding sphere; the per-bird size is `sc`, which IS its wingspan.
 */
function treeBirds(f, tb, hit) {
  const slots = tb?.slots;
  if (!slots) return;
  for (const group of slots) {
    const key = group[0]?.spec?.key;
    if (!key || hit.has(key)) continue;
    const g = group[0].mesh?.geometry;
    if (!g) continue;
    if (!g.boundingSphere) { try { g.computeBoundingSphere(); } catch { continue; } }
    const unit = g.boundingSphere?.radius;
    if (!Number.isFinite(unit)) continue;

    for (const b of group) {
      if (!b.active) continue;
      // `fold` is the instance's own wing state — 0 spread, 1 perched — and it
      // is smoothed, so a bird half way off its branch is half way between the
      // two sizes rather than snapping.
      const fold = Number.isFinite(b.fold) ? Math.min(1, Math.max(0, b.fold)) : 1;
      const r = unit * b.sc * (1 - fold * (1 - FOLD_R));
      _p.set(b.x, b.y, b.z);
      if (!visible(f, _p, r)) continue;
      hit.add(key);
      break;
    }
  }
}

/**
 * Any one waterfall. The item is "a waterfall", not "waterfall number nine" —
 * `Stats` keeps a per-fall set because a logbook wants to say how many you
 * found, and a scavenger hunt has one line.
 *
 * `Stats._waterfalls` already framed the geometry question and the answer is
 * borrowed: the middle of the drop, which is the part visible from below and
 * from the rim both. The radius is half the drop — a fall is tall rather than
 * wide, so its height is what fills the frame.
 */
function waterfalls(f, list, hit) {
  for (let i = 0; i < (list?.length ?? 0); i++) {
    const wf = list[i];
    if (!wf?.top || !wf?.bottom) continue;
    _p.set((wf.top[0] + wf.bottom[0]) * 0.5,
           (wf.top[1] + wf.bottom[1]) * 0.5,
           (wf.top[2] + wf.bottom[2]) * 0.5);
    const r = Math.max((wf.height ?? 0) * 0.5, (wf.width ?? 0) * 0.5, 2);
    if (!share(f, _p, r, FALL_SHARE, FALL_MAX)) continue;
    // Wide enough to be water rather than a scratch — see `FALL_W`. Done here
    // rather than through a second `share` call because `share` would apply
    // `EDGE` a second time with the narrower slack, and a fall filling the left
    // of the frame is exactly the shot that slack exists for. `_p` is still the
    // midpoint `share` just used, so this is one subtract and an atan.
    if ((2 * Math.atan(Math.max((wf.width ?? 0) * 0.5, 0.5) / f.eye.distanceTo(_p))) / f.vfov < FALL_W) continue;
    // The march runs to the LIP, not to the middle of the drop. See the block
    // over `LIP_R`: the midpoint is the one point of a waterfall that is
    // reliably behind something, and asking about it is what made the first
    // version of this detector skip the test altogether.
    _aim.set(wf.top[0], wf.top[1], wf.top[2]);
    if (!clearLine(f.world, f.eye, _aim, LIP_R)) continue;
    hit.add('waterfall');
    return;
  }
}

/**
 * A pitched camp above the line, and in frame.
 *
 * ── what "high" means in this valley ────────────────────────────────────────
 *
 * 100 m, and it is measured rather than picked. `WORLD.maxAltitude` is 340 and
 * `WORLD.valleyFloor` is 14, so a round third-of-the-way number was the obvious
 * guess — and the obvious guess is worthless here, because the question is not
 * how tall the mountains are, it is how high the ground a camp can actually
 * stand on goes.
 *
 * Sampled in the running game with `camp_site.scoreSite` — the same scorer that
 * decides whether the placement ring turns green — at six offsets from every
 * second node of the road network, on two seeds:
 *
 *              p50    p75    p90    p95   above 100 m   max
 *   20262018   20 m   53 m   59 m   63 m     2.2 %     197 m
 *   20261018    5 m   15 m   23 m   27 m     3.3 %     205 m
 *
 * So 100 m is roughly the 97th percentile of the ground people will camp on,
 * and both valleys have campable ground twice that high, so it is a climb
 * rather than a lottery. 120 m was tried first and is wrong: it survives in one
 * of those two seeds (1.7%) and essentially not at all in the other (0.16%, one
 * site in six hundred), which is the difference between a hard line and a line
 * that depends on which valley you were given.
 *
 * Off-road the ceiling is higher still — the same sweep over the whole map
 * found campable ground to 286 m — so a player who drives off the road to do it
 * has more than one answer available.
 *
 * ── the provenance of that table, marked honestly ──────────────────────────
 *
 * The percentile table above has NOT been independently reproduced. A critic
 * re-running the sweep collected only n = 39 usable sites before
 * `scoreSite` refused the rest, which is far too few to confirm or refute a
 * 97th percentile, and the table stands unaudited rather than confirmed. The
 * constant stays because the reasoning behind it is sound and the alternative
 * — moving a number nobody has a better measurement for — is worse. But if it
 * is ever re-derived, re-derive it; do not quote these rows as verified.
 *
 * What HAS been measured is the behaviour, and it has a sharp edge worth
 * stating. A camp pitched at 145.9 m reads unmistakably as a high mountain
 * campsite. Detection around it, by bearing at fixed range: 12 of 12 at 10 m,
 * 8 of 12 at 16 m, 3 of 12 at 24 m, 1 of 12 at 50 m, none by 80 m. That is
 * `clearLine` doing exactly what `AIM` was written for and still losing: a
 * summit is convex, the ground bulges over every chord drawn across it, and a
 * camera far enough back to see the DROP is a camera whose line to the tent
 * passes through the hilltop.
 *
 * That is accepted rather than fixed, and the reason is that the alternative is
 * worse in a way this file will not trade for. The wide portrait — camp on the
 * left, the valley two hundred metres below on the right — is the photograph a
 * player wants, and it mostly will not count. But the only way to make it count
 * is to stop asking whether the camp is visible, and a `highCamp` that credits
 * a tent on the far side of the summit is the cliff photograph again in a
 * different hat. So the shot that counts is the one taken from inside the camp,
 * and the sheet's hint says so in as many words: "Photograph it from the fire".
 */
const HIGH_CAMP = 100;

function highCamp(f, camp, hit) {
  for (const c of camp?.camps ?? []) {
    // Mid-raise is not a camp. `raise` runs 0 → 1 over about a second as the
    // props scale up out of nothing, and a photograph of a half-materialised
    // tent is not the thing being asked for.
    if (c.striking || (c.raise ?? 0) < 0.9) continue;
    if (!(c.y >= HIGH_CAMP)) continue;
    const r = c.radius ?? 5.8;
    _p.set(c.x, c.y + 1.2, c.z);
    if (!visible(f, _p, r, CAMP_SHARE, CAMP_MAX)) continue;
    hit.add('highCamp');
    return;
  }
}

/** GLSL's smoothstep, because half of `ffCount` is a transcription of one. */
function sstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * P(an insect's presence rank is under `t`).
 *
 * The shader gives every insect a rank — `aRand.w = rand() * rand()`, skewed
 * low on purpose so the swarm thins gracefully rather than in one block — and
 * draws it when `want` clears that rank. For a product of two uniforms the
 * distribution function is t·(1 − ln t), which is this.
 */
const ffRank = (t) => (t > 0 ? Math.min(1, t) * (1 - Math.log(Math.min(1, t))) : 0);

/**
 * The share of the population drawing at a spot whose `want` is this.
 *
 * The shader crossfades presence over a 0.20 band of rank, so this averages
 * `ffRank` across the band rather than sampling its middle. Three points where
 * the first version used one, and the difference is not cosmetic: the rank
 * distribution piles up near zero, so at a `want` of 0.05 — a thin swarm that
 * is nonetheless a swarm — the single midpoint sample lands below zero and
 * reports an empty meadow while the shader is drawing one insect in five.
 * Measured against frames, that was this estimator's worst disagreement with
 * the picture.
 */
function ffPresent(want) {
  return (ffRank(want) + ffRank(want - 0.10) + ffRank(want - 0.20)) / 3;
}

/**
 * How many fireflies are inside this frame.
 *
 * A number, not a boolean, because the question the hint asks is a question
 * about how MANY, and every cheaper version of this answers a different one.
 * See the header. What it counts is the population DRAWING in frame — about a
 * fifth of them are alight at any instant, so the flashes a person could
 * actually point at are far fewer, and the header carries that measurement.
 *
 * The integral is over the ground inside the wrap box: at each sample, rebuild
 * the vertex shader's own habitat product from the same four world queries it
 * makes through `uDataTex`, turn it into a population fraction, and add it up
 * where the sample lands in frame. It is the shader's arithmetic on a 72-point
 * grid instead of on three thousand insects.
 *
 * Exported through `_internals` because the threshold below it is the kind of
 * number that has to be re-derived rather than re-guessed.
 */
function ffCount(f, ff) {
  const W = f.world;
  if (typeof W?.getHeight !== 'function' || typeof W?.getMoisture !== 'function'
      || typeof W?.getSlope !== 'function' || typeof W?.getRiver !== 'function'
      || typeof W?.getWaterDepth !== 'function') return 0;   // no bake, no claim
  const u = ff?.uniforms;
  const n = ff?.n | 0;
  const half = u?.uBox?.value?.x;
  if (!(n > 0) || !Number.isFinite(half) || !(half > 0)) return 0;
  const opacity = u.uOpacity?.value ?? 0;
  const density = u.uDensity?.value ?? 0;
  const perM2 = n / (4 * half * half);
  const dr = half * (FF_RINGS[1] - FF_RINGS[0]);

  let n_in = 0;
  for (let ring = 0; ring < FF_RINGS.length; ring++) {
    const rad = FF_RINGS[ring] * half;
    // Area this sample stands for: its annulus, split between the bearings.
    const area = (2 * Math.PI * rad * dr) / FF_BEARINGS;
    for (let i = 0; i < FF_BEARINGS; i++) {
      // Each ring turned a quarter step off the last, so the six rings sample
      // seventy-two distinct radial lines rather than twelve. Without it one
      // hedge line along a bearing costs six samples instead of one.
      const a = ((i + ring * 0.25) / FF_BEARINGS) * Math.PI * 2;
      const x = f.eye.x + Math.sin(a) * rad;
      const z = f.eye.z + Math.cos(a) * rad;
      const g = W.getHeight(x, z);
      if (!Number.isFinite(g)) continue;

      // In frame first — it rejects most of the grid on most photographs, and
      // it is four multiplies against five world queries.
      const wet = W.getWaterDepth(x, z) || 0;
      _p.set(x, g + wet + FF_H, z);
      _view.copy(_p).applyMatrix4(f.view);
      if (!(-_view.z > 0.2)) continue;
      _ndc.copy(_view).applyMatrix4(f.proj);
      // The full frame, not `EDGE`: an insect at the edge of the picture is in
      // the picture. There is no "the subject is cut in half" here, because no
      // one firefly is the subject.
      if (Math.abs(_ndc.x) > 1 || Math.abs(_ndc.y) > 1) continue;
      // And the same line-of-sight test everything else in this file pays for,
      // for the same reason. Without it a camera pressed against a hillside
      // credits the whole meadow on the other side of it: measured, four of
      // thirty-four night poses estimated 60-270 insects in frame and had not
      // one flash anywhere in the picture, and every one of the four was
      // pointed into a slope. 0.4 m of radius is a firefly's own float above
      // the grass, which is what the march should be aimed at.
      if (!clearLine(W, f.eye, _p, 0.4)) continue;

      // `fireflies.js` VERT, term for term. Keeping the names is the point:
      // when somebody retunes the swarm's habitat this is greppable.
      const moist = W.getMoisture(x, z);
      const slope = W.getSlope(x, z);
      const meadow = sstep(0.24, 0.46, moist) * (1 - sstep(0.70, 0.92, moist));
      const bank = sstep(0.06, 0.40, W.getRiver(x, z));
      const open = 1 - sstep(0.34, 0.76, slope);
      const shallow = 1 - sstep(0.12, 0.70, wet);
      const low = 1 - sstep(190, 300, g);
      const local = Math.max(meadow, bank) * open * shallow * low * FF_CLUMP;
      n_in += area * perM2 * ffPresent(density * local * opacity);
    }
  }
  return n_in;
}

/**
 * Fireflies — enough of them, close enough, and pointed at.
 *
 * The two uniform gates are early-outs and nothing more; the item is decided
 * by `ffCount`. See the header for what the old version credited.
 */
function fireflies(f, ff, hit) {
  if (!ff?.points?.visible || !ff.uniforms) return;
  if ((ff.uniforms.uOpacity?.value ?? 0) < FF_NIGHT) return;
  if ((ff.uniforms.uDensity?.value ?? 0) < FF_HAB) return;
  if (ffCount(f, ff) >= FF_MIN) hit.add('fireflies');
}

/**
 * An over-roasted marshmallow — the one on the stick, right now.
 *
 * The shape it reads (`camp_roast_view.js`, `marshmallow_toast.js`):
 *   `Camp.roast`         the RoastView. Null until a fire has been sat at, and
 *                        `.toast` / `.mallow` are built in `enter()` and
 *                        dropped in `leave()` — so "nobody is at a fire" and
 *                        "this build has no roasting" are the same code path,
 *                        and it is the one that runs almost always.
 *   `roast.toast`        the ToastMap — the cook simulation
 *   `roast.mallow`       the marshmallow mesh
 *   `roast.mallowR`      its radius, ~21 mm
 *
 * ── the marshmallow in the picture, not the one in your stomach ─────────────
 *
 * `roast.result` is the grade of the last marshmallow **eaten**, and it is
 * deliberately not read here. `Stats._roasting` is right to watch it — a
 * logbook counts what you did — but an eaten marshmallow is not in the
 * photograph, and crediting one would tick the box for a shot of an empty
 * stick. What is photographed is `roast.toast`'s live state and `roast.mallow`'s
 * live position, which is exactly the pair photo mode goes out of its way to
 * preserve: `RoastView.handOff()` unparents the stick into the world and pauses
 * the cook so the ruined marshmallow is still over the fire when the shutter
 * fires (see the block in `hud_photo.setActive`). Burn one, press F,
 * photograph it. That is the intended path and this is written for it.
 *
 * ── what "over-roasted" means, and why the number is not here ───────────────
 *
 * `ToastMap.grade()` is the authority and it is called rather than
 * reimplemented. Its decision tree (`marshmallow_toast.js:1615`) returns
 * `'burnt'` for any of the three ways to ruin one — alight, more than
 * `RUIN_FRAC` (0.16) of the surface past `RUIN_CHAR` (0.45), or a mean
 * `doneness` over `RUIN_DONE` (0.84) — and those constants are private to that
 * file for a good reason: its own header records 0.88 being tried first and
 * being wrong, and it warns that the last third of the toast ramp is
 * compressed, so char arrives suddenly. A copy of 0.84 in this file would be a
 * second opinion on a number with a history, and it would drift the first time
 * somebody retunes the cook.
 *
 * ── `RoastView.alight` is a SECOND flag, and it is not optional ─────────────
 *
 * There are two "this is on fire" booleans and they are not the same one.
 * `ToastMap.burning` is the map's self-heat latch and it is `grade()`'s first
 * term; `RoastView.alight` is the view's own — the flame the player can see,
 * parented to the marshmallow. They can disagree, and the first end-to-end run
 * of this detector caught them doing it: `__roast.ignite()` at doneness 0.42
 * gave `alight true / burning false / grade 'good' / fires FALSE`. A
 * photograph of a marshmallow with a flame coming off it was being told it was
 * nicely toasted.
 *
 * The fix is the view's own rule rather than a new one. `RoastView._finish`
 * counts a ruined marshmallow as `key === 'burnt' || this.alight`, so that is
 * what is asked here — the same disjunction, in the same order, so this file
 * and the stats sheet can never grade the same marshmallow differently.
 * `toast.burning` stays in front of both as a cheap short-circuit that also
 * survives `grade()` being renamed.
 *
 * ── measured, through the mechanic's own harness ────────────────────────────
 *
 * `window.__roast` (the debug surface `tools/roastshot.mjs` drives) can paint
 * the toast map to an exact doneness, so this was walked up the same ladder the
 * roasting contact sheet is judged on — 21 rungs from raw to charred, with the
 * camera left where the fireside view itself poses it:
 *
 *     k 0.00 - 0.80    grade pale / good / perfect     fires: never  (17 rungs)
 *     k 0.85 - 1.00    grade burnt                     fires: always  (4 rungs)
 *
 * Not one false positive on a golden marshmallow, and the boundary is exactly
 * `grade()`'s, which is the point of calling it rather than copying it.
 *
 * The frame gate has room to spare at the pose the view actually holds: the
 * marshmallow measured 0.083 of the frame height against a 0.03 floor, which
 * agrees with the number `roastshot.mjs` reports for its own money shot
 * ("83.6 px of 900 on dusk-held-clean, 9.3% of frame").
 *
 * And the whole intended path was run end to end — burn one, press F, shoot:
 * `RoastView.handOff()` fires, the stick stands in the world, and
 * `detectSubjects` on the resulting frame returns
 * `['campDog', 'fireflies', 'burntMallow']`. All three were genuinely in it; it
 * was a camp with a dog at 20:24.
 */
function burntMallow(f, roast, hit) {
  const toast = roast?.toast;
  const mallow = roast?.mallow;
  if (!toast || !mallow || mallow.visible === false) return;

  let burnt = toast.burning === true || roast.alight === true;
  if (!burnt && typeof toast.grade === 'function') {
    burnt = toast.grade()?.key === 'burnt';
  }
  if (!burnt) return;

  mallow.getWorldPosition(_p);
  const r = Number.isFinite(roast.mallowR) ? roast.mallowR : 0.021;
  // No occlusion march: it is on the end of a stick in your own hand, and the
  // only thing under it is the fire.
  if (!share(f, _p, r, MALLOW_SHARE, MALLOW_MAX)) return;
  hit.add('burntMallow');
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The item ids present in the frame the camera is looking at RIGHT NOW.
 *
 * @param {object} ctx  the app context (`window.__ctx`)
 * @returns {string[]}  ids from HUNT_ITEMS, in page order. Never null, never
 *                      throws.
 */
export function detectSubjects(ctx) {
  const hit = new Set();
  try {
    const f = frameOf(ctx);
    if (!f) return [];
    const sys = ctx.systems ?? {};
    const wl = sys.wildlife;

    // Each family is guarded on its own. One broken peer costs one line of the
    // sheet; without this it would cost the whole photograph's detection, and
    // the player would never know which.
    const run = (fn, ...args) => { try { fn(f, ...args, hit); } catch (e) { warn(fn.name, e); } };

    if (wl?.enabled !== false) {
      run(mammals, wl);
      run(treeBirds, wl?.treeBirds);
      run(fireflies, wl?.fireflies);
    }
    run(campDog, sys.camp);
    run(highCamp, sys.camp);
    run(burntMallow, sys.camp?.roast);
    run(waterfalls, ctx.world?.waterfalls);
  } catch (e) {
    warn('detectSubjects', e);
  }
  // Page order, always — the journal crosses lines off top to bottom and a
  // detection order that depended on which system answered first would make the
  // ceremony jump around the page.
  return HUNT_IDS.filter((id) => hit.has(id));
}

// One warning per detector per session. A detector that is broken is broken
// every time the shutter fires, and a photograph is something a player takes
// hundreds of; a console filling with the same line is how the useful one gets
// missed.
let _warned = null;
function warn(where, e) {
  _warned ??= new Set();
  if (_warned.has(where)) return;
  _warned.add(where);
  console.warn('[hunt] detector failed:', where, e);
}

/**
 * The gates, for a harness. Exported so a test can ask "why did this not
 * count" without reimplementing the arithmetic — `tools/` scripts and the
 * console are the only callers.
 */
export const _internals = { share, clearLine, visible, frameOf, meshHeight,
  ffCount, MIN_SHARE, EDGE, HIGH_CAMP, FOLD_R, FALL_SHARE, FALL_W, CAMP_SHARE,
  FF_MIN, LIP_R };
