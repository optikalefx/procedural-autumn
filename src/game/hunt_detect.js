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
//     deer      counts out to  ~47 m   (Stats' sighting gate: 20 m — looser)
//     bear                     ~52 m
//     fox                      ~23 m
//     raccoon                  ~18 m
//     rabbit                   ~13 m
//     squirrel                  ~9 m
//     perched eagle            ~33 m   (Stats' bird gate: 130 m — much tighter)
//     eagle in flight          ~66 m
//     perched heron            ~42 m
//
//  A four-pixel deer in the corner is rejected by arithmetic rather than by a
//  distance somebody guessed, and the numbers above fall out of the geometry —
//  they are not typed in anywhere. Three of them were then measured in the
//  running valley by walking the camera out from a real animal until the
//  detector let go: deer 47 m (predicted 47.1), rabbit 13 m (13.3), eagle 33 m
//  (33.1), heron 42 m (42.8).
//
//  It has a property a distance rule cannot have: **zooming in works.** Frame
//  share is computed against the live `camera.fov`, and photo mode's wheel is a
//  zoom. Framing a distant deer through a long lens genuinely makes it count,
//  because it genuinely makes it a photograph of a deer. When the lens models
//  (`src/photo/lens_models.js`) land, a 400 mm at the same spot is worth ~5x
//  the reach of a 70 mm with no change to this file.
//
//  ── how MIN_SHARE was set: a constraint, then a photograph ─────────────────
//
//  It is squeezed from two sides and neither side is taste.
//
//  **From above** by the birds. `tree_birds.js:TREE_BIRD_SPECIES[].startle` is
//  the distance at which a perched bird flushes, and a threshold that demands
//  you crowd a bird closer than that is a threshold no player can ever satisfy
//  — the shutter fires at an empty branch. Checked against the SMALLEST
//  individual of each species, which is the case that binds:
//
//     species     startle   counts from      margin
//     eagle         26 m      31 m            +5 m
//     heron         30 m      40 m           +10 m
//     flamingo      14 m      25 m           +11 m
//     owl           20 m      18 m            -2 m   <- the one that does not clear
//
//  **From below** by looking at a frame. The first version of this file shipped
//  0.065, which is where the owl clears comfortably (20.4 m) — and then a real
//  capture of a real deer at the range that allows, 57 m, was pulled out of the
//  running game and looked at. It is a small dark shape standing at a treeline:
//  identifiable as an animal, about 35 px of subject height in a 1080 frame,
//  and not a photograph OF a deer. That frame is why the number moved.
//
//  0.085 is the compromise, and the cost is written above: the owl has to be
//  photographed from about 18 m, two metres inside the radius it leaves at.
//  That is survivable rather than lucky, because the owl is the one bird that
//  carries `startleDelay: 3` — it holds for three seconds of being crowded
//  before it goes, and its own table says why ("an owl found at night is a
//  payoff, and a payoff that leaves on the frame the headlights reach it is not
//  one"). Three seconds is a shutter press. It is still the tightest line on
//  the sheet and the first thing to revisit if players report it.
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
//  ── false positives, which are the failure mode that would ruin this ────────
//
//  800 camera poses at random points across the whole 3072 m valley, at midday
//  with no camps pitched, each looking in a random direction: **zero** animals,
//  zero camps, zero fireflies. The only id that came back was `waterfall`, on
//  52 of them (6.5%) — which is not a false positive, it is what a 320 m reach
//  over twenty waterfalls looks like when you point a camera at random.
//
//  ── what it costs ───────────────────────────────────────────────────────────
//
//  11.5 microseconds per call, measured over 200 calls in a booted game. It
//  runs once per shutter press, in the same task as a `toDataURL` of a
//  native-resolution frame that takes tens of milliseconds. It is free.
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
 * See the header for how 0.065 was arrived at — it is a consequence of the
 * birds' startle radii, not a number chosen for how it looks.
 */
const MIN_SHARE = 0.085;

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
// so "is a firefly in frame" is really two questions: is the swarm drawing at
// all, and is the photograph pointed at ground close enough to have some in it.
//
// The system's own `points.visible` gate is `amount > 0.004 && _hab > 0.01`,
// which is the threshold for "technically emitting" — a handful of insects an
// hour before you could see one in a picture. These are the thresholds for
// "there are fireflies in this photograph".
const FF_NIGHT = 0.35;    // uOpacity: the dusk ramp. 0.35 lands around 20:00
const FF_HAB = 0.25;      // uDensity: damped habitat at the camera
// Ground samples inside the wrap box, and how many must land in frame. Three
// rather than one, so a sliver of grass in a corner of a shot of the sky is not
// a photograph of fireflies.
const FF_RINGS = [6, 12, 19, 27];
const FF_BEARINGS = 8;
const FF_HITS = 3;

// ── scratch ──────────────────────────────────────────────────────────────────
// Module-level and reused. This runs once per shutter press, but it runs in the
// same task as a 2.5 MB `toDataURL` and there is no reason to hand the GC
// anything at all.
const _p = new THREE.Vector3();
const _view = new THREE.Vector3();
const _ndc = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _fwd = new THREE.Vector3();

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
    view: _inv.clone(),
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
    // No occlusion march. The line to the middle of a drop runs down a gorge
    // whose walls stand well above it, and `getHeight` at the fall's own
    // footprint returns the CLIFF rather than the water — the terrain test
    // rejects almost every genuine view of one. The thing a fall is on the far
    // side of is a ridge, and a ridge tall enough to hide a 40 m fall also
    // takes its own share of the frame away; the size gate is doing that work.
    if (!share(f, _p, r, FALL_SHARE, FALL_MAX)) continue;
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

/**
 * Fireflies. See the FF_ block above for why this is a habitat query and a
 * handful of ground samples rather than a list of objects.
 */
function fireflies(f, ff, hit) {
  const pts = ff?.points;
  const u = ff?.uniforms;
  if (!pts?.visible || !u) return;
  if ((u.uOpacity?.value ?? 0) < FF_NIGHT) return;
  if ((u.uDensity?.value ?? 0) < FF_HAB) return;
  const world = f.world;
  if (typeof world?.getHeight !== 'function') return;

  let hits = 0;
  for (let ring = 0; ring < FF_RINGS.length; ring++) {
    const rad = FF_RINGS[ring];
    for (let i = 0; i < FF_BEARINGS; i++) {
      // Each ring's bearings are rotated by a quarter step from the last, so
      // the four rings sample thirty-two distinct radial lines rather than
      // eight. Without it a single fence post or tree trunk lined up with one
      // bearing costs four samples instead of one.
      const a = ((i + ring * 0.25) / FF_BEARINGS) * Math.PI * 2;
      const x = f.eye.x + Math.sin(a) * rad;
      const z = f.eye.z + Math.cos(a) * rad;
      const g = world.getHeight(x, z);
      if (!Number.isFinite(g)) continue;
      // Where a firefly sits: a fraction of a metre above the grass, which is
      // what `fireflies.js` puts them at in the vertex shader.
      _p.set(x, g + 0.45, z);
      _view.copy(_p).applyMatrix4(f.view);
      if (!(-_view.z > 0.2)) continue;
      _ndc.copy(_view).applyMatrix4(f.proj);
      if (Math.abs(_ndc.x) > 0.94 || Math.abs(_ndc.y) > 0.94) continue;
      if (++hits >= FF_HITS) { hit.add('fireflies'); return; }
    }
  }
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
  MIN_SHARE, EDGE, HIGH_CAMP, FOLD_R, FALL_SHARE, CAMP_SHARE };
