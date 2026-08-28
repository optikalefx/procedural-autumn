// Why is the sharp-band line missing from the readout?
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const HMR = () => {
  const R = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, p);
  };
};
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(HMR);
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).split('\n')[0]));
await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
await page.waitForTimeout(1200);
await page.evaluate(() => { window.__systems.hud.togglePhoto(); });
await page.waitForTimeout(2500);
console.log(JSON.stringify(await page.evaluate(() => {
  const f = window.__systems.hud.photo.focus;
  const L = window.__postfx.lensInfo?.();
  return {
    lensInfo: L && { near: L.near, far: L.far, wideOpen: L.wideOpen, fStop: L.fStop },
    samePostfx: window.__postfx === window.__ctx.postfx,
    focusActive: f.active,
    photoActive: window.__systems.hud.photo.active,
    _photoDOF: window.__ctx.postfx._photoDOF,
    hasEffect: !!window.__ctx.postfx._dofEffect,
    dofInChain: !!window.__ctx.postfx.dof,
    ctxLensInfo: window.__ctx.postfx.lensInfo?.() ? 'ok' : 'null',
    html: f._node?.innerHTML,
    note: f._note, warn: f._warn,
  };
}), null, 2));
await b.close();
