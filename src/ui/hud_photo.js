// ─────────────────────────────────────────────────────────────────────────────
//  Photo mode — the thing players will actually share.
//
//  What it does:
//   · hands the camera to CameraRig's FREE mode, which continues from exactly
//     the pose the player was looking through and then does nothing at all
//     until they move it (`CameraRig.enterFree`). It used to hand it to the
//     auto-orbit, which cut to a different pose on the way in and then swept
//     around the camper on its own — two things you cannot compose a
//     photograph through. The clearance logic is still the rig's; free mode
//     reuses `_floorAt`, so there is no second, worse camera here either.
//   · takes the HUD away, leaving four corner brackets and an optional
//     rule-of-thirds grid
//   · works from inside the camp's two modal views. Both hold CameraRig's
//     takeover, which outranks free mode, so both are told to let go where they
//     stand before `enterFree` reads the camera. The telescope hides its tube
//     (the camera is inside it); the fireside stands its stick in the world and
//     pauses the cook, so the marshmallow the player pressed F on is still over
//     the fire to be photographed. See `ScopeView.handOff` and
//     `RoastView.handOff`, and the two calls in `setActive`.
//   · gives three dials that matter for a photograph — the hour, the exposure,
//     and the colour — and nothing else
//   · pins the render resolution to the display's native density for as long
//     as the mode is open, and puts back whatever was running on the way out
//     (see setActive) — so both the framing and the saved file are the
//     sharpest the machine can produce
//   · writes a real PNG at the drawing buffer's full size, which is therefore
//     the display's native resolution rather than the reduced one play uses
//
//  The save path is the fiddly part. The WebGL context has no
//  preserveDrawingBuffer, so the canvas reads back blank outside of a draw. The
//  fix is to render one extra frame through the post chain and read the buffer
//  *synchronously* in the same task, before the compositor clears it.
// ─────────────────────────────────────────────────────────────────────────────
import { el, button } from './hud_dom.js';
import { stats } from '../game/stats_store.js';
import { PhotoFocus } from '../photo/photo_focus.js';
import { detectSubjects } from '../game/hunt_detect.js';
import { hunt } from '../game/hunt_store.js';
import { LensKit, LensPreview, cameraFovForFocal, stopsFor } from '../photo/lens_models.js';
import { posthog } from '../posthog.js';

const RANGES = {
  hour: [0, 24, 0.05],
  exposure: [0.55, 1.9, 0.01],
  colour: [0.45, 1.5, 0.01],
};

