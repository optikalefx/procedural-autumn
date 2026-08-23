// ─────────────────────────────────────────────────────────────────────────────
//  Object Gallery — discovery.
//
//  The point of this file is that NOBODY HAS TO EDIT IT when a new prop is
//  authored. A gallery maintained by hand is a gallery that is wrong within a
//  week, and a wrong gallery is worse than none: it is the same class of blind
//  spot as a harness that measures something the player never runs.
//
//  So the page discovers its own contents, three ways, in this order:
//
//   1. THE GLOB. `import.meta.glob` pulls in every module under src/ except a
//      small denylist of engine plumbing (see MODULES). A new folder of props
//      is included by DEFAULT — the denylist names what is excluded, never what
//      is included, so the failure mode is "the gallery shows one module too
//      many", which is visible, rather than "the gallery quietly misses your
//      work", which is not.
//
//   2. THE CONVENTION. Every prop in this project is authored as
//      `build<Thing>(rnd, opts) -> THREE.Group` (camp_chair, camp_tent,
//      camp_table, camp_cooler, camp_fire's woodpile …). Any export matching
//      that shape is probed, and if it hands back a real object it is listed.
//      Write `buildLantern` in `src/camp/camp_lantern.js` tomorrow and it is in
//      the gallery with no edit here. If the module also exports
//      `LANTERN_COLORWAYS` — the other convention this project already keeps —
//      every colourway becomes a selectable variant automatically.
//
//   3. THE ADAPTERS. Four families are not single-call builders: trees, rocks,
//      ground cover and animals are TABLES of species/archetypes turned into
//      instanced or skinned meshes by a family-specific assembly step. An
//      adapter knows that assembly. It does NOT know the contents: it walks the
//      family's own table, so adding a species to `SPECIES` or an archetype to
//      `ARCHETYPES` shows up here for free, which is how those families
//      actually grow.
//
//  And when all three miss something, the page SAYS SO. Everything that looks
//  like an object producer and did not get rendered is reported, with the
//  reason, in the "Not shown" panel. The gallery is allowed to be incomplete;
//  it is not allowed to be silently incomplete.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mulberry32 } from '../../core/MathUtils.js';
import { SEED } from '../../world/WorldConfig.js';

// ── the glob ─────────────────────────────────────────────────────────────────
//
// Denylist, not an allowlist — see the header. The excluded paths are engine
// plumbing that owns no drawable prop of its own (core, render, ui, audio, sky,
// shaders, world) plus three specific files:
//
//   · main.js          — importing it boots the game.
//   · worldWorker.js   — a worker entry; importing it from the page is wrong.
//   · VehiclePhysics / RockColliders — `import RAPIER from
//     '@dimforge/rapier3d-compat'` at module scope. That is a megabyte of
//     base64 wasm this page has no use for, and it is served unbundled (see
//     optimizeDeps.exclude in vite.config.js). Both are reported in the
//     "Not shown" panel so the exclusion is visible rather than assumed.
//
// If you add a folder of props, you do not need to touch this.
const MODULES = import.meta.glob([
  '/src/**/*.js',
  '!/src/main.js',
  '!/src/core/**',
  '!/src/render/**',
  '!/src/ui/**',
  '!/src/audio/**',
  '!/src/sky/**',
  '!/src/shaders/**',
  '!/src/world/**',
  '!/src/tools/**',
  '!/src/vehicle/VehiclePhysics.js',
  '!/src/vehicle/RockColliders.js',
], { eager: true });

/** Paths excluded above that are worth naming out loud on the page. */
const EXCLUDED = [
  ['/src/vehicle/VehiclePhysics.js', 'imports Rapier at module scope — a megabyte of wasm this page never uses'],
  ['/src/vehicle/RockColliders.js', 'imports Rapier at module scope — a megabyte of wasm this page never uses'],
  ['/src/world/Terrain.js', 'needs a baked world; the terrain is the game, not a prop'],
  ['/src/world/Water.js', 'needs a baked world — river surfaces are placed from the flow field'],
  ['/src/world/Waterfalls.js', 'needs a baked world — falls come out of the bake header'],
];

// ── live uniform blocks ──────────────────────────────────────────────────────
//
// The families below do their shading in custom programs whose sun, sky and
// time come in as uniforms rather than from three's light list. The stage has
// to be able to move the sun and run the clock for ALL of them at once, so the
// adapters register their blocks here rather than the stage reaching into each
// family. Anything not registered simply lights off the stage's real lights,
// which is the case for every MeshStandardMaterial prop.
export const SUN_TARGETS = [];    // fn(THREE.Vector3 dir, THREE.Color color)
export const TIME_TARGETS = [];   // uniform objects carrying a `uTime`

/** Everything the adapters need from the page to build. */
export const BUILD_CTX = { renderer: null };

// ─────────────────────────────────────────────────────────────────────────────
//  Small shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A group name that survives being read at a glance in a sidebar. */
const GROUP_LABEL = {
  camp: 'Camp',
  vegetation: 'Vegetation',
  wildlife: 'Wildlife',
  rocks: 'Rocks',
  vehicle: 'Vehicle',
};

const folderOf = (path) => path.split('/')[2] ?? 'misc';
const groupOf = (path) => GROUP_LABEL[folderOf(path)] ?? titleCase(folderOf(path));
const fileOf = (path) => path.split('/').pop();

