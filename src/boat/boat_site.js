// ─────────────────────────────────────────────────────────────────────────────
//  boat_site — where a boat may be launched, and where the click snaps to.
//
//  Three jobs:
//    · waterRay       — march the pointer ray against the DRAWN water surface
//                       (world._water.levelAt), mirroring groundRay's structure.
//    · shoreSnap      — walk a clicked point to a fixed signed distance inside
//                       the waterline using the hydro sdf (|∇sdf| = 1, so a
//                       Newton step lands almost exactly).
//    · validateLaunch — is this water a boat can live on: a lake for either
//                       hull, or a river for a kayak.
//    · floatWidth     — how much floatable water lies across the current, the
//                       only "is there room" question worth asking in a channel.
//
//  All water questions go to `world.getHydro` (the bilinear hydro-field sample
//  with the mandatory -0.25 texel registration — see WorldData.microDetail for
//  the measurement behind that constant) and to `levelAt`, the drawn surface.
//  `getWaterDepth` is deliberately not used for the visible-water question —
//  see the long seenWaterDepth note in camp_site.js: the baked grid has
//  speckle, the drawn mesh is what the player can see.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp } from '../core/MathUtils.js';

// ── launch rules ─────────────────────────────────────────────────────────────
//
// `span` is the hydro field's openness — the mean of max(sdf, 0) over a box
// blur of radius 12 m (hydroField.js, the spanF block), so a ~25 m window.
// It is NOT a width in metres, and the scale to set a threshold on is the one
// hydroField states for itself: "1.0 m is a thread; 4.0 m is a body that can
// take the full radius".
//
// Read SPAN_PROBE metres into the water along the sdf gradient, not at the
// beached point — AT the waterline half the window looks at land and even big
// lakes read ~5.5 (seed 20261018, 903 launch-band points). The honest question
// is "is there a lake in front of the bow".
//
// ── MIN_SPAN WAS 14, AND 14 IS ABOVE THE PROBE'S OWN CEILING ─────────────────
//
// The probe point sits at LAUNCH_SDF + SPAN_PROBE = 16.5 m inside the
// waterline, so the 25 m window straddles the shore: half of it samples water
// shallower than the probe and some of it samples land at zero. The mean
// therefore cannot exceed ~16 however big the lake is. 14 was a threshold set
// at 86% of the largest value the measurement is capable of returning. (An
// earlier note here claimed the probe "reads 17-41 on lakes". It does not and
// it cannot; that claim is what the 14 rested on.)
//
// Measured on seed 20261018 — every shoreline point in the map on a 20 m grid,
// standing water only. n = 1097; "real lake" = 40 m or more of water across in
// front of the bow (n = 420); "puddle" = under 8 m (n = 413):
//
//   probe 14 m   span ceiling over the WHOLE map ......... 16.3
//                median on a real lake .................... 12.9   <- under 14
//
//   threshold    real lakes accepted    puddles accepted
//        3              91%                   31%
//        6              83%                   12%     <- SHIPPED
//        8              79%                    0%
//       10              70%                    0%
//       14              40%                    0%     <- was
//
// So the median real lake shoreline FAILED the gate, and a player reporting a
// giant lake that refuses a canoe was reading it correctly.
//
// 6 is a DELIBERATE trade and not what the table alone would pick. 8 is the
// strictest threshold that costs nothing on the reject side and was the first
// choice here; 6 buys four more points of real lake and pays 12% of puddles
// for them, so some ponds now accept a canoe that arguably should not. That is
// the right side to err on — refusing a launch on water the player is looking
// at reads as a bug, while accepting one on water that turns out to be small
// reads as a short paddle, and the physics beaches a hull gracefully either
// way (user direction, 2026-08-24).
//
// Do not move this without re-running tools/_scratch/launchgate.mjs. MIN_SPAN
// and SPAN_PROBE are COUPLED through the box radius — changing the probe
// distance moves the whole usable range of the threshold, and tuning one
// without the other is what produced the 14.
export const MIN_SPAN = 6;
export const SPAN_PROBE = 14;
// The lake/river discriminator. getRiver is the baked river mask; above this
// the water is flowing and the RIVER RULES below apply instead of the span
// gate. It used to be a flat refusal — "a boat on it would need a current
// model this feature does not have" — and that is no longer true: the current
// model is in boat_physics.js, driven by the baked flow field.
export const MAX_RIVER = 0.05;

