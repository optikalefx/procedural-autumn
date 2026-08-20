// ─────────────────────────────────────────────────────────────────────────────
//  Minimap — a topographic sketch of the whole valley, baked once at boot.
//
//  The player asked for "a mini topographical map … not much detail, just the
//  terrain map so I can see what terrain to drive to". That is a request for a
//  *direction*, not for tactics, and it decides every question this file had to
//  answer:
//
//   · **Whole world, always.** 3072 m fits in 165 px at 19 m per pixel. A
//     scrolling window would answer "what is near me", which is what the
//     windscreen is for; a fixed frame answers "where is the lake" and lets the
//     player learn the shape of the valley over a session.
//   · **North up, never rotating.** A map that spins under a moving arrow is
//     unreadable at this size and gives you nothing to remember. The arrow
//     rotates instead — one moving thing, not two.
//   · **Contours, hillshade and a hypsometric tint, and nothing else.** No
//     icons, no labels, no legend. Contour spacing *is* the information: wide
//     bands are drivable ground, tight bands are a wall.
//
//  "Not much detail" is a specification, not a disclaimer, and it is why the
//  height field is blurred before anything is drawn from it. The raw field
//  carries every erosion rill the generator cut, and at 19 m per pixel those
//  turn contours into hatching and the hillshade into sandpaper — a picture of
//  noise where the player asked for the shape of a valley.
//
//  Cost. The map is a static picture of a static world, so it is rasterised
//  once into an offscreen canvas during the loading screen and blitted into the
//  visible canvas only when the element resizes. The per-frame cost of this
//  whole file is one `transform` string on the marker, which never touches
//  layout. Nothing here samples the heightfield while the game is running.
//
//  `sampleWorld` and `paintMap` are pure and DOM-free on purpose: that is what
//  lets `tools/_scratch/mapbake.mjs` render this exact raster from a `.pab`
//  bake in Node, so the palette and the thresholds can be tuned without a
//  browser and without taking a capture slot off five other authors.
// ─────────────────────────────────────────────────────────────────────────────
import { el } from './hud_dom.js';

// The raster is baked at the size it will actually be *displayed*, in device
// pixels, rather than at a fixed high resolution that gets scaled down. A one
// pixel contour line does not survive a 3x downscale: the first version baked
// 512 px and drew it into 165, and every contour dissolved into a faint tonal
// smudge — a shaded relief map where the player had asked for a topographic
// one. Bounded, because the bake is O(N²) and this runs during the load screen.
const BAKE_MIN = 192;
const BAKE_MAX = 512;
const SMOOTH_PASSES = 2;       // 3×3 box blurs applied to the height field
const CONTOUR_STEPS = [5, 10, 20, 25, 50, 100, 200, 500];
const TARGET_CONTOURS = 9;

// Hypsometric ramp, in the HUD's own palette so the map reads as part of the
// instrument cluster rather than as an atlas page: plum valley floors climbing
// through ember and amber to cream summits. Deliberately *not* the green-to-
// brown of a survey map — that palette has no relationship to this game.
const RAMP = [
  [0.00, 74, 52, 84],
  [0.24, 112, 66, 80],
  [0.46, 160, 94, 64],
  [0.66, 210, 141, 70],
  [0.85, 238, 189, 110],
  [1.00, 252, 235, 205],
];
// ── water ────────────────────────────────────────────────────────────────────
//  Water on this map has exactly one sentence to say — "there is a lake there,
//  do not drive into it" — and the first version let it say a great deal more.
//  It was the only thing on the map exempted from the palette knock-back, so it
//  was also the most saturated and highest-contrast thing in the whole
//  instrument cluster; and because 21% of this world stands under water, mostly
//  as a basin where the flood threads between hummocks, it carried nearly all
//  the high-frequency detail in the frame. At 15 m per pixel that does not read
//  as lakes and rivers. It reads as marbling. The player asked for "not much
//  detail" and got a map whose most detailed element was the one thing they can
//  already see through the windscreen.
//
//  So water is now treated the same way the height field is: knocked back into
//  the panel's palette, and *generalised* rather than reproduced.
// ─────────────────────────────────────────────────────────────────────────────

