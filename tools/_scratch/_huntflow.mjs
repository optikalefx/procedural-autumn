// End-to-end check of the scavenger-hunt shutter path:
//   photo mode -> capture() -> detectSubjects -> hunt.award -> journal opens
// and, the question that matters, whether the print taped into the book is a
// REAL photograph or a black rectangle.
//
// GPU args are not optional: without them Chromium runs this game under 1 fps
// and every state-dependent step silently reads the boot pose.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const OUT = '/tmp/huntflow';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization'],
});
// `capture()` ends in an <a download>.click(). Without this the click reads as
// a navigation and destroys the page context mid-test.
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, acceptDownloads: true });
const page = await context.newPage();

// Neuter Vite's HMR client before any page script runs — the same stub
// tools/shot.mjs uses, and for the same reason. Other agents are editing this
// tree right now; a peer saving a file mid-run reloads the page and this test
// dies with "Execution context was destroyed". Cost me two runs before I put
// it in, which is exactly what shot.mjs's comment warns about.
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {},
               addEventListener() {}, removeEventListener() {},
               set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
});
page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()); });

await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
console.log('booted');

// Stand at a waterfall: the most reliable subject in the valley (320 m reach).
// Find a vantage the detector actually accepts, rather than assuming one.
const posed = await page.evaluate(async () => {
  const { detectSubjects } = await import('/src/game/hunt_detect.js');
  const cam = window.__ctx.camera;
  window.__forceCamera = true;
  window.__hudForce = true;
  const falls = window.__ctx.world?.waterfalls ?? [];
  const tried = [];
  for (let f = 0; f < Math.min(falls.length, 6); f++) {
    const wf = falls[f];
    const mid = [ (wf.top[0] + wf.bottom[0]) / 2,
                  (wf.top[1] + wf.bottom[1]) / 2,
                  (wf.top[2] + wf.bottom[2]) / 2 ];
    for (const r of [50, 90, 150]) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        cam.position.set(mid[0] + Math.sin(ang) * r, mid[1] + r * 0.25, mid[2] + Math.cos(ang) * r);
        cam.lookAt(mid[0], mid[1], mid[2]);
        cam.updateMatrixWorld(true);
        const hit = detectSubjects(window.__ctx);
        tried.push(hit.length);
        if (hit.includes('waterfall')) {
          return { fall: f, radius: r, angle: a, cam: cam.position.toArray(), hit };
        }
      }
    }
  }
  return { none: true, falls: falls.length, tried: tried.length };
});
await page.waitForTimeout(4000);

// Clear any previous run, then fire the real shutter path.
const result = await page.evaluate(async () => {
  const hud = window.__systems.hud;
  hud.toast = () => {};
  // Read the STORE THROUGH localStorage, not through a fresh dynamic import.
  // Vite stamps `?t=` on modules it has hot-reloaded, so `import(...)` from here
  // can hand back a SECOND instance of what is supposed to be a singleton — an
  // empty one. That cost a confusing run where the journal visibly opened while
  // the store this test was holding reported nothing awarded.
  localStorage.removeItem('pa.hunt');
  const { detectSubjects } = await import('/src/game/hunt_detect.js');
  const seen = detectSubjects(window.__ctx);
  const ok = hud.photo.capture();
  const raw = localStorage.getItem('pa.hunt');
  const rec = raw ? JSON.parse(raw) : null;
  const items = rec?.items ?? {};
  const first = Object.keys(items)[0] ?? null;
  return {
    detected: seen,
    captureReturned: ok,
    awardedIds: Object.keys(items),
    photoPrefix: (items[first]?.photo ?? '').slice(0, 22),
    photoBytes: (items[first]?.photo ?? '').length,
    journalActive: hud.journal.active,
  };
});
console.log('result:', JSON.stringify(result, null, 1));

// Let the ceremony play, then look at the book.
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/ceremony-mid.png` });
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}/ceremony-done.png` });

// And decode the stored thumbnail on its own, away from the 3D book, so a
// black print in the render can be told apart from a black print in the store.
const probe = await page.evaluate(async () => {
  const rec = JSON.parse(localStorage.getItem('pa.hunt') ?? '{}');
  const url = Object.values(rec.items ?? {})[0]?.photo;
  if (!url) return { err: 'no photo stored' };
  const img = new Image();
  await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = url; });
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let sum = 0, sq = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; sq += l * l;
  }
  const n = d.length / 4, mean = sum / n;
  return { w: img.width, h: img.height, mean: +mean.toFixed(1),
           variance: +(sq / n - mean * mean).toFixed(1) };
});
console.log('stored thumbnail:', JSON.stringify(probe));
console.log(probe.mean > 6 && probe.variance > 4
  ? 'PASS — the stored print is a real photograph'
  : 'FAIL — the stored print is black or flat');

await browser.close();
