// ─────────────────────────────────────────────────────────────────────────────
//  Terrain — chunked, LOD'd heightfield mesh with crack-free skirts.
//  Chunks are built lazily on a budget so streaming never hitches the frame.
//
//  PERFORMANCE NOTE. viewDistance (2400 m) is larger than the world's own
//  half-diagonal, so every one of the 32×32 chunks is resident all the time.
//  Drawn one mesh per chunk that was 910 objects in the scene graph and ~360
//  draw calls a frame — over half the whole frame's calls, for about a thousand
//  triangles each. Chunks past the last shadow-casting LOD band are therefore
//  *batched*: a 4×4 block of them becomes one mesh with one draw call. The
//  vertices are bit-identical to the unbatched ones, the material and the
//  shadow flags are the same, and the only thing that changes is that frustum
//  culling now works at block granularity — which costs a handful of LOD-3/4
//  triangles at the screen edge and buys back ~200 draw calls.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { TERRAIN, WORLD } from './WorldConfig.js';
import { createTerrainMaterial } from './TerrainMaterial.js';
import { clamp } from '../core/MathUtils.js';

// Chunks at this LOD or coarser are batched into blocks. It has to stay above
// the shadow-casting band (`castShadow = lod <= 2`) so batching can never
// change what the shadow map sees.
const BATCH_LOD = 3;
// Block edge, in chunks. 4 → one draw call per 384 m of distant ground.
const BATCH = 4;
// Metres the camera may travel before the wanted-set is recomputed. The LOD
// switch radii are 180 m and up, so a few metres of hysteresis is invisible;
// rescanning every frame cost a 2601-cell sweep and ~160 KB of garbage.
const RESCAN_DIST = 6;

export class Terrain {
  constructor(world, scene, opts = {}) {
    this.world = world;
    this.scene = scene;
    this.chunkSize = TERRAIN.chunkSize;
    this.chunksPerSide = Math.round(world.worldSize / this.chunkSize);
    this.viewDistance = opts.viewDistance ?? TERRAIN.viewDistance;

    this.material = createTerrainMaterial(world);
    this.material.side = THREE.FrontSide;

    this.group = new THREE.Group();
    this.group.name = 'Terrain';
    this.scene.add(this.group);

    this.chunks = new Map();          // key -> { mesh, lod, cx, cz }   (near, per-chunk)
    this.blocks = new Map();          // bkey -> { mesh, sig, bx, bz }  (far, batched)
    this._geomCache = new Map();      // res -> reusable index attribute
    this._idxCache = new Map();       // res -> raw index template
    this._buildQueue = [];
    this._wanted = new Set();
    this._wantedBlocks = new Map();   // bkey -> { members: [], sig, d }
    this._blockPool = [];             // reusable member arrays
    this._scanAt = new THREE.Vector3(Infinity, Infinity, Infinity);
    this._n = new THREE.Vector3();
  }

  key(cx, cz) { return cx * 4096 + cz; }
  blockKey(bx, bz) { return bx * 4096 + bz; }

  lodForDistance(d) {
    const L = TERRAIN.lodDistances;
    for (let i = 0; i < L.length; i++) if (d < L[i]) return i;
    return L.length;
  }

  _resFor(lod) {
    return TERRAIN.lodResolutions[clamp(lod, 0, TERRAIN.lodResolutions.length - 1)];
  }