// Cool enough to separate from every stop of the land ramp, and otherwise the
// quietest thing on the map. It takes the same knock-back toward the panel plum
// that the land does — measured over the shipped bake, that puts water at a
// median chroma of 33 against the land's 44 (it was 81, the highest on the map)
// and at a median luminance of 74 against the land's 77 (it was 89, the
// brightest on the map). Water is now dimmer and duller than the terrain it
// sits in, which is the whole point: it is no longer competing.
//
// What still makes it read as water at a glance is *flatness*, not saturation.
// A body carries no hillshade and no contour, so a smooth untextured pool in a
// map that is otherwise all banding and grain is unmistakable, at a fraction of
// the visual cost of a cyan one.
const WATER_SHALLOW = [92, 108, 130];
const WATER_DEEP = [60, 74, 98];
// Depth at which a body is drawn at the far end of that ramp. Set well past the
// world's 4 m median so the ordinary flooded basin lands mid-ramp and only a
// genuinely deep lake goes dark — the cue is meant to be a whisper.
const DEEP_AT = 8;

// The river mask is a wide, soft falloff — the terrain shader uses its skirts
// to damp grass near water, so it feathers out across most of the valley floor.
// Painting anything above zero as "river" floods the map in blue. Only the core
// of the channel is water you would have to drive around.
const RIVER_LO = 0.42;
const RIVER_HI = 0.72;
// Lakes come from the wet *fraction* of each block, softened first. Blurring
// before thresholding is what turns a texel-by-texel dither into one soft mass;
// four passes rather than two, because two still resolved the threading between
// the hummocks and drew every strand of it.
const WET_BLUR = 4;
const WET_LO = 0.30;
const WET_HI = 0.72;

// Generalisation. Everything above produces a *field*; these three numbers turn
// it into a small number of water bodies and throw the rest away.
//
//  · OPEN removes anything narrower than three map pixels — an erode followed
//    by a dilate, the standard cartographic open. A two-pixel wisp of marsh
//    tells a driver nothing at this size and costs the map its calm.
//  · MIN_WATER_M2 then drops whole bodies too small to be worth steering
//    around. One hectare is roughly forty map pixels at 15 m per pixel — a
//    blob about six pixels across. Below that it is a puddle, and a puddle
//    drawn here is a smudge, not information. Stated in m² rather than pixels
//    so the same bodies survive at every bake resolution: measured over 192,
//    200, 336 and 512, this keeps 23–26 bodies covering 15.2–16.2% of the map.
//  · EDGE_SOFT blurs the surviving binary back into an alpha so the shorelines
//    are not a stencil.
//
// This is also what suppresses the ruled diagonal lines in the south-east.
// Those are in `world.riverMask` itself, not in anything this file draws — the
// previous author proved it (185 polylines, longest segment 2.8 m, so no
// long-segment cull could ever have fired, and the mask-only offline raster
// shows them just as clearly) and correctly declined to paper over another
// system's artifact with a special case. This is not that special case: it is
// the same width-and-area generalisation applied to every water body on the
// map, and one-texel ruled channels simply fail it the way any other one-texel
// feature does. A map is a generalisation; suppressing a source artifact as a
// *consequence* of generalising honestly is cartography. The artifact is still
// real and still wrong, and it is filed against the terrain system in
// docs/INTEGRATION_REQUESTS.md.
const OPEN = 1;                 // structuring element radius, in map pixels
const MIN_WATER_M2 = 10000;
const EDGE_SOFT = 1;

// Everything on the land ramp is knocked back toward the panel's own plum
// before it is drawn. Full strength, the map was the loudest thing in the
// frame — two quiet instruments and one saturated postage stamp — which is not
// what "part of the same cluster" means. Water is knocked back with it: it was
// exempted in the first version on the theory that the gap between water and
// land was the one contrast that had to survive a glance, and that was true of
// the contrast and false of the chroma. Widening a gap that was already the
// widest on the map is how the subject of the map ended up losing to its
// background.
const SIT_BACK = 0.15;
const SCRIM = [43, 28, 51];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function rampAt(t) {
  t = clamp01(t);
  for (let i = 1; i < RAMP.length; i++) {
    if (t > RAMP[i][0] && i < RAMP.length - 1) continue;
    const a = RAMP[i - 1], b = RAMP[i];
    const k = (t - a[0]) / (b[0] - a[0]);
    return [
      lerpBack(a[1] + (b[1] - a[1]) * k, SCRIM[0]),
      lerpBack(a[2] + (b[2] - a[2]) * k, SCRIM[1]),
      lerpBack(a[3] + (b[3] - a[3]) * k, SCRIM[2]),
    ];
  }
  return RAMP[RAMP.length - 1].slice(1).map((c, i) => lerpBack(c, SCRIM[i]));
}

