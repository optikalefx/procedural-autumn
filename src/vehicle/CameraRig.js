// ─────────────────────────────────────────────────────────────────────────────
//  CameraRig — chase / free (photo) / auto-orbit / cockpit.
//
//  The chase camera is the single thing the player looks through for hours, so
//  it is built like a camera operator rather than a boom arm:
//
//   · it follows a *damped* heading, not the instantaneous one, so the world
//     swings through frame on a turn instead of snapping;
//   · it aims at a look-ahead point straight down the camper's own nose — it
//     does NOT lead sideways off the steering angle, which is a panning
//     motion the player asked to have removed;
//   · height and FOV open up with speed, which is most of the sensation of
//     going fast;
//   · drag the mouse to orbit and roll the wheel to zoom, over a range that
//     goes from "admire the paintwork" to "frame the whole valley";
//   · a manual orbit eases back to trailing once you stop touching it — but
//     only while actually moving, so a parked player can look around freely;
//   · it samples the world along its own boom and lifts over anything in the
//     way, at every orbit angle and every zoom level.
//
//  All of it is frame-rate independent exponential damping (`damp`), never
//  `lerp(a, b, 0.1)` — that would change feel with framerate.
//
//  The boom is fitted against the *whole* world, not the heightfield: terrain,
//  then water, then rock, then the trunks it must not end inside. Every one of
//  those was added after a frame the player was shown. See `BoomClearance.js`.
//
//  ── the free camera (`_free`) ───────────────────────────────────────────────
//
//  Photo mode used to be the auto-orbit below, and that was the wrong tool for
//  it in two ways at once: entering photo mode CUT to a different pose, and
//  then the camera kept sweeping on its own. Neither is something you can
//  compose a photograph with. `_free` is a tripod instead of a boom:
//
//   · `enterFree` reads the pose straight off the live camera — position,
//     orientation (roll included), fov — and reproduces it exactly. The first
//     frame of photo mode is the last frame before it, to float precision.
//   · nothing moves it but the player. No sweep, no easing, no recentring, no
//     damping on the dolly.
//   · left drag orbits, at the chase camera's own sensitivity, so the gesture
//     is the one players already have in their hands.
//   · middle drag translates, in the camera's own right/up plane, at exactly
//     one world unit per screen unit — the point under the cursor stays under
//     the cursor. The DCC-tool pan.
//   · the wheel dollies along the view axis, same multiplicative feel as the
//     chase zoom.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { clamp, clamp01, lerp, smoothstep, damp, dampAngle, wrapAngle } from '../core/MathUtils.js';
import { RockField, TrunkField, TRUNK_KEEP } from './BoomClearance.js';

// Cockpit is built (see `_cockpit`) but not in the player-facing cycle: the
// body panels are single-sided, so from the driver's seat you see straight out
// through the roof and the doors, and the wipers sit in your face. Fixing it
// means double-siding the shell — a triangle cost the whole game pays for one
// optional camera — so it stays behind a flag until someone wants it enough.
// `window.__cockpitCam = true` before boot to get it back.
//
// The C-key cycle. `free` is deliberately NOT in it: it is a mode a UI hands
// the rig and takes back (`enterFree`/`exitFree`), and a player cycling into it
// with C would get a camera with no way of returning to the vehicle.
const MODES = ['chase', 'orbit'];

// Boom length limits. The low end lets you inspect the roof rack; the high end
// is what the reference vista plates are shot at.
export const ZOOM_MIN = 5.5;
export const ZOOM_MAX = 68;
export const ZOOM_DEFAULT = 19;  // deliberately wide: the camper is a figure in
                                 // a landscape, not the subject of a portrait
const PITCH_MIN = -0.20;         // just under the sill, looking up into the trees
const PITCH_MAX = 1.30;          // near-vertical, looking straight down
const RECENTER_DELAY = 2.0;      // seconds of no mouse before easing back

// ── free camera ─────────────────────────────────────────────────────────────
//
// How far up and down a free camera may look. `PITCH_MAX` above is a *chase*
// limit — it exists because the boom must keep the camper in frame — and
// reusing it here would mean a photo camera that cannot point at the treetops
// or at the sky, which is half of what people photograph in this game. Just
// short of the poles, because the look matrix has no up vector at them.
const FREE_PITCH_LIMIT = Math.PI / 2 - 0.03;

// How much air the free camera keeps under it. Flat, and small.
//
// `camClearance` scales 1.6 m -> 4.0 m with boom length, and it is right to:
// a 68 m boom sweeping a hillside needs room or it clips through every ridge
// it passes. A free camera is not swept, it is aimed — the only thing it needs
// is to not be inside the ground. Four metres of forced lift would make a
// grass-level shot impossible, and a grass-level shot is the best photograph
// this game has. 0.45 m is about a hand above the blades.
const FREE_CLEARANCE = 0.45;

/**
 * Where the camera settles when the player is not steering it. Close in you
 * want an over-the-shoulder eye-line; far out you want to be looking *down*
 * into the valley, which is how the wide reference plate is framed.
 */
const PITCH_REST_NEAR = 0.20;
export const restPitch = (zoom) =>
  PITCH_REST_NEAR + 0.35 * Math.pow(clamp01((zoom - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)), 0.7);

/** How much air the camera itself wants under it, in metres. */
export const camClearance = (zoom) => lerp(1.6, 4.0, clamp01((zoom - 12) / (ZOOM_MAX - 12)));

