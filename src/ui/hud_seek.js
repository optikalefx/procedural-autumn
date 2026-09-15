// ─────────────────────────────────────────────────────────────────────────────
//  SeekCue — one leftover at a time, as a pocket compass.
//
//  After William's table note the player needs a way to follow the weekend,
//  and the minimap ring kept reading as camp. This is that way: a cream disc
//  with his scrap of paper and a tick that points at the current leftover
//  (paddle, then bike, …). Not a pin, not a !, not a new compass POI.
//
//  It arrives as a moment in the middle of the view — big, centred, readable
//  — and then docks onto the heading strip as a peer of the paw and the tent:
//  same disc, same chrome, same row. Facing the leftover, the tick points up
//  — same language as the caret. Distance is a whisper under the disc, not a
//  countdown. The settle has to land on those peer metrics; a leftover rest
//  pose (bigger, lower, its own z-index) reads as a second HUD.
// ─────────────────────────────────────────────────────────────────────────────
import { el, ICON, distanceLabel } from './hud_dom.js';

const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;

export class SeekCue {
  constructor(root) {
    this.node = el('div', 'pa-seek pa-game-only pa-gone');
    this.node.setAttribute('aria-hidden', 'true');
    this.disc = el('div', 'pa-seek-disc');
    this.needle = el('div', 'pa-seek-needle');
    this.glyph = el('div', 'pa-seek-glyph', ICON.seek);
    this.dist = el('div', 'pa-seek-dist');
    this.disc.append(this.needle, this.glyph);
    this.node.append(this.disc, this.dist);
    root.appendChild(this.node);

    this._armed = false;
    this._docked = false;
    this._ang = NaN;
    this._kind = null;
    this._label = '';
    this._arriveT = 0;
    this.node.addEventListener('animationend', (e) => {
      if (e.animationName !== 'pa-seek-arrive') return;
      this._dock();
    });
  }

  /** Call when the table note is put down. No-ops if already following. */
  begin() {
    if (this._armed) return;
    this._armed = true;
    this._docked = false;
    this._ang = NaN;
    this._kind = null;
    this.node.classList.remove('pa-gone', 'pa-seek-docked', 'pa-seek-retarget');
    this.node.classList.add('pa-seek-enter');
    clearTimeout(this._arriveT);
    this._arriveT = setTimeout(() => this._dock(), 1750);
  }

  _dock() {
    if (this._docked || !this._armed) return;
    this._docked = true;
    clearTimeout(this._arriveT);
    this.node.classList.remove('pa-seek-enter');
    this.node.classList.add('pa-seek-docked');
  }

  hide() {
    if (!this._armed && this.node.classList.contains('pa-gone')) return;
    this._armed = false;
    this._docked = false;
    clearTimeout(this._arriveT);
    this.node.classList.add('pa-gone');
    this.node.classList.remove('pa-seek-enter', 'pa-seek-docked', 'pa-seek-near', 'pa-seek-retarget');
  }

  /**
   * `heading` is degrees clockwise from north, matching the compass.
   * `guide` is `{ x, z, kind }` in world metres, or null when the weekend
   * has nothing left to point at.
   */
  update(x, z, heading, guide, dt) {
    if (!this._armed) return;
    if (!guide) { this.hide(); return; }

    const dx = guide.x - x;
    const dz = guide.z - z;
    const dist = Math.hypot(dx, dz);
    const bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
    const want = wrap180(bearing - heading);
    if (!Number.isFinite(this._ang)) this._ang = want;
    const k = Math.min(1, (dt > 0 ? dt : 0.016) * 7);
    this._ang += wrap180(want - this._ang) * k;
    this.needle.style.transform = `rotate(${this._ang.toFixed(1)}deg)`;

    const near = dist < 48;
    if (near !== this._near) {
      this._near = near;
      this.node.classList.toggle('pa-seek-near', near);
    }
    const label = dist > 32 ? distanceLabel(dist) : '';
    if (label !== this._label) {
      this._label = label;
      this.dist.textContent = label;
    }

    const kind = guide.kind ?? guide.beat ?? '';
    if (this._kind && kind && kind !== this._kind) {
      this.node.classList.remove('pa-seek-retarget');
      void this.node.offsetWidth;
      this.node.classList.add('pa-seek-retarget');
    }
    this._kind = kind;
  }

  dispose() {
    clearTimeout(this._arriveT);
    this.node?.remove();
  }
}
