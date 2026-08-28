// Leave photo mode on the long lens, come back, and see what you get.
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
const st = () => page.evaluate(() => {
  const p = window.__systems.hud.photo;
  return { label: p.lens.label(), fov: +window.__ctx.camera.fov.toFixed(2) };
});
const cues = () => page.evaluate(() => {
  const a = window.__systems.audio; const got = [];
  const real = a.cue.bind(a); a.cue = (n) => { got.push(n); real(n); };
  window.__cues = got; return true;
});

await page.evaluate(() => window.__systems.hud.togglePhoto());
await page.waitForTimeout(1400);
console.log('F on the wide      ', JSON.stringify(await st()));
// Walk out to the tele and well up its range, then leave.
for (let i = 0; i < 30; i++) await page.keyboard.press(']');
await page.waitForTimeout(700);
console.log('walked to          ', JSON.stringify(await st()));
await page.evaluate(() => window.__systems.hud.togglePhoto());
await page.waitForTimeout(900);
await cues();
await page.evaluate(() => window.__systems.hud.togglePhoto());
await page.waitForTimeout(1400);
console.log('F again            ', JSON.stringify(await st()));
console.log('cues on entry      ', JSON.stringify(await page.evaluate(() => window.__cues)));
await b.close();
