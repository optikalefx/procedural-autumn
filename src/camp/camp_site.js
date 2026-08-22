// ─────────────────────────────────────────────────────────────────────────────
//  camp_site — where the camp may go, and where each thing in it stands.
//
//  Two jobs, kept apart on purpose:
//
//    · `groundRay` / `scoreSite`  — can a camp exist here at all?
//    · `layoutCamp`               — given that it can, where does everything go?
//
//  The second one is the whole reason this feature either reads as calm or
//  reads as "objects were placed by a computer", so it is worth being explicit
//  about what it is doing. A camp is not a random scatter and it is not a
//  circle of evenly spaced furniture. It is a set of things arranged around a
//  fire by people who all wanted to face the fire and none of whom wanted to
//  sit in the smoke, carry the cooler far, or pitch the tent where sparks land.
//  Those four preferences produce the arrangement; randomness only decides how
//  far each thing drifts from where the preference put it.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, mulberry32 } from '../core/MathUtils.js';
import { FIRE_RING } from './camp_fire.js';

const TAU = Math.PI * 2;
// The golden angle. Successive multiples of it never repeat and never clump,
// which is why it is the standard way to place seeds on a sunflower head and
// exactly what is wanted for "spread these around the fire but not evenly".
const GOLDEN = Math.PI * (3 - Math.sqrt(5));   // 2.39996…

// ── how far from the camper the player may put a camp ────────────────────────
//
// Near enough that the camper is in the same frame as the fire — the shot the
// whole feature exists to produce — and far enough that the camper is not
// standing in the middle of the site.
//
// 8 m is arithmetic, not taste: the clearing's radius is 6.4 m and the camper
// is 4.7 m long, so at the first pass's 6 m the camper sat two and a half
// metres INSIDE the dirt, with its front axle on ground the camp had
// supposedly just cleared. At 8 m its nose just touches the fringe, which
// reads as parked at the edge of the site — which is what you actually do.
export const SITE_MIN = 8.0;
export const SITE_MAX = 18.0;

// The clearing's radius, and therefore the size of the camp.
//
// It has been three numbers and each move was forced by a capture.
//
// 5.2 with the tent at 0.86 R put the tent at 4.5 m, inside the clearing's own
// feathered edge where a third of the grass still stands — the first capture
// came back with the tent pitched in knee-deep meadow. 6.4 with the props
// pulled inside 0.72 R fixed that and overshot: eleven metres of bare ground
// for furniture that spans five, which reads as a gravel pit with a camp in
// the middle of it rather than as a patch of ground somebody cleared.
//
// 5.8 with a tighter 1.4 m feather is where the arithmetic actually lands. The
// tent sits at 0.62 R = 3.6 m and is 2.3 m long, so its far corner is at 4.8 m
// against full cover to 4.4 m — it stands on bare ground with its guy lines in
// the fringe, which is what a real pitch looks like.
export const CAMP_RADIUS = 5.8;

// The compact camp: a fire, a tent, one chair, on ground that will not take a
// full one.
//
// The player, looking at a "no camp here — too steep" prompt on an ordinary
// grassy ridge: "I should be able to camp on a less uneven slope with
// half-sized camping area. It should have just the tent and fire, and maybe 1
// chair." They are right, and the rule that refused them is not wrong so much
// as it only knew one answer. Slope and relief are measured ACROSS THE DISC,
// so most of what made that ridge fail was simply that the disc was twelve
// metres wide — the same ground under a smaller footprint is fine, and a
// backpacker's pitch on a hillside is a better picture than a refusal.
//
// 3.4 m, and it started at 4.2. The player, on seeing the first one pitched:
// "you can go smaller on the compact camp site. It's probably a little too big
// still for hillside camping." They were right — the capture shows an 8.4 m
// disc with about 5 m of camp on it and a bare crescent of dirt doing nothing.
//
// 3.4 m is a third of the full camp's area and the floor set by its own
// contents rather than by taste. The fire ring is 0.62 m, the tent is 2.3 m
// long, and the two must not touch: the tent's centre can come no closer than
// about 2.0 m, which puts its far corner at 3.15 m. The clearing's full cover
// reaches 2.7 m, so the tent's BACK corner sits in the fringe with grass
// against it — which is what a tent pitched on a hillside actually looks like,
// and is the only part of the arithmetic that is a judgement rather than a
// constraint. Going smaller starts putting the door in the grass instead.
export const CAMP_RADIUS_SMALL = 3.4;

// ── how close the tent may come to the fire ──────────────────────────────────
//
// The player: *"make sure the fire cannot be too close to the tent when we make
// camp."* They were looking at a compact camp, and they were right — in 30 of
// 32 pitched compact camps the tent's geometry was INSIDE the stone ring, the
// nearest fabric sitting 0.23 m from the middle of a fire whose cobbles are at
// 0.58. See `tools/_scratch/tentreach.mjs`, which measures the built tent
// rather than the number the layout thought it was placing.
//
// Two separate faults put it there, and both are fixed below rather than
// papered over with a bigger nominal radius:
//
//   · The fire was never in the layout's own separation test. `placed` is
//     seeded from `opts.obstacles` alone, so the one object every prop is
//     arranged around was the one object nothing was tested against. The
//     nominal radius was the only thing holding the tent out of the flames,
//     and a nominal radius is a suggestion — `tryPlace` moves off it freely.
//
//   · The tent's `insist` sweep started INSIDE its nominal radius and biased
//     inward (`0.80 + …`, so try 0 was always 0.80x). Try 0 almost always
//     succeeds, because nothing else is placed yet, so *every* camp took the
//     0.80. The full camp's tent sat at 2.88 m and not the 3.6 m this file's
//     own comments describe; the compact camp's at 1.63 m and not 2.04.
//
// The number itself. The tent's half-extent was assumed to be 1.15 m — half of
// a 2.3 m tent — and it is not: measured over both styles it reaches 1.40 m
// from its centre, because the guy lines and the vestibule reach past the fly.
// So the floor is the ring, plus that reach, plus a gap you can see:
//
//     0.58 (stone) + 1.40 (tent reach) + 0.22 (gap) = 2.20 m
//
// The gap is the only part of that which is judgement, and it is bought from
// the far end of the compact camp rather than found lying around. The tent's
// fly — cords and pegs excluded, since nobody minds a guy line in the grass —
// reaches 1.26 m out the back, so at a 2.20 m centre the back hem lands at
// 3.46 m against a 3.40 m rim and full cover that ended at 2.72 m.
//
// So this does NOT close with room to spare, and the first draft of this note
// claimed it did. Measured over 32 compact pitches: every one of them has its
// back hem in the clearing's fringe, and six of the 32 carry it 1-6 cm past
// the rim into standing grass. That is the cost, it is paid on the compact
// camp only, and it is worth paying — `CAMP_RADIUS_SMALL` already describes a
// back corner in the fringe as the correct picture for a hillside pitch,
// whereas fabric inside the stone ring is not a picture of anything.
//
// The gap could be 0.16 instead, which keeps every hem inside the rim. It is
// not, because 0.16 m is close enough to the cobbles that the clearance stops
// reading as deliberate, and the thing being protected here is the one the
// player actually asked for.
//
// The full camp never reaches this bound: its tent sits at 3.60 m, a metre and
// a half outside the floor. This number is set entirely by the compact camp.
export const TENT_FIRE_CLEAR = FIRE_RING + 1.40 + 0.22;

