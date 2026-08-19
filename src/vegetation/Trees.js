// ─────────────────────────────────────────────────────────────────────────────
//  Trees — the signature of the game's look.
//
//  Structure:
//    · five species × N deterministic variants are grown once at load into
//      geometry prototypes (bark tubes + leaf-clump billboards)
//    · every tree in the 3 km world is placed once at load into flat typed
//      arrays, bucketed into a 64 m grid
//    · each frame the buckets near the camera are binned into three LODs and
//      written straight into InstancedMesh buffers — near geometry, reduced
//      geometry, and a baked impostor card beyond that
//
//  Placement is deliberately *not* an even Poisson scatter. A moisture-driven
//  density field is multiplied by a low-frequency grove field, so the world
//  gets closed stands, open clearings, ragged forest edges and the occasional
//  lone sentinel in the meadow — which is what the reference plates show.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { NoiseField } from '../core/Noise.js';
import { SEED, VEG } from '../world/WorldConfig.js';
import { clamp, clamp01, lerp, smoothstep, mulberry32 } from '../core/MathUtils.js';
import { SPECIES, growTree } from './tree_species.js';
import { buildClusterAtlas } from './tree_textures.js';
import { buildBarkGeometry, buildLeafGeometry, buildImpostorGeometry } from './tree_geometry.js';
import {
  makeSharedUniforms, createLeafMaterial, createBarkMaterial, createImpostorMaterial,
} from './tree_material.js';

const CFG = {
  // Five prototypes per species, not three. Three is what produced the "12+
  // near-identical conifer silhouettes in a single view" the critic counted:
  // per-instance yaw and scale cannot hide a repeated crown outline, only a
  // different crown can. Five near slots per species is 50 near meshes plus 30
  // mid and one impostor — 81 draw calls at the absolute worst against a tree
  // budget of 120, and it costs no extra triangles because the same trees are
  // simply spread over more prototypes.
  variants: 5,           // prototypes per species
  // Two mid prototypes, not three. Crown-shape repetition is a near-field tell:
  // past 96 m a spruce is forty pixels wide and its outline is carried by the
  // stand, not by the individual. Spending the extra draw calls there buys
  // nothing visible and this system has to stay inside 120.
  midVariants: 2,        // how many of them survive into the mid LOD

  // 84 m, down from 96. The near LOD carries three times the leaf cards of the
  // mid one *and* it is the only foliage that casts, so every near instance is
  // paid for twice — once in the shadow pass and once in the main pass, both
  // as double-sided alpha-tested quads. Shrinking the radius by an eighth drops
  // near instances by a quarter (area, not radius) and it is the cheapest
  // frame-time this system has to give: at 84 m a crown is still 80 px across
  // and the mid prototype it hands over to is the same tree.
  nearDist: 84,          // full geometry
  midDist: 255,          // reduced geometry
  farDist: 1000,         // impostor card; past this, nothing (fog owns it)

  bucket: 64,            // spatial bucket size, metres
  rebuildMove: 11,       // camera travel that forces a re-bin, metres

  capNear: 700,          // instance cap per species-variant
  capMid: 1500,
  capFar: 30000,

  impostorTileW: 192,
  impostorTileH: 288,
  // Distinct impostor silhouettes baked per species. One tile per species meant
  // every spruce past 255 m was literally the same outline pasted across a
  // hillside — the "hundreds of same-size cones" the critic counted are mostly
  // this, not the scatter. Two tiles doubles the far-field silhouette vocabulary
  // for one extra bake each and no runtime cost at all: the atlas is still one
  // texture and the far field is still one draw call.
  impVariants: 2,
};

// Instances of the far impostor block uploaded per frame. At 120 bytes an
// instance (mat4 + three colours + impostor params + wind) this is ~490 kB a
// frame against the 1.9 MB the whole block used to cost on a single re-bin
// frame; a typical block of ~15 000 instances therefore lands over four frames.
// See _commitFar for why that is invisible.
const FAR_UPLOAD_CHUNK = 4096;

// Per-tier scale on the near and mid LOD radii.
//
// Engine now drops the quality tier by itself once the resolution scaler is
// pinned at its floor and still missing the frame target, so a tier has to shed
// real work. Trees measured at -8.2% of frame time at the player's 1.06 MP when
// hidden entirely (tools/_scratch/sceneab.mjs), and almost all of that is the
// near band: a near crown carries three times the leaf cards of a mid one and it
// is the only foliage that casts, so every near instance is paid for twice.
// Pulling the two inner radii in moves instances down a band; it does not remove
// a single tree from the world.
//
// `farDist` is deliberately NOT scaled. The impostor material bakes its fade
// range from CFG.farDist at build time, so shrinking it at runtime would make
// the far field end at a hard edge instead of fading into the haze.
//
// ultra and high are 1.0 — the shipped look at those tiers is untouched.
const LOD_TIER_SCALE = { ultra: 1, high: 1, medium: 0.76, low: 0.55 };


// VEG.treeDensity is the per-hectare figure the whole game shares; trees want a
// closed canopy in the groves, so they scale it up rather than redefining it.
const DENSITY_MUL = 3.9;

// Far-field thinning.
//
// This used to be a hard threshold on tree size: past 820 m only trees above
// 0.72 scale survived at all. That is *why* every distant hillside came back as
// hundreds of identically-sized cones — the cull was selecting a narrow slice
// out of the middle of the size distribution and throwing the rest away, so the
// surviving population genuinely had no size hierarchy left in it. A hard cut
// also pops: a tree crosses one metre and appears.
//
// Instead, thin with a *probability* that ramps across a size window which
// widens with distance. Every big tree still survives at every range (so the
// stand keeps its structure and its ridge line), mid trees thin out gradually,
// and saplings fade out first. The draw is deterministic per tree — keyed off
// its own stored phase — so a tree does not flicker in and out as the camera
// moves, and the same world always thins the same way.
//
// lo = size below which a tree is certainly dropped, hi = size above which it
// is certainly kept.
function thinWindow(d) {
  if (d < 300) return null;                 // keep everything
  if (d < 560) return [0.00, 0.30];         // saplings only
  if (d < 820) return [0.18, 0.62];
  return [0.32, 0.96];
}