function titleCase(s) {
  return s.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

/** `buildCampChair` -> `Camp chair`. The label a human wants on a card. */
function labelFromBuilder(name) {
  return titleCase(name.replace(/^build/, ''));
}

/**
 * One InstancedMesh holding exactly one instance, with a per-instance attribute
 * block filled in.
 *
 * Every instanced family in this project shades from `instanceMatrix` and from
 * its own instance attributes, so a plain `THREE.Mesh` of the same geometry
 * does not compile — and where it does, it draws untinted. This is the same
 * trick `Trees._bakeImpostors` uses to photograph one prototype, and it is the
 * only honest way to show an instanced prop: what you see is the real program
 * with real instance data, not an approximation of it.
 */
function singleInstance(geometry, material, attrs) {
  const g = geometry.clone();
  for (const [name, values] of Object.entries(attrs)) {
    g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(values), values.length));
  }
  const mesh = new THREE.InstancedMesh(g, material, 1);
  mesh.setMatrixAt(0, new THREE.Matrix4());
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Family adapter — trees
// ─────────────────────────────────────────────────────────────────────────────
//
// Walks `SPECIES` from tree_species.js. Add a species there and it appears
// here; the variant count is the same `CFG.variants` the game grows.

const TREE_VARIANTS = 5;   // Trees.js CFG.variants

let _treeKit = null;
async function treeKit() {
  if (_treeKit) return _treeKit;
  const [{ buildClusterAtlas }, { buildBarkGeometry, buildLeafGeometry }, mat] = await Promise.all([
    import('../../vegetation/tree_textures.js'),
    import('../../vegetation/tree_geometry.js'),
    import('../../vegetation/tree_material.js'),
  ]);
  const shared = mat.makeSharedUniforms();
  // Same atlas resolution the game uses, so a leaf card in this page is the
  // exact texture the player sees rather than a cheaper stand-in.
  const atlas = buildClusterAtlas(SEED & 0xffff, 448);
  const leaf = mat.createLeafMaterial(atlas, shared, { alphaTest: 0.40, atlasTexels: 896 });
  const bark = mat.createBarkMaterial(shared);

  TIME_TARGETS.push(shared);
  SUN_TARGETS.push((dir, col) => {
    shared.uSunDir.value.copy(dir);
    shared.uSunColor.value.copy(col);
  });

  _treeKit = { buildBarkGeometry, buildLeafGeometry, leaf, bark };
  return _treeKit;
}

