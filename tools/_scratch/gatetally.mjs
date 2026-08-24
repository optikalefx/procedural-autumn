import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5197';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 500, height: 400 } });
p.on('pageerror', e => console.log('ERR', e.message));
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState:3, url, close(){}, send(){}, addEventListener(){}, removeEventListener(){},
        set onopen(_){}, set onclose(_){}, set onerror(_){}, set onmessage(_){} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype; Object.assign(window.WebSocket, RealWS);
});
console.log('booting…');
await p.goto(`${URL}/?seed=20261018&car=camper&res=768`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
console.log(await p.evaluate(() => {
  const w = window.__world, B = window.__boat;
  const tally = {};
  let n = 0;
  for (let x=-1200;x<=1200;x+=20) for (let z=-1200;z<=1200;z+=20) {
    if (!w.isInBounds(x,z)) continue;
    const s = w.getHydro(x,z).sdf;
    if (s < -6 || s > 2) continue;
    n++;
    const v = B.validate(x, z);
    const k = v.ok ? 'OK' : v.reason;
    tally[k] = (tally[k]||0)+1;
  }
  // MIN_SPAN is the only gate that is not situational; count what passes it
  // regardless of where the camper happens to be parked.
  return JSON.stringify({ shoreBandPoints: n, tally }, null, 1);
}));
await b.close();
