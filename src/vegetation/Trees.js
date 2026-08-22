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
// OCCLUDE. Bark ships two programs and this file owns the choice between them;
// see `_gateOcclusion` and the note at the top of tree_material.js.
import { occlusionActive, occlusionTouchesColumn } from '../render/Occlusion.js';

// Which species carry the red sixth of the wheel. Read off the `autumnRed`
// flag in the species table rather than by index, so adding a species cannot
// silently leave it out of the admixture in _pickSpecies(). It is a declared
// flag and not a hue test on the palettes because 'red' here means the 0-30
// degree bucket tools/colorstats.mjs measures the plates in, and the gold and
// amber entries several species carry sit at 34-48 degrees — inside the same
// warm family, but they are precisely the colours the forest view already has
// too much of.
const RED_SPECIES = SPECIES.map((sp) => !!sp.autumnRed);

const CFG = {
  // Five prototypes per species, not three. Three is what produced the "12+
  // near-identical conifer silhouettes in a single view" the critic counted:
  // per-instance yaw and scale cannot hide a repeated crown outline, only a
  // different crown can. Five near slots per species is 50 near meshes plus 30
  // mid and one impostor — 81 draw calls at the absolute worst against a tree
  // budget of 120, and it costs no extra triangles because the same trees are
  // simply spread over more prototypes.
  variants: 5,           // prototypes per species
  //
  // EVERY variant is grown at every LOD. This used to be `midVariants: 2`,
  // with the mid slot chosen as `pvar % 2`, and the note defending it argued
  // that crown-shape *repetition* is invisible past 96 m — which is true, and
  // which is about the wrong thing. The question at a LOD boundary is not
  // whether the mid field is varied, it is whether a tree is still the same
  // tree after it crosses. Three trees in five were handed a prototype grown
  // from a different seed: a different height, a different lean, a different
  // crown. Measured with `tools/lodstrip.mjs`, one tree isolated, wind frozen,
  // framed to a constant angular size, at 83 m and then at 84 m:
  //
  //     silhouette IoU     1 m step, same LOD (control)     0.999
  //     silhouette IoU     1 m step across near->mid        0.365
  //     crown height       across near->mid                 15.5% mean, 34% worst
  //     crown width        across near->mid                 36.6% mean, 98% worst
  //
  // A 12.6 m maple became a 17 m maple with a crown twice as wide, in one
  // metre of driving, and the whole forest does that at once every
  // `rebuildMove` metres. That is the player's "a mess of trees changing all
  // around you", and it is not a fade problem — a cross-fade between two
  // different trees is a dissolve, not a LOD.
  //
  // The cost of fixing it is draw calls and memory, in that order. 25 mid
  // slots instead of 10 takes the tree meshes from 71 to 101 against the
  // budget of 120 in the comment above — 84% of the stated headroom, and the
  // number to watch if anyone adds a sixth species or a sixth variant.
  // Measured over the ten canonical views it is +41 to +46 draw calls; the
  // frame is fragment-bound (PERF_FINDINGS.md) and neither `ablate.mjs` nor an
  // independent critic's harness could price it above their own drift.
  //
  // Triangles are a WASH, not a saving. The same trees are spread over more
  // prototypes, so the count moves only because a tree's own mid geometry
  // replaces a substitute's: 1-2 k down per view, which is view-dependent
  // noise around zero and should not be quoted as a win.
  //
  // Memory is about 8 MB: 15 more mid instance slots at cap 1500 x 108 bytes
  // is ~2.4 MB, and the impostor atlas goes from 10 tiles to 25 — 960 x 1440
  // with its mip chain, ~5.9 MB more than the 10-tile strip. Mid geometry
  // itself is nothing, 170-300 triangles a prototype.

  // 84 m, down from 96. The near LOD carries three times the leaf cards of the
  // mid one *and* it is the only foliage that casts, so every near instance is
  // paid for twice — once in the shadow pass and once in the main pass, both
  // as double-sided alpha-tested quads. Shrinking the radius by an eighth drops
  // near instances by a quarter (area, not radius) and it is the cheapest
  // frame-time this system has to give: at 84 m a crown is still 80 px across
  // and the mid prototype it hands over to is the same tree — which was the
  // claim this note made before it was true, and see `variants` above for what
  // it cost.
  nearDist: 84,          // full geometry
  midDist: 255,          // reduced geometry
  farDist: 1000,         // impostor card; past this, nothing (fog owns it)

  bucket: 64,            // spatial bucket size, metres
  // Camera travel that forces a re-bin, metres.
  //
  // This number is also the reason there is no cross-fade across `nearDist`,
  // and the next person to reach for one should read this first, because the
  // work is a day and the answer is at the end of it.
  //
  // With identity fixed (see `variants`) a tree keeps its height, width, lean,
  // rotation, species and colour across 84 m to within 0.3% and 3.6%. What is
  // left is interior: the mid crown is a quarter as many leaf dabs at 1.7x the
  // size, and its bark drops to `maxLevel: 0`, so the limbs go. Silhouette IoU
  // at the boundary is 0.66 against a same-LOD control of 0.999, and only a
  // blend can close that, because the two meshes are genuinely different
  // meshes.
  //
  // A blend costs two things here and the second is the killer:
  //
  //  · the near and mid BARK are the same skeleton at different tessellation,
  //    so drawing both during a fade z-fights along the trunk. Fading bark
  //    needs a dither, and the dithering bark program gives up early-Z for the
  //    whole draw — 51.3 fps with bark untouched against 31.9 with bark
  //    discarding, in the table at the top of tree_material.js. Splitting bark
  //    and leaf onto separate instance counts is possible but they share one
  //    instance block today.
  //  · a fade parameter cannot be written at bin time, because bin time is
  //    only every 11 m: the fade would arrive in 11 m steps, which is the
  //    stutter it was meant to remove. It has to be computed per fragment from
  //    the camera distance, which means the two bands must OVERLAP in the
  //    binning by at least `rebuildMove` on each side. That puts the near bin
  //    radius at 84 + 11 = 95 m, i.e. 28% more near instances — the LOD that
  //    carries three times the leaf cards and is the only foliage that casts —
  //    in a frame PERF_FINDINGS.md measures as fragment-bound at 50%.
  //
  // 28% more near instances is well over the millisecond this was allowed to
  // spend. Shrinking `rebuildMove` to buy a narrow band trades it for a
  // 1-4 ms `_rebuild` several times a second plus continuous far-block upload
  // traffic (see `_commitFar`), which is the periodic hitch that note exists
  // to describe. Neither is worth it against a defect now measured at a
  // fraction of what it was.
  //
  // ── the 255 m boundary is a different question, and it is still open ─────
  //
  // A critic pointed out, correctly, that neither objection above transfers to
  // mid->far, and mid->far is now the LARGER of the two pops: excess over the
  // parallax floor ~4.0% at 255 m against 2.4-2.9% at 84 m, and the drive
  // ratios did not move (2.00->2.11, 2.24->2.34, 2.36->2.19). At 255 m the mid
  // bark is one or two pixels wide and can hard-switch, so there is nothing to
  // z-fight; the impostor material and the mid leaf material both alpha-test
  // already, so neither has early-Z to forfeit; and IMP_VERT already computes
  // `length(toCam)` for its own draw-distance fade, so the fade-IN is one more
  // smoothstep multiplied into `vFade` and a matching fade-OUT on the mid leaf.
  // The band would be extended OUTWARD from mid, not inward from near, so the
  // expensive LOD is not touched at all.
  //
  // What stopped it was the price, and the price is not what it looks like.
  // The band itself, 244-266 m, is 9.9% of the mid population — cheap. But the
  // binning is quantised by this constant, so the bands have to overlap by
  // `rebuildMove` on EACH side or the fade arrives in 11 m steps, which is the
  // stutter it exists to remove. In bin space that is 233-277 m, and mid then
  // runs to 277 instead of 255: (277^2 - 255^2) / (255^2 - 84^2) = +20.2% of
  // mid instances, twice the figure the band alone suggests. Mid is the most
  // numerous LOD in the game by four to one.
  //
  // +20% of the most numerous LOD, unpriced, is not a trade to make blind, and
  // it could not be priced this round: `ablate.mjs` and an independent
  // critic's own harness both disqualified themselves under machine
  // contention (baseline drift 5.1-34.6 ms, "the camper has not come to rest",
  // "HIT THE CAP — still streaming"). Whoever picks this up: the design above
  // is complete, the cost is +20.2% mid instances, and the first job is a
  // frame-time number on a quiet machine.
  rebuildMove: 11,

  capNear: 700,          // instance cap per species-variant
  capMid: 1500,
  capFar: 30000,

  impostorTileW: 192,
  impostorTileH: 288,
  // Distinct impostor silhouettes baked per species. One tile per species meant
  // every spruce past 255 m was literally the same outline pasted across a
  // hillside — the "hundreds of same-size cones" the critic counted are mostly
  // this, not the scatter.
  //
  // It is one tile per PROTOTYPE now, for the same reason the mid LOD is: with
  // two tiles a tree changed silhouette again at 255 m, because `pvar % 2`
  // chose a card baked from a different tree. The far field is still one draw
  // call and one texture, and there are fifteen more one-off bakes under the
  // loading screen.
  //
  // The atlas is a GRID — one row per species, one column per variant, so
  // `variants` columns and `SPECIES.length` rows, 960 x 1440 at these tile
  // dimensions. It is not a 25-wide strip, and that is a portability fix, not
  // a tidiness one: 25 tiles in a row is 4800 px across, three.js does not
  // clamp render-target dimensions, and MAX_TEXTURE_SIZE 4096 is ordinary on
  // integrated and mobile parts — the allocation fails there and the entire
  // far field goes with it, on a class of machine nothing in this harness can
  // boot. Both grid dimensions are inside the 2048 every WebGL2
  // implementation must support. `_bakeImpostors` clamps against the driver's
  // real limit as well, because a number in a config file is a promise and not
  // a guarantee.
  //
  // Keying the columns off `variants` also means the grid has no waste: 25
  // tiles in 25 slots, so the atlas holds exactly the texels the strip did.
  // Rows cost nothing that columns did not already cost either — the mip chain
  // blends NEIGHBOURING tiles whichever way they are packed, and at 192 x 288
  // the horizontal neighbour is the closer of the two, so a vertical neighbour
  // bleeds later than the packing that already shipped.
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

// OCCLUDE. Metres of slack added to the gate's test, in the only direction it
// is safe to err. The gate and the shader now ask the same question of the same
// number — both measure from the instance origin, one out of the matrix array
// and one out of the matrix — so this is no longer covering a difference in
// SHAPE, only in arithmetic: a tree that lands within a float of the boundary
// must not be left on the plain program while the shader is fading it by an
// epsilon. Erring wide costs a program swap on a tree that turns out not to
// fade; erring narrow costs a speckled trunk in the middle of the frame.
const OCC_SLACK = 0.25;


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
          mid: {
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
            //
            // `hull` is the third rule and it is what makes the decimation
            // safe at a boundary rather than only cheap. sqrt(keep) grows the
            // survivors to hold the crown's *area*, and area is not outline: a
            // clump on the rim grown by 1.72 pushes the silhouette out past
            // where the near LOD drew it, so the crown visibly inflates at
            // 84 m. `hull` caps each survivor's growth at the full crown's own
            // support in that clump's direction, so the interior still fills
            // in and the outline cannot move outward. Measured on the matched
            // prototypes, mid-vs-near crown width was -13% to +12% before and
            // is inside 2% after.
            //
            // sizeBoost 0.96, up from 0.86. That 0.86 was tuned when the ONLY
            // brake on the decimated crown was the boost itself, so it had to
            // trim sqrt(keep) to stop the crown inflating. `hull` is that brake
            // now and it is a far better one, because it binds at the rim and
            // nowhere else — which left 0.86 quietly shrinking the interior it
            // was never meant to touch. Rendered mid-vs-near crown AREA came
            // out at a mean of -8.6% (worst -16.2%): every mid tree in the game
            // a little thinner and more ragged than the near tree it replaces,
            // a static quality loss traded for boundary continuity nobody
            // asked for. At 0.96 the interior clumps take the growth their
            // four decimated neighbours left behind and the rim clumps do not
            // move, because `allowed` is small exactly there.
            leaf: buildLeafGeometry(tree, { keep: 4, sizeBoost: 0.96, hull: true }),
          },
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
    // OCCLUDE. The same program with the screen-door dither in it, swapped onto
    // a bark mesh only while that mesh has a trunk between the lens and the
    // camper. It costs early-Z, which is why it is a second material rather
    // than a uniform — see tree_material.js.
    this.barkOcc = createBarkMaterial(this.shared, { occlude: true });
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

    // OCCLUDE. Every slot that draws real bark, near and mid together. Mid is
    // in the list and is not a formality: at the medium tier the near radius
    // falls to 64 m while the chase boom still reaches 68, so a mid trunk can
    // stand inside the cone there. The gate costs nothing on a slot that has
    // nothing in the volume, which at ultra is every mid slot every frame.
    this._barkSlots = [...this.slots.near, ...this.slots.mid].filter(Boolean);
    // Frames of program warm-up left. See `_gateOcclusion`.
    this._occWarm = 2;
    this._occAny = false;
  }

  /** Build the bark + leaf InstancedMesh pair that share one instance block. */
  _attachNear(geoms, slot, leafMat, kind) {
    const barkGeom = geoms.bark;
    const leafGeom = geoms.leaf;

    // OCCLUDE. The prototype's bark extents used to be read off here for the
    // per-frame gate, which tested the whole bounding BOX. The volume is a
    // trunk-shaped column now and the gate tests the instance origin against it
    // directly (see `_gateOcclusion`), so there is nothing per-prototype left
    // to cache — only which program this slot is currently on.
    slot.occOn = false;

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
    const IV = CFG.variants;
    const TILES = N * IV;
    const W = CFG.impostorTileW, H = CFG.impostorTileH;

    // Grid, not strip — see the impostor note in CFG. The driver's own limit
    // gets the last word: this is the one place that can check it, and erring
    // narrow only costs a row.
    let cols = CFG.variants;                       // one row per species
    const gl = renderer.getContext();
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
    if (cols * W > maxTex) {
      cols = Math.max(1, Math.floor(maxTex / W));
      console.warn(`[trees] impostor atlas clamped to ${cols} columns by MAX_TEXTURE_SIZE ${maxTex}`);
    }
    const rows = Math.ceil(TILES / cols);
    const AW = cols * W, AH = rows * H;
    if (AH > maxTex) throw new Error(`[trees] impostor atlas ${AW}x${AH} exceeds MAX_TEXTURE_SIZE ${maxTex}`);

    const rt = new THREE.WebGLRenderTarget(AW, AH, {
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

      // v = 0 is the trunk base and a render target is not flipped, so row r
      // of the grid is viewport row r counting up from the bottom — the same
      // direction IMP_VERT reads it.
      const tx = (ti % cols) * W, ty = ((ti / cols) | 0) * H;
      rt.viewport.set(tx, ty, W, H);
      rt.scissor.set(tx, ty, W, H);
      renderer.setRenderTarget(rt);
      renderer.render(bakeScene, cam);

      this.impostorDims.push({ halfWidth: halfW, height: top });
      a.geometry.dispose(); b.geometry.dispose();
    }

    rt.scissorTest = false;
    rt.viewport.set(0, 0, AW, AH);
    rt.scissor.set(0, 0, AW, AH);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);

    this.impostorTex = rt.texture;
    this._impostorRT = rt;

    this.impostorMat = createImpostorMaterial(
      this.impostorTex, this.shared, { cols, rows }, [CFG.farDist * 0.80, CFG.farDist], AW);
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
          // Which baked silhouette this tree wears in the far field: this
          // tree's OWN prototype, so the outline it wears past 255 m is the
          // one it wore at 254. It used to be `vi % impVariants`, which is
          // the same substitution the mid LOD was making and produced the
          // same defect a hundred and seventy metres further out.
          const ti = si * CFG.variants + vi;
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

    // ── the mix, re-based on critic pass 6 §3 ────────────────────────────────
    //
    // The previous set of weights was written to fix "the eye-level frames
    // measured 0.0% yellow against the plates' 7.9%". It fixed it and then some.
    // Measured on the shipped `forest` frame, 28.6% of chromatic pixels are
    // yellow or yellow-green; on the archived full-resolution round it is 43%.
    // Against the plates *individually* — which is what the brief asks for, and
    // the averaging error is exactly how the 7.9% figure was arrived at:
    //
    //     plate    red   orange  yellow  y-grn
    //       1     51.8    38.4     4.8    3.1
    //       2     37.7    47.6     6.7    1.4
    //       3     37.3    24.5     2.3    0.3     <- eye-level reference
    //       5     47.6    39.2     0.1    0.0
    //     ours     8.6    48.5     8.3   20.3
    //
    // So the error is not really the yellow. It is that **red is missing**:
    // 8.6% against plate 3's 37.3%, in an autumn game. Every reference plate
    // puts crimson and rust crowns in its near field; a census of the `forest`
    // framing found maple at 4% of trees and oak at 0.4%, i.e. the only two
    // species in the set that carry any red are together 5% of the forest.
    // Birch and aspen — which between them carry every gold and lime note —
    // were 47%, and spruce 48%.
    //
    // Birch and aspen come down, the two red species come up, and the two
    // riparian bonuses stay because they are what plants a bank.
    // The numbers below are the SECOND pass. The first raised maple to 0.92 and
    // measured the result: maple went from 4% of the trees in the forest
    // framing to 56%, birch fell 27% -> 6% and aspen 29% -> 6%. That is not a
    // fix, it is the same monoculture in a different colour, and it is exactly
    // the shape of the overshoot that produced the 43% yellow in the first
    // place. Red comes up by about a third, not by double, and the admixture
    // below does the rest of the work.
    w[0] = (0.60 * (0.35 + wet) * (1 - smoothstep(150, 225, h))) + river * 0.78;       // birch
    w[1] = (0.48 * (0.30 + wet) * (1 - smoothstep(140, 205, h))) + river * 0.46;       // aspen
    // Maple is the crimson. Its altitude window was the tightest of the five and
    // it had no business being so: a maple at 150 m is an ordinary thing and
    // three of our ten views stand above 100 m.
    w[2] = 0.60 * (0.45 + wet * 0.85) * (1 - smoothstep(130, 205, h)) + river * 0.62;  // maple
    // Oak carries the rusts and bronzes and was effectively absent from every
    // frame — 0.4% of trees in the forest census, and 1% of the far field. It
    // genuinely prefers drier ground, but at (1.05 - wet * 0.45) that preference
    // was strong enough to exclude it from closed canopy entirely, which is
    // where the plates put their bronze crowns. It also needs its own regional
    // sharpening (below) or maple simply outbids it everywhere at once and the
    // whole red family collapses onto a single palette.
    w[3] = 0.88 * (0.98 - wet * 0.26) * (1 - smoothstep(105, 180, h));                 // oak
    // Spruce is the value anchor of the palette — the only deep, cool, dark
    // mass in a frame that is otherwise entirely hot. Confining it to the
    // treeline (which the altitude term alone does) leaves the valley with
    // nothing to read against, so it keeps a floor at every height and wins
    // outright wherever its regional bias is strong.
    //
    // What moved is the *moisture* term, and this is where the forest view's
    // problem actually lives. At (0.55 + wet * 0.7) spruce got its single
    // largest boost from wet ground — which is the same ground the density
    // field turns into closed canopy, which is where the `forest` anchor
    // resolves. So the one framing in the game that exists to photograph a
    // forest interior was guaranteed to be the most conifer-heavy place in the
    // world. The plates do not do that: their conifers stand on slopes,
    // ridgelines and the treeline, and their valley floors are deciduous. The
    // altitude and slope terms come up to compensate, so a spruce stand at
    // height is slightly *stronger* than before and the wet valley floor is
    // about a quarter weaker.
    //
    // Measured, `forest` at res 1024, this line and nothing else changed. The
    // frame it fixes had a single near spruce standing in the wet valley floor
    // directly in front of the camera, occluding most of the right half — that
    // one tree is the bulk of the number the critic filed:
    //
    //                     before   after   plate 3
    //     yellow + y-grn    24.5%    7.8%     2.6%
    //     red               22.5%   29.5%    37.3%
    //     chromaMean        0.248   0.274    0.307
    //     vividPct           25.1    35.4     31.2
    //
    // In-frustum species census on the same framing, spruce as a share of the
    // trees the frame actually contains: 0-40 m 57% -> 46%, 90-200 m 33% ->
    // 28%, 200-600 m 45% -> 35%. (The two inner bands hold ~10 trees each, so
    // only the outer two carry any weight; note also that species and spacing
    // are coupled — `_canPlace` uses the species' crown radius — so the band
    // totals shift by a tree or two as well.)
    //
    // `backlit` was captured in the same pair as a regression check and moved
    // the same way, not the opposite way: red 58.9% -> 70.3% against plate 4's
    // 100%, yellow 7.8% -> 3.5%, chromaMean 0.375 -> 0.380.
    //
    // What this does NOT do is re-tint anything. Critic pass 6 killed the
    // 'conifers are green-led where the reference is red-led' diagnosis with a
    // fog-off test: plate 3's conifer measured tight on the needles is
    // 1 : 1.13 : 0.63 and ours is 1 : 1.14 : 0.62. The needle hue matches. The
    // fault was only ever how many of them stood in this particular valley.
    w[4] = (0.62 + 1.35 * high + smoothstep(0.5, 1.0, slope) * 0.75) * (0.72 + wet * 0.34);

    let best = -1, bi = 0, redBest = -1, ri = -1;
    for (let s = 0; s < S; s++) {
      // Regional preference, squared for the clonal species so aspen forms the
      // pure single-colour groves it does in life.
      let b = bias[dfIdx * S + s];
      if (SPECIES[s].clonal) b = b * b * 1.6;
      if (SPECIES[s].key === 'birch') b = b * b * 1.5;
      if (SPECIES[s].key === 'oak') b = b * b * 1.4;
      // Conifer stands are large and near-pure in the reference plates, never
      // one spruce salted through a birch wood. Sharpening the bias turns the
      // regional field into a hard stand boundary.
      if (SPECIES[s].conifer) b = b * b * 1.75;
      const v = w[s] * (0.18 + 1.9 * b) * (0.8 + 0.4 * rng());
      if (v > best) { best = v; bi = s; }
      // Best red-bearing runner-up, for the admixture below. Maple and oak are
      // the only two species whose palettes reach the red sixth of the wheel.
      if (RED_SPECIES[s] && v > redBest) { redBest = v; ri = s; }
    }

    // ── admixture ────────────────────────────────────────────────────────────
    //
    // The argmax above is winner-take-all, and the conifer's b*b*1.75 makes its
    // stands not merely large but *pure*: the `forest` framing came back 100%
    // spruce inside 40 m and 40% spruce at 90-200 m with one crimson crown in
    // the whole frame. A pure conifer stand has no autumn in it by construction,
    // and no grade or shading change can put colour in that the scatter did not.
    //
    // Plate 3 does not show a pure conifer stand. It shows conifers as dark
    // punctuation *inside* a warm canopy. So a fraction of the trees a conifer
    // stand would have taken go to the best red-bearing species instead. The
    // fraction is driven by maple's own regional field, so some stands stay
    // pure dark spruce — that mass is the palette's only cool anchor and losing
    // it would trade one systematic error for another — while others read as a
    // genuinely mixed wood.
    if (ri >= 0 && SPECIES[bi].conifer) {
      const admix = 0.40 * smoothstep(0.22, 0.86, bias[dfIdx * S + 2]);
      if (rng() < admix) bi = ri;
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
            // Same species AND the same variant as the near LOD. Anything
            // else and the tree changes identity at 84 m — see `variants`.
            this._push(mid[T.pspec[t] * V + T.pvar[t]], T, t);
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

  /**
   * Trunks standing within `r` of a point, as [{ x, z, radius }].
   *
   * Added for the Camp system, which has to refuse to pitch a tent inside a
   * tree — the one failure in that feature nobody would forgive. Uses the
   * placement bucket grid rather than scanning the whole population, so it is
   * cheap enough to call every frame while the player is aiming: a 5 m query
   * touches at most four 32 m buckets and typically returns in under 40 tests.
   *
   * `radius` is the trunk radius at the base, not the crown. A camp under a
   * canopy is a good camp; a camp inside a bole is not.
   */
  trunksNear(x, z, r) {
    const T = this.trees;
    if (!T) return [];
    const out = [];
    const { px, pz, pscale, pspec, BW, BS, half } = T;
    const gx0 = Math.max(0, Math.floor((x - r + half) / BS));
    const gx1 = Math.min(BW - 1, Math.floor((x + r + half) / BS));
    const gz0 = Math.max(0, Math.floor((z - r + half) / BS));
    const gz1 = Math.min(BW - 1, Math.floor((z + r + half) / BS));
    const r2 = r * r;
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const b = gz * BW + gx;
        for (let i = T.bucketStart[b]; i < T.bucketStart[b + 1]; i++) {
          const t = T.order[i];
          const dx = px[t] - x, dz = pz[t] - z;
          if (dx * dx + dz * dz > r2) continue;
          const sp = SPECIES?.[pspec[t]];
          out.push({ x: px[t], z: pz[t], radius: (sp?.trunkRadiusK ?? 0.05) * pscale[t] * 3.2 });
        }
      }
    }
    return out;
  }

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
      // The unit changed, so this number is not comparable to the 1.10 / 2.40
      // it replaces: transmitted light is no longer multiplied by the leaf's
      // albedo (see the transmission block in tree_material.js), so the colour
      // it scales is about eight times brighter on a conifer and about twice on
      // a gold aspen.
      //
      // Set by sweep on the `backlit` crowns, transmission+rim on minus off,
      // interleaved inside one page load. Re-run rather than inherited, because
      // the table this replaces was quoted at a depth that also moved; these
      // are at the shipped uTransDepth 0.7. Mean luma over the near maple crown
      // (floor, transmission+rim off, = 0.3192) and over the mid-ground crowns
      // (floor 0.4112). A repeat of the 1.75 step landed at 0.4436 against
      // 0.4432, so 0.09% is the noise on these numbers:
      //
      //     strength      0.95    1.40    1.75    2.30
      //     near crown   +16.5%  +31.4%  +38.8%  +50.1%
      //     brightest
      //     crown pixel   0.774   0.772   0.825   0.921
      //
      // The sky in this frame maxes at 0.868, so 2.30 puts crown pixels ABOVE
      // the sky behind them — a crown that has stopped being a silhouette, and
      // in the picture the stand starts dissolving into the haze. 1.75 is the
      // top of the range that holds the relationship plate 3 holds, and it is
      // where the previous author landed; this reproduces their choice on
      // numbers I took myself, and finds the ceiling half a stop lower than
      // they quoted it.
      //
      // 0.95 — what HEAD shipped — delivers 16.5%, well under half. That is the
      // difference between a crown that glows and one that is merely not black.
      u.uTransStrength.value = lerp(0.85, 1.75, lowSun);
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
    this._gateOcclusion();
  }

  /**
   * OCCLUDE — pick the bark program for each instanced mesh, once a frame.
   *
   * Runs in lateUpdate and that is load-bearing: main.js calls
   * `setOcclusionTarget` at the END of the update pass, so a gate in `update()`
   * would be aiming at where the camper was last frame. lateUpdate is after
   * every updater and before the render, so this reads the same volume the
   * shader is about to.
   *
   * Per MESH, not per instance, because a program is a property of a draw call:
   * one trunk in the frustum puts that slot's whole near band — one species,
   * one prototype, inside 84 m, typically a couple of dozen trunks — on the
   * discarding program for as long as it is in the way. That is the unit of
   * granularity this system can offer without a second instance block, and it
   * is 50x finer than the alternative of switching all bark at once.
   *
   * The scan itself is a plan-distance reject on every drawn instance, and the
   * volume never reaches past the chase boom, so in open country it rejects
   * everything on the first compare and in a forest it stops at the first
   * instance that qualifies. Measured over 2075 frames of driving through wood
   * (tools/_scratch/occgate.mjs): p50 0.0 ms, p95 0.1 ms, worst 0.2 ms, with a
   * mean of 38 instances of 1176 drawn on the expensive program.
   *
   * ── why the swap itself cannot pop ──────────────────────────────────────
   *
   * The gate and the shader ask the identical question — `occlusionTouchesColumn`
   * against the instance origin, which is what `occludeFadeColumn` measures from
   * in BARK_VERT — so the program turns on at the exact distance the fade starts
   * having something to do. At the moment of either swap the tree sits at
   * `nearNone`, where the fade is 1.0 and `occludeCut` discards nothing, so the
   * two programs render the same pixels there. That is what makes a per-frame
   * material swap safe on a surface the player is looking straight at, and it is
   * why the slack in OCC_SLACK is spent outward and never inward.
   */
  _gateOcclusion() {
    const slots = this._barkSlots;
    if (!slots) return;

    // Program warm-up. The occluding variant is a second program and it compiles
    // the first time something is drawn with it; discovering that at the moment
    // a trunk crosses in front of the camper would put the compile stall exactly
    // where the player is looking. So the first rendered frame draws all bark
    // through it — one frame, behind the loading fade, alongside every other
    // first-frame compile — and the second frame hands it back.
    if (this._occWarm > 0) {
      const on = this._occWarm === 2;
      for (const s of slots) { s.occOn = on; s.meshes[0].material = on ? this.barkOcc.mat : this.bark.mat; }
      this._occWarm--;
      return;
    }

    const active = occlusionActive();
    if (!active && !this._occAny) return;      // nothing on, nothing to turn off

    let any = false;
    for (const s of slots) {
      let on = false;
      if (active && s.count) {
        const m = s.matrix.array;
        for (let k = 0; k < s.count; k++) {
          const o = k * 16;
          // The instance's foot, straight out of the matrix — the same three
          // numbers the vertex shader gets from `instanceMatrix`, which is what
          // makes this an exact mirror rather than a conservative one.
          if (occlusionTouchesColumn(m[o + 12], m[o + 13], m[o + 14],
                                     OCC_SLACK)) { on = true; break; }
        }
      }
      if (on !== s.occOn) {
        s.occOn = on;
        s.meshes[0].material = on ? this.barkOcc.mat : this.bark.mat;
      }
      any = any || on;
    }
    this._occAny = any;
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
    for (const k of ['leafNear', 'leafMid', 'bark', 'barkOcc', 'leafBake', 'barkBake']) {
      this[k]?.mat?.dispose(); this[k]?.depth?.dispose();
    }
    this.impostorMat?.mat?.dispose();
  }
}
