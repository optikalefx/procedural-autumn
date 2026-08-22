#!/usr/bin/env node
/**
 * Waterline edge quality, measured in the RENDERED FRAME.
 *
 *   node tools/wedge.mjs shots/w0-base/mouth.png
 *   node tools/wedge.mjs shots/w0-base/river.png shots/bed/river.png --zoom shots/wedge
 *   node tools/wedge.mjs a.png b.png --compare
 *
 * ── why a second instrument ──────────────────────────────────────────────────
 *
 * `tools/waterlab.mjs` measures the FIELD: the zero set of (water surface −
 * bed), in world metres, offline, in a fifth of a second. It is the right tool
 * for the cause. It is blind to the thing the player actually complains about,
 * because between that field and the screen sit a mesh, a fragment shader, a
 * projection and whatever antialiasing the pipeline has — and a shoreline can
 * be geometrically perfect in metres and still crawl with stair-steps on
 * screen, because the alpha edge that draws it is specified in world metres and
 * collapses inside one pixel at range.
 *
 * So this measures the same shapes in PIXELS, on a PNG, with no browser.
 *
 * ── how the waterline is found, and how that can lie ─────────────────────────
 *
 * The mask rule is `docs/WATER_ART_SPEC.md` §0's, the same one waterstats.mjs
 * uses: blue water is `B_srgb − R_srgb >= 0.02`. A colour rule latches onto sky
 * and pale distant hillsides as happily as onto water, so the same three
 * defences apply and are not optional:
 *
 *   1. the mask's share of the frame is printed on EVERY run;
 *   2. components touching the top row are dropped as sky, and components under
 *      2% of the largest are dropped as scatter — both counts are printed;
 *   3. `--zoom <dir>` writes the frame's busiest waterline region magnified with
 *      the extracted contour drawn over it. LOOK AT IT before quoting a number.
 *
 * **Hide `Waterfalls` as well as the vegetation.** `--waterdiff` hides only the
 * `Water` group, so any OTHER system that animates appears in the difference
 * and is counted as water. The falls do: their curtain is a field of
 * high-frequency whitewater streaks that advects between the two captures, and
 * on the `plunge` framing it dominated the mask — the extracted contour ran
 * down the curtain rather than along any shoreline, and `fine` read 16.5% for
 * a frame whose shorelines are clean. The falls are a separate system with a
 * separate look; judge them separately.
 *
 * The contour is not the mask boundary. It is the zero crossing of the
 * continuous field `(B − R) − 0.02`, extracted by marching squares with the
 * crossing interpolated along each pixel edge — which is the whole point. A
 * properly antialiased edge carries intermediate values, so the crossing lands
 * sub-pixel and the contour comes out smooth. A hard aliased edge jumps the
 * threshold inside one pixel, so every crossing lands on a pixel boundary and
 * the contour comes out as a staircase. The metrics below therefore measure
 * antialiasing and geometry together, which is correct: on screen they are the
 * same defect.
 *
 * ── the numbers ──────────────────────────────────────────────────────────────
 *
 *   fine    % of waterline length whose curvature radius is under 3 px. THE
 *           jaggedness number. A hand-painted plate is a few percent.
 *   stair   % of waterline length whose local direction disagrees with the
 *           direction of its own 4 px-smoothed curve by more than 20 degrees.
 *           A straight line at ANY angle scores zero; a pixel staircase scores
 *           near one, because its segments run at 0 and 90 while the curve they
 *           belong to runs at 45. Pure aliasing shows here first.
 *   crenel  contour length / its own 4 px-smoothed length.
 *   aaPx    median width of the edge in pixels, from the field's gradient at
 *           the waterline: the 15%-85% coverage span divided by how fast
 *           coverage changes there. A hard, unantialiased edge measures
 *           about 1.4 — the bilinear floor. See the block comment at the
 *           computation for the validation numbers.
 *           Anything under 1.3 is aliasing, whatever the still frame looks
 *           like, and it WILL crawl in motion. Good screen-space antialiasing
 *           lands 1.5-2.5. A number in the tens is not a soft edge, it is a
 *           slab with no edge at all.
 *   lenPx   total waterline length found, in pixels, summed from the raw
 *           marching-squares segments. Context for the rest: a tiny number
 *           means the mask found almost nothing and the other columns are
 *           noise.
 *   mask%   share of frame in the mask, after filtering.
 *   hole%   share of the contour that encloses DRY ground — pinholes in the
 *           water rather than bank. A result in its own right: the pristine
 *           baseline reads 16.9-33.6% and the current build 3.0-7.8%, which is
 *           the speckle reduction seen in the rendered frame. Read it before
 *           quoting `fine` or `stair`, both of which include it.
 */
