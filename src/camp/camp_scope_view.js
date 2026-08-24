// ─────────────────────────────────────────────────────────────────────────────
//  camp_scope_view — looking through the camp's telescope.
//
//  Click the telescope and the camera leans in to its eyepiece; drag to sweep
//  the sky; Escape to step back. That is the whole feature, and everything in
//  this file is one of four problems it turns out to have.
//
//  ── 1. Where the eye goes ────────────────────────────────────────────────
//
//  At the eyepiece, exactly. Not "near the telescope", and not at a bounding
//  box centre — `camp_telescope.js` publishes `userData.telescope.eye` and
//  `.aim` in the prop's own space precisely so this file never has to guess.
//  Guessing is wrong by 100 mm of position and 15 degrees of bearing, and at a
//  12-degree field of view 15 degrees is a different piece of sky.
//
//  ── 2. Nobody wants to look at the inside of the tube ───────────────────
//
//  A camera parked at the eyepiece and pointed along the optical axis has
//  700 mm of the player's own telescope directly in front of it. The honest fix
//  is to hide the prop while the player is inside it — they are standing where
//  it is, they cannot see it from there, and it means panning off the sky and
//  down at the fire still works instead of swinging a white tube across frame.
//  It is hidden under the mask (see 4) so the change is never seen happening.
//
//  ── 3. The rig has to let go ────────────────────────────────────────────
//
//  `CameraRig.lateUpdate` runs after every system update and writes the camera
//  outright, so a system that poses the camera in its own `update` is simply
//  overwritten. `CameraRig.takeCamera()` is the hook — the same escape hatch
//  the capture harness gets through `window.__forceCamera`, but callable and
//  reversible. This is the only caller.
//
//  ── 4. It has to READ as an eyepiece ────────────────────────────────────
//
//  A narrowed field of view alone reads as a zoom, and a zoom reads as a bug.
//  What makes it read as an eyepiece is the field stop: the hard-edged circle
//  of black that a real eyepiece puts around the image, with everything outside
//  it gone. That circle is worth more than any amount of care spent on the
//  camera path — it is the single element that turns "the camera moved" into
//  "I am looking through this thing". It is drawn in the DOM rather than in
//  post, because it is UI: it must not be in a `tools/shot.mjs` capture, it
//  must not be graded by the tonemapper, and its edge must stay hard at any
//  resolution scale.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, smoothstep } from '../core/MathUtils.js';
import { touchCapable } from '../core/verbs.js';

// How long the lean-in and the step-back take. Long enough to read as a move
// and not a cut; short enough that a player who clicked by accident is not
// waiting on an animation. Out is faster than in — arriving somewhere should
// feel deliberate, leaving it should feel immediate.
const IN_TIME = 0.55;
const OUT_TIME = 0.34;

// Field of view, in degrees, at the two ends of the wheel.
//
// 18 at rest — just under 3x against the game's 52-degree default. The first
// version rested at 14 and bottomed out at 4.5, and the capture of a real night
// sweep is what argued it back: this sky's star field is art-directed to about
// 585 visible points over the whole dome, so a 4.5-degree window holds five or
// six of them and the payoff for walking over and clicking a telescope is an
// almost empty circle. Widening the window is the only lever this file has over
// that — the density belongs to `src/sky/starfield.js` — and 18 degrees still
// reads unmistakably as an eyepiece while holding four times the sky.
//
// The bottom of the range is kept for the moon, which IS worth 6 degrees.
const FOV_REST = 18;
const FOV_MIN = 6.0;
const FOV_MAX = 34;

// How high the view may be swung. Down to a couple of degrees below the
// horizon, so the treeline and the camp's own fire are still reachable — the
// pan down to the fire is the shot that makes this feature feel like it is part
// of the world rather than a sky viewer bolted onto it. Up to just short of the
// zenith, because a mount that can point straight up hits its own tripod.
const PITCH_MIN = -0.10;
const PITCH_MAX = 1.40;

/**
 * The eyepiece mask: the field stop, and the prompt under it.
 *
 * One element, one radial gradient, and the numbers in it are the whole look.
 *
 * The stop is at 45vmin — a circle 91% of the frame's shorter dimension, which
 * on a 16:9 monitor leaves only the four corners black. It was 31vmin, a little
 * under two thirds of the frame height, and that was too timid: the whole point
 * of this view is to be somewhere the player has gone TO, and a small disc
 * floating in a large black field reads as a picture of an eyepiece rather than
 * as being at one. Bigger is also more usable, because the sky the player is
 * sweeping is the part inside the circle.
 *
 * There is no black band under it at this size, so the prompt below sits over
 * the image rather than beside it. That is fine — it carries its own panel —
 * and it is worth the trade.
 *
 * The soft inner ring inside the hard edge is not decoration either. A pure
 * hard-edged hole reads as a cut-out mask; a millimetre of falloff just inside
 * it reads as an optic, because that is what field curvature does at the edge
 * of a cheap eyepiece.
 */
