// ─────────────────────────────────────────────────────────────────────────────
//  HUD — diegetic, warm, and mostly out of the way.
//
//  This game has no fail state, no objectives and no resources, so there is
//  nothing for a HUD to warn you about. What is left is worth having: which way
//  you are facing, what is out there, how fast you are going, and a good camera
//  to photograph it with.
//
//  Structure: this file owns the root element, input, and the per-frame data
//  pull; the widgets (compass, dash, settings, photo mode) own their own DOM
//  and know nothing about each other.
//
//  Two things worth knowing before editing:
//
//   · The root is `pointer-events: none`. Only real controls turn it back on,
//     so the canvas underneath always gets the drag and the wheel.
//   · The HUD hides itself whenever the capture harness has posed the camera
//     (`window.__forceCamera`), because eleven authors judge their art through
//     `shot.mjs` and none of them asked for a speedometer in the frame. Pass
//     `--eval "window.__hudForce = true"` to capture it deliberately.
// ─────────────────────────────────────────────────────────────────────────────
import { System } from '../core/System.js';
import { QUALITY_PRESETS } from '../world/WorldConfig.js';
import './hud.css';
import { el, button, ICON } from './hud_dom.js';
import { Compass } from './hud_compass.js';
import { Dash } from './hud_dash.js';
import { Settings } from './hud_settings.js';
import { PhotoMode } from './hud_photo.js';
import { MiniMap } from './hud_map.js';

const STORE = 'pa.hud';
// How many of each landmark kind go on the compass. Weighted toward water:
// it is the thing worth driving to, and the thing you can already hear.
const LANDMARKS = [['waterfall', 4], ['vista', 3], ['peak', 2], ['river', 3]];
const FOUND_RADIUS = 75;

