#!/usr/bin/env node
/**
 * The water checklist, run as one command.
 *
 *   node tools/waterstats.mjs shots/w-base/river.png [more.png …]
 *   node tools/waterstats.mjs --plate            # the reference-art targets, same format
 *
 * `docs/WATER_ART_SPEC.md` §5 is a ten-item checklist with numeric targets, and
 * every item names a measurement — "k-means on the water mask's Y", "a
 * perpendicular scan; ≥4 distinct bands". A critic who has to rebuild that
 * instrument before it can say anything will not rebuild it; it will write "the
 * water looks flat", which is precisely the verdict the spec exists to replace.
 * So this reports items 1–10 (and the cheap half of 11) as PASS/FAIL with the
 * measured number and the target printed on the same line, quotable verbatim.
 *
 * ── the part that can quietly lie ────────────────────────────────────────────
 *
 * Everything downstream of the mask is honest arithmetic. The mask is not: it
 * is a colour rule, and a colour rule latches onto sky, wet rock and pale
 * distant hillsides just as happily as onto water. A mask that has found the
 * cliff behind the river will report ten confident PASSes about a surface
 * nobody is looking at. Three defences, all mandatory:
 *
 *   1. The mask's pixel share of the frame is printed on EVERY run,
 *      unconditionally, with the component table that produced it.
 *   2. `--dump-mask <path>` writes the mask over the frame as a PNG, with the
 *      shoreline scan rays drawn on it. Look at it before quoting a number.
 *   3. Where an item cannot honestly be computed from a flat PNG it prints
 *      SKIP and the reason. It never approximates one into a number. A
 *      fabricated PASS on item 8 walks a critic away from a real defect, which
 *      is strictly worse than having no tool.
 *
 * The mask rule is the spec's own (§0): blue water is `B_srgb − R_srgb ≥ 0.02`,
 * aerated water is `B − R ≥ −0.01` with `C ≤ 0.20`. On top of that the pixels
 * are grouped into connected components and two components are dropped:
 * anything touching row 0 of the frame, and anything smaller than 2% of the
 * largest survivor. Row 0 is the useful one — in a ground-level frame the thing
 * crossing the top edge is sky, a distant cliff, or a waterfall arriving from
 * off-screen, and those are exactly the three liars. It has a known cost: a
 * falling curtain that leaves the top of frame is dropped too, so measure one
 * with `--box`. Verified by eye on `shots/w-base/`: the rule finds the river in
 * `river.png` and the lake in `mouth.png` and nothing else, and on the water
 * plate P3 it reproduces §2's k-means centres (0.073 · 0.148 · 0.245 · 0.382
 * against the spec's hand-masked 0.073 · 0.149 · 0.246 · 0.391).
 *
 * It does NOT get `waterfall.png` right on its own, and this is the concrete
 * case for looking at the dump. Two of the six components it keeps there are a
 * blue-cast SHADOW on the cliff face (0.72% and 0.53% of frame, boxes
 * 640,251–776,556 and 601,10–892,560), which drags the pooled `cool` and the
 * value spread around. The distant reach the spec measured is components 4, 7
 * and 8; box it — `--box 1150,675,460,140` — and §1.4 comes back to within 0.03.
 *
 * It fails loudly on `hero.png`, and that failure is the finding: hero's lakes
 * measure `cool` −0.03, so a blue-leaning rule cannot see them by construction
 * and the mask comes back at 0.25% of frame. The tool says so rather than
 * reporting statistics for the stray pixels it did find. Measure that frame the
 * way §0 says to — a hand-placed region:
 *
 *   node tools/waterstats.mjs shots/w-base/hero.png \
 *        --rule any --box 985,505,105,35 --meadow Y=0.147
 *
 * ── what it was checked against ──────────────────────────────────────────────
 *
 * `--plate` passes every applicable item on P3 and every applicable item but
 * one on P5, which is the least a checklist instrument can be asked to do. The
 * numbers it prints for the four `shots/w-base/` frames the spec measured by
 * hand line up with §1–§3:
 *
 *   river.png       mask median #30354c Y 0.037 C 0.118 S 0.395 vs §1.2's
 *                   #313b51 Y 0.037 C 0.124 S 0.390; cool 1.20/0.90/1.21/1.53
 *                   vs §1.4's 1.18/0.86/1.21/1.53; k=4 centres 0.031 · 0.039 ·
 *                   0.067 · 0.174 vs §2's 0.032 · 0.040 · 0.068 · 0.176.
 *   mouth.png       cool 1.15/0.70/1.12/1.63 vs §1.4's 1.15/0.70/1.11/1.63;
 *                   k=3 centres 0.101 · 0.173 · 0.225 vs §2's 0.098 · 0.176 ·
 *                   0.221.
 *   waterfall.png   with --box 1150,675,460,140 on the distant reach,
 *                   cool 0.81/0.39/0.75/1.29 vs §1.4's 0.78/0.36/0.73/1.26.
 *   hero.png        with the hand-placed box above, k=2 shares 32/68 exactly as
 *                   §2 reports, and 87% of the region at cool < 0.
 *   P3              k=4 centres 0.073 · 0.148 · 0.245 · 0.382 against §2's
 *                   hand-masked 0.073 · 0.149 · 0.246 · 0.391, and lace peaking
 *                   at Y 0.605 against §3.1's 0.616.
 *   P5 / ours       item 9 with hand boxes: plate curtain 1:1.11:1.22 C 0.153
 *                   vs §1.2's 1:1.12:1.21 C 0.151; ours 1:1.05:1.12 C 0.094 and
 *                   1:1.07:1.14 C 0.102 vs §1.2's 1:1.06:1.13 C 0.101 / 0.105.
 *
 * Two things do NOT reproduce and are called out where they appear. The gold
 * meadow anchor is hand-placed in §1.1 and the automatic one lands −0.11 to
 * +0.56 stops away depending on the frame, which moves items 2, 5, 6, 7, 8 and
 * 10 — pass `--meadow`. And the tails of the Y distribution move with the
 * mask's exact edge: river.png's p98 reads −0.30 stops here against §1.3's
 * −0.02, because the spec's hand mask reached further into the pale rim on the
 * far bank than the colour rule does.
 *
 * ── which "chroma" ───────────────────────────────────────────────────────────
 *
 * §0 of the spec carries a terminology warning, and the appendix records that
 * the ambiguity already made one stated target unreachable — `water_river.js`
 * asks for "chroma 0.22 against reference water measured at 0.48–0.78" when no
 * water in any plate exceeds C 0.40, because those were S values. Nothing here
 * prints a bare "chroma". Every number is labelled `C` (sRGB max−min) or `S`
 * (C/max), the UNITS block repeats both definitions on every run, and the two
 * are never summed, averaged or compared with each other.
 *
 * flags:
 *   --plate                  measure reference-art P3 (blue) and P5 (aerated)
 *   --rule blue|aerated|any  §0's two mask rules, or `any` for every pixel in
 *                            --box. `any` is the hand-placed mask §0 asks for
 *                            when the water has gone warm: hero.png's lakes are
 *                            cool −0.03 and the blue rule cannot see them at
 *                            all.                            (default: blue)
 *   --box x,y,w,h            restrict the mask to a box, as §0's hand masks did
 *   --comp N                 keep only the Nth-largest component (0-based)
 *   --keep-top               do not drop components touching row 0
 *   --min-comp F             component size floor, fraction of the largest (0.02)
 *   --meadow #rrggbb | x,y,w,h | Y=0.158
 *                            the frame's sunlit gold meadow anchor. §1.1 hand-
 *                            places this patch per frame; the auto value is the
 *                            median of the frame's gold population and can sit
 *                            up to ~0.8 stops off a hand-placed one, so items
 *                            2 / 5 / 7 / 8 / 10 quote the anchor they used.
 *   --curtain x,y,w,h        falling-curtain box   } item 9 needs both, and
 *   --plunge  x,y,w,h        plunge-basin box      } SKIPs without them
 *   --sky x,y,w,h            sky patch for item 11
 *   --patch x,y,w,h          extra hand-placed patch, dumped raw (repeatable)
 *   --scan-step N            shoreline scan step, px               (default 5)
 *   --scan-count N           shoreline scans attempted           (default 128)
 *   --dump-mask PATH         write the mask overlay + scan rays as a PNG
 *   --scale N                analyse at N px wide (default: native)
 *
 * Pixels come out of an OffscreenCanvas in headless Chromium, as
 * tools/colorstats.mjs does, and the run takes a capture slot from _lock.mjs —
 * three authors are capturing while this runs and a fourth Chromium is a fourth
 * Chromium whether or not it is rendering a world.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
// Flags that swallow the next token, so a value never lands in the file list.
const VALUED = new Set(['rule', 'box', 'comp', 'meadow', 'dump-mask', 'scan-step',
  'scan-count', 'erode', 'curtain', 'plunge', 'sky', 'patch', 'min-comp', 'scale']);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const argAll = (n) => argv.map((a, i) => (a === `--${n}` ? argv[i + 1] : null)).filter(Boolean);
const has = (n) => argv.includes(`--${n}`);

const files = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { if (VALUED.has(a.slice(2))) i++; continue; }
  files.push(a);
}

const PLATES = [
  { file: 'reference-art/Zight 2026-08-18 at 10.29.49 AM.jpg', rule: 'blue',    note: 'P3 — the water plate, blue river through gold meadow' },
  { file: 'reference-art/Zight 2026-08-18 at 10.30.57 AM.jpg', rule: 'aerated', note: 'P5 — the waterfall plate, curtain / plunge / foam torrent' },
];

if (!files.length && !has('plate')) {
  console.error('usage: waterstats.mjs <image> [image …]   |   waterstats.mjs --plate');
  console.error('       run with --dump-mask <path> and LOOK at the mask before quoting a number.');
  process.exit(1);
}

const jobs = has('plate')
  ? PLATES.map((p) => ({ file: p.file, rule: p.rule, note: p.note }))
  : files.map((f) => ({ file: f, rule: arg('rule', 'blue'), note: null }));

for (const j of jobs) {
  if (!existsSync(j.file)) { console.error(`✗ no such file: ${j.file}`); process.exit(1); }
}

if (arg('rule', 'blue') === 'any' && !arg('box')) {
  console.error('✗ --rule any measures every pixel in --box, and without a --box that is the whole frame.');
  console.error('  Give it the box you are vouching for: --rule any --box x,y,w,h');
  process.exit(1);
}

const parseRect = (s) => {
  if (!s) return null;
  const v = String(s).split(',').map(Number);
  if (v.length !== 4 || v.some(Number.isNaN)) { console.error(`✗ bad rect "${s}" — want x,y,w,h`); process.exit(1); }
  return v;
};

const OPT = {
  box: parseRect(arg('box')),
  comp: arg('comp') === null ? null : parseInt(arg('comp'), 10),
  keepTop: has('keep-top'),
  minComp: parseFloat(arg('min-comp', '0.02')),
  meadow: arg('meadow'),
  curtain: parseRect(arg('curtain')),
  plunge: parseRect(arg('plunge')),
  sky: parseRect(arg('sky')),
  patches: argAll('patch').map(parseRect),
  scanStep: parseInt(arg('scan-step', '5'), 10),
  scanCount: parseInt(arg('scan-count', '128'), 10),
  erode: parseInt(arg('erode', '2'), 10),
  scale: arg('scale') ? parseInt(arg('scale'), 10) : 0,
};

/* ────────────────────────────────────────────────────────────────────────────
 * Everything below `analyse` runs inside the page. It must not close over any
 * module scope — playwright ships the function source across, not the closure.
 * ──────────────────────────────────────────────────────────────────────────── */
