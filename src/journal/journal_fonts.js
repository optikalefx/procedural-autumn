// ─────────────────────────────────────────────────────────────────────────────
//  journal_fonts — the two faces the journal page is lettered in, self-hosted.
//
//  These are the first font files this repo has ever shipped, so the reasoning
//  is written down rather than assumed.
//
//  ── why self-hosted ─────────────────────────────────────────────────────────
//  The game deploys to Cloudflare Pages and must not need fonts.googleapis.com
//  at runtime: a third-party stylesheet is a second DNS lookup, a second TLS
//  handshake and a third party who can take the page's typography down. Two
//  woff2 files in public/fonts/ are 126 KB total, cached forever, and the game
//  already ships 16 MB of world bake — this is noise against that.
//
//  ── which faces, and why not the ones that were recommended ────────────────
//  Body: CAVEAT (Impallari Type, SIL OFL 1.1). A pen hand with real stroke
//  modulation that stays legible at the ~30 device-pixel cap height a checklist
//  line gets on the page texture. Its variable axis is 400..700 in one file, so
//  emphasis costs nothing extra.
//
//  Heading: CAVEAT BRUSH (same designer, SIL OFL 1.1). The brief recommended
//  SPECIAL ELITE, a distressed typewriter, and it does look good — a specimen
//  of all four candidates over the real page layout is in the report. Two
//  things argued it down:
//
//   · Special Elite is APACHE-2.0, not SIL OFL. Apache would be redistributable
//     too, but the brief asked for OFL and there was no reason to spend the
//     exception.
//   · Read at real size, a typewriter heading over a handwritten list says
//     "printed form somebody filled in". A personal field journal is one
//     person's hand throughout, and Caveat Brush is literally the same skeleton
//     with a fatter pen. The page reads as one object rather than two.
//
//  Amatic SC was the other OFL candidate and goes wiry at heading weight on a
//  cream ground. Cutive Mono is too light to hold a title at all.
//
//  ── the trap this module exists to prevent ─────────────────────────────────
//  A CanvasTexture drawn before the webfont has loaded renders in the FALLBACK
//  face, silently, and never redraws — canvas has no equivalent of a reflow.
//  You get a page of system sans that looks *nearly* right in a screenshot and
//  is wrong in the shipped game on a cold cache. So: nothing paints a page
//  before `journalFontsReady()` resolves, and every page can repaint.
//
//  FontFace is used rather than an injected @font-face rule so this needs no
//  edit to index.html or hud.css — the integrator wires nothing for type.
// ─────────────────────────────────────────────────────────────────────────────

// Prefixed family names. An unprefixed 'Caveat' would silently resolve to a
// LOCALLY INSTALLED copy on a designer's machine — a different version,
// different metrics, and a page that only looks right on that one laptop.
export const FONT_HAND = 'PA Caveat';
export const FONT_TITLE = 'PA Caveat Brush';

const FACES = [
  { family: FONT_HAND, url: '/fonts/caveat.woff2', desc: { weight: '400 700' } },
  { family: FONT_TITLE, url: '/fonts/caveat-brush.woff2', desc: { weight: '400' } },
];

let _ready = null;

/**
 * Load both faces and resolve when the canvas can actually draw with them.
 *
 * Resolves (never rejects) even if a file 404s: a journal in the fallback face
 * is worse than the real thing and better than no journal, and a hard failure
 * here would take down a UI overlay over a font. The boolean says which
 * happened so a caller can log it once.
 *
 * @returns {Promise<boolean>} true when both faces are really loaded
 */
export function journalFontsReady() {
  if (_ready) return _ready;
  _ready = (async () => {
    if (typeof FontFace !== 'function' || !document.fonts) return false;
    let ok = true;
    await Promise.all(FACES.map(async (f) => {
      try {
        // `display: 'block'` is deliberate: this face is only ever used to
        // paint a texture, and a swap period would let a paint land in the
        // fallback and freeze there. Blocking costs nothing because the paint
        // is already gated on this promise.
        const face = new FontFace(f.family, `url(${f.url}) format('woff2')`,
          { ...f.desc, display: 'block' });
        await face.load();
        document.fonts.add(face);
      } catch (e) {
        console.warn(`[journal] font ${f.family} failed to load — the page will ` +
                     `paint in the fallback face`, e);
        ok = false;
      }
    }));
    // Belt and braces. `FontFace.load()` resolving means the bytes parsed;
    // `document.fonts.load()` is what makes the family available to a 2D
    // context, and on Safari the two are not the same moment.
    try {
      await Promise.all([
        document.fonts.load(`400 48px "${FONT_HAND}"`),
        document.fonts.load(`700 48px "${FONT_HAND}"`),
        document.fonts.load(`400 48px "${FONT_TITLE}"`),
      ]);
    } catch { /* nothing actionable; the fallback still draws */ }
    return ok;
  })();
  return _ready;
}

/** `font` shorthand for the pen hand. Size in canvas pixels. */
export const hand = (px, weight = 400) => `${weight} ${px}px "${FONT_HAND}", "Bradley Hand", cursive`;

/** `font` shorthand for the brush heading. */
export const brush = (px) => `${px}px "${FONT_TITLE}", "Marker Felt", cursive`;
