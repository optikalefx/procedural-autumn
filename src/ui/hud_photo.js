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
//   · takes the HUD away, leaving four corner brackets
//   · works from inside the camp's two modal views, and from a boat. All
//     three hold CameraRig's takeover, which outranks free mode, so all three
//     are told to let go where they stand before `enterFree` reads the camera.
//     The telescope hides its tube (the camera is inside it); the fireside
//     stands its stick in the world and pauses the cook, so the marshmallow the
//     player pressed F on is still over the fire to be photographed; the boat
//     hides nothing, because the hull you are sitting in is part of the shot.
//     See `ScopeView.handOff`, `RoastView.handOff` and `Boat.handOff`, and the
//     three calls in `setActive`.
//   · gives the controls a camera has, grouped the way a camera groups them —
//     see "the camera back" below
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
//
//  ── the camera back ─────────────────────────────────────────────────────────
//
//  What this rail used to be: one horizontal row holding three sliders, a 3D
//  lens preview, a round shutter and a TEN-LINE COLUMN OF KEYBOARD HINTS —
//  drag look / middle-drag move / wheel zoom / shift+wheel focus / shift+click
//  a subject / alt+wheel aperture / [ ] zoom ring / L change lens / P save /
//  G grid / J book / F exit. The focus readout floated separately above it and
//  auto-hid. The player's verdict, and it is the right one: *"The camera UI is
//  not good. Too many hidden options. and the UI looks weird. Fix the layout to
//  make more sense. And don't hide the info bar that says the aperture and
//  stuff."*
//
//  Three faults, and they are separable:
//
//   1. THE REAL CONTROLS WERE MODIFIER CHORDS. Focus, aperture and the zoom
//      ring existed only as gestures printed in a list. A control you can only
//      find by reading a legend is not discoverable, and on a phone a chord is
//      not a control at all. Every one of them now has a slider or a button.
//      The chords still work — they are accelerators for visible controls now,
//      which is the only honest way to have both.
//   2. IT WAS A ROW OF UNRELATED THINGS. A slider for the time of day, a
//      picture of a lens and a shutter button share a strip of screen and
//      nothing else. So the rail is now three GROUPS in the order a
//      photographer would name them, each captioned:
//
//        LENS   the preview, the body it shows, and the three rings that turn
//               on it — zoom, aperture, focus (plus AF, which is what
//               shift+click always was)
//        LIGHT  the hour, the exposure and the colour: the things about the
//               world and the print rather than about the camera
//        (verbs) the shutter, and time / book / exit under it
//
//      They are the same order as the readout's cells, deliberately: the panel
//      names lens, focal, aperture, focus and the sliders underneath are zoom,
//      aperture, focus. A number and the control that moves it are in the same
//      column of the eye.
//   3. THE INSTRUMENT PANEL HID. It is the top row of the rail now and it never
//      goes away. It is also the reason the three lens sliders print no numbers
//      of their own: every value they set is already up there, larger, with a
//      label under it. Printing them twice is what made the old strip read as
//      clutter. The LIGHT sliders do print theirs, because nothing else does.
//
//  ── T, and the world it stops ───────────────────────────────────────────────
//
//  The third verb chip used to be a rule-of-thirds grid. It is a clock now, and
//  the trade is not a close call. The grid was a drawing over the frame that a
//  photographer composes past in about a second; what the mode could not do at
//  all was LET GO. Photo mode freezes the world on entry — that is what makes a
//  still of a running river possible — and until now that freeze was the only
//  thing on offer. You could not wait for a deer to walk into the light, or let
//  the wind take the aspens, or watch the fireflies come up, because the moment
//  you pressed F the world stopped being a world.
//
//  So T hands it back and takes it again without leaving the camera. It is one
//  write to `ctx.worldPaused`, which main.js reads to drive every world system
//  at dt 0 against a stopped world clock (see the world-pause note there), so
//  resuming continues from the pose everything froze in rather than snapping to
//  wherever the wall clock went. Entry is still frozen — that is the shape of
//  the mode and what most shots want — and both exit paths reset it, so a world
//  left running cannot leak back into play.
//
//  Two things are deliberately NOT part of it:
//
//   · THE DRIVING CONTROLS. `input.suppressed` stays up for the whole visit.
//     Running the world is about the subject moving, not about the player
//     driving the camper out of a frame they are composing — the very defect
//     the suppression was added for.
//   · THE SUN. `lighting.cycleSpeed` stays 0 whether the world is running or
//     not, because the LIGHT group's Hour dial is what owns the sun while the
//     rail is open. That dial is painted once, on entry; a day cycle advancing
//     underneath it would make it lie within a few seconds.
//
//  `PhotoFocus` owns that panel's contents and this file owns where it sits —
//  it is handed a `slot` rather than positioning itself, which is what killed
//  the old arrangement where this file's stylesheet and `hud.css` both had an
//  opinion about one strip of screen and drifted apart.
// ─────────────────────────────────────────────────────────────────────────────
import { el, button } from './hud_dom.js';
import { stats } from '../game/stats_store.js';
import { PhotoFocus } from '../photo/photo_focus.js';
import { detectSubjects } from '../game/hunt_detect.js';
import { hunt, THUMB_MAX } from '../game/hunt_store.js';
import { LensKit, LensPreview, LENSES, lensById, cameraFovForFocal, focalForCameraFov, stopsFor }
  from '../photo/lens_models.js';
import { touchCapable } from '../core/verbs.js';
import { posthog } from '../posthog.js';

