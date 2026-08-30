// ─────────────────────────────────────────────────────────────────────────────
//  glb_rig — the hand-authored track, as a first-class species backend.
//
//  `animal_anim.js` is the procedural backend: a page of profile numbers is
//  lofted into a skeleton and the gait is *solved* against the ground every
//  frame. This file is the other backend — a mesh and its clips authored by
//  hand in Blender, exported to one GLB, and played back by three's
//  `AnimationMixer`.
//
//  The point of this file is that those are the ONLY two things that differ.
//  A GLB species is placed by the same habitat field, streamed by the same
//  site table, pooled by the same budget, credited by the same logbook and
//  photographed by the same detector as a procedural one, because `GlbRig`
//  answers the exact contract `AnimRig` answers:
//
//      new Rig(proto, scale, gaitCfg, key)
//      rig.mesh                    the object Wildlife positions and hides
//      rig.reset(pos, heading, W)  place it, feet on the ground
//      rig.update(dt, drive, W)    one frame, from Brain.fill's drive block
//      rig.setLod(0|1)             geometry LOD
//      rig.setShadow(bool)         shadow LOD
//      rig.gaitName                what it is doing, for the debug dumps
//      rig._warm                   false until reset has run once
//
//  `Wildlife` picks the backend off `SPECIES[key].glb` and never branches
//  again. Adding a second hand-authored animal is a model, a species file and
//  nothing else — see the `promote-glb-animal` skill.
//
//  ── the rule that outranks everything here ─────────────────────────────────
//
//  **A GLB's animations are read-only.** It is written up in CLAUDE.md. This
//  file changes *playback* — rate, blend weight, where the animal is — and
//  never a pose. An earlier cut widened the fox's walk by scaling its leg
//  keyframes and it was wrong twice over: it silently changed what the artist
//  authored, and glTF stores ABSOLUTE bone rotations (rest x pose), so scaling
//  a bone resting at 125.9 deg carrying a ±13 deg swing scales the rest pose
//  too — past 180 deg the slerp wraps and the limb goes somewhere nobody
//  designed.
//
//  So where the game must agree with a short clip, the GAME is derived from
//  the CLIP: `measureStride` reads the ground one authored cycle covers
//  straight off the asset, and the species' gait speeds are those numbers
//  times their playback rates. The paws keep pace with the ground at any rate
//  and the clip is never touched. Where a gait is slower than the real animal,
//  that is a note for the artist, not a thing for this file to paper over.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneRigged } from 'three/addons/utils/SkeletonUtils.js';
import { clamp, clamp01, damp, mulberry32 } from '../core/MathUtils.js';

// Bounds on a clip's playback rate once the Brain is steering. The animal is
// only ever asked to move at a speed one of its clips carries — that is what
// deriving the gait table from the asset buys — so these are a guard against a
// state that wants something else, not a routine clamp. A rate that sits on a
// bound is a finding: the asset has no clip for the speed the game wants.
const RATE = [0.6, 3.2];

// Where stand hands over to the walk, **as a fraction of the animal's own
// cruising walk speed** rather than in m/s. Absolute numbers were a bug here
// once: they were written when the fox walked at 0.44 m/s, and once the clip's
// real 0.08 m/s took over, cruising speed landed inside the band — so the fox
// walked permanently at 62% Walk / 38% Stand and never once played the clip
// clean. Anchored to the animal's own speed, the band cannot drift like that
// when a stride is rebuilt in Blender.
const MOVING = [0.25, 0.85];

// The same idea one tier up, and again one more: where walk hands to trot, and
// trot to run, as a fraction of the gap between the two clips' own cruising
// speeds. 0 is the lower clip's cruise and 1 is the upper's, so the animal is
// fully in the upper gait a little before it reaches that clip's authored
// speed and never plays a clip far off its tempo.
const TROTTING = [0.2, 0.9];
const RUNNING = [0.15, 0.85];

// Seconds for a crossfade, floor to ceiling. The blend is damped on its own
// clock rather than read straight off `Brain.speed`, because that speed is
// close to a step function for a small animal: the Brain's accel/decel rates
// are absolute and tuned for animals moving metres per second, so at a slow
// clip's speed every change of pace completes within one frame. Measured on
// the fox — walk weight went 0.62 -> 0 in 16 ms, which is the snap. Damping
// gives the transition a duration of its own, whatever the speed signal does.
const BLEND_TIME = 0.22;

