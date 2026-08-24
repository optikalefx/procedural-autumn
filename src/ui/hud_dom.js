// Tiny DOM helpers + the HUD's icon set. Kept apart so the widget files read
// as layout and behaviour rather than as string concatenation.

export function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

export function button(cls, html, onClick, label) {
  const b = el('button', cls, html);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Landmark glyphs. Drawn as strokes rather than fills so they read at 12 px on
 * a bright gold hillside — a filled glyph at this size turns into a dot.
 */
const S = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" ` +
  `stroke-linecap="round" stroke-linejoin="round">${d}${extra}</svg>`;

export const ICON = {
  // A summit, with a shoulder behind it.
  peak: S('<path d="M2 19l7-12 5 8 3-4 5 8z"/>'),
  // A drop over a lip: the lip, the sheet, the pool.
  waterfall: S('<path d="M4 5h6M7 5v8M4 19h16M12 8c1.6 1.4 1.6 3.6 0 5"/><path d="M17 6c1.6 1.4 1.6 3.6 0 5"/>'),
  // Two banks and the water between them.
  river: S('<path d="M3 9c3-2 5 2 8 0s5-2 8 0M3 15c3-2 5 2 8 0s5-2 8 0"/>'),
  // A horizon seen from above: what a vista actually is.
  vista: S('<path d="M2 15h20M6 15a6 6 0 0 1 12 0"/><circle cx="12" cy="7" r="1.6"/>'),
  meadow: S('<path d="M4 20V9M9 20V6M14 20v-9M19 20V8"/>'),
  // A pitched tent: the ridge and the door.
  camp: S('<path d="M12 4.8 2.8 19h18.4z"/><path d="M12 11l-3.6 8M12 11l3.6 8"/>'),
  // The camper, side-on: cab, box, two wheels.
  car: S('<path d="M3.5 16.2V10a1.5 1.5 0 0 1 1.5-1.5h8.6l4.3 3.6h2.1a1.6 1.6 0 0 1 1.6 1.6v2.5h-2"/>' +
         '<circle cx="7.4" cy="16.4" r="1.8"/><circle cx="15.6" cy="16.4" r="1.8"/><path d="M9.2 16.4h4.4"/>'),

  gear: S('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5' +
          'M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8M18.7 18.7l-1.8-1.8M7.1 7.1L5.3 5.3"/>'),
  camera: S('<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2l1.4-2h7.8l1.4 2h2.2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.4"/>'),
  sound: S('<path d="M4 9.5h3.2L12 5.5v13L7.2 14.5H4z"/><path d="M15.6 9.4a4 4 0 0 1 0 5.2"/><path d="M18.2 7a7.6 7.6 0 0 1 0 10"/>'),
  muted: S('<path d="M4 9.5h3.2L12 5.5v13L7.2 14.5H4z"/><path d="M16.5 10l4 4M20.5 10l-4 4"/>'),
};

/** Metres → the way a person would say it. */
export function distanceLabel(m) {
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** Point on a circle, degrees clockwise from 12 o'clock. */
export function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
