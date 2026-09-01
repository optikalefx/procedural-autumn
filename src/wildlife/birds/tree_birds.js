// ─────────────────────────────────────────────────────────────────────────────
//  tree_birds — the movement every perch-and-fly bird shares.
//
//  flocks.js owns the sky: wheeling specks and a startle burst, nine triangles
//  each, never meant to be looked at. This file owns the opposite moment — a
//  bird you *stop* for. A bald eagle at the top of a spruce is a landmark; the
//  same eagle crossing the valley to another tree is an event on the order of
//  a deer sighting.
//
//  The models are one per file next to this one; what lives here is everything
//  they have in common. One InstancedMesh per species, one draw call, animated
//  in the vertex shader (see bird_material.js), and one behaviour: settle →
//  pick a site in an annulus at random → fly to it → settle.
//
//  The species table below is the seam between the two. Three kinds of row:
//
//    tree     the bald eagle. Its perch is a treetop over `minTreeH`.
//    water    the heron and the flamingo (habitat: 'water'), whose perch is a
//             patch of shallow water found through the world's hydro queries.
//    night    the great horned owl, a tree row carrying `nocturnal: true` —
//             the streamer will not hand it a tree unless SKY_STATE.nightFactor
//             says the valley is actually dark. See NIGHT_SPAWN.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneRigged } from 'three/addons/utils/SkeletonUtils.js';
import { clamp, clamp01, lerp, smoothstep, damp, dampAngle, mulberry32 }
  from '../../core/MathUtils.js';
import { SPECIES as TREE_SPECIES } from '../../vegetation/tree_species.js';
import { SKY_STATE } from '../../render/Lighting.js';
import { treeBirdMaterial } from './bird_material.js';
import { buildBaldEagleGeometry } from './bald_eagle.js';
import { buildBlueHeronGeometry } from './blue_heron.js';
import { buildGreatHornedOwlGeometry } from './great_horned_owl.js';

// ── the species table ────────────────────────────────────────────────────────
//
//   live      instance slots (hard cap on simultaneous birds of this species)
//   chance    when a bird leaves the streamed area, the odds it comes back
//             soon rather than going dormant for minutes — the valley should
//             sometimes simply not have an eagle in it
//   wingspan  metres; scale IS wingspan (geometry span is 1.0).
//
//             The two waders are deliberately drawn at 3x life: a real great
//             blue heron is a 2 m span and 1.1 m tall, and at that size it is
//             a grey smudge on a shadowed bank that nobody ever notices. These
//             are landmarks, so they are sized to read as landmarks. Two other
//             numbers move with it and are not free to leave behind — `wade`,
//             because the depth a bird will stand in is a fraction of its leg
//             and a 3 m bird ankle-deep in a puddle looks beached; and
//             `flapHz`, because beat frequency falls as span grows (roughly
//             1/sqrt) and a 6 m wing beating at a 2 m wing's rate buzzes.
//   perchS    seconds on a perch before moving on
//   hop       metres to the next tree, picked at random in that annulus
//   cruise    m/s in level flight
//   flapHz    wingbeat — a bald eagle is a SLOW flapper, and the slowness is
//             most of what distinguishes it from the corvid flocks overhead
//   minTreeH  metres; only mature trees hold a two-metre bird
//   startle   metres; a vehicle closer than this flushes a perched bird
//   startleDelay  seconds that vehicle has to STAY inside `startle`
//              before the bird actually goes. Default 0 — the eagle and
//              the heron leave the moment you crowd them, which is what
//              those birds do. A flamingo colony is the payoff at the end
//              of a boat trip, and a payoff that leaves on the frame you
//              arrive is not one, so it holds for five seconds first.
//   nocturnal  this bird only exists at night. It is never handed a perch
//              while SKY_STATE.nightFactor is under NIGHT_SPAWN, and one that
//              is still out when the sky comes up leaves under its own power
//              rather than blinking off — see the nocturnal block in _scan.
//
// Waders (habitat: 'water') swap the tree
// fields for water ones:
//   wade       metres of standing-water depth a bird will stand in. The cap
//              is what keeps the belly above the surface at full leg length.
//   minSpan    metres of hydro `span` (how OPEN the water is) the site needs —
//              flamingos want a lake margin, not a brook.
//   footY      unit-space foot height (negative); -footY * scale is how far
//              the body origin stands above the bed.
//   perchPitch standing pitch — a wader stands level, not eagle-upright.
//   dip        metres of takeoff drop. An eagle FALLS off its tree onto its
//              wings; a wader starts half a metre over the water and springs.
//   cruiseUp   metres above the higher endpoint the flight cruises.
//   flock      spawns and lands near others of its kind when it can.
//   colony     if set, this species lives on exactly this many islands in the
//              whole valley and NOWHERE else — no mainland fallback. A bird
//              you can meet anywhere is scenery; one that lives on two known
//              islands is somewhere to go, which is the same reason a perched
//              eagle is written up as a landmark. See _ensureIslands.
export const TREE_BIRD_SPECIES = [
  {
    key: 'baldEagle',
    geometry: buildBaldEagleGeometry,
    live: 4,
    chance: 0.65,
    // 2x life. Less than the waders' 3x on purpose: an eagle is already read
    // against a treetop, which gives it a scale reference and a silhouette
    // against sky that a bird standing on a flat shore never gets.
    wingspan: [3.7, 4.5],
    perchS: [24, 75],
    hop: [55, 150],
    cruise: [11.0, 15.0],
    flapHz: [1.55, 2.0],
    flapAmp: [0.72, 0.95],
    minTreeH: 11,
    startle: 26,
  },
  {
    key: 'heron',
    geometry: buildBlueHeronGeometry,
    habitat: 'water',
    live: 3,
    chance: 0.6,
    // 3x life size, on purpose — see the note over TREE_BIRD_SPECIES.
    wingspan: [5.25, 6.0],
    perchS: [30, 90],          // a heron is a statue with a licence to fish
    hop: [40, 120],
    cruise: [8.0, 11.0],
    flapHz: [0.85, 1.1],       // slow, deep, unhurried — half the read
    flapAmp: [0.62, 0.85],
    startle: 30,
    wade: [0.18, 1.14],
    footY: -0.271,
    perchPitch: -0.10,
    dip: 0.3,
    cruiseUp: [3, 7],
  },
  {
    key: 'flamingo',
    // The one hand-authored model in here. Everything else on this table is a
    // `geometry` function lofted into an InstancedMesh and flapped by
    // `bird_material.js`'s vertex shader; this bird is a skinned GLB out of the
    // bought pack, playing its own clips through an `AnimationMixer`. Only
    // `build`, `_park` and `_pose` know the difference — the streaming, the
    // colony, the startle hold and the flight arc below are shared verbatim.
    glb: {
      url: 'models/flamingo_pack.glb',
      // All four measured off the asset and printed by
      // `tools/build_flamingo_blend.py`. None can be recovered downstream.
      //
      // `span` is the widest frame of the wingbeat, and it has to be: the bind
      // pose folds the wings to 0.598 m, so a scale fitted to the rest pose
      // would draw a "4.35 m wingspan" bird 3.6x too big. Measuring the spread
      // frame instead is what lets a pack model authored wings-folded carry the
      // same `wingspan` field as the lofted birds.
      span: 2.128,
      minY: -0.003,          // lowest vertex standing; the fit node lifts it to 0
      // Lowest BODY vertex above the soles, legs excluded — 0.52 m, a mere 32%
      // of this bird's standing height where the lofted one carried its body at
      // 52%. `_wadeY` keeps this point out of the water, and it is the number
      // that decides how deep a flamingo will stand.
      bellyY: 0.244,
      flapHz: 1.2,           // the authored wingbeat — 20 frames at 24 fps
      // The photo silhouette, for `hunt_detect`. It sizes a bird from a sphere
      // in this same unit space and centres it on the bird's origin, which
      // works unremarked for the lofted birds because their origin sits in the
      // body — the procedural flamingo's sphere is r=0.488 about a centre
      // 0.014 off its own. This model's origin is between the SOLES, so a
      // radius about it would have to reach the whole bird and would read 60%
      // over. `unitC` lifts the centre back into the body and `unitR` is the
      // spread radius about it: 0.546 against the old bird's 0.488, which is
      // the honest 12% — this really is the longer bird — and small enough
      // that swapping the model does not move the hunt's gate.
      unitC: 0.379,
      unitR: 0.546,
      clips: { idle: 'idle', fly: 'fly', preen: 'preen' },
    },
    habitat: 'water',
    live: 6,
    chance: 0.7,
    // 3x life size, on purpose — see the note over TREE_BIRD_SPECIES.
    //
    // Kept exactly as it was through the model swap, which makes the bird
    // TALLER than the one it replaces: span:height is 1.316 on the pack model
    // against the lofted bird's 1.61, so at a matched 4.35 m span it stands
    // 3.31 m rather than 2.71. That is the more honest flamingo — a real one is
    // about 1.1 — and `wingspan` is the field this table reasons in, so the
    // span is what is held fixed and the height is allowed to follow.
    wingspan: [4.05, 4.65],
    perchS: [20, 60],
    hop: [30, 90],
    cruise: [9.0, 13.0],
    flapHz: [1.8, 2.25],       // fast shallow beats, nothing like the eagle
    flapAmp: [0.48, 0.68],
    // Not a shy bird. 34 m made it the twitchiest of the three — it left
    // before you were close enough to see it was pink — so it now lets you
    // inside 14 m AND then holds that for five seconds before going.
    startle: 14,
    startleDelay: 5,
    // Both of these moved with the model, and neither is a taste change.
    //
    // `wade` is capped by the rule it always was — keep the water below the
    // belly — re-evaluated against the new mesh. The lofted bird carried its
    // body origin 0.436 units up, so 1.35 m of water was 71% of the 1.90 m it
    // stood clear at a mid-range span. The pack model's lowest body vertex
    // (excluding the legs) is 0.519 units up, which at the same span is
    // 1.061 m, and the same 71% is 0.75. A bird that waded to 1.35 now would
    // be in the water to its keel.
    wade: [0.30, 0.75],
    minSpan: 7,
    // Zero, where the lofted bird needed -0.436: the GLB's origin is already
    // at the soles, so `_wadeY` puts the feet straight onto the bed and the
    // rig's fit node absorbs the -0.003 the mesh hangs below them.
    footY: 0,
    perchPitch: -0.04,
    dip: 0.25,
    cruiseUp: [2.5, 6],
    flock: true,
    colony: 2,
  },
  {
    key: 'owl',
    geometry: buildGreatHornedOwlGeometry,
    nocturnal: true,
    // Two. An owl is an event and it is one the player can only have for a
    // few hours of the cycle, so the valley holds at most a pair — six of them
    // would turn the one bird you are meant to stop the car for into a zoo.
    live: 2,
    chance: 0.5,
    // 2x life, like the eagle and for the same reason (both are read against a
    // treetop), but visibly the smaller bird: a real great horned owl is 1.4 m
    // to a bald eagle's 2.05, and the gap between 2.8 and 4.1 in the world is
    // what says "not an eagle" before the ear tufts are resolvable.
    wingspan: [2.6, 3.0],
    // A statue, more so than the heron: this bird's whole trick is that it is
    // already there, and has been for a while, when the headlights find it.
    perchS: [45, 120],
    hop: [45, 120],
    cruise: [7.5, 10.5],       // unhurried; nothing an owl does is fast
    flapHz: [1.1, 1.45],       // slower than the eagle …
    flapAmp: [0.80, 1.00],     // … and deeper. Big soft wings, few beats.
    // Owls use smaller trees than eagles — a hunting perch wants a view of the
    // ground, not the highest spire in the valley.
    minTreeH: 8,
    // Three seconds of being crowded before it goes, for the flamingo's
    // reason: an owl found at night is a payoff, and a payoff that leaves on
    // the frame the headlights reach it is not one.
    startle: 20,
    startleDelay: 3,
    // Less vertical than the eagle's -0.85. The head is rigid with the body
    // and this one is mostly head: at the eagle's pitch the owl sits on its
    // branch looking at the sky, and the face is the entire animal.
    perchPitch: -0.70,
  },
];

