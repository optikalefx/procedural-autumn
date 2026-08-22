#!/usr/bin/env node
/**
 * River plan form — the view no other instrument in this harness could take.
 *
 *   node tools/riverplan.mjs --out shots/plan.png
 *   node tools/riverplan.mjs --out shots/plan.png --gate
 *
 * Every canonical framing in `tools/shot.mjs` is eye-level or an oblique
 * vista. Not one of them looks *down* at a river, so nothing a critic was ever
 * shown could answer the question "what shape is this river in plan". That gap
 * cost a whole round: the water was judged on colour, value structure and
 * shoreline — all of which measurably improved — while every trunk in the map
 * ran as a near-straight diagonal, which is the first thing a player sees from
 * a hillside and the first thing they reject. A user looking at the running
 * build caught it before any of the instruments here did.
 *
 * So this reports the one number that names the defect, and renders the frame
 * that shows it.
 *
 * SINUOSITY is channel length divided by straight-line distance between the
 * ends. It is the standard geomorphological measure and it has published
 * thresholds, which is what makes it usable as a gate rather than an opinion:
 *
 *     <= 1.05   straight
 *     1.05-1.5  sinuous
 *     >= 1.5    meandering
 *
 * Lowland meandering rivers run 1.4-3.0. Braided mountain reaches sit lower,
 * so a map with real relief should show a *spread* — steep headwaters near
 * 1.1, valley-floor trunks well above 1.4 — and a median that lands in the
 * sinuous band or better.
 *
 * The failure mode this is built to catch is specific and counter-intuitive:
 * when the median is low AND the longest trunks are the *straightest*, the
 * cause is a smoothing pass collapsing each path toward the chord between its
 * endpoints, because the more stations you smooth the closer you get to that
 * straight line. Trunk sinuosity below the median is therefore reported
 * separately and is its own gate line — an average alone hides it, since a
 * hundred short steep headwaters will drag the median up while the six rivers
 * that actually fill the frame run dead straight.
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const OUT = arg('out', 'shots/riverplan.png');
const URL = arg('url', (process.env.AUTUMN_URL || 'http://localhost:5178'));
const SIZE = parseInt(arg('size', '1400'), 10);
// Reaches shorter than this are headwater fragments; their sinuosity is noise
// and there are hundreds of them, so they would dominate any statistic.
const MIN_SPAN = parseInt(arg('min-span', '120'), 10);   // metres, end to end
// Gate thresholds. Deliberately below the 1.5 "meandering" line: this is a
// mountain valley, not a floodplain, and demanding 1.5 of an alpine headwater
// would be asking the terrain to lie.
const WANT_MEDIAN = parseFloat(arg('want-median', '1.35'));
const WANT_TRUNK = parseFloat(arg('want-trunk', '1.30'));

await acquire('riverplan');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
page.on('pageerror', (e) => console.error('ERR', e.message));

// Same HMR stub every other instrument here uses: a peer saving a file mid-run
// reloads the page and kills the evaluate with "Execution context destroyed".
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return {
        readyState: 3, url, close() {}, send() {},
        addEventListener() {}, removeEventListener() {},
        set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {},
      };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

const result = await page.evaluate(async ({ SIZE, MIN_SPAN }) => {
  const W = window.__world;
  const polys = W.riverPolylines ?? [];
  const R = W.res, half = W.half, size = half * 2;

  // ── measure ───────────────────────────────────────────────────────────────
  const rows = [];
  for (const p of polys) {
    if (!p || p.length < 8) continue;
    let len = 0, maxW = 0;
    for (let i = 1; i < p.length; i++) {
      len += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
      if ((p[i].w ?? 0) > maxW) maxW = p[i].w;
    }
    const span = Math.hypot(p[p.length - 1].x - p[0].x, p[p.length - 1].z - p[0].z);
    if (span < MIN_SPAN) continue;
    rows.push({ len, span, w: maxW, sin: len / span });
  }
  rows.sort((a, b) => b.len - a.len);

  const q = (vals, f) => {
    if (!vals.length) return 0;
    const s = vals.slice().sort((a, b) => a - b);
    return s[Math.max(0, Math.min(s.length - 1, Math.round(f * (s.length - 1))))];
  };
  const sins = rows.map((r) => r.sin);
  // "Trunk" means the reaches that actually occupy the frame. Ten is enough to
  // be stable and few enough that every one of them is a river a player sees.
  const trunks = rows.slice(0, 10);

  // ── render ────────────────────────────────────────────────────────────────
  const c = new OffscreenCanvas(SIZE, SIZE);
  const g = c.getContext('2d');
  const img = g.createImageData(SIZE, SIZE);
  const d = img.data;
  const h = W.height, wat = W.water;

  // A muted hillshade, deliberately low-contrast and near-neutral: this frame
  // exists so the blue lines on top of it are the only thing with any chroma,
  // and a pretty terrain render would compete with the thing being judged.
  const lx = -0.55, ly = 0.62, lz = -0.55;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const gx = Math.min(R - 2, Math.max(1, Math.floor((x / SIZE) * R)));
      const gy = Math.min(R - 2, Math.max(1, Math.floor((y / SIZE) * R)));
      const i = gy * R + gx;
      const dzdx = (h[i + 1] - h[i - 1]) * 0.5;
      const dzdy = (h[i + R] - h[i - R]) * 0.5;
      const nl = Math.hypot(dzdx, 1, dzdy);
      let l = Math.max(0, (-dzdx / nl) * lx + (1 / nl) * ly + (-dzdy / nl) * lz);
      l = 0.34 + 0.66 * Math.pow(l, 0.8);
      let v = Math.round(58 + l * 120);
      let r = v, gg = v, b = Math.round(v * 1.04);
      // Standing water as a flat dark mass — it is context for where a channel
      // has to arrive, and the arrival is half of what this frame is for.
      if (wat && wat[i] > -9000 && wat[i] - h[i] > 0.35) { r = 30; gg = 44; b = 72; }
      const o = (y * SIZE + x) * 4;
      d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  // Centrelines, width scaled by the channel's own width so the trunk network
  // reads apart from the headwater fuzz. Straightness is only legible against
  // a hierarchy — every line at one weight looks like a circuit diagram.
  const toPx = (v) => ((v + half) / size) * SIZE;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const p of polys) {
    if (!p || p.length < 4) continue;
    let maxW = 0;
    for (const s of p) if ((s.w ?? 0) > maxW) maxW = s.w;
    g.strokeStyle = maxW > 5 ? '#7fd4ff' : '#4a86b8';
    g.lineWidth = Math.max(0.7, (maxW / size) * SIZE * 1.6);
    g.beginPath();
    g.moveTo(toPx(p[0].x), toPx(p[0].z));
    for (let i = 1; i < p.length; i++) g.lineTo(toPx(p[i].x), toPx(p[i].z));
    g.stroke();
  }

  // The straight-line chord of each trunk, dashed, over the trunk itself. This
  // is the whole argument in one mark: where the channel hugs its own chord it
  // is a canal, and you can see that without reading a number.
  g.setLineDash([7, 7]);
  g.lineWidth = 1.4;
  g.strokeStyle = '#ff5a4a';
  for (const r of trunks) {
    const p = polys.find((q2) => {
      if (!q2 || q2.length < 8) return false;
      let L = 0;
      for (let i = 1; i < q2.length; i++) L += Math.hypot(q2[i].x - q2[i - 1].x, q2[i].z - q2[i - 1].z);
      return Math.abs(L - r.len) < 1e-6;
    });
    if (!p) continue;
    g.beginPath();
    g.moveTo(toPx(p[0].x), toPx(p[0].z));
    g.lineTo(toPx(p[p.length - 1].x), toPx(p[p.length - 1].z));
    g.stroke();
  }
  g.setLineDash([]);

  const blob = await c.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);

  return {
    png: btoa(bin),
    n: rows.length,
    stats: {
      min: q(sins, 0), p25: q(sins, 0.25), median: q(sins, 0.5),
      p75: q(sins, 0.75), max: q(sins, 1),
    },
    trunkMedian: q(trunks.map((t) => t.sin), 0.5),
    trunks: trunks.map((t) => ({
      len: Math.round(t.len), span: Math.round(t.span),
      w: +t.w.toFixed(1), sin: +t.sin.toFixed(3),
    })),
  };
}, { SIZE, MIN_SPAN });

await browser.close();

mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(resolve(OUT), Buffer.from(result.png, 'base64'));

const s = result.stats;
const f = (v) => v.toFixed(3);
console.log(`\nriver plan: ${OUT}`);
console.log(`reaches spanning >= ${MIN_SPAN} m: ${result.n}\n`);
console.log(`sinuosity   min ${f(s.min)}  p25 ${f(s.p25)}  median ${f(s.median)}  p75 ${f(s.p75)}  max ${f(s.max)}`);
console.log(`            <=1.05 straight · 1.05-1.5 sinuous · >=1.5 meandering (lowland rivers 1.4-3.0)\n`);
console.log(`the ten longest trunks — the reaches that fill a frame:`);
for (const t of result.trunks) {
  const flag = t.sin < WANT_TRUNK ? '  <-- straight' : '';
  console.log(`  ${String(t.len).padStart(5)} m over ${String(t.span).padStart(5)} m straight · w ${String(t.w).padStart(5)} · sinuosity ${f(t.sin)}${flag}`);
}
console.log(`  trunk median ${f(result.trunkMedian)}\n`);

// The trunk line is its own gate for the reason given in the header: a hundred
// short steep headwaters drag the median up while the six rivers a player
// actually looks at run dead straight, and only comparing the two shows it.
if (result.trunkMedian < s.median - 0.02) {
  console.log(`NOTE  the longest trunks are STRAIGHTER than the median (${f(result.trunkMedian)} vs ${f(s.median)}).`);
  console.log(`      That is the signature of a smoothing pass collapsing each path toward the`);
  console.log(`      chord between its endpoints — the more stations smoothed, the straighter.\n`);
}

if (has('gate')) {
  const okMedian = s.median >= WANT_MEDIAN;
  const okTrunk = result.trunkMedian >= WANT_TRUNK;
  console.log(`GATE  median  ${f(s.median)} >= ${f(WANT_MEDIAN)}   ${okMedian ? 'PASS' : 'FAIL'}`);
  console.log(`GATE  trunks  ${f(result.trunkMedian)} >= ${f(WANT_TRUNK)}   ${okTrunk ? 'PASS' : 'FAIL'}`);
  if (!okMedian || !okTrunk) {
    console.log(`\nRivers this straight read as canals from any elevated framing.`);
    process.exit(1);
  }
}
