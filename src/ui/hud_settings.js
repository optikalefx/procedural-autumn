// ─────────────────────────────────────────────────────────────────────────────
//  Settings — one sheet, three pages: the settings groups, a controls
//  reference, and the logbook, both reached by the buttons at the bottom (back
//  arrow or Esc returns).
//
//  Each page is a head and a body, and the BODY is the scroll container — not
//  the sheet. The sheet used to scroll as one piece, which took the title, the
//  back arrow and the close button off the top of the screen the moment the
//  logbook ran past a screenful: a dialog whose only way out scrolls away is a
//  trap, and it is the same argument that keeps the gear chip lit under
//  "Interface: Off". The head is pinned, the body moves under it.
//
//  Every control is a native <input>/<button>, which is what makes the panel
//  keyboard-reachable and screen-reader-legible without a line of ARIA
//  plumbing. The gamepad layer on top of it just moves focus and nudges values,
//  so there is exactly one set of behaviour to keep working.
// ─────────────────────────────────────────────────────────────────────────────
import { el, button } from './hud_dom.js';
import { CARS } from '../vehicle/vehicle_models.js';
import { StatsPage } from './hud_stats.js';

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

    // Three pages in one sheet: the settings themselves, the controls
    // reference that used to squat in the footer, and the logbook. Swapping
    // pages instead of stacking a second dialog keeps focus, Esc, and the
    // gamepad in one place.
    this.page = 'settings';
    this.pageSettings = el('div', 'pa-page pa-page-on');
    this.pageControls = el('div', 'pa-page');
    this.pageStats = el('div', 'pa-page');
    // Every page's scrolling half. Content goes here; only the head goes on
    // the page itself.
    this.bodySettings = el('div', 'pa-page-body');
    this.bodyControls = el('div', 'pa-page-body');
    this.bodyStats = el('div', 'pa-page-body');
    this.node.appendChild(this.pageSettings);
    this.node.appendChild(this.pageControls);
    this.node.appendChild(this.pageStats);

    const head = el('div', 'pa-sheet-head');
    head.appendChild(el('h2', null, 'Settings'));
    // Esc closes it, but a panel with no visible way out is hostile to anyone
    // who opened it with the mouse.
    head.appendChild(button('pa-close', '✕', () => hud.toggleSettings(), 'Close settings'));
    this.pageSettings.appendChild(head);
    this.pageSettings.appendChild(this.bodySettings);

    this.bodySettings.appendChild(this._group('Picture', [
      this._seg('Quality', QUALITIES.map((q) => [q[0].toUpperCase() + q.slice(1), q]),
        () => hud.quality, (v) => hud.applyQuality(v)),
    ]));

    // The car is a picture of itself as much as a setting, so it goes first —
    // and it is the one control here that changes something the player is
    // looking at rather than something they are looking through.
    this.bodySettings.appendChild(this._group('Vehicle', [
      this._seg('Drive', CARS.map((c) => [c.label, c.id]),
        () => hud.carId(), (v) => hud.applyCar(v)),
    ]));

    this.bodySettings.appendChild(this._group('Valley', [
      this._range('Time of day', 0, 24, 0.05, () => hud.hour(), (v) => hud.applyHour(v), hhmm),
      this._seg('Sun', CYCLES, () => hud.cycleSpeed(), (v) => hud.applyCycle(v)),
      this._seed(() => hud.seed(), (v) => hud.applySeed(v)),
    ]));

    this.bodySettings.appendChild(this._group('Sound', [
      this._range('Volume', 0, 1, 0.01, () => hud.volume(), (v) => hud.applyVolume(v),
        (v) => `${Math.round(v * 100)}%`),
      this._toggle('Mute', () => hud.isMuted(), (v) => hud.applyMute(v)),
    ]));

    // "View", not "Camera": the group also carries HUD visibility, and a
    // player looking for the setting that hides the interface does not look
    // under Camera.
    this.bodySettings.appendChild(this._group('View', [
      this._toggle('Invert look', () => hud.invertY, (v) => hud.applyInvert(v)),
      this._toggle('Valley map', () => hud.showMap, (v) => hud.applyMap(v)),
      this._toggle('FPS readout', () => hud.showPerf(), (v) => hud.applyPerf(v)),
      this._seg('Interface', HUD_MODES, () => hud.hudOpacity, (v) => hud.applyHudMode(v)),
    ]));

    const foot = el('div', 'pa-foot pa-foot-row');
    foot.appendChild(button('pa-controls-open', 'Controls', () => this._showPage('controls'),
      'Show the controls'));
    foot.appendChild(button('pa-controls-open', 'Logbook', () => this._showPage('stats'),
      'Show what you have done'));
    this.bodySettings.appendChild(foot);

    // ── controls page ─────────────────────────────────────────────────────
    const chead = el('div', 'pa-sheet-head');
    chead.appendChild(button('pa-close pa-back', '←', () => this._showPage('settings'),
      'Back to settings'));
    chead.appendChild(el('h2', null, 'Controls'));
    chead.appendChild(button('pa-close', '✕', () => hud.toggleSettings(), 'Close settings'));
    this.pageControls.appendChild(chead);
    this.pageControls.appendChild(this.bodyControls);

    const KEYS = [
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
    this.bodyControls.appendChild(keys);

    // ── logbook page ──────────────────────────────────────────────────────
    const shead = el('div', 'pa-sheet-head');
    shead.appendChild(button('pa-close pa-back', '←', () => this._showPage('settings'),
      'Back to settings'));
    shead.appendChild(el('h2', null, 'Logbook'));
    shead.appendChild(button('pa-close', '✕', () => hud.toggleSettings(), 'Close settings'));
    this.pageStats.appendChild(shead);
    this.pageStats.appendChild(this.bodyStats);
    this.stats = new StatsPage(this.bodyStats, hud);

    root.appendChild(this.node);

    // Keys typed into the sheet must not also drive the camper: Input listens
    // on window during the bubble phase, so stopping here is enough.
    this.node.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        // Esc backs out one layer at a time: controls/logbook → settings →
        // closed.
        if (this.page !== 'settings') { this._showPage('settings'); e.stopPropagation(); return; }
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
    this.pageStats.classList.toggle('pa-page-on', name === 'stats');
    const TITLE = { controls: 'Controls', stats: 'Logbook' };
    this.node.setAttribute('aria-label', TITLE[name] ?? 'Settings');
    // The logbook is read, not driven: it must be current the instant it
    // appears rather than at the first refresh tick a fifth of a second later.
    if (name === 'stats') this.stats.refresh();
    this._collect();
    this.controls[0]?.focus({ preventScroll: true });
    // A body scrolled two thirds down the settings does not open the logbook
    // two thirds down the logbook. Each page keeps its own scroll offset, so
    // this resets the one being shown.
    const body = { settings: this.bodySettings, controls: this.bodyControls, stats: this.bodyStats }[name];
    if (body) body.scrollTop = 0;
  }

  sync() { for (const s of this._syncs ?? []) s(); }

  /**
   * Per-frame, from HUD.update. Only the logbook wants one — everything else
   * in this sheet is a control whose value cannot change unless the player
   * changes it.
   */
  tick(dt) {
    if (this.open && this.page === 'stats') this.stats.tick(dt);
  }

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