import { readPNG } from './_pngread.mjs';
import { writePNG, canvas, text } from './_png.mjs';
import { mkdirSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const VALUED = new Set(['zoom', 'box', 'min-comp', 'thresh']);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);
const files = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { if (VALUED.has(a.slice(2))) i++; continue; }
  files.push(a);
}
if (!files.length) {
  console.error('usage: node tools/wedge.mjs <frame.png> [more.png ...] [--zoom <dir>] [--box x,y,w,h]');
  process.exit(2);
}

const THRESH = parseFloat(arg('thresh', '0.02'));
const MINCOMP = parseFloat(arg('min-comp', '0.02'));
const BOX = arg('box') ? arg('box').split(',').map(Number) : null;
const ZOOM = arg('zoom', null);
const DIFF_T = parseFloat(arg('diff-thresh', '0.045'));

function analyse(path) {
  const { w: W, h: H, px } = readPNG(path);
  const N = W * H;

  // ── the field the contour is cut on ────────────────────────────────────────
  //
  // Two ways to get it, and they are not equally honest.
  //
  // DIFF, used whenever `<frame>-nowater.png` exists beside the frame: the same
  // pose captured with the Water group hidden. The per-pixel difference between
  // the two IS the water's contribution, weighted by exactly the alpha it was
  // composited with. No colour rule, no threshold on appearance, and the
  // partial-alpha shoreline comes back as a real coverage ramp — which is what
  // makes the extracted waterline sub-pixel accurate rather than merely
  // plausible.
  //
  // COLOUR, the fallback: §0's `B_srgb - R_srgb >= 0.02`. It cannot tell water
  // from pale cool rock. On `shots/w0-bare-ref/waterfall.png` it found the
  // cliff face and reported 12.3% of it as a jagged shoreline. Every number
  // from this path is provisional until its --zoom image has been looked at.
  const nwPath = path.replace(/\.png$/, '-nowater.png');
  const haveDiff = existsSync(nwPath);
  const F = new Float32Array(N);
  if (haveDiff) {
    const nw = readPNG(nwPath);
    if (nw.w !== W || nw.h !== H) throw new Error(`${nwPath}: size differs from ${path}`);
    // Difference in sRGB, as a fraction of full scale, summed over the three
    // channels and scaled so that a fully opaque blue over gold bank lands well
    // above the threshold. DIFF_T is 0.045 of summed channel difference:
    // measured on the baseline captures, the noise floor away from water (the
    // renderer is not bit-exact between two draws) sits at 0.012 and the
    // faintest genuine shoreline pixel at 0.09.
    for (let i = 0; i < N; i++) {
      const d = Math.abs(px[i * 3] - nw.px[i * 3])
              + Math.abs(px[i * 3 + 1] - nw.px[i * 3 + 1])
              + Math.abs(px[i * 3 + 2] - nw.px[i * 3 + 2]);
      F[i] = (d / 765) - DIFF_T;
    }
  } else {
    for (let i = 0; i < N; i++) {
      const r = px[i * 3] / 255, b = px[i * 3 + 2] / 255;
      F[i] = (b - r) - THRESH;
    }
  }
  const inBox = (x, y) => !BOX || (x >= BOX[0] && x < BOX[0] + BOX[2] && y >= BOX[1] && y < BOX[1] + BOX[3]);

  // ── mask, and the two rejections, both counted ─────────────────────────────
  const raw = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const x = i % W, y = (i / W) | 0;
    if (inBox(x, y) && F[i] >= 0) raw[i] = 1;
  }
  const lab = new Int32Array(N).fill(-1);
  const comps = [];
  const stack = [];
  for (let s = 0; s < N; s++) {
    if (!raw[s] || lab[s] !== -1) continue;
    const id = comps.length;
    let n = 0, row0 = 0;
    stack.push(s); lab[s] = id;
    while (stack.length) {
      const p = stack.pop(); n++;
      const x = p % W, y = (p / W) | 0;
      if (y === 0) row0++;
      if (x > 0 && raw[p - 1] && lab[p - 1] === -1) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < W - 1 && raw[p + 1] && lab[p + 1] === -1) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && raw[p - W] && lab[p - W] === -1) { lab[p - W] = id; stack.push(p - W); }
      if (y < H - 1 && raw[p + W] && lab[p + W] === -1) { lab[p + W] = id; stack.push(p + W); }
    }
    comps.push({ id, n, row0 });
  }
  comps.sort((a, b) => b.n - a.n);
  // The size floor is a fraction of the largest component that SURVIVES the sky
  // rejection, not of the largest overall.
  //
  // That distinction was a silent, total failure and it is worth the paragraph.
  // Time advances between the water frame and the water-hidden one, and the
  // clouds advect — so the difference between the two frames contains the whole
  // sky as one enormous component. It touches row 0 and is correctly dropped,
  // but computing the floor from it set the bar at 2% of the SKY, which every
  // real body of water on the screen then failed. The `waterfall` framing came
  // back with a mask of 0.00%, 3 344 components rejected, and a table of zeros —
  // for a frame that visibly contains a plunge pool, a river and a lake. A
  // harness that reports nothing when there is something is worse than one that
  // reports the wrong number, because there is no number to disbelieve.
  const skyRejected = comps.filter((c) => c.row0 > 0).length;
  const survivors = comps.filter((c) => c.row0 === 0);
  const largest = survivors.length ? survivors[0].n : 0;
  const floor = Math.max(MINCOMP * largest, 0.0002 * N);
  const keep = new Set();
  let droppedSky = skyRejected, droppedSmall = 0;
  for (const c of survivors) {
    if (c.n < floor) { droppedSmall++; continue; }
    keep.add(c.id);
  }
  const mask = new Uint8Array(N);
  let maskN = 0;
  for (let i = 0; i < N; i++) if (lab[i] >= 0 && keep.has(lab[i])) { mask[i] = 1; maskN++; }

  // The field, restricted to kept components. A pixel outside them is forced
  // negative so the contour never runs round a rejected sky blob.
  const G = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = i % W, y = (i / W) | 0;
    if (!inBox(x, y)) { G[i] = -1; continue; }
    if (mask[i]) { G[i] = F[i]; continue; }
    // A dry pixel keeps its own value only if it neighbours a kept component,
    // so the crossing is interpolated against real bank colour rather than
    // snapped to -1 and pushed onto the pixel boundary — which would MANUFACTURE
    // the staircase this tool exists to detect.
    let touches = false;
    for (let dy = -1; dy <= 1 && !touches; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        if (mask[yy * W + xx]) { touches = true; break; }
      }
    }
    G[i] = touches ? Math.min(F[i], -1e-4) : -1;
  }

  // ── enclosed dry regions: holes in the water, not shoreline ───────────────
  //
  // Any small dry region fully surrounded by water has a perimeter, and the
  // contour traces it exactly as it traces a bank. It is reported separately
  // because it is a different fact about the frame.
  //
  // A critic introduced this column believing it measured OCCLUDER SILHOUETTES
  // — a boulder or shrub standing in front of water, which renders identically
  // in a frame and in its water-hidden twin, subtracts to zero, and punches a
  // hole. That is a real mechanism and it was a good hypothesis. **It is not
  // what this measures here**: re-capturing with `--hide Rocks` moves the number
  // by 0.3 points on the current build and 1.4 on the pristine baseline.
  //
  // What it actually finds is **pinholes in the water itself** — the speckle
  // this project has logged for several rounds. Which makes it a RESULT column
  // rather than a contamination one:
  //
  //     framing    baseline    current
  //     river        33.6%       7.5%
  //     hero         16.9%       4.2%
  //     mouth        16.9%       3.0%
  //
  // A third of the baseline `river` contour was the perimeter of holes in
  // shattered water. It is an independent confirmation, in the rendered frame,
  // of the 72% speckle reduction the offline field harness measures.
  //
  // Reported rather than subtracted out, deliberately: excluding it would
  // silently change `fine` and `stair` for everyone mid-round, and a reader is
  // better served by being shown how much of the contour is not a bank.
  const enclosed = new Uint8Array(N);
  {
    const seen = new Uint8Array(N), st = new Int32Array(N), comp = new Int32Array(N);
    for (let s0 = 0; s0 < N; s0++) {
      if (seen[s0] || mask[s0]) continue;
      let sp = 0, n = 0, touchesBorder = 0;
      st[sp++] = s0; seen[s0] = 1;
      while (sp > 0) {
        const k = st[--sp];
        comp[n++] = k;
        const x = k % W, y = (k / W) | 0;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touchesBorder = 1;
        if (x > 0 && !seen[k - 1] && !mask[k - 1]) { seen[k - 1] = 1; st[sp++] = k - 1; }
        if (x < W - 1 && !seen[k + 1] && !mask[k + 1]) { seen[k + 1] = 1; st[sp++] = k + 1; }
        if (y > 0 && !seen[k - W] && !mask[k - W]) { seen[k - W] = 1; st[sp++] = k - W; }
        if (y < H - 1 && !seen[k + W] && !mask[k + W]) { seen[k + W] = 1; st[sp++] = k + W; }
      }
      // Enclosed by water, and small enough to be an object rather than an
      // island: a genuine island in a lake is part of its shoreline and must
      // NOT be discounted. 6000 px is about 2% of a 1600x900 frame.
      if (!touchesBorder && n < 6000) for (let i = 0; i < n; i++) enclosed[comp[i]] = 1;
    }
  }

  // ── marching squares, sub-pixel ────────────────────────────────────────────
  const segs = [];
  const holeSeg = [];
  const lp = (p, q, vp, vq) => {
    const t = vp / (vp - vq);
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  };
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const P = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
      const V = [G[y * W + x], G[y * W + x + 1], G[(y + 1) * W + x + 1], G[(y + 1) * W + x]];
      let code = 0;
      for (let k = 0; k < 4; k++) if (V[k] > 0) code |= 1 << k;
      if (code === 0 || code === 15) continue;
      const E = [];
      for (let k = 0; k < 4; k++) {
        const a = k, b = (k + 1) & 3;
        if ((V[a] > 0) !== (V[b] > 0)) E.push(lp(P[a], P[b], V[a], V[b]));
      }
      // Does this cell touch an enclosed dry region? If so its segments are an
      // occluder's silhouette, not a waterline.
      const occl = enclosed[y * W + x] || enclosed[y * W + x + 1]
                || enclosed[(y + 1) * W + x] || enclosed[(y + 1) * W + x + 1];
      for (let k = 0; k + 1 < E.length; k += 2) {
        segs.push([E[k], E[k + 1]]);
        if (occl) holeSeg.push(segs.length - 1);
      }
    }
  }

  // ── chain into polylines ───────────────────────────────────────────────────
  const key = (p) => `${Math.round(p[0] * 64)},${Math.round(p[1] * 64)}`;
  const adj = new Map();
  for (const [a, b] of segs) {
    const ka = key(a), kb = key(b);
    if (ka === kb) continue;
    if (!adj.has(ka)) adj.set(ka, { p: a, n: [] });
    if (!adj.has(kb)) adj.set(kb, { p: b, n: [] });
    adj.get(ka).n.push(kb); adj.get(kb).n.push(ka);
  }
  const seen = new Set();
  const lines = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const out = [];
    let cur = start, prev = null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      out.push(adj.get(cur).p);
      const nb = adj.get(cur).n.filter((k) => k !== prev && !seen.has(k));
      prev = cur; cur = nb[0] ?? null;
    }
    if (out.length >= 6) lines.push(out);
  }

  // ── metrics ────────────────────────────────────────────────────────────────
  const polyLen = (L) => { let s = 0; for (let i = 1; i < L.length; i++) s += Math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1]); return s; };
  const resample = (L, sp) => {
    const out = [L[0]]; let acc = 0;
    for (let i = 1; i < L.length; i++) {
      let a = out[out.length - 1], b = L[i];
      let seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (seg < 1e-9) continue;
      while (seg >= sp - acc) {
        const t = (sp - acc) / seg;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        a = out[out.length - 1];
        seg -= (sp - acc); acc = 0;
      }
      acc += seg;
    }
    return out;
  };
  const gauss = (L, sigma) => {
    const r = Math.max(1, Math.round(sigma * 2.5));
    const w = []; for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
    return L.map((_, i) => {
      let sx = 0, sy = 0, sw = 0;
      for (let k = -r; k <= r; k++) {
        const j = Math.min(L.length - 1, Math.max(0, i + k)), ww = w[k + r];
        sx += L[j][0] * ww; sy += L[j][1] * ww; sw += ww;
      }
      return [sx / sw, sy / sw];
    });
  };
  // The strong-water level: the 90th percentile of the field over pixels the
  // water touched. `F` already has the threshold subtracted, so the level a
  // fully covered pixel reaches is this plus that offset.
  const THRESH_OFF = haveDiff ? DIFF_T : THRESH;
  const FULL = (() => {
    const t = [];
    for (let i = 0; i < N; i++) if (mask[i]) t.push(F[i] + THRESH_OFF);
    if (!t.length) return 1;
    t.sort((a, b) => a - b);
    return Math.max(1e-3, t[Math.floor(t.length * 0.90)]);
  })();

  const bilerp = (fx, fy) => {
    const x = Math.min(W - 1.001, Math.max(0, fx)), y = Math.min(H - 1.001, Math.max(0, fy));
    const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0;
    const a = F[y0 * W + x0], b = F[y0 * W + x0 + 1], c = F[(y0 + 1) * W + x0], d = F[(y0 + 1) * W + x0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };

  let totLen = 0, smoothLen = 0, fineLen = 0;
  let stairLen = 0, dirTotLen = 0;
  for (const rawL of lines) {
    if (polyLen(rawL) < 12) continue;
    const L = resample(rawL, 1.0);
    if (L.length < 6) continue;
    const S = gauss(L, 4.0);
    totLen += polyLen(L);
    smoothLen += polyLen(S);
    // Staircase = the local direction disagreeing with the direction of the
    // curve it belongs to. NOT direction mass at the lattice angles, which is
    // what this measured first and which was confidently wrong: a distant lake
    // shore seen from a level camera IS a horizontal line, and the histogram
    // form scored `mouth` at 25% "staircase" for a shoreline that is horizontal
    // because the geometry is horizontal. The crop that showed it is
    // shots/wedge/wip1/shots_wip1_bare_mouth_png.png.
    //
    // A real staircase alternates between two axis directions from one sample
    // to the next while the curve underneath goes one way. So: compare each
    // segment's direction to the 4 px-smoothed curve's direction at the same
    // place, and count the length whose disagreement exceeds 20 degrees. A
    // straight line at any angle scores zero. A pixel staircase scores near
    // one, because its segments are at 0 and 90 while its curve is at 45.
    const DEV = Math.cos(20 * Math.PI / 180);
    for (let i = 1; i < L.length; i++) {
      const dx = L[i][0] - L[i - 1][0], dy = L[i][1] - L[i - 1][1];
      const seg = Math.hypot(dx, dy);
      if (seg < 1e-6) continue;
      const j0 = Math.max(0, i - 3), j1 = Math.min(S.length - 1, i + 2);
      const sx = S[j1][0] - S[j0][0], sy = S[j1][1] - S[j0][1];
      const sl = Math.hypot(sx, sy);
      if (sl < 1e-6) continue;
      // |cos| — the curve has no orientation, only a direction line.
      const c = Math.abs((dx * sx + dy * sy) / (seg * sl));
      dirTotLen += seg;
      if (c < DEV) stairLen += seg;
    }
    for (let i = 1; i + 1 < L.length; i++) {
      const a = L[i - 1], b = L[i], c = L[i + 1];
      const ax = b[0] - a[0], ay = b[1] - a[1], bx = c[0] - b[0], by = c[1] - b[1];
      const cross = Math.abs(ax * by - ay * bx);
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by), lc = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const k = la * lb * lc > 1e-6 ? (2 * cross) / (la * lb * lc) : 0;
      if (k > 1 / 3.0) fineLen += (la + lb) * 0.5;
    }
  }
  // ── how many pixels wide is the edge ──────────────────────────────────────
  //
  // From the field's own GRADIENT, at the waterline: the width over which
  // coverage goes from 15% to 85% is that coverage difference divided by how
  // fast coverage is changing. Sub-pixel, one central difference per contour
  // vertex, and nothing to terminate early or silently drop.
  //
  // Three estimators were written before this one and all three failed the same
  // synthetic check — a horizontal edge built with a known 15-85% span of 1, 2,
  // 4 and 8 px (`aagen.mjs` in the scratchpad; `msdebug.mjs` beside it prints
  // the crossings down one column, which is how the fixture's own bug was
  // found). The first measured a thin slice around the mask threshold and
  // returned about 0.08 x the truth. The second walked the contour normal and
  // returned 1.79 / 1.50 / 4.88 / 1.63, which is not a measurement. The third
  // counted whole pixels in the band, which is honest but quantised: it reads
  // W-1 and floors at 1, so it cannot separate a 1 px edge from a 2 px one —
  // which is the only distinction anyone cares about here.
  //
  // Anything that replaces this must pass that fixture first, and the fixture
  // itself must be checked before the tool is: the version of it that produced
  // "the tool reads half the truth" had the water on the wrong side of the
  // edge, so the strip clamped dry to keep the body off row 0 became a second,
  // hard contour that doubled the length.
  //
  // VALIDATED against the fixture: known widths of 1 / 2 / 4 / 8 px read
  // 1.40 / 1.95 / 3.68 / 7.35 — within 8% for anything two pixels or wider,
  // with a floor at about 1.4 for an edge at or below the pixel, which is the
  // honest limit of a bilinear reconstruction of a step. So: **1.4 is a hard
  // edge**, 1.5-2.5 is good screen-space antialiasing, and a number in the tens
  // is not a soft edge at all, it is a slab.
  let segLen = 0;
  for (const [p0, p1] of segs) segLen += Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  let holeLen = 0;
  for (const k of holeSeg) {
    const [p0, p1] = segs[k];
    holeLen += Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  }
  const widths = [];
  {
    const span = 0.70 * FULL;             // 15% to 85% of full coverage
    const grad = (fx, fy) => {
      const gx = (bilerp(fx + 0.5, fy) - bilerp(fx - 0.5, fy));
      const gy = (bilerp(fx, fy + 0.5) - bilerp(fx, fy - 0.5));
      return Math.hypot(gx, gy);
    };
    // The gradient has to be read at HALF coverage, not at the contour.
    //
    // The contour is the zero of `F`, and `F` carries the mask threshold, so it
    // sits at whatever coverage that threshold happens to be — measured, about
    // 11%. A ramp is shallower there than at its middle: for a smoothstep the
    // slope at 11% is 1.006 against 1.5 at 50%, a factor of 1.49, and reading
    // the gradient at the contour duly returned 1.94 / 3.50 / 5.72 / 11.1 for
    // known widths of 1 / 2 / 4 / 8 — a consistent 1.4x, which is a bias and
    // not noise. So step up the gradient to the half-coverage level first.
    const mid = 0.50 * FULL - THRESH_OFF;
    for (let k = 0; k < segs.length; k += Math.max(1, (segs.length / 4000) | 0)) {
      const [p0, p1] = segs[k];
      let mx = (p0[0] + p1[0]) * 0.5, my = (p0[1] + p1[1]) * 0.5;
      let g = grad(mx, my);
      if (g <= 1e-5) continue;
      // Uphill in F is into the water. Walk until F reaches half coverage.
      for (let step = 0; step < 64; step++) {
        const v = bilerp(mx, my);
        if (v >= mid) break;
        const gx = (bilerp(mx + 0.5, my) - bilerp(mx - 0.5, my));
        const gy = (bilerp(mx, my + 0.5) - bilerp(mx, my - 0.5));
        const gl = Math.hypot(gx, gy);
        if (gl <= 1e-6) break;
        mx += (gx / gl) * 0.25; my += (gy / gl) * 0.25;
      }
      g = grad(mx, my);
      if (g > 1e-5) widths.push(Math.min(64, span / g));
    }
    widths.sort((x, y) => x - y);
  }
  // Median, not mean: a shoreline that is crisp along most of its length and
  // runs into a wide shallow shelf somewhere has a mean dragged by the shelf.
  const aaPx = widths.length ? widths[widths.length >> 1] : 0;

  const stair = dirTotLen > 0 ? stairLen / dirTotLen : 0;

  const m = {
    file: path,
    src: haveDiff ? 'diff' : 'colour',
    fine: totLen > 0 ? +(fineLen / totLen * 100).toFixed(1) : 0,
    stair: +(stair * 100).toFixed(1),
    crenel: smoothLen > 0 ? +(totLen / smoothLen).toFixed(3) : 0,
    aaPx: +aaPx.toFixed(2),
    lenPx: Math.round(segLen),
    hole: segLen > 0 ? +(holeLen / segLen * 100).toFixed(1) : 0,
    maskPct: +(maskN / N * 100).toFixed(2),
    droppedSky, droppedSmall,
  };

  if (ZOOM) {
    // The busiest 220 px square of waterline, at 3x, with the contour on it.
    const CELL = 220, SC = 3;
    let best = null;
    const gridW = Math.max(1, Math.floor(W / CELL)), gridH = Math.max(1, Math.floor(H / CELL));
    const score = new Float64Array(gridW * gridH);
    for (const L of lines) for (const p of L) {
      const gx = Math.min(gridW - 1, (p[0] / CELL) | 0), gy = Math.min(gridH - 1, (p[1] / CELL) | 0);
      score[gy * gridW + gx]++;
    }
    for (let i = 0; i < score.length; i++) if (!best || score[i] > best.s) best = { s: score[i], i };
    const ox = (best.i % gridW) * CELL, oy = ((best.i / gridW) | 0) * CELL;
    const img = canvas(CELL * SC, CELL * SC + 14, [10, 10, 12]);
    for (let y = 0; y < CELL * SC; y++) {
      for (let x = 0; x < CELL * SC; x++) {
        const sx = ox + ((x / SC) | 0), sy = oy + ((y / SC) | 0);
        if (sx >= W || sy >= H) continue;
        const k = (sy * W + sx) * 3;
        img.put(x, y + 14, px[k], px[k + 1], px[k + 2]);
      }
    }
    for (const L of lines) {
      for (let i = 1; i < L.length; i++) {
        const a = L[i - 1], b = L[i];
        const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * SC * 2));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const X = ((a[0] + (b[0] - a[0]) * t) - ox) * SC, Y = ((a[1] + (b[1] - a[1]) * t) - oy) * SC + 14;
          img.put(Math.round(X), Math.round(Y), 255, 40, 200);
        }
      }
    }
    text(img, 3, 3, `${path.split('/').slice(-2).join('/')} fine ${m.fine}% stair ${m.stair}% aa ${m.aaPx}px`, [240, 240, 240], 1);
    mkdirSync(ZOOM, { recursive: true });
    const out = `${ZOOM}/${path.replace(/[^\w]+/g, '_')}.png`;
    writePNG(out, img);
    m.zoom = out;
  }
  return m;
}

