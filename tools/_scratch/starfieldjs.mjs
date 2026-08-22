/**
 * skStars(), ported to JS.
 *
 * A star field cannot be scanned for discontinuities from a screenshot: the
 * ones that matter are a fraction of a degree wide and land wherever a bright
 * star happens to be. This is the same arithmetic as src/sky/starfield.js so
 * the whole sphere can be swept offline. Keep it in step with that file — the
 * constants are copied, not imported, because the shader is a string.
 */
const CELLS = 42.0, FILL = 0.210, FILL_MW = 1.20, CLUMP = 0.85;
const MAG_MIN = 0.0552, MAG_SLOPE = 1.7, MAG_MAX = 1.5525;
const PI = Math.PI;
const fract = (x) => x - Math.floor(x);

function hash33(px, py, pz) {
  let x = fract(px * 0.1031), y = fract(py * 0.1030), z = fract(pz * 0.0973);
  const d = x * (y + 33.33) + y * (x + 33.33) + z * (z + 33.33);
  x += d; y += d; z += d;
  return [fract((x + y) * z), fract((x + x) * y), fract((y + x) * x)];
}
function vn(px, py, pz) {
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  let fx = px - ix, fy = py - iy, fz = pz - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const h = (a, b, c) => hash33(ix + a, iy + b, iz + c)[0];
  const mix = (a, b, t) => a + (b - a) * t;
  return mix(mix(mix(h(0, 0, 0), h(1, 0, 0), fx), mix(h(0, 1, 0), h(1, 1, 0), fx), fy),
             mix(mix(h(0, 0, 1), h(1, 0, 1), fx), mix(h(0, 1, 1), h(1, 1, 1), fx), fy), fz);
}
export function fbm(x, y, z) {
  return 0.54 * vn(x, y, z) + 0.27 * vn(x * 2.17 + 11.3, y * 2.17 + 11.3, z * 2.17 + 11.3)
       + 0.19 * vn(x * 4.63 + 27.1, y * 4.63 + 27.1, z * 4.63 + 27.1);
}
export function faceUVAxis(d, axis) {
  let u, v, f;
  if (axis === 0)      { u = d[2] / Math.max(Math.abs(d[0]), 1e-5); v = d[1] / Math.max(Math.abs(d[0]), 1e-5); f = d[0] > 0 ? 0 : 1; }
  else if (axis === 1) { u = d[0] / Math.max(Math.abs(d[1]), 1e-5); v = d[2] / Math.max(Math.abs(d[1]), 1e-5); f = d[1] > 0 ? 2 : 3; }
  else                 { u = d[0] / Math.max(Math.abs(d[2]), 1e-5); v = d[1] / Math.max(Math.abs(d[2]), 1e-5); f = d[2] > 0 ? 4 : 5; }
  return [Math.atan(u) * (4 / PI), Math.atan(v) * (4 / PI), f];
}
export function domAxis(d) {
  const a = [Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])];
  return (a[0] >= a[1] && a[0] >= a[2]) ? 0 : (a[1] >= a[2] ? 1 : 2);
}

export function faceUV(d) {
  const a = [Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])];
  let u, v, f;
  if (a[0] >= a[1] && a[0] >= a[2]) { u = d[2] / Math.max(a[0], 1e-5); v = d[1] / Math.max(a[0], 1e-5); f = d[0] > 0 ? 0 : 1; }
  else if (a[1] >= a[2])           { u = d[0] / Math.max(a[1], 1e-5); v = d[2] / Math.max(a[1], 1e-5); f = d[1] > 0 ? 2 : 3; }
  else                             { u = d[0] / Math.max(a[2], 1e-5); v = d[1] / Math.max(a[2], 1e-5); f = d[2] > 0 ? 4 : 5; }
  return [Math.atan(u) * (4 / PI), Math.atan(v) * (4 / PI), f];
}
const MW_POLE = (() => { const p = [0.720, 0.500, -0.480]; const l = Math.hypot(...p); return p.map((c) => c / l); })();
export function milkyWay(d) {
  const b = d[0] * MW_POLE[0] + d[1] * MW_POLE[1] + d[2] * MW_POLE[2];
  const al = [d[0] - MW_POLE[0] * b, d[1] - MW_POLE[1] * b, d[2] - MW_POLE[2] * b];
  const core = Math.exp(-(b * b) / (2 * 0.1 * 0.1));
  const wide = Math.exp(-(b * b) / (2 * 0.255 * 0.255));
  const band = 0.66 * core + 0.34 * wide;
  const q1 = al.map((c, i) => c * 3.20 + MW_POLE[i] * b * 5.0);
  const lobes = fbm(q1[0] + 4, q1[1] + 4, q1[2] + 4);
  const lane = b - 0.038 - 0.070 * (fbm(al[0] * 1.6 + 31, al[1] * 1.6 + 31, al[2] * 1.6 + 31) - 0.5);
  const rift = 1 - 0.62 * Math.exp(-(lane * lane) / (2 * 0.042 * 0.042));
  return Math.min(Math.max(band * (0.35 + 1.00 * lobes) * rift, 0), 1);
}