const lerpBack = (c, to) => c + (to - c) * SIT_BACK;

/** 1st–99.5th percentile of the height field, via a coarse histogram. */
function heightRange(H) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < H.length; i++) {
    const v = H[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) return { lo: 0, hi: 1 };
  const BINS = 256;
  const hist = new Uint32Array(BINS);
  const k = BINS / (hi - lo);
  for (let i = 0; i < H.length; i++) {
    let b = ((H[i] - lo) * k) | 0;
    if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
    hist[b]++;
  }
  const pick = (frac) => {
    const want = H.length * frac;
    let acc = 0;
    for (let b = 0; b < BINS; b++) {
      acc += hist[b];
      if (acc >= want) return lo + ((b + 0.5) / BINS) * (hi - lo);
    }
    return hi;
  };
  return { lo: pick(0.01), hi: pick(0.995) };
}

/** Separable 3×3 box blur, in place, via one scratch buffer. */
function blur(H, N, passes) {
  const tmp = new Float32Array(N * N);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < N; y++) {
      const r = y * N;
      for (let x = 0; x < N; x++) {
        tmp[r + x] = (H[r + (x > 0 ? x - 1 : 0)] + H[r + x] + H[r + (x < N - 1 ? x + 1 : x)]) / 3;
      }
    }
    for (let x = 0; x < N; x++) {
      for (let y = 0; y < N; y++) {
        H[y * N + x] = (tmp[(y > 0 ? y - 1 : 0) * N + x] + tmp[y * N + x]
                      + tmp[(y < N - 1 ? y + 1 : y) * N + x]) / 3;
      }
    }
  }
  return H;
}

/**
 * Downsample the world's CPU-side fields into an N×N block summary.
 *
 * Reads the typed arrays on WorldData directly rather than the GPU textures,
 * because this needs a box filter over each block and a readback would cost
 * more than the arithmetic.
 *
 * Height is box-averaged; water is kept as the wet *fraction* of the block and
 * river as the block *maximum*, so a channel narrower than a map pixel still
 * registers rather than being averaged into nothing. Whether it then survives
 * to be drawn is `waterBodies`' decision, not this function's — sampling and
 * generalising are kept apart so the second can be retuned without disturbing
 * the first.
 */
export function sampleWorld(world, N) {
  const R = world.res;
  const height = world.height, water = world.water, riverMask = world.riverMask;
  const H = new Float32Array(N * N);
  const WET = new Float32Array(N * N);
  const DEP = new Float32Array(N * N);
  const RIV = new Float32Array(N * N);

  for (let py = 0; py < N; py++) {
    const z0 = Math.floor((py * R) / N);
    const z1 = Math.max(z0 + 1, Math.floor(((py + 1) * R) / N));
    for (let px = 0; px < N; px++) {
      const x0 = Math.floor((px * R) / N);
      const x1 = Math.max(x0 + 1, Math.floor(((px + 1) * R) / N));
      let hs = 0, n = 0, wet = 0, dep = 0, rm = 0;
      for (let gz = z0; gz < z1; gz++) {
        const row = gz * R;
        for (let gx = x0; gx < x1; gx++) {
          const i = row + gx;
          const hh = height[i];
          hs += hh; n++;
          const ww = water[i];
          if (ww > -9000 && ww > hh + 0.05) { wet++; dep += ww - hh; }
          const r = riverMask ? riverMask[i] : 0;
          if (r > rm) rm = r;
        }
      }
      const o = py * N + px;
      H[o] = hs / n;
      WET[o] = wet / n;
      DEP[o] = wet ? dep / wet : 0;
      RIV[o] = rm;
    }
  }
  return { H, WET, DEP, RIV };
}

/**
 * Turn the soft wet/river fields into a small number of *water bodies*.
 *
 * Pure, and deliberately so — this is the judgement call the whole revision
 * turns on, and it has to be tunable from `tools/_scratch/mapbake.mjs` without
 * a browser. Returns a 0..1 alpha per map pixel.
 *
 * Four steps, each throwing information away on purpose:
 *   1. threshold the softened fields into a binary "wet" mask;
 *   2. **open** it — erode by OPEN then dilate by OPEN — which deletes every
 *      feature narrower than 2·OPEN+1 pixels outright while leaving the outline
 *      of anything wider essentially where it was;
 *   3. drop connected components smaller than MIN_WATER_M2;
 *   4. blur the survivors back into an alpha so the shoreline is a soft edge
 *      rather than a stair.
 *
 * Depth is returned per *body*, not per pixel. A per-pixel depth ramp puts a
 * mottle inside every lake, which is precisely the sort of detail this revision
 * exists to remove; one tone per body still tells you a deep lake from a shallow
 * flood, which is the only thing depth was ever answering here.
 *
 * Returns `{ A, D }`: alpha and mean body depth in metres, both N×N.
 */