/**
 * March the mouse ray against the heightfield.
 *
 * Deliberately not a scene raycast. `Raycaster.intersectObjects(scene, true)`
 * over this world walks streamed terrain LOD tiles, ~500 k grass blades in
 * three rings, instanced cover and the tree BVH — it is milliseconds, every
 * frame, to answer a question the heightfield answers in microseconds. It is
 * also *wrong* for this job: the first thing it would hit is a grass blade or a
 * shrub, so the reticle would jitter between the ground and whatever foliage
 * happened to be in front of it.
 *
 * Linear march to a sign change, then bisect. The march step grows with
 * distance because precision only matters near the hit.
 */
export function groundRay(world, origin, dir, maxDist = 260) {
  let t = 1.0;
  let prevT = 0, prevD = origin.y - world.getHeight(origin.x, origin.z);
  // A ray pointing up out of the valley never hits; bail rather than marching
  // 260 m of sky.
  if (dir.y > 0 && prevD > 0) {
    const rise = dir.y * maxDist;
    if (prevD + rise > 0 && dir.y > 0.35) return null;
  }
  while (t < maxDist) {
    const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
    const d = y - world.getHeight(x, z);
    if (d <= 0 && prevD > 0) {
      // Bisect the bracket. Eight halvings of a 6 m step is 23 mm, which is
      // under the terrain's own vertex spacing and far under what the eye can
      // see in a reticle.
      let a = prevT, b = t;
      for (let i = 0; i < 8; i++) {
        const m = (a + b) * 0.5;
        const mx = origin.x + dir.x * m, my = origin.y + dir.y * m, mz = origin.z + dir.z * m;
        if (my - world.getHeight(mx, mz) <= 0) b = m; else a = m;
      }
      const hx = origin.x + dir.x * b, hz = origin.z + dir.z * b;
      return { x: hx, z: hz, y: world.getHeight(hx, hz), dist: b };
    }
    prevT = t; prevD = d;
    t += clamp(0.6 + t * 0.045, 0.6, 6.0);
  }
  return null;
}

// ── what counts as water for a REFUSAL, and why it is not getWaterDepth ──────
//
// The player, with the reticle on open grass and the river three tree-lengths
// away: *"I was trying to camp near this river, but it says can't spawn IN
// WATER. But i'm clearly not in water with my selection."* They were right.
//
// `world.getWaterDepth` is the correct answer for physics and for the camera.
// It takes the HIGHER of two derivations of one field — the baked 2 m water
// grid, point sampled at the NEAREST texel, and the drawn mesh's own field —
// because for those consumers under-reporting is the only dangerous direction:
// an animal spawned in a lake, or a chase boom with no floor under it, is worse
// than a spurious wetting. See the long note on `getWaterHeight`.
//
// For a refusal it is wrong in exactly the opposite direction. A refusal is a
// claim about the picture, so it has to be about water the player can SEE. The
// baked grid has speckle in it — isolated single texels carrying a valid water
// level with no river anywhere near them — and a nearest-texel sample smears
// each one across its own 2 x 2 m cell. The mesh culls them, so nothing is
// drawn there and nothing else in the frame says water. But this test samples
// 33 points over an 11.6 m disc and refuses on ANY of them, so one stray texel
// within 5.8 m of the centre refuses the camp.
//
// MEASURED through `bestSite` itself, over the 256 269 candidate centres lying
// within 90 m of drawn water, scored against an exact distance transform of the
// mesh's own `drawn` grid:
//
//   refused "in the water" with the water further than   worst refusal
//   15 m away                                            (centre -> drawn water)
//   ────────────────────────────────────────────────     ─────────────────────
//   shipped   114                                        61.1 m at (-440, 920)
//   this fix    0                                        11.3 m at ( 248, 1364)
//   main        16                                       40.0 m at (-1344, -1400)
//
// 11.3 m is the floor of the metric, not a residue: the ring reaches 5.8 m and
// the mesh's cells are 4 m, so a ring edge genuinely touching drawn water scores
// up to 5.8 + 5.66 m. Total refusals move 9 705 -> 9 416 (-3.0%); everything
// lost is past 10 m.
//
// The whole cause is 122 texels. Of the 527 984 texels the baked grid calls wet,
// 122 (0.023%) have no drawn water on them at all — 21 of those against the map
// border, the rest in pinhole clumps of two to eight. Note the `main` column:
// this is NOT a regression from the hydro round. It is a pre-existing hole that
// the new bake widened.
//
// Two things were tested and are NOT the cause, recorded so the next person
// does not re-test them:
//
//   · **The micro-detail taper.** A/B in one build, monkey-patching
//     `microDetail` back to main's un-tapered form: the tail is bit-identical —
//     114 centres past 15 m, same worst point, same 61.1 m. It moves 23 samples
//     in the whole valley and all 23 are within 5 m of the water. It is a real
//     term in this predicate — it faded the ground at (-437.8, 914.6) by exactly
//     enough to leave 0.025 m of "depth" under a 0.02 m threshold — but it is
//     the last straw on a stray texel, not the texel.
//   · **The hydro field.** `sdf > 0` is the single source of truth for
//     everything that DRAWS an edge, and it is fooled by the same speckle,
//     because it is seeded from the same cleaned mask: at (-437.8, 914.6) it
//     reports sdf -0.63 m and wet 0.45 with the drawn river 61 m away. Swapping
//     the predicate to it still leaves an 11-centre tail out to 58.2 m, and —
//     being a 4 m field with a 18 m graded band — it lets 72% more centres that
//     are standing in drawn water through as dry. It answers "where should the
//     edge be drawn", not "what is under this square metre".
//
// So ask the surface that is actually drawn. `levelAt` evaluates the same
// triangles the renderer submits, from the same numbers, so a refusal now means
// water is on the screen. It is not merely "the grid minus the speckle": the
// mesh dilates out to a depth of -1.4 m (SURF_ISO), so it also answers over the
// dry apron beyond the waterline, where its level is below the ground and this
// returns 0 — which is exactly right.
//
// It gives up almost nothing on the other side, which is the side that matters:
// a camp pitched IN a river would be far worse than a spurious refusal. Audited
// with a 73-point ring — four radii instead of three, 24 samples each instead of
// 16 — over the ~70 800 centres each predicate accepts, the number that turn out
// to have drawn water somewhere under them goes 208 -> 210. Those two, and the
// 208 already there, are `scoreSite`'s 33-sample ring being coarse at a
// scalloped bank, and that is unchanged by this and worth its own look.
//
// Reaching into `world._water` is a layering smell and is deliberate rather
// than lazy: `getWaterDepth` is the only public door and it is the one that has
// the max in it. A `getDrawnWaterDepth` on WorldData would be the better shape,
// but WorldData is under another author's hand this round.
function seenWaterDepth(world, x, z) {
  const f = world._water;
  // The soundlab rig and the bake tools stand up a world with no water mesh at
  // all. Fall back to the public query rather than calling the valley dry.
  if (!f || typeof f.levelAt !== 'function') return world.getWaterDepth(x, z);
  const lv = f.levelAt(x, z);
  if (lv === null) return 0;
  const d = lv - world.getHeight(x, z);
  return d > 0 ? d : 0;
}

