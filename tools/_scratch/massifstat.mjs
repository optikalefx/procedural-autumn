#!/usr/bin/env node
/**
 * Massif statistics over a MASK, not over a rect drawn by eye.
 *
 *   node tools/_scratch/massifstat.mjs --paint shots/terr/d-waterfall-paint.png \
 *        --region 0.25,0.10,0.30,0.45 \
 *        shots/terr/d-waterfall-base.png base
 *
 *   node tools/_scratch/massifstat.mjs --rect 0.10,0.30,0.16,0.30 \
 *        "reference-art/Zight 2026-08-18 at 10.30.57 AM.jpg" plate5rock
 *
 * `--paint` is a uDebugMask=11 frame: terrain rock drawn red, terrain non-rock
 * green, everything else in the scene untouched. Pixels whose red dominates by
 * `--margin` (default 0.10 of range) are the terrain rock mask. It is computed
 * ONCE and applied to every frame in the sweep, so every variant is measured
 * over an identical pixel set — a per-frame mask moves under the dial being
 * measured, which is how the rocks author's --diff mask swung 18.5% -> 21.9%
 * across one sweep.
 *
 * Three of the last four reference targets on this project were wrong because
 * they sampled the wrong pixels (pass 4 judged an eye-level view against a
 * vista plate; pass 5's "conifers are red-led" came from patches containing
 * gold grass; pass 6's "plate 5 rock" was gold grass beside a boulder). So this
 * prints WHAT IS IN THE MASK as well as the statistics over it.
 *
 * Beyond colorstats' tone metrics it reports three structure numbers, because
 * "the massif is grey" is not a defect — grey is what the plates show — and
 * "the massif is a wash" is:
 *
 *   contrastStd  luma std over the mask, at the SAME 480-wide downsample
 *                colorstats uses, so the number is comparable to the archive.
 *   stdCoarse    luma std after box-averaging to 1/12 scale. This is value
 *                structure at MASSIF scale — the "a face is a few distinct
 *                values" quantity. Grain, jointing and weathering do not enter
 *                it; a wash scores near zero however noisy it is.
 *   edgeShare    share of the TOTAL coarse gradient carried by the steepest
 *                tenth of blocks. This is the number that separates a wash
 *                from flat masses, and no amount of contrast can fake it: a
 *                linear ramp spends its gradient evenly and scores 10 by
 *                construction, however steep it is, while a face painted as
 *                three plateaus with definite boundaries spends nearly all of
 *                it on the boundaries and scores high. "Broad flat masses of
 *                saturated colour separated by soft edges" (DESIGN_BRIEF) is
 *                a statement about this quantity and not about contrastStd.
 *   flatPct      share of blocks whose gradient is under a third of the mean,
 *                i.e. how much of the face is genuinely FLAT interior.
 *   zoneSpread   p95-p05 of the coarse field: how much value a face spends
 *                across its whole area, ignoring grain.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const PAINT = arg('paint');
const REGION = arg('region') ? arg('region').split(',').map(Number) : null;
const RECT = arg('rect') ? arg('rect').split(',').map(Number) : null;
const MARGIN = Number(arg('margin', '0.10'));
// `green` masks terrain NON-rock instead, `all` masks every terrain pixel.
const WHICH = arg('which', 'red');
const CHAN = argv.includes('--channels');

const flagged = new Set(['paint', 'region', 'rect', 'margin', 'which']);
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { if (flagged.has(argv[i].slice(2))) i++; continue; }
  rest.push(argv[i]);
}
const frames = [];
for (let i = 0; i < rest.length; i += 2) frames.push({ file: rest[i], label: rest[i + 1] || rest[i] });
if (!frames.length) { console.error('usage: massifstat.mjs [--paint p.png] [--region x,y,w,h] <image> <label> …'); process.exit(1); }

await acquire('massifstat');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
await page.evaluate(() => { window.__st = {}; });

const put = async (key, f) => {
  const ext = f.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  await page.evaluate(async ({ key, b64, ext }) => {
    const img = new Image();
    img.src = `data:image/${ext};base64,${b64}`;
    await img.decode();
    // One common working resolution for every frame, so a mask taken off the
    // paint frame indexes the same ground in a plate of a different size.
    const W = 480, H = Math.max(1, Math.round((img.height / img.width) * W));
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, W, H);
    window.__st[key] = { w: W, h: H, d: g.getImageData(0, 0, W, H).data };
  }, { key, b64: readFileSync(f).toString('base64'), ext });
};

if (PAINT) await put('__paint', PAINT);
for (const f of frames) await put(f.label, f.file);

const out = await page.evaluate(({ labels, hasPaint, REGION, RECT, MARGIN, WHICH, CHAN }) => {
  const any = window.__st[labels[0]];
  const { w, h } = any;
  const inRect = (x, y, r) => !r || (x >= r[0] * w && x < (r[0] + r[2]) * w
    && y >= r[1] * h && y < (r[1] + r[3]) * h);

  // ── the mask ──────────────────────────────────────────────────────────────
  const mask = new Uint8Array(w * h);
  let nMask = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!inRect(x, y, REGION) || !inRect(x, y, RECT)) continue;
    if (!hasPaint) { mask[i] = 1; nMask++; continue; }
    const p = window.__st.__paint.d;
    const r = p[i * 4] / 255, g = p[i * 4 + 1] / 255, b = p[i * 4 + 2] / 255;
    // Hue dominance, not an absolute threshold: haze and the grade wash the
    // paint out badly at 2 km, and an absolute cut silently drops every far
    // massif from the mask — which would reproduce the exact class of error
    // this tool exists to avoid.
    const red = r - Math.max(g, b) > MARGIN;
    const grn = g - Math.max(r, b) > MARGIN;
    const hit = WHICH === 'red' ? red : WHICH === 'green' ? grn : (red || grn);
    if (hit) { mask[i] = 1; nMask++; }
  }

  const CO = 12;                       // coarse block size, in working pixels
  const cw = Math.ceil(w / CO), ch = Math.ceil(h / CO);

  const stats = (key) => {
    const d = window.__st[key].d;
    const lum = new Float32Array(w * h);
    let sum = 0, chSum = 0, neutral = 0, vivid = 0, n = 0;
    const rgb = [0, 0, 0];
    const ls = [];
    for (let i = 0; i < w * h; i++) {
      if (!mask[i]) continue;
      const R = d[i * 4] / 255, G = d[i * 4 + 1] / 255, B = d[i * 4 + 2] / 255;
      const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      lum[i] = L; ls.push(L); sum += L; n++;
      const c = Math.max(R, G, B) - Math.min(R, G, B);
      chSum += c; if (c < 0.06) neutral++; if (c > 0.35) vivid++;
      rgb[0] += R; rgb[1] += G; rgb[2] += B;
    }
    if (!n) return null;
    const mean = sum / n;
    let varr = 0;
    for (let i = 0; i < w * h; i++) if (mask[i]) varr += (lum[i] - mean) ** 2;
    varr /= n;
    ls.sort((a, b) => a - b);
    const pct = (q) => ls[Math.min(ls.length - 1, Math.floor(q * ls.length))];

    // ── coarse field: value structure at massif scale ───────────────────────
    // Box-average the masked luma into 12x12 blocks. A block is kept only if
    // it is at least a third mask, so the mask edge does not manufacture
    // structure that is really the silhouette against the sky.
    const cSum = new Float64Array(cw * ch), cN = new Float64Array(cw * ch);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!mask[i]) continue;
      const ci = Math.floor(y / CO) * cw + Math.floor(x / CO);
      cSum[ci] += lum[i]; cN[ci]++;
    }
    const cVal = new Float32Array(cw * ch).fill(NaN);
    for (let ci = 0; ci < cw * ch; ci++) if (cN[ci] >= CO * CO / 3) cVal[ci] = cSum[ci] / cN[ci];
    const cs = [];
    for (let ci = 0; ci < cw * ch; ci++) if (!Number.isNaN(cVal[ci])) cs.push(cVal[ci]);
    let stdCoarse = 0, edgeShare = 0, flatPct = 0, spread = 0;
    if (cs.length > 4) {
      const cm = cs.reduce((a, b) => a + b, 0) / cs.length;
      stdCoarse = Math.sqrt(cs.reduce((a, b) => a + (b - cm) ** 2, 0) / cs.length);
      const sorted = [...cs].sort((a, b) => a - b);
      spread = sorted[Math.floor(0.95 * sorted.length)] - sorted[Math.floor(0.05 * sorted.length)];
      // Gradient magnitude per coarse block, central-difference where both
      // neighbours are in the mask. Blocks with no in-mask neighbour are
      // skipped rather than scored zero: the silhouette against the sky is not
      // a plane break, and counting it would credit the massif for its own
      // outline.
      const grads = [];
      for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
        const ci = cy * cw + cx; if (Number.isNaN(cVal[ci])) continue;
        let gx = 0, gz = 0, ok = false;
        const at = (x, y) => (x < 0 || y < 0 || x >= cw || y >= ch) ? NaN : cVal[y * cw + x];
        const l = at(cx - 1, cy), r2 = at(cx + 1, cy), u = at(cx, cy - 1), dn = at(cx, cy + 1);
        if (!Number.isNaN(l) && !Number.isNaN(r2)) { gx = (r2 - l) / 2; ok = true; }
        if (!Number.isNaN(u) && !Number.isNaN(dn)) { gz = (dn - u) / 2; ok = true; }
        if (ok) grads.push(Math.hypot(gx, gz));
      }
      if (grads.length > 8) {
        const tot = grads.reduce((a, b) => a + b, 0);
        const gm = tot / grads.length;
        const gs = [...grads].sort((a, b) => b - a);
        const k = Math.max(1, Math.round(grads.length * 0.10));
        edgeShare = tot > 0 ? 100 * gs.slice(0, k).reduce((a, b) => a + b, 0) / tot : 0;
        flatPct = 100 * grads.filter((g) => g < gm / 3).length / grads.length;
      }
    }
    return {
      srgb: rgb.map((v) => Math.round(255 * v / n)),
      ratio: [1, +(rgb[1] / rgb[0]).toFixed(3), +(rgb[2] / rgb[0]).toFixed(3)],
      lumaMean: +mean.toFixed(3), lumaP05: +pct(0.05).toFixed(3), lumaP95: +pct(0.95).toFixed(3),
      lumaRange: +(pct(0.95) - pct(0.05)).toFixed(3),
      contrastStd: +Math.sqrt(varr).toFixed(4),
      chromaMean: +(chSum / n).toFixed(3),
      neutralPct: +(100 * neutral / n).toFixed(1), vividPct: +(100 * vivid / n).toFixed(1),
      stdCoarse: +stdCoarse.toFixed(4), edgeShare: +edgeShare.toFixed(1),
      flatPct: +flatPct.toFixed(1),
      zoneSpread: +spread.toFixed(3), coarseBlocks: cs.length,
    };
  };

  // Raw per-channel percentiles, for reading a debug mask numerically: the
  // strata read-out puts valueZones in green, and "how many zones are on this
  // face" is a question about that channel's histogram, not about luma.
  const chan = (key) => {
    const d = window.__st[key].d;
    const out = {};
    for (const [ci, nm] of [[0, 'R'], [1, 'G'], [2, 'B']]) {
      const v = [];
      for (let i = 0; i < w * h; i++) if (mask[i]) v.push(d[i * 4 + ci] / 255);
      v.sort((a, b) => a - b);
      const q = (p) => +v[Math.min(v.length - 1, Math.floor(p * v.length))].toFixed(3);
      // 24-bin histogram, printed as the share in each bin, so a field that
      // resolves as three plateaus is visibly three spikes.
      const hist = new Array(24).fill(0);
      for (const x of v) hist[Math.min(23, Math.floor(x * 24))]++;
      out[nm] = { p05: q(0.05), p50: q(0.50), p95: q(0.95),
        spread: +(q(0.95) - q(0.05)).toFixed(3),
        hist: hist.map((c) => Math.round(100 * c / v.length)) };
    }
    return out;
  };

  return {
    w, h, maskPct: +(100 * nMask / (w * h)).toFixed(2), nMask,
    rows: labels.map((k) => [k, stats(k)]),
    chans: CHAN ? labels.map((k) => [k, chan(k)]) : null,
  };
}, { labels: frames.map((f) => f.label), hasPaint: !!PAINT, REGION, RECT, MARGIN, WHICH, CHAN });

console.log(`mask: ${out.maskPct}% of frame (${out.nMask} px at ${out.w}x${out.h})`
  + `${PAINT ? `  paint=${PAINT} which=${WHICH}` : '  (no paint mask — rect only)'}`
  + `${REGION ? `  region=${REGION.join(',')}` : ''}${RECT ? `  rect=${RECT.join(',')}` : ''}`);
const cols = ['lumaMean', 'lumaP05', 'lumaP95', 'lumaRange', 'contrastStd', 'stdCoarse',
  'edgeShare', 'flatPct', 'zoneSpread', 'chromaMean', 'neutralPct', 'vividPct'];
const pad = Math.max(...frames.map((f) => f.label.length), 5);
console.log('label'.padEnd(pad) + '  ' + cols.map((c) => c.padStart(11)).join('') + '   srgb / ratio');
for (const [k, s] of out.rows) {
  if (!s) { console.log(`${k.padEnd(pad)}  (mask empty)`); continue; }
  console.log(k.padEnd(pad) + '  ' + cols.map((c) => String(s[c]).padStart(11)).join('')
    + `   (${s.srgb}) ${s.ratio.join(':')}`);
}
if (out.chans) for (const [k, c] of out.chans) {
  console.log(`\n${k} — raw channels over the mask:`);
  for (const nm of ['R', 'G', 'B'])
    console.log(`  ${nm}  p05 ${c[nm].p05}  p50 ${c[nm].p50}  p95 ${c[nm].p95}  spread ${c[nm].spread}`
      + `\n     hist ${c[nm].hist.map((v) => String(v).padStart(3)).join('')}`);
}
await browser.close();