// Streaming ring. Spawn perched birds far enough out that materialising is
// invisible, keep them until well past that, and never place one inside the
// view cone unless it is beyond VIS_OK (where a folded eagle is ~4 px).
const SPAWN_R = [85, 190];
const DESPAWN = 280;
const VIS_OK = 150;

// ── the nocturnal gate ───────────────────────────────────────────────────────
//
// `SKY_STATE.nightFactor` is Lighting's own night ramp, and its shape is the
// reason these are the numbers: it is 0.00 at 19:00, 0.29 at 19:48, 0.83 at
// 20:24 and 1.00 from 21:00 through 04:36 (the table over its definition).
//
// So NIGHT_SPAWN 0.55 means an owl may first arrive around 20:05 — full dusk,
// headlights already on, the sky still blue enough that the bird is not a
// black cut-out. NIGHT_STAY is deliberately much lower than the spawn gate,
// and not for hysteresis alone: a bird that appeared at dusk should be allowed
// to sit through the whole night and out the other side, and 0.30 puts its
// last legal minute at about 05:05, which is dawn twilight rather than
// daylight. Between the two the population only shrinks.
const NIGHT_SPAWN = 0.55;
const NIGHT_STAY = 0.30;

// What counts as an island a wader would use (see _ensureIslands). The area
// window is doing two jobs at once: below it a land component is a gravel
// hummock with no room for a bird, and above it we have caught the mainland,
// which in this valley is ~6.9 M m² and would hand back its whole coastline.
const ISLAND_AREA = [400, 160000];
const ISLAND_RING_WET = 0.6;   // fraction of a ring around it that must be water
const ISLAND_OPEN = 6;         // metres of hydro span: a lake, not a creek bend

// Behaviour states.
const P_PERCH = 0, P_FLY = 1;

// How upright a perched bird sits (rotation about X; negative is nose-up).
// -0.5 read as a bird lying on its belly; a real perched eagle is closer to
// vertical than to horizontal.
const PERCH_PITCH = -0.85;

const _pm = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _sphere = new THREE.Sphere();

/**
 * The asset-side half of a hand-authored bird: one skinned clone, fitted, with
 * a mixer and an action per clip slot.
 *
 * Exported because the gallery has to show the bird through EXACTLY this fit.
 * A gallery that builds its own copy is a gallery that can quietly disagree
 * with the valley, which is the one thing it exists not to do — so the fit
 * lives here and both callers go through it.
 *
 * `SkeletonUtils.clone`, never `Object3D.clone`: a plain clone shares the
 * prototype's bones, so every bird would play whichever one updated last. See
 * the same note in `glb_rig.js`.
 */
export function fitGlbBird(scene, clips, G, wingspan) {
  const rig = cloneRigged(scene);
  rig.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.castShadow = false;            // matches the instanced birds
    o.receiveShadow = false;
    // Streamed in and out of a parked pool, and three's culling works off a
    // bind-pose sphere that a flapping wing leaves behind. The parent's
    // `visible` is the cull that counts.
    o.frustumCulled = false;
  });

  // Two nested transforms, the split `glb_rig.js` argues for. `fit` holds
  // everything about the ASSET and never changes again: the exporter's -Z
  // facing turned to the +Z this file measures yaw from, the metres that make
  // `wingspan` mean wingspan, and the lift that puts the soles on the object's
  // own origin so `_wadeY` can stand it on the bed. The outer Group holds
  // everything about the BIRD and is written every frame.
  const scale = wingspan / G.span;
  const fit = new THREE.Object3D();
  fit.rotation.y = Math.PI;
  fit.scale.setScalar(scale);
  fit.position.y = -G.minY * scale;
  fit.add(rig);

  const obj = new THREE.Group();
  obj.rotation.order = 'YXZ';        // yaw, then pitch, then bank
  obj.add(fit);

  const mixer = new THREE.AnimationMixer(rig);
  const act = {};
  for (const slot of Object.keys(clips)) {
    const a = mixer.clipAction(clips[slot]);
    a.play();
    a.setEffectiveWeight(0);
    act[slot] = a;
  }
  act.idle.setEffectiveWeight(1);
  return { obj, mixer, act, scale };
}

