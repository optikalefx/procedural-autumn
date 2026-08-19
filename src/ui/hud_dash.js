// ─────────────────────────────────────────────────────────────────────────────
//  Dash — speed, trip, and how much of the valley you have found.
//
//  Deliberately analogue: a swept dial with a needle, because a camper has a
//  dial and because a bare digital number gives you no sense of *how fast for
//  this vehicle* you are going. The digital figure sits inside it for when you
//  actually want to read it.
//
//  There is no fuel gauge. This game has no fail state, and a bar that can run
//  out implies one; a trip odometer and a count of landmarks found say the same
//  "you have been somewhere" without ever threatening the player.
// ─────────────────────────────────────────────────────────────────────────────
import { el, polar } from './hud_dom.js';

// A drawn leaf rather than a typographic ornament: ❧ renders as a different
// creature in every font on every platform, and looked like a green smudge.
const LEAF = '<span class="pa-leaf"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M5 19c0-7 5-12 14-13 1 9-4 14-11 14z"/><path d="M5 19c3-3 6-5 9-6"/></svg></span>';

const MAX_KMH = 120;
// Degrees clockwise from 12 o'clock. The gap belongs at the *bottom* — the
// first version started the sweep at 148° and the needle sat pointing at the
// floor for every speed a camper can actually reach.
const START = 225;
const SWEEP = 270;
const R = 40;

const arc = (r, a0, a1) => {
  const [x0, y0] = polar(50, 50, r, a0);
  const [x1, y1] = polar(50, 50, r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

export class Dash {
  constructor(root) {
    this.node = el('div', 'pa-dash pa-panel pa-game-only');

    // ── dial ───────────────────────────────────────────────────────────────
    let ticks = '';
    for (let v = 0; v <= MAX_KMH; v += 10) {
      const a = START + (v / MAX_KMH) * SWEEP;
      const major = v % 40 === 0;
      const [xa, ya] = polar(50, 50, R - (major ? 7.5 : 4.5), a);
      const [xb, yb] = polar(50, 50, R - 1.5, a);
      ticks += `<path d="M${xa.toFixed(2)} ${ya.toFixed(2)}L${xb.toFixed(2)} ${yb.toFixed(2)}" ` +
               `stroke="rgba(255,246,234,${major ? 0.55 : 0.26})" stroke-width="${major ? 1.6 : 1}" stroke-linecap="round"/>`;
    }

    const speedo = el('div', 'pa-speedo');
    speedo.innerHTML = `
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <path d="${arc(R, START, START + SWEEP)}" stroke="rgba(255,246,234,0.14)" stroke-width="3.4"
              fill="none" stroke-linecap="round"/>
        <path class="pa-dial-fill" d="${arc(R, START, START + SWEEP)}" stroke="url(#pa-dial-grad)"
              stroke-width="3.4" fill="none" stroke-linecap="round"
              stroke-dasharray="0 999" style="transition:stroke-dasharray .12s linear"/>
        ${ticks}
        <g class="pa-needle" style="transform-origin:50px 50px">
          <!-- A tail as well as a pointer: an analogue needle is balanced, and
               the counterweight is most of why it reads as one. -->
          <path d="M50 57 L50 ${(50 - R + 7).toFixed(1)}" stroke="#e8622a" stroke-width="2.1" stroke-linecap="round"/>
        </g>
        <circle cx="50" cy="50" r="2.8" fill="#fff6ea" opacity="0.92"/>
        <defs>
          <linearGradient id="pa-dial-grad" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stop-color="#f3cf45"/>
            <stop offset="1" stop-color="#e8622a"/>
          </linearGradient>
        </defs>
      </svg>
      `;
    this.node.appendChild(speedo);
    this.node.appendChild(el('div', 'pa-dash-divider'));

    this.needle = speedo.querySelector('.pa-needle');
    this.fill = speedo.querySelector('.pa-dial-fill');
    // Path length of the swept arc, so the fill can be driven by dasharray
    // without measuring it in the browser every frame.
    this.arcLen = (SWEEP / 360) * 2 * Math.PI * R;

    // ── readouts ───────────────────────────────────────────────────────────
    // The digital speed used to live inside the dial, where it collided with
    // the needle hub at every angle. A dial cannot hold a 30 px numeral and a
    // pivot in the same 20 px of middle; the number belongs beside it, where it
    // can also be the largest thing in the cluster.
    const reads = el('div', 'pa-readouts');
    const speedRow = el('div', 'pa-readout pa-speed-row');
    const speedVal = el('div', 'pa-speed-num', '0<span class="pa-speed-unit">KM/H</span>');
    speedRow.appendChild(speedVal);
    reads.appendChild(speedRow);
    this.num = speedVal;
    const mk = (label) => {
      const r = el('div', 'pa-readout');
      r.appendChild(el('div', 'pa-label', label));
      const v = el('div', 'pa-readout-value');
      r.appendChild(v);
      reads.appendChild(r);
      return v;
    };
    this.tripEl = mk('Trip');
    this.foundEl = mk('Found');
    this.node.appendChild(reads);
    root.appendChild(this.node);

    this._shown = { kmh: -1, trip: -1, found: -1, total: -1 };
  }

  update(speedMs, tripM, found, total) {
    const kmh = Math.abs(speedMs) * 3.6;
    const a = START + Math.min(1, kmh / MAX_KMH) * SWEEP;
    this.needle.style.transform = `rotate(${(a).toFixed(1)}deg)`;

    const shown = Math.round(kmh);
    if (shown !== this._shown.kmh) {
      this._shown.kmh = shown;
      this.num.innerHTML = `${shown}<span class="pa-speed-unit">KM/H</span>`;
      this.fill.setAttribute('stroke-dasharray',
        `${(this.arcLen * Math.min(1, kmh / MAX_KMH)).toFixed(1)} 999`);
    }

    // Two decimals under a kilometre, one above: a trip meter that reads
    // "0.00 km" for the first five minutes of play tells you nothing.
    const trip = tripM < 1000 ? `${(tripM / 1000).toFixed(2)}` : `${(tripM / 1000).toFixed(1)}`;
    if (trip !== this._shown.trip) {
      this._shown.trip = trip;
      this.tripEl.innerHTML = `${trip}<span class="pa-unit">KM</span>`;
    }
    if (found !== this._shown.found || total !== this._shown.total) {
      this._shown.found = found;
      this._shown.total = total;
      // "0 of 12", not "0/12": a slash reads as a score, and this is not one.
      this.foundEl.innerHTML = `${LEAF}${found}<span class="pa-unit">of ${total}</span>`;
    }
  }
}
