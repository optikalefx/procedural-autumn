// Does the stow button park the panel off the left with a tab still on screen,
// and is the button that brings it back part of that tab?
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
mkdirSync('/tmp/stow', { recursive: true });
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
for (const vp of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  const page = await b.newPage({ viewport: vp });
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
  await page.evaluate(() => window.__systems.hud.togglePhoto());
  await page.waitForTimeout(1600);
  const open = await page.evaluate(() => {
    const r = window.__systems.hud.photo.rail.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) };
  });
  if (vp.width === 1600) await page.screenshot({ path: '/tmp/stow/open.png' });
  await page.evaluate(() => window.__systems.hud.photo.toggleStow(true));
  await page.waitForTimeout(700);
  if (vp.width === 1600) await page.screenshot({ path: '/tmp/stow/stowed.png' });
  const stowed = await page.evaluate(() => {
    const p = window.__systems.hud.photo;
    const r = p.rail.getBoundingClientRect();
    const btn = p.stowBtn.getBoundingClientRect();
    return { right: Math.round(r.right), btnLeft: Math.round(btn.left),
             btnRight: Math.round(btn.right), btnOnScreen: btn.left >= 0 && btn.right <= window.innerWidth,
             dialsHidden: getComputedStyle(p.rail.querySelector('.pa-cam-desk')).opacity === '0' };
  });
  await page.evaluate(() => window.__systems.hud.photo.toggleStow(false));
  await page.waitForTimeout(700);
  const back = await page.evaluate(() => Math.round(window.__systems.hud.photo.rail.getBoundingClientRect().left));
  const ok = stowed.right > 0 && stowed.right <= 40 && stowed.btnOnScreen && stowed.dialsHidden && back === open.left;
  console.log(`${vp.width}x${vp.height}  open[${open.left},${open.right}] w${open.w}  ` +
              `stowed right=${stowed.right} btn=[${stowed.btnLeft},${stowed.btnRight}] ` +
              `dialsHidden=${stowed.dialsHidden}  restored=${back === open.left}  ${ok ? 'PASS' : 'FAIL'}`);
  await page.close();
}
await b.close();