export function waterBodies(WET, RIV, DEP, N, cell) {
  const bin = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const lake = (WET[i] - WET_LO) / (WET_HI - WET_LO);
    const river = (RIV[i] - RIVER_LO) / (RIVER_HI - RIVER_LO);
    bin[i] = (lake > 0.5 || river > 0.5) ? 1 : 0;
  }

  morph(bin, N, OPEN, 0);        // erode
  morph(bin, N, OPEN, 1);        // dilate — together, an open

  // Area cull. Flood fill with an explicit stack: N is at most 512, so this is
  // a quarter of a million cells once, during the load screen.
  const minPx = Math.max(1, Math.round(MIN_WATER_M2 / (cell * cell)));
  const seen = new Uint8Array(N * N);
  const stack = new Int32Array(N * N);
  const body = new Int32Array(N * N);
  const D = new Float32Array(N * N);
  for (let start = 0; start < N * N; start++) {
    if (!bin[start] || seen[start]) continue;
    let sp = 0, count = 0;
    stack[sp++] = start; seen[start] = 1;
    while (sp > 0) {
      const i = stack[--sp];
      body[count++] = i;
      const x = i % N, y = (i / N) | 0;
      if (x > 0 && bin[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < N - 1 && bin[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0 && bin[i - N] && !seen[i - N]) { seen[i - N] = 1; stack[sp++] = i - N; }
      if (y < N - 1 && bin[i + N] && !seen[i + N]) { seen[i + N] = 1; stack[sp++] = i + N; }
    }
    if (count < minPx) { for (let k = 0; k < count; k++) bin[body[k]] = 0; continue; }
    let ds = 0;
    for (let k = 0; k < count; k++) ds += DEP[body[k]];
    const mean = ds / count;
    for (let k = 0; k < count; k++) D[body[k]] = mean;
  }

  const A = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) A[i] = bin[i];
  blur(A, N, EDGE_SOFT);
  // The alpha blur feathers a pixel or two past the binary edge; without this
  // those pixels would blend toward the *shallow* end of the ramp and put a
  // pale rim around every deep lake.
  spread(D, bin, N, EDGE_SOFT + 1);
  return { A, D };
}

/** Push a per-body value outward into the zero pixels around it. */
function spread(D, bin, N, passes) {
  for (let p = 0; p < passes; p++) {
    const src = D.slice();
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        if (src[i] > 0) continue;
        let v = 0;
        if (x > 0 && src[i - 1] > v) v = src[i - 1];
        if (x < N - 1 && src[i + 1] > v) v = src[i + 1];
        if (y > 0 && src[i - N] > v) v = src[i - N];
        if (y < N - 1 && src[i + N] > v) v = src[i + N];
        D[i] = v;
      }
    }
  }
  return D;
}

/** Erode (`grow` 0) or dilate (`grow` 1) a binary mask by a square radius. */
function morph(bin, N, radius, grow) {
  if (radius <= 0) return bin;
  const tmp = new Uint8Array(N * N);
  const pass = (src, dst, stride, limit) => {
    for (let a = 0; a < N; a++) {
      for (let b = 0; b < N; b++) {
        const i = stride === 1 ? a * N + b : b * N + a;
        let v = grow ? 0 : 1;
        for (let k = -radius; k <= radius; k++) {
          const bb = b + k;
          // Clamp at the border. For an erode that means the world edge does
          // not eat a lake that runs off the map.
          const j = i + (bb < 0 ? -b : bb > limit ? limit - b : k) * stride;
          v = grow ? (v | src[j]) : (v & src[j]);
        }
        dst[i] = v;
      }
    }
  };
  pass(bin, tmp, 1, N - 1);      // horizontal
  pass(tmp, bin, N, N - 1);      // vertical
  return bin;
}

/**
 * Paint the block summary into an RGBA byte array. Returns the contour interval
 * it chose, in metres.
 */
