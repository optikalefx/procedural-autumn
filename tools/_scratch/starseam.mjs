/**
 * Find bright stars sitting on a cube-face seam.
 *
 * skStars indexes cells in the fragment's OWN face. A face is 2*SK_CELLS cells
 * across, so the seam falls exactly on a cell boundary and no cell straddles
 * it — but a star's halo does. Every star within a halo radius of an edge is
 * therefore drawn on one side of the seam and missing on the other.
 *
 *   node tools/_scratch/starseam.mjs
 */
import { fbm, milkyWay } from './starfieldjs.mjs';

const CELLS = 42.0, FILL = 0.210, FILL_MW = 1.20, CLUMP = 0.85;
const MAG_MIN = 0.0552, MAG_SLOPE = 1.7, MAG_MAX = 1.5525;
const fract = (x) => x - Math.floor(x);
function hash33(px, py, pz) {
  let x = fract(px * 0.1031), y = fract(py * 0.1030), z = fract(pz * 0.0973);
  const d = x * (y + 33.33) + y * (x + 33.33) + z * (z + 33.33);
  x += d; y += d; z += d;
  return [fract((x + y) * z), fract((x + x) * y), fract((y + x) * x)];
}
function dirOf(u, v, f) {
  const ru = Math.tan(u * Math.PI / 4), rv = Math.tan(v * Math.PI / 4);
  let d;
  if (f === 0) d = [1, rv, ru]; else if (f === 1) d = [-1, rv, ru];
  else if (f === 2) d = [ru, 1, rv]; else if (f === 3) d = [ru, -1, rv];
  else if (f === 4) d = [ru, rv, 1]; else d = [ru, rv, -1];
  const l = Math.hypot(...d);
  return d.map((c) => c / l);
}

// The shipped gate: sampled at the star, at full night (mwVis 1).
const fillAt = (d) => {
  const cl = fbm(d[0] * 5 + 61, d[1] * 5 + 61, d[2] * 5 + 61);
  return (FILL + FILL_MW * milkyWay(d)) * (1 + ((0.22 + 2.60 * cl * cl) - 1) * CLUMP);
};

const hits = [];
for (let f = 0; f < 6; f++) {
  for (let cy = -CELLS; cy < CELLS; cy++) {
    for (let cx = -CELLS; cx < CELLS; cx++) {
      // Only the border ring can reach across a seam.
      const near = Math.min(cx + CELLS, CELLS - 1 - cx, cy + CELLS, CELLS - 1 - cy);
      if (near > 0) continue;
      const ha = hash33(cx, cy, f * 53 + 7);
      const hb = hash33((f * 53 + 7) * 1.37 + 21.7, cx * 1.37 + 21.7, cy * 1.37 + 21.7);
      const amp = Math.min(MAG_MIN * Math.pow(Math.max(hb[0], 1e-4), -1 / MAG_SLOPE), MAG_MAX);
      const m = Math.min(Math.max((amp - MAG_MIN) / (MAG_MAX - MAG_MIN), 0), 1);
      if (m < 0.25) continue;
      const su = (cx + 0.06 + 0.88 * ha[0]) / CELLS, sv = (cy + 0.06 + 0.88 * ha[1]) / CELLS;
      // Distance to the seam, in cells. The halo reaches ~0.85.
      const gap = Math.min(CELLS - Math.abs(su * CELLS), CELLS - Math.abs(sv * CELLS));
      if (gap > 0.85) continue;
      const sd = dirOf(su, sv, f);
      if (ha[2] > fillAt(sd)) continue;          // the cell holds no star
      const el = Math.asin(sd[1]) * 180 / Math.PI, az = Math.atan2(sd[0], sd[2]) * 180 / Math.PI;
      // Distance to the nearest cube CORNER, where a third face meets the two
      // this seam joins and the neighbour pass cannot reach.
      const corner = Math.hypot(CELLS - Math.abs(su * CELLS), CELLS - Math.abs(sv * CELLS));
      hits.push({ f, cx, cy, m, gap, corner, az, el });
    }
  }
}
hits.sort((a, b) => a.gap - b.gap || b.m - a.m);
const nearCorner = hits.filter((h) => h.corner < 0.85);
console.log(`${nearCorner.length} of them are within 0.85 cells of a cube corner` +
            (nearCorner.length ? ': ' + nearCorner.map((h) => `m ${h.m.toFixed(2)} at az ${h.az.toFixed(1)} el ${h.el.toFixed(1)}`).join(', ') : ''));
console.log(`${hits.length} stars of m > 0.25 sit within a halo radius of a face seam ` +
            `(${hits.filter((h) => h.el > 5).length} above 5 deg)`);
for (const h of hits.filter((x) => x.el > 5).slice(0, 12)) {
  console.log(`  m ${h.m.toFixed(2)} face ${h.f} cell ${h.cx},${h.cy}  ` +
              `${h.gap.toFixed(3)} cells from the seam  az ${h.az.toFixed(2)} el ${h.el.toFixed(2)}`);
}