class Eyepiece {
  constructor() {
    const el = document.createElement('div');
    el.className = 'pa-scope-mask';
    el.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none', 'z-index:38',
      'opacity:0', 'transition:opacity .18s ease',
      // Hard stop, then a whisper of falloff inside it, then black.
      //
      // The first version spread those four stops over 5 vmin and the capture
      // came back with a soft round vignette rather than a field stop — it read
      // as a blurred mask laid over the frame, which is the thing a field stop
      // is supposed to stop it reading as. A real eyepiece's edge is SHARP:
      // 1.2 vmin from full image to full black, with the falloff all on the
      // inside where field curvature actually puts it.
      'background:radial-gradient(circle at 50% 50%,' +
        'rgba(0,0,0,0) 0 45.4vmin,' +
        'rgba(3,4,8,0.30) 46.8vmin,' +
        'rgba(3,4,8,0.97) 47.6vmin,' +
        'rgba(1,2,4,1) 48.2vmin 200vmin)',
    ].join(';');
    document.body.appendChild(el);

    // The view's own prompt, inside its own overlay.
    //
    // It cannot use `CampPrompt`: this view raises `window.__forceCamera` so
    // the HUD leaves the frame, and `CampPrompt` hides itself under that global
    // along with everything else. Which is correct for the HUD and fatal for
    // this one line — the whole reason it exists is to say how to get out, and
    // a modal view with no way out advertised is a trap.
    const tip = document.createElement('div');
    tip.className = 'pa-scope-tip';
    tip.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:8.5%', 'transform:translateX(-50%)',
      'pointer-events:none', 'opacity:0', 'transition:opacity .2s ease',
      'font:500 13px/1.35 system-ui,-apple-system,sans-serif', 'letter-spacing:.02em',
      'padding:7px 13px', 'border-radius:8px', 'white-space:nowrap', 'z-index:39',
      'color:#e8ecf4', 'background:rgba(10,12,18,.5)',
      'backdrop-filter:blur(7px)', '-webkit-backdrop-filter:blur(7px)',
      'border:1px solid rgba(232,236,244,.14)',
    ].join(';');
    // Two devices, two honest sentences. The keyboard one is unchanged. The
    // touch one drops the scroll — there is no wheel and this view has no pinch
    // yet, so offering magnification would be a lie — and, far more important,
    // it makes the tip ITSELF the way out. Esc and Q are the only exits this
    // view has ever had, which on a phone turns the telescope into a room with
    // no door: you would enter it by tapping an eyepiece and never leave.
    const touch = touchCapable();
    tip.innerHTML = touch
      ? 'drag to sweep the sky&nbsp; ·&nbsp; <b>tap here</b> to step back'
      : 'drag to sweep the sky&nbsp; ·&nbsp; scroll to magnify' +
        '&nbsp; ·&nbsp; <b>Esc</b> step back';
    if (touch) {
      tip.style.pointerEvents = 'auto';
      tip.style.cursor = 'pointer';
      tip.addEventListener('click', (e) => { e.stopPropagation(); this.leave(); });
    }
    document.body.appendChild(tip);
    this.tip = tip;

    // A second, additive pass: the faint bloom a bright field throws onto the
    // inside of the barrel. Two elements rather than one gradient because the
    // stop has to stay hard while this one is soft, and a single gradient
    // cannot do both.
    const glow = document.createElement('div');
    glow.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none', 'z-index:37',
      'opacity:0', 'transition:opacity .18s ease', 'mix-blend-mode:screen',
      'background:radial-gradient(circle at 50% 50%,' +
        'rgba(0,0,0,0) 0 41vmin, rgba(150,170,205,0.10) 45vmin, rgba(0,0,0,0) 52vmin)',
    ].join(';');
    document.body.appendChild(glow);

    this.el = el;
    this.glow = glow;
    this._o = -1;
  }

  set(o) {
    const v = clamp01(o);
    if (Math.abs(v - this._o) < 0.004) return;
    this._o = v;
    // NOT gated on `__forceCamera` — this view raises that global itself, so
    // gating on it would hide the eyepiece the moment it opened. A real capture
    // of this view is what `tools/_scratch/scopeview.mjs` is for, and it wants
    // the mask in the frame.
    this.el.style.opacity = String(v);
    this.glow.style.opacity = String(v);
    // The tip comes in behind the stop, once there is something to look at.
    this.tip.style.opacity = String(clamp01((v - 0.55) / 0.45));
  }

  dispose() { this.el.remove(); this.glow.remove(); this.tip.remove(); }
}