const _fwd = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * How far a paw travels through one cycle of `clip`, in model units.
 *
 * The clip is in place, so the paw's own displacement IS the stride the body
 * would cover if the foot were planted. Sampling beats reading the keyframes:
 * it accounts for the whole chain (upper, lower and foot bones compound) and
 * it keeps working if the rig is rebuilt with different joints.
 *
 * Blender's exporter strips the dots out of bone names, so `hind_foot.L`
 * arrives here as `hind_footL`. The species file names them; a name that does
 * not resolve is skipped rather than thrown on, and a clip where NONE resolve
 * comes back 0 — which the loader reports as the asset problem it is.
 */
function measureStride(root, clip, boneNames) {
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.play();
  let best = 0;
  const p = new THREE.Vector3();
  for (const name of boneNames) {
    const bone = root.getObjectByName(name);
    if (!bone) continue;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 64; i++) {
      mixer.setTime((i / 64) * clip.duration);
      root.updateMatrixWorld(true);
      p.setFromMatrixPosition(bone.matrixWorld);
      if (p.z < lo) lo = p.z;
      if (p.z > hi) hi = p.z;
    }
    best = Math.max(best, hi - lo);
  }
  action.stop();
  mixer.uncacheRoot(root);
  return best;
}

/**
 * Load one hand-authored species and measure it. Called once, from
 * `Wildlife.init`, and returns one prototype per coat variant.
 *
 * **This mutates `sp.gait`**, and that is the point rather than a shortcut.
 * The gait table is what the Brain steers by, and for this track the honest
 * walk/trot/run speeds are not numbers anybody can write down in a species
 * file — they are a property of the clips, knowable only once the asset has
 * been read. Writing them back onto the species record keeps one source of
 * truth for every consumer (`Brain`, `AnimRig._pickGait`, the census tools)
 * instead of a shadow copy that the next reader forgets to look for.
 */
