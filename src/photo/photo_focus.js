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
//       f/2.8-versus-f/11 choice is what a photograph is actually made of.
//
//  ── the wheel already did something ─────────────────────────────────────────
//
//  In photo mode the bare wheel dollies the free camera (`CameraRig._free`) and
//  the on-screen rail says so. Taking it for focus would have broken the one
//  camera verb the mode advertises, so focus lives on a HELD MODIFIER:
//
//      shift + wheel   focus nearer / further
//      shift + click   pull focus onto whatever is under the cursor
//      alt   + wheel   aperture
//
//  Every one of those now has a VISIBLE control beside it on the rail — a focus
//  slider, an aperture slider, an AF button — because a chord is not a control
//  a player can find by looking, and on a phone it is not a control at all.
//  The chords stay for the people who learned them; they are no longer the only
//  way in. See the rail in `hud_photo.js`.
//
//  The aperture ladder below runs f/1.4 to f/22, but the RING the player turns
//  is clamped to the fitted lens by the rail (`hud_photo._lensStop`): f/2.8 to
//  f/22 on the 24-70, f/4 to f/22 on the 200-400. The ladder keeps the faster
//  stops because it is the model's range, not the barrel's — a faster lens in
//  the bag would want them and nothing here would have to change.
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
//  It is an INSTRUMENT PANEL and it never goes away. Both halves of that
//  sentence are corrections.
//
//  It used to appear only while a modifier was held or a dial was moving, and
//  fade a second and a half after the last change — on the argument that a
//  readout on screen is a readout in the photograph. That argument was wrong
//  twice over. The shutter reads the drawing buffer, so no DOM has ever been in
//  a saved photo; and the numbers a photographer wants are exactly the ones you
//  want *while deciding*, not the ones you want for a second and a half after
//  you have already decided. The player's words were "don't hide the info bar
//  that says the aperture and stuff". So it is up for as long as the mode is.
//
//  And it reads as an instrument rather than as a sentence: four value/label
//  cells — lens, focal length, aperture, focus distance — over one line for the
//  band that is actually sharp. The transient lines (a click that found sky, a
//  subject the lens cannot reach) are the only thing left that comes and goes.
//
//  ── where it sits, and who decides ─────────────────────────────────────────
//
//  Pass `opts.slot` and the panel becomes an ordinary block inside it, with no
//  position of its own. That is not a convenience; it is the fix to a real
//  defect. The panel used to place itself at a fixed `bottom: 92px` from this
//  file's own injected stylesheet, and `hud.css` carried an override lifting it
//  clear of the photo rail — two files owning one strip of screen, kept in
//  agreement by hand, and out of agreement the moment the rail grew a lens
//  preview. With a slot, this file owns how the readout LOOKS and the host owns
//  where it SITS, and there is no second rule to keep in step. The fixed
//  fallback stays for a host that gives no slot, so the class is still usable
//  on its own.
//
//  It also shows the DEPTH OF FIELD, which is not decoration. Nine stops is a
//  lot of clicks for a dial whose usable range is three or four of them, and
//  which three depends on the focus distance: at 3 m the wide end is all
//  ceiling and at 37 m the narrow end is indistinguishable from the effect
//  being off. Rather than grey out stops on a wheel, the panel prints the band
//  that is actually sharp — turn the ring and watch "17.2 – 21.3 m" become
//  "10.4 – 116 m" — so the control explains itself while it is being used. The
//  band comes from `PostFX.lensInfo()`, solved from the same circle of
//  confusion the shader runs, so the number on screen is the number in the
//  picture rather than a second model that will drift from the first.
//
//  There is a second line under it, in amber, and it exists because a readout
//  that is confidently wrong is worse than no readout. With the 200-400 fitted,
//  a shift+click on a ridge 2 km away used to clamp the dial to a hard-coded
//  400 m and then print "sharp 395 – 405 m" — a sentence about a photograph
//  nobody had taken, while the ridge measured softer than with the effect off.
//  The dial's far end is the LENS's now (`_reach`), and on the rare click it
//  still cannot honour, the amber line says which subject fell outside the band
//  instead of the band quietly describing somewhere else. The test is not "did
//  it clamp" — clamping to the hyperfocal is free, everything past it is
//  already sharp — but "is the thing you clicked on inside the band you were
//  just shown".
//
//  Neither lens in the bag can currently produce that condition, and that is
//  the point rather than an omission: the line is the tripwire that stops a
//  future lens, or a future cap, from quietly bringing the confident wrong
//  sentence back.
//
//  ── wiring ─────────────────────────────────────────────────────────────────
//
//  Deliberately self-installing. `enable()` attaches its own listeners and
//  builds its own DOM; `disable()` removes both. The integrator constructs it,
//  enables/disables it alongside the mode, and calls `update(dt)` while it is
//  open. Four optional hooks make it a citizen of a real interface rather than
//  a floating box: `slot` (where the panel goes — see above), `barrel` (the
//  fitted lens, which this file models the optics of but cannot name),
//  `onChange` (so a host with sliders can follow the wheel), and `repaint()`
//  (so a host whose lens moved can make the panel say so).
// ─────────────────────────────────────────────────────────────────────────────

