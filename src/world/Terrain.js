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
import { TERRAIN, WORLD, SEED } from './WorldConfig.js';
import { createTerrainMaterial } from './TerrainMaterial.js';
import { clamp, clamp01, smoothstep } from '../core/MathUtils.js';
import { NoiseField } from '../core/Noise.js';

// ── The world edge ───────────────────────────────────────────────────────────
// The playable heightfield is 3072 m square and several canonical cameras stand
// *outside* it (the peaks framing resolves to 341 m beyond the -Z boundary), so
// the map's rim was drawn as a dead-straight vertical cliff with empty sky past
// it, and the chunk skirts along that rim hung into the sky as black curtains.
//
// The apron is a square annulus of extra ground beyond the boundary, built once
// and never streamed. Three things make it work:
//
//   · Its inner band is the interior heightfield MIRRORED across the boundary,
//     so ground, slope and surface materials cross the seam continuously and
//     the near field (which a camera can stand on) is real terrain rather than
//     a radial smear of edge texels. TerrainMaterial mirrors its data-texture
//     lookup the same way, so the shading agrees with the surface.
//   · Its outer band rises into a distant range. That is not decoration: the
//     haze cap is 0.76, so a *falling* skirt keeps a quarter of its own value
//     and its far edge stays a visible line on the sky forever. A crest higher
//     than any camera occludes everything behind it instead, and a pale hazy
//     range on the horizon is what the reference vista plate actually shows.
//   · Behind that crest the surface falls away hard, so the true outer edge is
//     geometrically unreachable from anywhere in the world.
const APRON_WIDTH = 4200;      // metres of ground beyond the boundary
const APRON_RINGS = 34;        // radial divisions, geometric from the seam
const APRON_PER_SIDE = 192;    // perimeter samples per world side (16 m pitch)
const APRON_SEGMENTS = 16;     // meshes the ring is split into, for culling
// Crest of the far range, and the one number that decides whether the horizon
// reads as a cozy valley or as the Himalayas.
//
// The floor is a sightline constraint, not a taste one: every camera must sit
// BELOW the crest, because then every ray that clears it is climbing and the
// ground behind it is unreachable at any distance. MEASURED, not assumed — the
// three vista cameras resolve to 153 m (peaks), 213 m (hero) and 210 m (dawn),
// and the highest ground in the world is 362 m, so 490 m is the floor with a
// third of it in hand. The minimum crest is 0.72 of this constant.
//
// The ceiling is taste, and two attempts got it wrong before this one. At
// 1180 m the range subtended 20 degrees at foreground contrast and dwarfed the
// world's own massifs — the hero frame stopped being a valley with mountains
// behind it and became mountains with a valley in front. At 870 m it was a
// blown-out white wall across the whole horizon. 680 m at 2.4 km is a band
// about five degrees high, which is what the reference vista plate carries.
const APRON_CREST = 700;

// Chunks at this LOD or coarser are batched into blocks.
//
// Batching can only ever *widen* a bounding volume, so it can only ever add a
// caster or a visible surface, never remove one — which is why it is safe to
// batch across the shadow-casting band as well. The band is still respected
// exactly: LOD 2 is the last casting band, so LOD-2 blocks cast and LOD-3+
// blocks do not, which is what the per-chunk rule said.
const BATCH_LOD = 2;
// Block edge in chunks, per band. LOD 2 still carries real detail and still
// casts shadows, so it batches in small 2x2 (192 m) blocks and stays cheap to
// rebuild and tight to cull; everything past it is 4x4 (384 m).
const BATCH_NEAR = 2;
const BATCH_FAR = 4;
// Metres the camera may travel before the wanted-set is recomputed. The LOD
// switch radii are 180 m and up, so a few metres of hysteresis is invisible;
// rescanning every frame cost a 2601-cell sweep and ~160 KB of garbage.
const RESCAN_DIST = 6;

