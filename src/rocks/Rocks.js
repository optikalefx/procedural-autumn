// ─────────────────────────────────────────────────────────────────────────────
//  Rocks — boulders, scree fields, bedrock ribs and cliff relief.
//
//  Structure:
//    RockForms.js    convex-polytope mesh library (the faceted look)
//    RockScatter.js  geological placement rules (the composition)
//    RockMaterial.js the lavender-grey painted-plane shader
//    this file       streaming, instancing and the frame budget
//
//  One InstancedMesh per archetype/variant. Rocks are cheap geometry — a
//  boulder is ~120 triangles — so there is no distance LOD; instead each
//  instance carries its own visible radius, scaled by size. A hero erratic
//  carries 780 m, a cobble 85 m. That single rule is most of the perf story
//  and it also happens to be the right art call: the far field should be
//  composed of the big shapes only.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { SEED } from '../world/WorldConfig.js';
import { buildRockLibrary, ARCHETYPES } from './RockForms.js';
import { createRockMaterial } from './RockMaterial.js';
import { RockScatter } from './RockScatter.js';

const CELL = 64;              // metres per scatter cell
const STREAM_RADIUS = 800;    // metres; matches the largest instance vis radius
const REPACK_MOVE = 14;       // metres of camera travel before we repack

// Per-variant instance capacity, and whether the archetype casts shadows.
// Rubble does not: a 40 cm stone's shadow is invisible at any range where the
// stone itself is, and skipping it saves four shadow draws.
const CAPS = {
  boulder:  { cap: 300, shadow: true },
  slab:     { cap: 260, shadow: true },
  standing: { cap: 170, shadow: true },
  rubble:   { cap: 620, shadow: false },
  talus:    { cap: 300, shadow: true },
  hero:     { cap: 70,  shadow: true },
  ledge:    { cap: 210, shadow: true },
};

