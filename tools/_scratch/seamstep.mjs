/**
 * How far the star field jumps when a sightline crosses a cube-face seam.
 *
 * Walks points along every seam and evaluates the field a hair either side of
 * it. A field with nothing to hide steps by nothing; the number this prints is
 * the size of the hardest edge a viewer could find on a seam.
 *
 *   node tools/_scratch/seamstep.mjs [samples]
 */
import { starsNow } from './starfieldjs.mjs';

const N = parseInt(process.argv[2] ?? '4000', 10);
// In face-uv units. It has to be far under a core radius (0.03 cells is
// 7e-4 of a face) or a star sitting on the seam is measured as a jump when
// what was sampled is its own gradient.
const EPS = 1e-6;
const PX = 0.02;           // pixel footprint in cells, i.e. a magnified view

const cellDirRaw = (u, v, f) => {
  const ru = Math.tan(u * Math.PI / 4), rv = Math.tan(v * Math.PI / 4);
  let d;
  if (f === 0) d = [1, rv, ru]; else if (f === 1) d = [-1, rv, ru];
  else if (f === 2) d = [ru, 1, rv]; else if (f === 3) d = [ru, -1, rv];
  else if (f === 4) d = [ru, rv, 1]; else d = [ru, rv, -1];
  const l = Math.hypot(...d);
  return d.map((c) => c / l);
};

for (const seams of [false, true]) {
  let worst = 0, worstAt = null, over = 0;
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let k = 0; k < N; k++) {
    const f = Math.floor(rnd() * 6);
    // Optionally keep clear of the cube corners, where three faces meet.
    const span = process.argv.includes('--corners') ? 1.0 : 1.0 - 3.0 / 42.0;
    const along = (rnd() * 2 - 1) * span;
    const edge = rnd() < 0.5 ? 1 : -1;
    const onU = rnd() < 0.5;
    for (const side of [-1, 1]) {
      const off = edge * (1 + side * EPS);
      const d = onU ? cellDirRaw(off, along, f) : cellDirRaw(along, off, f);
      const v = starsNow(d, PX, 1, seams);
      if (side === -1) { var inside = v; } else {
        const step = Math.abs(v - inside);
        if (step > 0.0005) over++;
        if (step > worst) { worst = step; worstAt = { f, along: +along.toFixed(4), onU, edge }; }
      }
    }
  }
  console.log(`${process.argv.includes('--corners') ? 'corners included ' : 'corners excluded '}` +
              `${seams ? 'with seam passes ' : 'without (old)    '} ` +
              `worst step ${worst.toFixed(4)}  over 0.0005: ${over}/${N}` +
              (worstAt ? `  worst at face ${worstAt.f} ${worstAt.onU ? 'u' : 'v'} edge ${worstAt.edge}` : ''));
}
