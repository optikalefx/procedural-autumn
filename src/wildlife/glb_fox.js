// ─────────────────────────────────────────────────────────────────────────────
//  glb_fox — the Blender track, on trial.
//
//  Every other animal in this valley is procedural: `mammals/<species>.js` is
//  a page of profile numbers, `quadruped.js` lofts them into a skeleton, and
//  `animal_anim.js` solves a gait against the ground every frame. This file is
//  the opposite experiment — a mesh and three clips authored by hand in Blender,
//  exported to one GLB, and played back by three's AnimationMixer.
//
//  It exists to answer one question before the whole cast is converted: does a
//  hand-authored animal hold up in this world at the ranges the player sees it?
//  So it deliberately shares as little as possible with the procedural track.
//  The ONE thing it reuses is `Brain` — where an animal goes and why is already
//  solved, it is orthogonal to how the animal is drawn, and re-deriving it here
//  would only prove that a copy of it also works.
//
//  What is NOT reused, and would have to be built if this track wins:
//    * the site table and habitat suitability (Wildlife._placeSites/_suit)
//    * streaming, the mesh pool, and the animation-rate LOD
//    * the hide material, its silhouette shader and the coat-variant system
//    * audio, the logbook hooks, photo detection
//  Those are the real cost of the swap; this file is the look test that decides
//  whether paying it is worth it.
//
//  ── the stride problem, measured and NOT compensated ──────────────────────
//
//  The Walk clip's legs swing about 13°, which moves a paw 0.35 model units —
//  7.6 cm once the fox is scaled to `TARGET_H`. Over the clip's two seconds that
//  is a ground speed of 0.037 m/s. A red fox walks at roughly 0.85 m/s, so the
//  clip as authored covers some twenty times too little ground. Trot was rebuilt
//  in Blender since — one stride over 16 frames with the leg reach opened 1.8x —
//  and covers far more ground per second, but it is the same measurement that
//  decides how fast the animal travels. See the console line `init` prints.
//
//  **This file does not touch the animation.** An earlier cut widened the leg
//  keys to buy stride, and it was wrong twice over: it changed what the artist
//  authored, and it did it by scaling glTF's ABSOLUTE bone rotations (rest x
//  pose) rather than the pose delta, so at any real gain the slerp ran past 180°
//  and the legs went somewhere nobody designed. The movement stopped matching
//  the .blend, which is the one thing this test exists to judge. That rule is
//  now written down in CLAUDE.md.
//
//  So the clips play exactly as exported, and the only lever here is the one
//  that does not alter a pose: how fast they play, and how far the animal travels
//  while they do. `measureStride` reads the ground one cycle covers straight off
//  the asset — once per clip, because Walk and Trot carry different strides over
//  different durations — and the fox's speed for that gait is that number times
//  its playback rate. So the paws keep pace with the ground at any rate, and the
//  clip is still the clip. Where a gait is slower than the real animal, that is
//  a note for the artist, not a thing for this file to paper over.
//
//  `?foxrate=` and `?foxtrotrate=` set the two playback rates, `?foxgait=` pins
//  the pack to one gait for looking at it, and `?foxspeed=` breaks the lock
//  between rate and travel, which is how you see the sliding the lock prevents.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneRigged } from 'three/addons/utils/SkeletonUtils.js';
import { System } from '../core/System.js';
import { Brain, ST, WATER_MAX } from './animal_brain.js';
import { FOX } from './mammals/fox.js';
import { clamp, clamp01, damp, mulberry32 } from '../core/MathUtils.js';

// Root-absolute, matching how the bakes are fetched in main.js: dev serves
// public/ at the root and the production build ships the same layout.
const MODEL_URL = '/models/fox_reference.glb';

// Ear-tip to paw, in metres. Chosen to stand beside the procedural cast rather
// than against a tape measure: `mammals/fox.js` carries its head at y=0.496
// with the ears above that, so a hair over 0.6 puts the two foxes shoulder to
// shoulder. If this one reads as a different animal from the other, that is a
// finding about the pipeline, not a licence to fudge the number.
const TARGET_H = 0.62;

// How fast the Walk clip plays, as a multiple of its authored tempo. This is a
// playback speed, not an edit: every pose the fox strikes is a pose that is in
// the .blend, which is the whole point.
//
// 2.2 is a judgement call about cadence and nothing else. The authored cycle is
// 2.042 s, or 0.49 Hz, where a walking quadruped runs 1.0-1.8 Hz; 2.2x puts it
// at 1.08 Hz, the slow end of a real walk. Raise it and the fox travels faster
// in exact proportion — see `walkSpeed` in `init`.
const WALK_RATE = 2.2;