// ── LOD switch radii ─────────────────────────────────────────────────────────
// WorldConfig ships [180, 380, 720, 1300]. Against a 96 m chunk and
// lodResolutions [64,32,16,8,4] that is 1.5 / 3 / 6 / 12 / 24 metres per vertex,
// so everything past 380 m is drawn at 6 m per vertex and everything past 720 m
// at 12 m. The erosion bake cuts benches and gullies at 10-40 m. A 12 m grid
// cannot represent a 10 m gully at all, and a 6 m grid halves it — which is why
// the massifs in hero, peaks and dawn arrived as smooth gradient masses no
// matter what the shader did with them, and why the crag geometry that reads
// correctly at 180-380 m washes out at 600-950 m.
//
// The heightfield-derived relief normal in TerrainMaterial puts that structure
// back into the *lighting* for free, and it does most of the work. This pushes
// the mesh out as well so the structure is in the silhouette and in the shadow
// map too, not only in the shading.
//
// MEASURED COST (32x32 chunks of 96 m, camera at world centre, whole map
// resident because viewDistance exceeds the half-diagonal):
//   [180, 380,  720, 1300]  0.388 M triangles   (shipped)
//   [180, 380,  900, 1500]  0.460 M             <- this
//   [240, 500,  900, 1500]  0.545 M
//   [280, 600, 1100, 1800]  0.780 M
//   [320, 700, 1300, 2100]  0.940 M
//
// Only the two far radii move. The near bands are the expensive ones per chunk
// and the near field was never the problem — 1.5 and 3 m per vertex already
// resolve everything, and past 110 m the relief normal covers it. Pushing LOD2
// from 720 m to 900 m is the whole visual win here, because that is the band
// the hero, peaks and dawn massifs sit in, and it costs +0.072 M triangles
// rather than the +0.157 M the four-radius version cost. The two larger options
// were costed and rejected: the game is already breaching the 4.5 M triangle
// cap in heavy views and a performance author is actively fixing it.
//
// MEASURED IN THE FRAME (tools/perf.mjs --seconds 45 --res 1536, this change
// alone, stashed A/B on the same working tree):
//   baseline  p50 29.6 ms  p95 63.6 ms  >50ms 184  >100ms 26  peak 3.54 M tris
//   +LOD+shdr p50 29.8 ms  p95 66.0 ms  >50ms 196  >100ms 30  peak 3.80 M tris
// The run fails its budget in both states — that is the pre-existing hitching
// the performance author is working on, not this change — and the delta this
// change adds is p50 +0.2 ms and peak +0.26 M triangles. Documented in
// docs/INTEGRATION_REQUESTS.md. If the triangle budget has to be clawed back,
// this constant is the single lever: setting it to TERRAIN.lodDistances returns
// every triangle, and the relief normal keeps most of the shading win.
//
// It also moves the shadow-casting band (castShadow = lod <= 2) from 720 m to
// 900 m. That is deliberate — distant massifs throwing shadows across the
// valley is a signature of the reference art — and it is ~67 K extra triangles
// per cascade, which is inside the noise of the numbers above.
const LOD_DISTANCES = [180, 380, 900, 1500];

