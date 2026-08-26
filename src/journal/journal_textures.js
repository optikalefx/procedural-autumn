// ─────────────────────────────────────────────────────────────────────────────
//  journal_textures — everything the book is *surfaced* with, generated on a
//  canvas at construction. No image assets: same rule as the rest of the repo.
//
//  ── the thing that actually sells leather ──────────────────────────────────
//  Not the colour. The first pass at this cover was a nicely mottled brown
//  MeshStandardMaterial with no maps at all and it read as painted MDF, because
//  at the size a book fills the frame the eye is reading two things:
//
//    1. a HIGH-FREQUENCY PEBBLE GRAIN whose crevices are darker AND rougher
//       than its peaks. The roughness half is the important half — real leather
//       is burnished on the raised grain and matte in the valleys, so a raking
//       light picks out a field of tiny bright caps. A normal map alone with
//       uniform roughness reads as embossed plastic, which is exactly what the
//       second pass looked like.
//    2. a BLIND-TOOLED BORDER — the debossed line a binder runs a hot brass
//       wheel around, inset from the cover edge. It is the single strongest
//       "this is a bound book and not a brown box" signal available, it costs
//       one groove in the height field, and it must NOT tile, which is why the
//       cover gets its own non-repeating map set and the spine gets a separate
//       tiling one.
//
//  Grain is Worley (cellular) rather than fbm noise. fbm gives you a lumpy
//  surface; leather grain is *cells with creases between them*, and the crease
//  network is what the eye recognises. F2-F1 gives that network directly.
//
//  ── the size the maps are, and why they are not bigger ─────────────────────
//  512² for the cover. The cover is ~150 mm of real object filling maybe 500
//  CSS pixels of a 1600-wide frame, so 512 texels across it is already about
//  one texel per rendered pixel at photo-mode density. 1024² measured 4x the
//  build cost (the cellular pass is per-pixel over 9 cells) for a difference
//  nobody can see, and this runs on the main thread during boot.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp01, smoothstep } from '../core/MathUtils.js';

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Jittered-grid cellular noise. Returns F1 and F2 (distances to the nearest and
 * second-nearest feature point) in cell units, from the 3x3 neighbourhood.
 *
 * Toroidal: the cell index wraps, so a map built with this TILES, which the
 * spine/edge map depends on.
 */
function worley(x, y, cells, seedX, seedY, out) {
  const cx = Math.floor(x * cells), cy = Math.floor(y * cells);
  let f1 = 1e9, f2 = 1e9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = ((cx + i) % cells + cells) % cells;
      const gy = ((cy + j) % cells + cells) % cells;
      // Cheap deterministic hash. sin-based hashing is fine here: the output is
      // a texture built once, not a placement anyone has to reproduce.
      const h = Math.sin(gx * 127.1 + gy * 311.7 + seedX) * 43758.5453;
      const k = Math.sin(gx * 269.5 + gy * 183.3 + seedY) * 43758.5453;
      const jx = h - Math.floor(h), jy = k - Math.floor(k);
      const px = (cx + i + jx) / cells, py = (cy + j + jy) / cells;
      const dx = (x - px) * cells, dy = (y - py) * cells;
      const d = Math.hypot(dx, dy);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  out[0] = f1; out[1] = f2;
  return out;
}

