// Visible-contact audit for crag blocks, offline.
//
// A block is "grounded" to the eye when some part of it disappears INTO the
// hill from the camera's viewpoint — i.e. at least one of its points is behind
// the terrain along the ray that reaches it. A block every one of whose points
// is in front of the terrain has no ground line anywhere in its silhouette and
// reads as detached, no matter how far its lowest vertex is below the
// heightfield vertically (which is all the old rockfloat.mjs measured).
//
//   node tools/_scratch/rockview.mjs [view] [bakeRes]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import * as THREE from 'three';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { RockScatter } from '../../src/rocks/RockScatter.js';
import { buildRockLibrary, archFootprints } from '../../src/rocks/RockForms.js';
import { SEED } from '../../src/world/WorldConfig.js';
// Inlined so importing shot.mjs does not run a capture.
const VIEWS = {
  hero:   { anchor: 'vista', height: 62, dist: 150, pitch: -0.16, fov: 46 },
  peaks:  { anchor: 'peak',  height: 120, dist: 420, pitch: -0.10, fov: 42 },
  dawn:   { anchor: 'vista', height: 48, dist: 130, pitch: -0.13, fov: 46 },
  meadow: { anchor: 'meadow', height: 1.6, dist: 6, pitch: -0.05, fov: 58 },
  drive:  { anchor: 'road',  height: 4.2, dist: 12, pitch: -0.10, fov: 55, standOff: 16 },
  river:  { anchor: 'river', height: 6.0, dist: 30, pitch: -0.18, fov: 54, yawOffset: 0.42, index: 3 },
  waterfall: { anchor: 'waterfall', height: 11, dist: 58, pitch: 0.08, fov: 50, yawOffset: -0.55 },
};

const viewName = process.argv[2] || 'peaks';
const res = process.argv[3] || '768';
const dir = new URL('../../public/bakes/', import.meta.url);
const file = readdirSync(dir).find((f) => f.startsWith(`world-${SEED}-${res}-`));
const buf = readFileSync(new URL(file, dir));
const data = decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const world = new WorldData(data, SEED);
const sc = new RockScatter(world, SEED);
const lib = buildRockLibrary(SEED);
sc.setFootprints(archFootprints(lib));
// review/anchors.json is the tracked pin file; shots/_anchors.json was the old
// location and is gitignored scratch that gets pruned mid-run.
const anchors = JSON.parse(readFileSync(new URL(
  existsSync(new URL('../../review/anchors.json', import.meta.url))
    ? '../../review/anchors.json' : '../../shots/_anchors.json', import.meta.url), 'utf8'));

const v = VIEWS[viewName];
const a = anchors[v.anchor];
const yaw = (a.yaw ?? 0) + (v.yawOffset ?? 0);
const back = v.standOff ?? 0;
const gx = a.x - Math.sin(yaw) * back, gz = a.z - Math.cos(yaw) * back;
const cam = new THREE.PerspectiveCamera(v.fov, 1600 / 900, 0.1, 6000);
cam.position.set(gx, world.getHeight(gx, gz) + v.height, gz);
cam.lookAt(gx + Math.sin(yaw) * v.dist,
  cam.position.y + Math.tan(v.pitch) * v.dist,
  gz + Math.cos(yaw) * v.dist);
cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
console.log(`view ${viewName} cam ${cam.position.x.toFixed(0)},${cam.position.y.toFixed(0)},${cam.position.z.toFixed(0)}`);

