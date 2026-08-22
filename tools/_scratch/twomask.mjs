#!/usr/bin/env node
/**
 * twomask — how far apart are the two statements about where the water is?
 *
 *   node tools/_scratch/twomask.mjs [--res 1536]
 *
 * The terrain shader paints its four water-margin terms from hydroField's
 * `depth`. The water mesh is built by Water.js from a QUAD-level mask of the
 * raw bake, cleaned by its own rules. Where hydro says "wet" and the mesh drew
 * nothing, the terrain paints a shore band for water that is never drawn — and
 * the RIM of such a region is a thin closed dark lasso on bare ground.
 *
 * Imports both builders rather than modelling them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { buildHydroField } from '../../src/world/hydroField.js';
import { buildWaterSurface } from '../../src/world/Water.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const RES = +argv('--res', 1536);

const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/bakes/manifest.json'), 'utf8'));
const entry = man.entries.find((e) => e.res === RES && e.hash === man.current);
const buf = fs.readFileSync(path.join(ROOT, 'public/bakes', entry.file));
const bake = decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const world = {
  res: bake.res, worldSize: bake.worldSize, half: bake.worldSize / 2,
  texel: bake.worldSize / bake.res, height: bake.height, water: bake.water,
};
const R = world.res, TEXEL = world.texel, HALF = world.half;

const th = process.hrtime.bigint();
const hydro = buildHydroField(world.height, world.water, R, world.worldSize);
const hms = Number(process.hrtime.bigint() - th) / 1e6;
const dbg = {};
const tw = process.hrtime.bigint();
const built = buildWaterSurface(world, dbg);
const wms = Number(process.hrtime.bigint() - tw) / 1e6;
console.log(`hydro ${hms.toFixed(0)} ms  (${hydro.stages.map(s => s.join(' ')).join(', ')})`);
console.log(`mesh  ${wms.toFixed(0)} ms   quads ${built.quads} tris ${built.triangles}`);

const { G, quadM, drawn, mask, wet } = dbg;
const HR = hydro.res;
console.log(`grids: hydro ${HR}@${hydro.texel}m   mesh ${G}@${quadM}m   ${HR === G ? 'ALIGNED' : 'MISALIGNED'}`);

const cellA = quadM * quadM;
const label = (pred) => {
  const N = G * G;
  const seen = new Uint8Array(N), stack = new Int32Array(N), comp = new Int32Array(N);
  const out = [];
  for (let s0 = 0; s0 < N; s0++) {
    if (seen[s0] || !pred(s0)) continue;
    let sp = 0, n = 0; stack[sp++] = s0; seen[s0] = 1;
    let sx = 0, sz = 0;
    while (sp > 0) {
      const k = stack[--sp]; comp[n++] = k;
      const cx = k % G, cz = (k / G) | 0; sx += cx; sz += cz;
      if (cx > 0 && !seen[k - 1] && pred(k - 1)) { seen[k - 1] = 1; stack[sp++] = k - 1; }
      if (cx < G - 1 && !seen[k + 1] && pred(k + 1)) { seen[k + 1] = 1; stack[sp++] = k + 1; }
      if (cz > 0 && !seen[k - G] && pred(k - G)) { seen[k - G] = 1; stack[sp++] = k - G; }
      if (cz < G - 1 && !seen[k + G] && pred(k + G)) { seen[k + G] = 1; stack[sp++] = k + G; }
    }
    out.push({ n, x: -HALF + (sx / n + 0.5) * quadM, z: -HALF + (sz / n + 0.5) * quadM });
  }
  out.sort((a, b) => b.n - a.n);
  return out;
};

const hydroWet = (k) => hydro.depth[k] > 0.02;
const report = (name, pred) => {
  const comps = label(pred);
  let n = 0; for (const c of comps) n += c.n;
  console.log(`\n${name}: ${n} cells = ${(n * cellA / 1e6).toFixed(4)} km2 in ${comps.length} components`);
  for (const c of comps.slice(0, 8)) {
    console.log(`   ${String(c.n).padStart(7)} cells ${(c.n * cellA).toFixed(0).padStart(8)} m2  at (${c.x.toFixed(0)}, ${c.z.toFixed(0)})`);
  }
};

let nH = 0, nD = 0;
for (let k = 0; k < G * G; k++) { if (hydroWet(k)) nH++; if (drawn[k]) nD++; }
console.log(`\nhydro depth>0.02   ${nH} cells (${(nH / (G * G) * 100).toFixed(2)}% of map)`);
console.log(`mesh drawn         ${nD} cells (${(nD / (G * G) * 100).toFixed(2)}%)`);

report('HYDRO WET, MESH DRAWS NOTHING', (k) => hydroWet(k) && !drawn[k]);
report('MESH DRAWS, HYDRO DRY', (k) => !hydroWet(k) && drawn[k]);

// ── the other half of the question: aShore's mask vs hydro's mask, at 2 m ──
// Water.js's aShore transform is seeded from the raw texel mask; hydroField's
// sdf is seeded from that mask CLEANED. How far apart are the two seeds?
{
  const N = R * R;
  let raw = 0, diffAdd = 0, diffDel = 0;
  const bw = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const v = world.water[i];
    bw[i] = (v > -9000 && v > world.height[i]) ? 1 : 0;
    if (bw[i]) raw++;
  }
  // Re-derive hydro's cleaned mask from its own published sdf sign at 2 m is
  // not possible (the field is stored at 4 m), so compare against the stored
  // wet coverage channel instead, which IS the cleaned mask area-averaged.
  let hw = 0;
  for (let k = 0; k < HR * HR; k++) hw += hydro.wet[k];
  console.log(`\nraw bake wet   ${(raw / N * 100).toFixed(3)}% of map (${(raw * TEXEL * TEXEL / 1e6).toFixed(3)} km2)`);
  console.log(`hydro cleaned  ${(hw / (HR * HR) * 100).toFixed(3)}% of map (${(hw * hydro.texel * hydro.texel / 1e6).toFixed(3)} km2)`);
  void diffAdd; void diffDel;
}

// mesh mask vs wet
let nMask = 0, nWetQ = 0;
for (let k = 0; k < G * G; k++) { if (mask[k]) nMask++; if (wet[k]) nWetQ++; }
console.log(`mesh quad wet  ${(nWetQ / (G * G) * 100).toFixed(3)}%   mask(+dilation) ${(nMask / (G * G) * 100).toFixed(3)}%`);

// ── the contradiction the ghost loop needs: depth says WET, mask says DRY ──
{
  const N = HR * HR;
  const pred = (k) => hydro.depth[k] > 0.02 && hydro.wet[k] === 0;
  const predDeep = (k) => hydro.depth[k] > 0.50 && hydro.wet[k] === 0;
  const lab = (p) => {
    const seen = new Uint8Array(N), stack = new Int32Array(N);
    const out = [];
    for (let s0 = 0; s0 < N; s0++) {
      if (seen[s0] || !p(s0)) continue;
      let sp = 0, n = 0, sx = 0, sz = 0; stack[sp++] = s0; seen[s0] = 1;
      while (sp > 0) {
        const k = stack[--sp]; n++;
        const cx = k % HR, cz = (k / HR) | 0; sx += cx; sz += cz;
        if (cx > 0 && !seen[k - 1] && p(k - 1)) { seen[k - 1] = 1; stack[sp++] = k - 1; }
        if (cx < HR - 1 && !seen[k + 1] && p(k + 1)) { seen[k + 1] = 1; stack[sp++] = k + 1; }
        if (cz > 0 && !seen[k - HR] && p(k - HR)) { seen[k - HR] = 1; stack[sp++] = k - HR; }
        if (cz < HR - 1 && !seen[k + HR] && p(k + HR)) { seen[k + HR] = 1; stack[sp++] = k + HR; }
      }
      out.push({ n, x: -HALF + (sx / n + 0.5) * hydro.texel, z: -HALF + (sz / n + 0.5) * hydro.texel });
    }
    out.sort((a, b) => b.n - a.n);
    return out;
  };
  for (const [nm, p] of [['depth>0.02 & wet==0', pred], ['depth>0.50 & wet==0', predDeep]]) {
    const c = lab(p);
    let n = 0; for (const x of c) n += x.n;
    console.log(`\nCONTRADICTION ${nm}: ${n} cells in ${c.length} comps`);
    for (const x of c.slice(0, 6)) console.log(`   ${String(x.n).padStart(6)} cells at (${x.x.toFixed(0)}, ${x.z.toFixed(0)})`);
  }
  // ...and the same, against the mesh's own idea of standing water.
  let a = 0, b = 0, c2 = 0;
  for (let k = 0; k < N; k++) {
    const hw = hydro.depth[k] > 0.02;
    if (hw && !wet[k]) a++;
    if (!hw && wet[k]) b++;
    if (hw && !drawn[k]) c2++;
  }
  console.log(`\nhydro wet & mesh quad NOT standing: ${a} cells (${(a * cellA).toFixed(0)} m2)`);
  console.log(`mesh quad standing & hydro NOT wet: ${b} cells`);
  console.log(`hydro wet & no triangles at all:    ${c2} cells`);
}
