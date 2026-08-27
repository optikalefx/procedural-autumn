#!/usr/bin/env node
/**
 * _skyflow — the whole sky path, end to end, through the game's own shutter.
 *
 *   node tools/_scratch/_skyflow.mjs --dir /tmp/skyflow
 *
 * `_skysweep.mjs` calls `detectSubjects` directly, which proves the rule and
 * not the feature. This presses F and then P: photo mode really opens, the
 * lens really gets fitted from the camera's field of view, `capture()` really
 * runs, and the award really lands in `pa.hunt` — read out of localStorage
 * rather than out of a second copy of the store, because Vite stamps `?t=` on
 * hot-reloaded modules and a dynamic `import()` of a singleton can hand back an
 * empty second instance.
 *
 * Three shots: the Moon, Jupiter, the Great Spiral — one per sky line.
 *
 * GPU args are not optional: without them Chromium runs this game under 1 fps
 * and every state-dependent step silently reads the boot pose.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const OUT = resolve(arg('dir', '/tmp/skyflow'));
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
// `capture()` ends in an <a download>.click(); without this the click reads as
// a navigation and destroys the page context mid-test.
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
               set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, pr);
  };
});
page.on('pageerror', (e) => console.log('  [page error]', String(e)));
await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
console.log('booted');

await page.evaluate(async () => {
  const e = window.__engine;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
  window.__lighting.hour = 23.0; window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  window.__systems.hud.toast = () => {};
  localStorage.removeItem('pa.hunt');
  const a = window.__cameraAnchors.vista();
  window.__ctx.camera.position.set(a.x, window.__world.getHeight(a.x, a.z) + 40, a.z);
  await window.__settle(30);
});

for (const target of ['moon', 'jupiter', 'spiral']) {
  const res = await page.evaluate(async ({ target }) => {
    const { SKY_OBJECTS } = await import('/src/game/sky_objects.js');
    const o = SKY_OBJECTS.find((x) => x.id === target);
    const md = window.__lighting.computeMoonDir(23.0);
    const d = o.live ? md : o.dir;
    const cam = window.__ctx.camera;
    const hud = window.__systems.hud;

    // Aim and set the field of view BEFORE pressing F: `CameraRig.enterFree`
    // reads the live camera, and photo mode fits the body from that same fov —
    // which is the behaviour being exercised, not worked around.
    cam.fov = 2.9; cam.updateProjectionMatrix();
    cam.lookAt(cam.position.x + d.x * 1000, cam.position.y + d.y * 1000, cam.position.z + d.z * 1000);
    cam.updateMatrixWorld(true);
    await window.__settle(4);

    hud.photo.setActive(true);
    await window.__settle(20);
    const lens = hud.photo.lens;
    const before = Object.keys(JSON.parse(localStorage.getItem('pa.hunt') ?? '{}').items ?? {});
    const ok = hud.photo.capture();
    const rec = JSON.parse(localStorage.getItem('pa.hunt') ?? '{}');
    const items = rec.items ?? {};
    const fresh = Object.keys(items).filter((k) => !before.includes(k));
    return {
      target,
      lens: lens?.lens?.name, focal: Math.round(lens?.focal ?? 0),
      camFov: +cam.fov.toFixed(2),
      captureReturned: ok,
      newlyAwarded: fresh,
      allAwarded: Object.keys(items),
      photoBytes: fresh.length ? (items[fresh[0]]?.photo ?? '').length : 0,
      photoPrefix: fresh.length ? (items[fresh[0]]?.photo ?? '').slice(0, 22) : '',
    };
  }, { target });
  console.log(JSON.stringify(res));
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(OUT, `${target}-ceremony.png`) });
  await page.waitForTimeout(3600);
  await page.screenshot({ path: resolve(OUT, `${target}-book.png`) });
  await page.evaluate(async () => {
    const hud = window.__systems.hud;
    hud.journal?.close?.();
    await window.__settle(20);
    hud.photo.setActive(false);
    await window.__settle(20);
  });
}

// And the print itself, decoded away from the 3D book, so a black page in the
// render can be told apart from a black print in the store.
const probe = await page.evaluate(async () => {
  const rec = JSON.parse(localStorage.getItem('pa.hunt') ?? '{}');
  const out = {};
  for (const [id, v] of Object.entries(rec.items ?? {})) {
    if (!v?.photo) { out[id] = { err: 'no photo' }; continue; }
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = v.photo; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, sq = 0, peak = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; sq += l * l;
      if (l > peak) peak = l;
    }
    const n = d.length / 4, mean = sum / n;
    out[id] = { w: img.width, h: img.height, mean: +mean.toFixed(1),
                variance: +(sq / n - mean * mean).toFixed(1), peak: Math.round(peak) };
  }
  return out;
});
console.log('stored prints:', JSON.stringify(probe, null, 1));
console.log('\nwrote', OUT);
await browser.close();