/**
 * How much of the boom the world allows, as a fraction of its full length.
 *
 * March from the camper outwards and stop at the first sample that would be
 * inside something. Pure, and exported, because an audit that re-derives this
 * loop is auditing the audit: `tools/_scratch/camrock.mjs` fits the boom with
 * this exact function and only swaps the `floorAt` it is given.
 *
 * `floorAt(x, z)` is the top of the world at a column — see `CameraRig._floorAt`.
 * `clearAt(anchor, desired, maxT)` is the optional second pass: the standing
 * solids that are too thin to be a floor. It only ever shortens further.
 */
export function boomFree(anchor, desired, zoom, floorAt, clearAt) {
  const dx = desired.x - anchor.x, dy = desired.y - anchor.y, dz = desired.z - anchor.z;
  const run = Math.hypot(dx, dz);
  const steps = clamp(Math.ceil(run / 2.0), 6, 30);
  // Required air under the boom, from "may skim the grass" near the camper to
  // a comfortable gap at the camera end.
  const clr = (t) => lerp(0.35, camClearance(zoom), t);

  let free = 1;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const g = floorAt(anchor.x + dx * t, anchor.z + dz * t);
    if (anchor.y + dy * t < g + clr(t)) { free = (i - 1) / steps; break; }
  }
  // Trunks second, and inwards from whatever the floor left: a bole is 0.7 m
  // across and the 2 m march above would step over most of them.
  if (clearAt) free = Math.min(free, clearAt(anchor, desired, free));
  // Never collapse all the way onto the camper — past this the shot is just
  // the roof rack, and lifting takes over instead.
  return Math.max(free, 0.34);
}

/**
 * Where the chase boom wants to put the camera, before any damping. Pure, and
 * exported for the same reason as `boomFree`: the audit must pose the camera
 * the way the rig poses it, not the way a tool remembers the rig posing it.
 *
 * Writes the boom pivot into `anchor` and the unfitted endpoint into `desired`;
 * returns the two shot-shape numbers `_chase` needs afterwards.
 */
export function chaseDesired(anchor, desired, o) {
  const wide = clamp01((o.zoom - 16) / (ZOOM_MAX - 16));
  // Wound right in, aim at the waistline so the whole camper sits in frame
  // instead of the roof rack; wound out, ride high above the roof so it reads
  // as a figure in a valley.
  const close = clamp01((10 - o.zoom) / 4.5);
  anchor.set(o.x, o.y + lerp(1.05, 0.62, close) + wide * 2.4, o.z);
  // Spherical boom: yaw around the camper, pitch above the horizon.
  const dist = o.zoom * lerp(1.0, 1.10, o.fast);
  const cp = Math.cos(o.pitch), sp = Math.sin(o.pitch);
  desired.set(
    anchor.x - Math.sin(o.yaw) * dist * cp,
    anchor.y + dist * sp,
    anchor.z - Math.cos(o.yaw) * dist * cp,
  );
  return { wide, close };
}

