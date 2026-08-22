#!/usr/bin/env node
/**
 * Runtime performance and visual-stability audit.
 *
 * The rest of this harness judges STILL FRAMES, which is why a hitch or a
 * flashing black tile is invisible to it: a screenshot is taken after the
 * scene has settled, so it never sees the frame that stuttered. This drives the
 * camper on a real route and watches the frames as they happen.
 *
 *   node tools/perf.mjs                       # 45 s drive, full report
 *   node tools/perf.mjs --seconds 90 --res 1536
 *   node tools/perf.mjs --json shots/perf/run.json
 *
 * Reports, and asserts against, four things:
 *   1. frame-time distribution (p50/p95/p99, worst) and hitch counts
 *   2. black / partially-rendered frames sampled DURING motion
 *   3. draw-call and triangle spikes, correlated with the hitch timeline
 *   4. resource growth over the run (geometries, textures, programs) — leaks
 *
 * Exit code 0 = within budget. Non-zero = a regression worth blocking on.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const SECONDS = parseFloat(arg('seconds', '45'));
const RES = arg('res', '1536');
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const QUALITY = arg('quality', null);
// The player's display, not the harness's. dprtest.mjs exists because this
// harness and the player disagreed by 3x on frame time for exactly this reason;
// a hitch profile taken at a quarter of the pixel count is not the one anyone
// feels. Default stays 1 so existing budgets and baselines still mean what they
// meant.
const DPR = parseFloat(arg('dpr', '1'));

// Budgets. A cozy driving game must hold 60 fps; a hitch you can feel is ~2
// dropped frames, and anything over 100 ms reads as a freeze.
const BUDGET = {
  p50Ms: 16.7,
  p95Ms: 25.0,
  hitch50: 6,      // frames over 50 ms across the whole run
  hitch100: 0,     // frames over 100 ms — a visible freeze
  blackFrames: 0,
  drawCalls: 900,
  triangles: 4_500_000,
};

/**
 * Refuse to capture against a broken tree.
 *
 * Six separate authors have taken the build down by putting a backtick inside a
 * GLSL template literal. The failure surfaces as a blank page or a confusing
 * runtime error a minute later, after a capture has already been spent. Linting
 * first costs ~1 s and names the file and line.
 */
function assertTreeParses() {
  try {
    execFileSync(process.execPath, ['tools/lint.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
    console.error('\n[capture] refusing to run — the source tree does not parse:\n');
    console.error(out.trim());
    console.error('\nFix the syntax error and re-run. If the offending file is not yours, a peer is');
    console.error('mid-edit: wait a moment and retry rather than editing their file.\n');
    process.exit(2);
  }
}

assertTreeParses();
await acquire('perf');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });

// Neuter Vite's HMR client before any page script runs. A dozen authors edit
  // this tree concurrently, and a peer saving a file mid-run reloads the page
  // and kills the run with "Execution context was destroyed".
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

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

// Eleven authors share one dev server. Any of them saving a file makes Vite
// push a hot reload, which throws away the recorder and the whole measurement
// half way through a 45 s drive. A capture is a one-shot page load and never
// wants hot reload, so the HMR socket is stubbed out; the module graph still
// loads exactly as it normally does.
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => { /* swallowed */ });

// A reload that gets through anyway would silently produce a bogus report, so
// say so rather than crash with a confusing "__perf is undefined".
let navigations = 0;
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });

const params = new URLSearchParams({ res: RES });
if (QUALITY) params.set('quality', QUALITY);
// Pin the internal render scale (and thereby freeze the adaptive scaler) so a
// hitch profile can separate "the scaler stepped" from "the frame is slow".
const ISCALE = arg('iscale', null);
if (ISCALE) params.set('iscale', ISCALE);
await page.goto(`${process.env.AUTUMN_URL || 'http://localhost:5178'}/?${params}`, { waitUntil: 'domcontentloaded' });
const navAtStart = navigations;
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

