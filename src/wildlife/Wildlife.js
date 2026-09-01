// ─────────────────────────────────────────────────────────────────────────────
//  Wildlife — deer, bears, rabbits and birds, alive in the valley.
//
//  The layers below this one do the hard parts:
//    animal_rig      geometry + skeleton, one draw call per animal
//    animal_species  the cast, one file per mammal under mammals/
//    animal_anim     procedural gaits driven by real ground speed
//    animal_brain    the state machine and the steering
//    birds/          one file per bird, plus the two systems they belong to:
//                    flocks.js (instanced flocks and a startle burst) and
//                    tree_birds.js (the perch-and-fly birds you stop for)
//    fireflies       the night shift: one GPU-resident draw call over the
//                    meadow and the water margins, dark before dusk
//    bigfoot         a cast of one, and only once the journal says so — his
//                    own habitat, streaming and behaviour in one file, because
//                    none of the machinery below is worth running for one animal
//
//  This file is the world layer: where animals live, when they exist, and how
//  much of the frame they are allowed to cost.
//
//  The design goal is a *cozy* one and it drives every number here. Spotting a
//  deer should feel like a small gift, which means two things that pull against
//  each other: the valley must be sparse enough that an animal is an event, and
//  reliable enough that a minute of driving produces one. The resolution is
//  habitat — animals are common in the places they should be (meadow edges,
//  riverbanks, scrub) and absent everywhere else, so the density you experience
//  while driving the valley floor is far higher than the density on the map.
//
//  Nothing may appear inside the player's view. Home sites are streamed in on a
//  distance budget with a frustum guard, so an animal materialises either
//  behind you or at a range where it is a few pixels of fog.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { SEED } from '../world/WorldConfig.js';
import { SKY_STATE } from '../render/Lighting.js';
import { NoiseField } from '../core/Noise.js';
import { clamp, clamp01, lerp, damp, smoothstep, mulberry32, hash2i } from '../core/MathUtils.js';
import { SPECIES, buildSpecies, loadSpecies, isGlb, createHideMaterial,
         pickVariant, setHideSilScale, SIL_FOV_REF, GlbRig } from './animal_species.js';
import { instantiate } from './animal_rig.js';
import { AnimRig } from './animal_anim.js';
import { Brain, ST, WATER_MAX } from './animal_brain.js';
import { Birds } from './birds/flocks.js';
import { TreeBirds } from './birds/tree_birds.js';
import { Fireflies } from './fireflies.js';
import { Bigfoot } from './bigfoot.js';

// Per-species streaming and population budget.
//
//   spawn/despawn  metres from the camera. The gap between them is hysteresis;
//                  without it an animal at exactly the boundary flickers.
//   live           hard cap on simultaneous SkinnedMeshes (one draw call each,
//                  two while they are close enough to cast a shadow)
//   perKm2         home *groups* per square kilometre of suitable habitat
// `perKm2` is per square kilometre of *perfectly* suitable habitat, and almost
// nowhere scores 1.0, so the realised counts are far lower than these numbers
// suggest — see the `[wildlife]` line in the console for what actually landed.
//
// `tools/wcensus.mjs` is the arbiter, not intuition. At these numbers, driving
// the whole road network: an animal is in view 45% of the time, the median gap
// between sightings is ~7 s and the 90th percentile is ~51 s, and the busiest
// point on the map costs 7 draw calls and 4.7 k triangles against a 60-call
// budget. There is a lot of headroom; the cap is taste, not performance.
// How far a named bird quarry may be pinned from. The mammals answer this off
// their own `CFG[key].spawn`, but the birds stream on one ring for the whole
// cast (`tree_birds.js` SPAWN_R), so their ceiling is a constant rather than a
// column: 190 m is the outer edge of that ring, which is the furthest a bird
// can exist to be pointed at. See `_nearestQuarry`.
const BIRD_QUARRY_R = 190;

const CFG = {
  deer:   { spawn: 172, despawn: 215, live: 9,  perKm2: 88 },
  bear:   { spawn: 185, despawn: 230, live: 3,  perKm2: 0.5 },
  rabbit: { spawn: 96,  despawn: 132, live: 8,  perKm2: 330 },
  // A fox is meant to be an uncommon treat — rarer than deer, far commoner
  // than a bear. It is a 0.5 m animal, so the streaming band sits between the
  // rabbit's and the deer's: far enough out that it never pops in view, close
  // enough that a spawned fox is actually resolvable.
  fox:    { spawn: 140, despawn: 178, live: 4,  perKm2: 16 },
  // Squirrels are the common small life of the timber — commoner on the map
  // than rabbits, on a streaming band even tighter than theirs, because a
  // 0.19 m animal past forty metres is nothing at all. The tight band is what
  // makes the high density affordable: at any moment only the handful around
  // the camper exist.
  // 240 lands ~620 home sites — about 2.5× the rabbits, far and away the
  // commonest mammal, without letting one species own most of the site table
  // (the first cut at 420 took 1080 of 1671).
  squirrel: { spawn: 72, despawn: 104, live: 8, perKm2: 240 },
  // Raccoons exist only at night (see `_night` and the gate in `_scan`), so
  // this row is read for perhaps a third of a day cycle — which is exactly why
  // `perKm2` is kept low rather than raised to compensate. Home sites are
  // placed once at init for every species whether or not it is awake, and they
  // all come out of one capped table; a nocturnal species that paid for its
  // downtime with density would be spending the bears' places to do it.
  // 24 lands 54-66 sites depending on the quality tier's density
  // multiplier — a tenth of the squirrels', a little over the foxes'.
  raccoon: { spawn: 92, despawn: 124, live: 5, perKm2: 24 },
  // ── the alpine pair, and why these numbers look absurd ─────────────────────
  // `perKm2` is per square kilometre of *perfectly* suitable habitat, and for
  // these two that habitat is tiny: summed over the map, the goat's
  // suitability field integrates to 0.19 km² of perfect-equivalent ground
  // against the deer's 2.13. Same site count therefore costs eleven times the
  // density, and these are what land ~140 goat and ~85 ram home sites — about
  // half the deer's, which is the intent. A goat is not rare because there are
  // few of them; it is rare because almost none of the valley is a mountain.
  //
  // The place to change the *feel* is the suitability bands in the two species
  // files, not here: raising these only packs more animals onto the same
  // crags, which is the failure the clumping noise exists to avoid.
  //
  // Wide streaming bands, like the bear's: both of these are big shapes seen
  // across a valley rather than met at the roadside, and an animal on a crag
  // that only exists inside a hundred metres is one nobody will ever see.
  goat:   { spawn: 165, despawn: 205, live: 7, perKm2: 720 },
  // The ram's row is the yak's, unchanged when the model changed: where a
  // species lives and how thickly is a fact about the mountain, not about the
  // mesh. Its `live` is one under the goat's for the same reason it always
  // was — the two share a pool budget and the goat is the commoner animal.
  ram:    { spawn: 185, despawn: 230, live: 6, perKm2: 210 },
};

// Seeded firefly population inside the 60 m wrap box, per quality tier.
//
// It looks enormous next to the mote counts and it is not the same kind of
// number: a firefly is DARK about four fifths of the time, the habitat gates
// delete most of the box on any given ground, and the clumping noise deletes
// most of what is left. Measured at the meadow anchor at 22:00, 3000 seeded
// lands about 28 lit insects in a 1600x900 frame; at the lake margin about 10;
// in deep timber, zero. Sparse is the target and this is what sparse costs.
//
// A tier table rather than a multiplier, on Weather's pattern: these are all
// one draw call and a few thousand vertex invocations, so the low tier is cut
// for the fill cost of the glows and nothing else.
const FIREFLY_N = { ultra: 3200, high: 3000, medium: 1900, low: 900 };

// ── the night gate ───────────────────────────────────────────────────────────
// How much night there has to be before a raccoon will come out, and how much
// there has to stop being before the ones already out go home. The gap is
// hysteresis in exactly the sense the spawn/despawn bands are: without it a
// nightFactor sitting on the threshold at dusk would spawn and despawn the same
// group every scan.
const NIGHT_WAKE = 0.55;
const NIGHT_SLEEP = 0.42;

// LOD. A deer is about 1.5 m tall, so at 60 m it is roughly forty pixels — the
// reduced mesh is indistinguishable there and costs 40% of the triangles.
const NEAR_GEOM = 58;     // full geometry inside this
const SHADOW_DIST = 92;   // beyond this an animal stops casting (saves a call)
const FULL_ANIM = 95;     // full-rate animation inside this, whatever the view
const IDLE_HZ = 6;        // off-screen and far: animate this often

const _v = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _pm = new THREE.Matrix4();
// Reused by _standPoint. Site activation is not per frame, but this file's
// rule is that nothing in the streaming path allocates, and one shared pair
// of floats is cheaper than the habit of making an exception.
const _stand = { x: 0, z: 0 };
// `RockScatter.classify` writes the uphill direction into an out-param. Site
// placement calls it tens of thousands of times, so it gets one shared object
// for the same reason `_stand` above has one.
const _up = { x: 0, z: 0 };
// Scratch for the boulder search — see _findPerches. Reused rather than
// allocated per site, which is this file's rule for anything on the streaming
// path even when the call is once per site.
const _rockHits = [];