export function paintMap(fields, N, worldSize, out) {
  // The blurs are destructive, and that is fine — nothing else reads these.
  const H = blur(fields.H, N, SMOOTH_PASSES);
  const WET = blur(fields.WET, N, WET_BLUR);
  const RIV = blur(fields.RIV, N, WET_BLUR);
  // DEP is not blurred: it is only ever read as a mean over a whole body,
  // and blurring would drag dry-land zeros into that mean.
  const DEP = fields.DEP;

  // Percentile clip rather than min/max: one 320 m spire would otherwise squash
  // the whole valley into the bottom third of the ramp, and the valley is the
  // part the player is driving in.
  const { lo, hi } = heightRange(H);
  const span = Math.max(1e-3, hi - lo);
  const iv = CONTOUR_STEPS.find((s) => span / s <= TARGET_CONTOURS) ?? 500;
  const cell = worldSize / N;          // metres per map pixel
  const { A: WATER, D: WDEPTH } = waterBodies(WET, RIV, DEP, N, cell);

  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const o = py * N + px;
      const h = H[o];
      let [r, g, b] = rampAt((h - lo) / span);

      // Hillshade from the north-west, the cartographic convention — and the
      // only reason a ridge reads as a ridge rather than as a colour band.
      // Kept gentle: this is a diagram, not a relief photograph.
      const hxa = H[o - (px > 0 ? 1 : 0)];
      const hxb = H[o + (px < N - 1 ? 1 : 0)];
      const hza = H[o - (py > 0 ? N : 0)];
      const hzb = H[o + (py < N - 1 ? N : 0)];
      const gx = (hxb - hxa) / (2 * cell);
      const gz = (hzb - hza) / (2 * cell);
      const inv = 1 / Math.sqrt(gx * gx + gz * gz + 1);
      // N = (-gx, -gz, 1) * inv, L = (-0.5, -0.5, 0.707)
      const lam = clamp01((0.5 * gx + 0.5 * gz + 0.707) * inv);
      const sh = 0.80 + 0.34 * lam;
      r *= sh; g *= sh; b *= sh;

      // Contours. A band boundary crossed between this texel and the one west
      // or north of it is a line — cheap, crisp, and always one pixel.
      const band = Math.floor(h / iv);
      if (band !== Math.floor(hxa / iv) || band !== Math.floor(hza / iv)) {
        // Darken toward the pixel's own colour rather than toward a fixed ink,
        // so a contour stays visible on cream summits and plum hollows alike.
        r *= 0.66; g *= 0.66; b *= 0.70;
      }

      // Water last: it overrides both the tint and the contour, because a
      // contour drawn across a lake is a lie about a flat surface — and because
      // that flatness is now the main thing telling you it is water at all.
      const wt = clamp01(WATER[o]);
      if (wt > 0.004) {
        const dt = clamp01(WDEPTH[o] / DEEP_AT);
        const wr = lerpBack(WATER_SHALLOW[0] + (WATER_DEEP[0] - WATER_SHALLOW[0]) * dt, SCRIM[0]);
        const wg = lerpBack(WATER_SHALLOW[1] + (WATER_DEEP[1] - WATER_SHALLOW[1]) * dt, SCRIM[1]);
        const wb = lerpBack(WATER_SHALLOW[2] + (WATER_DEEP[2] - WATER_SHALLOW[2]) * dt, SCRIM[2]);
        r += (wr - r) * wt; g += (wg - g) * wt; b += (wb - b) * wt;
      }

      const k = o * 4;
      out[k] = r; out[k + 1] = g; out[k + 2] = b; out[k + 3] = 255;
    }
  }
  return iv;
}

export class MiniMap {
  constructor(root, world) {
    this.world = world ?? null;
    this.visible = true;

    this.node = el('div', 'pa-map pa-game-only');
    // Decorative: everything it says is also said by the compass and by the
    // world itself, and a screen reader has no use for a raster.
    this.node.setAttribute('aria-hidden', 'true');

    this.canvas = el('canvas', 'pa-map-canvas');
    this.node.appendChild(this.canvas);
    this.node.appendChild(el('div', 'pa-map-north', 'N'));

    // The player. A stubby arrowhead rather than a dot with a stick: at 14 px a
    // stick is one aliased pixel line and reads as noise, whereas a solid
    // triangle keeps its direction down to about 8 px.
    this.marker = el('div', 'pa-map-me',
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 2.6 L19.4 20.2 L12 15.7 L4.6 20.2 Z" ' +
      'fill="#e8622a" stroke="#fff6ea" stroke-width="1.9" stroke-linejoin="round"/></svg>');
    this.node.appendChild(this.marker);

    root.appendChild(this.node);

    this._size = 0;
    this._mx = this._my = this._mb = NaN;
    this.off = null;
    this._bakeN = 0;
    this._hasWorld = !!(this.world?.height && this.world?.water);

    // Appending forced a layout, so the element already has its size — which is
    // what decides the bake resolution.
    this._ensureBake();

    // Resize is the only thing that redraws the canvas, and it fires on window
    // resize and on the font-size clamp changing — never during play.
    this._ro = new ResizeObserver(() => this._ensureBake());
    this._ro.observe(this.node);
  }

