// Photograph something that is already in the book, and choose which print to
// keep.
//
// Both prints are REAL — the shutter is fired twice, at two different vantages
// of the same waterfall, with a reload in between so the second one is not
// swallowed by `hunt.award` returning false. That matters more here than
// anywhere else in the journal's harnesses: the whole feature is "can you tell
// these two apart and pick one", and two copies of the same placeholder would
// pass a test the player would fail.
//
// The compare is driven through `hud.openJournal({ id, photoDataURL, replace })`,
// which is the integrator call `hud_photo` makes — so the store is never
// touched from an evaluate (JOURNAL_NOTES 13.4's first trap).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const OUT = process.env.OUT ?? '/tmp/jreplace';
const KEEP = process.env.KEEP ?? 'new';        // new | old | escape
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
page.on('console', (m) => { const t = m.text();
  if (m.type() === 'error' && !t.includes('POSTHOG')) console.log('  [page error]', t); });
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).split('\n')[0]));

const boot = async () => {
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
  await page.evaluate(() => { window.__systems.hud.toast = () => {}; });
};

/** Stand at waterfall `want`, at vantage `pick`, and check the detector agrees. */
const poseAt = (pick) => page.evaluate(async (p) => {
  const { detectSubjects } = await import('/src/game/hunt_detect.js');
  const cam = window.__ctx.camera;
  window.__forceCamera = true; window.__hudForce = true;
  const falls = window.__ctx.world?.waterfalls ?? [];
  const hits = [];
  for (let f = 0; f < Math.min(falls.length, 6); f++) {
    const wf = falls[f];
    const mid = [(wf.top[0] + wf.bottom[0]) / 2, (wf.top[1] + wf.bottom[1]) / 2,
                 (wf.top[2] + wf.bottom[2]) / 2];
    for (const r of [50, 90, 150]) for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      cam.position.set(mid[0] + Math.sin(ang) * r, mid[1] + r * 0.25, mid[2] + Math.cos(ang) * r);
      cam.lookAt(mid[0], mid[1], mid[2]); cam.updateMatrixWorld(true);
      if (detectSubjects(window.__ctx).includes('waterfall')) {
        hits.push({ f, r, a });
        if (hits.length > p) return hits[p];
      }
    }
  }
  return hits[0] ?? { none: true };
}, pick);

const shoot = async (pick) => {
  console.log('  posed:', JSON.stringify(await poseAt(pick)));
  await page.waitForTimeout(3500);
  await page.evaluate(() => window.__systems.hud.photo.capture());
  await page.waitForTimeout(1500);
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem('pa.hunt') ?? '{}').items?.waterfall?.photo ?? null);
};

// ── print A ─────────────────────────────────────────────────────────────────
await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await boot();
await page.evaluate(() => localStorage.removeItem('pa.hunt'));
console.log('print A:');
const A = await shoot(0);
console.log('   ', (A ?? '').length, 'chars');

// ── print B, from a different vantage, after a reload ───────────────────────
await page.evaluate(() => localStorage.removeItem('pa.hunt'));
await page.reload({ waitUntil: 'domcontentloaded' });
await boot();
console.log('print B:');
const B = await shoot(3);
console.log('   ', (B ?? '').length, 'chars');
if (!A || !B || A === B) { console.log('FAIL — need two different prints'); await browser.close(); process.exit(1); }

// ── put A back in the book, then offer B ────────────────────────────────────
await page.evaluate((a) => {
  localStorage.setItem('pa.hunt', JSON.stringify({
    v: 1, items: { waterfall: { at: Date.now() - 86400000, photo: a } } }));
}, A);
await page.reload({ waitUntil: 'domcontentloaded' });
await boot();

