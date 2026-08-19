// Headless float audit: for every crag instance in a region, transform the
// geometry's bounding-box corners into the world and ask how far the lowest one
// sits *above* the terrain under it. Anything over ~0 m is a visibly detached
// block, which is the defect that has made crag geometry unusable twice.
import { readFileSync, readdirSync } from 'node:fs';
import * as THREE from 'three';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { RockScatter } from '../../src/rocks/RockScatter.js';
import { buildRockLibrary } from '../../src/rocks/RockForms.js';
import { SEED } from '../../src/world/WorldConfig.js';

const res = process.argv[5] || '768';
const dir = new URL('../../public/bakes/', import.meta.url);
const file = readdirSync(dir).find((f) => f.startsWith(`world-${SEED}-${res}-`));
const buf = readFileSync(new URL(file, dir));
const data = decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const world = new WorldData(data, SEED);
const sc = new RockScatter(world, SEED);
const lib = buildRockLibrary(SEED);

const CELL = 64, R = Number(process.argv[4] ?? 12);
const cx0 = Math.round(Number(process.argv[2]) / CELL), cz0 = Math.round(Number(process.argv[3]) / CELL);
const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
const gaps = [];
const byArch = {};
for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
  const out = [];
  sc.generateCell(cx0 + dx, cz0 + dz, CELL, 0, out);
  for (const i of out) {
    const geoms = lib[i.arch]; if (!geoms) continue;
    const v = Math.min(geoms.length - 1, (i.rnd * geoms.length) | 0);
    const pos = geoms[v].attributes.position.array;
    p.set(i.x, i.y, i.z); q.set(i.qx, i.qy, i.qz, i.qw); s.set(i.sx, i.sy, i.sz);
    m.compose(p, q, s);
    // The real question is not whether *some* corner is buried — an overhanging
    // block always has its uphill corner in the hill and still reads as
    // floating. It is how far the block's own lowest vertex sits above the
    // ground under the block's centre.
    let gap = Infinity, gx = 0, gz = 0, lowY = Infinity;
    const v3 = new THREE.Vector3();
    for (let k = 0; k < pos.length; k += 3) {
      v3.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(m);
      if (v3.y < lowY) { lowY = v3.y; gx = v3.x; gz = v3.z; }
      const g = v3.y - world.getHeight(v3.x, v3.z);
      if (g < gap) gap = g;
    }
    gap = lowY - world.getHeight(i.x, i.z);
    gaps.push({ gap, arch: i.arch, kind: i.kind, size: i.size, x: i.x, z: i.z, lowY, gx, gz });
    const b = byArch[i.arch] ?? (byArch[i.arch] = { n: 0, float: 0, worst: -1e9 });
    b.n++; if (gap > 0.5) b.float++; if (gap > b.worst) b.worst = gap;
  }
}
gaps.sort((a, b) => b.gap - a.gap);
const crag = gaps.filter((g) => g.kind === 'crag');
console.log('instances', gaps.length, 'crag', crag.length,
  'crag floating >0.5m:', crag.filter((g) => g.gap > 0.5).length,
  '>3m:', crag.filter((g) => g.gap > 3).length);
console.log(Object.fromEntries(Object.entries(byArch).map(([k, v]) => [k, `${v.float}/${v.n} worst ${v.worst.toFixed(1)}`])));
console.log(crag.slice(0, 8).map((g) => ({ gap: +g.gap.toFixed(1), arch: g.arch, size: +g.size.toFixed(1) })));
