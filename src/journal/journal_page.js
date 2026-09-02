// ─────────────────────────────────────────────────────────────────────────────
//  journal_page — one leaf of the journal, painted onto a CanvasTexture.
//
//  ── the layout decision that came first ────────────────────────────────────
//  The photo slots are not a decoration bolted onto a list of lines. They are
//  the tallest thing on the page, so the row height is DERIVED FROM THEM and
//  everything else fits around. The first pass did it the other way — a tidy
//  list of fifteen lines, with a plan to "find room for the photos later" — and
//  there is no later: fifteen lines at a readable size fills the page, and a
//  photograph then has nowhere to go but on top of the text. Four items per
//  page with a taped print beside each is the whole reason there are multiple
//  pages, and multiple pages are cheap because there is already a page turn.
//
//  ── recto and verso are not the same page ──────────────────────────────────
//  A page has a WIDE margin at the fold and a narrow one at the fore edge,
//  because text that runs into the gutter disappears into the curve of the
//  paper. Which side the fold is on flips every leaf. So a page knows whether
//  it is a recto (fold on the left) or a verso (fold on the right) and lays
//  itself out accordingly — and the verso's texture is sampled u-flipped by the
//  model, because a verso is the BACK face of a sheet and the back face of a
//  quad shows its texture mirrored. Getting this wrong is not subtle: the page
//  comes out in mirror writing.
//
//  ── the pencil ─────────────────────────────────────────────────────────────
//  A struck-off line is drawn, not composited. Three passes of a wobbly
//  polyline at low alpha with a graphite-coloured stroke, overshooting both
//  ends and hooking at the finish, because a single crisp 2 px line through a
//  word reads as `text-decoration: line-through` — i.e. as a web page. The
//  animation is driven by redrawing only the row's own rectangle over a cached
//  clean copy of the page, so the cost is a partial canvas blit rather than a
//  full repaint. NOTE the number that used to be here — "~40 ms" — was wrong by
//  an order of magnitude and is corrected in docs/JOURNAL_NOTES.md 9: Chromium
//  DEFERS 2D raster, so timing either side of a paint measures command
//  recording, and the 40 ms was a queue draining later. Measured with the
//  raster forced, a full repaint is ~2.5 ms. The partial blits are still the
//  right design (a rectangle instead of 1.5 M pixels); they were not saving a
//  dropped frame.
//
//  ── the tape ───────────────────────────────────────────────────────────────
//  Two pieces, both crooked, both a DIFFERENT crookedness, with torn short
//  edges and a soft shadow. Two axis-aligned translucent rectangles read as UI
//  chrome instantly; a two-degree rotation is the entire difference between
//  "stuck in a book" and "a div with opacity 0.6".
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { hand, brush } from './journal_fonts.js';
import { clamp01 } from '../core/MathUtils.js';

// Page pixel size. 1024 x 1452 is 148:210 (A5) to within half a pixel, and 1024
// across a leaf that fills ~500 CSS px of a 1600-wide frame is a shade over one
// texel per device pixel at photo mode's native density — which is the density
// the page has to survive, because photo mode pins the renderer to it.
export const PAGE_W = 1024;
export const PAGE_H = 1452;

/** Items per page. See the header: this falls out of the photo slot's height. */
export const ROWS_PER_PAGE = 4;

const INK = '#3a2b20';           // pen
const INK_SOFT = 'rgba(74,58,44,0.66)';
const GRAPHITE = '#494037';      // pencil

// Margins, in canvas pixels. The gutter margin is 40% wider than the fore-edge
// one for the reason in the header.
const M_FORE = 78;
const M_GUT = 112;
const M_TOP = 92;
const M_BOT = 84;

// The header band every list page reserves, whether or not it carries the big
// heading. Uniform so the first rows of a spread line up across the fold — two
// facing pages whose lists start at different heights look broken in a way
// nobody can name but everybody sees.
const HEAD_BAND = 196;
// ── the mystery leaf's one entry ─────────────────────────────────────────────
// It sits at the FOOT of the page rather than on the four-row grid: a leaf with
// a single line laid out on that grid puts the print at the top and leaves two
// thirds of the page empty. One description of where it went, because four
// separate things need it and they must not disagree — `_paintMystery` draws
// it, `slotRect` is what the click hit-test picks against, `rowUV` is what the
// close look frames, and `tickAt` blits the box back.
const MYST_BASE = 1118;                  // the entry's baseline; PAGE_H - M_BOT - 250

const ROW_H = 252;
const SLOT_W = 252;
const SLOT_H = 190;

// ── the two slots on the compare leaf ────────────────────────────────────────
//
// When a subject that is already crossed off is photographed again, the book
// opens on a blank leaf with the print that is IN the book beside the one just
// taken, and the player keeps one of them. See `Journal._armCompare`.
//
// The width falls out of the page and is not a taste: the text block is
// 1024 - 78 - 112 = 834 px across, and two prints side by side with a thumb's
// width of paper between them is 390 + 54 + 390. The height then falls out of
// the PRINT rather than out of the page — `_paste` takes 32 px of card and
// border off the width and 46 off the height, so holding the emulsion at the
// 220:126 the row slots use gives 269. Anything else and the two prints on the
// compare leaf are a different shape from the one in the checklist, which is
// the one thing this page must not do: the player is comparing them.
//
// Side by side rather than one above the other because that is what the request
// asked for, and it is also the right answer — two landscape prints stacked put
// 500 px of paper between the things being compared, and a decision between two
// images is made by looking back and forth along ONE line.
// And the BLOCK is packed short and wide, high up the leaf, which is the one
// number here that was arrived at by measuring rather than by reasoning. The
// framing is a contain-fit at 80% (`Journal._trackCloseZoom`), so on a 16:9
// window a tall rectangle binds on the HEIGHT and everything in it shrinks to
// fit — and a portrait A5 page is as tall a rectangle as this book has. Framing
// the whole text block put each print at 200 CSS px on a 1600 px window, which
// is smaller than the thumbnail in the checklist and useless for the one
// judgement this page exists to support. Measured, at 1600 x 900:
//
//     the whole leaf, M_TOP to M_BOT (h 1276)     201 px a print
//     heading + question + prints + captions + Esc (h 625)    449 px a print
//     the two prints and nothing else   (h 429)   598 px a print — and no
//                                                 question, no way out written
//                                                 down, so: no.
//
// 625 is the tightest block that still carries the question and the escape
// hatch, and it triples the thing the player came here to look at. Everything
// below it is bare paper, which is what a leaf out of the back of a notebook
// looks like anyway.
const CMP_W = 390;
const CMP_H = 269;
const CMP_GAP = 54;
const CMP_TOP = 288;
const CMP_CAPS = CMP_TOP + CMP_H + 68;      // caption baseline
const CMP_ESC = CMP_CAPS + 66;              // the way out, right under it
const CMP_BAND = { y: 96, h: 625 };         // what the camera frames

// ─────────────────────────────────────────────────────────────────────────────
//  Paper
// ─────────────────────────────────────────────────────────────────────────────

// The tooth is generated once per variant and blitted, not regenerated on every
// repaint: a per-pixel noise loop over 1.5 M pixels is ~35 ms, and the pencil
// animation repaints (part of) a page every frame.
const _paperCache = new Map();