// ── install the recorder ────────────────────────────────────────────────────
await page.evaluate(() => {
  const e = window.__engine;
  window.__perf = { frames: [], started: performance.now(), baseline: null };
  const r = e.renderer;

  window.__perf.baseline = {
    geometries: r.info.memory.geometries,
    textures: r.info.memory.textures,
    programs: r.info.programs?.length ?? 0,
  };

  let last = performance.now();
  e.onLateUpdate(() => {
    const now = performance.now();
    window.__perf.frames.push({
      t: now - window.__perf.started,
      ms: now - last,
      calls: r.info.render.calls,
      tris: r.info.render.triangles,
      geo: r.info.memory.geometries,
      tex: r.info.memory.textures,
      prog: r.info.programs?.length ?? 0,
    });
    last = now;
  });

  // Drive: hold throttle, weave, so streaming and LOD are genuinely exercised.
  const input = window.__ctx?.input;
  if (input) {
    window.__perfDrive = true;
    const tick = () => {
      if (!window.__perfDrive) return;
      const t = (performance.now() - window.__perf.started) / 1000;
      input.axes.throttle = 1;
      input.axes.brake = 0;
      input.axes.steer = Math.sin(t * 0.42) * 0.75;
      input.axes.handbrake = 0;
      requestAnimationFrame(tick);
    };
    tick();
  }
});

// ── sample frames DURING motion, looking for black / partial renders ────────
//
// The decode and the pixel scan run in a SEPARATE blank page, not in the page
// under test. They used to run in the game page, and decoding a 1600x900 PNG
// data URL plus a getImageData on the same main thread that owns the render
// loop stalled it for 300-700 ms — every single time. The tool then counted its
// own stalls as game hitches: a clean run reported 12 frames over 100 ms, of
// which 8 were exactly the eight samples. Same measurement, same thresholds,
// just performed somewhere that cannot perturb the subject.
const analyst = await browser.newPage();
await analyst.goto('about:blank');

const SAMPLES = Math.max(6, Math.round(SECONDS / 4));
const blackSamples = [];
for (let i = 0; i < SAMPLES; i++) {
  await page.waitForTimeout((SECONDS * 1000) / SAMPLES);
  const buf = await page.screenshot();
  const at = await page.evaluate(() => performance.now() - window.__perf.started);
  const q = await analyst.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const w = 160, h = Math.max(1, Math.round(img.height / img.width * w));
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    let dark = 0;
    const colDark = new Array(w).fill(0);
    const rowDark = new Array(h).fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i2 = (y * w + x) * 4;
        if ((d[i2] + d[i2 + 1] + d[i2 + 2]) / 3 < 12) { dark++; colDark[x]++; rowDark[y]++; }
      }
    }
    return {
      darkFrac: dark / (w * h),
      deadCols: colDark.filter((c) => c >= h * 0.97).length / w,
      deadRows: rowDark.filter((c) => c >= w * 0.97).length / h,
    };
  }, buf.toString('base64'));
  q.t = at;
  // A tile-shaped hole shows up as dead columns or rows; a whole-frame drop as
  // a high dark fraction. Either is a visual failure the still harness misses.
  if (q.darkFrac > 0.5 || q.deadCols > 0.2 || q.deadRows > 0.2) blackSamples.push(q);
}

if (navigations !== navAtStart) {
  await browser.close();
  console.error('\nABORTED — the page reloaded mid-run (a concurrent edit, most likely). Re-run.');
  process.exit(2);
}

await page.evaluate(() => { window.__perfDrive = false; });

