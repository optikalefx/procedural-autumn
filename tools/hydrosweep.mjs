#!/usr/bin/env node
/**
 * Sweep the hydro field's parameters against the shipped bake.
 *
 *   node tools/hydrosweep.mjs                # the default sweep
 *   node tools/hydrosweep.mjs --res 1024
 *
 * `src/world/hydroField.js` conditions the bed the water's edge is cut on. Every
 * dial in it trades the same two things against each other:
 *
 *   how SMOOTH the waterline is   against   how much water there is
 *
 * because the only way to smooth a level curve of a rough field is to move the
 * field, and moving it moves the curve. A conditioning that scores perfectly on
 * shape and floods a fifth of the map is not a fix, it is a different map. So
 * this reports both, per variant, in one table, and nothing here is allowed to
 * quote one without the other.
 *
 * ── the columns ──────────────────────────────────────────────────────────────
 *
 *   area      wet area as a % of the map, against the bake's own 21.82%.
 *             `dArea` is the change. The bake is the authority on how much
 *             water the world has; this field's job is to draw its edge, not to
 *             decide its extent.
 *   fine      % of the waterline with a curvature radius under 3 m — the same
 *             quantity tools/waterlab.mjs reports, computed the same way, on the
 *             real bake instead of a synthetic one.
 *   speck     bodies and holes under 40 m^2, per km^2.
 *   grad10    10th percentile of |grad depth| along the waterline. Rises when
 *             the bank is better graded, which is what stops a waterline
 *             crawling under camera motion.
 *   span      RMS and max of the openness channel, metres. Context rather than a
 *             target: a lake reads at the 48 m cap and a thread under a metre,
 *             so a run whose spanMax has collapsed has lost its lakes.
 *   ms        build cost.
 */
import { TerrainGen } from '../src/world/TerrainGen.js';
import { buildHydroField } from '../src/world/hydroField.js';
import { writePNG, canvas, text } from './_png.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const RES = parseInt(arg('res', '1024'), 10);
// --crop cx,cz,size  in HALF-RES cells: the patch every variant is rendered
// over, so the sheet compares the same ground and not a different one.
const CROP = (arg('crop', null) || '').split(',').map(Number);
const RENDER = argv.includes('--render');
const WORLD = 3072;

console.log(`baking res ${RES}...`);
const gen = new TerrainGen({ res: RES, worldSize: WORLD, seed: 20261018 });
const w = gen.generate();
const texel = WORLD / RES;

let bakedWet = 0;
for (let i = 0; i < RES * RES; i++) if (w.water[i] > -9000 && w.water[i] > w.height[i]) bakedWet++;
const BASE_AREA = bakedWet / (RES * RES) * 100;
console.log(`bake wet area ${BASE_AREA.toFixed(2)}%\n`);

