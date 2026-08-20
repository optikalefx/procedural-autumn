// ─────────────────────────────────────────────────────────────────────────────
//  GroundCover — the mid layer: shrubs, scrub, ferns, flowers, litter, deadfall.
//
//  Structure:
//    cover_forms.js          the procedural mesh library (silhouette)
//    cover_scatter.js        placement rules (composition)
//    shaders/cover_material  the instanced painted material (shading)
//    this file               streaming, instancing and the frame budget
//
//  The problem this system exists to solve is that a gold meadow with a
//  treeline behind it has exactly two values in it. The reference plates are
//  full of a third: small, dark, ground-level masses — bushes in the open,
//  bronze fern beds and deadfall under canopy, litter drifts at the tree bases.
//  Those are what give the ground its scale and stop it reading as a carpet.
//
//  Streaming follows the Rocks system's pattern, because it is the right shape
//  for this problem and consistency is worth more than novelty: a 48 m cell
//  grid around the camera, cells generated on a per-frame millisecond budget,
//  and every instance carrying its own visibility radius so the far field is
//  composed of the big shapes only. There is no geometry LOD — a shrub is 90
//  triangles, and a second LOD tier would cost more draw calls than it saved
//  triangles. What replaces it is a *detail band* per cell: a cell 250 m away
//  never even generates the ferns and flowers it could not show.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { SEED } from '../world/WorldConfig.js';
import { buildCoverLibrary, COVER_ARCHETYPES } from './cover_forms.js';
import { CoverScatter, COVER_STRIDE } from './cover_scatter.js';
import { makeCoverUniforms, createCoverMaterial, createCoverDepthMaterial } from '../shaders/cover_material.js';

const CELL = 48;                 // metres per scatter cell
// Must exceed the largest archetype visibility radius (thicket, 250 m) by more
// than a cell diagonal, or an instance becomes visible in the same frame its
// cell is created and pops rather than fading in.
const STREAM_RADIUS = 300;
const REPACK_MOVE = 12;          // metres of camera travel before a repack
// Visibility radius that splits a cell's instances into two buffers.
//
// A repack has to look at every instance of every live cell to decide whether
// it is inside its own radius, and nine tenths of them are 3-30 cm substrate
// props with radii of 25-55 m. Streaming holds cells out to 300 m, so the scan
// was spending nine tenths of its time on grit that could not possibly be
// visible — a million distance tests per repack, roughly once a second while
// driving, which is exactly the shape of the >50 ms frames in `perf.mjs`.
//
// Splitting at generation time costs one extra pass over a cell that has just
// been generated, and lets a repack skip the whole near buffer for any cell
// whose nearest corner is further away than anything in it could be seen from.
// Every archetype at or above this radius goes in the far buffer; the number
// itself only has to sit in the gap between `scrubDry` (55) and `cobble` (74).
// RAISED from 60 to 92 with the arrival of `groundMat` (vis 88), and then to
// 132 when that radius went to 130. The rule is the same both times and it is
// worth stating as a rule, because getting it wrong is silent and expensive:
//
//   NEAR_VIS must sit JUST ABOVE the radius of the most numerous archetype.
//
// The far buffer is scanned for every live cell out to 300 m — around 120 of
// them — and the near buffer only for cells inside NEAR_VIS. `groundMat` is by
// a distance the most numerous long-radius thing in the layer (a cell can hold
// several hundred), so leaving it above the threshold puts tens of thousands of
// extra distance tests into every repack, which happens every 12 m of travel.
// At 132 the mats ride in the near buffer and a cell beyond 132 m skips them
// wholesale, while `shrubDark` (135) and `thicket` (250) — a couple of dozen
// per cell — stay in the far buffer where they belong.
const NEAR_VIS = 132;
// Scratch capacity for one cell's generation. A 48 m cell is 2304 m², and the
// ground-substrate layer now aims at roughly one clump every 3 m² with up to
// twenty pieces in a clump, so the old 2200 was clipping the far half of every
// cell — silently, and worst in exactly the dense hollows the layer exists for.
//
// 5600 was still clipping, and the diagnostic is unambiguous: seven of the nine
// nearest band-0 cells came back holding exactly 5600 instances — the value of
// this constant, which is what a truncation looks like. Every one of those
// cells lost the tail of the ground layer and the whole of the tree skirt after
// it, in the 50 m ring the player is actually looking at. The layer order below
// now puts the structural skirt ahead of the substrate as well, so that if this
// ever binds again it drops grit rather than the clumps at the foot of a tree.
const MAX_PER_CELL = 12200;

