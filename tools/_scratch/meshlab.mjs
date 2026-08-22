#!/usr/bin/env node
/**
 * meshlab — measure the WATER MESH, not the water field.
 *
 *   node tools/_scratch/meshlab.mjs [--res 1536]
 *
 * tools/waterlab.mjs measures the depth field: the curve `S - B = 0` that the
 * fragment shader draws. It cannot see the mesh at all, and every defect this
 * file exists to find is a property of the mesh — a boundary that ends on a
 * cell edge, an attribute whose level sets are straight because it is
 * interpolated linearly across a triangle, a block-max field with seams.
 *
 * It does not model Water.js. It IMPORTS buildWaterSurface from it and reads
 * the arrays that function actually built, which is the habit
 * docs/CRITIC_PROTOCOL.md says catches a well-measured number attached to the
 * wrong object.
 *
 * ── the headline metric: VISIBLE BOUNDARY ───────────────────────────────────
 * The mesh boundary is supposed to be invisible: it sits out on the dry side,
 * where the shader's alpha has already reached zero. Where that is not true,
 * the polygon itself is the visible edge of the water — a straight, cell-length
 * segment with 45-degree corners. So walk every boundary edge of the welded
 * mesh, evaluate the SHADER'S OWN alpha chain at points along it, and report
 * how many metres of boundary are drawn at alpha above the discard threshold.
 * That number is defect (1) in the brief, in metres.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBake } from '../../src/world/bakeFormat.js';
// --impl base  loads tools/_scratch/Water.base.js, a frozen copy of the
// pre-round builder with the same mechanical refactor applied, so an A/B
// compares two builders through ONE instrument rather than two runs of a
// number remembered from earlier.
const IMPL = process.argv.includes('--impl') ? process.argv[process.argv.indexOf('--impl') + 1] : 'live';
const { buildWaterSurface } = await import(IMPL === 'base' ? './Water.base.js' : '../../src/world/Water.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const RES = +argv('--res', 1536);

// ── the world, from the bake the app itself loads ───────────────────────────
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/bakes/manifest.json'), 'utf8'));
const entry = man.entries.find((e) => e.res === RES && e.hash === man.current);
if (!entry) throw new Error(`no bake for res ${RES}`);
const buf = fs.readFileSync(path.join(ROOT, 'public/bakes', entry.file));
const bake = decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const world = {
  res: bake.res,
  worldSize: bake.worldSize,
  half: bake.worldSize / 2,
  texel: bake.worldSize / bake.res,
  height: bake.height,
  water: bake.water,
};
const R = world.res, HALF = world.half, TEXEL = world.texel;

// ── the shader's own samplers, in metres ────────────────────────────────────
// uDataTex is a LinearFilter float texture with texel centres at +0.5, so a
// world point maps to grid coordinate (x + half)/texel - 0.5. Getting this
// wrong costs a metre of horizontal slip, which is the whole quantity being
// measured, so it is written the same way water_common.js writes it.
function bilin(arr, x, z) {
  let gx = (x + HALF) / TEXEL - 0.5, gz = (z + HALF) / TEXEL - 0.5;
  gx = Math.min(R - 1.0001, Math.max(0, gx));
  gz = Math.min(R - 1.0001, Math.max(0, gz));
  const x0 = gx | 0, z0 = gz | 0, tx = gx - x0, tz = gz - z0;
  const a = arr[z0 * R + x0], b = arr[z0 * R + x0 + 1];
  const c = arr[(z0 + 1) * R + x0], d = arr[(z0 + 1) * R + x0 + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}
const waterTex = new Float32Array(R * R);
for (let i = 0; i < R * R; i++) waterTex[i] = world.water[i] < -9000 ? -9999 : world.water[i];
const wBed = (x, z) => bilin(world.height, x, z);
const wBaked = (x, z) => bilin(waterTex, x, z);

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const UWETBAND = 1.0;   // Water.js uniform, copied; asserted below.
/**
 * The fragment shader's alpha, for a point on the surface.
 * `foot` is metres of ground per pixel — the caller supplies it, because it is
 * a camera quantity and the answer depends on it.
 */
function shaderAlpha(x, z, y, vShore, foot) {
  const bed = wBed(x, z);
  const depth = y - bed;
  const bedE = wBed(x + 2, z), bedN = wBed(x, z + 2);
  const grad = Math.max(Math.hypot(bedE - bed, bedN - bed) * 0.5, 0.02);
  const shoreIn = Math.min(Math.max(depth, 0) / grad, Math.max(vShore, 0) + 6);
  const shoreOut = Math.max(Math.max(-depth, 0) / grad, Math.max(-vShore, 0));
  const bodyCore = smoothstep(10, 40, Math.max(vShore, 0));
  const depthFade = Math.max(smoothstep(0, 0.62 + Math.min(foot, 5) * 0.55, depth),
                             bodyCore * smoothstep(0, 0.20 + Math.min(foot, 5) * 0.10, depth));
  const edgeM = Math.max(0.35, Math.min(foot, 8) * 1.1);
  let alpha = Math.min(depthFade, smoothstep(0, edgeM, shoreIn));
  const baked = smoothstep(-4000, -40, wBaked(x, z));
  alpha *= 1 - (1 - baked) * smoothstep(1.2, 3.5, depth);
  alpha *= 1 - smoothstep(2, 9, -vShore);
  const wetT = smoothstep(-UWETBAND, -0.02, depth)
             * (1 - smoothstep(-0.04, 0.06, depth))
             * (1 - smoothstep(1.1, 3.1, shoreOut));
  return Math.max(alpha, wetT * 0.80);
}

// ── build ───────────────────────────────────────────────────────────────────
const dbg = {};
const t0 = process.hrtime.bigint();
const built = buildWaterSurface(world, dbg);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

