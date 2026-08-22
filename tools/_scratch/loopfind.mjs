#!/usr/bin/env node
// Where in the world is the ghost loop? Reconstruct shot.mjs's `mouth` pose
// offline, march the heightfield along the ray through a given pixel, and dump
// every field the terrain shader's damp term reads at the hit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { buildHydroField } from '../../src/world/hydroField.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/bakes/manifest.json'), 'utf8'));
const entry = man.entries.find((e) => e.res === 1536 && e.hash === man.current);
const buf = fs.readFileSync(path.join(ROOT, 'public/bakes', entry.file));
const bake = decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const R = bake.res, WS = bake.worldSize, HALF = WS / 2, TEXEL = WS / R;
const hydro = buildHydroField(bake.height, bake.water, R, WS);
const HR = hydro.res, HT = hydro.texel;

const bilinAt = (arr, res, texel, x, z) => {
  let gx = (x + HALF) / texel - 0.5, gz = (z + HALF) / texel - 0.5;
  gx = Math.min(res - 1.001, Math.max(0, gx)); gz = Math.min(res - 1.001, Math.max(0, gz));
  const x0 = gx | 0, z0 = gz | 0, tx = gx - x0, tz = gz - z0;
  const a = arr[z0 * res + x0], b = arr[z0 * res + x0 + 1];
  const c = arr[(z0 + 1) * res + x0], d = arr[(z0 + 1) * res + x0 + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
};
const H = (x, z) => bilinAt(bake.height, R, TEXEL, x, z);
const HD = (ch, x, z) => bilinAt(hydro[ch], HR, HT, x, z);

const ANCH = JSON.parse(fs.readFileSync(path.join(ROOT, 'review/anchors.json'), 'utf8'));
// shot.mjs's VIEWS, copied for the framings this measurement uses.
const VIEWS = {
  mouth:     { a: 'mouth',     height: 5.0, dist: 26,  pitch: -0.16, fov: 54, yawOffset: 0 },
  backwater: { a: 'mouth',     height: 2.2, dist: 14,  pitch: 0.02,  fov: 54, yawOffset: 0 },
  river:     { a: 'river',     height: 6.0, dist: 30,  pitch: -0.18, fov: 54, yawOffset: 0.42 },
  waterfall: { a: 'waterfall', height: 11,  dist: 58,  pitch: 0.08,  fov: 50, yawOffset: -0.55 },
  hero:      { a: 'vista',     height: 62,  dist: 150, pitch: -0.16, fov: 46, yawOffset: 0 },
  drive:     { a: 'road',      height: 4.2, dist: 12,  pitch: -0.10, fov: 55, yawOffset: 0, standOff: 16 },
};
const VNAME = process.argv.includes('--view') ? process.argv[process.argv.indexOf('--view') + 1] : 'mouth';
const VV = VIEWS[VNAME];
const A = { ...ANCH[VV.a], yaw: ANCH[VV.a].yaw + VV.yawOffset };
const V = { height: VV.height, dist: VV.dist, pitch: VV.pitch, fov: VV.fov };
// shot.mjs's LANDSCAPE branch, not its subject branch: the camera STANDS AT
// the anchor (stepped back by standOff, 16 m only on `drive`) and looks along
// the anchor's yaw. Modelling the subject branch instead put the camera a full
// `dist` behind the anchor -- 26 m at mouth -- which is a 7% error in every
// range and therefore in every footM on this page.
const yaw = A.yaw;
const back = VV.standOff ?? 0;
const gx = A.x - Math.sin(yaw) * back, gz = A.z - Math.cos(yaw) * back;
const gy = H(gx, gz) + V.height;
const look = [gx + Math.sin(yaw) * V.dist, gy + Math.tan(V.pitch) * V.dist, gz + Math.cos(yaw) * V.dist];
const cam = [gx, gy, gz];
console.log(`cam ${cam.map((v) => v.toFixed(1))}  look ${look.map((v) => v.toFixed(1))}  eye above bed ${V.height}`);

// camera basis
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const nrm = (a) => { const L = Math.hypot(...a); return [a[0] / L, a[1] / L, a[2] / L]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const fwd = nrm(sub(look, cam));
const right = nrm(cross(fwd, [0, 1, 0]));
const up = cross(right, fwd);
const W = 1600, HGT = 900;
const tanH = Math.tan(V.fov * Math.PI / 360);
const aspect = W / HGT;

function rayHit(px, py) {
  const ndcX = (px + 0.5) / W * 2 - 1, ndcY = 1 - (py + 0.5) / HGT * 2;
  const d = nrm([
    fwd[0] + right[0] * ndcX * tanH * aspect + up[0] * ndcY * tanH,
    fwd[1] + right[1] * ndcX * tanH * aspect + up[1] * ndcY * tanH,
    fwd[2] + right[2] * ndcX * tanH * aspect + up[2] * ndcY * tanH,
  ]);
  let t = 0.5, prev = cam[1] - H(cam[0], cam[2]);
  for (let i = 0; i < 40000; i++) {
    t += 0.25;
    if (t > 2500) return null;
    const p = [cam[0] + d[0] * t, cam[1] + d[1] * t, cam[2] + d[2] * t];
    const dh = p[1] - H(p[0], p[2]);
    if (dh <= 0 && prev > 0) {
      // bisect
      let lo = t - 0.25, hi = t;
      for (let j = 0; j < 30; j++) {
        const m = (lo + hi) / 2;
        const q = [cam[0] + d[0] * m, cam[1] + d[1] * m, cam[2] + d[2] * m];
        if (q[1] - H(q[0], q[2]) > 0) lo = m; else hi = m;
      }
      const m = (lo + hi) / 2;
      return { t: m, p: [cam[0] + d[0] * m, cam[1] + d[1] * m, cam[2] + d[2] * m] };
    }
    prev = dh;
  }
  return null;
}

if (process.argv.includes('--scan')) {
  // Screen-weighted distribution of footM and slope over the pixels the
  // submerged damp band is drawn on: hydro depth in (0.02, 0.50). This is the
  // number that matters and the map-weighted one is not it — a bank you can
  // see is a bank turned towards you, and at range one pixel covers many band
  // cells.
  const fs2 = [], sl = [], rg = [];
  for (let py = 0; py < 900; py += 2) for (let px = 0; px < 1600; px += 2) {
    const h = rayHit(px, py); if (!h) continue;
    const [x, y, z] = h.p;
    const dep = HD('depth', x, z);
    if (!(dep > 0.02 && dep < 0.50)) continue;
    const e = 2.0;
    const nx = -(H(x + e, z) - H(x - e, z)) / (2 * e), nz = -(H(x, z + e) - H(x, z - e)) / (2 * e);
    const N = nrm([nx, 1, nz]);
    const V = nrm(sub(cam, h.p));
    const gz2 = Math.max(Math.abs(N[0] * V[0] + N[1] * V[1] + N[2] * V[2]), 0.30);
    fs2.push(h.t * 0.0012 / gz2); sl.push(bilinAt(bake.slope, R, TEXEL, x, z)); rg.push(h.t);
    void y;
  }
  const P = (a, q) => a.length ? a.slice().sort((m, n) => m - n)[Math.floor(a.length * q)] : NaN;
  const over = (a, t) => (a.filter((v) => v > t).length / a.length * 100).toFixed(0);
  console.log(`band pixels sampled ${fs2.length}`);
  console.log(`  footM  p10 ${P(fs2, .1).toFixed(2)} p50 ${P(fs2, .5).toFixed(2)} p90 ${P(fs2, .9).toFixed(2)}   >0.15 ${over(fs2, 0.15)}%  >0.45 ${over(fs2, 0.45)}%`);
  console.log(`  slope  p10 ${P(sl, .1).toFixed(2)} p50 ${P(sl, .5).toFixed(2)} p90 ${P(sl, .9).toFixed(2)}   >0.58 ${over(sl, 0.58)}%  >1.15 ${over(sl, 1.15)}%`);
  console.log(`  range  p10 ${P(rg, .1).toFixed(0)} p50 ${P(rg, .5).toFixed(0)} p90 ${P(rg, .9).toFixed(0)} m`);
  process.exit(0);
}
const pts = process.argv.slice(2).length
  ? process.argv.slice(2).map((s) => s.split(',').map(Number))
  : [[1046, 181], [1065, 200], [1065, 240], [1065, 300], [1035, 250], [1090, 250], [1065, 170], [800, 500], [1065, 130]];
// footM is the terrain shader's own analytic pixel footprint:
//   graze = max(|dot(V, N)|, 0.30);  footM = camDist * 0.0012 / graze
// computed here from the bake's own normal at the ray hit, so it is the same
// number the fragment shader computes and not a model of it.
const normAt = (x, z) => {
  const e = 2.0;
  const nx = -(H(x + e, z) - H(x - e, z)) / (2 * e);
  const nz = -(H(x, z + e) - H(x, z - e)) / (2 * e);
  return nrm([nx, 1, nz]);
};
console.log('  px      py     range      world x,y,z            bedH   hydro.depth  sdf    wet   span   slope  graze  footM');
for (const [px, py] of pts) {
  const h = rayHit(px, py);
  if (!h) { console.log(`${String(px).padStart(5)} ${String(py).padStart(5)}   MISS (sky)`); continue; }
  const [x, y, z] = h.p;
  const dep = HD('depth', x, z), sdf = HD('sdf', x, z), wet = HD('wet', x, z), span = HD('span', x, z);
  const bw = bilinAt(bake.water, R, TEXEL, x, z);
  const N = normAt(x, z);
  const V = nrm(sub(cam, h.p));
  const graze = Math.max(Math.abs(N[0] * V[0] + N[1] * V[1] + N[2] * V[2]), 0.30);
  const footM = h.t * 0.0012 / graze;
  const slope = Math.hypot(N[0], N[2]) / Math.max(N[1], 1e-3);
  void bw;
  console.log(`${String(px).padStart(5)} ${String(py).padStart(5)} ${h.t.toFixed(1).padStart(8)}  (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})  ${H(x, z).toFixed(2).padStart(7)} ${dep.toFixed(3).padStart(9)} ${sdf.toFixed(2).padStart(8)} ${wet.toFixed(2).padStart(6)} ${span.toFixed(1).padStart(6)} ${slope.toFixed(2).padStart(6)} ${graze.toFixed(2).padStart(6)} ${footM.toFixed(3).padStart(6)}`);
}