// The near end of the dial, in metres: closer than the free camera's own ground
// clearance lets it get to anything.
const NEAR = 0.6;

// The far end used to be a constant 400 m, on the argument that past it the
// valley reads as a backdrop rather than as a subject and the aerial
// perspective in the grade has taken over anyway. That argument was true of the
// only lens the mode had: at 24 mm-equivalent the hyperfocal is 168 m at f/2.8
// and 335 m even at the ladder's f/1.4, so a 400 m dial already meant "sharp to
// infinity" and the clamp could never be felt.
//
// It is flatly false of a 400 mm. Aimed at valley terrain 2097 m away with the
// tele fitted, shift+click clamped the dial to 400 m, the panel printed a
// confident "sharp 395 – 405 m", and the thing that had just been clicked on
// measured 0.50 acutance against 1.48 with the effect switched off — SOFTER
// than no depth of field at all, while the readout said it was fine. The tele's
// own blurb sells "ridgelines, the moon".
//
// So the far end is now the lens's, not a constant: `_reach()` asks PostFX for
// the hyperfocal distance and stops there, because past the hyperfocal the far
// limit is already infinity and no further travel buys anything. `FAR_MIN`
// keeps the old 400 m as a floor so the wide end of the kit behaves exactly as
// it did — every measurement the previous round took at 400 m still reaches.
const FAR_MIN = 400;

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
// The ring. f/28 is the last rung and it is not an ordinary stop: see
// `PostFX.setPinhole` — the lens equation never reaches zero blur, so the far
// end of the ring is made to mean "everything sharp" rather than "a bit less
// blurred than f/22", which is what a player turning the dial all the way is
// asking for.
const STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22, 28];
/** The rung that means no depth of field at all. */
const PINHOLE_F = 28;

// How many frames the opening measurement may keep asking for. It used to be a
// bare `_pendingAF = 2` — wait two frames, read once, believe whatever comes
// back — and the failure mode of that is invisible: measured over four trials,
// `readDepthAt` right after `setPhotoDOF(true)` returns **0.25 m** on frame 0.
// Finite, plausible, and wrong; `focusAt`'s null guard would not have caught
// it, and the mode would have opened at the 0.6 m clamp with the whole world
// melted — the exact bug the deferral exists to prevent. So the read is
// retried until it comes back finite AND outside the near clamp, which is a
// condition a stale buffer fails and a real measurement passes. Ten frames
// because photo mode's entry can spend 450–2500 ms reallocating the drawing
// buffer on a Retina panel (see hud_photo.js) and nobody has measured what the
// depth attachment does across that; ten is ~1/6 s, under the door sound.
const AF_TRIES = 10;

// Metres, at three significant-ish figures: 2 decimals inside 10 m (a mug on a
// camp table is a 5 cm decision), 1 to 100 m, none past it.
const fmtM = (d) => (d >= 100 ? d.toFixed(0) : d >= 10 ? d.toFixed(1) : d.toFixed(2));

// How long a transient line stays up. The PANEL no longer fades — see the
// header — but "sky — nothing to focus on" is an answer to a click, and an
// answer to a click that is still on screen a minute later has stopped being
// an answer and started being a label.
const NOTE_HOLD = 3.0;