/**
 * Is this a place a camp could be?
 *
 * Returns `{ ok, reason, score, x, z, y }`. `score` is 0..1 and is only
 * meaningful when ok — it drives how confident the reticle looks, so a player
 * aiming at a merely-acceptable spot gets a visibly less settled ring than one
 * aiming at a good one, without ever being told a number.
 *
 * The footprint samples are a ring plus the centre rather than a disc: the
 * failure this is guarding against is a lip, a boulder or a waterline crossing
 * the site, and all three are found at the rim. Sixteen ring samples at two
 * radii is 33 heightfield lookups, which is nothing, and it catches a 1.5 m
 * hummock that a 4-sample cross walks straight over.
 */
export function scoreSite(world, x, z, opts = {}) {
  const R = opts.radius ?? CAMP_RADIUS;
  const out = { ok: false, reason: '', score: 0, x, z, y: world.getHeight(x, z) };

  if (!Number.isFinite(x) || !Number.isFinite(z)) { out.reason = 'nowhere'; return out; }
  if (!world.isInBounds(x, z)) { out.reason = 'out of bounds'; return out; }

  // Sample the disc, and keep the offsets: the statistic that matters here is
  // not the raw spread of heights, it is the spread AFTER the ground's own
  // tilt has been taken out. See the note below.
  const sxs = [], szs = [], hs = [];
  let slopeSum = 0, slopeMax = 0, wet = 0, n = 0;
  for (const rr of [0, R * 0.55, R]) {
    const count = rr === 0 ? 1 : 16;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU;
      const dx = Math.cos(a) * rr, dz = Math.sin(a) * rr;
      const h = world.getHeight(x + dx, z + dz);
      const sl = world.getSlope(x + dx, z + dz);
      if (!Number.isFinite(h)) { out.reason = 'nowhere'; return out; }
      sxs.push(dx); szs.push(dz); hs.push(h);
      slopeSum += sl; if (sl > slopeMax) slopeMax = sl;
      if (seenWaterDepth(world, x + dx, z + dz) > 0.02) wet++;
      n++;
    }
  }
  const slopeMean = slopeSum / n;

  // ── the plane, and what is left over ──────────────────────────────────────
  //
  // Fit h = a*dx + b*dz + c by least squares, then measure the peak-to-peak of
  // the residual. Because the samples are concentric rings the cross terms
  // vanish and this is three sums, not a matrix solve.
  //
  // THIS IS THE FIX FOR "too uneven" ON A PERFECTLY SMOOTH HILLSIDE.
  //
  // The previous version tested raw peak-to-peak height across the disc, which
  // on any slope is dominated by the tilt: a dead-smooth 20-degree hillside has
  // 3.4 m of relief across 8.4 m and nothing uneven about it whatsoever. The
  // player was told "no camp here — too uneven" while looking at a grassy
  // ridge with no bumps on it at all, and they were right to disbelieve it.
  //
  // The two questions are genuinely different and now have genuinely different
  // tests. `grade` is how tilted the ground is — you cannot sleep on a steep
  // slope, and no amount of levelling fixes it. `bumpiness` is what is left
  // after the tilt: a boulder-sized hump, a lip, a gully crossing the site —
  // and that is what actually stops a tent going down, because it is what you
  // cannot level a pad against.
  let Sxx = 0, Szz = 0, Sxh = 0, Szh = 0, Sh = 0;
  for (let i = 0; i < n; i++) {
    Sxx += sxs[i] * sxs[i]; Szz += szs[i] * szs[i];
    Sxh += sxs[i] * hs[i];  Szh += szs[i] * hs[i];
    Sh += hs[i];
  }
  const pa = Sxx > 1e-6 ? Sxh / Sxx : 0;
  const pb = Szz > 1e-6 ? Szh / Szz : 0;
  const pc = Sh / n;
  let rLo = Infinity, rHi = -Infinity, hLo = Infinity, hHi = -Infinity;
  for (let i = 0; i < n; i++) {
    const r = hs[i] - (pa * sxs[i] + pb * szs[i] + pc);
    if (r < rLo) rLo = r;
    if (r > rHi) rHi = r;
    if (hs[i] < hLo) hLo = hs[i];
    if (hs[i] > hHi) hHi = hs[i];
  }
  const grade = Math.hypot(pa, pb);      // rise over run of the best-fit plane
  const bumpiness = rHi - rLo;           // metres of hump left after the tilt
  const relief = hHi - hLo;              // kept for the score and for reporting

  // Published BEFORE the tests, not after, so a refused site can still be
  // measured. Setting them only on success is how the first sweep of this came
  // back reporting nothing at all about the 86% it was rejecting — which is
  // precisely the population whose distribution decides where the limits go.
  out.grade = grade;
  out.bumpiness = bumpiness;
  out.relief = relief;
  out.slope = slopeMean;

  // Water first: it is the only hard, obvious, unarguable no.
  if (wet > 0) { out.reason = 'in the water'; return out; }

  // ── how steep, and how bumpy ──────────────────────────────────────────────
  //
  // Both limits are set from a sweep rather than from taste, for exactly the
  // reason the rescue button's are (see RESCUE_SLOPE in Vehicle.js — a limit
  // chosen by feel declined from 57% of the ground where the button was most
  // needed and nobody noticed until someone counted).
  //
  // `maxGrade` comes from the caller because it is the one number that should
  // differ between a full camp and a compact one: a whole furnished camp wants
  // ground you could put a table on, and one tent and a chair does not. A
  // backpacker pitches on ground a dinner party would not.
  //
  // `slopeMax` survives as a separate guard on the sampled gradient field,
  // because the plane fit is a smooth average and cannot see a single cliff
  // edge clipping the rim of the disc.
  const maxGrade = opts.maxGrade ?? MAX_GRADE_FULL;
  if (grade > maxGrade) { out.reason = 'too steep'; return out; }
  if (slopeMax > 1.55) { out.reason = 'too steep'; return out; }
  const maxBump = opts.maxBump ?? MAX_BUMP_FULL;
  if (bumpiness > maxBump) { out.reason = 'too uneven'; return out; }

  // Anything solid standing in the middle of the site. Trees are the real case
  // — a tent inside a trunk is the single worst thing this feature could ship —
  // and rocks are the same test.
  const blocker = opts.blocked?.(x, z, R);
  if (blocker) { out.reason = blocker; return out; }

  out.ok = true;
  // Flat, level and dry scores 1. The score decays over the acceptable band
  // rather than at its edge, so the reticle firms up as the player finds the
  // nice spot instead of switching from bad to good at a threshold. It is
  // scored on the same two things it is judged on, so a site that only just
  // passes visibly only just passes.
  out.score = clamp01(
    (1 - smoothstep(0.02, maxGrade, grade)) * 0.60 +
    (1 - smoothstep(0.10, maxBump, bumpiness)) * 0.40
  );
  return out;
}

