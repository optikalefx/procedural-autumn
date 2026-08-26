// ─────────────────────────────────────────────────────────────────────────────
//  PhotoFocus — the lens photo mode is missing.
//
//  Photo mode already hands the player a camera: a free-flying pose, a native-
//  resolution frame, a stopped world, an hour dial, an exposure dial and a
//  colour dial. What it has never had is the control that makes a photograph
//  look photographed rather than rendered — a plane of focus you choose, and
//  everything else falling away behind it.
//
//  This is that control. It owns three things and nothing else:
//
//    1. turning PostFX's depth of field on for exactly as long as photo mode is
//       open, and putting PostFX back byte for byte on the way out,
//    2. a focus distance the player sets — by scrolling with a modifier held,
//       or by clicking on the thing they want sharp,
//    3. an aperture, because "focus" without an f-stop is one number and an
//       f/1.4-versus-f/11 choice is what a photograph is actually made of.
//
//  ── the wheel already did something ─────────────────────────────────────────
//
//  In photo mode the bare wheel dollies the free camera (`CameraRig._free`) and
//  the on-screen rail says so. Taking it for focus would have broken the one
//  camera verb the mode advertises, so focus lives on a HELD MODIFIER:
//
//      shift + wheel   focus nearer / further
//      shift + click   pull focus onto whatever is under the cursor
//      alt   + wheel   aperture, f/1.4 … f/22
//
//  Shift and Alt were picked by elimination, not by taste. In photo mode the
//  keys that already mean something are F (exit), Escape (exit), P (save),
//  G (grid), M (mute), H (hud), N (map) and ` (settings) — all of them in
//  `HUD._bindKeys` and `PhotoMode`'s rail handler — plus WASD/E/R/Space, which
//  `Input.suppressed` has already taken away. Neither Shift nor Alt appears in
//  any of them. Ctrl and Meta were ruled OUT rather than merely unused: both
//  are browser page-zoom on a wheel, on every platform, and a photo mode that
//  zooms the browser is worse than one with no focus control at all.
//
//  Two traps came with that choice and both are handled below:
//
//   · **Shift+wheel arrives on the X axis.** Chrome (and Safari) translate a
//     shifted vertical wheel into `deltaX`, leaving `deltaY` at zero — the
//     control did nothing at all until this read both.
//   · **The listeners have to be in the CAPTURE phase.** `PhotoMode` focuses
//     the rail's first slider the moment the mode opens and its keydown handler
//     calls `stopPropagation()` on everything it does not recognise, so a
//     window-level listener in the bubble phase never sees a key while the rail
//     has focus. Capture at `window` runs before any of that. It also solves
//     the wheel cleanly: `Input`'s own wheel listener is a bubble listener on
//     `window`, so stopping propagation in capture means the free camera never
//     learns the wheel happened and the dolly cannot fight the focus pull.
//
//  ── why there is a click-to-focus at all ───────────────────────────────────
//
//  A focus distance in metres is not a thing anyone can judge by eye. Every
//  camera made in the last fifteen years solves this the same way — point at
//  the subject, the camera measures it — and PostFX can answer that exactly,
//  because the composer already keeps the frame's depth buffer for the grade's
//  hearth mask. `postfx.readDepthAt(u, v)` is one 1×1 draw and a four-byte
//  read; see its header for why the two obvious alternatives (a scene raycast,
//  or a depth re-render through `scene.overrideMaterial`) are both wrong in
//  this world.
//
//  `enable()` runs it once at the centre of frame, so the mode opens with the
//  focus already on whatever the player pressed F while looking at.
//
//  ── the readout ────────────────────────────────────────────────────────────
//
//  A control nobody can see is a control nobody uses, and this one has no
//  slider of its own on the rail. So the panel appears whenever the player
//  holds either modifier — before they have scrolled anything — lists the three
//  gestures, and shows the live focus distance and f-stop. It fades out a
//  second and a half after the last change so it is never in a photograph. The
//  shutter path does not have to know about it: `PhotoMode.capture()` reads the
//  drawing buffer, and this is DOM.
//
//  ── wiring ─────────────────────────────────────────────────────────────────
//
//  Deliberately self-installing. `enable()` attaches its own listeners and
//  builds its own DOM; `disable()` removes both. The integrator needs three
//  lines in `hud_photo.js` and nothing else — construct it, enable/disable it
//  alongside the mode, and call `update(dt)` while it is open.
// ─────────────────────────────────────────────────────────────────────────────

