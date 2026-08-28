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
import { RockScatter, VIS_PER_METRE, VIS_FLOOR, VIS_CAP } from './RockScatter.js';
// OCCLUDE. Rock ships two programs and this file owns the choice between them;
// see `_gateOcclusion` below and the note on `opts.occlude` in RockMaterial.js.
import { occlusionActive, occlusionTouchesSphere } from '../render/Occlusion.js';

const CELL = 64;              // metres per scatter cell
// Metres, and it IS the largest instance vis radius rather than a round number
// near it: past that nothing is drawn, so generating it is pure cost. A chain
// of blocks at a kilometre is a row of five-pixel dots on a hazed hillside, and
// the mountains are better served by terrain and aerial perspective alone.
const STREAM_RADIUS = VIS_CAP;
const REPACK_MOVE = 14;       // metres of camera travel before we repack
// Metres of camera travel before the *wanted set* is recomputed. This used to
// happen only when the camera crossed a cell boundary, which is a 64 m stride:
// a cell 90 m ahead was assessed once, at 90 m, and then not reassessed until
// the camera had driven a whole cell further — by which time it could be
// underfoot. Everything it had declined to generate then arrived in one batch,
// which is the "a rock popped in on top of me" report. See `_minSizeFor`.
const REFRESH_MOVE = 6;
// Centre to corner of a cell. A cell's contents can be this much nearer the
// camera than the cell's own centre is, and the detail floor has to be chosen
// for the nearest thing in the cell, not the middle of it.
const CELL_REACH = CELL * Math.SQRT1_2;   // 45.25 m
// How far ahead of the exact answer the detail floor is chosen, in metres.
//
// The gate below answers "could this rock be drawn from anywhere in this cell
// *right now*", and that is one refresh and one build-queue drain too late to
// be useful: refining a cell only puts it in a queue, the queue is worked at
// 2.2 ms a frame, and the camera keeps moving the whole time. Measured over a
// 45 s drive (tools/_scratch/rockpopdrive.mjs) the exact gate alone still had
// rocks arriving 38 m from the lens — not the 3 m the old gate managed, but
// close enough to notice. The lead buys REFRESH_MOVE plus about a second and a
// half of drain at speed, and it is the only fudge factor in this file: it is
// paying for latency, not for geometry, which is why it is a separate number
// rather than folded into CELL_REACH.
const STREAM_LEAD = 34;

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
    this._lastRefresh = new THREE.Vector3(1e9, 1e9, 1e9);
    // Test hook, and the only reason it exists: tools/_scratch/rockpopdrive.mjs
    // walks the same ground twice to compare this streamer against the one it
    // replaced, and the old one reassessed cells on a cell crossing only.
    this.__forceCellOnly = false;
    this._lastCell = { x: 1e9, z: 1e9 };
    this._catchup = 0;
    this._dirty = true;
    // OCCLUDE. Frames of program warm-up left, the meshes currently on the
    // occluding program, and whether that set is non-empty — see
    // `_gateOcclusion`.
    this._occWarm = 2;
    this._occAny = false;
    this._occHit = new Set();
    // Cells generated for `rocksAround` that the streamer never asked for —
    // see there. Bounded, and thrown away wholesale rather than aged, because
    // the only caller is a button press.
    this._probe = new Map();
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
    // Kept, not just handed over: `topOf`/`reachOf` answer questions about a
    // placed instance and need the same measurements the placement used.
    this.footprints = archFootprints(this.library);
    this.scatter.setFootprints(this.footprints);

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
        // OCCLUDE. The gate used to carry a per-prototype bounding radius here.
        // The volume is a small sphere about the lens now and the shader tests
        // each rock at its own origin with its own instance size, so the gate
        // asks the identical question in `_gateOcclusion` and there is nothing
        // per-prototype left to cache — only which program this mesh is on.
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
   * Detail floor for a cell whose centre is `d` from the camera, in metres of
   * rock *width*: rocks narrower than this are not generated for that cell.
   *
   * This has to be the exact inverse of the rule that decides whether an
   * instance is DRAWN, which lives in `_place`:
   *
   *     vis = clamp(size * VIS_PER_METRE, VIS_FLOOR, VIS_CAP)
   *
   * and the two used to disagree, in the one direction that is visible to the
   * player. The old rule was `minSize = 2d / VIS_PER_METRE`, which is that
   * inverse with the floor dropped and a factor of two standing in for the
   * cell's own size. Both of those are wrong, and they compound:
   *
   *  · A cell is 64 m across, so its nearest corner is CELL_REACH = 45 m
   *    closer to the camera than its centre. The floor has to be chosen for
   *    that corner. A factor of two only covers it past ~90 m.
   *  · Below VIS_FLOOR every rock is drawn *whatever its size*, so inside that
   *    range there is no detail floor at all — the correct answer is zero.
   *
   * Together they meant the camera's OWN cell (centre up to ~50 m away, since
   * the camera trails the camper) generated nothing under 0.8 m, while the
   * draw rule was willing to draw a 0.2 m cobble at 80 m. Measured over 18
   * random spots (tools/_scratch/rockpop.mjs): a median of 96 rocks per spot
   * were inside their own draw radius and did not exist, 7 of them within
   * 40 m, and the nearest came to 3.2 m of the camera. They appeared, en
   * masse, at whatever moment the cell was finally regenerated — which is the
   * pop-in, and with rock now solid it is also an invisible obstacle.
   *
   * So: measure to the nearest point of the cell, and return zero wherever the
   * floor would draw everything anyway — plus STREAM_LEAD, which is what makes
   * the answer arrive before it is needed rather than as it is needed.
   */
  _minSizeFor(d) {
    const near = Math.max(0, d - CELL_REACH - STREAM_LEAD);
    // Inside the floor, every size is drawn: generate the lot.
    if (near <= VIS_FLOOR) return 0;
    // Past it, the smallest rock that could be seen from anywhere in this cell.
    const need = near / VIS_PER_METRE;
    // Quantised into bands, so a metre of camera drift cannot trigger a
    // regeneration. The bands are the old ones — they were chosen against the
    // far field's "white chips sprinkled on the massif" read and that judgement
    // still holds; what changed is which cells land in which band.
    if (need < 2.0) return 0.9;
    if (need < 3.8) return 2.0;
    if (need < 6.2) return 3.8;
    if (need < 9.6) return 6.2;
    if (need < 14.5) return 9.6;
    if (need < 21.0) return 14.5;
    if (need < 29.0) return 21.0;
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
        // Nearest corner again, matching `_minSizeFor`: a cell whose centre is
        // just outside the radius still has 45 m of itself inside it.
        if (d - CELL_REACH > STREAM_RADIUS) continue;
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
   * In lateUpdate, not update: main.js switches the volume on at the end of the
   * update pass, so this is the first place in the frame that can read it with
   * this frame's camera in it. See the same note in Trees.js.
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
   * Like the tree gate, this one now asks the shader's own question rather than
   * a conservative superset of it: the same instance origin, the same radius off
   * the same instance size. The program therefore turns on at the exact distance
   * the fade starts having something to do, and at either swap both programs
   * draw the same pixels — the fade is 1.0 there. See the longer note in
   * Trees.js.
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
      // One cell of reach. The volume used to run all the way to the camper and
      // wanted two rings; it is a few metres of air around the lens now, and a
      // cell is 64 m, so the ring around the camera's own cell covers it many
      // times over however close to an edge the camera sits.
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const c = this.cells.get((ccx + dx) * 100003 + (ccz + dz));
          if (!c) continue;
          for (const inst of c.instances) {
            const ix = inst.x - cam.x, iz = inst.z - cam.z;
            if (ix * ix + iz * iz > inst.vis * inst.vis) continue;   // not drawn at all
            const mesh = this.byArch[inst.arch]?.[inst.variant];
            if (!mesh || hit.has(mesh)) continue;
            // The same radius the vertex shader uses — half the instance's own
            // size, capped, see RockMaterial — so the gate turns the discarding
            // program on exactly when the fade has something to do and not one
            // rock earlier.
            const r = Math.min(inst.size * 0.5, 2.0);
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

  /**
   * Every rock of consequence within `r` of a point — including the ones that
   * have not streamed in.
   *
   * `boulderNear` above deliberately walks the live cells only, and for a camp
   * pitched at the player's feet that is right. The rescue search is the other
   * case: it asks about ground up to 340 m away, which is well outside the
   * streamed set, and a query that answers "no rocks" for unloaded ground will
   * cheerfully drop the camper inside a boulder that pops in a second later.
   * That is not hypothetical — it is what tools/_scratch/rescuetest.mjs caught
   * the moment the search was allowed to reach past the streaming radius.
   *
   * The scatter is a pure function of cell coordinates and the seed, so a cell
   * that is not resident can simply be generated and thrown in a small cache.
   * It costs what one streamer job costs, and only a button press pays it.
   */
  rocksAround(x, z, r, minSize = 0.45, out = []) {
    const cx0 = Math.floor((x - r) / CELL), cx1 = Math.floor((x + r) / CELL);
    const cz0 = Math.floor((z - r) / CELL), cz1 = Math.floor((z + r) / CELL);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = cx * 100003 + cz;
        const live = this.cells.get(key);
        // A resident cell built at a coarser LOD than we are asking about has
        // dropped exactly the rocks in question, so it is generated too.
        const list = (live && live.minSize <= minSize)
          ? live.instances : this._probeCell(cx, cz, key, minSize);
        for (let i = 0; i < list.length; i++) {
          const inst = list[i];
          if (inst.size < minSize) continue;
          const dx = inst.x - x, dz = inst.z - z;
          if (dx * dx + dz * dz < r * r) out.push(inst);
        }
      }
    }
    return out;
  }

  /**
   * The world Y of the top of one placed rock, and its half-width in plan.
   *
   * Added for the mountain goats and yaks, which stand on boulders — the one
   * thing in the game that treats a rock as ground rather than as scenery. The
   * instance carries its own per-axis scale and the library carries the mesh's
   * local extents, and neither half is meaningful without the other, so the
   * multiply belongs here rather than in the wildlife code.
   *
   * `variant` is clamped the way `_buildCells` clamps it: an instance that came
   * back from `rocksAround` may have been generated by a probe cell, which
   * never went through that pass.
   */
  _foot(inst) {
    const list = this.footprints?.[inst.arch];
    if (!list || !list.length) return null;
    return list[Math.min(list.length - 1, Math.max(0, inst.variant | 0))];
  }

  /** World Y of the rock's summit, or its base if the archetype is unknown. */
  topOf(inst) {
    const fp = this._foot(inst);
    return fp ? inst.y + fp.hi * inst.sy : inst.y;
  }

  /** Half-width in plan — how far the rock reaches from its own centre. */
  reachOf(inst) {
    const fp = this._foot(inst);
    return fp ? Math.max(fp.rx * inst.sx, fp.rz * inst.sz) : inst.size * 0.5;
  }

  _probeCell(cx, cz, key, minSize) {
    const hit = this._probe.get(key);
    if (hit && hit.minSize <= minSize) return hit.instances;
    const instances = [];
    this.scatter.generateCell(cx, cz, CELL, minSize, instances);
    // Cleared wholesale: it is a scratch pad for one search, not a second
    // streaming cache to keep coherent with the first.
    if (this._probe.size > 192) this._probe.clear();
    this._probe.set(key, { instances, minSize });
    return instances;
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

    // Reassess which cells want which detail. On travel as well as on a cell
    // crossing: a cell only ever refines when this runs, so gating it on the
    // 64 m cell stride alone is what let a cell arrive underfoot still holding
    // the detail it was assigned from 90 m away. See REFRESH_MOVE.
    const ccx = Math.floor(cam.x / CELL), ccz = Math.floor(cam.z / CELL);
    if (ccx !== this._lastCell.x || ccz !== this._lastCell.z
        || (!this.__forceCellOnly && this._lastRefresh.distanceTo(cam) > REFRESH_MOVE)) {
      this._lastCell.x = ccx; this._lastCell.z = ccz;
      this._lastRefresh.copy(cam);
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
