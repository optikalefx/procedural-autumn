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
//  subject's bounding sphere must subtend at least `MIN_SHARE` of the frame's
//  HEIGHT. That single rule replaces the three hand-tuned distances Stats needs
//  (20 m / 130 m / 420 m), and it lands in a different place in each direction,
//  which is exactly what it should do:
//
//  Everything below was measured in the running valley at fov 50, by planting
//  one animal, hiding the rest of its site, finding a bearing with a clear line
//  and then binary-searching the stand-off until the detector let go. Predicted
//  is the arithmetic; cut is what the game did.
//
//     species     sphere r   predicted   cut     (Stats' sighting gate)
//     bear          2.01 m     29.6 m    29.5 m    20 m — this is TIGHTER
//     deer          1.76       25.9      25.9      20
//     fox           0.89       13.1      13.1      20
//     raccoon       0.71       10.4      10.4      20
//     rabbit        0.49        7.3       7.1      20
//     squirrel      0.36        5.3       5.0      20
//     heron                              23.2      130 m — much tighter
//     eagle, perched                     17.9      130
//     flamingo                           15.5      130
//     owl, perched                       10.4      130
//
//  A four-pixel deer in the corner is rejected by arithmetic rather than by a
//  distance somebody guessed. At the deer's cut the animal measures 64 x 85 px
//  in a 1080 frame — a body, four legs, a neck and a tail.
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
//  **What a photograph needs, measured by looking at one.** At 0.085 the deer's
//  cut is 46.9 m and the animal measures 35 x 46 px in a 1920x1080 frame: a
//  dark brown lozenge with no legs, no tail and no readable head, in a frame
//  that also holds half a dozen brown bushes of the same size and colour. It is
//  not a landscape with a deer in it; it is a landscape in which you cannot
//  find the deer. This file's own header had already rejected that exact frame
//  once, at 0.065 and 57 m, in the same words — and then set a threshold that
//  produced it again four metres closer.
//
//  0.155 is where the same deer, at 25.9 m, is a deer: 64 x 85 px, a body with
//  four legs under it and a head at the end of a neck. The number is not round
//  and it is not meant to be — it is the frame share of the photograph that was
//  judged acceptable, and it comes from that photograph and nothing else.
//
//  **What it costs, per subject, is in the table above** — every cut was
//  re-measured rather than scaled, because the birds do not scale with the
//  mammals. Two consequences are worth stating out loud:
//
//   · The squirrel counts from 5.0 m. That is close, and it is reachable: the
//     free camera flies, the world is stopped, and the squirrel is not going
//     anywhere while you compose. "The smallest animal here" is the hint and
//     five metres is what the hint means.
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
//  fly the free camera up to the canopy (it counts from 10.4 m at perch
//  height), or fit the long lens. Measured at 400 mm from ground level, share
//  0.68 at 40 m and still 0.198 at 140 m — the owl is comfortably in reach from
//  the road, through the glass that is in the bag for exactly this.
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
//  bed, counts from 23.2 m; flamingo 1.9 m, counts from 15.5 m.
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
//  86 blocked, **5** still credited, and those five are not errors — they are
//  poses where the lip clears the ridge and the plunge pool does not, which is
//  a real if partial view of a real waterfall.
//
//  And the ordinary case did not move, which is what says the test is aimed
//  right rather than merely strict: from 120 road-level poses looking where the
//  road looks, 25 credited `waterfall` before the change and **25 after**. The
//  frames it was already getting were genuine; only the mountain-road case
//  changed.
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
//  over the greenish-yellow core colour (`shots2/ffcal/`, `dots.mjs`). At
//  FF_MIN = 110: ten poses credited, nine of the ten had five or more
//  countable flashes and the ten averaged 12.8; the best frame in the whole set
//  — a wooded meadow with 25 flashes in it — is credited, and the rejects top
//  out at 6.5. Roughly a fifth of the swarm is alight at any instant and much
//  of the rest is behind grass, which is why 110 insects reads as about a dozen
//  lights: the estimate is a population, the flashes are what the picture
//  shows, and the two are related by that measurement rather than by a guess.
//
//  The per-sample line-of-sight test came out of the same calibration. Without
//  it, four of the thirty-four poses estimated between 60 and 270 insects and
//  had not one flash anywhere in the frame — every one of them a camera pressed
//  against a slope, crediting the meadow on the other side of the hill.
//
//  Where it lands: 18 of 40 (45%) of poses framed deliberately at the ground
//  the way the old sweep framed them, against 83% before; and **42 of 200
//  (21%) of random night photographs aimed anywhere** — which is the number
//  that matters, because that is the accidental tick. The swarm really is a
//  valley-floor phenomenon and an honest rule cannot make it rarer than it is;
//  what changed is that a dark hillside, a dry ridge, an alpine shoulder or a
//  frame of night sky no longer counts as a photograph of fireflies.
//
//  ── false positives, which are the failure mode that would ruin this ────────
//
//  800 camera poses at random points across the whole 3072 m valley, at midday
//  with no camps pitched, each looking in a random direction: **zero** animals,
//  zero camps, zero fireflies. The only id that came back was `waterfall`, on
//  44 of them (5.5%) — which is not a false positive, it is what a 320 m reach
//  over twenty-eight waterfalls looks like when you point a camera at random.
//  (52 before the lip test; the eight that went away were the ones behind a
//  ridge.)
//
//  ── what it costs ───────────────────────────────────────────────────────────
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
 * How much of the frame's HEIGHT the subject's bounding sphere must subtend.
 *
 * See the header for how this was arrived at. The short version: it is the
 * size at which a capture of a real deer in the real valley stops being a
 * brown lozenge and starts having legs, and nothing else in the game pushes
 * back on it — not the birds, not the vehicle. It was 0.085 and 0.085 was a
 * threshold defended by an argument that turned out not to be true.
 */
