// Boot the game once and evaluate a JS file's source in the page. Prints whatever it returns.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
const url = process.env.AUTUMN_URL || 'http://127.0.0.1:5211/?seed=20261018';
const src = readFileSync(process.argv[2], 'utf8');
await acquire('probe');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
p.on('pageerror', e => console.log('ERR', e.message));
p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(u, pr);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await p.goto(url);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
const out = await p.evaluate(src);
console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
await b.close();
