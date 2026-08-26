// A print taken this session vanishes at the close zoom; an older one does not.
// The only difference between them is that the new one is stored at 1024.
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const j = window.__systems.hud.journal;
  const rows = [];
  for (let p = 0; p < j._pages.length; p++) {
    for (const [i, r] of (j._pages[p].spec?.rows ?? []).entries()) {
      if (!r?.done) continue;
      let patchW = null, err = null;
      try { const pt = j._pages[p].printPatch(i); patchW = pt?.canvas?.width ?? null; }
      catch (e) { err = String(e).split('\n')[0]; }
      rows.push({ id: r.id, done: !!r.done, hasPhoto: !!r.photo,
                  photoW: r.photo?.width ?? null, patchW, err });
    }
  }
  return rows;
});

// ── path A: award THIS session, then look ──────────────────────────────────
await page.evaluate(async () => {
  const store = await import('/src/game/hunt_store.js');
  localStorage.removeItem('pa.hunt');
  const make = (w) => { const c = document.createElement('canvas');
    c.width = w; c.height = Math.round(w * 9 / 16);
    const g = c.getContext('2d'); g.fillStyle = '#3a6ea5';
    g.fillRect(0, 0, c.width, c.height); return c; };
  store.hunt.award('deer', make(1024));
  await new Promise((r) => setTimeout(r, 400));
  window.__systems.hud.toggleJournal();
  await new Promise((r) => setTimeout(r, 2000));
});
console.log('awarded this session :', JSON.stringify(await probe()));

// ── path B: the same store, reloaded from disk ─────────────────────────────
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
await page.evaluate(async () => {
  window.__systems.hud.toggleJournal();
  await new Promise((r) => setTimeout(r, 2000));
});
console.log('same photo, after boot:', JSON.stringify(await probe()));
const out = {};
console.log(JSON.stringify(out, null, 1));
await b.close();