/**
 * The best camp that will fit here: a full one if the ground allows, a compact
 * one if it does not, and nothing if even that will not stand.
 *
 * Returns the winning `scoreSite` result with `radius` and `small` on it.
 *
 * Retrying at the smaller radius is the whole mechanism, and it is deliberately
 * NOT a second, looser set of thresholds. The same rule is applied to a smaller
 * footprint, so a compact camp is one that genuinely passes the same test —
 * ground that is bad enough to fail at 4.2 m is ground you cannot pitch a tent
 * on at all, and it still refuses. Water, bounds and trees are properties of
 * the place rather than of the disc, so a site that fails on those is not
 * retried; there is no smaller camp that is less in a lake.
 */
// ── the two limits, read off a sweep of the valley ───────────────────────────
//
// `grade` is rise over run of the best-fit plane through the site; `bump` is
// what is left after that plane is subtracted. They are different questions and
// they get different numbers (see the long note in `scoreSite`).
//
// tools/_scratch/campsmall.mjs, 774 dry samples, measured on the 4.2 m disc.
// Deciles of the whole dry population:
//
//   grade   0.11 0.16 0.20 0.26 0.33 0.45 0.77 1.10 1.52
//   bump    0.44 0.57 0.67 0.76 0.89 1.04 1.22 1.52 2.37
//
// The median of this valley is a 0.33 grade, which is simply what a mountain
// valley is — most of it is mountainside, and most of it should refuse.
//
// A full camp wants ground you could stand a table on. One tent and a chair
// does not: a backpacker pitches on ground a dinner party would not, and 0.42
// is about 23 degrees. That is a stretch to sleep on in life and exactly right
// for a game with no fail state whose whole proposition is stopping wherever
// you like.
//
// The bump limits are the part that had to be measured rather than guessed. The
// first pass used 0.62 for both, which is around the 25th percentile — it cut
// straight through the middle of the distribution and refused 295 of 774
// samples as "too uneven", taking the full camp down to 1.4% of the valley.
export const MAX_GRADE_FULL = 0.22;
export const MAX_GRADE_SMALL = 0.42;
export const MAX_BUMP_FULL = 0.80;
export const MAX_BUMP_SMALL = 0.95;

export function bestSite(world, x, z, opts = {}) {
  const full = scoreSite(world, x, z, {
    ...opts, radius: CAMP_RADIUS, maxGrade: MAX_GRADE_FULL, maxBump: MAX_BUMP_FULL,
  });
  if (full.ok) { full.radius = CAMP_RADIUS; full.small = false; return full; }
  if (full.reason === 'in the water' || full.reason === 'out of bounds' ||
      full.reason === 'nowhere' || full.reason === 'too close') { full.radius = CAMP_RADIUS; full.small = false; return full; }

  const small = scoreSite(world, x, z, {
    ...opts, radius: CAMP_RADIUS_SMALL,
    maxGrade: MAX_GRADE_SMALL, maxBump: MAX_BUMP_SMALL,
  });
  small.radius = CAMP_RADIUS_SMALL;
  small.small = true;
  if (!small.ok) return small;
  // A compact camp never scores as confidently as a full one. The reticle
  // reads `score` for how settled to look, and a pitch you had to shrink to
  // make fit should look like what it is — found, not chosen.
  small.score = clamp01(small.score * 0.78);
  return small;
}

/**
 * Clamp a point into the annulus around the camper the player may build in.
 * Returns the clamped point and whether it had to move — the reticle draws
 * itself differently when it is being held at the limit, so the rule is
 * legible without a message.
 */
export function clampToSite(px, pz, vx, vz) {
  const dx = px - vx, dz = pz - vz;
  const d = Math.hypot(dx, dz);
  if (d < 1e-4) return { x: vx + SITE_MIN, z: vz, clamped: true };
  const t = clamp(d, SITE_MIN, SITE_MAX);
  return { x: vx + (dx / d) * t, z: vz + (dz / d) * t, clamped: Math.abs(t - d) > 0.01 };
}

// ─────────────────────────────────────────────────────────────────────────────
//  The layout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Arrange a camp.
 *
 * The arrangement is built from four facts about how people actually set one
 * up, and every one of them is a constraint here rather than a random draw:
 *
 *  1. **The fire is the centre and the reason.** Everything is placed in polar
 *     coordinates about it, so everything relates to it by construction.
 *
 *  2. **Nobody sits in the smoke.** Smoke goes downwind, so the chairs take the
 *     *upwind* arc. This is the single strongest reason the result reads as
 *     considered rather than scattered: the whole camp has an axis, and the
 *     axis has a cause the player can feel from the drifting smoke without ever
 *     being told.
 *
 *  3. **The tent goes furthest out and off to one side** — clear of sparks,
 *     clear of the seating arc, door turned toward the fire but not square to
 *     it. Square-on is the tell of a placed object; real tents are pitched to
 *     the ground, not to the furniture.
 *
 *  4. **The cooler and the table are within arm's reach of a chair**, because
 *     that is what they are for. They sit *between* two chairs, or just outside
 *     the arc beside one, never opposite it across the fire.
 *
 *  Randomness enters as jitter on angle, radius and yaw, drawn from the seeded
 *  RNG so a given site always builds the same camp — which matters more than it
 *  sounds, because it is what lets a critic A/B two builds of the same site.
 *
 * @param rnd    seeded RNG
 * @param world  WorldData, for standing each prop on the actual ground
 * @param cx,cz  the fire, in world XZ
 * @param opts   { windDir: THREE.Vector2, radius, chairs, obstacles }
 *
 * `obstacles` are the trunks and boulders the valley already put inside the
 * clearing, as [{ x, z, r }]. They are seeded into the separation test exactly
 * like an already-placed prop, so a camp pitched under a birch simply arranges
 * itself around the birch. That is a better picture than a camp that refuses
 * to exist anywhere a tree is standing, which is what the first pass did.
 * @returns array of { kind, x, z, y, yaw, tilt, scale, opts }
 */