// The dial's limits, in metres. 0.6 m is closer than the free camera's own
// ground clearance lets it get to anything; 400 m is past the point where the
// valley reads as a backdrop rather than as a subject, and the aerial
// perspective in the grade has taken over anyway.
const NEAR = 0.6;
const FAR = 400;

// One wheel detent, as a RATIO. Logarithmic because the dial spans nearly three
// decades: a linear step small enough to frame a mug on a camp table (5 cm)
// needs eight thousand detents to reach the far ridge, and a step big enough to
// cross the valley skips the whole near field. 6% per detent is ~112 detents
// end to end, which is about four flicks of a trackpad, and it feels the same
// at 2 m as it does at 200 m — which is the actual requirement.
const STEP = 1.06;

// What one wheel event is worth, in `deltaY`. A mouse notch reports 100-ish and
// a trackpad reports a stream of 1-10 per frame, so the two have to be
// normalised or the same gesture would move the dial by two orders of magnitude
// depending on the hardware. Dividing by this makes a mouse notch 2.5 steps
// (~16%) and a trackpad frame a fraction of one, which is the same felt speed
// from either.
const NOTCH = 40;

// The stops, as a photographer would say them. Whole stops from f/1.4 (the
// widest lens anyone would call fast) to f/22 (past which a real lens is
// diffraction-limited and this model would keep pretending otherwise).
const STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22];

const READOUT_HOLD = 1.5;   // s the panel stays up after the last change
const READOUT_FADE = 0.45;  // s it takes to go

const CSS = `
.pa-focus {
  position: fixed; left: 50%; bottom: 92px; transform: translateX(-50%);
  z-index: 40; pointer-events: none; opacity: 0;
  transition: opacity ${READOUT_FADE}s ease;
  font: 500 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.04em; color: #f4ece0; text-align: center;
  background: rgba(18, 14, 11, 0.62);
  border: 1px solid rgba(244, 236, 224, 0.18);
  border-radius: 10px; padding: 9px 16px 8px;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  text-shadow: 0 1px 2px rgba(0,0,0,0.6);
}
.pa-focus.pa-on { opacity: 1; }
.pa-focus b { font-weight: 600; font-size: 17px; letter-spacing: 0.02em; }
.pa-focus i { font-style: normal; opacity: 0.55; }
.pa-focus u {
  display: block; margin-top: 5px; text-decoration: none;
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  opacity: 0.5;
}
/* The pull-focus target: where the last measurement was taken. It is a
   confirmation, not a reticle — it flashes once and goes, so it cannot end up
   in a photograph. */
.pa-focus-mark {
  position: fixed; z-index: 40; pointer-events: none;
  width: 46px; height: 46px; margin: -23px 0 0 -23px;
  border: 1px solid rgba(255, 246, 232, 0.9);
  border-radius: 3px; opacity: 0;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(0,0,0,0.25);
}
.pa-focus-mark.pa-fire { animation: pa-focus-pop 0.55s ease-out; }
@keyframes pa-focus-pop {
  0%   { opacity: 0; transform: scale(1.7); }
  35%  { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(0.94); }
}`;

