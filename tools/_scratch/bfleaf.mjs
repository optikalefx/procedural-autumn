// The mystery leaf's own canvas, straight to a PNG — no renderer, no lighting,
// no page curl. The one thing worth looking at here is whether the entry, the
// checkbox, the ring and the paw land where they are supposed to on the paper.
//   AUTUMN_URL=http://127.0.0.1:5245 node tools/_scratch/bfleaf.mjs --out /tmp/leaf.png
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
await acquire('bfleaf');

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 500, height: 300 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
        removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype;
  Object.assign(window.WebSocket, R);
});
await p.goto((process.env.AUTUMN_URL || 'http://127.0.0.1:5245') + '/?hunt=18');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

const out = await p.evaluate(async (want) => {
  const j = window.__ctx.systems.hud.journal;
  const t0 = Date.now();
  while (!j._ready && Date.now() - t0 < 90000) await new Promise((r) => setTimeout(r, 200));
  window.__dbg.sheet(18);
  if (want === 'ringed') window.__hunt.setTracked('bigfoot');
  await j._decorate({ force: true });
  const page = j._pages[j._mysteryPage];
  const row = page.spec.rows[0];
  return { png: page.canvas.toDataURL('image/png'),
           row: { track: row.track, target: row.target }, open: page.spec.open };
}, arg('state', 'ringed'));

console.log(JSON.stringify({ row: out.row, open: out.open }));
writeFileSync(arg('out', '/tmp/leaf.png'), Buffer.from(out.png.split(',')[1], 'base64'));
console.log('wrote', arg('out', '/tmp/leaf.png'));
await b.close();