/** Resolve a species' clip slots against a loaded GLB, or say what is missing. */
export function resolveBirdClips(key, G, animations) {
  const clips = {};
  for (const [slot, name] of Object.entries(G.clips)) {
    const clip = animations.find((a) => a.name === name);
    // Fatal for the species rather than silently absent — the same call
    // `loadGlbSpecies` makes, and for the same reason: a flamingo that cannot
    // open its wings is a regression the player sees, and load is the only
    // place it is cheap to notice.
    if (!clip) {
      throw new Error(`[tree_birds] ${key}: no clip "${name}" for slot "${slot}"; `
        + `the GLB carries ${animations.map((a) => a.name).join(', ')}`);
    }
    clips[slot] = clip;
  }
  return clips;
}

export class TreeBirds {
  constructor(ctx, seed) {
    this.ctx = ctx;
    this.rnd = mulberry32(seed >>> 0);
    this.group = new THREE.Group();
    this.group.name = 'TreeBirds';
    this.shared = { time: { value: 0 } };
    this.stats = { live: 0, flights: 0 };

    this._dummy = new THREE.Object3D();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._col = new THREE.Color();
    this._time = 0;
    this._scanT = 0.5;
    // Conifer mask by tree-species index: eagles perch on spires, and a spire
    // hides the perch-point error a leaning tree introduces.
    this._conifer = TREE_SPECIES.map((s) => !!s.conifer);
  }

