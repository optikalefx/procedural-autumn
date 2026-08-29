// ─────────────────────────────────────────────────────────────────────────────
//  glb_fox — the Blender track, on trial.
//
//  Every other animal in this valley is procedural: `mammals/<species>.js` is
//  a page of profile numbers, `quadruped.js` lofts them into a skeleton, and
//  `animal_anim.js` solves a gait against the ground every frame. This file is
//  the opposite experiment — a mesh and two clips authored by hand in Blender,
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
//  ── the stride problem, measured ───────────────────────────────────────────
//
//  The Walk clip's legs swing about 14° peak-to-peak, which moves a paw 0.35
//  model units — 7.6 cm once the fox is scaled to `TARGET_H`. Over the clip's
//  2.042 s that is a ground speed of **0.037 m/s**. A red fox walks at roughly
//  0.85 m/s, so the clip as authored is some twenty times short: played at a
//  rate that matches how fast the animal actually travels, the legs blur; played
//  at a believable rate, the fox skates.
//
//  Rather than pick one of those and call it done, this file measures the clip
//  at load (`measureStride`) and derives everything downstream from the number,
//  so the tuning follows the asset instead of a constant going stale behind it:
//
//    * `STRIDE_GAIN` widens the authored leg swing by scaling the leg bones'
//      rotation keys — on the LOADED clip, never on the asset on disk. It is
//      the honest lever, and the number it needs (~4) is exactly how much more
//      swing the Blender clip should have been authored with.
//    * the fox's walk speed is then set FROM the clip rather than from a fox's
//      real-world pace, so the feet do not slide. A slow fox is a fair look
//      test; a skating one is not.
//
//  Widen the stride in Blender and `STRIDE_GAIN` drops toward 1 on its own.
//  `?foxstride=` and `?foxspeed=` tune both live — see the header of `init`.
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

// The authored swing, multiplied. See the stride note above — 4 is the factor
// that turns a 14° shuffle into a stride a fox could plausibly walk on.
const STRIDE_GAIN = 4.0;

// How fast the Walk clip is allowed to play. Below 1 the fox is dawdling, above
// ~2.5 the legs start to read as a trot the clip is not.
const RATE = [0.75, 2.4];

// The speed the fox walks at, as a multiple of what the (gained) clip carries at
// 1x. Two means the clip runs at 2x when the animal is at its cruising walk,
// which leaves headroom in both directions.
const WALK_RATE = 2.0;

// Blend in the walk over this speed band. Narrow, because the interesting
// question is whether the Stand->Walk transition reads cleanly at all.
const MOVING = [0.02, 0.10];

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

/**
 * Widen every leg-bone rotation in `clip` by `gain`.
 *
 * The authored leg keys are rotations about a single axis, so scaling the angle
 * is a slerp away from identity — `slerp(identity, q, gain)` is the same
 * rotation `gain` times over. Anything past 180° would wrap, which no plausible
 * gain reaches here, and the spine, neck, head and tail are left exactly as
 * authored: only the stride is short, and amplifying the head bob with it would
 * turn a fox into a hobby horse.
 */