export async function loadGlbSpecies(key, sp, log = true) {
  const G = sp.glb;
  const gltf = await new GLTFLoader().loadAsync(G.url);
  const scene = gltf.scene;

  // Resolve the clips by the names the species file gives. A missing clip is
  // fatal for the species rather than silently absent: an animal that cannot
  // graze is a regression the player sees, and failing loudly at load is the
  // only place it is cheap to notice.
  const clips = {};
  for (const [slot, cfg] of Object.entries(G.clips)) {
    const clip = gltf.animations.find((a) => a.name === cfg.name);
    if (!clip) {
      throw new Error(`[glb_rig] ${key}: no clip named "${cfg.name}" for slot `
        + `"${slot}"; the GLB carries ${gltf.animations.map((a) => a.name).join(', ')}`);
    }
    clips[slot] = clip;
  }

  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const modelH = box.max.y - box.min.y;
  const s = G.height / modelH;

  // The rest pose, captured before anything animates the scene and put back
  // after measuring: `measureStride` leaves the skeleton wherever its last
  // sample landed, and a clone taken from a half-walked animal starts life
  // with one leg in the air until its mixer's first update. Read-only — the
  // clip itself is never written to.
  const rest = new Map();
  scene.traverse((o) => { if (o.isBone) rest.set(o.name, o.quaternion.clone()); });

  // Ground covered per second of clip, straight off the asset. Every moving
  // clip gets its own number because each has to keep its own paws on the
  // ground: they carry different strides over different durations, so one
  // shared number would slide whichever clip it was not derived from.
  //
  // `strides` is how many strides the clip contains. The fox's run is three
  // rotary-gallop strides in one two-second clip, and its sampled paw reach is
  // one of them — so ground speed over the full duration has to count all
  // three or the animal travels at a third of what the legs are doing.
  const speed = {};
  const stride = {};
  for (const [slot, cfg] of Object.entries(G.clips)) {
    if (!cfg.rate) continue;                    // a pose clip covers no ground
    const raw = measureStride(scene, clips[slot], G.feet) * s;
    if (raw <= 0) {
      throw new Error(`[glb_rig] ${key}: clip "${cfg.name}" moved none of the `
        + `feet named in glb.feet (${G.feet.join(', ')}) — check the bone names, `
        + `remembering the exporter strips dots`);
    }
    stride[slot] = raw;
    speed[slot] = raw * (cfg.strides ?? 1) / clips[slot].duration * cfg.rate;
  }
  scene.traverse((o) => { if (o.isBone && rest.has(o.name)) o.quaternion.copy(rest.get(o.name)); });
  scene.updateMatrixWorld(true);

  // The gait the Brain steers by — see the note on the JSDoc above.
  sp.gait.walk = speed.walk;
  sp.gait.trot = speed.trot;
  sp.gait.run = speed.run;

  // Bounds carrier. `hunt_detect.meshHeight` reads half the animal's height
  // off `mesh.geometry.boundingBox`, and for this track `mesh` is a Group with
  // no geometry of its own — so it gets one that exists only to hold the box,
  // in the already-scaled metres the root works in. Never drawn: a Group has
  // no `isMesh`, so the renderer does not visit it.
  //
  // The REST-pose box, matching the procedural track, and right for the same
  // reason: an animal mid-stride and one standing still are the same size of
  // animal, and a per-frame box would make the photo gate flicker with the gait.
  const bounds = new THREE.BufferGeometry();
  bounds.boundingBox = new THREE.Box3(
    new THREE.Vector3(box.min.x * s, 0, box.min.z * s),
    new THREE.Vector3(box.max.x * s, G.height, box.max.z * s));

  // One prototype per coat. The mesh, the skeleton and the clips are shared by
  // every variant — only the materials differ — because the whole cast of one
  // species is one animal wearing a different coat, and cloning geometry per
  // morph would pay for three foxes' memory to draw one.
  //
  // Two scales, and conflating them is a bug that has already been paid for.
  // `scale` is the ASSET fit — model units to metres, ~0.22 for the fox — and
  // is what the rig's transform needs. `size` is how big this individual is
  // AS AN ANIMAL, ~1, and is what `Brain._scale` needs: the Brain multiplies
  // every gait speed by it, so a bigger fox moves faster. Handing the Brain
  // the fit factor instead multiplied the fox's flee speed by 0.22 and left it
  // strolling away from the camper at 0.07 m/s, playing the walk clip.
  //
  // The procedural track never noticed the difference because its blueprints
  // are authored in metres, so its fit is 1 and the two numbers coincide.
  const protos = sp.variants.map((v) => ({
    scene, clips, variant: v, species: key,
    scale: s * (v.scale ?? 1), size: v.scale ?? 1, minY: box.min.y, fit: s,
    speed, stride, geoms: [bounds, bounds], height: G.height,
    mats: buildCoat(scene, v),
    glb: G,
  }));

  if (log) {
    const parts = Object.entries(G.clips)
      .filter(([slot]) => stride[slot] !== undefined)
      .map(([slot, cfg]) => `${cfg.name} ${(stride[slot] * 100).toFixed(1)} cm`
        + `${cfg.strides > 1 ? ` x${cfg.strides}` : ''}`
        + ` / ${clips[slot].duration.toFixed(2)}s at ${cfg.rate}x`
        + ` -> ${speed[slot].toFixed(3)} m/s`);
    console.info(`[glb_rig] ${key}: model ${modelH.toFixed(2)}u -> ${G.height} m `
      + `(x${s.toFixed(3)}), ${sp.variants.length} coats; ${parts.join('; ')}. `
      + `Clips unmodified.`);
  }
  return protos;
}

/**
 * One coat, as a material per slot of the GLB.
 *
 * The asset ships untextured: every material is a flat `baseColorFactor`, which
 * is what makes a morph a recolour rather than a second export. A variant that
 * names no colours wears the material exactly as Blender authored it — that is
 * the whole promise of this track and the base coat keeps it. The others are
 * the same coat in a different set of tones, named by the Blender material so
 * the mapping is legible from the artist's side.
 *
 * Colours arrive as **linear** RGB triples, not sRGB hex, because that is what
 * glTF stores in `baseColorFactor` and what `GLTFLoader` hands three — it calls
 * `setRGB(..., LinearSRGBColorSpace)` on the way in. Taking a hex here would put
 * the override and the value it is replacing in two different spaces, and every
 * morph would come out quietly wrong in a way that looks like an art choice.
 */