let verts = 0;
for (const c of built.chunks) verts += c.pos.length / 3;
console.log(`build          ${ms.toFixed(0)} ms   chunks ${built.chunks.length}  verts ${verts}  quads ${built.quads}  tris ${built.triangles}`);
console.log(`culled         vOk ${dbg.cullVOk}  levelStep ${dbg.cullStep}  emptyPoly ${dbg.cullNp}  dead ${dbg.cullDead ?? 0}`);

const { G, quadM, mask, wet, drawn } = dbg;
let nMask = 0, nWet = 0, nDrawn = 0;
for (let k = 0; k < G * G; k++) { if (mask[k]) nMask++; if (wet[k]) nWet++; if (drawn[k]) nDrawn++; }
console.log(`cells          G ${G}  quadM ${quadM}  wet ${nWet}  mask ${nMask}  drawn ${nDrawn}`);

// ── weld the chunks and find the true boundary ──────────────────────────────
// Each chunk is its own geometry, so the chunk seams look like boundary edges
// unless the vertices are welded back together. Quantised to 1 mm: the two
// sides of a seam are produced by identical arithmetic on identical inputs, so
// they are bit-equal in practice and this only guards against the exception.
const key = (x, z) => `${Math.round(x * 1000)},${Math.round(z * 1000)}`;
const vid = new Map();
const VX = [], VZ = [], VY = [], VS = [], VSP = [];
const remap = [];
for (const c of built.chunks) {
  const m = new Int32Array(c.pos.length / 3);
  for (let i = 0; i < m.length; i++) {
    const x = c.pos[i * 3], y = c.pos[i * 3 + 1], z = c.pos[i * 3 + 2];
    const kk = key(x, z);
    let id = vid.get(kk);
    if (id === undefined) {
      id = VX.length;
      vid.set(kk, id);
      VX.push(x); VY.push(y); VZ.push(z); VS.push(c.shore[i]); VSP.push(c.span[i]);
    }
    m[i] = id;
  }
  remap.push(m);
}
// Edge use count. An interior edge is used by two triangles, a boundary edge
// by one. Direction-insensitive.
const edgeUse = new Map();
let triN = 0;
for (let ci = 0; ci < built.chunks.length; ci++) {
  const c = built.chunks[ci], m = remap[ci];
  for (let i = 0; i < c.index.length; i += 3) {
    triN++;
    const a = m[c.index[i]], b = m[c.index[i + 1]], d = m[c.index[i + 2]];
    for (const [p, q] of [[a, b], [b, d], [d, a]]) {
      const kk = p < q ? p * 1e7 + q : q * 1e7 + p;
      edgeUse.set(kk, (edgeUse.get(kk) ?? 0) + 1);
    }
  }
}
const boundary = [];
for (const [kk, n] of edgeUse) if (n === 1) boundary.push([Math.floor(kk / 1e7), kk % 1e7]);
console.log(`welded         verts ${VX.length}  tris ${triN}  boundary edges ${boundary.length}`);

// Is a boundary edge CELL-ALIGNED (both ends on lattice points, so it is a raw
// mask edge that the contour never cut) or CONTOUR-CUT?
const ORIGIN = -HALF;
const onLattice = (x, z) => {
  const fx = (x - ORIGIN) / quadM, fz = (z - ORIGIN) / quadM;
  return Math.abs(fx - Math.round(fx)) < 1e-4 && Math.abs(fz - Math.round(fz)) < 1e-4;
};

// ── the headline: how many metres of boundary does the shader actually draw ──
// Sampled at 1 m along each edge. `foot` is set from the framings this round is
// judged on: 'river' and 'mouth' put the far bank 60-120 m out at a grazing
// angle, which wFootprint returns 0.4-1.2 m for. 0.6 is the middle of that.
const FOOT = +argv('--foot', 0.6);
const ALPHA_VIS = 0.05;    // well above the shader's own 0.012 discard
// The mesh is clipped by the map, and 208 km of boundary includes 12 km of map
// border. That edge is real geometry drawn at full alpha and it is NOT a
// defect of this file — it is the end of the world, under the far fog. Counted
// separately, because leaving it in makes the headline number a statement
// about the wrong object.
const BORDER = HALF - quadM * 1.5;
const isBorder = (x, z) => Math.abs(x) > BORDER || Math.abs(z) > BORDER;
let lenAll = 0, lenAligned = 0;
const vis = { border: 0, step: 0, other: 0 };
let lenVis = 0, lenVisAligned = 0;
let alphaHist = new Float64Array(11);
const visSamples = [];
// A cell-aligned boundary edge next to a cell the level-step cull threw away
// is a HOLE in the water, not the rim of it. Rebuild that map from `drawn`.
const stepHole = new Uint8Array(G * G);
for (let k = 0; k < G * G; k++) if (mask[k] && !drawn[k]) stepHole[k] = 1;
const cellOf = (x, z) => {
  const cx = Math.floor((x - ORIGIN) / quadM), cz = Math.floor((z - ORIGIN) / quadM);
  return (cx < 0 || cz < 0 || cx >= G || cz >= G) ? -1 : cz * G + cx;
};
for (const [a, b] of boundary) {
  const ax = VX[a], az = VZ[a], bx = VX[b], bz = VZ[b];
  const L = Math.hypot(bx - ax, bz - az);
  const aligned = onLattice(ax, az) && onLattice(bx, bz);
  lenAll += L; if (aligned) lenAligned += L;
  const n = Math.max(2, Math.ceil(L));
  let visFrac = 0;
  const border = isBorder((ax + bx) / 2, (az + bz) / 2);
  // which side is missing: the cell just off the edge's midpoint normal
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  const ex = (bx - ax) / L, ez = (bz - az) / L;
  const k1 = cellOf(mx - ez * quadM * 0.35, mz + ex * quadM * 0.35);
  const k2 = cellOf(mx + ez * quadM * 0.35, mz - ex * quadM * 0.35);
  const nextToHole = (k1 >= 0 && stepHole[k1]) || (k2 >= 0 && stepHole[k2]);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    const y = VY[a] + (VY[b] - VY[a]) * t;
    const sh = VS[a] + (VS[b] - VS[a]) * t;
    const al = shaderAlpha(x, z, y, sh, FOOT);
    alphaHist[Math.min(10, Math.floor(al * 10))] += L / n;
    if (al > ALPHA_VIS) {
      visFrac += 1 / n;
      if (!border && visSamples.length < 40) visSamples.push({ x: +x.toFixed(0), z: +z.toFixed(0), al: +al.toFixed(2), sh: +sh.toFixed(1), d: +(y - wBed(x, z)).toFixed(2), aligned, hole: nextToHole });
    }
  }
  const seen = L * visFrac;
  lenVis += seen; if (aligned) lenVisAligned += seen;
  if (border) vis.border += seen; else if (nextToHole) vis.step += seen; else vis.other += seen;
}
console.log(`boundary       total ${(lenAll / 1000).toFixed(2)} km   cell-aligned ${(100 * lenAligned / lenAll).toFixed(1)}%`);
console.log(`VISIBLE EDGE   ${lenVis.toFixed(0)} m at alpha>${ALPHA_VIS} (foot ${FOOT} m) = ${(100 * lenVis / lenAll).toFixed(2)}% of boundary; ${(100 * lenVisAligned / Math.max(lenVis, 1e-9)).toFixed(0)}% cell-aligned`);
console.log(`  of which     map border ${vis.border.toFixed(0)} m | level-step hole ${vis.step.toFixed(0)} m | REAL RIM ${vis.other.toFixed(0)} m`);
console.log(`  alpha hist   ${[...alphaHist].map((v, i) => `${i / 10}:${(v).toFixed(0)}`).join(' ')}`);
if (visSamples.length) console.log('  samples      ' + JSON.stringify(visSamples.slice(0, 6)));