export class Wildlife extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Wildlife';
    this.loadLabel = 'Waking the wildlife';

    this.group = new THREE.Group();
    this.group.name = 'Wildlife';
    this.noise = new NoiseField(SEED ^ 0x3e17);

    this.stats = { live: 0, groups: 0, sites: 0, drawn: 0 };
    this._threat = { x: 0, z: 0, speed: 0, heading: 0 };
    this._threatOverride = null;
    this._scanT = 0;
    this._frozen = false;
    this._time = 0;
    // Is it night enough for the nocturnal cast? Latched with hysteresis in
    // `_scan`; false at boot because the game starts in daylight.
    this._night = false;
  }

  async init() {
    const { scene, preset } = this.ctx;
    // The quality preset does not carry a wildlife knob, so ride on the tree
    // multiplier: a machine that cannot afford the forest cannot afford a herd.
    this.mul = clamp(preset?.treeMul ?? 1, 0.4, 1);

    this.keys = Object.keys(SPECIES);
    // The rock scatter, for the alpine pair's habitat term, and Rocks itself
    // for the boulders they stand on. Rocks is constructed and initialised
    // before Wildlife (the SYSTEMS table in main.js), so this is read once here
    // rather than fetched lazily — but it stays optional, because a system
    // whose init threw is disabled rather than removed and the valley should
    // still get its wildlife.
    this._rocks = this.ctx.systems?.rocks ?? null;
    this._scatter = this._rocks?.scatter ?? null;
    await this._buildProtos();
    this._buildPool();
    this._placeSites();

    this.birds = new Birds(this.ctx, SEED ^ 0x51b1);
    this.birds.build();

    // The perch-and-fly birds — eagles in the trees, herons and flamingos in
    // the shallows. See birds/tree_birds.js and the wader models beside it.
    this.treeBirds = new TreeBirds(this.ctx, SEED ^ 0x6ea9);
    this.treeBirds.build();

    // The night shift. One draw call, GPU-resident, and it does not draw at all
    // before dusk — see the header of fireflies.js.
    this.fireflies = new Fireflies(this.ctx, SEED ^ 0x1ee5,
                                   FIREFLY_N[this.ctx.quality] ?? FIREFLY_N.high);
    this.fireflies.build();

    // The nineteenth line. Constructed always and built never, until something
    // above sets `armed` — see the header of bigfoot.js. Nothing is loaded, no
    // geometry exists and no site is placed for a player who has not finished
    // the sheet; the cost until then is one boolean read a frame.
    this.bigfoot = new Bigfoot(this.ctx, SEED ^ 0xb1f7);

    scene.add(this.group);
    this._compileWarm = true;

    // Damped so raising the telescope does not pop the value of every distant
    // animal on one frame; photo mode cuts instead. See _silScale.
    this._sil = 1;
    this._silPhoto = false;
  }

  /**
   * Wildlife is pooled below the world and invisible until a habitat wakes.
   * Compile those skinned hide variants for EffectComposer's linear scene
   * target now; otherwise the first deer sighting also becomes a shader hitch.
   */
  precompileMaterials() {
    const { renderer, camera, scene } = this.ctx;
    renderer.compile(this.group, camera, scene);
  }

  /**
   * Put one pooled skinned animal inside the warm frame's shadow frustum.
   * WebGLRenderer.compile() does not visit shadow passes, so without one real
   * caster Three links MeshDepthMaterial on the first live herd instead.
   * Returns a restore callback for main's loading-screen warm draw.
   */
  beginWarmFrame() {
    const a = this.pool?.deer?.flat()?.[0];
    if (!a) return null;
    const mesh = a.mesh;
    const was = {
      visible: mesh.visible,
      castShadow: mesh.castShadow,
      frustumCulled: mesh.frustumCulled,
      position: mesh.position.clone(),
    };
    const { camera, world } = this.ctx;
    const p = camera.getWorldDirection(new THREE.Vector3())
      .multiplyScalar(18).add(camera.position);
    p.y = world.getHeight(p.x, p.z);
    mesh.position.copy(p);
    mesh.visible = true;
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    mesh.updateMatrixWorld(true);
    return () => {
      mesh.visible = was.visible;
      mesh.castShadow = was.castShadow;
      mesh.frustumCulled = was.frustumCulled;
      mesh.position.copy(was.position);
      mesh.updateMatrixWorld(true);
    };
  }

  // ── prototypes and the mesh pool ───────────────────────────────────────────

  /**
   * One prototype per coat, for every species, on whichever track it is on.
   *
   * The hand-authored species are the only asynchronous thing in the whole
   * wildlife load, and they are awaited HERE rather than lazily for one
   * reason: `loadSpecies` measures the clips and writes the measured walk,
   * trot and run speeds onto the species record (see `glb_rig.loadGlbSpecies`).
   * `_buildPool` constructs a `Brain` per pool entry off `SPECIES[key]`, and a
   * Brain built before that write would steer the animal at speeds its clips
   * cannot carry — the paws would slide, which is the exact failure the whole
   * measure-the-asset mechanism exists to prevent.
   *
   * Loaded in parallel, because there is no reason for a second hand-authored
   * animal to wait on the first.
   */
  async _buildProtos() {
    this.protos = {};
    this.mats = {};
    const pending = [];
    for (const key of Object.keys(SPECIES)) {
      if (isGlb(key)) {
        // The materials come off the asset, one set per coat, so there is no
        // hide material for this species and `this.mats[key]` stays empty.
        pending.push(loadSpecies(key).then((protos) => { this.protos[key] = protos; }));
        this.mats[key] = [];
        continue;
      }
      this.protos[key] = buildSpecies(key, SEED);
      // One material per variant, shared by every animal of that variant. They
      // all compile to the same program (see createHideMaterial), so the whole
      // cast costs one shader.
      this.mats[key] = this.protos[key].map((p) => {
        const m = createHideMaterial(p.variant.col);
        m.name = `hide:${key}:${p.variant.name}`;
        return m;
      });
    }
    await Promise.all(pending);
  }

  /**
   * Every animal that can ever be on screen is built here, at load, and then
   * recycled forever. Building a SkinnedMesh mid-drive would cost a bone
   * hierarchy allocation and a first-draw shader hitch at exactly the moment
   * the player is looking at the thing being built.
   */
  _buildPool() {
    this.pool = {};
    for (const key of Object.keys(SPECIES)) {
      const live = Math.max(2, Math.round(CFG[key].live * this.mul));
      const protos = this.protos[key];
      const per = [];
      for (let vi = 0; vi < protos.length; vi++) per.push([]);
      for (let i = 0; i < live; i++) {
        // Distribute the pool across variants by the same weights the placement
        // uses, so a common doe is common in the pool too.
        const vi = pickVariant(key, ((i + 0.5) / live) % 1);
        const proto = protos[vi];
        // Size jitter is baked per pool entry rather than per spawn: the rig
        // caches a lot of scale-derived geometry, and an individual keeping one
        // size for the whole session costs nothing and is invisible.
        const jit = 0.90 + hash2i(i * 31 + 7, key.length * 17, SEED) * 0.20;
        const scale = proto.scale * jit;
        // How big this individual is as an ANIMAL, which is not the same number
        // as the transform above the moment a species is hand-authored — see
        // the two-scales note in `glb_rig.loadGlbSpecies`. `Brain` multiplies
        // every gait speed by this, so it has to stay around 1. A procedural
        // prototype carries no `size` and falls back to `scale`, which for a
        // blueprint authored in metres is the same thing it always was.
        const size = (proto.size ?? proto.scale) * jit;
        // The two backends, and the only place the difference is visible.
        // Both satisfy the same contract — see the header of glb_rig.js — so
        // everything downstream of this line walks one cast.
        const glb = isGlb(key);
        const inst = glb ? null : instantiate(proto, this.mats[key][vi], 0);
        const rig = glb
          ? new GlbRig(proto, scale, SPECIES[key].gait, key)
          : new AnimRig(proto, inst, scale, SPECIES[key].gait, key);
        rig.mesh.name = `${key}:${proto.variant.name}`;
        rig.mesh.position.set(0, -500, 0);
        this.group.add(rig.mesh);
        per[vi].push({
          key, vi, proto, inst, rig, scale, size,
          mesh: rig.mesh,
          brain: new Brain(key, SPECIES[key], (i * 2654435761) >>> 0, null, 0),
          drive: { pos: null, heading: 0, speed: 0, yawRate: 0, graze: 0, alert: 0, flag: 0, look: null, lod: 0 },
          group: null, slot: 0, active: false, lod: 0, acc: 0, tick: 0,
        });
      }
      this.pool[key] = per;
    }
  }

  /** Take a free animal, preferring the requested variant. */
  _take(key, vi) {
    const per = this.pool[key];
    const want = per[vi];
    for (const a of want) if (!a.active) return a;
    for (let i = 0; i < per.length; i++) {
      for (const a of per[i]) if (!a.active) return a;
    }
    return null;
  }

  // ── habitat and placement ──────────────────────────────────────────────────

  /**
   * How much exposed rock is happening at this point, 0..1 — the alpine pair's
   * habitat term and the only place the wildlife layer asks the rock layer
   * anything.
   *
   * `classify` returns the geological process operating at a point and how
   * strongly, which is exactly the question "are there boulders here" asked in
   * the rock system's own words. The four kinds that mean *big* rock are
   * weighted by how much of it each actually leaves on the ground: a crag is a
   * banded face with blocks the size of a camper, a talus fan is the pile
   * underneath one, scree is smaller and a bedrock rib is thinner still.
   * `riverbed` and `erratic` score zero — a boulder in a meadow is not a
   * mountain, and it is thirty metres above sea level anyway.
   */
  _rockAt(x, z) {
    const c = this._scatter.classify(x, z, _up);
    if (!c) return 0;
    if (c.kind === 'crag') return clamp01(c.s * 1.6);
    if (c.kind === 'talus') return clamp01(c.s * 1.3);
    if (c.kind === 'scree') return clamp01(c.s * 1.1);
    if (c.kind === 'rib') return clamp01(c.s * 0.8);
    return 0;
  }

  /**
   * The above, as a raster, built once over the sampling grid `_placeSites`
   * already uses.
   *
   * A grid rather than a call per candidate for two reasons, and the second is
   * the real one. `classify` is a dozen height samples and placement asks about
   * ninety thousand points, so per-species calls would be most of the cost of
   * building the world's wildlife. And a ram does not want to stand *in* the
   * crag, it wants the apron beside it — which is a question about the
   * neighbourhood, and a neighbourhood maximum over a raster is a handful of
   * array reads where re-classifying five points around every candidate would
   * be another five thousand height samples.
   *
   * Skipped below 100 m: `classify` cannot return crag, talus or scree down
   * there (its own thresholds), and that is 60% of the map.
   */
  _buildRockField(W, DF, step, half) {
    const f = new Float32Array(DF * DF);
    if (!this._scatter) return f;
    for (let j = 0; j < DF; j++) {
      for (let i = 0; i < DF; i++) {
        const x = -half + (i + 0.5) * step, z = -half + (j + 0.5) * step;
        if (!W.isInBounds(x, z)) continue;
        if (W.getHeight(x, z) < 100) continue;
        f[j * DF + i] = this._rockAt(x, z);
      }
    }
    return f;
  }

  /**
   * Strongest rock process within `cells` grid cells of a point — 0 for "on
   * it", 1 for "beside it". See `_buildRockField`.
   */
  _rockiness(x, z, cells) {
    const g = this._rockGrid;
    if (!g) return 0;
    const i0 = Math.round((x + g.half) / g.step - 0.5);
    const j0 = Math.round((z + g.half) / g.step - 0.5);
    let best = 0;
    for (let j = j0 - cells; j <= j0 + cells; j++) {
      if (j < 0 || j >= g.DF) continue;
      for (let i = i0 - cells; i <= i0 + cells; i++) {
        if (i < 0 || i >= g.DF) continue;
        const v = g.f[j * g.DF + i];
        if (v > best) best = v;
      }
    }
    return best;
  }

  /**
   * Suitability, 0..1, for one species at one point. This is the whole habitat
   * model and it is deliberately small: three numbers off the world, one
   * clumping noise, and a hard zero anywhere an animal must not be.
   */
  _suit(key, x, z, W) {
    const depth = W.getWaterDepth(x, z);
    if (depth > WATER_MAX) return 0;
    const slope = W.getSlope(x, z);
    const h = W.getHeight(x, z);
    // ── the two gates, and who is allowed past them ─────────────────────────
    // "Not too steep, not too high" is the whole of the valley cast's habitat
    // before the per-species terms even run, and it is correct for every animal
    // that lives on the floor of this world. The alpine pair live above both
    // limits — a goat held to 0.80 slope and 300 m would be a goat with nowhere
    // to stand — so a species carrying a `rock` block brings its own ceiling.
    // The brain reads the same `slopeMax`, so placement, wander targets and the
    // probe fan cannot disagree about where an animal may be.
    const climb = SPECIES[key].brain.rock;
    if (slope > (climb ? climb.slopeMax : 0.80)) return 0;
    if (h > (climb ? 400 : 300)) return 0;
    const m = W.getMoisture(x, z);
    const river = W.getRiver(x, z);
    const flat = 1 - smoothstep(0.35, 0.78, slope);

    // Clumping: without it every species is an even Poisson scatter, which the
    // brief calls out by name. Two octaves at ~350 m gives good ground and
    // empty ground rather than a uniform sprinkle.
    const clump = clamp01(this.noise.fbm(x * 0.0029 + key.length * 41.7, z * 0.0029, 2, 2.1, 0.5, 1) * 0.5 + 0.62);

    if (climb) {
      // ── high, rocky, and steep ──────────────────────────────────────────
      // The rock term is asked of the scatter rather than guessed from slope,
      // and that is the whole difference between "goats on steep ground" and
      // "goats in the rocks": `RockScatter.classify` is the function that
      // decides where the crags, the talus fans and the scree actually go, so
      // the animals that live among boulders are placed off the same answer
      // the boulders are. It costs a handful of height samples per candidate
      // and only runs for these two species, above the altitude floor.
      const alt = smoothstep(climb.altBand[0], climb.altBand[1], h);
      if (alt <= 0) return 0;
      const rock = this._rockiness(x, z, climb.nearCells);
      if (rock <= 0) return 0;
      // Preferred steepness, as a band rather than a cap. `slopeBest[0]` is
      // where the ground stops being a meadow and `slopeBest[1]` is where it
      // stops being standable; a goat's band is most of a talus fan and a
      // ram's is the bench below it, which is how the two share a mountain
      // without standing in the same places.
      const rise = smoothstep(climb.slopeBest[0] * 0.5, climb.slopeBest[0], slope);
      const stand = 1 - smoothstep(climb.slopeBest[1], climb.slopeMax, slope);
      return clamp01(rock * climb.rockGain * alt * rise * stand * clump);
    }
    if (key === 'deer') {
      // The forest edge — the moisture band where trees give way to meadow —
      // plus open meadow. Deer at the treeline, not deep inside the wood: the
      // player has to be able to see them.
      const edge = smoothstep(0.28, 0.48, m) * (1 - smoothstep(0.66, 0.92, m));
      const meadow = (1 - smoothstep(0.40, 0.62, m)) * 0.55;
      // …but never *none* in deep timber. Cutting deer off above 0.80 moisture
      // left the wet-forest roads with no mammal of any species on them, and
      // the census found a 4½-minute stretch of one with nothing alive at all.
      const wood = smoothstep(0.70, 0.90, m) * 0.32;
      // Deer thin out with altitude rather than stopping dead at a contour —
      // a hard ceiling left whole alpine road sections with nothing on them.
      return clamp01((edge * 1.15 + meadow + wood) * flat * clump * (1 - smoothstep(200, 285, h)));
    }
    if (key === 'rabbit') {
      // Low scrub: dry, open, gentle, and low down. Rabbits want cover within
      // a bolt of the feeding ground, so a little moisture is a plus.
      const scrub = (1 - smoothstep(0.44, 0.70, m)) * smoothstep(0.06, 0.26, m);
      return clamp01(scrub * 1.3 * flat * clump * (1 - smoothstep(110, 190, h)));
    }
    if (key === 'fox') {
      // Where the rabbits are, plus the field edges the deer use — a fox lives
      // on the seam between cover and open hunting ground, which conveniently
      // is also the seam the player drives along. The two bands overlap the
      // prey species' on purpose: a fox trotting a hedge line forty metres
      // from a rabbit is the valley telling a true story.
      const edge = smoothstep(0.24, 0.44, m) * (1 - smoothstep(0.60, 0.85, m));
      const scrub = (1 - smoothstep(0.46, 0.72, m)) * smoothstep(0.05, 0.22, m) * 0.6;
      return clamp01((edge + scrub) * 1.1 * flat * clump * (1 - smoothstep(170, 250, h)));
    }
    if (key === 'raccoon') {
      // Water margins and the forest edge, which for a raccoon are the same
      // habitat seen from two directions: it forages along the wet edge of
      // things and dens in the timber behind it. `river` is scored the way the
      // bear scores it — it is the strongest single term — and the moisture
      // edge band is the fox's seam, shifted a little wetter.
      //
      // "Drawn to human sites" is the third real thing about a raccoon, and the
      // honest way to say it here is the road-verge boost that `_placeSites`
      // already applies to every non-bear species: at this layer the road
      // network IS where the people are (the camps sit on it), and inventing a
      // campsite field for one species would be reaching past the world for
      // data that does not exist yet when sites are placed.
      const edge = smoothstep(0.30, 0.50, m) * (1 - smoothstep(0.68, 0.92, m));
      const wood = smoothstep(0.55, 0.80, m) * 0.45;
      // Low ground. A raccoon is a bottomland animal and has no business on the
      // alpine benches at all, so this ceiling is harder than the fox's.
      return clamp01((edge + wood + river * 2.2) * flat * clump * (1 - smoothstep(120, 195, h)));
    }
    if (key === 'squirrel') {
      // The timber itself, plus its inner edge — the one species that lives
      // where the trees are rather than where they stop. The moisture field is
      // the tree field, so "wood" here is the same band the forest grows in;
      // the edge term keeps a few on the verges the player actually drives.
      const wood = smoothstep(0.48, 0.76, m);
      const edge = smoothstep(0.30, 0.46, m) * (1 - smoothstep(0.64, 0.88, m)) * 0.5;
      return clamp01((wood * 1.15 + edge) * flat * clump * (1 - smoothstep(150, 230, h)));
    }
    // Bear: water and cover. River sites are placed separately off the actual
    // polylines; this covers the deep-wood animal.
    const cover = smoothstep(0.55, 0.80, m);
    return clamp01((cover + river * 2.0) * flat * clump * (1 - smoothstep(150, 215, h)));
  }

  _placeSites() {
    const t0 = performance.now();
    const W = this.ctx.world;
    const half = W.half, size = W.worldSize;
    const rng = mulberry32(SEED ^ 0x5eed17);

    // Verge bias: hedge and forest edge follow tracks, and a cozy driving game
    // wants its wildlife where the player will actually drive past it. A mild
    // multiplier, not a corridor of tame animals.
    const RM = 8, RW = Math.ceil(size / RM);
    const nearRoad = new Uint8Array(RW * RW);
    for (const road of (W.roads ?? [])) {
      for (let i = 0; i < road.length - 1; i++) {
        const a = road[i], b = road[i + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const steps = Math.max(1, Math.ceil(len / RM));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
          const gx = ((x + half) / RM) | 0, gz = ((z + half) / RM) | 0;
          const R = 7;    // ~56 m either side
          for (let j = -R; j <= R; j++) {
            const zz = gz + j; if (zz < 0 || zz >= RW) continue;
            for (let i2 = -R; i2 <= R; i2++) {
              const xx = gx + i2; if (xx < 0 || xx >= RW) continue;
              if (i2 * i2 + j * j <= R * R) nearRoad[zz * RW + xx] = 1;
            }
          }
        }
      }
    }

    // The cap bounds the every-0.3 s scan loop, and it has to clear the
    // realised site count with room to spare: species are placed in key
    // order and the river bears after all of them, so a saturated cap does
    // not degrade evenly — it silently deletes whatever placed last. The
    // squirrels found this at 1400: the census came back with exactly 1400
    // sites and zero bears on the map.
    const cap = 2400;
    const sx = new Float32Array(cap), sz = new Float32Array(cap);
    const spec = new Uint8Array(cap), scount = new Uint8Array(cap), sseed = new Uint32Array(cap);
    const lines = new Array(cap).fill(null);
    let n = 0;

    const keys = Object.keys(SPECIES);
    const DF = 96;                       // 32 m sampling cells
    const step = size / DF;
    const cellKm2 = (step * step) / 1e6;

    // Where the exposed rock is, for the alpine pair. Built on the same grid
    // the candidates are drawn on, and only if somebody is going to ask.
    this._rockGrid = keys.some((k) => SPECIES[k].brain.rock)
      ? { f: this._buildRockField(W, DF, step, half), DF, step, half }
      : null;

    for (let ki = 0; ki < keys.length; ki++) {
      const key = keys[ki];
      const brain = SPECIES[key].brain;
      const dens = CFG[key].perKm2 * this.mul;
      for (let j = 0; j < DF && n < cap; j++) {
        for (let i = 0; i < DF && n < cap; i++) {
          const x = -half + (i + 0.35 + rng() * 0.3) * step;
          const z = -half + (j + 0.35 + rng() * 0.3) * step;
          if (!W.isInBounds(x, z)) continue;
          let s = this._suit(key, x, z, W);
          const gx = ((x + half) / RM) | 0, gz = ((z + half) / RM) | 0;
          if (key !== 'bear' && nearRoad[gz * RW + gx] && s > 0) {
            // Verges are edge habitat everywhere, and a long dead stretch of
            // road is the one failure the player definitely notices. A floor
            // plus a boost, only where the ground is habitable at all.
            s = Math.max(s * 1.75, 0.10);
          }
          if (s <= 0.02) continue;
          if (rng() > s * dens * cellKm2) continue;

          sx[n] = x; sz[n] = z; spec[n] = ki;
          scount[n] = brain.herd[0] + ((rng() * (brain.herd[1] - brain.herd[0] + 1)) | 0);
          sseed[n] = (rng() * 0xffffffff) >>> 0;
          n++;
        }
      }
    }

    // ── bears on the rivers ─────────────────────────────────────────────────
    // Placed straight off the polylines rather than off the suitability field,
    // because "bear beside a river" is the whole point of plate 3 and because
    // the walk they patrol is the polyline itself.
    const bearKi = keys.indexOf('bear');
    const polys = W.riverPolylines ?? [];
    for (const poly of polys) {
      if (poly.length < 12 || n >= cap) continue;
      // Only the substantial channels; a headwater trickle is not bear country.
      let flow = 0;
      for (const p of poly) flow = Math.max(flow, p.w ?? 0);
      if (flow < 5) continue;
      // A bear is meant to be rare. One possible site every ~20 nodes of river,
      // taken about one time in ten, is roughly one bear per major channel.
      for (let i = 8; i < poly.length - 8 && n < cap; i += 20) {
        if (rng() > 0.11 * this.mul) continue;
        const p = poly[i];
        // Step onto the bank, away from the channel, and only keep it if the
        // bank is dry and walkable.
        const q = poly[i + 1] ?? poly[i - 1];
        const tx = q.x - p.x, tz = q.z - p.z;
        const tl = Math.hypot(tx, tz) || 1;
        const side = rng() < 0.5 ? 1 : -1;
        const off = (p.w ?? 4) * 0.6 + 6 + rng() * 7;
        const x = p.x - (tz / tl) * off * side;
        const z = p.z + (tx / tl) * off * side;
        if (!W.isInBounds(x, z)) continue;
        if (W.getWaterDepth(x, z) > WATER_MAX) continue;
        if (W.getSlope(x, z) > 0.75) continue;
        sx[n] = x; sz[n] = z; spec[n] = bearKi;
        scount[n] = 1;
        sseed[n] = (rng() * 0xffffffff) >>> 0;
        lines[n] = poly;
        n++;
      }
    }

    this.keys = keys;
    this.sites = {
      n, x: sx.slice(0, n), z: sz.slice(0, n), spec: spec.slice(0, n),
      count: scount.slice(0, n), seed: sseed.slice(0, n), lines,
      // Runtime: null when asleep, the live group when awake.
      live: new Array(n).fill(null),
      // Where the members were when the group last went to sleep, so walking
      // back to a meadow does not reset it to a diorama.
      memo: new Float32Array(n * 4 * 3),
      memoT: new Float32Array(n).fill(-1e9),
      // Group records are preallocated: waking a herd must not allocate.
      rec: new Array(n),
    };
    for (let i = 0; i < n; i++) {
      this.sites.rec[i] = {
        si: i, key: keys[spec[i]], alarm: 0, fleeH: null,
        line: lines[i], members: [], pinned: false,
      };
    }
    this.stats.sites = n;
    const byKey = keys.map((k, i) => `${k} ${spec.slice(0, n).reduce((a, v) => a + (v === i ? 1 : 0), 0)}`);
    console.log(`[wildlife] ${n} home sites (${byKey.join(', ')}) in ${(performance.now() - t0).toFixed(0)} ms`);
    // Say so when the cap truncates — see its comment for why silence here
    // once cost the valley every bear it had.
    if (n >= cap) console.warn(`[wildlife] site cap ${cap} reached — later species were truncated`);
  }

  // ── streaming ──────────────────────────────────────────────────────────────

  /**
   * The boulders around one home site that an animal could actually stand on
   * top of.
   *
   * `Rocks.rocksAround` answers off the scatter, so it reaches ground that has
   * not streamed in — which matters here, because a group wakes at up to 185 m
   * and the rock cells out there may well be coarser than the ones this asks
   * about. It costs what a streamer cell build costs, and it is paid once per
   * site for the life of the page.
   *
   * What makes a rock a perch:
   *
   *  · **Rise.** Measured from the hillside under the rock to its summit.
   *    Under `rise[0]` it is a kerb and standing on it reads as nothing;
   *    over `rise[1]` the animal is on a spire.
   *  · **Not taller than it is wide.** `Brain._groundY` models a boulder as a
   *    dome whose flank is the ramp the animal walks up, so a rock with no
   *    flank would be a wall a goat strolls through. This is the rule that
   *    keeps that from happening, and it is why crag towers are skipped and
   *    fat talus blocks are not.
   *
   * Biggest first, capped at four: a goat picking the hero boulder of a field
   * is the shot, and past four the extra entries only widen the choice enough
   * to stop the band converging on one outcrop.
   */
  _findPerches(g, x, z, cfg) {
    if (g.rocks) {
      // Already searched. Free the claims from the last time this site was
      // awake — the brains that held them are long recycled.
      for (const r of g.rocks) r.taken = -1;
      return;
    }
    g.rocks = [];
    const R = this._rocks;
    if (!R?.rocksAround) return;
    const W = this.ctx.world;
    // ── why the query asks for EVERYTHING ─────────────────────────────────
    // `minSize` is not a filter the rock scatter applies after the fact — it
    // changes the random stream a cell is generated with (a course that is
    // entirely below the cutoff returns early instead of drawing its numbers),
    // so the same cell at two cutoffs is two different fields of rock, not a
    // subset and a superset. Asking at 0.6 therefore answered a question about
    // a hillside the player will never see: every cell within ~180 m of the
    // camera is generated at minSize 0, and that is the rock an animal can
    // actually be standing on. Half the boulders this used to find did not
    // exist by the time anybody arrived.
    //
    // So the query is for the complete set and the size cut is made here. The
    // cost is a full cell build for ground that has not streamed in yet, which
    // is why `search` is a couple of cells wide and the answer is cached for
    // the life of the site.
    _rockHits.length = 0;
    R.rocksAround(x, z, cfg.search, 0, _rockHits);
    for (const inst of _rockHits) {
      if (inst.size < cfg.minSize) continue;
      const r = R.reachOf(inst);
      if (r > cfg.maxR) continue;
      const top = R.topOf(inst);
      // Against the ground at the rock's own centre, which is the only place
      // the number means anything: placement sinks a block against the LOWEST
      // corner of its footprint, so on a hillside a great many rocks have
      // their summit below the ground at the middle of them. Those come out
      // negative here and are rejected by the same test that rejects kerbs.
      const rise = top - W.getHeight(inst.x, inst.z);
      if (rise < cfg.rise[0] || rise > cfg.rise[1]) continue;
      if (rise < r * cfg.steep) continue;
      // The rock's REAL top over the disc the animal stands on. `top` alone is
      // one number for the whole boulder and holding it flat floated the goat a
      // mean 0.52 m; `Brain._groundY` stands the animal on this instead and
      // keeps `top` only for the ramp. Baked here because this search already
      // runs once per site and is cached for the life of the page — see
      // `Rocks.perchField` for what a ray costs and why the grid is coarse.
      const field = R.perchField ? R.perchField(inst, r) : null;
      g.rocks.push({ x: inst.x, z: inst.z, top, r, rise, field, taken: -1 });
    }
    _rockHits.length = 0;
    g.rocks.sort((a, b) => b.rise - a.rise);
    if (g.rocks.length > 4) g.rocks.length = 4;
  }

  /**
   * Move the band's stand point next to its best boulder.
   *
   * The site itself is a jittered point inside a 32 m suitability cell and its
   * exact position carries no information; the boulder is a real feature of
   * the ground. So when the two are close enough, the rock wins — which is the
   * difference between "goats on a rocky hillside" and "goats at that rock".
   * It also means an animal is never far from the thing it wants to climb, so
   * a band is not commuting for a minute each way.
   *
   * Bounded by `snap`, and that bound is a streaming rule rather than a taste
   * one: `_scan` measures spawn, despawn and the frustum guard at the SITE, so
   * dragging the animals far from it would eventually let a group wake up
   * inside the player's view. See the goat's `snap` note.
   */
  _standAtRock(g, out, seed, W, cfg) {
    const R = g.rocks?.[0];
    if (!R) return;
    const dx = R.x - out.x, dz = R.z - out.z;
    if (dx * dx + dz * dz > cfg.snap * cfg.snap) return;
    // Deterministic per site, so a band does not stand somewhere different
    // each time its site streams in.
    const ang = (((seed >>> 8) & 255) / 255) * Math.PI * 2;
    const rad = R.r + 4 + (((seed >>> 16) & 127) / 127) * 5;
    for (let i = 0; i < 6; i++) {
      const a = ang + i * 1.05;
      const x = R.x + Math.sin(a) * rad, z = R.z + Math.cos(a) * rad;
      if (!W.isInBounds(x, z)) continue;
      if (W.getWaterDepth(x, z) > WATER_MAX) continue;
      if (W.getSlope(x, z) > cfg.slopeMax) continue;
      out.x = x; out.z = z;
      return;
    }
  }

  _liveCount(key) {
    let c = 0;
    for (const per of this.pool[key]) for (const a of per) if (a.active) c++;
    return c;
  }

  _activate(si, camPos) {
    const S = this.sites;
    const ki = S.spec[si];
    const key = this.keys[ki];
    const rng = mulberry32(S.seed[si]);
    const count = Math.max(1, S.count[si]);
    if (this._liveCount(key) + count > Math.max(2, Math.round(CFG[key].live * this.mul))) return false;

    const g = S.rec[si];
    g.alarm = 0; g.fleeH = null; g.pinned = false; g.members.length = 0;
    const fresh = this._time - S.memoT[si] > 60;
    const W = this.ctx.world;
    // Where in the site they stand, as opposed to where the site is.
    const stand = this._standPoint(si, key, _stand);
    // The two alpine species stand on boulders, and this is where the group
    // learns which ones. Cached on the record: the scatter is a pure function
    // of position and seed, so a site's rocks never change and a site that
    // wakes fifty times pays for the search once.
    const climb = SPECIES[key].brain.rock;
    if (climb) {
      this._findPerches(g, stand.x, stand.z, climb);
      this._standAtRock(g, stand, S.seed[si], W, climb);
    }
    // Scatter members on ground this species will actually stand on. The
    // hard-coded 0.9 here was the whole cast's limit; on a talus fan every
    // candidate fails it, all eight tries are rejected and the herd lands in a
    // pile on the exact stand point — which reads as a spawner, the one thing
    // the scatter exists to avoid.
    const slopeMax = climb ? climb.slopeMax : 0.9;

    for (let m = 0; m < count; m++) {
      const vi = pickVariant(key, rng());
      const a = this._take(key, vi);
      if (!a) break;
      let x, z, heading;
      if (fresh) {
        // Scatter the herd around its home, rejecting water and cliffs. A herd
        // that spawns in a perfect ring reads as a spawner.
        let ok = false;
        for (let t = 0; t < 8 && !ok; t++) {
          const ang = rng() * Math.PI * 2;
          const r = m === 0 ? rng() * 2 : (2 + rng() * SPECIES[key].brain.herdRadius);
          x = stand.x + Math.sin(ang) * r;
          z = stand.z + Math.cos(ang) * r;
          ok = W.isInBounds(x, z) && W.getWaterDepth(x, z) <= WATER_MAX
            && W.getSlope(x, z) < slopeMax;
        }
        if (!ok) { x = stand.x; z = stand.z; }
        heading = rng() * Math.PI * 2;
      } else {
        const o = (si * 4 + m) * 3;
        x = S.memo[o]; z = S.memo[o + 1]; heading = S.memo[o + 2];
      }

      a.active = true;
      a.group = g;
      a.slot = m;
      a.brain.bind(g, m, (S.seed[si] ^ (m * 2654435761)) >>> 0);
      a.brain.reset(x, W.getHeight(x, z), z, heading, a.size);
      a.brain.home.set(stand.x, 0, stand.z);
      if (g.line && key === 'bear') a.brain.state = ST.PATROL;
      a.rig._warm = false;
      a.rig.reset(a.brain.pos, heading, W);
      a.mesh.visible = true;
      a.acc = 0;
      g.members.push(a);
    }
    if (!g.members.length) return false;
    S.live[si] = g;
    void camPos;
    return true;
  }

  _deactivate(si) {
    const S = this.sites;
    const g = S.live[si];
    if (!g) return;
    for (let m = 0; m < g.members.length && m < 4; m++) {
      const a = g.members[m];
      const o = (si * 4 + m) * 3;
      S.memo[o] = a.brain.pos.x;
      S.memo[o + 1] = a.brain.pos.z;
      S.memo[o + 2] = a.brain.heading;
    }
    S.memoT[si] = this._time;
    for (const a of g.members) {
      a.active = false;
      a.group = null;
      a.brain.group = null;
      a.mesh.visible = false;
      a.mesh.position.set(0, -500, 0);
    }
    g.members.length = 0;
    S.live[si] = null;
  }

  /**
   * The nearest animal worth hinting at, or null — what puts the paw print on
   * the compass strip.
   *
   * "Worth hinting at" is three things:
   *
   *  · Inside its own species' `hintDist` (that species' file under mammals/,
   *    in the brain block beside the other distance thresholds). One per species
   *    rather than one for the game, because the bands they describe are not
   *    the same size: a deer minds you from 108 m and a bear from 66 m, so a
   *    single radius would either hint at deer far too late or at bears far
   *    too early. Every one of them sits inside its species' spawn ring, which
   *    is the real ceiling — outside that there is no animal to pin.
   *
   *  · Not already in the logbook for this streamed-in lifetime. `_statSeen`
   *    is Stats' flag, set when an animal comes within 20 m and into frame,
   *    and reusing it is the point: the paw is the lead-in to that rule, so it
   *    should go out at exactly the moment the sighting is credited. A paw
   *    still burning over a deer the player is looking straight at is the
   *    HUD nagging about something already found.
   *
   *  · Nearest first, and only one is ever returned. A herd of four deer is
   *    one thing to go and look at, not four pins stacked on one bearing.
   *
   * Measured from where the player actually is rather than from the camera,
   * for the reason `_anchor` gives in HUD.js: the chase boom sits several
   * metres back, and the brain's own thresholds are measured from the camper
   * too, so this keeps the paw and the animal's nerves on the same ruler.
   *
   * Walks the live pool, which is capped at 32 animals across all five species
   * (the `live` column of CFG). HUD calls it from `_refreshMarks` at 4 Hz, and
   * Stats does the same walk at 6 Hz for the logbook, so this is a rounding
   * error on a pass the frame already pays for.
   */
  nearestHint(x, z, quarry = null) {
    if (!this.enabled || !this.pool) return null;
    if (quarry) return this._nearestQuarry(x, z, quarry);
    let best = null, bestD2 = Infinity;
    for (const key of this.keys) {
      // SPECIES[key].brain, not the CFG table above: CFG is this file's
      // streaming config (spawn radii, densities) and the distance thresholds
      // all live together in the brain block, which is where this one belongs.
      const hint = SPECIES[key].brain?.hintDist;
      if (!hint) continue;
      const r2 = hint * hint;
      for (const per of this.pool[key]) {
        for (const a of per) {
          if (!a.active || a._statSeen) continue;
          const p = a.brain?.pos;
          if (!p) continue;
          // Flat distance, matching Stats and the brain: an animal on the bank
          // below a clifftop track is not far away in the sense the player
          // means.
          const dx = p.x - x, dz = p.z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 > r2 || d2 >= bestD2) continue;
          bestD2 = d2; best = p;
        }
      }
    }
    return best ? { x: best.x, z: best.z, dist: Math.sqrt(bestD2) } : null;
  }

  /**
   * Is `id` something this system can point at? The journal asks before it
   * draws a target on a checklist row, so the answer has to cover both backends
   * — the mammals in `SPECIES` and the perch-and-fly birds in `treeBirds` —
   * and it is derived rather than listed. The hunt's ids ARE these systems'
   * own keys (`hunt_items.js` rule 1 says so and says why), so a species added
   * to either table becomes trackable with nothing else to remember.
   *
   * What is deliberately NOT here: the camp dog, whose camp is already a
   * permanent compass pin, and the flocks, the sky and the places. A row this
   * returns false for simply draws no target — see `Journal._rowAt`.
   */
  canTrack(id) {
    return !!SPECIES[id] || !!this.treeBirds?.hasSpecies?.(id);
  }

  /**
   * The player's chosen quarry, or null — the paw when the journal has a target
   * ringed on it.
   *
   * Three things separate this from the ambient walk above, and each of them is
   * the whole reason the feature exists:
   *
   *  · **One species, not the nearest.** The ambient paw is fair to all six
   *    mammals, which on this map means it points at a squirrel: the valley
   *    carries 659 squirrel sites and 348 rabbit against 22 bear. A player who
   *    has said "I am looking for the bear" is not helped by an honest answer
   *    to a question they did not ask.
   *
   *  · **The spawn ring, not the hint band.** `hintDist` is tuned for an
   *    unasked-for nudge — a bear's is 79 m, which is close enough to walk into
   *    one by accident. The ceiling on any of this is the streaming radius,
   *    because outside it there is no animal to point at, so a named quarry
   *    gets the whole ring: 185 m for a bear, 190 for a bird. That is the
   *    widening, and it is the most a pin can honestly do — it still cannot
   *    know about an animal that has not been streamed in, so this is a better
   *    nudge and not a waypoint.
   *
   *  · **`_statSeen` does not silence it.** That flag means "credited in the
   *    logbook" — within 20 m and in frame — and for the ambient paw it is
   *    exactly right, because a paw still burning over a deer you are looking
   *    at is the HUD nagging. But the hunt asks for a PHOTOGRAPH, and seeing a
   *    bear is not photographing one. The quarry's pin therefore stands until
   *    the line is crossed off, which is enforced at the other end: `hunt`
   *    clears the target the moment it is awarded, so a quarry that reaches
   *    this function is by construction one the player still needs.
   *
   * `PAW_HIDE` in HUD.js still stands the pin down inside 8 m, for both kinds.
   * That is not this rule being undone — a bearing to something two paces away
   * swings across the whole strip, and at 8 m you are looking at the animal.
   */
  _nearestQuarry(x, z, quarry) {
    const bird = this.treeBirds?.nearestOf?.(quarry, x, z, BIRD_QUARRY_R);
    if (bird) return bird;
    const per = this.pool[quarry];
    if (!per) return null;
    const r = CFG[quarry]?.spawn ?? 0;
    let best = null, bestD2 = r * r;
    for (const slots of per) {
      for (const a of slots) {
        if (!a.active) continue;
        const p = a.brain?.pos;
        if (!p) continue;
        const dx = p.x - x, dz = p.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= bestD2) continue;
        bestD2 = d2; best = p;
      }
    }
    return best ? { x: best.x, z: best.z, dist: Math.sqrt(bestD2) } : null;
  }

  /**
   * How much distance-silhouette the hides should be running, as a scale on
   * view depth. See the SIL block in mammals/hide.js for why the treatment
   * is depth-denominated in the first place and why that stops being the right
   * denominator the moment something changes the field of view.
   *
   * Two cases turn it down:
   *
   *  · Magnification. The camp telescope drives this same camera down to a 6
   *    degree field of view (camp_scope_view.js), which is eight times life
   *    size: a deer at 145 m fills the frame like one at 18 m, and flattening
   *    it to a dark shape throws away the detail the player picked up the
   *    telescope to look at. Dividing depth by the magnification against
   *    SIL_FOV_REF makes the ramp apparent-size denominated, which is what it
   *    always meant. It also picks up the chase camera's own fov breathing
   *    (50 at rest, 62 flat out, less 9 zoomed wide) for free, in the correct
   *    direction — a wider lens really does make the animal smaller.
   *
   *  · Photo mode, where it goes off entirely. That mode renders at full
   *    resolution and its whole output is a still that gets looked at large and
   *    shared, so the sixteen-pixel argument the treatment rests on is simply
   *    not true there. Its zoom is a dolly on freeDist about the pivot rather
   *    than a lens, so magnification alone would never catch it: the player
   *    composing a shot of a deer eighty metres off-axis can dolly all day and
   *    the deer stays eighty metres away.
   *
   * Reads the camera one frame late — CameraRig writes fov in lateUpdate — on a
   * value that is damped anyway. The damp is for the telescope, whose fov is
   * itself damped and which leaves the world running.
   *
   * Photo mode has to be a cut, and not as a style choice: it sets
   * `ctx.worldPaused`, which makes main.js drive every world system with dt 0,
   * so a damp here would never advance a single step and the mode would sit at
   * whatever scale it was entered with. Cutting on the transition is also what
   * matches the rest of that mode, which cuts the camera, the HUD and the
   * render resolution on the same frame.
   */
  _silScale(dt, cam) {
    const photo = this.ctx.systems?.cameraRig?.mode === 'free';
    let want = 0;
    if (!photo) {
      const t = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
      const tRef = Math.tan(THREE.MathUtils.degToRad(SIL_FOV_REF) * 0.5);
      // Capped above 1: a very wide lens should not invent extra silhouette
      // beyond what the ramp was tuned to give.
      want = clamp(t / tRef, 0, 1.15);
    }
    if (photo !== this._silPhoto) { this._silPhoto = photo; this._sil = want; }
    else if (dt > 0) this._sil = damp(this._sil, want, 6, dt);
    setHideSilScale(this._sil);
  }

  /**
   * Wake and sleep home sites around the camera.
   *
   * The frustum guard is the rule that "nothing pops into existence in view":
   * a site inside the view cone only wakes at nearly the full spawn radius,
   * where an animal is a handful of fogged pixels. Everything closer has to
   * come in from behind or off the edge of the screen.
   *
   * ── the nocturnal gate ─────────────────────────────────────────────────────
   * A raccoon only exists between about 20:00 and 05:00, and this is the layer
   * that decides it — not `_suit`. Home sites are placed once at init, before
   * the world has a time of day at all and for a map that has to be the same
   * map at every hour, so a habitat term could only ever say *where* a raccoon
   * lives and never *when*. Streaming is the part of this file that already
   * owns when an animal exists.
   *
   * Coming out is a plain gate: no raccoon site wakes while `_night` is false.
   * Going home is deliberately not the mirror of it, because the sun does not
   * ask whether the player is looking. A group caught out by the dawn is
   * recycled the moment it is either out of frame or well past the near half of
   * its own despawn band, which is the same "nothing pops in view" rule the
   * spawn side runs, played backwards. In practice they are all gone within a
   * scan or two of the ramp: the raccoon's whole band is 124 m and the player
   * is rarely watching more than one group.
   */
  _scan(camPos) {
    const S = this.sites;
    if (!S.n) return;
    const cam = this.ctx.camera;
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);

    // Latched, so a nightFactor hovering on the threshold through dusk cannot
    // spawn and despawn the same group on alternate scans. Read once here
    // rather than per site.
    const nf = SKY_STATE.nightFactor;
    this._night = nf > (this._night ? NIGHT_SLEEP : NIGHT_WAKE);

    let groups = 0;
    for (let i = 0; i < S.n; i++) {
      const key = this.keys[S.spec[i]];
      const c = CFG[key];
      const dx = S.x[i] - camPos.x, dz = S.z[i] - camPos.z;
      const d2 = dx * dx + dz * dz;
      const live = S.live[i];
      // The only nocturnal species. A table lookup would be tidier and this is
      // the 0.3 s scan over every site on the map, so it stays a compare.
      const nightOnly = key === 'raccoon';

      if (live) {
        groups++;
        if (live.pinned) continue;
        if (nightOnly && !this._night) {
          // Dawn. Put them on their feet and walking rather than standing
          // still waiting to be deleted — a group that vanishes mid-graze
          // reads as a bug even when the player only catches it in the corner
          // of the frame.
          for (const a of live.members) {
            if (a.brain.state === ST.GRAZE || a.brain.state === ST.IDLE) {
              a.brain.state = ST.WANDER; a.brain.timer = 0;
            }
          }
          if (!this._groupVisible(live) || d2 > (c.despawn * 0.45) ** 2) {
            this._deactivate(i);
            groups--;
          }
          continue;
        }
        // Rabbits that have finished bolting are gone; recycle them the moment
        // they are out of sight rather than parking them in the open.
        let allDone = live.members.length > 0;
        for (const a of live.members) if (!a.brain.done) { allDone = false; break; }
        if (d2 > c.despawn * c.despawn || (allDone && !this._groupVisible(live))) {
          this._deactivate(i);
          groups--;
        }
        continue;
      }
      if (d2 > c.spawn * c.spawn) continue;
      if (nightOnly && !this._night) continue;

      // Inside the view cone? Then only at the far edge of the budget.
      _sphere.center.set(S.x[i], this.ctx.world.getHeight(S.x[i], S.z[i]) + 1, S.z[i]);
      _sphere.radius = 14;
      if (_frustum.intersectsSphere(_sphere) && d2 < (c.spawn * 0.82) ** 2) continue;

      if (this._activate(i, camPos)) groups++;
    }
    this.stats.groups = groups;
  }

  _groupVisible(g) {
    for (const a of g.members) {
      _sphere.center.copy(a.brain.pos); _sphere.center.y += 1;
      _sphere.radius = 3;
      if (_frustum.intersectsSphere(_sphere)) return true;
    }
    return false;
  }

  // ── frame ──────────────────────────────────────────────────────────────────

  update(dt, elapsed) {
    if (this._compileWarm) {
      // main.js compiles the scene once at load, and three's compile() only
      // walks *visible* objects — so the pool is built visible and parked
      // underground, and hidden here, on the first frame after the warm-up.
      //
      // `!a.active` is load-bearing. This sweep is about the pool that was
      // built visible for the compile, and an animal a site has already woken
      // is not part of that — hiding it here left it `active && !visible`
      // with nothing that would ever show it again, because only `_activate`
      // sets `visible = true` and it has already run. The animal then walks
      // around the valley, fully simulated, invisible, for the rest of the
      // session.
      //
      // The window is real, not theoretical: `init` sets the flag and only the
      // first `update` clears it, and the journal auto-opens on first run and
      // holds the sim — so anything that spawns before the player closes it
      // (`debugSpawn` from the console, most obviously) lands squarely inside.
      for (const key of Object.keys(this.pool)) {
        for (const per of this.pool[key]) for (const a of per) {
          if (!a.active) a.mesh.visible = false;
        }
      }
      this._compileWarm = false;
    }
    this._time = elapsed;
    const W = this.ctx.world;
    const cam = this.ctx.camera;
    const camPos = cam.position;

    // ── the camper, as far as an animal is concerned ────────────────────────
    const veh = this.ctx.systems?.vehicle;
    let threat = null;
    if (this._threatOverride) {
      threat = this._threatOverride;
    } else if (veh?.position) {
      this._threat.x = veh.position.x;
      this._threat.z = veh.position.z;
      this._threat.speed = veh.speed ?? 0;
      this._threat.heading = veh.heading ?? 0;
      threat = this._threat;
    }

    this._scanT -= dt;
    if (this._scanT <= 0) { this._scanT = 0.30; this._scan(camPos); }

    this._silScale(dt, cam);

    // Frustum for the animation LOD. Recomputed here because the camera has
    // moved since the scan.
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);

    let live = 0;
    // this.keys, not Object.keys(this.pool): the latter allocated a fresh array
    // of species names every frame, which is exactly the kind of per-frame
    // garbage the budget forbids.
    for (const key of this.keys) {
      for (const per of this.pool[key]) {
        for (const a of per) {
          if (!a.active) continue;
          live++;
          this._step(a, dt, W, threat, cam, camPos);
        }
      }
    }
    this.stats.live = live;

    // Herd alarm decays on the group, not the individual, so a herd that has
    // calmed down does so together.
    for (let i = 0; i < this.sites.n; i++) {
      const g = this.sites.live[i];
      if (g && g.alarm > 0) {
        let any = false;
        for (const a of g.members) {
          if (a.brain.state === ST.ALERT || a.brain.state === ST.FLEE) { any = true; break; }
        }
        if (!any) { g.alarm = 0; g.fleeH = null; }
      }
    }

    this.birds.update(dt, cam, threat);
    this.treeBirds.update(dt, cam, threat);
    this.fireflies?.update(dt, elapsed);
    // Last, and outside the frozen check above on purpose: `_frozen` is the
    // gallery's and the harness's switch for holding the CAST still, and there
    // is at most one of him — a bigfoot that ignored it would be a bigfoot
    // walking through a paused world.
    if (!this._frozen) this.bigfoot?.update(dt, cam);
  }

  /** One animal: brain, then LOD, then the gait solver. */
  _step(a, dt, W, threat, cam, camPos) {
    const B = a.brain;
    if (!this._frozen) {
      const lead = B.leader ? null : a.group.members[0]?.brain ?? null;
      B.update(dt, W, threat, lead);
    }
    // Debug surface only — see `debugGait`. Held after the Brain has run so it
    // overrides whatever pace the state machine chose, and nowhere near the
    // Brain's own steering, which keeps working.
    if (this._gaitPin && a.key === this._gaitPin.key) B.speed = this._gaitPin.speed;

    const dx = B.pos.x - camPos.x, dy = B.pos.y - camPos.y, dz = B.pos.z - camPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Geometry LOD. On the procedural track both meshes share the skeleton, so
    // the swap is one assignment and costs nothing at the moment it happens; a
    // hand-authored animal has the one mesh its artist made and does nothing
    // here. Asked of the rig rather than done to the mesh, because "how this
    // animal is drawn" is precisely what the two backends disagree about.
    const wantLod = dist > NEAR_GEOM ? 1 : 0;
    if (wantLod !== a.lod) { a.lod = wantLod; a.rig.setLod(wantLod); }
    // Shadows are the second draw call per animal. Past the point where an
    // animal's own shadow is a smudge, drop it.
    a.rig.setShadow(dist < SHADOW_DIST);

    // Animation rate. Anything close, or on screen, is animated every frame.
    // Anything else is stepped a few times a second purely so it arrives in the
    // right place when it does come into view.
    let full = dist < FULL_ANIM;
    if (!full) {
      _sphere.center.set(B.pos.x, B.pos.y + 1, B.pos.z);
      _sphere.radius = 3.5;
      full = _frustum.intersectsSphere(_sphere);
    }

    // The gait solver asks the world exactly one question — the height at a
    // point — so an animal standing on a boulder is handed something else that
    // answers it. `B.ground` exists only on the alpine pair and is only used
    // while one of them is actually engaged with a rock; everything else, and
    // those two the rest of the time, get the world itself. See Brain._groundY.
    const G = (B.rock && B.ground) ? B.ground : W;
    if (full) {
      a.rig.update(dt, B.fill(a.drive, a.lod), G);
      a.acc = 0;
    } else {
      a.acc += dt;
      if (a.acc >= 1 / IDLE_HZ) {
        a.rig.update(Math.min(a.acc, 0.2), B.fill(a.drive, 1), G);
        a.acc = 0;
      }
    }
    void cam;
  }

  // ── debug surface ──────────────────────────────────────────────────────────

  /**
   * Force a group into existence near the camera (or at an explicit spot) and
   * pin it there. The canonical capture views will not reliably contain an
   * animal, so every wildlife frame in `shots/` is framed off this.
   */
  debugSpawn(key = 'deer', opts = {}) {
    const W = this.ctx.world;
    const cam = this.ctx.camera;
    const dist = opts.dist ?? 12;
    let x, z;
    if (opts.x !== undefined) { x = opts.x; z = opts.z; }
    else {
      _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
      x = cam.position.x + _v.x * dist;
      z = cam.position.z + _v.z * dist;
    }
    // Walk outward until the ground is dry and walkable — and, if asked, clear
    // of trees, so a capture is not framed on the back of a spruce.
    const clearR = opts.clear ?? 0;
    let bx = x, bz = z, found = false;
    for (let r = 0; r < 26 && !found; r++) {
      for (let s = 0; s < 12; s++) {
        const a = (s / 12) * Math.PI * 2 + r * 0.31;
        const tx = x + Math.sin(a) * r * 2, tz = z + Math.cos(a) * r * 2;
        if (!W.isInBounds(tx, tz)) continue;
        if (W.getWaterDepth(tx, tz) > WATER_MAX) continue;
        if (W.getSlope(tx, tz) > 0.7) continue;
        if (clearR && this._treeNear(tx, tz, clearR)) continue;
        bx = tx; bz = tz; found = true; break;
      }
    }

    const ki = this.keys.indexOf(key);
    const S = this.sites;
    // Reuse the nearest sleeping site of this species so the record keeps its
    // deterministic seed; nothing here invents a new site.
    let best = -1, bestD = Infinity;
    for (let i = 0; i < S.n; i++) {
      if (S.spec[i] !== ki || S.live[i]) continue;
      const d = (S.x[i] - bx) ** 2 + (S.z[i] - bz) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return null;
    S.x[best] = bx; S.z[best] = bz;
    S.memoT[best] = -1e9;
    if (opts.count) S.count[best] = opts.count;
    this._exactPlacement = true;
    const activated = this._activate(best, cam.position);
    this._exactPlacement = false;
    if (!activated) return null;
    const g = S.live[best];
    g.pinned = true;
    if (opts.state !== undefined) {
      for (const a of g.members) { a.brain.state = opts.state; a.brain.timer = 999; }
    }
    const lead = g.members[0];
    return { x: lead.brain.pos.x, y: lead.brain.pos.y, z: lead.brain.pos.z, site: best, n: g.members.length };
  }

  /** Is there a tree within `r` metres? Debug framing only. */
  _treeNear(x, z, r) {
    const T = this.ctx.systems?.trees?.trees;
    if (!T) return false;
    const gx = clamp(((x + T.half) / T.BS) | 0, 0, T.BW - 1);
    const gz = clamp(((z + T.half) / T.BS) | 0, 0, T.BW - 1);
    for (let j = -1; j <= 1; j++) {
      const zz = gz + j; if (zz < 0 || zz >= T.BW) continue;
      for (let i = -1; i <= 1; i++) {
        const xx = gx + i; if (xx < 0 || xx >= T.BW) continue;
        const b = zz * T.BW + xx;
        for (let k = T.bucketStart[b]; k < T.bucketStart[b + 1]; k++) {
          const t = T.order[k];
          const dx = T.px[t] - x, dz = T.pz[t] - z;
          const rr = r + T.pImpW[t] * 0.35;
          if (dx * dx + dz * dz < rr * rr) return true;
        }
      }
    }
    return false;
  }

  /**
   * Canopy weight within `r` metres — `_treeNear`'s walk, but counting and
   * weighted by how much sky each trunk actually takes up.
   *
   * Only ever called when a site streams in, never per frame.
   */
  _canopy(x, z, r) {
    const T = this.ctx.systems?.trees?.trees;
    if (!T) return 0;
    const gx = clamp(((x + T.half) / T.BS) | 0, 0, T.BW - 1);
    const gz = clamp(((z + T.half) / T.BS) | 0, 0, T.BW - 1);
    let w = 0;
    for (let j = -1; j <= 1; j++) {
      const zz = gz + j; if (zz < 0 || zz >= T.BW) continue;
      for (let i = -1; i <= 1; i++) {
        const xx = gx + i; if (xx < 0 || xx >= T.BW) continue;
        const b = zz * T.BW + xx;
        for (let k = T.bucketStart[b]; k < T.bucketStart[b + 1]; k++) {
          const t = T.order[k];
          const dx = T.px[t] - x, dz = T.pz[t] - z;
          const d2 = dx * dx + dz * dz;
          const rr = r + T.pImpW[t] * 0.35;
          if (d2 < rr * rr) w += T.pImpW[t] / (1 + Math.sqrt(d2));
        }
      }
    }
    return w;
  }

  /**
   * Where inside a site the animals actually stand.
   *
   * The habitat scoring that *chose* this site is untouched, and should be:
   * deer really do live on forest edges and that is what makes the density
   * feel earned. But an edge site has two sides, and which one the animal
   * stands on decides whether the player ever sees it. A deer under the canopy
   * is a dark shape on a dark backdrop, and no amount of tuning its hide value
   * fixes that — value contrast is a relationship, not a property of the
   * animal. Reference plate 3 makes the point better than any measurement:
   * its bear is legible at a hundred metres partly because it is flat and dark
   * and broadside, and partly because it is standing well clear of the trees.
   *
   * So this walks the stand point a few metres toward the open side of the
   * edge it is already on. The site is still an edge site, the animal is still
   * browsing the edge, and it is now silhouetted against meadow instead of
   * buried in shadow.
   *
   * Deliberately modest. A large offset would march deer into the middle of
   * open meadow, which reads as a spawner and loses the edge habitat the site
   * was picked for in the first place.
   *
   * On testing the backdrop's *value* rather than its openness: every hide in
   * the cast is dark, and the distance treatment drives them darker still, so
   * "put the animal where its backdrop differs in value" collapses for this
   * cast into "put the animal where its backdrop is bright". Openness is that
   * test. It does not catch a stand point that is open but under cloud shadow;
   * nothing available here does, and guessing at one would be worse than
   * saying so.
   */
  _standPoint(si, key, out) {
    const S = this.sites, W = this.ctx.world;
    const push = SPECIES[key].brain.standoff ?? 0;
    out.x = S.x[si]; out.z = S.z[si];
    // `debugSpawn` names an exact spot and every capture harness frames on it.
    // Walking the animal several metres off that is how a framing tool starts
    // quietly lying to you, so the stand-off is suppressed for it.
    if (push <= 0 || this._exactPlacement) return out;

    // Measured across 322 streamed deer, canopy weight at a site runs a median
    // of 3.1 with a quarter of sites under 2.2, so the thresholds below are in
    // those units and not the 0-1 the first cut of this assumed.
    const here = this._canopy(out.x, out.z, 11);
    // Already in the open: leave it alone. Moving an animal that is not in
    // shadow buys nothing and only risks walking it somewhere worse.
    if (here < 0.8) return out;

    // Eight bearings, deterministic per site so a site does not jitter its
    // animals to a different spot each time it streams in.
    const jitter = ((S.seed[si] & 255) / 255) * 0.78;
    let bx = out.x, bz = out.z, bestOpen = here, moved = false;
    for (let i = 0; i < 8; i++) {
      const a = jitter + (i / 8) * Math.PI * 2;
      const tx = out.x + Math.sin(a) * push;
      const tz = out.z + Math.cos(a) * push;
      if (!W.isInBounds(tx, tz)) continue;
      if (W.getWaterDepth(tx, tz) > WATER_MAX) continue;
      if (W.getSlope(tx, tz) > 0.7) continue;
      const open = this._canopy(tx, tz, 11);
      if (open < bestOpen) { bestOpen = open; bx = tx; bz = tz; moved = true; }
    }
    // Only worth it if the move actually bought a meaningful change of
    // backdrop; a shuffle between two equally shaded spots is just noise.
    if (moved && here - bestOpen > 0.3) { out.x = bx; out.z = bz; }
    return out;
  }

  /** Despawn everything, pinned or not. */
  debugClear() {
    for (let i = 0; i < this.sites.n; i++) {
      if (this.sites.live[i]) { this.sites.live[i].pinned = false; this._deactivate(i); }
    }
  }

  /** Pretend the camper is here, at this speed — the only way to test fleeing. */
  debugThreat(x, z, speed = 12) {
    this._threatOverride = x === null ? null : { x, z, speed, heading: 0 };
  }

  debugFreeze(on = true) { this._frozen = !!on; }

  /**
   * Hold one species at a named gait's cruising speed. Debug surface.
   *
   * A look test wants the gait still in the frame, not whatever the state
   * machine happened to pick, and waiting for an animal to choose a trot on its
   * own is how a capture run produces eight pictures of a standing fox.
   *
   * The speed pinned is the species' UNSCALED cruise, which is exactly the
   * number the gait bands are measured against — so the clip being judged sits
   * at weight 1 rather than part-way through a crossfade. Pass no gait to
   * release. Applies to both backends: a procedural animal picks the matching
   * rung of its gait ladder from the same speed.
   */
  debugGait(key, gait = null) {
    if (!gait) { this._gaitPin = null; return null; }
    const g = SPECIES[key]?.gait;
    if (!g) return null;
    const speed = gait === 'stand' ? 0 : g[gait];
    if (speed === undefined) return null;
    this._gaitPin = { key, speed };
    return speed;
  }

  /** A readable dump of every live animal, for the motion-strip harness. */
  debugState() {
    const names = ['idle', 'graze', 'wander', 'alert', 'flee', 'patrol', 'watch',
      'climb', 'perch'];
    const out = [];
    for (const key of Object.keys(this.pool)) {
      for (const per of this.pool[key]) {
        for (const a of per) {
          if (!a.active) continue;
          out.push({
            key, variant: a.proto.variant.name, state: names[a.brain.state],
            x: +a.brain.pos.x.toFixed(2), y: +a.brain.pos.y.toFixed(2), z: +a.brain.pos.z.toFixed(2),
            speed: +a.brain.speed.toFixed(2), gait: a.rig.gaitName, lod: a.lod,
          });
        }
      }
    }
    return out;
  }

  debugBurst(x, y, z) { return this.birds.debugBurst(x, y, z); }

  onQuality(preset) {
    this.mul = clamp(preset?.treeMul ?? 1, 0.4, 1);
  }

  dispose() {
    this.debugClear();
    this.group.removeFromParent();
    const seen = new Set();
    for (const key of Object.keys(this.protos)) {
      // `seen`, because the hand-authored track shares one bounds carrier
      // across both LOD slots and all of a species' coats — the procedural
      // track's geometries are all distinct and pass straight through.
      for (const p of this.protos[key]) {
        for (const g of p.geoms) { if (!seen.has(g)) { seen.add(g); g.dispose(); } }
      }
      for (const m of this.mats[key]) m.dispose();
    }
    for (const key of Object.keys(this.pool ?? {})) {
      for (const per of this.pool[key]) for (const a of per) a.rig.dispose?.();
    }
    this.birds?.dispose();
    this.treeBirds?.dispose();
    this.fireflies?.dispose();
    this.bigfoot?.dispose();
  }
}

export { CFG as WILDLIFE_CFG };