// The Trot plays as authored, and that is the point of the number being 1.
// Walk needs 2.2x because its cycle was keyed slow; Trot was rebuilt in Blender
// as one stride over 16 frames — 1.5 Hz at 24 fps, which is already a real
// trotting cadence — so speeding it up would only undo the artist's timing.
// If the trot ever needs to cover more ground, that is a stride to widen in the
// .blend, not a rate to raise here.
const TROT_RATE = 1.0;

// Bounds on that rate once the Brain is steering. The animal is only ever asked
// to move at a speed the clip carries, so these are a guard against a state that
// wants something else (FLEE), not a routine clamp.
const RATE = [0.6, 3.2];

// Where the Stand->Walk crossfade starts and finishes, **as a fraction of the
// fox's own cruising walk speed** rather than in m/s. Absolute numbers were a
// bug: they were written when the animal walked at 0.44 m/s, and once the clip's
// real 0.08 m/s took over, cruising speed landed inside the band — so the fox
// walked permanently at 62% Walk / 38% Stand and never once played the clip
// clean. Anchoring to the animal's own speed cannot drift like that.
const MOVING = [0.25, 0.85];

// The same idea one tier up: where Walk hands over to Trot, as a fraction of the
// gap between the two clips' own cruising speeds. 0 is cruising walk and 1 is
// cruising trot, so the fox is fully trotting a little before it reaches the
// trot's authored speed and never plays a clip far off its tempo.
const TROTTING = [0.2, 0.9];

// Seconds for the crossfade, floor to ceiling. The blend is damped on its own
// clock rather than read straight off `Brain.speed`, because that speed is a
// step function here: the Brain's accel/decel rates are absolute and tuned for
// animals moving metres per second, so at this fox's 0.08 m/s every change of
// pace completes within one frame. Measured — walk weight went 0.62 -> 0 in
// 16 ms, which is the snap. Damping the blend gives the transition a duration
// of its own, whatever the speed signal does.
const BLEND_TIME = 0.22;

const PACK = 5;
const RING = [10, 30];        // where a fox is seated relative to the player
const RESEAT = 130;           // ...and how far they may drift before re-seating

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * How far a paw travels through one cycle of `clip`, in model units.
 *
 * The clip is in place, so the paw's own displacement IS the stride the body
 * would cover if the foot were planted. Sampling beats reading the keyframes:
 * it accounts for the whole chain (upper, lower and foot bones compound) and it
 * keeps working if the rig is rebuilt with different joints.
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

/** One fox: a cloned rig, its own mixer, and a Brain. */
class GlbFoxIndividual {
  constructor(proto, seed, group, slot, scene) {
    // SkeletonUtils.clone, not Object3D.clone: a SkinnedMesh has to be
    // re-bound to a cloned skeleton, and the plain clone shares the original's
    // bones — every fox would then play every other fox's animation.
    this.rig = cloneRigged(proto.scene);
    this.rig.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = false; o.frustumCulled = false; }
    });

    // Two nested transforms, and the split matters. `fit` carries everything
    // about the ASSET — the exporter's -Z facing, the metre scale, the lift
    // that puts the paws on y=0 — and never changes again. `root` carries
    // everything about the ANIMAL, and is written every frame. Collapsing them
    // would mean re-deriving the fit each time the fox turns.
    this.fit = new THREE.Object3D();
    this.fit.rotation.y = Math.PI;
    this.fit.scale.setScalar(proto.scale);
    this.fit.position.y = -proto.minY * proto.scale;
    this.fit.add(this.rig);

    this.root = new THREE.Object3D();
    // Yaw first, then the terrain tilt, so a fox on a slope leans along its own
    // heading instead of around the world axes.
    this.root.rotation.order = 'YXZ';
    this.root.add(this.fit);
    scene.add(this.root);

    this.mixer = new THREE.AnimationMixer(this.rig);
    this.stand = this.mixer.clipAction(proto.stand);
    this.walk = this.mixer.clipAction(proto.walk);
    this.trot = this.mixer.clipAction(proto.trot);
    for (const a of [this.stand, this.walk, this.trot]) { a.play(); a.setEffectiveWeight(0); }
    this.stand.setEffectiveWeight(1);
    // Offset each fox into the cycle so a pack does not march in lockstep.
    const r = mulberry32(seed >>> 0);
    this.stand.time = r() * proto.stand.duration;
    this.walk.time = r() * proto.walk.duration;
    this.trot.time = r() * proto.trot.duration;

    this.brain = new Brain('fox', proto.species, seed, group, slot);
    this.drive = {};
    this.pitch = 0;
    this.roll = 0;
    // Damped Stand<->Walk crossfade, and the damped speed its playback rate
    // rides on. See BLEND_TIME.
    this.blend = 0;
    this.trotBlend = 0;
    this.paceSpeed = 0;
  }

  dispose(scene) {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.rig);
    scene.remove(this.root);
    this.rig.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) o.geometry?.dispose?.(); });
  }
}

