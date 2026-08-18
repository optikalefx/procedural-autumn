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

  const strands = tree.strands.filter((s) => s.level <= maxLevel);
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