  setVisible(v) {
    this.visible = !!v;
    this.node.classList.toggle('pa-gone', !this.visible);
  }

  /** Bake if we have not yet, or if the element has outgrown the raster. */
  _ensureBake() {
    if (!this._hasWorld) return;
    const css = this.canvas.clientWidth;
    if (!css) return;
    const want = Math.round(css * Math.min(2, window.devicePixelRatio || 1));
    const N = Math.max(BAKE_MIN, Math.min(BAKE_MAX, want));
    // Re-bake only when the map has grown enough that the shortfall would show.
    // Shrinking never needs one: downscaling a raster that is already close to
    // the target is exactly what the blit does well.
    if (this.off && N <= this._bakeN * 1.25) { this._blit(); return; }
    try { this._bake(N); } catch (e) { console.warn('[hud] minimap bake failed', e); }
  }

  _bake(N) {
    const w = this.world;
    this._bakeN = N;
    const f = sampleWorld(w, N);
    const off = document.createElement('canvas');
    off.width = off.height = N;
    const g = off.getContext('2d');
    const img = g.createImageData(N, N);
    this.contourInterval = paintMap(f, N, w.worldSize, img.data);
    g.putImageData(img, 0, 0);

    // The polyline stroke that used to happen here is gone. It existed to weld
    // a raster that broke into dashes back into a continuous thread — a good
    // repair to a problem this revision no longer has, because a thread that
    // thin is now deliberately *not* drawn. Stroking the rivers back in after
    // culling them by width and area would have been a cull with a cheat behind
    // it. Losing it also means the offline raster from
    // tools/_scratch/mapbake.mjs is now exactly, pixel for pixel, what ships.
    this.off = off;
    this._blit();
  }

  // ── presentation ──────────────────────────────────────────────────────────

  /** Downscale the bake into the visible canvas. Runs on resize only. */
  _blit() {
    const css = this.canvas.clientWidth;
    if (!css || !this.off) return;
    this._size = css;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const p = Math.max(1, Math.round(css * dpr));
    if (this.canvas.width !== p) { this.canvas.width = p; this.canvas.height = p; }
    const g = this.canvas.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.clearRect(0, 0, p, p);
    g.drawImage(this.off, 0, 0, p, p);
    this._mx = NaN;                        // force the marker to re-place
  }

  /**
   * `bearing` is degrees clockwise from north, matching the compass strip.
   *
   * The only per-frame work in this file, and deliberately transform-only:
   * writing `left`/`top` would invalidate layout sixty times a second for a
   * marker fourteen pixels wide.
   *
   * It also mostly does nothing, which is the point. One map pixel is 19 m, so
   * a camper at 60 km/h crosses one about once a second — quantising to a third
   * of a pixel and a degree of heading means the string is built and the style
   * written only when the marker would actually move somewhere different.
   * Measured against the interleaved A/B in tools/_scratch/postab.mjs, writing
   * it unconditionally cost 0.8 ms a frame at dpr 2, for a change nobody could
   * see.
   */
  update(x, z, bearing) {
    const s = this._size;
    if (!s) { this._ensureBake(); return; }
    const w = this.world;
    if (!w) return;
    const half = w.worldSize / 2;
    const px = Math.round(clamp01((x + half) / w.worldSize) * s * 3);
    const py = Math.round(clamp01((z + half) / w.worldSize) * s * 3);
    const pb = Math.round(bearing);
    if (px === this._mx && py === this._my && pb === this._mb) return;
    this._mx = px; this._my = py; this._mb = pb;
    this.marker.style.transform =
      `translate(${(px / 3).toFixed(2)}px, ${(py / 3).toFixed(2)}px) `
      + `translate(-50%, -50%) rotate(${pb}deg)`;
  }

  dispose() {
    this._ro?.disconnect();
    this.node?.remove();
  }
}
