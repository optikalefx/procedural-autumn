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
import { buildRockLibrary, archFootprints, ARCHETYPES } from './RockForms.js';
import { createRockMaterial } from './RockMaterial.js';
import { RockScatter, VIS_PER_METRE } from './RockScatter.js';
// OCCLUDE. Rock ships two programs and this file owns the choice between them;
// see `_gateOcclusion` below and the note on `opts.occlude` in RockMaterial.js.
import { occlusionActive, occlusionTouchesSphere } from '../render/Occlusion.js';

const CELL = 64;              // metres per scatter cell
// Metres. Matches the largest instance vis radius in RockScatter, which caps
// crag mass at ~950 m: past a kilometre a chain of blocks is a row of
// five-pixel dots on a hazed hillside, and the mountains are better served by
// terrain and aerial perspective alone.
const STREAM_RADIUS = 1000;
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
  ledge:    { cap: 220, shadow: true },
  bench:    { cap: 420, shadow: true },
  tower:    { cap: 260, shadow: true },
  cliff:    { cap: 620, shadow: true },
  prow:     { cap: 220, shadow: true },
};

/** Upload only the first `count` instances of an instance attribute. */
function upload(attr, count) {
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}

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
    // OCCLUDE. Frames of program warm-up left, the meshes currently on the
    // occluding program, and whether that set is non-empty — see
    // `_gateOcclusion`.
    this._occWarm = 2;
    this._occAny = false;
    this._occHit = new Set();
    this.stats = { instances: 0, tris: 0, cells: 0 };
  }

  async init() {
    const { scene, world } = this.ctx;

    this.material = createRockMaterial();
    // OCCLUDE. The same shader with the screen-door dither in it, sharing this
    // material's uniform block so `update` still writes the sun once. Swapped
    // onto a mesh only while one of its instances stands between the lens and
    // the camper — it gives up early-Z, and a crag field cannot afford that in
    // every frame. See RockMaterial.js.
    this.materialOcc = createRockMaterial({ occlude: true, uniforms: this.material.userData.uniforms });
    this.scatter = new RockScatter(world, SEED);

    const t0 = performance.now();
    this.library = buildRockLibrary(SEED);
    // Placement plants a crag block on its own base corners, so it needs the
    // built mesh's local extents. Read off the geometry rather than restated in
    // the scatter, so the two cannot drift apart.
    this.scatter.setFootprints(archFootprints(this.library));

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
        g.setAttribute('aRockB', new THREE.InstancedBufferAttribute(new Float32Array(cfg.cap * 3), 3));
        // Ground gradient under the instance, for the contact band. Separate
        // from aRockB only because that one is full.
        g.setAttribute('aRockC', new THREE.InstancedBufferAttribute(new Float32Array(cfg.cap * 2), 2));

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
        // OCCLUDE. A bounding radius about the INSTANCE ORIGIN rather than
        // about the geometry's own centre, so the frustum gate does not have to
        // rotate the centre offset per instance. Conservative by exactly that
        // offset, which is what a gate wants to be.
        if (!g.boundingSphere) g.computeBoundingSphere();
        mesh.userData.occR = g.boundingSphere.center.length() + g.boundingSphere.radius;
        mesh.userData.occOn = false;
        this.group.add(mesh);
        this.meshes.push(mesh);
        list.push(mesh);
      }
      this.byArch[arch] = list;
    }
    scene.add(this.group);

    // This runs on every page load in the project, including six other
    // authors' captures — keep an eye on it.
    this.buildMs = performance.now() - t0;
    window.__rocksBuildMs = this.buildMs;
    console.log(`[rocks] ${this.meshes.length} meshes, ${baseTris | 0} base tris, ` +
                `built in ${this.buildMs.toFixed(0)} ms`);

    // Fill the world around wherever the camera starts before the first frame.
    this._catchup = 48;
  }

  // ── streaming ──────────────────────────────────────────────────────────────

  /**
   * Detail floor for a cell at distance `d`, in metres of rock *width*.
   * Derived from the visibility rule rather than guessed: a rock of radius r
   * is drawn out to r * VIS_PER_METRE, so anything narrower than 2d/V could
   * never be seen from here and generating it is pure waste. Quantised into
   * bands so a metre of camera drift does not trigger a regeneration.
   */
  _minSizeFor(d) {
    const need = (2 * d) / VIS_PER_METRE;
    if (need < 0.9) return 0;
    if (need < 2.2) return 0.8;
    if (need < 4.0) return 2.0;
    if (need < 6.5) return 3.8;
    // The bands used to stop at 6.2 m, which meant every cell from 300 m to the
    // 920 m stream radius still generated three-metre blocks. They are culled
    // again at pack time by their own `vis`, so they cost only CPU — but the
    // ones right on the edge of that cutoff *are* drawn, at four or five pixels
    // each, and en masse that is the "white chips sprinkled on the massif" read
    // in the peaks view. Carrying the bands out to the stream radius means the
    // far field is composed of crag-scale mass only, which is what the plates
    // show.
    if (need < 10.0) return 6.2;
    if (need < 15.0) return 9.6;
    if (need < 22.0) return 14.5;
    if (need < 30.0) return 21.0;
    return 29.0;
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
      // Variant comes from the scatter, which picks it from a position hash so
      // it can anchor the block against the base of the shape that will
      // actually be drawn. Clamped here only as a guard: a rock must keep its
      // shape when the cell is regenerated at finer detail, and a position hash
      // guarantees that where the old rng-derived index did not.
      for (const inst of instances) {
        const vcount = this.library[inst.arch].length;
        inst.variant = Math.min(vcount - 1, Math.max(0, inst.variant | 0));
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
        b[i * 3 + 0] = inst.waterY;
        b[i * 3 + 1] = inst.frost;
        b[i * 3 + 2] = inst.groundY;
        const c = mesh.geometry.attributes.aRockC.array;
        c[i * 2 + 0] = inst.groundGX;
        c[i * 2 + 1] = inst.groundGZ;

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
        // Range, not the whole buffer — see GroundCover for the measurement.
        // Every archetype block is sized for its worst case and a repack fills
        // a fraction of it; the tail was being re-uploaded every time.
        upload(mesh.instanceMatrix, n);
        upload(mesh.geometry.attributes.aRockA, n);
        upload(mesh.geometry.attributes.aRockB, n);
        upload(mesh.geometry.attributes.aRockC, n);
      }
    }

    this.stats.instances = total;
    this.stats.tris = tris | 0;
    this.stats.cells = this.cells.size;
    this._lastPack.copy(cam);
    this._dirty = false;
  }

  // ── frame ──────────────────────────────────────────────────────────────────

  /**
   * OCCLUDE — pick the rock program for each instanced mesh, once a frame.
   *
   * In lateUpdate, not update: main.js aims the frustum at the end of the
   * update pass, so this is the first place in the frame that can read where it
   * actually points. See the same note in Trees.js.
   *
   * Per MESH means per archetype and variant — `rock_cliff_2`, `rock_boulder_0`
   * — because a program is a property of a draw call. That is coarse: one crag
   * block against the lens puts every drawn block of that shape on the
   * discarding program. It is still the right trade, because the frames where
   * ANY of them qualifies are rare — 17.5% of a 2075-frame drive through wood
   * (tools/_scratch/occgate.mjs), against bark's 61.7% — and the alternative is
   * paying for it in every frame of the game. On the frozen crag pose in
   * tools/_scratch/occsolid.mjs the swap costs 0.00 ms of a 17.7 ms frame.
   *
   * Like the tree gate, this one is deliberately conservative — a bounding
   * sphere about the instance origin, which contains everything the shader can
   * fade — so the program is always on before the volume reaches the stone and
   * still on after it leaves. At either swap both programs draw the same pixels
   * and there is nothing to see. See the longer note in Trees.js.
   */
  _gateOcclusion() {
    // Program warm-up: one frame drawn through the occluding variant so its
    // compile lands behind the loading fade rather than at the moment a crag
    // crosses the lens. See the same two-frame dance in Trees.js.
    if (this._occWarm > 0) {
      const on = this._occWarm === 2;
      for (const m of this.meshes) { m.userData.occOn = on; m.material = on ? this.materialOcc : this.material; }
      this._occAny = on;
      this._occWarm--;
      return;
    }

    const active = occlusionActive();
    if (!active && !this._occAny) return;      // nothing on, nothing to turn off

    const hit = this._occHit;
    hit.clear();
    if (active) {
      const cam = this.ctx.camera.position;
      const ccx = Math.floor(cam.x / CELL), ccz = Math.floor(cam.z / CELL);
      // Two cells of reach. The volume ends at the camper and the chase wheel
      // tops out at 68 m, and a cell is 64 m, so one ring is not quite enough
      // once the camera sits near a cell edge. The per-cell reject below means
      // the extra ring costs a distance compare each.
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const c = this.cells.get((ccx + dx) * 100003 + (ccz + dz));
          if (!c) continue;
          for (const inst of c.instances) {
            const ix = inst.x - cam.x, iz = inst.z - cam.z;
            if (ix * ix + iz * iz > inst.vis * inst.vis) continue;   // not drawn at all
            const mesh = this.byArch[inst.arch]?.[inst.variant];
            if (!mesh || hit.has(mesh)) continue;
            const r = mesh.userData.occR * Math.max(inst.sx, inst.sy, inst.sz);
            if (occlusionTouchesSphere(inst.x, inst.y, inst.z, r)) hit.add(mesh);
          }
        }
      }
    }

    let any = false;
    for (const m of this.meshes) {
      const on = hit.has(m);
      if (on !== m.userData.occOn) {
        m.userData.occOn = on;
        m.material = on ? this.materialOcc : this.material;
      }
      any = any || on;
    }
    this._occAny = any;
  }

  lateUpdate() {
    this._gateOcclusion();
  }

  /**
   * Is there a rock of consequence within `r` of a point?
   *
   * Added for the Camp system, which must not clear a patch of ground with a
   * two-metre erratic standing in the middle of it. Walks the live cells only —
   * a rock that has not streamed in yet is also a rock the player cannot see,
   * and the site test runs at the moment of placement, which is exactly when
   * the cells around the camper are resident.
   *
   * `minSize` skips the gravel: a camp is happily pitched among 20 cm cobbles
   * and that is part of what makes it look like a real spot.
   */
  boulderNear(x, z, r, minSize = 0.45) {
    for (const c of this.cells.values()) {
      for (const inst of c.instances) {
        if (inst.size < minSize) continue;
        const reach = r + inst.size * 0.75;
        const dx = inst.x - x, dz = inst.z - z;
        if (dx * dx + dz * dz < reach * reach) return inst;
      }
    }
    return null;
  }

  update(dt, elapsed) {
    const cam = this.ctx.camera.position;
    const u = this.material.userData.uniforms;
    const lighting = this.ctx.lighting;
    if (lighting?.sunDir) u.uSunDir.value.copy(lighting.sunDir);
    // Normalised so only the sun's *hue* reaches the albedo; its intensity is
    // already applied by the light rig and must not be double-counted.
    const sc = lighting?.sun?.color;
    if (sc) {
      const m = Math.max(sc.r, sc.g, sc.b, 1e-3);
      u.uSunTint.value.setRGB(sc.r / m, sc.g / m, sc.b / m);
    }
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
    this.materialOcc.dispose();
    this.ctx.scene.remove(this.group);
    this.cells.clear();
    void ARCHETYPES;
  }
}