// ── the waterline band is pinned to ONE LOD, and that is a correctness fix ───
//
// A critic measured, with the engine's clock frozen, that translating the
// camera five metres moved the terrain under the waterline: per-cell height
// drift p90 0.08 m at mouth/river/plunge, 0.35 m at hero and 0.47 m at drive,
// against exactly 0.00 for a static camera. Round 1 cut the waterline from the
// hydro texture, which is LOD-independent — so the water surface now stays
// still while the BANK rises and falls through it as you drive.
//
// Measured at the cause rather than at the symptom, with the mesh's own
// arithmetic (vertices at the chunk lattice, quads split by the same
// alternating diagonal _indexTemplate uses), over 4000 points within 3 m of the
// waterline, as the spread of the height the mesh would draw across the LODs
// that could be selected there:
//
//     LOD 0..0      p50 0.000   p90 0.000   p99 0.000   max 0.000   (the null)
//     LOD 0..1      p50 0.042   p90 0.158   p99 0.389   max 1.245
//     LOD 0..2      p50 0.178   p90 0.529   p99 1.114   max 4.146
//     LOD 0..3      p50 0.460   p90 1.301   p99 2.965   max 5.935
//
// A LOD-invariant RECONSTRUCTION was tried first and rejected on its own
// numbers. Resampling the field near the water onto a fixed world-aligned
// lattice that every LOD's vertices land on — 1.5, 3, 6, 12 and 24 all divide
// 6, and the chunk origin -1536 + cx*96 is a multiple of 6, so they all read
// the same corners — takes LOD 0..2 from p50 0.178 to 0.036 and p90 0.529 to
// 0.204. It does not reach zero, because the LODs still disagree about the
// twist term inside a cell. And it costs more than it buys: the ground itself
// moves p50 0.164 m and p90 0.518 m, which is the same magnitude as the drift
// being removed, and it moves away from world.getHeight — which is what the
// collider drives on. Trading a camera-dependent error for a permanent one of
// equal size is not a fix.
//
// Pinning is structural instead of statistical: inside this radius a chunk
// carrying a waterline is built at ONE resolution whatever the camera does, so
// the spread is the LOD 0..0 row — exactly zero, by construction, and it cannot
// regress under a test nobody has run yet.
//
// LOD 0 and not a coarser pin, for two reasons. It is the resolution those
// chunks already have for the whole near field, so nothing at all moves at the
// range the player looks at banks from; and it is world.getHeight sampled at
// 1.5 m against a 2 m bake, which is the one resolution that agrees with the
// collider. Pinning at LOD 1 would have been cheaper still — it takes triangles
// OFF the near field — but it moves every near bank by p50 0.042 / p90 0.158 m
// and desynchronises the mesh from the vehicle's ground.
//
// ── the radius, and what this actually costs ────────────────────────────────
//
// It is the LOD-2 switch, not the view distance, and the reason is the batcher:
// chunks at BATCH_LOD or coarser are merged into blocks, so pinning past 380 m
// would pull every distant water chunk out of its block and spend draw calls on
// ground where the residual step is already under a pixel.
//
// And this is NOT a narrowly targeted change, which is worth saying plainly
// because the name suggests it is. MEASURED: 949 of this map's 1024 chunks —
// 92.7% — carry a waterline within WATERLINE_PIN_REACH. Rivers thread the whole
// valley and a chunk is 96 m across, so at chunk granularity there is nothing
// to target. In practice this is "LOD 0 out to 380 m", and it costs what that
// costs: at hero, 1 066 380 triangles -> 1 296 780, +21.6%, with draw calls
// unchanged at 368. A 40 s drive A/B could not resolve a frame-time difference
// — p50 25.0 ms pinned against 26.1 ms unpinned, with peak triangles 6.57 M
// against 8.29 M on the same pair — because the run-to-run spread is larger
// than the effect and Engine's newly-reachable quality step rescales the LOD
// radii mid-run. Do not read those two numbers as this change being free; read
// them as this harness being unable to see it.
//
// Setting WATERLINE_PIN_RADIUS to 0 disables the whole thing in one constant,
// and that is the lever if the triangle budget has to be clawed back.
//
// WHAT IT DOES NOT FIX. Ring budget, p90 spread at the ring times the pixels a
// metre subtends there (900 px tall, 52 degree fov):
//     today   180 m 0.81 px   380 m 1.09 px   900 m 1.12 px   = 3.02
//     pinned                  380 m 1.24 px   900 m 1.12 px   = 2.36
// The near ring is gone and the 380 m ring is slightly worse because it is now
// a 0-to-2 step rather than a 1-to-2 step. That is a 22% cut, not a cure. The
// cure is to band-limit the field itself so that the drift per LOD step is
// small, and that belongs in WorldData.getHeight, where the collider, the
// scatterers and the camp props would all move with it — here it would only
// move the mesh and desynchronise it from everything standing on it.
//
// VERIFIED, not assumed: _scan's selection replayed over 1681 camera positions
// on a 5 m grid across a 200 m square at the map's densest water, 66 866
// chunk-camera pairs, 55 distinct chunks entering the radius. Chunks that took
// more than one LOD while inside it: 0.
const WATERLINE_PIN_LOD = 0;
// MEASURED DOWN from 380, on the pin's own ring budget rather than on taste.
//
// The author who added this reported it honestly as untargeted: 92.7% of chunks
// carry a waterline, so at 96 m granularity a 380 m radius is in practice "LOD 0
// out to 380 m", and it cost **+21.6% triangles at hero** — 1 066 380 to
// 1 296 780 — while the whole scene was already at p50 24.3 ms against a 16.7 ms
// budget. That is a bad trade on its face, and its own numbers say it is a bad
// trade on the detail too. Spread of the height the mesh draws, times the pixels
// a metre subtends at each ring:
//
//     unpinned    180 m 0.81 px   380 m 1.09 px   900 m 1.12 px   = 3.02
//     pinned 380                  380 m 1.24 px   900 m 1.12 px   = 2.36
//
// Read the 380 m column. Pinning to 380 removes the near ring and makes the
// 380 m ring WORSE, because the LOD step there becomes 0 -> 2 instead of 1 -> 2.
// The near ring is the one worth buying and the far ring is one the pin damages.
//
//     pinned 200                  380 m 1.09 px   900 m 1.12 px   = 2.21
//
// Better on the metric AND a fraction of the cost: a 200 m disc is about a fifth
// the area of a 380 m one. The far rings need the field itself band-limited,
// which belongs in WorldData.getHeight where the collider, the scatterers and
// the camp props would all move with it — filed rather than bodged here.
const WATERLINE_PIN_RADIUS = 200;
// Metres from the waterline a chunk must reach to count as carrying one. The
// damp margin TerrainMaterial draws is 0.9 m and the shore terms reach 2.8 m,
// so 12 m is comfortably past everything that is cut on the hydro field, with
// room for the bank above it that those bands are painted on.
const WATERLINE_PIN_REACH = 12;