const RANGES = {
  hour: [0, 24, 0.05],
  exposure: [0.55, 1.9, 0.01],
  colour: [0.45, 1.5, 0.01],
};

// The verb glyphs this rail needs and `hud_dom.ICON` does not carry. Same
// construction as that set — strokes, not fills, because a filled glyph at the
// fourteen pixels a chip draws at turns into a dot — and kept here rather than
// pushed into the shared set because nothing outside photo mode wants a
// contact sheet or a lens-swap arrow.
const S = (d) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" ' +
  `stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const GLYPH = {
  // A clock: the world running, or held. Lit when it is running.
  time: S('<circle cx="12" cy="12" r="8.6"/><path d="M12 6.9V12l3.4 2.3"/>'),
  // The journal, seen from the spine side: a cover and the block of pages.
  book: S('<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v14H6.5A1.5 1.5 0 0 0 5 18.5z"/>' +
          '<path d="M5 18.5A1.5 1.5 0 0 1 6.5 17H19v4H6.5A1.5 1.5 0 0 1 5 19.5z"/>'),
  // Out of the frame.
  exit: S('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  // Two lenses trading places on the mount.
  swap: S('<path d="M4 8.5h13M14.2 5.3l3.3 3.2-3.3 3.2"/>' +
          '<path d="M20 15.5H7M9.8 12.3l-3.3 3.2 3.3 3.2"/>'),
  // A panel against the edge with an arrow into it. Drawn pointing LEFT because
  // that is the way it goes; the button flips it with a CSS rotation when the
  // panel is away, so the glyph always points the direction the click moves it.
  stow: S('<path d="M4.5 4.5v15"/><path d="M20 12H9"/><path d="M12.6 8.4 9 12l3.6 3.6"/>'),
};

export class PhotoMode {
  constructor(root, hud) {
    this.hud = hud;
    this.ctx = hud.ctx;
    this.active = false;
    // The world is stopped on entry, every time — see "T, and the world it
    // stops" in the header. `setActive` re-asserts it rather than trusting this.
    this.running = false;
    this.stowed = false;
    this._saved = null;

    this.node = el('div', 'pa-photo-frame');
    for (const c of ['tl', 'tr', 'bl', 'br']) this.node.appendChild(el('div', `pa-bracket ${c}`));
    this.flash = el('div', 'pa-flash');
    this.node.appendChild(this.flash);

    const rail = el('div', 'pa-rail pa-panel');
    rail.setAttribute('role', 'group');
    rail.setAttribute('aria-label', 'Photo controls');

    // ── row one: the instrument panel ───────────────────────────────────────
    // Always on. `PhotoFocus` fills it; this file only says where it goes. See
    // "the camera back" in the header, and `photo_focus.js`'s own note on why
    // a panel that positioned itself was a defect rather than an independence.
    // ── get out of the way ──────────────────────────────────────────────────
    //
    // The panel is a camera back and a camera back is opaque, so on a wide shot
    // it sits over the bottom third of the composition — which is exactly where
    // a horizon or a foreground usually is. This slides it off the LEFT edge and
    // leaves a tab.
    //
    // Top-right of the panel is where the button goes, and that is not a taste
    // call: sliding left means the panel's RIGHT edge is the part still on
    // screen, so a control in that corner is the one thing guaranteed to still
    // be reachable when it is away. A button anywhere else would hide itself.
    this.stowBtn = button('pa-cam-stow', GLYPH.stow, () => this.toggleStow(),
      'Hide the controls');
    rail.appendChild(this.stowBtn);

    this.readoutSlot = el('div', 'pa-cam-readout');
    rail.appendChild(this.readoutSlot);

    // The lens. It binds its own capture-phase wheel/pointer listeners in
    // `enable()` and removes them in `disable()`, which is also how it takes
    // shift+wheel away from the free camera's dolly without either of them
    // knowing about the other: Input's wheel listener is bubble-phase, so a
    // modified wheel is consumed before it ever gets there.
    //
    // `barrel` is how the panel can print a lens it knows nothing about;
    // `onChange` is how a wheel gesture moves the sliders that set the same
    // numbers, so the two controls can never disagree on screen.
    this.focus = new PhotoFocus(this.ctx, {
      root,
      slot: this.readoutSlot,
      barrel: () => ({ name: this.lens.lens.name, focal: this.lens.focal }),
      onChange: () => this._syncLens({ readout: false }),
    });

    // ── the lens ────────────────────────────────────────────────────────────
    // Two bodies, one ring per body. `LensKit.zoom` walks the FITTED lens and
    // stops at its own limits; crossing the 70-200 gap is `L` or the swap
    // button and nothing else. It used to cross the gap by itself after a
    // banked detent of resistance — see the `LensKit` header for why that is
    // gone and `_ring` below for what happens at the stop instead.
    //
    // The camera lever is `rig.fov`, NOT `camera.fov`: CameraRig._apply writes
    // the camera's fov from its own every frame (`_apply`, near line 887), so
    // anything written straight onto the camera is gone by the next frame.
    // And it is the VERTICAL angle, which is what three.js means by fov and is
    // not what a lens is specified in — `cameraFovForFocal` does that
    // conversion against the live aspect.
    this.lens = new LensKit({
      onChange: ({ reason }) => {
        // The ring moved, so whatever the barrel was pressed up against, it is
        // not pressed up against it now. `_ring` reads this to decide whether
        // the toast would be news or nagging. First line in the handler: the
        // `_fitting` guard below returns early and the fit is exactly the case
        // that has to clear it.
        this._atStop = 0;
        const rig = this.ctx.systems?.cameraRig;
        if (rig) rig.fov = cameraFovForFocal(this.lens.focal, this.ctx.camera.aspect);
        this.lensPreview?.setZoomT(this.lens.t);
        this.lensPreview?.setLens(this.lens.lens.id);
        this._fitAperture();
        this._fitDolly();
        this._syncLens();
        // Changing a lens is not the same act as turning a ring, so it does not
        // get the same sound. `select` is the heavier of the two UI voices.
        // Silent while this file is fitting the lens on the way in: that is not
        // the player turning anything. Without the guard, entering photo mode
        // announced itself as a lens change ("select, door") — and re-entering
        // after a walk to the tele announced a swap the player did not make.
        if (this._fitting) return;
        this.hud.audio()?.cue(reason === 'swap' ? 'select' : 'tick');
      },
    });

    // ── the aperture belongs to two owners, so it is wrapped ────────────────
    //
    // `PhotoFocus` owns the ring and clamps to its own ladder, f/1.4 to f/22,
    // which is the range its blur maths covers and knows nothing about what is
    // on the front of the camera. The bag disagrees: the 24-70 is an f/2.8 and
    // the 200-400 an f/4. Fitting the aperture only when the LENS changed left
    // the real control — alt+wheel — untouched, so four notches opened the
    // 200-400 to f/1.4 while the label beside it still read f/4: two numbers on
    // screen contradicting each other.
    //
    // Wrapped rather than edited, and not owned by this file either way: the
    // same technique `Stats._water` uses on `Boat.onStroke`, and for the same
    // reason — one file breaks if the other changes shape, and it is this one.
    const rawNudge = this.focus.nudgeAperture.bind(this.focus);
    this.focus.nudgeAperture = (steps) => { rawNudge(steps); this._fitAperture(); this._syncLens(); };
    const rawSet = this.focus.setAperture.bind(this.focus);
    this.focus.setAperture = (f) => { rawSet(this._lensStop(f)); this._syncLens(); };

    // ── row two: the desk ───────────────────────────────────────────────────
    const desk = el('div', 'pa-cam-desk');
    rail.appendChild(desk);

    // ── group one: the lens, and the three rings that turn on it ────────────
    const gLens = this._group(desk, 'Lens');
    const bay = el('div', 'pa-cam-bay');
    gLens.appendChild(bay);

    // The row exists from the start; the RENDERER inside it does not. Two
    // reasons, and the second one is the serious one:
    //
    //  · a second WebGL context is not free, and photo mode may never be opened
    //    at all — so it is taken on the first F, not at boot;
    //  · a second WebGL context is also refusable. `LensPreview` handles that
    //    honestly — it returns with `ok === false` and NO `canvas` property —
    //    and the first cut of this appended `this.lensPreview.canvas`
    //    unguarded. On a device that refuses the context that is a TypeError
    //    thrown inside PhotoMode's constructor, inside HUD's constructor, and
    //    the player gets NO INTERFACE AT ALL, at boot, without ever pressing F.
    //    This game ships touch controls; phones are exactly where a second
    //    context gets refused. The label alone is the fallback.
    this.lensRow = el('div', 'pa-lens');
    // The plate under the barrel names the BODY and nothing else. It used to
    // print the live focal length and stop as well — correctly, against a
    // `LensKit.label()` that printed the barrel's engraved maximum aperture and
    // contradicted the readout. Both numbers are cells in the instrument panel
    // now, so a second copy of them four centimetres lower is the clutter this
    // redesign is about. What is left is a caption for the picture above it,
    // and the fallback if the preview's GL context is refused.
    const foot = el('div', 'pa-cam-foot');
    this.lensLabel = el('div', 'pa-label pa-lens-label', '<span></span>');
    foot.appendChild(this.lensLabel);
    this.swapBtn = this._verb(foot, 'swap', 'Change lens', 'L',
      () => this.lens.cycle(1), 'Swap');
    this.lensRow.appendChild(foot);
    bay.appendChild(this.lensRow);

    // Three rings, in the order the panel above prints them — focal, aperture,
    // focus — so the number and the control that moves it line up down the
    // screen. None of them prints its own value: see fault 3 in the header.
    const rings = el('div', 'pa-cam-rings');
    bay.appendChild(rings);
    this.zoomEl = this._dial(rings, 'Zoom', {
      min: 0, max: 1, step: 0.002, hint: '[ ]',
      onInput: (v) => this.lens.setT(v),
    });
    this.apEl = this._dial(rings, 'Aperture', {
      min: 0, max: 8, step: 1, hint: 'alt+wheel',
      onInput: (i) => {
        const stops = stopsFor(this.lens.lens);
        this.focus.setAperture(stops[Math.min(stops.length - 1, Math.max(0, Math.round(i)))]);
      },
    });
    // Log-spaced, like the wheel gesture it stands in for: the dial spans NEAR
    // to several kilometres, and a linear track would give the whole near field
    // — every subject a person actually photographs — about one pixel.
    this.focusEl = this._dial(rings, 'Focus', {
      min: 0, max: 1, step: 0.001, hint: 'shift+wheel',
      onInput: (t) => {
        const n = this.focus.near, r = Math.max(n * 1.01, this.focus.reach);
        this.focus.setDistance(n * Math.pow(r / n, t));
      },
      // Autofocus. This is shift+click without the shift and without the click
      // landing anywhere in particular — the same `focusAt(0.5, 0.5)` the mode
      // runs on entry — and it is the only one of these controls that a phone
      // could not otherwise reach at all.
      verb: ['AF', 'Focus on the centre of the frame', '', () => this.focus.focusAtCentre()],
    });

    // ── group two: the light ────────────────────────────────────────────────
    const gLight = this._group(desk, 'Light');
    this.hourEl = this._dial(gLight, 'Hour', {
      ...this._range('hour'), fmt: (v) => this._fmtHour(v), onInput: (v) => this.hud.applyHour(v),
    });
    this.expEl = this._dial(gLight, 'Exposure', {
      ...this._range('exposure'), fmt: (v) => v.toFixed(2), onInput: (v) => this._setExposure(v),
    });
    this.colEl = this._dial(gLight, 'Colour', {
      ...this._range('colour'), fmt: (v) => v.toFixed(2), onInput: (v) => this._setSaturation(v),
    });

    // ── group three: the verbs ──────────────────────────────────────────────
    const gVerbs = el('div', 'pa-cam-group pa-cam-verbs');
    desk.appendChild(gVerbs);
    this.shutterBtn = button('pa-shutter', '', () => this.capture(), 'Take photo');
    const shutterWrap = el('div', 'pa-cam-verb pa-cam-verb-shutter');
    shutterWrap.appendChild(this.shutterBtn);
    shutterWrap.appendChild(this._cap('Shoot', 'P'));
    gVerbs.appendChild(shutterWrap);
    const small = el('div', 'pa-cam-verb-row');
    gVerbs.appendChild(small);
    // The label is set by `_paintTime`, which is the only thing that knows
    // which way the toggle is pointing; what is passed here is just the caption
    // and the key, and both are constant.
    this.timeBtn = this._verb(small, 'time', 'Let the world run', 'T', () => this.toggleTime(), 'Time');
    this._verb(small, 'book', 'Open the journal', 'J', () => this.hud.toggleJournal(), 'Book');
    this._verb(small, 'exit', 'Leave photo mode', 'F', () => this.hud.togglePhoto(), 'Exit');

    // ── the only hints left ─────────────────────────────────────────────────
    // Three pointer verbs, on one wrapping line. Everything else that used to
    // be in the ten-line column is a labelled control a few pixels above this,
    // and these three are here because the free camera has no slider — moving
    // the camera is a gesture, not a dial. Gone entirely where there is no
    // mouse to make the gesture with.
    if (!touchCapable()) {
      rail.appendChild(el('div', 'pa-cam-gestures',
        '<span><b>drag</b> look</span><span><b>middle-drag</b> move</span>' +
        '<span><b>wheel</b> dolly</span>' +
        // The one control with no dial of its own: AF focuses the CENTRE, and
        // this focuses whatever you point at, which is the thing a photographer
        // actually wants and was nowhere on screen.
        '<span><b>shift+click</b> focus there</span>'));
    }
    this.node.appendChild(rail);
    this.rail = rail;
    this._syncLens();
    // So `aria-pressed` is right before the mode is ever opened. `_verb` set the
    // title and the label from what was passed to it; only this knows the state.
    this._paintTime();

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
      // P and T need the same local path, for the same reason F does: focus
      // lands on this rail's first control the moment photo mode opens (see
      // `.focus()` below), and every key typed there is swallowed by the
      // `stopPropagation()` a few lines down before it can reach HUD's own
      // `KeyP`/`KeyT` cases — which never fire because HUD._onKey already
      // ignores keys whose target is inside its root. Without this, the
      // shutter hint on screen ("P save") is a lie until the player clicks
      // somewhere else first.
      if (e.code === 'KeyP') { this.capture(); e.preventDefault(); return; }
      if (e.code === 'KeyT') { this.toggleTime(); e.preventDefault(); return; }
      // And J, which was never here and was advertised anyway. `HUD._onKey`
      // ignores keys whose target is inside its root and the `stopPropagation`
      // below eats the rest, so from the moment the rail took focus the old
      // hint column's "J book" was simply false.
      if (e.code === 'KeyJ') { this.hud.toggleJournal(); e.preventDefault(); return; }
      if (this.lensKey(e.code)) { e.preventDefault(); return; }
      e.stopPropagation();
    });
    rail.addEventListener('keyup', (e) => e.stopPropagation());

    // The offset is measured, so it is wrong the moment the viewport changes
    // shape. Only while the mode is open and only while stowed — `_placeStow`
    // returns immediately otherwise.
    this._onResize = () => { if (this.active) this._placeStow(); };
    window.addEventListener('resize', this._onResize);

    root.appendChild(this.node);
  }

  // ── rail construction ──────────────────────────────────────────────────────

  /** One captioned group on the desk. The caption is the whole point. */
  _group(desk, name) {
    const g = el('div', 'pa-cam-group');
    g.appendChild(el('div', 'pa-cam-title', name));
    desk.appendChild(g);
    return g;
  }

  _range(key) {
    const [min, max, step] = RANGES[key];
    return { min, max, step };
  }

  /**
   * One labelled slider.
   *
   * `fmt` is optional and its absence is a decision, not a shortcut: the three
   * lens rings set numbers the instrument panel is already printing, larger,
   * with a label under each, and printing them twice is what made the old rail
   * read as clutter. The LIGHT dials pass one, because nothing else says what
   * hour it is.
   *
   * `hint` is the chord that does the same thing for someone who knows it. It
   * goes in the tooltip rather than on screen — a legend of chords next to the
   * controls those chords duplicate is a second, worse copy of the interface.
   *
   * `verb` optionally hangs a chip off the right of the track (`[glyph, label,
   * key, onClick]`) — AF, which is the only lens control with no continuous
   * axis to sit on.
   */
  _dial(parent, name, o) {
    const wrap = el('div', 'pa-cam-dial');
    const label = el('div', 'pa-label', `<span>${name}</span><span></span>`);
    const val = label.lastChild;
    const input = el('input');
    input.type = 'range';
    input.min = o.min; input.max = o.max; input.step = o.step;
    input.setAttribute('aria-label', name);
    // The chord, PRINTED — not just a tooltip.
    //
    // These three dials deliberately print no value (the instrument panel above
    // prints all three, larger), which left the right-hand half of every one of
    // their labels blank. The chords were going into `input.title`, i.e. a
    // tooltip you have to know to hover for — so the redesign that removed the
    // ten-line legend took shift+wheel and alt+wheel off the screen entirely
    // and the mode stopped teaching its own controls. The blank half of the
    // label is exactly the right size for them and costs no layout.
    //
    // A dial that DOES print a value keeps it — Hour and Exposure have no chord
    // anyway — and a touch device gets neither, because there is no modifier
    // key to press.
    if (o.hint && !touchCapable() && !o.fmt) {
      val.textContent = o.hint;
      val.classList.add('pa-cam-chord');
    } else if (o.hint && !touchCapable()) {
      input.title = `${name} — ${o.hint}`;
    }
    const paint = () => {
      const min = +input.min, max = +input.max;
      if (o.fmt) val.textContent = o.fmt(+input.value);
      input.style.setProperty('--fill', `${((+input.value - min) / Math.max(1e-6, max - min)) * 100}%`);
    };
    input.addEventListener('input', () => { o.onInput(+input.value); paint(); });
    wrap.appendChild(label);
    const track = el('div', 'pa-cam-track');
    track.appendChild(input);
    if (o.verb) this._verb(track, ...o.verb);
    wrap.appendChild(track);
    parent.appendChild(wrap);
    return {
      input,
      paint,
      set: (v) => { input.value = v; paint(); },
      /** The aperture ladder is a different length on each body. */
      span: (max) => { input.max = max; paint(); },
    };
  }

  /**
   * A round chip with a caption under it — the word for what it does, and,
   * where there is a keyboard, the key it answers to.
   *
   * The caption is what let the ten-line legend go. "TIME T" under a picture of
   * a clock is the same information the legend carried, attached to the thing it
   * is about instead of listed six lines away from it, and it costs one short
   * word. On a touch device the key is simply absent: there is nothing to press
   * and a legend that names one is a legend that lies.
   *
   * `glyph` is a key into `GLYPH`, or its own text for a chip that is better as
   * two letters than as a drawing — AF being the only one, because there is no
   * icon for "autofocus" that anybody would read as autofocus.
   */
  _verb(parent, glyph, label, key, onClick, caption = '') {
    const wrap = el('div', 'pa-cam-verb');
    const art = GLYPH[glyph];
    const b = button(art ? 'pa-chip' : 'pa-chip pa-chip-text', art ?? glyph, onClick,
      key ? `${label} (${key})` : label);
    b.title = key && !touchCapable() ? `${label} (${key})` : label;
    wrap.appendChild(b);
    if (caption) wrap.appendChild(this._cap(caption, key));
    parent.appendChild(wrap);
    return b;
  }

  _cap(word, key) {
    return el('div', 'pa-label pa-cam-verb-cap',
      `${word}${key && !touchCapable() ? ` <b>${key}</b>` : ''}`);
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
      // Raised by `_fitDolly` for a long lens; the chase boom wants its own.
      freeDistMax: this.ctx.systems?.cameraRig?.freeDistMax ?? 68,
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
      this._releaseTime();
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
      // …and the boat takes its mounted camera back, as a cut. Same placement
      // and the same reason as the fireside above: the ride camera retakes the
      // rig, so whatever mode `exitFree` selects below is moot while the boat
      // has it, and doing it the other way round would show one frame of chase
      // camera behind the CAMPER — which, aboard, is most of a lake away. See
      // `Boat.endHandOff`.
      this.ctx.systems?.boat?.endHandOff?.();
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
      //
      // The RETURN VALUE is the sample, and taking it here is the only place it
      // can be taken. `handOff()` gives back the telescope it released, or null
      // if no eyepiece was open; one line later `scope.active` is false because
      // this call is what made it false. Anything that asks afterwards gets
      // "no" every time. It is read at the bottom of this branch, where the
      // lens is fitted — see there for what it does with it.
      const fromScope = !!this.ctx.systems?.camp?.scope?.handOff?.();
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
      // …and from a boat, which holds the rig's takeover for the whole ride
      // (`Boat.board`). Aboard, the mounted ride camera outranked free mode
      // exactly the way the eyepiece does, and photo mode opened over three
      // dead controls: the zoom ring wrote `rig.fov` with nothing left to
      // apply it, middle-drag pan did nothing at all, and the ride camera
      // dragged every composed shot back over the bow two seconds after the
      // player let go of the mouse (user, 2026-08-29). Same fix, same
      // ordering, same reason — `Boat.handOff` has the full account.
      this.ctx.systems?.boat?.handOff?.();
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
      // note in main.js).
      //
      // Frozen on ENTRY, always, and only on entry: T hands the world back and
      // takes it again for as long as the rail is open. Re-asserted here rather
      // than left to the constructor's initial value, so a visit that ended with
      // the world running cannot open the next one live.
      this.setTime(false);
      // The sun, held separately, and NOT released by T. This used to be
      // redundant with the pause — a frozen clock cannot advance the hour — and
      // it is load-bearing now that the clock can be started again: the Hour
      // dial two groups over is painted once, on entry, and a day cycle running
      // underneath it would make it lie within a few seconds. The exit path
      // restores whatever speed the player actually had.
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
      // ── the lens, fitted to the frame you pressed F on ────────────────────
      //
      // This file's header promises "the frame the player pressed F on is the
      // frame they get to compose from". Fitting the kit's REMEMBERED focal
      // broke that promise the moment lenses existed: the chase camera is a
      // 22 mm-equivalent and the kit opens at 35, so pressing F cropped the
      // view by a third before the player had touched anything. So the ring is
      // fitted to the camera instead, and the wide end of the wide lens is the
      // closest a 24 mm barrel can get to 22 — a few degrees, against a third
      // of the frame.
      // Fit the BODY as well as the ring. Fitting only the focal clamps it into
      // whatever lens happened to be on, so leaving photo mode at 272 mm and
      // pressing F again opened at 200 mm — a five-degree view of an orange
      // smear — and silently threw away the ring position too. Pick the lens
      // whose barrel actually contains the frame on screen, then set the ring
      // inside it.
      //
      // ── except from the telescope, where the BODY is chosen for you ───────
      //
      // "if you're going into photo mode from the telescope you should
      // automatically be in the telephoto lens." That is a direct conflict with
      // the fov rule two paragraphs up, so which wins has to be written down.
      //
      // THE TELESCOPE WINS, and only over the body. The eyepiece rests at an
      // 18° vertical fov, which off a 36 mm frame at 16:9 is a 64 mm lens — so
      // the rule as written fits the 24-70 and hands the player the
      // general-purpose zoom at the exact moment they walked to an instrument
      // for reach. That is the complaint. The counter-argument, that the frame
      // must not change, is weaker here than anywhere else in the mode: you
      // were not composing through the camera at the eyepiece, you were looking
      // down a tube, and `enterFree` still reproduces the position, the bearing
      // and therefore the SUBJECT exactly. All that moves is the crop, and it
      // tightens onto the thing the telescope was already pointed at.
      //
      // The ring is still fitted from the fov — `setLens` clamps it into the
      // barrel, so the eyepiece's 64 mm lands on the tele's own wide end at
      // 200 mm rather than on a default nobody chose. At the scope's tightest
      // (6°, ~194 mm) the two rules already agreed; this only changes the half
      // of the scope's travel where they did not.
      const mm = focalForCameraFov(this.ctx.camera.fov, this.ctx.camera.aspect);
      const fit = fromScope ? lensById('tele') : (LENSES.find((x) => mm <= x.mmMax) ?? LENSES[0]);
      this._fitting = true;
      try { this.lens.setLens(fit.id, { focal: mm }); } finally { this._fitting = false; }
      const rig0 = this.ctx.systems?.cameraRig;
      if (rig0) rig0.fov = cameraFovForFocal(this.lens.focal, this.ctx.camera.aspect);
      this._fitAperture();
      this._fitDolly();
      // The preview's GL context, taken on the first F rather than at boot —
      // and survivable if the browser refuses it. See the note by `lensRow`.
      if (!this.lensPreview) {
        this.lensPreview = new LensPreview({ width: 188, height: 128, lens: this.lens.lens.id });
        // `prepend`, not `insertBefore(canvas, this.lensLabel)`: the plate is a
        // grandchild now (it shares a row with the swap button) and
        // `insertBefore` against a node that is not a child of the reference
        // parent throws a DOMException — inside the first F, which would take
        // the whole mode with it.
        if (this.lensPreview.ok && this.lensPreview.canvas) {
          this.lensRow.prepend(this.lensPreview.canvas);
        }
      }
      this.lensPreview?.setLens(this.lens.lens.id);
      this.lensPreview?.setZoomT(this.lens.t);
      this.hourEl.set(this._saved.hour);
      this.expEl.set(this._saved.exposure);
      this.colEl.set(this._saved.saturation);
      this._syncLens();
      this.hud.audio()?.cue('door');
      // The panel may have been stowed when the player last left, and the rail
      // is a different width now — a stale offset would park it in the wrong
      // place. Cheap, and it is the only moment the measurement can be taken
      // before the first frame is composed.
      this._placeStow();
      void this.node.offsetWidth;      // see the note in hud_settings.setOpen
      // The zoom ring, and it is named rather than taken from a list. Focus has
      // to land somewhere inside the rail — that is what routes P, G, J, F and
      // the bracket keys to the handler above, since `HUD._onKey` ignores keys
      // aimed at its own controls — and "the first control in DOM order" is now
      // the lens-swap button, where a stray Space would change the glass on the
      // camera. A range input answers arrow keys and ignores Space, so the ring
      // is both the safe landing place and a good one: the arrows zoom.
      this.zoomEl.input.focus({ preventScroll: true });
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
        if (rig) { rig.fov = s.fov; rig.freeDistMax = s.freeDistMax; }
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
    if (code === 'BracketRight') { this._ring(1); return true; }
    if (code === 'BracketLeft') { this._ring(-1); return true; }
    if (code === 'KeyL') { this.lens.cycle(1); return true; }
    return false;
  }

  /**
   * One detent of the zoom ring, and what happens when there is no more ring.
   *
   * The ring used to walk off the end of the barrel and change the lens for
   * you, after a banked detent of resistance so it could not happen on a
   * flick. It does not any more, and the player's own words are the whole
   * argument: *"the zoom ring should not change lenses automatically. It should
   * just toast saying 'cannot zoom out further, switch lenses' same in the max
   * direction."* The mechanic is documented at length in `LensKit`'s header and
   * in `docs/LENS_NOTES.md` §2, and both now describe why it is gone.
   *
   * The tick fires on every press at the stop, because that is the barrel
   * refusing to turn and you want to feel it every time. The TOAST does not:
   * a message that reappears on every detent of a held key is not information,
   * it is a stack of identical cards over the photograph the player is trying
   * to compose. `_atStop` remembers which end was already announced and
   * `LensKit`'s `onChange` clears it the moment the ring actually moves — so
   * arriving at the stop says so once, leaving and coming back says so again.
   */
  _ring(dir) {
    if (this.lens.zoom(dir) !== 'end') return;
    this.hud.audio()?.cue('tick');
    if (this._atStop === dir) return;
    this._atStop = dir;
    const mm = Math.round(this.lens.focal);
    this.hud.toast(dir > 0
      ? `${mm} mm is all the reach this lens has — change lens for more`
      : `${mm} mm is as wide as this lens goes — change lens to go wider`);
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
  /**
   * How far the wheel may back the camera off, given the lens on the front.
   *
   * The free camera's ceiling is the chase boom's ZOOM_MAX, 68 m, which is a
   * sane distance to stand from a camper with a wide lens on. At 400 mm the
   * frame is 2.9 degrees across and the subject is something on the far side of
   * the valley — a player scrolling back to find it hits that stop at once, and
   * reports it as the wheel not going far enough. Which it is.
   *
   * Scaled by focal length against the wide end, because that is what the
   * geometry says: the same subject fills the same share of the frame at a
   * distance proportional to the focal. Capped at 420 m — past that the terrain
   * between camera and subject is doing more to the shot than the dial is, and
   * the free camera's own floor clearance starts fighting the hillside.
   */
  _fitDolly() {
    const rig = this.ctx.systems?.cameraRig;
    if (!rig) return;
    const wide = LENSES[0]?.mmMin ?? 24;
    rig.freeDistMax = Math.min(420, 68 * Math.max(1, this.lens.focal / wide));
  }

  /** `f`, brought inside what the fitted lens can actually do. */
  _lensStop(f) {
    const stops = stopsFor(this.lens.lens);
    if (!stops.length) return f;
    return Math.min(Math.max(f, stops[0]), stops[stops.length - 1]);
  }

  _fitAperture() {
    if (!this.focus) return;
    const now = this.focus.fStop;
    const capped = this._lensStop(now);
    // Clamped, not reset: a player who chose f/11 on the wide is still at f/11
    // after fitting the tele, because that is the setting they chose. Only an
    // impossible value moves.
    if (Math.abs(capped - now) > 1e-6) this.focus.setAperture(capped);
  }

  /**
   * Put every control that reads the lens back in agreement with it.
   *
   * There are five of them and they can all be moved from somewhere else: the
   * plate under the preview, three sliders, and the instrument panel. The
   * aperture alone can be set by the panel's own wheel chord, by its slider, by
   * a lens swap that clamps it, or by this file fitting a lens on entry — so a
   * single place that re-derives everything from the model is the only shape
   * this can take. It used to be `_paintLens`, which painted the plate and left
   * the rest to luck, and that was survivable only because the sliders did not
   * exist yet.
   *
   * The plate is NOT `LensKit.label()`, which prints the barrel's *maximum*
   * aperture — what is engraved on a real lens, and the wrong number here
   * because the panel above it prints the aperture actually set. The two
   * disagreed on screen: the panel said f/8 while the plate said f/2.8.
   *
   * `readout: false` is for the call that comes FROM the readout: `PhotoFocus`
   * has already painted itself before it tells us, and repainting it from
   * inside its own notification is one wasted `innerHTML` per wheel event.
   */
  _syncLens(o = {}) {
    const f = this.focus?.fStop ?? this.lens.lens.fStop;
    if (this.lensLabel) this.lensLabel.firstChild.textContent = this.lens.lens.name;
    this.zoomEl?.set(this.lens.t);
    if (this.apEl) {
      // The ladder is a different length on each body — seven stops on the
      // f/2.8 wide, six on the f/4 tele — so the track is re-spanned before the
      // thumb is placed, or a swap leaves the thumb describing an index the new
      // lens does not have.
      const stops = stopsFor(this.lens.lens);
      this.apEl.span(Math.max(1, stops.length - 1));
      const i = stops.indexOf(f);
      this.apEl.set(i < 0 ? 0 : i);
    }
    if (this.focusEl && this.focus) {
      const n = this.focus.near, r = Math.max(n * 1.01, this.focus.reach);
      this.focusEl.set(Math.log(Math.max(n, this.focus.distance) / n) / Math.log(r / n));
    }
    if (o.readout !== false) this.focus?.repaint();
  }

  /** Real seconds, from HUD.update — the rail runs while the world is frozen. */
  update(dt) {
    this.focus?.update(dt);
    this.lensPreview?.update(dt);
  }

  /**
   * Slide the panel off to the left, or bring it back.
   *
   * The offset is MEASURED rather than a CSS constant, and has to be: the rail
   * is centred (`left: 50%; translateX(-50%)`) and its width changes with the
   * viewport, the fitted lens's name and whether the gesture line is there at
   * all. What we want is its right edge parked `TAB` px from the left of the
   * screen, so the shift is `TAB - (rail.right)` — computed at the moment of
   * the click, and again on resize while it is away.
   *
   * Composed as a second `translateX` on top of the centring one rather than
   * replacing it, so only the transform animates. The first version switched
   * `left: 50%` to `left: 0` and animated both, which reads as the panel
   * jumping to the corner and then sliding.
   */
  toggleStow(on = !this.stowed) {
    this.stowed = !!on;
    this.rail.classList.toggle('pa-cam-stowed', this.stowed);
    this.stowBtn.setAttribute('aria-label', this.stowed ? 'Show the controls' : 'Hide the controls');
    this.stowBtn.setAttribute('aria-expanded', String(!this.stowed));
    this._placeStow();
    this.hud.audio()?.cue('tick');
  }

  /** The measured offset, applied. Also the resize handler. */
  _placeStow() {
    if (!this.stowed) { this.rail.style.setProperty('--cam-off', '0px'); return; }
    // Enough of the panel left on screen to be an obvious handle and to hold
    // the button that brings it back.
    const TAB = 34;
    const r = this.rail.getBoundingClientRect();
    // `r` already includes the current offset, so undo it before measuring.
    const cur = parseFloat(this.rail.style.getPropertyValue('--cam-off')) || 0;
    const right = r.right - cur;
    this.rail.style.setProperty('--cam-off', `${Math.round(TAB - right)}px`);
  }

  /**
   * Let the world run, or hold it still again — without leaving the camera.
   *
   * The whole mechanism is one flag: main.js drives every world system with
   * `ctx.worldPaused ? 0 : dt` and accumulates its world clock the same way, so
   * this is the entire implementation and there is nothing here to keep in sync
   * with anything. See "T, and the world it stops" in the header for what is
   * deliberately left OUT of it — the driving controls and the sun.
   *
   * Split from `toggleTime` because `setActive` needs the state written without
   * the sound: entering photo mode already plays a door, and a tick underneath
   * it is one cue too many for something the player did not press.
   */
  setTime(on) {
    this.running = !!on;
    this.ctx.worldPaused = !this.running;
    this._paintTime();
  }

  toggleTime() {
    this.setTime(!this.running);
    this.hud.audio()?.cue('tick');
  }

  /**
   * Leaving. The world goes back to play and the toggle goes back to its
   * default, and those are OPPOSITE values of the same pair — which is the
   * whole reason this exists instead of a `setTime(false)` on the exit path.
   *
   * `running = false` means "photo mode is holding the world still". That is
   * the right state for the chip to be reset to and exactly the wrong thing to
   * hand back to play, and writing it as one call did precisely that: every
   * exit from photo mode left `ctx.worldPaused` up, so main.js kept driving
   * every world system at dt 0 with the mode already closed. The camper could
   * not be driven, and its wheels — placed each frame from a physics step that
   * was no longer running — hung detached in the air, because `_readWheels`
   * had never filled in a position for them.
   *
   * It is on the unconditional exit path with `input.suppressed` for the same
   * reason that one is: a photo mode that can be left with the world still
   * frozen is a soft lock.
   */
  _releaseTime() {
    this.running = false;
    this.ctx.worldPaused = false;
    this._paintTime();
  }

  /**
   * The chip, told which way it is pointing.
   *
   * Lit means the world is RUNNING, which is the added state and the one the
   * player chose — the same reading the grid chip's light had. T and the button
   * are the same verb and the button is the only one of the two that can show
   * state, so this lives here rather than in the click handler: a world started
   * from the keyboard has to light it too.
   *
   * The label flips with it, for the reason `stowBtn`'s does — a control whose
   * tooltip names one direction while it is already pointing that way is a
   * control that reads as broken.
   */
  _paintTime() {
    if (!this.timeBtn) return;
    const label = this.running ? 'Hold the world still' : 'Let the world run';
    this.timeBtn.classList.toggle('pa-on', this.running);
    this.timeBtn.title = touchCapable() ? label : `${label} (T)`;
    this.timeBtn.setAttribute('aria-label', label);
    this.timeBtn.setAttribute('aria-pressed', String(this.running));
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
        // `THUMB_MAX`, imported — NOT a 512 written out again here.
        //
        // This line used to carry its own copy of the number, which meant the
        // store's constant could be raised and the shutter would go on handing
        // it a 512 px canvas: `makeThumb` only ever scales DOWN, so the larger
        // setting would have been silently ignored and the only symptom would
        // have been that nothing looked any better.
        const k = THUMB_MAX / Math.max(canvas.width, canvas.height, 1);
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
      world_running: this.running,
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
      let award = null, again = null;
      for (const id of detectSubjects(this.ctx)) {
        if (hunt.award(id, thumb)) {
          if (!award) award = { id, photoDataURL: hunt.photoFor(id) };
        } else if (!again) {
          // Already crossed off. Photographing a subject the book has was doing
          // nothing at all, which reads as the shutter having missed — so offer
          // the swap: the book opens on the two prints side by side and the
          // player picks which one to keep.
          again = { id, photo: thumb, replace: true };
        }
      }
      // An award beats a replace when one frame holds both: a line the player
      // has never crossed off is the more interesting of the two events, and
      // two ceremonies queued behind one shutter press is a lot of theatre.
      //
      // `thumb` is the scratch canvas this block already holds and it is REUSED
      // on the next press — `Journal.open()` re-encodes it synchronously before
      // its first `await` for exactly that reason.
      if (award ?? again) this.hud.openJournal(award ?? again);
    } catch (e) {
      console.warn('[hunt] check failed', e);
    }
    return true;
  }
}