export class Rocks extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Rocks';
    this.loadLabel = 'Setting the stones';

    this.group = new THREE.Group();
    this.group.name = 'Rocks';

    this.cells = new Map();       // key -> { instances, minSize, cx, cz, d }
    this.queue = [];
    this.meshes = [];             // flat list of every InstancedMesh
    this.byArch = {};             // arch -> [InstancedMesh per variant]

    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._lastPack = new THREE.Vector3(1e9, 1e9, 1e9);
    this._lastCell = { x: 1e9, z: 1e9 };
    this._catchup = 0;
    this._dirty = true;
    this.stats = { instances: 0, tris: 0, cells: 0 };
  }

  async init() {
    const { scene, world } = this.ctx;

    this.material = createRockMaterial();
    this.scatter = new RockScatter(world, SEED);

    const t0 = performance.now();
    this.library = buildRockLibrary(SEED);

    let baseTris = 0;
    for (const [arch, geoms] of Object.entries(this.library)) {
      const cfg = CAPS[arch] ?? { cap: 200, shadow: true };
      const list = [];
      for (let v = 0; v < geoms.length; v++) {
        const g = geoms[v];
        baseTris += g.attributes.position.count / 3;

        // Per-instance shading inputs. Kept separate from the matrix so a
        // repack can rewrite them without touching transforms.
        g.setAttribute('aRockA', new THREE.InstancedBufferAttribute(new Float32Array(cfg.cap * 4), 4));
        g.setAttribute('aRockB', new THREE.InstancedBufferAttribute(new Float32Array(cfg.cap * 2), 2));

        const mesh = new THREE.InstancedMesh(g, this.material, cfg.cap);
        mesh.name = `rock_${arch}_${v}`;
        mesh.count = 0;
        mesh.visible = false;
        mesh.castShadow = cfg.shadow;
        mesh.receiveShadow = true;
        // Instances are spread over hundreds of metres; the geometry's own
        // bounding sphere would cull the whole field the moment the origin
        // rock left the frustum.
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.userData.arch = arch;
        this.group.add(mesh);
        this.meshes.push(mesh);
        list.push(mesh);
      }
      this.byArch[arch] = list;
    }
    scene.add(this.group);

    console.log(`[rocks] ${this.meshes.length} meshes, ${baseTris | 0} base tris, ` +
                `built in ${(performance.now() - t0).toFixed(0)} ms`);

    // Fill the world around wherever the camera starts before the first frame.
    this._catchup = 48;
  }

  // ── streaming ──────────────────────────────────────────────────────────────

  /** Detail floor for a cell at distance `d`: far cells only keep big rock. */
  _minSizeFor(d) {
    if (d > 330) return 1.7;
    if (d > 150) return 0.75;
    return 0;
  }

  _refreshQueue(cam) {
    const cellsWanted = new Set();
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
        cellsWanted.add(key);
        const minSize = this._minSizeFor(d);
        const have = this.cells.get(key);
        if (!have) this.queue.push({ cx, cz, key, d, minSize });
        else if (have.minSize > minSize + 1e-3) this.queue.push({ cx, cz, key, d, minSize });
      }
    }
    this.queue.sort((a, b) => a.d - b.d);

    for (const [key, c] of this.cells) {
      if (!cellsWanted.has(key)) { this.cells.delete(key); this._dirty = true; }
    }
    this._wanted = cellsWanted;
  }

  _buildCells(budgetMs) {
    if (!this.queue.length) return;
    const t0 = performance.now();
    let n = 0;
    while (n < this.queue.length) {
      const job = this.queue[n++];
      const instances = [];
      this.scatter.generateCell(job.cx, job.cz, CELL, job.minSize, instances);
      // Variant is picked here so a rock keeps its shape if the cell is
      // regenerated at finer detail — the field must not reshuffle visibly.
      for (const inst of instances) {
        const vcount = this.library[inst.arch].length;
        inst.variant = Math.min(vcount - 1, (inst.rnd * vcount) | 0);
      }
      this.cells.set(job.key, { instances, minSize: job.minSize, cx: job.cx, cz: job.cz });
      this._dirty = true;
      if (performance.now() - t0 > budgetMs) break;
    }
    this.queue.splice(0, n);
  }

  // ── packing ────────────────────────────────────────────────────────────────

  _repack(cam) {
    const counts = new Map();
    for (const m of this.meshes) counts.set(m, 0);

    // Nearest cells first, so if a bucket overflows it is the far rocks that
    // get dropped rather than the ones under the player's nose.
    const cells = [...this.cells.values()];
    for (const c of cells) {
      c._d = Math.hypot((c.cx + 0.5) * CELL - cam.x, (c.cz + 0.5) * CELL - cam.z);
    }
    cells.sort((a, b) => a._d - b._d);

    const m = this._m, p = this._p, q = this._q, s = this._s;
    let total = 0, tris = 0;

    for (const c of cells) {
      for (const inst of c.instances) {
        const dx = inst.x - cam.x, dz = inst.z - cam.z;
        if (dx * dx + dz * dz > inst.vis * inst.vis) continue;

        const mesh = this.byArch[inst.arch]?.[inst.variant];
        if (!mesh) continue;
        const i = counts.get(mesh);
        if (i >= mesh.instanceMatrix.count) continue;

        p.set(inst.x, inst.y, inst.z);
        q.set(inst.qx, inst.qy, inst.qz, inst.qw);
        s.set(inst.sx, inst.sy, inst.sz);
        m.compose(p, q, s);
        mesh.setMatrixAt(i, m);

        const a = mesh.geometry.attributes.aRockA.array;
        a[i * 4 + 0] = inst.wet;
        a[i * 4 + 1] = inst.moisture;
        a[i * 4 + 2] = inst.tint;
        a[i * 4 + 3] = inst.size;
        const b = mesh.geometry.attributes.aRockB.array;
        b[i * 2 + 0] = inst.waterY;
        b[i * 2 + 1] = inst.frost;

        counts.set(mesh, i + 1);
        total++;
        tris += mesh.geometry.attributes.position.count / 3;
      }
    }

    for (const mesh of this.meshes) {
      const n = counts.get(mesh);
      mesh.count = n;
      mesh.visible = n > 0;
      if (n > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.geometry.attributes.aRockA.needsUpdate = true;
        mesh.geometry.attributes.aRockB.needsUpdate = true;
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
    const u = this.material.userData.uniforms;
    const sun = this.ctx.lighting?.sunDir;
    if (sun) u.uSunDir.value.copy(sun);
    u.uTime.value = elapsed;

    // A teleport (capture harness, fast travel) invalidates the whole cache;
    // spend a much bigger budget for a few frames rather than trickle in.
    const moved = this._lastPack.distanceTo(cam);
    if (moved > 180) this._catchup = 40;

    const ccx = Math.floor(cam.x / CELL), ccz = Math.floor(cam.z / CELL);
    if (ccx !== this._lastCell.x || ccz !== this._lastCell.z) {
      this._lastCell.x = ccx; this._lastCell.z = ccz;
      this._refreshQueue(cam);
    }

    if (this._catchup > 0) { this._buildCells(28); this._catchup--; }
    else this._buildCells(2.2);

    if (this._dirty || moved > REPACK_MOVE) this._repack(cam);
    void dt;
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
    this.material.dispose();
    this.ctx.scene.remove(this.group);
    this.cells.clear();
    void ARCHETYPES;
  }
}
