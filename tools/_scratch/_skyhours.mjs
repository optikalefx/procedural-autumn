#!/usr/bin/env node
/**
 * _skyhours — when is the sky dark enough that a planet is a photograph?
 *
 *   node tools/_scratch/_skyhours.mjs --dir /tmp/skyhours
 *
 * The companion to `_skyshots.mjs`. That one holds the hour and walks the
 * focal length; this one holds the lens at 400 mm and walks the clock, so the
 * night gate in `hunt_detect.js` is set off frames rather than off a ramp.
 *
 * Each row prints the two scalars the sky's own draw gates are built from —
 * `starAmount` (the planets and galaxies are drawn inside `starVis =
 * starAmount^3 * darkGuard`) and `moonIntensity` (the moon has its own) — next
 * to the cloud deck's live coverage, so the "is it overcast" question is
 * answered on the same table.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SKY_OBJECTS } from '../../src/game/sky_objects.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const OUT = resolve(arg('dir', '/tmp/skyhours'));
const FOV = parseFloat(arg('fov', '2.9'));
const SEED = arg('seed', '20261018');
mkdirSync(OUT, { recursive: true });

const HOURS = [];
for (let h = 18.0; h <= 22.01; h += 0.25) HOURS.push(+h.toFixed(2));

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
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
page.on('pageerror', (e) => console.log('  [page error]', String(e)));
await page.goto(`${URL}/?seed=${SEED}&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
console.log('booted');

await page.evaluate(() => {
  const e = window.__engine;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
  window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  window.__ctx.worldPaused = true;
  const hudRoot = window.__systems.hud?.root;
  if (hudRoot) hudRoot.style.display = 'none';
  const a = window.__cameraAnchors.vista();
  window.__ctx.camera.position.set(a.x, window.__world.getHeight(a.x, a.z) + 40, a.z);
});

const want = ['jupiter', 'spiral', 'moon'];
const rows = [];
for (const h of HOURS) {
  const s = await page.evaluate(async ({ h }) => {
    window.__lighting.hour = h;
    await window.__settle(8);
    const u = window.__sky.uniforms;
    const md = window.__lighting.computeMoonDir(h);
    return {
      starAmount: u.uStarAmount.value,
      moonDiscI: u.uMoonDiscI.value,
      cover: window.__systems.clouds?.uniforms?.uCover?.value ?? -1,
      moonDir: [md.x, md.y, md.z],
    };
  }, { h });
  rows.push({ hour: h, ...s });
  console.log(`h ${String(h).padStart(5)}  starAmt ${s.starAmount.toFixed(4)}  star^3 ${(s.starAmount ** 3).toFixed(4)}` +
              `  moonDiscI ${s.moonDiscI.toFixed(4)}  uCover ${s.cover.toFixed(4)}  moonY ${s.moonDir[1].toFixed(3)}`);
  for (const id of want) {
    const o = SKY_OBJECTS.find((x) => x.id === id);
    const dir = o.live ? s.moonDir : [o.dir.x, o.dir.y, o.dir.z];
    await page.evaluate(async ({ dir, fov }) => {
      const cam = window.__ctx.camera;
      cam.fov = fov; cam.updateProjectionMatrix();
      cam.lookAt(cam.position.x + dir[0] * 1000, cam.position.y + dir[1] * 1000, cam.position.z + dir[2] * 1000);
      cam.updateMatrixWorld(true);
      await window.__settle(4);
    }, { dir, fov: FOV });
    await page.screenshot({ path: resolve(OUT, `${id}-h${String(h).replace('.', '_')}.png`) });
  }
}
writeFileSync(resolve(OUT, 'rows.json'), JSON.stringify(rows, null, 1));
console.log('\nwrote', OUT);
await browser.close();
