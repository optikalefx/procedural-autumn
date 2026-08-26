// A print taken this session vanishes at the close zoom; an older one does not.
// The only difference between them is that the new one is stored at 1024.
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