export class GlbFoxes extends System {
  constructor(ctx) {
    super(ctx);
    this.foxes = [];
    this.proto = null;
    this.group = { alarm: 0, fleeH: null, members: [] };
    this._seated = false;
    // Set by debugSpawn: a pack a capture has deliberately framed must not be
    // dragged back to the camper by the re-seat below on the very next frame.
    this._pinned = false;
    // Set by debugCalm: the Walk clip is only visible on an animal that has not
    // noticed the player, and every fox seated inside RING is well inside
    // `alertDist`. A capture that wants to see the gait turns the camper off.
    this._calm = false;
    this._rnd = mulberry32(0x5eed ^ 0xf0);
    this.stats = { n: 0, clipSpeed: 0, stride: 0, trotClipSpeed: 0, trotStride: 0 };

    const q = new URLSearchParams(location.search);
    this.enabled = q.get('glbfox') !== '0';
    this.count = Math.max(0, Math.min(24, +(q.get('glbfox') ?? PACK) || PACK));
    this.rate = +(q.get('foxrate') ?? WALK_RATE) || WALK_RATE;
    this.trotRate = +(q.get('foxtrotrate') ?? TROT_RATE) || TROT_RATE;
    this.speedMul = +(q.get('foxspeed') ?? 1) || 1;
    // Pin the whole pack to one gait, for looking at it rather than for play:
    // `?foxgait=trot` holds every fox at its cruising trot so the clip can be
    // judged without waiting for the Brain to choose that speed on its own.
    this.forceGait = q.get('foxgait');
  }

