// Does a runtime quality-tier change actually reach the post chain, and does
// the picture survive it? A shader link failure or a lost pass renders nothing
// and passes every other check, so this reads pixels back as well as structure.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('perf');
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
  await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
  await page.goto('http://127.0.0.1:5178/?res=768', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
  // The readback has to happen INSIDE the render callback, right after the
  // composer presents. Reading the default framebuffer from a later task
  // returns zeros in Chrome (no preserveDrawingBuffer), which reads as "the
  // screen is black" for every tier including the one that is known good.
  await page.evaluate(() => {
    const P = window.__ctx.postfx, gl = window.__engine.renderer.getContext();
    const W = 40, H = 24, px = new Uint8Array(W * H * 4);
    const orig = P.render.bind(P);
    P.render = function (dt) {
      orig(dt);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let sum = 0, dark = 0;
      for (let i = 0; i < W * H; i++) { const v = (px[i*4]+px[i*4+1]+px[i*4+2]) / 3; sum += v; if (v < 8) dark++; }
      window.__px = { meanLuma: +(sum / (W * H)).toFixed(1), darkPct: +(100 * dark / (W * H)).toFixed(1) };
    };
  });
  const probe = async (label) => {
    await page.waitForTimeout(900);
    const r = await page.evaluate(() => {
      const P = window.__ctx.postfx, e = window.__engine, r = e.renderer;
      return {
        tier: P.tier,
        passes: P.composer.passes.map((p) => p.constructor.name),
        effects: P.mainPass.effects.map((x) => x.name),
        ao: !!P.ao, aoSamples: P.ao?.configuration.aoSamples ?? null,
        denoise: P.ao ? [P.ao.configuration.denoiseSamples, P.ao.configuration.denoiseIterations] : null,
        dof: !!P.dof, bloomLevels: P.bloom.mipmapBlurPass.levels,
        ...window.__px,
        programErrors: r.info.programs.filter((p) => p.diagnostics && !p.diagnostics.runnable).length,
      };
    });
    console.log(label.padEnd(8), JSON.stringify(r));
  };
  await probe('boot');
  for (const t of ['high', 'medium', 'low', 'ultra', 'medium', 'ultra']) {
    await page.evaluate((q) => window.__engine.setQuality(q), t);
    await probe('->' + t);
  }
  console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors');
} finally { await browser.close().catch(() => {}); }
