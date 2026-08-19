// Does the amortised far-impostor upload ever show fewer trees than the
// unamortised one would?
//
// A pixel A/B cannot answer this right now — another author is editing the post
// chain between captures, so every frame differs for reasons that have nothing
// to do with this change. The invariant is checkable directly instead: after
// the scene settles, the drawn count must equal the binned count, and while
// driving it must never exceed what has actually been uploaded.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '40'));
await acquire('farcheck');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
await page.evaluate(() => {
  const e = window.__engine, ctx = window.__ctx, T = window.__systems.trees;
  const P = window.__fc = { frames: 0, bad: 0, worstDeficit: 0, lagFrames: 0, samples: [] };
  e.onLateUpdate(() => {
    P.frames++;
    const drawn = T.farMesh.count, binned = T.farSlot.count;
    // Never draw an instance that has not been uploaded at least once.
    if (drawn > T._farFilled) P.bad++;
    if (drawn < binned) { P.lagFrames++; P.worstDeficit = Math.max(P.worstDeficit, binned - drawn); }
    if (P.frames % 120 === 0) P.samples.push({ f: P.frames, drawn, binned });
  });
  const input = ctx.input; window.__d = true;
  const tick = () => { if (!window.__d) return; const t = performance.now() / 1000;
    input.axes.throttle = 1; input.axes.steer = Math.sin(t * 0.42) * 0.75; requestAnimationFrame(tick); };
  tick();
});
await page.waitForTimeout(SECONDS * 1000);
// Then stand still and settle, which is what every canonical shot does.
const out = await page.evaluate(async () => {
  const ctx = window.__ctx, T = window.__systems.trees;
  window.__d = false; ctx.input.axes.throttle = 0; ctx.input.axes.brake = 1; ctx.input.axes.steer = 0;
  await window.__settle(90);
  const P = window.__fc;
  return { frames: P.frames, drawnPastUploaded: P.bad, lagFrames: P.lagFrames, worstDeficit: P.worstDeficit,
           settledDrawn: T.farMesh.count, settledBinned: T.farSlot.count, samples: P.samples.slice(0, 6) };
});
await browser.close();
console.log(JSON.stringify(out, null, 1));