// ── river launches ───────────────────────────────────────────────────────────
//
// A kayak may be put on a river; a canoe may not. That is a design line rather
// than a physics one — the two hulls differ only in speed and dimensions here —
// and it is the one the player asked for: an open canoe is the wrong boat for
// moving water, and keeping it to lakes gives the kind swap something to mean.
export const RIVER_KIND = 'kayak';

// ── WHY THE SPAN GATE CANNOT BE REUSED ON A RIVER ────────────────────────────
//
// `span` is the mean inside-distance over a 25 m window, so a channel can
// never fill it however navigable it is. Measured on seed 20261018 over every
// riverbank point in the map on a 16 m grid (n = 1008): span reads p50 1.03
// against a MIN_SPAN of 6, and the gate accepts **3.7%** of them. That is the
// measured reason a river refuses a boat, and no threshold on span fixes it —
// the statistic is answering a different question.
//
// The question that matters in a channel is whether the hull has floatable
// water across the current, and the answer is that it nearly always does:
//
//   floatable width across the flow ... p05 7.5   p50 19.5   p75 29   p95 64 m
//   depth at the launch point ......... p05 0.52  p50 1.01   p95 2.66 m
//
// against a kayak that draws 0.11 m. So the width floor is set BELOW p05 and
// is there to catch a genuine trickle, not to rank reaches: it rejects under
// 5% of riverbank points and every one of those is the thinnest water in the
// map. Do not try to make it selective — floatable width was measured against
// "how much continuous channel actually lies downstream" and does not separate
// them at all (p50 19.5 m on good reaches, 20.5 m on dead ends), so a stricter
// threshold buys nothing and costs real launches.
//
// ── WHY 5 AND NOT THE HULL'S BEAM ────────────────────────────────────────────
//
// The obvious floor is "wide enough for the boat", i.e. the kayak's 0.60 m
// beam. It is the wrong one, because BoatPhysics has no width test at all: the
// hull is integrated as a POINT and may go anywhere with water under it, so
// nothing here gates passage, only launching. A beam-width floor would let the
// player put a 4.2 m boat into a channel it cannot turn around in — and since
// the physics is a point while the MODEL is four metres of drawn hull, the
// first sweep stroke would swing the bow visibly through the bank.
//
// So the floor is the hull's LENGTH plus a little, not its beam: room to turn
// the boat around is the honest minimum for a craft you can paddle upstream.
//
// It costs almost nothing either way, which is the real reason not to agonise.
// Measured on seed 20262018 (the seed the game boots), n = 1112 riverbank
// points, share accepted by floor:
//
//   0.60 m (beam) 99.4%   ·   4.2 m (hull) 98.9%   ·   5 m 98.6%   ·   8 m 96.6%
//
// Dropping to the beam buys eight tenths of a point of riverbank. What limits
// where a kayak can go on this map is depth and how far the reach runs, never
// width.
export const RIVER_MIN_WIDTH = 5;

// Turbulence, 0..1 off the flow field — steep, pinched or fast water. Also a
// design rule rather than a discriminator, and honestly so: the cap sits above
// p95 (0.50) and refuses about 2% of riverbank points. It exists so the game
// declines to put a touring kayak into whitewater at the top of a chute, which
// is the one place on a river where launching is actually a bad idea.
export const RIVER_MAX_TURB = 0.55;
// Where the boat is placed: just inside the water, measured along the sdf.
export const LAUNCH_SDF = 2.5;
// How far from the camper a launch click may land. You carry a canoe to the
// water; you do not throw it across the lake.
export const MAX_LAUNCH_DIST = 45;

/**
 * March a ray against the drawn water surface. Same structure as groundRay in
 * camp_site.js: linear march to a sign change, then bisect. Cells with no
 * drawn water (`levelAt` null) count as "no water" and never bracket a hit.
 * Returns { x, z, y, dist } or null.
 */
