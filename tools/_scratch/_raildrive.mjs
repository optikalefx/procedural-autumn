// Do the new visible controls actually drive anything, and do the keys still
// work now that focus lands on the zoom ring?
//
// Every control is exercised through a REAL event — a pointer drag on a slider,
// a keypress on the page — rather than by calling the handler, because the
// thing most likely to be wrong is the routing and calling the handler is
// exactly what skips it.
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
await page.waitForTimeout(2200);

const read = () => page.evaluate(() => {
  const p = window.__systems.hud.photo;
  return { focal: +p.lens.focal.toFixed(1), fStop: p.focus.fStop,
           dist: +p.focus.distance.toFixed(2), lens: p.lens.lens.id,
           grid: p.grid, focused: document.activeElement?.getAttribute('aria-label') ?? null,
           journal: window.__systems.hud.journal?.active ?? null };
});
console.log('at entry        ', JSON.stringify(await read()));

// Drag each slider by grabbing its thumb and moving right.
const drag = async (label, dx) => {
  const el = await page.$(`input[aria-label="${label}"]`);
  const box = await el.boundingBox();
  const v = await el.evaluate((n) => (+n.value - +n.min) / (+n.max - +n.min));
  // Inset from the ends. A thumb parked at the extreme right sits ON the box
  // edge, and a mousedown there lands outside the input — which is how the
  // aperture drag came back reporting "no focused control" and no change.
  const x = box.x + Math.min(box.width - 6, Math.max(6, box.width * v));
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(220);
};

await drag('Zoom', 60);
console.log('after Zoom drag ', JSON.stringify(await read()));
await drag('Aperture', -70);
console.log('after Aper drag ', JSON.stringify(await read()));
await drag('Focus', 40);
console.log('after Focus drag', JSON.stringify(await read()));

// The AF button, and the verb chips.
await page.click('button[aria-label^="Focus on the centre"]');
await page.waitForTimeout(300);
console.log('after AF        ', JSON.stringify(await read()));
await page.click('button[aria-label^="Change lens"]');
await page.waitForTimeout(300);
console.log('after Swap      ', JSON.stringify(await read()));
await page.click('button[aria-label^="Rule-of-thirds"]');
await page.waitForTimeout(300);
const g = await read();
console.log('after Grid btn  ', JSON.stringify(g),
  await page.evaluate(() => document.querySelector('.pa-cam-verb-row .pa-chip')?.classList.contains('pa-on'))
    ? ' (chip lit)' : ' (CHIP NOT LIT)');

// Keys, with focus wherever the last click left it — put it back on the rail
// first, which is the state photo mode actually opens in.
await page.evaluate(() => document.querySelector('input[aria-label="Zoom"]').focus());
await page.keyboard.press('g');
await page.waitForTimeout(250);
console.log('after G key     ', JSON.stringify(await read()));
await page.keyboard.press('j');
await page.waitForTimeout(700);
console.log('after J key     ', JSON.stringify(await read()));
await b.close();
