// ─────────────────────────────────────────────────────────────────────────────
//  Settings — one sheet, two pages: the settings groups, and a controls
//  reference reached by the button at the bottom (back arrow or Esc returns).
//
//  Every control is a native <input>/<button>, which is what makes the panel
//  keyboard-reachable and screen-reader-legible without a line of ARIA
//  plumbing. The gamepad layer on top of it just moves focus and nudges values,
//  so there is exactly one set of behaviour to keep working.
// ─────────────────────────────────────────────────────────────────────────────
import { el, button } from './hud_dom.js';
import { CARS } from '../vehicle/vehicle_models.js';
import { touchCapable } from '../core/verbs.js';

const QUALITIES = ['ultra', 'high', 'medium', 'low'];
const CYCLES = [['Frozen', 0], ['Slow', 0.06], ['Fast', 0.35]];
const HUD_MODES = [['Full', 1], ['Dim', 0.45], ['Off', 0]];

const hhmm = (h) => {
  const hh = Math.floor(((h % 24) + 24) % 24);
  const mm = Math.floor((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

export class Settings {
  constructor(root, hud) {
    this.hud = hud;
    this.open = false;
    this.node = el('div', 'pa-sheet pa-panel');
    this.node.setAttribute('role', 'dialog');
    this.node.setAttribute('aria-label', 'Settings');

    // Two pages in one sheet: the settings themselves, and the controls
    // reference that used to squat in the footer. Swapping pages instead of
    // stacking a second dialog keeps focus, Esc, and the gamepad in one place.
    this.page = 'settings';
    this.pageSettings = el('div', 'pa-page pa-page-on');
    this.pageControls = el('div', 'pa-page');
    this.node.appendChild(this.pageSettings);
    this.node.appendChild(this.pageControls);

    const head = el('div', 'pa-sheet-head');
    head.appendChild(el('h2', null, 'Settings'));
    // Esc closes it, but a panel with no visible way out is hostile to anyone
    // who opened it with the mouse.
    head.appendChild(button('pa-close', '✕', () => hud.toggleSettings(), 'Close settings'));
    this.pageSettings.appendChild(head);

    this.pageSettings.appendChild(this._group('Picture', [
      this._seg('Quality', QUALITIES.map((q) => [q[0].toUpperCase() + q.slice(1), q]),
        () => hud.quality, (v) => hud.applyQuality(v)),
    ]));

    // The car is a picture of itself as much as a setting, so it goes first —
    // and it is the one control here that changes something the player is
    // looking at rather than something they are looking through.
    this.pageSettings.appendChild(this._group('Vehicle', [
      this._seg('Drive', CARS.map((c) => [c.label, c.id]),
        () => hud.carId(), (v) => hud.applyCar(v)),
    ]));

    this.pageSettings.appendChild(this._group('Valley', [
      this._range('Time of day', 0, 24, 0.05, () => hud.hour(), (v) => hud.applyHour(v), hhmm),
      this._seg('Sun', CYCLES, () => hud.cycleSpeed(), (v) => hud.applyCycle(v)),
      this._seed(() => hud.seed(), (v) => hud.applySeed(v)),
    ]));

    this.pageSettings.appendChild(this._group('Sound', [
      this._range('Volume', 0, 1, 0.01, () => hud.volume(), (v) => hud.applyVolume(v),
        (v) => `${Math.round(v * 100)}%`),
      this._toggle('Mute', () => hud.isMuted(), (v) => hud.applyMute(v)),
    ]));

    // "View", not "Camera": the group also carries HUD visibility, and a
    // player looking for the setting that hides the interface does not look
    // under Camera.
    this.pageSettings.appendChild(this._group('View', [
      this._toggle('Invert look', () => hud.invertY, (v) => hud.applyInvert(v)),
      this._toggle('Valley map', () => hud.showMap, (v) => hud.applyMap(v)),
      this._toggle('FPS readout', () => hud.showPerf(), (v) => hud.applyPerf(v)),
      this._seg('Interface', HUD_MODES, () => hud.hudOpacity, (v) => hud.applyHudMode(v)),
    ]));

    const foot = el('div', 'pa-foot');
    foot.appendChild(button('pa-controls-open', 'Controls', () => this._showPage('controls'),
      'Show the controls'));
    this.pageSettings.appendChild(foot);

    // ── controls page ─────────────────────────────────────────────────────
    const chead = el('div', 'pa-sheet-head');
    chead.appendChild(button('pa-close pa-back', '←', () => this._showPage('settings'),
      'Back to settings'));
    chead.appendChild(el('h2', null, 'Controls'));
    chead.appendChild(button('pa-close', '✕', () => hud.toggleSettings(), 'Close settings'));
    this.pageControls.appendChild(chead);

    // This is the one page in the game whose entire job is to say what the
    // controls are, so it is the last place that may get it wrong: a phone
    // opening "Controls" and reading a list of keys it does not have is being
    // told, in the most official voice the game has, that it is playing the
    // wrong version. Two lists, and the touch one names gestures.
    //
    // The touch list is shorter because it is honest: the chips in the corner
    // are self-evident and do not need a legend, and what genuinely needs
    // saying is the part that is invisible — that a HOLD is a different act
    // from a tap, and what each one is for.
    const KEYS = touchCapable() ? [
      ['steer', 'drag the strip — how far across is how hard you turn'],
      ['gas / brake', 'drive; brake again from a stop to reverse'],
      ['park', 'handbrake — under 8 km/h it holds; camp and boats need you parked'],
      ['tap', 'look at a camp, board a boat, come back to the camper'],
      ['hold', 'make camp here, put a boat in here, pack a camp up'],
      ['toast', 'when you are stuck, the message that appears is the rescue'],
    ] : [
      ['WASD', 'drive'],
      ['Space', 'handbrake — under 8 km/h it holds; stays parked until you drive off'],
      ['C', 'camera'],
      ['R', 'rescue — moves you to clear ground nearby'],
      ['F', 'photo mode'],
      ['N', 'valley map'],
      ['M', 'mute'],
      ['H', 'hide interface'],
      ['F3', 'fps readout'],
      ['Esc', 'settings / close'],
    ];
    const keys = el('div', 'pa-keys');
    for (const [k, desc] of KEYS) {
      const kr = el('div', 'pa-key-row');
      kr.appendChild(el('span', 'pa-key', k));
      kr.appendChild(el('span', 'pa-key-desc', desc));
      keys.appendChild(kr);
    }
    this.pageControls.appendChild(keys);

    root.appendChild(this.node);

    // Keys typed into the sheet must not also drive the camper: Input listens
    // on window during the bubble phase, so stopping here is enough.
    this.node.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        // Esc backs out one layer at a time: controls → settings → closed.
        if (this.page === 'controls') { this._showPage('settings'); e.stopPropagation(); return; }
        this.setOpen(false); return;
      }
      e.stopPropagation();
    });
    this.node.addEventListener('keyup', (e) => e.stopPropagation());

    this.controls = [];        // for gamepad focus movement
    this._collect();
  }

  _group(label, rows) {
    const g = el('div', 'pa-group');
    g.appendChild(el('div', 'pa-label', label));
    for (const r of rows) g.appendChild(r);
    return g;
  }

  /** Slider row: name, live value, then the track underneath it. */
  _range(name, min, max, step, get, set, fmt) {
    const row = el('div');
    const head = el('div', 'pa-row');
    head.appendChild(el('div', 'pa-row-name', name));
    const val = el('div', 'pa-row-val');
    head.appendChild(val);
    row.appendChild(head);

    const input = el('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    input.setAttribute('aria-label', name);
    const paint = () => {
      const v = +input.value;
      val.textContent = fmt ? fmt(v) : String(v);
      input.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
    };
    input.addEventListener('input', () => { set(+input.value); paint(); });
    row.appendChild(input);
    row._sync = () => { input.value = get(); paint(); };
    this._syncs = this._syncs ?? [];
    this._syncs.push(row._sync);
    return row;
  }

  /** Segmented row: values may be strings or numbers. */
  _seg(name, options, get, set) {
    const row = el('div');
    const head = el('div', 'pa-row');
    head.appendChild(el('div', 'pa-row-name', name));
    row.appendChild(head);
    const seg = el('div', 'pa-seg');
    const btns = options.map(([label, value]) => {
      const b = button(null, label, () => { set(value); sync(); });
      b._value = value;
      seg.appendChild(b);
      return b;
    });
    const sync = () => {
      const cur = get();
      for (const b of btns) b.classList.toggle('pa-on', b._value === cur);
    };
    row.appendChild(seg);
    row._sync = sync;
    this._syncs = this._syncs ?? [];
    this._syncs.push(sync);
    return row;
  }

  /**
   * Seed row: a number and an explicit "New map" button. Applying rewrites the
   * ?seed= URL and reloads, which throws the whole session away — so nothing
   * commits while you are still typing; only Enter or the button does.
   */
  _seed(get, set) {
    const row = el('div');
    const head = el('div', 'pa-row');
    head.appendChild(el('div', 'pa-row-name', 'Seed'));
    row.appendChild(head);

    const wrap = el('div', 'pa-seed');
    const input = el('input');
    input.type = 'number';
    // Real bounds, not decoration: the gamepad nudge clamps to +input.min and
    // +input.max, and an unset max coerces to 0 — which would pin the value.
    input.min = 0; input.max = 999999999; input.step = 1;
    input.setAttribute('aria-label', 'World seed');
    const apply = () => {
      const v = parseInt(input.value, 10);
      if (Number.isFinite(v)) set(v);
    };
    input.addEventListener('keydown', (e) => { if (e.code === 'Enter') apply(); });
    wrap.appendChild(input);
    wrap.appendChild(button(null, 'New map', apply, 'Rebuild the valley from this seed'));
    row.appendChild(wrap);
    row._sync = () => { input.value = get(); };
    this._syncs = this._syncs ?? [];
    this._syncs.push(row._sync);
    return row;
  }

  _toggle(name, get, set) {
    const row = el('div', 'pa-row');
    row.appendChild(el('div', 'pa-row-name', name));
    const t = button('pa-toggle', '', () => { set(!get()); sync(); }, name);
    t.setAttribute('role', 'switch');
    const sync = () => {
      const on = !!get();
      t.classList.toggle('pa-on', on);
      t.setAttribute('aria-checked', String(on));
    };
    row.appendChild(t);
    row._sync = sync;
    this._syncs = this._syncs ?? [];
    this._syncs.push(sync);
    return row;
  }

  _collect() {
    // Only the visible page: focus and the gamepad must never land on a
    // control the player cannot see.
    this.controls = [...this.node.querySelectorAll('.pa-page-on input, .pa-page-on button')];
  }

  _showPage(name) {
    this.page = name;
    this.pageSettings.classList.toggle('pa-page-on', name === 'settings');
    this.pageControls.classList.toggle('pa-page-on', name === 'controls');
    this.node.setAttribute('aria-label', name === 'controls' ? 'Controls' : 'Settings');
    this._collect();
    this.controls[0]?.focus({ preventScroll: true });
  }

  sync() { for (const s of this._syncs ?? []) s(); }

  setOpen(v) {
    if (v === this.open) return;
    this.open = v;
    this.node.classList.toggle('pa-open', v);
    if (v) {
      // Always open on the settings page, even if the sheet was closed while
      // showing controls.
      if (this.page !== 'settings') this._showPage('settings');
      this.sync();
      // Focus the first control so Tab and the gamepad both start somewhere
      // sensible, but do not scroll the page doing it.
      //
      // The reflow read is load-bearing: the sheet is `visibility: hidden`
      // until `.pa-open` lands, and calling focus() in the same task as the
      // class toggle silently does nothing, because the element the browser
      // still has computed is an unfocusable one. Measured: focus stayed on
      // <body> and the first three Tab presses walked out of the panel.
      void this.node.offsetWidth;
      this.controls[0]?.focus({ preventScroll: true });
    } else if (this.node.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  }

  /** Gamepad: move focus through the sheet. */
  moveFocus(dir) {
    const list = this.controls;
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    const n = (i < 0 ? 0 : i + dir + list.length) % list.length;
    list[n].focus({ preventScroll: true });
  }

  /** Gamepad: nudge whatever is focused. */
  nudge(dir) {
    const a = document.activeElement;
    if (!a || !this.node.contains(a)) return;
    if (a.tagName === 'INPUT') {
      const step = (+a.step || 1) * (dir > 0 ? 1 : -1);
      a.value = Math.max(+a.min, Math.min(+a.max, +a.value + step));
      a.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Inside a segmented control, left/right walks the segments.
      const seg = a.closest('.pa-seg');
      if (!seg) return;
      const btns = [...seg.querySelectorAll('button')];
      const i = btns.indexOf(a);
      const n = Math.max(0, Math.min(btns.length - 1, i + dir));
      btns[n].focus({ preventScroll: true });
      btns[n].click();
    }
  }

  activate() {
    const a = document.activeElement;
    if (a && this.node.contains(a) && a.tagName === 'BUTTON') a.click();
  }
}
