#!/usr/bin/env node
/**
 * Frame time with nothing but sky in frame.
 *
 * The star field is a per-fragment cost over whatever part of the screen the
 * dome covers, so the honest way to price a change to it is to fill the frame
 * with dome and nothing else. gputime.mjs cannot split passes on this stack
 * (read its header), so this measures the whole frame and the pose is what
 * isolates the shader.
 *
 *   node tools/_scratch/skybench.mjs --label after --seconds 5
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); if (i === -1) return d;
  const v = argv[i + 1]; return v && !v.startsWith('--') ? v : true; };
const SECONDS = parseFloat(arg('seconds', '5'));
const LABEL = String(arg('label', 'run'));
const W = parseInt(arg('w', '1600'), 10), H = parseInt(arg('h', '900'), 10);
const AZ = parseFloat(arg('az', '0')), EL = parseFloat(arg('el', '68'));
const FOV = parseFloat(arg('fov', '52'));
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '/?seed=' + arg('seed', '20261018')
          + '&res=' + arg('res', '512');

await acquire('skybench');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
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

const out = await page.evaluate(async ({ seconds, az, elv, fov }) => {
  const THREE = window.__THREE, e = window.__engine;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
  window.__lighting.hour = 0; window.__lighting.cycleSpeed = 0;
  const pos = new THREE.Vector3(0, 300, 0);
  e.camera.fov = fov; e.camera.updateProjectionMatrix();
  e.camera.position.copy(pos);
  const a = az * Math.PI / 180, el = elv * Math.PI / 180;
  e.camera.lookAt(pos.x + Math.sin(a) * Math.cos(el) * 100,
                  pos.y + Math.sin(el) * 100,
                  pos.z + Math.cos(a) * Math.cos(el) * 100);
  window.__forceCamera = true;
  const frames = [];
  let last = performance.now(), t0 = last, warm = true;
  await new Promise((done) => {
    const tick = () => {
      const now = performance.now();
      const dt = now - last; last = now;
      if (warm && now - t0 > 2000) { warm = false; t0 = now; }
      else if (!warm) frames.push(dt);
      if (!warm && now - t0 > seconds * 1000) return done();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  frames.sort((a, b) => a - b);
  const q = (p) => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))];
  return { n: frames.length, p50: q(0.5), p95: q(0.95), mean: frames.reduce((a, b) => a + b, 0) / frames.length };
}, { seconds: SECONDS, az: AZ, elv: EL, fov: FOV });
console.log(`${LABEL.padEnd(8)} n ${out.n}  p50 ${out.p50.toFixed(2)} ms  p95 ${out.p95.toFixed(2)} ms  ` +
            `mean ${out.mean.toFixed(2)} ms  (${(1000 / out.p50).toFixed(0)} fps)`);
await browser.close();
