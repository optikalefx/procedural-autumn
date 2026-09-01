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
import { posthog } from '../posthog.js';
import { QUALITY_PRESETS, SEED } from '../world/WorldConfig.js';
import './hud.css';
import { el, button, ICON } from './hud_dom.js';
import { Compass } from './hud_compass.js';
import { Dash } from './hud_dash.js';
import { Settings } from './hud_settings.js';
import { PhotoMode } from './hud_photo.js';
import { Journal } from '../journal/Journal.js';
import { MiniMap } from './hud_map.js';
import { hunt } from '../game/hunt_store.js';
import { touchCapable } from '../core/verbs.js';

const STORE = 'pa.hud';
// How many of each landmark kind are in the world's list of things to find.
// Weighted toward water: it is the thing worth driving to, and the thing you
// can already hear.
const LANDMARKS = [['waterfall', 4], ['vista', 3], ['peak', 2], ['river', 3]];
// Kinds that count toward "found" but never take a slot on the compass strip.
// A crest that rises 350 m out of the valley floor announces itself from the
// far side of the map — the player has already seen it, and a pin saying it is
// 4 km that way is the compass repeating the windscreen. Driving up to one is
// still worth crediting; it just does not need directions.
const UNPINNED = new Set(['peak']);
const FOUND_RADIUS = 75;
// A peak is not a place you stand on — the crests here rise 350 m out of a
// valley floor that reaches their feet, and nothing the player drives is
// getting up one. So the mark sits on the summit (see `_landmarkSpot`) and the
// ring around it is the width of the mountain's foot rather than a doorstep:
// close enough that the thing fills the windscreen, which is the moment worth
// calling "found". At 75 m it would never fire at all.
const FOUND_RADIUS_BY_KIND = { peak: 200 };
// Two vantages scored for the camera can be aimed at the same massif, which
// gives two summits a few dozen metres apart and two entries on the same rock.
const SAME_LANDMARK = 300;
// A waterfall inside this range stays on the compass even when six other
// landmarks are nearer — it is the thing you can already hear.
const WATERFALL_NEAR = 1000;
// The camp and camper pins stand down when you are basically standing at them:
// a marker for "here" swings across the whole strip with every step.
const PIN_HIDE = 30;
// The paw stands down much later than the camp does. Its whole job is "there
// is something over there", and an animal you have not been credited for at
// fifteen metres is the case where that is most worth saying — turn around,
// it is right behind you. Only inside this does the bearing stop meaning
// anything, for the same reason PIN_HIDE exists at all.
const PAW_HIDE = 8;