// Per-tier scale on the LOD switch radii.
//
// Engine now steps the quality tier down on its own when the resolution scaler
// has been pinned at its floor and is still missing the frame target, so a tier
// has to actually shed work — and until now nothing in Terrain moved at all
// when it fired. Terrain is the largest single item in the frame: hiding it
// entirely was measured at -28% of frame time at the player's 1.06 MP
// (tools/_scratch/sceneab.mjs, 18 interleaved cycles), more than trees, the
// camper, grass, cover, rocks and water put together.
//
// The lever is the switch radii and not `viewDistance`. Shrinking the view
// distance takes distant massifs out of the world altogether and leaves a hole
// on the horizon that neither the apron nor the fog covers; pulling the radii in
// keeps every silhouette exactly where it is and simply draws it at fewer
// vertices, which also pushes more of the world past BATCH_LOD where it batches
// into blocks and costs draw calls as well as triangles. The terrain author's
// own note beside LOD_DISTANCES names this as the single lever for reclaiming
// triangles.
//
// ultra and high are 1.0 — the shipped look at those tiers is untouched.
const LOD_TIER_SCALE = { ultra: 1, high: 1, medium: 0.78, low: 0.60 };

export class Terrain {
  constructor(world, scene, opts = {}) {
    this.world = world;
    this.scene = scene;
    this.chunkSize = TERRAIN.chunkSize;
    this.chunksPerSide = Math.round(world.worldSize / this.chunkSize);
    this.viewDistance = opts.viewDistance ?? TERRAIN.viewDistance;
    // Terrain-local, see LOD_DISTANCES. Falls back to the shared config if a
    // caller passes its own schedule.
    this.lodDistances = opts.lodDistances ?? LOD_DISTANCES;

    this.material = createTerrainMaterial(world, {
      detailDistance: opts.detailDistance,
    });
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
    this._baseLod = this.lodDistances;
    this._lodScale = 1;
  }

