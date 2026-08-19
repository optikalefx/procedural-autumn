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
  let vCount = 0, iCount = 0;
  for (const s of strands) {
    vCount += s.pts.length * (radialSegs + 1);
    iCount += (s.pts.length - 1) * radialSegs * 6;
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

      for (let k = 0; k <= radialSegs; k++) {
        const ang = (k / radialSegs) * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        tmp.copy(normal).multiplyScalar(ca).addScaledVector(binormal, sa);
        const o = (vo + i * (radialSegs + 1) + k);
        pos[o * 3 + 0] = p.x + tmp.x * r;
        pos[o * 3 + 1] = p.y + tmp.y * r;
        pos[o * 3 + 2] = p.z + tmp.z * r;
        nrm[o * 3 + 0] = tmp.x; nrm[o * 3 + 1] = tmp.y; nrm[o * 3 + 2] = tmp.z;
        uv[o * 2 + 0] = k / radialSegs;
        uv[o * 2 + 1] = run;
        bark[o * 2 + 0] = species.bark;
        bark[o * 2 + 1] = w * (s.level > 0 ? 1.35 : 1.0);
      }
    }
    const ring = radialSegs + 1;
    for (let i = 0; i < pts.length - 1; i++) {
      for (let k = 0; k < radialSegs; k++) {
        const a = vo + i * ring + k;
        const b = a + 1;
        const c = a + ring;
        const d = c + 1;
        idx[io++] = a; idx[io++] = c; idx[io++] = b;
        idx[io++] = b; idx[io++] = c; idx[io++] = d;
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
 */
export function buildLeafGeometry(tree, opts = {}) {
  const keep = opts.keep ?? 1;
  const src = tree.clusters;
  const list = [];
  for (let i = 0; i < src.length; i++) if (i % keep === 0) list.push(src[i]);
  const grow = Math.sqrt(keep) * (opts.sizeBoost ?? 1);

  const n = list.length;
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
      size[o * 2 + 0] = c.sx * grow; size[o * 2 + 1] = c.sy * grow;
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
  for (const c of list) maxS = Math.max(maxS, c.sx * grow, c.sy * grow);
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
