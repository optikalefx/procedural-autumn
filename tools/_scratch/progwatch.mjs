// When does a shader program actually get built, and what is it?
//
// hitchwhy.mjs answers this by wrapping every material's onBeforeCompile. That
// is not a passive instrument: three puts `material.onBeforeCompile.toString()`
// into the program cache key (you can see it in hitchwhy's own output — cache
// keys ending in `onBeforeCompile() { }` and `function(sh,rr)`), so replacing
// the function invalidates the cache and forces the recompiles it then reports.
// Its 500 ms re-tag interval reproduces that indefinitely.
//
// This watches renderer.info.programs instead and never touches a material, so
// what it reports is what the player's machine would actually compile. It also
// records the frame time of the frame each program appeared on, which is the
// only number that says whether a late compile is a stall or a shrug.
//
//   node tools/_scratch/progwatch.mjs --seconds 60
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '60')), RES = arg('res', '1536'), QUALITY = arg('quality', null);
const W = parseInt(arg('w', '1280'), 10), H = parseInt(arg('h', '800'), 10), DPR = parseFloat(arg('dpr', '2'));
await acquire('progwatch');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
const q = new URLSearchParams({ res: RES }); if (QUALITY) q.set('quality', QUALITY);
await page.goto(`http://localhost:5178/?${q}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
await page.evaluate(() => {
  const e = window.__engine, ctx = window.__ctx, r = e.renderer, gl = r.getContext();
  const P = window.__pw = { t0: performance.now(), news: [], links: [], frames: 0, worst: [] };
  // linkProgram is the GL call that actually builds one; on this driver the
  // link itself returns immediately and the cost lands on the first draw, so
  // record both the link and the frame time of the frame it happened on.
  const ol = gl.linkProgram.bind(gl);
  let linksThisFrame = 0;
  gl.linkProgram = function (p) { linksThisFrame++; P.links.push(+(performance.now() - P.t0).toFixed(0)); return ol(p); };
  let known = new Set((r.info.programs || []).map((x) => x.cacheKey));
  P.atReady = known.size;
  let last = performance.now();
  e.onLateUpdate(() => {
    const now = performance.now(), ms = now - last; last = now; P.frames++;
    for (const x of (r.info.programs || [])) {
      if (known.has(x.cacheKey)) continue;
      known.add(x.cacheKey);
      P.news.push({ t: +((now - P.t0) / 1000).toFixed(2), ms: +ms.toFixed(0), name: x.name || '?' });
    }
    if (ms > 60) P.worst.push({ t: +((now - P.t0) / 1000).toFixed(2), ms: +ms.toFixed(0), links: linksThisFrame });
    linksThisFrame = 0;
  });
  const input = ctx.input; window.__d = true;
  const tick = () => { if (!window.__d) return; const t = (performance.now() - P.t0) / 1000;
    input.axes.throttle = 1; input.axes.brake = 0; input.axes.steer = Math.sin(t * 0.42) * 0.75; requestAnimationFrame(tick); };
  tick();
});
await page.waitForTimeout(SECONDS * 1000);
const d = await page.evaluate(() => { window.__d = false; const P = window.__pw;
  return { atReady: P.atReady, total: window.__engine.renderer.info.programs.length, frames: P.frames,
    news: P.news, links: P.links, worst: P.worst.sort((a, b) => b.ms - a.ms).slice(0, 12) }; });
await browser.close();
console.log(`programs at ready ${d.atReady} -> ${d.total} after ${SECONDS}s (${d.frames} frames)`);
console.log(`gl.linkProgram calls after ready: ${d.links.length}   at ms: ${d.links.join(', ')}`);
console.log('\nnew programs after ready (t, frame time of the frame it appeared on):');
for (const n of d.news) console.log(`   ${String(n.t).padStart(7)}s  ${String(n.ms).padStart(5)} ms   ${n.name}`);
console.log('\nframes over 60 ms:');
for (const w of d.worst) console.log(`   ${String(w.t).padStart(7)}s  ${String(w.ms).padStart(5)} ms   links ${w.links}`);