// First terrain hit along a ray, by marching the analytic field. The rendered
// mesh tracks it within a metre at every LOD the crags are seen at (measured
// live: mean 0.2–0.6 m sag), so the analytic field is the right proxy here.
const rayDir = new THREE.Vector3(), sp = new THREE.Vector3();
function terrainDist(from, to) {
  rayDir.copy(to).sub(from);
  const len = rayDir.length();
  rayDir.divideScalar(len);
  const far = Math.min(3000, len + 1200);
  let step = 3.0, t = 1.0, prev = null;
  while (t < far) {
    sp.copy(rayDir).multiplyScalar(t).add(from);
    const h = world.getHeight(sp.x, sp.z);
    const d = sp.y - h;
    if (d <= 0) {
      // refine
      let lo = prev ?? t - step, hi = t;
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2;
        sp.copy(rayDir).multiplyScalar(mid).add(from);
        if (sp.y - world.getHeight(sp.x, sp.z) <= 0) hi = mid; else lo = mid;
      }
      return hi;
    }
    prev = t;
    step = Math.min(12, Math.max(2.5, d * 0.55));
    t += step;
  }
  return Infinity;
}

const CELL = 64, STREAM = 1000;
const ccx = Math.floor(cam.position.x / CELL), ccz = Math.floor(cam.position.z / CELL);
const R = Math.ceil(STREAM / CELL);
const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
const vv = new THREE.Vector3(), cc = new THREE.Vector3();
const frustum = new THREE.Frustum().setFromProjectionMatrix(
  new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
const ONLY = process.env.ROCKARCH ? new Set(process.env.ROCKARCH.split(',')) : null;
const CRAG = new Set(['cliff', 'tower', 'prow', 'bench', 'ledge']);
const rows = [];
for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
  const mx = (ccx + dx + 0.5) * CELL, mz = (ccz + dz + 0.5) * CELL;
  const dcell = Math.hypot(mx - cam.position.x, mz - cam.position.z);
  if (dcell > STREAM) continue;
  const need = (2 * dcell) / 88;
  const minSize = need < 0.9 ? 0 : need < 2.2 ? 0.8 : need < 4.0 ? 2.0 : need < 6.5 ? 3.8
    : need < 10 ? 6.2 : need < 15 ? 9.6 : need < 22 ? 14.5 : need < 30 ? 21.0 : 29.0;
  const out = [];
  sc.generateCell(ccx + dx, ccz + dz, CELL, minSize, out);
  for (const i of out) {
    if (ONLY ? !ONLY.has(i.arch) : !CRAG.has(i.arch)) continue;
    const dd = Math.hypot(i.x - cam.position.x, i.z - cam.position.z);
    if (dd > i.vis) continue;
    cc.set(i.x, i.y, i.z);
    if (!frustum.containsPoint(cc)) continue;
    const geoms = lib[i.arch]; if (!geoms) continue;
    const gi = Math.min(geoms.length - 1, (i.rnd * geoms.length) | 0);
    const pos = geoms[gi].attributes.position.array;
    p.copy(cc); q.set(i.qx, i.qy, i.qz, i.qw); s.set(i.sx, i.sy, i.sz);
    m.compose(p, q, s);
    const nv = pos.length / 3;
    // Local-frame Y tells base from cap; the base is what has to be in the hill.
    let loY = Infinity, hiY = -Infinity;
    for (let k = 1; k < pos.length; k += 3) { if (pos[k] < loY) loY = pos[k]; if (pos[k] > hiY) hiY = pos[k]; }
    const mid = loY + (hiY - loY) * 0.25;
    let baseClear = -Infinity, minClear = Infinity, lowY = Infinity, footClear = 0;
    let nAll = 0, nBuried = 0;
    for (let k = 0; k < pos.length; k += 3) {
      vv.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(m);
      const cl = vv.y - world.getHeight(vv.x, vv.z);
      if (cl < minClear) minClear = cl;
      if (vv.y < lowY) { lowY = vv.y; footClear = cl; }
      if (pos[k + 1] <= mid && cl > baseClear) baseClear = cl;
      nAll++; if (cl < 0) nBuried++;
    }
    const buried = nBuried / Math.max(1, nAll);
    const ndc = cc.clone().project(cam);
    rows.push({ arch: i.arch, kind: i.kind, baseClear, footClear, minClear, buried,
      px: Math.round((ndc.x * 0.5 + 0.5) * 1600), py: Math.round((0.5 - ndc.y * 0.5) * 900),
      d: cc.distanceTo(cam.position), x: i.x, y: i.y, z: i.z, size: i.size });
  }
}
// Isolation: a block with no neighbour inside a couple of its own widths has no
// chain to belong to, which is the other half of the "detached" read.
for (const r of rows) {
  let near = 0;
  for (const o of rows) {
    if (o === r) continue;
    const d3 = Math.hypot(o.x - r.x, o.y - r.y, o.z - r.z);
    if (d3 < r.size * 2.4) near++;
  }
  r.near = near;
}
const det = rows.slice().sort((a, b) => b.baseClear - a.baseClear);
const n = rows.length || 1;
const pc = (f) => `${rows.filter(f).length} (${(100 * rows.filter(f).length / n).toFixed(0)}%)`;
console.log(`crag blocks in frustum: ${rows.length}`);
console.log(`base hangs over air  >0m: ${pc((r) => r.baseClear > 0)}  >2m: ${pc((r) => r.baseClear > 2)}  >5m: ${pc((r) => r.baseClear > 5)}  >10m: ${pc((r) => r.baseClear > 10)}`);
const bc = rows.map((r) => r.baseClear).sort((a, b) => a - b);
const qt = (f) => bc.length ? bc[Math.min(bc.length - 1, Math.floor(f * bc.length))].toFixed(1) : 'n/a';
console.log(`baseClear median ${qt(0.5)}  p90 ${qt(0.9)}  max ${qt(0.999)}`);
console.log(`sitting on top (buried<15% of the mesh): ${pc((r) => r.buried < 0.15)}   <30%: ${pc((r) => r.buried < 0.30)}`);
const bf = rows.map((r) => r.buried).sort((a, b) => a - b);
console.log(`buried fraction median ${(bf.length ? bf[bf.length >> 1] : 0).toFixed(2)}`);
console.log(`lowest vertex above its own ground >0m: ${pc((r) => r.footClear > 0)}  >2m: ${pc((r) => r.footClear > 2)}  >5m: ${pc((r) => r.footClear > 5)}`);
console.log(`no contact at all (minClear>0): ${pc((r) => r.minClear > 0)}`);
console.log(`isolated (no neighbour within 2.4 sizes): ${pc((r) => r.near === 0)}   only one: ${pc((r) => r.near === 1)}`);
console.log('worst:', det.slice(0, 12).map((r) => `${r.arch} base+${r.baseClear.toFixed(1)} px${r.px},${r.py} d${r.d | 0} sz${r.size.toFixed(0)} @${r.x | 0},${r.z | 0}`));
if (process.env.ROCKDUMP) {
  for (const r of rows.slice().sort((a, b) => a.px - b.px)) {
    console.log(`${r.arch}/${r.kind} px${r.px},${r.py} d${r.d | 0} sz${r.size.toFixed(1)} buried${r.buried.toFixed(2)} base${r.baseClear.toFixed(1)} near${r.near} @${r.x | 0},${r.y | 0},${r.z | 0}`);
  }
}
// What is at a given pixel? node ... peaks 768 <px> <py>
const qx = Number(process.argv[4]), qy = Number(process.argv[5]);
if (Number.isFinite(qx) && Number.isFinite(qy)) {
  const near = rows.filter((r) => Math.hypot(r.px - qx, r.py - qy) < 60)
    .sort((a, b) => Math.hypot(a.px - qx, a.py - qy) - Math.hypot(b.px - qx, b.py - qy));
  console.log(`at pixel ${qx},${qy}:`, near.slice(0, 8).map((r) => `${r.arch}/${r.kind} buried${r.buried.toFixed(2)} base${r.baseClear.toFixed(1)} foot${r.footClear.toFixed(1)} px${r.px},${r.py} sz${r.size.toFixed(0)} d${r.d | 0} @${r.x | 0},${r.z | 0}`));
}