  /**
   * Load the GLB, measure it, and build the pack.
   *
   * `?glbfox=0` turns the whole system off, `?glbfox=<n>` sets the pack size,
   * `?foxrate=<k>` sets the clip's playback rate — travel speed follows it, so
   * the paws stay with the ground — and `?foxspeed=<k>` breaks that lock, which
   * is how you see the sliding it prevents.
   */
  async init() {
    if (!this.enabled) return;

    const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
    const scene = gltf.scene;

    const stand = gltf.animations.find((a) => a.name === 'Stand');
    const walk = gltf.animations.find((a) => a.name === 'Walk');
    const trot = gltf.animations.find((a) => a.name === 'Trot');
    if (!stand || !walk || !trot) {
      console.warn('[glb_fox] expected clips Stand, Walk and Trot, got',
        gltf.animations.map((a) => a.name));
      this.enabled = false;
      return;
    }

    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const modelH = box.max.y - box.min.y;
    const s = TARGET_H / modelH;

    // The rest pose, captured before anything animates the scene, and put back
    // after measuring: `measureStride` leaves the skeleton wherever its last
    // sample landed, and a clone taken from a half-walked fox starts life with
    // one leg in the air until its mixer's first update. Read-only — the clip
    // itself is never written to.
    const rest = new Map();
    scene.traverse((o) => { if (o.isBone) rest.set(o.name, o.quaternion.clone()); });

    // Blender's exporter strips the dots out of `hind_foot.L`, so the bone is
    // `hind_footL` here.
    const FEET = ['fore_footL', 'fore_footR', 'hind_footL', 'hind_footR'];
    const stride = measureStride(scene, walk, FEET) * s;
    const trotStride = measureStride(scene, trot, FEET) * s;
    scene.traverse((o) => { if (o.isBone && rest.has(o.name)) o.quaternion.copy(rest.get(o.name)); });
    scene.updateMatrixWorld(true);

    // Ground covered per second of clip, straight off each asset. Both clips get
    // the same treatment because both have to keep their own paws on the ground:
    // they carry different strides over different durations, so one shared number
    // would slide whichever clip it was not derived from.
    const clipSpeed = stride / walk.duration;
    const trotClipSpeed = trotStride / trot.duration;

    // The gait the Brain steers by, derived from the clips rather than from a
    // real fox — this is the whole mechanism that keeps the paws with the ground.
    // The animal travels exactly as far as the animation says it should, at
    // whatever rate the clip is played. `run` has no clip of its own, so it sits
    // just above the trot rather than promising a gallop nothing can draw.
    const walkSpeed = clipSpeed * this.rate * this.speedMul;
    const trotSpeed = trotClipSpeed * this.trotRate * this.speedMul;
    const species = {
      ...FOX,
      gait: { ...FOX.gait, walk: walkSpeed, trot: trotSpeed, run: trotSpeed * 1.25 },
    };

    this.proto = {
      scene, stand, walk, trot, species,
      scale: s, minY: box.min.y, clipSpeed, trotClipSpeed,
    };
    this.stats.clipSpeed = clipSpeed;
    this.stats.stride = stride;
    this.stats.trotStride = trotStride;
    this.stats.trotClipSpeed = trotClipSpeed;
    this.walkSpeed = walkSpeed;
    this.trotSpeed = trotSpeed;

    console.info(`[glb_fox] model ${modelH.toFixed(2)}u -> ${TARGET_H} m (x${s.toFixed(3)}); ` +
      `Walk stride ${(stride * 100).toFixed(1)} cm over ${walk.duration.toFixed(2)}s ` +
      `= ${clipSpeed.toFixed(3)} m/s at 1x, playing ${this.rate}x -> ${walkSpeed.toFixed(3)} m/s; ` +
      `Trot stride ${(trotStride * 100).toFixed(1)} cm over ${trot.duration.toFixed(2)}s ` +
      `= ${trotClipSpeed.toFixed(3)} m/s at 1x, playing ${this.trotRate}x -> ${trotSpeed.toFixed(3)} m/s ` +
      `(${(this.trotRate / trot.duration).toFixed(2)} Hz). Clips unmodified.`);

    for (let i = 0; i < this.count; i++) {
      const fox = new GlbFoxIndividual(this.proto, (0xf0 * 2654435761 + i * 40503) >>> 0,
        this.group, i, this.ctx.scene);
      this.group.members.push(fox);
      this.foxes.push(fox);
    }
    this.stats.n = this.foxes.length;
  }

  /**
   * Seat the pack on dry, walkable ground around a point.
   *
   * This is test scaffolding and nothing else. The procedural cast earns its
   * position from a habitat suitability field and a capped site table
   * (`Wildlife._suit`, `_placeSites`); none of that exists here, so the foxes
   * are simply put near the player, and put near them again if the player
   * drives off and leaves them behind. It guarantees there is something to
   * look at, which is the entire point of the exercise.
   */
  _seat(cx, cz, ring = RING) {
    const W = this.ctx.world;
    for (let i = 0; i < this.foxes.length; i++) {
      const fox = this.foxes[i];
      // Fan the fallback around the ring by index rather than dropping every
      // fox that fails its probes onto (cx, cz) — that put two of five inside
      // each other the first time this ran on a steep site.
      const spoke = (i / this.foxes.length) * Math.PI * 2;
      let px = cx + Math.sin(spoke) * ring[0];
      let pz = cz + Math.cos(spoke) * ring[0];
      for (let attempt = 0; attempt < 40; attempt++) {
        const a = this._rnd() * Math.PI * 2;
        const r = ring[0] + this._rnd() * (ring[1] - ring[0]);
        const tx = cx + Math.sin(a) * r, tz = cz + Math.cos(a) * r;
        if (!W.isInBounds(tx, tz)) continue;
        if (W.getWaterDepth(tx, tz) > WATER_MAX) continue;
        if (W.getSlope(tx, tz) > 0.6) continue;
        px = tx; pz = tz; break;
      }
      fox.brain.reset(px, W.getHeight(px, pz), pz, this._rnd() * Math.PI * 2, 1);
    }
    this.group.alarm = 0;
    this.group.fleeH = null;
    this._seated = true;
  }

