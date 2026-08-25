// End-to-end: paste wader-console.js exactly as the player would, call it for
// each species, and screenshot the resulting view. No forced camera — this is
// the real gameplay frame.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
await acquire('probe');

const OUT = process.argv[2] ?? '/tmp/waders';
const SRC = readFileSync(new URL('./wader-console.js', import.meta.url), 'utf8');

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
p.on('pageerror', (e) => console.log('ERR', e.message));
p.on('console', (m) => { if (m.type() !== 'debug') console.log('  [page]', m.text()); });
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
        removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await p.goto(process.env.AUTUMN_URL || 'http://localhost:5199');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 300 });

await p.evaluate(SRC);              // the paste

for (const key of ['flamingo', 'heron']) {
  const r = await p.evaluate((k) => {
    const res = window.__waders(k);
    return res && { site: res.site, landed: res.landed, placed: res.placed };
  }, key);
  if (!r) { console.log(`${key}: helper returned null`); continue; }
  // let the warp settle and the birds pose
  await p.waitForTimeout(3000);
  const seen = await p.evaluate((k) => {
    const tb = window.__ctx.systems.wildlife.treeBirds;
    const c = window.__ctx.camera.position;
    return tb.debugList().filter((v) => v.key === k)
      .map((v) => Math.round(Math.hypot(v.x - c.x, v.z - c.z))).sort((a, z) => a - z);
  }, key);
  console.log(`${key}: placed ${r.placed}, now at ${seen.join(', ')} m from camera`);
  await p.screenshot({ path: `${OUT}/console-${key}.png` });
  console.log(`  -> ${OUT}/console-${key}.png`);
}
await b.close();