export function layoutCamp(rnd, world, cx, cz, opts = {}) {
  const R = opts.radius ?? CAMP_RADIUS;
  // A compact camp is not a full camp with things deleted — it is a different
  // camp. One tent, one chair, a fire, and a good chance of a woodpile: the
  // pitch of somebody who stopped on a hillside for the night rather than the
  // pitch of somebody who is staying. Adding a table and two coolers to a 4 m
  // clearing does not read as cosy, it reads as crowded, and crowded is the
  // opposite of what this whole feature is for.
  const small = !!opts.small;
  const wind = opts.windDir ?? new THREE.Vector2(0.86, 0.51);
  // The direction the smoke leaves in. Chairs sit opposite it.
  const downwind = Math.atan2(wind.y, wind.x);
  const seatCentre = downwind + Math.PI;

  const out = [];
  const placed = [];   // { x, z, r } for separation tests
  // The fire, first, as an obstacle like any other.
  //
  // It is the origin of every polar coordinate below, which is exactly why it
  // was missed: it did not feel like a thing in the camp, it felt like the
  // frame the camp is drawn in. But it is a ring of stones with a fire in it
  // and nothing may stand on it, so it belongs in the same list as a trunk.
  // Seeded here rather than special-cased per prop, so a future prop is
  // separated from the fire by construction and not by whoever adds it
  // remembering to.
  //
  // This costs the other props nothing — it is a guard, not a re-tune, and the
  // census either side of it says so: every other kind's closest approach to
  // the fire moved by at most 3 cm, and no camp lost a prop it used to have.
  // The tightest is the compact camp's single chair, which lands at 1.11 m
  // against a required (0.58 + 0.42) * 1.04 = 1.04; the woodpile, telescope,
  // cooler and table are all further out. See `tools/_scratch/firegap.mjs`.
  placed.push({ x: cx, z: cz, r: FIRE_RING });
  for (const o of opts.obstacles ?? []) placed.push({ x: o.x, z: o.z, r: o.r });

  // Reject a candidate that lands on top of something already placed, or on
  // ground the prop cannot stand on. Then give up: a camp that is one chair
  // short is a camp, and a camp with a chair inside the cooler is a bug.
  //
  // `insist` is for the tent, and only for the tent. A camp missing a chair or
  // a table still reads as somebody's camp; a camp with no tent reads as a
  // bug, because the feature's own spec is about pitching one. When insisting,
  // the search sweeps the FULL circle at several radii and, if even that finds
  // nothing, takes the least-bad candidate rather than returning nothing.
  const tryPlace = (kind, angle, radius, foot, make,
                    { tries = 14, insist = false, swing = 0.5, rMin = 0 } = {}) => {
    let best = null, bestPenalty = Infinity;
    if (insist) tries = 64;
    for (let i = 0; i < tries; i++) {
      // ── how the search widens, and why it is bounded ────────────────────
      //
      // Failures push the candidate OUTWARD first and only sideways within
      // `swing`. The earlier version widened the angle without a bound
      // (i * 0.42, reaching ±2.7 rad by the last try), which meant a chair
      // that failed a few times could be flung to the far side of the fire —
      // and the chairs occupying one arc on one side is the single strongest
      // thing making a camp read as a place people sat down together rather
      // than as furniture on a roundabout. On open ground the early tries
      // almost always succeed so it rarely bit; under obstacle pressure — a
      // camp pitched among trunks, which is now the common case — it would.
      //
      // So: radius carries the search (a chair pushed half a metre out is
      // still a chair in the circle), the angle is clamped to `swing`, and a
      // prop that genuinely cannot fit is simply not placed.
      //
      // A note on how this was nearly justified with a fabricated number.
      // `tools/_scratch/camplayout.mjs` first reported the chairs' arc at a
      // median of 4.48 rad and that looked like a smoking gun. It was the
      // instrument: the census sorted raw atan2 bearings, so two chairs 0.3
      // rad apart that straddled the ±pi seam sorted as 6.0 rad apart. Fixed,
      // the same layouts measure 0.74 / 1.22 / 1.93 rad, which is the design
      // intent. The bound is still right — it is a guard, not a fix — but it
      // was very nearly written into this file as a defect it never repaired.
      //
      // The tent is the exception. It insists, and it sweeps the full circle
      // on the golden angle — which covers every bearing evenly without ever
      // repeating one — because a camp with no tent is a bug and a tent on an
      // unexpected bearing is just a tent.
      const a = insist ? angle + i * GOLDEN
                       : angle + (rnd() - 0.5) * Math.min(swing, 0.12 + i * 0.14);
      // ── the sweep widens OUTWARD, from the nominal radius ───────────────
      //
      // `((i * 7) % 5) / 4` cycles 0, 0.5, 1, 0.25, 0.75 — radius variety
      // spread across the bearing sweep so the insisted prop is not tried at
      // one distance on 64 bearings. What it multiplies is the part that was
      // wrong: it used to run 0.80 -> 1.10, so the sweep both started inside
      // the nominal radius and spent three of its five steps there. Try 0 is
      // the one that nearly always succeeds, and try 0 was the innermost.
      //
      // Now it runs 1.00 -> 1.30. A prop that cannot fit where it was asked to
      // go moves AWAY from the fire, which is the only direction that is ever
      // an improvement — the fire is the hot thing in the middle, and "it did
      // not fit, so it was moved closer to the flames" is not a recovery.
      const rRaw = insist ? radius * (1.00 + 0.30 * ((i * 7) % 5) / 4)
                          : radius * (1 + (rnd() - 0.5) * 0.10 + i * 0.055);
      // The floor. Nothing — not the jitter, not the sweep, and not the
      // least-bad fallback below, which is the one that actually put tents in
      // the fire — may take a prop inside this.
      const r = Math.max(rRaw, rMin);
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      // How far this candidate overlaps the worst thing it touches, so an
      // insisted placement can pick the least-bad rather than the first.
      let worst = 0;
      for (const p of placed) {
        const over = (p.r + foot) * 1.04 - Math.hypot(p.x - x, p.z - z);
        if (over > worst) worst = over;
      }
      // Standing on a lip reads as a prop clipping the ground, and a chair with
      // one leg in the air is the first thing anyone notices. Reject the worst
      // of it here rather than trying to fix it with per-leg raycasts later.
      const relief = footprintRelief(world, x, z, foot);
      const penalty = worst * 3 + Math.max(0, relief - 0.34) * 2;
      if (penalty < bestPenalty) { bestPenalty = penalty; best = { x, z, a, relief }; }
      if (worst > 0) continue;
      if (relief > 0.34 && i < tries - 2) continue;
      const item = make(x, z, a, relief);
      placed.push({ x, z, r: foot });
      out.push(item);
      return item;
    }
    if (!insist || !best) return null;
    const item = make(best.x, best.z, best.a, best.relief);
    placed.push({ x: best.x, z: best.z, r: foot });
    out.push(item);
    return item;
  };

  // ── the tent ───────────────────────────────────────────────────────────────
  // One tent. Off the seating axis by 100–140 degrees so it frames the camp
  // from the side rather than closing it off from behind, and at 0.86 R so its
  // guy lines are still on the dirt.
  {
    const side = rnd() < 0.5 ? 1 : -1;
    const a = seatCentre + side * lerp(1.75, 2.45, rnd());
    // Which of the two tents. The dome is the common one — it is what almost
    // everybody actually owns — but a valley where every camp has the same tent
    // is a valley with one camper in it, seen four times. Drawn here rather than
    // in the builder because the RNG is shared with the rest of the layout and a
    // draw made conditionally would desync every prop placed after this one.
    const style = rnd() < 0.34 ? 'ridge' : 'dome';
    // 0.62 R on a full camp; 0.60 on a compact one, which is 2.04 m.
    //
    // The tent does not scale with the clearing — it is the same tent — so on
    // the compact camp this fraction lands very near the floor, and the floor
    // is what actually governs there. `TENT_FIRE_CLEAR` is passed as `rMin`
    // rather than folded into this fraction on purpose: a fraction of the
    // clearing is a preference and gets jittered and swept off, and the
    // distance from a tent to a fire is not a preference. See the note on
    // `TENT_FIRE_CLEAR` for how far off the two had drifted.
    //
    // A hand's width was the old margin, and "a hand's width from a fire" is
    // the wrong unit for the thing it was measuring.
    tryPlace('tent', a, R * (small ? 0.60 : 0.62), 1.45, (x, z, ang) => ({
      kind: 'tent', x, z, y: world.getHeight(x, z),
      // The door turns toward the fire, then backs off 15–35 degrees. Facing a
      // tent door dead at the fire is what a level editor does; a real one is
      // pitched across the slope with the door wherever that leaves it.
      yaw: Math.atan2(cx - x, cz - z) + (rnd() - 0.5) * 0.62,
      // 0.92, not the 0.55 this started at. The old value came from "a tent
      // floor is a taut rectangle that bridges small undulations rather than
      // draping over them", which is true and was the wrong lever: bridging
      // is about BUMPS, and the site test already caps bumpiness under a
      // prop's own footprint at 0.34 m, so there is very little left to
      // bridge. What 0.55 actually did was hold the tent half-level on a
      // hillside, which buries its uphill edge — the player's report.
      //
      // A tent pitched on a slope lies along the slope. The remaining 0.08
      // keeps a hint of a taut floor rather than a fabric draped over terrain.
      tilt: 0.92,
      // Both tables are four long, so the same draw is uniform whichever
      // builder `style` sends this to. See RIDGETENT_COLORWAYS.
      opts: { style, colorway: Math.floor(rnd() * 4), wear: rnd() },
    }), { insist: true, rMin: TENT_FIRE_CLEAR });
  }

  // ── the chairs ─────────────────────────────────────────────────────────────
  // Two or three, on an arc upwind of the fire. The arc is *not* symmetric: the
  // gaps between chairs are drawn from a spread so the group has a shape. Two
  // chairs at exactly ±0.6 rad is a pair of parentheses; two at +0.45 and −0.78
  // is two people who sat down.
  {
    // 2, 3 or occasionally 4. Never 1 on a full camp: a single chair by a big
    // fire is a lonely image, and this feature's whole job is the opposite of
    // that. A compact camp is the exception, and it is not lonely for the same
    // reason a one-person tent is not — the whole pitch is sized for one, so
    // one chair reads as complete rather than as missing three.
    const rc = rnd();
    const n = opts.chairs ?? (small ? 1 : rc < 0.50 ? 2 : rc < 0.86 ? 3 : 4);
    // Total arc widens with the number of chairs but sub-linearly, so three
    // chairs sit closer together than two chairs spread apart would.
    const span = lerp(0.85, 1.85, (n - 2) / 2.2) + rnd() * 0.25;
    for (let i = 0; i < n; i++) {
      const frac = n === 1 ? 0.5 : i / (n - 1);
      const a = seatCentre + (frac - 0.5) * span + (rnd() - 0.5) * 0.22;
      // Same argument as the tent: a chair is 0.55 m wide whatever the
      // clearing is, so a compact camp seats it proportionally closer in.
      // 0.34–0.42 of 3.4 m is 1.16–1.43 m from the fire, which is close enough
      // to put your boots near it — the right distance for one chair and a
      // small fire on a hillside.
      const r = R * (small ? lerp(0.34, 0.42, rnd()) : lerp(0.30, 0.38, rnd()));
      // A chair may drift 0.28 rad — sixteen degrees — and no further. Beyond
      // that it has left the group it belongs to.
      tryPlace('chair', a, r, 0.42, (x, z) => ({
        kind: 'chair', x, z, y: world.getHeight(x, z),
        // A chair points at the fire, off by up to 20 degrees. Chairs that all
        // aim exactly at the centre look like a Stonehenge diagram.
        yaw: Math.atan2(cx - x, cz - z) + (rnd() - 0.5) * 0.70,
        tilt: 1.0,     // four feet on the ground; take the normal fully
        opts: { colorway: Math.floor(rnd() * 4), style: rnd() < 0.5 ? 'sling' : 'arm', wear: rnd() },
      }), { swing: 0.28 });
    }
  }

  // ── the coolers ────────────────────────────────────────────────────────────
  // Just outside the seating arc, on one flank, where somebody would reach for
  // it without getting up. Turned mostly toward the fire so its latches — the
  // detail that says "cooler" at 15 m — face the camera in the frames that
  // matter.
  //
  // One about two thirds of the time and two the rest, on opposite flanks, in
  // different colourways. Two is what a real camp has (food in one, drinks in
  // the other) and it is also the cheapest variety in the whole layout: the
  // difference between "every camp has exactly one of everything" and "this
  // camp is a bit different from the last one" is worth more than another prop
  // type would be. The second one is smaller and is often the one left open.
  if (!small) {
    const flank = rnd() < 0.5 ? 1 : -1;
    const cw = Math.floor(rnd() * 3);
    const a = seatCentre + flank * lerp(0.95, 1.35, rnd());
    tryPlace('cooler', a, R * lerp(0.38, 0.46, rnd()), 0.46, (x, z) => ({
      kind: 'cooler', x, z, y: world.getHeight(x, z),
      yaw: Math.atan2(cx - x, cz - z) + (rnd() - 0.5) * 0.9,
      tilt: 1.0,
      opts: { colorway: cw, lidOpen: rnd() < 0.18, wear: rnd() },
    }), { swing: 0.55 });
    if (rnd() < 0.34) {
      const a2 = seatCentre - flank * lerp(0.85, 1.45, rnd());
      tryPlace('cooler', a2, R * lerp(0.36, 0.44, rnd()), 0.40, (x, z) => ({
        kind: 'cooler', x, z, y: world.getHeight(x, z),
        yaw: Math.atan2(cx - x, cz - z) + (rnd() - 0.5) * 1.3,
        tilt: 1.0,
        // Never the same colourway as the first: two identical coolers side by
        // side is the single loudest "these were instanced" tell in the camp.
        opts: { colorway: (cw + 1 + Math.floor(rnd() * 2)) % 3, small: true,
                lidOpen: rnd() < 0.40, wear: rnd() },
      }), { swing: 0.55 });
    }
  }

  // ── the table ──────────────────────────────────────────────────────────────
  // Between two chairs, at the same radius, which is where a small folding
  // table actually ends up. Skipped one time in five: a camp that always has
  // exactly one of everything is a checklist.
  if (!small && rnd() < 0.82) {
    const flank = rnd() < 0.5 ? -1 : 1;
    const a = seatCentre + flank * lerp(0.35, 0.72, rnd());
    tryPlace('table', a, R * lerp(0.34, 0.42, rnd()), 0.40, (x, z) => ({
      kind: 'table', x, z, y: world.getHeight(x, z),
      yaw: Math.atan2(cx - x, cz - z) + (rnd() - 0.5) * 1.1,
      tilt: 1.0,
      opts: { wear: rnd(), dressed: rnd() < 0.7 },
    }), { swing: 0.40 });
  }

  // ── the telescope ──────────────────────────────────────────────────────────
  //
  // Uncommon on purpose. This is the one object in the camp that is somebody's
  // hobby rather than their kit, and the whole value of it is that a player who
  // has pitched twenty camps still gets a small jolt from the twenty-first. One
  // camp in five, on a full pitch and on a compact one alike.
  //
  // Where it goes is the more interesting decision. A telescope does not belong
  // in the seating arc, because the fire is the one thing that ruins night
  // vision — real observers set up well away from it and behind the seats. So
  // it is placed on the flank *behind* the chairs, at 0.62-0.72 R, near the lip
  // of the clearing where the sky opens up. `Camp.js` yaws every prop's +Z at
  // the fire, and this prop is authored with +Z as the eyepiece side, so that
  // rule leaves it aimed out of the camp at the dark — which is both correct
  // and the better picture: a bright tube raking up and away out of the frame.
  //
  // The compact camp gets one too, at half the rate. A 4.2 m hillside pitch
  // will not take the 1.4 m equatorial rig — it would stand taller than the
  // tent and eat a third of the clearing — so a small camp always gets the
  // little refractor, and a full camp rolls between the two. That is also the
  // only way both plates are ever reachable in play.
  {
    const chance = 0.40;
    if (rnd() < chance) {
      // Which telescope. Three now, and the compact camp can only have two of
      // them for the same reason it only gets one chair: a 1.5 m equatorial rig
      // in a 4.2 m clearing stands taller than the tent and eats a third of the
      // ground. The two small ones are 0.87 m and 1.09 m and both sit in a
      // compact pitch without crowding it.
      //
      // The roll is not uniform on a full camp. The Newtonian is the rarest of
      // the three because it is the biggest event — a player who has seen one
      // twice should still not expect the third — and the travel scope is the
      // commonest because it is the one somebody actually throws in a truck.
      const r3 = rnd();
      const variant = small
        ? (r3 < 0.55 ? 'travel' : 'refractor')
        : (r3 < 0.34 ? 'reflector' : r3 < 0.66 ? 'travel' : 'refractor');
      const big = variant === 'reflector';
      const flank = rnd() < 0.5 ? 1 : -1;
      // Behind the seats and off to one side: a quarter turn or more past the
      // last chair, which puts it outside the group without putting it across
      // the fire from it.
      const a = seatCentre + flank * lerp(1.45, 2.05, rnd());
      // Inside the bare ground, and that bound is arithmetic rather than taste.
      // `camp_clearing.js` feathers the dirt over `0.20 R`, and the edge wobble
      // takes the disc in to `0.77 R` on its worst bearing, so ground that is
      // fully bare on EVERY bearing ends at `0.57 R` — about 3.3 m on a full
      // camp. The first build placed the scope at 0.62-0.74 R and the capture
      // came back with a 1.5 m instrument standing in half-metre meadow grass
      // with its tripod feet invisible. A telescope is the thinnest-legged
      // thing in the set and it is the one that can least afford that.
      //
      // Pulled in again after the second round: at 0.50-0.60 R the reflector's
      // 1.0 m foot circle still had one leg in the fringe, and a two-pixel
      // silver leg silhouetted against high-frequency yellow grass is the worst
      // backdrop available for it. The scope's own footprint grew with the
      // splay, so the CENTRE has to come in by more than the footprint did.
      tryPlace('telescope', a, R * (small ? lerp(0.44, 0.52, rnd()) : lerp(0.46, 0.55, rnd())),
        big ? 0.58 : 0.40, (x, z) => ({
          kind: 'telescope', x, z, y: world.getHeight(x, z),
          // The tube swings off the fire bearing by up to 40 degrees. Every
          // telescope in every camp aiming at exactly the same bearing is the
          // Stonehenge problem the chairs already solved.
          yaw: Math.atan2(cx - x, cz - z) + (rnd() - 0.5) * 1.4,
          // A tripod is the one thing in a camp somebody deliberately levelled,
          // so it takes very little of the ground normal. Not zero: at zero it
          // reads as pasted onto a slope, and a hand-levelled tripod on rough
          // ground is still a couple of degrees out.
          tilt: 0.22,
          opts: { variant, wear: rnd() },
        }), { swing: 0.75 });
    }
  }

  // ── firewood ───────────────────────────────────────────────────────────────
  // A stack of split logs, downwind-ish of the fire and well back from it.
  // Small, but it is the prop that says somebody is *staying*.
  if (!small || rnd() < 0.55) {
    const a = downwind + (rnd() - 0.5) * 1.1;
    // 0.50 rather than 0.44: the stack is 0.46 wide and the piece lying beside
    // it reaches past that, and the builder now measures and publishes the real
    // figure rather than asserting one.
    tryPlace('woodpile', a, R * lerp(0.42, 0.52, rnd()), 0.50, (x, z) => ({
      kind: 'woodpile', x, z, y: world.getHeight(x, z),
      // `logs` is the number of pieces on the stack, and it is now read: the
      // builder used to ignore it and always laid 9-12, so this range keeps the
      // mass the layout was tuned against while letting camps differ. Pieces
      // are quarters, halves and whole rounds of varying size and the builder
      // packs courses by measured width, so this comes out three or four
      // courses — shin-high, which is what a camp keeps by a fire.
      yaw: rnd() * TAU, tilt: 1.0, opts: { logs: 12 + Math.floor(rnd() * 4), wear: rnd() },
    }), { swing: 0.85 });
  }

  return out;
}

