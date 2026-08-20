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

  let minY = Infinity, maxY = -Infinity, slopeSum = 0, slopeMax = 0, wet = 0, n = 0;
  for (const rr of [0, R * 0.55, R]) {
    const count = rr === 0 ? 1 : 16;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU;
      const sx = x + Math.cos(a) * rr, sz = z + Math.sin(a) * rr;
      const h = world.getHeight(sx, sz);
      const s = world.getSlope(sx, sz);
      if (!Number.isFinite(h)) { out.reason = 'nowhere'; return out; }
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
      slopeSum += s; if (s > slopeMax) slopeMax = s;
      if (world.getWaterDepth(sx, sz) > 0.02) wet++;
      n++;
    }
  }
  const slopeMean = slopeSum / n;
  const relief = maxY - minY;

  // Water first: it is the only hard, obvious, unarguable no.
  if (wet > 0) { out.reason = 'in the water'; return out; }

  // ── slope and relief ──────────────────────────────────────────────────────
  //
  // These limits are set from a sweep rather than from taste, for exactly the
  // reason the rescue button's are (see RESCUE_SLOPE in Vehicle.js — a limit
  // chosen by feel declined from 57% of the ground where the button was most
  // needed and nobody noticed until someone counted).
  //
  // `tools/_scratch/campdiag.mjs` samples the whole annulus the player may aim
  // into, from five parking places. Measured, p10/p50/p90 of the disc:
  //
  //            slopeMean          slopeMax           relief (m over 12.8 m)
  //   meadow   0.03/0.03/0.04     0.04/0.05/0.05     0.42/0.65/0.83
  //   river    0.03/0.09/0.12     0.05/0.12/0.17     0.46/1.16/1.63
  //   forest   0.17/0.32/0.45     0.36/0.59/0.69     1.99/4.03/6.16
  //   vista    0.45/0.94/1.59     0.69/1.44/1.92     4.78/10.53/20.42
  //   road     0.76/1.11/2.00     1.12/2.00/2.29     7.81/13.87/26.50
  //
  // The first pass used slopeMax > 0.62 and relief > 1.55 and rejected 100% of
  // the ground near the road and the vista — which is CORRECT, those are a
  // mountain road cut and a ridge lookout and you cannot pitch a tent on
  // either — but it also threw away 19% of the river bank, which is flat
  // ground at a 9% grade and is one of the nicest places in the valley to
  // camp. The limits below keep the road and the vista out and let the bank in.
  //
  // slopeMax alone is not enough: it is a max over 33 samples of a bilinear
  // field, so one texel of noise on otherwise flat ground can trip it. Both
  // statistics have to agree that the ground is bad.
  if (slopeMean > 0.42 && slopeMax > 1.10) { out.reason = 'too steep'; return out; }
  if (slopeMax > 1.55) { out.reason = 'too steep'; return out; }
  if (relief > 2.1) { out.reason = 'too uneven'; return out; }

  // Anything solid standing in the middle of the site. Trees are the real case
  // — a tent inside a trunk is the single worst thing this feature could ship —
  // and rocks are the same test.
  const blocker = opts.blocked?.(x, z, R);
  if (blocker) { out.reason = blocker; return out; }

  out.ok = true;
  // Flat, level and dry scores 1. The score decays over the acceptable band
  // rather than at its edge, so the reticle firms up as the player finds the
  // nice spot instead of switching from bad to good at a threshold.
  out.score = clamp01(
    (1 - smoothstep(0.10, 0.55, slopeMean)) * 0.55 +
    (1 - smoothstep(0.25, 1.35, relief)) * 0.45
  );
  out.slope = slopeMean;
  out.relief = relief;
  return out;
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
  const wind = opts.windDir ?? new THREE.Vector2(0.86, 0.51);
  // The direction the smoke leaves in. Chairs sit opposite it.
  const downwind = Math.atan2(wind.y, wind.x);
  const seatCentre = downwind + Math.PI;

  const out = [];
  const placed = [];   // { x, z, r } for separation tests
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
                    { tries = 14, insist = false, swing = 0.5 } = {}) => {
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
      const r = insist ? radius * (0.80 + 0.30 * ((i * 7) % 5) / 4)
                       : radius * (1 + (rnd() - 0.5) * 0.10 + i * 0.055);
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
    tryPlace('tent', a, R * 0.62, 1.45, (x, z, ang) => ({
      kind: 'tent', x, z, y: world.getHeight(x, z),
      // The door turns toward the fire, then backs off 15–35 degrees. Facing a
      // tent door dead at the fire is what a level editor does; a real one is
      // pitched across the slope with the door wherever that leaves it.
      yaw: Math.atan2(cx - x, cz - z) + (rnd() - 0.5) * 0.62,
      tilt: 0.55,      // how much of the ground normal it takes
      opts: { colorway: Math.floor(rnd() * 4), wear: rnd() },
    }), { insist: true });
  }

  // ── the chairs ─────────────────────────────────────────────────────────────
  // Two or three, on an arc upwind of the fire. The arc is *not* symmetric: the
  // gaps between chairs are drawn from a spread so the group has a shape. Two
  // chairs at exactly ±0.6 rad is a pair of parentheses; two at +0.45 and −0.78
  // is two people who sat down.
  {
    // 2, 3 or occasionally 4. Never 1: a single chair by a fire is a lonely
    // image, and this feature's whole job is the opposite of that.
    const rc = rnd();
    const n = opts.chairs ?? (rc < 0.50 ? 2 : rc < 0.86 ? 3 : 4);
    // Total arc widens with the number of chairs but sub-linearly, so three
    // chairs sit closer together than two chairs spread apart would.
    const span = lerp(0.85, 1.85, (n - 2) / 2.2) + rnd() * 0.25;
    for (let i = 0; i < n; i++) {
      const frac = n === 1 ? 0.5 : i / (n - 1);
      const a = seatCentre + (frac - 0.5) * span + (rnd() - 0.5) * 0.22;
      const r = R * lerp(0.30, 0.38, rnd());
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
  {
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
  if (rnd() < 0.82) {
    const flank = rnd() < 0.5 ? -1 : 1;
    const a = seatCentre + flank * lerp(0.35, 0.72, rnd());
    tryPlace('table', a, R * lerp(0.34, 0.42, rnd()), 0.40, (x, z) => ({
      kind: 'table', x, z, y: world.getHeight(x, z),
      yaw: Math.atan2(cx - x, cz - z) + (rnd() - 0.5) * 1.1,
      tilt: 1.0,
      opts: { wear: rnd(), dressed: rnd() < 0.7 },
    }), { swing: 0.40 });
  }

  // ── firewood ───────────────────────────────────────────────────────────────
  // A stack of split logs, downwind-ish of the fire and well back from it.
  // Small, but it is the prop that says somebody is *staying*.
  {
    const a = downwind + (rnd() - 0.5) * 1.1;
    tryPlace('woodpile', a, R * lerp(0.42, 0.52, rnd()), 0.44, (x, z) => ({
      kind: 'woodpile', x, z, y: world.getHeight(x, z),
      yaw: rnd() * TAU, tilt: 1.0, opts: { logs: 5 + Math.floor(rnd() * 4), wear: rnd() },
    }), { swing: 0.85 });
  }

  return out;
}

/** Peak-to-peak height across a prop's footprint. */
function footprintRelief(world, x, z, r) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    const h = world.getHeight(x + Math.cos(a) * r, z + Math.sin(a) * r);
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  const c = world.getHeight(x, z);
  return Math.max(hi, c) - Math.min(lo, c);
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

/** A seeded RNG keyed off a site's position, so the same spot builds the same camp. */
export function siteRng(x, z, seed = 0) {
  const k = (Math.round(x * 16) * 73856093) ^ (Math.round(z * 16) * 19349663) ^ (seed * 83492791);
  return mulberry32(k >>> 0);
}
