// Headless float audit.
//
// The metric that matters: for every vertex of a placed block, how far does it
// sit ABOVE the ground directly beneath *that vertex*? A block is in contact
// with the hill iff at least one vertex is below the surface, i.e.
//   clearance = min over vertices of (v.y - height(v.x, v.z))
// is <= 0. The previous version of this script instead measured the block's
// lowest vertex against the terrain at the block's *centre*, which on a 40°
// face is metres of ground drop away from where that vertex actually is — that
// test reports "buried" for a block whose entire downhill half hangs in space,
// and is why three passes concluded nothing was floating.
//
// usage: node tools/_scratch/rockfloat.mjs <x> <z> <cellRadius> <bakeRes>
import { readFileSync, readdirSync } from 'node:fs';
import * as THREE from 'three';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { RockScatter } from '../../src/rocks/RockScatter.js';
import { buildRockLibrary, archFootprints } from '../../src/rocks/RockForms.js';
import { SEED } from '../../src/world/WorldConfig.js';

const res = process.argv[5] || '768';
const dir = new URL('../../public/bakes/', import.meta.url);
const file = readdirSync(dir).find((f) => f.startsWith(`world-${SEED}-${res}-`));
const buf = readFileSync(new URL(file, dir));
const data = decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const world = new WorldData(data, SEED);
const sc = new RockScatter(world, SEED);
const lib = buildRockLibrary(SEED);
sc.setFootprints(archFootprints(lib));

const CELL = 64, R = Number(process.argv[4] ?? 12);
const cx0 = Math.round(Number(process.argv[2]) / CELL), cz0 = Math.round(Number(process.argv[3]) / CELL);
const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
const v3 = new THREE.Vector3();
const rows = [];
for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
  const out = [];
  sc.generateCell(cx0 + dx, cz0 + dz, CELL, 0, out);
  for (const i of out) {
    const geoms = lib[i.arch]; if (!geoms) continue;
    const v = Math.min(geoms.length - 1, (i.rnd * geoms.length) | 0);
    const pos = geoms[v].attributes.position.array;
    p.set(i.x, i.y, i.z); q.set(i.qx, i.qy, i.qz, i.qw); s.set(i.sx, i.sy, i.sz);
    m.compose(p, q, s);
    let clear = Infinity, cxp = 0, czp = 0;
    for (let k = 0; k < pos.length; k += 3) {
      v3.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(m);
      const g = v3.y - world.getHeight(v3.x, v3.z);
      if (g < clear) { clear = g; cxp = v3.x; czp = v3.z; }
    }
    rows.push({ clear, arch: i.arch, kind: i.kind, size: i.size, x: i.x, z: i.z, cxp, czp });
  }
}
rows.sort((a, b) => b.clear - a.clear);
const sel = (k) => rows.filter((r) => r.kind === k);
const stat = (list) => {
  if (!list.length) return 'none';
  const f0 = list.filter((r) => r.clear > 0).length;
  const f3 = list.filter((r) => r.clear > 3).length;
  const f10 = list.filter((r) => r.clear > 10).length;
  const worst = list[0].clear;
  return `n=${list.length} float>0m ${f0} (${(100 * f0 / list.length).toFixed(0)}%) >3m ${f3} >10m ${f10} worst ${worst.toFixed(1)}m`;
};
console.log('ALL  ', stat(rows));
for (const k of [...new Set(rows.map((r) => r.kind))]) console.log(k.padEnd(6), stat(sel(k)));
const byArch = {};
for (const r of rows) (byArch[r.arch] ??= []).push(r);
for (const [a, l] of Object.entries(byArch)) { l.sort((x, y) => y.clear - x.clear); console.log(' ', a.padEnd(9), stat(l)); }
console.log('worst 10:', rows.slice(0, 10).map((r) => `${r.arch}/${r.kind} ${r.clear.toFixed(1)}m sz${r.size.toFixed(1)} @${r.x.toFixed(0)},${r.z.toFixed(0)}`));
