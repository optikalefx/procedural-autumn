// ─────────────────────────────────────────────────────────────────────────────
//  Grown tree -> BufferGeometry.
//
//  Two geometries per prototype per LOD: bark (extruded tubes) and leaves
//  (one quad per clump, billboarded in the vertex shader). They are kept apart
//  because they need different materials, and merging them would cost more in
//  overdraw than it saves in draw calls.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { tileUV } from './tree_textures.js';
import { clamp01 } from '../core/MathUtils.js';

/**
 * Index of the last point of a limb that lies within `k` clump radii of some
 * leaf clump, or -1. Two different radii are needed and conflating them was a
 * real bug: a generous one to decide whether a limb *has* foliage at all (its
 * lobe sits on its tip, and the dabs of that lobe are distributed on a shell
 * *around* the tip, so the tip itself is often in the hole in the middle), and
 * a tight one to decide where to cut, because the retained tip has to end up
 * buried in the mass rather than merely touching its rim. Using the tight
 * radius for both dropped whole limbs whose lobes were right there, and left
 * crowns hanging in the sky with no tree under them.
 */
function lastPointNear(pts, clusters, k) {
  for (let last = pts.length - 1; last >= 0; last--) {
    const p = pts[last].p;
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      const r = Math.max(c.sx, c.sy) * k;
      const dx = c.x - p.x, dy = c.y - p.y, dz = c.z - p.z;
      if (dx * dx + dy * dy + dz * dz < r * r) return last;
    }
  }
  return -1;
}

/**
 * Extrude the strand poly-lines into tapered tubes.
 *
 * `maxLevel` drops twig-level geometry for the mid LOD; `radialSegs` is 5 near
 * (round enough to catch a rim light) and 3 at distance (still reads as a
 * cylinder once it is four pixels wide).
 */