/**
 * The view itself.
 *
 * Owns no scene objects and no materials — it borrows the camera for as long as
 * it is active and gives it back untouched. `active` is the only thing the rest
 * of the camp reads.
 */
export class ScopeView {
  constructor(ctx) {
    this.ctx = ctx;
    this.mask = new Eyepiece();
    this.prop = null;            // the telescope group, while inside one
    this.t = 0;                  // 0 = out, 1 = fully at the eyepiece
    this.closing = false;
    this.yaw = 0;                // absolute, world
    this.pitch = 0;
    this.fov = FOV_REST;
    this.fovTarget = FOV_REST;
    this._held = false;
    this._from = { p: new THREE.Vector3(), q: new THREE.Quaternion(), fov: 52 };
    this._eye = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._took = false;
    this._hadForce = false;
  }

  get active() { return !!this.prop; }

  /**
   * The telescope currently being looked through, or null.
   *
   * `Camp.js` needs this to answer one question: when a camp is struck, was the
   * open eyepiece one of ITS props? With several camps in the world that is not
   * the same question as "is a telescope open", and getting it wrong either
   * leaves the player inside geometry that has been packed away or throws them
   * out of a telescope in a camp nobody touched.
   *
   * Named `subject` rather than `prop` because that is the name the integration
   * reads, and a public contract is worth an alias.
   */
  get subject() { return this.prop; }

  /**
   * Step up to a telescope.
   *
   * The pose the camera is at RIGHT NOW is remembered, and the step-back
   * returns to it exactly. That is what makes leaving feel like leaving rather
   * than like a cut: the camper has not moved (the player is parked, or this
   * prompt would not have been offered), so the shot they came from is still
   * the correct shot to go back to.
   */
  enter(prop) {
    if (this.prop === prop) return;
    const cam = this.ctx.camera;
    const d = prop.userData?.telescope;
    if (!d?.eye || !d?.aim) return;

    this.prop = prop;
    this.closing = false;
    this._from.p.copy(cam.position);
    this._from.q.copy(cam.quaternion);
    this._from.fov = cam.fov;

    // Eye and aim, carried out of the prop's own space. `updateMatrixWorld`
    // first: a telescope built this frame has not been through a render yet and
    // its world matrix is still identity, which would put the eyepiece at the
    // world origin — 800 m away, pointing at nothing.
    prop.updateMatrixWorld(true);
    this._eye.copy(d.eye).applyMatrix4(prop.matrixWorld);
    this._aim.copy(d.aim).applyQuaternion(prop.getWorldQuaternion(this._q)).normalize();

    // Start looking exactly where the tube is pointed. The player aims it by
    // sweeping from there; the tube's own angle is the opening shot and it is
    // the reason the model's altitude is jittered per camp.
    this.yaw = Math.atan2(-this._aim.x, -this._aim.z);
    this.pitch = clamp(Math.asin(clamp(this._aim.y, -1, 1)), PITCH_MIN, PITCH_MAX);
    this.fov = this.fovTarget = FOV_REST;
    this.t = 0;

    // Get the HUD out of the frame.
    //
    // A speedometer, a compass, a minimap and a keybind bar around a circular
    // eyepiece is the loudest possible statement that this is a camera trick,
    // and the first capture of this view showed exactly that. `__forceCamera`
    // is the global every one of those elements already reads — it is what the
    // capture harness raises for the same reason — so this raises it too and
    // puts it back on the way out. `CameraRig` checks its takeover BEFORE this
    // global for that reason; see the note there.
    this._hadForce = window.__forceCamera;
    window.__forceCamera = true;

    const rig = this.ctx.systems?.cameraRig;
    if (rig?.takeCamera) { rig.takeCamera((dt) => this._drive(dt)); this._took = true; }
  }

  /** Begin the step back. The camera is released when the ease-out finishes. */
  leave() {
    if (!this.prop || this.closing) return;
    this.closing = true;
  }

  /** Let go of the camera and the prop, immediately and without an ease. */
  _release() {
    const rig = this.ctx.systems?.cameraRig;
    if (this._took && rig?.takeCamera) rig.takeCamera(null);
    this._took = false;
    window.__forceCamera = this._hadForce;
    if (this.prop) this.prop.visible = true;
    this.prop = null;
    this.closing = false;
    this.t = 0;
    this.mask.set(0);
  }

