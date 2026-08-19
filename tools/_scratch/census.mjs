// Long-run resource census: is the geometry count a leak or a working set?
//
// perf.mjs reports "geometries +134 over 40 s and still climbing", which is the
// same shape whether the streaming systems are leaking or simply filling a
// cache that is bigger than 40 s of driving. The difference is only visible
// over a run long enough for the working set to saturate, and only if the
// per-system counters are read alongside the renderer's total — a leak shows as
// renderer total climbing while every system's own count is flat.
//
//   node tools/_scratch/census.mjs --seconds 180
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '180')), RES = arg('res', '1536');
await acquire('census');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
await page.evaluate(() => {
  const e = window.__engine, ctx = window.__ctx;
  window.__census = { rows: [], t0: performance.now() };
  const input = ctx.input; window.__drive = true;
  const tick = () => { if (!window.__drive) return; const t = (performance.now() - window.__census.t0) / 1000;
    input.axes.throttle = 1; input.axes.brake = 0; input.axes.steer = Math.sin(t * 0.42) * 0.75; requestAnimationFrame(tick); };
  tick();
  void e;
});
const sample = () => page.evaluate(() => {
  const r = window.__engine.renderer, S = window.__systems, T = window.__terrain;
  let objs = 0, meshes = 0;
  window.__engine.scene.traverse((o) => { objs++; if (o.isMesh || o.isPoints || o.isLine) meshes++; });
  return {
    t: +((performance.now() - window.__census.t0) / 1000).toFixed(0),
    geo: r.info.memory.geometries, tex: r.info.memory.textures,
    prog: r.info.programs?.length ?? 0,
    calls: r.info.render.calls, tris: r.info.render.triangles,
    objs, meshes,
    chunks: T?.chunks?.size ?? -1, blocks: T?.blocks?.size ?? -1,
    cover: S?.groundCover?.cells?.size ?? -1,
    rocks: S?.rocks?.cells?.size ?? -1,
    heap: performance.memory ? (performance.memory.usedJSHeapSize / 1048576) | 0 : 0,
  };
});
const rows = [];
const N = Math.max(2, Math.round(SECONDS / 10));
for (let i = 0; i < N; i++) { await page.waitForTimeout(10000); rows.push(await sample()); }
await page.evaluate(() => { window.__drive = false; });
await browser.close();
const cols = Object.keys(rows[0]);
console.log(cols.map((c) => c.padStart(8)).join(''));
for (const r of rows) console.log(cols.map((c) => String(r[c]).padStart(8)).join(''));
