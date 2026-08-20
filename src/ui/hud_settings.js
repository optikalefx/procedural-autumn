// ─────────────────────────────────────────────────────────────────────────────
//  Settings — one sheet, four groups, no tabs.
//
//  Every control is a native <input>/<button>, which is what makes the panel
//  keyboard-reachable and screen-reader-legible without a line of ARIA
//  plumbing. The gamepad layer on top of it just moves focus and nudges values,
//  so there is exactly one set of behaviour to keep working.
// ─────────────────────────────────────────────────────────────────────────────
import { el, button } from './hud_dom.js';

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
    const head = el('div', 'pa-sheet-head');
    head.appendChild(el('h2', null, 'Settings'));
    // Esc closes it, but a panel with no visible way out is hostile to anyone
    // who opened it with the mouse.
    head.appendChild(button('pa-close', '✕', () => hud.toggleSettings(), 'Close settings'));
    this.node.appendChild(head);

    this.node.appendChild(this._group('Picture', [
      this._seg('Quality', QUALITIES.map((q) => [q[0].toUpperCase() + q.slice(1), q]),
        () => hud.quality, (v) => hud.applyQuality(v)),
    ]));

    this.node.appendChild(this._group('Valley', [
      this._range('Time of day', 0, 24, 0.05, () => hud.hour(), (v) => hud.applyHour(v), hhmm),
      this._seg('Sun', CYCLES, () => hud.cycleSpeed(), (v) => hud.applyCycle(v)),
    ]));

    this.node.appendChild(this._group('Sound', [
      this._range('Volume', 0, 1, 0.01, () => hud.volume(), (v) => hud.applyVolume(v),
        (v) => `${Math.round(v * 100)}%`),
      this._toggle('Mute', () => hud.isMuted(), (v) => hud.applyMute(v)),
    ]));

    // "View", not "Camera": the group also carries HUD visibility, and a
    // player looking for the setting that hides the interface does not look
    // under Camera.
    this.node.appendChild(this._group('View', [
      this._toggle('Invert look', () => hud.invertY, (v) => hud.applyInvert(v)),
      this._toggle('Valley map', () => hud.showMap, (v) => hud.applyMap(v)),
      this._seg('Interface', HUD_MODES, () => hud.hudOpacity, (v) => hud.applyHudMode(v)),
    ]));

    const foot = el('div', 'pa-foot',
      '<b>WASD</b> drive &nbsp;·&nbsp; <b>Space</b> handbrake &nbsp;·&nbsp; <b>C</b> camera<br>' +
      '<b>R</b> rescue — moves you to clear ground nearby<br>' +
      '<b>F</b> photo mode &nbsp;·&nbsp; <b>N</b> map &nbsp;·&nbsp; <b>M</b> mute<br>' +
      '<b>H</b> hide interface &nbsp;·&nbsp; <b>Esc</b> close');
    this.node.appendChild(foot);
    root.appendChild(this.node);

    // Keys typed into the sheet must not also drive the camper: Input listens
    // on window during the bubble phase, so stopping here is enough.
    this.node.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') { this.setOpen(false); return; }
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
    this.controls = [...this.node.querySelectorAll('input, button')];
  }

  sync() { for (const s of this._syncs ?? []) s(); }

  setOpen(v) {
    if (v === this.open) return;
    this.open = v;
    this.node.classList.toggle('pa-open', v);
    if (v) {
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