  /**
   * Write one chunk's vertices into the given arrays starting at `vOff`.
   *
   * The grid carries a one-vertex skirt ring all the way round: the outer ring
   * sits at the same XZ as the chunk edge but dropped below it. Two chunks at
   * different LODs sample the shared edge at different rates, so their edges do
   * not agree to the millimetre and daylight shows through the T-junction. The
   * skirt is a vertical curtain that plugs that gap. It costs ~6% more vertices
   * at LOD0 and it is the only reason there are no seams.
   *
   * @returns {number} number of vertices written
   */
  _fillChunk(cx, cz, res, positions, normals, uvs, vOff) {
    const size = this.chunkSize;
    const ox = -this.world.half + cx * size;
    const oz = -this.world.half + cz * size;
    const step = size / res;
    const skirtDepth = Math.max(2.0, step * 2.2);
    const vps = res + 3;                    // res+1 surface + 1 skirt each side
    const W = this.world;
    const n = this._n;
    const eps = Math.max(0.8, step * 0.6);

    for (let j = 0; j < vps; j++) {
      // Skirt rows reuse the clamped edge sample, so the curtain hangs from
      // exactly the surface height rather than from a second evaluation.
      const jj = j === 0 ? 0 : (j > res + 1 ? res : j - 1);
      const skirtJ = (j === 0 || j === vps - 1);
      for (let i = 0; i < vps; i++) {
        const ii = i === 0 ? 0 : (i > res + 1 ? res : i - 1);
        const skirtI = (i === 0 || i === vps - 1);
        const idx = vOff + j * vps + i;
        const x = ox + ii * step;
        const z = oz + jj * step;
        const y = W.getHeight(x, z);
        positions[idx * 3 + 0] = x;
        positions[idx * 3 + 1] = (skirtI || skirtJ) ? y - skirtDepth : y;
        positions[idx * 3 + 2] = z;
        uvs[idx * 2 + 0] = ii / res;
        uvs[idx * 2 + 1] = jj / res;

        // Normals from the analytic field (smooth across chunk seams, unlike
        // per-geometry computeVertexNormals which would produce visible edges).
        // Skirt vertices inherit the edge normal so the curtain shades exactly
        // like the ground it hangs from and stays invisible.
        W.getNormal(x, z, n, eps);
        normals[idx * 3 + 0] = n.x;
        normals[idx * 3 + 1] = n.y;
        normals[idx * 3 + 2] = n.z;
      }
    }
    return vps * vps;
  }

  /** Build (or rebuild at a new LOD) a single chunk. */
  buildChunk(cx, cz, lod) {
    const res = this._resFor(lod);
    const vps = res + 3;
    const total = vps * vps;
    const positions = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);
    const uvs = new Float32Array(total * 2);
    this._fillChunk(cx, cz, res, positions, normals, uvs, 0);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geom.setIndex(this._indicesFor(res));
    this._finishGeometry(geom);