const rows = files.map(analyse);
const pad = (s, n) => String(s).padStart(n);
console.log(`${'frame'.padEnd(34)}${['fine', 'stair', 'crenel', 'aaPx', 'lenPx', 'mask%', 'hole%'].map((k) => pad(k, 9)).join('')}  src`);
for (const m of rows) {
  console.log(`${m.file.slice(-34).padEnd(34)}${pad(m.fine + '%', 9)}${pad(m.stair + '%', 9)}${pad(m.crenel, 9)}`
            + `${pad(m.aaPx, 9)}${pad(m.lenPx, 9)}${pad(m.maskPct + '%', 9)}${pad(m.hole + '%', 9)}  ${m.src}`);
  if (m.zoom) console.log(`${' '.repeat(34)}zoom: ${m.zoom}`);
}
if (rows.some((m) => m.src === 'colour')) {
  console.log('\n  !! a frame fell back to the COLOUR mask — it cannot tell water from pale cool rock.');
  console.log('     Re-capture with `node tools/shot.mjs --waterdiff ...` for an exact one.');
}
if (rows.some((m) => m.lenPx < 300)) {
  console.log('\n  !! a frame found under 300 px of waterline — its columns are noise, not a result.');
}
console.log('\n  targets: fine < 8%   stair < 4%   crenel < 1.03   aaPx 1.5-2.5 (1.4 is the hard-edge floor)');