export function waterRay(world, origin, dir, maxDist = 220) {
  const f = world._water;
  if (!f || typeof f.levelAt !== 'function') return null;
  const above = (x, y, z) => {
    const lv = f.levelAt(x, z);
    return lv === null ? null : y - lv;
  };
  let t = 1.0;
  let prevT = 0;
  let prevD = above(origin.x, origin.y, origin.z);
  while (t < maxDist) {
    const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
    const d = above(x, y, z);
    if (d !== null && d <= 0 && prevD !== null && prevD > 0) {
      let a = prevT, b = t;
      for (let i = 0; i < 8; i++) {
        const m = (a + b) * 0.5;
        const md = above(origin.x + dir.x * m, origin.y + dir.y * m, origin.z + dir.z * m);
        if (md !== null && md <= 0) b = m; else a = m;
      }
      const hx = origin.x + dir.x * b, hz = origin.z + dir.z * b;
      const lv = f.levelAt(hx, hz);
      return { x: hx, z: hz, y: lv ?? origin.y + dir.y * b, dist: b };
    }
    // Only a real "above water" sample may open a bracket; null (off-mesh)
    // resets it, so a ray that dips underground between two lakes cannot
    // report a hit on the far one's surface through the hill.
    prevT = t; prevD = d;
    t += clamp(0.6 + t * 0.045, 0.6, 6.0);
  }
  return null;
}

/** sdf and its gradient at (x, z), via world.getHydro. Central differences at
 *  1.5 m — under the field's own 4 m texel, so the gradient is the bilinear
 *  patch's, which is exactly the surface the snap is walking on. */
export function sdfGrad(world, x, z, out = {}) {
  const e = 1.5;
  const h = world.getHydro(x, z);
  const xr = world.getHydro(x + e, z).sdf, xl = world.getHydro(x - e, z).sdf;
  const zr = world.getHydro(x, z + e).sdf, zl = world.getHydro(x, z - e).sdf;
  let gx = (xr - xl) / (2 * e), gz = (zr - zl) / (2 * e);
  const m = Math.hypot(gx, gz);
  if (m > 1e-6) { gx /= m; gz /= m; }
  out.sdf = h.sdf; out.span = h.span; out.wet = h.wet;
  out.gx = gx; out.gz = gz;                     // unit, pointing INTO the water
  return out;
}

/**
 * Walk a point to sdf ≈ `target` metres inside the waterline. |∇sdf| = 1 by
 * construction, so p -= (sdf(p) - target) · ∇sdf is a Newton step; three of
 * them land within centimetres of the 4 m field's own precision.
 * Returns { x, z, gx, gz } — the gradient is kept because the bow heading is
 * derived from it (pointing into open water).
 */
export function shoreSnap(world, x, z, target = LAUNCH_SDF) {
  let px = x, pz = z, g = null;
  for (let i = 0; i < 3; i++) {
    g = sdfGrad(world, px, pz);
    if (Math.abs(g.gx) + Math.abs(g.gz) < 1e-5) break;   // flat field: give up
    const step = g.sdf - target;
    px -= step * g.gx;
    pz -= step * g.gz;
  }
  g = sdfGrad(world, px, pz);
  return { x: px, z: pz, gx: g.gx, gz: g.gz, sdf: g.sdf };
}

/**
 * How much floatable water lies ACROSS the current at (x, z), in metres.
 *
 * Perpendicular to the flow, not to the sdf gradient: on a river the gradient
 * points at the nearer bank and its direction is degenerate on the channel's
 * medial axis, so a width measured along it is neither the channel's width nor
 * stable. The flow vector is splatted from the smoothed centreline and blurred
 * (TerrainGen._flowField), so it is smooth by construction — and where it has
 * no direction to give, the shoreline normal is the right fallback anyway.
 *
 * Floatable means the DRAWN water is deeper than the hull's draft plus a
 * margin, matching what BoatPhysics will actually let the boat enter. Walks
 * out in half-metre steps and stops at the first sample that fails, so an
 * island or a gravel bar splits the channel honestly rather than being
 * measured through.
 */
export function floatWidth(world, x, z, floatDepth, gx = 0, gz = 0, max = 60) {
  const f = world.getFlow ? world.getFlow(x, z, {}) : null;
  const coh = f ? Math.hypot(f.vx, f.vz) : 0;
  let nx, nz;
  if (coh > 1e-3) { nx = -f.vz / coh; nz = f.vx / coh; }
  else { nx = -gz; nz = gx; }
  if (!(Math.abs(nx) + Math.abs(nz) > 1e-6)) return 0;
  const wet = (px, pz) => {
    const lv = world._water?.levelAt?.(px, pz) ?? world.getWaterHeight(px, pz);
    if (lv === null || lv === undefined) return false;
    return lv - world.getHeight(px, pz) >= floatDepth;
  };
  let width = 0;
  for (const sgn of [1, -1]) {
    let reach = 0;
    for (let d = 0.5; d <= max; d += 0.5) {
      if (!wet(x + nx * sgn * d, z + nz * sgn * d)) break;
      reach = d;
    }
    width += reach;
  }
  return width;
}