  /**
   * Quality tier changed — re-scale the LOD switch radii. See LOD_TIER_SCALE.
   *
   * `main.js` wires this to `Engine.setQuality`, which now fires on its own when
   * the resolution scaler has run out of room. A no-op at ultra and high.
   *
   * The rescan is forced rather than applied directly: every chunk's wanted LOD
   * has changed, so the whole set has to be re-derived. It goes through the same
   * `_drain(budgetMs)` path as ordinary streaming, so the rebuild is spread over
   * frames at 3 ms each and a tier change does not itself become a hitch.
   */
  onQuality(preset, name) {
    const detail = this.material.userData.uniforms?.uDetailDistance;
    if (detail && Number.isFinite(preset?.terrainDetailDistance)) {
      detail.value = preset.terrainDetailDistance;
    }
    const s = LOD_TIER_SCALE[name] ?? 1;
    if (s === this._lodScale) return;
    this._lodScale = s;
    this.lodDistances = s === 1 ? this._baseLod : this._baseLod.map((d) => d * s);
    this._scanAt.set(Infinity, Infinity, Infinity);
    void preset;
  }

  key(cx, cz) { return cx * 4096 + cz; }
  blockKey(tier, bx, bz) { return tier * 0x400000 + bx * 4096 + bz; }
  blockSize(tier) { return tier === 0 ? BATCH_NEAR : BATCH_FAR; }