/** Returns the field's luminance-ish sum at `dir`, with pxCell supplied. */
export function stars(dir, pxCell, t = 0, mwBoost = null) {
  const fuv = faceUV(dir);
  const uv = [fuv[0] * CELLS, fuv[1] * CELLS];
  const gi = [Math.floor(uv[0]), Math.floor(uv[1])];
  const boost = mwBoost ?? milkyWay(dir);
  const cl = fbm(dir[0] * 5 + 61, dir[1] * 5 + 61, dir[2] * 5 + 61);
  const fill = (FILL + FILL_MW * boost) * (1 + ((0.22 + 2.60 * cl * cl) - 1) * CLUMP);
  let acc = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cell = [gi[0] + i, gi[1] + j];
    const seed = [cell[0], cell[1], fuv[2] * 53 + 7];
    const ha = hash33(seed[0], seed[1], seed[2]);
    if (ha[2] > fill) continue;
    const hb = hash33(seed[2] * 1.37 + 21.7, seed[0] * 1.37 + 21.7, seed[1] * 1.37 + 21.7);
    let amp = Math.min(MAG_MIN * Math.pow(Math.max(hb[0], 1e-4), -1 / MAG_SLOPE), MAG_MAX);
    const m = Math.min(Math.max((amp - MAG_MIN) / (MAG_MAX - MAG_MIN), 0), 1);
    const rad = 0.030 + 0.075 * m;
    const radE = Math.max(rad, pxCell * 0.62);
    amp *= Math.min(1, rad / radE * 1.35);
    const dx = uv[0] - (cell[0] + 0.06 + 0.88 * ha[0]);
    const dy = uv[1] - (cell[1] + 0.06 + 0.88 * ha[1]);
    const r2 = dx * dx + dy * dy;
    if (r2 > radE * radE * 64 + 0.02) continue;
    const r = Math.sqrt(r2);
    const core = Math.exp(-r2 / (radE * radE));
    const halo = Math.exp(-r / (radE * 3.4)) * m * m * 0.10;
    acc += amp * (core + halo);      // twinkle held at 1, spark at 0
  }
  return acc;
}

// ── the shipped field: gate at the star, lobes that reach zero, seam passes ──
export function cellDir(u, v, f) {
  const ru = Math.tan(u * PI / 4), rv = Math.tan(v * PI / 4);
  let d;
  if (f === 0) d = [1, rv, ru]; else if (f === 1) d = [-1, rv, ru];
  else if (f === 2) d = [ru, 1, rv]; else if (f === 3) d = [ru, -1, rv];
  else if (f === 4) d = [ru, rv, 1]; else d = [ru, rv, -1];
  const l = Math.hypot(...d);
  return d.map((c) => c / l);
}
function fillAt(d, mwVis) {
  const cl = fbm(d[0] * 5 + 61, d[1] * 5 + 61, d[2] * 5 + 61);
  return (FILL + FILL_MW * milkyWay(d) * mwVis) * (1 + ((0.22 + 2.60 * cl * cl) - 1) * CLUMP);
}
function cellPass(dir, fuv, pxCell, mwVis, clip) {
  const uv = [fuv[0] * CELLS, fuv[1] * CELLS];
  const gi = [Math.floor(uv[0]), Math.floor(uv[1])];
  const radMax = Math.max(0.030 + 0.075, pxCell * 0.62);
  const cullMax = radMax * radMax * 64 + 0.02;
  let acc = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cell = [gi[0] + i, gi[1] + j];
    if (clip && (cell[0] < -CELLS || cell[1] < -CELLS ||
                 cell[0] > CELLS - 1 || cell[1] > CELLS - 1)) continue;
    const seed = [cell[0], cell[1], fuv[2] * 53 + 7];
    const ha = hash33(seed[0], seed[1], seed[2]);
    const sx = cell[0] + 0.06 + 0.88 * ha[0], sy = cell[1] + 0.06 + 0.88 * ha[1];
    const dx = uv[0] - sx, dy = uv[1] - sy;
    const r2 = dx * dx + dy * dy;
    if (r2 > cullMax) continue;
    const hb = hash33(seed[2] * 1.37 + 21.7, seed[0] * 1.37 + 21.7, seed[1] * 1.37 + 21.7);
    let amp = Math.min(MAG_MIN * Math.pow(Math.max(hb[0], 1e-4), -1 / MAG_SLOPE), MAG_MAX);
    const m = Math.min(Math.max((amp - MAG_MIN) / (MAG_MAX - MAG_MIN), 0), 1);
    const rad = 0.030 + 0.075 * m;
    const radE = Math.max(rad, pxCell * 0.62);
    amp *= Math.min(1, rad / radE * 1.35);
    const cull2 = radE * radE * 64 + 0.02;
    if (r2 > cull2) continue;
    const r = Math.sqrt(r2), cull = Math.sqrt(cull2);
    const core = Math.exp(-r2 / (radE * radE));
    const halo = Math.max(Math.exp(-r / (radE * 3.4)) - Math.exp(-cull / (radE * 3.4)), 0) * m * m * 0.10;
    const light = amp * (core + halo);          // twinkle held at 1, spark at 0
    if (light < 0.0005) continue;
    if (ha[2] > fillAt(cellDir(sx / CELLS, sy / CELLS, fuv[2]), mwVis)) continue;
    acc += light;
  }
  return acc;
}

/** The field as skStars draws it now. seams=false reproduces the old clipping. */
export function starsNow(dir, pxCell, mwVis = 1, seams = true) {
  const ax = domAxis(dir);
  const fuv = faceUVAxis(dir, ax);
  let acc = cellPass(dir, fuv, pxCell, mwVis, seams);
  if (!seams) return acc;
  const reach = 1 - 1.5 / CELLS;
  const axU = ax === 0 ? 2 : 0;
  const axV = ax === 2 ? 1 : (ax === 0 ? 1 : 2);
  if (Math.abs(fuv[0]) > reach) acc += cellPass(dir, faceUVAxis(dir, axU), pxCell, mwVis, true);
  if (Math.abs(fuv[1]) > reach) acc += cellPass(dir, faceUVAxis(dir, axV), pxCell, mwVis, true);
  return acc;
}