    const mesh = new THREE.Mesh(geom, this.material);
    // Distant massifs throwing shadows across the valley floor is a signature
    // of the reference art, so terrain casts two LOD bands out, not one.
    mesh.castShadow = lod <= 2;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.userData.chunk = { cx, cz, lod };
    return mesh;
  }

  /**
   * Build one batched block: the concatenation of every member chunk's grid,
   * vertex for vertex, into a single geometry.
   */
  buildBlock(members) {
    let vTotal = 0, iTotal = 0;
    for (let m = 0; m < members.length; m += 3) {
      const res = this._resFor(members[m + 2]);
      vTotal += (res + 3) * (res + 3);
      iTotal += (res + 2) * (res + 2) * 6;
    }
    const positions = new Float32Array(vTotal * 3);
    const normals = new Float32Array(vTotal * 3);
    const uvs = new Float32Array(vTotal * 2);
    const indices = new Uint32Array(iTotal);

    let vOff = 0, iOff = 0;
    for (let m = 0; m < members.length; m += 3) {
      const cx = members[m], cz = members[m + 1], lod = members[m + 2];
      const res = this._resFor(lod);
      const written = this._fillChunk(cx, cz, res, positions, normals, uvs, vOff);
      const tpl = this._indexTemplate(res);
      for (let i = 0; i < tpl.length; i++) indices[iOff + i] = tpl[i] + vOff;
      vOff += written;
      iOff += tpl.length;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    this._finishGeometry(geom);

    const mesh = new THREE.Mesh(geom, this.material);
    // Blocks only ever hold LOD ≥ BATCH_LOD, which is past the shadow-casting
    // band, so batching cannot change the shadow map.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  _finishGeometry(geom) {
    geom.computeBoundingSphere();
    geom.computeBoundingBox();
    // Grow the bounds a touch so skirts never cause premature culling.
    geom.boundingSphere.radius *= 1.15;
  }

  /** Raw index template for one chunk grid at `res` (no vertex offset). */
  _indexTemplate(res) {
    if (this._idxCache.has(res)) return this._idxCache.get(res);
    const quads = res + 2;                  // surface quads plus the skirt ring
    const vps = res + 3;
    const idx = new Uint32Array(quads * quads * 6);
    let p = 0;
    for (let j = 0; j < quads; j++) {
      for (let i = 0; i < quads; i++) {
        const a = j * vps + i;
        const b = a + 1;
        const c = a + vps;
        const d = c + 1;
        // Alternate the diagonal to avoid directional shading artefacts.
        if (((i + j) & 1) === 0) {
          idx[p++] = a; idx[p++] = c; idx[p++] = b;
          idx[p++] = b; idx[p++] = c; idx[p++] = d;
        } else {
          idx[p++] = a; idx[p++] = c; idx[p++] = d;
          idx[p++] = a; idx[p++] = d; idx[p++] = b;
        }
      }
    }
    this._idxCache.set(res, idx);
    return idx;
  }

  _indicesFor(res) {
    if (this._geomCache.has(res)) return this._geomCache.get(res);
    const attr = new THREE.BufferAttribute(this._indexTemplate(res), 1);
    this._geomCache.set(res, attr);
    return attr;
  }

  /** Stream chunks around the viewer. Budgeted so it never stalls a frame. */
  update(camera, budgetMs = 3.0) {
    const p = camera.position;
    // Recomputing the wanted set is a sweep over every chunk in the world plus
    // a Set and a job object per cell. It only ever changes its answer when the
    // camera has moved, so gate it on that rather than paying it every frame.
    const moved = this._scanAt.distanceToSquared(p);
    if (moved > RESCAN_DIST * RESCAN_DIST) {
      this._scanAt.copy(p);
      this._scan(p);
    }
    this._drain(budgetMs);
  }

  _scan(pos) {
    const cs = this.chunkSize;
    const N = this.chunksPerSide;
    const cxCam = Math.floor((pos.x + this.world.half) / cs);
    const czCam = Math.floor((pos.z + this.world.half) / cs);
    const radius = Math.ceil(this.viewDistance / cs);

    const wanted = this._wanted;
    wanted.clear();
    const wantedBlocks = this._wantedBlocks;
    for (const [, b] of wantedBlocks) this._blockPool.push(b.members);
    wantedBlocks.clear();
    this._buildQueue.length = 0;

    const z0 = Math.max(0, czCam - radius), z1 = Math.min(N - 1, czCam + radius);
    const x0 = Math.max(0, cxCam - radius), x1 = Math.min(N - 1, cxCam + radius);

    for (let cz = z0; cz <= z1; cz++) {
      const centreZ = -this.world.half + (cz + 0.5) * cs;
      const dz = centreZ - pos.z;
      for (let cx = x0; cx <= x1; cx++) {
        const centreX = -this.world.half + (cx + 0.5) * cs;
        const dx = centreX - pos.x;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > this.viewDistance) continue;
        const lod = this.lodForDistance(d);

        if (lod >= BATCH_LOD) {
          const bx = Math.floor(cx / BATCH), bz = Math.floor(cz / BATCH);
          const bk = this.blockKey(bx, bz);
          let b = wantedBlocks.get(bk);
          if (!b) {
            b = { members: this._blockPool.pop() ?? [], sig: 0, d, bx, bz };
            b.members.length = 0;
            wantedBlocks.set(bk, b);
          }
          b.members.push(cx, cz, lod);
          // Order-independent signature over (cell, lod) — cheap and good
          // enough to notice any change in the block's contents.
          b.sig = (b.sig + Math.imul(this.key(cx, cz) + 1, 0x9e3779b1) + lod * 0x85ebca6b) | 0;
          if (d < b.d) b.d = d;
          continue;
        }

        const k = this.key(cx, cz);
        wanted.add(k);
        const existing = this.chunks.get(k);
        if (!existing) this._buildQueue.push(0, cx, cz, lod, d, k);
        else if (existing.lod !== lod) this._buildQueue.push(0, cx, cz, lod, d, k);
      }
    }

    for (const [bk, b] of wantedBlocks) {
      const existing = this.blocks.get(bk);
      if (!existing || existing.sig !== b.sig) this._buildQueue.push(1, b.bx, b.bz, 0, b.d, bk);
    }

    // Evict what fell out of range or was batched into a block.
    for (const [k, c] of this.chunks) {
      if (!wanted.has(k)) {
        this.group.remove(c.mesh);
        c.mesh.geometry.dispose();
        this.chunks.delete(k);
      }
    }
    for (const [bk, b] of this.blocks) {
      if (!wantedBlocks.has(bk)) {
        this.group.remove(b.mesh);
        b.mesh.geometry.dispose();
        this.blocks.delete(bk);
      }
    }

    // Nearest first — the player never sees a hole in front of them.
    this._sortQueue();
  }

  /** Insertion sort of the flat 6-wide job records by distance. Allocates nothing. */
  _sortQueue() {
    const q = this._buildQueue;
    const W = 6;
    for (let i = W; i < q.length; i += W) {
      const a = q[i], b = q[i + 1], c = q[i + 2], d = q[i + 3], e = q[i + 4], f = q[i + 5];
      let j = i - W;
      while (j >= 0 && q[j + 4] > e) {
        q[j + W] = q[j]; q[j + W + 1] = q[j + 1]; q[j + W + 2] = q[j + 2];
        q[j + W + 3] = q[j + 3]; q[j + W + 4] = q[j + 4]; q[j + W + 5] = q[j + 5];
        j -= W;
      }
      q[j + W] = a; q[j + W + 1] = b; q[j + W + 2] = c;
      q[j + W + 3] = d; q[j + W + 4] = e; q[j + W + 5] = f;
    }
  }

  /** Spend at most `budgetMs` building queued chunks and blocks. */
  _drain(budgetMs) {
    const q = this._buildQueue;
    if (q.length === 0) return;
    const t0 = performance.now();
    let i = 0;
    for (; i < q.length; i += 6) {
      if (i > 0 && performance.now() - t0 > budgetMs) break;
      const kind = q[i], a = q[i + 1], b = q[i + 2], lod = q[i + 3], key = q[i + 5];
      if (kind === 0) {
        // A rescan may have dropped this cell since the job was queued.
        if (!this._wanted.has(key)) continue;
        const mesh = this.buildChunk(a, b, lod);
        const prev = this.chunks.get(key);
        if (prev) { this.group.remove(prev.mesh); prev.mesh.geometry.dispose(); }
        this.group.add(mesh);
        this.chunks.set(key, { mesh, lod, cx: a, cz: b });
      } else {
        const want = this._wantedBlocks.get(key);
        if (!want) continue;
        const mesh = this.buildBlock(want.members);
        const prev = this.blocks.get(key);
        if (prev) { this.group.remove(prev.mesh); prev.mesh.geometry.dispose(); }
        this.group.add(mesh);
        this.blocks.set(key, { mesh, sig: want.sig, bx: want.bx, bz: want.bz });
      }
    }
    // Keep the tail for the next frame instead of rebuilding the whole queue.
    if (i >= q.length) q.length = 0;
    else q.copyWithin(0, i), q.length -= i;
  }

  setSunDir(v) {
    this.material.userData.uniforms.uSunDir.value.copy(v);
  }

  setTime(t) {
    this.material.userData.uniforms.uTime.value = t;
  }

  dispose() {
    for (const [, c] of this.chunks) c.mesh.geometry.dispose();
    for (const [, b] of this.blocks) b.mesh.geometry.dispose();
    this.chunks.clear();
    this.blocks.clear();
    this.material.dispose();
    this.scene.remove(this.group);
  }
}