function paperBase(variant) {
  const hit = _paperCache.get(variant);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  cv.width = PAGE_W; cv.height = PAGE_H;
  const g = cv.getContext('2d');

  g.fillStyle = '#eee1c4';
  g.fillRect(0, 0, PAGE_W, PAGE_H);

  // A slow warm/cool wash. Real paper in a book is never one value: it picks up
  // the light from the window on one side and the shadow of its own leaf on the
  // other, and a flat cream rectangle is the reason untextured UI panels look
  // like UI panels.
  const wash = g.createLinearGradient(0, 0, PAGE_W * 0.7, PAGE_H);
  wash.addColorStop(0, 'rgba(255,246,222,0.55)');
  wash.addColorStop(0.55, 'rgba(226,206,168,0.10)');
  wash.addColorStop(1, 'rgba(186,158,116,0.30)');
  g.fillStyle = wash;
  g.fillRect(0, 0, PAGE_W, PAGE_H);

  let s = (variant + 1) * 2654435761;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  // Foxing — the little rust-coloured age spots. Three or four, large and very
  // faint. More than that and the page looks mouldy rather than used.
  for (let i = 0; i < 5; i++) {
    const x = rnd() * PAGE_W, y = rnd() * PAGE_H, r = 40 + rnd() * 150;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(170,124,72,${0.05 + rnd() * 0.05})`);
    grd.addColorStop(1, 'rgba(170,124,72,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Tooth. Monochrome grain, ±7/255 — below the threshold where anyone sees
  // "noise" and above the one where the paper reads as vinyl.
  const img = g.getImageData(0, 0, PAGE_W, PAGE_H);
  const d = img.data;
  for (let i = 0; i < PAGE_W * PAGE_H; i++) {
    const n = (rnd() - 0.5) * 14;
    d[i * 4] += n; d[i * 4 + 1] += n; d[i * 4 + 2] += n * 0.8;
  }
  g.putImageData(img, 0, 0);

  _paperCache.set(variant, cv);
  return cv;
}

/** Drop everything the paper cache is holding. Called from Journal.dispose. */
export function disposePaperCache() { _paperCache.clear(); }

// ─────────────────────────────────────────────────────────────────────────────
//  Small hand-drawn marks
// ─────────────────────────────────────────────────────────────────────────────

/** A deterministic little RNG so a page looks the same every time it repaints. */
function rng(seed) {
  let s = (seed | 0) * 1103515245 + 12345;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/**
 * A line drawn by a hand: a slightly bowed polyline with per-vertex wobble,
 * drawn twice at low alpha so the overlaps darken the way a real pass does.
 */
function inkLine(g, x0, y0, x1, y1, { width = 3, alpha = 0.5, wobble = 2.2, bow = 0, seed = 1, passes = 2, colour = GRAPHITE, t = 1 } = {}) {
  const r = rng(seed);
  const n = 22;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const x = x0 + (x1 - x0) * u;
    const y = y0 + (y1 - y0) * u + Math.sin(u * Math.PI) * bow
      + (r() - 0.5) * wobble;
    pts.push([x, y]);
  }
  const cut = Math.max(1, Math.round(n * clamp01(t)));
  g.save();
  g.strokeStyle = colour;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let p = 0; p < passes; p++) {
    g.globalAlpha = alpha * (p === 0 ? 1 : 0.62);
    g.lineWidth = width * (p === 0 ? 1 : 0.55);
    g.beginPath();
    for (let i = 0; i <= cut; i++) {
      const [x, y] = pts[i];
      const jx = (p === 0 ? 0 : (r() - 0.5) * 2.4);
      const jy = (p === 0 ? 0 : (r() - 0.5) * 2.4);
      i ? g.lineTo(x + jx, y + jy) : g.moveTo(x + jx, y + jy);
    }
    g.stroke();
  }
  g.restore();
}

/** The hand-ruled box a checklist item is ticked in. Four separate strokes. */
function checkbox(g, x, y, s, seed) {
  const r = rng(seed);
  const j = () => (r() - 0.5) * 2.6;
  g.save();
  g.strokeStyle = INK;
  // Heavier than it looks right at 1:1 on the canvas. The page is read at ~55
  // degrees and about a third of its texture resolution, and a 3 px pen stroke
  // loses two of its four box sides to the mip chain at that angle — the
  // checkbox came out as a bracket. Thin strokes are the first thing a
  // CanvasTexture gives away.
  g.globalAlpha = 0.88;
  g.lineWidth = 5.0;
  g.lineCap = 'round';
  g.beginPath();
  // Drawn as four strokes that overshoot at the corners, like a pen box.
  g.moveTo(x + j(), y + j()); g.lineTo(x + s + j(), y + j());
  g.moveTo(x + s + j(), y - 2 + j()); g.lineTo(x + s + j(), y + s + j());
  g.moveTo(x + s + 2 + j(), y + s + j()); g.lineTo(x + j(), y + s + j());
  g.moveTo(x + j(), y + s + 2 + j()); g.lineTo(x + j(), y - 1 + j());
  g.stroke();
  g.restore();
}

/**
 * A paw print, drawn in the middle of an empty slot on a line that can be gone
 * looking for.
 *
 * This is the affordance, and it took a round to learn that it had to exist.
 * The click target was put on the empty slot — which is the right place, since
 * a row has a print or a slot and never both — but an empty slot with nothing
 * in it looks exactly like an empty slot, so the verb was invisible: the state
 * only appeared AFTER you had guessed there was something to click.
 *
 * Why a paw specifically, rather than a plus or a target reticle: it is the
 * same mark the compass puts on the strip when the animal is near
 * (`hud_dom.js` ICON.paw, and the shape here is that glyph's — three toes and
 * a pad). Marking the line in the book and the pin that appears on the horizon
 * are then plainly the same thing, which is the whole mechanic taught without
 * a word of instruction on a page that has no room for one.
 *
 * Pencil when it is only an offer, ink when it has been taken. Filled blobs
 * rather than outlines for the reason the HUD glyph gives: a stroked paw at
 * any small size closes its own gaps and reads as a smudge.
 */
function pawMark(g, cx, cy, s, { colour = GRAPHITE, alpha = 0.22, seed = 1 } = {}) {
  const r = rng(seed);
  // A hand-placed stamp is never quite square to the page.
  const tilt = (r() - 0.5) * 0.30;
  const blobs = [
    [-6.4, -4.0, 2.2, 2.4], [0, -6.0, 2.3, 2.6], [6.4, -4.0, 2.2, 2.4],
    [0, 4.6, 5.4, 4.3],
  ];
  g.save();
  g.translate(cx, cy);
  g.rotate(tilt);
  g.scale(s / 24, s / 24);
  g.fillStyle = colour;
  g.globalAlpha = alpha;
  for (const [x, y, rx, ry] of blobs) {
    g.beginPath();
    g.ellipse(x + (r() - 0.5) * 0.7, y + (r() - 0.5) * 0.7,
      rx * (0.94 + r() * 0.12), ry * (0.94 + r() * 0.12), (r() - 0.5) * 0.4, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}


// ─────────────────────────────────────────────────────────────────────────────
//  The win stamp
// ─────────────────────────────────────────────────────────────────────────────
//
// The one PRINTED thing in a hand-written book, and that contrast is the whole
// idea. Every other mark on these pages is somebody's pen: wobbled, overshot,
// drawn twice so the passes darken. A rubber stamp is a manufactured object
// pressed onto paper, and it should look like it arrived from outside the
// journal — which is exactly what winning is.
//
// ── the green ────────────────────────────────────────────────────────────────
//
// `#4e7346` is not a UI green, it is the CONIFER from `DESIGN_BRIEF`'s palette
// table — the "deep, desaturated, cool" note the brief calls the visual rest in
// a hot palette. That makes it the only green the game actually owns, and on
// cream paper under `multiply` it soaks in as ink rather than sitting on top as
// a sticker. A brighter one was tried and reads as a web badge.
//
// ── what makes it a stamp and not a circle with type in it ───────────────────
//
//   · **it is pressed, so it is uneven.** Everything is drawn opaque into a
//     scratch canvas and then eaten into with `destination-out` — a scatter of
//     soft blobs and a few long streaks where the pad was dry. Without this it
//     is a printed logo; with it, it is a stamp.
//   · **it rocked.** A faint second impression 3 px off, under the first. That
//     is what happens when a hand does not press square.
//   · **`multiply`.** Ink darkens paper; it does not replace it. The ruled
//     lines of the Notes page show straight through, which is most of why it
//     reads as ON the page rather than composited over it.
//   · **the rings are not circles.** Radius jitter around the sweep, same
//     principle as `inkLine` — a die cut by hand and worn by use.
//
// ── the composition ──────────────────────────────────────────────────────────
//
// Arced type top and bottom, a fat check and the words in the middle, and two
// diamonds at the sides to close the arcs. The check is `tick` — the same mark
// the player has watched go into eighteen boxes, at seven times the size.
const STAMP_INK = '#4e7346';

function winStamp(g, cx, cy, R, seed, t = 1) {
  if (t <= 0 || typeof document === 'undefined') return;
  const r = rng(seed);
  const S = Math.ceil(R * 2.3);
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const q = c.getContext('2d');
  if (!q) return;
  q.translate(S / 2, S / 2);
  q.strokeStyle = STAMP_INK;
  q.fillStyle = STAMP_INK;
  q.lineCap = 'round';
  q.lineJoin = 'round';

  // ── the rings ──────────────────────────────────────────────────────────────
  const ring = (rad, w, jitter) => {
    q.lineWidth = w;
    q.beginPath();
    const n = 190;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = rad + Math.sin(a * 3.1 + seed) * jitter + (r() - 0.5) * jitter * 0.8;
      const x = Math.sin(a) * rr, y = -Math.cos(a) * rr;
      i ? q.lineTo(x, y) : q.moveTo(x, y);
    }
    q.closePath();
    q.stroke();
  };
  ring(R * 0.97, R * 0.055, R * 0.006);
  ring(R * 0.845, R * 0.018, R * 0.005);

  // ── the arced type ─────────────────────────────────────────────────────────
  //
  // Angles are measured clockwise from straight up, which is what `rotate(a)`
  // then `translate(0, -rad)` gives you. The bottom arc runs the other way and
  // flips each glyph, so it reads left to right along the underside instead of
  // upside down along the top of nothing.
  const arc = (txt, rad, size, bottom) => {
    q.font = hand(size, 700);
    q.textAlign = 'center';
    q.textBaseline = 'middle';
    const chars = [...txt];
    const step = chars.map((ch) => (q.measureText(ch).width + size * 0.30) / rad);
    const span = step.reduce((a, b) => a + b, 0);
    let a = bottom ? Math.PI + span / 2 : -span / 2;
    for (let i = 0; i < chars.length; i++) {
      const half = step[i] / 2;
      q.save();
      q.rotate(bottom ? a - half : a + half);
      q.translate(0, -rad);
      if (bottom) q.rotate(Math.PI);
      q.fillText(chars[i], 0, 0);
      q.restore();
      a += bottom ? -step[i] : step[i];
    }
  };
  // Both arcs have to finish before the diamonds at three and nine o'clock, so
  // neither string may run much past 120 degrees of sweep. An earlier bottom
  // line ran to 136 and put its first and last letters behind the two marks
  // that are supposed to CLOSE the arcs — which is the whole constraint here,
  // and the reason a longer line gets set smaller rather than let to spread.
  arc('CAMPING SEASON', R * 0.740, R * 0.130, false);
  arc('CONGRATULATIONS', R * 0.750, R * 0.112, true);

  // The two diamonds that close the arcs, at three and nine o'clock.
  for (const sx of [-1, 1]) {
    q.save();
    q.translate(sx * R * 0.735, 0);
    q.rotate(Math.PI * 0.25);
    q.fillRect(-R * 0.036, -R * 0.036, R * 0.072, R * 0.072);
    q.restore();
  }

  // ── the check, and the words ───────────────────────────────────────────────
  // The band between the two arcs is about 340 units of a 536-unit stamp, and
  // the check and the words have to share it without either touching type that
  // is curving toward them. `tick` runs from y-0.30s to y+0.92s, so the check's
  // own extent is written out here rather than eyeballed.
  const ck = R * 0.42;
  tick(q, -ck * 0.56, -R * 0.44, ck, seed + 3, 1,
    { colour: STAMP_INK, width: R * 0.082, alpha: 1 });

  q.font = brush(R * 0.345);
  q.textAlign = 'center';
  q.textBaseline = 'alphabetic';
  q.fillText('YOU WIN', 0, R * 0.335);

  // ── the pad was not evenly inked ───────────────────────────────────────────
  q.globalCompositeOperation = 'destination-out';
  // Many small bites rather than few big ones. The first pass used blobs up to
  // 7.5% of the stamp across and it read as mould on the paper rather than as
  // a pad that had not taken ink evenly — the tell is that real starve marks
  // are at the scale of the paper's tooth, not of the artwork.
  for (let i = 0; i < 340; i++) {
    const a = r() * Math.PI * 2;
    // Biased outward: the middle of a stamp takes ink best and the rim is where
    // it starves, which is also where the eye reads the shape from.
    const rad = R * (0.15 + Math.sqrt(r()) * 0.92);
    const w = R * (0.006 + r() * 0.030);
    q.globalAlpha = 0.14 + r() * 0.38;
    q.beginPath();
    q.ellipse(Math.sin(a) * rad, -Math.cos(a) * rad, w, w * (0.4 + r()), r() * 3.14, 0, Math.PI * 2);
    q.fill();
  }
  // …and three dry streaks, which is what a pad that has sat open does.
  q.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const a = r() * Math.PI * 2, len = R * (0.5 + r() * 0.9);
    q.globalAlpha = 0.26 + r() * 0.30;
    q.lineWidth = R * (0.008 + r() * 0.016);
    q.beginPath();
    q.moveTo(Math.cos(a) * -len / 2, Math.sin(a) * -len / 2);
    q.lineTo(Math.cos(a) * len / 2, Math.sin(a) * len / 2);
    q.stroke();
  }

  // ── onto the page ──────────────────────────────────────────────────────────
  // `t` is the slam: it comes down oversized and settles, so the beat has
  // weight rather than fading in like a notification.
  const k = 1 + (1 - clamp01(t)) * 0.5;
  const tilt = -0.105;
  g.save();
  g.globalCompositeOperation = 'multiply';
  g.translate(cx, cy);
  g.rotate(tilt);
  g.scale(k, k);
  // The rock: a faint second impression, under the first and off to one side.
  g.globalAlpha = 0.16 * clamp01(t * 1.4);
  g.drawImage(c, -S / 2 + R * 0.016, -S / 2 + R * 0.012);
  g.globalAlpha = 0.88 * clamp01(t * 1.4);
  g.drawImage(c, -S / 2, -S / 2);
  g.restore();
}

