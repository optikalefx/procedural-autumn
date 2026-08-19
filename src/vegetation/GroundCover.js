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
const NEAR_VIS = 60;
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
const MAX_PER_CELL = 8200;

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
    this.meshes = [];              // flat list, index === slot index
    this.slots = [];               // flat list of every archetype/variant slot
    this._byArch = [];             // [archetype][variant] -> slot, for packing

    // Scratch — update() and _repack() must never allocate.
    this._scratch = new Float32Array(MAX_PER_CELL * COVER_STRIDE);
    this._counts = null;
    this._cellList = [];
    this._wanted = new Set();
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._qy = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._tilt = new THREE.Vector3();
    this._lastPack = new THREE.Vector3(1e9, 1e9, 1e9);
    this._lastCell = { x: 1e9, z: 1e9 };
    this._catchup = 0;
    this._dirty = true;
    this.stats = { instances: 0, tris: 0, cells: 0, buildMs: 0 };
  }

  async init() {
    const { scene, preset, world } = this.ctx;
    // No cover-specific quality knob exists, so ride the two vegetation ones.
    this.mul = Math.max(0.15, 0.5 * ((preset?.grassMul ?? 1) + (preset?.treeMul ?? 1)));

    const t0 = performance.now();
    const lib = buildCoverLibrary(SEED);

    this.matSolid = createCoverMaterial(this.uniforms, false);
    this.matCard = createCoverMaterial(this.uniforms, true);
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

        const mesh = new THREE.InstancedMesh(g, arch.card ? this.matCard : this.matSolid, cap);
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
        const slot = { mesh, geo: g, arch, ai, variant: v, index: this.meshes.length };
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
    if (d < 50) return 0;          // ground substrate, flowers  (vis <= 44)
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
      const n = this.scatter.generateCell(job.cx, job.cz, CELL, job.band, scratch, MAX_PER_CELL);
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
      this.cells.set(job.key, {
        far, near, nFar, nNear, count: n,
        band: job.band, cx: job.cx, cz: job.cz, d: job.d,
      });
      this._dirty = true;
      if (performance.now() - t0 > budgetMs) break;
    }
    this.queue.splice(0, done);
    this.stats.buildMs = performance.now() - t0;
  }

  // ── packing ────────────────────────────────────────────────────────────────

  _repack(cam) {
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
          const vis = data[i + 16];
          if (dx * dx + dz * dz > vis * vis) continue;

          const slot = this._byArch[data[i + 17]][data[i + 18]];
          const idx = counts[slot.index];
          if (idx >= slot.mesh.instanceMatrix.count) continue;

          // Lean with the ground, but only partly: a bush on a 30° slope grows
          // more upright than the hill, and fully aligning it looks pasted on.
          const nx = data[i + 19], nz = data[i + 20];
          const ny = Math.sqrt(Math.max(0.02, 1 - nx * nx - nz * nz));
          tilt.set(nx * 0.55, ny * 0.55 + 0.45, nz * 0.55).normalize();
          const yaw = data[i + 3];
          q.setFromUnitVectors(UP, tilt);
          qy.setFromAxisAngle(UP, yaw);
          q.multiply(qy);
          p.set(x, data[i + 1], z);
          s.set(data[i + 4], data[i + 5], data[i + 6]);
          m.compose(p, q, s);
          slot.mesh.setMatrixAt(idx, m);

          const g = slot.geo;
          const cA = g.getAttribute('aColA').array;
          cA[idx * 3] = data[i + 7]; cA[idx * 3 + 1] = data[i + 8]; cA[idx * 3 + 2] = data[i + 9];
          const cB = g.getAttribute('aColB').array;
          cB[idx * 3] = data[i + 10]; cB[idx * 3 + 1] = data[i + 11]; cB[idx * 3 + 2] = data[i + 12];
          const cv = g.getAttribute('aCov').array;
          cv[idx * 4] = data[i + 13];
          cv[idx * 4 + 1] = data[i + 14];
          cv[idx * 4 + 2] = data[i + 15];
          cv[idx * 4 + 3] = vis;
          // World wind rotated into the instance's own frame, so a whole hillside
          // sways one way instead of each plant swaying along its own yaw.
          const cw = Math.cos(yaw), sw = Math.sin(yaw);
          const wd = g.getAttribute('aWindDir').array;
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
        upload(slot.geo.getAttribute('aColA'), n);
        upload(slot.geo.getAttribute('aColB'), n);
        upload(slot.geo.getAttribute('aCov'), n);
        upload(slot.geo.getAttribute('aWindDir'), n);
      }
    }

    this.stats.instances = total;
    this.stats.tris = tris | 0;
    this.stats.cells = this.cells.size;
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
    if (ccx !== this._lastCell.x || ccz !== this._lastCell.z) {
      this._lastCell.x = ccx; this._lastCell.z = ccz;
      this._refreshQueue(cam);
    }

    // 12 ms rather than 26. A single cell of the ground-substrate layer is a
    // few hundred instances now, and the budget is only checked *between*
    // cells, so a large per-frame allowance turns into a real hitch as soon as
    // the queue is deep. Spreading the same work over more frames costs a
    // slightly longer fill-in and no visible spike.
    if (this._catchup > 0) { this._buildCells(12); this._catchup--; }
    else this._buildCells(1.6);

    if (this._dirty || moved > REPACK_MOVE) this._repack(cam);
    void dt;
  }

  dispose() {
    for (const slot of this.slots) slot.geo.dispose();
    this.matSolid.dispose();
    this.matCard.dispose();
    this.matDepth.dispose();
    this.ctx.scene.remove(this.group);
    this.cells.clear();
    this.meshes.length = 0;
    this.slots.length = 0;
  }
}