export class PhotoMode {
  constructor(root, hud) {
    this.hud = hud;
    this.ctx = hud.ctx;
    this.active = false;
    this.grid = false;
    this._saved = null;

    this.node = el('div', 'pa-photo-frame');
    for (const c of ['tl', 'tr', 'bl', 'br']) this.node.appendChild(el('div', `pa-bracket ${c}`));
    this.gridNode = el('div', 'pa-grid');
    this.node.appendChild(this.gridNode);
    this.flash = el('div', 'pa-flash');
    this.node.appendChild(this.flash);

    const rail = el('div', 'pa-rail pa-panel');
    rail.setAttribute('role', 'group');
    rail.setAttribute('aria-label', 'Photo controls');
    this.hourEl = this._slider(rail, 'Hour', 'hour', (v) => this._fmtHour(v), (v) => this.hud.applyHour(v));
    this.expEl = this._slider(rail, 'Light', 'exposure', (v) => v.toFixed(2), (v) => this._setExposure(v));
    this.colEl = this._slider(rail, 'Colour', 'colour', (v) => v.toFixed(2), (v) => this._setSaturation(v));

    // The lens. It binds its own capture-phase wheel/key/pointer listeners in
    // `enable()` and removes them in `disable()`, which is also how it takes
    // shift+wheel away from the free camera's dolly without either of them
    // knowing about the other: Input's wheel listener is bubble-phase, so a
    // modified wheel is consumed before it ever gets there.
    this.focus = new PhotoFocus(this.ctx, { root });

    // ── the lens ────────────────────────────────────────────────────────────
    // Two bodies, one ring. `LensKit` walks a single log-spaced ladder from
    // 24 mm to 400 mm and changes lens across the 70-200 gap only when the
    // player pushes through a detent of resistance at the stop — so the gap is
    // something you feel rather than something hidden from you.
    //
    // The camera lever is `rig.fov`, NOT `camera.fov`: CameraRig._apply writes
    // the camera's fov from its own every frame (`_apply`, near line 887), so
    // anything written straight onto the camera is gone by the next frame.
    // And it is the VERTICAL angle, which is what three.js means by fov and is
    // not what a lens is specified in — `cameraFovForFocal` does that
    // conversion against the live aspect.
    this.lens = new LensKit({
      onChange: () => {
        const rig = this.ctx.systems?.cameraRig;
        if (rig) rig.fov = cameraFovForFocal(this.lens.focal, this.ctx.camera.aspect);
        this.lensPreview?.setZoomT(this.lens.t);
        this.lensPreview?.setLens(this.lens.lens.id);
        this._fitAperture();
        this._paintLens();
        this.hud.audio()?.cue('tick');
      },
    });

    const lensRow = el('div', 'pa-rail-item pa-lens');
    this.lensPreview = new LensPreview({ width: 188, height: 128, lens: this.lens.lens.id });
    lensRow.appendChild(this.lensPreview.canvas);
    this.lensLabel = el('div', 'pa-label pa-lens-label', '<span></span>');
    lensRow.appendChild(this.lensLabel);
    rail.appendChild(lensRow);
    this._paintLens();

    this.shutterBtn = button('pa-shutter', '', () => this.capture(), 'Take photo');
    rail.appendChild(this.shutterBtn);
    // The camera verbs come first: the two dial rows above are discoverable by
    // looking at them, and a pan you do not know exists is a pan nobody uses.
    rail.appendChild(el('div', 'pa-rail-hint',
      'drag&nbsp;&nbsp;look<br>middle-drag&nbsp;&nbsp;move<br>wheel&nbsp;&nbsp;zoom<br>' +
      'shift+wheel&nbsp;&nbsp;focus<br>shift+click&nbsp;&nbsp;a subject<br>' +
      'alt+wheel&nbsp;&nbsp;aperture<br>' +
      '[&nbsp;]&nbsp;&nbsp;zoom ring<br>L&nbsp;&nbsp;change lens<br>' +
      'P&nbsp;&nbsp;save<br>G&nbsp;&nbsp;grid<br>J&nbsp;&nbsp;book<br>F&nbsp;&nbsp;exit'));
    this.node.appendChild(rail);
    this.rail = rail;

    rail.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' || e.code === 'KeyF') {
        // Go through HUD so its root/chip classes stay in sync with the mode.
        // Calling setActive directly leaves `pa-photo` stuck on the root and
        // hides the rest of the interface after Escape closes the rail. F
        // needs the same local path because the HUD ignores keys from controls.
        this.hud.togglePhoto();
        e.preventDefault();
        return;
      }
      // P and G need the same local path, for the same reason F does: focus
      // lands on this rail's first control the moment photo mode opens (see
      // `.focus()` below), and every key typed there is swallowed by the
      // `stopPropagation()` a few lines down before it can reach HUD's own
      // `KeyP`/`KeyG` cases — which never fire because HUD._onKey already
      // ignores keys whose target is inside its root. Without this, the
      // shutter hint on screen ("P save") is a lie until the player clicks
      // somewhere else first.
      if (e.code === 'KeyP') { this.capture(); e.preventDefault(); return; }
      if (e.code === 'KeyG') { this.toggleGrid(); e.preventDefault(); return; }
      if (this.lensKey(e.code)) { e.preventDefault(); return; }
      e.stopPropagation();
    });
    rail.addEventListener('keyup', (e) => e.stopPropagation());

    root.appendChild(this.node);
    this.controls = [...rail.querySelectorAll('input, button')];
  }

  _slider(rail, name, key, fmt, onInput) {
    const wrap = el('div', 'pa-rail-item');
    const label = el('div', 'pa-label', `<span>${name}</span><span></span>`);
    const val = label.lastChild;
    const input = el('input');
    const [min, max, step] = RANGES[key];
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    input.setAttribute('aria-label', name);
    const paint = () => {
      val.textContent = fmt(+input.value);
      input.style.setProperty('--fill', `${((+input.value - min) / (max - min)) * 100}%`);
    };
    input.addEventListener('input', () => { onInput(+input.value); paint(); });
    wrap.appendChild(label);
    wrap.appendChild(input);
    rail.appendChild(wrap);
    return { input, paint, set: (v) => { input.value = v; paint(); } };
  }

  _fmtHour(h) {
    const hh = Math.floor(((h % 24) + 24) % 24);
    return `${String(hh).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
  }

  // ── grade hooks ───────────────────────────────────────────────────────────
  // PostFX belongs to another author, so this only ever *moves* its published
  // knobs and always puts them back on exit. Nothing here is permanent.

  // `setExposure` writes PostFX's *base* exposure, which its elevation ramp
  // then multiplies every frame (`_driveTimeOfDay`). So the base is also the
  // only thing that may be read back — see `_readGrade`.
  _setExposure(v) { this.ctx.postfx?.setExposure?.(v); }

  _setSaturation(v) {
    const u = this.ctx.postfx?.grade?.uniforms?.get('uSaturation');
    if (u) u.value = v;
  }

  _readGrade() {
    const fx = this.ctx.postfx;
    return {
      // The base, NOT `tone.exposure`. They are not the same number: the ramp
      // writes `tone.exposure = base * high * low` every frame, and in daylight
      // `high` bottoms out at 0.66. Reading the product here and handing it to
      // `setExposure` on the way out made every visit to photo mode a real
      // exposure cut — 0.88, then 0.58, then 0.38 — so the world got darker
      // each time the player closed it, and the slider opened pinned to the
      // bottom of its range because it was showing a stopped-down value against
      // a scale authored for the base.
      exposure: fx?.getExposure?.() ?? fx?.tone?.exposure ?? 0.88,
      saturation: fx?.grade?.uniforms?.get('uSaturation')?.value ?? 0.86,
      hour: this.ctx.lighting?.hour ?? 16.6,
      cycle: this.ctx.lighting?.cycleSpeed ?? 0,
      mode: this.ctx.systems?.cameraRig?.mode ?? 'chase',
      // The rig's own field of view, which the fitted lens overwrites. Chase
      // and orbit damp theirs back within a second, but `exitFree` cuts — so
      // without this the first frame after leaving photo mode is 400 mm wide.
      fov: this.ctx.systems?.cameraRig?.fov ?? 52,
      // The engine's absolute pin, or null for "the adaptive scaler had it".
      // Read from the engine rather than from HUD.renderPin on purpose: this
      // has to restore what was actually running, and those two differ while a
      // player is looking at an automatic frame.
      resolutionPin: this.ctx.engine?.resolutionPin ?? null,
    };
  }

  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    this.node.classList.toggle('pa-open', on);
    const rig = this.ctx.systems?.cameraRig;
    // Whatever happens below, the controls come back and the world resumes.
    // This runs on both exit paths — the HUD toggle and the rail's Escape
    // handler, which delegates to that same toggle — and a photo mode that
    // could be left with the throttle still suppressed or the world still
    // frozen would be a soft lock.
    if (!on) {
      if (this.ctx.input) this.ctx.input.suppressed = false;
      this.ctx.worldPaused = false;
      // And the telescope this shot may have been composed through comes back
      // — it is hidden for as long as the free camera stands inside it. See
      // `ScopeView.handOff`.
      this.ctx.systems?.camp?.scope?.endHandOff?.();
      // …and the fireside goes back to roasting: the stick returns to the hand,
      // the camera cuts back to the seat, and the marshmallow is at exactly the
      // doneness it was when F was pressed. Here rather than in the `else`
      // below, and BEFORE `exitFree` runs there, because the roast view retakes
      // the rig — `CameraRig.lateUpdate` checks its takeover first, so whatever
      // mode `exitFree` selects is moot while the fire has the camera, and
      // doing it the other way round would show one frame of chase camera in
      // the middle of a cut. See `RoastView.endHandOff`.
      this.ctx.systems?.camp?.roast?.endHandOff?.();
    }

    if (on) {
      this._saved = this._readGrade();
      // Photo mode is CameraRig's free mode. It takes over from wherever the
      // camera already is — the frame the player pressed F on is the frame
      // they get to compose from — and moves only when they move it.
      //
      // Including from inside a telescope. The eyepiece holds the rig's
      // takeover, which outranks free mode, so it has to be told to let go
      // BEFORE `enterFree` reads the camera — and told to let go where it
      // stands rather than through its own step-back, or the shot eases out to
      // the pose the player came from and then cuts straight back to the
      // eyepiece the free camera was posed at. See `ScopeView.handOff`.
      this.ctx.systems?.camp?.scope?.handOff?.();
      // …and from the fire, which is the one the player asked for: "is there
      // any way to use photo mode and be able to capture a photo while you're
      // roasting?" The roast view holds the rig's takeover and raises
      // `__forceCamera`, both of which `CameraRig.lateUpdate` returns at before
      // it ever reaches free mode, so it has to let go BEFORE `enterFree` reads
      // the camera — same ordering as the eyepiece above, same reason.
      //
      // What it does NOT do is put its stick away. It unparents the stick into
      // the world at the pose the hand had it, so the free camera flies and the
      // marshmallow stays over the fire where it can be photographed, and it
      // pauses the cook for as long as the shutter is open. See
      // `RoastView.handOff`.
      this.ctx.systems?.camp?.roast?.handOff?.();
      rig?.enterFree?.();
      // Take the driving controls away. `Input.suppressed` exists for exactly
      // this and says so in its own comment ("A UI layer (menus, photo mode)
      // sets this"), and nothing had ever set it.
      //
      // It was invisible while photo mode was the auto-orbit, because that
      // camera followed the camper: press W and the whole shot moved, which
      // reads as a camera doing something rather than as a bug. The free camera
      // does not follow anything, so the same W now drives the camper out of
      // frame at 20 m/s while the photograph sits perfectly still — and WASD is
      // the first thing anyone tries in a camera they have just been given.
      //
      // It also takes E, R and the handbrake, which is right: every one of them
      // does something to the world the player is trying to photograph.
      // `mouse.dx/dy/wheel` survive, because `Input.update` zeroes them at the
      // very end of the frame either way (main.js:385, after every lateUpdate),
      // so the free camera has already read them.
      if (this.ctx.input) this.ctx.input.suppressed = true;
      // Snap the camp placement ring off now, before the pause below freezes
      // every world system at dt 0. Camp.js already stops drawing it once
      // `photo.active` is true, but that check only ever runs again once
      // paused — by then its fade-out lerp has nothing to lerp with, so a
      // ring still fading in when F was pressed would otherwise hang lit at
      // whatever opacity it had that frame, in every photo taken this visit.
      this.ctx.systems?.camp?.reticle?.hide?.();
      // The world holds still while you compose — all of it, not just the sun.
      // `worldPaused` makes main.js drive every world system with dt 0 and a
      // stopped world clock, so wildlife, water, weather, the camper and every
      // shader-time animation freeze mid-frame while the camera rig, the
      // music and this rail keep running on real time (see the world-pause
      // note in main.js). The lighting line below is now redundant with the
      // pause — a frozen clock cannot advance the hour — but it stays: it is
      // what the exit path restores, and it keeps the sun still even if the
      // pause ever becomes partial.
      this.ctx.worldPaused = true;
      if (this.ctx.lighting) this.ctx.lighting.cycleSpeed = 0;
      // ── full resolution, for as long as the mode is open ──────────────────
      // In play the scene is drawn well under the display's pixel density: the
      // tier's `pixelRatioCap` and the adaptive scaler's preferred rung
      // multiply, and on a Retina panel the product is around 39% of the
      // screen's pixels. That is a defensible trade at 60 fps and the wrong one
      // here — this is the mode whose entire output is a still image, the
      // sun is already stopped, and nothing in frame is moving to hide the
      // softness. Thin high-frequency geometry (a tripod, a chair frame, a
      // radiator grille) is exactly what undersampling destroys and exactly
      // what a player frames a photograph on.
      //
      // `setResolutionPin` also switches the adaptive scaler off while it is
      // held, so a heavy vista cannot walk the resolution back down midway
      // through composing a shot.
      //
      // The saved PNG comes with it: `capture` reads the drawing buffer, which
      // is now the display's native size.
      //
      // It costs a drawing-buffer reallocation on the way in and another on the
      // way out — measured at 450-2500 ms on ANGLE/Metal. That is a real hitch
      // and it is spent in the right place: a deliberate mode change that
      // already cuts the camera, takes the HUD away and plays a door sound,
      // rather than anywhere during driving.
      this.ctx.engine?.setResolutionPin?.(this.ctx.engine.nativePixelRatio());
      // After `enterFree` (it seeds its first guess from the rig's own distance)
      // and after the resolution pin (so the first depth read is taken at the
      // size the mode will actually run at).
      this.focus.enable();
      // Fit whatever lens was last on the body. Done here rather than in the
      // constructor because the rig only owns the fov once free mode has it.
      const rig0 = this.ctx.systems?.cameraRig;
      if (rig0) rig0.fov = cameraFovForFocal(this.lens.focal, this.ctx.camera.aspect);
      this._fitAperture();
      this.hourEl.set(this._saved.hour);
      this.expEl.set(this._saved.exposure);
      this.colEl.set(this._saved.saturation);
      this.hud.audio()?.cue('door');
      void this.node.offsetWidth;      // see the note in hud_settings.setOpen
      this.controls[0]?.focus({ preventScroll: true });
    } else {
      // Before the grade is restored below: `disable()` puts PostFX's pass list
      // back, and doing that after the exposure/saturation writes would hand
      // those values to a chain that is about to be rebuilt underneath them.
      this.focus.disable();
      const s = this._saved;
      if (s) {
        this._setExposure(s.exposure);
        this._setSaturation(s.saturation);
        if (this.ctx.lighting) {
          this.ctx.lighting.hour = s.hour;
          this.ctx.lighting.cycleSpeed = s.cycle;
        }
        // Back to exactly what was running: a manual pin the player had set, or
        // a non-finite value, which hands the lever back to the adaptive
        // scaler. HUD.renderPin and its stored setting were never touched — the
        // override lives and dies inside this mode.
        this.ctx.engine?.setResolutionPin?.(s.resolutionPin ?? NaN);
        // Back to whatever camera was driving before — as a cut, which is what
        // `exitFree` does. `s.mode` is read rather than trusted to the rig's
        // own memory of it so a mode changed while photo mode was open (it
        // cannot be today; C is locked out in free mode) still loses to what
        // the player actually had.
        if (rig) rig.fov = s.fov;
        rig?.exitFree?.(s.mode === 'free' ? 'chase' : s.mode);
      }
      this._saved = null;
      if (this.node.contains(document.activeElement)) document.activeElement.blur();
    }
  }

  /**
   * The lens keys, in one place so the rail and the HUD can share them.
   *
   * `[`/`]` walk the ring and `L` swaps the body. The wheel is deliberately NOT
   * one of them: bare wheel is the free camera's dolly and has been since photo
   * mode existed, shift+wheel is the focus the player was promised, and
   * alt+wheel is the aperture. A fourth wheel gesture would be a modifier
   * nobody could remember.
   *
   * Returns true if the key was ours.
   */
  lensKey(code) {
    if (code === 'BracketRight') { this.lens.zoom(1); return true; }
    if (code === 'BracketLeft') { this.lens.zoom(-1); return true; }
    if (code === 'KeyL') { this.lens.cycle(1); return true; }
    return false;
  }

  /**
   * A lens cannot open wider than it opens.
   *
   * `PhotoFocus` owns the aperture and offers f/1.4 to f/22 because that is the
   * range the blur maths covers. The bag disagrees: the 24-70 is an f/2.8 and
   * the 200-400 an f/4, so leaving the two unconnected let the rail advertise
   * f/1.4 on a lens whose front element is stopped a stop and a half down —
   * a number no photographer would believe and, worse, one that produced a
   * different picture from the same nominal setting on each body.
   *
   * Clamped rather than reset: a player who was at f/11 on the wide should
   * still be at f/11 after fitting the tele, because that is the setting they
   * chose. Only an impossible value moves.
   */
  _fitAperture() {
    const stops = stopsFor(this.lens.lens);
    if (!stops.length || !this.focus) return;
    const now = this.focus.fStop;
    const capped = Math.min(Math.max(now, stops[0]), stops[stops.length - 1]);
    if (Math.abs(capped - now) > 1e-6) this.focus.setAperture(capped);
  }

  _paintLens() {
    if (this.lensLabel) this.lensLabel.firstChild.textContent = this.lens.label();
  }

  /** Real seconds, from HUD.update — the rail runs while the world is frozen. */
  update(dt) {
    this.focus?.update(dt);
    this.lensPreview?.update(dt);
  }

  toggleGrid() {
    this.grid = !this.grid;
    this.gridNode.classList.toggle('pa-on', this.grid);
  }

  /**
   * Write a PNG of exactly what is on screen.
   *
   * The extra render is not waste: without it the drawing buffer has already
   * been presented and cleared, and every saved photo comes out transparent.
   */
  capture() {
    const canvas = this.ctx.renderer?.domElement;
    if (!canvas) return false;

    // Render, check, then read — up to three times.
    //
    // One full-resolution capture in testing came back as a 31 KB PNG where
    // every other one was 2.5 MB: the forced render landed while the composer
    // was between buffers and produced a near-empty frame. The player only
    // finds out about that when they open the file, so the frame is inspected
    // before it is written. The 64x36 probe has to happen in the same task as
    // the render, for the same reason toDataURL does — the drawing buffer is
    // gone by the next one.
    let url = null;
    let thumb = null;
    for (let attempt = 0; attempt < 3 && !url; attempt++) {
      try {
        this.ctx.postfx?.render?.(1 / 60);
        const c = this._probeCanvas ??= document.createElement('canvas');
        c.width = 64; c.height = 36;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(canvas, 0, 0, 64, 36);
        const d = g.getImageData(0, 0, 64, 36).data;
        let sum = 0, sumSq = 0;
        for (let i = 0; i < d.length; i += 4) {
          const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
          sum += l; sumSq += l * l;
        }
        const n = d.length / 4;
        const mean = sum / n;
        const varr = sumSq / n - mean * mean;
        // A real frame of this game is bright and has structure. Both tests
        // matter: a black frame fails the first, a flat wash fails the second.
        if (mean < 6 || varr < 4) continue;
        url = canvas.toDataURL('image/png');
        // The journal's copy, taken in the SAME task as the read above and for
        // exactly the same reason: one turn of the event loop later the drawing
        // buffer has been presented and cleared, and the book would be handed a
        // transparent rectangle. (That is the shape of the bug that produced the
        // black print in the journal's own harness shots.)
        //
        // 512 on the long edge is hunt_store's budget, not a guess: a photo here
        // is written at the display's native density and runs to megabytes,
        // while localStorage holds about five in total for the whole origin.
        thumb = this._thumbCanvas ??= document.createElement('canvas');
        const k = 512 / Math.max(canvas.width, canvas.height, 1);
        thumb.width = Math.max(1, Math.round(canvas.width * k));
        thumb.height = Math.max(1, Math.round(canvas.height * k));
        thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
      } catch (e) {
        console.warn('[hud] photo failed', e);
      }
    }
    if (!url || url.length < 2048) { this.hud.toast('Could not save photo'); return false; }

    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const name = `procedural-autumn-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
                 `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();

    this.flash.classList.remove('pa-fire');
    void this.flash.offsetWidth;           // restart the animation
    this.flash.classList.add('pa-fire');
    this.hud.audio()?.cue('shutter');
    this.hud.toast('Photo saved');
    // The one line in this tree that writes to the logbook from outside
    // src/game/Stats.js. Everything else there is derived by watching a system;
    // a saved photo leaves nothing behind to watch, and nothing to hook.
    stats.add('photo.taken');
    this.lastPhotoBytes = url.length;
    posthog.capture('photo_taken', {
      file_size_bytes: url.length,
      grid_visible: this.grid,
      hour_of_day: this.ctx.lighting?.hour ?? null,
    });

    // ── the scavenger hunt ───────────────────────────────────────────────────
    //
    // Last, and wrapped, and in that order deliberately. By the time this runs
    // the player's photograph is already written to disk; nothing the hunt does
    // is worth losing it to. `detectSubjects` promises never to throw and
    // `hunt.award` swallows a full localStorage — this is the belt to those
    // braces, because a shutter that dies is the worst bug this file could have.
    //
    // `award` returns true only the first time an item is ticked, so it is both
    // the write and the "is this news?" test. Everything found is ticked; only
    // the FIRST new one opens the book. Two subjects can genuinely share a frame
    // — a deer at a waterfall — and two ceremonies queued behind one shutter
    // press is a great deal of theatre to sit through. The second line is
    // crossed off just the same; the player finds it there next time they look.
    try {
      let award = null;
      for (const id of detectSubjects(this.ctx)) {
        if (hunt.award(id, thumb) && !award) award = { id, photoDataURL: hunt.photoFor(id) };
      }
      if (award) this.hud.openJournal(award);
    } catch (e) {
      console.warn('[hunt] check failed', e);
    }
    return true;
  }
}
