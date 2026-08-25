// ─────────────────────────────────────────────────────────────────────────────
//  loft_smooth — the Catmull-Rom station resampler every lofted animal uses.
//
//  Four files author their models as a handful of stations along a centreline
//  and sweep a ring round each one. Straight chords between the keys are what
//  makes a loft read as a stack of welded plates, and no amount of extra
//  radial sides fixes a profile that is piecewise linear along its own LENGTH.
//  So each of them rounds the path between the keys first — the mammals
//  (animal_species.js, `smoothStations`, station objects), the owl and the
//  eagle (numeric tuples), the waders (water_birds.js's `crSample`, which
//  keeps a 0..1 parameter alongside each row).
//
//  Three shapes of the same spline, so the polynomial lives here once and the
//  callers keep their own shape of station.
//
//  What this is NOT: smooth shading. Every bird and mammal in the tree is flat
//  shaded and stays that way — the material derives the real normal per pixel
//  from the derivative, and that is the house style. What resampling buys is
//  SMALLER facets, never smoother ones.
// ─────────────────────────────────────────────────────────────────────────────

/** Catmull-Rom through four scalars. */
export function crom(a, b, c, d, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * b) + (-a + c) * t
    + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
}

/**
 * `smoothStations` for plain numeric tuples: `factor - 1` interpolated
 * stations between each authored pair, every column following a Catmull-Rom
 * through the keys rather than the straight chord. The authored stations pass
 * through untouched — they are the art; this only rounds the path between
 * them, which is the entire difference between a loft that reads as a curve
 * and one that reads as a stack of plates.
 *
 * Rows must all be the same length; every column is splined, so anything a
 * caller wants left alone (a colour, an index) has to live outside the tuple.
 * Colour by a FUNCTION OF POSITION rather than of station index for the same
 * reason: an index-keyed ramp moves when the density changes, and a mottle
 * keyed on the index turns into a shimmer.
 */
export function smoothTuples(src, factor) {
  if (factor <= 1 || src.length < 2) return src;
  const out = [];
  for (let i = 0; i < src.length - 1; i++) {
    const p0 = src[Math.max(0, i - 1)], p1 = src[i];
    const p2 = src[i + 1], p3 = src[Math.min(src.length - 1, i + 2)];
    out.push(p1);
    for (let k = 1; k < factor; k++) {
      const t = k / factor;
      out.push(p1.map((_, f) => crom(p0[f], p1[f], p2[f], p3[f], t)));
    }
  }
  out.push(src[src.length - 1]);
  return out;
}