/**
 * A pen ring round something, the way a person marks the line they are working
 * on. This is what a targeted row wears.
 *
 * Deliberately NOT a checkbox, a chip or a second tick: the page already has a
 * box that means "found", and a control that looks like it would be read as
 * one. What a ring means is unambiguous on any list ever written — *this one* —
 * and it is the only mark on the page that says something about the player's
 * intention rather than about the world.
 *
 * Drawn as one continuous overshooting sweep rather than a closed ellipse,
 * because a closed ellipse is a UI ring and the overshoot is the whole tell of
 * a pen: it starts, goes round, and crosses its own beginning. `over` is how
 * far past the start it runs, in radians.
 */
function circleMark(g, cx, cy, rx, ry, { seed = 1, colour = INK, alpha = 0.72, width = 4.2, over = 0.5, tilt = -0.09, t = 1 } = {}) {
  const r = rng(seed);
  const n = 40;
  const span = Math.PI * 2 + over;
  // Start at the lower left, where a right-handed person's pen lands.
  const a0 = Math.PI * 0.78;
  const cos = Math.cos(tilt), sin = Math.sin(tilt);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + span * (i / n);
    // The wobble grows a little as the stroke goes round, so the ring does not
    // close exactly on itself — the same reason `inkLine` wobbles at all.
    const w = 1.1 + 1.5 * (i / n);
    const ex = Math.cos(a) * rx + (r() - 0.5) * w;
    const ey = Math.sin(a) * ry + (r() - 0.5) * w;
    pts.push([cx + ex * cos - ey * sin, cy + ex * sin + ey * cos]);
  }
  const cut = Math.max(1, Math.round(n * clamp01(t)));
  g.save();
  g.strokeStyle = colour;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let p = 0; p < 2; p++) {
    g.globalAlpha = alpha * (p === 0 ? 1 : 0.55);
    g.lineWidth = width * (p === 0 ? 1 : 0.5);
    g.beginPath();
    for (let i = 0; i <= cut; i++) {
      const [x, y] = pts[i];
      const jx = p === 0 ? 0 : (r() - 0.5) * 2.2;
      const jy = p === 0 ? 0 : (r() - 0.5) * 2.2;
      i ? g.lineTo(x + jx, y + jy) : g.moveTo(x + jx, y + jy);
    }
    g.stroke();
  }
  g.restore();
}

/**
 * A tick, drawn in two strokes with the second one long and fast.
 *
 * `opts` exists for the win stamp, which needs this same shape big and in
 * green. One tick in the book at three sizes beats a second tick shape that
 * only ever appears once — the check on the stamp should be recognisably the
 * mark the player has watched go into eighteen boxes.
 */
function tick(g, x, y, s, seed, t = 1, { colour = GRAPHITE, width = 6.2, alpha = 0.86 } = {}) {
  const r = rng(seed);
  g.save();
  g.strokeStyle = colour;
  g.globalAlpha = alpha;
  g.lineWidth = width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const p0 = [x + s * 0.02, y + s * 0.52];
  const p1 = [x + s * 0.36, y + s * 0.92];
  const p2 = [x + s * 1.18, y - s * 0.30];
  const a = clamp01(t * 2), b = clamp01(t * 2 - 1);
  g.beginPath();
  g.moveTo(p0[0], p0[1]);
  g.lineTo(p0[0] + (p1[0] - p0[0]) * a, p0[1] + (p1[1] - p0[1]) * a);
  if (b > 0) g.lineTo(p1[0] + (p2[0] - p1[0]) * b + (r() - 0.5) * 2, p1[1] + (p2[1] - p1[1]) * b);
  g.stroke();
  g.restore();
}

/**
 * One piece of masking tape.
 *
 * The short edges are torn (a jagged path), the long edges are clean, the whole
 * thing is rotated a couple of degrees, and it casts a soft shadow onto what it
 * is stuck to. The fill is warm and translucent so whatever is under it shows
 * through slightly darker — that show-through is most of why it reads as tape
 * rather than as a beige rectangle.
 *
 * `px` is how many DEVICE pixels one page pixel is being drawn at, and it exists
 * for `printPatch` (which draws this same strip into a canvas 2-5x the page's
 * own resolution). It scales the blur radius and nothing else — MEASURED, not
 * assumed: `g.filter = 'blur(6px)'` is in device pixels and is NOT affected by
 * the context transform, so a `scale(3)` transform makes the same call blur a
 * third as far in page coordinates. (Probed in Chromium: a 6 px blur reaches 11
 * page px at scale 1, 5.5 at scale 2, 3.67 at scale 3.) Every other length here
 * IS in page coordinates and the transform handles it.
 */
function tapeStrip(g, cx, cy, w, h, angle, seed, px = 1) {
  const r = rng(seed);
  g.save();
  g.translate(cx, cy);
  g.rotate(angle);

  const path = new Path2D();
  const teeth = 7;
  path.moveTo(-w / 2, -h / 2);
  path.lineTo(w / 2, -h / 2 + (r() - 0.5) * 2);
  for (let i = 0; i <= teeth; i++) {          // torn right edge
    const u = i / teeth;
    path.lineTo(w / 2 + (r() - 0.5) * 7, -h / 2 + h * u);
  }
  path.lineTo(-w / 2, h / 2 + (r() - 0.5) * 2);
  for (let i = teeth; i >= 0; i--) {          // torn left edge
    const u = i / teeth;
    path.lineTo(-w / 2 + (r() - 0.5) * 7, -h / 2 + h * u);
  }
  path.closePath();

  // Shadow first, offset down-right to agree with the key light in the scene.
  // HALF what it was: masking tape is two hundredths of a millimetre thick and
  // the old shadow (0.34 at 4 px, offset 2.5/4) plus the sheen below made each
  // strip read as a raised beige BAR lying across the print at gameplay size.
  // The tape itself — translucent, torn-edged, crooked — was never the problem.
  g.save();
  g.translate(1.4, 2.2);
  g.filter = `blur(${(3 * px).toFixed(2)}px)`;
  g.fillStyle = 'rgba(84,62,40,0.17)';
  g.fill(path);
  g.restore();

  const grd = g.createLinearGradient(0, -h / 2, 0, h / 2);
  grd.addColorStop(0, 'rgba(246,238,214,0.52)');
  grd.addColorStop(0.42, 'rgba(232,222,192,0.44)');
  grd.addColorStop(1, 'rgba(240,232,206,0.50)');
  g.fillStyle = grd;
  g.fill(path);

  // The sheen: one bright band along the tape, which is what a plastic-backed
  // tape does under a raking light and what stops it looking like paper.
  const sh = g.createLinearGradient(0, -h / 2, 0, h / 2);
  sh.addColorStop(0.26, 'rgba(255,255,255,0)');
  sh.addColorStop(0.40, 'rgba(255,255,255,0.15)');
  sh.addColorStop(0.52, 'rgba(255,255,255,0)');
  g.fillStyle = sh;
  g.fill(path);

  g.strokeStyle = 'rgba(150,124,88,0.28)';
  g.lineWidth = 1.2;
  g.stroke(path);
  g.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Photo decoding
// ─────────────────────────────────────────────────────────────────────────────

const _imgCache = new Map();

/**
 * Decode a data URL into an Image, once.
 *
 * Never rejects: a photo that will not decode should leave an empty slot in the
 * journal, not take the ceremony down halfway through. The store's photos are
 * JPEG data URLs it wrote itself, so this is defensive rather than expected.
 */
export function loadPhoto(dataURL) {
  if (!dataURL) return Promise.resolve(null);
  const hit = _imgCache.get(dataURL);
  if (hit) return hit;
  const p = new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => { console.warn('[journal] a stored photo would not decode'); resolve(null); };
    im.src = dataURL;
  });
  _imgCache.set(dataURL, p);
  return p;
}