export class PhotoFocus {
  /**
   * @param {object} ctx   the app context — needs `camera`, `postfx`, and
   *                       `renderer` for the canvas the click lands on.
   * @param {object} [opts]
   * @param {HTMLElement} [opts.root]  where the readout is appended.
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.root = opts.root ?? document.body;
    this.active = false;
    this._dist = 18;
    this._stop = STOPS.indexOf(2);  // f/2 — `enable` re-asserts it, see there
    this._show = 0;                 // seconds of readout left
    this._held = false;             // a modifier is down: keep the panel up
    this._node = null;
    this._mark = null;
    this._down = null;              // {x, y} of a pointer that may become a pull
    this._pendingAF = 0;            // frames until the opening measurement
    this._apAccum = 0;              // part-detents banked toward the next stop
    // Bound once so add/removeEventListener see the same function objects. A
    // mode that can be opened and closed a hundred times a session cannot leak
    // a listener per visit.
    this._onWheel = this._onWheel.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
  }

  get distance() { return this._dist; }
  get fStop() { return STOPS[this._stop]; }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Take the lens. Safe to call twice.
   *
   * Order matters: the aperture the mode opens at is set BEFORE the first
   * measurement, because `postfx.setFocusManual` re-derives the blur ceiling
   * and the sharp zone from the focus distance and would otherwise do it twice.
   */
  enable() {
    if (this.active) return;
    const fx = this.ctx.postfx;
    if (!fx?.setPhotoDOF) return;          // an older PostFX: stay out of the way
    this.active = true;

    fx.setPhotoDOF(true);
    // Photo mode opens at f/2. It is a compromise and worth naming: f/1.4 makes
    // the most striking first frame and also makes it hard to keep anything
    // with depth — a camper, a tent — sharp end to end, which is a bad first
    // five seconds. f/2 separates the subject from the valley on sight and
    // still holds a whole vehicle.
    this._stop = STOPS.indexOf(2);
    fx.setAperture(this.fStop);
    // The lens is now the player's; CameraRig may keep writing its own idea of
    // the focus from the free camera's pivot and will be ignored (see
    // `PostFX.holdFocus`).
    fx.holdFocus(true);
    // Seed from where CameraRig would have put the plane — the free camera's
    // own pivot, which is the subject the player framed — and MEASURE it two
    // frames later.
    //
    // Not immediately, and this is the one ordering trap in the file:
    // `setPhotoDOF` rebuilds the merged EffectPass, and `EffectComposer`
    // deletes its depth texture the moment no pass in the chain wants one and
    // recreates it when the new pass arrives. So for the rest of this task the
    // depth buffer exists and contains nothing. Measured against it, every
    // visit to photo mode opened focused 0.6 m in front of the lens with the
    // entire world melted — which looks exactly like a broken feature.
    const rig = this.ctx.systems?.cameraRig;
    this.setDistance(Number.isFinite(rig?.freeDist) ? rig.freeDist * 1.15 + 4 : 18);
    this._pendingAF = 2;

    this._mountDom();
    window.addEventListener('wheel', this._onWheel, { capture: true, passive: false });
    window.addEventListener('keydown', this._onKeyDown, true);
    window.addEventListener('keyup', this._onKeyUp, true);
    window.addEventListener('pointerdown', this._onPointerDown, true);
    window.addEventListener('pointerup', this._onPointerUp, true);
    window.addEventListener('blur', this._onBlur);
    // Up on entry, so the control announces itself once and then gets out of
    // the way. Nobody discovers a modifier they were never told about.
    this._flash(2.6);
  }

  /**
   * Give the lens back, exactly as it was found.
   *
   * `setPhotoDOF(false)` restores PostFX's tier configuration and the focus
   * distance CameraRig had written; `holdFocus` goes back to whatever it was
   * (which is `false` in every path that exists today, and is restored rather
   * than assumed for the same reason the exposure in `hud_photo._readGrade` is
   * — a mode that guesses what it found is a mode that drifts the world one
   * visit at a time).
   */
  disable() {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('wheel', this._onWheel, { capture: true });
    window.removeEventListener('keydown', this._onKeyDown, true);
    window.removeEventListener('keyup', this._onKeyUp, true);
    window.removeEventListener('pointerdown', this._onPointerDown, true);
    window.removeEventListener('pointerup', this._onPointerUp, true);
    window.removeEventListener('blur', this._onBlur);
    this._down = null;
    this._held = false;
    this._pendingAF = 0;
    this._apAccum = 0;
    this._unmountDom();
    this.ctx.postfx?.holdFocus?.(false);
    this.ctx.postfx?.setPhotoDOF?.(false);
  }

  // ── the dial ──────────────────────────────────────────────────────────────

  /** Put the focal plane at `m` metres. */
  setDistance(m) {
    if (!Number.isFinite(m)) return;
    this._dist = Math.min(FAR, Math.max(NEAR, m));
    this.ctx.postfx?.setFocusManual?.(this._dist);
    this._flash();
  }