const state = () => page.evaluate(() => {
  const j = window.__systems.hud.journal;
  const C = j._cmp;
  const rec = JSON.parse(localStorage.getItem('pa.hunt') ?? '{}');
  return {
    comparing: j.comparing, up: !!C?.up, hover: C?.hover ?? null,
    chosen: C?.chosen ?? null, zoom: j.zoomLevel,
    leaf: +(j._pose?.leaf ?? -1).toFixed(2), backTo: j._backTo ?? null,
    quads: (j._cmpQuad ?? []).map((m) => !!m?.visible),
    storedBytes: (rec.items?.waterfall?.photo ?? '').length,
  };
});

console.log('\nopening the compare…');
// CANVAS=1 hands the journal the shutter's own scratch CANVAS instead of a data
// URL, which is the shape the wiring in `hud_photo` actually uses — `open()`
// has to turn it into a string synchronously, before the first await, because
// that canvas is reused on the next shutter press.
if (process.env.CANVAS) {
  await page.evaluate(async (b) => {
    const im = new Image();
    await new Promise((r) => { im.onload = r; im.onerror = r; im.src = b; });
    const c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    c.getContext('2d').drawImage(im, 0, 0);
    window.__systems.hud.openJournal({ id: 'waterfall', photo: c, replace: true });
  }, B);
} else await page.evaluate((b) => {
  window.__systems.hud.openJournal({ id: 'waterfall', photoDataURL: b, replace: true });
}, B);
await page.waitForTimeout(9000);
await page.screenshot({ path: `${OUT}/a_compare.png` });
console.log('arrived:', JSON.stringify(await state()));

// Where the two prints are on screen, asked of the journal's own picker.
const pointFor = (k) => page.evaluate((k2) => {
  const j = window.__systems.hud.journal;
  for (let y = 0.05; y < 0.98; y += 0.01)
    for (let x = 0.02; x < 0.98; x += 0.01) {
      const cx = Math.round(x * window.innerWidth), cy = Math.round(y * window.innerHeight);
      if (j._cmpAt(cx, cy) === k2) return { cx, cy };
    }
  return null;
}, k);

const pOld = await pointFor(0), pNew = await pointFor(1);
console.log('old print at', JSON.stringify(pOld), ' new print at', JSON.stringify(pNew));
if (!pOld || !pNew) { console.log('FAIL — a print is not pickable'); await browser.close(); process.exit(1); }

await page.mouse.move(pOld.cx, pOld.cy);
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/b_hover_old.png` });
console.log('hover old :', JSON.stringify(await state()));

await page.mouse.move(pNew.cx, pNew.cy);
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/c_hover_new.png` });
console.log('hover new :', JSON.stringify(await state()));

if (KEEP === 'escape') {
  await page.keyboard.press('Escape');
} else {
  const p = KEEP === 'new' ? pNew : pOld;
  await page.mouse.click(p.cx, p.cy);
  await page.waitForTimeout(280);
  await page.screenshot({ path: `${OUT}/d_slap.png` });
  console.log('mid-slap  :', JSON.stringify(await state()));
}
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}/e_after.png` });
console.log('after     :', JSON.stringify(await state()));

const verdict = await page.evaluate(([a, b]) => {
  const rec = JSON.parse(localStorage.getItem('pa.hunt') ?? '{}');
  const url = rec.items?.waterfall?.photo ?? '';
  const j = window.__systems.hud.journal;
  const notes = j._pages.find((p) => p.spec.kind === 'notes');
  return {
    // With CANVAS=1 the journal re-encodes the canvas through `makeThumb`, so
    // the stored string is a second JPEG of B rather than B itself — the same
    // picture, different bytes. Length is the honest test there.
    stored: url === a ? 'A (the old one)' : url === b ? 'B (the new one)'
      : url.length === a.length ? 'A (same length)'
        : `re-encoded, ${url.length} chars (A is ${a.length}, B is ${b.length})`,
    notesLeafRestored: !notes?.spec?.compare,
    rowPhotoW: j._pages[4]?.spec?.rows?.[0]?.photo?.width ?? null,
  };
}, [A, B]);
console.log('verdict   :', JSON.stringify(verdict));

await browser.close();