const CSS = `
.pa-focus {
  z-index: 40; pointer-events: none;
  font: 500 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.04em; color: #f4ece0; text-align: center;
  text-shadow: 0 1px 2px rgba(0,0,0,0.6);
}
/* The standalone placement, for a host that hands this class no slot. Inside
   photo mode there is a slot and none of this applies — see the header on why
   two files owning one strip of screen was a defect and not a convenience. */
.pa-focus.pa-focus-inline { color: inherit; }
.pa-focus:not(.pa-focus-inline) {
  position: fixed; left: 50%; bottom: 92px; transform: translateX(-50%);
  background: rgba(18, 14, 11, 0.62);
  border: 1px solid rgba(244, 236, 224, 0.18);
  border-radius: 10px; padding: 9px 16px 8px;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
}
/* ── the instrument row ──────────────────────────────────────────────────
   Four value/label cells. A photographer reads a camera's top plate by
   position, not by punctuation, so the cells are a grid with air between
   them rather than one sentence separated by middots. \`flex-wrap\` is what
   carries it down to a phone: the row becomes two rows of two and nothing
   is cut off. */
.pa-focus-row {
  display: flex; flex-wrap: wrap; justify-content: center;
  gap: 2px 22px;
}
.pa-focus-cell { min-width: 3.6em; }
.pa-focus-cell b {
  display: block; font-weight: 600; font-size: 16px; letter-spacing: 0.01em;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.pa-focus-cell i {
  display: block; font-style: normal; font-size: 9px; opacity: 0.5;
  letter-spacing: 0.16em; text-transform: uppercase; margin-top: 1px;
}
/* The depth of field, or what the last click found. Under the numbers because
   it is the line that changes when the aperture cell does — which is the whole
   answer to "is this stop doing anything". */
.pa-focus em {
  display: block; margin-top: 5px; font-style: normal;
  font-size: 11px; letter-spacing: 0.05em; opacity: 0.72;
}
/* The one thing the dial could not do. Warm amber rather than red: nothing has
   gone wrong, the lens simply does not reach. */
.pa-focus em.pa-warn { color: #ffcf8a; opacity: 0.95; margin-top: 3px; }
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
   * @param {HTMLElement} [opts.root]  where the pull-focus mark is appended.
   *                       It is `position: fixed` over the canvas, so it wants
   *                       the HUD root whatever the readout is doing.
   * @param {HTMLElement} [opts.slot]  where the readout is appended. Given one,
   *                       the panel takes no position of its own and the host's
   *                       layout places it. See the header.
   * @param {function} [opts.barrel]  `() => ({ name, focal })` for the lens
   *                       actually fitted. This class models the OPTICS and has
   *                       no idea what body is on the camera; the two cells that
   *                       say so come from whoever owns the kit.
   * @param {function} [opts.onChange]  fired after anything the player can see
   *                       moves, so a host with its own sliders can resync them.
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.root = opts.root ?? document.body;
    this.slot = opts.slot ?? null;
    this.barrel = opts.barrel ?? null;
    this.onChange = opts.onChange ?? null;
    this.active = false;
    this._dist = 18;
    this._stop = STOPS.indexOf(22);  // f/22 — `enable` re-asserts it, see there
    this._noteHold = 0;             // seconds the transient line has left
    this._node = null;
    this._mark = null;
    this._down = null;              // {x, y} of a pointer that may become a pull
    this._note = null;              // a one-line answer that replaces the DoF band
    this._warn = null;              // a line that appears BELOW the band, not instead
    this._pendingAF = 0;            // opening-measurement attempts left
    this._apAccum = 0;              // part-detents banked toward the next stop
    // Bound once so add/removeEventListener see the same function objects. A
    // mode that can be opened and closed a hundred times a session cannot leak
    // a listener per visit.
    this._onWheel = this._onWheel.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
  }

  get distance() { return this._dist; }
  get fStop() { return STOPS[this._stop]; }
  /** The near and far ends of the dial, in metres — what a slider spans. */
  get near() { return NEAR; }
  get reach() { return this._reach(); }

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
    // ── photo mode opens at f/22 ──────────────────────────────────────────
    //
    // The player asked for it outright ("when you first go into photo mode,
    // the default should be F22") and the measurement agrees with them, which
    // is worth writing down because the old default was defended at length.
    //
    // It was f/2.8 — the wide lens's own maximum aperture, chosen to separate
    // a subject from the valley on sight. What that argument missed is the
    // FORMAT this mode is running. `PostFX` holds a 440 mm lens and derives
    // the film from the fitted angle of view (see its `_lensGeometry`), so a
    // 24 mm-equivalent frame is a 14x17 view camera: at f/2.8 the hyperfocal
    // is 168 m and a subject 10 m away gets a band 1.2 m deep. Measured on a
    // cold entry with the centre of frame on a hillside 227 m out, f/2.8 held
    // 48% of the frame inside the sharp band and every near thing in it was a
    // smear. That is the "why is it always blurry" the player is reporting.
    //
    // f/22 is the far end of the ladder and both lenses reach it (`fStopMin`
    // is 22 on the 24-70 AND on the 200-400), so unlike the f/2 this line used
    // to hold, it survives the rail's clamp with no second write and the
    // player sees the number they were promised. Opening stopped down is also
    // simply what a photographer does when they have not chosen a subject yet.
    this._stop = STOPS.indexOf(22);
    this._applyStop();
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
    //
    // The seed is `freeDist` and nothing else. It was `freeDist * 1.15 + 4`,
    // which is 25.85 m against a measured 19.11 — 35% long, and long enough
    // that a frame taken before the measurement lands has nothing sharp in it
    // at all. The free camera's pivot distance IS the subject distance; there
    // was never anything for the fudge to correct.
    const rig = this.ctx.systems?.cameraRig;
    this.setDistance(this._openAt(Number.isFinite(rig?.freeDist) ? rig.freeDist : 18));
    this._pendingAF = AF_TRIES;

    this._mountDom();
    window.addEventListener('wheel', this._onWheel, { capture: true, passive: false });
    window.addEventListener('pointerdown', this._onPointerDown, true);
    window.addEventListener('pointerup', this._onPointerUp, true);
  }

  /**
   * The opening focus, brought inside the distance that leaves the MOST of the
   * frame sharp. Applies to the automatic focus only — never to a pull the
   * player asked for, which is their decision and gets `_warn` instead.
   *
   * ── the measurement ────────────────────────────────────────────────────
   *
   * The autofocus below was audited and it is not broken: on a cold entry the
   * centre-of-frame depth read came back on frame 0 with zero error, and the
   * focus distance it set was exactly the depth of the pixel in the middle of
   * the screen. The frame was still a smear, and the census says why:
   *
   *     centre of frame 227.4 m     band at f/2.8   96.6 m – infinity
   *     frame depths    p10 9.5 m   median 27.0 m   p90 436.6 m
   *     inside the band                             48% of the frame
   *
   * The centre pixel was a hillside a quarter of a kilometre away, so the
   * whole near half of the picture — which is most of the picture — fell
   * outside the near limit. The mirror case is just as common and just as bad:
   * point slightly down, the centre pixel is grass at 10 m, and the valley
   * behind it dissolves. Reading the centre and believing it is what every
   * camera does; what every camera ALSO does is refuse to focus past the
   * hyperfocal, because beyond it the far limit is already infinity and all
   * the extra distance buys is throwing away near sharpness for nothing.
   *
   * So: `min(measured, hyperfocal)`. On the frame above that moves the plane
   * from 227.4 m to 21.3 m and the far limit stays at infinity, which is the
   * point — the hillside is still sharp AND so is everything from 10.7 m out.
   * A deer at 6 m is inside the hyperfocal and is focused on exactly as
   * before; nothing near the camera changes at all.
   *
   * `hyperfocal` comes from `PostFX.lensInfo()`, solved from the same c(d) the
   * shader runs, so this cannot drift from the picture. `_reach()` uses the
   * same number for the far end of the DIAL and deliberately scales it to the
   * widest stop; this one must not, because here the current aperture is
   * exactly the thing being asked about.
   */
  _openAt(m) {
    const h = this.ctx.postfx?.lensInfo?.()?.hyperfocal;
    return Number.isFinite(h) && h > NEAR ? Math.min(m, h) : m;
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
    window.removeEventListener('pointerdown', this._onPointerDown, true);
    window.removeEventListener('pointerup', this._onPointerUp, true);
    this._down = null;
    this._note = null;
    this._warn = null;
    this._pendingAF = 0;
    this._apAccum = 0;
    this._unmountDom();
    this.ctx.postfx?.holdFocus?.(false);
    this.ctx.postfx?.setPhotoDOF?.(false);
  }

  // ── the dial ──────────────────────────────────────────────────────────────

  /**
   * The far end of the dial for the lens that is fitted, in metres.
   *
   * Two things it deliberately is NOT.
   *
   * It is not a second copy of the optics. `PostFX.lensInfo()` solves the
   * hyperfocal from the same c(d) the shader runs — the rule this file already
   * follows for the sharp band it prints — so there is one model and the dial
   * cannot drift from the picture.
   *
   * And it does not move with the APERTURE ring, even though the hyperfocal
   * does (H ∝ 1/N exactly). A limit that tracked the current stop would be
   * 1956 m at f/4 on the 400 mm and 356 m at f/22, so one click of the aperture
   * would silently yank a 1956 m focus plane back to 356 m — a dial moving
   * because a different dial moved. Scaling it to `STOPS[0]` instead — the
   * widest stop the ladder has, which is at least as wide as any ring the rail
   * will hand out — gives the furthest this lens could ever need at ANY stop,
   * in one multiply, because the relation is exact. Written out, H·N/N₀ is
   * f²/(N₀·c) plus a term of a few millimetres: the reach depends on the
   * barrel and not on the ring, which is the property being bought.
   *
   * What it comes to, measured through `lensInfo`: 400 m at 24 mm (the floor
   * still winning), 496 at 35, 985 at 70, 2801 at 200 and 5594 at 400.
   *
   * `camera.far` caps it: there is nothing to focus on past the far plane, and
   * `readDepthAt` returns null there anyway.
   */
  _reach() {
    const L = this.ctx.postfx?.lensInfo?.();
    const cap = this.ctx.camera?.far ?? 6000;
    if (!L || !Number.isFinite(L.hyperfocal) || !(L.fStop > 0)) return FAR_MIN;
    const widest = L.hyperfocal * (L.fStop / STOPS[0]);
    return Math.min(cap, Math.max(FAR_MIN, widest));
  }

  /** Put the focal plane at `m` metres. */
  setDistance(m) {
    if (!Number.isFinite(m)) return;
    this._note = null;
    this._warn = null;
    this._dist = Math.min(this._reach(), Math.max(NEAR, m));
    this.ctx.postfx?.setFocusManual?.(this._dist);
    this._touch();
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
   *
   * The `> NEAR` test is the same one `update`'s deferred autofocus runs, and
   * for the same reason: a depth attachment that has just been recreated reads
   * a finite, plausible, wrong 0.25–0.27 m, `setDistance` clamps that to the
   * 0.6 m floor and the whole frame melts (grass 129.2 → 1.02 acutance in the
   * measurement that found it). No shipped path rebuilds the merged pass while
   * photo mode is open, so this is a guard against a future `_syncDOF` and not
   * against a live bug — but it is one line and the failure it prevents looks
   * exactly like a broken feature. What it costs: a subject genuinely inside
   * 0.6 m cannot be clicked. Nothing in this world is: the free camera's own
   * clearance keeps it further away than that, which is where the floor came
   * from in the first place.
   */
  focusAt(u, v) {
    const d = this.ctx.postfx?.readDepthAt?.(u, v);
    if (d == null || !Number.isFinite(d)) {
      // The panel is always up now, so it cannot answer a click by appearing.
      // It has to SAY so instead: an unchanged number reads as a missed click,
      // and one word closes the loop.
      this._note = 'sky — nothing to focus on';
      this._touch();
      return null;
    }
    if (!(d > NEAR)) {
      this._note = 'too near to measure — focus unchanged';
      this._touch();
      return null;
    }
    this._note = null;
    this.setDistance(d);
    this._markAt(u, v);
    // Did the dial actually get there? `_reach()` is generous enough that the
    // answer is normally yes even when it clamped — past the hyperfocal the far
    // limit is infinity, so a ridge at 2 km is sharp with the plane at 1.9 km
    // and there is nothing to apologise for. The test is therefore not "was it
    // clamped" but "is the thing you clicked on inside the band you were just
    // told about", which is the question a silent clamp answered wrongly.
    const L = this.ctx.postfx?.lensInfo?.();
    this._warn = (L && (d > L.far || d < L.near))
      ? `subject at ${fmtM(d)} m is outside the band — the lens will not reach it`
      : null;
    this._touch();
    return this._dist;
  }

  /** Set the aperture to the nearest whole stop to `f`, measured in stops. */
  /**
   * Push the current stop at PostFX, and switch the pinhole on at the far end.
   *
   * Every route that changes the aperture comes through here — the dial, the
   * wheel, the lens clamp and `enable()` — so the pinhole cannot be left on by
   * a path that forgot about it.
   */
  _applyStop() {
    const fx = this.ctx.postfx;
    if (!fx) return;
    fx.setAperture(this.fStop);
    fx.setPinhole?.(this.fStop >= PINHOLE_F - 1e-6);
  }

  setAperture(f) {
    this._note = null;
    this._warn = null;
    let best = 0;
    for (let i = 1; i < STOPS.length; i++) {
      if (Math.abs(Math.log(STOPS[i] / f)) < Math.abs(Math.log(STOPS[best] / f))) best = i;
    }
    this._stop = best;
    this._applyStop();
    this._touch();
  }

  /** One detent on the aperture ring. Positive stops down. */
  nudgeAperture(steps) {
    if (!steps) return;
    const next = Math.min(STOPS.length - 1, Math.max(0, this._stop + Math.sign(steps)));
    if (next === this._stop) { this._touch(); return; }
    this._note = null;
    this._warn = null;
    this._stop = next;
    this._applyStop();
    this._touch();
  }

  // ── frame ─────────────────────────────────────────────────────────────────

  /**
   * REAL time, like everything else in photo mode — the world clock is stopped.
   *
   * Three jobs. It expires the transient line, it re-asserts the aperture when
   * the field of view has moved, and it keeps asking for the opening
   * measurement until the depth buffer has one to give.
   *
   * The fov watch is not hypothetical any more: the blur circle is derived
   * from the focal length and the focal length from the fov, and photo mode
   * now has a lens kit with a zoom ring (`src/photo/lens_models.js`). Without
   * this, zooming would leave the aperture describing the lens that was fitted
   * before. It repaints too — the sharp band moves with the focal length, and
   * a panel that is always on screen is a panel that is always being read.
   */
  update(dt) {
    if (!this.active) return;
    const fov = this.ctx.camera?.fov ?? 0;
    if (Math.abs(fov - (this._fov ?? 0)) > 0.01) {
      this._fov = fov;
      this._applyStop();
      this._paint();
    }
    // The deferred opening measurement — see `enable`. Retried rather than
    // counted down, and the test is on the ANSWER, not on the frame number: a
    // stale depth attachment reads 0.25 m, which is finite, plausible and
    // inside the near clamp, so `> NEAR` is what tells the two apart. No
    // reticle for this one — nothing was clicked.
    //
    // `_openAt` is the hyperfocal clamp, and it is on BOTH exits. The second
    // one is the case the old code left blurry with nothing to say for itself:
    // ten frames of centre-of-frame sky — a camera pointed at the horizon, or
    // over a ridge — and the dial stayed on the free camera's arm length with
    // the entire landscape outside the near limit. Focusing at the hyperfocal
    // is the right answer to "there is no subject in the middle of the frame":
    // it is the setting that has the most of everything sharp.
    if (this._pendingAF > 0) {
      this._pendingAF--;
      const d = this.ctx.postfx?.readDepthAt?.(0.5, 0.5);
      if (Number.isFinite(d) && d > NEAR) { this._pendingAF = 0; this.setDistance(this._openAt(d)); }
      else if (this._pendingAF === 0) this.setDistance(this._openAt(this._dist));
    }
    if (this._noteHold <= 0) return;
    this._noteHold -= dt;
    if (this._noteHold <= 0 && (this._note || this._warn)) {
      this._note = null;
      this._warn = null;
      this._paint();
    }
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
    if (Math.abs(this._apAccum) < 1.6) return;
    const dir = Math.sign(this._apAccum);
    this._apAccum = 0;
    this.nudgeAperture(dir);
  }

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
      this._node.className = this.slot ? 'pa-focus pa-focus-inline' : 'pa-focus';
      this._node.setAttribute('aria-live', 'polite');
      this._mark = document.createElement('div');
      this._mark.className = 'pa-focus-mark';
    }
    (this.slot ?? this.root).appendChild(this._node);
    // The mark is `position: fixed` over the canvas wherever the panel went.
    this.root.appendChild(this._mark);
    this._paint();
  }

  _unmountDom() {
    this._node?.remove();
    this._mark?.remove();
    this._noteHold = 0;
  }

  /**
   * Something the player can see has moved: repaint, hold any transient line
   * up for a few seconds, and tell the host so its sliders can follow.
   *
   * This was `_flash(hold)`, and the name was the design: the panel appeared,
   * stayed 1.5 s and faded. It does not fade any more (see the header), so
   * what is left is the repaint and the note timer.
   */
  _touch() {
    if (this._note || this._warn) this._noteHold = NOTE_HOLD;
    this._paint();
    this.onChange?.(this);
  }

  /** Repaint from outside — the fitted lens changed under us. */
  repaint() { this._paint(); }

  /**
   * The panel.
   *
   * Four cells and a band. The cells are what a camera puts on its top plate,
   * in the order a photographer names them, and they are cells rather than a
   * sentence because a value with its own label under it can be found by
   * position at a glance — which is the entire job of an instrument panel and
   * is not something "10.1 m focus · f/2.8" ever did.
   *
   * The band under them is the depth of field, and it is there to answer a
   * question the dial could not: which stops are doing anything. The usable
   * range is genuinely narrow and it MOVES — at a 3 m focus the wide end is
   * all ceiling, at 37 m the narrow end is indistinguishable from the effect
   * being off — so rather than grey out stops the panel shows the band that is
   * sharp. Turn the ring and watch "17.7 – 20.6 m" become "10.4 – 113 m": that
   * is the control explaining itself. `PostFX.lensInfo()` solves it from the
   * same c(d) the shader runs, so the number on screen is the number in the
   * picture.
   *
   * The gesture legend that used to be the last line is gone, and not because
   * it was wrong: every chord it listed now has a slider or a button on the
   * rail with its own label, so the line had become a second, worse copy of
   * the controls sitting directly underneath it.
   */
  _paint() {
    if (!this._node) return;
    const f = this.fStop < 10 ? this.fStop.toFixed(1) : String(this.fStop);
    const L = this.ctx.postfx?.lensInfo?.();
    const b = this.barrel?.() ?? null;
    let mid = this._note ?? '';
    if (!mid && L) {
      mid = `sharp ${fmtM(L.near)} – ${Number.isFinite(L.far) ? `${fmtM(L.far)} m` : '∞'}`;
      // The one thing that can still make two adjacent stops look alike: past
      // this point the background is already as blurred as the kernel draws,
      // and opening up further only widens the melt toward the camera.
      if (L.wideOpen) mid += ' &nbsp;·&nbsp; background at max blur';
    }
    const cell = (v, k) => `<div class="pa-focus-cell"><b>${v}</b><i>${k}</i></div>`;
    this._node.innerHTML =
      '<div class="pa-focus-row">' +
        (b ? cell(b.name, 'lens') + cell(`${Math.round(b.focal)} mm`, 'focal') : '') +
        cell(`f/${f}`, 'aperture') +
        cell(`${fmtM(this._dist)} m`, 'focus') +
      '</div>' +
      (mid ? `<em>${mid}</em>` : '') +
      // BELOW the band rather than instead of it. The band is what the player
      // is being taught to read; a warning that replaced it would take the
      // lesson away at the exact moment it is most needed.
      (this._warn ? `<em class="pa-warn">${this._warn}</em>` : '');
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