// One prevailing wind for the whole valley, matching the leaf-drift direction
// in cover_scatter.js. Held constant so each instance's local sway axis can be
// baked at pack time instead of inverting the instance basis per vertex.
const WIND_ANGLE = 0.7;
const WIND_X = Math.cos(WIND_ANGLE), WIND_Z = Math.sin(WIND_ANGLE);

const UP = new THREE.Vector3(0, 1, 0);

/** Upload only the first `count` instances of an instance attribute. */
function upload(attr, count) {
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}

export class GroundCover extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'GroundCover';
    this.loadLabel = 'Seeding the undergrowth';

    this.group = new THREE.Group();
    this.group.name = 'GroundCover';
    this.group.matrixAutoUpdate = false;

    this.uniforms = makeCoverUniforms();
    this.cells = new Map();        // key -> { data, count, band, cx, cz, d }
    this.queue = [];
    // Deferred substrate jobs, one slice per entry. See `_buildGround`.
    this.gQueue = [];
    this.meshes = [];              // flat list, index === slot index
    this.slots = [];               // flat list of every archetype/variant slot
    this._byArch = [];             // [archetype][variant] -> slot, for packing

    // Scratch — update() and _repack() must never allocate.
    this._scratch = new Float32Array(MAX_PER_CELL * COVER_STRIDE);
    // Separate accumulator for the one band-0 substrate cell in flight, so a
    // slice job cannot be clobbered by a structural cell built in the same
    // frame out of `_scratch`.
    this._gscratch = new Float32Array(MAX_PER_CELL * COVER_STRIDE);
    this._counts = null;
    this._cellList = [];
    this._wanted = new Set();
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._qy = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._tilt = new THREE.Vector3();
    // ── near-field LOD instrument ────────────────────────────────────────
    // A multiplier on every instance's own visibility radius, applied in
    // `_repack` to BOTH the cull test and the `aCov.w` the shader fades
    // against, so the two can never disagree. It exists because the only
    // trustworthy way to price reach on a machine five other authors are
    // capturing on is an A/B *within one page load* — see
    // `tools/_scratch/lodab.mjs` and the perf author's note in
    // INTEGRATION_REQUESTS ("A/B'd within one page load ... so machine
    // contention hits both arms equally"). Ships at 1; nothing reads it unless
    // a harness sets it.
    this.visMul = 1;
    this._lastPack = new THREE.Vector3(1e9, 1e9, 1e9);
    this._lastCell = { x: 1e9, z: 1e9 };
    this._lastRefresh = new THREE.Vector3(1e9, 1e9, 1e9);
    this._packT = -1e9;
    this._catchup = 0;
    this._dirty = true;
    this.stats = { instances: 0, tris: 0, cells: 0, buildMs: 0, groundMs: 0, packMs: 0, packMaxMs: 0, packs: 0 };
  }

  async init() {
    const { scene, preset, world } = this.ctx;
    // No cover-specific quality knob exists, so ride the two vegetation ones.
    this.mul = Math.max(0.15, 0.5 * ((preset?.grassMul ?? 1) + (preset?.treeMul ?? 1)));

    const t0 = performance.now();
    const lib = buildCoverLibrary(SEED);

    this.matSolid = createCoverMaterial(this.uniforms, false);
    this.matCard = createCoverMaterial(this.uniforms, true);
    // One extra program, for the broad ground mats' distance fade-in. It is a
    // compile-time define rather than a uniform because every other archetype
    // must not pay a second smoothstep per vertex for a branch it never takes.
    this.matMat = createCoverMaterial(this.uniforms, true, true);
    this.matDepth = createCoverDepthMaterial(this.uniforms);

    for (let ai = 0; ai < COVER_ARCHETYPES.length; ai++) {
      const arch = COVER_ARCHETYPES[ai];
      const cap = Math.max(24, Math.ceil(arch.cap * this.mul));
      const list = [];
      for (let v = 0; v < arch.variants; v++) {
        const g = lib.geoms[ai][v];
        g.setAttribute('aColA', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
        g.setAttribute('aColB', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
        g.setAttribute('aCov', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
        g.setAttribute('aWindDir', new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2));
        for (const k of ['aColA', 'aColB', 'aCov', 'aWindDir']) {
          g.getAttribute(k).setUsage(THREE.DynamicDrawUsage);
        }

        const mat = arch.nearFade ? this.matMat : (arch.card ? this.matCard : this.matSolid);
        const mesh = new THREE.InstancedMesh(g, mat, cap);
        mesh.name = `cover_${arch.key}_${v}`;
        mesh.count = 0;
        mesh.visible = false;
        mesh.castShadow = arch.shadow;
        mesh.receiveShadow = arch.recv !== false;
        // Instances are spread over hundreds of metres; the geometry's own
        // bounding sphere would cull the whole field the moment the prototype
        // at the origin left the frustum.
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.matrixAutoUpdate = false;
        if (arch.shadow) mesh.customDepthMaterial = this.matDepth;
        mesh.userData.tris = g.userData.tris;

        this.group.add(mesh);
        // Attribute arrays cached on the slot. `_repack` writes every drawn
        // instance in one unbudgeted pass, and it used to reach them with five
        // `getAttribute` lookups PER INSTANCE — at 26,000 instances that is
        // 130,000 string lookups in the one frame of the round that can least
        // afford them. Nothing about them changes after init.
        const slot = { mesh, geo: g, arch, ai, variant: v, index: this.meshes.length,
                       aColA: g.getAttribute('aColA'), aColB: g.getAttribute('aColB'),
                       aCov: g.getAttribute('aCov'), aWindDir: g.getAttribute('aWindDir') };
        this.meshes.push(mesh);
        this.slots.push(slot);
        list.push(slot);
      }
      // Indexed by archetype then variant, which is how the packer looks up.
      this._byArch.push(list);
    }
    this._counts = new Int32Array(this.meshes.length);

    this.scatter = new CoverScatter(world, SEED, { mul: this.mul });
    // Read the tree placement defensively — Trees inits before this system, but
    // a failed init there must not take the undergrowth down with it.
    this.scatter.attachTrees(this.ctx.systems?.trees?.trees ?? null);

    scene.add(this.group);

    this.buildMs = performance.now() - t0;
    console.log(`[cover] ${this.meshes.length} meshes, ${lib.tris} base tris, ` +
                `trees ${this.scatter.trees ? 'linked' : 'absent'}, ` +
                `built in ${this.buildMs.toFixed(0)} ms`);

    // Fill the world around wherever the camera starts before the first frame.
    this._catchup = 80;
  }

  // ── streaming ──────────────────────────────────────────────────────────────

  /**
   * Detail band for a cell at distance `d`. Each boundary sits comfortably
   * beyond the visibility radius of every archetype in that band, so refining a
   * cell only ever adds things that were invisible from where they were added.
   */
  _bandFor(d) {
    // Boundary 0 RAISED from 50 to 84. It is a hard ceiling on how far the
    // substrate can be seen, and it was the thing that made the substrate's
    // 22-24 m radii look like a free choice: nothing in `_layerGround` could
    // reach past 50 m however generous its radius, because no cell beyond that
    // ever generates it. With the substrate now carrying 30-59 m radii (see
    // `visSpread` in cover_forms.js) it has to sit clear of the largest of
    // them — deadTuft tops out at 42 * 1.40 = 58.8 — with room for the
    // largest of them — deadTuft tops out at 46 * 1.40 = 64.4 — with room for
    // the slack `_refreshQueue` allows (12 m) and for the streamer's own
    // fill-in latency on top of that.
    //
    // What it costs is streaming, not frame time: the band-0 disc goes from
    // ~10 cells to ~19, so the rate at which substrate cells have to be
    // generated while driving rises about 40% (2*pi*R*v / CELL^2 — perimeter,
    // not area). At 13 m/s that is 4.2 cells per second against a 1.6 ms per
    // frame budget, i.e. 25 ms of work per second of driving. It is the
    // *generation* budget this spends, and it has the room.
    if (d < 84) return 0;          // ground substrate, flowers  (vis <= 64.4)
    if (d < 134) return 1;         // ferns, branches            (vis <= 88)
    if (d < 196) return 2;         // scrub, berries, litter     (vis <= 155)
    return 3;                      // shrubs, thickets, deadfall (vis <= 250)
  }

  _refreshQueue(cam) {
    const wanted = this._wanted;
    wanted.clear();
    this.queue.length = 0;
    const r = Math.ceil(STREAM_RADIUS / CELL);
    const ccx = Math.floor(cam.x / CELL), ccz = Math.floor(cam.z / CELL);

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = ccx + dx, cz = ccz + dz;
        const mx = (cx + 0.5) * CELL, mz = (cz + 0.5) * CELL;
        const d = Math.hypot(mx - cam.x, mz - cam.z);
        if (d > STREAM_RADIUS) continue;
        const key = cx * 100003 + cz;
        wanted.add(key);
        // Band from the *nearest* corner, not the centre: a 48 m cell straddles
        // a boundary, and generating from the centre leaves the near half of it
        // one band too coarse.
        const near = Math.max(0, d - CELL * 0.708);
        const band = this._bandFor(near);
        const have = this.cells.get(key);
        if (!have) this.queue.push({ cx, cz, key, d, band });
        else if (have.band > band) this.queue.push({ cx, cz, key, d, band });
      }
    }
    this.queue.sort((a, b) => a.d - b.d);

    for (const [key] of this.cells) {
      if (!wanted.has(key)) { this.cells.delete(key); this._dirty = true; }
    }
  }

  _buildCells(budgetMs) {
    if (!this.queue.length) return;
    const t0 = performance.now();
    const scratch = this._scratch;
    let done = 0;
    while (done < this.queue.length) {
      const job = this.queue[done++];
      // Band-0 cells hand their substrate layer to `_buildGround` rather than
      // generating it here. See the note on `generateGroundSlice`: the layer is
      // 8-10,000 instances and 4-5 ms, and a per-frame *budget* cannot help
      // when the smallest unit of work is bigger than the budget.
      const defer = job.band <= 0;
      const n = this.scatter.generateCell(job.cx, job.cz, CELL, job.band, scratch,
                                          MAX_PER_CELL, defer);
      // Two right-sized copies per cell rather than a few hundred small
      // objects: the long-radius forms, which every repack has to consider,
      // and the short-radius substrate, which most repacks can ignore whole.
      let nFar = 0;
      for (let k = 0; k < n; k++) if (scratch[k * COVER_STRIDE + 16] >= NEAR_VIS) nFar++;
      const nNear = n - nFar;
      const far = nFar ? new Float32Array(nFar * COVER_STRIDE) : null;
      const near = nNear ? new Float32Array(nNear * COVER_STRIDE) : null;
      for (let k = 0, a = 0, b2 = 0; k < n; k++) {
        const i = k * COVER_STRIDE;
        const src = scratch.subarray(i, i + COVER_STRIDE);
        if (scratch[i + 16] >= NEAR_VIS) { far.set(src, a); a += COVER_STRIDE; }
        else { near.set(src, b2); b2 += COVER_STRIDE; }
      }
      const cell = {
        far, near, nFar, nNear, count: n,
        band: job.band, cx: job.cx, cz: job.cz, d: job.d,
      };
      this.cells.set(job.key, cell);
      if (defer) {
        // A cell re-queued at a finer band replaces one that may still have
        // slices outstanding; those would append a second copy of the substrate
        // to the new buffer. Drop them.
        for (let gi = this.gQueue.length - 1; gi >= 0; gi--) {
          if (this.gQueue[gi].key === job.key) this.gQueue.splice(gi, 1);
        }
        this.gQueue.push({ key: job.key, cx: job.cx, cz: job.cz, slice: 0, gn: 0 });
      }
      this._dirty = true;
      if (performance.now() - t0 > budgetMs) break;
    }
    this.queue.splice(0, done);
    this.stats.buildMs = performance.now() - t0;
  }

  /**
   * Generate the deferred substrate for band-0 cells, one slice at a time.
   *
   * One cell is in flight at once and its slices accumulate in `_gscratch`;
   * only when the last slice lands is the cell's near buffer rebuilt, so the
   * substrate appears all at once rather than growing in quarters. That matters
   * less than it sounds — a cell only enters band 0 at 50 m, and four frames of
   * 60 Hz is 67 ms — but a partially-filled cell would also have to be packed
   * repeatedly, and packing is the other half of the frame cost.
   *
   * Everything in this layer has a visibility radius under `NEAR_VIS`, so it
   * all belongs in the near buffer and the far buffer is never touched.
   */
  _buildGround(budgetMs) {
    if (!this.gQueue.length) return;
    const t0 = performance.now();
    const g = this._gscratch;
    while (this.gQueue.length) {
      const job = this.gQueue[0];
      const cell = this.cells.get(job.key);
      // Evicted while its substrate was still queued, or superseded by a finer
      // band. Either way the job is stale.
      if (!cell || cell.cx !== job.cx || cell.cz !== job.cz) { this.gQueue.shift(); continue; }
      job.gn = this.scatter.generateGroundSlice(job.cx, job.cz, CELL, g, job.gn,
                                                MAX_PER_CELL, job.slice);
      job.slice++;
      if (job.slice >= CoverScatter.GROUND_SLICES) {
        this.gQueue.shift();
        const add = job.gn;
        if (add) {
          const near = new Float32Array((cell.nNear + add) * COVER_STRIDE);
          if (cell.near) near.set(cell.near.subarray(0, cell.nNear * COVER_STRIDE), 0);
          near.set(g.subarray(0, add * COVER_STRIDE), cell.nNear * COVER_STRIDE);
          cell.near = near;
          cell.nNear += add;
          cell.count += add;
          this._dirty = true;
        }
      }
      if (performance.now() - t0 > budgetMs) break;
    }
    this.stats.groundMs = performance.now() - t0;
  }

  // ── packing ────────────────────────────────────────────────────────────────

  _repack(cam) {
    // A repack is the one piece of work in this system that is neither budgeted
    // nor resumable: it walks every instance of every live cell and rewrites
    // the matrix and five attributes of each one that passes. It runs on 12 m
    // of camera travel, i.e. about once a second at driving speed, so if it
    // costs more than a frame it does not show up in p50 at all — it shows up
    // as a periodic hitch in p95, which is the number the player feels.
    const tPack = performance.now();
    const counts = this._counts;
    counts.fill(0);

    // Nearest cells first, so if a bucket overflows it is the far instances
    // that get dropped rather than the ones under the player's nose.
    const list = this._cellList;
    list.length = 0;
    for (const c of this.cells.values()) {
      if (!c.count) continue;
      c.d = Math.hypot((c.cx + 0.5) * CELL - cam.x, (c.cz + 0.5) * CELL - cam.z);
      list.push(c);
    }
    list.sort((a, b) => a.d - b.d);

    const m = this._m, p = this._p, q = this._q, qy = this._qy, s = this._s, tilt = this._tilt;
    const vm = this.visMul;
    let total = 0, tris = 0;

    for (let ci = 0; ci < list.length; ci++) {
      const c = list[ci];
      // Distance to the cell's nearest edge, not to its centre. A cell is 48 m
      // across, so a centre-distance test would keep scanning a cell for
      // 34 metres after the near half of it stopped being able to show
      // anything — and would drop instances that are still visible in the
      // half nearest the camera.
      const ex = Math.max((c.cx * CELL) - cam.x, 0, cam.x - (c.cx + 1) * CELL);
      const ez = Math.max((c.cz * CELL) - cam.z, 0, cam.z - (c.cz + 1) * CELL);
      const nearVisible = ex * ex + ez * ez < NEAR_VIS * NEAR_VIS;
      const passes = nearVisible ? 2 : 1;
      for (let pass = 0; pass < passes; pass++) {
        const data = pass === 0 ? c.far : c.near;
        const cnt = pass === 0 ? c.nFar : c.nNear;
        if (!data) continue;
        for (let k = 0; k < cnt; k++) {
          const i = k * COVER_STRIDE;
          const x = data[i], z = data[i + 2];
          const dx = x - cam.x, dz = z - cam.z;
          const vis = data[i + 16] * vm;
          if (dx * dx + dz * dz > vis * vis) continue;

          const slot = this._byArch[data[i + 17]][data[i + 18]];
          const idx = counts[slot.index];
          if (idx >= slot.mesh.instanceMatrix.count) continue;

          // Lean with the ground, but only partly: a bush on a 30° slope grows
          // more upright than the hill, and fully aligning it looks pasted on.
          //
          // Per archetype, because that is only true of things that *stand* on
          // the ground. A three-metre ground mat leaning 55% of a 30° slope
          // buries its uphill edge half a metre deep and flies its downhill one
          // the same distance clear, which is the failure every previous
          // attempt at broad ground cover in this file hit. `conform: 1` takes
          // those to the full terrain normal, where a flat thing on a flat
          // slope is exactly right.
          const cf = slot.arch.conform ?? 0.55;
          const nx = data[i + 19], nz = data[i + 20];
          const ny = Math.sqrt(Math.max(0.02, 1 - nx * nx - nz * nz));
          tilt.set(nx * cf, ny * cf + (1 - cf), nz * cf).normalize();
          const yaw = data[i + 3];
          q.setFromUnitVectors(UP, tilt);
          qy.setFromAxisAngle(UP, yaw);
          q.multiply(qy);
          p.set(x, data[i + 1], z);
          s.set(data[i + 4], data[i + 5], data[i + 6]);
          m.compose(p, q, s);
          slot.mesh.setMatrixAt(idx, m);

          const cA = slot.aColA.array;
          cA[idx * 3] = data[i + 7]; cA[idx * 3 + 1] = data[i + 8]; cA[idx * 3 + 2] = data[i + 9];
          const cB = slot.aColB.array;
          cB[idx * 3] = data[i + 10]; cB[idx * 3 + 1] = data[i + 11]; cB[idx * 3 + 2] = data[i + 12];
          const cv = slot.aCov.array;
          cv[idx * 4] = data[i + 13];
          cv[idx * 4 + 1] = data[i + 14];
          cv[idx * 4 + 2] = data[i + 15];
          cv[idx * 4 + 3] = vis;
          // World wind rotated into the instance's own frame, so a whole hillside
          // sways one way instead of each plant swaying along its own yaw.
          const cw = Math.cos(yaw), sw = Math.sin(yaw);
          const wd = slot.aWindDir.array;
          wd[idx * 2] = WIND_X * cw - WIND_Z * sw;
          wd[idx * 2 + 1] = WIND_X * sw + WIND_Z * cw;

          counts[slot.index] = idx + 1;
          total++;
          tris += slot.mesh.userData.tris;
        }
      }
    }

    for (let si = 0; si < this.slots.length; si++) {
      const slot = this.slots[si];
      const n = counts[slot.index];
      slot.mesh.count = n;
      slot.mesh.visible = n > 0;
      if (n > 0) {
        // Range, not the whole buffer. These blocks are sized for the worst
        // case and a repack typically fills a fraction of one; without a range
        // `needsUpdate` re-uploads the unused tail as well, which measured
        // 15.6 MB of pointless bus traffic over a 30 s drive.
        upload(slot.mesh.instanceMatrix, n);
        upload(slot.aColA, n);
        upload(slot.aColB, n);
        upload(slot.aCov, n);
        upload(slot.aWindDir, n);
      }
    }

    this.stats.instances = total;
    this.stats.tris = tris | 0;
    this.stats.cells = this.cells.size;
    this.stats.packMs = performance.now() - tPack;
    this.stats.packs++;
    if (this.stats.packMs > this.stats.packMaxMs) this.stats.packMaxMs = this.stats.packMs;
    this._lastPack.copy(cam);
    this._dirty = false;
  }

  // ── frame ──────────────────────────────────────────────────────────────────

  update(dt, elapsed) {
    const cam = this.ctx.camera.position;
    const u = this.uniforms;
    u.uTime.value = elapsed;
    const lighting = this.ctx.lighting;
    if (lighting?.sunDir) u.uSunDir.value.copy(lighting.sunDir);
    if (lighting?.sun) u.uSunColor.value.copy(lighting.sun.color);

    // A teleport (capture harness, fast travel) invalidates the whole cache;
    // spend a much bigger budget for a few frames rather than trickle in.
    const moved = this._lastPack.distanceTo(cam);
    if (moved > 160) this._catchup = 70;

    const ccx = Math.floor(cam.x / CELL), ccz = Math.floor(cam.z / CELL);
    // Also on distance travelled, not only on crossing a cell boundary.
    //
    // A cell's detail band is decided from the camera position at refresh time,
    // and a camera that enters a cell at one corner and leaves at the opposite
    // one travels 68 m without ever changing cell index. That was harmless
    // while the substrate faded out at 23 m against a 50 m boundary — 27 m of
    // slack. The substrate now reaches 59 m against a 68 m boundary, so the
    // slack is 9 m and in-cell travel could carry a band-1 cell (no substrate
    // at all) inside the radius at which its substrate should be visible. The
    // symptom would be a wedge of undressed ground appearing at speed, which
    // is exactly the class of defect this whole change exists to remove.
    // A refresh is a 15x15 scan of integers; running it every 12 m of travel
    // costs nothing and bounds the error at 12 m instead of 68.
    const travelled = this._lastRefresh.distanceToSquared(cam);
    if (ccx !== this._lastCell.x || ccz !== this._lastCell.z || travelled > 144) {
      this._lastCell.x = ccx; this._lastCell.z = ccz;
      this._lastRefresh.copy(cam);
      this._refreshQueue(cam);
    }

    // 12 ms rather than 26. A single cell of the ground-substrate layer is a
    // few hundred instances now, and the budget is only checked *between*
    // cells, so a large per-frame allowance turns into a real hitch as soon as
    // the queue is deep. Spreading the same work over more frames costs a
    // slightly longer fill-in and no visible spike.
    if (this._catchup > 0) { this._buildCells(12); this._buildGround(10); this._catchup--; }
    else { this._buildCells(1.6); this._buildGround(1.6); }

    // ── when to repack ──────────────────────────────────────────────────
    // `_dirty` is set by EVERY completed cell and every completed substrate
    // slice, and a repack is a full rewrite of every drawn instance — it is the
    // one piece of work here that is neither budgeted nor resumable. While
    // driving, cells complete several times a second, so the old condition ran
    // a full repack several times a second as well. That was affordable at
    // 7,000 instances (~4 ms) and is not at 26,000 (measured 12.2 ms max), and
    // it lands as a periodic hitch in p95 rather than anywhere in p50.
    //
    // Nothing is lost by coalescing them. A cell that has just finished
    // building is at least 84 m away for substrate and up to 300 m for the
    // structural forms — several seconds of driving before any of it is inside
    // its own visibility radius — so holding its instances back for a fifth of
    // a second is invisible. Travel still forces a repack on its own schedule,
    // and the first pack after a teleport is never delayed.
    const now = performance.now();
    if (moved > REPACK_MOVE || (this._dirty && now - this._packT > 200)) {
      this._packT = now;
      this._repack(cam);
    }
    void dt;
  }

  dispose() {
    for (const slot of this.slots) slot.geo.dispose();
    this.matSolid.dispose();
    this.matCard.dispose();
    this.matMat.dispose();
    this.matDepth.dispose();
    this.ctx.scene.remove(this.group);
    this.cells.clear();
    this.queue.length = 0;
    this.gQueue.length = 0;
    this.meshes.length = 0;
    this.slots.length = 0;
  }
}