  /**
   * Read the player's input. Called from `Camp.update`, which is where the
   * input is read for everything else in this system.
   *
   * Drag to look, rather than pointer lock. The rest of this game turns its
   * camera by dragging and a modal view that suddenly captures the cursor is
   * the kind of inconsistency that reads as a different game — the same
   * argument `CameraRig._readLook` already makes. Arrow keys do the same job
   * for anyone who would rather not drag.
   */
  update(dt) {
    if (!this.prop) return;
    const { input } = this.ctx;

    if (input.justPressed('Escape') || input.justPressed('KeyQ')) this.leave();
    // The eyepiece is entered with a tap, so the first thing a touch player
    // does inside it is tap again — which used to do nothing at all. A tap on
    // the sky steps back out, and `t > 0.4` is the same settling guard the drag
    // uses, so the tap that ENTERED the view cannot immediately leave it.
    if (touchCapable() && this.t > 0.4 && input.press.tap) { this.leave(); return; }

    // Sensitivity scales with the field of view. At 4.5 degrees a drag that
    // felt right at 26 throws the sky past in a blink — what the hand means is
    // "move it a third of a screen", not "move it 20 degrees".
    const k = 0.0021 * (this.fov / FOV_REST);
    if (input.mouse.down && this.t > 0.4) {
      this.yaw -= input.mouse.dx * k;
      this.pitch = clamp(this.pitch - input.mouse.dy * k, PITCH_MIN, PITCH_MAX);
    }
    // The finger drag, read straight off the press rather than through
    // `mouse.dx/dy`. Those are the look drag, and on touch they are deliberately
    // left alone: CameraRig orbits the chase camera with them, so a finger in
    // them turned every steering input into a camera swing (see the note in
    // core/Input.js). Nothing else in the game wants a raw finger delta, so the
    // eyepiece keeps its own — one subtraction against last frame's position.
    const pr = input.press;
    if (pr.down && this.t > 0.4) {
      if (this._dragging) {
        this.yaw -= (pr.px - this._lastPx) * k;
        this.pitch = clamp(this.pitch - (pr.py - this._lastPy) * k, PITCH_MIN, PITCH_MAX);
      }
      this._dragging = true;
      this._lastPx = pr.px; this._lastPy = pr.py;
    } else {
      this._dragging = false;
    }
    const kk = dt * 0.62 * (this.fov / FOV_REST);
    if (input.key('ArrowLeft')) this.yaw += kk;
    if (input.key('ArrowRight')) this.yaw -= kk;
    if (input.key('ArrowUp')) this.pitch = clamp(this.pitch + kk, PITCH_MIN, PITCH_MAX);
    if (input.key('ArrowDown')) this.pitch = clamp(this.pitch - kk, PITCH_MIN, PITCH_MAX);

    if (input.mouse.wheel) {
      this.fovTarget = clamp(this.fovTarget * (1 + input.mouse.wheel * 0.0016), FOV_MIN, FOV_MAX);
    }
    this.fov = damp(this.fov, this.fovTarget, 9, dt);
  }

  /**
   * Pose the camera. Runs inside `CameraRig.lateUpdate`, after every system has
   * had its say, which is the only place a camera pose survives the frame.
   */
  _drive(dt) {
    const cam = this.ctx.camera;
    const step = Math.min(dt, 1 / 20);
    this.t = this.closing
      ? this.t - step / OUT_TIME
      : Math.min(1, this.t + step / IN_TIME);
    if (this.closing && this.t <= 0) {
      cam.position.copy(this._from.p);
      cam.quaternion.copy(this._from.q);
      cam.fov = this._from.fov;
      cam.updateProjectionMatrix();
      this._release();
      return;
    }

    // Ease both ways, and ease the ARRIVAL harder than the departure: a move
    // that decelerates into its target reads as somebody leaning in and
    // stopping, where a linear one reads as a camera on rails.
    const e = smoothstep(0, 1, clamp01(this.t));
    const soft = e * e * (3 - 2 * e);

    this._e.set(this.pitch, this.yaw, 0);
    this._q.setFromEuler(this._e);

    cam.position.lerpVectors(this._from.p, this._eye, soft);
    cam.quaternion.copy(this._from.q).slerp(this._q, soft);
    const fov = lerp(this._from.fov, this.fov, soft);
    if (Math.abs(cam.fov - fov) > 0.005) { cam.fov = fov; cam.updateProjectionMatrix(); }

    // The prop goes away once the mask has most of the frame — see note 2. The
    // thresholds are ordered so the mask is already at 0.6 opacity when the
    // telescope vanishes, which is what makes the swap unseeable.
    this.mask.set(smoothstep(0.30, 0.86, this.t));
    this.prop.visible = this.t < 0.62;
  }

  dispose() {
    this._release();
    this.mask.dispose();
  }
}
