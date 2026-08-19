// Headless float audit for placed rock. No browser, no capture slot.
//
//   node tools/_scratch/rockfloat.mjs <x> <z> [cellRadius] [bakeRes]
//
// ── read this before you trust a number out of it ────────────────────────────
//
// Two earlier versions of this tool reported "nothing floats" while the `peaks`
// frame plainly showed crag blocks hanging in the air, and two authors believed
// them. Both measured the wrong quantity:
//
//   v1  the block's lowest vertex against the terrain at the block's *centre*.
//       On a 40-degree face the centre is twenty metres of ground drop away
//       from where that vertex actually is, so the test passes for a block
//       whose whole downhill half is in space.
//   v2  min over all vertices of (vertex.y - ground under that vertex). Sounds
//       right, but a crag block is a wedge driven into a hillside: its uphill
//       corner sits tens of metres inside the hill and owns the minimum. The
//       test therefore passes for *any* block that touches the slope anywhere,
//       including one that touches only at its buried back edge.
//
// What actually reads as floating is air under the block's BASE on the side you
// can see. So the number that matters is `base`: the highest clearance among
// the vertices in the lower part of the mesh. Positive means part of the base
// stands clear of the ground. `buried` — the fraction of the mesh below the
// surface — is the companion: a block that emerges from a hillside is 40-70%
// buried, a crate resting on one is near 0%.
//
// Measured against the analytic heightfield, which the drawn LOD mesh tracks to
// within a metre at every band the crags are seen at (raycast against the live
// `Terrain` group at the `hero` and `peaks` framings: mean sag 0.2-0.6 m, worst
// 6.4 m at 800 m). The rendered surface is not the problem and never was.
//
// For a per-view audit that reports screen coordinates, see rockview.mjs.
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
    const gi = Math.min(geoms.length - 1, (i.rnd * geoms.length) | 0);
    const pos = geoms[gi].attributes.position.array;
    p.set(i.x, i.y, i.z); q.set(i.qx, i.qy, i.qz, i.qw); s.set(i.sx, i.sy, i.sz);
    m.compose(p, q, s);
    let loY = Infinity, hiY = -Infinity;
    for (let k = 1; k < pos.length; k += 3) { if (pos[k] < loY) loY = pos[k]; if (pos[k] > hiY) hiY = pos[k]; }
    // "The base" = the bottom quarter of the mesh. Not half: a tower is three
    // times as tall as it is wide, and half of it is well clear of the ground by
    // design. The foot is what has to be in the hill.
    const BASEFRAC = Number(process.env.BASEFRAC ?? 0.25);
    const mid = loY + (hiY - loY) * BASEFRAC;
    let base = -Infinity, foot = 0, lowY = Infinity, n = 0, nb = 0;
    for (let k = 0; k < pos.length; k += 3) {
      v3.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(m);
      const cl = v3.y - world.getHeight(v3.x, v3.z);
      if (v3.y < lowY) { lowY = v3.y; foot = cl; }
      if (pos[k + 1] <= mid && cl > base) base = cl;
      n++; if (cl < 0) nb++;
    }
    rows.push({ base, foot, buried: nb / Math.max(1, n), arch: i.arch, kind: i.kind, size: i.size, x: i.x, z: i.z });
  }
}

const report = (name, list) => {
  if (!list.length) return;
  const sorted = list.slice().sort((a, b) => a.base - b.base);
  const qt = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))].base.toFixed(1);
  const pc = (f) => `${(100 * list.filter(f).length / list.length).toFixed(0)}%`;
  console.log(`${name.padEnd(11)} n=${String(list.length).padEnd(5)} ` +
    `base>0 ${pc((r) => r.base > 0).padStart(4)} >5m ${pc((r) => r.base > 5).padStart(4)} ` +
    `median ${qt(0.5).padStart(6)} p90 ${qt(0.9).padStart(6)}  ` +
    `foot>0 ${pc((r) => r.foot > 0).padStart(4)}  buried<15% ${pc((r) => r.buried < 0.15).padStart(4)}`);
};
report('ALL', rows);
for (const k of [...new Set(rows.map((r) => r.kind))]) report(k, rows.filter((r) => r.kind === k));
console.log('—');
for (const a of [...new Set(rows.map((r) => r.arch))]) report('  ' + a, rows.filter((r) => r.arch === a));
const worst = rows.filter((r) => r.kind === 'crag').sort((a, b) => b.base - a.base).slice(0, 6);
console.log('worst crag bases:', worst.map((r) => `${r.arch} +${r.base.toFixed(1)}m sz${r.size.toFixed(0)} @${r.x | 0},${r.z | 0}`));
