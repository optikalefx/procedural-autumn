// ─────────────────────────────────────────────────────────────────────────────
//  Dash — speed, trip, and how much of the valley you have found.
//
//  Deliberately analogue: a swept dial with a needle, because a camper has a
//  dial and because a bare digital number gives you no sense of *how fast for
//  this vehicle* you are going. The digital figure sits inside it for when you
//  actually want to read it.
//
//  There is no fuel gauge. This game has no fail state, and a bar that can run
//  out implies one; a trip odometer and a count of animals found say the same
//  "you have been somewhere" without ever threatening the player.
//
//  The third readout used to be a leaf counting LANDMARKS — the waterfalls,
//  vistas, peaks and river bends `HUD.js` scatters and credits at 75 m. It was
//  the wrong number to put on the dash for one reason: nothing else in the game
//  shows it, so "0 of 12" was a score against a list the player could never
//  read. It now counts the animals on the scavenger sheet, which is a list they
//  can open and look at, and the glyph is the paw the compass strip and the
//  journal's empty slots already use for exactly that thing.
// ─────────────────────────────────────────────────────────────────────────────
import { el, polar, ICON } from './hud_dom.js';
import { RHYTHM_TARGET, RHYTHM_TOL } from '../boat/boat_physics.js';

// The compass strip's paw, at readout size. Shared rather than redrawn so the
// three places that mean "animal" — strip pin, journal slot, this counter —
// cannot drift apart; `hud_dom.js` explains why it is the one filled glyph in
// the set, and that is what lets it survive being set beside a numeral.
const PAW = `<span class="pa-paw">${ICON.paw}</span>`;

// The brake-hold lamp. A disc with two pads on it: the one shape that says
// "brake" without a word, and it survives being drawn at nine pixels because it
// is two arcs and a circle rather than anything with an inside.
const HOLD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="6.2"/>' +
  '<path d="M3.4 8.2a9.6 9.6 0 0 0 0 7.6M20.6 8.2a9.6 9.6 0 0 1 0 7.6"/></svg>';

// Full scale, and how the ticks are stepped under it, per craft. One dial
// face, two scales: a needle only says "how fast for *this* vehicle" — the
// reason the dial exists at all, per the header — if the sweep it swings over
// is sized for the thing being ridden.
//
// 120 km/h is the camper's. A paddle craft lives in a tenth of that.
// `boat_physics` tops a canoe at 3.2 m/s and a kayak at 3.8 unboosted; on flat
// water at full effort the stroke's surge-and-glide settles a canoe at
// 2.1–2.3 m/s and a kayak at 3.2–3.3 — 7.7–8.3 and 11.4–12.0 km/h. On the
// camper's dial that entire range moved the needle 20–27° out of 270 and left
// it pointing at the floor for the whole time the player was on the water,
// which is exactly the failure START was chosen to avoid.
//
// The rhythm bonus (see boat_physics.js's RHYTHM_* constants) changed what
// "full scale" has to cover: landing a sustained on-beat streak — scripted
// against the same drag model in tools/_scratch/rhythm_test.mjs, not a lake
// capture — oscillates a canoe through 18.2–26.5 km/h and a kayak through
// 22.5–31.4, before a river current (up to another 1.6 m/s at full discharge)
// stacks on top of that. A 20 km/h scale would pin the needle at the top for
// most of a boosted run, which is exactly the moment a dial is supposed to
// look like something is happening.
//
// 40 km/h full scale puts unboosted cruise back down around 19–34% — close to
// where the original 20-scale sat it, just compressed to make room — and a
// full-meter streak fills roughly half to three-quarters of the sweep, with
// a sliver held back at the top for a boosted hull riding a fast current.
//
// The bike gets its own, and the same arithmetic decides it. A mountain bike in
// this model settles around 7.6 m/s (27 km/h) on the flat, walks a climb at
// 4-8 km/h and will touch 45 downhill before the rider sits up. A 60 km/h dial
// puts the flat cruise at 45% of the sweep, leaves the whole top half for a
// descent — which is the reading a rider actually watches — and never sends the
// needle to the floor the way the camper's 120 would.
const SCALES = {
  camper: { max: 120, minor: 10, major: 40 },
  boat: { max: 40, minor: 4, major: 8 },
  bike: { max: 60, minor: 5, major: 20 },
};
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

// Redrawn only when the player boards or steps ashore, never per frame.
const ticksFor = ({ max, minor, major }) => {
  let out = '';
  for (let v = 0; v <= max; v += minor) {
    const a = START + (v / max) * SWEEP;
    const big = v % major === 0;
    const [xa, ya] = polar(50, 50, R - (big ? 7.5 : 4.5), a);
    const [xb, yb] = polar(50, 50, R - 1.5, a);
    out += `<path d="M${xa.toFixed(2)} ${ya.toFixed(2)}L${xb.toFixed(2)} ${yb.toFixed(2)}" ` +
           `stroke="rgba(255,246,234,${big ? 0.55 : 0.26})" stroke-width="${big ? 1.6 : 1}" stroke-linecap="round"/>`;
  }
  return out;
};

