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
  variants: 3,           // prototypes per species
  midVariants: 2,        // how many of them survive into the mid LOD

  nearDist: 96,          // full geometry
  midDist: 255,          // reduced geometry
  farDist: 1000,         // impostor card; past this, nothing (fog owns it)

  bucket: 64,            // spatial bucket size, metres
  rebuildMove: 11,       // camera travel that forces a re-bin, metres

  capNear: 700,          // instance cap per species-variant
  capMid: 1500,
  capFar: 30000,

  impostorTileW: 192,
  impostorTileH: 288,
};

// Trees now share the authored fog density with everything else. This was
// briefly scaled to 0.37 to compensate for a global wiring bug in which
// MeshStandardMaterial received no fog uniforms at all, so only opt-in
// ShaderMaterials were hazed. That bug is fixed (see render/uniformPatch.js).
const FOG_MATCH = 1.0;

// VEG.treeDensity is the per-hectare figure the whole game shares; trees want a
// closed canopy in the groves, so they scale it up rather than redefining it.
const DENSITY_MUL = 3.5;

// Beyond `nearDist` a tree's importance rank (0..1, small = big tree) has to
// beat this curve to survive. Saplings at 600 m are three pixels of noise.
// Beyond `nearDist` a tree's importance rank (0..1, small = big tree) has to
// beat this curve to survive. It used to thin hard, which left the far field as
// evenly-spaced hero trees — a polka-dot of identical cones rather than the
// continuous textured band the reference paints. Impostors cost two triangles
// in one shared draw call, so the thinning only needs to keep saplings out of
// the last few hundred metres.
function rankCutoff(d) {
  if (d < 300) return 1.0;
  if (d < 560) return 0.90;
  if (d < 820) return 0.70;
  return 0.48;
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
    this._windAngle = 0.7;
    this._tmpSphere = new THREE.Sphere();
    this.stats = { near: 0, mid: 0, far: 0, buildMs: 0 };
  }

  async init() {
    const { scene, preset } = this.ctx;
    this.treeMul = preset?.treeMul ?? 1;

    this.atlas = buildClusterAtlas(SEED & 0xffff, 256);
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
            bark: buildBarkGeometry(tree, sp, { radialSegs: 3, maxLevel: 0 }),
            leaf: buildLeafGeometry(tree, { keep: 2, sizeBoost: 0.86 }),
          } : null,
        });
      }
      this.protos.push(variants);
    }
  }

  /**
   * Sit in the same aerial perspective as the rest of the frame.
   *
   * The shared atmospheric fog currently only reaches materials that opted in
   * with `fogUniforms()` — trees, water and waterfalls. Terrain, rock, grass
   * and the camper are MeshStandardMaterials, and `THREE.ShaderLib.physical`
   * was built at three's own module-init, *before* `Atmosphere.patchFogChunks`
   * added `uFogDensity` and friends to `THREE.UniformsLib.fog`. Adding keys to
   * the library afterwards does not retroactively add them to an already-merged
   * ShaderLib entry, so those programs declare the uniforms and never receive a
   * value: `uFogDensity` is zero and they render with no haze at all. (Verified
   * in the running game: `ShaderLib.physical.uniforms` has no `uFog*` keys.)
   *
   * The net effect is that trees were the only tall thing in the frame carrying
   * the full haze. A crown is also the darkest thing in the far field, so it
   * went to haze colour first — which is why every distant stand, conifers
   * included, rendered as pale cream cones standing on ground that had kept all
   * of its gold. Matching the *nominal* density did not help, because the
   * ground is not being fogged at that density; it is not being fogged at all,
   * and only carries the terrain's own internal distance desaturation.
   *
   * So this matches what the frame actually shows rather than what it nominally
   * asks for: a fraction of the authored density, measured against the terrain
   * at 300–900 m in the `peaks` and `hero` views. Logged in
   * docs/INTEGRATION_REQUESTS.md; delete this whole method once standard
   * materials are genuinely fogged, and trees will fall straight back in line.
   */
  _syncFogDensity() {
    const lib = THREE.UniformsLib?.fog?.uFogDensity;
    if (!lib || !this._fogMats) return;
    const d = lib.value * FOG_MATCH;
    for (const m of this._fogMats) {
      const u = m?.uniforms?.uFogDensity;
      if (u) u.value = d;
    }
  }

  _buildMaterials() {
    this.leafNear = createLeafMaterial(this.atlas, this.shared, { alphaTest: 0.40 });
    // A lower cutout at distance compensates for mip-chain alpha erosion, which
    // otherwise makes mid-LOD crowns visibly thin out as you back away.
    this.leafMid = createLeafMaterial(this.atlas, this.shared, { alphaTest: 0.26 });
    this.bark = createBarkMaterial(this.shared);
    this.leafBake = createLeafMaterial(this.atlas, this.shared, { alphaTest: 0.40, bake: true });
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

    for (const m of [barkMesh, leafMesh]) {
      m.count = 0;
      m.castShadow = true;
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
    const W = CFG.impostorTileW, H = CFG.impostorTileH;

    const rt = new THREE.WebGLRenderTarget(W * N, H, {
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

    for (let si = 0; si < N; si++) {
      const p = this.protos[si][0];
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

      rt.viewport.set(si * W, 0, W, H);
      rt.scissor.set(si * W, 0, W, H);
      renderer.setRenderTarget(rt);
      renderer.render(bakeScene, cam);

      this.impostorDims.push({ halfWidth: halfW, height: top });
      a.geometry.dispose(); b.geometry.dispose();
    }

    rt.scissorTest = false;
    rt.viewport.set(0, 0, W * N, H);
    rt.scissor.set(0, 0, W * N, H);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);

    this.impostorTex = rt.texture;
    this._impostorRT = rt;

    this.impostorMat = createImpostorMaterial(
      this.impostorTex, this.shared, N, [CFG.farDist * 0.80, CFG.farDist]);
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
        // Riverbanks are lined with trees whatever the grove field says.
        d = Math.max(d, smoothstep(0.05, 0.45, river) * 0.85);
        // Lone sentinels: a thin floor everywhere drivable keeps the meadows
        // from being empty, and gives the long raking shadows something to cast.
        d = Math.max(d, 0.055 * slopeLim * treeLine);
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
    const pspec = new Uint8Array(cap), pvar = new Uint8Array(cap), prank = new Float32Array(cap);
    const pcolA = new Float32Array(cap * 3), pcolB = new Float32Array(cap * 3), pbark = new Float32Array(cap * 3);
    const pphase = new Float32Array(cap), pstiff = new Float32Array(cap);
    const pImpH = new Float32Array(cap), pImpW = new Float32Array(cap);
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
          const u = rng();
          let scale = lerp(0.26, 0.98, u * u * u);
          if (rng() < 0.085) scale = lerp(1.05, 1.85, rng() * rng());   // hero
          // Altitude and dryness stunt growth — treeline trees are runts.
          scale *= lerp(0.70, 1.0, 1 - smoothstep(150, 250, h));
          scale *= lerp(0.84, 1.08, clamp01(m));

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
          this._drift(cBk, jitterH * 0.3, 0.88 + rng() * 0.24);

          const rot = rng() * Math.PI * 2;
          px[n] = x; py[n] = y; pz[n] = z;
          pscale[n] = scale;
          pcos[n] = Math.cos(rot); psin[n] = Math.sin(rot);
          pspec[n] = si; pvar[n] = vi;
          pradius[n] = radius;
          // Importance: big trees first when the far field is thinned.
          prank[n] = clamp01(1 - scale * 0.72);
          pcolA[n * 3] = cA.r; pcolA[n * 3 + 1] = cA.g; pcolA[n * 3 + 2] = cA.b;
          pcolB[n * 3] = cB.r; pcolB[n * 3 + 1] = cB.g; pcolB[n * 3 + 2] = cB.b;
          pbark[n * 3] = cBk.r; pbark[n * 3 + 1] = cBk.g; pbark[n * 3 + 2] = cBk.b;
          pphase[n] = rng() * Math.PI * 2;
          // Slender trees whip; heavy oaks and stiff conifers barely move.
          pstiff[n] = (sp.conifer ? 0.45 : lerp(1.15, 0.62, clamp01(sp.trunkRadiusK * 22))) *
                      lerp(1.15, 0.85, clamp01(scale));
          pImpH[n] = this.impostorDims[si].height * scale;
          pImpW[n] = this.impostorDims[si].halfWidth * scale;

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
      n, px, py, pz, pscale, pcos, psin, pspec, pvar, prank,
      pcolA, pcolB, pbark, pphase, pstiff, pImpH, pImpW,
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

    w[0] = (0.50 * (0.35 + wet) * (1 - smoothstep(150, 225, h))) + river * 1.5;        // birch
    w[1] = (0.46 * (0.30 + wet) * (1 - smoothstep(140, 205, h))) + river * 0.9;        // aspen
    w[2] = 0.42 * (0.45 + wet * 0.85) * (1 - smoothstep(105, 180, h));                 // maple
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
      // Conifer stands are large and near-pure in the reference plates, never
      // one spruce salted through a birch wood. Sharpening the bias turns the
      // regional field into a hard stand boundary.
      if (SPECIES[s].conifer) b = b * b * 2.1;
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
    const nearD2 = CFG.nearDist * CFG.nearDist;
    const midD2 = CFG.midDist * CFG.midDist;
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
            if (T.prank[t] > rankCutoff(Math.sqrt(d2))) continue;
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
    im[j3] = T.pspec[t]; im[j3 + 1] = T.pImpH[t]; im[j3 + 2] = T.pImpW[t];
    const w = slot.wind.array;
    w[k * 2] = T.pphase[t]; w[k * 2 + 1] = T.pstiff[t];
  }

  _commit(slots) {
    for (const s of slots) {
      if (!s) continue;
      const c = s.count;
      s.matrix.needsUpdate = true;
      s.colA.needsUpdate = true; s.colB.needsUpdate = true;
      s.barkCol.needsUpdate = true; s.wind.needsUpdate = true;
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

  _commitFar(s) {
    s.matrix.needsUpdate = true;
    s.colA.needsUpdate = true; s.colB.needsUpdate = true; s.colC.needsUpdate = true;
    s.imp.needsUpdate = true; s.wind.needsUpdate = true;
    this.farMesh.count = s.count;
    this.farMesh.visible = s.count > 0;
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
      u.uTransStrength.value = lerp(1.40, 3.20, lowSun);
    }

    const p = camera.position;
    if (p.distanceToSquared(this._lastRebuildPos) > CFG.rebuildMove * CFG.rebuildMove) {
      this._lastRebuildPos.copy(p);
      this._rebuild(p);
    }
  }

  lateUpdate() {
    // After Atmosphere has had its say for this frame.
    this._syncFogDensity();
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
