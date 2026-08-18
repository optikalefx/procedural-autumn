// ─────────────────────────────────────────────────────────────────────────────
//  Grass — the surface the player stares at for hours.
//
//  A camera-following field of instanced blades, built as three concentric LOD
//  rings of tiles. Each ring is a 4×4 grid snapped to its own tile size and
//  addressed toroidally, so driving one tile forward dirties one row of four
//  tiles, not the whole grid.
//
//  Ring hand-over is a *density* cross-fade done in the vertex shader: ring N
//  thins to nothing before its outermost tile can ever be recycled, and ring
//  N+1 thickens over the same band. Because a tile's content is already
//  invisible by the time it is repositioned, there is no pop while driving —
//  which is the whole reason the rings overlap instead of nesting exactly.
//
//  Rebuilds are amortised: dirty tiles queue up, nearest first, and update()
//  spends a fixed millisecond budget on them.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { VEG, SEED } from '../world/WorldConfig.js';
import { createGrassMaterial, makeGrassUniforms, makeBladeGeometry } from '../shaders/grass_material.js';
import { fillTile, RoadMask, STRIDE } from './grass_scatter.js';

// Guaranteed coverage radius of a 4×4 grid is 2 × tileSize (worst case, camera
// at the far edge of its own tile) — every fadeOut below must finish inside it.
const GRID = 4;

const RINGS = [
  {
    tileSize: 20, segments: 4, maxBlades: 21000, perClump: 26, clumpRadius: 0.52,
    width: 0.043, height: 0.78, salt: 0x1111,
    fadeIn: [-20, -10], fadeOut: [26, 38], widthGain: 0.0, aoScale: 1.0,
  },
  {
    tileSize: 44, segments: 2, maxBlades: 19000, perClump: 22, clumpRadius: 1.05,
    width: 0.115, height: 0.84, salt: 0x2222,
    fadeIn: [24, 36], fadeOut: [66, 86], widthGain: 0.40, aoScale: 0.55,
  },
  {
    tileSize: 96, segments: 1, maxBlades: 16000, perClump: 18, clumpRadius: 2.6,
    width: 0.300, height: 1.05, salt: 0x3333,
    fadeIn: [60, 82], fadeOut: [150, 180], widthGain: 1.2, aoScale: 0.22,
  },
];

const wrap = (v, m) => ((v % m) + m) % m;

