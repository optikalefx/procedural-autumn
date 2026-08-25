// ─────────────────────────────────────────────────────────────────────────────
//  Compass — a heading strip with the valley's landmarks pinned to it.
//
//  A strip rather than a dial, for one reason: the player is looking at a
//  horizon, and a strip is the horizon. A round compass in the corner asks you
//  to translate between two coordinate systems; this one asks you to look
//  slightly left.
//
//  It carries no waypoints, no objectives and no distances-to-target — the game
//  has no goals. It says "there is a waterfall that way, 700 m", which is an
//  invitation rather than an instruction. The two exceptions are the camp and
//  the camper: those are not discoveries, they are the way back, so HUD.js
//  pins them whenever the player is away from them.
// ─────────────────────────────────────────────────────────────────────────────
import { el, ICON, distanceLabel } from './hud_dom.js';

const SPAN_DEG = 130;             // degrees of heading visible across the strip
const CARDS = [
  [0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
  [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'],
];
// Six nearest landmarks, plus the pins HUD.js always sends (camp, camper) and
// any waterfall close enough to hear — see _refreshMarks for the arithmetic.
const MAX_POI = 14;

const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;

export class Compass {
  constructor(root) {
    this.node = el('div', 'pa-compass pa-game-only');
    this.node.setAttribute('aria-hidden', 'true');   // decorative; state is in the settings sheet
    this.track = el('div', 'pa-compass-track');
    this.node.appendChild(this.track);
    this.node.appendChild(el('div', 'pa-compass-caret'));
    root.appendChild(this.node);

    // Ticks every 15°, majors on the cardinals. Built once and moved by
    // transform — creating and destroying nodes every frame would be the only
    // GC pressure in the whole HUD.
    this.ticks = [];
    for (let d = 0; d < 360; d += 15) {
      const t = el('div', `pa-tick${d % 45 === 0 ? ' pa-major' : ''}`);
      t.dataset.deg = d;
      this.track.appendChild(t);
      this.ticks.push(t);
    }
    this.cards = CARDS.map(([deg, name]) => {
      const c = el('div', 'pa-card', name);
      c.dataset.deg = deg;
      this.track.appendChild(c);
      return c;
    });

    this.slots = [];
    for (let i = 0; i < MAX_POI; i++) {
      const s = el('div', 'pa-poi');
      const disc = el('div', 'pa-poi-disc');
      const dist = el('div', 'pa-poi-dist');
      s.appendChild(disc);
      s.appendChild(dist);
      s.style.opacity = '0';
      // On the strip, NOT in the track: the track's overflow:hidden was
      // guillotining the distance label and every second-row chip, and its
      // edge mask erased the pinned-behind-you markers it exists to keep.
      // Chips clamp their own x, so they never needed the clipping.
      this.node.appendChild(s);
      this.slots.push({ node: s, disc, dist, kind: null, key: null });
    }
    this._w = 0;
  }

  /**
   * `heading` is in degrees clockwise from north; `marks` is the shortlist of
   * landmarks HUD.js keeps sorted by distance.
   */
  update(heading, marks) {
    const w = this.node.clientWidth || this._w;
    if (!w) return;
    this._w = w;
    const pxPerDeg = w / SPAN_DEG;
    const half = w / 2;

    for (const t of this.ticks) {
      const x = wrap180(+t.dataset.deg - heading) * pxPerDeg + half;
      if (x < -20 || x > w + 20) { if (t.style.visibility !== 'hidden') t.style.visibility = 'hidden'; continue; }
      if (t.style.visibility === 'hidden') t.style.visibility = '';
      t.style.transform = `translateX(${x.toFixed(1)}px)`;
    }
    for (const c of this.cards) {
      const x = wrap180(+c.dataset.deg - heading) * pxPerDeg + half;
      if (x < -40 || x > w + 40) { if (c.style.visibility !== 'hidden') c.style.visibility = 'hidden'; continue; }
      if (c.style.visibility === 'hidden') c.style.visibility = '';
      // The label is centred on its tick, so it needs its own half-width back.
      c.style.transform = `translateX(${(x - c.offsetWidth / 2).toFixed(1)}px)`;
    }

    // Lay the landmarks out first, then resolve overlaps, then write the DOM.
    // Three peaks on the same bearing used to stack into one illegible blob.
    const place = this._place ??= [];
    place.length = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const m = marks[i];
      if (!m) continue;
      const delta = wrap180(m.bearing - heading);
      const x = delta * pxPerDeg + half;
      // Landmarks behind you are not hidden, they are pinned to the edge and
      // faded: knowing the falls are somewhere behind is useful, and a marker
      // that pops in and out at the screen edge is not. Clamped fully inside
      // the strip so the disc is never shown half-cut.
      const clamped = Math.max(14, Math.min(w - 14, x));
      place.push({ i, m, delta, x: clamped, off: Math.abs(x - clamped), row: 0 });
    }
    // Horizontal position carries the bearing, so crowding is resolved by
    // dropping a chip to a second row rather than by nudging it sideways.
    place.sort((a, b) => a.x - b.x);
    const rowLastX = [];
    for (const p of place) {
      let row = 0;
      while (rowLastX[row] !== undefined && p.x - rowLastX[row] < 40) row++;
      rowLastX[row] = p.x;
      p.row = Math.min(row, 2);
    }

    const used = new Set();
    for (const p of place) {
      const s = this.slots[p.i];
      const m = p.m;
      used.add(p.i);
      if (s.kind !== m.kind) {
        s.kind = m.kind;
        s.disc.innerHTML = ICON[m.kind] ?? ICON.vista;
      }
      const delta = p.delta;
      const off = p.off;
      const fade = off > 2 ? 0.28 : 1 - Math.min(0.55, Math.abs(delta) / 190);
      s.node.style.transform = `translate(${(p.x - 13).toFixed(1)}px, ${(p.row * 30).toFixed(0)}px)`;
      s.node.style.opacity = fade.toFixed(2);
      // Only the landmark you are actually facing carries its distance. Six
      // labels across a 620 px strip collide into an unreadable smear the
      // moment two of them share a bearing, and five of the six are answering
      // a question nobody asked.
      // `noLabel` is the paw's (HUD.js explains why an animal gets no range).
      const label = !m.noLabel && off < 2 && Math.abs(delta) < 24 ? distanceLabel(m.dist) : '';
      if (s._label !== label) { s._label = label; s.dist.textContent = label; }
      const near = Math.abs(delta) < 9 && off < 2;
      if (near !== s._near) { s._near = near; s.node.classList.toggle('pa-near', near); }
      if (m.found !== s._found) { s._found = m.found; s.node.classList.toggle('pa-found', !!m.found); }
    }
    for (let i = 0; i < this.slots.length; i++) {
      if (used.has(i)) continue;
      const s = this.slots[i];
      if (s.node.style.opacity !== '0') s.node.style.opacity = '0';
    }
  }
}