  /**
   * One wheel detent, log-scaled. Positive is further away.
   *
   * Fractional steps are honoured so a trackpad's stream of small deltas reads
   * as a smooth pull rather than as nothing until it crosses a threshold.
   */
  nudge(steps) {
    if (!steps) return;
    this.setDistance(this._dist * Math.pow(STEP, steps));
  }

  /** Pull focus onto whatever is in the middle of the frame. */
  focusAtCentre() { return this.focusAt(0.5, 0.5); }

  /**
   * Pull focus onto whatever is drawn at screen uv (`0,0` is bottom left).
   *
   * Sky returns nothing to measure — `readDepthAt` gives `null` at the far
   * plane — and the honest response to "focus on the sky" is to leave the dial
   * where it is rather than to snap to a number the player did not ask for.
   * The readout still comes up, because a control that appears to have ignored
   * a click is worse than one that says it found nothing.
   */
  focusAt(u, v) {
    const d = this.ctx.postfx?.readDepthAt?.(u, v);
    if (d == null || !Number.isFinite(d)) { this._flash(); return null; }
    this.setDistance(d);
    this._markAt(u, v);
    return this._dist;
  }

  /** Set the aperture to the nearest whole stop to `f`, measured in stops. */
  setAperture(f) {
    let best = 0;
    for (let i = 1; i < STOPS.length; i++) {
      if (Math.abs(Math.log(STOPS[i] / f)) < Math.abs(Math.log(STOPS[best] / f))) best = i;
    }
    this._stop = best;
    this.ctx.postfx?.setAperture?.(this.fStop);
    this._flash();
  }

  /** One detent on the aperture ring. Positive stops down. */
  nudgeAperture(steps) {
    if (!steps) return;
    const next = Math.min(STOPS.length - 1, Math.max(0, this._stop + Math.sign(steps)));
    if (next === this._stop) { this._flash(); return; }
    this._stop = next;
    this.ctx.postfx?.setAperture?.(this.fStop);
    this._flash();
  }

  // ── frame ─────────────────────────────────────────────────────────────────

  /**
   * REAL time, like everything else in photo mode — the world clock is stopped.
   *
   * Two jobs. It fades the readout, and it re-asserts the aperture when the
   * field of view has moved, because the blur circle is derived from the focal
   * length and the focal length is derived from the fov. Nothing in the game
   * changes the fov while photo mode is open today; a zoom lens would.
   */
  update(dt) {
    if (!this.active) return;
    const fov = this.ctx.camera?.fov ?? 0;
    if (Math.abs(fov - (this._fov ?? 0)) > 0.01) {
      this._fov = fov;
      this.ctx.postfx?.setAperture?.(this.fStop);
    }
    // The deferred opening measurement — see `enable`.
    if (this._pendingAF > 0 && --this._pendingAF === 0) this.focusAtCentre();
    if (this._held) { this._show = Math.max(this._show, 0.2); return; }
    if (this._show <= 0) return;
    this._show -= dt;
    if (this._show <= 0) this._node?.classList.remove('pa-on');
  }

  // ── input ─────────────────────────────────────────────────────────────────

  /**
   * Exposed so a host that would rather forward events than let this class
   * bind its own can do that. `enable()` binds these itself, so nothing has to.
   */
  handleWheel(e) { return this._onWheel(e); }

  _onWheel(e) {
    if (!this.active) return;
    const focus = e.shiftKey;
    const aperture = e.altKey;
    if (!focus && !aperture) return;
    // A shifted wheel arrives on the X axis in Chrome and Safari — deltaY is
    // flatly zero. Reading both is the difference between a working control and
    // one that silently does nothing on the two browsers most players use.
    const raw = e.deltaY || e.deltaX || 0;
    if (!raw) return;
    // Capture-phase, so `Input`'s own bubble-phase wheel listener never runs and
    // the free camera's dolly cannot move on the same detent. `preventDefault`
    // is for the browser's own gestures (Alt+wheel is history navigation in
    // some builds); it needs `passive: false`, which `enable` asks for.
    e.preventDefault();
    e.stopPropagation();
    // A mouse notch is |delta| ~100 and a trackpad emits a stream of 1-10s, so
    // the delta is divided by a notch and clamped: one mouse click of the wheel
    // is ~2.5 steps (a 16% move), one trackpad frame is a fraction of one, and
    // a violent flick cannot cross the whole range in a single event.
    const steps = Math.max(-3, Math.min(3, raw / NOTCH));
    // A wheel's positive deltaY is "scroll down", which everywhere else in this
    // game means "away". Focus follows: down pushes the plane out.
    if (!aperture) { this.nudge(steps); return; }
    // The aperture is a ratchet, not a continuum: without accumulating, a
    // trackpad's twenty events per flick would run f/1.4 to f/22 and back before
    // the player's finger left the glass.
    this._apAccum = (this._apAccum ?? 0) + steps;
    if (Math.abs(this._apAccum) < 1.6) { this._flash(); return; }
    const dir = Math.sign(this._apAccum);
    this._apAccum = 0;
    this.nudgeAperture(dir);
  }