const MIN_SHARE = 0.155;

// The two set-pieces are not animals and do not answer to the birds' rule.
// A waterfall is enormous, so the animal share would count one at 700 m; a camp
// is something you are standing next to.
const FALL_SHARE = 0.12;
const CAMP_SHARE = 0.12;

// A marshmallow is 21 mm across, held at arm's length, in a view that frames it
// for you. The share rule that keeps a deer honest at 60 m has nothing useful
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
                          // photographed
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
const _fwd = new THREE.Vector3();
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
 * Is a sphere of `radius` at `pos` big enough, and far enough inside the frame,
 * to be the subject of this photograph?
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
 * A mesh's world-space bounding sphere, as (centre in `_p`, radius returned).
 *
 * The animals are skinned and animated in a rig, so the geometry's own sphere
 * is the REST pose — which is the right thing to use anyway: a deer mid-stride
 * and a deer standing still are the same size of deer, and a per-frame sphere
 * would make the gate flicker with the gait.
 *
 * Only `.y` of the local centre is carried across, because these objects rotate
 * about Y and the horizontal part of the offset would need the full transform
 * for an answer that moves the centre by half a metre inside a sphere metres
 * across.
 */
function meshSphere(mesh) {
  const g = mesh?.geometry;
  if (!g) return 0;
  if (!g.boundingSphere) { try { g.computeBoundingSphere(); } catch { return 0; } }
  const bs = g.boundingSphere;
  if (!bs || !Number.isFinite(bs.radius)) return 0;
  const s = Math.abs(mesh.scale?.x) || 1;
  _p.copy(mesh.position);
  _p.y += bs.center.y * s;
  return bs.radius * s;
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
        const r = meshSphere(a.mesh);
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
    // position in `pos` and poses the mesh through its rig — so the sphere is
    // taken from the geometry and re-centred on `pos` by hand.
    const r = meshSphere(dog.mesh);
    if (!r) continue;
    _p.set(dog.pos.x, dog.pos.y + r * 0.45, dog.pos.z);
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
 * The share of the population present at a spot whose `want` is this.
 *
 * The shader gives every insect a rank (`aRand.w = rand() * rand()`, skewed
 * low on purpose so the swarm thins gracefully) and draws it when `want`
 * clears that rank, crossfading over a 0.20 band. P(rank < t) for a product of
 * two uniforms is t·(1 − ln t); the crossfade is taken as a 0.10 offset on
 * `want`, which is where the middle of the band sits.
 */
function ffPresent(want) {
  // Three points across the crossfade band rather than one at its middle. One
  // point is what the first version did and it is wrong exactly where it
  // matters: the rank distribution piles up near zero, so at a `want` of 0.05 —
  // a thin swarm that is nonetheless a swarm — a single sample at `want - 0.1`
  // lands below zero and reports an empty meadow, while the shader is drawing
  // one insect in five. Measured against frames, that was the estimator's worst
  // disagreement with the picture.
  return (ffRank(want) + ffRank(want - 0.10) + ffRank(want - 0.20)) / 3;
}
const ffRank = (t) => (t > 0 ? Math.min(1, t) * (1 - Math.log(Math.min(1, t))) : 0);

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
export const _internals = { share, clearLine, visible, frameOf, meshSphere,
  ffCount, MIN_SHARE, EDGE, HIGH_CAMP, FOLD_R, FALL_SHARE, CAMP_SHARE,
  FF_MIN, LIP_R };