  update(dt) {
    if (!this.enabled || !this.proto) return;

    const W = this.ctx.world;
    const cam = this.ctx.camera;
    const veh = this.ctx.systems?.vehicle;

    // Seat on the first frame the world can answer a height query, then re-seat
    // if the player has left the pack behind. Both are test-only — see `_seat`.
    const cx = veh?.position?.x ?? cam.position.x;
    const cz = veh?.position?.z ?? cam.position.z;
    if (!this._seated) this._seat(cx, cz);
    else if (!this._pinned && this.foxes.length) {
      const lead = this.foxes[0].brain.pos;
      if ((lead.x - cx) ** 2 + (lead.z - cz) ** 2 > RESEAT * RESEAT) this._seat(cx, cz);
    }

    let threat = null;
    if (veh?.position && !this._calm) {
      this._threat ??= { x: 0, z: 0, speed: 0, heading: 0 };
      this._threat.x = veh.position.x;
      this._threat.z = veh.position.z;
      this._threat.speed = veh.speed ?? 0;
      this._threat.heading = veh.heading ?? 0;
      threat = this._threat;
    }

    for (let i = 0; i < this.foxes.length; i++) {
      const fox = this.foxes[i];
      const B = fox.brain;
      B.update(dt, W, threat, B.leader ? null : this.foxes[0].brain);
      // Debug surface only: hold the animal at one gait's cruising speed so the
      // clip can be judged without waiting for the Brain to pick that pace.
      if (this.forceGait === 'trot') B.speed = this.trotSpeed;
      else if (this.forceGait === 'walk') B.speed = this.walkSpeed;
      else if (this.forceGait === 'stand') B.speed = 0;

      fox.root.position.set(B.pos.x, B.pos.y, B.pos.z);
      fox.root.rotation.y = B.heading;

      // Lie the fox along the slope it is standing on. The procedural track
      // gets this for free — its gait solver plants each paw against its own
      // height query — so without it a GLB fox on a hillside stands bolt
      // upright through the ground, which is the first thing that would read
      // as "the new animals are worse".
      _fwd.set(Math.sin(B.heading), 0, Math.cos(B.heading));
      const reach = TARGET_H * 0.7;
      const hF = W.getHeight(B.pos.x + _fwd.x * reach, B.pos.z + _fwd.z * reach);
      const hB = W.getHeight(B.pos.x - _fwd.x * reach, B.pos.z - _fwd.z * reach);
      const hL = W.getHeight(B.pos.x - _fwd.z * reach, B.pos.z + _fwd.x * reach);
      const hR = W.getHeight(B.pos.x + _fwd.z * reach, B.pos.z - _fwd.x * reach);
      const wantPitch = clamp(Math.atan2(hB - hF, reach * 2), -0.5, 0.5);
      const wantRoll = clamp(Math.atan2(hR - hL, reach * 2), -0.4, 0.4);
      fox.pitch = damp(fox.pitch, wantPitch, 6, dt);
      fox.roll = damp(fox.roll, wantRoll, 6, dt);
      fox.root.rotation.x = fox.pitch;
      fox.root.rotation.z = fox.roll;

      // Stand, Walk and Trot, crossfaded on speed alone. Three clips is the
      // whole vocabulary: there is no graze, no alert, no flee pose, so a fox
      // that the Brain has frozen in ALERT simply stands. That gap is the
      // finding — the procedural cast has all of those, and matching it in
      // Blender is six more clips per species.
      const cruise = this.walkSpeed || 1;
      const want = clamp01((B.speed / cruise - MOVING[0]) / (MOVING[1] - MOVING[0]));
      // How far past the cruising walk the animal is, measured against the gap
      // to the cruising trot so the handover cannot drift if either clip's
      // stride changes — the same reasoning as MOVING, one tier up.
      const gap = Math.max(this.trotSpeed - this.walkSpeed, 1e-4);
      const wantTrot = clamp01(((B.speed - this.walkSpeed) / gap - TROTTING[0])
        / (TROTTING[1] - TROTTING[0]));
      // `damp` is framerate-independent; the lambda is chosen so the blend
      // covers most of its travel in BLEND_TIME.
      fox.blend = damp(fox.blend, want, 3 / BLEND_TIME, dt);
      fox.trotBlend = damp(fox.trotBlend, wantTrot, 3 / BLEND_TIME, dt);
      // Trot takes precedence and the lower pair share what is left, so the
      // three weights always sum to 1 — an unnormalised set makes the mixer
      // average toward the rest pose and the fox sinks as it changes gait.
      const t = fox.trotBlend;
      fox.trot.setEffectiveWeight(t);
      fox.walk.setEffectiveWeight(fox.blend * (1 - t));
      fox.stand.setEffectiveWeight((1 - fox.blend) * (1 - t));
      // Rate follows speed through the SAME number each speed was derived from,
      // so a fox at its cruising walk plays Walk at exactly `this.rate`, one at
      // its cruising trot plays Trot at `this.trotRate`, and both keep their paws
      // with the ground. Only a Brain state asking for something the clips
      // cannot carry reaches the clamp.
      //
      // Damped on the blend's clock for the same reason the blend is: an
      // undamped rate collapsed from 1.87x to the clamp floor in one frame, so
      // the legs changed tempo instantly underneath a crossfade that was busy
      // taking 300 ms. While the fox holds a steady pace the damped speed equals
      // the real one, so this costs the paw-to-ground lock nothing.
      fox.paceSpeed = damp(fox.paceSpeed, B.speed, 3 / BLEND_TIME, dt);
      fox.walk.timeScale = clamp(fox.paceSpeed / this.proto.clipSpeed, RATE[0], RATE[1]);
      fox.trot.timeScale = clamp(fox.paceSpeed / this.proto.trotClipSpeed, RATE[0], RATE[1]);
      fox.mixer.update(dt);
    }
  }

