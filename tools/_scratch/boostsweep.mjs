// Offline pre-screen for `sizeBoost`: how much crown a mid prototype keeps
// against its own near prototype, flat-on.
//
// It calls the SHIPPED buildLeafGeometry, so the selection rule and the hull
// cap are the game's and not a copy, and reads the clump centres and post-cap
// sizes back off the attributes. Each clump is a view-facing card, so flat-on
// it rasterises as an axis-aligned ellipse — close enough to rank candidate
// values before spending a browser run on the real renderer.
import { SPECIES, growTree } from '../../src/vegetation/tree_species.js';
import { buildLeafGeometry } from '../../src/vegetation/tree_geometry.js';
import { SEED } from '../../src/world/WorldConfig.js';

const RES = 320;

function mask(geom, halfW, top) {
  const pos = geom.getAttribute('position').array;
  const size = geom.getAttribute('aSize').array;
  const n = pos.length / 12;                       // 4 verts per clump
  const m = new Uint8Array(RES * RES);
  const sx = RES / (2 * halfW), sy = RES / top;
  for (let i = 0; i < n; i++) {
    const o = i * 12, so = i * 8;
    const cx = (pos[o] + halfW) * sx, cy = pos[o + 1] * sy;
    const rx = size[so] * sx, ry = size[so + 1] * sy;
    const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(RES - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(RES - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const u = (x + 0.5 - cx) / (rx || 1e-6), v = (y + 0.5 - cy) / (ry || 1e-6);
        if (u * u + v * v <= 1) m[y * RES + x] = 1;
      }
    }
  }
  return m;
}
const area = (m) => m.reduce((a, x) => a + x, 0);
function iou(a, b) {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) { if (a[k] | b[k]) u++; if (a[k] & b[k]) i++; }
  return u ? i / u : 1;
}

const BOOSTS = process.argv.slice(2).map(Number);
if (!BOOSTS.length) BOOSTS.push(0.86, 0.95, 1.00, 1.06, 1.12, 1.20);

const trees = [];
for (let si = 0; si < SPECIES.length; si++) {
  for (let vi = 0; vi < 5; vi++) {
    const tree = growTree(SPECIES[si], (SEED ^ 0x51ed) + si * 7919 + vi * 104729);
    let halfW = 0.4, top = tree.height;
    for (const c of tree.clusters) {
      halfW = Math.max(halfW, Math.hypot(c.x, c.z) + c.sx);
      top = Math.max(top, c.y + c.sy);
    }
    const near = mask(buildLeafGeometry(tree, { keep: 1 }), halfW, top);
    trees.push({ si, vi, tree, halfW, top, near, nearArea: area(near) });
  }
}

console.log('boost   mean dArea   worst dArea   mean IoU(near,mid)');
for (const boost of BOOSTS) {
  const dA = [], ious = [];
  for (const t of trees) {
    const g = buildLeafGeometry(t.tree, { keep: 4, sizeBoost: boost, hull: true });
    const m = mask(g, t.halfW, t.top);
    dA.push((area(m) / t.nearArea - 1) * 100);
    ious.push(iou(t.near, m));
  }
  const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const worst = dA.reduce((a, x) => (Math.abs(x) > Math.abs(a) ? x : a), 0);
  console.log(`${boost.toFixed(2)}   ${mean(dA).toFixed(1).padStart(9)}%  ${worst.toFixed(1).padStart(10)}%   ${mean(ious).toFixed(4)}`);
}