/**
 * Give a decode back.
 *
 * The cache is keyed by the data URL and holds the decoded `Image` for the life
 * of the page, which is right for the STORE's photographs — there are at most
 * fifteen and the book asks for the same ones over and over. It is wrong for a
 * candidate the player was offered and turned down (`Journal._armCompare`):
 * that string is never written to the store, is different every shutter press,
 * and would pin a full-size decode for the rest of the session for every
 * re-photograph of an already-found subject.
 *
 * Only ever called for a URL the caller knows is not in the store. A cached
 * decode of a stored photo must stay: dropping it would make leafing back to a
 * page re-decode every print on it.
 */
export function forgetPhoto(dataURL) {
  if (dataURL) _imgCache.delete(dataURL);
}

/** Cover-fit `img` into a w x h box at the origin. */
function drawCover(g, img, w, h) {
  const ar = img.width / img.height, box = w / h;
  let sw = img.width, sh = img.height, sx = 0, sy = 0;
  if (ar > box) { sw = img.height * box; sx = (img.width - sw) / 2; }
  else { sh = img.width / box; sy = (img.height - sh) / 2; }
  g.drawImage(img, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
}

// ─────────────────────────────────────────────────────────────────────────────
//  A page
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param spec {
 *   kind: 'title' | 'list' | 'notes',
 *   verso: boolean,               // fold on the right
 *   index: number,                // page number as printed
 *   heading: string|null,         // the big brush heading, first list page only
 *   progress: string|null,        // "four of fourteen found"
 *   rows: [{ id, subject, hint, done, photo, pending }],
 *   seed: number,
 * }
 */
export class JournalPage {
  constructor(spec) {
    this.spec = spec;
    this.canvas = document.createElement('canvas');
    this.canvas.width = PAGE_W;
    this.canvas.height = PAGE_H;
    this.g = this.canvas.getContext('2d');

    // The clean copy the pencil animation blits back from. Allocated lazily —
    // most pages never animate.
    this._clean = null;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 16;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    // A verso is the back face of a sheet, and a back face shows its texture
    // mirrored. Sample it flipped so the writing is the right way round. See
    // the file header — this is the one that produces mirror writing.
    if (spec.verso) { this.texture.repeat.x = -1; this.texture.offset.x = 1; }
    this.texture.needsUpdate = true;
  }

  /** Left and right edge of the text block, accounting for which fold this is. */
  get _x0() { return this.spec.verso ? M_FORE : M_GUT; }
  get _x1() { return PAGE_W - (this.spec.verso ? M_GUT : M_FORE); }

  /** Top-left of row `i`'s box. */
  _rowTop(i) { return M_TOP + HEAD_BAND + i * ROW_H; }

  /** The photo slot rect for row `i`, in canvas pixels. */
  slotRect(i) {
    return {
      x: this._x1 - SLOT_W,
      y: this.spec.kind === 'mystery' ? MYST_BASE + 34 : this._rowTop(i) + 8,
      w: SLOT_W,
      h: SLOT_H,
    };
  }

  /**
   * Where row `i`'s photo lands, in page UV (0..1, v measured from the BOTTOM
   * so it matches a THREE.PlaneGeometry's uv attribute).
   *
   * A verso's texture is sampled u-flipped, so its geometry u is 1 - canvas u.
   */
  slotUV(i) {
    return this._toUV(this.slotRect(i));
  }

  /**
   * Row `i`'s WHOLE band — label, hint, checkbox and photo slot — in page UV.
   *
   * `slotUV` is where a print lands; this is what a reader is actually looking
   * at when they lean in on one. A photograph is landscape and sits beside its
   * line rather than above it, so framing the print alone puts the entry it
   * belongs to off the side of the screen — the interesting rectangle is the
   * row. Same convention as `slotUV`, including the verso u-flip.
   */
  rowUV(i) {
    return this._toUV({
      x: this._x0,
      // The mystery entry's band starts above its own line rather than at a
      // grid row, so leaning in on it frames the line and the slot together.
      y: this.spec.kind === 'mystery' ? MYST_BASE - 86 : this._rowTop(i),
      w: this._x1 - this._x0,
      h: ROW_H,
    });
  }

  /**
   * Slot `k` of the compare leaf — 0 is the print in the book, 1 is the new one.
   *
   * Left is the incumbent and right is the challenger, in reading order, and
   * that is deliberate: this leaf is read left to right like every other page
   * in the book, so "what you have" comes before "what you could have". The
   * captions say which is which in words — see `_paintCompare` — because a
   * convention nobody was told is not an answer to "which is which".
   */
  compareSlot(k) {
    return {
      x: this._x0 + (k ? CMP_W + CMP_GAP : 0),
      y: CMP_TOP,
      w: CMP_W,
      h: CMP_H,
    };
  }

  compareSlotUV(k) { return this._toUV(this.compareSlot(k)); }

  /**
   * What the camera frames while the compare leaf is up: the whole text block.
   *
   * NOT the pair of prints. The heading says what has happened, the captions
   * say which print is which and the line at the foot says what Escape does —
   * a framing that shows only the two photographs would put every one of those
   * off the screen, and this is the one page in the book that asks a question.
   */
  compareFrameUV() {
    return this._toUV({
      x: this._x0, y: CMP_BAND.y, w: this._x1 - this._x0, h: CMP_BAND.h,
    });
  }

  /** A canvas-pixel rect as a page-UV centre and size. See `slotUV`. */
  _toUV(r) {
    const cu = (r.x + r.w / 2) / PAGE_W;
    const cv = (r.y + r.h / 2) / PAGE_H;
    return {
      u: this.spec.verso ? 1 - cu : cu,
      v: 1 - cv,
      w: r.w / PAGE_W,
      h: r.h / PAGE_H,
    };
  }

  // ── painting ──────────────────────────────────────────────────────────────

  paint() {
    const g = this.g, s = this.spec;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, PAGE_W, PAGE_H);
    g.drawImage(paperBase(s.seed % 3), 0, 0);

    this._gutterShade(g);

    // `compare` is a transient overlay on whatever leaf is carrying it, not a
    // fourth `kind`: the leaf goes back to being itself the moment the choice
    // is made, so the book has no page a player can leaf to and find two
    // photographs of somebody else's decision. See `Journal._armCompare`.
    if (s.compare) this._paintCompare(g);
    else if (s.kind === 'title') this._paintTitle(g);
    // The mystery leaf IS a notes leaf until it is not. See `_paintMystery`:
    // the whole effect depends on a player having leafed past this page and
    // found it empty, so the blank state has to be a real blank page rather
    // than a locked one — no box, no dashes, nothing to be curious about.
    else if (s.kind === 'mystery') { if (s.open) this._paintMystery(g); else this._paintNotes(g); }
    else if (s.kind === 'notes') this._paintNotes(g);
    else this._paintList(g);

    this._folio(g);
    this._clean = null;                 // the cached clean copy is now stale
    this.texture.needsUpdate = true;
  }

  /**
   * The fold shadow.
   *
   * Real and necessary: an open book is two planes leaning into each other and
   * the gutter is the darkest thing on the spread. The page geometry does curve
   * down into the fold, but at this scale the curvature alone gives a gradient
   * of maybe two values — nowhere near enough. Painting it is honest here
   * because the fold is always in the same place on the page.
   */
  _gutterShade(g) {
    const v = this.spec.verso;
    const grd = v
      ? g.createLinearGradient(PAGE_W, 0, PAGE_W - 190, 0)
      : g.createLinearGradient(0, 0, 190, 0);
    grd.addColorStop(0, 'rgba(78,54,32,0.42)');
    grd.addColorStop(0.35, 'rgba(88,62,38,0.14)');
    grd.addColorStop(1, 'rgba(88,62,38,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, PAGE_W, PAGE_H);
    // And a thin bright line just outside it — the paper catching light as it
    // comes back up out of the fold. Cheap, and it is what makes the gutter
    // read as a curve rather than as a smudge.
    const lg = v
      ? g.createLinearGradient(PAGE_W - 150, 0, PAGE_W - 230, 0)
      : g.createLinearGradient(150, 0, 230, 0);
    lg.addColorStop(0, 'rgba(255,248,226,0.30)');
    lg.addColorStop(1, 'rgba(255,248,226,0)');
    g.fillStyle = lg;
    g.fillRect(0, 0, PAGE_W, PAGE_H);
  }

  _folio(g) {
    if (this.spec.index == null) return;
    g.save();
    g.font = hand(30);
    g.fillStyle = INK_SOFT;
    g.textAlign = this.spec.verso ? 'left' : 'right';
    g.fillText(String(this.spec.index),
      this.spec.verso ? M_FORE : PAGE_W - M_FORE, PAGE_H - M_BOT + 26);
    g.restore();
  }

  // ── the title leaf ────────────────────────────────────────────────────────

  _paintTitle(g) {
    const cx = (this._x0 + this._x1) / 2;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';

    g.fillStyle = INK;
    g.font = brush(96);
    g.fillText('Camping', cx, 372);
    g.fillText('Season', cx, 470);

    // The subtitle belongs to the title, so the rule goes UNDER BOTH. It used
    // to sit between them, which cut the title block in half and made
    // "scavenger hunt" read as a separate item further down the page rather
    // than as the second line of the same masthead. Same ink, shorter, and now
    // it is the thing that closes the block.
    g.font = hand(58, 400);
    g.fillStyle = INK_SOFT;
    g.fillText('scavenger hunt', cx, 546);
    inkLine(g, cx - 190, 592, cx + 190, 595,
      { seed: 4, width: 2.6, alpha: 0.5, colour: '#5c452e' });

    this._vignetteDoodle(g, cx, 800, 240);

    // How to play, in the keeper's own hand. This block replaced the
    // "kept by / season" flyleaf lines: a player meeting the book for the
    // first time needs the three keys more than they need a blank to admire.
    g.font = hand(40);
    g.fillStyle = INK_SOFT;
    g.fillText('Welcome to Camping Season!', cx, 1032);
    g.fillText('Enjoy a quiet drive through the forest.', cx, 1096);
    g.fillText('See if you can find everything in this journal.', cx, 1160);
    g.font = hand(32);
    g.fillStyle = 'rgba(74,58,44,0.58)';
    g.fillText('Good luck!', cx, 1230);

    g.textAlign = 'center';
    g.font = hand(30);
    g.fillStyle = 'rgba(74,58,44,0.44)';
    g.fillText('The letter "J" opens this book, any time', cx, PAGE_H - 168);
  }

  /**
   * A pen sketch of a ridge with two firs and a tent, drawn as strokes.
   *
   * It exists because a title page with nothing but type on it reads as a
   * splash screen. It is drawn very light and very small; it is a margin
   * doodle, not an illustration, and the moment it competes with the type it
   * has failed.
   */
  _vignetteDoodle(g, cx, cy, w) {
    const h = w * 0.52;
    g.save();
    g.translate(cx - w / 2, cy - h / 2);
    g.strokeStyle = '#5c452e';
    g.globalAlpha = 0.55;
    g.lineWidth = 2.6;
    g.lineJoin = 'round';
    g.lineCap = 'round';

    // Ridge line
    g.beginPath();
    g.moveTo(0, h * 0.78);
    g.lineTo(w * 0.16, h * 0.52);
    g.lineTo(w * 0.28, h * 0.66);
    g.lineTo(w * 0.46, h * 0.18);
    g.lineTo(w * 0.60, h * 0.44);
    g.lineTo(w * 0.72, h * 0.30);
    g.lineTo(w * 0.88, h * 0.62);
    g.lineTo(w, h * 0.50);
    g.stroke();
    // Snow hatching on the tallest peak
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(w * 0.42, h * 0.28); g.lineTo(w * 0.50, h * 0.29);
    g.moveTo(w * 0.44, h * 0.36); g.lineTo(w * 0.545, h * 0.37);
    g.stroke();

    // Two firs
    g.lineWidth = 2.4;
    for (const [fx, fs] of [[w * 0.20, 1.0], [w * 0.32, 0.72]]) {
      const base = h * 0.98, top = base - h * 0.42 * fs;
      g.beginPath();
      g.moveTo(fx, base);
      g.lineTo(fx, top);
      for (let i = 0; i < 3; i++) {
        const y = top + (base - top) * (0.22 + i * 0.26);
        const sp = w * 0.035 * fs * (1 + i * 0.55);
        g.moveTo(fx - sp, y + sp * 0.7); g.lineTo(fx, y - sp * 0.3); g.lineTo(fx + sp, y + sp * 0.7);
      }
      g.stroke();
    }

    // Tent
    g.beginPath();
    g.moveTo(w * 0.62, h * 0.98);
    g.lineTo(w * 0.74, h * 0.66);
    g.lineTo(w * 0.86, h * 0.98);
    g.closePath();
    g.moveTo(w * 0.74, h * 0.66); g.lineTo(w * 0.74, h * 0.98);
    g.stroke();

    // Ground
    g.lineWidth = 2.0;
    g.globalAlpha = 0.4;
    g.beginPath();
    g.moveTo(-w * 0.04, h * 0.99); g.lineTo(w * 1.04, h * 0.985);
    g.stroke();
    g.restore();
  }

  // ── the checklist ─────────────────────────────────────────────────────────

  _paintList(g) {
    const s = this.spec;
    const x0 = this._x0, x1 = this._x1;

    if (s.heading) {
      g.textAlign = 'left';
      g.fillStyle = INK;
      // Fitted rather than fixed: "CAMP SCAVENGER HUNT" at 74 px is 20 px wider
      // than the text block on a verso, and a heading that touches the fore
      // edge is the first thing a reader notices.
      let size = 76;
      g.font = brush(size);
      while (g.measureText(s.heading).width > (x1 - x0) && size > 46) {
        size -= 2; g.font = brush(size);
      }
      g.fillText(s.heading, x0, M_TOP + 74);
      inkLine(g, x0, M_TOP + 104, x1, M_TOP + 107, { seed: 3, width: 3.0, alpha: 0.5, colour: '#5c452e' });
    } else {
      g.textAlign = s.verso ? 'left' : 'right';
      g.font = hand(32);
      g.fillStyle = 'rgba(74,58,44,0.40)';
      g.fillText('scavenger hunt', s.verso ? x0 : x1, M_TOP + 52);
      inkLine(g, x0, M_TOP + 78, x1, M_TOP + 80, { seed: 5, width: 2.0, alpha: 0.30, colour: '#5c452e' });
    }

    if (s.progress) {
      g.textAlign = 'left';
      g.font = hand(36);
      g.fillStyle = INK_SOFT;
      g.fillText(s.progress, x0, M_TOP + 156);
    }

    for (let i = 0; i < s.rows.length; i++) this._paintRow(g, i, s.rows[i]);
  }


  /**
   * The open-cornered pencil frame that marks out where a print will go.
   *
   * Pulled out of `_paintRow` when the mystery leaf needed the same marks in a
   * different place. `hot` is the targeted state: the same marks pressed
   * harder, which puts "this is the one I am after" at BOTH ends of a row
   * rather than leaving the ring by the checkbox to carry it alone on a page of
   * four lines.
   */
  _slotCorners(g, slot, tilt, seed, hot) {
    g.save();
    g.translate(slot.x + slot.w / 2, slot.y + slot.h / 2);
    g.rotate(tilt);
    const hw = slot.w / 2 - 8, hh = slot.h / 2 - 6, c = 52;
    const ink = hot
      ? { width: 4.0, alpha: 0.72, wobble: 1.5, colour: INK, passes: 2 }
      : { width: 3.4, alpha: 0.40, wobble: 1.5, colour: '#6a533a', passes: 2 };
    let k = 0;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      inkLine(g, sx * hw, sy * hh - sy * c, sx * hw, sy * hh + sy * 2,
        { ...ink, seed: seed + 60 + k });
      inkLine(g, sx * hw + sx * 2, sy * hh, sx * hw - sx * c, sy * hh,
        { ...ink, seed: seed + 70 + k });
      k++;
    }
    g.restore();
  }

  _paintRow(g, i, row) {
    const x0 = this._x0, top = this._rowTop(i);
    const slot = this.slotRect(i);
    const seed = this.spec.seed * 31 + i * 7 + 1;
    const r = rng(seed);
    const tiltA = (r() - 0.5) * 0.055;      // the photo's own crookedness

    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';

    // ── the empty slot ──────────────────────────────────────────────────────
    // A pencil-ruled rectangle with the corners left open, which is how you
    // actually mark out where something is going to be pasted. A closed dashed
    // box reads as a file-upload dropzone.
    if (!row.done || row.pending) {
      // The corner marks were `setLineDash([10, 11])` over 30 px legs — a dash
      // PERIOD longer than the leg it was drawn on, so each leg came out as one
      // or two dashes, which at gameplay resolution is a 1-2 px speck. Fifteen
      // rows of specks read as dirt on the paper rather than as "a photograph
      // goes here", and a place for the photographs is the one thing the brief
      // asked for by name.
      //
      // Solid now, longer legs, and drawn with `inkLine` rather than a canvas
      // stroke so they are in the same hand as everything else on the page —
      // wobbled, double-passed, overshooting the corner. Still corners rather
      // than a closed box: a closed dashed rectangle reads as a file-upload
      // dropzone, which was right the first time.
      this._slotCorners(g, slot, tiltA, seed, row.target);
      // The offer, and then the answer. Only on lines something can actually
      // point at — `Journal._canTrack` asks the wildlife layer, so the Moon and
      // the waterfall get a plain empty frame and no promise this book cannot
      // keep.
      if (row.track) {
        pawMark(g, slot.x + slot.w / 2, slot.y + slot.h / 2, 96, row.target
          ? { colour: INK, alpha: 0.60, seed: seed + 80 }
          : { colour: GRAPHITE, alpha: 0.20, seed: seed + 80 });
      }
    }

    // ── the checkbox ────────────────────────────────────────────────────────
    const boxY = top + 34;
    checkbox(g, x0, boxY, 44, seed + 2);
    if (row.done && !row.pending) tick(g, x0 + 4, boxY + 2, 44, seed + 3);
    // Ringed: this is the one the player is out looking for. Drawn AFTER the
    // box so the sweep crosses it, which is what a pen does and what stops the
    // two marks reading as one printed widget.
    if (row.target) circleMark(g, x0 + 21, boxY + 22, 54, 45, { seed: seed + 11, width: 5.4, alpha: 0.80 });

    // ── the line ────────────────────────────────────────────────────────────
    const tx = x0 + 70;
    const tw = slot.x - 26 - tx;
    const label = `Photo of ${row.subject}`;
    let size = 52;
    g.font = hand(size);
    while (g.measureText(label).width > tw && size > 34) { size -= 1; g.font = hand(size); }
    g.fillStyle = row.done && !row.pending ? 'rgba(58,43,32,0.62)' : INK;
    const baseline = top + 78;
    g.fillText(label, tx, baseline);
    const lw = g.measureText(label).width;

    if (row.hint) {
      // FITTED to one line before it is allowed to wrap. The wrap is still
      // here as a backstop, but the squirrel's hint ("under the hardwoods; the
      // smallest animal here") overflowed by a single word and left "here"
      // hanging on its own line under the row — a widow, on the page the
      // player reads fifteen times.
      let hs = 33;
      g.font = hand(hs);
      while (g.measureText(row.hint).width > tw && hs > 25) { hs -= 1; g.font = hand(hs); }
      // A struck-off row does not need telling where to look any more. The
      // hint stays (leafing back should still read as a list, not as a
      // scoreboard) but it drops back so the completed rows go quiet.
      const spent = row.done && !row.pending;
      g.fillStyle = spent ? 'rgba(74,58,44,0.26)' : 'rgba(74,58,44,0.62)';
      const words = row.hint.split(' ');
      let line = '', y = baseline + 46, lines = 0;
      for (const w of words) {
        const t = line ? `${line} ${w}` : w;
        if (g.measureText(t).width > tw && line) {
          g.fillText(line, tx, y); line = w; y += hs + 5; lines++;
          if (lines >= 1) break;
        } else line = t;
      }
      if (line) g.fillText(line, tx, y);
    }

    // ── done: the strike, then the print ────────────────────────────────────
    if (row.done && !row.pending) {
      this._strike(g, tx, baseline, lw, seed, 1);
      // `hidePrint` leaves the strike and the tick and takes only the print,
      // because a higher-resolution copy of it is being composited over this
      // leaf right now — see `printPatch`. The empty-slot corner marks stay
      // away too (they are gated on `!row.done` above), which is right: the
      // slot is not empty, it is occupied by something drawn elsewhere.
      if (!row.hidePrint) this._paste(g, slot, row.photo, tiltA, seed, row.tapeT ?? 1);
    }

    // Where the strike lives, so the animation knows what to blit back.
    row._strikeBox = { x: tx - 26, y: baseline - 46, w: lw + 52, h: 74 };
    row._strikeArgs = { tx, baseline, lw, seed };
  }

  /** The pencil stroke through a line. `t` in 0..1 draws it progressively. */
  _strike(g, tx, baseline, lw, seed, t) {
    const y = baseline - 15;
    // Overshoot both ends by ~12 px: a strike that starts exactly at the first
    // glyph and stops exactly at the last is a CSS rule, not a pencil.
    inkLine(g, tx - 13, y + 4, tx + lw + 15, y - 3, {
      seed, width: 5.0, alpha: 0.52, wobble: 3.0, bow: 3.4, passes: 3, colour: GRAPHITE, t,
    });
    // The hook at the end, drawn only once the main stroke has arrived.
    if (t > 0.94) {
      const r = rng(seed + 77);
      g.save();
      g.strokeStyle = GRAPHITE;
      g.globalAlpha = 0.38;
      g.lineWidth = 3.4;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(tx + lw + 15, y - 3);
      g.quadraticCurveTo(tx + lw + 30, y - 12, tx + lw + 20 + (r() * 8), y - 26);
      g.stroke();
      g.restore();
    }
  }

  /**
   * The developed print, taped down.
   *
   * `tapeT` runs the two strips on: 0 is a bare photo lying on the page, 1 is
   * both pieces stuck down. They are staggered, because two pieces of tape
   * appearing on the same frame is one event and the point of the beat is that
   * somebody put them on one at a time.
   *
   * `px` is device pixels per page pixel — 1 for the page's own canvas, 2-5 for
   * `printPatch`. It reaches only the two blur radii; see `tapeStrip`.
   */
  _paste(g, slot, img, tilt, seed, tapeT = 1, px = 1) {
    const cx = slot.x + slot.w / 2, cy = slot.y + slot.h / 2;
    const cardW = slot.w - 12, cardH = slot.h - 18;
    const imgW = cardW - 20, imgH = cardH - 20 - 26;   // caption strip at the foot

    g.save();
    g.translate(cx, cy);
    g.rotate(tilt);

    // Drop shadow. Offset down-right, matching the tape and the key light.
    g.save();
    g.translate(3, 6);
    g.filter = `blur(${(6 * px).toFixed(2)}px)`;
    g.fillStyle = 'rgba(70,50,32,0.42)';
    g.fillRect(-cardW / 2, -cardH / 2, cardW, cardH);
    g.restore();

    // The print itself: slightly off-white, never pure #fff — a white rectangle
    // on a cream page is the brightest thing in the whole journal and it reads
    // as a hole punched in the paper.
    g.fillStyle = '#f6efe0';
    g.fillRect(-cardW / 2, -cardH / 2, cardW, cardH);

    g.save();
    g.translate(0, -13);
    if (img) {
      g.save();
      g.beginPath();
      g.rect(-imgW / 2, -imgH / 2, imgW, imgH);
      g.clip();
      drawCover(g, img, imgW, imgH);
      g.restore();
    } else {
      g.fillStyle = '#cfc3aa';
      g.fillRect(-imgW / 2, -imgH / 2, imgW, imgH);
    }
    // A hairline inside the print's edge — the emulsion sits a hair below the
    // paper and catches a dark line all the way round.
    g.strokeStyle = 'rgba(52,40,28,0.28)';
    g.lineWidth = 1.4;
    g.strokeRect(-imgW / 2, -imgH / 2, imgW, imgH);
    g.restore();

    g.restore();

    // Tape LAST and OUTSIDE the card transform, so the two pieces are crooked
    // relative to the photo as well as to the page. Two different angles and
    // two different lengths — see the header.
    //
    // BOTH angles are now POSITIVE, and that is a correction rather than a
    // taste change. A strip taped over a corner runs perpendicular to that
    // corner's bisector; the two corners used here are opposite ends of the
    // same diagonal, so both strips want the same sign. The second one was at
    // `tilt - 0.70`, i.e. PARALLEL to its bisector, which sent it running out
    // of the corner instead of across it — so it frequently landed beside the
    // print holding nothing. They stay visibly different (0.60 against 0.86)
    // because a person does not tape two corners at the same angle either.
    const r = rng(seed + 41);
    const hx = Math.cos(tilt) * cardW / 2, hy = Math.sin(tilt) * cardW / 2;
    const vx = -Math.sin(tilt) * cardH / 2, vy = Math.cos(tilt) * cardH / 2;
    const a = clamp01(tapeT * 1.7), b = clamp01(tapeT * 1.7 - 0.7);
    if (a > 0) {
      g.save(); g.globalAlpha = a;
      tapeStrip(g, cx - hx * 0.86 + vx * 0.94, cy - hy * 0.86 + vy * 0.94,
        (104 + r() * 16) * (0.7 + 0.3 * a), 34, tilt + 0.60 + (r() - 0.5) * 0.20, seed + 5, px);
      g.restore();
    }
    if (b > 0) {
      g.save(); g.globalAlpha = b;
      tapeStrip(g, cx + hx * 0.9 - vx * 0.96, cy + hy * 0.9 - vy * 0.96,
        (96 + r() * 20) * (0.7 + 0.3 * b), 32, tilt + 0.86 + (r() - 0.5) * 0.20, seed + 6, px);
      g.restore();
    }
  }

  /**
   * The same print, drawn once more at whatever resolution the SOURCE can pay
   * for, on its own transparent canvas.
   *
   * ── why this exists ────────────────────────────────────────────────────────
   * The second zoom level (`Journal.studyClose`) puts one photograph across 80%
   * of the screen, and at that magnification the page texture is the binding
   * constraint — not the stored JPEG, which is the thing everybody assumes.
   * The arithmetic, measured rather than estimated, at 1600x900:
   *
   *   · `_paste` draws the stored photo into `imgW x imgH` = **220 x 126 page
   *     pixels**, and that downscale happens once, at paint time, and is baked;
   *   · the close look then blows those 220 texels up to **878 CSS px**, i.e.
   *     **3.99x**, and 7.99x on a dpr-2 display;
   *   · the store is keeping 1024 px of that same photograph the whole time.
   *
   * So raising `hunt_store.THUMB_MAX` alone buys exactly nothing while this
   * path exists. This canvas is the bypass. It carries the print at `px` device
   * pixels per page pixel, chosen from the decoded photo's own width, so a
   * bigger stored photo makes the close look sharper with no edit here and no
   * edit in `Journal`.
   *
   * ── what it draws, and what it deliberately does not ───────────────────────
   * EVERYTHING the baked version draws in this rectangle: the drop shadow, the
   * card stock, the emulsion, the hairline and both pieces of tape — and it
   * draws them from the same seed, so it is the same crookedness, the same torn
   * edges and the same sheen. It does NOT draw the paper, the ruled row or the
   * struck line: those stay in the page texture, at the page's own resolution,
   * where they belong. A patch that redrew the paper would have to match the
   * tooth exactly or show a rectangle on the leaf.
   *
   * That in turn is why `spec.rows[i].hidePrint` exists. The patch composites
   * OVER the leaf, and everything in it is translucent somewhere — the shadow,
   * the tape, the tape's own shadow — so leaving the baked copy underneath
   * would darken every one of those twice. The page hides the print for as long
   * as the patch is up; `paint()` is ~2.5 ms and it happens on a click.
   *
   * @param i        row index
   * @param maxPx    ceiling on device px per page px (memory, see `Journal`)
   * @returns {{canvas, uv:{u,v,w,h}, px:number, src:number, dst:number}|null}
   *          `uv` is the covered rectangle in page UV, same convention and same
   *          verso flip as `slotUV`, so the caller places it exactly the way it
   *          places a slot. `src`/`dst` are the emulsion's source width and its
   *          width on this canvas, which is the honest measure of what was
   *          gained and is what the harness prints.
   */
  printPatch(i, maxPx = 4.7) {
    const row = this.spec.rows?.[i];
    if (!row || !row.done || !row.photo) return null;
    const seed = this.spec.seed * 31 + i * 7 + 1;
    return this._patch(this.slotRect(i), row.photo,
      (rng(seed)() - 0.5) * 0.055, seed, row.tapeT ?? 1, maxPx);
  }

  /**
   * The same trick for one of the two prints on the compare leaf.
   *
   * `tapeT` is the caller's, and it carries the whole difference between the
   * two: the print that is already in the book is TAPED DOWN and the one just
   * taken is a loose print lying on the paper. That reads before any caption
   * does, and it is the truth rather than a decoration — one of them is stuck
   * in a book and the other is not yet.
   */
  comparePatch(k, img, tapeT, maxPx = 4.7) {
    if (!img) return null;
    const seed = this.spec.seed * 31 + 900 + k * 7;
    return this._patch(this.compareSlot(k), img,
      (rng(seed)() - 0.5) * 0.055, seed, tapeT, maxPx);
  }

  /**
   * One print, redrawn on its own canvas at whatever resolution its source can
   * pay for. Shared by `printPatch` and `comparePatch` — the two differ only in
   * which rectangle they hand in.
   */
  _patch(slot, img, tilt, seed, tapeT, maxPx) {
    // The tape overhangs the slot, and so does the shadow. This is the same
    // bleed box `tapeAt` blits, for the same reason: it is where the ink is.
    const rect = {
      x: Math.max(0, slot.x - 70), y: Math.max(0, slot.y - 40),
      w: slot.w + 140, h: slot.h + 80,
    };
    // The emulsion is `cardW - 20` = 220 page pixels wide on a row slot. Past
    // the point where one source pixel lands on one canvas pixel there is
    // nothing left to recover — upsampling in a 2D canvas and upsampling on the
    // GPU are the same bilinear filter — so the scale is the SOURCE's, capped.
    // 4.7 is what a 1024 px photo asks for (1024 / 220), which is where the cap
    // is set; it is a ceiling and not a target, and a 512 px store would come
    // out at 2.33 and a 1825 x 1257 canvas would be a 913 x 629 one. A compare
    // slot's emulsion is 358 px, so the same photo asks for 2.86 there and the
    // cap is never the binding constraint on that leaf.
    const imgW = slot.w - 12 - 20;
    const px = Math.max(1, Math.min(maxPx, (img.width ?? imgW) / imgW));

    const cv = document.createElement('canvas');
    cv.width = Math.round(rect.w * px);
    cv.height = Math.round(rect.h * px);
    const g = cv.getContext('2d');
    // Page coordinates in, device pixels out. Everything below is written in
    // the page's own numbers, exactly as `_paintRow` writes them.
    g.setTransform(px, 0, 0, px, -rect.x * px, -rect.y * px);
    this._paste(g, slot, img, tilt, seed, tapeT, px);
    g.setTransform(1, 0, 0, 1, 0, 0);

    return {
      canvas: cv,
      uv: this._toUV(rect),
      px: +px.toFixed(3),
      src: img.width ?? 0,
      dst: Math.round(imgW * px),
    };
  }

  /**
   * Hide (or restore) one row's print, and repaint.
   *
   * The only caller is the close look, which replaces this print with a
   * higher-resolution copy of it — see `printPatch`. Returns true if anything
   * changed, so the caller can skip the repaint when it did not.
   */
  hidePrint(i, on) {
    const row = this.spec.rows?.[i];
    if (!row || !!row.hidePrint === !!on) return false;
    row.hidePrint = !!on;
    this.paint();
    return true;
  }

  /**
   * Animate the tape onto row `i`'s photo, at progress `t`.
   *
   * Same partial-blit trick as `strikeAt`, over the slot's rectangle plus the
   * margin the strips overhang into. The clean cache has to have been taken
   * AFTER the photo was baked in and BEFORE any tape was drawn, which is what
   * `paint()` invalidating it and this re-taking it arranges for free.
   */
  tapeAt(i, t) {
    const row = this.spec.rows?.[i];
    if (!row || !row.done) return;
    if (!this._clean) {
      this._clean = document.createElement('canvas');
      this._clean.width = PAGE_W; this._clean.height = PAGE_H;
      this._clean.getContext('2d').drawImage(this.canvas, 0, 0);
    }
    const s = this.slotRect(i);
    const b = { x: s.x - 70, y: s.y - 40, w: s.w + 140, h: s.h + 80 };
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(b.x, b.y, b.w, b.h);
    g.drawImage(this._clean, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
    const seed = this.spec.seed * 31 + i * 7 + 1;
    const tilt = (rng(seed)() - 0.5) * 0.055;
    // Only the tape, over the photo that is already in the clean copy.
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    const cardW = s.w - 12, cardH = s.h - 18;
    const r = rng(seed + 41);
    const hx = Math.cos(tilt) * cardW / 2, hy = Math.sin(tilt) * cardW / 2;
    const vx = -Math.sin(tilt) * cardH / 2, vy = Math.cos(tilt) * cardH / 2;
    const a = clamp01(t * 1.7), bb = clamp01(t * 1.7 - 0.7);
    if (a > 0) {
      g.save(); g.globalAlpha = a;
      tapeStrip(g, cx - hx * 0.86 + vx * 0.94, cy - hy * 0.86 + vy * 0.94,
        (104 + r() * 16) * (0.7 + 0.3 * a), 34, tilt + 0.60 + (r() - 0.5) * 0.20, seed + 5);
      g.restore();
    }
    if (bb > 0) {
      g.save(); g.globalAlpha = bb;
      tapeStrip(g, cx + hx * 0.9 - vx * 0.96, cy + hy * 0.9 - vy * 0.96,
        (96 + r() * 20) * (0.7 + 0.3 * bb), 32, tilt + 0.86 + (r() - 0.5) * 0.20, seed + 6);
      g.restore();
    }
    this.texture.needsUpdate = true;
  }

  /**
   * Rewrite the progress line under the heading, in place.
   *
   * B6 was: `Journal._armAward` calls `hunt.award()` and updates every page's
   * `spec.progress` string, but only repaints the page the AWARD is on. The
   * count lives on page 1 and nowhere else, so an award anywhere else left the
   * canvas saying what it said before — measured at t = 3.90 s, with the item
   * struck off, ticked, photographed and taped, the line still read "none of
   * fifteen found". A wrong number on screen at the exact beat the feature
   * exists for.
   *
   * A full `paint()` would also fix it, but on a page that may be mid-turn.
   * This blits the band back out of `paperBase` instead, re-lays the fold
   * shadow over it and writes the new text — the same partial-blit discipline
   * as `strikeAt`/`tickAt`/`tapeAt`, and measured at 2.28 ms against 4.77 ms
   * for the full repaint (both with the raster forced; the forcing probe is
   * ~2.3 ms of that, so the blit is very nearly free).
   *
   * Note it does NOT blit from `_clean`: the clean copy is the page as it was
   * BEFORE the ceremony, which still has the old number in it.
   */
  progressAt(text) {
    const s = this.spec;
    if (s.progress == null || text == null) return;
    s.progress = text;
    const g = this.g;
    const x0 = this._x0, x1 = this._x1;
    const b = { x: x0 - 10, y: M_TOP + 116, w: x1 - x0 + 20, h: 64 };
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.save();
    g.beginPath();
    g.rect(b.x, b.y, b.w, b.h);
    g.clip();
    g.clearRect(b.x, b.y, b.w, b.h);
    g.drawImage(paperBase(s.seed % 3), 0, 0);
    this._gutterShade(g);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.font = hand(36);
    g.fillStyle = INK_SOFT;
    g.fillText(text, x0, M_TOP + 156);
    g.restore();
    // Keep the pencil animation's cache honest: `strikeAt` blits this band's
    // neighbours back out of `_clean`, and a stale number in there would come
    // back the next time anything near it redrew.
    if (this._clean) {
      const cg = this._clean.getContext('2d');
      cg.clearRect(b.x, b.y, b.w, b.h);
      cg.drawImage(this.canvas, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
    }
    this.texture.needsUpdate = true;
  }

  // ── the notes leaf ────────────────────────────────────────────────────────

  /**
   * The leaf that asks which print to keep.
   *
   * `spec.compare` is `{ subject, hover }` — `hover` is 0, 1 or -1 and is the
   * ONLY thing on this page that moves, which is what makes a repaint on a
   * hover change affordable (~2.5 ms, and only when the pointer crosses a
   * boundary rather than every frame it is inside one).
   *
   * ── what is painted here and what is not ──────────────────────────────────
   * The two photographs are NOT. They are `comparePatch` canvases composited
   * over this leaf as quads, the same way the close look's print is, because
   * they are the thing the player is being asked to look at and the page
   * texture holds 358 px of a 1024 px photo. What IS painted is everything that
   * has to sit UNDER them: the question, the two captions, the empty slot the
   * loose print is lying in, and the line at the foot that says what Escape
   * does. That last one is the whole of this page's escape hatch — the journal
   * has no chrome and this is the only screen in it that can strand a player.
   *
   * The hover mark is a pencil bracket UNDER the caption of the print the
   * pointer is on, not a box around the print: a box would be a second
   * rectangle a few pixels outside a photograph that already has a white
   * border and a drop shadow, which reads as a rendering fault. A pencil
   * stroke under a word reads as somebody having made up their mind.
   */
  _paintCompare(g) {
    const c = this.spec.compare;
    const x0 = this._x0, x1 = this._x1;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';

    g.fillStyle = INK;
    g.font = brush(62);
    g.fillText('Two of these', x0, M_TOP + 62);

    // One line, and it names the subject rather than saying "this photo": the
    // player pressed the shutter at something, and being told WHAT the book
    // already has is half the answer to whether they want to swap it.
    g.font = hand(42);
    g.fillStyle = INK_SOFT;
    g.fillText(`Keep the better photo of ${c.subject ?? 'it'}.`, x0, M_TOP + 140);

    // The two empty slots, in the same hand as an un-photographed row: open
    // corners rather than a closed box. Under the taped print it is invisible;
    // under the loose one it says the print is lying somewhere, not stuck.
    for (let k = 0; k < 2; k++) {
      const s = this.compareSlot(k);
      const seed = this.spec.seed * 31 + 900 + k * 7;
      const tilt = (rng(seed)() - 0.5) * 0.055;
      g.save();
      g.translate(s.x + s.w / 2, s.y + s.h / 2);
      g.rotate(tilt);
      // Inset far enough to stay UNDER the card. `_paste` draws a card
      // `slot.w - 12` by `slot.h - 18`, so marks at the row slot's own 8/6
      // inset stick out past the bottom corners of a print that is covering
      // them and read as dirt on the paper. 16/18 is inside the card on both
      // axes with room for the print's own crookedness.
      const hw = s.w / 2 - 16, hh = s.h / 2 - 18, leg = 62;
      const ink = { width: 3.4, alpha: 0.34, wobble: 1.5, colour: '#6a533a', passes: 2 };
      let n = 0;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        inkLine(g, sx * hw, sy * hh - sy * leg, sx * hw, sy * hh + sy * 2,
          { ...ink, seed: seed + 60 + n });
        inkLine(g, sx * hw + sx * 2, sy * hh, sx * hw - sx * leg, sy * hh,
          { ...ink, seed: seed + 70 + n });
        n++;
      }
      g.restore();
    }

    // The captions. Centred under each slot, and the hovered one goes to full
    // ink with a stroke under it — so the page itself answers "which one am I
    // about to keep" without the player having to trust a 3D lift.
    const caps = ['in the book', 'just taken'];
    g.textAlign = 'center';
    for (let k = 0; k < 2; k++) {
      const s = this.compareSlot(k);
      const cx = s.x + s.w / 2, y = CMP_CAPS;
      const on = c.hover === k;
      g.font = hand(on ? 46 : 42);
      g.fillStyle = on ? INK : 'rgba(74,58,44,0.42)';
      g.fillText(caps[k], cx, y);
      if (on) {
        const w = g.measureText(caps[k]).width;
        inkLine(g, cx - w / 2 - 10, y + 18, cx + w / 2 + 10, y + 20,
          { seed: 95 + k, width: 3.4, alpha: 0.5, wobble: 1.6, colour: GRAPHITE, passes: 2 });
      }
    }

    // The way out, in the hand, at the foot of the page. It says what Escape
    // KEEPS rather than that it cancels: a player who has just taken a photo
    // they are not sure about needs to know that walking away is safe, and
    // "cancel" does not tell them which of the two survives it.
    g.textAlign = 'center';
    g.font = hand(36);
    g.fillStyle = 'rgba(74,58,44,0.40)';
    g.fillText('Esc — keep the one in the book', (x0 + x1) / 2, CMP_ESC);
  }

  _paintNotes(g) {
    const x0 = this._x0, x1 = this._x1;
    g.textAlign = 'left';
    g.fillStyle = INK;
    g.font = brush(64);
    g.fillText('Notes', x0, M_TOP + 66);
    inkLine(g, x0, M_TOP + 96, x1, M_TOP + 98, { seed: 6, width: 2.6, alpha: 0.45, colour: '#5c452e' });
    for (let i = 0; i < 18; i++) {
      const y = M_TOP + 190 + i * 62;
      if (y > PAGE_H - M_BOT) break;
      inkLine(g, x0, y, x1, y + 1, { seed: 40 + i, width: 1.6, alpha: 0.18, wobble: 1.2, colour: '#6b5238' });
    }
    // The book is finished. Over the ruled lines and not between them — a stamp
    // lands where the hand puts it, and a notes page is exactly the blank a
    // person reaches for. See `winStamp`.
    if (this.spec.stamp) {
      winStamp(g, (x0 + x1) / 2, PAGE_H * 0.56, 268, this.spec.seed * 17 + 5,
        this.spec.stampT ?? 1);
    }
  }


  // ── the mystery leaf ──────────────────────────────────────────────────────

  /**
   * The nineteenth entry, on a page that was blank until the other eighteen
   * were crossed off.
   *
   * Everything about this leaf is set against the checklist pages, because the
   * point of it is that it does not belong to them:
   *
   *   · **it is written in pencil, not pen.** The list is ruled out in ink at a
   *     table; this was put down in the field, in a hurry, on the first blank
   *     page to hand. `GRAPHITE` and a lower alpha, all the way through.
   *   · **it is not ruled and not aligned.** No row grid, no folio band, a
   *     heading that sits low and off the margin. A player who has read the
   *     same four-row grid eighteen times will feel the difference before they
   *     read a word of it.
   *   · **it has one line and one slot**, at the foot, in the checklist's own
   *     form — the checkbox, the struck line, the taped print. That much has to
   *     match, because it is the same promise: photograph it and the book
   *     closes.
   *
   * The text is the keeper's, and it is short on purpose. The only two facts a
   * player needs are in it — deep timber, and the long lens — and everything
   * else is somebody deciding whether to write this down at all.
   */
  _paintMystery(g) {
    const s = this.spec;
    const x0 = this._x0, x1 = this._x1;
    const tw = x1 - x0;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';

    // The heading, low and crooked. Not `brush` — this is the same pencil the
    // rest of the page is in, only bigger.
    g.save();
    g.translate(x0 + 6, M_TOP + 92);
    g.rotate(-0.017);
    g.font = hand(62, 600);
    g.fillStyle = 'rgba(58,43,32,0.86)';
    g.fillText('One more thing', 0, 0);
    g.restore();
    inkLine(g, x0 + 2, M_TOP + 118, x0 + 372, M_TOP + 124,
      { seed: 91, width: 2.4, alpha: 0.34, wobble: 2.6, colour: GRAPHITE });

    const BODY = [
      'Everything on the list, found. So I will',
      'write the other thing down now.',
      '',
      'Twice, on the logging road above the',
      'creek. Standing back in the timber,',
      'watching the truck go by. Too tall, and',
      'far too wide, and on two legs.',
      '',
      'Gone both times before I had the camera',
      'up, and I am not telling anyone without',
      'a photograph.',
      '',
      'It keeps to the deep woods. Go and find',
      'it. Put the long lens on FIRST — there',
      'is no time to change it.',
    ];
    g.font = hand(37);
    g.fillStyle = 'rgba(74,58,44,0.72)';
    let y = M_TOP + 196;
    for (const line of BODY) {
      if (line) g.fillText(line, x0 + 4, y);
      y += line ? 50 : 26;
    }

    // ── the line ─────────────────────────────────────────────────────────────
    // Same furniture as a checklist row, at the foot of the page: box, subject,
    // strike, print. `Journal._bakePhoto` and the strike/tick animations all
    // address rows by index, so this one IS row 0 of a one-row page — which is
    // why `slotRect(0)` and `_rowTop(0)` are not used here and the geometry is
    // written out instead. A leaf with one entry laid out on the four-row grid
    // would put the print at the top and leave two thirds of the page empty.
    const row = s.rows?.[0];
    if (!row) return;
    const baseline = MYST_BASE;
    const boxY = baseline - 46;
    const slot = this.slotRect(0);
    const seed = s.seed * 31 + 5;

    checkbox(g, x0 + 4, boxY, 44, seed + 2);
    if (row.done && !row.pending) tick(g, x0 + 8, boxY + 2, 44, seed + 3);
    // Ringed: this is the one the player is out looking for. After the box, so
    // the sweep crosses it — a pen would, and it stops the two marks reading as
    // one printed widget. Same as any other row.
    if (row.target) circleMark(g, x0 + 25, boxY + 22, 54, 45, { seed: seed + 11, width: 5.4, alpha: 0.80 });
    const tx = x0 + 76;
    g.font = hand(41);
    g.fillStyle = INK;
    const label = `Photo of ${row.subject}`;
    g.fillText(label, tx, baseline);
    const lw = g.measureText(label).width;

    if (row.done && !row.pending) {
      this._strike(g, tx, baseline, lw, seed, 1);
      if (!row.hidePrint) this._paste(g, slot, row.photo, -0.021, seed, row.tapeT ?? 1);
    } else {
      // The same open-cornered pencil frame the checklist rows use, and drawn
      // by the same code path for the same reason its comment gives: a closed
      // dashed box reads as a file-upload dropzone.
      this._slotCorners(g, slot, -0.021, seed, row.target);
      // …and the paw, which is the offer to go looking. This page argued
      // itself out of one at first — "nothing in the game could point at him,
      // and a promise this book cannot keep is worse here than anywhere" — and
      // that was true of the code and wrong about the game. A player has spent
      // eighteen lines learning that an empty frame with a paw in it is a thing
      // you click, and the one entry that is actually hard to find is the last
      // place to withhold it. `Wildlife.canTrack` now answers for him and
      // `Bigfoot.nearest` is what the compass reads; see `row.track`.
      if (row.track) {
        pawMark(g, slot.x + slot.w / 2, slot.y + slot.h / 2, 96, row.target
          ? { colour: INK, alpha: 0.60, seed: seed + 80 }
          : { colour: GRAPHITE, alpha: 0.20, seed: seed + 80 });
      }
    }
    row._strikeBox = { x: tx - 26, y: baseline - 46, w: lw + 52, h: 74 };
    row._strikeArgs = { tx, baseline, lw, seed };
    this._mysterySlot = slot;
  }

  /** The mystery leaf's own print slot, for `slotUV`. Null on every other leaf. */
  mysterySlotUV() {
    return this._mysterySlot ? this._toUV(this._mysterySlot) : null;
  }

  // ── the animated strike ───────────────────────────────────────────────────

  /**
   * Draw row `i`'s pencil strike at progress `t`, cheaply.
   *
   * Only the row's own rectangle is touched: the clean page is cached once and
   * that rectangle is blitted back before each new partial stroke. The header's
   * note applies: the "~40 ms per repaint" this was built against was Chromium
   * deferring 2D raster, not the paint. Touching a rectangle rather than 1.5 M
   * pixels is still the right thing to do sixty times a second.
   */
  strikeAt(i, t) {
    const row = this.spec.rows?.[i];
    if (!row || !row._strikeBox) return;
    if (!this._clean) {
      this._clean = document.createElement('canvas');
      this._clean.width = PAGE_W; this._clean.height = PAGE_H;
      this._clean.getContext('2d').drawImage(this.canvas, 0, 0);
    }
    const b = row._strikeBox;
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(b.x, b.y, b.w, b.h);
    g.drawImage(this._clean, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
    const a = row._strikeArgs;
    this._strike(g, a.tx, a.baseline, a.lw, a.seed, clamp01(t));
    this.texture.needsUpdate = true;
  }

  /**
   * Animate the tick going into the checkbox. Same blit trick, tiny region.
   *
   * The box's y is re-derived from the row's own strike baseline rather than
   * from `_rowTop(i)`, because the mystery leaf lays its single entry out at
   * the FOOT of the page and not on the four-row grid. `_strikeArgs` is written
   * by whichever painter drew the row, so it is the one description of where a
   * row ended up that both leaves agree on.
   */
  tickAt(i, t) {
    const row = this.spec.rows?.[i];
    if (!row) return;
    if (!this._clean) return;                 // strikeAt allocates it; order matters
    const x0 = this._x0;
    const boxY = (row._strikeArgs?.baseline ?? (this._rowTop(i) + 80)) - 46;
    const b = { x: x0 - 12, y: boxY - 26, w: 90, h: 96 };
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(b.x, b.y, b.w, b.h);
    g.drawImage(this._clean, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
    tick(g, x0 + 4, boxY + 2, 44, this.spec.seed * 31 + i * 7 + 4, clamp01(t));
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
    this.canvas.width = this.canvas.height = 1;
    this._clean = null;
  }
}