function treeEntries(mod, path) {
  const out = [];
  mod.SPECIES.forEach((sp, si) => {
    for (let vi = 0; vi < TREE_VARIANTS; vi++) {
      out.push({
        id: `tree:${sp.key}:${vi}`,
        label: titleCase(sp.key),
        sub: `variant ${vi + 1}`,
        group: groupOf(path),
        family: 'Trees',
        file: path,
        call: `growTree(SPECIES[${si}], seed) → buildBarkGeometry / buildLeafGeometry`,
        // The tree's own seed is what a re-roll rolls. Everything else about a
        // species is the table — including its palettes, which become the
        // colourway selector without anyone listing them.
        seeded: true,
        colorways: sp.palettes?.length > 1 ? { key: 'palettes', count: sp.palettes.length } : null,
        async build(seed, opts = {}) {
          const kit = await treeKit();
          const tree = mod.growTree(sp, (seed ^ 0x51ed) + si * 7919 + vi * 104729);
          const root = new THREE.Group();

          // COLOUR IS INSTANCE DATA, and getting this wrong is not subtle: the
          // first cut passed 1,1,1 for aColA/aColB on the theory that neutral
          // instance data would let "the species' own colours" through. There
          // are no species colours in the material — the leaf shader mixes
          // between the two instanced hues and multiplies, so every tree in the
          // gallery came out bone white. The scatter picks one of the species'
          // palette pairs per tree (Trees._buildPlacement); so does this.
          const pal = sp.palettes[(opts.colorway ?? 0) % sp.palettes.length];
          const cA = [pal[0].r, pal[0].g, pal[0].b];
          const cB = [pal[1].r, pal[1].g, pal[1].b];
          const bk = [sp.barkColor.r, sp.barkColor.g, sp.barkColor.b];
          // Phase, stiffness — the same pair the scatter writes. Slender trees
          // whip, conifers barely move.
          const wind = [vi * 1.1, sp.conifer ? 0.45 : 0.95];

          root.add(singleInstance(
            kit.buildBarkGeometry(tree, sp, { radialSegs: 4, maxLevel: 2 }),
            kit.bark.mat, { aColA: bk, aWind: wind },
          ));
          root.add(singleInstance(
            kit.buildLeafGeometry(tree, { keep: 1 }),
            kit.leaf.mat, { aColA: cA, aColB: cB, aWind: wind },
          ));
          return {
            root,
            notes: [
              `${tree.height.toFixed(1)} m grown height`,
              `${tree.clusters.length} leaf clumps`,
              `${tree.strands.length} branch strands`,
              `palette ${(opts.colorway ?? 0) + 1} of ${sp.palettes.length}`,
            ],
          };
        },
      });
    }
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Family adapter — rocks
// ─────────────────────────────────────────────────────────────────────────────

let _rockKit = null;
async function rockKit(mod) {
  if (_rockKit) return _rockKit;
  const { createRockMaterial } = await import('../../rocks/RockMaterial.js');
  const material = createRockMaterial();
  const u = material.userData.uniforms;
  if (u) {
    TIME_TARGETS.push(u);
    SUN_TARGETS.push((dir, col) => {
      u.uSunDir?.value.copy(dir);
      u.uSunTint?.value.copy(col);
    });
  }
  _rockKit = { material, library: mod.buildRockLibrary(SEED) };
  return _rockKit;
}

function rockEntries(mod, path) {
  const out = [];
  for (const [arch, spec] of Object.entries(mod.ARCHETYPES)) {
    for (let v = 0; v < spec.variants; v++) {
      out.push({
        id: `rock:${arch}:${v}`,
        label: titleCase(arch),
        sub: `variant ${v + 1}`,
        group: groupOf(path),
        family: 'Rock forms',
        file: path,
        call: `buildRockLibrary(SEED).${arch}[${v}]`,
        async build() {
          const kit = await rockKit(mod);
          const geo = kit.library[arch][v];
          geo.computeBoundingBox();
          const size = geo.boundingBox.getSize(new THREE.Vector3());
          const root = new THREE.Group();
          root.add(singleInstance(geo, kit.material, {
            // wetness, moisture, tint jitter, size in metres — see the
            // attribute comments in RockMaterial.js. A dry rock on a dry slope.
            aRockA: [0, 0.35, 0.5, Math.max(size.x, size.z)],
            // water surface Y (far below), frost, ground Y under the instance
            aRockB: [-9999, 0, 0],
            // ground gradient under the rock: flat, for a studio
            aRockC: [0, 0],
          }));
          return {
            root,
            notes: [`${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} m`],
          };
        },
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Family adapter — ground cover
// ─────────────────────────────────────────────────────────────────────────────
//
// Colour is the awkward part here and it is worth being straight about it. A
// cover plant's two palette colours are chosen by the SCATTER, at placement,
// from moisture and an RNG — `cover_scatter.js` has thirty-odd such choices and
// several are conditional on the ground the plant is standing on. There is no
// function to ask "what colour is a reed", so a gallery cannot simply call one.
//
// Rather than hard-code a copy of those thirty choices (which would be wrong
// the first time somebody edits the scatter), the default here is derived by
// NAME from the scatter's own exported palette: archetype `reed` takes the
// `reedDeep`/`reedLit` pair, `sedge` takes `sedgeDeep`/`sedgeTip`, and so on.
// New archetypes that follow the same naming get a sensible colour for free.
// Where the name does not resolve, an alias covers it, and the stage offers the
// whole palette in a dropdown so any pair can be tried.

// An explicit pair wins; anything else falls to the prefix search below. These
// are the archetypes whose name shares no stem with its colour — a `log` is
// painted `barkGrey`, an `aster` grows on a `stem` — and there is no rule that
// can be inferred from the names alone.
const COVER_ALIAS = {
  shrubBerry: ['berryLeaf', 'berry'],
  flowerAster: ['stem', 'aster'],
  goldenrod: ['stem', 'goldenrod'],
  seedHead: ['stemDry', 'seedTip'],
  leafDrift: ['litterWarm', 'litterGold'],
  leafScatter: ['litterWarm', 'litterGold'],
  deadTuft: ['strawDeep', 'strawPale'],
  log: ['barkGrey', 'moss'],
  stump: ['barkGrey', 'moss'],
  branch: ['barkGrey', 'moss'],
  pebble: ['stoneDeep', 'stoneLit'],
  cobble: ['stoneDeep', 'stoneLit'],
  groundMat: ['matDamp', 'matDampLit'],
  thicket: 'shrub',
};

const luma = (c) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;

/**
 * Pick the (deep, lit) pair for an archetype out of the scatter's palette.
 *
 * LONGEST PREFIX, then luminance. Both halves are corrections of a first cut
 * that looked reasonable and was wrong on real data:
 *
 *  · Matching the archetype key as a whole prefix (`scrubDry` against
 *    `scrubBase`) matches nothing, and `scrubDry` — one of the most numerous
 *    things in the meadow — rendered pure white. Shortening the key one
 *    character at a time until something matches finds `scrub*` on the fourth
 *    try and costs nothing.
 *  · Choosing the ends by suffix (`*Deep`, `*Lit`) only works where the palette
 *    happens to spell them that way. `moss` and `mossDeep` have no such suffix
 *    on the light end, so the "lit" colour came out as the darker of the two.
 *    Sorting the matches by luminance needs no naming convention at all.
 *
 * Returns null when nothing matches, which the caller renders as plain white —
 * an honest "no colour known" rather than an invented one.
 */
function coverPair(archKey, palette) {
  const names = Object.keys(palette);
  const alias = COVER_ALIAS[archKey];
  if (Array.isArray(alias)) {
    const [deep, lit] = alias;
    if (palette[deep] && palette[lit]) return { deep, lit };
  }

  // Shorten the key a character at a time until it matches a palette stem,
  // preferring the shortest prefix that matches a PAIR: `shrubd` matches only
  // `shrubDeep` and would hand back one colour for both ends, where `shrub`
  // matches the four that make up the shrub family.
  const stem = (typeof alias === 'string' ? alias : archKey).toLowerCase();
  let pre = null, hits = [];
  for (let n = stem.length; n >= 3; n--) {
    const cand = stem.slice(0, n);
    const found = names.filter((k) => k.toLowerCase().startsWith(cand));
    if (!found.length) continue;
    if (!hits.length) { pre = cand; hits = found; }     // the longest that matched at all
    if (found.length >= 2) { pre = cand; hits = found; break; }
  }
  if (!hits.length) return null;

  // The palette names its own pairs — <stem>Deep/Base against
  // <stem>Lit/Tip/Gold — so use that where it exists and fall back to
  // luminance where it does not (`moss` has no light-end suffix at all).
  const exact = (sfx) => names.find((k) => k.toLowerCase() === pre + sfx);
  const byLuma = [...hits].sort((a, b) => luma(palette[a]) - luma(palette[b]));
  const deep = ['deep', 'base', ''].map(exact).find(Boolean) ?? byLuma[0];
  let lit = ['lit', 'tip', 'gold', 'pale'].map(exact).find(Boolean) ?? byLuma[byLuma.length - 1];
  if (lit === deep) lit = byLuma[byLuma.length - 1];
  return { deep, lit };
}

let _coverKit = null;
async function coverKit(mod) {
  if (_coverKit) return _coverKit;
  const [cm, scatter] = await Promise.all([
    import('../../shaders/cover_material.js'),
    import('../../vegetation/cover_scatter.js'),
  ]);
  const uniforms = cm.makeCoverUniforms();
  TIME_TARGETS.push(uniforms);
  SUN_TARGETS.push((dir, col) => {
    uniforms.uSunDir.value.copy(dir);
    uniforms.uSunColor.value.copy(col);
  });
  _coverKit = {
    uniforms,
    palette: scatter.COVER_PALETTE,
    solid: cm.createCoverMaterial(uniforms, false),
    card: cm.createCoverMaterial(uniforms, true),
    matmat: cm.createCoverMaterial(uniforms, true, true),
    library: mod.buildCoverLibrary(SEED),
  };
  return _coverKit;
}

function coverEntries(mod, path) {
  const out = [];
  mod.COVER_ARCHETYPES.forEach((arch, ai) => {
    for (let v = 0; v < arch.variants; v++) {
      out.push({
        id: `cover:${arch.key}:${v}`,
        label: titleCase(arch.key),
        sub: `variant ${v + 1}`,
        group: groupOf(path),
        family: 'Ground cover',
        file: path,
        call: `buildCoverLibrary(SEED).geoms[${ai}][${v}]`,
        // The stage fills this in once the kit exists; see palette() below.
        palette: () => coverKit(mod).then((k) => ({
          all: k.palette, pair: coverPair(arch.key, k.palette),
        })),
        async build(_seed, opts = {}) {
          const kit = await coverKit(mod);
          const geo = kit.library.geoms[ai][v];
          const pair = coverPair(arch.key, kit.palette);
          const cA = kit.palette[opts.colA ?? pair?.deep] ?? new THREE.Color(1, 1, 1);
          const cB = kit.palette[opts.colB ?? pair?.lit] ?? new THREE.Color(1, 1, 1);
          const mat = arch.nearFade ? kit.matmat : (arch.card ? kit.card : kit.solid);
          const root = new THREE.Group();
          const mesh = singleInstance(geo, mat, {
            aColA: [cA.r, cA.g, cA.b],
            aColB: [cB.r, cB.g, cB.b],
            // wind amplitude, phase, brightness, visibility radius. The radius
            // is what `aCov.w` fades against, and a studio is always inside it.
            aCov: [arch.wind ?? 0.03, 0, 1, 400],
            aWindDir: [1, 0],
          });
          mesh.castShadow = !!arch.shadow;
          mesh.receiveShadow = arch.recv !== false;
          root.add(mesh);
          return {
            root,
            notes: [
              `${geo.userData.tris} triangles`,
              `drawn to ${arch.vis} m`,
              `cap ${arch.cap} instances`,
              pair ? `palette ${pair.deep} → ${pair.lit}` : 'no palette match — shown white',
            ],
          };
        },
      });
    }
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Family adapter — animals
// ─────────────────────────────────────────────────────────────────────────────
//
// The only family here that MOVES. An animal is a SkinnedMesh driven by
// `AnimRig`, and a bind-pose deer tells you nothing about whether the gait
// works — which is most of what anyone would open a gallery to look at. The rig
// only needs `world.getHeight`, so a flat stub stands in for the valley, and
// the animal walks on a treadmill: the drive position advances so stride and
// cadence are exactly what the game computes, and the holder counter-translates
// so the subject stays under the camera. No skating, no faked cycle.

const ANIMAL_POSES = [
  { key: 'stand', label: 'Stand', speed: 0, graze: 0, alert: 0 },
  { key: 'graze', label: 'Graze', speed: 0, graze: 1, alert: 0 },
  { key: 'alert', label: 'Alert', speed: 0, graze: 0, alert: 1 },
  { key: 'walk', label: 'Walk', speed: 1.0, graze: 0, alert: 0 },
  { key: 'trot', label: 'Trot', speed: 3.0, graze: 0, alert: 0.3 },
  { key: 'run', label: 'Run', speed: 8.0, graze: 0, alert: 1 },
];

const FLAT_WORLD = { getHeight: () => 0 };

function animalEntries(mod, path) {
  const out = [];
  for (const [key, sp] of Object.entries(mod.SPECIES)) {
    sp.variants.forEach((v, vi) => {
      out.push({
        id: `animal:${key}:${vi}`,
        label: titleCase(key),
        sub: v.name,
        group: groupOf(path),
        family: 'Animals',
        file: path,
        call: `instantiate(buildSpecies('${key}', SEED)[${vi}], hide)`,
        poses: ANIMAL_POSES,
        async build(_seed, opts = {}) {
          const { instantiate } = await import('../../wildlife/animal_rig.js');
          const { AnimRig } = await import('../../wildlife/animal_anim.js');
          const proto = mod.buildSpecies(key, SEED)[vi];
          const hide = mod.createHideMaterial(v.col);
          const inst = instantiate(proto, hide, 0);
          const rig = new AnimRig(proto, inst, v.scale, sp.gait, key);

          const root = new THREE.Group();
          root.add(inst.mesh);

          const pose = ANIMAL_POSES.find((p) => p.key === (opts.pose ?? 'stand')) ?? ANIMAL_POSES[0];
          const pos = new THREE.Vector3(0, 0, 0);
          const drive = {
            pos, heading: 0, speed: pose.speed * v.scale,
            graze: pose.graze, alert: pose.alert, flag: 0, look: null, lod: 0,
          };
          // The treadmill: the belt moves, not the animal. `AnimRig` plants
          // feet at absolute `drive.pos`-space points but solves the leg IK
          // through `parent.matrixWorld` — so the old trick of letting `pos`
          // run and counter-translating the holder split those two spaces
          // apart by exactly `pos.z`, and after a few metres of walking every
          // IK target was metres ahead of the body and the legs clamped into
          // a horizontal reach. (The head solve round-trips through the same
          // matrices, so it cancelled and never showed the bug.) Instead,
          // rebase before each step: pull the accumulated advance out of
          // `pos` AND out of the rig's world-anchored foot state, so the
          // animal stays at the origin and the anchors slide back under it —
          // a real conveyor belt. Stride and cadence still come from real
          // ground speed, and stance feet still never skate on the belt.
          const rebase = () => {
            const dz = pos.z;
            if (dz === 0) return;
            pos.z = 0;
            for (const lg of rig.legs) {
              lg.foot.z -= dz; lg.anchor.z -= dz; lg.from.z -= dz; lg.to.z -= dz;
            }
          };
          // Prime a couple of cycles so the first frame shown is mid-gait
          // rather than the reset pose stepping into it.
          rig.update(0.016, drive, FLAT_WORLD);
          for (let i = 0; i < 60 && drive.speed > 0; i++) {
            rebase();
            pos.z += drive.speed * 0.016;
            rig.update(0.016, drive, FLAT_WORLD);
          }

          return {
            root,
            update(dt) {
              rebase();
              pos.z += drive.speed * dt;
              rig.update(dt, drive, FLAT_WORLD);
            },
            dispose() { hide.dispose(); },
            notes: [
              `${proto.tris} triangles (near LOD)`,
              `${proto.height.toFixed(2)} m at the withers`,
              `scale ×${v.scale}`,
              `walk ${sp.gait.walk} · trot ${sp.gait.trot} · run ${sp.gait.run} m/s`,
            ],
          };
        },
      });
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Family adapter — the camper
// ─────────────────────────────────────────────────────────────────────────────
//
// `buildCamper` takes a material set rather than an RNG, so the convention
// probe would mis-call it; and it returns a bag of named parts rather than one
// object. Both are fine reasons for an adapter and neither is a reason to
// change the model's signature to suit a dev page.

let _camperMats = null;
function camperMats(mod) {
  if (!_camperMats) {
    const env = BUILD_CTX.renderer ? mod.buildEnvMap(BUILD_CTX.renderer) : null;
    _camperMats = mod.buildMaterials(env);
  }
  return _camperMats;
}

function camperEntries(mod, path) {
  return [
    {
      id: 'vehicle:camper', label: 'Camper', sub: 'the van',
      group: groupOf(path), family: 'Vehicle', file: path,
      call: 'buildCamper(buildMaterials(env), seed)',
      seeded: true,
      async build(seed) {
        const built = mod.buildCamper(camperMats(mod), seed & 0xffff);
        const D = mod.DIM;
        return {
          root: built.root,
          notes: [
            `${(D.front - D.rear).toFixed(2)} m long, ${(D.halfWidth * 2).toFixed(2)} m wide (DIM)`,
            `${(D.roof - D.floor).toFixed(2)} m sill to roof`,
            `${mod.WINDOWS.length} side windows`,
          ],
        };
      },
    },
    {
      id: 'vehicle:wheel', label: 'Wheel', sub: 'road',
      group: groupOf(path), family: 'Vehicle', file: path,
      call: 'buildWheel(buildMaterials(env))',
      async build() { return { root: mod.buildWheel(camperMats(mod)) }; },
    },
    {
      id: 'vehicle:wheel-spare', label: 'Wheel', sub: 'spare',
      group: groupOf(path), family: 'Vehicle', file: path,
      call: 'buildWheel(buildMaterials(env), { spare: true })',
      async build() { return { root: mod.buildWheel(camperMats(mod), { spare: true }) }; },
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Family adapter — birds
// ─────────────────────────────────────────────────────────────────────────────
//
// A bird is one instanced card-and-wedge whose wings beat in the vertex shader
// off `aBeat` (phase, rate, amplitude) and a shared clock. It is here because
// the "Not shown" panel said it was missing: `birdGeometry` and `birdMaterial`
// were module-private, so the discovery pass could see the `Birds` system and
// nothing to draw. Opening those two exports is the whole change on the game's
// side — no behaviour moved — and it is exactly the kind of nudge that panel
// exists to produce.

// One clock and one material for every bird, registered once. Built lazily so
// a page that never opens a bird never compiles its program — and, more to the
// point, so a re-roll does not push another entry onto TIME_TARGETS every time.
let _birdKit = null;
function birdKit(mod) {
  if (!_birdKit) {
    const shared = { time: { value: 0 } };
    TIME_TARGETS.push({ uTime: shared.time });
    _birdKit = { shared, mat: mod.birdMaterial(shared), geo: mod.birdGeometry() };
  }
  return _birdKit;
}

function birdEntries(mod, path) {
  const names = ['High flock', 'Low flock'];
  return mod.FLOCK_SPECIES.map((S, fi) => ({
    id: `bird:${fi}`,
    label: 'Bird',
    sub: names[fi] ?? `flock ${fi + 1}`,
    group: groupOf(path),
    family: 'Birds',
    file: path,
    call: `birdGeometry() + birdMaterial(shared), FLOCK_SPECIES[${fi}]`,
    seeded: true,
    async build(seed) {
      const rnd = mulberry32(seed >>> 0);
      const { mat, geo } = birdKit(mod);
      const pal = mod.PLUMAGE[fi % mod.PLUMAGE.length];
      const mid = (r) => r[0] + (r[1] - r[0]) * 0.5;
      const mesh = singleInstance(geo, mat, {
        aBeat: [rnd() * 6.28, mid(S.rate), mid(S.amp)],
      });
      mesh.castShadow = false;
      const col = new THREE.Color(pal[(rnd() * pal.length) | 0]).multiplyScalar(0.82 + rnd() * 0.42);
      mesh.setColorAt(0, col);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // Birds fly. Standing one on the studio floor at its own scale would put
      // a 30 cm mark in the middle of a metre grid and tell you nothing about
      // the silhouette that matters, so it is held at a wingspan's height.
      const scale = mid(S.scale);
      mesh.scale.setScalar(scale);
      mesh.position.y = 0.5 * scale;
      const root = new THREE.Group();
      root.add(mesh);
      return {
        root,
        notes: [
          `beat ${mid(S.rate).toFixed(2)} Hz, amplitude ${mid(S.amp).toFixed(2)}`,
          `flies at ${S.alt[0]}–${S.alt[1]} m`,
          `${S.count[0]}–${S.count[1]} to a flock`,
          'wings beat in the vertex shader — the stage clock drives them',
        ],
      };
    },
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Family adapter — the fire
// ─────────────────────────────────────────────────────────────────────────────
//
// `Firepit` is a class that adds itself to whatever it is handed and then
// animates. It is handed the holder group instead of a scene, which works
// because `add` is `add` — and it means the pit's own PointLight travels with
// the prop instead of being left behind in the stage.

function fireEntries(mod, path) {
  return [{
    id: 'camp:firepit', label: 'Firepit', sub: 'ring, flame, embers, smoke',
    group: groupOf(path), family: 'Camp props', file: path,
    call: 'new Firepit(scene, rnd)',
    seeded: true,
    async build(seed) {
      const root = new THREE.Group();
      const pit = new mod.Firepit(root, mulberry32(seed >>> 0), {});
      let t = 0;
      return {
        root,
        update(dt, camera) { t += dt; pit.update(dt, t, camera); },
        dispose() { pit.dispose?.(); },
        notes: ['flame, embers and smoke run live', 'carries its own PointLight'],
      };
    },
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
//  The adapter table
// ─────────────────────────────────────────────────────────────────────────────
//
// `claims` names the exports an adapter is responsible for, so the convention
// probe leaves them alone and the "Not shown" panel does not accuse them of
// being missing.

const ADAPTERS = [
  {
    path: '/src/vegetation/tree_species.js', claims: ['SPECIES', 'growTree'], entries: treeEntries,
    // Assembly steps of this family living in other files. Naming them keeps
    // them out of the "looked like an object and was not usable" list, where
    // a geometry helper is a false alarm rather than a finding.
    parts: {
      '/src/vegetation/tree_geometry.js': ['buildBarkGeometry', 'buildLeafGeometry', 'buildImpostorGeometry'],
      '/src/vegetation/tree_textures.js': ['buildClusterAtlas'],
    },
  },
  { path: '/src/rocks/RockForms.js', claims: ['ARCHETYPES', 'buildRockLibrary', 'archFootprints'], entries: rockEntries },
  { path: '/src/vegetation/cover_forms.js', claims: ['COVER_ARCHETYPES', 'buildCoverLibrary', 'ARCH_INDEX'], entries: coverEntries },
  { path: '/src/wildlife/animal_species.js', claims: ['SPECIES', 'buildSpecies', 'createHideMaterial', 'pickVariant'], entries: animalEntries },
  { path: '/src/vehicle/CamperModel.js', claims: ['buildCamper', 'buildWheel', 'buildMaterials', 'buildEnvMap', 'DIM', 'WINDOWS'], entries: camperEntries },
  { path: '/src/camp/camp_fire.js', claims: ['Firepit'], entries: fireEntries },
  { path: '/src/wildlife/birds.js', claims: ['FLOCK_SPECIES', 'PLUMAGE', 'birdGeometry', 'birdMaterial', 'Birds'], entries: birdEntries },
];

// ─────────────────────────────────────────────────────────────────────────────
//  The convention probe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this the `build<Thing>(rnd, opts) -> Object3D` convention?
 *
 * The probe CALLS the function, which is the only way to know. Two guards keep
 * a false positive off the page:
 *
 *  · the result has to be a THREE.Object3D, and
 *  · every mesh under it has to have a material.
 *
 * The second one exists because of `buildWheel(materials, opts)`: hand an RNG
 * to a builder whose first argument is a material set and you get an object
 * back, silently, with `undefined` on every mesh. That is precisely the kind of
 * plausible-looking wrong result a discovery page must not print.
 */
function probeBuilder(fn) {
  const rnd = mulberry32(1);
  let obj;
  try {
    obj = fn(rnd, {});
  } catch (e) {
    return { ok: false, why: `throws when called as build(rnd, {}): ${e.message}` };
  }
  if (!obj || !obj.isObject3D) {
    const kind = obj?.isBufferGeometry ? 'a BufferGeometry' : obj ? typeof obj : String(obj);
    return { ok: false, why: `returns ${kind}, not a THREE.Object3D` };
  }
  let meshes = 0, bad = 0;
  obj.traverse((o) => { if (o.isMesh) { meshes++; if (!o.material) bad++; } });
  if (!meshes) return { ok: false, why: 'returns an Object3D with no meshes in it' };
  if (bad) return { ok: false, why: `${bad} of ${meshes} meshes came back with no material — the first argument is probably not an RNG` };
  return { ok: true, obj };
}

/**
 * The other convention: a module that exports `THING_COLORWAYS` beside
 * `buildThing` is telling us its colourways are enumerable, so they become
 * variants without anyone listing them here. Where the table's entries carry a
 * `name` — TENT_COLORWAYS does — the card gets it.
 */
function colorwaysFor(mod, builderName) {
  const stem = builderName.replace(/^build/, '').toUpperCase();
  const key = `${stem}_COLORWAYS`;
  const arr = mod[key];
  if (!Array.isArray(arr) || !arr.length) return null;
  return {
    key,
    count: arr.length,
    labels: arr.map((c, i) => c?.name ?? `colourway ${i + 1}`),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reading a builder's options out of the builder
// ─────────────────────────────────────────────────────────────────────────────
//
// A chair is not one object. It is four colourways times two frame styles, and
// a cooler is three colourways times two chest sizes with the lid open or shut.
// The first version of this page showed one card per builder and hid all of
// that behind a single dropdown, which is how a gallery of 125 objects managed
// to under-report the camp by two thirds.
//
// The options cannot come from a list kept here — that list is the thing that
// goes stale. They come from the builder's own source. `fn.toString()` on a
// module Vite is serving in dev is the real text of the function, and every
// builder in this project reads its options the same handful of ways:
//
//     opts.style === 'arm' || opts.style === 'sling'   -> an enum of two
//     opts.colorway ?? 0                               -> an index into a table
//     opts.size !== undefined ? !!opts.size            -> a flag
//     if (opts.dressed)                                -> a flag
//     clamp01(opts.wear ?? 0.4)                        -> a number, default 0.4
//     Math.round(opts.logs ?? 11)                      -> a number, default 11
//
// so each one is recognised by the shape of its read. Anything that matches
// nothing is still reported, as `unknown`, and shown on the object's info panel
// — a control nobody can offer is at least a fact somebody can act on.
//
// This is a dev page and that matters here: a production build would have
// minified the identifiers this reads. It never runs there.

const OPTION_IGNORE = new Set(['light', 'order', 'name', 'prewarm']);

function readOptions(fn, mod, builderName) {
  let src = '';
  try { src = fn.toString(); } catch { return []; }

  const names = new Set([...src.matchAll(/\bopts\.([A-Za-z_]\w*)/g)].map((m) => m[1]));
  const out = [];

  for (const name of names) {
    if (OPTION_IGNORE.has(name)) continue;
    const esc = name.replace(/[^\w]/g, '');

    // An index into a colourway table, named by the module's own export.
    if (/^colou?rway$/i.test(name)) {
      const cw = colorwaysFor(mod, builderName);
      if (cw) { out.push({ name, kind: 'index', count: cw.count, labels: cw.labels, key: cw.key }); continue; }
    }

    // An enum: compared against string literals, either way round.
    const lits = new Set();
    for (const m of src.matchAll(new RegExp(`opts\\.${esc}\\s*[!=]==\\s*'([^']*)'`, 'g'))) lits.add(m[1]);
    for (const m of src.matchAll(new RegExp(`'([^']*)'\\s*[!=]==\\s*opts\\.${esc}\\b`, 'g'))) lits.add(m[1]);
    if (lits.size >= 2) { out.push({ name, kind: 'enum', values: [...lits] }); continue; }

    // A number, if it has a numeric default. Checked before the flag test:
    // `opts.wear ?? 0.4` also reads as truthy-tested and is not a flag.
    const num = src.match(new RegExp(`opts\\.${esc}\\s*\\?\\?\\s*(-?[\\d.]+)`));
    if (num) { out.push({ name, kind: 'number', def: parseFloat(num[1]) }); continue; }

    // A flag: coerced, ternary-tested or used as a bare condition.
    if (new RegExp(`!!\\s*opts\\.${esc}\\b`).test(src)
      || new RegExp(`opts\\.${esc}\\s*\\?[^?]`).test(src)
      || new RegExp(`\\(\\s*opts\\.${esc}\\s*\\)`).test(src)) {
      out.push({ name, kind: 'bool' });
      continue;
    }

    out.push({ name, kind: 'unknown' });
  }

  // Colourway first, then the enums, then flags, then numbers: the order the
  // card expansion consumes them in, and the order they read in a control bar.
  const rank = { index: 0, enum: 1, bool: 2, number: 3, unknown: 4 };
  out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
  return out;
}

/**
 * How many cards one builder is allowed to occupy.
 *
 * Expansion is over the AUTHORED variant tables only — colourways and string
 * enums — because those are the axes where each value is a deliberate, visually
 * distinct thing somebody drew. Flags and numbers stay as controls on the
 * stage: `lidOpen` and `wear` are states of one object, not two objects, and
 * putting them on cards would quadruple the sidebar to say so.
 */
const CARD_CAP = 8;

function expansionAxes(options) {
  const axes = [];
  let product = 1;
  for (const o of options) {
    if (o.kind !== 'index' && o.kind !== 'enum') continue;
    const n = o.kind === 'index' ? o.count : o.values.length;
    if (product * n > CARD_CAP) continue;
    axes.push(o);
    product *= n;
  }
  return axes;
}

/** Cartesian product of the expansion axes -> [{ opts, label }]. */
function variantsOf(axes) {
  let rows = [{ opts: {}, parts: [] }];
  for (const a of axes) {
    const next = [];
    const values = a.kind === 'index'
      ? a.labels.map((label, i) => ({ value: i, label }))
      : a.values.map((v) => ({ value: v, label: v }));
    for (const row of rows) {
      for (const v of values) {
        next.push({ opts: { ...row.opts, [a.name]: v.value }, parts: [...row.parts, v.label] });
      }
    }
    rows = next;
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
//  discover()
// ─────────────────────────────────────────────────────────────────────────────

export function discover() {
  const entries = [];
  const notShown = [];
  const claimed = new Map();   // path -> Set(export names)

  const partsOf = new Map();   // "path#name" -> the family it assembles
  for (const a of ADAPTERS) {
    claimed.set(a.path, new Set(a.claims));
    for (const [p, names] of Object.entries(a.parts ?? {})) {
      for (const n of names) partsOf.set(`${p}#${n}`, a.path);
    }
  }

  // ── adapters first, so their claims are respected by the probe ────────────
  for (const a of ADAPTERS) {
    const mod = MODULES[a.path];
    if (!mod) {
      notShown.push({ file: a.path, name: '(whole module)', why: 'an adapter is registered for this file but the glob did not match it — has it moved?' });
      continue;
    }
    try {
      entries.push(...a.entries(mod, a.path));
    } catch (e) {
      notShown.push({ file: a.path, name: '(adapter)', why: `adapter failed: ${e.message}` });
    }
  }

  // ── the convention probe over everything else ─────────────────────────────
  for (const [path, mod] of Object.entries(MODULES)) {
    const mine = claimed.get(path) ?? new Set();
    for (const [name, value] of Object.entries(mod)) {
      if (mine.has(name)) continue;

      const isBuilder = /^build[A-Z]/.test(name) && typeof value === 'function';
      const isClassish = typeof value === 'function' && /^[A-Z]/.test(name) && !isBuilder;

      const part = partsOf.get(`${path}#${name}`);
      if (part) {
        notShown.push({
          file: path, name, soft: true,
          why: `an assembly step of ${fileOf(part).replace(/\.js$/, '')} — shown as the finished object, not on its own`,
        });
        continue;
      }

      if (isBuilder) {
        const probe = probeBuilder(value);
        if (!probe.ok) { notShown.push({ file: path, name, why: probe.why }); continue; }

        // One card per authored variant, not one per builder. See readOptions.
        const options = readOptions(value, mod, name);
        const axes = expansionAxes(options);
        const rest = options.filter((o) => !axes.includes(o));
        const rows = variantsOf(axes);

        for (const row of rows) {
          const suffix = row.parts.join(' · ');
          entries.push({
            id: `prop:${fileOf(path)}:${name}${suffix ? `:${row.parts.join('-')}` : ''}`,
            label: labelFromBuilder(name),
            sub: suffix || fileOf(path).replace(/\.js$/, ''),
            group: groupOf(path),
            family: `${groupOf(path)} props`,
            file: path,
            call: `${name}(rnd, ${JSON.stringify(row.opts)})`,
            seeded: true,
            // The axes this card already stands for are fixed; everything else
            // the builder accepts becomes a live control on the stage.
            fixed: row.opts,
            options: rest,
            allOptions: options,
            async build(seed, opts = {}) {
              const o = value(mulberry32(seed >>> 0), { ...row.opts, ...opts });
              return { root: o, notes: describeUserData(o) };
            },
          });
        }
      } else if (isClassish && value.prototype) {
        // Systems and helpers. Not an error — but naming them is how somebody
        // notices that, say, `Birds` has no gallery entry.
        notShown.push({
          file: path, name,
          why: 'a class, not a build(rnd) function — needs a game context (world, scene, ctx) to construct',
          soft: true,
        });
      }
    }
  }

  for (const [file, why] of EXCLUDED) notShown.push({ file, name: '(whole module)', why, soft: true });

  // Stable, readable ordering: group, then family, then label.
  const order = ['Camp', 'Vegetation', 'Rocks', 'Wildlife', 'Vehicle'];
  const rank = (g) => { const i = order.indexOf(g); return i === -1 ? order.length : i; };
  entries.sort((a, b) =>
    rank(a.group) - rank(b.group) ||
    a.group.localeCompare(b.group) ||
    a.family.localeCompare(b.family) ||
    a.label.localeCompare(b.label) ||
    (a.sub ?? '').localeCompare(b.sub ?? ''));

  notShown.sort((a, b) => Number(!!a.soft) - Number(!!b.soft) || a.file.localeCompare(b.file));

  return { entries, notShown, scanned: Object.keys(MODULES).length };
}

/** Anything a builder chose to write on `userData` is worth surfacing. */
function describeUserData(o) {
  const notes = [];
  const d = o.userData ?? {};
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === 'number') notes.push(`${k} ${(+v.toFixed(3))}`);
    else if (typeof v === 'string' || typeof v === 'boolean') notes.push(`${k} ${v}`);
  }
  return notes;
}

export { titleCase };