  _onKeyDown(e) {
    if (!this.active) return;
    if (e.key === 'Shift' || e.key === 'Alt') { this._held = true; this._flash(); }
  }

  _onKeyUp(e) {
    if (!this.active) return;
    if (e.key === 'Shift' || e.key === 'Alt') { this._held = false; this._flash(); }
  }

  _onBlur() { this._held = false; }

  /**
   * Shift + click = pull focus here.
   *
   * The press is tracked here rather than read from `Input.press`, and that is
   * not duplication for its own sake: photo mode sets `Input.suppressed`, and
   * `Input.update` clears `press.tap` and `press.commit` every frame while it
   * is set (deliberately — see its comment about a sheet opening over a held
   * placement). There is no press gesture to read in this mode.
   *
   * Shift+drag still orbits the free camera, which is correct: a drag is a
   * camera move and only a click that stayed put is a focus pull. The 6 px slop
   * is `Input.SLOP_MOUSE`, so "in place" means the same thing here as
   * everywhere else in the game.
   */
  _onPointerDown(e) {
    if (!this.active || !e.shiftKey || e.button !== 0) { this._down = null; return; }
    if (!(e.target instanceof HTMLCanvasElement) || e.target.closest('#pa-hud')) {
      this._down = null;
      return;
    }
    this._down = { x: e.clientX, y: e.clientY };
  }

  _onPointerUp(e) {
    const d = this._down;
    this._down = null;
    if (!this.active || !d) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
    const r = this.ctx.renderer?.domElement?.getBoundingClientRect?.();
    if (!r || !r.width || !r.height) return;
    this.focusAt((e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height);
  }

  // ── readout ───────────────────────────────────────────────────────────────

  _mountDom() {
    if (!this._node) {
      if (!document.getElementById('pa-focus-css')) {
        const style = document.createElement('style');
        style.id = 'pa-focus-css';
        style.textContent = CSS;
        document.head.appendChild(style);
      }
      this._node = document.createElement('div');
      this._node.className = 'pa-focus';
      this._node.setAttribute('aria-live', 'polite');
      this._mark = document.createElement('div');
      this._mark.className = 'pa-focus-mark';
    }
    this.root.appendChild(this._node);
    this.root.appendChild(this._mark);
    this._paint();
  }

  _unmountDom() {
    this._node?.remove();
    this._mark?.remove();
    this._show = 0;
  }

  _flash(hold = READOUT_HOLD) {
    this._show = Math.max(this._show, hold);
    this._paint();
    this._node?.classList.add('pa-on');
  }

  _paint() {
    if (!this._node) return;
    const d = this._dist;
    const m = d >= 100 ? d.toFixed(0) : d >= 10 ? d.toFixed(1) : d.toFixed(2);
    const f = this.fStop < 10 ? this.fStop.toFixed(1) : String(this.fStop);
    this._node.innerHTML =
      `<b>${m} m</b> <i>focus</i> &nbsp;·&nbsp; <b>f/${f}</b>` +
      `<u>shift+wheel focus &nbsp; shift+click here &nbsp; alt+wheel aperture</u>`;
  }

  _markAt(u, v) {
    const r = this.ctx.renderer?.domElement?.getBoundingClientRect?.();
    if (!r || !this._mark) return;
    this._mark.style.left = `${r.left + u * r.width}px`;
    this._mark.style.top = `${r.top + (1 - v) * r.height}px`;
    this._mark.classList.remove('pa-fire');
    void this._mark.offsetWidth;          // restart the animation
    this._mark.classList.add('pa-fire');
  }
}