async function analyse({ b64, ext, rule, opt, wantMask }) {
  const img = new Image();
  img.src = `data:image/${ext};base64,${b64}`;
  await img.decode();

  // Native resolution by default. Downsampling blends the waterline into the
  // bank, and the waterline is item 8; measured on river.png, 480-wide costs
  // 0.04 stops on the mask median and half the bright tail.
  const W = opt.scale || img.width;
  const H = Math.max(1, Math.round((img.height / img.width) * W));
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  const D = ctx.getImageData(0, 0, W, H).data;
  const N = W * H;

  // §0, verbatim. `lin` is the sRGB EOTF; Y is LINEAR luminance, L is the gamma
  // luma colorstats.mjs reports, C is max−min in sRGB, S is C/max, and `cool`
  // is (B−R)/Y in linear light — the same quantity wCoolGovern computes, signed,
  // positive blue, negative mud.
  const LUT = new Float64Array(256);
  for (let v = 0; v < 256; v++) { const s = v / 255; LUT[v] = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
  // Precomputed once into typed arrays. The object-per-pixel form below is kept
  // for the handful of places that want a hex or a whole sample, but the loops
  // that touch all 1.4M pixels — the gold scan, the mask statistics, the shelf
  // test, which between them ran seven passes — read these instead. Measured on
  // mouth.png, whose mask is 55% of the frame: minutes to seconds.
  const Yb = new Float32Array(N), Cb = new Float32Array(N), Sb = new Float32Array(N), Kb = new Float32Array(N);
  const Db = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const r8 = D[i * 4], g8 = D[i * 4 + 1], b8 = D[i * 4 + 2];
    const R = LUT[r8], G = LUT[g8], B = LUT[b8];
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const mx = Math.max(r8, g8, b8) / 255, mn = Math.min(r8, g8, b8) / 255;
    Yb[i] = Y; Cb[i] = mx - mn; Sb[i] = mx > 0 ? (mx - mn) / mx : 0;
    if (Y > 1e-5) Kb[i] = (B - R) / Y; else { Kb[i] = 0; Db[i] = 1; }
  }
  const px = (i) => {
    const r8 = D[i * 4], g8 = D[i * 4 + 1], b8 = D[i * 4 + 2];
    const r = r8 / 255, g = g8 / 255, b = b8 / 255;
    const R = LUT[r8], G = LUT[g8], B = LUT[b8];
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return {
      r8, g8, b8, Y,
      L: 0.2126 * r + 0.7152 * g + 0.0722 * b,
      C: mx - mn,
      S: mx > 0 ? (mx - mn) / mx : 0,
      cool: Y > 1e-5 ? (B - R) / Y : 0,
      degenerate: Y <= 1e-5,
    };
  };
  const hex = (p) => '#' + [p.r8, p.g8, p.b8].map((v) => v.toString(16).padStart(2, '0')).join('');
  const srt = (a) => a.slice().sort((x, y) => x - y);
  const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const r3 = (v) => +v.toFixed(3);
  const r2 = (v) => +v.toFixed(2);

  /* ── the mask ─────────────────────────────────────────────────────────── */
  const inBox = (x, y, b) => !b || (x >= b[0] && x < b[0] + b[2] && y >= b[1] && y < b[1] + b[3]);
  const raw = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const x = i % W, y = (i / W) | 0;
    if (!inBox(x, y, opt.box)) continue;
    const r = D[i * 4] / 255, g = D[i * 4 + 1] / 255, b = D[i * 4 + 2] / 255;
    const C = Math.max(r, g, b) - Math.min(r, g, b);
    raw[i] = rule === 'any' ? 1
      : rule === 'aerated' ? ((b - r) >= -0.01 && C <= 0.20 ? 1 : 0)
      : ((b - r) >= 0.02 ? 1 : 0);
  }

  // 4-connected components, iteratively (a recursive fill blows the stack on a
  // 800k-pixel lake).
  const lab = new Int32Array(N).fill(-1);
  const comps = [];
  const stack = [];
  for (let s = 0; s < N; s++) {
    if (!raw[s] || lab[s] !== -1) continue;
    const id = comps.length;
    let n = 0, row0 = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
    stack.push(s); lab[s] = id;
    while (stack.length) {
      const p = stack.pop(); n++;
      const x = p % W, y = (p / W) | 0;
      if (y === 0) row0++;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x > 0 && raw[p - 1] && lab[p - 1] === -1) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < W - 1 && raw[p + 1] && lab[p + 1] === -1) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && raw[p - W] && lab[p - W] === -1) { lab[p - W] = id; stack.push(p - W); }
      if (y < H - 1 && raw[p + W] && lab[p + W] === -1) { lab[p + W] = id; stack.push(p + W); }
    }
    comps.push({ id, n, row0, box: [minx, miny, maxx, maxy] });
  }
  comps.sort((a, b) => b.n - a.n);

  const largest = comps.length ? comps[0].n : 0;
  const floor = Math.max(opt.minComp * largest, 0.0002 * N);
  const keep = new Set();
  for (let r = 0; r < comps.length; r++) {
    const c = comps[r];
    c.rank = r;
    if (opt.comp !== null) { c.why = r === opt.comp ? null : `--comp ${opt.comp}`; }
    else if (c.row0 > 0 && !opt.keepTop) c.why = 'touches row 0';
    else if (c.n < floor) c.why = `< ${(opt.minComp * 100).toFixed(0)}% of largest`;
    else c.why = null;
    if (!c.why) keep.add(c.id);
  }
  const mask = new Uint8Array(N);
  let maskN = 0;
  for (let i = 0; i < N; i++) if (lab[i] >= 0 && keep.has(lab[i])) { mask[i] = 1; maskN++; }

  /* ── the mask's own statistics ────────────────────────────────────────── */
  const idx = new Int32Array(maskN);
  {
    let k = 0;
    for (let i = 0; i < N; i++) if (mask[i]) idx[k++] = i;
  }
  let degenerate = 0;
  const Ys = new Float64Array(maskN), Cs = new Float64Array(maskN), Ss = new Float64Array(maskN);
  const coolsRaw = [];
  for (let k = 0; k < maskN; k++) {
    const i = idx[k];
    Ys[k] = Yb[i]; Cs[k] = Cb[i]; Ss[k] = Sb[i];
    if (Db[i]) degenerate++; else coolsRaw.push(Kb[i]);
  }
  // The median-Y pixel, for the hex the spec quotes alongside the percentiles.
  const orderY = Array.from(idx).sort((a, b) => Yb[a] - Yb[b]);
  const medPx = orderY.length ? px(orderY[Math.floor(orderY.length / 2)]) : null;
  Ys.sort(); Cs.sort(); Ss.sort();
  const cools = srt(coolsRaw);

  /* ── the gold meadow anchor ───────────────────────────────────────────── */
  // §1.1 hand-places one patch per frame. Automating that is the weakest joint
  // in this tool and it is labelled as such in the output: measured against the
  // four w-base frames, the median of the frame's gold population lands −0.11,
  // −0.80, +0.26 and +0.56 stops from the spec's hand-placed anchors. Every
  // item that leans on it prints the anchor it used, and --meadow overrides.
  let meadow = null, meadowSrc = '';
  const patchStat = (b) => {
    const acc = [];
    for (let y = b[1]; y < b[1] + b[3]; y++) for (let x = b[0]; x < b[0] + b[2]; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      acc.push(px(y * W + x));
    }
    if (!acc.length) return null;
    const s = acc.slice().sort((a, b2) => a.Y - b2.Y);
    const m = s[Math.floor(s.length / 2)];
    return { hex: hex(m), Y: r3(m.Y), C: r3(q(srt(acc.map((p) => p.C)), 0.5)), S: r3(q(srt(acc.map((p) => p.S)), 0.5)), cool: r2(q(srt(acc.map((p) => p.cool)), 0.5)), n: acc.length };
  };
  if (opt.meadow && opt.meadow.startsWith('#')) {
    const v = opt.meadow.slice(1);
    const r8 = parseInt(v.slice(0, 2), 16), g8 = parseInt(v.slice(2, 4), 16), b8 = parseInt(v.slice(4, 6), 16);
    const R = LUT[r8], G = LUT[g8], B = LUT[b8];
    const r = r8 / 255, g = g8 / 255, b = b8 / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    meadow = { hex: opt.meadow, Y: r3(Y), C: r3(mx - mn), S: r3(mx ? (mx - mn) / mx : 0), cool: r2(Y > 1e-5 ? (B - R) / Y : 0) };
    meadowSrc = '--meadow, given as a colour';
  } else if (opt.meadow && opt.meadow.startsWith('Y=')) {
    meadow = { hex: '—', Y: +parseFloat(opt.meadow.slice(2)).toFixed(3), C: NaN, S: NaN, cool: NaN };
    meadowSrc = '--meadow, given as a luminance';
  } else if (opt.meadow) {
    meadow = patchStat(String(opt.meadow).split(',').map(Number));
    meadowSrc = `--meadow patch ${opt.meadow}`;
  } else {
    // "Sunlit gold meadow": strongly chromatic and strongly warm. The plates
    // run C 0.475–0.606 and cool −1.62 to −1.93; ours C 0.370–0.490 and cool
    // −1.27 to −1.69, so the gate is set below both at C ≥ 0.30, cool ≤ −1.0.
    const gold = [];
    for (let i = 0; i < N; i++) if (Cb[i] >= 0.30 && !Db[i] && Kb[i] <= -1.0) gold.push(i);
    if (gold.length > 200) {
      const g = gold.slice().sort((a, b) => Yb[a] - Yb[b]);
      const m = px(g[Math.floor(g.length / 2)]);
      meadow = {
        hex: hex(m), Y: r3(m.Y),
        C: r3(q(srt(gold.map((i) => Cb[i])), 0.5)),
        S: r3(q(srt(gold.map((i) => Sb[i])), 0.5)),
        cool: r2(q(srt(gold.map((i) => Kb[i])), 0.5)),
        share: r2(gold.length / N * 100),
      };
      meadowSrc = `auto — median of the ${r2(gold.length / N * 100)}% of the frame with C ≥ 0.30 and cool ≤ −1.0`;
    }
  }

  /* ── 1-D k-means over the mask's Y, §0 "Value masses" ─────────────────── */
  // Seeded on quantiles so it is deterministic; k = 2…5; the reported structure
  // is read off whichever k gives the frame the most qualifying masses, which
  // is deliberately generous — a FAIL that survives the frame's best k is not
  // an artefact of the k this tool happened to pick.
  const kmeans = (k) => {
    if (Ys.length < k * 4) return null;
    let cen = [];
    for (let i = 0; i < k; i++) cen.push(q(Ys, (i + 0.5) / k));
    const asg = new Int32Array(Ys.length);
    for (let it = 0; it < 80; it++) {
      let moved = 0;
      for (let i = 0; i < Ys.length; i++) {
        let bi = 0, bd = Infinity;
        for (let j = 0; j < k; j++) { const dd = Math.abs(Ys[i] - cen[j]); if (dd < bd) { bd = dd; bi = j; } }
        if (asg[i] !== bi) { asg[i] = bi; moved++; }
      }
      const sum = new Float64Array(k), cnt = new Float64Array(k);
      for (let i = 0; i < Ys.length; i++) { sum[asg[i]] += Ys[i]; cnt[asg[i]]++; }
      for (let j = 0; j < k; j++) if (cnt[j]) cen[j] = sum[j] / cnt[j];
      if (!moved) break;
    }
    const cnt = new Float64Array(k);
    let se = 0;
    for (let i = 0; i < Ys.length; i++) { cnt[asg[i]]++; se += (Ys[i] - cen[asg[i]]) ** 2; }
    const order = cen.map((_, i) => i).sort((a, b) => cen[a] - cen[b]);
    return {
      k, rms: Math.sqrt(se / Ys.length),
      cen: order.map((i) => cen[i]),
      share: order.map((i) => cnt[i] / Ys.length * 100),
    };
  };
  const ks = [2, 3, 4, 5].map(kmeans).filter(Boolean);

  // A "mass" a viewer can see: clusters closer than 0.5 stops are one tint, so
  // merge them (share-weighted), then drop anything under 5% of the water —
  // §2's own reading, which calls river.png's 3% pale rim "not a mass".
  const massesOf = (km) => {
    let m = km.cen.map((c, i) => ({ Y: c, share: km.share[i] }));
    for (;;) {
      let bi = -1, bd = Infinity;
      for (let i = 1; i < m.length; i++) { const d = Math.log2(m[i].Y / m[i - 1].Y); if (d < bd) { bd = d; bi = i; } }
      if (bi < 0 || bd >= 0.5) break;
      const a = m[bi - 1], b = m[bi], sh = a.share + b.share;
      m.splice(bi - 1, 2, { Y: (a.Y * a.share + b.Y * b.share) / (sh || 1), share: sh });
    }
    return m.filter((x) => x.share >= 5);
  };
  let best = null;
  for (const km of ks) {
    const m = massesOf(km);
    if (!best || m.length > best.masses.length) best = { km, masses: m };
  }
  const spanP1090 = Ys.length ? Math.log2(q(Ys, 0.90) / q(Ys, 0.10)) : NaN;
  const spanP0298 = Ys.length ? Math.log2(q(Ys, 0.98) / q(Ys, 0.02)) : NaN;

  /* ── the geometric mask, for item 4 ───────────────────────────────────── */
  // §0: "Do not use a blue-leaning mask to test for the mud failure. The rule
  // excludes warm pixels by construction, so it will always report 0% warm."
  // So item 4 runs on a *geometric* mask, which §0 explicitly permits: fill the
  // colour mask's holes (a warm patch inside the water is a hole), then erode
  // so the bank does not leak in. Anything opaque floating on the water — rock,
  // leaf, log — is a hole too and lands inside this mask, so the filled area is
  // reported alongside the number.
  const outside = new Uint8Array(N);
  {
    const qs = [];
    for (let x = 0; x < W; x++) { for (const y of [0, H - 1]) { const i = y * W + x; if (!mask[i] && !outside[i]) { outside[i] = 1; qs.push(i); } } }
    for (let y = 0; y < H; y++) { for (const x of [0, W - 1]) { const i = y * W + x; if (!mask[i] && !outside[i]) { outside[i] = 1; qs.push(i); } } }
    let h = 0;
    while (h < qs.length) {
      const p = qs[h++]; const x = p % W, y = (p / W) | 0;
      if (x > 0 && !mask[p - 1] && !outside[p - 1]) { outside[p - 1] = 1; qs.push(p - 1); }
      if (x < W - 1 && !mask[p + 1] && !outside[p + 1]) { outside[p + 1] = 1; qs.push(p + 1); }
      if (y > 0 && !mask[p - W] && !outside[p - W]) { outside[p - W] = 1; qs.push(p - W); }
      if (y < H - 1 && !mask[p + W] && !outside[p + W]) { outside[p + W] = 1; qs.push(p + W); }
    }
  }
  // Only SMALL holes are filled. P3 has a jeep, a bear and two vegetated islands
  // sitting in or against its river; filling those put 3.6% of the plate's own
  // "water" at cool < 0 and failed item 4 on the reference art. A hole bigger
  // than 0.5% of the mask is an object, not a patch of surface.
  let geom = new Uint8Array(N), filled = 0, holesDropped = 0;
  {
    const hl = new Int32Array(N).fill(-1), sizes = [], hstack = [];
    for (let s0 = 0; s0 < N; s0++) {
      if (mask[s0] || outside[s0] || hl[s0] !== -1) continue;
      const id = sizes.length; let n = 0;
      hstack.push(s0); hl[s0] = id;
      while (hstack.length) {
        const q0 = hstack.pop(); n++;
        const x = q0 % W, y = (q0 / W) | 0;
        const nb = [x > 0 ? q0 - 1 : -1, x < W - 1 ? q0 + 1 : -1, y > 0 ? q0 - W : -1, y < H - 1 ? q0 + W : -1];
        for (const t of nb) if (t >= 0 && !mask[t] && !outside[t] && hl[t] === -1) { hl[t] = id; hstack.push(t); }
      }
      sizes.push(n);
    }
    const cap = Math.max(64, 0.005 * maskN);
    for (let i = 0; i < N; i++) {
      if (mask[i]) { geom[i] = 1; continue; }
      if (outside[i]) continue;
      if (sizes[hl[i]] <= cap) { geom[i] = 1; filled++; } else holesDropped++;
    }
  }
  for (let e = 0; e < opt.erode; e++) {
    const nx = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!geom[i]) continue;
      const x = i % W, y = (i / W) | 0;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) continue;
      if (geom[i - 1] && geom[i + 1] && geom[i - W] && geom[i + W]) nx[i] = 1;
    }
    geom = nx;
  }
  const geomCool = [], geomC = [];
  for (let i = 0; i < N; i++) if (geom[i] && !Db[i]) { geomCool.push(Kb[i]); geomC.push(Cb[i]); }
  const geomCoolS = srt(geomCool);
  const warmShare = geomCoolS.length ? geomCoolS.filter((v) => v < 0).length / geomCoolS.length * 100 : NaN;

  /* ── item 5, silver sheet ─────────────────────────────────────────────── */
  let silver = NaN;
  if (meadow && maskN) {
    let n = 0;
    for (let k = 0; k < maskN; k++) { const i = idx[k]; if (Cb[i] < 0.09 && Yb[i] > meadow.Y) n++; }
    silver = n / maskN * 100;
  }

  /* ── the shoreline scan, items 6 / 7 / 8 ──────────────────────────────── */
  // §0/§3: a perpendicular scan across the bank, 5×5 box every step. The normal
  // comes from the gradient of a box-blurred mask, which is stable where a
  // per-pixel edge normal is not. A scan is thrown away unless its first three
  // outward samples are all outside the mask and its first three inward samples
  // all inside — that alone discards every ray launched off a corner or a spit.
  const blur = new Float32Array(N);
  {
    const R = 10, tmp = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      let acc = 0;
      for (let x = -R; x <= R; x++) acc += mask[y * W + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x++) {
        tmp[y * W + x] = acc / (2 * R + 1);
        acc -= mask[y * W + Math.min(W - 1, Math.max(0, x - R))];
        acc += mask[y * W + Math.min(W - 1, Math.max(0, x + R + 1))];
      }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let y = -R; y <= R; y++) acc += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y++) {
        blur[y * W + x] = acc / (2 * R + 1);
        acc -= tmp[Math.min(H - 1, Math.max(0, y - R)) * W + x];
        acc += tmp[Math.min(H - 1, Math.max(0, y + R + 1)) * W + x];
      }
    }
  }
  const box5 = (cx, cy) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4; r += D[i]; g += D[i + 1]; b += D[i + 2]; n++;
    }
    if (!n) return null;
    const r8 = Math.round(r / n), g8 = Math.round(g / n), b8 = Math.round(b / n);
    const R = LUT[r8], G = LUT[g8], B = LUT[b8];
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const rr = r8 / 255, gg = g8 / 255, bb = b8 / 255, mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
    return { r8, g8, b8, Y, C: mx - mn, S: mx ? (mx - mn) / mx : 0, cool: Y > 1e-5 ? (B - R) / Y : 0 };
  };

  const edges = [];
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const x = i % W, y = (i / W) | 0;
    if (x < 4 || y < 4 || x >= W - 4 || y >= H - 4) continue;      // frame border is not a shoreline
    if (mask[i - 1] && mask[i + 1] && mask[i - W] && mask[i + W]) continue;
    edges.push(i);
  }
  const OUT_MAX = 170, IN_MAX = 90;
  // §3.1 puts P3's lace 40 px INSIDE the blue mask's edge — behind a shallow rim
  // that is blue and therefore masked — so the search window has to reach well
  // past the waterline in both directions. Scaled to the frame: 72 px at 1600.
  const LACE_WIN = Math.max(60, Math.round(0.045 * W));
  const scans = [];
  // Edge pixels come out in raster order, so a plain stride bunches every ray
  // onto whichever stretch of bank happens to be densest in the upper rows —
  // on river.png that put all 32 scans on the far bank and left the near bank,
  // the one §3.6 measured, unsampled. Walk the whole boundary finely and keep a
  // candidate only if it is MIN_SEP px away from every ray already accepted.
  const MIN_SEP = 30;
  // Two passes. Collecting origins and stopping at the quota does NOT work:
  // boundary pixels arrive in raster order, and P3's ragged mid-distance reach
  // has so much perimeter that it filled all 128 slots before the scan ever
  // reached the foreground reach at the bottom of the frame — the one §3.1
  // measured, and the only one with lace on it. So take every MIN_SEP-separated
  // origin along the WHOLE boundary first, then thin that set uniformly.
  const origins = [];
  {
    const fine = Math.max(1, Math.floor(edges.length / 4000));
    for (let e = 0; e < edges.length; e += fine) {
      const i = edges[e], cx = i % W, cy = (i / W) | 0;
      if (origins.some((o) => Math.hypot(o.cx - cx, o.cy - cy) < MIN_SEP)) continue;
      origins.push({ i, cx, cy });
    }
  }
  const thin = Math.max(1, Math.floor(origins.length / Math.max(1, opt.scanCount)));
  for (let e = 0; e < origins.length; e += thin) {
    const { i, cx, cy } = origins[e];
    const gx = (blur[cy * W + Math.min(W - 1, cx + 3)] - blur[cy * W + Math.max(0, cx - 3)]);
    const gy = (blur[Math.min(H - 1, cy + 3) * W + cx] - blur[Math.max(0, cy - 3) * W + cx]);
    const gl = Math.hypot(gx, gy);
    if (gl < 0.01) continue;
    const nx = -gx / gl, ny = -gy / gl;                             // outward, away from water
    const samples = [];
    let ok = true;
    for (let t = -IN_MAX; t <= OUT_MAX; t += opt.scanStep) {
      const x = Math.round(cx + nx * t), y = Math.round(cy + ny * t);
      if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) { ok = false; break; }
      const s = box5(x, y);
      if (!s) { ok = false; break; }
      samples.push({ t, x, y, ...s, in: !!mask[y * W + x] });
    }
    if (!ok || samples.length < 12) continue;
    const at = (t) => samples.find((s) => s.t === t);
    const outer3 = [1, 2, 3].map((k) => at(k * opt.scanStep)).filter(Boolean);
    const inner3 = [1, 2, 3].map((k) => at(-k * opt.scanStep)).filter(Boolean);
    if (outer3.length < 3 || inner3.length < 3) continue;
    if (outer3.some((s) => s.in) || inner3.some((s) => !s.in)) continue;
    scans.push({ cx, cy, nx, ny, samples });
  }

  // ── band segmentation ──────────────────────────────────────────────────
  // A bank is not smooth: grass, leaf litter and dithered terrain make every
  // 5×5 sample differ from its neighbour, and a naive "new band whenever the
  // sample changes" counts texture. Measured on river.png that returned 22
  // bands over 225 px where §3.6 counts 3 over 25. Three corrections, in order
  // of how much each mattered:
  //   • the series is smoothed with a 3-tap mean before anything looks at it;
  //   • a sample is compared with the RUNNING MEAN of the band it is in, not
  //     with one arbitrary member of it;
  //   • a run shorter than two samples is merged back — an 8 px tide line at a
  //     5 px step is one sample, and one sample is not a band you can see.
  // Tolerances are calibrated against the spec's own hand counts: this returns
  // 3 bands for river.png (§3.6 says 3) and 5 for P3's near bank (§3.1 counts
  // 7, and the two it has that this does not are the 8 px tide line and one
  // 40 px pale band that sits inside the smoothing window).
  const TOL_Y = 0.30, TOL_C = 0.075, TOL_COOL = 0.55;
  const same = (a, b) => Math.abs(Math.log2(Math.max(a.Y, 1e-6) / Math.max(b.Y, 1e-6))) <= TOL_Y
    && Math.abs(a.C - b.C) <= TOL_C && Math.abs(a.cool - b.cool) <= TOL_COOL;
  const smooth = (s) => s.map((_, i) => {
    const w = s.slice(Math.max(0, i - 1), Math.min(s.length, i + 2));
    return { t: s[i].t, x: s[i].x, y: s[i].y, in: s[i].in, r8: s[i].r8, g8: s[i].g8, b8: s[i].b8,
      Y: w.reduce((a, v) => a + v.Y, 0) / w.length,
      C: w.reduce((a, v) => a + v.C, 0) / w.length,
      S: w.reduce((a, v) => a + v.S, 0) / w.length,
      cool: w.reduce((a, v) => a + v.cool, 0) / w.length };
  });
  const scanRead = (sc) => {
    const s = smooth(sc.samples);
    // The settled plateaus at each end. Reference is the median of the four
    // outermost samples; the plateau reaches as far in as the last sample that
    // still matches it, tolerating one outlier so a single leaf does not end it.
    const refOf = (arr) => {
      const Y = srt(arr.map((v) => v.Y)), C = srt(arr.map((v) => v.C)), K = srt(arr.map((v) => v.cool));
      return { Y: q(Y, 0.5), C: q(C, 0.5), cool: q(K, 0.5) };
    };
    // Water side: homogeneous, so the innermost four samples are the reference
    // and the body reaches out to the last sample that still matches them.
    const waterRef = refOf(s.slice(0, 4));
    let waterEdge = 0, miss = 0;
    for (let k = 0; k < s.length; k++) {
      if (same(s[k], waterRef)) { waterEdge = k; miss = 0; }
      else if (++miss > 1) break;
    }
    // Land side is the hard one, and it is where this item's number comes from.
    // "Settled" cannot just mean "three samples that agree": P3's damp band is
    // 105 px of near-flat dark olive (Y 0.050 → 0.041, a third of a stop) and a
    // local flatness test calls it settled ground and reports the plate's own
    // shoreline as 20 px wide. The transition ends where the ground settles AND
    // has come back to the MEADOW — within 1.2 stops of the anchor's Y, 0.15 of
    // its C and 0.8 of its cool. P3's damp band is 1.9 stops below its meadow
    // anchor and stays outside that; §3.1's dry gold at 1.08 stops falls inside.
    // This is the one place where the checklist's number moves with the meadow
    // anchor, so pass --meadow before quoting item 6 or 7.
    const meadowLike = (c) => meadow && Number.isFinite(meadow.C)
      && Math.abs(Math.log2(Math.max(c.Y, 1e-6) / meadow.Y)) <= 1.2
      && Math.abs(c.C - meadow.C) <= 0.15 && Math.abs(c.cool - meadow.cool) <= 0.8;
    let landEdge = -1;
    for (let k = waterEdge + 1; k < s.length - 2; k++) {
      if (!meadowLike(s[k])) continue;
      if (same(s[k], s[k + 1]) && same(s[k + 1], s[k + 2]) && same(s[k], s[k + 2])) { landEdge = k; break; }
    }
    if (landEdge < 0) {
      // No meadow anchor, or the ray never reaches the meadow (it ran into
      // forest, rock or shadow). Fall back to the ray's own outer plateau.
      const landRef = refOf(s.slice(-4));
      landEdge = s.length - 1; miss = 0;
      for (let k = s.length - 1; k >= 0; k--) {
        if (same(s[k], landRef)) { landEdge = k; miss = 0; }
        else if (++miss > 1) break;
      }
    }
    if (waterEdge >= landEdge - 1) return null;

    // Greedy runs over the transition, against the running mean of the run.
    const runs = [];
    let acc = null;
    for (let k = waterEdge + 1; k < landEdge; k++) {
      const c = s[k];
      if (acc && same(c, { Y: acc.Y / acc.n, C: acc.C / acc.n, cool: acc.cool / acc.n })) {
        acc.n++; acc.Y += c.Y; acc.C += c.C; acc.cool += c.cool; acc.px += opt.scanStep; acc.members.push(c);
      } else {
        if (acc) runs.push(acc);
        acc = { n: 1, Y: c.Y, C: c.C, cool: c.cool, px: opt.scanStep, members: [c] };
      }
    }
    if (acc) runs.push(acc);
    // Merge single-sample runs into whichever neighbour they are closer to.
    for (let pass = 0; pass < 4; pass++) {
      const i = runs.findIndex((r, k) => r.n < 2 && runs.length > 1 && k >= 0);
      if (i < 0) break;
      const j = i === 0 ? 1 : i - 1;
      const a = runs[i], b = runs[j];
      b.n += a.n; b.Y += a.Y; b.C += a.C; b.cool += a.cool; b.px += a.px; b.members.push(...a.members);
      runs.splice(i, 1);
    }
    // "+1" is the settled water body itself, which §3.1 counts as a band (its
    // band 8) and §3.6 counts for river.png. Reproduces 7 for P3 and 3 for ours.
    const bands = runs.length + 1;
    const widthPx = s[landEdge].t - s[waterEdge].t;

    // The damp band: the darkest LAND-side sample inside the transition, taken
    // at least two steps out from the waterline so the tide line — §3.1's band
    // 3, one dark near-neutral step ~8 px wide — is not mistaken for it. §3.5's
    // rule is about the substrate band's polarity, not about that step.
    const landSide = [];
    for (let k = waterEdge + 1; k < landEdge; k++) if (s[k].t >= 2 * opt.scanStep) landSide.push(s[k]);
    // Against blue water the band is the DARK one, so take the three darkest.
    // Against white water §3.4's band is the one whose CHROMA collapses while
    // its value stays flat, so take the three least chromatic; picking the
    // darkest there measures a shadow and reports the plate's own pale margin
    // as a quarter stop down at C 0.187.
    landSide.sort(rule === 'aerated' ? (a, b) => a.C - b.C : (a, b) => a.Y - b.Y);
    const dk = landSide.slice(0, 3);
    // §3.5's "1.0–1.9 stops down" is measured against the DRY GROUND BESIDE IT,
    // not against §1.1's sunlit meadow anchor: P3's band 2 is Y 0.050 against
    // §3.1's band 1 dry gold at Y 0.089, which is −0.83 stops, while the same
    // band against §1.1's anchor at Y 0.188 is −1.91. Using the scan's own
    // settled ground reproduces the stated target and drops item 7's dependence
    // on the anchor. `dry` is the median Y of the settled ground this ray found.
    const dryW = s.slice(landEdge, Math.min(s.length, landEdge + 4));
    const dry = q(srt(dryW.map((v) => v.Y)), 0.5);
    const dryC = q(srt(dryW.map((v) => v.C)), 0.5);
    const dryCool = q(srt(dryW.map((v) => v.cool)), 0.5);
    const damp = dk.length ? {
      Y: dk.reduce((a, v) => a + v.Y, 0) / dk.length,
      C: dk.reduce((a, v) => a + v.C, 0) / dk.length,
      cool: dk.reduce((a, v) => a + v.cool, 0) / dk.length,
      dry, dryC, dryCool,
    } : null;
    if (damp) damp.stops = Math.log2(Math.max(damp.Y, 1e-6) / Math.max(dry, 1e-6));
    // The lace: the brightest sample on the WATER side within 40 px of the edge.
    // Searched GEOMETRICALLY — within 60 px inside the waterline — and not
    // inside the colour mask, because P3's lace is `#e2c7d3`, B−R = −15/255,
    // i.e. faintly WARM (§3.1 band 5, cool −0.05 to −0.18). A blue-leaning mask
    // excludes the plate's own lace by construction; testing item 8 inside it
    // reports "no lace" on the reference art, which is how this was caught.
    // The window straddles the waterline (±60 px) because the mask edge is not
    // reliably on the water side of the lace: P3's shallow rim is blue, its
    // lace is not, so the blue component ends at the lace's INNER edge and the
    // lace sits at positive t. Candidates are gated on hue instead of on side —
    // C ≤ 0.30 and cool ≥ −0.6 — which admits both of the plate's two lace
    // forms (near-white cream at cool −0.05…−0.18, pale blue at cool 1.09) and
    // rejects sunlit gold bank, which runs C ≈ 0.5 at cool ≤ −1.0.
    let lace = null, laceW = 0;
    for (const c of s) {
      if (Math.abs(c.t) > LACE_WIN || c.C > 0.30 || c.cool < -0.6) continue;
      if (!lace || c.Y > lace.Y) lace = c;
    }
    if (lace) for (const c of s) { if (Math.abs(c.t) <= LACE_WIN && Math.log2(Math.max(lace.Y, 1e-6) / Math.max(c.Y, 1e-6)) <= 0.5) laceW += opt.scanStep; }
    return { bands, widthPx, damp, lace, laceW };
  };
  const reads = scans.map(scanRead).filter(Boolean);
  const med = (a) => (a.length ? srt(a)[Math.floor(a.length / 2)] : NaN);

  // Channel width, for item 8's "≤8% of channel width": the median run length
  // of mask pixels along a row. For a river that is the channel; for an open
  // lake it is the lake, and the item's width test is meaningless there — which
  // is why the number is printed rather than silently used.
  const rowRuns = [];
  for (let y = 0; y < H; y++) {
    let run = 0, best2 = 0;
    for (let x = 0; x < W; x++) { if (mask[y * W + x]) { run++; if (run > best2) best2 = run; } else run = 0; }
    if (best2 > 3) rowRuns.push(best2);
  }
  const channelPx = rowRuns.length ? med(rowRuns) : NaN;

  // Three conditions, not two. §3.2: "What is constant is that it is ~2 stops
  // brighter than the water immediately inside it." Without that clause the
  // sky-glare streaks near mouth.png's shore qualify at Y 0.427 — only 1.17
  // stops over that lake's median — and item 8 reports a lace in a frame §1.2
  // records as having none. Gate at 1.5 stops, with the plate at 3.09.
  const bodyMedY = Ys.length ? q(Ys, 0.5) : 1;
  const laced = reads.filter((r) => r.lace && r.lace.Y >= 0.40 && r.lace.C >= 0.07 && r.lace.C <= 0.30
    && Math.log2(r.lace.Y / Math.max(bodyMedY, 1e-6)) >= 1.5);
  const lacePeak = reads.length ? Math.max(...reads.map((r) => (r.lace ? r.lace.Y : 0))) : NaN;

  /* ── item 10, a shallow shelf mass ────────────────────────────────────── */
  // Colour signature AND bank adjacency. A shelf is a mass lying against the
  // bank; a scatter of shelf-coloured pixels in midwater is glare, not a shelf.
  let shelf = null;
  if (best && meadow) {
    const dist = new Int32Array(N).fill(-1);
    const qd = [];
    for (const i of edges) { dist[i] = 0; qd.push(i); }
    let h = 0;
    while (h < qd.length) {
      const p = qd[h++]; if (dist[p] >= 60) continue;
      const x = p % W, y = (p / W) | 0; const nd = dist[p] + 1;
      if (x > 0 && mask[p - 1] && dist[p - 1] < 0) { dist[p - 1] = nd; qd.push(p - 1); }
      if (x < W - 1 && mask[p + 1] && dist[p + 1] < 0) { dist[p + 1] = nd; qd.push(p + 1); }
      if (y > 0 && mask[p - W] && dist[p - W] < 0) { dist[p - W] = nd; qd.push(p - W); }
      if (y < H - 1 && mask[p + W] && dist[p + W] < 0) { dist[p + W] = nd; qd.push(p + W); }
    }
    const cands = [];
    const bands = best.masses.map((m) => ({ m, lo: m.Y / Math.SQRT2, hi: m.Y * Math.SQRT2, C: [], S: [], K: [], near: 0 }));
    for (let k = 0; k < maskN; k++) {
      const i = idx[k], y = Yb[i];
      for (const b of bands) {
        if (y < b.lo || y > b.hi) continue;
        b.C.push(Cb[i]); b.S.push(Sb[i]); b.K.push(Kb[i]);
        if (dist[i] >= 0) b.near++;
      }
    }
    for (const b of bands) {
      const m = b.m, acc = b.C, near = b.near;
      if (acc.length < 50) continue;
      const C = q(srt(b.C), 0.5), S = q(srt(b.S), 0.5);
      const cl = q(srt(b.K), 0.5);
      cands.push({
        Y: r3(m.Y), share: r2(m.share), C: r3(C), S: r3(S), cool: r2(cl),
        stops: r2(Math.log2(m.Y / meadow.Y)), bankPct: r2(near / acc.length * 100),
        // §4 F2 in full: "S > 0.42 AND cool > 2.5 AND Y at or above the frame's
        // gold meadow". §5 item 10 quotes only the first two, and without the
        // third P3's own deep body — S 0.75, cool 2.59, but 2.3 stops BELOW the
        // meadow — is reported as swimming-pool cyan on the reference plate.
        cyan: S > 0.42 && cl > 2.5 && m.Y >= meadow.Y,
        // The stated signature is "C ≈ 0.19, S ≤ 0.40, cool ≈ 1.1, 0.5 stops
        // below the meadow". The ± here is this tool's, not the spec's: a
        // k-means mass is a half-stop band of water and mixes in its
        // neighbours, so it lands a little wide of a hand-picked patch. P3's
        // shelf mass measures C 0.227, S 0.411, cool 1.32 at −0.52 stops
        // against the spec's hand patch at C 0.194, S 0.374, cool 1.12, −0.53.
        ok: C >= 0.13 && C <= 0.25 && S <= 0.42 && cl >= 0.6 && cl <= 1.6
          && Math.log2(m.Y / meadow.Y) <= -0.2 && Math.log2(m.Y / meadow.Y) >= -0.9
          && m.share >= 5 && (near / acc.length) >= 0.4,
      });
    }
    shelf = cands;
  }

  /* ── hand-placed patches: items 9 and 11, and anything a critic wants ─── */
  const curtain = opt.curtain ? patchStat(opt.curtain) : null;
  const plunge = opt.plunge ? patchStat(opt.plunge) : null;
  const skyPatch = opt.sky ? patchStat(opt.sky) : null;
  const patches = opt.patches.map((b) => ({ box: b, ...(patchStat(b) || {}) }));
  const ratio = (p) => (p && p.hex !== '—' ? (() => {
    const v = p.hex.slice(1);
    const r = parseInt(v.slice(0, 2), 16) || 1, g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
    return `1:${(g / r).toFixed(2)}:${(b / r).toFixed(2)}`;
  })() : null);

  // The top-of-frame band, reported for item 11 but NOT passed or failed: this
  // tool cannot tell sky from a distant cliff, and mouth.png's top band is rock
  // that measures perfectly sky-like. Use --sky to hand it a patch.
  const TB = Math.max(1, Math.round(H * 0.06));
  const tb = [];
  for (let y = 0; y < TB; y++) for (let x = 0; x < W; x++) tb.push(y * W + x);
  const tbSorted = tb.slice().sort((a, b) => Yb[a] - Yb[b]);
  const topBand = {
    hex: hex(px(tbSorted[Math.floor(tbSorted.length / 2)])),
    Y: r3(q(srt(tb.map((i) => Yb[i])), 0.5)),
    C: r3(q(srt(tb.map((i) => Cb[i])), 0.5)),
    cool: r2(q(srt(tb.filter((i) => !Db[i]).map((i) => Kb[i])), 0.5)),
    rows: TB,
  };

  /* ── the mask overlay ─────────────────────────────────────────────────── */
  let maskPng = null;
  if (wantMask) {
    const o = ctx.getImageData(0, 0, W, H);
    for (let i = 0; i < N; i++) {
      const j = i * 4;
      if (mask[i]) { o.data[j] = Math.min(255, o.data[j] * 0.4 + 150); o.data[j + 1] = o.data[j + 1] * 0.3; o.data[j + 2] = Math.min(255, o.data[j + 2] * 0.4 + 150); }
      else { const l = (o.data[j] + o.data[j + 1] + o.data[j + 2]) / 3 * 0.55; o.data[j] = l; o.data[j + 1] = l; o.data[j + 2] = l; }
    }
    ctx.putImageData(o, 0, 0);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgb(90,255,120)';
    for (const sc of scans) {
      ctx.beginPath();
      ctx.moveTo(sc.cx - sc.nx * IN_MAX, sc.cy - sc.ny * IN_MAX);
      ctx.lineTo(sc.cx + sc.nx * OUT_MAX, sc.cy + sc.ny * OUT_MAX);
      ctx.stroke();
    }
    const blob = await cv.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
    maskPng = btoa(bin);
  }

  return {
    W, H, rule, maskN, maskPct: +(maskN / N * 100).toFixed(2), degenerate,
    comps: comps.slice(0, 10).map((c) => ({ rank: c.rank, n: c.n, pct: +(c.n / N * 100).toFixed(2), box: c.box, why: c.why })),
    compsTotal: comps.length, kept: keep.size,
    med: medPx ? { hex: hex(medPx), Y: r3(medPx.Y), L: r3(medPx.L) } : null,
    C: { p50: r3(q(Cs, 0.5)), mean: r3(mean(Cs)) },
    S: { p50: r3(q(Ss, 0.5)) },
    Y: { p02: q(Ys, 0.02), p10: q(Ys, 0.10), p50: q(Ys, 0.50), p90: q(Ys, 0.90), p98: q(Ys, 0.98) },
    cool: { mean: r2(mean(cools)), p10: r2(q(cools, 0.10)), p50: r2(q(cools, 0.50)), p90: r2(q(cools, 0.90)) },
    meadow, meadowSrc,
    ks: ks.map((k) => ({ k: k.k, rms: +k.rms.toFixed(4), cen: k.cen.map(r3), share: k.share.map((s) => +s.toFixed(0)) })),
    best: best ? { k: best.km.k, masses: best.masses.map((m) => ({ Y: r3(m.Y), share: +m.share.toFixed(0) })) } : null,
    spanP1090: +spanP1090.toFixed(2), spanP0298: +spanP0298.toFixed(2),
    geom: { n: geomCoolS.length, filled, filledPct: +(filled / Math.max(1, maskN) * 100).toFixed(2), holesDropped, warmShare: +warmShare.toFixed(2), p10: r2(q(geomCoolS, 0.10)), Cp50: r3(q(srt(geomC), 0.5)) },
    silver: +silver.toFixed(1),
    scan: {
      n: reads.length, attempted: scans.length, edges: edges.length,
      bands: med(reads.map((r) => r.bands)), width: med(reads.map((r) => r.widthPx)),
      bandsP25: q(srt(reads.map((r) => r.bands)), 0.25), widthP25: q(srt(reads.map((r) => r.widthPx)), 0.25),
      bandHist: reads.reduce((a, r) => { a[r.bands] = (a[r.bands] || 0) + 1; return a; }, {}),
      damp: reads.filter((r) => r.damp).length ? {
        stops: r2(med(reads.filter((r) => r.damp).map((r) => r.damp.stops))),
        dry: r3(med(reads.filter((r) => r.damp).map((r) => r.damp.dry))),
        dryC: r3(med(reads.filter((r) => r.damp).map((r) => r.damp.dryC))),
        dCool: r2(med(reads.filter((r) => r.damp).map((r) => r.damp.cool - r.damp.dryCool))),
        Y: r3(med(reads.filter((r) => r.damp).map((r) => r.damp.Y))),
        C: r3(med(reads.filter((r) => r.damp).map((r) => r.damp.C))),
        cool: r2(med(reads.filter((r) => r.damp).map((r) => r.damp.cool))),
      } : null,
      lacePct: reads.length ? +(laced.length / reads.length * 100).toFixed(0) : NaN,
      laceLift: reads.length ? r2(Math.log2(Math.max(lacePeak, 1e-6) / Math.max(bodyMedY, 1e-6))) : NaN,
      lacePeak: r3(lacePeak),
      laceW: laced.length ? med(laced.map((r) => r.laceW)) : NaN,
      laceC: laced.length ? r3(med(laced.map((r) => r.lace.C))) : NaN,
      channelPx: +channelPx,
    },
    shelf, topBand, maskPng,
    hand: {
      curtain: curtain ? { ...curtain, ratio: ratio(curtain) } : null,
      plunge: plunge ? { ...plunge, ratio: ratio(plunge) } : null,
      sky: skyPatch, patches,
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reporting.
 * ──────────────────────────────────────────────────────────────────────────── */
const pad = (s, w) => String(s).padEnd(w);
const st = (y, m) => (m && y > 0 ? Math.log2(y / m) : NaN);
const sst = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) : '—');
const line = (n, name, verdict, measured, target) =>
  console.log(` ${String(n).padStart(2)} ${pad(name, 30)} ${pad(verdict, 5)}  ${pad(measured, 56)} [target ${target}]`);
