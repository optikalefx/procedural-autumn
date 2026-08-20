#!/usr/bin/env node
/**
 * Headless floater census for the whole world, or for one view's frustum.
 *
 * Why a fourth one of these. `rockfloat.mjs` and `rockview.mjs` both pick the
 * drawn mesh with `gi = (inst.rnd * geoms.length) | 0` — the variant rule that
 * `_place` stopped using when it started planting blocks on their own base
 * corners. `Rocks._repack` draws `byArch[arch][inst.variant]`, and measured
 * over a patch of the peak massif **67 % of instances resolve to a different
 * geometry than the one those tools measure**. Both therefore report the
 * clearance of a mesh that is not on screen, which is how they came back with
 * "nothing floats in `meadow`" against a frame with a dozen blocks in the air.
 *
 * Definitions, in the order they matter:
 *
 *   foot    lowest drawn vertex minus the ground directly under that vertex.
 *           > 0 means the whole block is off the ground: the literal floater.
 *   base    the largest clearance among the vertices in the bottom quarter of
 *           the mesh. > 0 means part of the base stands in air even if some
 *           other corner is buried — the "sky visible underneath" read.
 *   buried  fraction of vertices below the surface. A block emerging from a
 *           hillside is 40-70 %; a crate set on one is near 0.
 *
 *   node tools/_scratch/rockair.mjs                 # whole world
 *   node tools/_scratch/rockair.mjs --view meadow   # one view's frustum, with pixels
 *   node tools/_scratch/rockair.mjs --view peaks --dump
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import * as THREE from 'three';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { RockScatter, VIS_PER_METRE } from '../../src/rocks/RockScatter.js';
import { buildRockLibrary, archFootprints } from '../../src/rocks/RockForms.js';
import { SEED } from '../../src/world/WorldConfig.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const VIEW = arg('view', null);
const DUMP = argv.includes('--dump');
const res = arg('res', '768');

const VIEWS = {
  hero:   { anchor: 'vista',  height: 62,  dist: 150, pitch: -0.16, fov: 46 },
  peaks:  { anchor: 'peak',   height: 120, dist: 420, pitch: -0.10, fov: 42 },
  dawn:   { anchor: 'vista',  height: 48,  dist: 130, pitch: -0.13, fov: 46 },
  meadow: { anchor: 'meadow', height: 1.6, dist: 6,   pitch: -0.05, fov: 58 },
  drive:  { anchor: 'road',   height: 4.2, dist: 12,  pitch: -0.10, fov: 55, standOff: 16 },
  river:  { anchor: 'river',  height: 6.0, dist: 30,  pitch: -0.18, fov: 54, yawOffset: 0.42 },
  waterfall: { anchor: 'waterfall', height: 11, dist: 58, pitch: 0.08, fov: 50, yawOffset: -0.55 },
};

const dir = new URL('../../public/bakes/', import.meta.url);
const file = readdirSync(dir).find((f) => f.startsWith(`world-${SEED}-${res}-`));
const buf = readFileSync(new URL(file, dir));
const data = decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const world = new WorldData(data, SEED);
const lib = buildRockLibrary(SEED);
const sc = new RockScatter(world, SEED);
sc.setFootprints(archFootprints(lib));

const CELL = 64, STREAM = 1000;
let cam = null, frustum = null;
let cx0 = 0, cz0 = 0, R = Math.ceil(world.half / CELL);
if (VIEW) {
  const v = VIEWS[VIEW];
  const anchors = JSON.parse(readFileSync(new URL(
    existsSync(new URL('../../review/anchors.json', import.meta.url))
      ? '../../review/anchors.json' : '../../shots/_anchors.json', import.meta.url), 'utf8'));
  const a = anchors[v.anchor];
  const yaw = (a.yaw ?? 0) + (v.yawOffset ?? 0);
  const back = v.standOff ?? 0;
  const gx = a.x - Math.sin(yaw) * back, gz = a.z - Math.cos(yaw) * back;
  cam = new THREE.PerspectiveCamera(v.fov, 1280 / 720, 0.1, 6000);
  cam.position.set(gx, world.getHeight(gx, gz) + v.height, gz);
  cam.lookAt(gx + Math.sin(yaw) * v.dist,
    cam.position.y + Math.tan(v.pitch) * v.dist,
    gz + Math.cos(yaw) * v.dist);
  cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
  frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  cx0 = Math.floor(cam.position.x / CELL); cz0 = Math.floor(cam.position.z / CELL);
  R = Math.ceil(STREAM / CELL);
}

const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion();
const s = new THREE.Vector3(), vv = new THREE.Vector3(), cc = new THREE.Vector3();
const rows = [];
for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
  const cx = cx0 + dx, cz = cz0 + dz;
  let minSize = 0;
  if (cam) {
    const mx = (cx + 0.5) * CELL, mz = (cz + 0.5) * CELL;
    const d = Math.hypot(mx - cam.position.x, mz - cam.position.z);
    if (d > STREAM) continue;
    // Same bands as Rocks._minSizeFor, so the census sees what is packed.
    const need = (2 * d) / VIS_PER_METRE;
    minSize = need < 0.9 ? 0 : need < 2.2 ? 0.8 : need < 4.0 ? 2.0 : need < 6.5 ? 3.8
      : need < 10 ? 6.2 : need < 15 ? 9.6 : need < 22 ? 14.5 : need < 30 ? 21.0 : 29.0;
  }
  const out = [];
  sc.generateCell(cx, cz, CELL, minSize, out);
  for (const i of out) {
    const geoms = lib[i.arch]; if (!geoms) continue;
    if (cam) {
      const dd = Math.hypot(i.x - cam.position.x, i.z - cam.position.z);
      if (dd > i.vis) continue;
      cc.set(i.x, i.y, i.z);
      if (!frustum.containsPoint(cc)) continue;
    }
    // THE fix: the drawn geometry is the one `_repack` indexes with `variant`.
    const gi = Math.min(geoms.length - 1, Math.max(0, i.variant | 0));
    const pos = geoms[gi].attributes.position.array;
    p.set(i.x, i.y, i.z); q.set(i.qx, i.qy, i.qz, i.qw); s.set(i.sx, i.sy, i.sz);
    m.compose(p, q, s);
    let loY = Infinity, hiY = -Infinity;
    for (let k = 1; k < pos.length; k += 3) { if (pos[k] < loY) loY = pos[k]; if (pos[k] > hiY) hiY = pos[k]; }
    const mid = loY + (hiY - loY) * 0.25;
    let base = -Infinity, foot = 0, lowY = Infinity, nAll = 0, nBur = 0;
    for (let k = 0; k < pos.length; k += 3) {
      vv.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(m);
      const cl = vv.y - world.getHeight(vv.x, vv.z);
      if (vv.y < lowY) { lowY = vv.y; foot = cl; }
      if (pos[k + 1] <= mid && cl > base) base = cl;
      nAll++; if (cl < 0) nBur++;
    }
    const r = { arch: i.arch, kind: i.kind, variant: gi, size: i.size,
      base, foot, buried: nBur / Math.max(1, nAll), x: i.x, y: i.y, z: i.z };
    if (cam) {
      const ndc = cc.clone().project(cam);
      r.px = Math.round((ndc.x * 0.5 + 0.5) * 1280);
      r.py = Math.round((0.5 - ndc.y * 0.5) * 720);
      r.d = cc.distanceTo(cam.position);
    }
    rows.push(r);
  }
}

const n = rows.length || 1;
const pc = (f) => { const k = rows.filter(f).length; return `${String(k).padStart(5)} (${(100 * k / n).toFixed(1).padStart(5)}%)`; };
console.log(`${VIEW ? `view ${VIEW}` : 'whole world'}  instances ${rows.length}`);
console.log(`FLOATERS  foot>0 (whole block off the ground) ${pc((r) => r.foot > 0)}`);
console.log(`          foot>1m ${pc((r) => r.foot > 1)}   foot>5m ${pc((r) => r.foot > 5)}`);
console.log(`base in air >0m ${pc((r) => r.base > 0)}  >2m ${pc((r) => r.base > 2)}  >5m ${pc((r) => r.base > 5)}`);
console.log(`sitting on top (buried<15%) ${pc((r) => r.buried < 0.15)}`);
const bs = rows.map((r) => r.base).sort((a, b) => a - b);
const qt = (a, f) => a.length ? a[Math.min(a.length - 1, Math.floor(f * a.length))].toFixed(1) : 'n/a';
console.log(`base median ${qt(bs, 0.5)}  p90 ${qt(bs, 0.9)}  p99 ${qt(bs, 0.99)}  max ${qt(bs, 1)}`);
for (const k of [...new Set(rows.map((r) => r.kind))]) {
  const sub = rows.filter((r) => r.kind === k);
  const f = sub.filter((r) => r.foot > 0).length;
  console.log(`  ${k.padEnd(9)} n=${String(sub.length).padStart(5)}  foot>0 ${String(f).padStart(4)} (${(100 * f / sub.length).toFixed(1)}%)  base>0 ${(100 * sub.filter((r) => r.base > 0).length / sub.length).toFixed(1)}%`);
}
const worst = rows.filter((r) => r.foot > 0).sort((a, b) => b.foot - a.foot);
console.log('worst floaters:');
for (const r of worst.slice(0, 14)) {
  console.log(`  ${r.arch}/${r.kind} v${r.variant} foot+${r.foot.toFixed(1)} base+${r.base.toFixed(1)} sz${r.size.toFixed(1)}` +
    (r.px !== undefined ? ` px${r.px},${r.py} d${r.d | 0}` : '') + ` @${r.x | 0},${r.z | 0}`);
}
const AT = arg('at', null);
if (AT) {
  const [qx, qy] = AT.split(',').map(Number);
  const near = rows.filter((r) => r.px !== undefined && Math.hypot(r.px - qx, r.py - qy) < 70)
    .sort((a, b) => Math.hypot(a.px - qx, a.py - qy) - Math.hypot(b.px - qx, b.py - qy));
  console.log(`instances near pixel ${qx},${qy}: ${near.length}`);
  for (const r of near.slice(0, 12)) {
    console.log(`  ${r.arch}/${r.kind} v${r.variant} px${r.px},${r.py} d${r.d | 0} sz${r.size.toFixed(1)} foot${r.foot.toFixed(1)} base${r.base.toFixed(1)} buried${r.buried.toFixed(2)} y${r.y.toFixed(1)} ground${world.getHeight(r.x, r.z).toFixed(1)} @${r.x | 0},${r.z | 0}`);
  }
}
if (DUMP) for (const r of rows.filter((x) => x.foot > -1e9).sort((a, b) => a.px - b.px)) {
  console.log(`${r.arch}/${r.kind} v${r.variant} px${r.px},${r.py} d${r.d | 0} sz${r.size.toFixed(1)} foot+${r.foot.toFixed(1)} base+${r.base.toFixed(1)} buried${r.buried.toFixed(2)} @${r.x | 0},${r.z | 0}`);
}