/**
 * Can a boat be launched at (or near) this clicked point?
 *
 * Snaps to the shore first, then judges the SNAPPED point — the click only has
 * to be roughly at the water's edge. Returns
 * `{ ok, reason, x, z, y, heading, river }`; x/z/y/heading are the beached
 * pose. On a lake the bow points into open water (up the sdf gradient); on a
 * river it points DOWNSTREAM instead — a 4.2 m hull set down square across a
 * channel is both the wrong pose to start paddling from and the one that reads
 * worst from the bank.
 *
 * `kind` selects the rule set: rivers take a kayak only (see RIVER_KIND).
 * Passing null skips that hull rule and asks only whether the WATER is
 * launchable, which is what a site-scouting harness wants; the player path
 * always names the hull.
 *
 * @param kind  'canoe' | 'kayak', or null to skip the hull rule.
 * @param floatDepth  m of water the hull needs to float; defaults to a kayak's.
 */
export function validateLaunch(world, cx, cz, veh = null, kind = null,
                               floatDepth = 0.26) {
  const out = { ok: false, reason: '', x: cx, z: cz, y: 0, heading: 0, river: 0 };
  if (!Number.isFinite(cx) || !Number.isFinite(cz)) { out.reason = 'nowhere'; return out; }
  if (!world.isInBounds(cx, cz)) { out.reason = 'out of bounds'; return out; }

  const s = shoreSnap(world, cx, cz);
  out.x = s.x; out.z = s.z;
  out.heading = Math.atan2(s.gx, s.gz);          // bow into open water

  const lv = world._water?.levelAt?.(s.x, s.z) ?? world.getWaterHeight(s.x, s.z);
  if (lv === null || lv === undefined) { out.reason = 'no water here'; return out; }
  out.y = lv;

  const riverAt = world.getRiver(s.x, s.z);
  out.river = riverAt;

  if (riverAt > MAX_RIVER) {
    // ── flowing water ────────────────────────────────────────────────────────
    // Its own rules; the span gate below is meaningless here and would refuse
    // 96% of the map's riverbank. See the note on RIVER_MIN_WIDTH.
    if (kind && kind !== RIVER_KIND) {
      out.reason = `only a ${RIVER_KIND} can run a river`;
      return out;
    }
    const f = world.getFlow ? world.getFlow(s.x, s.z, {}) : null;
    if (f && f.turb > RIVER_MAX_TURB) { out.reason = 'that water is too rough'; return out; }
    const wide = floatWidth(world, s.x, s.z, floatDepth, s.gx, s.gz);
    if (wide < RIVER_MIN_WIDTH) { out.reason = 'the channel is too narrow'; return out; }
    // Bow downstream, where the flow field has a direction to give. Its
    // magnitude is a coherence, so a slack pocket falls back to the shoreline
    // normal rather than pointing the boat at noise.
    const coh = f ? Math.hypot(f.vx, f.vz) : 0;
    if (coh > 0.12) out.heading = Math.atan2(f.vx, f.vz);
  } else {
    // ── standing water ───────────────────────────────────────────────────────
    // Openness, probed into the water the bow points at — see MIN_SPAN.
    const open = world.getHydro(s.x + s.gx * SPAN_PROBE, s.z + s.gz * SPAN_PROBE);
    if (open.span < MIN_SPAN) { out.reason = 'not enough open water'; return out; }
    // No depth gate. Big lakes shelve gently, so the snapped point is often the
    // shallowest water in sight and a depth test there refused giant lakes
    // ("too shallow" on a 40 m span — the user's screenshot). Span already
    // rejects puddles, and the physics beaches a hull gracefully in shallows,
    // so the honest question is only "is the body of water large enough".
  }

  // The distance gate runs LAST, so "too far from the camper" always means
  // "drive closer and this works" — the honest prompt, and it makes a
  // refusal's reason strictly more useful to a site-scouting harness.
  if (veh) {
    const d = Math.hypot(s.x - veh.position.x, s.z - veh.position.z);
    if (d > MAX_LAUNCH_DIST) { out.reason = 'too far from the camper'; return out; }
  }

  out.ok = true;
  return out;
}