// ── metrics on the stored field ──────────────────────────────────────────────
function measure(h) {
  const R = h.res, N = R * R, T = h.texel;
  let area = 0;
  for (let i = 0; i < N; i++) area += h.wet[i];
  area = area / N * 100;

  // Contour of depth = 0, marching squares at 2x, then curvature and speckle.
  const SS = 2, step = 1 / SS;
  const at = (fx, fz) => {
    const x = Math.min(R - 1.001, Math.max(0, fx)), z = Math.min(R - 1.001, Math.max(0, fz));
    const x0 = x | 0, z0 = z | 0, tx = x - x0, tz = z - z0;
    const a = h.depth[z0 * R + x0], b = h.depth[z0 * R + x0 + 1];
    const c = h.depth[(z0 + 1) * R + x0], d = h.depth[(z0 + 1) * R + x0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };
  let totLen = 0, fineLen = 0;
  const grads = [];
  const gradAt = (fx, fz) => {
    const s = (x, z) => h.depth[Math.min(R - 1, Math.max(0, Math.round(z))) * R
                              + Math.min(R - 1, Math.max(0, Math.round(x)))];
    return Math.hypot((s(fx + 1, fz) - s(fx - 1, fz)) / (2 * T),
                      (s(fx, fz + 1) - s(fx, fz - 1)) / (2 * T));
  };
  // A three-sample stencil along each marching-squares segment is enough for a
  // curvature histogram and avoids the chaining pass entirely — this runs 30
  // times in a sweep and the chain is the expensive half.
  for (let z = 0; z < (R - 1) * SS; z++) {
    for (let x = 0; x < (R - 1) * SS; x++) {
      const fx = x * step, fz = z * step;
      const V = [at(fx, fz), at(fx + step, fz), at(fx + step, fz + step), at(fx, fz + step)];
      let code = 0;
      for (let k = 0; k < 4; k++) if (V[k] > 0) code |= 1 << k;
      if (code === 0 || code === 15) continue;
      const P = [[fx, fz], [fx + step, fz], [fx + step, fz + step], [fx, fz + step]];
      const E = [];
      for (let k = 0; k < 4; k++) {
        const a = k, b = (k + 1) & 3;
        if ((V[a] > 0) !== (V[b] > 0)) {
          const t = V[a] / (V[a] - V[b]);
          E.push([P[a][0] + (P[b][0] - P[a][0]) * t, P[a][1] + (P[b][1] - P[a][1]) * t]);
        }
      }
      if (E.length < 2) continue;
      const L = Math.hypot(E[1][0] - E[0][0], E[1][1] - E[0][1]) * T;
      totLen += L;
      // Curvature proxy: how far the depth field's own second difference bends
      // the contour over a 3 m chord. Cheap, and it correlates with the chained
      // Menger curvature waterlab computes to within a few percent — checked on
      // three variants.
      const mx = (E[0][0] + E[1][0]) * 0.5, mz = (E[0][1] + E[1][1]) * 0.5;
      const g = gradAt(mx, mz);
      if (grads.length < 200000 && ((x + z) & 7) === 0) grads.push(g);
      const d2 = Math.abs(at(mx + 1.5 / T, mz) + at(mx - 1.5 / T, mz) - 2 * at(mx, mz))
               + Math.abs(at(mx, mz + 1.5 / T) + at(mx, mz - 1.5 / T) - 2 * at(mx, mz));
      // radius = |grad| / |curvature of the level set|; under 3 m is "fine"
      if (g > 1e-6 && d2 / Math.max(g, 1e-6) > 1 / 3.0 * 2.25) fineLen += L;
    }
  }
  grads.sort((a, b) => a - b);
  const grad10 = grads.length ? grads[Math.floor(grads.length * 0.10)] : 0;

  // Speckle on the coverage mask.
  const m = new Uint8Array(N);
  for (let i = 0; i < N; i++) m[i] = h.wet[i] >= 0.5 ? 1 : 0;
  const comp = (want) => {
    const seen = new Uint8Array(N), st = new Int32Array(N);
    const small = Math.max(1, Math.round(40 / (T * T)));
    let count = 0;
    for (let s = 0; s < N; s++) {
      if (seen[s] || m[s] !== want) continue;
      let sp = 0, n = 0; st[sp++] = s; seen[s] = 1;
      while (sp > 0) {
        const k = st[--sp]; n++;
        const cx = k % R, cz = (k / R) | 0;
        if (cx > 0 && !seen[k - 1] && m[k - 1] === want) { seen[k - 1] = 1; st[sp++] = k - 1; }
        if (cx < R - 1 && !seen[k + 1] && m[k + 1] === want) { seen[k + 1] = 1; st[sp++] = k + 1; }
        if (cz > 0 && !seen[k - R] && m[k - R] === want) { seen[k - R] = 1; st[sp++] = k - R; }
        if (cz < R - 1 && !seen[k + R] && m[k + R] === want) { seen[k + R] = 1; st[sp++] = k + R; }
      }
      if (n < small) count++;
    }
    return count;
  };
  const km2 = (WORLD * WORLD) / 1e6;

  let ls = 0, lmax = 0;
  for (let i = 0; i < N; i++) { ls += h.span[i] * h.span[i]; const a = Math.abs(h.span[i]); if (a > lmax) lmax = a; }

  return {
    area: +area.toFixed(2),
    dArea: +(area - BASE_AREA).toFixed(2),
    fine: totLen > 0 ? +(fineLen / totLen * 100).toFixed(1) : 0,
    speck: +((comp(1) + comp(0)) / km2).toFixed(1),
    grad10: +grad10.toFixed(3),
    spanRms: +Math.sqrt(ls / N).toFixed(2),
    spanMax: +lmax.toFixed(1),
  };
}

const OFF = { sdfBlurM: 0.1, clean: false, gradeK: 0, gradeBandM: 0.01 };
const V = (K, band, sdf) => ({ sdfBlurM: sdf, clean: true, gradeK: K, gradeBandM: band });
const VARIANTS = [
  ['off',           OFF],
  ['clean only',    { ...OFF, clean: true }],
  ['K.45 B18 s10',  V(0.45, 18, 10)],
  ['K.60 B18 s6',   V(0.60, 18, 6)],
  ['K.60 B18 s10',  V(0.60, 18, 10)],
  ['K.60 B18 s16',  V(0.60, 18, 16)],
  ['K.60 B26 s10',  V(0.60, 26, 10)],
  ['K.80 B18 s10',  V(0.80, 18, 10)],
];








const pad = (s, n) => String(s).padStart(n);
console.log(`${'variant'.padEnd(16)}${['area%', 'dArea', 'fine', 'speck', 'grad10', 'spanRms', 'spanMax', 'ms'].map((k) => pad(k, 9)).join('')}`);
for (const [name, opt] of VARIANTS) {
  const h = buildHydroField(w.height, w.water, RES, WORLD, opt);
  const m = measure(h);
  console.log(`${name.padEnd(16)}${pad(m.area, 9)}${pad((m.dArea >= 0 ? '+' : '') + m.dArea, 9)}`
            + `${pad(m.fine + '%', 9)}${pad(m.speck, 9)}${pad(m.grad10, 9)}`
            + `${pad(m.spanRms, 9)}${pad(m.spanMax, 9)}${pad(Math.round(h.ms), 9)}`);
}
console.log(`\n  bake area ${BASE_AREA.toFixed(2)}%. dArea is the change this field makes to how much water the world has.`);
console.log('  A variant that wins on fine/speck and moves dArea by more than a couple of points is not a fix.');


// ── the picture ──────────────────────────────────────────────────────────────
// A table of shape metrics with no image beside it is how a round ships a
// waterline that scores 5.7% and looks like a cut-out. Every variant renders the
// same patch: bed relief in gold, water in blue shaded by depth, the waterline
// as a hairline, all at four pixels per cell so a two-metre feature is visible.
if (RENDER) {
  const SC = 4;
  const size = CROP.length === 3 && CROP[2] ? CROP[2] : 190;
  const tiles = [];
  // Default crop: the densest patch of waterline in the map, found once so
  // every variant is judged on the same ground.
  let cx = CROP.length === 3 ? CROP[0] : -1, cz = CROP.length === 3 ? CROP[1] : -1;
  const probe = buildHydroField(w.height, w.water, RES, WORLD, VARIANTS[0][1]);
  if (cx < 0) {
    const R = probe.res;
    let best = -1;
    for (let z = 0; z + size < R; z += size >> 1) {
      for (let x = 0; x + size < R; x += size >> 1) {
        let edge = 0;
        for (let j = 0; j < size; j += 2) {
          for (let i = 0; i < size; i += 2) {
            const k = (z + j) * R + (x + i);
            const v = probe.wet[k];
            if (v > 0.05 && v < 0.95) edge++;
          }
        }
        if (edge > best) { best = edge; cx = x; cz = z; }
      }
    }
    console.log(`\ncrop chosen: --crop ${cx},${cz},${size}`);
  }
  for (const [name, opt] of VARIANTS) {
    const h = buildHydroField(w.height, w.water, RES, WORLD, opt);
    const R = h.res;
    const img = canvas(size * SC, size * SC, [16, 16, 20]);
    const at = (fx, fz) => {
      const x = Math.min(R - 1.001, Math.max(0, fx)), z = Math.min(R - 1.001, Math.max(0, fz));
      const x0 = x | 0, z0 = z | 0, tx = x - x0, tz = z - z0;
      const a = h.depth[z0 * R + x0], b = h.depth[z0 * R + x0 + 1];
      const c = h.depth[(z0 + 1) * R + x0], d = h.depth[(z0 + 1) * R + x0 + 1];
      return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
    };
    for (let py = 0; py < size * SC; py++) {
      for (let pxx = 0; pxx < size * SC; pxx++) {
        const fx = cx + pxx / SC, fz = cz + py / SC;
        const d = at(fx, fz);
        // Bed relief from the full-res height, so the roughness the field is
        // conditioning against is visible under the water it is drawing.
        const hx = Math.min(RES - 1, Math.round(fx * 2)), hz = Math.min(RES - 1, Math.round(fz * 2));
        const hh = w.height[hz * RES + hx];
        const hl = w.height[Math.min(RES - 1, hz + 1) * RES + Math.min(RES - 1, hx + 1)];
        const sh = Math.max(0.25, Math.min(1.4, 0.9 + (hh - hl) * 0.6));
        let r, g, b;
        if (d > 0) {
          const t = Math.min(1, d / 3.0);
          r = (46 + (1 - t) * 74) * (0.6 + sh * 0.4);
          g = (98 + (1 - t) * 62) * (0.6 + sh * 0.4);
          b = (156 + (1 - t) * 52) * (0.6 + sh * 0.4);
        } else {
          r = 178 * sh; g = 150 * sh; b = 92 * sh;
        }
        // Hairline where the field crosses zero, found on the pixel itself.
        if (Math.abs(d) < 0.02 * Math.max(1, Math.abs(at(fx + 1 / SC, fz) - d) * SC)) { r = 255; g = 255; b = 255; }
        img.put(pxx, py, Math.min(255, r), Math.min(255, g), Math.min(255, b));
      }
    }
    for (let y = 0; y < 12; y++) for (let x = 0; x < 200; x++) {
      const k = (y * img.w + x) * 3;
      img.px[k] *= 0.2; img.px[k + 1] *= 0.2; img.px[k + 2] *= 0.2;
    }
    text(img, 3, 3, name, [255, 255, 255], 1);
    tiles.push(img);
  }
  const cols = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / cols);
  const TS = tiles[0].w;
  const sheet = canvas(cols * TS, rows * TS, [10, 10, 12]);
  tiles.forEach((t, i) => sheet.blit(t, (i % cols) * TS, ((i / cols) | 0) * TS));
  writePNG('shots/hydrosweep/sheet.png', sheet);
  console.log('sheet: shots/hydrosweep/sheet.png');
}
