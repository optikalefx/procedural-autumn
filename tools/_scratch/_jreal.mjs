// The user's own path, keys and clicks only, nothing called by hand.
//
//   F  -> photo mode (which PINS the render resolution and stays active under
//         the book, so this is a different renderer state from calling
//         `hud.photo.capture()` out of nowhere)
//   P  -> the shutter; the ceremony opens the book on the new line
//   J  -> shut it
//   J  -> open it again, cold, with no award
//   clicks to leaf to the award's spread, then click the print, then again
//
// The point is that everything after the ceremony goes through `open()` with NO
// award, which is the branch a player reaches by looking at the book later —
// and it is not the branch a one-shot harness exercises.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const OUT = process.env.OUT ?? '/tmp/jreal';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
});
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('POSTHOG')) console.log('  [page error]', t);
  if (t.startsWith('[probe]')) console.log(' ', t);
});
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).split('\n')[0]));

await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
await page.evaluate(() => { window.__systems.hud.toast = () => {}; localStorage.removeItem('pa.hunt'); });

const state = () => page.evaluate(() => {
  const j = window.__systems.hud.journal;
  const rows = [];
  for (let p = 0; p < j._pages.length; p++)
    for (const [i, r] of (j._pages[p].spec?.rows ?? []).entries()) {
      if (!r?.done) continue;
      let patchW = null, err = null;
      try { patchW = j._pages[p].printPatch(i)?.canvas?.width ?? null; }
      catch (e) { err = String(e).split('\n')[0]; }
      rows.push({ seat: `${p}:${i}`, id: r.id, photo: !!r.photo, hidden: !!r.hidePrint, patchW, err });
    }
  return { active: j.active, leaf: +(j._pose?.leaf ?? -1).toFixed(2), zoom: j.zoomLevel,
           detailFor: j._detailFor ?? null, detailHidden: j._detailHidden ?? null,
           detailVis: !!j._detail?.visible, rows };
});

// stand at a waterfall
console.log('posed:', JSON.stringify(await page.evaluate(async () => {
  const { detectSubjects } = await import('/src/game/hunt_detect.js');
  const cam = window.__ctx.camera;
  window.__forceCamera = true; window.__hudForce = true;
  const falls = window.__ctx.world?.waterfalls ?? [];
  for (let f = 0; f < Math.min(falls.length, 6); f++) {
    const wf = falls[f];
    const mid = [(wf.top[0] + wf.bottom[0]) / 2, (wf.top[1] + wf.bottom[1]) / 2,
                 (wf.top[2] + wf.bottom[2]) / 2];
    for (const r of [50, 90, 150]) for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      cam.position.set(mid[0] + Math.sin(ang) * r, mid[1] + r * 0.25, mid[2] + Math.cos(ang) * r);
      cam.lookAt(mid[0], mid[1], mid[2]); cam.updateMatrixWorld(true);
      if (detectSubjects(window.__ctx).includes('waterfall')) return { fall: f, radius: r };
    }
  }
  return { none: true };
})));
await page.waitForTimeout(3500);

await page.keyboard.press('f');            // photo mode
await page.waitForTimeout(1500);
console.log('photo mode:', await page.evaluate(() => window.__systems.hud.photo.active),
            'pixelRatio', await page.evaluate(() => window.__ctx.renderer?.getPixelRatio?.() ?? null));
await page.keyboard.press('p');            // the shutter
await page.waitForTimeout(7000);
await page.screenshot({ path: `${OUT}/a_ceremony.png` });
console.log('after the ceremony:', JSON.stringify(await state()));

await page.keyboard.press('j');            // shut it
await page.waitForTimeout(1200);
await page.keyboard.press('j');            // and open it cold
await page.waitForTimeout(2500);
console.log('reopened cold  :', JSON.stringify(await state()));

// leaf forward until the award's print is pickable
for (let n = 0; n < 6; n++) {
  const seat = await page.evaluate(() => {
    const j = window.__systems.hud.journal;
    for (let y = 0.1; y < 0.95; y += 0.01)
      for (let x = 0.03; x < 0.97; x += 0.01) {
        const cx = Math.round(x * window.innerWidth), cy = Math.round(y * window.innerHeight);
        const s = j._rowAt(cx, cy);
        if (s) return { cx, cy, ...s };
      }
    return null;
  });
  if (seat) {
    console.log('print pickable at:', JSON.stringify(seat), 'after', n, 'turns');
    // Rest on it first: the hover is what arms the detail patch now.
    await page.mouse.move(seat.cx, seat.cy);
    await page.waitForTimeout(400);
    await page.mouse.click(seat.cx, seat.cy);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/c_close.png` });
    console.log('close:', JSON.stringify(await state()));
    // The ladder, one rung at a time: Escape out of the close look leaves the
    // book OPEN at the spread, and a second Escape shuts it. Two rungs now,
    // where there were three.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(900);
    const l1 = await state();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(900);
    const l2 = await state();
    console.log('ladder: Escape ->', `zoom ${l1.zoom} active ${l1.active}`,
                '| Escape ->', `active ${l2.active}`);
    break;
  }
  await page.mouse.click(Math.round(1600 * 0.8), 450);   // turn the page
  await page.waitForTimeout(1100);
}

await browser.close();