function widenStride(clip, gain, isLeg) {
  if (gain === 1) return;
  const q = new THREE.Quaternion();
  const acc = new THREE.Quaternion();
  for (const track of clip.tracks) {
    if (!(track instanceof THREE.QuaternionKeyframeTrack)) continue;
    if (!isLeg(track.name.split('.')[0])) continue;
    const v = track.values;
    for (let i = 0; i < v.length; i += 4) {
      q.set(v[i], v[i + 1], v[i + 2], v[i + 3]);
      acc.set(0, 0, 0, 1).slerp(q, gain);   // slerp past t=1 extrapolates the arc
      v[i] = acc.x; v[i + 1] = acc.y; v[i + 2] = acc.z; v[i + 3] = acc.w;
    }
  }
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
    for (const a of [this.stand, this.walk]) { a.play(); a.setEffectiveWeight(0); }
    this.stand.setEffectiveWeight(1);
    // Offset each fox into the cycle so a pack does not march in lockstep.
    const r = mulberry32(seed >>> 0);
    this.stand.time = r() * proto.stand.duration;
    this.walk.time = r() * proto.walk.duration;

    this.brain = new Brain('fox', proto.species, seed, group, slot);
    this.drive = {};
    this.pitch = 0;
    this.roll = 0;
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
    this.stats = { n: 0, clipSpeed: 0, stride: 0 };

    const q = new URLSearchParams(location.search);
    this.enabled = q.get('glbfox') !== '0';
    this.count = Math.max(0, Math.min(24, +(q.get('glbfox') ?? PACK) || PACK));
    this.gain = +(q.get('foxstride') ?? STRIDE_GAIN) || STRIDE_GAIN;
    this.speedMul = +(q.get('foxspeed') ?? 1) || 1;
  }

  /**
   * Load the GLB, measure it, and build the pack.
   *
   * `?glbfox=0` turns the whole system off, `?glbfox=<n>` sets the pack size,
   * `?foxstride=<k>` overrides the stride gain (1 plays the clip exactly as
   * authored, and is how you see the problem the header describes), and
   * `?foxspeed=<k>` scales how fast the animals travel against the clip.
   */
  async init() {
    if (!this.enabled) return;

    const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
    const scene = gltf.scene;

    const stand = gltf.animations.find((a) => a.name === 'Stand');
    const walk = gltf.animations.find((a) => a.name === 'Walk');
    if (!stand || !walk) {
      console.warn('[glb_fox] expected clips Stand and Walk, got',
        gltf.animations.map((a) => a.name));
      this.enabled = false;
      return;
    }

    // Blender's exporter strips the dots out of `hind_foot.L`, so the bone is
    // `hind_footL` here. Matching on the prefix rather than the full name means
    // a rig rename on either side of the dot does not silently stop matching.
    const isLeg = (n) => n.startsWith('fore_') || n.startsWith('hind_');

    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const modelH = box.max.y - box.min.y;
    const s = TARGET_H / modelH;

    const strideRaw = measureStride(scene, walk, ['fore_footL', 'fore_footR', 'hind_footL', 'hind_footR']);
    widenStride(walk, this.gain, isLeg);
    const stride = measureStride(scene, walk, ['fore_footL', 'fore_footR', 'hind_footL', 'hind_footR']) * s;
    const clipSpeed = stride / walk.duration;

    // The gait the Brain will steer by, derived from the clip instead of from a
    // real fox. Walk is what the clip carries at WALK_RATE; trot and run exist
    // only because Brain reads all three, and there is no clip for either, so
    // they stay inside a band the walk cycle can still cover without tearing.
    const walkSpeed = clipSpeed * WALK_RATE * this.speedMul;
    const species = {
      ...FOX,
      gait: { ...FOX.gait, walk: walkSpeed, trot: walkSpeed * 1.5, run: walkSpeed * 2.2 },
    };

    this.proto = {
      scene, stand, walk, species,
      scale: s, minY: box.min.y, clipSpeed,
    };
    this.stats.clipSpeed = clipSpeed;
    this.stats.stride = stride;
    this.walkSpeed = walkSpeed;

    console.info(`[glb_fox] model ${modelH.toFixed(2)}u -> ${TARGET_H} m (x${s.toFixed(3)}); ` +
      `stride ${(strideRaw * s * 100).toFixed(1)} cm authored, ` +
      `${(stride * 100).toFixed(1)} cm at gain ${this.gain}; ` +
      `clip carries ${clipSpeed.toFixed(3)} m/s at 1x; walk ${walkSpeed.toFixed(2)} m/s`);

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

      // Stand and Walk, crossfaded on speed alone. Two clips is the whole
      // vocabulary: there is no graze, no alert, no flee pose, so a fox that
      // the Brain has frozen in ALERT simply stands. That gap is the finding —
      // the procedural cast has all of those, and matching it in Blender is
      // eight more clips per species.
      const moving = clamp01((B.speed - MOVING[0]) / (MOVING[1] - MOVING[0]));
      fox.walk.setEffectiveWeight(moving);
      fox.stand.setEffectiveWeight(1 - moving);
      fox.walk.timeScale = clamp(B.speed / this.proto.clipSpeed, RATE[0], RATE[1]);
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
      strideCm: +(this.stats.stride * 100).toFixed(1),
      walkSpeed: +(this.walkSpeed ?? 0).toFixed(3),
      foxes: this.foxes.map((f) => ({
        state: Object.keys(ST).find((k) => ST[k] === f.brain.state),
        speed: +f.brain.speed.toFixed(3),
        x: +f.brain.pos.x.toFixed(1),
        y: +f.brain.pos.y.toFixed(1),
        z: +f.brain.pos.z.toFixed(1),
        walkW: +f.walk.getEffectiveWeight().toFixed(2),
        rate: +f.walk.timeScale.toFixed(2),
      })),
    };
  }

  dispose() {
    for (const f of this.foxes) f.dispose(this.ctx.scene);
    this.foxes.length = 0;
    this.group.members.length = 0;
  }
}