export class Dash {
  constructor(root) {
    this.node = el('div', 'pa-dash pa-panel pa-game-only');

    // ── dial ───────────────────────────────────────────────────────────────
    this.scale = SCALES.camper;

    const speedo = el('div', 'pa-speedo');
    speedo.innerHTML = `
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <path d="${arc(R, START, START + SWEEP)}" stroke="rgba(255,246,234,0.14)" stroke-width="3.4"
              fill="none" stroke-linecap="round"/>
        <path class="pa-dial-fill" d="${arc(R, START, START + SWEEP)}" stroke="url(#pa-dial-grad)"
              stroke-width="3.4" fill="none" stroke-linecap="round"
              stroke-dasharray="0 999" style="transition:stroke-dasharray .12s linear"/>
        <g class="pa-ticks">${ticksFor(this.scale)}</g>
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
    // ── brake-hold lamp ────────────────────────────────────────────────────
    // In the gap at the bottom of the dial, because that is where a car puts
    // its warning lamps and because the sweep starts at 225° specifically to
    // leave that gap empty. Absolutely positioned inside the dial rather than
    // added to the readout column, so a hold appearing and disappearing never
    // reflows the cluster — a speed number that jumps sideways when you park is
    // a worse tell than no lamp at all.
    //
    // No separate capture handling is needed: it lives inside #pa-hud, which
    // takes `.pa-capture-hidden` when the harness poses the camera. A review
    // sheet with a HOLD badge burned into ten tiles would be a regression.
    this.hold = el('div', 'pa-hold', `${HOLD_ICON}<span>Hold</span>`);
    this.hold.setAttribute('role', 'status');
    speedo.appendChild(this.hold);

    this.node.appendChild(speedo);
    this.node.appendChild(el('div', 'pa-dash-divider'));

    this.speedo = speedo;
    this.needle = speedo.querySelector('.pa-needle');
    this.ticks = speedo.querySelector('.pa-ticks');
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

    this._shown = { kmh: -1, trip: -1, found: -1, total: -1, hold: null, beat: null };
  }

  /**
   * @param {number} found — animals crossed off the scavenger sheet.
   * @param {number} total — animal lines on the sheet; see `HUNT_ANIMALS`.
   * @param {'camper'|'boat'|'bike'} scale — full scale of the dial; see SCALES.
   * @param {number} beatT — s since the last W press edge; drives the boat's
   *   once-a-second dial glow. Ignored for every other scale.
   */
  update(speedMs, tripM, found, total, hold = false, scale = 'camper', beatT = 0) {
    const sc = SCALES[scale] ?? SCALES.camper;
    if (sc !== this.scale) {
      this.scale = sc;
      this.ticks.innerHTML = ticksFor(sc);
      // The arc fill is written from the digital readout's change branch, which
      // caches on the rounded number — so a scale change that happens not to
      // move that number would otherwise leave the fill sized for the old dial.
      this._shown.kmh = -1;
    }

    const kmh = Math.abs(speedMs) * 3.6;
    const frac = Math.min(1, kmh / sc.max);
    this.needle.style.transform = `rotate(${(START + frac * SWEEP).toFixed(1)}deg)`;

    // Only on a change: this runs every frame and a class toggle is a style
    // recalculation whether or not the class actually differs.
    const held = !!hold;
    if (held !== this._shown.hold) {
      this._shown.hold = held;
      this.hold.classList.toggle('pa-on', held);
    }

    // ── paddle-beat glow ─────────────────────────────────────────────────
    // Boat mode only: the dial itself flashes once every RHYTHM_TARGET
    // seconds, on the same window boat_physics.js judges a tap by, instead of
    // a separate widget — see RHYTHM_TOL there for the window's width.
    const beat = scale === 'boat' && (() => {
      const lap = ((beatT % RHYTHM_TARGET) + RHYTHM_TARGET) % RHYTHM_TARGET;
      // Straddles the wrap — a beat right on target sits at both lap≈0 and
      // lap≈RHYTHM_TARGET — so both ends of the lap light up.
      return lap <= RHYTHM_TOL || lap >= RHYTHM_TARGET - RHYTHM_TOL;
    })();
    if (beat !== this._shown.beat) {
      this._shown.beat = beat;
      this.speedo.classList.toggle('pa-beat', beat);
    }

    const shown = Math.round(kmh);
    if (shown !== this._shown.kmh) {
      this._shown.kmh = shown;
      this.num.innerHTML = `${shown}<span class="pa-speed-unit">KM/H</span>`;
      this.fill.setAttribute('stroke-dasharray', `${(this.arcLen * frac).toFixed(1)} 999`);
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
      // "0 of 11", not "0/11": a slash reads as a score, and this is not one.
      this.foundEl.innerHTML = `${PAW}${found}<span class="pa-unit">of ${total}</span>`;
    }
  }
}
