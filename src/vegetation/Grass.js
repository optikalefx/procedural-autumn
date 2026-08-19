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
  // The near ring is the 2 m band — the surface the player looks at for the
  // whole game — so it is the one ring whose *individual blades* can be
  // resolved, and it is budgeted the other way round from the far two.
  //
  // "3 segments still reads as a curve at 2 m" was wrong, and it was the fourth
  // blocker of critic pass 4. Three uniformly-spaced rows put the entire top
  // third of the blade in one straight-sided quad, so the taper and the arc
  // both flattened into a line and what rasterised was an isoceles triangle.
  // Five rows packed toward the tip (see `tipBias`) resolve the curl.
  //
  // The triangles that buys are paid for out of *width*: the perf author's
  // measurement (INTEGRATION_REQUESTS, "Grass is the single largest p95
  // contributor") is that grass costs overdraw, not geometry — hiding it is
  // p95 -7.6 ms for only 0.37 M triangles — and names near-ring blade width as
  // the cheapest lever. So the near blade goes from a 0.055 m wedge to a
  // 0.044 m hair, and the ground coverage that loses is bought back with bend
  // and tuft splay in grass_scatter.js, which cost no instances at all.
  {
    tileSize: 16, segments: 5, tipBias: 0.72, maxBlades: 19000, perClump: 26, clumpRadius: 0.48,
    // Height is the other half of the coverage trade, and the cheap half. An
    // arched blade's horizontal reach scales with its length, so 0.38 -> 0.44
    // buys back most of the ground the narrower blade stopped hiding, for no
    // extra instances and no extra triangles — only the overdraw of the blade
    // itself, which the width cut has already more than paid for. Still well
    // inside the "ground cover, not a wheat crop" bound in grass_scatter.js:
    // typical stand goes ~0.34 m to ~0.39 m against a 2 m vehicle.
    width: 0.052, height: 0.44, salt: 0x1111, floor: 0.46,
    fadeIn: [-20, -10], fadeOut: [20, 30], widthGain: 0.0, aoScale: 1.0,
  },
  // Mid ring: two rows still cannot carry a curl, but at 20–70 m the blade is a
  // few pixels wide and only its *lean* survives, so it gets the extra row that
  // buys the bent tip and nothing more.
  {
    tileSize: 40, segments: 3, tipBias: 0.78, maxBlades: 18500, perClump: 30, clumpRadius: 1.20,
    width: 0.115, height: 0.40, salt: 0x2222, floor: 0.40,
    fadeIn: [18, 28], fadeOut: [58, 76], widthGain: 0.40, aoScale: 0.70,
  },
  {
    tileSize: 96, segments: 1, maxBlades: 16000, perClump: 34, clumpRadius: 3.2,
    width: 0.320, height: 0.48, salt: 0x3333, floor: 0.34,
    fadeIn: [54, 72], fadeOut: [150, 182], widthGain: 1.2, aoScale: 0.30,
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
    // Resume state for the tile currently under construction. Reused, never
    // reallocated — update() must not allocate.
    this._st = { a: 0, n: 0, minY: 0, maxY: 0, weights: {}, deadline: 0 };
    this._size = new THREE.Vector2();
    this._first = true;
    // A tile is built atomically, so the true worst-case frame cost is this
    // budget plus one tile. Measured at 5.7 ms with the old far-ring clump
    // granularity; the far rings now emit larger tufts, which is the same
    // silhouette at 60–180 m for roughly half the world sampling.
    this._budgetMs = 2.0;
  }

  async init() {
    const { ctx } = this;
    const { world, scene, preset } = ctx;

    const mul = Math.max(0.12, preset?.grassMul ?? 1);
    this.roads = new RoadMask(world, 4);

    for (const cfg of RINGS) {
      const ring = Object.assign({}, cfg);
      ring.maxBlades = Math.max(400, Math.round(cfg.maxBlades * mul * (VEG.grassBladesPerChunk / 26000)));

      // ── how the field degrades ──────────────────────────────────────────
      // Spending grassMul purely on blade count is the obvious thing and it
      // looks broken: at `low` the tuft count falls with it and the meadow
      // becomes islands of grass marooned on bare ground. A thinner, shorter-
      // ranged field reads as a deliberate art choice; islands read as a bug.
      //
      // So the budget is spent two other ways first. Blades per tuft fall
      // sub-linearly, which keeps most of the tufts and so keeps the ground
      // covered; and the whole fade ladder contracts, so the smaller budget
      // is spread over less ground and stays dense where the player is
      // actually looking. Scaling every ring by the same factor preserves the
      // ring-to-ring overlap, and shrinking fadeOut only ever helps the
      // tile-recycling margin asserted below.
      ring.perClump = Math.max(5, Math.round(cfg.perClump * Math.pow(mul, 0.75)));
      ring.clumpAttempts = Math.ceil((ring.maxBlades / ring.perClump) * 1.35);

      const reach = 0.62 + 0.38 * Math.min(1, mul);
      if (reach < 0.999) {
        ring.fadeIn = cfg.fadeIn.map((v) => v * reach);
        ring.fadeOut = cfg.fadeOut.map((v) => v * reach);
        ring.clumpRadius = cfg.clumpRadius * (0.80 + 0.20 * mul);
      }

      // The no-pop guarantee rests entirely on a tile being fully faded out
      // before the toroidal grid can ever recycle it. Worst case the camera
      // sits at the far corner of its own cell, so a 4×4 grid only guarantees
      // 2 × tileSize. Assert it rather than trust the arithmetic in the table
      // above — the failure mode is a row of blades popping in at speed, which
      // is easy to miss in a still and impossible to miss while driving.
      if (ring.fadeOut[1] > 2 * ring.tileSize - 2) {
        console.warn(`[Grass] ring tileSize ${ring.tileSize} only covers ` +
          `${2 * ring.tileSize} m but fades out at ${ring.fadeOut[1]} m — tiles ` +
          `can be recycled while still visible.`);
      }

      const blade = makeBladeGeometry(cfg.segments, cfg.tipBias ?? 1.0);
      // `ring`, not `cfg` — the material has to be given the *scaled* fade
      // ladder, or the shader keeps fading blades out at the ultra distances
      // while the CPU culls tiles at the contracted ones.
      const mat = createGrassMaterial(this.uniforms, ring);
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

        // build/built carry a part-finished fill across frames; see _build().
        ring.tiles.push({ ix: 1e9, iz: 1e9, mesh, geo, ib, data,
                          dirty: false, dist: 0, count: 0, minY: 0, maxY: 0,
                          build: 0, built: 0 });
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
            tile.build = 0; tile.built = 0;       // restart a partial build
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

  /**
   * Advance one tile's fill until it is finished or `deadline` passes.
   * A part-built tile stays invisible: dirty tiles only ever sit beyond their
   * ring's fade-out, so nothing is missing from the frame while it completes.
   * @returns {boolean} true when the tile is finished
   */
  _build(ring, tile, deadline) {
    const S = ring.tileSize;
    const ox = (tile.ix + 0.5) * S, oz = (tile.iz + 0.5) * S;
    const st = this._st;
    st.a = tile.build;
    st.n = tile.built;
    st.minY = tile.build === 0 ? Infinity : tile.minY;
    st.maxY = tile.build === 0 ? -Infinity : tile.maxY;
    st.deadline = deadline;

    const done = fillTile(this.ctx.world, this.roads, ring, ox, oz,
                          SEED, tile.data, st);

    tile.build = st.a;
    tile.built = st.n;
    tile.minY = st.minY;
    tile.maxY = st.maxY;
    if (!done) return false;

    const n = st.n;
    tile.geo.instanceCount = n;
    tile.count = n;
    if (n === 0) { tile.minY = 0; tile.maxY = 0; }
    tile.mesh.visible = n > 0;
    tile.mesh.position.set(ox, 0, oz);
    tile.mesh.updateMatrix();
    tile.mesh.updateMatrixWorld(true);

    if (n > 0) {
      const midY = (tile.minY + tile.maxY) * 0.5;
      const s = tile.geo.boundingSphere;
      s.center.set(0, midY, 0);
      // Half-diagonal of the tile, plus the vertical spread, plus headroom for
      // the wind swing so a gusting tile never gets culled at the screen edge.
      s.radius = Math.hypot(S * 0.5, S * 0.5) + (tile.maxY - tile.minY) * 0.5 + ring.height * 2.0;
      tile.ib.needsUpdate = true;
    }
    tile.dirty = false;
    return true;
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

    // One deadline for the whole frame's build work. Because fillTile is
    // resumable this is a real bound, not "budget plus however long one more
    // tile happens to take".
    const budget = this._first ? 400 : this._budgetMs;
    const deadline = performance.now() + budget;
    for (let i = 0; i < q.length; i += 2) {
      if (!this._build(q[i], q[i + 1], deadline)) break;
      if (performance.now() > deadline) break;
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
