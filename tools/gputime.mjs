/**
 * Per-pass GPU time via EXT_disjoint_timer_query_webgl2.
 *
 * ── READ THIS BEFORE USING IT ───────────────────────────────────────────────
 *
 * ON THIS STACK (headless Chromium, ANGLE, Metal, Apple silicon) THE NUMBERS
 * THIS TOOL PRODUCES ARE WRONG. Measured 2026-08-21: the extension reports as
 * available, every query reports NOT disjoint, and the four composer passes
 * come back summing to 156 ms inside a 36.5 ms frame. A single full-screen blit
 * (the NaN guard, one texture read and one write) reads as 21.5 ms. The query
 * appears to bracket the whole queued command buffer rather than the pass, so
 * every pass measures roughly "everything queued up to here".
 *
 * It is kept, and kept documented, for three reasons:
 *
 *   1. So the next person does not spend an afternoon rediscovering it.
 *   2. `stats-gl` — a dependency of this project that nothing currently
 *      imports — reads the same extension. Whatever GPU number it would show
 *      in an overlay comes from the same source and deserves the same
 *      suspicion.
 *   3. The failure is a property of the driver, not of the code. On a different
 *      backend (a real Chrome on Windows/D3D, or WebGPU timestamp queries) this
 *      may simply work, and then it is the fastest way to split the frame.
 *
 * Until it does, `tools/ablate.mjs` is the ground truth for this project, and
 * docs/PERF_FINDINGS.md is what it found. Ablation has its own confound —
 * hiding an object removes its occlusion too — but it does not silently invent
 * 120 ms of GPU time.
 *
 *   node tools/gputime.mjs                     # parked
 *   node tools/gputime.mjs --mode drive --seconds 20
 *
 * ── HOW TO TELL IF IT IS WORKING ────────────────────────────────────────────
 *
 * The last two lines of the report are the check. "TOTAL GPU (sum of passes)"
 * must be LESS than the frame time, and "unaccounted" must be POSITIVE. If the
 * total is a multiple of the frame or the unaccounted figure is negative, the
 * backend is batching and every row above it is meaningless.
 *
 * ── METHOD ──────────────────────────────────────────────────────────────────
 *
 * Only one TIME_ELAPSED query may be active at a time, so passes are timed one
 * per frame, round-robin, and each is a distribution rather than one frame's
 * breakdown. Queries are read back several frames later and disjoint results
 * are discarded rather than averaged in — which is the whole reason the
 * extension reports disjointness.
 *
 * The scene pass necessarily includes the shadow map render, because Three
 * renders shadows inside renderer.render(). ablate.mjs's `fx.shadowMapUpdate`
 * knob is what splits those two.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const W       = parseInt(arg('w', '1920'), 10);
const H       = parseInt(arg('h', '1080'), 10);
const DPR     = parseFloat(arg('dpr', '2'));
const PORT    = arg('port', '5180');
const RES     = arg('res', '1536');
const QUALITY = arg('quality', null);
const SECONDS = parseFloat(arg('seconds', '18'));
const MODE    = arg('mode', 'still');
const ANCHOR  = arg('anchor', 'meadow');

await acquire('gputime', { exclusive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, p);
  };
  window.WebSocket.prototype = R.prototype;
  Object.assign(window.WebSocket, R);
});
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));

const params = new URLSearchParams({ res: RES });
if (QUALITY) params.set('quality', QUALITY);
await page.goto(`http://127.0.0.1:${PORT}/?${params}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

const ok = await page.evaluate(({ mode, anchor }) => {
  const e = window.__engine;
  const renderer = e.renderer;
  const gl = renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return { ok: false, reason: 'EXT_disjoint_timer_query_webgl2 unavailable' };

  e.adaptive = false;
  e.autoQuality = false;

  const a = (window.__cameraAnchors[anchor] ?? window.__cameraAnchors.road)();
  window.__vehicleTeleport?.(a.x, a.z, a.yaw ?? 0);
  window.__gtDrive = mode === 'drive';
  const tick = () => {
    const inp = window.__ctx.input;
    if (window.__gtDrive) { inp.axes.throttle = 1; inp.axes.brake = 0; inp.axes.handbrake = 0; inp.axes.steer = 0.42; }
    else { inp.axes.throttle = 0; inp.axes.steer = 0; inp.axes.brake = 1; inp.axes.handbrake = 1; }
    requestAnimationFrame(tick);
  };
  tick();

  const postfx = window.__postfx;
  const passes = postfx.composer.passes;
  // Name the passes by what they are, not by their class — three of them are
  // EffectPass and a reader cannot tell which is which.
  const label = (p, i) => {
    if (p === postfx.renderPass) return 'scene (+shadow map)';
    if (p === postfx.ao) return 'ssao (N8AO)';
    if (p === postfx.sanity) return 'nan guard';
    if (p === postfx.mainPass) return 'merged effects (dof,bloom,veil,tone,vignette,grade,smaa)';
    return `${p.constructor.name}#${i}`;
  };

  const slots = [];
  passes.forEach((p, i) => {
    const name = label(p, i);
    const rec = { name, samples: [], pass: p };
    slots.push(rec);
    const orig = p.render.bind(p);
    p.render = (...args) => {
      if (window.__gt.active !== rec) return orig(...args);
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      orig(...args);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      window.__gt.pending.push({ q, rec, frame: e.frame });
    };
  });

  window.__gt = { slots, pending: [], active: null, cursor: 0, frames: [], last: performance.now(), ext, gl };

  e.onLateUpdate(() => {
    const now = performance.now();
    window.__gt.frames.push(now - window.__gt.last);
    window.__gt.last = now;

    // Harvest anything finished. A disjoint result means the GPU was preempted
    // inside the query and the number is meaningless — throw it away.
    const still = [];
    for (const p of window.__gt.pending) {
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) { still.push(p); continue; }
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      if (!disjoint) p.rec.samples.push(gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(p.q);
    }
    window.__gt.pending = still;

    // One pass per frame, round robin.
    window.__gt.cursor = (window.__gt.cursor + 1) % slots.length;
    window.__gt.active = slots[window.__gt.cursor];
  });

  return { ok: true, passes: slots.map((s) => s.name) };
}, { mode: MODE, anchor: ANCHOR });

if (!ok.ok) { console.error(`cannot measure: ${ok.reason}`); await browser.close(); process.exit(2); }

await page.evaluate(() => window.__settleStable(400, 30));
await page.waitForTimeout(1500);
await page.evaluate(() => { for (const s of window.__gt.slots) s.samples.length = 0; window.__gt.frames.length = 0; });
await page.waitForTimeout(SECONDS * 1000);

const out = await page.evaluate(() => {
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
  const e = window.__engine;
  return {
    passes: window.__gt.slots.map((s) => ({ name: s.name, n: s.samples.length,
      p50: +pct(s.samples, 0.5).toFixed(3), p95: +pct(s.samples, 0.95).toFixed(3) })),
    frame: { p50: +pct(window.__gt.frames, 0.5).toFixed(2), p95: +pct(window.__gt.frames, 0.95).toFixed(2), n: window.__gt.frames.length },
    quality: e.quality,
    megapixels: +((e.renderer.domElement.width * e.renderer.domElement.height) / 1e6).toFixed(2),
    calls: e.renderer.info.render.calls,
    tris: e.renderer.info.render.triangles,
  };
});
await browser.close();

console.log(`\n${MODE}   ${W}x${H} @ dpr ${DPR} -> ${out.megapixels} MP   quality ${out.quality}   ` +
            `${out.calls} calls   ${(out.tris / 1e6).toFixed(2)} M tris`);
console.log(`frame        p50 ${out.frame.p50} ms  =  ${(1000 / out.frame.p50).toFixed(1)} fps   (p95 ${out.frame.p95} ms)\n`);
console.log('  ' + 'GPU pass'.padEnd(54) + 'p50 ms'.padStart(9) + 'p95 ms'.padStart(9) + '  share of frame');
let sum = 0;
for (const p of out.passes) {
  sum += p.p50;
  console.log('  ' + p.name.padEnd(54) + p.p50.toFixed(2).padStart(9) + p.p95.toFixed(2).padStart(9) +
              `${((p.p50 / out.frame.p50) * 100).toFixed(0)}%`.padStart(10) + `   (n=${p.n})`);
}
console.log('  ' + 'TOTAL GPU (sum of passes)'.padEnd(54) + sum.toFixed(2).padStart(9) + ''.padStart(9) +
            `${((sum / out.frame.p50) * 100).toFixed(0)}%`.padStart(10));
console.log(`  ${'unaccounted (CPU, present, compositor)'.padEnd(54)}${(out.frame.p50 - sum).toFixed(2).padStart(9)}`);

if (errors.length) console.log('\nconsole errors:', [...new Set(errors)].slice(0, 4));
if (arg('json')) {
  mkdirSync(dirname(resolve(arg('json'))), { recursive: true });
  writeFileSync(resolve(arg('json')), JSON.stringify({ mode: MODE, ...out }, null, 1));
}