/**
 * How BUMPY the ground under a prop's footprint is, with the local tilt taken
 * out — the same distinction `scoreSite` draws, one level down, and it was
 * wrong here for exactly as long.
 *
 * This used to return raw peak-to-peak height, and on a slope that is dominated
 * by the tilt: a 1.45 m tent footprint on a smooth 15-degree hillside has
 * 0.77 m of raw spread and nothing wrong with it at all. So on any sloping site
 * every prop failed its placement test, the tent fell through to `insist` and
 * swept off to an arbitrary bearing, and the chair and the woodpile were never
 * placed at all. The first hillside capture came back with a camp consisting of
 * one tent, sitting on its own.
 *
 * A prop stands on three or four feet and can bridge a tilt; what it cannot do
 * is bridge a hump. So: fit the plane, return what is left.
 */
function footprintRelief(world, x, z, r) {
  const c = world.getHeight(x, z);
  let Sxx = 0, Szz = 0, Sxh = 0, Szh = 0, Sh = c, n = 1;
  const dxs = [0], dzs = [0], hs = [c];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    const dx = Math.cos(a) * r, dz = Math.sin(a) * r;
    const h = world.getHeight(x + dx, z + dz);
    dxs.push(dx); dzs.push(dz); hs.push(h);
    Sxx += dx * dx; Szz += dz * dz; Sxh += dx * h; Szh += dz * h; Sh += h; n++;
  }
  const pa = Sxx > 1e-6 ? Sxh / Sxx : 0;
  const pb = Szz > 1e-6 ? Szh / Szz : 0;
  const pc = Sh / n;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const res = hs[i] - (pa * dxs[i] + pb * dzs[i] + pc);
    if (res < lo) lo = res;
    if (res > hi) hi = res;
  }
  return hi - lo;
}

