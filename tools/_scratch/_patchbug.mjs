// A print taken THIS SESSION at the close zoom.
//
// The first version of this harness awarded through `await
// import('/src/game/hunt_store.js')` inside a page evaluate, which is the trap
// this repo's notes warn about: Vite stamps `?t=` on hot-reloaded modules, so
// the import hands back a SECOND instance of the singleton and the award lands
// in a store the game is not holding. It reported the bug as unfixed after it
// had been fixed. Award through the real shutter, like _huntflow.mjs.
//
// ⚠ THIS HARNESS DOES NOT MEASURE THAT, AND ITS FIRST LINE OF OUTPUT IS AN
// ARTIFACT OF ITSELF. `store.hunt.award(...)` below reaches the store through a
// dynamic `import()` from inside an evaluate — the exact trap JOURNAL_NOTES 13.4
// documents — so on a tree Vite has hot-reloaded it awards into a SECOND
// instance of the singleton. The journal, reading the first, sees nothing done
// and reports `[]`; the reload then finds the row because the second instance
// did write `pa.hunt` to disk. So "the row is empty until a reload" is this
// file, not the product: driven through the real shutter the row comes back
// `{done, hasPhoto, photoW: 1024, patchW: 1825}` with no reload at all.
//
// The real bug was the detail patch's ORIENTATION on a left-hand leaf — see
// JOURNAL_NOTES 15.1 and `_jsweep.mjs`, which drives awards through
// `hud.openJournal` so the store is never touched from an evaluate.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const context = await b.newContext({ viewport: { width: 1600, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).split('\n')[0]));
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

const probe = () => page.evaluate(async () => {
  const j = window.__systems.hud.journal;
  const rows = [];
  for (let p = 0; p < j._pages.length; p++) {
    for (const [i, r] of (j._pages[p].spec?.rows ?? []).entries()) {
      if (!r?.done) continue;
      let patchW = null, err = null;
      try { const pt = j._pages[p].printPatch(i); patchW = pt?.canvas?.width ?? null; }
      catch (e) { err = String(e).split('\n')[0]; }
      rows.push({ page: p, id: r.id, hasPhoto: !!r.photo,
                  photoW: r.photo?.width ?? null, patchW, err });
    }
  }
  return rows;
});

// Pose at a waterfall and fire the real shutter — the same path _huntflow uses.
await page.evaluate(async () => {
  localStorage.removeItem('pa.hunt');
  const cam = window.__ctx.camera;
  window.__forceCamera = true; window.__hudForce = true;
  const { detectSubjects } = await import('/src/game/hunt_detect.js');
  const falls = window.__ctx.world?.waterfalls ?? [];
  for (let f = 0; f < Math.min(falls.length, 6); f++) {
    const wf = falls[f];
    const mid = [(wf.top[0] + wf.bottom[0]) / 2, (wf.top[1] + wf.bottom[1]) / 2,
                 (wf.top[2] + wf.bottom[2]) / 2];
    for (const r of [50, 90, 150]) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        cam.position.set(mid[0] + Math.sin(ang) * r, mid[1] + r * 0.25, mid[2] + Math.cos(ang) * r);
        cam.lookAt(mid[0], mid[1], mid[2]); cam.updateMatrixWorld(true);
        if (detectSubjects(window.__ctx).includes('waterfall')) return;
      }
    }
  }
});
await page.waitForTimeout(3000);
await page.evaluate(() => { window.__systems.hud.toast = () => {}; window.__systems.hud.photo.capture(); });
await page.waitForTimeout(4500);
console.log('awarded this session, no reload:', JSON.stringify(await probe()));

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
await page.keyboard.press('j');
await page.waitForTimeout(2500);
console.log('the same print, after boot :', JSON.stringify(await probe()));
await b.close();
