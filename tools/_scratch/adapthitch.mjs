// Is the adaptive resolution scaler itself the p95?
//
// At 2560x1400 dpr2 the frame is p50 53 ms / p95 115 ms / max 2032 ms, and on
// every one of the worst frames the time is in `~gap before update` — outside
// every system, outside the render callback. The two things that happen there
// are the browser's own work and Engine._adapt, which on a change calls
// setPixelRatio + setSize and makes every render target in the post chain
// reallocate. This pins it: same drive, three arms.
//
//   auto    — as shipped
//   pinned  — adaptive off, held at the floor the auto arm reaches
//   full    — adaptive off, held at 1.0 (control: is a resize the cost, or the pixels?)
//
//   node tools/_scratch/adapthitch.mjs --w 2560 --h 1400 --dpr 2 --seconds 30
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '30')), RES = arg('res', '1536');
const W = parseInt(arg('w', '2560'), 10), H = parseInt(arg('h', '1400'), 10), DPR = parseFloat(arg('dpr', '2'));
const ARMS = (arg('arms', 'auto,pinned')).split(',');
await acquire('adapthitch');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
await page.evaluate(() => {
  const e = window.__engine, ctx = window.__ctx;
  const P = window.__ah = { frames: [], resizes: [], t0: performance.now(), scale: e.resolutionScale };
  // Break one resize into its parts. Engine._applyResolution does
  // setPixelRatio -> setSize -> every registered onResize callback, and the only
  // registered callback in the game is PostFX's composer.setSize + ao.setSize.
  const part = {};
  const timed = (label, fn) => function (...a) { const t = performance.now(); const o = fn.apply(this, a); part[label] = (part[label] || 0) + (performance.now() - t); return o; };
  const r = e.renderer;
  r.setSize = timed('renderer.setSize', r.setSize.bind(r));
  r.setPixelRatio = timed('renderer.setPixelRatio', r.setPixelRatio.bind(r));
  e._resizeCbs = e._resizeCbs.map((cb, i) => timed('onResize#' + i, cb));
  const ar = e._applyResolution.bind(e);
  e._applyResolution = function () { for (const k in part) delete part[k];
    const t = performance.now(); const o = ar(); const ms = performance.now() - t;
    P.resizes.push({ t: +(performance.now() - P.t0).toFixed(0), ms: +ms.toFixed(1), to: +e.resolutionScale.toFixed(3),
      parts: Object.entries(part).map(([k, v]) => k + ' ' + v.toFixed(0)).join(' + ') }); return o; };
  let last = performance.now();
  e.onLateUpdate(() => { const now = performance.now(); P.frames.push({ t: now - P.t0, ms: now - last, s: e.resolutionScale }); last = now; });
  const input = ctx.input; window.__drive = true;
  const tick = () => { if (!window.__drive) return; const t = (performance.now() - P.t0) / 1000;
    input.axes.throttle = 1; input.axes.brake = 0; input.axes.steer = Math.sin(t * 0.42) * 0.75; requestAnimationFrame(tick); };
  tick();
});
const run = async (arm) => {
  await page.evaluate((a) => {
    const e = window.__engine;
    e.adaptive = true;
    if (a === 'pinned') { e.adaptive = false; e.resolutionScale = e.minResolutionScale; e._applyResolution(); }
    if (a === 'full') { e.adaptive = false; e.resolutionScale = 1; e._applyResolution(); }
    window.__ah.frames.length = 0; window.__ah.resizes.length = 0; window.__ah.t0 = performance.now();
  }, arm);
  await page.waitForTimeout(4000);
  await page.evaluate(() => { window.__ah.frames.length = 0; window.__ah.resizes.length = 0; window.__ah.t0 = performance.now(); });
  await page.waitForTimeout(SECONDS * 1000);
  return page.evaluate(() => {
    const P = window.__ah, f = P.frames.map((x) => x.ms).sort((a, b) => a - b);
    const p = (q) => f[Math.min(f.length - 1, Math.floor(q * f.length))];
    return { n: f.length, p50: +p(0.5).toFixed(1), p95: +p(0.95).toFixed(1), max: +f[f.length - 1].toFixed(0),
      over100: f.filter((x) => x > 100).length, over60: f.filter((x) => x > 60).length,
      scale: +window.__engine.resolutionScale.toFixed(3), mp: +((window.__engine.renderer.domElement.width * window.__engine.renderer.domElement.height) / 1e6).toFixed(2),
      resizes: P.resizes.slice(0, 20) };
  });
};
const out = {};
for (const a of ARMS) out[a] = await run(a);
await browser.close();
console.log(`${W}x${H} dpr${DPR}   ${SECONDS}s per arm`);
for (const [k, v] of Object.entries(out)) {
  console.log(`\n  ${k.padEnd(8)} frames ${v.n}  p50 ${v.p50}  p95 ${v.p95}  max ${v.max}  >60ms ${v.over60}  >100ms ${v.over100}  scale ${v.scale}  ${v.mp} MP  fps50 ${(1000 / v.p50).toFixed(1)}`);
  for (const r of v.resizes) console.log(`    resize at ${r.t} ms -> ${r.to}   ${r.ms} ms   [${r.parts}]`);
}
