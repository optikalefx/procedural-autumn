// Where does _overBook say "the book" is? Sample a grid and draw the mask over
// the real frame, so the answer can be compared with where the book LOOKS.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
mkdirSync('/tmp/bookmask', { recursive: true });
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
await page.screenshot({ path: '/tmp/bookmask/frame.png' });

const grid = await page.evaluate(() => {
  const j = window.__systems.hud.journal;
  const W = window.innerWidth, H = window.innerHeight, S = 16;
  const rows = [];
  for (let y = 0; y < H; y += S) {
    let line = '';
    for (let x = 0; x < W; x += S) line += j._overBook(x, y) ? '#' : '.';
    rows.push(line);
  }
  return { rows, hits: rows.join('').split('#').length - 1,
           total: rows.join('').length,
           thrown: (() => { try { j._overBook(10, 10); return null; } catch (e) { return String(e); } })(),
           hasTHREE: !!(j.ctx?.THREE || globalThis.__THREE) };
});
console.log(`THREE reachable: ${grid.hasTHREE}   throw: ${grid.thrown}`);
console.log(`hits ${grid.hits} of ${grid.total} samples (${(100 * grid.hits / grid.total).toFixed(1)}%)\n`);
for (const r of grid.rows) console.log(r);
await b.close();
