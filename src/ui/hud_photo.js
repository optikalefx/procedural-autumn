// ─────────────────────────────────────────────────────────────────────────────
//  Photo mode — the thing players will actually share.
//
//  What it does:
//   · hands the camera to CameraRig's own orbit mode (which already knows how
//     to keep a boom out of a hillside — reimplementing that here would be a
//     second, worse camera)
//   · takes the HUD away, leaving four corner brackets and an optional
//     rule-of-thirds grid
//   · gives three dials that matter for a photograph — the hour, the exposure,
//     and the colour — and nothing else
//   · writes a real PNG at the window's resolution
//
//  The save path is the fiddly part. The WebGL context has no
//  preserveDrawingBuffer, so the canvas reads back blank outside of a draw. The
//  fix is to render one extra frame through the post chain and read the buffer
//  *synchronously* in the same task, before the compositor clears it.
// ─────────────────────────────────────────────────────────────────────────────
import { el, button } from './hud_dom.js';

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

    this.shutterBtn = button('pa-shutter', '', () => this.capture(), 'Take photo');
    rail.appendChild(this.shutterBtn);
    rail.appendChild(el('div', 'pa-rail-hint',
      'P&nbsp;&nbsp;save<br>G&nbsp;&nbsp;grid<br>F&nbsp;&nbsp;exit'));
    this.node.appendChild(rail);
    this.rail = rail;

    rail.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') { this.setActive(false); return; }
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

  _setExposure(v) { this.ctx.postfx?.setExposure?.(v); }

  _setSaturation(v) {
    const u = this.ctx.postfx?.grade?.uniforms?.get('uSaturation');
    if (u) u.value = v;
  }

  _readGrade() {
    const fx = this.ctx.postfx;
    return {
      exposure: fx?.tone?.exposure ?? 1.12,
      saturation: fx?.grade?.uniforms?.get('uSaturation')?.value ?? 0.86,
      hour: this.ctx.lighting?.hour ?? 16.6,
      cycle: this.ctx.lighting?.cycleSpeed ?? 0,
      mode: this.ctx.systems?.cameraRig?.mode ?? 'chase',
    };
  }

  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    this.node.classList.toggle('pa-open', on);
    const rig = this.ctx.systems?.cameraRig;

    if (on) {
      this._saved = this._readGrade();
      // Photo mode is CameraRig's orbit mode. It already handles terrain
      // clearance, zoom and the slow sweep; this just asks for it.
      if (rig) rig.mode = 'orbit';
      // The world should hold still while you compose.
      if (this.ctx.lighting) this.ctx.lighting.cycleSpeed = 0;
      this.hourEl.set(this._saved.hour);
      this.expEl.set(this._saved.exposure);
      this.colEl.set(this._saved.saturation);
      this.hud.audio()?.cue('door');
      void this.node.offsetWidth;      // see the note in hud_settings.setOpen
      this.controls[0]?.focus({ preventScroll: true });
    } else {
      const s = this._saved;
      if (s) {
        this._setExposure(s.exposure);
        this._setSaturation(s.saturation);
        if (this.ctx.lighting) {
          this.ctx.lighting.hour = s.hour;
          this.ctx.lighting.cycleSpeed = s.cycle;
        }
        if (rig) rig.mode = s.mode;
      }
      this._saved = null;
      if (this.node.contains(document.activeElement)) document.activeElement.blur();
    }
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
    let url = null;
    try {
      this.ctx.postfx?.render?.(1 / 60);
      url = canvas.toDataURL('image/png');
    } catch (e) {
      console.warn('[hud] photo failed', e);
      this.hud.toast('Could not save photo');
      return false;
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
    this.lastPhotoBytes = url.length;
    return true;
  }
}
