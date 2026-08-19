// perf.mjs with an --eval hook: run arbitrary page JS before the recording
// starts, so a system can be disabled and the run re-measured. Same drive,
// same statistics, no black-frame sampling (that perturbs nothing but costs
// wall time we do not need while bisecting).
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '30')), RES = arg('res', '1536'), QUALITY = arg('quality', null);
const EVAL = arg('eval', null), LABEL = arg('label', EVAL ? EVAL.slice(0, 60) : 'baseline');
await acquire('perf');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
const p = new URLSearchParams({ res: RES }); if (QUALITY) p.set('quality', QUALITY);
await page.goto(`http://localhost:5178/?${p}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForTimeout(1200);
if (EVAL) await page.evaluate(EVAL);
await page.evaluate(() => {
  const e = window.__engine, r = e.renderer;
  const P = window.__perf = { frames: [], started: performance.now() };
  let last = performance.now();
  e.onLateUpdate(() => { const now = performance.now();
    P.frames.push({ t: now - P.started, ms: now - last, calls: r.info.render.calls, tris: r.info.render.triangles, geo: r.info.memory.geometries }); last = now; });
  const input = window.__ctx?.input; window.__perfDrive = true;
  const tick = () => { if (!window.__perfDrive) return; const t = (performance.now() - P.started) / 1000;
    input.axes.throttle = 1; input.axes.brake = 0; input.axes.steer = Math.sin(t * 0.42) * 0.75; requestAnimationFrame(tick); };
  tick();
});
await page.waitForTimeout(SECONDS * 1000);
const d = await page.evaluate(() => {
  const f = window.__perf.frames.slice(60); window.__perfDrive = false;
  const ms = f.map((x) => x.ms).sort((a, b) => a - b);
  const pct = (q) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] : 0;
  return { n: f.length, p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2), p99: +pct(0.99).toFixed(2),
    worst: +Math.max(...ms).toFixed(1), h33: f.filter((x) => x.ms > 33).length, h50: f.filter((x) => x.ms > 50).length,
    h100: f.filter((x) => x.ms > 100).length, calls: Math.max(...f.map((x) => x.calls)),
    tris: +(Math.max(...f.map((x) => x.tris)) / 1e6).toFixed(2),
    geo: f[f.length - 1].geo - f[0].geo };
});
await browser.close();
console.log(`${LABEL.padEnd(46)} p50 ${String(d.p50).padStart(6)}  p95 ${String(d.p95).padStart(6)}  p99 ${String(d.p99).padStart(6)}  worst ${String(d.worst).padStart(6)}  >33 ${String(d.h33).padStart(4)} >50 ${String(d.h50).padStart(4)} >100 ${String(d.h100).padStart(3)}  calls ${d.calls}  ${d.tris}M  geo+${d.geo}  (${d.n}f)`);
