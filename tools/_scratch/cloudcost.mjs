// Frame cost of the cloud dome, measured as a DIFFERENCE against itself.
//
// perf.mjs reports absolute frame time, and on a machine running three other
// authors' headless captures that number is noise. Toggling one mesh on and off
// inside one session, alternating so any drift in machine load falls on both
// arms equally, gives a delta that survives the contention.
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:5180';
const HOUR = Number(process.argv[3] ?? 19);
const REPS = Number(process.argv[4] ?? 6);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, p) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, p);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await page.goto(URL + '?res=640', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 600000, polling: 250 });
await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, HOUR);
// Pitch up so the deck fills the frame — worst case for a sky shader.
await page.evaluate(() => {
  const c = window.__ctx.camera;
  window.__forceCamera = true;
  c.rotation.x = 0.55;
});

const sample = (vis, frames) => page.evaluate(async ({ vis, frames }) => {
  const sys = Object.values(window.__systems).find((s) => s?.name === 'Clouds');
  sys.mesh.visible = vis;
  const ts = [];
  await new Promise((res) => {
    let n = 0, last = performance.now();
    const tick = () => {
      const t = performance.now();
      if (n > 8) ts.push(t - last);      // discard the warm-up
      last = t; n++;
      if (n < frames) requestAnimationFrame(tick); else res();
    };
    requestAnimationFrame(tick);
  });
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)];
}, { vis, frames });

const on = [], off = [];
for (let i = 0; i < REPS; i++) {
  on.push(await sample(true, 90));
  off.push(await sample(false, 90));
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
console.log(`hour ${HOUR}, camera pitched up so the deck fills the frame`);
console.log(`  clouds ON   median frame ${med(on).toFixed(2)} ms   [${on.map((v) => v.toFixed(1)).join(' ')}]`);
console.log(`  clouds OFF  median frame ${med(off).toFixed(2)} ms   [${off.map((v) => v.toFixed(1)).join(' ')}]`);
console.log(`  deck costs  ${(med(on) - med(off)).toFixed(2)} ms  (${(100 * (med(on) / med(off) - 1)).toFixed(1)}%)`);
await browser.close();
