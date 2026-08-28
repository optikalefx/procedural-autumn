// The four gestures, each doing exactly one thing:
//   swipe right on the book  -> next spread
//   swipe left  on the book  -> previous spread
//   click on the book        -> nothing moves
//   click / drag outside     -> camera only, never a page turn
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

const st = () => page.evaluate(() => {
  const j = window.__systems.hud.journal;
  return { leaf: Math.round(j._pose.leaf),
           pose: +((j._pan?.yaw ?? 0) + (j._pan?.pitch ?? 0) + (j._pan?.x ?? 0)).toFixed(4) };
});
const spots = await page.evaluate(() => {
  const j = window.__systems.hud.journal;
  // A point on the book that is NOT a print, and a point out on the table.
  let on = null, off = null;
  for (let y = 250; y < 700 && !on; y += 20)
    for (let x = 600; x < 1000; x += 20)
      if (j._overBook(x, y) && !j._rowAt(x, y)) { on = { x, y }; break; }
  for (let y = 100; y < 800 && !off; y += 20)
    for (let x = 40; x < 300; x += 20) if (!j._overBook(x, y)) { off = { x, y }; break; }
  return { on, off };
});
const swipe = async (p, dx) => {
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(p.x + (dx / 10) * i, p.y + 3);
  await page.mouse.up(); await page.waitForTimeout(900);
};
const click = async (p) => { await page.mouse.move(p.x, p.y); await page.mouse.down();
  await page.mouse.up(); await page.waitForTimeout(700); };

const a = await st();
await swipe(spots.on, -240); const afterLeft = await st();   // drag left = forward
await swipe(spots.on, 240);  const afterRight = await st();  // drag right = back
const beforeClick = await st();
await click(spots.on);       const afterClickOn = await st();
await click(spots.off);      const afterClickOff = await st();
await swipe(spots.off, 240); const afterDragOff = await st();

console.log(`start                 leaf ${a.leaf}`);
console.log(`swipe LEFT  on book   leaf ${afterLeft.leaf}  (want ${a.leaf + 1})`);
console.log(`swipe RIGHT on book   leaf ${afterRight.leaf}  (want ${a.leaf})`);
console.log(`click on book         leaf ${afterClickOn.leaf}, pose moved ${(afterClickOn.pose - beforeClick.pose).toFixed(4)}`);
console.log(`click outside         leaf ${afterClickOff.leaf}`);
console.log(`drag outside          leaf ${afterDragOff.leaf}, pose moved ${(afterDragOff.pose - afterClickOff.pose).toFixed(4)}`);
const ok = afterLeft.leaf === a.leaf + 1 && afterRight.leaf === a.leaf
  && afterClickOn.leaf === beforeClick.leaf && Math.abs(afterClickOn.pose - beforeClick.pose) < 1e-3
  && afterClickOff.leaf === afterClickOn.leaf
  && afterDragOff.leaf === afterClickOff.leaf && Math.abs(afterDragOff.pose - afterClickOff.pose) > 0.02;
console.log(ok ? '\nPASS - all four gestures do exactly one thing' : '\nFAIL');
await b.close();