export class Trees extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Trees';
    this.loadLabel = 'Planting the valley';
    this.group = new THREE.Group();
    this.group.name = 'Trees';

    this.noise = new NoiseField(SEED ^ 0x7a3f10);
    this.shared = makeSharedUniforms();

    this._lastRebuildPos = new THREE.Vector3(1e9, 0, 1e9);
    // Far-block upload cursor — see _commitFar.
    this._farTarget = 0;
    this._farCursor = 0;
    this._farFilled = 0;
    this._lodScale = 1;
    this._windAngle = 0.7;
    this._tmpSphere = new THREE.Sphere();
    this.stats = { near: 0, mid: 0, far: 0, buildMs: 0 };
  }

  async init() {
    const { scene, preset } = this.ctx;
    this.treeMul = preset?.treeMul ?? 1;

    // 448 texels a tile, not 256. A leaf dab on a hero tree is over a metre
    // across, so when the camera comes within a few metres of a crown the tile
    // is magnified five to ten times and its marks stop reading as crisp brush
    // strokes and start reading as soft overlapping cellophane ellipses — which
    // is what the `waterfall` anchor catches whenever a big tree stands near it.
    // The atlas is one texture shared by every tree in the game, so this is 3 MB
    // for a defect that shows on the closest, most-looked-at foliage.
    this.atlas = buildClusterAtlas(SEED & 0xffff, 448);
    this.atlasTexels = 896;
    this._buildPrototypes();
    this._buildMaterials();
    this._buildMeshes();
    this._bakeImpostors();
    this._buildPlacement();

    scene.add(this.group);
  }

  // ── prototypes ─────────────────────────────────────────────────────────────

  _buildPrototypes() {
    this.protos = [];
    for (let si = 0; si < SPECIES.length; si++) {
      const sp = SPECIES[si];
      const variants = [];
      for (let vi = 0; vi < CFG.variants; vi++) {
        const tree = growTree(sp, (SEED ^ 0x51ed) + si * 7919 + vi * 104729);
        // Extent of the *drawn* silhouette, not the skeleton — the impostor
        // card and the placement spacing both key off this.
        let halfW = 0.4, top = tree.height;
        for (const c of tree.clusters) {
          halfW = Math.max(halfW, Math.hypot(c.x, c.z) + c.sx);
          top = Math.max(top, c.y + c.sy);
        }
        variants.push({
          tree,
          height: top,
          halfWidth: halfW,
          near: {
            bark: buildBarkGeometry(tree, sp, { radialSegs: 4, maxLevel: 2 }),
            leaf: buildLeafGeometry(tree, { keep: 1 }),
          },
          mid: vi < CFG.midVariants ? {
            bark: buildBarkGeometry(tree, sp, { radialSegs: 3, maxLevel: 0, leaderBonus: 0 }),
            // Every third clump, not every second. Mid instances outnumber near
            // ones four to one, so their leaf quads are the single biggest
            // triangle line item in the game's largest triangle consumer. The
            // survivors are grown by sqrt(keep) so the crown's silhouette area
            // is held, and at 96-255 m the loss of mark *count* is not visible —
            // a crown is forty pixels wide there and it is the mass, not the
            // individual mark, that the eye is reading.
            // Every fourth clump, not every third. The size-hierarchy field
            // added this round puts genuinely large trees close to the camera
            // where before the population was mush in the middle, and that took
            // the whole-game triangle peak from 4.16 M to 4.36 M against a
            // 4.5 M cap — too little headroom for a system that is already the
            // largest consumer. Mid instances outnumber near ones four to one,
            // so this is where the cheap triangles are, and at 84-255 m a crown
            // is forty pixels across: the survivors are grown by sqrt(keep) so
            // the silhouette area is held and the loss of mark *count* is not
            // resolvable at that range.
            leaf: buildLeafGeometry(tree, { keep: 4, sizeBoost: 0.86 }),
          } : null,
        });
      }
      this.protos.push(variants);
    }
  }


  _buildMaterials() {
    const texels = this.atlasTexels;
    this.leafNear = createLeafMaterial(this.atlas, this.shared, { alphaTest: 0.40, atlasTexels: texels });
    // A lower cutout at distance compensates for mip-chain alpha erosion, which
    // otherwise makes mid-LOD crowns visibly thin out as you back away.
    this.leafMid = createLeafMaterial(this.atlas, this.shared, { alphaTest: 0.26, atlasTexels: texels });
    this.bark = createBarkMaterial(this.shared);
    this.leafBake = createLeafMaterial(this.atlas, this.shared, { alphaTest: 0.40, bake: true, atlasTexels: texels });
    this.barkBake = createBarkMaterial(this.shared, { bake: true });
    // Impostor material is created later in _bakeImpostors; it appends itself.
    this._fogMats = [this.leafNear.mat, this.leafMid.mat, this.bark.mat];
  }

  // ── instanced meshes ───────────────────────────────────────────────────────

  /** One instance-attribute block, shared by the bark and leaf mesh of a slot. */
  _makeSlot(cap, withImpostorAttrs = false) {
    const s = {
      cap,
      count: 0,
      matrix: new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16),
      colA: new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3),
      colB: new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3),
      wind: new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2),
      barkCol: new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3),
      minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0,
    };
    s.matrix.setUsage(THREE.DynamicDrawUsage);
    for (const k of ['colA', 'colB', 'wind', 'barkCol']) s[k].setUsage(THREE.DynamicDrawUsage);
    if (withImpostorAttrs) {
      s.colC = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      s.imp = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      s.colC.setUsage(THREE.DynamicDrawUsage);
      s.imp.setUsage(THREE.DynamicDrawUsage);
    }
    return s;
  }

  _buildMeshes() {
    this.slots = { near: [], mid: [] };
    this.meshes = [];

    for (let si = 0; si < SPECIES.length; si++) {
      for (let vi = 0; vi < CFG.variants; vi++) {
        const p = this.protos[si][vi];

        const nSlot = this._makeSlot(Math.ceil(CFG.capNear * this.treeMul));
        this._attachNear(p.near, nSlot, this.leafNear, 'near');
        this.slots.near.push(nSlot);

        if (p.mid) {
          const mSlot = this._makeSlot(Math.ceil(CFG.capMid * this.treeMul));
          this._attachNear(p.mid, mSlot, this.leafMid, 'mid');
          this.slots.mid.push(mSlot);
        } else {
          this.slots.mid.push(null);
        }
      }
    }

    // ── impostors: one draw call for the entire far field ────────────────────
    this.farSlot = this._makeSlot(Math.ceil(CFG.capFar * this.treeMul), true);
  }

  /** Build the bark + leaf InstancedMesh pair that share one instance block. */
  _attachNear(geoms, slot, leafMat, kind) {
    const barkGeom = geoms.bark;
    const leafGeom = geoms.leaf;

    barkGeom.setAttribute('aColA', slot.barkCol);
    barkGeom.setAttribute('aWind', slot.wind);
    leafGeom.setAttribute('aColA', slot.colA);
    leafGeom.setAttribute('aColB', slot.colB);
    leafGeom.setAttribute('aWind', slot.wind);

    const barkMesh = new THREE.InstancedMesh(barkGeom, this.bark.mat, slot.cap);
    barkMesh.instanceMatrix = slot.matrix;
    barkMesh.customDepthMaterial = this.bark.depth;

    const leafMesh = new THREE.InstancedMesh(leafGeom, leafMat.mat, slot.cap);
    leafMesh.instanceMatrix = slot.matrix;
    leafMesh.customDepthMaterial = leafMat.depth;

    // Mid-LOD *leaves* do not cast. This is by far the largest single cost in
    // the whole system: a mid crown is ~140 alpha-tested double-sided cards, the
    // billboards turn to face the light in the shadow pass so every one of them
    // presents its full disc, and with ~1700 mid instances on screen that is a
    // quarter of a million discarded-fragment quads rasterised into the shadow
    // map every frame. Measured in the river view it costs 35 fps on its own —
    // half the frame rate of the entire game — to shadow trees that are 90 to
    // 255 m away, whose crowns mostly shadow other crowns. Mid *trunks* still
    // cast, so a distant stand is still anchored to the ground, and everything
    // inside 96 m casts in full.
    leafMesh.castShadow = kind === 'near';
    barkMesh.castShadow = true;
    for (const m of [barkMesh, leafMesh]) {
      m.count = 0;
      m.receiveShadow = true;
      m.frustumCulled = true;
      m.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.group.add(m);
      this.meshes.push(m);
    }
    slot.meshes = [barkMesh, leafMesh];
    slot.kind = kind;
  }

  // ── impostor bake ──────────────────────────────────────────────────────────

  /**
   * Render each species' mid-LOD prototype flat-on into an atlas strip. The
   * bake stores palette *weights* rather than colour (see tree_material.js), so
   * one card serves every colour variation of that species.
   */
  _bakeImpostors() {
    const renderer = this.ctx.renderer;
    const N = SPECIES.length;
    const IV = CFG.impVariants;
    const TILES = N * IV;
    const W = CFG.impostorTileW, H = CFG.impostorTileH;

    const rt = new THREE.WebGLRenderTarget(W * TILES, H, {
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: true,
    });
    rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;

    const bakeScene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 400);
    const identity = new THREE.Matrix4();

    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    // Drive the viewport through the render target rather than the renderer:
    // `render()` re-applies the target's own viewport/scissor, so setting it on
    // the renderer would be silently overwritten between tiles.
    rt.scissorTest = true;

    this.impostorDims = [];

    for (let ti = 0; ti < TILES; ti++) {
      const si = (ti / IV) | 0, vi = ti % IV;
      const p = this.protos[si][vi];
      const src = p.mid ?? p.near;
      bakeScene.clear();

      const mk = (geom, mat) => {
        const g = geom.clone();
        // Neutral instance data: the bake encodes weights, not colour.
        const one = new THREE.InstancedBufferAttribute(new Float32Array([1, 1, 1]), 3);
        g.setAttribute('aColA', one);
        g.setAttribute('aColB', one);
        g.setAttribute('aWind', new THREE.InstancedBufferAttribute(new Float32Array([0, 0]), 2));
        const m = new THREE.InstancedMesh(g, mat, 1);
        m.setMatrixAt(0, identity);
        m.frustumCulled = false;
        bakeScene.add(m);
        return m;
      };
      const a = mk(src.bark, this.barkBake.mat);
      const b = mk(src.leaf, this.leafBake.mat);

      const halfW = p.halfWidth * 1.06;
      const top = p.height * 1.02;
      cam.left = -halfW; cam.right = halfW;
      cam.top = top; cam.bottom = 0;
      cam.position.set(0, 0, 200);
      cam.lookAt(0, 0, 0);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();

      rt.viewport.set(ti * W, 0, W, H);
      rt.scissor.set(ti * W, 0, W, H);
      renderer.setRenderTarget(rt);
      renderer.render(bakeScene, cam);

      this.impostorDims.push({ halfWidth: halfW, height: top });
      a.geometry.dispose(); b.geometry.dispose();
    }

    rt.scissorTest = false;
    rt.viewport.set(0, 0, W * TILES, H);
    rt.scissor.set(0, 0, W * TILES, H);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);

    this.impostorTex = rt.texture;
    this._impostorRT = rt;

    this.impostorMat = createImpostorMaterial(
      this.impostorTex, this.shared, TILES, [CFG.farDist * 0.80, CFG.farDist], W * TILES);
    this._fogMats.push(this.impostorMat.mat);

    const geom = buildImpostorGeometry();
    geom.setAttribute('aColA', this.farSlot.colA);
    geom.setAttribute('aColB', this.farSlot.colB);
    geom.setAttribute('aColC', this.farSlot.colC);
    geom.setAttribute('aImp', this.farSlot.imp);
    geom.setAttribute('aWind', this.farSlot.wind);

    const mesh = new THREE.InstancedMesh(geom, this.impostorMat.mat, this.farSlot.cap);
    mesh.instanceMatrix = this.farSlot.matrix;
    mesh.count = 0;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;    // one cheap draw call; culling it costs more
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.farSlot.meshes = [mesh];
    this.farMesh = mesh;
  }

  // ── placement ──────────────────────────────────────────────────────────────

  /**
   * A 12 m density field, then stratified sampling inside it with a spacing
   * grid. Density is the product of an environmental term (moisture, slope,
   * altitude, water) and a grove term, which is what produces edges and
   * clearings rather than a uniform speckle.
   */
  _buildPlacement() {
    const t0 = performance.now();
    const W = this.ctx.world;
    const half = W.half;
    const size = W.worldSize;
    const N = this.noise;

    const DF = 256;
    const dfStep = size / DF;
    const density = new Float32Array(DF * DF);
    const sppBias = new Float32Array(DF * DF * SPECIES.length);

    for (let j = 0; j < DF; j++) {
      const z = -half + (j + 0.5) * dfStep;
      for (let i = 0; i < DF; i++) {
        const x = -half + (i + 0.5) * dfStep;
        const idx = j * DF + i;

        const depth = W.getWaterDepth(x, z);
        if (depth > 0.02) { density[idx] = 0; continue; }
        const h = W.getHeight(x, z);
        const slope = W.getSlope(x, z);
        const m = W.getMoisture(x, z);
        const river = W.getRiver(x, z);

        const slopeLim = 1 - smoothstep(0.62, 1.10, slope);
        const treeLine = 1 - smoothstep(196, 258, h);
        const wet = smoothstep(0.20, 0.66, m);

        // Groves: a large-scale field thresholded hard, so the map has closed
        // canopy in some places and open gold meadow in others.
        const grove = N.fbm(x * 0.0055, z * 0.0055, 3, 2.1, 0.5, 1) * 0.5 + 0.5;
        const detail = N.fbm(x * 0.021, z * 0.021, 2, 2.3, 0.5, 1) * 0.5 + 0.5;
        const g = smoothstep(0.34, 0.70, grove * 0.66 + detail * 0.34 + wet * 0.30 - 0.10);

        let d = (0.10 + 0.90 * wet) * g;
        // Riverbanks are lined with trees whatever the grove field says — but
        // *ragged*. A flat threshold on the river field draws a constant-width
        // hedge down both banks, which is precisely the "evenly-spaced identical
        // lollipop trees along shorelines" the critic photographed. Modulating
        // the bank density by the 48 m detail field breaks it into thickets,
        // gaps and the occasional lone tree standing out over the water.
        d = Math.max(d, smoothstep(0.05, 0.45, river) * lerp(0.10, 1.30, detail));
        // Lone sentinels: a thin floor everywhere drivable keeps the meadows
        // from being empty, and gives the long raking shadows something to cast.
        d = Math.max(d, 0.055 * slopeLim * treeLine);
        // Clumping at grove scale (~28 m). Density fields this smooth still put
        // trees down at a near-constant rate inside a stand, and a constant rate
        // is what the eye reads as a polka dot of cones. Multiplying by a
        // sharpened mid-frequency field gives thickets you cannot see through
        // next to clearings you can, which is what every reference plate shows.
        const clump = N.fbm(x * 0.036 + 91.7, z * 0.036 - 43.1, 2, 2.4, 0.5, 1) * 0.5 + 0.5;
        d *= lerp(0.46, 1.74, clump * clump * (3 - 2 * clump));
        d *= slopeLim * treeLine;

        density[idx] = clamp01(d) * VEG.treeDensity * DENSITY_MUL * this.treeMul;

        // Species preference, smooth over ~100 m so stands read as stands.
        for (let s = 0; s < SPECIES.length; s++) {
          sppBias[idx * SPECIES.length + s] =
            N.fbm(x * 0.0095 + s * 137.1, z * 0.0095 + s * 71.3, 2, 2.0, 0.5, 1) * 0.5 + 0.5;
        }
      }
    }

    // ── keep-out mask along the dirt tracks ──────────────────────────────────
    // A cozy driving game whose roads have trees growing down the middle is not
    // a driving game. Stamping the polylines into a coarse bitmask once is far
    // cheaper than testing every candidate against every road segment.
    const RM = 4;                                   // metres per mask cell
    const RW = Math.ceil(size / RM);
    const roadMask = new Uint8Array(RW * RW);
    const stamp = (x, z, r) => {
      const gx = ((x + half) / RM) | 0, gz = ((z + half) / RM) | 0;
      const R = Math.ceil(r / RM);
      for (let j = -R; j <= R; j++) {
        const zz = gz + j; if (zz < 0 || zz >= RW) continue;
        for (let i = -R; i <= R; i++) {
          const xx = gx + i; if (xx < 0 || xx >= RW) continue;
          if (i * i + j * j <= R * R) roadMask[zz * RW + xx] = 1;
        }
      }
    };
    for (const road of (W.roads ?? [])) {
      for (let i = 0; i < road.length - 1; i++) {
        const a = road[i], b = road[i + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const steps = Math.max(1, Math.ceil(len / RM));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          // Just wide enough to keep the track drivable. The reference plates
          // have trees crowding right up to the verge; a 13 m clear corridor
          // reads as a fire break, not as a cozy dirt road.
          stamp(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, 4.5);
        }
      }
    }

    // ── stratified sampling ──────────────────────────────────────────────────
    const rng = mulberry32(SEED ^ 0x1eaf);
    const cellArea = dfStep * dfStep;
    const OCC = 4;                                     // spacing grid, metres
    const OW = Math.ceil(size / OCC);
    const occ = new Int32Array(OW * OW).fill(-1);

    const cap = 120000;
    const px = new Float32Array(cap), py = new Float32Array(cap), pz = new Float32Array(cap);
    const pscale = new Float32Array(cap), pcos = new Float32Array(cap), psin = new Float32Array(cap);
    const pspec = new Uint8Array(cap), pvar = new Uint8Array(cap), pjit = new Float32Array(cap);
    const pcolA = new Float32Array(cap * 3), pcolB = new Float32Array(cap * 3), pbark = new Float32Array(cap * 3);
    const pphase = new Float32Array(cap), pstiff = new Float32Array(cap);
    const pImpH = new Float32Array(cap), pImpW = new Float32Array(cap);
    const pImpT = new Float32Array(cap);
    const pradius = new Float32Array(cap);
    let n = 0;

    const cA = new THREE.Color(), cB = new THREE.Color(), cBk = new THREE.Color();

    for (let j = 0; j < DF && n < cap; j++) {
      for (let i = 0; i < DF && n < cap; i++) {
        const idx = j * DF + i;
        const d = density[idx];
        if (d <= 0) continue;
        const expected = d * cellArea;
        let want = Math.floor(expected + rng());
        if (want <= 0) continue;
        want = Math.min(want, 14);

        const ox = -half + i * dfStep, oz = -half + j * dfStep;
        for (let k = 0; k < want && n < cap; k++) {
          const x = ox + rng() * dfStep;
          const z = oz + rng() * dfStep;

          if (W.getWaterDepth(x, z) > 0.0) continue;
          const rgx = ((x + half) / RM) | 0, rgz = ((z + half) / RM) | 0;
          if (roadMask[rgz * RW + rgx]) continue;
          const slope = W.getSlope(x, z);
          if (slope > 1.15) continue;
          const h = W.getHeight(x, z);
          if (h > 262) continue;

          const m = W.getMoisture(x, z);
          const river = W.getRiver(x, z);
          const si = this._pickSpecies(idx, sppBias, h, m, slope, river, rng);
          const sp = SPECIES[si];
          const vi = (rng() * CFG.variants) | 0;
          const proto = this.protos[si][vi];

          // Size hierarchy. The reference reads as a *forest* because it has
          // three populations, not one: a floor of knee-high saplings, a bulk
          // of mid trees, and a handful of heroes that are twice anything near
          // them. A single lerp over one random gives a mush of mediums, which
          // is exactly what the art review called out.
          // The cube gave a distribution whose *visible* half was all crammed
          // against its own ceiling: the median tree came out at 0.35 scale
          // (hidden in the grass) while everything big enough to read on a
          // skyline sat between 0.85 and 0.98 — which is why a treeline came
          // back looking like a trimmed hedge with every crown at one height.
          // A gentler exponent over a wider range keeps the sapling floor the
          // forest floor needs and gives the canopy an actual continuum above
          // it, so a stand has a top storey, an understorey and something in
          // between rather than two populations with a gap.
          //
          // Size is now *spatially correlated*, which is the part that was
          // missing. Drawing every tree's scale from one global distribution
          // gives a hillside of independent samples, and independent samples of
          // anything read to the eye as uniform — which is exactly the note on
          // the `peaks` view, a field of cones at one size with no hierarchy in
          // it, even though the distribution behind it was wide. Real forests
          // are patchy in *age*: a dense young thicket next to a stand of old
          // giants. One low-frequency field (~70 m) bends the exponent, so a
          // mature patch runs large and a young one runs small, and the heroes
          // land where the big trees already are instead of alone in a meadow.
          const mature = this.noise.fbm(x * 0.014 + 311.7, z * 0.014 - 177.3, 2, 2.2, 0.5, 1) * 0.5 + 0.5;
          const mat = clamp01(mature * 1.35 - 0.18);
          const u = rng();
          let scale = lerp(0.24, 1.18, Math.pow(u, lerp(2.9, 1.15, mat)));
          if (rng() < 0.028 + 0.135 * mat * mat) scale = lerp(1.20, 2.05, rng() * rng());   // hero
          // Altitude and dryness stunt growth — treeline trees are runts.
          scale *= lerp(0.70, 1.0, 1 - smoothstep(150, 250, h));
          scale *= lerp(0.84, 1.08, clamp01(m));
          // Absolute ceiling, in metres. Scale is a multiplier on a prototype
          // whose own height was already rolled from a range, so the two ranges
          // multiply: a hero draw on a 30 m spruce prototype grew a 58 m tree.
          // Beyond the fact that no spruce is 58 m, every foliage card on it is
          // scaled by the same factor, so its needle sprays came out five to
          // eight metres across and a near conifer read as a banana palm. The
          // cap is on the tree, not on the draw, so the size hierarchy is intact
          // everywhere below it.
          if (sp.maxHeight) scale = Math.min(scale, sp.maxHeight / proto.height);

          const radius = proto.halfWidth * scale;
          if (!this._space(occ, OW, OCC, half, x, z, radius, px, pz, pradius)) continue;

          const y = W.getHeight(x, z) - 0.14 * scale;

          // Palette: one pair per tree, plus a small per-tree hue/value drift so
          // a stand of one species is never one flat colour.
          const pal = sp.palettes[(rng() * sp.palettes.length) | 0];
          const jitterH = (rng() - 0.5) * 0.045;
          const jitterV = 0.86 + rng() * 0.30;
          cA.copy(pal[0]); cB.copy(pal[1]);
          this._drift(cA, jitterH, jitterV);
          this._drift(cB, jitterH * 0.7, jitterV * (0.94 + rng() * 0.12));
          cBk.copy(sp.barkColor);
          // Bark drift is deliberately narrow. On a dark trunk a wide value
          // scale is invisible; on a near-white birch it is the difference
          // between the plates' paper-white signature and a beige stick.
          this._drift(cBk, jitterH * 0.3, sp.bark === 0 ? 0.96 + rng() * 0.09
                                                        : 0.88 + rng() * 0.24);

          const rot = rng() * Math.PI * 2;
          px[n] = x; py[n] = y; pz[n] = z;
          pscale[n] = scale;
          pcos[n] = Math.cos(rot); psin[n] = Math.sin(rot);
          pspec[n] = si; pvar[n] = vi;
          pradius[n] = radius;
          // Stable per-tree draw for the far-field thinning (see thinWindow).
          pjit[n] = rng();
          pcolA[n * 3] = cA.r; pcolA[n * 3 + 1] = cA.g; pcolA[n * 3 + 2] = cA.b;
          pcolB[n * 3] = cB.r; pcolB[n * 3 + 1] = cB.g; pcolB[n * 3 + 2] = cB.b;
          pbark[n * 3] = cBk.r; pbark[n * 3 + 1] = cBk.g; pbark[n * 3 + 2] = cBk.b;
          pphase[n] = rng() * Math.PI * 2;
          // Slender trees whip; heavy oaks and stiff conifers barely move.
          pstiff[n] = (sp.conifer ? 0.45 : lerp(1.15, 0.62, clamp01(sp.trunkRadiusK * 22))) *
                      lerp(1.15, 0.85, clamp01(scale));
          // Which baked silhouette this tree wears in the far field. Keyed off
          // the near-LOD variant so a tree does not change outline as it
          // crosses the mid/far boundary.
          const ti = si * CFG.impVariants + (vi % CFG.impVariants);
          pImpT[n] = ti;
          pImpH[n] = this.impostorDims[ti].height * scale;
          pImpW[n] = this.impostorDims[ti].halfWidth * scale;

          const oi = (((z + half) / OCC) | 0) * OW + (((x + half) / OCC) | 0);
          if (oi >= 0 && oi < occ.length) occ[oi] = n;
          n++;
        }
      }
    }

    // ── bucket into a 64 m grid (counting sort) ──────────────────────────────
    const BS = CFG.bucket;
    const BW = Math.ceil(size / BS);
    const counts = new Int32Array(BW * BW + 1);
    const bucketOf = new Int32Array(n);
    for (let t = 0; t < n; t++) {
      const bx = clamp(((px[t] + half) / BS) | 0, 0, BW - 1);
      const bz = clamp(((pz[t] + half) / BS) | 0, 0, BW - 1);
      const b = bz * BW + bx;
      bucketOf[t] = b;
      counts[b + 1]++;
    }
    for (let b = 0; b < BW * BW; b++) counts[b + 1] += counts[b];
    const order = new Int32Array(n);
    const cursor = counts.slice(0, BW * BW);
    for (let t = 0; t < n; t++) order[cursor[bucketOf[t]]++] = t;

    this.trees = {
      n, px, py, pz, pscale, pcos, psin, pspec, pvar, pjit,
      pcolA, pcolB, pbark, pphase, pstiff, pImpH, pImpW, pImpT,
      order, bucketStart: counts, BW, BS, half,
    };
    this.stats.total = n;
    console.log(`[trees] ${n} placed in ${(performance.now() - t0).toFixed(0)} ms`);
  }

  /** Rejection test against the 4 m spacing grid. */
  _space(occ, OW, OCC, half, x, z, radius, px, pz, pradius) {
    const gx = ((x + half) / OCC) | 0;
    const gz = ((z + half) / OCC) | 0;
    if (gx < 0 || gz < 0 || gx >= OW || gz >= OW) return false;
    const R = Math.min(6, Math.ceil((radius * 0.9 + 1.2) / OCC));
    for (let j = -R; j <= R; j++) {
      const zz = gz + j;
      if (zz < 0 || zz >= OW) continue;
      for (let i = -R; i <= R; i++) {
        const xx = gx + i;
        if (xx < 0 || xx >= OW) continue;
        const t = occ[zz * OW + xx];
        if (t < 0) continue;
        // Crowns interlock in a real forest; 0.55 keeps them touching, not merged.
        const need = (radius + pradius[t]) * 0.42 + 0.7;
        const dx = px[t] - x, dz = pz[t] - z;
        if (dx * dx + dz * dz < need * need) return false;
      }
    }
    return true;
  }

  _pickSpecies(dfIdx, bias, h, m, slope, river, rng) {
    const S = SPECIES.length;
    const wet = smoothstep(0.24, 0.74, m);
    const high = smoothstep(55, 155, h);
    const w = this._w ?? (this._w = new Float32Array(S));

    // Birch and aspen carry every gold and lime note in the game. Under the old
    // weights spruce out-competed them almost everywhere below the treeline and
    // the eye-level frames measured 0.0% yellow against the plates' 7.9%, which
    // is why every deciduous canopy in a view read as the same orange. They now
    // win their own stands, and birch is sharpened like the conifer so those
    // stands have edges instead of being one birch salted through a maple wood.
    // The river bonus used to be birch 1.5 / aspen 0.9 against base weights near
    // 0.4, which meant that anywhere the river field approached 1 — the whole of
    // the waterfall and river anchors — birch simply won, and those frames came
    // back as a single gold species. Riparian species still lead on a bank, but
    // by a margin the other weights can argue with, and maple gets its own
    // riverbank term because it is the crimson in the plates' bank planting.
    w[0] = (0.72 * (0.35 + wet) * (1 - smoothstep(150, 225, h))) + river * 0.85;       // birch
    w[1] = (0.58 * (0.30 + wet) * (1 - smoothstep(140, 205, h))) + river * 0.50;       // aspen
    w[2] = 0.46 * (0.45 + wet * 0.85) * (1 - smoothstep(105, 180, h)) + river * 0.55;  // maple
    w[3] = 0.38 * (1.05 - wet * 0.45) * (1 - smoothstep(85, 155, h));                  // oak
    // Spruce is the value anchor of the palette — the only deep, cool, dark
    // mass in a frame that is otherwise entirely hot. Confining it to the
    // treeline (which the altitude term alone does) leaves the valley with
    // nothing to read against, so it gets a substantial floor at every height
    // and wins outright wherever its regional bias is strong.
    w[4] = (0.72 + 1.15 * high + smoothstep(0.5, 1.0, slope) * 0.55) * (0.55 + wet * 0.7);

    let best = -1, bi = 0;
    for (let s = 0; s < S; s++) {
      // Regional preference, squared for the clonal species so aspen forms the
      // pure single-colour groves it does in life.
      let b = bias[dfIdx * S + s];
      if (SPECIES[s].clonal) b = b * b * 1.6;
      if (SPECIES[s].key === 'birch') b = b * b * 1.5;
      // Conifer stands are large and near-pure in the reference plates, never
      // one spruce salted through a birch wood. Sharpening the bias turns the
      // regional field into a hard stand boundary.
      if (SPECIES[s].conifer) b = b * b * 1.75;
      const v = w[s] * (0.18 + 1.9 * b) * (0.8 + 0.4 * rng());
      if (v > best) { best = v; bi = s; }
    }
    return bi;
  }

  /** Small hue rotation + value scale, in place. Keeps stands from going flat. */
  _drift(col, hueShift, valueScale) {
    col.getHSL(this._hsl ?? (this._hsl = {}));
    const hsl = this._hsl;
    col.setHSL(
      (hsl.h + hueShift + 1) % 1,
      // Slightly *below* unity on average. Measured against the plates, the
      // reference tops out around chromaMean 0.42 and a stand of crimson maple
      // was pushing the frame past 0.49; inflating saturation per tree on top
      // of an already-saturated palette is how a warm frame tips into garish.
      clamp01(hsl.s * (0.94 + Math.abs(hueShift) * 2)),
      clamp01(hsl.l * valueScale)
    );
  }

  // ── per-frame binning ──────────────────────────────────────────────────────

  _rebuild(camPos) {
    const t0 = performance.now();
    const T = this.trees;
    if (!T) return;
    const { BW, BS, half } = T;

    const near = this.slots.near, mid = this.slots.mid, far = this.farSlot;
    for (const s of near) { s.count = 0; s.minX = 1e9; s.maxX = -1e9; s.minY = 1e9; s.maxY = -1e9; s.minZ = 1e9; s.maxZ = -1e9; }
    for (const s of mid) if (s) { s.count = 0; s.minX = 1e9; s.maxX = -1e9; s.minY = 1e9; s.maxY = -1e9; s.minZ = 1e9; s.maxZ = -1e9; }
    far.count = 0;

    const cx = camPos.x, cz = camPos.z;
    const rad = Math.ceil(CFG.farDist / BS) + 1;
    const bcx = clamp(((cx + half) / BS) | 0, 0, BW - 1);
    const bcz = clamp(((cz + half) / BS) | 0, 0, BW - 1);
    const lodMul = this._lodScale;
    const nearD = CFG.nearDist * lodMul, midD = CFG.midDist * lodMul;
    const nearD2 = nearD * nearD;
    const midD2 = midD * midD;
    const farD2 = CFG.farDist * CFG.farDist;
    const V = CFG.variants;

    for (let j = -rad; j <= rad; j++) {
      const bz = bcz + j;
      if (bz < 0 || bz >= BW) continue;
      for (let i = -rad; i <= rad; i++) {
        const bx = bcx + i;
        if (bx < 0 || bx >= BW) continue;
        // Whole-bucket reject on the nearest corner distance.
        const ddx = Math.max(0, Math.abs((-half + (bx + 0.5) * BS) - cx) - BS * 0.5);
        const ddz = Math.max(0, Math.abs((-half + (bz + 0.5) * BS) - cz) - BS * 0.5);
        if (ddx * ddx + ddz * ddz > farD2) continue;

        const b = bz * BW + bx;
        const s0 = T.bucketStart[b], s1 = T.bucketStart[b + 1];
        for (let o = s0; o < s1; o++) {
          const t = T.order[o];
          const dx = T.px[t] - cx, dz = T.pz[t] - cz;
          const d2 = dx * dx + dz * dz;
          if (d2 > farD2) continue;

          if (d2 < nearD2) {
            this._push(near[T.pspec[t] * V + T.pvar[t]], T, t);
          } else if (d2 < midD2) {
            const slot = mid[T.pspec[t] * V + (T.pvar[t] % CFG.midVariants)];
            this._push(slot, T, t);
          } else {
            const win = thinWindow(Math.sqrt(d2));
            if (win) {
              const keep = (T.pscale[t] - win[0]) / (win[1] - win[0]);
              // T.pjit is a stable per-tree uniform in 0..1, so the decision is
              // the same every frame and every session.
              if (keep < 1 && T.pjit[t] > keep) continue;
            }
            this._pushFar(far, T, t);
          }
        }
      }
    }

    this._commit(near); this._commit(mid); this._commitFar(far);
    this.stats.near = near.reduce((a, s) => a + s.count, 0);
    this.stats.mid = mid.reduce((a, s) => a + (s ? s.count : 0), 0);
    this.stats.far = far.count;
    // Trees are the biggest triangle consumer in the game; keep the number in
    // front of us rather than inferring it from the global counter.
    let tris = far.count * 2;
    for (const s of [...near, ...mid]) {
      if (!s || !s.count) continue;
      for (const m of s.meshes) tris += s.count * (m.geometry.index.count / 3);
    }
    this.stats.tris = tris;
    this.stats.calls = this.meshes.filter((m) => m.visible).length + (far.count ? 1 : 0);
    this.stats.buildMs = performance.now() - t0;
  }

  _push(slot, T, t) {
    if (!slot || slot.count >= slot.cap) return;
    const k = slot.count++;
    const s = T.pscale[t], c = T.pcos[t] * s, si = T.psin[t] * s;
    const m = slot.matrix.array, o = k * 16;
    // Y-rotation + uniform scale, written straight in. Composing a Matrix4 per
    // instance is the single hottest thing in this loop; this is 12 stores.
    m[o] = c;      m[o + 1] = 0; m[o + 2] = -si;   m[o + 3] = 0;
    m[o + 4] = 0;  m[o + 5] = s; m[o + 6] = 0;     m[o + 7] = 0;
    m[o + 8] = si; m[o + 9] = 0; m[o + 10] = c;    m[o + 11] = 0;
    m[o + 12] = T.px[t]; m[o + 13] = T.py[t]; m[o + 14] = T.pz[t]; m[o + 15] = 1;

    const a = slot.colA.array, bb = slot.colB.array, bk = slot.barkCol.array;
    const j3 = k * 3, s3 = t * 3;
    a[j3] = T.pcolA[s3]; a[j3 + 1] = T.pcolA[s3 + 1]; a[j3 + 2] = T.pcolA[s3 + 2];
    bb[j3] = T.pcolB[s3]; bb[j3 + 1] = T.pcolB[s3 + 1]; bb[j3 + 2] = T.pcolB[s3 + 2];
    bk[j3] = T.pbark[s3]; bk[j3 + 1] = T.pbark[s3 + 1]; bk[j3 + 2] = T.pbark[s3 + 2];
    const w = slot.wind.array;
    w[k * 2] = T.pphase[t]; w[k * 2 + 1] = T.pstiff[t];

    const x = T.px[t], y = T.py[t], z = T.pz[t];
    if (x < slot.minX) slot.minX = x; if (x > slot.maxX) slot.maxX = x;
    if (y < slot.minY) slot.minY = y; if (y > slot.maxY) slot.maxY = y;
    if (z < slot.minZ) slot.minZ = z; if (z > slot.maxZ) slot.maxZ = z;
  }

  _pushFar(slot, T, t) {
    if (slot.count >= slot.cap) return;
    const k = slot.count++;
    const m = slot.matrix.array, o = k * 16;
    m[o] = 1; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = 1; m[o + 11] = 0;
    m[o + 12] = T.px[t]; m[o + 13] = T.py[t]; m[o + 14] = T.pz[t]; m[o + 15] = 1;

    const j3 = k * 3, s3 = t * 3;
    const a = slot.colA.array, bb = slot.colB.array, cc = slot.colC.array, im = slot.imp.array;
    a[j3] = T.pcolA[s3]; a[j3 + 1] = T.pcolA[s3 + 1]; a[j3 + 2] = T.pcolA[s3 + 2];
    bb[j3] = T.pcolB[s3]; bb[j3 + 1] = T.pcolB[s3 + 1]; bb[j3 + 2] = T.pcolB[s3 + 2];
    cc[j3] = T.pbark[s3]; cc[j3 + 1] = T.pbark[s3 + 1]; cc[j3 + 2] = T.pbark[s3 + 2];
    im[j3] = T.pImpT[t]; im[j3 + 1] = T.pImpH[t]; im[j3 + 2] = T.pImpW[t];
    const w = slot.wind.array;
    w[k * 2] = T.pphase[t]; w[k * 2 + 1] = T.pstiff[t];
  }

  /**
   * Upload only the instances this rebuild actually wrote.
   *
   * `attr.needsUpdate = true` re-uploads the entire buffer, and these buffers
   * are sized for the worst case: 25 near slots of 700, 25 mid slots of 1500,
   * and a 30 000-instance far block. Measured on a drive, one re-bin pushed
   * 7.1 MB across the bus in a single frame — most of it the unused tail of a
   * half-full slot, and about a third of it slots holding nothing at all. An
   * update range turns that into the prefix that was just written; an empty
   * slot is not uploaded at all, because its mesh is hidden and the stale tail
   * can never be drawn.
   */
  _upload(attr, count) {
    if (count <= 0) return;
    attr.addUpdateRange(0, count * attr.itemSize);
    attr.needsUpdate = true;
  }

  _commit(slots) {
    for (const s of slots) {
      if (!s) continue;
      const c = s.count;
      this._upload(s.matrix, c);
      this._upload(s.colA, c); this._upload(s.colB, c);
      this._upload(s.barkCol, c); this._upload(s.wind, c);
      for (const m of s.meshes) {
        m.count = c;
        m.visible = c > 0;
        if (c > 0) {
          // World-space bounds of the live instances, padded by the tallest
          // prototype so a crown leaning out of the box is not culled.
          const pad = 26;
          m.boundingSphere.center.set(
            (s.minX + s.maxX) * 0.5, (s.minY + s.maxY) * 0.5 + pad * 0.5, (s.minZ + s.maxZ) * 0.5);
          m.boundingSphere.radius =
            0.5 * Math.hypot(s.maxX - s.minX, s.maxY - s.minY + pad, s.maxZ - s.minZ) + pad;
        }
      }
    }
  }

  /**
   * Hand the far block to the GPU a few thousand instances at a time.
   *
   * The far slot holds ~15 000 impostors, and one re-bin used to push all of it
   * in a single frame: 960 kB of instanceMatrix plus 720 kB of colour and
   * impostor attributes, 1.9 MB, measured with tools/_scratch/uploads.mjs. It
   * is the largest single upload in the game and it lands on ONE frame every
   * ~11 m of travel — those frames measured 18-40 ms against a 17 ms median, so
   * it is a periodic spike that exists only while the camera is moving. That is
   * the shape of the player's report that driving is worse than standing still.
   *
   * Spreading it costs nothing visually because far instances DO NOT MOVE. A
   * tree's position is fixed for the whole session; what a re-bin changes is
   * only *which* trees are in the block and in what order, and consecutive bins
   * 11 m apart differ in about one instance in a hundred. So an instance whose
   * new data has not been uploaded yet still draws a real tree at a real
   * position — the previous bin's occupant of that slot — for at most three
   * frames, i.e. about a metre of camera travel at driving speed.
   *
   * The one case that would *not* be safe is drawing past the high-water mark
   * of what has ever been uploaded: those instances are still zeroed and would
   * put trees at the origin. That tail is therefore uploaded in full, on the
   * spot, and only the refresh of already-valid instances is spread.
   */
  _commitFar(s) {
    this._farTarget = s.count;
    // Anything past the high-water mark has never been uploaded — it holds
    // zeroes, and drawing it would put trees at the origin. That tail goes up
    // immediately, whatever it costs, and it is small: the far count moves by a
    // few hundred instances between bins, against a block of ~13 000. Spreading
    // it instead was measured to leave up to 1867 impostors undrawn for a frame,
    // which is a visible flicker on a distant hillside and not worth the bytes.
    if (s.count > this._farFilled) {
      const from = this._farFilled, n = s.count - from;
      this._uploadFarRange(s, from, n);
      this._farFilled = s.count;
    }
    // Everything below the mark already holds a real tree at a real position —
    // the previous bin's occupant — so refreshing it can take as many frames as
    // it likes. Far instances never move; only which tree sits in which slot
    // changes, and consecutive bins 11 m apart differ in about one slot in a
    // hundred.
    this._farCursor = 0;
    this._drainFar();
  }

  _uploadFarRange(s, from, n) {
    if (n <= 0) return;
    for (const attr of [s.matrix, s.colA, s.colB, s.colC, s.imp, s.wind]) {
      attr.addUpdateRange(from * attr.itemSize, n * attr.itemSize);
      attr.needsUpdate = true;
    }
  }

  /** Upload the next chunk of the far block. Called once per frame. */
  _drainFar() {
    const s = this.farSlot;
    if (!s || !this.farMesh) return;
    if (this._farCursor < this._farTarget) {
      const from = this._farCursor;
      const n = Math.min(FAR_UPLOAD_CHUNK, this._farTarget - from);
      this._uploadFarRange(s, from, n);
      this._farCursor = from + n;
    }
    this.farMesh.count = this._farTarget;
    this.farMesh.visible = this._farTarget > 0;
  }

  // ── frame ──────────────────────────────────────────────────────────────────

  update(dt, elapsed) {
    const { camera, lighting } = this.ctx;
    const u = this.shared;

    u.uTime.value = elapsed;

    // Wind: a slowly wandering direction so shadows and gusts never settle into
    // a pattern. Weather may take this over later; read it defensively.
    const weather = this.ctx.systems?.weather;
    this._windAngle += dt * 0.035;
    const wa = this._windAngle + Math.sin(elapsed * 0.07) * 0.35;
    u.uWindDir.value.set(Math.cos(wa), 0, Math.sin(wa));
    const gust = 0.34 + 0.20 * (0.5 + 0.5 * Math.sin(elapsed * 0.11));
    u.uWindStrength.value = gust * (weather?.windScale ?? 1);

    if (lighting) {
      // Match three's Lambert normalisation so trees sit in the same light as
      // the terrain instead of reading as a separate render.
      u.uSunDir.value.copy(lighting.sunDir);
      u.uSunColor.value.copy(lighting.sun.color).multiplyScalar(lighting.sun.intensity / Math.PI);
      u.uSkyColor.value.copy(lighting.hemi.color);
      u.uGroundColor.value.copy(lighting.hemi.groundColor);
      u.uAmbient.value = (lighting.hemi.intensity + lighting.fill.intensity * 0.5) / Math.PI;
      // Backlight glow rides the sun's own colour, hottest near the horizon.
      const lowSun = 1 - smoothstep(0.05, 0.42, Math.max(0, lighting.sunDir.y));
      // Down from 1.40 / 3.20. With uTransTint no longer supplying a third
      // warm multiplier the transmitted term arrives much *whiter*, so the same
      // strength reads far hotter than it did — the near crowns in `backlit`
      // measured srgb(156,81,53) against grass at srgb(206,118,84), i.e. the
      // same hue at a lower value, and simply vanished into the meadow. The
      // glow is meant to separate a crown from what is behind it, not to bleach
      // it to the background.
      u.uTransStrength.value = lerp(1.10, 2.40, lowSun);
    }

    const p = camera.position;
    if (p.distanceToSquared(this._lastRebuildPos) > CFG.rebuildMove * CFG.rebuildMove) {
      this._lastRebuildPos.copy(p);
      this._rebuild(p);
    } else {
      // Keep feeding the far block on the frames between re-bins; _rebuild
      // starts the transfer, this finishes it.
      this._drainFar();
    }
  }

  lateUpdate() {
    // After Atmosphere has had its say for this frame.
  }

  /**
   * Quality tier changed — re-scale the near and mid LOD radii. See
   * LOD_TIER_SCALE. A no-op at ultra and high.
   *
   * Only the binning changes; no geometry is rebuilt and no instance buffer is
   * reallocated, because the slot caps were sized from `treeMul` at load and a
   * smaller radius can only ever fill them less. The re-bin is forced by
   * invalidating the last rebuild position, so it happens on the next frame
   * through the ordinary path.
   */
  onQuality(preset, name) {
    const s = LOD_TIER_SCALE[name] ?? 1;
    if (s === this._lodScale) return;
    this._lodScale = s;
    this._lastRebuildPos.set(1e9, 0, 1e9);
    void preset;
  }

  dispose() {
    this.ctx.scene.remove(this.group);
    for (const m of this.meshes ?? []) m.geometry.dispose();
    this.farMesh?.geometry.dispose();
    this._impostorRT?.dispose();
    this.atlas?.dispose();
    for (const k of ['leafNear', 'leafMid', 'bark', 'leafBake', 'barkBake']) {
      this[k]?.mat?.dispose(); this[k]?.depth?.dispose();
    }
    this.impostorMat?.mat?.dispose();
  }
}
