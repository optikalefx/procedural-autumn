// ─────────────────────────────────────────────────────────────────────────────
//  Terrain — chunked, LOD'd heightfield mesh with crack-free skirts.
//  Chunks are built lazily on a budget so streaming never hitches the frame.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { TERRAIN, WORLD } from './WorldConfig.js';
import { createTerrainMaterial } from './TerrainMaterial.js';
import { clamp } from '../core/MathUtils.js';

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

    this.chunks = new Map();          // key -> { mesh, lod, cx, cz }
    this._geomCache = new Map();      // lod -> reusable index buffer
    this._buildQueue = [];
    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._tmpBox = new THREE.Box3();
  }

  key(cx, cz) { return cx * 4096 + cz; }

  lodForDistance(d) {
    const L = TERRAIN.lodDistances;
    for (let i = 0; i < L.length; i++) if (d < L[i]) return i;
    return L.length;
  }

  /** Build (or rebuild at a new LOD) a single chunk. */
  buildChunk(cx, cz, lod) {
    const size = this.chunkSize;
    const res = TERRAIN.lodResolutions[clamp(lod, 0, TERRAIN.lodResolutions.length - 1)];
    const ox = -this.world.half + cx * size;
    const oz = -this.world.half + cz * size;

    // The grid carries a one-vertex skirt ring all the way round: the outer
    // ring sits at the same XZ as the chunk edge but dropped below it. Two
    // chunks at different LODs sample the shared edge at different rates, so
    // their edges do not agree to the millimetre and daylight shows through the
    // T-junction. The skirt is a vertical curtain that plugs that gap. It costs
    // ~6% more vertices at LOD0 and it is the only reason there are no seams.
    const step = size / res;
    const skirtDepth = Math.max(2.0, step * 2.2);
    const vps = res + 3;                    // res+1 surface + 1 skirt each side
    const total = vps * vps;
    const positions = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);
    const uvs = new Float32Array(total * 2);
    const W = this.world;
    const n = new THREE.Vector3();
    const eps = Math.max(0.8, step * 0.6);

    for (let j = 0; j < vps; j++) {
      // Skirt rows reuse the clamped edge sample, so the curtain hangs from
      // exactly the surface height rather than from a second evaluation.
      const jj = j === 0 ? 0 : (j > res + 1 ? res : j - 1);
      const skirtJ = (j === 0 || j === vps - 1);
      for (let i = 0; i < vps; i++) {
        const ii = i === 0 ? 0 : (i > res + 1 ? res : i - 1);
        const skirtI = (i === 0 || i === vps - 1);
        const idx = j * vps + i;
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

    const indices = this._indicesFor(res);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeBoundingSphere();
    geom.computeBoundingBox();
    // Grow the bounds a touch so skirts never cause premature culling.
    geom.boundingSphere.radius *= 1.15;

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

  _indicesFor(res) {
    if (this._geomCache.has(res)) return this._geomCache.get(res);
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
    const attr = new THREE.BufferAttribute(idx, 1);
    this._geomCache.set(res, attr);
    return attr;
  }

  /** Stream chunks around the viewer. Budgeted so it never stalls a frame. */
  update(camera, budgetMs = 3.0) {
    const cs = this.chunkSize;
    const cxCam = Math.floor((camera.position.x + this.world.half) / cs);
    const czCam = Math.floor((camera.position.z + this.world.half) / cs);
    const radius = Math.ceil(this.viewDistance / cs);

    const wanted = new Set();
    this._buildQueue.length = 0;

    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = cxCam + dx, cz = czCam + dz;
        if (cx < 0 || cz < 0 || cx >= this.chunksPerSide || cz >= this.chunksPerSide) continue;
        const centreX = -this.world.half + (cx + 0.5) * cs;
        const centreZ = -this.world.half + (cz + 0.5) * cs;
        const d = Math.hypot(centreX - camera.position.x, centreZ - camera.position.z);
        if (d > this.viewDistance) continue;
        const lod = this.lodForDistance(d);
        const k = this.key(cx, cz);
        wanted.add(k);
        const existing = this.chunks.get(k);
        if (!existing) this._buildQueue.push({ cx, cz, lod, d, k });
        else if (existing.lod !== lod) this._buildQueue.push({ cx, cz, lod, d, k, replace: true });
      }
    }

    // Nearest first — the player never sees a hole in front of them.
    this._buildQueue.sort((a, b) => a.d - b.d);

    const t0 = performance.now();
    for (const job of this._buildQueue) {
      if (performance.now() - t0 > budgetMs) break;
      const mesh = this.buildChunk(job.cx, job.cz, job.lod);
      const prev = this.chunks.get(job.k);
      if (prev) { this.group.remove(prev.mesh); prev.mesh.geometry.dispose(); }
      this.group.add(mesh);
      this.chunks.set(job.k, { mesh, lod: job.lod, cx: job.cx, cz: job.cz });
    }

    // Evict what fell out of range.
    for (const [k, c] of this.chunks) {
      if (!wanted.has(k)) {
        this.group.remove(c.mesh);
        c.mesh.geometry.dispose();
        this.chunks.delete(k);
      }
    }
  }

  setSunDir(v) {
    this.material.userData.uniforms.uSunDir.value.copy(v);
  }

  setTime(t) {
    this.material.userData.uniforms.uTime.value = t;
  }

  dispose() {
    for (const [, c] of this.chunks) c.mesh.geometry.dispose();
    this.chunks.clear();
    this.material.dispose();
    this.scene.remove(this.group);
  }
}
