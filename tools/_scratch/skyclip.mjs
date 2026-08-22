#!/usr/bin/env node
/**
 * Sky clipping hunt.
 *
 * Pans the night sky from one page load and writes a frame per pose, so a hard
 * edge cutting a star's halo can be found and located rather than guessed at.
 *
 *   node tools/_scratch/skyclip.mjs --dir shots/skyclip --hour 0
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); if (i === -1) return d;
  const v = argv[i + 1]; return v && !v.startsWith('--') ? v : true; };

const DIR = String(arg('dir', 'shots/skyclip'));
const W = parseInt(arg('w', '1134'), 10), H = parseInt(arg('h', '912'), 10);
const HOUR = parseFloat(arg('hour', '0'));
const FOV = parseFloat(arg('fov', '50'));
const YAWS = String(arg('yaws', '0,45,90,135,180,225,270,315')).split(',').map(Number);
const PITCHES = String(arg('pitches', '25,45,65')).split(',').map(Number);
// --aims az,el;az,el  aims at explicit directions instead of the yaw x pitch grid.
const AIMS = typeof arg('aims') === 'string'
  ? String(arg('aims')).split(';').map((s) => s.split(',').map(Number)) : null;
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '/?seed=' + arg('seed', '20261018')
          + '&res=' + arg('res', '512');

await acquire('skyclip');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
// Neuter Vite's HMR client, exactly as shot.mjs does: an edit landing mid-run
// reloads the page and the capture comes back as the title screen at the
// default hour, which reads as "the fix did nothing".
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
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate((hour) => {
  const e = window.__engine;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
  window.__lighting.hour = hour;
  window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
}, HOUR);

mkdirSync(resolve(DIR), { recursive: true });
const poses = AIMS ?? PITCHES.flatMap((pitch) => YAWS.map((yaw) => [yaw, pitch]));
for (const [yaw, pitch] of poses) {
  {
    await page.evaluate(async ({ yaw, pitch, fov, hour }) => {
      const THREE = window.__THREE, e = window.__engine;
      // Re-assert the clock every pose. Something in the boot sequence walks it
      // for the first few seconds, and a frame taken during that walk comes back
      // at twilight with the title still up.
      window.__lighting.hour = hour;
      window.__lighting.cycleSpeed = 0;
      const y = yaw * Math.PI / 180, p = pitch * Math.PI / 180;
      const pos = new THREE.Vector3(0, 300, 0);
      e.camera.fov = fov; e.camera.updateProjectionMatrix();
      e.camera.position.copy(pos);
      e.camera.lookAt(pos.x + Math.sin(y) * Math.cos(p) * 100,
                      pos.y + Math.sin(p) * 100,
                      pos.z + Math.cos(y) * Math.cos(p) * 100);
      window.__forceCamera = true;
      if (window.__settle) await window.__settle(8);
    }, { yaw, pitch, fov: FOV, hour: HOUR });
    await page.waitForTimeout(900);
    const st = await page.evaluate(() => ({ hour: window.__lighting.hour,
      sunY: +window.__lighting.sunDir.y.toFixed(3) }));
    const out = `${DIR}/p${pitch}_y${yaw}.png`;
    console.log('  hour', st.hour, 'sunY', st.sunY);
    await page.screenshot({ path: out });
    console.log(out);
  }
}
await browser.close();