const detail = (s) => console.log(`      ${s}`);
const PF = (b) => (b ? 'PASS' : 'FAIL');

function report(file, note, r) {
  const m = r.meadow;
  console.log('\n' + '═'.repeat(140));
  console.log(`${file}   ${r.W}×${r.H}   mask rule: ${r.rule}` + (note ? `   ${note}` : ''));
  console.log('═'.repeat(140));

  console.log('UNITS  Y  relative luminance, LINEAR (sRGB EOTF applied)        stops are log2(Y_a / Y_b)');
  console.log('       C  sRGB chroma, max−min, 0..1        ← every "C" below is this, never C/max');
  console.log('       S  saturation, C/max, 0..1           ← every "S" below is this, never max−min');
  console.log('       cool  (B−R)/Y in LINEAR light; signed, positive is blue, negative is mud');

  // The mask, unconditionally, before any number that depends on it.
  console.log(`\nMASK   ${r.maskN} px = ${r.maskPct}% of frame   (${r.kept} of ${r.compsTotal} components kept)`);
  for (const c of r.comps) {
    console.log(`       ${c.why ? 'drop' : 'KEEP'} #${c.rank}  ${String(c.n).padStart(8)} px  ${String(c.pct).padStart(6)}%  ` +
      `box ${c.box[0]},${c.box[1]}–${c.box[2]},${c.box[3]}` + (c.why ? `   (${c.why})` : ''));
  }
  if (r.comps.length < r.compsTotal) console.log(`       … ${r.compsTotal - r.comps.length} smaller components, all dropped`);
  if (r.maskPct < 0.5) {
    console.log(`       ⚠ THE MASK IS ALMOST EMPTY (${r.maskPct}%). Either this framing has no water, or the`);
    console.log(`         water has gone warm enough that the "${r.rule}" rule cannot see it — which is`);
    console.log(`         failure F1 and the reason §5 item 4 says not to test mud with a blue mask.`);
    console.log(`         Nothing below is trustworthy. Re-run with --box over the water.`);
  }
  console.log(`       check it: --dump-mask <path>   (magenta = mask, green = shoreline scan rays)`);

  if (m) console.log(`\nANCHOR gold meadow ${m.hex}  Y ${m.Y.toFixed(3)}  C ${m.C}  S ${m.S}  cool ${Number(m.cool).toFixed(2)}\n       ${r.meadowSrc}`);
  else console.log('\nANCHOR gold meadow — NOT FOUND; items 2 / 5 / 7 / 8 / 10 will SKIP. Pass --meadow.');

  console.log(`\nBODY   median ${r.med ? r.med.hex : '—'}  Y ${r.med ? r.med.Y : '—'}  L ${r.med ? r.med.L : '—'}  ` +
    `C ${r.C.p50}  S ${r.S.p50}  cool mean ${r.cool.mean.toFixed(2)}`);
  console.log(`       Y percentiles  p02 ${r.Y.p02.toFixed(4)}  p10 ${r.Y.p10.toFixed(4)}  p50 ${r.Y.p50.toFixed(4)}  ` +
    `p90 ${r.Y.p90.toFixed(4)}  p98 ${r.Y.p98.toFixed(4)}`);
  if (m) console.log(`       vs meadow      p02 ${sst(st(r.Y.p02, m.Y))}  p50 ${sst(st(r.Y.p50, m.Y))}  ` +
    `p98 ${sst(st(r.Y.p98, m.Y))} stops   span ${(st(r.Y.p98, m.Y) - st(r.Y.p02, m.Y)).toFixed(2)}   [§1.3]`);
  console.log(`       cool  mean ${r.cool.mean.toFixed(2)}  p10 ${r.cool.p10.toFixed(2)}  p50 ${r.cool.p50.toFixed(2)}  p90 ${r.cool.p90.toFixed(2)}  ` +
    `spread p90−p10 ${(r.cool.p90 - r.cool.p10).toFixed(2)}   [§1.4]`);
  if (r.degenerate) console.log(`       ${r.degenerate} px at Y ≈ 0 excluded from cool (0/0)`);

  console.log('\nCHECKLIST — docs/WATER_ART_SPEC.md §5');

  /* 1 */
  if (r.best) {
    const masses = r.best.masses;
    const seps = masses.slice(1).map((x, i) => Math.log2(x.Y / masses[i].Y));
    const top = Math.max(...masses.map((x) => x.share));
    const ok = masses.length >= 3 && r.spanP1090 >= 1.5 && top <= 60;
    line(1, 'value masses', PF(ok),
      `${masses.length} masses ≥0.5 st apart · span ${r.spanP1090.toFixed(2)} st · largest ${top}%`,
      '≥3 masses, ≥1.5 st p10→p90, none >60%');
    detail(`k-means on the mask's Y, seeded on quantiles; read at k=${r.best.k}, the k giving this frame the MOST masses:`);
    for (const kk of r.ks) detail(`  k=${kk.k}  rms ${kk.rms.toFixed(4)}  Y ${kk.cen.join(' · ')}  share ${kk.share.join('/')}%`);
    detail(`  masses after merging clusters <0.5 st apart and dropping <5% share: ` +
      `${masses.map((x) => `Y ${x.Y} (${x.share}%)`).join(' · ')}`);
    detail(`  separations ${seps.map((s) => s.toFixed(2)).join(' · ')} st · p02→p98 ${r.spanP0298.toFixed(2)} st [§2]`);
    if (r.rule === 'aerated') {
      detail(`  ⚠ the ≥1.5 st span is a blue-body target. §2 records P5's own aerated water at three masses 0.66 and 0.31 stops apart`);
      detail(`    and its curtain alone spanning 1.15 st p10→p90, so the reference plate does not meet it either. The mass COUNT and`);
      detail(`    the ≤60% share are still the live tests here — §2's point about our curtain is that it has two masses, not three.`);
    }
  } else line(1, 'value masses', 'SKIP', 'mask is empty', '≥3 masses, ≥1.5 st, none >60%');

  /* 2 */
  if (r.rule === 'aerated') {
    line(2, 'straddles the land', 'SKIP', 'aerated framing — this is a blue-body item', 'darkest ≤−1.0 st AND brightest ≥+0.5 st');
    detail(`§1.3 puts P5's water at −0.13 / +0.88 / +1.06 — "at and above" the meadow, by design, because §3.4's white water IS the`);
    detail(`light note. Measured here: p02 ${sst(st(r.Y.p02, m ? m.Y : NaN))} / p50 ${sst(st(r.Y.p50, m ? m.Y : NaN))} / p98 ${sst(st(r.Y.p98, m ? m.Y : NaN))} stops.`);
  } else if (m && r.best) {
    const lo = st(r.best.masses[0].Y, m.Y), hi = st(r.best.masses[r.best.masses.length - 1].Y, m.Y);
    line(2, 'straddles the land', PF(lo <= -1.0 && hi >= 0.5),
      `darkest ${sst(lo)} st · brightest ${sst(hi)} st vs meadow Y ${m.Y}`,
      'darkest ≤−1.0 st AND brightest ≥+0.5 st');
    detail(`P3: p02 −1.82 / p98 +1.20, lace peak +1.72. Anchor is ${r.meadowSrc.startsWith('auto') ? 'AUTO — §1.1 hand-places it; pass --meadow to reproduce a stated figure' : 'as given'}.`);
  } else line(2, 'straddles the land', 'SKIP', 'no meadow anchor', 'darkest ≤−1.0 st AND brightest ≥+0.5 st');

  /* 3 */
  if (r.rule === 'aerated') {
    line(3, 'cool in the body', 'SKIP', 'aerated framing — target is for blue water', 'mean ≥1.5, p90 ≥2.5, spread ≥1.5');
    detail(`aerated water in the plates runs cool 0.19 (P5 all) to 0.42 (P5 curtain) [§1.4]; measured here: mean ${r.cool.mean.toFixed(2)}, spread ${(r.cool.p90 - r.cool.p10).toFixed(2)}`);
  } else {
    const spread = r.cool.p90 - r.cool.p10;
    line(3, 'cool in the body', PF(r.cool.mean >= 1.5 && r.cool.p90 >= 2.5 && spread >= 1.5),
      `mean ${r.cool.mean.toFixed(2)} · p90 ${r.cool.p90.toFixed(2)} · spread ${spread.toFixed(2)}`,
      'mean ≥1.5, p90 ≥2.5, spread p90−p10 ≥1.5');
    detail(`P3 mean 1.55–2.56, spread 1.59–2.40 [§1.4]. A wCoolGovern floor moves the mean and cannot move the spread.`);
  }

  /* 4 */
  {
    const g = r.geom;
    // §4 F1's detector, verbatim: "any water pixel with cool < 0, or a water
    // mask whose p10 of cool is below +0.3 while C > 0.10". The p10 form is the
    // one that survives contact with a real frame — a rock in the river is a
    // filled hole and contributes genuinely warm pixels without the water being
    // mud — so the share is reported but the verdict rests on p10, with the
    // share allowed up to P5's own 1.9%.
    // §4 F1 has TWO clauses and both are needed. The p10 clause alone passes
    // hero.png's lakes — 87% of them are cool < 0 but their C is 0.075, under
    // the clause's own 0.10 gate — and hero is the frame §4 F1 names as live.
    // The "any water pixel with cool < 0" clause is quantified at 1.9%, which is
    // what P5 measures at its rock edges and the most the plates ever show.
    const ok = g.warmShare <= 1.9 && !(g.p10 < 0.3 && g.Cp50 > 0.10);
    line(4, 'no water warmer than neutral', PF(ok),
      `${g.warmShare}% of the mask is cool < 0 · p10 ${g.p10.toFixed(2)} at C ${g.Cp50}`,
      'F1: ≤1.9% warm AND not (p10 < +0.3 while C > 0.10)');
    detail(`§0 forbids testing this with the blue mask, which excludes warm pixels by construction, so this runs on the`);
    detail(`GEOMETRIC mask: the colour mask, holes under 0.5% of its area filled, then eroded ${OPT.erode}px. ${g.filled} px (${g.filledPct}% of`);
    detail(`the mask) came from filled holes and ${g.holesDropped} px of larger holes were left out as objects. A leaf or a ripple`);
    detail(`inside the water is a filled hole and can be genuinely warm, so the raw share is context; the verdict is §4 F1's own`);
    detail(`clause, which is the p10 test — P3 measures p10 +0.48 at C 0.23 and passes, hero.png's lakes sit at cool −0.03.`);
    if (r.maskPct < 0.5) detail(`⚠ the colour mask is ${r.maskPct}% of frame, so the geometric mask is derived from nearly nothing. This number means nothing here.`);
  }

  /* 5 */
  if (r.rule === 'aerated') {
    line(5, 'no silver sheet', 'SKIP', `aerated framing — ${r.silver}% would be counted`, '<15%');
    detail(`F3 is a blue-water failure. Aerated water is near-neutral and above the meadow by definition, so this test counts the`);
    detail(`whitewater itself; P5 measures ${r.silver}% and is not a silver sheet. Run item 5 on a framing masked with --rule blue.`);
  } else if (m) {
    line(5, 'no silver sheet', PF(r.silver < 15),
      `${r.silver}% of the mask is C < 0.09 AND above meadow Y ${m.Y}`,
      '<15%');
    detail(`hero.png measured 100% in §4 F3 — C 0.054–0.075 at +1.05 st over the land, which is why it reads as bare rock.`);
  } else line(5, 'no silver sheet', 'SKIP', 'no meadow anchor', '<15%');

  /* 6 */
  if (r.rule === 'aerated' && r.scan.n >= 3) {
    line(6, 'shoreline band count', 'SKIP', `${r.scan.bandsP25} bands over ${r.scan.widthP25} px (weakest quarter of ${r.scan.n})`, '≥4 bands, ≥60 px — a P3 target');
    detail(`§5 item 6's target is measured on P3. §3.4's two P5 scans are meadow → one margin ~30–35 px → whitewater, i.e. two bands`);
    detail(`over ~30 px, so the plate itself does not meet it. Judging a white-water shoreline against a blue-water target is the`);
    detail(`error §3.5 and the water_lake.js wet-margin comment already made once; the number is printed instead of ruled on.`);
  } else if (r.scan.n >= 3) {
    line(6, 'shoreline band count', PF(r.scan.bandsP25 >= 4 && r.scan.widthP25 >= 60),
      `${r.scan.bandsP25} bands over ${r.scan.widthP25} px on the weakest quarter of ${r.scan.n} scans`,
      '≥4 bands, transition ≥60 px');
    detail(`median over all scans: ${r.scan.bands} bands over ${r.scan.width} px. The verdict is read off the WEAKEST QUARTILE, not the`);
    detail(`median, because F5 is a local failure — one bank that steps straight from ground to full-depth water reads as a cut-out`);
    detail(`however well the opposite bank is drawn, and §3.3 records P3 itself drawing its two banks very differently.`);
    detail(`perpendicular 5×5 scans every ${OPT.scanStep} px along the mask edge normal, ≥30 px apart. A band ends where a sample leaves`);
    detail(`±0.30 st of Y, ±0.075 of C or ±0.55 of cool from its band's running mean; runs under two samples are merged away. The`);
    detail(`transition runs from settled water to settled MEADOW, so item 6 and item 7 both move with the --meadow anchor.`);
    detail(`band histogram ${JSON.stringify(r.scan.bandHist)} · P3 §3.1 hand-counts 7 bands, river.png §3.6 hand-counts 3.`);
  } else line(6, 'shoreline band count', 'SKIP', `only ${r.scan.n} usable scans`, '≥4 bands, transition ≥60 px');

  /* 7 */
  if (r.scan.damp) {
    const d = r.scan.damp;
    const blue = r.rule === 'blue';
    const ok = blue ? (d.stops <= -0.8 && d.stops >= -1.9 && d.C >= 0.18)
                    : (d.stops >= -0.25 && d.C < 0.10);
    line(7, 'damp band polarity', PF(ok),
      `${sst(d.stops)} st · C ${d.C}   (cool ${d.cool.toFixed(2)}, ${sst(d.dCool)} vs its own dry ground — reported, not gated)`,
      blue ? '−0.8…−1.9 st, C ≥0.18' : 'Y flat or up, C <0.10');
    detail(`§3.5: against BLUE water the band goes dark and KEEPS the meadow's hue; against WHITE water it goes pale and loses its`);
    detail(`chroma. Taken as the mean of the three darkest land-side samples in the transition, median over ${r.scan.n} scans, measured`);
    detail(`in stops against the settled dry ground each ray found (Y ${r.scan.damp.dry}) — which is what §3.5's figure is relative to.`);
    detail(`§5's third clause, "cool ≤ −0.9", is REPORTED AND NOT GATED, and that is deliberate. The plate's own banks disagree with`);
    detail(`each other: §3.1's damp band sits at cool −1.15…−1.40 beside dry ground at −1.32 (a shift of −0.08), §3.3's at −1.1…−1.3`);
    detail(`beside sunlit gold at −2.10 (a shift of +0.9). Medianed over every bank in the frame P3 reads cool −0.85 and would fail its`);
    detail(`own checklist, while river.png reads −1.03 and would pass it — the criterion inverts. C does not: P3 0.217, river.png 0.142,`);
    detail(`mouth.png 0.060, which is exactly §3.5's point that the band must KEEP the meadow's hue. Dry ground here: Y ${d.dry} C ${d.dryC}.`);
  } else line(7, 'damp band polarity', 'SKIP', 'no usable shoreline scans', 'see §3.5');

  /* 8 */
  if (r.rule === 'aerated' && r.scan.n >= 3) {
    line(8, 'lace present/bright/narrow/broken', 'SKIP', `aerated framing — ${r.scan.lacePct}% of scans, peak Y ${r.scan.lacePeak}`, 'on 10–85% of banks, peak Y ≥0.40, ≥1.5 st over the body');
    detail(`§3.5: against white water "there is no separate lace, because the whitewater is the light note". What this measures on an`);
    detail(`aerated framing is the whitewater itself, which is why the number is printed rather than ruled on.`);
  } else if (r.scan.n >= 3 && m) {
    const s = r.scan;
    const pct = s.lacePct;
    const ok = pct >= 10 && pct <= 85 && s.lacePeak >= 0.40;
    line(8, 'lace present/bright/narrow/broken', PF(ok),
      `on ${pct}% of scans · peak Y ${s.lacePeak}, ${sst(s.laceLift)} st over the body · width ${Number.isFinite(s.laceW) ? s.laceW + ' px' : '—'} (NOT judged)`,
      'on 10–85% of banks, peak Y ≥0.40, ≥1.5 st over the body');
    detail(`lace = brightest 5×5 sample within 60 px of the waterline at C ≤0.30 and cool ≥−0.6, qualifying at Y ≥0.40, C 0.07–0.30 and ≥1.5 st over the body median ` +
      (Number.isFinite(s.laceC) ? `(measured C ${s.laceC})` : '(none qualified)') + '.');
    detail(`⚠ WIDTH IS REPORTED, NOT JUDGED — this half of item 8 is a SKIP. The "≤0.5 m" form needs §0's px/m fit, which is anchored`);
    detail(`   on P3's own jeep and bear at a known image height and does not transfer. The "≤8% of channel width" form needs a`);
    detail(`   channel width, and the only one available from a flat PNG is the median mask run per row (${s.channelPx} px here), which for an`);
    detail(`   open lake is the lake and not a channel at all. On P3 that denominator fails the plate's own lace at 40/339 = 11.8%.`);
    detail(`   The verdict above therefore rests on presence, brightness and brokenness only. Judge width by eye from --dump-mask.`);
    detail(`P3 peaks at Y 0.616, 0.3–0.4 m wide, broken, and absent entirely from its far bank [§3.3, §4 F6].`);
  } else line(8, 'lace present/bright/narrow/broken', 'SKIP', r.scan.n < 3 ? `only ${r.scan.n} usable scans` : 'no meadow anchor', 'see §5 item 8');

  /* 9 */
  if (r.hand.curtain && r.hand.plunge) {
    const c = r.hand.curtain, p = r.hand.plunge;
    const drop = Math.log2(c.Y / p.Y);
    const ok = drop <= -0.15 && c.C >= 0.10 && p.C <= 0.09;
    line(9, 'foam: curtain ≠ plunge', PF(ok),
      `curtain ${c.ratio} C ${c.C} · plunge ${p.ratio} C ${p.C} · curtain ${sst(drop)} st`,
      'curtain 1:1.12:1.21 C 0.15, 0.3 st darker; plunge 1:1.02:1.06 C 0.05');
    detail(`curtain ${c.hex} Y ${c.Y} cool ${c.cool} · plunge ${p.hex} Y ${p.Y} cool ${p.cool}`);
    detail(`§4 F4: ours separate them by 0.00 on every axis. The appendix also corrects wFoamLight — the plate's plunge is`);
    detail(`1:1.01:1.03 masked / 1:1.03:1.06 at the core, faintly cool, not the "1:0.99:1.00, effectively neutral" it was tuned to.`);
    detail(`⚠ B/R and C are stable against where the boxes land; the "0.3 stops darker" clause is NOT. §1.2 reads P5's curtain at`);
    detail(`Y 0.571 and its plunge at 0.715; a curtain box on the bright upper sheet and a plunge box off the bright core reverse`);
    detail(`the sign. Put the boxes on the same parts §1.2 sampled, or read the two hexes above and judge the drop yourself.`);
  } else {
    line(9, 'foam: curtain ≠ plunge', 'SKIP', 'needs --curtain x,y,w,h and --plunge x,y,w,h', 'curtain 1:1.12:1.21 vs plunge 1:1.02:1.06');
    detail(`NOT automated on purpose. Splitting a falling curtain from its plunge basin needs geometry a flat PNG does not carry;`);
    detail(`every colour rule that separates them is a rule fitted to one framing, and a fitted PASS here is worse than no number.`);
  }

  /* 10 */
  if (r.rule === 'aerated') {
    line(10, 'a shallow shelf mass exists', 'SKIP', 'aerated framing — this is a blue-body item', 'C 0.19±0.06, S ≤0.42, cool 1.1±0.5, −0.5 st');
    detail(`the shelf signature is a blue shallow, and P5 carries no blue water to look for it in.`);
  } else if (r.shelf && m) {
    const hit = r.shelf.find((x) => x.ok);
    const cyan = r.shelf.find((x) => x.cyan);
    line(10, 'a shallow shelf mass exists', PF(!!hit && !cyan),
      hit ? `mass Y ${hit.Y} C ${hit.C} S ${hit.S} cool ${hit.cool} ${sst(hit.stops)} st, ${hit.bankPct}% bank-adjacent`
          : (cyan ? 'no shelf; a CYAN mass is present (F2)' : 'no mass with the shelf signature'),
      'C 0.19±0.06, S ≤0.42, cool 1.1±0.5, −0.2…−0.9 st, ≥40% within 60px of a bank');
    for (const x of r.shelf) detail(`  mass Y ${x.Y} (${x.share}%)  C ${x.C}  S ${x.S}  cool ${x.cool}  ${sst(x.stops)} st  bank-adjacent ${x.bankPct}%` +
      (x.ok ? '   ← shelf' : '') + (x.cyan ? '   ← CYAN, F2' : ''));
    detail(`P3's shelf is #536684, C 0.194, S 0.374, cool 1.12, 0.53 st BELOW the meadow [§1.2]. The ± above is this tool's, not the`);
    detail(`spec's: a k-means mass is a half-stop band of water, not a hand-picked patch. F2 guard is §4's full form — S >0.42 AND`);
    detail(`cool >2.5 AND at or above the meadow; without that last clause P3's own deep body is reported as swimming-pool cyan.`);
    detail(`⚠ colour signature + bank adjacency only. It cannot tell a shelf from a bank-hugging band of the same colour.`);
  } else line(10, 'a shallow shelf mass exists', 'SKIP', 'no meadow anchor or no masses', 'C 0.19±0.06, S ≤0.42, cool 1.1±0.5, −0.5 st');

  /* 11 */
  if (r.hand.sky) {
    const s = r.hand.sky;
    const ok = s.cool <= -0.29 && s.cool >= -0.60;
    line(11, 'sky illuminant (item 11, part)', PF(ok), `sky ${s.hex} Y ${s.Y} C ${s.C} cool ${s.cool}`, 'plate skies cool −0.29…−0.48');
  } else {
    line(11, 'sky illuminant (item 11, part)', 'SKIP', `top ${r.topBand.rows} rows: ${r.topBand.hex} Y ${r.topBand.Y} C ${r.topBand.C} cool ${r.topBand.cool}`, 'plate skies cool −0.29…−0.48');
    detail(`the top-of-frame band is printed for reference but NOT judged: this tool cannot tell sky from a distant cliff, and`);
    detail(`mouth.png's top band is rock that measures perfectly sky-like. Pass --sky x,y,w,h to turn this into a verdict.`);
  }
  detail(`item 11's other half — "distant water at 300 m+" — is SKIP: a flat PNG carries no depth, so the 300 m cut cannot be made.`);
  detail(`§1.1 records waterfall.png's sky at cool +0.37 where every plate sky is −0.29 to −0.48; it is the source term for the`);
  detail(`sheen floor and the environment reflection, so no water dial in that frame can be judged without it.`);

  if (r.hand.patches.length) {
    console.log('\nPATCHES (hand-placed, raw)');
    for (const p of r.hand.patches) console.log(`       ${p.box.join(',')}  ${p.hex}  Y ${p.Y}  C ${p.C}  S ${p.S}  cool ${p.cool}  (${p.n} px)`);
  }
}

/* ── run ─────────────────────────────────────────────────────────────────── */
await acquire('waterstats');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const dumpTo = arg('dump-mask');

for (const j of jobs) {
  const ext = j.file.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  const b64 = readFileSync(j.file).toString('base64');
  const r = await page.evaluate(analyse, { b64, ext, rule: j.rule, opt: OPT, wantMask: !!dumpTo });
  report(j.file, j.note, r);
  if (dumpTo && r.maskPng) {
    const out = jobs.length > 1
      ? resolve(dirname(dumpTo), `${basename(dumpTo).replace(/\.png$/, '')}-${basename(j.file).replace(/\.\w+$/, '')}.png`)
      : resolve(dumpTo);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(r.maskPng, 'base64'));
    console.log(`\n       mask written to ${out}`);
  }
}
await browser.close();