/** Signed distance to a rounded rectangle outline, in normalised map units. */
function roundRectSDF(x, y, hw, hh, r) {
  const qx = Math.abs(x) - (hw - r), qy = Math.abs(y) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function canvasTexture(size, put, { srgb = true, repeat = 1 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const img = g.createImageData(size, size);
  put(img.data);
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat === 1) {
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  } else {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const [rx, ry] = Array.isArray(repeat) ? repeat : [repeat, repeat];
    tex.repeat.set(rx, ry);
  }
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The leather set: `{ map, normalMap, roughnessMap }`.
 *
 * One height field drives all three, which is the only way the three agree.
 * Building the roughness map independently is what made the second pass look
 * like plastic — the specular caps landed in the wrong places relative to the
 * bumps and the eye reads that as "a bump map on a smooth surface", instantly.
 *
 * @param tint   base leather colour, THREE.Color
 * @param border true to deboss a blind-tooled frame (cover faces only — this
 *               map does not tile when it is on)
 */
export function leatherMaps(tint, { size = 512, border = true, repeat = 1, seed = 3 } = {}) {
  const N = size, N2 = N * N;
  // Three fields, composed at the end, because they have to interact:
  //   grain   the hide's own surface
  //   deboss  everything a hot tool pressed INTO it (border, emblem)
  //   tooled  a 0..1 mask of where that tool went
  // The first pass added them straight into one array, which meant the grain
  // crossed the blind-tooled fillet unchanged — see the composition at the
  // bottom of this function for why that one omission was the loudest tell on
  // the whole cover.
  const grain = new Float32Array(N2);
  const deboss = new Float32Array(N2);
  const tooled = new Float32Array(N2);
  const h = new Float32Array(N2);
  const f = [0, 0];

  // ── height ────────────────────────────────────────────────────────────────
  // Two cellular octaves. The coarse one is the pebble; the fine one breaks its
  // faces up so a raking light does not paint 900 identical facets.
  for (let y = 0; y < N; y++) {
    const v = y / N;
    for (let x = 0; x < N; x++) {
      const u = x / N;
      // (F2-F1) is ~0 on a cell boundary and ~0.5 in a cell centre: a crease
      // network with domed cells between it, which is leather.
      //
      // THREE octaves, and the weights below are the second attempt. The
      // first set had 40/104/248 cells at 0.30/0.48/0.22, which on a 148 mm
      // board is 3.7/1.4/0.6 mm — and JUDGED AT OPENING FRAMING rather than at
      // 4x zoom, all three of those numbers were wrong:
      //
      //  · the 40-cell octave entered through smoothstep(0, 0.34, F2-F1),
      //    which SATURATES over most of a cell interior. What it contributed
      //    was therefore a second crease network rather than the large dome
      //    the comment claimed — i.e. it was adding the very crazing it was
      //    put here to prevent. Widened to 0.72 it stops clipping, and it is
      //    now the heaviest term: the pebble.
      //  · the 1.4 mm octave carried the largest weight and is a SINGLE cell
      //    size, so the "size distribution" was not visually present at all.
      //    It is the crease network and nothing else now.
      //  · the 0.6 mm octave is about two screen pixels at the framing the
      //    book actually opens at. Below Nyquist it does not resolve as cells;
      //    it integrates to a uniform fizz that shimmers when the book moves.
      //    Kept at a trace so a 4x zoom is not glassy between the creases.
      worley(u, v, 40, seed * 9.1, seed * 23.7, f);
      let e = smoothstep(0.0, 0.72, f[1] - f[0]) * 0.44;
      worley(u, v, 104, seed * 17.3, seed * 29.1, f);
      e += smoothstep(0.0, 0.30, f[1] - f[0]) * 0.34;
      worley(u, v, 248, seed * 51.7 + 4, seed * 13.9 + 7, f);
      e += smoothstep(0.0, 0.40, f[1] - f[0]) * 0.08;
      // A slow undulation so the hide is not perfectly flat across the board.
      e += 0.10 * Math.sin(u * 7.1 + seed) * Math.sin(v * 5.7 - seed * 2.0);
      grain[y * N + x] = e;
    }
  }

  // A handful of faint scratches. Leather that has been in a pack has them, and
  // three or four long low-contrast marks do more for "used object" than any
  // amount of extra grain.
  {
    const cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const g = cv.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
    g.strokeStyle = '#fff'; g.lineCap = 'round';
    let s = seed * 7919;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 7; i++) {
      const x0 = rnd() * N, y0 = rnd() * N;
      const a = rnd() * Math.PI * 2, len = N * (0.10 + rnd() * 0.34);
      g.lineWidth = 0.8 + rnd() * 1.5;
      g.globalAlpha = 0.25 + rnd() * 0.4;
      g.beginPath();
      g.moveTo(x0, y0);
      g.quadraticCurveTo(
        x0 + Math.cos(a + 0.3) * len * 0.5, y0 + Math.sin(a + 0.3) * len * 0.5,
        x0 + Math.cos(a) * len, y0 + Math.sin(a) * len);
      g.stroke();
    }
    const d = g.getImageData(0, 0, N, N).data;
    for (let i = 0; i < N2; i++) grain[i] -= (d[i * 4] / 255) * 0.18;
  }

  // ── the blind-stamped emblem ──────────────────────────────────────────────
  // A ridge, a fir and a moon, pressed into the middle of the front board.
  //
  // Blind TEXT was tried first and thrown away: a stamped title at this size is
  // four pixels of cap height on screen, which reads as a scratch, not as
  // words — and a title nobody can read is worse than no title, because the eye
  // keeps going back to it. A mark is legible as a mark at any size.
  //
  // Drawn with 2D paths into a mask and subtracted from the height field, so it
  // is a real deboss: it darkens, it polishes, and it catches the key light on
  // its lower lip exactly like the tooled border does, because it IS the same
  // mechanism.
  if (border) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const g = cv.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
    g.strokeStyle = '#fff';
    g.lineCap = 'round'; g.lineJoin = 'round';
    const R = N * 0.138, cx = N * 0.5, cy = N * 0.5;
    g.lineWidth = Math.max(1.6, N * 0.0055);
    // The ring
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(cx, cy, R * 0.90, 0, Math.PI * 2);
    g.globalAlpha = 0.55; g.stroke(); g.globalAlpha = 1;
    // The ridge, clipped to the ring
    g.save();
    g.beginPath(); g.arc(cx, cy, R * 0.86, 0, Math.PI * 2); g.clip();
    g.beginPath();
    g.moveTo(cx - R, cy + R * 0.42);
    g.lineTo(cx - R * 0.36, cy - R * 0.30);
    g.lineTo(cx - R * 0.06, cy + R * 0.10);
    g.lineTo(cx + R * 0.34, cy - R * 0.52);
    g.lineTo(cx + R, cy + R * 0.36);
    g.stroke();
    // A fir in front of it
    g.beginPath();
    g.moveTo(cx - R * 0.52, cy + R * 0.66);
    g.lineTo(cx - R * 0.52, cy + R * 0.10);
    for (let i = 0; i < 3; i++) {
      const y = cy + R * (0.14 + i * 0.18);
      const sp = R * (0.10 + i * 0.055);
      g.moveTo(cx - R * 0.52 - sp, y + sp * 0.7);
      g.lineTo(cx - R * 0.52, y - sp * 0.3);
      g.lineTo(cx - R * 0.52 + sp, y + sp * 0.7);
    }
    // The ground
    g.moveTo(cx - R, cy + R * 0.70); g.lineTo(cx + R, cy + R * 0.66);
    g.stroke();
    g.restore();
    // A moon, outside the ridge, inside the ring
    g.beginPath(); g.arc(cx + R * 0.46, cy - R * 0.50, R * 0.14, 0, Math.PI * 2); g.stroke();

    const d = g.getImageData(0, 0, N, N).data;
    for (let i = 0; i < N2; i++) {
      const t = (d[i * 4] / 255) * 0.74;
      if (t > 0) { deboss[i] = Math.max(deboss[i], t); tooled[i] = Math.max(tooled[i], t); }
    }
  }

  // ── the blind-tooled border ───────────────────────────────────────────────
  // Two grooves, an outer heavy one and an inner hairline, the way a binder's
  // double fillet actually runs. Depth is large compared with the grain (0.55
  // against ~1.0 of total grain range) because a tooled line is pressed with a
  // hot wheel and really is deeper than the grain it crosses.
  if (border) {
    for (let y = 0; y < N; y++) {
      const py = (y / N) * 2 - 1;
      for (let x = 0; x < N; x++) {
        const px = (x / N) * 2 - 1;
        const d1 = Math.abs(roundRectSDF(px, py, 0.845, 0.885, 0.10));
        const d2 = Math.abs(roundRectSDF(px, py, 0.795, 0.838, 0.09));
        const w1 = 0.010, w2 = 0.0045;
        const g1 = Math.exp(-(d1 / w1) * (d1 / w1));
        const g2 = Math.exp(-(d2 / w2) * (d2 / w2));
        const t = Math.min(1, g1 * 0.55 + g2 * 0.30);
        tooled[y * N + x] = Math.max(tooled[y * N + x], t);
        deboss[y * N + x] = Math.max(deboss[y * N + x], t);
      }
    }
  }

  // ── the joint, and the dye ────────────────────────────────────────────────
  //
  // THE JOINT. `coverGeometry` writes u = x/w + 0.5, so u = 0 is the hinge end
  // of the board — and that strip is not just leather with a fold in it, it is
  // the strip whose extruded SIDE WALL points straight down the key light
  // (-0.62, 0.92, 0.72). Left as ordinary burnished grain it fired back a
  // one-pixel highlight the full height of the closed book: measured 0.50 luma
  // against a 0.34 cover, a glowing seam on the first frame anybody sees. A
  // real joint is the opposite — crushed, dark and matte, because it is the
  // one part of the cover a thumb touches every time the book is opened.
  //
  // THE DYE. Real leather pools its dye over 15-40 mm; there was NO
  // low-frequency albedo variation on this cover at all, only a height
  // undulation, and one flat brown with grain over it is exactly the "printed
  // texture" read the grain is trying to escape. On a 148 mm board 15-40 mm is
  // 4 to 10 cycles across the map. Both of these are cover-only: the spine's
  // map TILES, and a non-tiling term in a tiling map is a visible seam.
  const joint = new Float32Array(N2);
  const mottle = new Float32Array(N2);
  if (border) {
    for (let y = 0; y < N; y++) {
      const v = y / N;
      for (let x = 0; x < N; x++) {
        const u = x / N;
        joint[y * N + x] = 1 - smoothstep(0.004, 0.042, u);
        const m =
          Math.sin(u * 4.3 + seed * 1.7) * Math.sin(v * 3.7 - seed * 0.9) +
          0.70 * Math.sin(u * 6.1 - seed * 2.3 + 1.4) * Math.sin(v * 8.9 + seed * 1.1) +
          0.50 * Math.sin((u + v) * 9.3 + seed) * Math.sin((u - v) * 7.1 - seed * 0.4);
        mottle[y * N + x] = m / 2.2;                 // about -1 .. 1
      }
    }
  }

  // ── compose the height field ──────────────────────────────────────────────
  //
  // A HOT BRASS WHEEL CRUSHES GRAIN FLAT. The first pass subtracted the fillet
  // and the emblem from the height field and left the pebble running across
  // them at full amplitude — so the tooled line looked like a dark stripe
  // PAINTED over leather instead of a line pressed into it, and that single
  // omission was the most obvious "this is a texture, not a hide" tell on the
  // cover. Multiplying the grain down inside the tool's own mask costs one
  // extra array and fixes it outright.
  for (let i = 0; i < N2; i++) {
    const crush = clamp01(tooled[i] + joint[i]);
    h[i] = grain[i] * (1 - 0.80 * crush) - deboss[i] - joint[i] * 0.16;
  }

  // ── wear ──────────────────────────────────────────────────────────────────
  // Rubbed at the four corners and along the cover edges: lighter, smoother,
  // slightly grey. This is what stops a new-looking cover reading as vinyl.
  const wear = new Float32Array(N2);
  for (let y = 0; y < N; y++) {
    const py = (y / N) * 2 - 1;
    for (let x = 0; x < N; x++) {
      const px = (x / N) * 2 - 1;
      const edge = smoothstep(0.80, 1.0, Math.max(Math.abs(px), Math.abs(py)));
      const corner = smoothstep(0.62, 1.05, Math.hypot(px, py) - 0.35);
      wear[y * N + x] = clamp01(edge * 0.55 + corner * 0.75) *
        (0.55 + 0.45 * Math.sin(px * 23.0) * Math.sin(py * 19.0) * 0.5 + 0.22);
    }
  }

  // ── albedo ────────────────────────────────────────────────────────────────
  const base = tint.clone();
  const hi = base.clone().lerp(new THREE.Color(0xc79256), 0.44);
  const lo = base.clone().multiplyScalar(0.40);
  const map = canvasTexture(N, (d) => {
    const c = new THREE.Color();
    for (let i = 0; i < N2; i++) {
      const e = clamp01(h[i] * 0.9 + 0.18);
      c.copy(lo).lerp(hi, e);
      if (border) {
        // Blind tooling darkens the groove — the leather is compressed and
        // scorched, not inked. Colour change is small; the shadow does the work.
        const t = tooled[i];
        c.multiplyScalar(1 - t * 0.30);
      }
      // Dye pooling: +-8% of value over 15-40 mm. Small enough that nobody
      // reads it as a pattern, large enough that no two square centimetres of
      // the board are the same colour.
      c.multiplyScalar(1 + mottle[i] * 0.08);
      // Worn areas lose pigment toward a pale dusty tan.
      c.lerp(new THREE.Color(0xb99a78), clamp01(wear[i]) * 0.34);
      // The joint is rubbed dark. See the note above the joint mask.
      c.multiplyScalar(1 - joint[i] * 0.36);
      d[i * 4] = c.r * 255; d[i * 4 + 1] = c.g * 255; d[i * 4 + 2] = c.b * 255; d[i * 4 + 3] = 255;
    }
  }, { srgb: true, repeat });

  // ── roughness ─────────────────────────────────────────────────────────────
  // Peaks burnished (0.42), valleys matte (0.86), wear polished back down. The
  // spread has to be wide: Stylize is not patching these materials (this scene
  // is not the world scene) so the specular term is three's own, and a narrow
  // roughness range on a small object produces no visible variation at all.
  const roughnessMap = canvasTexture(N, (d) => {
    for (let i = 0; i < N2; i++) {
      const e = clamp01(h[i] * 0.9 + 0.18);
      let r = lerp(0.88, 0.40, e);
      if (border) r = lerp(r, 0.34, tooled[i] * 0.8);     // the wheel polishes it
      r = lerp(r, 0.30, clamp01(wear[i]) * 0.55);
      r = lerp(r, 0.92, joint[i] * 0.85);                  // and the joint kills it
      const v = Math.round(clamp01(r) * 255);
      d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
  }, { srgb: false, repeat });

  // ── normal ────────────────────────────────────────────────────────────────
  // Sobel on the height field. `strength` is in height-units per texel and was
  // tuned by eye at the framing the journal actually opens at: too high and the
  // grain crawls under the key light, too low and the cover flattens the moment
  // the book tips away from the camera.
  const STRENGTH = 1.1;
  const at = (x, y) => h[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  const normalMap = canvasTexture(N, (d) => {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * STRENGTH;
        const dy = (at(x, y + 1) - at(x, y - 1)) * STRENGTH;
        let nx = -dx, ny = -dy, nz = 1;
        const l = Math.hypot(nx, ny, nz);
        nx /= l; ny /= l; nz /= l;
        const i = (y * N + x) * 4;
        d[i] = (nx * 0.5 + 0.5) * 255;
        d[i + 1] = (ny * 0.5 + 0.5) * 255;
        d[i + 2] = (nz * 0.5 + 0.5) * 255;
        d[i + 3] = 255;
      }
    }
  }, { srgb: false, repeat });

  return { map, normalMap, roughnessMap };
}

