/**
 * Find stars the field CUTS.
 *
 * skStars decides whether a cell holds a star with `if (ha.z > fill) continue`,
 * and `fill` is evaluated at the FRAGMENT's direction — the clump fbm and the
 * Milky Way boost are both functions of `dir`. So the test is not a property of
 * the star: it flips as the eye moves across the sky, and where it flips the
 * star is switched off along a contour that runs through its own disc.
 *
 * This walks cells, evaluates the same test at the star's own direction and on
 * a ring around it, and reports the bright ones where the answer disagrees.
 *
 *   node tools/_scratch/starcut.mjs
 */
import { fbm, milkyWay, faceUV } from './starfieldjs.mjs';

const CELLS = 42.0, FILL = 0.210, FILL_MW = 1.20, CLUMP = 0.85;
const MAG_MIN = 0.0552, MAG_SLOPE = 1.7, MAG_MAX = 1.5525;
const fract = (x) => x - Math.floor(x);
function hash33(px, py, pz) {
  let x = fract(px * 0.1031), y = fract(py * 0.1030), z = fract(pz * 0.0973);
  const d = x * (y + 33.33) + y * (x + 33.33) + z * (z + 33.33);
  x += d; y += d; z += d;
  return [fract((x + y) * z), fract((x + x) * y), fract((y + x) * x)];
}
// (u, v, face) -> unit direction. The inverse of skFaceUV.
function dirOf(u, v, f) {
  const ru = Math.tan(u * Math.PI / 4), rv = Math.tan(v * Math.PI / 4);
  let d;
  if (f === 0) d = [1, rv, ru]; else if (f === 1) d = [-1, rv, ru];
  else if (f === 2) d = [ru, 1, rv]; else if (f === 3) d = [ru, -1, rv];
  else if (f === 4) d = [ru, rv, 1]; else d = [ru, rv, -1];
  const l = Math.hypot(...d);
  return d.map((c) => c / l);
}
const fillAt = (d) => {
  const cl = fbm(d[0] * 5 + 61, d[1] * 5 + 61, d[2] * 5 + 61);
  return (FILL + FILL_MW * milkyWay(d)) * (1 + ((0.22 + 2.60 * cl * cl) - 1) * CLUMP);
};

const hits = [];
for (let f = 0; f < 6; f++) {
  for (let cy = -CELLS; cy < CELLS; cy++) {
    for (let cx = -CELLS; cx < CELLS; cx++) {
      const ha = hash33(cx, cy, f * 53 + 7);
      const hb = hash33((f * 53 + 7) * 1.37 + 21.7, cx * 1.37 + 21.7, cy * 1.37 + 21.7);
      const amp = Math.min(MAG_MIN * Math.pow(Math.max(hb[0], 1e-4), -1 / MAG_SLOPE), MAG_MAX);
      const m = Math.min(Math.max((amp - MAG_MIN) / (MAG_MAX - MAG_MIN), 0), 1);
      if (m < parseFloat(process.env.MMIN ?? "0.25")) continue;                       // only stars big enough to see cut
      const su = (cx + 0.06 + 0.88 * ha[0]) / CELLS, sv = (cy + 0.06 + 0.88 * ha[1]) / CELLS;
      const sd = dirOf(su, sv, f);
      const at = fillAt(sd) > ha[2];                // is the star on at its own centre?
      // The halo reaches ~0.85 cells; sample a ring at that radius.
      let flips = 0;
      for (let k = 0; k < 12; k++) {
        const a = k * Math.PI / 6, R = 0.85 / CELLS;
        const d = dirOf(su + R * Math.cos(a), sv + R * Math.sin(a), f);
        if ((fillAt(d) > ha[2]) !== at) flips++;
      }
      if (flips === 0) continue;
      const el = Math.asin(sd[1]) * 180 / Math.PI, az = Math.atan2(sd[0], sd[2]) * 180 / Math.PI;
      hits.push({ f, cx, cy, m, amp, flips, on: at, az, el });
    }
  }
}
hits.sort((a, b) => b.m - a.m);
console.log(`${hits.length} bright stars (m>0.25) are cut by the fill contour`);
for (const h of hits.slice(0, 15)) {
  console.log(`  m ${h.m.toFixed(2)} amp ${h.amp.toFixed(2)} face ${h.f} cell ${h.cx},${h.cy} ` +
              `${h.on ? 'on at centre' : 'OFF at centre'} ${h.flips}/12 ring flips  ` +
              `az ${h.az.toFixed(2)} el ${h.el.toFixed(2)}`);
}
const up = hits.filter((h) => h.el > 5);
console.log(`${up.length} of them are above 5 deg elevation`);
