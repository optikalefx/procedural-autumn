// Dragging beside the book moves the camera; dragging ON the book must not —
// and must not turn a page on release either.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} }; }
    return new R(u, p); };
});
await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
await page.keyboard.press('j');
await page.waitForTimeout(2500);

const state = () => page.evaluate(() => {
  const j = window.__systems.hud.journal;
  return { yaw: +(j._pan?.yaw ?? 0).toFixed(4), pitch: +(j._pan?.pitch ?? 0).toFixed(4),
           x: +(j._pan?.x ?? 0).toFixed(4), leaf: j._pose?.leaf ?? null };
});
// Where is the book on screen, and where is empty table?
const spots = await page.evaluate(() => {
  const j = window.__systems.hud.journal;
  const hit = (x, y) => j._overBook(x, y);
  let on = null, off = null;
  for (let y = 200; y < 800 && (!on || !off); y += 25)
    for (let x = 200; x < 1400; x += 25) {
      if (!on && hit(x, y)) on = { x, y };
      if (!off && !hit(x, y)) off = { x, y };
    }
  return { on, off };
});
console.log('a point on the book:', JSON.stringify(spots.on), ' beside it:', JSON.stringify(spots.off));

const drag = async (p) => {
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(p.x + i * 12, p.y + i * 5);
  await page.mouse.up();
  await page.waitForTimeout(500);
};
const a = await state();
await drag(spots.off);
const afterOff = await state();
await page.evaluate(() => window.__systems.hud.journal.panHome());
await page.waitForTimeout(700);
const home = await state();
await drag(spots.on);
const afterOn = await state();

const moved = (p, q) => Math.abs(p.yaw - q.yaw) + Math.abs(p.pitch - q.pitch) + Math.abs(p.x - q.x);
console.log(`drag BESIDE the book -> camera moved by ${moved(a, afterOff).toFixed(4)}`);
console.log(`drag ON the book     -> camera moved by ${moved(home, afterOn).toFixed(4)}, leaf ${home.leaf} -> ${afterOn.leaf}`);
console.log(moved(a, afterOff) > 0.02 && moved(home, afterOn) < 0.001 && home.leaf === afterOn.leaf
  ? 'PASS - outside drives the camera, inside does not, and no page turned'
  : 'FAIL');
await b.close();