  /** Put the pack in front of the camera. Debug surface, mirrors Wildlife's. */
  debugSpawn(dist = 14, ring = null) {
    if (!this.proto) return null;
    _v.set(0, 0, -1).applyQuaternion(this.ctx.camera.quaternion);
    const x = this.ctx.camera.position.x + _v.x * dist;
    const z = this.ctx.camera.position.z + _v.z * dist;
    this._seat(x, z, ring ?? RING);
    this._pinned = true;
    return { x, z, n: this.foxes.length };
  }

  /**
   * Put one fox at an exact spot, walking a long straight line.
   *
   * A look test wants the gait held still in the frame, not whatever the state
   * machine happened to pick — so this pins the animal, points it, and gives it
   * a target far enough away that it will not arrive and stop mid-capture.
   */
  debugWalk(i, x, z, heading, run = 400) {
    const fox = this.foxes[i];
    if (!fox) return null;
    const W = this.ctx.world;
    const B = fox.brain;
    this._pinned = true;
    this._calm = true;
    B.reset(x, W.getHeight(x, z), z, heading, 1);
    B.state = ST.WANDER;
    B.timer = 1e4;
    B.target.set(x + Math.sin(heading) * run, 0, z + Math.cos(heading) * run);
    B.wantHeading = heading;
    return { x, z, heading };
  }

  /** Ignore the camper, so the pack goes about its business. Debug surface. */
  debugCalm(on = true) {
    this._calm = !!on;
    if (on) for (const f of this.foxes) if (f.brain.state === ST.ALERT) f.brain.state = ST.IDLE;
  }

  debugState() {
    return {
      n: this.foxes.length,
      clipSpeed: +this.stats.clipSpeed.toFixed(4),
      trotClipSpeed: +(this.stats.trotClipSpeed ?? 0).toFixed(4),
      rate: this.rate,
      trotRate: this.trotRate,
      strideCm: +(this.stats.stride * 100).toFixed(1),
      trotStrideCm: +((this.stats.trotStride ?? 0) * 100).toFixed(1),
      walkSpeed: +(this.walkSpeed ?? 0).toFixed(3),
      trotSpeed: +(this.trotSpeed ?? 0).toFixed(3),
      foxes: this.foxes.map((f) => ({
        state: Object.keys(ST).find((k) => ST[k] === f.brain.state),
        speed: +f.brain.speed.toFixed(3),
        x: +f.brain.pos.x.toFixed(1),
        y: +f.brain.pos.y.toFixed(1),
        z: +f.brain.pos.z.toFixed(1),
        walkW: +f.walk.getEffectiveWeight().toFixed(2),
        trotW: +f.trot.getEffectiveWeight().toFixed(2),
        cruiseFrac: +(f.brain.speed / (this.walkSpeed || 1)).toFixed(2),
        rate: +f.walk.timeScale.toFixed(2),
        trotRate: +f.trot.timeScale.toFixed(2),
      })),
    };
  }

  dispose() {
    for (const f of this.foxes) f.dispose(this.ctx.scene);
    this.foxes.length = 0;
    this.group.members.length = 0;
  }
}