  lodForDistance(d) {
    const L = this.lodDistances;
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
  buildBlock(members, tier) {
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
    // Tier 0 is the LOD-2 band, which is inside the shadow-casting range; every
    // coarser tier is outside it. Same rule the per-chunk path applies.
    mesh.castShadow = tier === 0;
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

  /**
   * One bit per chunk: does this chunk carry a waterline, or ground close
   * enough to one to be painted by a band cut on the hydro field?
   *
   * Read from the hydro field's own signed distance rather than from the river
   * mask, for the same reason TerrainMaterial's margins are: the river mask is
   * a disc splatted round each channel station and the waterline is not, and
   * where the two disagree they disagree by metres. Built once, on first scan,
   * over the whole 4 m field — 590 k texels, a few milliseconds, and it never
   * changes because the bake does not.
   */
  _waterChunks() {
    if (this._waterChunkMap) return this._waterChunkMap;
    const N = this.chunksPerSide;
    const map = new Uint8Array(N * N);
    const h = this.world.hydro;
    if (h) {
      const HR = h.res, texel = h.texel, half = this.world.half, cs = this.chunkSize;
      for (let j = 0; j < HR; j++) {
        // Sample k represents (k + 0.25) texels from the corner, not (k + 0.5):
        // the hydro field is stored at half the bake's resolution by
        // area-averaging pairs. The same quarter-texel that TerrainMaterial and
        // WorldData.microDetail both carry, and getting it wrong here would
        // slide the whole map one chunk edge in each axis.
        const wz = (j + 0.25) * texel - half;
        const cz = Math.floor((wz + half) / cs);
        if (cz < 0 || cz >= N) continue;
        for (let i = 0; i < HR; i++) {
          if (h.sdf[j * HR + i] < -WATERLINE_PIN_REACH) continue;
          const wx = (i + 0.25) * texel - half;
          const cx = Math.floor((wx + half) / cs);
          if (cx < 0 || cx >= N) continue;
          map[cz * N + cx] = 1;
        }
      }
    }
    this._waterChunkMap = map;
    return map;
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
    if (!this.apron) this.buildApron();
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
        let lod = this.lodForDistance(d);
        // See WATERLINE_PIN_LOD. Chunks carrying a waterline are pinned so the
        // ground under the water's edge cannot move when the camera does.
        if (lod > WATERLINE_PIN_LOD && d < WATERLINE_PIN_RADIUS
            && this._waterChunks()[cz * N + cx]) lod = WATERLINE_PIN_LOD;

        if (lod >= BATCH_LOD) {
          const tier = lod === BATCH_LOD ? 0 : 1;
          const B = this.blockSize(tier);
          const bx = Math.floor(cx / B), bz = Math.floor(cz / B);
          const bk = this.blockKey(tier, bx, bz);
          let b = wantedBlocks.get(bk);
          if (!b) {
            b = { members: this._blockPool.pop() ?? [], sig: 0, d, bx, bz, tier };
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
      if (!existing || existing.sig !== b.sig) this._buildQueue.push(1, b.bx, b.bz, b.tier, b.d, bk);
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
        const mesh = this.buildBlock(want.members, want.tier);
        const prev = this.blocks.get(key);
        if (prev) { this.group.remove(prev.mesh); prev.mesh.geometry.dispose(); }
        this.group.add(mesh);
        this.blocks.set(key, { mesh, sig: want.sig, bx: want.bx, bz: want.bz, tier: want.tier });
      }
    }
    // Keep the tail for the next frame instead of rebuilding the whole queue.
    if (i >= q.length) q.length = 0;
    else q.copyWithin(0, i), q.length -= i;
  }

  // ── World-edge apron ───────────────────────────────────────────────────────

  /** Reflect a world coordinate back inside the map. Continuous in value and
   *  in first derivative at the boundary, which is what keeps the seam invisible. */
  _mirror(v) {
    const H = this.world.half;
    // Clamped to a SINGLE reflection. The apron is wider than the map, so a
    // naive reflection runs off the far side and lands back outside; the
    // shader's matching mirror has the same one-fold range, and the two have to
    // agree texel for texel or the far apron is lit for a surface it is not.
    if (v > H) return Math.max(-H, 2 * H - v);
    if (v < -H) return Math.min(H, -2 * H - v);
    return v;
  }

  /**
   * Apron surface height at a world point outside the boundary.
   *
   * `s` runs 0 at the seam to 1 at the outer edge. The profile is three things
   * added: the mirrored interior (dominant at the seam, gone by ~1.4 km out), a
   * gentle outward fall that stops the mirror reading as one ruler-straight
   * ridge running the full length of the boundary, and the far range.
   */
  _apronHeight(x, z) {
    const H = this.world.half;
    const d = Math.max(0, Math.max(Math.abs(x), Math.abs(z)) - H);
    const s = clamp01(d / APRON_WIDTH);
    const n = this._apronNoise;

    const mt = this.world.getHeight(this._mirror(x), this._mirror(z));

    // Two ranges rather than one, at 2200 m and 900 m, and the ridge transfer
    // is deliberately BLUNT (sharpness 0.62, half its weight in a billow). At
    // 1.15 the silhouette came back as a row of near-identical shark teeth,
    // which is what a sharpened ridged fractal always gives when every crest is
    // clipped to the same height by the same profile. Fat shoulders and round
    // summits are also what the reference plate's far field is made of.
    const w1 = n.ridged(x * 0.00045, z * 0.00045, 4, 2.04, 0.48, 1, 0.62);
    const w2 = n.billow(x * 0.0011 + 8.3, z * 0.0011 - 5.1, 3, 2.1, 0.45, 1) * 0.5 + 0.5;
    const w3 = n.fbm(x * 0.0026 - 21.4, z * 0.0026 + 13.7, 3, 2.1, 0.42, 1) * 0.5 + 0.5;
    const wall = clamp01(w1 * 0.50 + w2 * 0.32 + w3 * 0.18);

    // Rises from the seam, tops out at ~0.62 of the width (2.6 km out), then
    // falls away behind its own crest.
    // THE CREST MUST NOT SIT AT ONE DISTANCE. With `shape` a function of s
    // alone the only thing that varied along the range was its height, by 28%,
    // and the result was a flat-topped wall with a nearly straight top edge
    // running the whole width of the hero frame — a mesa, not a range. Letting
    // the profile advance and recede by up to 550 m puts ridges in front of
    // other ridges, which is the layering the reference vista is built from and
    // the only reason a far field reads as deep rather than as a backdrop.
    const sOff = n.fbm(x * 0.00035 + 3.7, z * 0.00035 - 9.1, 2, 2.0, 0.5, 1) * 0.13;
    const shape = smoothstep(0.24 + sOff, 0.58 + sOff, s)
                * (1 - smoothstep(0.70 + sOff, 0.90 + sOff, s));
    // 420-826 m. The floor still clears the highest camera (213 m) by 200 m, so
    // widening the spread costs no sightline and buys a real skyline.
    const crest = (0.60 + 0.58 * wall) * APRON_CREST;

    // Foothills at 260 m and 110 m. Without them the mid apron — the band a
    // vista camera looks straight at, 300 m to 1.5 km beyond the boundary — is
    // the difference of two fields a kilometre wide and reads as one smooth
    // waxy ramp filling a third of the frame. This is the only structure out
    // there once the mirrored interior has faded.
    const detail = (n.ridged(x * 0.0038, z * 0.0038, 3, 2.1, 0.45, 1, 0.8) - 0.38) * 62.0
                 + n.fbm(x * 0.0092, z * 0.0092, 3, 2.1, 0.42, 1) * 24.0;

    // The mirrored interior is the near band's material: real ground, real
    // slope, real surface colour, continuous across the seam. It is held to
    // 18% by ~1.9 km out, past which the reflection would be a recognisable
    // second copy of the valley rather than a continuation of its rim.
    let y = mt * (1 - smoothstep(0.04, 0.46, s) * 0.82)
          - smoothstep(0.0, 0.14, s) * 52.0
          + detail * smoothstep(0.03, 0.30, s) * (1.0 - smoothstep(0.52, 0.86, s) * 0.60)
          + crest * shape;
    // Behind the crest, out of every sightline in the game.
    y -= smoothstep(0.80, 1.0, s) * 900.0;
    return y;
  }

  /**
   * Build the apron once. One mesh per perimeter segment so frustum culling
   * still works — the whole ring as a single object would be drawn from the
   * middle of the map with none of it on screen.
   */
  buildApron() {
    if (this.apron) return;
    this._apronNoise = new NoiseField(SEED ^ 0x5ed6e1);
    const H = this.world.half;
    const group = new THREE.Group();
    group.name = 'TerrainApron';

    const P = APRON_PER_SIDE * 4;               // perimeter samples, wrapping
    const perSeg = P / APRON_SEGMENTS;
    // Radial spacing is GEOMETRIC, not a power of the parameter: 10 m at the
    // seam growing 13% a ring. A power law spends most of its rings in the last
    // kilometre, where everything is haze, and leaves 60-70 m steps at 500 m
    // out, where a vista camera can still resolve them.
    const dist = new Float32Array(APRON_RINGS + 1);
    {
      let step = 10.0, d = 0;
      for (let j = 0; j <= APRON_RINGS; j++) { dist[j] = d; d += step; step *= 1.13; }
      const k = APRON_WIDTH / dist[APRON_RINGS];
      for (let j = 0; j <= APRON_RINGS; j++) dist[j] *= k;
    }

    // Boundary point for perimeter index i (0..P), walking the square.
    const bx = new Float32Array(P + 1), bz = new Float32Array(P + 1);
    for (let i = 0; i <= P; i++) {
      const side = Math.min(3, Math.floor(i / APRON_PER_SIDE));
      const u = (i - side * APRON_PER_SIDE) / APRON_PER_SIDE;
      if (side === 0) { bx[i] = -H + u * 2 * H; bz[i] = -H; }
      else if (side === 1) { bx[i] = H; bz[i] = -H + u * 2 * H; }
      else if (side === 2) { bx[i] = H - u * 2 * H; bz[i] = H; }
      else { bx[i] = -H; bz[i] = H - u * 2 * H; }
    }

    const rows = APRON_RINGS + 2;               // skirt row + ring rows
    const nrm = new THREE.Vector3();
    let tris = 0;

    for (let seg = 0; seg < APRON_SEGMENTS; seg++) {
      const i0 = seg * perSeg;
      const cols = perSeg + 1;
      const positions = new Float32Array(cols * rows * 3);
      const normals = new Float32Array(cols * rows * 3);
      const uvs = new Float32Array(cols * rows * 2);

      for (let c = 0; c < cols; c++) {
        const i = i0 + c;
        for (let r = 0; r < rows; r++) {
          const j = Math.max(0, r - 1);         // r 0 and 1 share the seam ring
          const scale = (H + dist[j]) / H;
          const x = bx[i] * scale, z = bz[i] * scale;
          let y = j === 0 ? this.world.getHeight(x, z) : this._apronHeight(x, z);
          if (r === 0) y -= 40.0;               // seam skirt

          const o = (r * cols + c);
          positions[o * 3] = x; positions[o * 3 + 1] = y; positions[o * 3 + 2] = z;
          uvs[o * 2] = c / perSeg; uvs[o * 2 + 1] = j / APRON_RINGS;
        }
      }

      // Normals from finite differences on the built grid. Cheap and exact for
      // this surface, and it needs no second pass over the height function.
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          const o = r * cols + c;
          const cL = Math.max(0, c - 1), cR = Math.min(cols - 1, c + 1);
          const rD = Math.max(1, r - 1), rU = Math.min(rows - 1, r + 1);
          const aL = (r * cols + cL) * 3, aR = (r * cols + cR) * 3;
          const aD = (rD * cols + c) * 3, aU = (rU * cols + c) * 3;
          const ex = positions[aR] - positions[aL], ez = positions[aR + 2] - positions[aL + 2];
          const ey = positions[aR + 1] - positions[aL + 1];
          const fx = positions[aU] - positions[aD], fz = positions[aU + 2] - positions[aD + 2];
          const fy = positions[aU + 1] - positions[aD + 1];
          nrm.set(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx);
          if (nrm.lengthSq() < 1e-12) nrm.set(0, 1, 0); else nrm.normalize();
          if (nrm.y < 0) nrm.negate();
          normals[o * 3] = nrm.x; normals[o * 3 + 1] = nrm.y; normals[o * 3 + 2] = nrm.z;
        }
      }

      const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
      let p = 0;
      for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const a = r * cols + c, b = a + 1, e = a + cols, f = e + 1;
          // Wound so the outward-facing side is front — the ring is built with
          // +r pointing away from the map, so this is the mirror of the chunk
          // grid's winding.
          idx[p++] = a; idx[p++] = b; idx[p++] = e;
          idx[p++] = b; idx[p++] = f; idx[p++] = e;
        }
      }
      tris += idx.length / 3;

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geom.setIndex(new THREE.BufferAttribute(idx, 1));
      geom.computeBoundingSphere();
      geom.computeBoundingBox();

      const mesh = new THREE.Mesh(geom, this.material);
      // Never a caster and never a receiver: it is outside the cascade extent
      // and putting a 1.1 km range into the shadow map would spend the whole
      // texel budget on ground the player can never reach.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
    }

    this.apron = group;
    this.apronTriangles = tris;
    this.scene.add(group);
  }

  setSunDir(v) {
    this.material.userData.uniforms.uSunDir.value.copy(v);
  }

  setTime(t) {
    this.material.userData.uniforms.uTime.value = t;
  }

  dispose() {
    if (this.apron) {
      for (const m of this.apron.children) m.geometry.dispose();
      this.scene.remove(this.apron);
      this.apron = null;
    }
    for (const [, c] of this.chunks) c.mesh.geometry.dispose();
    for (const [, b] of this.blocks) b.mesh.geometry.dispose();
    this.chunks.clear();
    this.blocks.clear();
    this.material.dispose();
    this.scene.remove(this.group);
  }
}
