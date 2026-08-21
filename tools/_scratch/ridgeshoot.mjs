import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/ridge');
const IDS = arg('ids', 'prop:camp_tent_ridge.js:buildRidgeTent:timberline').split(',');
const ANG = arg('ang', '0.75,2.05,3.35,4.9').split(',').map(Number);
const PITCH = parseFloat(arg('pitch', '0.24'));
mkdirSync(DIR, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
// Several of us share one dev server; every save reloads the page and detaches
// whatever element handle was in flight. Stub the HMR socket. (campshot's trick.)
await p.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {},
               set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto('http://127.0.0.1:5178/gallery.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__gallery, null, { timeout: 60000 });
// The sidebar and the header eat the frame; shoot the canvas alone.
for (const id of IDS) {
  await p.evaluate((i) => window.__gallery.select(i), id);
  await p.waitForTimeout(900);
  const short = id.split(':').pop();
  for (const a of ANG) {
    await p.evaluate(([yaw, pitch, zoom, lift]) => {
      const s = window.__gallery.stage;
      s.turntable = false; s.yaw = yaw; s.pitch = pitch;
      s.dist *= zoom; s.target.y += lift;
    }, [a, PITCH, parseFloat(process.env.ZOOM || '1'), parseFloat(process.env.LIFT || '0')]);
    await p.waitForTimeout(280);
    await (await p.$('#stage')).screenshot({ path: `${DIR}/${short}-${a}.png` });
  }
}
if (errs.length) console.log('ERRORS', [...new Set(errs)].slice(0, 6));
console.log('done');
await b.close();
