// ─────────────────────────────────────────────────────────────────────────────
//  boat_site — where a boat may be launched, and where the click snaps to.
//
//  Three jobs:
//    · waterRay       — march the pointer ray against the DRAWN water surface
//                       (world._water.levelAt), mirroring groundRay's structure.
//    · shoreSnap      — walk a clicked point to a fixed signed distance inside
//                       the waterline using the hydro sdf (|∇sdf| = 1, so a
//                       Newton step lands almost exactly).
//    · validateLaunch — is this water a boat can live on: a LAKE (not a river),
//                       open enough, deep enough.
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
// `span` is the hydro field's openness in metres (a thread of river reads ~1,
// a lake saturates at 48). 14 m of open water is a pond you can actually turn
// a canoe around on; less is a puddle or a channel.
//
// MEASURED, not sampled at the beached point itself: span is the mean inside
// distance over 12 m, so AT the waterline half its probes look at land and
// even the big lakes read ~5.5 there (probed on seed 20261018: shoreline span
// tops out at 5.6 across 903 launch-band points). The honest question is "is
// there a lake in front of the bow", so span is read SPAN_PROBE metres into
// the water along the sdf gradient — where the same probe reads 17-41 on
// lakes and 0.3-5.6 on every river bank tested.
export const MIN_SPAN = 14;
export const SPAN_PROBE = 14;
// Standing water only. getRiver is the baked river mask; anything flowing is
// the river system's water, and a boat on it would need a current model this
// feature does not have.
export const MAX_RIVER = 0.05;
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
 * Can a boat be launched at (or near) this clicked point?
 *
 * Snaps to the shore first, then judges the SNAPPED point — the click only has
 * to be roughly at the water's edge. Returns
 * `{ ok, reason, x, z, y, heading }`; x/z/y/heading are the beached pose
 * (heading = bow pointing into open water, i.e. up the sdf gradient).
 */
export function validateLaunch(world, cx, cz, veh = null) {
  const out = { ok: false, reason: '', x: cx, z: cz, y: 0, heading: 0 };
  if (!Number.isFinite(cx) || !Number.isFinite(cz)) { out.reason = 'nowhere'; return out; }
  if (!world.isInBounds(cx, cz)) { out.reason = 'out of bounds'; return out; }

  const s = shoreSnap(world, cx, cz);
  out.x = s.x; out.z = s.z;
  out.heading = Math.atan2(s.gx, s.gz);          // bow into open water

  const lv = world._water?.levelAt?.(s.x, s.z) ?? world.getWaterHeight(s.x, s.z);
  if (lv === null || lv === undefined) { out.reason = 'no water here'; return out; }
  out.y = lv;

  // Openness, probed into the water the bow points at — see MIN_SPAN.
  const open = world.getHydro(s.x + s.gx * SPAN_PROBE, s.z + s.gz * SPAN_PROBE);
  if (open.span < MIN_SPAN) { out.reason = 'not enough open water'; return out; }
  if (world.getRiver(s.x, s.z) > MAX_RIVER) { out.reason = 'the river is too fast'; return out; }
  // No depth gate. Big lakes shelve gently, so the snapped point is often the
  // shallowest water in sight and a depth test there refused giant lakes
  // ("too shallow" on a 40 m span — the user's screenshot). Span already
  // rejects puddles, and the physics beaches a hull gracefully in shallows,
  // so the honest question is only "is the body of water large enough".

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