export class HUD extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'HUD';
    this.loadLabel = 'Folding the map';

    this.quality = ctx.quality ?? 'high';
    this.invertY = false;
    this.showMap = true;
    this.hudOpacity = 1;
    this.trip = 0;
    this.found = 0;
    this.marks = [];
    this._all = [];
    this._markTimer = 0;
    this._frame = 0;
    this._pads = [];
    this._hintTimer = 0;

    try {
      const s = JSON.parse(localStorage.getItem(STORE) ?? 'null');
      if (s) {
        this.invertY = !!s.invertY;
        this.hudOpacity = typeof s.hudOpacity === 'number' ? s.hudOpacity : 1;
        this.showMap = s.showMap !== false;
        this._seenHint = !!s.seenHint;
      }
    } catch { /* defaults are fine */ }
  }

  async init() {
    const root = el('div');
    root.id = 'pa-hud';
    // index.html belongs to the engine owner, so the HUD builds its own root
    // and appends it to the body rather than expecting a container to exist.
    document.body.appendChild(root);
    this.root = root;

    this.compass = new Compass(root);
    this.dash = new Dash(root);
    // Baked here, inside the awaited init, so the ~40 ms raster lands under the
    // loading screen rather than as a hitch on the player's first frame.
    this.map = new MiniMap(root, this.ctx.world ?? globalThis.__world ?? null);
    this.map.setVisible(this.showMap);

    // ── corner chips ───────────────────────────────────────────────────────
    const corner = el('div', 'pa-corner pa-game-only');
    this.muteChip = button('pa-chip', ICON.sound, () => this.applyMute(!this.isMuted()), 'Mute');
    this.photoChip = button('pa-chip', ICON.camera, () => this.togglePhoto(), 'Photo mode');
    this.gearChip = button('pa-chip', ICON.gear, () => this.toggleSettings(), 'Settings');
    corner.append(this.muteChip, this.photoChip, this.gearChip);
    root.appendChild(corner);

    this.toastEl = el('div', 'pa-toast pa-panel');
    root.appendChild(this.toastEl);

    // ── first-run hint ─────────────────────────────────────────────────────
    this.hint = el('div', 'pa-hint pa-panel pa-game-only',
      '<span><kbd>WASD</kbd>drive</span><span><kbd>Drag</kbd>look</span>' +
      '<span><kbd>C</kbd>camera</span><span><kbd>R</kbd>rescue</span>' +
      '<span><kbd>F</kbd>photo</span><span><kbd>Esc</kbd>settings</span>');
    if (this._seenHint) this.hint.classList.add('pa-gone');
    else this._hintTimer = 13;
    root.appendChild(this.hint);

    this.settings = new Settings(root, this);
    this.photo = new PhotoMode(root, this);

    this._buildLandmarks();
    this._bindKeys();
    this.applyHudMode(this.hudOpacity);

    window.__hud = this;
  }

  // ── landmarks ─────────────────────────────────────────────────────────────

  _buildLandmarks() {
    const poi = this.ctx.poi;
    if (!poi) return;
    for (const [kind, n] of LANDMARKS) {
      for (let i = 0; i < n; i++) {
        const p = poi.best(kind, i);
        // `best` clamps to the last entry, so a short list would otherwise
        // return the same place several times.
        if (!p || this._all.some((m) => m.x === p.x && m.z === p.z)) continue;
        this._all.push({ kind, x: p.x, z: p.z, dist: Infinity, bearing: 0, found: false });
      }
    }
    this.total = this._all.length;
  }

  /** Distance and bearing for every landmark; the nearest six go on the strip. */
  _refreshMarks(cam) {
    let found = 0;
    for (const m of this._all) {
      const dx = m.x - cam.x, dz = m.z - cam.z;
      m.dist = Math.hypot(dx, dz);
      // Bearing clockwise from north, matching the compass strip. North is -Z,
      // which is the direction three.js's default camera looks.
      m.bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
      if (m.dist < FOUND_RADIUS && !m.found) {
        m.found = true;
        this.toast(`Found a ${m.kind === 'river' ? 'river bend' : m.kind}`);
      }
      if (m.found) found++;
    }
    this.found = found;
    this.marks = this._all.slice().sort((a, b) => a.dist - b.dist).slice(0, 6);
  }

  // ── input ─────────────────────────────────────────────────────────────────

  _bindKeys() {
    this._onKey = (e) => {
      // A control inside the HUD has focus: it handles its own keys.
      if (this.root.contains(e.target) && e.target !== document.body) return;
      switch (e.code) {
        case 'KeyF': this.togglePhoto(); break;
        case 'Escape':
          if (this.photo.active) this.togglePhoto();
          else this.toggleSettings();
          break;
        case 'KeyM': this.applyMute(!this.isMuted()); break;
        case 'KeyG': if (this.photo.active) this.photo.toggleGrid(); break;
        case 'KeyP': if (this.photo.active) this.photo.capture(); break;
        case 'KeyH': this.applyHudMode(this.hudOpacity > 0 ? 0 : 1); break;
        case 'KeyN': this.applyMap(!this.showMap); break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', this._onKey);
  }

  /**
   * Gamepad. Deliberately does not use button 0 (A / cross): `Input` maps that
   * to the handbrake, and menus that also yank the handbrake are a bad joke.
   * X/square activates, Start opens settings, Y toggles photo mode.
   */
  _gamepad() {
    const pads = navigator.getGamepads?.();
    const gp = pads && [...pads].find((p) => p && p.connected);
    if (!gp) return;
    const down = (i) => !!gp.buttons[i]?.pressed;
    const edge = (i) => {
      const now = down(i);
      const was = this._pads[i];
      this._pads[i] = now;
      return now && !was;
    };
    if (edge(9)) this.toggleSettings();
    if (edge(3)) this.togglePhoto();
    if (edge(1)) { if (this.photo.active) this.togglePhoto(); else if (this.settings.open) this.toggleSettings(); }
    if (this.settings.open) {
      if (edge(12)) { this.settings.moveFocus(-1); this.audio()?.cue('tick'); }
      if (edge(13)) { this.settings.moveFocus(1); this.audio()?.cue('tick'); }
      if (edge(14)) this.settings.nudge(-1);
      if (edge(15)) this.settings.nudge(1);
      if (edge(2)) { this.settings.activate(); this.audio()?.cue('select'); }
    } else if (this.photo.active && edge(2)) {
      this.photo.capture();
    }
  }

  // ── actions the settings sheet and the chips call ─────────────────────────

  audio() { return this.ctx.systems?.audio ?? null; }
  isMuted() { return this.audio()?.muted ?? false; }
  volume() { return this.audio()?.volume ?? 0.75; }
  hour() { return this.ctx.lighting?.hour ?? 16.6; }
  cycleSpeed() { return this.ctx.lighting?.cycleSpeed ?? 0; }

  applyVolume(v) { this.audio()?.setVolume(v); }

  applyMute(m) {
    const a = this.audio();
    a?.setMuted(m);
    const on = a?.muted ?? m;
    this.muteChip.innerHTML = on ? ICON.muted : ICON.sound;
    this.muteChip.classList.toggle('pa-on', on);
    this.settings?.sync();
    this.toast(on ? 'Sound off' : 'Sound on');
  }

  applyHour(h) { if (this.ctx.lighting) this.ctx.lighting.hour = h; }
  applyCycle(v) { if (this.ctx.lighting) this.ctx.lighting.cycleSpeed = v; }

  applyInvert(v) { this.invertY = !!v; this._save(); }

  applyMap(v) {
    this.showMap = !!v;
    this.map?.setVisible(this.showMap);
    this._save();
    this.settings?.sync();
  }

  applyHudMode(v) {
    this.hudOpacity = v;
    // A custom property, not `style.opacity`: an inline opacity outranks every
    // stylesheet rule, including the one that hides the HUD for other authors'
    // captures. See the note at the top of hud.css.
    this.root.style.setProperty('--hud-op', String(v));
    // At zero the HUD must also stop taking clicks, or an invisible gear chip
    // still eats a drag on the canvas.
    this.root.style.pointerEvents = v > 0 ? '' : 'none';
    this._save();
  }

  /**
   * Live quality change.
   *
   * `onQuality(preset)` is part of the System interface, so peers opt in by
   * implementing it. Engine's own resize handler re-reads `engine.preset` for
   * the pixel-ratio cap, so that has to move too — see the note filed in
   * docs/INTEGRATION_REQUESTS.md asking for a proper `engine.setQuality()`.
   */
  applyQuality(q) {
    const preset = QUALITY_PRESETS[q];
    if (!preset) return;
    const { ctx } = this;
    this.quality = q;
    ctx.quality = q;
    ctx.preset = preset;
    if (ctx.engine) { ctx.engine.quality = q; ctx.engine.preset = preset; }
    try {
      ctx.renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatioCap));
      window.dispatchEvent(new Event('resize'));
    } catch { /* renderer is not ours to guarantee */ }
    for (const [name, s] of Object.entries(ctx.systems ?? {})) {
      try { s.onQuality?.(preset); } catch (e) { console.warn(`[hud] ${name}.onQuality threw`, e); }
    }
    for (const p of [ctx.postfx, ctx.lighting, ctx.terrain]) {
      try { p?.onQuality?.(preset); } catch { /* optional hook */ }
    }
    this.toast(`${q[0].toUpperCase()}${q.slice(1)} quality`);
    this.settings?.sync();
  }

  toggleSettings() {
    const open = !this.settings.open;
    if (open && this.photo.active) this.togglePhoto();
    this.settings.setOpen(open);
    this.gearChip.classList.toggle('pa-on', open);
    this.audio()?.cue(open ? 'select' : 'tick');
  }

  togglePhoto() {
    const on = !this.photo.active;
    if (on && this.settings.open) this.settings.setOpen(false);
    this.photo.setActive(on);
    this.root.classList.toggle('pa-photo', on);
    this.photoChip.classList.toggle('pa-on', on);
    this._dismissHint();
  }

  toast(msg) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('pa-show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.toastEl.classList.remove('pa-show'), 2200);
  }

  _dismissHint() {
    if (this._seenHint) return;
    this._seenHint = true;
    this.hint.classList.add('pa-gone');
    this._save();
  }

  _save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        invertY: this.invertY, hudOpacity: this.hudOpacity, showMap: this.showMap,
        seenHint: !!this._seenHint,
      }));
    } catch { /* nothing important lost */ }
  }

  // ── frame ─────────────────────────────────────────────────────────────────

  update(dt) {
    const { ctx } = this;
    this._frame++;

    // Invert look. CameraRig reads `mouse.dy` in lateUpdate and `axes.lookY` is
    // refilled by Input at the end of the frame, so flipping both here lands
    // exactly once per frame, before the only consumer.
    if (this.invertY) {
      ctx.input.mouse.dy = -ctx.input.mouse.dy;
      ctx.input.axes.lookY = -ctx.input.axes.lookY;
    }

    // Stand down for the capture harness unless a capture explicitly wants us.
    const hidden = !!window.__forceCamera && !window.__hudForce;
    if (hidden !== this._captureHidden) {
      this._captureHidden = hidden;
      this.root.classList.toggle('pa-capture-hidden', hidden);
    }

    const veh = ctx.systems?.vehicle;
    const speed = veh?.speed ?? 0;
    this.trip += Math.abs(speed) * dt;

    if (this._hintTimer > 0) {
      this._hintTimer -= dt;
      // The hint goes as soon as the player drives — it has done its job the
      // moment they touch a key.
      if (this._hintTimer <= 0 || Math.abs(speed) > 1.5) this._dismissHint();
    }

    this._markTimer -= dt;
    if (this._markTimer <= 0) {
      this._markTimer = 0.25;
      this._refreshMarks(ctx.camera.position);
    }

    // The compass is the only per-frame DOM write of any size; 30 Hz is
    // indistinguishable from 60 for a strip that moves this slowly, and halves
    // the layout cost.
    if ((this._frame & 1) === 0) {
      const e = ctx.camera.matrixWorld.elements;
      // Camera forward is -(third basis column); bearing is clockwise from -Z.
      const heading = (Math.atan2(-e[8], e[10]) * 180) / Math.PI;
      this.compass.update(heading, this.marks);
    }

    // The map arrow follows the *camper*, not the camera: free-look swings the
    // compass strip, but the question the map answers is which way the vehicle
    // is pointed. `vehicle.heading` is measured from +Z; the map, like the
    // compass, works clockwise from north, which is -Z.
    if (this.showMap) {
      const p = veh?.position ?? ctx.camera.position;
      let bearing;
      if (veh) bearing = 180 - (veh.heading * 180) / Math.PI;
      else {
        const m = ctx.camera.matrixWorld.elements;
        bearing = (Math.atan2(-m[8], m[10]) * 180) / Math.PI;
      }
      this.map.update(p.x, p.z, bearing);
    }
    this.dash.update(speed, this.trip, this.found, this.total);
    this._gamepad();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    clearTimeout(this._toastT);
    this.map?.dispose();
    this.root?.remove();
  }
}