// ── collect ─────────────────────────────────────────────────────────────────
const data = await page.evaluate(() => {
  const f = window.__perf.frames.slice(30);   // drop warm-up
  const ms = f.map((x) => x.ms).sort((a, b) => a - b);
  const pct = (p) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : 0;
  const worst = f.reduce((a, b) => (b.ms > a.ms ? b : a), f[0] ?? { ms: 0, t: 0 });
  const last = f[f.length - 1] ?? {};
  return {
    frames: f.length,
    p50: +pct(0.50).toFixed(2), p95: +pct(0.95).toFixed(2), p99: +pct(0.99).toFixed(2),
    worstMs: +(worst.ms ?? 0).toFixed(1), worstAtS: +((worst.t ?? 0) / 1000).toFixed(1),
    hitch33: f.filter((x) => x.ms > 33).length,
    hitch50: f.filter((x) => x.ms > 50).length,
    hitch100: f.filter((x) => x.ms > 100).length,
    maxCalls: Math.max(...f.map((x) => x.calls)),
    maxTris: Math.max(...f.map((x) => x.tris)),
    // Resource growth is the leak signal: a system that rebuilds without
    // disposing shows up here long before it shows up as a frame-time problem.
    growth: {
      geometries: (last.geo ?? 0) - window.__perf.baseline.geometries,
      textures: (last.tex ?? 0) - window.__perf.baseline.textures,
      programs: (last.prog ?? 0) - window.__perf.baseline.programs,
    },
    // Worst ten frames with their draw-call load, to correlate hitch with cause.
    worstFrames: [...f].sort((a, b) => b.ms - a.ms).slice(0, 10)
      .map((x) => ({ atS: +(x.t / 1000).toFixed(1), ms: +x.ms.toFixed(1), calls: x.calls, tris: x.tris })),
  };
});

await browser.close();

// ── verdict ─────────────────────────────────────────────────────────────────
const fails = [];
if (data.p50 > BUDGET.p50Ms) fails.push(`p50 ${data.p50} ms > ${BUDGET.p50Ms} (below 60 fps at the median)`);
if (data.p95 > BUDGET.p95Ms) fails.push(`p95 ${data.p95} ms > ${BUDGET.p95Ms}`);
if (data.hitch50 > BUDGET.hitch50) fails.push(`${data.hitch50} frames over 50 ms (budget ${BUDGET.hitch50})`);
if (data.hitch100 > BUDGET.hitch100) fails.push(`${data.hitch100} frames over 100 ms — visible freezes`);
if (blackSamples.length > BUDGET.blackFrames) fails.push(`${blackSamples.length}/${SAMPLES} sampled frames were black or partially rendered`);
if (data.maxCalls > BUDGET.drawCalls) fails.push(`peak ${data.maxCalls} draw calls > ${BUDGET.drawCalls}`);
if (data.maxTris > BUDGET.triangles) fails.push(`peak ${(data.maxTris / 1e6).toFixed(2)} M triangles > ${(BUDGET.triangles / 1e6).toFixed(1)} M`);
if (data.growth.geometries > 400) fails.push(`geometries grew by ${data.growth.geometries} over the run — likely a leak`);
if (data.growth.textures > 40) fails.push(`textures grew by ${data.growth.textures} over the run — likely a leak`);

const report = { seconds: SECONDS, res: RES, viewport: [W, H], ...data, blackSamples, errors: [...new Set(errors)].slice(0, 8), fails };

console.log(`\nframe time   p50 ${data.p50} ms   p95 ${data.p95} ms   p99 ${data.p99} ms   worst ${data.worstMs} ms @ ${data.worstAtS}s`);
console.log(`hitches      >33ms ${data.hitch33}   >50ms ${data.hitch50}   >100ms ${data.hitch100}   (${data.frames} frames)`);
console.log(`peak load    ${data.maxCalls} calls   ${(data.maxTris / 1e6).toFixed(2)} M tris`);
console.log(`growth       geo +${data.growth.geometries}  tex +${data.growth.textures}  prog +${data.growth.programs}`);
console.log(`black frames ${blackSamples.length}/${SAMPLES} sampled during motion`);
if (data.worstFrames.length) {
  console.log('\nworst frames (time, ms, calls, tris):');
  for (const w of data.worstFrames) console.log(`  ${String(w.atS).padStart(6)}s  ${String(w.ms).padStart(7)} ms  ${String(w.calls).padStart(5)} calls  ${(w.tris / 1e6).toFixed(2)} M`);
}
if (errors.length) console.log('\nconsole errors:', JSON.stringify([...new Set(errors)].slice(0, 5), null, 1));

if (arg('json')) {
  mkdirSync(dirname(resolve(arg('json'))), { recursive: true });
  writeFileSync(resolve(arg('json')), JSON.stringify(report, null, 1));
}

if (fails.length) {
  console.log('\nFAIL');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('\nPASS — within budget');