export function buildBarkGeometry(tree, species, opts = {}) {
  const radialSegs = opts.radialSegs ?? 5;
  const maxLevel = opts.maxLevel ?? 9;
  const H = tree.height;

  // Pruning the skeleton to what the foliage actually covers.
  //
  // A crown is a handful of lobes, so most branch tips deliberately carry no
  // leaves — and every limb that ran past the last lobe left a bare dark wire
  // sticking out through the silhouette, or worse, a whole limb hanging in mid
  // air with nothing on the end of it. Three rules together fix that:
  //   · a limb survives only if it, or something growing out of it, has
  //     foliage on it (bottom-up over the parent links);
  //   · a limb with no leafy children is cut back to its last point *buried*
  //     inside a clump, not merely touching one;
  //   · a limb that only exists to reach a leafy sub-limb is cut at that
  //     sub-limb's attachment point.
  // What survives is the branch structure you see *through* a canopy, which is
  // a feature of the reference plates, and nothing that pokes out of one.
  const src = tree.strands.filter((s) => s.level <= maxLevel);
  const index = new Map(tree.strands.map((s, i) => [s, i]));
  const slot = new Map(src.map((s, i) => [index.get(s), i]));
  const reach = src.map((s) => lastPointNear(s.pts, tree.clusters, 1.30));
  const snug = src.map((s) => lastPointNear(s.pts, tree.clusters, 0.60));
  const keep = reach.map((b) => b >= 0);
  // Last point index a *kept* child hangs off, so a limb that only exists to
  // feed a leafy sub-limb is drawn exactly as far as it has to reach and no
  // further. Children are always pushed after their parent, so one backward
  // sweep resolves the whole tree.
  const childAt = src.map(() => -1);
  for (let i = src.length - 1; i >= 0; i--) {
    const pi = slot.get(src[i].parent);
    if (pi === undefined || !keep[i]) continue;
    keep[pi] = true;
    childAt[pi] = Math.max(childAt[pi], src[i].attach ?? 0);
  }
  const strands = [];
  for (let i = 0; i < src.length; i++) {
    const s = src[i];
    if (s.level > 0 && !keep[i]) continue;        // no foliage on it or below it
    // The leader gets the same treatment, with a floor so the tree keeps its
    // bole. A birch's trunkFrac is 0.96, so its leader ran a metre or two past
    // the top of its own crown and left a clean grey needle standing above
    // every birch on a hillside — the single most CG-looking thing left in the
    // silhouette once the limbs were fixed.
    const floor = s.level === 0 ? Math.ceil(s.pts.length * 0.45) : 1;
    const trim = snug[i] >= 0 ? snug[i] : Math.max(reach[i] - 1, 0);
    const last = Math.max(trim, childAt[i] + 1, floor);
    const pts = s.pts.slice(0, Math.min(s.pts.length, last + 1));
    if (pts.length > 1) strands.push({ ...s, pts });
  }
  // Segment count per strand, not one for the whole tree. The bole is the only
  // part of the skeleton a 3 m camera reads as a solid — at four segments it is
  // a square in cross-section, so its silhouette has visible flats and the rim
  // light breaks at the corners — while the twigs are three pixels wide and
  // hidden inside the crown. On a spruce the boughs are 119 three-point
  // poly-lines and cost 80% of the bark budget, so spending the extra rings
  // uniformly would be paying almost all of it where nothing can see it.
  // Near LOD only: at the mid LOD the bole is a few pixels wide and there are
  // four times as many instances, so the extra rings there cost more than the
  // whole near-field saving.
  const leaderBonus = opts.leaderBonus ?? 2;
  const segsOf = (s) => (s.level === 0 ? radialSegs + leaderBonus : radialSegs);
  let vCount = 0, iCount = 0;
  for (const s of strands) {
    const rs = segsOf(s);
    vCount += s.pts.length * (rs + 1);
    iCount += (s.pts.length - 1) * rs * 6;
  }

  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  // x: bark style, y: wind weight (how much this vertex bends)
  const bark = new Float32Array(vCount * 2);
  const idx = new (vCount > 65535 ? Uint32Array : Uint16Array)(iCount);

  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const prevNormal = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  let vo = 0, io = 0;
  for (const s of strands) {
    const pts = s.pts;
    const rs = segsOf(s);
    let run = 0;
    prevNormal.set(1, 0, 0);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i].p;
      const a = pts[Math.max(0, i - 1)].p;
      const b = pts[Math.min(pts.length - 1, i + 1)].p;
      tangent.subVectors(b, a);
      if (tangent.lengthSq() < 1e-10) tangent.set(0, 1, 0);
      tangent.normalize();
      if (i > 0) run += p.distanceTo(pts[i - 1].p);

      // Parallel transport: project the previous normal onto the new ring's
      // plane. Rebuilding the frame from world-up instead makes the bark twist
      // wildly wherever a limb passes through horizontal.
      normal.copy(prevNormal).addScaledVector(tangent, -prevNormal.dot(tangent));
      if (normal.lengthSq() < 1e-8) {
        normal.set(Math.abs(tangent.y) > 0.9 ? 1 : 0, Math.abs(tangent.y) > 0.9 ? 0 : 1, 0)
          .addScaledVector(tangent, -tangent.y);
      }
      normal.normalize();
      prevNormal.copy(normal);
      binormal.crossVectors(tangent, normal).normalize();

      const r = pts[i].r;
      // Wind weight: quadratic in height so the base is pinned and the tips fly.
      const w = Math.pow(clamp01(p.y / (H * 0.95)), 1.8);

      for (let k = 0; k <= rs; k++) {
        const ang = (k / rs) * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        tmp.copy(normal).multiplyScalar(ca).addScaledVector(binormal, sa);
        const o = (vo + i * (rs + 1) + k);
        pos[o * 3 + 0] = p.x + tmp.x * r;
        pos[o * 3 + 1] = p.y + tmp.y * r;
        pos[o * 3 + 2] = p.z + tmp.z * r;
        nrm[o * 3 + 0] = tmp.x; nrm[o * 3 + 1] = tmp.y; nrm[o * 3 + 2] = tmp.z;
        uv[o * 2 + 0] = k / rs;
        uv[o * 2 + 1] = run;
        bark[o * 2 + 0] = species.bark;
        bark[o * 2 + 1] = w * (s.level > 0 ? 1.35 : 1.0);
      }
    }
    const ring = rs + 1;
    for (let i = 0; i < pts.length - 1; i++) {
      for (let k = 0; k < rs; k++) {
        const a = vo + i * ring + k;
        const b = a + 1;
        const c = a + ring;
        const d = c + 1;
        // Winding must agree with the outward normal written above, and it did
        // not. With tangent +Y and ring offset normal*cos + binormal*sin (where
        // binormal = tangent x normal), the ring advances *clockwise* seen from
        // outside, so (a, c, b) put the front face on the *inside* of the tube.
        // Under `side: FrontSide` that culls the near wall and draws the far
        // one, whose stored normal points away from the camera — a trunk lit
        // from the front therefore rendered shaded and one lit from behind
        // rendered lit, which is why every trunk in the game read as a flat
        // dark stick from every angle and why the birch bark had accumulated a
        // 1.30x key and a 1.95x ambient lift trying to compensate.
        idx[io++] = a; idx[io++] = b; idx[io++] = c;
        idx[io++] = b; idx[io++] = d; idx[io++] = c;
      }
    }
    vo += pts.length * ring;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aBark', new THREE.BufferAttribute(bark, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * One quad per leaf clump. Everything the shader needs to place, orient,
 * colour, occlude and flutter the clump travels as vertex attributes; the quad
 * itself is degenerate in object space (all four corners at the clump centre)
 * and gets its extent in view space, so it always faces the camera — or the
 * light, in the shadow pass, which is exactly what you want for foliage.
 *
 * `keep` decimates for the mid LOD; surviving clumps grow to hold the crown's
 * silhouette area roughly constant.
 *
 * `hull` caps that growth so the decimated crown cannot be WIDER or TALLER
 * than the undecimated one. Holding area and holding outline are two different
 * things, and the difference is exactly what pops at a LOD boundary: with
 * `keep: 4` every survivor grows by 1.72, and a survivor that happened to sit
 * on the rim then pushes the silhouette 72% of its own radius further out than
 * the near LOD ever drew it. The cap is a support-function test — for each
 * survivor, how far the FULL crown reaches along that survivor's own outward
 * direction — so a clump buried in the middle still takes the whole 1.72 and
 * fills the hole its four neighbours left, while a clump on the edge grows
 * only into the room the full crown actually occupied. Never below 1.0: a
 * survivor may not shrink, or the crown goes see-through instead.
 *
 * `hull` also decides WHICH clump of each group of `keep` survives. Taking
 * every keep-th clump takes an arbitrary one, so the clump that actually
 * defined the crown's widest point survived only a quarter of the time and the
 * decimated crown came out up to 22% NARROWER than the full one — the same pop
 * as the inflation, in the other direction. Taking the most outward of each
 * group instead fixes the width (to 3.5%) and empties the crown: a crown here
 * is dabs on a shell, so "most outward of every group" is a shell of a shell,
 * and the silhouette lost 18% of its filled area.
 *
 * So: one representative per group, the arbitrary one by default, EXCEPT that
 * the clumps which define the crown's support in 26 sample directions take
 * their own group's slot. That pins the envelope with about a third of the
 * survivors and leaves the rest sampling the crown evenly, which is what fills
 * it. Envelope and fill are two different jobs and this is the split.
 */