/**
 * The soft contact shadow the book sits in.
 *
 * A radial gradient, deliberately elliptical and offset: a light coming from
 * the upper left throws the shadow down and right, and an axis-aligned circular
 * blob under a rectangular object is one of the loudest tells of programmer
 * art. Alpha only — the plane it lands on is drawn with a dark colour.
 */
export function contactShadowTexture(size = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, size, size);
  g.save();
  g.translate(size * 0.52, size * 0.54);
  g.scale(1.0, 0.66);
  const grd = g.createRadialGradient(0, 0, size * 0.06, 0, 0, size * 0.48);
  grd.addColorStop(0.00, 'rgba(0,0,0,0.92)');
  grd.addColorStop(0.42, 'rgba(0,0,0,0.55)');
  grd.addColorStop(0.72, 'rgba(0,0,0,0.16)');
  grd.addColorStop(1.00, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(-size, -size, size * 2, size * 2);
  g.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Blank stock: the leaf a page with nothing printed on it shows.
 *
 * Small and cheap on purpose. Its whole job is that an unprinted leaf is CREAM
 * rather than the pure white a mapless MeshStandardMaterial would give — a
 * white leaf next to a printed one reads as a missing texture, which is exactly
 * what it would be.
 */
export function blankLeafTexture(size = 128) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = '#efe3c7';
  g.fillRect(0, 0, size, size);
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const n = (Math.random() - 0.5) * 10;
    d[i * 4] += n; d[i * 4 + 1] += n; d[i * 4 + 2] += n * 0.8;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The endpaper pasted to the inside of each cover.
 *
 * Real trade endpapers are patterned; this one is a warm ochre wash with a very
 * quiet contour-map print, because the book belongs to somebody who drives a
 * camper around a valley. It is drawn with strokes rather than generated as a
 * height field because it wants to look PRINTED — even line weight, no shading.
 */
export function endpaperTexture(size = 512, seed = 11) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = '#b89b6e';
  g.fillRect(0, 0, size, size);
  let s = seed * 2654435761;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  // Contour rings. Deliberately CALM: an early version wobbled each ring by
  // 30% of its own radius with five harmonics and came out as a spirograph —
  // the whole endpaper read as a scribble the moment the cover swung open,
  // which is the first interior surface anybody sees. Real contours are nearly
  // concentric, evenly spaced and drawn in one thin weight.
  g.strokeStyle = 'rgba(120,84,48,0.22)';
  g.lineWidth = 1.3;
  for (let hill = 0; hill < 4; hill++) {
    const cx = size * (0.16 + rnd() * 0.68), cy = size * (0.16 + rnd() * 0.68);
    const wob = 0.07 + rnd() * 0.06, ph = rnd() * 7, sq = 0.78 + rnd() * 0.3;
    const rings = 5 + Math.floor(rnd() * 4);
    for (let ring = 1; ring <= rings; ring++) {
      const r = ring * size * 0.030;
      g.beginPath();
      for (let a = 0; a <= 72; a++) {
        const th = (a / 72) * Math.PI * 2;
        const rr = r * (1 + wob * Math.sin(th * 2 + ph) + wob * 0.4 * Math.sin(th * 3 - ph));
        const x = cx + Math.cos(th) * rr, y = cy + Math.sin(th) * rr * sq;
        a ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
      g.stroke();
    }
  }
  // One river, because a contour map with no water on it looks like a diagram.
  g.strokeStyle = 'rgba(96,116,132,0.28)';
  g.lineWidth = 2.4;
  g.beginPath();
  g.moveTo(-10, size * 0.30);
  for (let i = 1; i <= 10; i++) {
    const x = (size * 1.02 * i) / 10;
    g.lineTo(x, size * (0.30 + 0.34 * Math.sin(i * 0.9 + 1.2) * 0.5 + i * 0.024));
  }
  g.stroke();

  // Paper tooth over the top so the flat ochre is not flat.
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const n = (rnd() - 0.5) * 16;
    d[i * 4] += n; d[i * 4 + 1] += n * 0.9; d[i * 4 + 2] += n * 0.7;
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}
