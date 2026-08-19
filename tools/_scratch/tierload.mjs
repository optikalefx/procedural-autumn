// What does a runtime tier change actually remove from the scene?
//
// Engine now steps the tier down on its own, so "medium" and "low" have to mean
// something. tiercheck.mjs proves the picture survives and qswitch.mjs times it;
// this one counts, which is the part that is contention-proof: draw calls,
// triangles, and the per-system resident sets, before and after.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const TIERS = (arg('tiers', 'ultra,high,medium,low')).split(',');
await acquire('perf');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
  await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
  await page.goto('http://127.0.0.1:5178/?res=1536', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
  // Drive for a moment so the streaming systems are warm and representative.
  await page.evaluate(() => { const i = window.__ctx.input; window.__d = true;
    const t = () => { if (!window.__d) return; i.axes.throttle = 1; i.axes.steer = 0.2; requestAnimationFrame(t); }; t(); });
  await page.waitForTimeout(6000);
  await page.evaluate(() => { window.__d = false; const i = window.__ctx.input; i.axes.throttle = 0; i.axes.brake = 1; });

  const rows = [];
  for (const tier of TIERS) {
    await page.evaluate((t) => { window.__engine.setQuality(t); }, tier);
    // A tier change forces a terrain rescan that drains at 3 ms a frame, so
    // give it long enough to finish before counting.
    await page.evaluate(() => window.__settle(220));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__settle(120));
    rows.push(await page.evaluate((t) => {
      const r = window.__engine.renderer, S = window.__systems, T = window.__terrain;
      return { tier: t,
        calls: r.info.render.calls, tris: +(r.info.render.triangles / 1e6).toFixed(2),
        mp: +((r.domElement.width * r.domElement.height) / 1e6).toFixed(2),
        chunks: T.chunks.size, blocks: T.blocks.size, lod: T.lodDistances.map((x) => Math.round(x)).join('/'),
        treeNear: S.trees.stats.near, treeMid: S.trees.stats.mid, treeFar: S.trees.stats.far,
        treeTris: +(S.trees.stats.tris / 1e6).toFixed(2),
        shadow: window.__lighting?.sun?.shadow?.mapSize?.x ?? 0 };
    }, tier));
  }
  console.log('tier      calls  M tris     MP  chunks blocks  lodDistances        treeNear  treeMid  treeFar  treeM  shadow');
  for (const r of rows) console.log(
    `${r.tier.padEnd(8)}${String(r.calls).padStart(6)}${String(r.tris).padStart(8)}${String(r.mp).padStart(7)}` +
    `${String(r.chunks).padStart(8)}${String(r.blocks).padStart(7)}  ${r.lod.padEnd(20)}` +
    `${String(r.treeNear).padStart(8)}${String(r.treeMid).padStart(9)}${String(r.treeFar).padStart(9)}${String(r.treeTris).padStart(7)}${String(r.shadow).padStart(8)}`);
  if (errs.length) { console.log('\nERRORS:'); for (const e of errs.slice(0, 8)) console.log('  ' + e); }
} finally { await browser.close().catch(() => {}); }