export class Grass extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Grass';
    this.loadLabel = 'Sowing the meadow';

    this.group = new THREE.Group();
    this.group.name = 'Grass';
    this.group.matrixAutoUpdate = false;

    this.uniforms = makeGrassUniforms();
    this.rings = [];
    this.roads = null;

    // Scratch — update() must never allocate.
    this._queue = [];
    this._bounds = { minY: 0, maxY: 0, weights: {} };
    this._camXZ = new THREE.Vector2();
    this._size = new THREE.Vector2();
    this._first = true;
    this._budgetMs = 2.6;
  }

  async init() {
    const { ctx } = this;
    const { world, scene, preset } = ctx;

    const mul = Math.max(0.12, preset?.grassMul ?? 1);
    this.roads = new RoadMask(world, 4);

    for (const cfg of RINGS) {
      const ring = Object.assign({}, cfg);
      ring.maxBlades = Math.max(400, Math.round(cfg.maxBlades * mul * (VEG.grassBladesPerChunk / 26000)));
      ring.clumpAttempts = Math.ceil((ring.maxBlades / ring.perClump) * 1.35);

      const blade = makeBladeGeometry(cfg.segments);
      const mat = createGrassMaterial(this.uniforms, cfg);
      ring.blade = blade;
      ring.material = mat;
      ring.tiles = [];

      for (let s = 0; s < GRID * GRID; s++) {
        const data = new Float32Array(ring.maxBlades * STRIDE);
        const ib = new THREE.InstancedInterleavedBuffer(data, STRIDE);
        ib.setUsage(THREE.DynamicDrawUsage);

        const geo = new THREE.InstancedBufferGeometry();
        geo.setIndex(blade.index);                                    // shared GPU buffers
        geo.setAttribute('position', blade.attributes.position);
        geo.setAttribute('aPos',   new THREE.InterleavedBufferAttribute(ib, 3, 0));
        geo.setAttribute('aShape', new THREE.InterleavedBufferAttribute(ib, 4, 3));
        geo.setAttribute('aTint',  new THREE.InterleavedBufferAttribute(ib, 4, 7));
        geo.setAttribute('aMisc',  new THREE.InterleavedBufferAttribute(ib, 3, 11));
        geo.instanceCount = 0;
        geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);

        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = true;
        mesh.castShadow = false;       // 500 k blades in the shadow pass is not
        mesh.receiveShadow = true;     // affordable; base AO stands in for it.
        mesh.matrixAutoUpdate = false;
        mesh.visible = false;
        mesh.renderOrder = 1;
        this.group.add(mesh);

        ring.tiles.push({ ix: 1e9, iz: 1e9, mesh, geo, ib, data,
                          dirty: false, dist: 0, count: 0, minY: 0, maxY: 0 });
      }
      this.rings.push(ring);
    }

    scene.add(this.group);
  }

  /** Re-point every tile at the cell it should own for this camera position. */
  _reassign(camX, camY, camZ) {
    for (const ring of this.rings) {
      const S = ring.tileSize;
      const bx = Math.floor(camX / S), bz = Math.floor(camZ / S);
      for (let sz = 0; sz < GRID; sz++) {
        for (let sx = 0; sx < GRID; sx++) {
          // The window is [b-2, b+1]; find the member of it that lands in this
          // toroidal slot, so only the row that left the window goes dirty.
          const ix = bx - 2 + wrap(sx - wrap(bx - 2, GRID), GRID);
          const iz = bz - 2 + wrap(sz - wrap(bz - 2, GRID), GRID);
          const tile = ring.tiles[sz * GRID + sx];
          if (tile.ix !== ix || tile.iz !== iz) {
            tile.ix = ix; tile.iz = iz; tile.dirty = true; tile.count = 0;
            tile.mesh.visible = false;
          }

          // Distance band cull. Frustum culling alone still draws whole tiles
          // whose every blade is faded to zero area — 100 k wasted triangles a
          // tile. Comparing the tile's own distance band against the ring's
          // fade window throws those away on the CPU for a few flops.
          const x0 = ix * S, x1 = x0 + S, z0 = iz * S, z1 = z0 + S;
          const ddx = Math.max(x0 - camX, 0, camX - x1);
          const ddz = Math.max(z0 - camZ, 0, camZ - z1);
          const ddy = Math.max(tile.minY - camY, 0, camY - tile.maxY);
          const near = Math.sqrt(ddx * ddx + ddz * ddz + ddy * ddy);
          const fx = Math.max(Math.abs(camX - x0), Math.abs(camX - x1));
          const fz = Math.max(Math.abs(camZ - z0), Math.abs(camZ - z1));
          const fy = Math.max(Math.abs(camY - tile.minY), Math.abs(camY - tile.maxY));
          const far = Math.sqrt(fx * fx + fz * fz + fy * fy);

          tile.dist = near;
          tile.mesh.visible = tile.count > 0 &&
            near <= ring.fadeOut[1] && far >= ring.fadeIn[0];
        }
      }
    }
  }

  _build(ring, tile) {
    const S = ring.tileSize;
    const ox = (tile.ix + 0.5) * S, oz = (tile.iz + 0.5) * S;
    const n = fillTile(this.ctx.world, this.roads, ring, ox, oz,
                       SEED, tile.data, this._bounds);

    tile.geo.instanceCount = n;
    tile.count = n;
    tile.minY = this._bounds.minY;
    tile.maxY = this._bounds.maxY;
    tile.mesh.visible = n > 0;
    tile.mesh.position.set(ox, 0, oz);
    tile.mesh.updateMatrix();
    tile.mesh.updateMatrixWorld(true);

    if (n > 0) {
      const b = this._bounds;
      const midY = (b.minY + b.maxY) * 0.5;
      const s = tile.geo.boundingSphere;
      s.center.set(0, midY, 0);
      // Half-diagonal of the tile, plus the vertical spread, plus headroom for
      // the wind swing so a gusting tile never gets culled at the screen edge.
      s.radius = Math.hypot(S * 0.5, S * 0.5) + (b.maxY - b.minY) * 0.5 + ring.height * 2.0;
      tile.ib.needsUpdate = true;
    }
    tile.dirty = false;
  }

  update(dt, elapsed) {
    const { camera, renderer, lighting } = this.ctx;
    const u = this.uniforms;

    u.uTime.value = elapsed;
    if (lighting?.sunDir) u.uSunDir.value.copy(lighting.sunDir);
    if (lighting?.sun) u.uSunColor.value.copy(lighting.sun.color);

    // World units per pixel, per metre of distance — the minimum blade width
    // that keeps a distant meadow from crawling.
    renderer.getDrawingBufferSize(this._size);
    const fovRad = (camera.fov * Math.PI) / 180;
    u.uPxWorld.value = (2 * Math.tan(fovRad * 0.5)) / Math.max(1, this._size.y);

    this._reassign(camera.position.x, camera.position.y, camera.position.z);

    // ── amortised rebuild, nearest tile first ────────────────────────────────
    const q = this._queue;
    q.length = 0;
    for (const ring of this.rings) {
      for (const tile of ring.tiles) if (tile.dirty) q.push(ring, tile);
    }
    if (q.length === 0) return;

    // Insertion sort on (ring, tile) pairs — the list is never more than a few
    // entries once the field is warm, and this allocates nothing.
    for (let i = 2; i < q.length; i += 2) {
      const r = q[i], t = q[i + 1];
      let j = i - 2;
      while (j >= 0 && q[j + 1].dist > t.dist) { q[j + 2] = q[j]; q[j + 3] = q[j + 1]; j -= 2; }
      q[j + 2] = r; q[j + 3] = t;
    }

    const budget = this._first ? 400 : this._budgetMs;
    const t0 = performance.now();
    for (let i = 0; i < q.length; i += 2) {
      this._build(q[i], q[i + 1]);
      if (performance.now() - t0 > budget) break;
    }
    this._first = false;
    void dt;
  }

  dispose() {
    for (const ring of this.rings) {
      for (const tile of ring.tiles) tile.geo.dispose();
      ring.blade.dispose();
      ring.material.dispose();
    }
    this.ctx.scene.remove(this.group);
    this.rings.length = 0;
  }
}