const HULL_DIRS = (() => {
  const d = [];
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue;
        const l = Math.hypot(x, y, z);
        d.push([x / l, y / l, z / l]);
      }
    }
  }
  return d;
})();

export function buildLeafGeometry(tree, opts = {}) {
  const keep = opts.keep ?? 1;
  const src = tree.clusters;
  const list = [];
  if (opts.hull && keep > 1) {
    // One representative index per group of `keep`.
    const rep = [];
    for (let i = 0; i < src.length; i += keep) rep.push(i);
    for (const [dx, dy, dz] of HULL_DIRS) {
      let best = -1, bd = -1e9;
      for (let k = 0; k < src.length; k++) {
        const c = src[k];
        const d = c.x * dx + c.y * dy + c.z * dz + Math.max(c.sx, c.sy);
        if (d > bd) { bd = d; best = k; }
      }
      if (best >= 0) rep[(best / keep) | 0] = best;
    }
    for (const i of rep) list.push(src[i]);
  } else {
    for (let i = 0; i < src.length; i++) if (i % keep === 0) list.push(src[i]);
  }
  const grow = Math.sqrt(keep) * (opts.sizeBoost ?? 1);

  const n = list.length;
  // Per-clump growth. Uniform unless `hull` is on.
  const gs = new Float32Array(n).fill(grow);
  if (opts.hull && keep > 1 && grow > 1) {
    let mx = 0, my = 0, mz = 0;
    for (const c of src) { mx += c.x; my += c.y; mz += c.z; }
    mx /= src.length; my /= src.length; mz /= src.length;
    for (let i = 0; i < n; i++) {
      const c = list[i];
      let dx = c.x - mx, dy = c.y - my, dz = c.z - mz;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-4) continue;                    // dead centre: nothing to clip
      dx /= len; dy /= len; dz /= len;
      const r = Math.max(c.sx, c.sy);
      if (r < 1e-5) continue;                      // a zero-radius clump: 0/0
      // How far the full crown reaches in this direction.
      let support = -1e9;
      for (const o of src) {
        const d = (o.x - mx) * dx + (o.y - my) * dy + (o.z - mz) * dz + Math.max(o.sx, o.sy);
        if (d > support) support = d;
      }
      const allowed = (support - len) / r;
      gs[i] = Math.max(1, Math.min(grow, allowed));
    }
  }

  const pos = new Float32Array(n * 4 * 3);
  const uv = new Float32Array(n * 4 * 2);
  const corner = new Float32Array(n * 4 * 2);
  const size = new Float32Array(n * 4 * 2);
  const cn = new Float32Array(n * 4 * 3);
  const data = new Float32Array(n * 4 * 3);   // ao, tone, flex
  const idx = new (n * 4 > 65535 ? Uint32Array : Uint16Array)(n * 6);

  const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

  for (let i = 0; i < n; i++) {
    const c = list[i];
    const t = tileUV(c.tile);
    // 90° steps + a mirror gives 8 looks per tile with zero atlas bleed.
    const uvq = [[t.u0, t.v0], [t.u1, t.v0], [t.u1, t.v1], [t.u0, t.v1]];
    for (let k = 0; k < 4; k++) {
      const o = i * 4 + k;
      pos[o * 3 + 0] = c.x; pos[o * 3 + 1] = c.y; pos[o * 3 + 2] = c.z;
      let cx = CORNERS[k][0], cy = CORNERS[k][1];
      if (c.flip) cx = -cx;
      corner[o * 2 + 0] = cx; corner[o * 2 + 1] = cy;
      const uq = uvq[(k + c.rot) & 3];
      uv[o * 2 + 0] = uq[0]; uv[o * 2 + 1] = uq[1];
      size[o * 2 + 0] = c.sx * gs[i]; size[o * 2 + 1] = c.sy * gs[i];
      cn[o * 3 + 0] = c.nx; cn[o * 3 + 1] = c.ny; cn[o * 3 + 2] = c.nz;
      data[o * 3 + 0] = c.ao;
      data[o * 3 + 1] = c.tone;
      data[o * 3 + 2] = c.flex;
      // The flutter phase is derived in the shader from `position`, so it costs
      // no attribute and is automatically coherent per clump.
    }
    const b = i * 4;
    idx[i * 6 + 0] = b; idx[i * 6 + 1] = b + 1; idx[i * 6 + 2] = b + 2;
    idx[i * 6 + 3] = b; idx[i * 6 + 4] = b + 2; idx[i * 6 + 5] = b + 3;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 2));
  g.setAttribute('aCrownN', new THREE.BufferAttribute(cn, 3));
  g.setAttribute('aData', new THREE.BufferAttribute(data, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  // The quads expand in view space, so the object-space bounds must be padded
  // by the largest clump or three will cull trees that are still on screen.
  g.computeBoundingSphere();
  let maxS = 0;
  for (let i = 0; i < n; i++) maxS = Math.max(maxS, list[i].sx * gs[i], list[i].sy * gs[i]);
  if (g.boundingSphere) g.boundingSphere.radius += maxS * 1.5;
  return g;
}

/** A single upright quad, for the distant impostor. Unit-sized; scaled per instance. */
export function buildImpostorGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array([-1, 0, 1, 0, 1, 1, -1, 1]), 2));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 1.5);
  return g;
}
