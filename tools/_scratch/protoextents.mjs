// Offline probe: per-species, per-variant prototype extents, and what the
// mid LOD actually substitutes for each near variant. No browser needed —
// growTree and buildLeafGeometry's decimation rule are both pure JS.
import { SPECIES, growTree } from '../../src/vegetation/tree_species.js';
import { SEED } from '../../src/world/WorldConfig.js';

const VARIANTS = 5, MIDV = 2, KEEP = 4, BOOST = 0.86;
const grow = Math.sqrt(KEEP) * BOOST;

for (let si = 0; si < SPECIES.length; si++) {
  const sp = SPECIES[si];
  const vs = [];
  for (let vi = 0; vi < VARIANTS; vi++) {
    const tree = growTree(sp, (SEED ^ 0x51ed) + si * 7919 + vi * 104729);
    let halfW = 0.4, top = tree.height, mHalf = 0.4, mTop = tree.height;
    for (let i = 0; i < tree.clusters.length; i++) {
      const c = tree.clusters[i];
      halfW = Math.max(halfW, Math.hypot(c.x, c.z) + c.sx);
      top = Math.max(top, c.y + c.sy);
      if (i % KEEP === 0) {
        mHalf = Math.max(mHalf, Math.hypot(c.x, c.z) + c.sx * grow);
        mTop = Math.max(mTop, c.y + c.sy * grow);
      }
    }
    vs.push({ h: top, w: halfW, mh: mTop, mw: mHalf, n: tree.clusters.length });
  }
  console.log('---', sp.name ?? si);
  for (let vi = 0; vi < VARIANTS; vi++) {
    const b = vs[vi], u = vs[vi % MIDV];
    console.log(
      `  v${vi} near h=${b.h.toFixed(2)} w=${b.w.toFixed(2)} clumps=${b.n}` +
      ` -> mid proto v${vi % MIDV} h=${u.mh.toFixed(2)} w=${u.mw.toFixed(2)}` +
      `  dH=${((u.mh / b.h - 1) * 100).toFixed(1)}% dW=${((u.mw / b.w - 1) * 100).toFixed(1)}%`);
  }
}
