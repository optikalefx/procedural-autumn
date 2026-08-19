// dprtest, but the quality tier is changed AT RUNTIME after boot.
//
// Booting with ?quality=medium was never the broken case — PostFX read the
// preset in its constructor, so a boot-time tier was honoured. The broken case
// is the settings panel: boot at ultra, then drop the tier. Before PostFX
// implemented onQuality, SSAO and depth of field simply stayed where the
// constructor left them, so a struggling player's escape hatch changed the
// pixel ratio and nothing else. This measures that path.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const W = parseInt(arg('w', '1170'), 10), H = parseInt(arg('h', '870'), 10);
const DPR = parseFloat(arg('dpr', '2')), SECONDS = parseFloat(arg('seconds', '24'));
const TO = arg('to', 'medium');
// --boot loads the tier from the URL instead of switching to it, so the two
// paths can be compared inside the same minute of machine load.
const BOOT = argv.includes('--boot');
await acquire('dprtest');
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--disable-frame-rate-limit'] });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
  await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
  await page.goto(`http://127.0.0.1:5178/?res=1536${BOOT ? '&quality=' + TO : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
  await page.waitForTimeout(1500);
  const applied = BOOT ? 'boot' : await page.evaluate((q) => window.__engine.setQuality(q), TO);
  await page.evaluate(() => {
    const e = window.__engine; window.__dpr = { frames: [], t0: performance.now() };
    let last = performance.now();
    e.onLateUpdate(() => { const n = performance.now(); window.__dpr.frames.push(n - last); last = n; });
    const input = window.__ctx.input; window.__drive = true;
    const tick = () => { if (!window.__drive) return;
      const t = (performance.now() - window.__dpr.t0) / 1000;
      input.axes.throttle = 1; input.axes.steer = Math.sin(t * 0.42) * 0.7; requestAnimationFrame(tick); };
    tick();
  });
  await page.waitForTimeout(SECONDS * 1000);
  const s = await page.evaluate(() => {
    window.__drive = false;
    const all = window.__dpr.frames.slice(40);
    const tail = all.slice(Math.floor(all.length * 0.66)).sort((a, b) => a - b);
    const tp = (p) => tail[Math.min(tail.length - 1, Math.floor(p * tail.length))];
    const P = window.__ctx.postfx;
    return { settled_p50: +tp(0.5).toFixed(1), settled_fps: +(1000 / tp(0.5)).toFixed(1), p95: +tp(0.95).toFixed(1),
      tier: P.tier, ao: !!P.ao, aoSamples: P.ao?.configuration.aoSamples ?? null, dof: !!P.dof,
      calls: window.__engine.renderer.info.render.calls,
      tris: +(window.__engine.renderer.info.render.triangles / 1e6).toFixed(2),
      shadowMap: window.__engine.preset.shadowMapSize,
      resolution: window.__resolution() };
  });
  console.log(JSON.stringify({ switchedTo: TO, applied, ...s }));
} finally { await browser.close().catch(() => {}); }