export class CameraRig extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'CameraRig';
    this.active = false;
    this.mode = 'chase';

    this.camPos = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.followYaw = 0;
    this.fov = 52;
    this.roll = 0;

    // free-look state
    this.zoom = ZOOM_DEFAULT;      // smoothed boom length
    this.zoomTarget = ZOOM_DEFAULT; // what the wheel actually sets
    this.orbitYaw = 0;             // offset from the trailing direction
    this.orbitPitch = restPitch(ZOOM_DEFAULT);
    this._idle = 99;               // seconds since the player last touched it

    this.orbitAngle = 0.7;         // the auto-orbit's own slow sweep

    // ── free camera state ────────────────────────────────────────────────
    // A pivot in front of the lens and a spherical arm to it. The eye is
    // derived, never stored: that is what makes the ground clamp below able to
    // lift the camera without the lift ever accumulating into the pose.
    this.freePivot = new THREE.Vector3();
    this.freeYaw = 0;
    this.freePitch = 0;
    this.freeDist = ZOOM_DEFAULT;
    this._freeEye = new THREE.Vector3();
    this._freeDir = new THREE.Vector3();
    this._freeRight = new THREE.Vector3();
    this._freeUp = new THREE.Vector3();
    this._prevMode = 'chase';
    this._up = new THREE.Vector3(0, 1, 0);
    this._t = new THREE.Vector3();
    this._t2 = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._qr = new THREE.Quaternion();
    this._axis = new THREE.Vector3(0, 0, 1);
    this._primed = false;
    this._shake = 0;
    this._takeover = null;   // see takeCamera()

    // ── what the boom is pointed at ───────────────────────────────────────
    //
    // Normally the camper, and for the whole history of this rig that was the
    // only possibility — every anchor in here was `v.position` directly. The
    // camp changes that: the player's own request was "when camp is placed,
    // you need to focus the camera around the fire. Allow the user to click
    // the car to change focus back to the car."
    //
    // `subject` is the point the boom pivots around and the eye rests on. It
    // is DAMPED toward the focus rather than snapped, so switching between the
    // camper and the fire is a slow drift across eight metres — a camera
    // operator walking, not a cut. Everything else the rig reads (heading,
    // speed, the bank, the landing shake) still comes from the camper, which
    // is correct: those describe how the shot moves, not what it is of.
    this.focus = null;               // null = the camper
    this.subject = new THREE.Vector3();
    this._subjPrimed = false;
    this._boomFrac = 1;            // how much of the boom the world allows
    this._teleportSeq = 0;         // last vehicle teleport this rig has seen

    // The two standing-solid fields. Bound once: `boomFree` takes both as
    // callbacks and the floor is on the render path 30+ times a frame.
    this.rockBoom = new RockField();
    this.trunks = new TrunkField();
    this._floor = (x, z) => this._floorAt(x, z);
    this._clear = (a, d, maxT) => this.trunks.retract(a, d, TRUNK_KEEP, maxT);
  }

  async init() {
    this.vehicle = this.ctx.systems.vehicle;

    // Debug surface for tools/drive.mjs --scenario camera.
    window.__cameraState = () => {
      const w = this.ctx.world;
      const p = this.camPos;
      const terrain = Math.max(w.getHeight(p.x, p.z), w.getWaterHeight(p.x, p.z) ?? -1e9);
      const g = this._floorAt(p.x, p.z);
      const inside = this.rockBoom.insideAny(p.x, p.y, p.z, 0);
      return {
        mode: this.mode, zoom: this.zoom, zoomTarget: this.zoomTarget,
        yaw: this.orbitYaw, pitch: this.orbitPitch, fov: this.fov,
        x: p.x, y: p.y, z: p.z, ground: g, clearance: p.y - g,
        // `ground` is the whole world's floor now, so the terrain-only number
        // stays alongside it — a rig that is being held up by rock and one that
        // is being held up by a hill look identical without it.
        terrain, rockLift: g - terrain, boomFrac: this._boomFrac,
        rockCandidates: this.rockBoom.n, trunkCandidates: this.trunks.n,
        insideRock: inside ? `${inside.arch} size ${inside.size.toFixed(1)}` : null,
        inTrunk: this.trunks.hit(p.x, p.y, p.z, TRUNK_KEEP) >= 0,
        // The free camera's own pose, so a harness can assert that photo mode
        // did not move it rather than eyeballing two screenshots.
        freeDist: this.freeDist, freeYaw: this.freeYaw, freePitch: this.freePitch,
        roll: this.roll,
        pivot: { x: this.freePivot.x, y: this.freePivot.y, z: this.freePivot.z },
        limits: { zoomMin: ZOOM_MIN, zoomMax: ZOOM_MAX, pitchMin: PITCH_MIN, pitchMax: PITCH_MAX },
      };
    };
  }

  lateUpdate(dt) {
    const v = this.vehicle ?? this.ctx.systems.vehicle;
    if (!v?.phys?.ready) return;
    this.vehicle = v;

    // C cycles the driving cameras. Not while photo mode holds the rig: that
    // mode is entered and left by the UI that owns it, and cycling out of it
    // from under that UI leaves photo mode on with a chase camera behind it.
    if (this.ctx.input.justPressed('KeyC') && this.mode !== 'free') {
      const modes = window.__cockpitCam ? [...MODES, 'cockpit'] : MODES;
      this.mode = modes[(modes.indexOf(this.mode) + 1) % modes.length];
      if (this.mode === 'cockpit') this._primed = false;
    }
    this.active = true;

    // A system that has been handed the camera outranks EVERYTHING, including
    // `__forceCamera`. See `takeCamera` below.
    //
    // The order of these two checks is load-bearing and was wrong first time.
    // `camp_scope_view.js` raises `__forceCamera` while the player is at an
    // eyepiece — that global is what the HUD, the perf overlay and the camp
    // prompt all read to get out of the frame, and a modal first-person view is
    // exactly the case they should get out of the frame for. With the capture
    // check first, raising it made the rig return before ever reaching the
    // takeover, the eyepiece view stopped being driven, and the camera froze
    // wherever it happened to be.
    if (this._takeover) {
      this._primed = false;
      this._subjPrimed = false;
      this._takeover(dt);
      return;
    }

    // The capture harness poses the camera itself; do not fight it.
    if (window.__forceCamera) { this._primed = false; return; }

    // A rescue moves the camper 20 m in one frame. Damping toward that would
    // fly the camera across the intervening ground, through whatever is in the
    // way, for the best part of a second. Re-prime instead: the boom snaps to
    // its new place behind the camper, which is what a cut is for.
    if (v.teleportSeq !== this._teleportSeq) {
      this._teleportSeq = v.teleportSeq;
      this._primed = false;
      this.lookAt.copy(v.position);
    }

    dt = Math.min(dt, 1 / 20);

    // Drift the subject toward whatever has focus. 2.2 is about a second and a
    // half to cross the gap between a parked camper and its fire, which reads
    // as deliberate without being slow enough to feel like lag.
    const want = this.focus ?? v.position;
    if (!this._subjPrimed || !this._primed) { this.subject.copy(want); this._subjPrimed = true; }
    else {
      this.subject.x = damp(this.subject.x, want.x, 2.2, dt);
      this.subject.y = damp(this.subject.y, want.y, 2.2, dt);
      this.subject.z = damp(this.subject.z, want.z, 2.2, dt);
    }

    // Photo mode's free camera reads its own input and poses itself. It shares
    // this rig's floor — `_floorAt`, and therefore the rock field, primed
    // around its own eye rather than around the camper — and nothing else.
    if (this.mode === 'free') { this._free(dt); return; }

    this._readLook(dt, v);

    // Gather the rock near the SUBJECT once, before anything queries the floor.
    // After `_readLook` because that is where the wheel has just moved `zoom`,
    // and the disc has to cover the boom the player asked for rather than the
    // one it has damped to yet — a fast flick out to 68 m must not fit itself
    // against a 19 m disc for the half-second the dolly takes.
    // A teleport needs nothing extra here: this runs before `_chase` re-primes
    // the boom, so the cut lands against the rock at the new place, not the old.
    //
    // Around the subject, not around `v.position`, because the subject is what
    // the boom pivots on. The two are the same point whenever nothing has
    // focus, which is most of the time — but a camp can hold the camera from
    // tens of metres away (see `Camp._updateFocus`), and a disc centred on the
    // camper then stops short of the boom it is supposed to be fitting. The
    // symptom would be the camera clipping a boulder at the camp while the
    // rock field reported no candidates at all.
    const boom = Math.max(this.zoom, this.zoomTarget) * 1.12;
    this.rockBoom.attach(this.ctx.systems?.rocks).prime(this.subject.x, this.subject.z, boom + 6);
    this.trunks.attach(this.ctx.systems?.trees).prime(this.subject.x, this.subject.z, boom + 4);

    if (this.mode === 'chase') this._chase(dt, v);
    else if (this.mode === 'orbit') this._orbit(dt, v);
    else this._cockpit(dt, v);
  }

  /**
   * Mouse orbit + wheel zoom.  Drag rather than pointer lock: this is a cozy
   * game, and grabbing the cursor for a camera you only nudge occasionally is
   * hostile.  Gamepad right stick feeds in through input.axes.look*.
   */
  _readLook(dt, v) {
    const input = this.ctx.input;
    const m = input.mouse;
    let touched = false;

    // Holding the button counts as touching it even with the mouse still —
    // otherwise the rig would start recentring under the player's own hand.
    if (m.down) {
      touched = true;
      if (m.dx || m.dy) {
        this.orbitYaw = wrapAngle(this.orbitYaw - m.dx * 0.0042);
        // Pull down to look down on the roof, push up to look at the treetops.
        this.orbitPitch = clamp(this.orbitPitch + m.dy * 0.0032, PITCH_MIN, PITCH_MAX);
      }
    }
    const ax = input.axes;
    if (ax.lookX || ax.lookY) {
      this.orbitYaw = wrapAngle(this.orbitYaw - ax.lookX * 1.6 * dt);
      this.orbitPitch = clamp(this.orbitPitch + ax.lookY * 1.1 * dt, PITCH_MIN, PITCH_MAX);
      ax.lookX = 0; ax.lookY = 0;
      touched = true;
    }
    if (m.wheel) {
      // Multiplicative so a notch feels the same close-in and far out. One
      // Chrome notch is ~100 deltaY, i.e. ~17% of the current boom.
      this.zoomTarget = clamp(this.zoomTarget * Math.exp(m.wheel * 0.0016), ZOOM_MIN, ZOOM_MAX);
      touched = true;
    }
    // Damped so a fast flick of the wheel dollies out instead of teleporting.
    this.zoom = damp(this.zoom, this.zoomTarget, 9, dt);

    this._idle = touched ? 0 : this._idle + dt;

    // Ease back behind the camper — but only when it is actually going
    // somewhere. Parked, the player is sightseeing; leave their framing alone.
    // Ramped with speed rather than switched, so rolling gently to a stop does
    // not yank the view around at the last moment.
    const moving = smoothstep(2.2, 7.0, Math.abs(v.speed));
    if (moving > 0.02 && this._idle > RECENTER_DELAY) {
      const k = smoothstep(RECENTER_DELAY, RECENTER_DELAY + 1.2, this._idle) * 1.5 * moving;
      this.orbitYaw = dampAngle(this.orbitYaw, 0, k, dt);
      this.orbitPitch = damp(this.orbitPitch, restPitch(this.zoom), k, dt);
    }
  }

  // ── shared: keep a point clear of the ground ──────────────────────────────
  _clearGround(p, clearance) {
    const floor = this._floorAt(p.x, p.z) + clearance;
    if (p.y < floor) p.y = floor;
    return p;
  }

  /**
   * The top of the world at one column: terrain, or water over it, or rock
   * over that.
   *
   * Every boom sample and both hard floors come through here, so there is
   * exactly one answer to "what is solid at (x, z)" and no way for a caller to
   * be fitted against a subset of it. That is not hypothetical tidiness — the
   * water term was added to three of the four call sites once already, and the
   * rock term (P2) is only needed because a fourth field existed that none of
   * them knew about.
   *
   * A caveat worth carrying: this is only as good as the queries it calls.
   * `getWaterHeight` returns null over a few per cent of deep water (P1, being
   * fixed at the source by the water author), and a null there reads as "no
   * water" and lets the camera under the surface. `?? -1e9` is a defensive
   * clamp, not a correct field, and it is not this file's to fix.
   */
  _floorAt(x, z) {
    const w = this.ctx.world;
    const g = Math.max(w.getHeight(x, z), w.getWaterHeight(x, z) ?? -1e9);
    return this.rockBoom.lift(x, z, g);
  }

  /**
   * Keep the boom out of the hillside — and out of the crag.
   *
   * Two mechanisms, in this order, because they fix different failures:
   *
   *  1. **Shorten.** March along the boom from the camper outwards and stop at
   *     the first point that would be underground. A camera that slides in when
   *     a bank rises behind you keeps the camper framed; one that only rises
   *     ends up looking down at it from a corner of the screen.
   *  2. **Lift.** Whatever length survives, hold it clear of the ground under
   *     it, so a boom that is blocked all the way down still ends up in the air
   *     rather than inside the slope.
   *
   * Both matter far more at full zoom-out, where the boom is 68 m of hillside,
   * so the sample count follows the boom length rather than being fixed.
   *
   * The march itself is `boomFree` above; what stays here is the damping, which
   * is the part that has state and feel in it.
   */
  _boomFit(anchor, desired, dt) {
    const free = boomFree(anchor, desired, this.zoom, this._floor, this._clear);
    // Snap in hard (being inside a hill is a hard failure), ease back out slowly
    // so cresting a rise does not fling the camera backwards.
    this._boomFrac = free < this._boomFrac
      ? damp(this._boomFrac, free, 24, dt)
      : damp(this._boomFrac, free, 1.6, dt);
    return this._boomFrac;
  }

  /** How much air the camera itself wants under it, in metres. */
  _camClearance() {
    return camClearance(this.zoom);
  }

  _groundAt(x, z) {
    return this._floorAt(x, z);
  }

  /**
   * Raise a boom endpoint out of the ground it landed on, and report by how
   * much — the caller uses that to back off the look-ahead, because a camera
   * the terrain has shoved upwards is no longer where the shot was composed.
   */
  _liftEnd(p) {
    const floor = this._groundAt(p.x, p.z) + this._camClearance();
    const lifted = Math.max(0, floor - p.y);
    if (lifted > 0) p.y = floor;
    return lifted;
  }

  _chase(dt, v) {
    const speed = Math.abs(v.speed);
    const fast = smoothstep(2, 21, speed);

    // Follow a damped heading. Reversing keeps the camera behind the *nose*,
    // which is what players expect when backing out of a ditch.
    this.followYaw = dampAngle(this.followYaw, v.heading, lerp(1.9, 3.6, fast), dt);
    // ...but let the tail slide: blend a little of the velocity direction in so
    // a drift shows the flank of the camper rather than its number plate.
    let slideYaw = this.followYaw;
    if (speed > 4) {
      const vy = Math.atan2(v.velocity.x, v.velocity.z);
      const d = wrapAngle(vy - v.heading);
      if (Math.abs(d) < 1.4) slideYaw = this.followYaw + d * 0.35;
    }

    // Where the boom pivots and where the eye rests — shared with the audit,
    // see `chaseDesired`.
    const anchor = this._t, desired = this._t2;
    const { wide, close } = chaseDesired(anchor, desired, {
      x: this.subject.x, y: this.subject.y, z: this.subject.z,
      yaw: slideYaw + this.orbitYaw, zoom: this.zoom, pitch: this.orbitPitch, fast,
    });

    // Pull the boom in past anything solid, then keep what is left in the air.
    const frac = this._boomFit(anchor, desired, dt);
    desired.lerpVectors(anchor, desired, frac);
    const lifted = this._liftEnd(desired);

    if (!this._primed) { this.camPos.copy(desired); this._primed = true; }

    // While the player is dragging, track hard so the camera feels attached to
    // the mouse; otherwise trail softly.
    const grab = this._idle < 0.15 ? 16 : lerp(3.0, 5.0, fast);
    this.camPos.x = damp(this.camPos.x, desired.x, grab, dt);
    this.camPos.z = damp(this.camPos.z, desired.z, grab, dt);
    this.camPos.y = damp(this.camPos.y, desired.y, Math.max(grab, 5.4), dt);

    // Hard safety, undamped: whatever the damping did, the camera does not get
    // to be underground for even one frame.
    this._clearGround(this.camPos, this._camClearance() * 0.7);

    // ── look-ahead: strong close in, almost none when zoomed way out (there,
    //    leading the vehicle just pushes it out of a very wide frame), and
    //    faded out entirely once the player has orbited off the tail — looking
    //    at the camper's flank, "ahead" is sideways and only spoils the shot.
    // A boom that had to be shortened or lifted is looking at the camper from
    // somewhere it did not choose; leading the shot from there throws the
    // subject into a corner, so fade the look-ahead out with the compromise.
    const composed = clamp01(1 - (1 - frac) * 1.6) * clamp01(1 - lifted * 0.25);
    const trail = clamp01(Math.cos(this.orbitYaw)) * composed;
    const lead = lerp(3.0, 9.5, fast) * (1 - wide * 0.85) * (1 - close * 0.8) * trail;
    // NOTE: there was a second term here, a *lateral* offset driven straight
    // off `phys.steerAngle`, which swung the aim point up to 9 m sideways the
    // instant the wheel moved — before the camper had changed heading at all.
    // The player: "when we go left and right, the camera does this panning
    // thing first. I don't like that. just take that bit out." Removed. The
    // camera now only follows where the camper actually goes; the damped
    // `followYaw` still lets the world swing through frame on a turn.
    const target = this._t2.copy(anchor)
      .addScaledVector(v.forward, lead)
      .addScaledVector(this._up, lerp(0.35, -0.15, fast));
    this.lookAt.x = damp(this.lookAt.x, target.x, 6.5, dt);
    this.lookAt.y = damp(this.lookAt.y, target.y, 5.0, dt);
    this.lookAt.z = damp(this.lookAt.z, target.z, 6.5, dt);

    // ── grade: FOV opens with speed, a hint of roll, a shake on hard landings
    this.fov = damp(this.fov, lerp(50, 62, fast) - wide * 9, 3.2, dt);
    const bank = clamp((v.phys.lateral ?? 0) * -0.006, -0.045, 0.045) * (1 - wide);
    this.roll = damp(this.roll, bank, 4.0, dt);

    this._focus(v);

    const landed = v.wheels.filter((wl) => wl.grounded).length >= 3;
    if (v._wasAirborne && landed) this._shake = Math.min(0.4, Math.abs(v.velocity.y) * 0.035);
    v._wasAirborne = v.phys.airborne;
    this._shake = damp(this._shake, 0, 6, dt);

    this._apply();
  }

  // ── the free camera ────────────────────────────────────────────────────────

  /**
   * Take the camera over for photo mode, from exactly where it is.
   *
   * Everything here is read off the LIVE camera rather than off this rig's own
   * `camPos`/`lookAt`/`fov`. They are nearly the same and the difference is
   * exactly the part that matters: `_apply` adds the landing shake to the
   * position and the bank to the orientation on its way out, so `camPos` is
   * where the rig wanted the camera and `ctx.camera` is where the player's last
   * frame actually was. Photo mode has to continue the frame the player saw.
   *
   * The pose is decomposed into pivot / yaw / pitch / roll and rebuilt by
   * `_free`, and the round trip is exact to float precision — the eye is
   * `pivot - dir * dist` with the same `dir` that produced the pivot, and the
   * roll is recovered against the same reference basis `_apply` rolls away
   * from. Measured rather than assumed, on the frame either side of the
   * switch: position identical to the bit, quaternion within 2e-15 per
   * component, fov and the depth-of-field plane identical. Then nine further
   * frames with no input, all four identical again — which is the second half
   * of the contract and the half the old auto-orbit broke worst.
   */
  enterFree() {
    if (this.mode === 'free') return;
    this._prevMode = this.mode;
    const cam = this.ctx.camera;

    // Where the arm points, straight off the camera's own matrix.
    const dir = this._freeDir.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();

    // How long the arm is. The distance to the SUBJECT, not `zoom`: the depth
    // of field plane is `distance(eye, subject)` (see `_focus`) and matching it
    // is what keeps the first photo-mode frame identical in blur as well as in
    // framing. It also puts the pivot at the depth of whatever the player was
    // looking at, which is the thing they will want to orbit around.
    this.freeDist = Math.max(0.5, this.camPos.distanceTo(this.subject));

    this.freePivot.copy(cam.position).addScaledVector(dir, this.freeDist);
    this.freePitch = clamp(Math.asin(clamp(-dir.y, -1, 1)), -FREE_PITCH_LIMIT, FREE_PITCH_LIMIT);
    this.freeYaw = Math.atan2(-dir.x, -dir.z);

    // Recover the roll. `_apply` builds `lookAt(eye, target, +Y)` and then
    // multiplies a rotation about the view axis onto it, so the camera's own
    // right vector is the unrolled right turned through that angle.
    const right = this._freeRight.copy(dir).cross(this._up);
    if (right.lengthSq() < 1e-8) this.roll = 0;      // straight up or down: no reference
    else {
      right.normalize();
      const up = this._freeUp.copy(right).cross(dir);
      const camRight = this._t.set(1, 0, 0).applyQuaternion(cam.quaternion);
      this.roll = Math.atan2(camRight.dot(up), camRight.dot(right));
    }

    this.fov = cam.fov;
    this.camPos.copy(cam.position);
    // The shake is already baked into the pose that was just read; adding it
    // again on top would be a wobble nobody asked for.
    this._shake = 0;
    this._idle = 99;
    this.mode = 'free';
  }

  /**
   * Hand the camera back, as a cut.
   *
   * Not a drift. The player may have flown sixty metres up a hillside to take
   * a photograph, and easing back from there is a long ride through terrain
   * that the boom fit was never meant to compose. `_primed = false` is this
   * rig's existing word for "put the camera where it belongs, now" — the same
   * thing a vehicle teleport does, for the same reason.
   */
  exitFree(mode) {
    if (this.mode !== 'free') return;
    this.mode = mode ?? this._prevMode ?? 'chase';
    this._primed = false;
    this._subjPrimed = false;
  }

  /**
   * The free camera itself. Nothing in here moves without an input.
   *
   * ── what holds it out of the hillside, and what deliberately does not ──────
   *
   * The rig has two mechanisms for that (see `_boomFit`): SHORTEN the boom past
   * anything solid, and LIFT whatever is left clear of the ground. This uses
   * the lift — `_floorAt`, the whole world's floor, terrain over water over
   * rock, the same query every other camera in this file is fitted against —
   * and deliberately does not use the shorten.
   *
   * Shortening exists to keep a SUBJECT in frame: when a bank rises behind the
   * camper the boom slides in so the camper does not end up in a corner. A free
   * camera has no subject to protect, and sliding it along its own view axis
   * because of geometry the player can see and has already composed around is
   * precisely the "collision yanks the camera" failure. So the shot is never
   * pulled in; it is only ever pushed up, and only when it would otherwise be
   * underground.
   *
   * The lift carries the PIVOT with it. The first version of this clamped only
   * the derived eye and left the pose untouched, which had one lovely property
   * — pan into a hill and back out and you return to the exact metre you left
   * — and one disqualifying one: everything you panned while the eye was
   * pinned went into the pivot as hidden depth, so 300 px of overshoot bought
   * 310 px of dead travel on the way back up, and 3600 px put the pivot 71.6 m
   * underground. A control that does nothing for the first third of the
   * gesture is broken however clean its state is. So the frame that lifts the
   * eye lifts the pivot with it, and the two can never disagree.
   *
   * What survives is the property that mattered: a gesture that never meets
   * the floor is exactly reversible, because nothing is written on a frame
   * with no lift. Against the floor the camera trades the buried travel for
   * an immediate response, which is the trade every DCC tool makes.
   *
   * The clamp translates rather than rotates: the look point is carried up with
   * the eye, so being lifted slides the frame instead of tilting it.
   */
  _free(dt) {
    const input = this.ctx.input;
    const m = input.mouse;
    let touched = false;

    // Basis, from the pose the player is holding.
    const cp = Math.cos(this.freePitch), sp = Math.sin(this.freePitch);
    const dir = this._freeDir.set(-Math.sin(this.freeYaw) * cp, -sp, -Math.cos(this.freeYaw) * cp);
    const right = this._freeRight.copy(dir).cross(this._up);
    if (right.lengthSq() < 1e-8) right.set(Math.cos(this.freeYaw), 0, -Math.sin(this.freeYaw));
    right.normalize();
    const up = this._freeUp.copy(right).cross(dir).normalize();

    if (m.mid) {
      // ── middle drag: translate, the DCC pan ─────────────────────────────
      // One world unit per screen unit at the pivot's depth, so the point under
      // the cursor stays under the cursor. Anything else (a fixed metres-per-
      // pixel, or a constant scaled by distance alone) drifts away from the
      // cursor as the fov or the viewport changes, and the gesture stops
      // feeling like grabbing the world.
      touched = true;
      if (m.dx || m.dy) {
        const h = this.ctx.renderer?.domElement?.clientHeight || window.innerHeight || 900;
        const mpp = 2 * this.freeDist * Math.tan((this.fov * Math.PI / 180) * 0.5) / h;
        this.freePivot.addScaledVector(right, -m.dx * mpp).addScaledVector(up, m.dy * mpp);
      }
    } else if (m.down) {
      // ── left drag: orbit, at the chase camera's own sensitivity ──────────
      // The same 0.0042 / 0.0032 and the same signs `_readLook` uses, so the
      // gesture the player has spent hours with does not change under them
      // when they press F.
      touched = true;
      if (m.dx || m.dy) {
        this.freeYaw = wrapAngle(this.freeYaw - m.dx * 0.0042);
        this.freePitch = clamp(this.freePitch + m.dy * 0.0032, -FREE_PITCH_LIMIT, FREE_PITCH_LIMIT);
      }
    }

    const ax = input.axes;
    if (ax.lookX || ax.lookY) {
      this.freeYaw = wrapAngle(this.freeYaw - ax.lookX * 1.6 * dt);
      this.freePitch = clamp(this.freePitch + ax.lookY * 1.1 * dt, -FREE_PITCH_LIMIT, FREE_PITCH_LIMIT);
      ax.lookX = 0; ax.lookY = 0;
      touched = true;
    }

    if (m.wheel) {
      // Undamped, unlike the chase dolly. A damped dolly keeps travelling for
      // half a second after the notch, and "the camera does not move unless
      // the player moves it" is the whole contract of this mode.
      //
      // The limits are the chase boom's, with one concession: photo mode can
      // be entered from further out than ZOOM_MAX (the chase eye sits a little
      // beyond its own boom once the ground has lifted it), and clamping to 68
      // on the first notch would be a snap on the one input that is supposed to
      // be a nudge. So the range only ever tightens toward the real limits.
      const lo = Math.min(ZOOM_MIN, this.freeDist), hi = Math.max(ZOOM_MAX, this.freeDist);
      this.freeDist = clamp(this.freeDist * Math.exp(m.wheel * 0.0016), lo, hi);
      touched = true;
    }

    this._idle = touched ? 0 : this._idle + dt;

    // Level the horizon, but only under the player's hand. The pose is entered
    // with whatever bank the chase camera had, because the first frame has to
    // be the last frame; a permanent two-degree tilt that nothing can remove
    // would be a defect. Composing is the moment to take it out, and it costs
    // nothing when there was no bank to begin with — which, parked, there never
    // is.
    if (touched && this.roll) this.roll = damp(this.roll, 0, 4, dt);

    // Recompute the basis if the drag moved it, then place the eye.
    if (touched) {
      const cp2 = Math.cos(this.freePitch), sp2 = Math.sin(this.freePitch);
      dir.set(-Math.sin(this.freeYaw) * cp2, -sp2, -Math.cos(this.freeYaw) * cp2);
    }
    const eye = this._freeEye.copy(this.freePivot).addScaledVector(dir, -this.freeDist);

    // The floor. Primed around the eye's own column rather than the camper's —
    // this camera can be anywhere — and a small disc, because unlike the boom
    // there is exactly one point to test.
    this.rockBoom.attach(this.ctx.systems?.rocks).prime(eye.x, eye.z, 12);
    const floor = this._floorAt(eye.x, eye.z) + FREE_CLEARANCE;
    if (eye.y < floor) { this.freePivot.y += floor - eye.y; eye.y = floor; }

    this.camPos.copy(eye);
    this.lookAt.copy(eye).addScaledVector(dir, this.freeDist);

    // Depth of field on the pivot: it is the thing the player is composing
    // around, and at entry it is at the exact distance the chase camera's
    // subject was, so the blur does not change on the frame photo mode opens.
    this.ctx.postfx?.setFocus?.(this.freeDist * 1.15 + 4);
    this._apply();
  }

  /** The auto-orbit: a slow sweep at whatever distance the player has dialled in. */
  _orbit(dt, v) {
    this.orbitAngle += dt * 0.11;
    const r = clamp(this.zoom, 6, ZOOM_MAX);
    const cp = Math.cos(this.orbitPitch), sp = Math.sin(this.orbitPitch);
    const anchor = this._t.copy(this.subject).addScaledVector(this._up, 1.0 + r * 0.05);
    const a = this.orbitAngle + this.orbitYaw;
    const desired = this._t2.set(
      anchor.x + Math.sin(a) * r * cp,
      anchor.y + r * sp,
      anchor.z + Math.cos(a) * r * cp,
    );
    desired.lerpVectors(anchor, desired, this._boomFit(anchor, desired, dt));
    this._liftEnd(desired);
    if (!this._primed) { this.camPos.copy(desired); this._primed = true; }
    const k = this._idle < 0.15 ? 16 : 4.0;
    this.camPos.x = damp(this.camPos.x, desired.x, k, dt);
    this.camPos.y = damp(this.camPos.y, desired.y, k, dt);
    this.camPos.z = damp(this.camPos.z, desired.z, k, dt);
    this._clearGround(this.camPos, this._camClearance() * 0.7);
    this.lookAt.lerp(anchor, 1 - Math.exp(-6 * dt));
    this.fov = damp(this.fov, 46, 3, dt);
    this.roll = damp(this.roll, 0, 4, dt);
    this._focus(v);
    this._apply();
  }

  _cockpit(dt, v) {
    // Driver's eye, right-hand drive to match the modelled steering wheel.
    this._t.set(0.42, 0.86, 0.34).applyQuaternion(v.quaternion).add(v.position);
    if (!this._primed) { this.camPos.copy(this._t); this._primed = true; }
    this.camPos.copy(this._t);
    this.camPos.y += Math.sin(performance.now() * 0.004) * 0.006 * clamp01(Math.abs(v.speed) / 8);

    // Mouse look works here too — glance out of the side window at the view.
    const cy = Math.cos(this.orbitYaw), sy = Math.sin(this.orbitYaw);
    const fx = v.forward.x * cy - v.right.x * sy;
    const fz = v.forward.z * cy - v.right.z * sy;
    const look = this._t2.set(
      this.camPos.x + fx * 22,
      this.camPos.y + 22 * Math.tan(clamp(this.orbitPitch - PITCH_REST_NEAR, -0.5, 0.5)) - 1.0,
      this.camPos.z + fz * 22,
    );
    // No steer-driven lateral lead here either — same reason as `_chase`.
    // Cockpit is behind `window.__cockpitCam`, but if it is ever turned on it
    // should not reintroduce the pan the player rejected.
    this.lookAt.x = damp(this.lookAt.x, look.x, 9, dt);
    this.lookAt.y = damp(this.lookAt.y, look.y, 9, dt);
    this.lookAt.z = damp(this.lookAt.z, look.z, 9, dt);
    this.fov = damp(this.fov, 66, 4, dt);
    this.roll = damp(this.roll, 0, 5, dt);
    this._focus(v);
    this._apply();
  }

  /**
   * Depth of field focuses on the camper, not on a fixed distance. Nothing else
   * owns this: PostFX ships a default focus plane that was right for one boom
   * length, so at 6 m the subject was a blur and at 60 m so was the foreground.
   * Pushed a little past the camper so the ground it stands on stays sharp.
   */
  _focus(v) {
    const fx = this.ctx.postfx;
    if (!fx?.setFocus) return;
    // The focus plane follows the SUBJECT, not the camper — otherwise looking
    // at a fire eight metres from the camper puts the fire out of focus and
    // sharpens an empty patch of meadow behind it.
    const d = this.camPos.distanceTo(this.subject);
    fx.setFocus(d * 1.15 + 4);
  }

  _apply() {
    const cam = this.ctx.camera;
    cam.position.copy(this.camPos);
    if (this._shake > 0.001) {
      const t = performance.now() * 0.001;
      cam.position.y += Math.sin(t * 58) * this._shake * 0.1;
      cam.position.x += Math.sin(t * 47 + 1.3) * this._shake * 0.06;
    }
    this._m.lookAt(cam.position, this.lookAt, this._up);
    this._q.setFromRotationMatrix(this._m);
    if (this.roll) {
      this._qr.setFromAxisAngle(this._axis, this.roll);
      this._q.multiply(this._qr);
    }
    cam.quaternion.copy(this._q);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * Point the boom at something other than the camper.
   *
   * @param target THREE.Vector3 to look at, or null for the camper.
   *
   * Deliberately does not take a duration or an easing: the drift is a
   * property of the rig, not of the caller, and a caller that could ask for a
   * cut would eventually ask for one in the middle of a drive.
   */
  /**
   * Hand the camera to another system entirely.
   *
   * `setFocus` is enough for anything that wants the boom pointed somewhere
   * else, and it is the right tool for almost everything — it keeps the rig's
   * collision, its dolly and its idle recentring. This is for the case
   * `setFocus` cannot express: a system that wants to BE the camera for a
   * while, on its own path, with its own field of view. `camp_scope_view.js`
   * looking through the camp's telescope is the only caller.
   *
   * Why a hook here rather than the caller writing `camera.position` in its own
   * update: this rig's `lateUpdate` runs after every system update and writes
   * the camera outright, so a pose set anywhere else is simply overwritten on
   * the same frame. That is by design and worth keeping — a camera with two
   * authors is how a rig ends up with an unexplained jitter nobody can bisect.
   * So there is exactly one way to take it, it is explicit, and it is
   * reversible: pass `null` and the rig picks the shot back up, cut rather than
   * damped, which is correct because the thing that took it has by then put the
   * camera wherever it wants to hand it back from.
   *
   * @param fn  fn(dt) called once per frame in place of the rig, or null.
   */
  takeCamera(fn) { this._takeover = fn ?? null; }

  setFocus(target) {
    if (target && this.focus && this.focus.distanceToSquared(target) < 1e-6) return;
    this.focus = target ? (this.focus ? this.focus.copy(target) : target.clone()) : null;
  }

  dispose() { this.active = false; }
}
