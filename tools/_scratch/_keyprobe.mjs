import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
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
});
await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
const out = await page.evaluate(async () => {
  const hud = window.__systems.hud;
  const r = {};
  // Does ANY synthetic key reach HUD? N toggles the minimap.
  const map0 = hud.showMap;
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN', bubbles: true }));
  await new Promise((s) => setTimeout(s, 150));
  r.synthKeysReachHud = hud.showMap !== map0;
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN', bubbles: true }));

  // Instrument the path: does HUD's own handler see KeyJ?
  let sawJ = false;
  const spy = (e) => { if (e.code === 'KeyJ') sawJ = true; };
  window.addEventListener('keydown', spy);            // bubble, same as HUD
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', bubbles: true }));
  await new Promise((s) => setTimeout(s, 150));
  r.bubblePhaseSeesJ = sawJ;
  r.journalOpened = hud.journal.active;
  window.removeEventListener('keydown', spy);
  return r;
});
console.log(JSON.stringify(out, null, 1));
await b.close();