// ── aShore: how wrong is the lattice chamfer? ───────────────────────────────
// Exact Euclidean distance transform (Felzenszwalb-Huttenlocher, O(N)) on the
// NATIVE 2 m grid, against the same wet definition the mesh uses, so the two
// are statements about the same waterline.
function edt1d(f, n, d, v, zz) {
  let k = 0; v[0] = 0; zz[0] = -Infinity; zz[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= zz[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; zz[k] = s; zz[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (zz[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}
/** Squared Euclidean distance, in cells, to the nearest cell where mask is 0. */
function edt2(maskArr, W, H) {
  const INF = 1e12;
  const f = new Float64Array(Math.max(W, H));
  const d = new Float64Array(Math.max(W, H));
  const v = new Int32Array(Math.max(W, H));
  const zz = new Float64Array(Math.max(W, H) + 1);
  const out = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = maskArr[i] ? INF : 0;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = out[y * W + x];
    edt1d(f, H, d, v, zz);
    for (let y = 0; y < H; y++) out[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = out[y * W + x];
    edt1d(f, W, d, v, zz);
    for (let x = 0; x < W; x++) out[y * W + x] = d[x];
  }
  return out;
}

// The mesh's own wet definition, at native resolution: surface above bed.
const wetT = new Uint8Array(R * R);
for (let i = 0; i < R * R; i++) wetT[i] = (world.water[i] > -9000 && world.water[i] > world.height[i]) ? 1 : 0;
const dryT = new Uint8Array(R * R);
for (let i = 0; i < R * R; i++) dryT[i] = 1 - wetT[i];
const tE0 = process.hrtime.bigint();
const dIn2 = edt2(wetT, R, R);      // inside water -> distance to dry
const dOut2 = edt2(dryT, R, R);     // outside -> distance to wet
const edtMs = Number(process.hrtime.bigint() - tE0) / 1e6;
const exactShore = new Float32Array(R * R);
for (let i = 0; i < R * R; i++) {
  exactShore[i] = wetT[i] ? Math.sqrt(dIn2[i]) * TEXEL : -Math.sqrt(dOut2[i]) * TEXEL;
}
console.log(`exact EDT      2 m Euclidean, both signs, ${edtMs.toFixed(0)} ms at ${R}^2`);

// Compare: the value the SHADER sees (aShore interpolated across the triangle)
// against the exact distance at the same point. Sampled inside real triangles,
// weighted to the shore band, because that is the only place it is used.
{
  let n = 0, sum = 0, sum2 = 0, mx = 0, nBand = 0, sumB = 0, sum2B = 0, mxB = 0;
  for (let ci = 0; ci < built.chunks.length; ci++) {
    const c = built.chunks[ci];
    for (let i = 0; i < c.index.length; i += 3) {
      const i0 = c.index[i], i1 = c.index[i + 1], i2 = c.index[i + 2];
      // barycentric samples
      for (const [u, v2] of [[0.25, 0.25], [0.5, 0.25], [0.25, 0.5], [0.34, 0.33]]) {
        const w0 = 1 - u - v2;
        const x = c.pos[i0 * 3] * w0 + c.pos[i1 * 3] * u + c.pos[i2 * 3] * v2;
        const z = c.pos[i0 * 3 + 2] * w0 + c.pos[i1 * 3 + 2] * u + c.pos[i2 * 3 + 2] * v2;
        const sh = c.shore[i0] * w0 + c.shore[i1] * u + c.shore[i2] * v2;
        const ex = bilin(exactShore, x, z);
        const e = Math.abs(sh - ex);
        n++; sum += e; sum2 += e * e; if (e > mx) mx = e;
        if (Math.abs(ex) < 8) { nBand++; sumB += e; sum2B += e * e; if (e > mxB) mxB = e; }
      }
    }
  }
  console.log(`aShore error   all: mean ${(sum / n).toFixed(2)} m  rms ${Math.sqrt(sum2 / n).toFixed(2)} m  max ${mx.toFixed(1)} m   (n ${n})`);
  console.log(`               |exact|<8 m band: mean ${(sumB / nBand).toFixed(2)} m  rms ${Math.sqrt(sum2B / nBand).toFixed(2)} m  max ${mxB.toFixed(1)} m`);
}

// ── the kink: how much does the level set of aShore bend at a lattice line? ──
// A lattice quantity interpolated linearly across triangles is C0 but not C1.
// The visible artefact is the gradient JUMP across an edge — that is what draws
// a crease. Measured as the angle between the gradient of aShore in the two
// quads either side of every interior lattice line, in degrees, and the jump in
// magnitude, in m/m.
// `band`: restrict to cells inside |aShore| < 8 m. An exact distance field is
// genuinely non-differentiable on the MEDIAL AXIS of the body — that is what a
// distance field is — and mid-channel is where every term keyed off aShore is
// already saturated. Averaging the kink over the whole surface therefore
// measures the skeleton, not the shoreline, and reports a field getting worse
// when the place it is used got better.
function fieldKinks(vArr, VGn, Gn, cellM, drawnArr, label, band) {
  let n = 0, sumAng = 0, mxAng = 0, sumMag = 0, mxMag = 0;
  const grad = (cx, cz) => {
    const i00 = cz * VGn + cx, i10 = i00 + 1, i01 = (cz + 1) * VGn + cx, i11 = i01 + 1;
    // bilinear gradient at the cell centre
    return [((vArr[i10] + vArr[i11]) - (vArr[i00] + vArr[i01])) * 0.5 / cellM,
            ((vArr[i01] + vArr[i11]) - (vArr[i00] + vArr[i10])) * 0.5 / cellM];
  };
  for (let cz = 0; cz < Gn; cz++) {
    for (let cx = 0; cx < Gn - 1; cx++) {
      if (!drawnArr[cz * Gn + cx] || !drawnArr[cz * Gn + cx + 1]) continue;
      if (band) {
        const sh = dbg.vShore[cz * VGn + cx];
        if (!(sh > band[0] && sh < band[1])) continue;
      }
      const a = grad(cx, cz), b = grad(cx + 1, cz);
      const la = Math.hypot(a[0], a[1]), lb = Math.hypot(b[0], b[1]);
      if (la < 1e-6 || lb < 1e-6) continue;
      const ang = Math.acos(Math.min(1, Math.max(-1, (a[0] * b[0] + a[1] * b[1]) / (la * lb)))) * 180 / Math.PI;
      const dm = Math.abs(la - lb);
      n++; sumAng += ang; if (ang > mxAng) mxAng = ang; sumMag += dm; if (dm > mxMag) mxMag = dm;
    }
  }
  console.log(`${label} kink mean ${(sumAng / n).toFixed(1)} deg  max ${mxAng.toFixed(0)} deg   |grad| jump mean ${(sumMag / n).toFixed(3)}  max ${mxMag.toFixed(2)}   (n ${n})`);
}
fieldKinks(dbg.vShore, G + 1, G, quadM, drawn, 'aShore all  ', false);
fieldKinks(dbg.vShore, G + 1, G, quadM, drawn, 'aShore dry  ', [-8, -1]);
fieldKinks(dbg.vShore, G + 1, G, quadM, drawn, 'aShore wet  ', [1, 8]);
fieldKinks(dbg.vSpan, G + 1, G, quadM, drawn, 'aSpan  all  ', false);
fieldKinks(dbg.vSpan, G + 1, G, quadM, drawn, 'aSpan  band ', [-8, 8]);

// ── aSpan seams: the block grid is 16 m; is the step across a block visible? ─
{
  const CB = Math.max(1, Math.round(16 / quadM));
  let n = 0, sum = 0, mx = 0;
  // Step in aSpan across each block boundary column, in metres of span per
  // metre of ground — the shader turns aSpan into shoreBand = span*0.30, so a
  // step of s metres moves the band by 0.3*s.
  for (let cz = 1; cz < G - 1; cz++) {
    for (let cx = 1; cx < G - 1; cx++) {
      if (!drawn[cz * G + cx]) continue;
      const i = cz * (G + 1) + cx;
      const d2 = Math.abs(dbg.vSpan[i - 1] - 2 * dbg.vSpan[i] + dbg.vSpan[i + 1]);
      n++; sum += d2; if (d2 > mx) mx = d2;
    }
  }
  console.log(`aSpan  2nd-diff along x: mean ${(sum / n).toFixed(3)} m  max ${mx.toFixed(2)} m  (block ${CB} cells = ${CB * quadM} m)`);
}

// ── where the ring runs out with water still on it ──────────────────────────
{
  const { level } = dbg;
  let runout = 0, runoutWet = 0, runoutShore = 0;
  const shoreAtMask = [];
  for (let cz = 1; cz < G - 1; cz++) {
    for (let cx = 1; cx < G - 1; cx++) {
      const k = cz * G + cx;
      if (!mask[k]) continue;
      // a mask cell with a non-mask 4-neighbour is on the outer rim
      if (mask[k - 1] && mask[k + 1] && mask[k - G] && mask[k + G]) continue;
      runout++;
      shoreAtMask.push(bilin(exactShore, ORIGIN + (cx + 0.5) * quadM, ORIGIN + (cz + 0.5) * quadM));
      const x = ORIGIN + (cx + 0.5) * quadM, z = ORIGIN + (cz + 0.5) * quadM;
      const d = level[k] - wBed(x, z);
      if (d > -1.4) runoutWet++;
      if (bilin(exactShore, x, z) > -9) runoutShore++;
    }
  }
  shoreAtMask.sort((a, b) => a - b);
  const pc = (p) => shoreAtMask[Math.floor(p * (shoreAtMask.length - 1))].toFixed(1);
  console.log(`ring rim       ${runout} cells; ${(100 * runoutWet / runout).toFixed(1)}% still have depth > iso at the rim; ${(100 * runoutShore / runout).toFixed(1)}% have aShore > -9 m (shader's own outer guard not yet finished)`);
  console.log(`  rim aShore   p05 ${pc(0.05)}  p50 ${pc(0.5)}  p95 ${pc(0.95)} m`);
}

// ── what the level-step cull actually throws away ───────────────────────────
// 4551 quads is a small number; 5.4 km of hard bright edge is not. So look at
// the population: is a culled quad a waterfall lip (which the shader's perched
// guard would kill per-pixel anyway) or a steep reach in the middle of a river
// (which is a hole in the water with the bed showing through)?
{
  const { vLevel, level } = dbg;
  const VG = G + 1;
  let n = 0, holeInWater = 0, perched = 0, bothWet = 0;
  const steps = [];
  for (let cz = 0; cz < G; cz++) {
    for (let cx = 0; cx < G; cx++) {
      const k = cz * G + cx;
      if (!mask[k] || drawn[k]) continue;
      const ci = [cz * VG + cx, (cz + 1) * VG + cx, (cz + 1) * VG + cx + 1, cz * VG + cx + 1];
      let lo = Infinity, hi = -Infinity;
      for (const q of ci) { if (dbg.vLevel[q] < lo) lo = dbg.vLevel[q]; if (dbg.vLevel[q] > hi) hi = dbg.vLevel[q]; }
      if (!(hi - lo > 8.0)) continue;    // SURF_LEVEL_STEP; the rest are emptyPoly
      n++;
      steps.push(hi - lo);
      const x = ORIGIN + (cx + 0.5) * quadM, z = ORIGIN + (cz + 0.5) * quadM;
      const bakedHere = wBaked(x, z);
      // Would the shader's own perched guard have removed it? It needs the bake
      // to say "no water" AND the surface to be metres above the ground.
      const d = (lo + hi) * 0.5 - wBed(x, z);
      if (bakedHere < -40 && d > 3.5) perched++;
      if (wet[k]) bothWet++;
      // is it surrounded by real water?
      let wetN = 0;
      for (const nk of [k - 1, k + 1, k - G, k + G]) if (nk >= 0 && nk < G * G && wet[nk]) wetN++;
      if (wetN >= 2) holeInWater++;
    }
  }
  steps.sort((a, b) => a - b);
  const q = (p) => steps[Math.floor(p * (steps.length - 1))].toFixed(1);
  console.log(`levelStep cull ${n} quads: ${bothWet} are themselves WET, ${holeInWater} have >=2 wet 4-neighbours (a hole in a body), ${perched} would be killed by the shader's perched guard anyway`);
  console.log(`  step range   p50 ${q(0.5)} m  p90 ${q(0.9)} m  p99 ${q(0.99)} m  max ${q(1)} m`);
}

// ── cells the shader can never draw ─────────────────────────────────────────
// alpha *= 1 - smoothstep(2, 9, -vShore). A quad all four of whose corners sit
// at aShore < -9 m is multiplied by exactly zero over its whole area, whatever
// else is true. Those triangles are pure cost.
{
  const VG = G + 1;
  let dead = 0, deadTris = 0;
  for (let cz = 0; cz < G; cz++) {
    for (let cx = 0; cx < G; cx++) {
      const k = cz * G + cx;
      if (!drawn[k]) continue;
      const ci = [cz * VG + cx, (cz + 1) * VG + cx, (cz + 1) * VG + cx + 1, cz * VG + cx + 1];
      if (ci.every((q) => dbg.vShore[q] < -9.0)) { dead++; deadTris += 2; }
    }
  }
  console.log(`invisible      ${dead} drawn quads have all four corners at aShore < -9 m: alpha is identically zero over them (${deadTris} tris, ${(100 * deadTris / built.triangles).toFixed(1)}% of the surface)`);
}

// ── aSpan distribution, so a replacement can be checked against it ──────────
{
  const s = [...dbg.vSpan].filter((v, i) => dbg.vOk[i]);
  s.sort((a, b) => a - b);
  const q = (p) => s[Math.floor(p * (s.length - 1))].toFixed(1);
  console.log(`aSpan dist     p05 ${q(0.05)}  p25 ${q(0.25)}  p50 ${q(0.5)}  p75 ${q(0.75)}  p95 ${q(0.95)}  max ${q(1)} m`);
}

// ── does the BAKE call the culled quad water? ──────────────────────────────
// The bake refuses to write channel water more than three metres above its own
// bed (see the perched-guard note in water_surface.js), so a cell the bake
// itself flagged cannot be the sixty-metre bridging wall the step test was
// written to catch. Split the cull population on that.
{
  const VG = G + 1, { hasW } = dbg;
  let withBake = 0, ringOnly = 0;
  for (let cz = 0; cz < G; cz++) {
    for (let cx = 0; cx < G; cx++) {
      const k = cz * G + cx;
      if (!mask[k] || drawn[k]) continue;
      const ci = [cz * VG + cx, (cz + 1) * VG + cx, (cz + 1) * VG + cx + 1, cz * VG + cx + 1];
      let lo = Infinity, hi = -Infinity;
      for (const q of ci) { if (dbg.vLevel[q] < lo) lo = dbg.vLevel[q]; if (dbg.vLevel[q] > hi) hi = dbg.vLevel[q]; }
      if (!(hi - lo > 8.0)) continue;
      if (hasW[k]) withBake++; else ringOnly++;
    }
  }
  console.log(`levelStep split  baked-water cells ${withBake}   pure dilation-ring cells ${ringOnly}`);
}

// ── vertices where two BODIES of water meet ────────────────────────────────
// 'Real water wins' fixed ring-vs-real. It says nothing about real-vs-real: a
// vertex touched by two wet cells at different levels takes their MEAN, which
// belongs to neither. Measure the spread.
{
  const VG = G + 1, { level } = dbg;
  const spreads = [];
  let n = 0, over1 = 0, over3 = 0, over8 = 0;
  for (let vz = 0; vz < VG; vz++) {
    for (let vx = 0; vx < VG; vx++) {
      let lo = Infinity, hi = -Infinity, c = 0;
      for (let dz = -1; dz <= 0; dz++) {
        const cz = vz + dz; if (cz < 0 || cz >= G) continue;
        for (let dx = -1; dx <= 0; dx++) {
          const cx = vx + dx; if (cx < 0 || cx >= G) continue;
          const k = cz * G + cx;
          if (!wet[k]) continue;
          c++; if (level[k] < lo) lo = level[k]; if (level[k] > hi) hi = level[k];
        }
      }
      if (c < 2) continue;
      n++;
      const s = hi - lo;
      spreads.push(s);
      if (s > 1) over1++; if (s > 3) over3++; if (s > 8) over8++;
    }
  }
  spreads.sort((a, b) => a - b);
  const q = (p) => spreads[Math.floor(p * (spreads.length - 1))].toFixed(2);
  console.log(`wet-wet vertex ${n} vertices touch >=2 wet cells; spread p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} p999 ${q(0.999)} max ${q(1)} m`);
  console.log(`               >1 m: ${over1} (${(100 * over1 / n).toFixed(2)}%)  >3 m: ${over3}  >8 m: ${over8}`);
}

// ── are the disagreeing cells both DEEP, or is one a shallow rim? ──────────
// If one side is always a shallow rim texel of a body that is really somewhere
// else, weighting the vertex mean by how much water each cell holds fixes it
// with no structural change. If both sides are deep, the vertex is straddling
// a genuine discontinuity and no single value can be right.
{
  const VG = G + 1, { level } = dbg;
  const S = dbg.S, Rr = dbg.R;
  // mean depth of each wet quad, from the native texels
  const cellDepth = new Float32Array(G * G);
  for (let cz = 0; cz < G; cz++) {
    for (let cx = 0; cx < G; cx++) {
      const k = cz * G + cx; if (!wet[k]) continue;
      let s = 0, n = 0;
      for (let j = 0; j < S; j++) {
        const row = (cz * S + j) * Rr;
        for (let i = 0; i < S; i++) {
          const gi = row + cx * S + i;
          if (world.water[gi] > -9000 && world.water[gi] > world.height[gi]) { s += world.water[gi] - world.height[gi]; n++; }
        }
      }
      cellDepth[k] = n ? s / n : 0;
    }
  }
  let bothDeep = 0, oneShallow = 0, diag = 0, tot = 0;
  for (let vz = 0; vz < VG; vz++) {
    for (let vx = 0; vx < VG; vx++) {
      const cells = [];
      for (let dz = -1; dz <= 0; dz++) {
        const cz = vz + dz; if (cz < 0 || cz >= G) continue;
        for (let dx = -1; dx <= 0; dx++) {
          const cx = vx + dx; if (cx < 0 || cx >= G) continue;
          const k = cz * G + cx; if (wet[k]) cells.push([k, dx, dz]);
        }
      }
      if (cells.length < 2) continue;
      let lo = Infinity, hi = -Infinity, klo = -1, khi = -1;
      for (const [k] of cells) { if (level[k] < lo) { lo = level[k]; klo = k; } if (level[k] > hi) { hi = level[k]; khi = k; } }
      if (hi - lo <= 3) continue;
      tot++;
      if (Math.min(cellDepth[klo], cellDepth[khi]) > 0.5) bothDeep++; else oneShallow++;
      // locally disconnected: exactly two wet cells, touching only at the corner
      if (cells.length === 2) {
        const [, dx0, dz0] = cells[0], [, dx1, dz1] = cells[1];
        if (dx0 !== dx1 && dz0 !== dz1) diag++;
      }
    }
  }
  console.log(`disagree >3 m  ${tot} vertices: both sides deeper than 0.5 m ${bothDeep}, one side a shallow rim ${oneShallow}, locally diagonal-only ${diag}`);
}

// ── the regression guard for touching the level-step cull ──────────────────
// The cull exists to stop a wall of water hanging down a rock face between two
// bodies. Relaxing it is only safe if no such wall is DRAWN. So: every quad
// steeper than SURF_LEVEL_STEP that survived, sampled over its area, at the
// shader's own alpha. Area drawn is the number that must stay at zero.
{
  const VG = G + 1;
  let walls = 0, wallArea = 0; const wallDepths = [];
  for (let cz = 0; cz < G; cz++) {
    for (let cx = 0; cx < G; cx++) {
      const k = cz * G + cx;
      if (!drawn[k]) continue;
      const ci = [cz * VG + cx, (cz + 1) * VG + cx, (cz + 1) * VG + cx + 1, cz * VG + cx + 1];
      let lo = Infinity, hi = -Infinity;
      for (const q of ci) { if (dbg.vLevel[q] < lo) lo = dbg.vLevel[q]; if (dbg.vLevel[q] > hi) hi = dbg.vLevel[q]; }
      if (hi - lo <= 8.0) continue;
      walls++;
      let hit = 0, n = 0;
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          const u = (i + 0.5) / 4, v2 = (j + 0.5) / 4;
          const x = ORIGIN + (cx + u) * quadM, z = ORIGIN + (cz + v2) * quadM;
          const y = (dbg.vLevel[ci[0]] * (1 - u) + dbg.vLevel[ci[3]] * u) * (1 - v2)
                  + (dbg.vLevel[ci[1]] * (1 - u) + dbg.vLevel[ci[2]] * u) * v2;
          const sh = (dbg.vShore[ci[0]] * (1 - u) + dbg.vShore[ci[3]] * u) * (1 - v2)
                   + (dbg.vShore[ci[1]] * (1 - u) + dbg.vShore[ci[2]] * u) * v2;
          n++;
          if (shaderAlpha(x, z, y, sh, FOOT) > 0.05) hit++;
        }
      }
      wallArea += (hit / n) * quadM * quadM;
      { // how far above its own bed does the drawn part of this wall stand?
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
          const u = (i + 0.5) / 4, v2 = (j + 0.5) / 4;
          const x = ORIGIN + (cx + u) * quadM, z = ORIGIN + (cz + v2) * quadM;
          const y = (dbg.vLevel[ci[0]] * (1 - u) + dbg.vLevel[ci[3]] * u) * (1 - v2)
                  + (dbg.vLevel[ci[1]] * (1 - u) + dbg.vLevel[ci[2]] * u) * v2;
          const sh = (dbg.vShore[ci[0]] * (1 - u) + dbg.vShore[ci[3]] * u) * (1 - v2)
                   + (dbg.vShore[ci[1]] * (1 - u) + dbg.vShore[ci[2]] * u) * v2;
          if (shaderAlpha(x, z, y, sh, FOOT) > 0.05) wallDepths.push(y - wBed(x, z));
        }
      }
    }
  }
  wallDepths.sort((a, b) => a - b);
  const wq = (p) => wallDepths.length ? wallDepths[Math.floor(p * (wallDepths.length - 1))].toFixed(1) : 'na';
  console.log(`WALL GUARD     ${walls} drawn quads steeper than 8 m per quad; ${wallArea.toFixed(0)} m2 of them drawn at alpha>0.05`);
  console.log(`  drawn depth  p05 ${wq(0.05)}  p50 ${wq(0.5)}  p95 ${wq(0.95)}  max ${wq(1)} m above its own bed  (a cascade is a metre or two; a bridging wall is tens)`);
}

// ── does aSpan still bound the true half-width? ────────────────────────────
// aSpan has to be an UPPER estimate of the local half-width or bankT goes
// negative mid-channel and the bank terms wake up in open water. Checked
// against the exact inside distance at the same point.
{
  let n = 0, under = 0, ratio = 0, worst = 0;
  for (let cz = 1; cz < G - 1; cz++) {
    for (let cx = 1; cx < G - 1; cx++) {
      const k = cz * G + cx;
      if (!drawn[k] || !wet[k]) continue;
      const x = ORIGIN + (cx + 0.5) * quadM, z = ORIGIN + (cz + 0.5) * quadM;
      const din = Math.min(bilin(exactShore, x, z), 32);
      if (din <= 0.5) continue;
      const sp = dbg.vSpan[cz * (G + 1) + cx];
      n++; ratio += sp / din;
      if (sp < din - 0.25) { under++; if (din - sp > worst) worst = din - sp; }
    }
  }
  console.log(`aSpan vs truth ${(100 * under / n).toFixed(2)}% of wet cells have aSpan BELOW their own inside distance (worst ${worst.toFixed(1)} m short); mean aSpan/din ${(ratio / n).toFixed(2)}`);
}

// ── did smoothing aShore move its ZERO SET? ────────────────────────────────
// The zero of aShore is the waterline. A blur that rounds the skeleton must not
// move it, so measure directly: at every sample where the exact field is within
// 1 m of zero, how far off zero is the attribute the shader will read?
{
  const errs = [];
  for (const c of built.chunks) {
    for (let i = 0; i < c.index.length; i += 3) {
      const i0 = c.index[i], i1 = c.index[i + 1], i2 = c.index[i + 2];
      for (const [u, v2] of [[0.25, 0.25], [0.5, 0.25], [0.25, 0.5]]) {
        const w0 = 1 - u - v2;
        const x = c.pos[i0 * 3] * w0 + c.pos[i1 * 3] * u + c.pos[i2 * 3] * v2;
        const z = c.pos[i0 * 3 + 2] * w0 + c.pos[i1 * 3 + 2] * u + c.pos[i2 * 3 + 2] * v2;
        const ex = bilin(exactShore, x, z);
        if (Math.abs(ex) > 1) continue;
        errs.push(Math.abs((c.shore[i0] * w0 + c.shore[i1] * u + c.shore[i2] * v2) - ex));
      }
    }
  }
  errs.sort((a, b) => a - b);
  const q = (p) => errs.length ? errs[Math.floor(p * (errs.length - 1))].toFixed(2) : 'na';
  console.log(`zero-set shift on the waterline itself: p50 ${q(0.5)}  p90 ${q(0.9)}  p99 ${q(0.99)}  max ${q(1)} m  (n ${errs.length})`);
}

// ── does the mesh's LEVEL reconstruction move the waterline? ───────────────
// The visible waterline is the zero set of (mesh surface) - (bed sampled per
// pixel at 2 m). The bed term is smooth. So any lattice structure in the mesh's
// level term prints straight into the waterline, amplified by 1/|grad bed| —
// which on this map's aprons is 30. Measured against the bake's OWN water
// surface, bilinearly sampled at the same point, at samples within 3 m of the
// true waterline.
{
  const errs = [], moves = [];
  const VG = G + 1;
  const lvlAt = (x, z) => {
    const fx = (x - ORIGIN) / quadM, fz = (z - ORIGIN) / quadM;
    const cx = Math.min(G - 1, Math.max(0, Math.floor(fx))), cz = Math.min(G - 1, Math.max(0, Math.floor(fz)));
    const u = fx - cx, v = fz - cz;
    const i00 = cz * VG + cx, i10 = i00 + 1, i01 = (cz + 1) * VG + cx, i11 = i01 + 1;
    if (!dbg.vOk[i00] || !dbg.vOk[i10] || !dbg.vOk[i01] || !dbg.vOk[i11]) return null;
    return (dbg.vLevel[i00] * (1 - u) + dbg.vLevel[i10] * u) * (1 - v)
         + (dbg.vLevel[i01] * (1 - u) + dbg.vLevel[i11] * u) * v;
  };
  for (let cz = 1; cz < G - 1; cz++) {
    for (let cx = 1; cx < G - 1; cx++) {
      const k = cz * G + cx;
      if (!drawn[k]) continue;
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
        const x = ORIGIN + (cx + (i + 0.5) / 2) * quadM, z = ORIGIN + (cz + (j + 0.5) / 2) * quadM;
        if (Math.abs(bilin(exactShore, x, z)) > 3) continue;
        const baked = wBaked(x, z);
        if (baked < -40) continue;
        const L = lvlAt(x, z); if (L === null) continue;
        const e = L - baked;
        errs.push(Math.abs(e));
        const bed = wBed(x, z);
        const g = Math.max(Math.hypot(wBed(x + 2, z) - bed, wBed(x, z + 2) - bed) * 0.5, 0.02);
        moves.push(Math.abs(e) / g);
      }
    }
  }
  errs.sort((a, b) => a - b); moves.sort((a, b) => a - b);
  const q = (a, p) => a.length ? a[Math.floor(p * (a.length - 1))].toFixed(2) : 'na';
  console.log(`LEVEL vs bake  within 3 m of the waterline: |mesh level - baked surface| p50 ${q(errs, 0.5)}  p90 ${q(errs, 0.9)}  p99 ${q(errs, 0.99)} m`);
  console.log(`               implied waterline displacement p50 ${q(moves, 0.5)}  p90 ${q(moves, 0.9)}  p99 ${q(moves, 0.99)} m  (n ${errs.length})`);
}

// ── what would refining the lattice near the waterline COST? ───────────────
// Splitting a 4 m cell into four 2 m cells turns 2 triangles into 8, plus the
// stitching a T-junction needs. Count the cells a shore band would cover.
{
  const VG = G + 1;
  for (const band of [4, 6, 8]) {
    let n = 0;
    for (let cz = 0; cz < G; cz++) {
      for (let cx = 0; cx < G; cx++) {
        const k = cz * G + cx; if (!drawn[k]) continue;
        const ci = [cz * VG + cx, (cz + 1) * VG + cx, (cz + 1) * VG + cx + 1, cz * VG + cx + 1];
        if (ci.some((q) => Math.abs(dbg.vShore[q]) < band)) n++;
      }
    }
    console.log(`refine cost    |aShore| < ${band} m: ${n} of ${built.quads} drawn quads (${(100 * n / built.quads).toFixed(0)}%); refining them 2x adds ${(n * 6 / 1000).toFixed(0)}k triangles = +${(100 * n * 6 / built.triangles).toFixed(0)}%`);
  }
}

// ── the regression guard: no wet cell may lose its geometry ────────────────
// waterlab's `chanWet` guards the FIELD against a fix that scores well by
// deleting water. This is the same guard for the MESH.
{
  let wetCells = 0, wetNotDrawn = 0, wetArea = 0, drawnWetArea = 0;
  for (let k = 0; k < G * G; k++) {
    if (!wet[k]) continue;
    wetCells++; wetArea += quadM * quadM;
    if (drawn[k]) drawnWetArea += quadM * quadM; else wetNotDrawn++;
  }
  console.log(`WET COVERAGE   ${wetCells} wet cells, ${wetNotDrawn} of them not drawn (${(100 * drawnWetArea / wetArea).toFixed(2)}% of wet area has geometry)`);
}

// ── does the mesh surface ever sink below its own bed inside real water? ───
// The tan wedges. Where the bake says there is standing water and the mesh's
// interpolated surface is BELOW the terrain, the terrain draws over the water
// and what the player sees is a flat slab of riverbed lying across the channel
// with water on both sides of it. Sampled at every wet texel of the bake.
{
  const VG = G + 1;
  let n = 0, sunk = 0, area = 0; let worst = 0;
  for (let tz = 1; tz < R - 1; tz += 1) {
    for (let tx = 1; tx < R - 1; tx += 1) {
      const gi = tz * R + tx;
      const v = world.water[gi];
      if (!(v > -9000 && v > world.height[gi] + 0.25)) continue;   // 25 cm of real water
      const x = -HALF + (tx + 0.5) * TEXEL, z = -HALF + (tz + 0.5) * TEXEL;
      const fx = (x - ORIGIN) / quadM, fz = (z - ORIGIN) / quadM;
      const cx = Math.min(G - 1, Math.max(0, Math.floor(fx))), cz = Math.min(G - 1, Math.max(0, Math.floor(fz)));
      if (!drawn[cz * G + cx]) continue;
      const u = fx - cx, w = fz - cz;
      const i00 = cz * VG + cx, i10 = i00 + 1, i01 = (cz + 1) * VG + cx, i11 = i01 + 1;
      const L = (dbg.vLevel[i00] * (1 - u) + dbg.vLevel[i10] * u) * (1 - w)
              + (dbg.vLevel[i01] * (1 - u) + dbg.vLevel[i11] * u) * w;
      n++;
      const d = L - wBed(x, z);
      if (d < 0) { sunk++; area += TEXEL * TEXEL; if (-d > worst) worst = -d; }
    }
  }
  console.log(`SUNK SURFACE   ${sunk} of ${n} wet texels (${(100 * sunk / n).toFixed(3)}%) have the mesh surface BELOW the bed: ${area.toFixed(0)} m2 of water the terrain draws over, worst ${worst.toFixed(2)} m`);
}