export class HUD extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'HUD';
    this.loadLabel = 'Folding the map';

    this.quality = ctx.quality ?? 'high';
    this.invertY = false;
    this.showMap = true;
    this.hudOpacity = 1;
    // null = let the adaptive scaler decide; a number = pinned, as a fraction
    // of this display's native pixel density. See `renderScale`.
    this.renderPin = null;
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
        this._introSeen = !!s.introSeen;
        this.renderPin = typeof s.renderPin === 'number' ? s.renderPin : null;
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
    this.map = new MiniMap(root, this.ctx.world ?? globalThis.__world ?? null,
      (x, z) => this._warp(x, z));
    this.map.setVisible(this.showMap);

    // ── corner chips ───────────────────────────────────────────────────────
    const corner = el('div', 'pa-corner pa-game-only');
    this.muteChip = button('pa-chip', ICON.sound, () => this.applyMute(!this.isMuted()), 'Mute');
    this.photoChip = button('pa-chip', ICON.camera, () => this.togglePhoto(), 'Photo mode');
    // `pa-gear` marks the one chip that survives "Interface: Off" — see hud.css.
    this.gearChip = button('pa-chip pa-gear', ICON.gear, () => this.toggleSettings(), 'Settings');
    // The camera cycle is C on a keyboard and nothing at all on a phone, so on
    // touch it joins the chips — the row where every other keyboard-only toggle
    // already ended up. Not added on desktop: the key is right there, and a
    // fourth chip would be clutter bought with nothing.
    if (touchCapable()) {
      this.camChip = button('pa-chip', ICON.cycle,
        () => this.ctx.systems?.cameraRig?.cycleMode?.(), 'Camera');
      corner.append(this.muteChip, this.photoChip, this.camChip, this.gearChip);
    } else {
      corner.append(this.muteChip, this.photoChip, this.gearChip);
    }
    root.appendChild(corner);

    this.toastEl = el('div', 'pa-toast pa-panel');
    // An actionable toast fires once and takes itself down: the offer it was
    // making has been accepted, and a rescue button that stays up after a
    // rescue reads as one that did not work.
    this._toastAction = null;
    this.toastEl.addEventListener('click', () => {
      const act = this._toastAction;
      if (!act) return;
      this.hideToast();
      act();
    });
    root.appendChild(this.toastEl);

    // ── first-run hint ─────────────────────────────────────────────────────
    this.hint = el('div', 'pa-hint pa-panel pa-game-only',
      '<span><kbd>WASD</kbd>drive</span><span><kbd>Drag</kbd>look</span>' +
      '<span><kbd>C</kbd>camera</span><span><kbd>R</kbd>rescue</span>' +
      '<span><kbd>F</kbd>photo</span><span><kbd>~</kbd>settings</span>');
    if (this._seenHint) this.hint.classList.add('pa-gone');
    else this._hintTimer = 13;
    root.appendChild(this.hint);

    this.settings = new Settings(root, this);
    this.photo = new PhotoMode(root, this);
    // The journal is NOT a DOM widget like everything else in this file — it is
    // a three.js object drawn over the finished frame (see the render callback
    // in main.js). HUD owns it anyway, because HUD is what has the key, the
    // chip and the mode arbitration, and because HUD is in main.js's
    // LIVE_WHILE_PAUSED set: the book has to keep turning its pages while the
    // world behind it is frozen at dt 0.
    this.journal = new Journal(this.ctx);
    // Closing by any route — J, Escape, Enter, all of which the journal binds
    // itself — has to put the interface back. Without this the chrome stays
    // hidden after the book shuts and the game looks broken.
    this.journal.onClose = () => this.root.classList.remove('pa-journal');
    // Ringing a line says so out loud. The toast is deliberately NOT
    // `pa-game-only`, so unlike the compass and the dash it is still on screen
    // with the book up — which is the only reason this can be said at the
    // moment it happens rather than after the book is shut.
    this.journal.onTarget = (id, subject) =>
      this.toast(id ? `Tracking ${subject}` : 'Stopped tracking');

    this._buildLandmarks();
    this._bindKeys();
    this.applyHudMode(this.hudOpacity);
    // A pin restored from a previous session goes in NOW, undebounced, while
    // the loading screen is still up — main.js checks `engine.resolutionPin`
    // before it sets the automatic starting rung, so this wins rather than
    // being quietly overwritten one line later.
    if (this.renderPin) this._commitRenderScale(true);

    window.__hud = this;
  }

  /**
   * Debug: click the map, go there.
   *
   * Temporary by request — it is a way to get to a piece of terrain without
   * driving twenty minutes to it, not a mechanic. It is deliberately blunt: no
   * confirmation, no site search, and no refusal to land in a lake, because
   * being able to click the lake is most of the point. `Vehicle.warpTo` clamps
   * to the world and does the rest.
   */
  _warp(x, z) {
    const v = this.ctx.systems?.vehicle ?? globalThis.__vehicle;
    if (!v?.warpTo) return;
    const p = v.warpTo(x, z);
    // `warpTo` steps the player off a boat OR a bike on the way (the warp moves
    // the camper, and the player has to arrive with it) and leaves the thing
    // where it was. Say so in the same toast rather than a second one: a boat
    // silently gone from under you reads as the game having eaten it, and
    // there is no boat marker on the map to go looking for. The bike is the
    // gentler case — the next camp brings it along — but it is still worth a
    // word, because you were sitting on it a moment ago.
    if (p) {
      const left = p.leftBoat ? ` — ${p.leftBoat} left moored`
                 : p.leftBike ? ' — bike left behind' : '';
      this.toast(`Warped to ${Math.round(p.x)}, ${Math.round(p.z)}${left}`);
    }
  }

  // ── landmarks ─────────────────────────────────────────────────────────────

  /**
   * Where the landmark *is*, which is not always where `poi` put its entry.
   * A peak entry is a camera stand-off aimed at the crest from most of a
   * kilometre away; the landmark the player is looking for is the crest.
   */
  _landmarkSpot(kind, p) {
    if (kind === 'peak' && p.summit) return p.summit;
    return p;
  }

  _buildLandmarks() {
    const poi = this.ctx.poi;
    if (!poi) return;
    for (const [kind, n] of LANDMARKS) {
      let added = 0;
      // Walk past the quota: a candidate dropped for landing on one already
      // taken costs the kind a candidate, not an entry.
      for (let i = 0; added < n && i < n + 12; i++) {
        const p = poi.best(kind, i);
        if (!p) break;
        const spot = this._landmarkSpot(kind, p);
        // `best` clamps to the last entry, so a short list would otherwise
        // return the same place several times — and two peak vantages can
        // resolve to *near* the same summit even when the entries differ, so
        // peaks need a radius where the rest only need identity. Same kind
        // only: a river bend 200 m from a waterfall is still its own place.
        const sep = kind === 'peak' ? SAME_LANDMARK : 1;
        if (this._all.some((m) => m.kind === kind &&
            Math.hypot(m.x - spot.x, m.z - spot.z) < sep)) continue;
        this._all.push({ kind, x: spot.x, z: spot.z, dist: Infinity, bearing: 0, found: false });
        added++;
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
      if (m.dist < (FOUND_RADIUS_BY_KIND[m.kind] ?? FOUND_RADIUS) && !m.found) {
        m.found = true;
        this.toast(`Found a ${m.kind === 'river' ? 'river bend' : m.kind}`);
        posthog.capture('landmark_discovered', {
          landmark_kind: m.kind,
          landmarks_found_total: this.found + 1,
          landmarks_total: this.total,
        });
      }
      if (m.found) found++;
    }
    this.found = found;
    // Every landmark is measured and credited above; only the pinnable kinds
    // compete for the six slots. Peaks drop out here rather than at build time
    // so they still count toward "found / total" and the logbook.
    const sorted = this._all.slice()
      .filter((m) => !UNPINNED.has(m.kind))
      .sort((a, b) => a.dist - b.dist);
    const marks = sorted.slice(0, 6);
    for (const m of sorted) {
      if (m.kind === 'waterfall' && m.dist < WATERFALL_NEAR && !marks.includes(m)) marks.push(m);
    }
    // The camp and the camper are not landmarks to be found — they are the way
    // back, so they are always on the strip while the player is away from them.
    // Away from, and so measured from where the player actually *is*, not from
    // the camera: a wide boom or a swung free-look puts the eye forty metres
    // off the thing you are riding, and a pin for "here" is noise.
    const here = this._anchor(cam);
    for (const c of this.ctx.systems?.camp?.camps ?? []) {
      if (!c.striking) this._pin(marks, 'camp', c.x, c.z, here);
    }
    const veh = this.vehicle();
    // The camper earns a pin only when the player is out of it. Aboard, it is
    // underneath you: the pin sits dead ahead and swings the width of the strip
    // with every turn of the wheel. `controlsHeldBy` is the system of record
    // for who has the pedals — null is the camper, 'boat' is the player off
    // paddling and 'bike' is the player off riding, with the camper parked
    // somewhere behind them either way.
    if (veh?.position && veh.controlsHeldBy != null) {
      this._pin(marks, 'car', veh.position.x, veh.position.z, here);
    }
    // ── the paw ─────────────────────────────────────────────────────────────
    // One animal, the nearest that is inside its own species' hint band and
    // not yet in the logbook. Wildlife owns both the walk and the thresholds
    // (see `nearestHint`); all this end knows is where to point.
    //
    // It carries no distance label. Every other pin on this strip is a fixed
    // landmark, and telling you a waterfall is 700 m away is the invitation
    // the compass header describes. An animal is not a landmark: it moves, it
    // can be spooked, and a live range readout to one would be the closest
    // thing to a waypoint in a game that deliberately has none. Bearing is the
    // hint; the finding is yours.
    //
    // With a target ringed in the journal the paw belongs to that species and
    // to nothing else, and it reaches as far as the animal can exist rather
    // than as far as an unasked-for nudge should carry. Wildlife owns both
    // rules; all this end does is say which line the book is open at. See
    // `Wildlife._nearestQuarry`.
    const paw = this.ctx.systems?.wildlife?.nearestHint?.(here.x, here.z, hunt.target);
    if (paw) this._pin(marks, 'paw', paw.x, paw.z, here, PAW_HIDE, true);
    this.marks = marks;
  }

  /**
   * Where the player is, as opposed to where the camera is. Aboard a boat that
   * is the boat, on a bike it is the bike; otherwise it is the camper, which
   * the player is always in. Same question the map arrow asks — see `update`.
   *
   * At most one of the two can be true — both take `vehicle.controlsHeldBy` —
   * so the order between them is arbitrary rather than a priority.
   */
  _anchor(cam) {
    const boat = this.ctx.systems?.boat;
    if (boat?.active && boat.current) return boat.current;
    const bike = this.ctx.systems?.bike;
    if (bike?.active && bike.current) return bike.current;
    return this.vehicle()?.position ?? cam;
  }

  _pin(marks, kind, x, z, cam, hide = PIN_HIDE, noLabel = false) {
    const dx = x - cam.x, dz = z - cam.z;
    const dist = Math.hypot(dx, dz);
    if (dist < hide) return;
    marks.push({
      kind, x, z, dist, noLabel,
      bearing: (Math.atan2(dx, -dz) * 180) / Math.PI, found: false,
    });
  }

  // ── input ─────────────────────────────────────────────────────────────────

  _bindKeys() {
    this._onKey = (e) => {
      // A control inside the HUD has focus: it handles its own keys.
      if (this.root.contains(e.target) && e.target !== document.body) return;
      switch (e.code) {
        case 'KeyF': this.togglePhoto(); break;
        case 'KeyJ': this.toggleJournal(); break;
        case 'Escape':
          if (this.journal.active) { this.toggleJournal(); break; }
          if (!this.photo.active) return;
          this.togglePhoto();
          break;
        case 'Backquote': this.toggleSettings(); break;
        case 'KeyM': this.applyMute(!this.isMuted()); break;
        case 'KeyT': if (this.photo.active) this.photo.toggleTime(); break;
        case 'KeyP': if (this.photo.active) this.photo.capture(); break;
        case 'KeyL': case 'BracketLeft': case 'BracketRight':
          // The rail handles these too (it swallows keys while focused); this
          // is the path for a player who has clicked out onto the canvas.
          if (!this.photo.active || !this.photo.lensKey(e.code)) return;
          break;
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
  vehicle() { return this.ctx.systems?.vehicle ?? globalThis.__vehicle ?? null; }
  isMuted() { return this.audio()?.muted ?? false; }
  volume() { return this.audio()?.volume ?? 0.75; }
  hour() { return this.ctx.lighting?.hour ?? 16.6; }
  cycleSpeed() { return this.ctx.lighting?.cycleSpeed ?? 0; }

  /** Take the toast down, whether it was sticky or timed. */
  hideToast() {
    clearTimeout(this._toastT);
    this.toastEl.classList.remove('pa-show', 'pa-toast-action');
    this.toastEl.style.pointerEvents = '';
    this._toastAction = null;
  }

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

  /** Which car is being driven, for the settings sheet's segmented control. */
  carId() { return this.vehicle()?.car?.id ?? null; }

  /**
   * Swap cars from the settings sheet. Deliberately NOT persisted: you arrive
   * at the trailhead in whatever you arrived in (vehicle_models.js `pickCar`),
   * and a saved choice would quietly turn that into "whatever I picked once".
   */
  applyCar(id) {
    const v = this.vehicle();
    if (!v?.setCar) return;
    if (v.setCar(id)) {
      this.toast(`${v.car.label}`);
      posthog.capture('car_changed', { car_id: id, car_label: v.car.label });
    }
    this.settings?.sync();
  }

  /** The seed the running world was baked from: the URL's, else the default. */
  seed() {
    const v = parseInt(new URLSearchParams(location.search).get('seed') ?? '', 10);
    return Number.isFinite(v) ? v : SEED;
  }

  /**
   * New seed → new valley. This is a page reload, not a live change: the whole
   * boot path (main.js) keys terrain, water and POIs off ?seed=, so rewriting
   * the URL is the one honest way to rebuild everything consistently. Other
   * params (res, quality overrides) ride along untouched.
   */
  applySeed(v) {
    const s = Math.floor(v);
    if (!Number.isFinite(s) || s < 0 || s === this.seed()) return;
    posthog.capture('world_seed_changed', { new_seed: s, previous_seed: this.seed() });
    const params = new URLSearchParams(location.search);
    params.set('seed', String(s));
    location.search = params.toString();
  }

  applyHour(h) { if (this.ctx.lighting) this.ctx.lighting.hour = h; }
  applyCycle(v) { if (this.ctx.lighting) this.ctx.lighting.cycleSpeed = v; }

  applyInvert(v) { this.invertY = !!v; this._save(); }

  // The perf readout lives outside the HUD (see PerfOverlay.js for why), so
  // the settings sheet reaches it through the global main.js publishes. It
  // persists its own visibility; nothing to save here.
  perf() { return window.__perfOverlay ?? null; }
  showPerf() { return this.perf()?.visible ?? false; }
  applyPerf(v) { this.perf()?.setVisible(v); this.settings?.sync(); }

  applyMap(v) {
    this.showMap = !!v;
    this.map?.setVisible(this.showMap);
    this._save();
    this.settings?.sync();
  }

  applyHudMode(v) {
    this.hudOpacity = v;
    // "Off" is not the same as "faded to nothing". Turning the whole root
    // transparent takes the gear chip with it, and a player who hid the
    // interface from the settings sheet then has nothing on screen telling them
    // how to get it back — only the H key, which is written down in the panel
    // they just made invisible. So Off leaves the root opaque and hands the
    // hiding to `.pa-hud-off` in hud.css, which spares the gear and the sheet.
    const off = v <= 0;
    this.root.classList.toggle('pa-hud-off', off);
    // A custom property, not `style.opacity`: an inline opacity outranks every
    // stylesheet rule, including the one that hides the HUD for other authors'
    // captures. See the note at the top of hud.css.
    this.root.style.setProperty('--hud-op', String(off ? 1 : v));
    this._save();
  }

  // ── render resolution ─────────────────────────────────────────────────────
  // Two ceilings decide how many pixels the scene is actually drawn with: the
  // tier's `pixelRatioCap` (how big the canvas is) and the adaptive scaler's
  // internal rung (what fraction of that canvas the scene renders into). They
  // multiply, and on a Retina panel the product lands well under native — sharp
  // enough for the soft, bloomy parts of the frame and visibly not enough for
  // thin geometry. This is the manual override for players who would rather
  // spend the frame time. Engine.setResolutionPin has the full argument.
  //
  // Stored as a FRACTION OF NATIVE rather than an absolute pixel ratio, so the
  // setting means the same thing when the window moves between a 1x monitor and
  // a 2x laptop panel: "as sharp as this screen goes", not "1.5, whatever that
  // happens to be here".

  /** Where the slider sits: the pin if pinned, else where the scaler has landed. */
  renderScale() {
    if (this.renderPin) return this.renderPin;
    const e = this.ctx.engine;
    const native = e?.nativePixelRatio?.() ?? (window.devicePixelRatio || 1);
    const eff = e?.effectivePixelRatio?.() ?? native;
    return Math.max(0.5, Math.min(1, eff / native));
  }

  /** The megapixels a given fraction of native asks for, for the slider label. */
  renderScaleLabel(v) {
    const native = this.ctx.engine?.nativePixelRatio?.() ?? (window.devicePixelRatio || 1);
    const px = window.innerWidth * window.innerHeight * (native * v) ** 2;
    return `${Math.round(v * 100)}%  ${(px / 1e6).toFixed(1)} MP`;
  }

  autoRes() { return !this.renderPin; }

  applyAutoRes(v) {
    // Turning auto OFF pins wherever the scaler currently is, so the control
    // hands over without the picture jumping.
    this.renderPin = v ? null : this.renderScale();
    this._commitRenderScale();
    this.settings?.sync();
  }

  applyRenderScale(v) {
    this.renderPin = Math.max(0.5, Math.min(1, v));
    this._commitRenderScale();
    this.settings?.sync();
  }

  /**
   * Push the pin into the engine, debounced.
   *
   * Committing resizes the drawing buffer, measured at 450-2500 ms on
   * ANGLE/Metal. A slider drag fires an input event per frame, so applying
   * every one of them would freeze the game for the length of the drag; the
   * label under the slider updates live, the pixels follow when the hand stops.
   */
  _commitRenderScale(immediate = false) {
    this._save();
    clearTimeout(this._resTimer);
    const apply = () => {
      const e = this.ctx.engine;
      if (!e?.setResolutionPin) return;
      e.setResolutionPin(this.renderPin ? this.renderPin * e.nativePixelRatio() : NaN);
      if (!immediate) {
        this.toast(this.renderPin
          ? `Resolution ${this.renderScaleLabel(this.renderPin)}`
          : 'Resolution auto');
        posthog.capture('render_scale_changed', {
          render_scale: this.renderPin, quality_tier: this.quality,
        });
      }
      this.settings?.sync();
    };
    if (immediate) apply();
    else this._resTimer = setTimeout(apply, 260);
  }

  /**
   * Live quality change.
   *
   * `Engine.setQuality` owns the whole change — pixel-ratio cap, the tier's
   * preferred resolution rung, the resize, and the fan-out to every system that
   * implements `onQuality` (registered in main.js). This used to be
   * reimplemented here: it assigned `engine.quality`/`engine.preset` by hand,
   * called `setPixelRatio` itself and then fanned out a second time. That was
   * survivable while every tier shared one resolution preference and stopped
   * being survivable when the tier started deciding it — picking Ultra kept
   * whatever rung the previous tier had settled on, so the tier that is
   * supposed to mean "native" quietly did not. docs/INTEGRATION_REQUESTS.md
   * asked for exactly this; the request is now met.
   */
  applyQuality(q) {
    const preset = QUALITY_PRESETS[q];
    if (!preset) return;
    const { ctx } = this;
    this.quality = q;
    ctx.quality = q;
    ctx.preset = preset;
    if (ctx.engine?.setQuality) {
      ctx.engine.setQuality(q);
    } else {
      // Contexts that build a partial ctx without an Engine (the gallery, some
      // harnesses) still get the tier change; they just have no renderer for it
      // to resize.
      for (const [name, s] of Object.entries(ctx.systems ?? {})) {
        try { s.onQuality?.(preset); } catch (e) { console.warn(`[hud] ${name}.onQuality threw`, e); }
      }
      for (const p of [ctx.postfx, ctx.lighting, ctx.terrain]) {
        try { p?.onQuality?.(preset); } catch { /* optional hook */ }
      }
    }
    this.toast(`${q[0].toUpperCase()}${q.slice(1)} quality`);
    posthog.capture('quality_changed', { quality_tier: q });
    this.settings?.sync();
  }

  toggleSettings() {
    const open = !this.settings.open;
    if (open && this.photo.active) this.togglePhoto();
    if (open && this.journal.active) this.toggleJournal();
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
    posthog.capture('photo_mode_toggled', { active: on });
  }

  /**
   * Open or shut the logbook.
   *
   * The `pa-journal` class is what takes the interface away (see hud.css). It
   * is set here rather than inside Journal because the book knows nothing about
   * the DOM, and cleared from `journal.onClose` rather than here because the
   * journal closes itself on three keys of its own and only one of them comes
   * through this method.
   */
  toggleJournal() {
    if (this.journal.active) { this.journal.close(); return; }
    if (this.settings.open) this.settings.setOpen(false);
    this.root.classList.add('pa-journal');
    this.journal.open();
    this._dismissHint();
    posthog.capture('journal_opened', { source: 'key' });
  }

  /**
   * Open the book onto a line that has just been earned.
   *
   * Called from `PhotoMode.capture()` and nowhere else. Photo mode stays active
   * underneath — the player is still standing where they took the shot, and
   * shutting the book puts them back at the viewfinder rather than back in the
   * driving seat, which is what someone who has just found one of fifteen
   * things wants.
   */
  openJournal(award) {
    this.root.classList.add('pa-journal');
    this.journal.open({ award });
    posthog.capture('journal_opened', { source: 'award', item: award?.id ?? null });
  }

  /**
   * The one-time greeting: a brand-new player has never seen the book, so
   * main.js calls this the moment the world is up and lets it open itself
   * straight to the title leaf (see `Journal.open`'s `holdTitle`), rather than
   * making them find J on their own first. Every session after this one is a
   * no-op — `_introSeen` latches on the first call and is saved immediately,
   * not on close, so a refresh mid-read can't win the popup back.
   *
   * Deliberately bypasses `toggleJournal()`: that path calls `_dismissHint()`
   * on open, which would burn the bottom control legend's one showing while
   * it sits invisible behind the book (see the `!this.journal.active` guard
   * in `update()`) — the legend is for AFTER this closes, not instead of it.
   */
  maybeShowIntro() {
    if (this._introSeen) return;
    this._introSeen = true;
    this._save();
    this.root.classList.add('pa-journal');
    this.journal.open({ holdTitle: true });
    posthog.capture('journal_opened', { source: 'intro' });
  }

  /**
   * A line of text, briefly.
   *
   * Two options, both of which exist for the same reason: on a touch device the
   * toast is sometimes the only control there is. "Stuck? Press R" is a fine
   * thing to read on a laptop and a dead end on a phone, so the touch twin says
   * "Touch to rescue" and IS the button — which means it has to take a tap
   * (`action`) and it has to stay up for as long as the offer stands
   * (`sticky`), rather than timing out after 2.2 s while the camper is still on
   * its roof. See `Vehicle.update`.
   *
   * @param {string} msg
   * @param {{action?: Function, sticky?: boolean}} [opts]
   */
  toast(msg, opts = {}) {
    const { action = null, sticky = false } = opts;
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('pa-show');
    this.toastEl.classList.toggle('pa-toast-action', !!action);
    // `#pa-hud` is pointer-events:none, so an actionable toast has to opt back
    // in — and opt out again the moment it is an ordinary message, or an
    // invisible pill would sit over the world eating presses.
    this.toastEl.style.pointerEvents = action ? 'auto' : '';
    this._toastAction = action;
    clearTimeout(this._toastT);
    if (sticky) return;
    this._toastT = setTimeout(() => this.hideToast(), 2200);
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
        seenHint: !!this._seenHint, introSeen: !!this._introSeen, renderPin: this.renderPin,
      }));
    } catch { /* nothing important lost */ }
  }

  // ── frame ─────────────────────────────────────────────────────────────────

  update(dt) {
    const { ctx } = this;
    this._frame++;

    // Real seconds, deliberately. HUD is in main.js's LIVE_WHILE_PAUSED set, so
    // `dt` here keeps running while the world is frozen at 0 — which is exactly
    // the condition the book is opened under. Driving it with world time would
    // freeze the ceremony mid-page-turn.
    this.journal.update(dt);
    if (this.photo.active) this.photo.update(dt);

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
    // Everything below reports on whatever the player is *riding*, not on the
    // camper and not on the camera. Aboard a boat that is the boat: the camper
    // is parked on a shore that may be half a lake behind you, and both an
    // arrow stuck on it and a speedo reading its zero are answering a question
    // nobody asked. `boat.current` is published every frame by Boat._publish
    // and carries `speed` in m/s signed along the hull and `heading` measured
    // from +Z — the same units and conventions as Vehicle's, so both consumers
    // can take either without converting. It is non-null for a moored boat too
    // (the water agent wants a wake source), hence the `boat.active` gate.
    const boat = ctx.systems?.boat;
    const bike = ctx.systems?.bike;
    // The bike publishes the same shape for the same reason, with `speed` as
    // the ground track it actually made — so a rider grinding against a boulder
    // reads zero rather than reading the effort they are putting in.
    const aboard = boat?.active ? boat.current : (bike?.active ? bike.current : null);
    const riding = !!bike?.active;
    const speed = aboard?.speed ?? veh?.speed ?? 0;
    // A deliberate consequence: the trip meter now turns while you paddle. It
    // is the player's journey rather than the camper's odometer — the "you
    // have been somewhere" reading hud_dash's header describes — and freezing
    // it for the length of a lake crossing would undercount exactly the stretch
    // the player worked hardest for.
    this.trip += Math.abs(speed) * dt;

    // Frozen, not just invisible, while the book is up: the legend is hidden
    // behind `.pa-journal` (see hud.css) but this timer runs on real seconds
    // regardless of pause, and a first-time player can spend longer than 13 s
    // reading the intro popup. Without the guard the countdown burns through
    // while nobody can see it and the legend is already gone the moment the
    // book closes — see `maybeShowIntro`.
    if (this._hintTimer > 0 && !this.journal.active) {
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

    // Free-look swings the compass strip, but the question the map answers is
    // where you are and which way you are *pointed*, so the arrow takes the
    // ridden heading rather than the camera's. Headings arrive measured from
    // +Z; the map, like the compass, works clockwise from north, which is -Z.
    if (this.showMap) {
      const p = aboard ?? veh?.position ?? ctx.camera.position;
      let bearing;
      if (aboard) bearing = 180 - (aboard.heading * 180) / Math.PI;
      else if (veh) bearing = 180 - (veh.heading * 180) / Math.PI;
      else {
        const m = ctx.camera.matrixWorld.elements;
        bearing = (Math.atan2(-m[8], m[10]) * 180) / Math.PI;
      }
      this.map.update(p.x, p.z, bearing);
    }
    // HOLD is the camper's handbrake lamp, and boarding a boat *requires* the
    // camper parked with the hold armed (see the `parked` gate in Boat.update),
    // so left alone the lamp would burn for every second the player is on the
    // water. A warning lamp that is always on is not a warning lamp, and a
    // kayak has no brake to hold in the first place.
    // The dash's third readout is the scavenger sheet's animals, not this
    // system's landmarks — `hud_dash.js`'s header says why. `this.found` /
    // `this.total` are still live and still credited above: they drive the
    // toast, the compass strip's crossed-off pins and the logbook. They just
    // are not what the paw counts.
    // ── arming the nineteenth line ──────────────────────────────────────────
    //
    // `src/wildlife/` does not import `src/game/`, and this is the seam that
    // keeps it that way: whether the mystery is open is a fact about the SAVE,
    // and the HUD is already the layer that reads the save and hands pieces of
    // it down (the paw's target two hundred lines up, the counts on the line
    // below). So the world system exposes a boolean and this sets it.
    //
    // Cleared again once he is photographed, because the line is finished and a
    // bigfoot still wandering the timber after the book has closed on him is a
    // creature with nothing left to be. See `Bigfoot.update`, which despawns
    // any live one on the frame this goes false.
    const bf = this.ctx.systems?.wildlife?.bigfoot;
    if (bf) bf.armed = hunt.mysteryOpen && !hunt.won;

    this.dash.update(speed, this.trip, hunt.animalCount(), hunt.animalTotal,
      aboard ? false : (veh?.brakeHold ?? false),
      aboard ? (riding ? 'bike' : 'boat') : 'camper');
    this.settings.tick(dt);
    this._gamepad();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    clearTimeout(this._toastT);
    this.map?.dispose();
    this.root?.remove();
  }
}