function buildCoat(scene, v) {
  const out = new Map();
  scene.traverse((o) => {
    const list = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of list) {
      if (out.has(m.name)) continue;
      const c = v.col?.[m.name];
      // No override: share the authored material itself, uncloned. One less
      // program to compile and nothing to drift out of sync with the .blend.
      if (c === undefined) { out.set(m.name, m); continue; }
      const cl = m.clone();
      cl.color = new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
      cl.name = `${m.name} [${v.name}]`;
      out.set(m.name, cl);
    }
  });
  return out;
}

/**
 * One animal: a cloned rig, its own mixer, and the clip blender.
 *
 * Same constructor shape as `AnimRig` so `Wildlife._buildPool` does not care
 * which backend it is holding.
 */
export class GlbRig {
  constructor(proto, scale, gaitCfg, speciesKey) {
    this.proto = proto;
    this.cfg = gaitCfg;
    this.species = speciesKey;
    this.scale = scale;
    this.gaitName = 'stand';

    // SkeletonUtils.clone, not Object3D.clone: a SkinnedMesh has to be
    // re-bound to a cloned skeleton, and the plain clone shares the original's
    // bones — every animal would then play every other animal's animation.
    this.rig = cloneRigged(proto.scene);
    this.rig.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      o.castShadow = true;
      o.receiveShadow = false;
      // The pool is parked underground and streamed in and out; three's own
      // culling works off a bind-pose bounding sphere that a running animation
      // leaves behind, so the parent Group's visibility is the cull that counts.
      o.frustumCulled = false;
      o.material = Array.isArray(o.material)
        ? o.material.map((m) => proto.mats.get(m.name) ?? m)
        : (proto.mats.get(o.material.name) ?? o.material);
    });

    // Two nested transforms, and the split matters. `fit` carries everything
    // about the ASSET — the exporter's -Z facing, the metre scale, the lift
    // that puts the paws on y=0 — and never changes again. `root` carries
    // everything about the ANIMAL, and is written every frame. Collapsing them
    // would mean re-deriving the fit each time the animal turns.
    this.fit = new THREE.Object3D();
    this.fit.rotation.y = Math.PI;
    this.fit.scale.setScalar(scale);
    this.fit.position.y = -proto.minY * scale;
    this.fit.add(this.rig);

    this.mesh = new THREE.Group();
    // Yaw first, then the terrain tilt, so an animal on a slope leans along its
    // own heading instead of around the world axes.
    this.mesh.rotation.order = 'YXZ';
    this.mesh.add(this.fit);
    // See the `bounds` note in `loadGlbSpecies` — this is a bounds carrier for
    // the photo detector, not something the renderer ever draws.
    this.mesh.geometry = proto.geoms[0];

    this.mixer = new THREE.AnimationMixer(this.rig);
    this.act = {};
    for (const slot of Object.keys(proto.clips)) {
      const a = this.mixer.clipAction(proto.clips[slot]);
      a.play();
      a.setEffectiveWeight(0);
      this.act[slot] = a;
    }
    this.act.stand.setEffectiveWeight(1);

    this.pitch = 0;
    this.roll = 0;
    // Damped blend per clip, and the damped speed the playback rates ride on.
    // See BLEND_TIME for why every one of these has a clock of its own.
    this.bMove = 0;
    this.bTrot = 0;
    this.bRun = 0;
    this.bGraze = 0;
    this.bAlert = 0;
    this.paceSpeed = 0;
    this._shadow = true;
    this._warm = false;
  }

  /**
   * Place the animal, and start its cycle somewhere of its own.
   *
   * The offset is what stops a pair of foxes marching in lockstep. It is
   * derived from the position rather than from a counter so that an animal
   * streaming back into the same slot does not inherit the last one's phase.
   */
  reset(pos, heading, world) {
    this.mesh.position.copy(pos);
    this.mesh.rotation.y = heading;
    const r = mulberry32(((pos.x * 73856093) ^ (pos.z * 19349663)) >>> 0);
    for (const slot of Object.keys(this.act)) {
      // Only the cycles are offset. The authored pose clips play a lift and a
      // lower at their ends, so they start at frame zero every time they are
      // entered and get to play those transitions in full.
      const cyc = this.proto.glb.clips[slot].rate !== undefined;
      this.act[slot].time = cyc ? r() * this.proto.clips[slot].duration : 0;
    }
    // The ground under the animal, so a streamed-in fox is not tilted from
    // wherever the last one in this slot was standing.
    this._tilt(pos, heading, world, 1);
    this.mesh.rotation.x = this.pitch;
    this.mesh.rotation.z = this.roll;
    this.bMove = 0; this.bTrot = 0; this.bRun = 0;
    this.bGraze = 0; this.bAlert = 0;
    this.paceSpeed = 0;
    this._warm = true;
  }

  /** Geometry LOD. One geometry here, so this is where a GLB pays nothing. */
  setLod(lod) {
    // The animation-rate LOD (`Wildlife._step`) is what actually saves the
    // frame for this track: a mixer update walks every bone of every clip, and
    // stepping it at 6 Hz instead of 60 is the whole saving. There is no second
    // mesh to swap to — one authored mesh is what the artist made, and building
    // a decimated twin is a job for the exporter, not for load time.
    void lod;
  }

  /** Shadow LOD. Set on the meshes, since a Group does not carry it down. */
  setShadow(on) {
    if (on === this._shadow) return;
    this._shadow = on;
    this.rig.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) o.castShadow = on; });
  }

  /**
   * Lie the animal along the slope it is standing on.
   *
   * The procedural track gets this for free — its gait solver plants each paw
   * against its own height query — so without it a GLB animal on a hillside
   * stands bolt upright through the ground, which is the first thing that would
   * read as "the hand-authored animals are worse".
   */
  _tilt(pos, heading, world, k) {
    _fwd.set(Math.sin(heading), 0, Math.cos(heading));
    const reach = this.proto.height * 0.7;
    const hF = world.getHeight(pos.x + _fwd.x * reach, pos.z + _fwd.z * reach);
    const hB = world.getHeight(pos.x - _fwd.x * reach, pos.z - _fwd.z * reach);
    const hL = world.getHeight(pos.x - _fwd.z * reach, pos.z + _fwd.x * reach);
    const hR = world.getHeight(pos.x + _fwd.z * reach, pos.z - _fwd.x * reach);
    const wantPitch = clamp(Math.atan2(hB - hF, reach * 2), -0.5, 0.5);
    const wantRoll = clamp(Math.atan2(hR - hL, reach * 2), -0.4, 0.4);
    this.pitch += (wantPitch - this.pitch) * k;
    this.roll += (wantRoll - this.roll) * k;
  }

  /**
   * One frame, from the same `drive` block the procedural rig reads.
   *
   * drive = {
   *   pos, heading, speed   world position / yaw / ground speed (m/s)
   *   graze 0..1            head down into the grass
   *   alert 0..1            head up, ears forward, body stiff
   *   flag  0..1            tail up — deer only, and no clip carries it here
   *   look  Vector3|null    world point to watch — no clip carries it here
   *   lod   0 near | 1 mid
   * }
   *
   * `graze` and `alert` arriving pre-smoothed is what makes this track cheap.
   * `Brain` already ramps them (see its "smoothed pose channels" block) and
   * already answers the awkward question — an animal in WATCH sits at 0.62
   * alert while it is drifting and 0.85 while it is still, so the alert pose
   * partial-blends over a walk exactly as much as the state deserves, with no
   * second state machine here to disagree with the first one.
   */
  update(dt, drive, world) {
    const pos = drive.pos, heading = drive.heading;
    if (!this._warm) this.reset(pos, heading, world);

    this.mesh.position.copy(pos);
    this.mesh.rotation.y = heading;
    this._tilt(pos, heading, world, 1 - Math.exp(-6 * dt));
    this.mesh.rotation.x = this.pitch;
    this.mesh.rotation.z = this.roll;

    const g = this.cfg;
    const sp = this.proto.speed;
    // `damp` is framerate-independent; the lambda is chosen so a blend covers
    // most of its travel in BLEND_TIME.
    const L = 3 / BLEND_TIME;

    // ── the locomotion ladder ───────────────────────────────────────────────
    // Every band is a fraction of the animal's OWN cruising speeds, never an
    // absolute — see MOVING. Each tier measures how far past the lower clip's
    // cruise the animal is, against the gap to the upper clip's cruise, so a
    // stride rebuilt in Blender moves the handover with it.
    const wMove = clamp01((drive.speed / (g.walk || 1) - MOVING[0])
      / (MOVING[1] - MOVING[0]));
    const wTrot = clamp01(((drive.speed - g.walk) / Math.max(g.trot - g.walk, 1e-4)
      - TROTTING[0]) / (TROTTING[1] - TROTTING[0]));
    const wRun = clamp01(((drive.speed - g.trot) / Math.max(g.run - g.trot, 1e-4)
      - RUNNING[0]) / (RUNNING[1] - RUNNING[0]));
    this.bMove = damp(this.bMove, wMove, L, dt);
    this.bTrot = damp(this.bTrot, wTrot, L, dt);
    this.bRun = damp(this.bRun, wRun, L, dt);
    this.bGraze = damp(this.bGraze, drive.graze, L, dt);
    this.bAlert = damp(this.bAlert, drive.alert, L, dt);

    // ── the budget ──────────────────────────────────────────────────────────
    // The weights must sum to 1. An unnormalised set makes the mixer average
    // toward the rest pose, and the animal visibly sinks as it changes gait.
    //
    // Locomotion takes what it needs and the standing poses share what is left,
    // so a fox that is genuinely running gets no graze or alert contribution —
    // which is right: the run clip already reads as flight, and blending a
    // head-up freeze into it would only soften both. It falls out of the
    // arithmetic rather than needing a rule.
    const move = this.bMove;
    const still = 1 - move;
    // Alert outranks graze: an animal that has just noticed you has its head
    // up, whatever it was doing a moment ago.
    const al = this.bAlert * still;
    const gz = Math.min(this.bGraze * still, still - al);
    const a = this.act;
    a.run.setEffectiveWeight(move * this.bRun);
    a.trot.setEffectiveWeight(move * (1 - this.bRun) * this.bTrot);
    a.walk.setEffectiveWeight(move * (1 - this.bRun) * (1 - this.bTrot));
    a.alert.setEffectiveWeight(al);
    a.graze.setEffectiveWeight(gz);
    a.stand.setEffectiveWeight(still - al - gz);

    // ── the rates ───────────────────────────────────────────────────────────
    // A clip's rate follows speed through the SAME number its cruising speed
    // was derived from, so an animal at its cruising walk plays Walk at exactly
    // the authored rate, and every gait keeps its paws with the ground.
    //
    // Damped on the blend's clock for the same reason the blend is: an undamped
    // rate collapsed from 1.87x to the clamp floor in one frame, so the legs
    // changed tempo instantly underneath a crossfade that was busy taking
    // 300 ms. While the animal holds a steady pace the damped speed equals the
    // real one, so this costs the paw-to-ground lock nothing.
    this.paceSpeed = damp(this.paceSpeed, drive.speed, L, dt);
    const C = this.proto.glb.clips;
    a.walk.timeScale = clamp(this.paceSpeed / sp.walk * C.walk.rate, RATE[0], RATE[1]);
    a.trot.timeScale = clamp(this.paceSpeed / sp.trot * C.trot.rate, RATE[0], RATE[1]);
    a.run.timeScale = clamp(this.paceSpeed / sp.run * C.run.rate, RATE[0], RATE[1]);

    // What it is doing, for `Wildlife.debugState` and the harnesses that read
    // it. The heaviest clip, which is the honest answer while two are crossfading.
    let best = 'stand', bw = 0;
    for (const slot of Object.keys(a)) {
      const w = a[slot].getEffectiveWeight();
      if (w > bw) { bw = w; best = slot; }
    }
    this.gaitName = best;

    this.mixer.update(dt);
    void _q;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.rig);
    this.mesh.removeFromParent();
  }
}