/**
 * The quaternion that stands a prop on the ground.
 *
 * `tilt` is how much of the terrain normal the prop takes: 1 for a chair, whose
 * four feet genuinely follow the slope, and about 0.55 for a tent, whose floor
 * is a taut rectangle that bridges small undulations rather than draping over
 * them. Taking the full normal on a tent makes it look like it is sliding
 * downhill; taking none makes it look like it is levitating on the high side.
 */
export function standOn(world, x, z, yaw, tilt = 1, out = new THREE.Quaternion()) {
  const e = 0.9;
  const hL = world.getHeight(x - e, z), hR = world.getHeight(x + e, z);
  const hD = world.getHeight(x, z - e), hU = world.getHeight(x, z + e);
  const n = new THREE.Vector3(hL - hR, 2 * e, hD - hU).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const tilted = new THREE.Quaternion().setFromUnitVectors(up, n);
  // Slerp from identity so `tilt` is a real fraction of the rotation rather
  // than a lerp of a normal, which would denormalise on a steep slope.
  tilted.slerp(new THREE.Quaternion(), 1 - clamp01(tilt));
  return out.setFromAxisAngle(up, yaw).premultiply(tilted);
}

/**
 * How far a prop has to be lifted so no part of its base is under the ground.
 *
 * `standOn` orients a prop, and any prop that takes less than the FULL ground
 * normal is left at an angle to the terrain it stands on — so one side of its
 * base is below the surface. That is what "cutting into the side" is, and it
 * scales with the footprint: at tilt 0.92 on a 0.27 grade, a 1.45 m tent still
 * buries its uphill corner by about 3 cm, and at the 0.55 it used to use it was
 * nearly 20 cm.
 *
 * Samples the terrain around the footprint, expresses each sample in the prop's
 * own rotated frame, and returns the largest amount by which the ground stands
 * proud of the prop's base plane.
 *
 * Clamped by the caller. A lift big enough to fix a bad tilt is also big enough
 * to leave a visible gap on the downhill side, and a floating tent is not an
 * improvement on a buried one — the lift is a finishing touch on top of a tilt
 * that is already nearly right, not a substitute for one.
 */
export function groundLift(world, x, z, quat, footprint) {
  const inv = _liftQ.copy(quat).invert();
  const y0 = world.getHeight(x, z);
  let lift = 0;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    const dx = Math.cos(a) * footprint, dz = Math.sin(a) * footprint;
    const h = world.getHeight(x + dx, z + dz);
    // The sample, relative to the prop's origin, in the prop's own frame. Its
    // y is how far above the prop's base plane the ground is at that point.
    _liftV.set(dx, h - y0, dz).applyQuaternion(inv);
    if (_liftV.y > lift) lift = _liftV.y;
  }
  return lift;
}
const _liftQ = new THREE.Quaternion();
const _liftV = new THREE.Vector3();

/** A seeded RNG keyed off a site's position, so the same spot builds the same camp. */
export function siteRng(x, z, seed = 0) {
  const k = (Math.round(x * 16) * 73856093) ^ (Math.round(z * 16) * 19349663) ^ (seed * 83492791);
  return mulberry32(k >>> 0);
}