  build() {
    this.mat = treeBirdMaterial(this.shared);
    this.meshes = [];
    this.slots = [];
    for (const S of TREE_BIRD_SPECIES) {
      // A hand-authored species has no shared geometry and nothing to instance:
      // each of its slots gets its own skinned clone once the GLB lands. Until
      // then it simply has no mesh, `_scan` declines to hand it a site, and
      // every other line in this file runs unchanged.
      const mesh = S.glb ? null : this._instanced(S);
      this.meshes.push(mesh);

      const slots = [];
      for (let i = 0; i < S.live; i++) {
        if (mesh) {
          // The geometry already carries the real plumage in its vertex colours,
          // and instanceColor MULTIPLIES that — so the per-bird variation must
          // stay near white. The first pass tinted with a mid-brown here and
          // turned the white head tan and the brown body black in-game.
          const m0 = 0.92 + this.rnd() * 0.18;
          const warm = (this.rnd() - 0.5) * 0.06;
          this._col.setRGB(m0 * (1 + warm), m0, m0 * (1 - warm));
          mesh.setColorAt(i, this._col);
        }
        slots.push({
          spec: S, mesh, i,
          active: false,
          cool: this.rnd() * 20,     // stagger the first arrivals
          state: P_PERCH,
          x: 0, y: 0, z: 0, yaw: 0, pitch: 0, bank: 0,
          sc: lerp(S.wingspan[0], S.wingspan[1], this.rnd()),
          timer: 0,
          tree: -1,
          // pose smoothing
          amp: 0, fold: 1, rate: 2.4, phase: this.rnd() * 6.28,
          spooked: 0,                // seconds a threat has been in startle range
          // flight path
          fx0: 0, fy0: 0, fz0: 0, fcx: 0, fcz: 0, fx1: 0, fy1: 0, fz1: 0,
          ft: 0, fdur: 1, fcruise: 0, fspeed: 12, bout: this.rnd() * 6.28,
          // Hand-authored slots only; null on an instanced bird for its whole
          // life. `obj` doubles as "this slot has a model", which is what
          // `_scan` and `_pose` branch on rather than re-reading `spec.glb`.
          obj: null, mixer: null, act: null,
          preen: 0, preenHold: 0, preenT: 6 + this.rnd() * 22,
        });
      }
      if (mesh?.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.slots.push(slots);

      if (mesh) {
        // Park everything out of sight until the first scan.
        this._dummy.position.set(0, -9000, 0);
        this._dummy.rotation.set(0, 0, 0);
        this._dummy.scale.setScalar(0.0001);
        this._dummy.updateMatrix();
        for (let i = 0; i < S.live; i++) mesh.setMatrixAt(i, this._dummy.matrix);
        mesh.instanceMatrix.needsUpdate = true;
      } else {
        this._loadGlb(S, slots);
      }
    }
    this.ctx.scene.add(this.group);
  }

  /** The instanced backend: one draw call and one shared material per species. */
  _instanced(S) {
    const mesh = new THREE.InstancedMesh(S.geometry(), this.mat, S.live);
    const pose = new THREE.InstancedBufferAttribute(new Float32Array(S.live * 4), 4);
    pose.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('aPose', pose);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = false;         // perched: shadow lands inside the crown
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;      // instances are scattered; sphere is stale
    mesh.userData.pose = pose;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * The hand-authored backend: one skinned clone and one mixer per slot.
   *
   * Async, and deliberately not awaited. A species with no model yet is a
   * species `_scan` will not place, which is the same state it is in during a
   * cooldown — so a slow load costs a few seconds of no flamingos and nothing
   * else. Nothing in here can fail a frame that has already been drawn.
   *
   * The clone is `SkeletonUtils.clone` and NOT `Object3D.clone` — see
   * `fitGlbBird`, which both this and the gallery build through.
   */
  async _loadGlb(S, slots) {
    const G = S.glb;
    const gltf = await new GLTFLoader().loadAsync(G.url);
    const clips = resolveBirdClips(S.key, G, gltf.animations);

    for (const b of slots) {
      const { obj, mixer, act } = fitGlbBird(gltf.scene, clips, G, b.sc);
      obj.visible = false;           // parked until the first scan places it
      this.group.add(obj);
      // Six birds standing on one island must not breathe in unison. `phase` is
      // already the per-bird offset the instanced shader uses, so it is the
      // offset here too, scaled into the idle clip's own length.
      act.idle.time = (b.phase / 6.28) * clips.idle.duration;
      b.mixer = mixer;
      b.act = act;
      b.clips = clips;
      b.obj = obj;
    }
  }

  // ── per frame ──────────────────────────────────────────────────────────────

  update(dt, cam, threat) {
    this._time += dt;
    this.shared.time.value = this._time;

    this._scanT -= dt;
    if (this._scanT <= 0) { this._scanT = 0.8; this._scan(cam); }

    let live = 0;
    for (let s = 0; s < this.slots.length; s++) {
      const mesh = this.meshes[s];
      let dirty = false;
      for (const b of this.slots[s]) {
        if (!b.active) continue;
        live++;
        this._step(b, dt, threat);
        this._pose(b, mesh, dt);
        dirty = true;
      }
      // A hand-authored species has no shared buffers to flush; each of its
      // birds advanced its own mixer inside `_pose`.
      if (dirty && mesh) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.userData.pose.needsUpdate = true;
      }
    }
    this.stats.live = live;
  }

  /**
   * Streaming. Perched birds well behind the player are recycled; empty slots
   * refill at the edge of the ring, never visibly. A bird mid-flight is left
   * alone until it lands — a vanishing eagle is worse than a distant one.
   */
  _scan(cam) {
    const T = this.ctx.systems?.trees?.trees;
    if (!T) return;
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    const cx = cam.position.x, cz = cam.position.z;

    for (const slots of this.slots) {
      for (const b of slots) {
        const S = b.spec;
        if (b.active) {
          const d = Math.hypot(b.x - cx, b.z - cz);
          if (d > DESPAWN && b.state === P_PERCH) { this._park(b); continue; }
          // Dawn on a night bird: it goes home, it does not evaporate.
          if (S.nocturnal && SKY_STATE.nightFactor < NIGHT_STAY) this._dayOut(b, d, cx, cz);
          continue;
        }
        // A hand-authored species whose GLB has not arrived yet has nothing to
        // place. Indistinguishable from a cooldown as far as the valley is
        // concerned, which is why the load does not need to be awaited.
        if (S.glb && !b.obj) continue;
        // …and the same gate on the way in. Placed ahead of the cooldown so
        // the cooldown only burns at night: otherwise both owls would spend
        // the afternoon draining theirs and then materialise together the
        // moment it got dark.
        if (S.nocturnal && SKY_STATE.nightFactor < NIGHT_SPAWN) continue;
        // The cooldown is what keeps the population breathing. A freed slot
        // that refills within seconds means exactly `live` eagles forever; a
        // slot that sometimes goes dormant for minutes means stretches of
        // valley with no eagle in them, which is what makes the next one land.
        if (b.cool > 0) { b.cool -= 0.8; continue; }
        if (this.rnd() > 0.3) continue;               // per-scan trickle
        const water = S.habitat === 'water';
        for (let attempt = 0; attempt < (water ? 6 : 4); attempt++) {
          // Flock species arrive where their kind already is: most of the
          // time a new flamingo joins the shallows that hold one, and the
          // valley gets a group on one lake instead of six scattered dots.
          let ax, az;
          const mate = S.flock ? this._flockmate(b) : null;
          const nearMate = !!mate && this.rnd() < 0.65;
          if (nearMate) {
            ax = mate.x + (this.rnd() - 0.5) * 36;
            az = mate.z + (this.rnd() - 0.5) * 36;
          } else {
            const a = this.rnd() * Math.PI * 2;
            const r = lerp(SPAWN_R[0], SPAWN_R[1], this.rnd());
            ax = cx + Math.sin(a) * r; az = cz + Math.cos(a) * r;
          }
          if (water) {
            // Island rim first, mainland waterline second — see _ensureIslands
            // for why the mainland alone was not enough. A colony species does
            // NOT fall through: its whole point is to be on its own islands and
            // nowhere else, so failing to find one is the answer, not a reason
            // to scatter it along the nearest bank.
            let site = null;
            if (nearMate) site = this._findWade(ax, az, S);
            if (!site) site = this._islandSite(cx, cz, SPAWN_R[0], SPAWN_R[1], S);
            if (!site && !S.colony) site = this._findWade(ax, az, S);
            if (!site) continue;
            _sphere.center.set(site.x, site.gy + 1, site.z);
            _sphere.radius = 3;
            const dist = Math.hypot(site.x - cx, site.z - cz);
            if (dist < VIS_OK && _frustum.intersectsSphere(_sphere)) continue;
            this._wadeAt(b, site, this.rnd() * Math.PI * 2);
            break;
          }
          const tree = this._findTree(T, ax, az, S.minTreeH, -1);
          if (tree < 0) continue;
          const py = this._perchY(T, tree);
          _sphere.center.set(T.px[tree], py, T.pz[tree]);
          _sphere.radius = 3;
          const dist = Math.hypot(T.px[tree] - cx, T.pz[tree] - cz);
          if (dist < VIS_OK && _frustum.intersectsSphere(_sphere)) continue;
          this._perchAt(b, T, tree, this.rnd() * Math.PI * 2);
          break;
        }
      }
    }
  }

  /**
   * A nocturnal bird caught out by the sunrise.
   *
   * The cheap thing to do would be to call _park and be done, and for a bird
   * three hundred metres away that is exactly right. Up close it is the one
   * failure this whole system exists to avoid: an owl the player has driven
   * out to look at, deleted between two frames while they watch. So near the
   * camera it leaves the way it arrived — a launch away from the player, which
   * is the same move a startled bird makes, and _scan pushes it off again each
   * time it lands until it is far enough out that nobody can see it go. A
   * hop is 45–120 m, so that is one or two flights, not a hunt for the horizon.
   *
   * Mid-flight birds are left alone until they land, the same rule the
   * distance despawn follows.
   */
  _dayOut(b, d, cx, cz) {
    if (d > VIS_OK) { this._park(b); return; }
    if (b.state !== P_PERCH) return;
    this._launch(b, cx, cz);
  }

  _park(b) {
    b.active = false;
    // Most departures come back soon; some leave the area for a long while.
    b.cool = this.rnd() < b.spec.chance ? 8 + this.rnd() * 25 : 90 + this.rnd() * 150;
    // A hand-authored bird parks by going invisible. There is no shared matrix
    // buffer to shrink a slot out of, and hiding the Group is also what stops
    // its mixer costing anything: `_pose` is the only caller that advances it
    // and it is only reached while the slot is active.
    if (b.obj) { b.obj.visible = false; return; }
    this._dummy.position.set(0, -9000, 0);
    this._dummy.rotation.set(0, 0, 0);
    this._dummy.scale.setScalar(0.0001);
    this._dummy.updateMatrix();
    b.mesh.setMatrixAt(b.i, this._dummy.matrix);
    b.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * The best perch tree near a point: tall wins, conifer wins harder (a spire
   * carries a silhouette; a rounded crown swallows it), with enough jitter
   * that the same grove does not elect the same tree every time.
   */
  _findTree(T, ax, az, minH, exclude) {
    const gx = clamp(((ax + T.half) / T.BS) | 0, 0, T.BW - 1);
    const gz = clamp(((az + T.half) / T.BS) | 0, 0, T.BW - 1);
    let best = -1, bestScore = 0;
    for (let j = -1; j <= 1; j++) {
      const zz = gz + j; if (zz < 0 || zz >= T.BW) continue;
      for (let i = -1; i <= 1; i++) {
        const xx = gx + i; if (xx < 0 || xx >= T.BW) continue;
        const bb = zz * T.BW + xx;
        for (let k = T.bucketStart[bb]; k < T.bucketStart[bb + 1]; k++) {
          const t = T.order[k];
          if (t === exclude) continue;
          const h = T.pImpH[t];
          if (h < minH) continue;
          const dx = T.px[t] - ax, dz = T.pz[t] - az;
          const score = h * (this._conifer[T.pspec[t]] ? 1.8 : 1.0)
            * (0.7 + 0.6 * this.rnd()) / (1 + (dx * dx + dz * dz) / 900);
          if (score > bestScore) { bestScore = score; best = t; }
        }
      }
    }
    return best;
  }

  _perchY(T, t) {
    // ON the tip, not in the crown. The first pass sat 12% down "against the
    // foliage", and the foliage won: a spruce crown is a solid cartoon mass
    // and it swallowed the bird whole — verified with a 25x debug eagle that
    // rendered perfectly while the life-size one was invisible. pImpH is the
    // baked silhouette top, so tip + a little stand-off for the feet.
    // pImpH is the baked silhouette top, and the drawn leader both sits a
    // little below it and LEANS — up to a metre off the trunk axis on a tall
    // spruce. The bird perches on the trunk axis, so it sits low enough that
    // the top whorl's boughs read as what it is standing on; at the tip
    // itself a leaning tree leaves it visibly floating in air.
    return T.py[t] + T.pImpH[t] - 1.35;
  }

  _perchAt(b, T, tree, yaw) {
    b.active = true;
    b.state = P_PERCH;
    b.tree = tree;
    b.x = T.px[tree]; b.z = T.pz[tree];
    b.y = this._perchY(T, tree);
    b.yaw = yaw;
    b.pitch = b.spec.perchPitch ?? PERCH_PITCH;
    b.bank = 0;
    b.fold = 1; b.amp = 0; b.spooked = 0;
    b.timer = lerp(b.spec.perchS[0], b.spec.perchS[1], this.rnd());
  }

  // ── island shores ─────────────────────────────────────────────────────────

  /**
   * Every shoreline point on an island in a lake, found once.
   *
   * This exists because the mainland waterline turned out to be a bad habitat
   * and a worse spawn source. The depth window a wader can stand in is narrow
   * and this terrain mostly goes from dry to over-depth inside a couple of
   * metres, so the standable fringe is a thin broken thread — measured on the
   * spawn lake, a 28 m square of standing water held exactly two cells a
   * flamingo would take. Birds did spawn, just rarely and nowhere anyone
   * drives. An island rim is the opposite: shallow the whole way round, open
   * water on every side, and it reads from clear across the lake. Which is
   * also simply where these birds are in life.
   *
   * Finding them is a flood fill on the hydro sdf, whose sign already asks the
   * right question (>= 0 is water). Land cells group into connected
   * components, and a component that never touches the map border is by
   * construction ringed by water — there is no separate "is it surrounded"
   * test to get wrong. Area and the openness of the water around it then
   * separate a lake island from a bog hummock or a bar in a creek.
   *
   * One pass over a 768² field, on the first scan that finds a bake in place
   * rather than in build(), where the hydro field may not exist yet.
   *
   * @returns {{list: Array, colony: Map}|null} null while the bake is missing
   */
  _ensureIslands() {
    if (this._islands) return this._islands;
    const W = this.ctx.world;
    const h = W?.hydro;
    if (!h?.sdf || !W.getHydro) return null;      // not baked yet — try next scan

    const R = h.res, T = h.texel, half = W.half;
    const N = R * R, sdf = h.sdf;
    const lab = new Int32Array(N).fill(-1);
    const stack = new Int32Array(N);
    const kept = [];
    let id = 0;

    for (let s = 0; s < N; s++) {
      if (sdf[s] >= 0 || lab[s] !== -1) continue;
      let sp = 0, n = 0, border = false, sumx = 0, sumz = 0;
      let minc = R, maxc = -1, minr = R, maxr = -1;
      stack[sp++] = s; lab[s] = id;
      while (sp > 0) {
        const c = stack[--sp]; n++;
        const cx = c % R, cz = (c / R) | 0;
        if (cx === 0 || cz === 0 || cx === R - 1 || cz === R - 1) border = true;
        if (cx < minc) minc = cx;
        if (cx > maxc) maxc = cx;
        if (cz < minr) minr = cz;
        if (cz > maxr) maxr = cz;
        sumx += cx; sumz += cz;
        // Stepped one neighbour at a time with the edge guarded per side: a
        // flat c-1 / c+1 would wrap around the row ends and weld the east
        // shore to the west one into a single component that touches nothing.
        if (cx > 0) { const q = c - 1; if (sdf[q] < 0 && lab[q] === -1) { lab[q] = id; stack[sp++] = q; } }
        if (cx < R - 1) { const q = c + 1; if (sdf[q] < 0 && lab[q] === -1) { lab[q] = id; stack[sp++] = q; } }
        if (cz > 0) { const q = c - R; if (sdf[q] < 0 && lab[q] === -1) { lab[q] = id; stack[sp++] = q; } }
        if (cz < R - 1) { const q = c + R; if (sdf[q] < 0 && lab[q] === -1) { lab[q] = id; stack[sp++] = q; } }
      }
      const area = n * T * T;
      if (!border && area >= ISLAND_AREA[0] && area <= ISLAND_AREA[1]) {
        kept.push({
          id,
          x: (sumx / n + 0.25) * T - half,
          z: (sumz / n + 0.25) * T - half,
          rad: Math.max(maxc - minc + 1, maxr - minr + 1) * T * 0.5,
          open: 0, sites: [],
        });
      }
      id++;
    }

    // Is it in open water, and is it really an island? A component can clear
    // the border test and still be a hummock in a bog, so sample a ring just
    // outside it: most of that ring has to be water, and the water has to be
    // wide enough to read as a lake.
    const hy = {};
    const byId = new Map();
    for (const isl of kept) {
      let wet = 0, tries = 0, open = 0;
      for (let a = 0; a < 24; a++) {
        const th = (a / 24) * Math.PI * 2;
        const rr = isl.rad + 12;
        const x = isl.x + Math.sin(th) * rr, z = isl.z + Math.cos(th) * rr;
        if (!W.isInBounds(x, z)) continue;
        tries++;
        const q = W.getHydro(x, z, hy);
        if (q.sdf > 0) wet++;
        if (q.span > open) open = q.span;
      }
      if (!tries || wet / tries < ISLAND_RING_WET || open < ISLAND_OPEN) continue;
      isl.open = open;
      byId.set(isl.id, isl);
    }

    // The shoreline: every water cell touching one of these islands. Taken
    // from the same field the components came from, so a site is on the rim
    // by construction rather than by a second search that could disagree.
    for (let c = 0; c < N; c++) {
      if (sdf[c] >= 0) continue;
      const isl = byId.get(lab[c]);
      if (!isl) continue;
      const cx = c % R, cz = (c / R) | 0;
      const nb = [
        cx > 0 ? c - 1 : -1, cx < R - 1 ? c + 1 : -1,
        cz > 0 ? c - R : -1, cz < R - 1 ? c + R : -1,
      ];
      for (const q of nb) {
        if (q < 0 || sdf[q] < 0) continue;
        isl.sites.push({ x: ((q % R) + 0.25) * T - half, z: (((q / R) | 0) + 0.25) * T - half });
      }
    }

    const list = [...byId.values()].filter((i) => i.sites.length >= 4);

    // Colony species get a FEW islands in the whole valley, not all of them.
    // A flamingo everywhere is scenery; a flamingo on two known islands is
    // somewhere to go — the same reasoning that makes a perched eagle a
    // landmark rather than a bird. Openness breaks the tie because a big
    // bright lake is where you would actually notice them.
    const colony = new Map();
    for (const S of TREE_BIRD_SPECIES) {
      if (!S.colony) continue;
      const ranked = list
        .map((isl, i) => ({ i, score: isl.open * (0.6 + 0.8 * this.rnd()) }))
        .filter(({ i }) => !S.minSpan || list[i].open >= S.minSpan)
        .sort((a, b) => b.score - a.score)
        .slice(0, S.colony)
        .map(({ i }) => i);
      colony.set(S.key, new Set(ranked));
    }

    this._islands = { list, colony };
    return this._islands;
  }

  /**
   * A shore site on an island whose distance from (cx, cz) lands in
   * [rmin, rmax]. Colony species are held to their own islands; everyone else
   * may use any of them.
   *
   * Depth is only capped, not floored: on a rim the difference between ankle
   * deep and standing on wet sand is a metre of shore, and a bird at the
   * water's edge is right either way. Flooring it here is what made the
   * mainland so barren.
   */
  _islandSite(cx, cz, rmin, rmax, S) {
    const I = this._ensureIslands();
    if (!I) return null;
    const allowed = I.colony.get(S.key);
    const W = this.ctx.world;

    let pick = null, seen = 0;
    for (let k = 0; k < I.list.length; k++) {
      if (allowed && !allowed.has(k)) continue;
      const isl = I.list[k];
      if (S.minSpan && isl.open < S.minSpan) continue;
      const d = Math.hypot(isl.x - cx, isl.z - cz);
      if (d + isl.rad < rmin || d - isl.rad > rmax) continue;
      seen++;
      if (this.rnd() < 1 / seen) pick = isl;      // reservoir: no bias to the first
    }
    if (!pick) return null;

    // A flock lands together. Without this the rim is long enough that six
    // flamingos spread themselves evenly round a 146 m island and read as six
    // separate birds rather than a flock — the same reason _scan biases new
    // arrivals toward a mate on the mainland.
    let near = null;
    if (S.flock) {
      const mate = this._settledOn(pick, S);
      if (mate && this.rnd() < 0.75) {
        near = pick.sites.filter((s) => Math.hypot(s.x - mate.x, s.z - mate.z) < 34);
        if (!near.length) near = null;
      }
    }
    const pool = near ?? pick.sites;

    for (let t = 0; t < 10; t++) {
      const s = pool[(this.rnd() * pool.length) | 0];
      // Jittered off the 4 m lattice the field is stored on, or a flock lines
      // up on a grid like fenceposts.
      const x = s.x + (this.rnd() - 0.5) * 3.2;
      const z = s.z + (this.rnd() - 0.5) * 3.2;
      if (!W.isInBounds(x, z)) continue;
      const d = Math.hypot(x - cx, z - cz);
      if (d < rmin || d > rmax) continue;
      if (W.getWaterDepth(x, z) > S.wade[1]) continue;
      return { x, z, gy: W.getHeight(x, z), wy: W.getWaterHeight(x, z), island: pick };
    }
    return null;
  }

  // ── wading sites (habitat: 'water') ───────────────────────────────────────

  /**
   * A wading site near (ax, az): standing water inside the species' depth
   * window, open enough if the species cares. Sampled, not searched — water is
   * a quarter of this map, so a handful of throws either lands in some or the
   * neighbourhood genuinely has none and the spawn attempt should fail.
   */
  _findWade(ax, az, S) {
    const W = this.ctx.world;
    if (!W?.getWaterContactDepth) return null;
    for (let k = 0; k < 10; k++) {
      const x = ax + (this.rnd() - 0.5) * 36;
      const z = az + (this.rnd() - 0.5) * 36;
      if (!W.isInBounds(x, z)) continue;
      // Two queries, each for what it is honest about. The hydro sdf gates
      // OUT the phantoms — the raw grid keeps water in speck cells the drawn
      // mesh deliberately drops, and a bird wading in one stands in dry
      // meadow (shipped once, shots/waders/heron-wade.png). The DEPTH is
      // getWaterDepth, which reads the drawn surface's own field: hydro depth
      // is reconstructed as 0.60 x sdf near the waterline, and testing
      // against that put a heron chest-deep in honest-to-goodness water.
      const h = W.getHydro(x, z, this._hy ??= {});
      if (h.sdf < 1.2 || h.wet < 0.5) continue;
      const d = W.getWaterDepth(x, z);
      if (d < S.wade[0] || d > S.wade[1]) continue;
      if (S.minSpan && h.span < S.minSpan) continue;
      return { x, z, gy: W.getHeight(x, z), wy: W.getWaterHeight(x, z) };
    }
    return null;
  }

  /**
   * The standing height: feet on the bed, body up the leg length — but never
   * so deep the belly ships water. The depth window should make the clamp a
   * no-op; it exists because two derivations of "how deep is it here" have
   * already disagreed once each.
   */
  _wadeY(site, S, sc) {
    let y = site.gy - S.footY * sc;
    // Keep the BODY clear of the water — not the object's origin, because on a
    // lofted bird those are the same point and on a hand-authored one they are
    // not.
    //
    // `y` is where the origin goes. A lofted wader's origin sits in its body, so
    // "origin 0.07 spans above the surface" was the body rule written directly
    // and nobody had to say so. The GLB's origin is between the SOLES, and that
    // same line read literally floated every flamingo 0.07 * sc above the water
    // standing on nothing — 0.30 m of daylight under a bird in a lake, and the
    // clamp won every time because it beat the bed by the whole wade depth.
    //
    // So the rule is stated once, about the belly, and each backend says where
    // its belly is above its own origin. Zero for a lofted bird, which is the
    // original line exactly; 0.244 spans for the flamingo, measured off the
    // asset. It also cross-checks `wade`: the deepest water this permits is
    // 0.174 * sc = 0.74 m against the 0.75 the species asks for, so the two
    // numbers were derived independently and agree to a centimetre.
    const belly = S.glb ? S.glb.bellyY : 0;
    if (site.wy != null) y = Math.max(y, site.wy + (0.07 - belly) * sc);
    return y;
  }

  /** Stand a wader in the shallows: feet on the bed, body up the leg length. */
  _wadeAt(b, site, yaw) {
    b.active = true;
    b.state = P_PERCH;
    b.tree = -1;
    b.x = site.x; b.z = site.z;
    b.y = this._wadeY(site, b.spec, b.sc);
    b.yaw = yaw;
    b.pitch = b.spec.perchPitch ?? PERCH_PITCH;
    b.bank = 0;
    b.fold = 1; b.amp = 0; b.spooked = 0;
    b.timer = lerp(b.spec.perchS[0], b.spec.perchS[1], this.rnd());
  }

  /** A settled bird of species S standing on island `isl`, or null. */
  _settledOn(isl, S) {
    for (const slots of this.slots) {
      if (slots[0]?.spec !== S) continue;
      for (const o of slots) {
        if (!o.active || o.state !== P_PERCH) continue;
        if (Math.hypot(o.x - isl.x, o.z - isl.z) <= isl.rad + 20) return o;
      }
    }
    return null;
  }

  /**
   * The nearest SETTLED bird of `key` within `maxD` of (x, z), or null.
   *
   * This exists for wildlife_audio.js. That file finds its mammals by walking
   * Wildlife.debugState(), which knows nothing about the birds in here, and a
   * hoot has to come from an owl that is actually sitting in a tree nearby —
   * a call with no bird under it is the cuckoo clock its header forbids. This
   * is the cheapest honest answer to that question, and the audio side asks it
   * on a minute-plus cooldown, never per frame.
   */
  nearestPerched(key, x, z, maxD) {
    let best = null, bd = maxD;
    for (const slots of this.slots) {
      if (slots[0]?.spec?.key !== key) continue;
      for (const b of slots) {
        if (!b.active || b.state !== P_PERCH) continue;
        const d = Math.hypot(b.x - x, b.z - z);
        if (d < bd) { bd = d; best = b; }
      }
    }
    return best ? { x: best.x, y: best.y, z: best.z, dist: bd } : null;
  }

  /** A random other settled bird of the same species, or null. */
  _flockmate(b) {
    let pick = null, n = 0;
    for (const slots of this.slots) {
      if (slots[0]?.spec !== b.spec) continue;
      for (const o of slots) {
        if (o === b || !o.active || o.state !== P_PERCH) continue;
        n++;
        if (this.rnd() < 1 / n) pick = o;
      }
    }
    return pick;
  }

  /**
   * Set up the flight state for a hop to (tx, ty, tz). The path is a bowed
   * line, not a bee-line: the control point swings it to one side so the bird
   * banks through a real turn.
   */
  _flightTo(b, tx, ty, tz, d) {
    const S = b.spec;
    b.fx0 = b.x; b.fy0 = b.y; b.fz0 = b.z;
    b.fx1 = tx; b.fy1 = ty; b.fz1 = tz;
    const side = this.rnd() < 0.5 ? -1 : 1;
    const nx = -(tz - b.z) / d, nz = (tx - b.x) / d;
    b.fcx = (b.x + tx) * 0.5 + nx * side * d * (0.12 + this.rnd() * 0.16);
    b.fcz = (b.z + tz) * 0.5 + nz * side * d * (0.12 + this.rnd() * 0.16);
    const up = S.cruiseUp ?? [4, 11];
    b.fcruise = Math.max(b.fy0, b.fy1) + lerp(up[0], up[1], this.rnd());
    b.fspeed = lerp(S.cruise[0], S.cruise[1], this.rnd());
    b.fdur = Math.max(2.5, d * 1.08 / b.fspeed);
    b.ft = 0;
    b.state = P_FLY;
    b.rate = lerp(S.flapHz[0], S.flapHz[1], this.rnd());
    b.bout = this.rnd() * 6.28;
    this.stats.flights++;
  }

  /** Launch a flight from the current perch to a site in an annulus around it. */
  _launch(b, awayX = 0, awayZ = 0) {
    const S = b.spec;
    if (S.habitat === 'water') return this._launchWade(b, awayX, awayZ);
    const T = this.ctx.systems?.trees?.trees;
    if (!T) { b.timer = 8; return false; }
    for (let attempt = 0; attempt < 5; attempt++) {
      let a = this.rnd() * Math.PI * 2;
      // Flushed birds leave away from the threat; wandering birds don't care.
      if (awayX || awayZ) a = Math.atan2(b.x - awayX, b.z - awayZ) + (this.rnd() - 0.5) * 1.6;
      const r = lerp(S.hop[0], S.hop[1], this.rnd());
      const tree = this._findTree(T, b.x + Math.sin(a) * r, b.z + Math.cos(a) * r, S.minTreeH, b.tree);
      if (tree < 0) continue;
      const tx = T.px[tree], tz = T.pz[tree], ty = this._perchY(T, tree);
      const d = Math.hypot(tx - b.x, tz - b.z);
      if (d < 14) continue;                        // hopping one crown over reads as a glitch
      this._flightTo(b, tx, ty, tz, d);
      b.tree = tree;
      return true;
    }
    b.timer = 8;
    return false;
  }

  /** The wader version: the next stand of shallows, biased toward the flock. */
  _launchWade(b, awayX = 0, awayZ = 0) {
    const S = b.spec;
    for (let attempt = 0; attempt < 6; attempt++) {
      let ax, az;
      const mate = (!awayX && !awayZ && S.flock) ? this._flockmate(b) : null;
      if (mate && this.rnd() < 0.5) {
        ax = mate.x + (this.rnd() - 0.5) * 30;
        az = mate.z + (this.rnd() - 0.5) * 30;
      } else {
        let a = this.rnd() * Math.PI * 2;
        if (awayX || awayZ) a = Math.atan2(b.x - awayX, b.z - awayZ) + (this.rnd() - 0.5) * 1.6;
        const r = lerp(S.hop[0], S.hop[1], this.rnd());
        ax = b.x + Math.sin(a) * r; az = b.z + Math.cos(a) * r;
      }
      // Hops stay on the island rims too, so a colony bird works its way round
      // its own island instead of leaving for a bank it can never spawn on.
      // 14 m, not S.hop[0]: a hop between rim points is bounded by the island,
      // and on a small one every point is inside the species' normal hop
      // minimum — hold it to that and a colony bird can never move at all.
      let site = (!awayX && !awayZ) || S.colony
        ? this._islandSite(b.x, b.z, 14, S.hop[1], S) : null;
      if (!site && !S.colony) site = this._findWade(ax, az, S);
      if (!site) continue;
      const ty = this._wadeY(site, S, b.sc);
      const d = Math.hypot(site.x - b.x, site.z - b.z);
      if (d < 12) continue;                        // shuffling one pool over reads as a glitch
      this._flightTo(b, site.x, ty, site.z, d);
      b.tree = -1;
      return true;
    }
    b.timer = 8;
    return false;
  }

  _step(b, dt, threat) {
    const S = b.spec;
    if (b.state === P_PERCH) {
      b.timer -= dt;
      b.fold = damp(b.fold, 1, 5, dt);
      b.amp = damp(b.amp, 0, 6, dt);
      b.pitch = damp(b.pitch, S.perchPitch ?? PERCH_PITCH, 4, dt);
      b.bank = damp(b.bank, 0, 4, dt);
      // Holding its nerve. `startleDelay` is how long a threat has to stay
      // inside `startle` before the bird gives up on it — without it a bird
      // flushes on the frame you arrive, which means the only flamingo anyone
      // ever sees is one already leaving. The count decays at twice the rate
      // it builds, so driving past does not bank credit toward a later flush,
      // but a bird you have already crowded stays jumpy for a moment.
      const pressed = threat && Math.abs(threat.speed) > 4
        && Math.hypot(threat.x - b.x, threat.z - b.z) < S.startle;
      if (pressed) b.spooked += dt;
      else b.spooked = Math.max(0, b.spooked - dt * 2);
      if (pressed && b.spooked >= (S.startleDelay ?? 0)) {
        this._launch(b, threat.x, threat.z);
      } else if (b.timer <= 0) {
        this._launch(b);
      }
      return;
    }

    // ── flight ────────────────────────────────────────────────────────────
    const W = this.ctx.world;
    b.ft += dt / b.fdur;
    const t = clamp01(b.ft);

    // Horizontal: quadratic bezier through the bowed control point.
    const u = 1 - t;
    const x = u * u * b.fx0 + 2 * u * t * b.fcx + t * t * b.fx1;
    const z = u * u * b.fz0 + 2 * u * t * b.fcz + t * t * b.fz1;
    // Vertical: climb off the perch to cruise, hold, descend onto the new
    // one — with a takeoff dip, because an eagle leaves a treetop by falling
    // onto its wings, and that drop is the most recognisable part of the move.
    let y = lerp(b.fy0, b.fcruise, smoothstep(0.04, 0.42, t));
    y = lerp(y, b.fy1, smoothstep(0.60, 0.97, t));
    y -= (S.dip ?? 1.7) * Math.sin(clamp01(t / 0.16) * Math.PI) * clamp01(1 - t * 2);
    // Terrain clearance, windowed to mid-flight: at the endpoints the bird is
    // ON its perch, and a wader's perch is half a metre over the water — the
    // old flat +8 clamp would snatch it into the air the frame it launched.
    if (W.isInBounds(x, z)) {
      const mid = smoothstep(0.05, 0.30, t) * (1 - smoothstep(0.70, 0.95, t));
      y = Math.max(y, W.getHeight(x, z) + lerp(0.35, 8, mid));
    }

    // Heading from the bezier tangent; pitch from the actual climb.
    const dxdt = 2 * u * (b.fcx - b.fx0) + 2 * t * (b.fx1 - b.fcx);
    const dzdt = 2 * u * (b.fcz - b.fz0) + 2 * t * (b.fz1 - b.fcz);
    const wantYaw = Math.atan2(dxdt, dzdt);
    const prevYaw = b.yaw;
    b.yaw = dampAngle(b.yaw, wantYaw, 6, dt);
    const yawRate = (b.yaw - prevYaw) / Math.max(dt, 1e-3);
    b.bank = damp(b.bank, clamp(yawRate * 0.55, -0.8, 0.8), 5, dt);
    const vy = (y - b.y) / Math.max(dt, 1e-3);
    const flare = smoothstep(0.85, 1.0, t);
    const wantPitch = clamp(-Math.atan2(vy, b.fspeed) * 0.8, -0.55, 0.55) - flare * 0.45;
    b.pitch = damp(b.pitch, wantPitch, 6, dt);

    // Wings: open immediately, flap through the climb, then bouts of glide —
    // the flap-flap-glide rhythm is the other half of reading "eagle".
    b.fold = damp(b.fold, 0, 8, dt);
    let wantAmp;
    if (t < 0.32) wantAmp = lerp(S.flapAmp[0], S.flapAmp[1], 0.8);
    else if (flare > 0) wantAmp = lerp(b.amp, 0.9, flare);
    else {
      const gate = Math.sin(this._time * 0.85 + b.bout);
      wantAmp = gate > 0.15 ? S.flapAmp[0] : 0.05;
    }
    b.amp = damp(b.amp, wantAmp, 4, dt);

    b.x = x; b.y = y; b.z = z;

    if (b.ft >= 1) {
      // Touch down exactly on the perch; the flare got the pose close enough
      // that the snap is invisible.
      b.x = b.fx1; b.y = b.fy1; b.z = b.fz1;
      b.state = P_PERCH;
      b.timer = lerp(S.perchS[0], S.perchS[1], this.rnd());
    }
  }

  _pose(b, mesh, dt) {
    if (b.obj) { this._poseGlb(b, dt); return; }
    const D = this._dummy, E = this._e;
    D.position.set(b.x, b.y, b.z);
    E.set(b.pitch, b.yaw, b.bank);
    D.quaternion.setFromEuler(E);
    D.scale.setScalar(b.sc);
    D.updateMatrix();
    mesh.setMatrixAt(b.i, D.matrix);
    const p = mesh.userData.pose.array;
    p[b.i * 4] = b.phase;
    p[b.i * 4 + 1] = b.rate;
    p[b.i * 4 + 2] = b.amp;
    p[b.i * 4 + 3] = b.fold;
  }

  /**
   * The same pose, played by a mixer instead of written into a shader.
   *
   * `_step` is untouched and does not know which backend it is driving: it
   * produces the same `(x, y, z, yaw, pitch, bank, fold, rate, amp)` it always
   * did, and this reads three of those as clip weights and a playback rate. So
   * the flamingo flushes, banks and flares on exactly the timeline it did as a
   * lofted bird — only the surface changed.
   *
   * **`amp` has no counterpart here, and that is a property of the asset.** On
   * the instanced birds it is wing amplitude, and `_step` drops it to 0.05
   * between bouts to sell the flap-flap-glide rhythm. The pack's fly clip is
   * one continuous beat with no glide pose in it, and a glide is a shape the
   * wing holds rather than a smaller version of a flap — so it cannot be
   * reached by scaling anything, and faking it by stalling the clip would just
   * freeze the wings wherever the beat happened to be. Left unread on purpose:
   * a flamingo beats continuously in level flight, which is why this species
   * carries the fastest, shallowest `flapAmp` on the table. It is the eagle
   * this would cost something, and the eagle is still instanced.
   */
  _poseGlb(b, dt) {
    const G = b.spec.glb, o = b.obj, a = b.act;
    o.visible = true;
    o.position.set(b.x, b.y, b.z);
    o.rotation.set(b.pitch, b.yaw, b.bank);

    // An occasional preen, only while genuinely settled. This file argues that
    // a flamingo colony is the payoff at the end of a boat trip and holds the
    // birds five seconds after you crowd them so the payoff survives arrival;
    // six birds frozen in one identical idle is a poor thing to have travelled
    // to, and `preen` is a clip the pack already ships.
    if (b.fold > 0.9) {
      b.preenT -= dt;
      if (b.preenT <= 0) {
        b.preenT = 16 + this.rnd() * 30;
        b.preenHold = b.clips.preen.duration;
        a.preen.time = 0;
      }
    }
    b.preenHold = Math.max(0, b.preenHold - dt);
    // Released a little before the clip runs out, so the crossfade lands on the
    // pose the preen returns to instead of cutting from wherever it stopped.
    b.preen = damp(b.preen, b.preenHold > 0.4 ? 1 : 0, 3, dt);

    // `fold` is 1 perched and 0 airborne, damped by `_step` on its own clock —
    // the same signal the shader rolls the wing in with, used here as the
    // crossfade weight, so both backends change state at the same instant.
    //
    // The three weights sum to 1 by construction. They have to: an unnormalised
    // set makes the mixer average toward the rest pose, and the bird visibly
    // sinks and straightens as it takes off. See the budget note in glb_rig.js.
    const still = b.fold;
    a.fly.setEffectiveWeight(1 - still);
    a.preen.setEffectiveWeight(still * b.preen);
    a.idle.setEffectiveWeight(still * (1 - b.preen));

    // Beat frequency, derived the way this repo derives everything else about a
    // clip: the species table asks for a wingbeat in Hz, the asset was authored
    // at `flapHz`, and the ratio is the playback rate. Cadence here where the
    // mammals use ground speed, and the clip itself is never touched.
    a.fly.timeScale = b.rate / G.flapHz;

    b.mixer.update(dt);
  }

  /** Is `key` one of the species in here? See `Wildlife.canTrack`. */
  hasSpecies(key) { return TREE_BIRD_SPECIES.some((s) => s.key === key); }

  /**
   * The nearest live bird of `key` within `maxD`, or null.
   *
   * The mammals' half of this question is `Wildlife.nearestHint`, and this is
   * deliberately the plainer function: a perched bird has no logbook flag, no
   * herd and no notion of having been noticed, so there is nothing to filter
   * on but species and distance. `Wildlife` is the only caller and it owns the
   * policy — which bird the player asked for, and how far is fair.
   *
   * Flat distance, matching every other range in the wildlife layer: an eagle
   * thirty metres up a spruce is not thirty metres away in the sense the player
   * means. That matters more here than it does for a deer, because these are
   * the only animals in the game whose `y` is routinely a storey above the
   * ground the player is standing on.
   *
   * Walks this species' slots only — four for an eagle, six for a flamingo —
   * so it is a handful of comparisons however often it is asked.
   */
  nearestOf(key, x, z, maxD) {
    const si = TREE_BIRD_SPECIES.findIndex((s) => s.key === key);
    if (si < 0) return null;
    let best = null, bestD2 = maxD * maxD;
    for (const b of this.slots[si]) {
      if (!b.active) continue;
      const dx = b.x - x, dz = b.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= bestD2) continue;
      bestD2 = d2; best = b;
    }
    return best ? { x: best.x, z: best.z, dist: Math.sqrt(bestD2) } : null;
  }

  // ── debug hooks (capture harnesses) ───────────────────────────────────────

  /** Positions and states of every live bird. */
  debugList() {
    const out = [];
    for (const slots of this.slots) {
      for (const b of slots) {
        if (b.active) out.push({ key: b.spec.key, x: b.x, y: b.y, z: b.z, state: b.state, t: b.ft });
      }
    }
    return out;
  }

  /** Force the perched bird nearest (x, z) into the air. */
  debugFly(x, z) {
    let best = null, bd = 1e9;
    for (const slots of this.slots) {
      for (const b of slots) {
        if (!b.active || b.state !== P_PERCH) continue;
        const d = Math.hypot(b.x - x, b.z - z);
        if (d < bd) { bd = d; best = b; }
      }
    }
    if (best) this._launch(best);
    return best ? { x: best.x, y: best.y, z: best.z } : null;
  }

  /**
   * Perch a bird of `key` (default: the first species) on the best site near
   * (x, z) right now, view guard skipped. Trees for the tree birds, shallows
   * for the waders.
   */
  debugPerchNear(x, z, key) {
    const si = key ? TREE_BIRD_SPECIES.findIndex((s) => s.key === key) : 0;
    if (si < 0) return null;
    const slots = this.slots[si];
    const b = slots.find((s) => !s.active) ?? slots[0];
    const S = b.spec;
    if (S.habitat === 'water') {
      const site = this._findWade(x, z, S);
      if (!site) return null;
      this._wadeAt(b, site, this.rnd() * Math.PI * 2);
      return { x: b.x, y: b.y, z: b.z };
    }
    const T = this.ctx.systems?.trees?.trees;
    if (!T) return null;
    const tree = this._findTree(T, x, z, S.minTreeH, -1);
    if (tree < 0) return null;
    this._perchAt(b, T, tree, this.rnd() * Math.PI * 2);
    return { x: b.x, y: b.y, z: b.z };
  }

  dispose() {
    this.group.removeFromParent();
    // Null for a hand-authored species, which owns no shared geometry — its
    // meshes came off the GLB and are released with their mixers below.
    for (const m of this.meshes) m?.geometry.dispose();
    for (const slots of this.slots) {
      for (const b of slots) {
        if (!b.mixer) continue;
        b.mixer.stopAllAction();
        b.mixer.uncacheRoot(b.mixer.getRoot());
        b.obj?.removeFromParent();
      }
    }
    this.mat.dispose();
  }
}
