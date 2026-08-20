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
// Water is the one thing you cannot drive across, so it gets the only cool hue
// on the map and therefore separates from every stop of the ramp above.
const WATER_SHALLOW = [124, 176, 205];
const WATER_DEEP = [37, 82, 120];

// The river mask is a wide, soft falloff — the terrain shader uses its skirts
// to damp grass near water, so it feathers out across most of the valley floor.
// Painting anything above zero as "river" floods the map in blue. Only the core
// of the channel is water you would have to drive around.
const RIVER_LO = 0.42;
const RIVER_HI = 0.72;
// Lakes come from the wet *fraction* of each block, softened first. The valley
// floor of this world is a flooded basin where water threads between hummocks,
// and thresholding it texel by texel produced a two-pixel dither of blue across
// a third of the map — visually it read as static, and it answered no question
// a driver has. Blurring the fraction before thresholding turns that dither
// into the thing it actually is: a marsh, drawn as one soft mass.
const WET_BLUR = 2;
const WET_LO = 0.30;
const WET_HI = 0.72;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function rampAt(t) {
  t = clamp01(t);
  for (let i = 1; i < RAMP.length; i++) {
    if (t > RAMP[i][0] && i < RAMP.length - 1) continue;
    const a = RAMP[i - 1], b = RAMP[i];
    const k = (t - a[0]) / (b[0] - a[0]);
    return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
  }
  return RAMP[RAMP.length - 1].slice(1);
}

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
 * Height is box-averaged, but water and river are taken as the *maximum* over
 * each block. A river eight metres wide is under a pixel at this scale, and
 * averaging it away is exactly how a minimap ends up with no rivers on it.
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
 * Paint the block summary into an RGBA byte array. Returns the contour interval
 * it chose, in metres.
 */
export function paintMap(fields, N, worldSize, out) {
  const { RIV } = fields;
  // The blurs are destructive, and that is fine — nothing else reads these.
  const H = blur(fields.H, N, SMOOTH_PASSES);
  const WET = blur(fields.WET, N, WET_BLUR);
  const DEP = blur(fields.DEP, N, 1);

  // Percentile clip rather than min/max: one 320 m spire would otherwise squash
  // the whole valley into the bottom third of the ramp, and the valley is the
  // part the player is driving in.
  const { lo, hi } = heightRange(H);
  const span = Math.max(1e-3, hi - lo);
  const iv = CONTOUR_STEPS.find((s) => span / s <= TARGET_CONTOURS) ?? 500;
  const cell = worldSize / N;          // metres per map pixel

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
      // contour drawn across a lake is a lie about a flat surface.
      const lake = clamp01((WET[o] - WET_LO) / (WET_HI - WET_LO));
      const river = clamp01((RIV[o] - RIVER_LO) / (RIVER_HI - RIVER_LO));
      const wt = Math.max(lake, river);
      if (wt > 0.002) {
        const dt = clamp01(DEP[o] / 5.5) * lake;
        const wr = WATER_SHALLOW[0] + (WATER_DEEP[0] - WATER_SHALLOW[0]) * dt;
        const wg = WATER_SHALLOW[1] + (WATER_DEEP[1] - WATER_SHALLOW[1]) * dt;
        const wb = WATER_SHALLOW[2] + (WATER_DEEP[2] - WATER_SHALLOW[2]) * dt;
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
    this._last = '';
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

    // The river mask gives every pixel its colour but not its continuity:
    // eroded channels drop below the threshold for a texel here and there and
    // the raster breaks into dashes. The polylines are the same rivers as a
    // curve, so stroking them welds the dashes back into one thread. Only a
    // canvas can do this, which is why it is not part of the pure raster.
    this._strokeRivers(g, N);

    this.off = off;
    this._blit();
  }

  _strokeRivers(g, N) {
    const lines = this.world.riverPolylines;
    if (!lines?.length) return;
    const s = N / this.world.worldSize;
    const half = this.world.worldSize / 2;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Faint on purpose. These are a *repair* to the raster, not a layer of
    // their own: at full strength a one-pixel polyline is the loudest thing on
    // the map, and rivers are not the loudest thing in the valley. Some of them
    // also leave the map in dead-straight runs, which reads as a drawing error
    // rather than as a river the moment the line is bright enough to follow.
    g.strokeStyle = 'rgba(112,164,197,0.5)';
    g.lineWidth = Math.max(1, N / 400);
    g.beginPath();
    for (const line of lines) {
      if (!line || line.length < 2) continue;
      for (let i = 0; i < line.length; i++) {
        const p = line[i];
        const x = (p.x + half) * s, y = (p.z + half) * s;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
    }
    g.stroke();
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
    this._last = '';                       // force the marker to re-place
  }

  /**
   * `bearing` is degrees clockwise from north, matching the compass strip.
   * The only per-frame work in this file, and deliberately transform-only:
   * writing `left`/`top` would invalidate layout sixty times a second for a
   * marker that is fourteen pixels wide.
   */
  update(x, z, bearing) {
    const s = this._size;
    if (!s) { this._blit(); return; }
    const w = this.world;
    if (!w) return;
    const half = w.worldSize / 2;
    const u = clamp01((x + half) / w.worldSize);
    const v = clamp01((z + half) / w.worldSize);
    const t = `translate(${(u * s).toFixed(1)}px, ${(v * s).toFixed(1)}px) `
            + `translate(-50%, -50%) rotate(${bearing.toFixed(1)}deg)`;
    if (t === this._last) return;
    this._last = t;
    this.marker.style.transform = t;
  }

  dispose() {
    this._ro?.disconnect();
    this.node?.remove();
  }
}
