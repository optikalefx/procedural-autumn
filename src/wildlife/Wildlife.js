// ─────────────────────────────────────────────────────────────────────────────
//  Wildlife — deer, bears, rabbits and birds, alive in the valley.
//
//  The layers below this one do the hard parts:
//    animal_rig      geometry + skeleton, one draw call per animal
//    animal_species  the blueprints and the palette
//    animal_anim     procedural gaits driven by real ground speed
//    animal_brain    the state machine and the steering
//    birds           two instanced flocks and a startle burst
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
import { NoiseField } from '../core/Noise.js';
import { clamp, clamp01, lerp, damp, smoothstep, mulberry32, hash2i } from '../core/MathUtils.js';
import { SPECIES, buildSpecies, createHideMaterial, pickVariant,
         setHideSilScale, SIL_FOV_REF } from './animal_species.js';
import { instantiate } from './animal_rig.js';
import { AnimRig } from './animal_anim.js';
import { Brain, ST, WATER_MAX } from './animal_brain.js';
import { Birds } from './birds.js';
import { TreeBirds } from './tree_birds.js';

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
};

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
  }

  async init() {
    const { scene, preset } = this.ctx;
    // The quality preset does not carry a wildlife knob, so ride on the tree
    // multiplier: a machine that cannot afford the forest cannot afford a herd.
    this.mul = clamp(preset?.treeMul ?? 1, 0.4, 1);

    this.keys = Object.keys(SPECIES);
    this._buildProtos();
    this._buildPool();
    this._placeSites();

    this.birds = new Birds(this.ctx, SEED ^ 0x51b1);
    this.birds.build();

    // The perch-and-fly birds — eagles in the trees, herons and flamingos in
    // the shallows. See tree_birds.js and water_birds.js.
    this.treeBirds = new TreeBirds(this.ctx, SEED ^ 0x6ea9);
    this.treeBirds.build();

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

  _buildProtos() {
    this.protos = {};
    this.mats = {};
    for (const key of Object.keys(SPECIES)) {
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
        const inst = instantiate(proto, this.mats[key][vi], 0);
        const rig = new AnimRig(proto, inst, scale, SPECIES[key].gait, key);
        inst.mesh.name = `${key}:${proto.variant.name}`;
        inst.mesh.position.set(0, -500, 0);
        this.group.add(inst.mesh);
        per[vi].push({
          key, vi, proto, inst, rig, scale,
          mesh: inst.mesh,
          brain: new Brain(key, SPECIES[key], (i * 2654435761) >>> 0, null, 0),
          drive: { pos: null, heading: 0, speed: 0, graze: 0, alert: 0, flag: 0, look: null, lod: 0 },
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
   * Suitability, 0..1, for one species at one point. This is the whole habitat
   * model and it is deliberately small: three numbers off the world, one
   * clumping noise, and a hard zero anywhere an animal must not be.
   */
  _suit(key, x, z, W) {
    const depth = W.getWaterDepth(x, z);
    if (depth > WATER_MAX) return 0;
    const slope = W.getSlope(x, z);
    if (slope > 0.80) return 0;
    const h = W.getHeight(x, z);
    if (h > 300) return 0;
    const m = W.getMoisture(x, z);
    const river = W.getRiver(x, z);
    const flat = 1 - smoothstep(0.35, 0.78, slope);

    // Clumping: without it every species is an even Poisson scatter, which the
    // brief calls out by name. Two octaves at ~350 m gives good ground and
    // empty ground rather than a uniform sprinkle.
    const clump = clamp01(this.noise.fbm(x * 0.0029 + key.length * 41.7, z * 0.0029, 2, 2.1, 0.5, 1) * 0.5 + 0.62);

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
          ok = W.isInBounds(x, z) && W.getWaterDepth(x, z) <= WATER_MAX && W.getSlope(x, z) < 0.9;
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
      a.brain.reset(x, W.getHeight(x, z), z, heading, a.scale);
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
   * How much distance-silhouette the hides should be running, as a scale on
   * view depth. See the SIL block in animal_species.js for why the treatment
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
   */
  _scan(camPos) {
    const S = this.sites;
    if (!S.n) return;
    const cam = this.ctx.camera;
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);

    let groups = 0;
    for (let i = 0; i < S.n; i++) {
      const key = this.keys[S.spec[i]];
      const c = CFG[key];
      const dx = S.x[i] - camPos.x, dz = S.z[i] - camPos.z;
      const d2 = dx * dx + dz * dz;
      const live = S.live[i];

      if (live) {
        groups++;
        if (live.pinned) continue;
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
      for (const key of Object.keys(this.pool)) {
        for (const per of this.pool[key]) for (const a of per) a.mesh.visible = false;
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
  }

  /** One animal: brain, then LOD, then the gait solver. */
  _step(a, dt, W, threat, cam, camPos) {
    const B = a.brain;
    if (!this._frozen) {
      const lead = B.leader ? null : a.group.members[0]?.brain ?? null;
      B.update(dt, W, threat, lead);
    }

    const dx = B.pos.x - camPos.x, dy = B.pos.y - camPos.y, dz = B.pos.z - camPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Geometry LOD. Both meshes share the skeleton, so the swap is one
    // assignment and costs nothing at the moment it happens.
    const wantLod = dist > NEAR_GEOM ? 1 : 0;
    if (wantLod !== a.lod) {
      a.lod = wantLod;
      a.mesh.geometry = a.proto.geoms[wantLod];
    }
    // Shadows are the second draw call per animal. Past the point where an
    // animal's own shadow is a smudge, drop it.
    const wantShadow = dist < SHADOW_DIST;
    if (wantShadow !== a.mesh.castShadow) a.mesh.castShadow = wantShadow;

    // Animation rate. Anything close, or on screen, is animated every frame.
    // Anything else is stepped a few times a second purely so it arrives in the
    // right place when it does come into view.
    let full = dist < FULL_ANIM;
    if (!full) {
      _sphere.center.set(B.pos.x, B.pos.y + 1, B.pos.z);
      _sphere.radius = 3.5;
      full = _frustum.intersectsSphere(_sphere);
    }

    if (full) {
      a.rig.update(dt, B.fill(a.drive, a.lod), W);
      a.acc = 0;
    } else {
      a.acc += dt;
      if (a.acc >= 1 / IDLE_HZ) {
        a.rig.update(Math.min(a.acc, 0.2), B.fill(a.drive, 1), W);
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

  /** A readable dump of every live animal, for the motion-strip harness. */
  debugState() {
    const names = ['idle', 'graze', 'wander', 'alert', 'flee', 'patrol', 'watch'];
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
    for (const key of Object.keys(this.protos)) {
      for (const p of this.protos[key]) for (const g of p.geoms) g.dispose();
      for (const m of this.mats[key]) m.dispose();
    }
    this.birds?.dispose();
    this.treeBirds?.dispose();
  }
}

export { CFG as WILDLIFE_CFG };
