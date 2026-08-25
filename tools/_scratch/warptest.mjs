// Does __vehicleTeleport actually move the player, or only the physics body?
// Compares it against Vehicle.warpTo (the path the minimap click uses).
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('probe');

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 640, height: 400 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
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

const read = () => p.evaluate(() => {
  const ctx = window.__ctx;
  const v = ctx.systems.vehicle;
  return {
    vehicle: [Math.round(v.position.x), Math.round(v.position.z)],
    camera: [Math.round(ctx.camera.position.x), Math.round(ctx.camera.position.z)],
  };
});

const TARGET = [1352, 760];

console.log('start           ', JSON.stringify(await read()));

await p.evaluate((t) => window.__vehicleTeleport(t[0], t[1], 0), TARGET);
await p.waitForTimeout(2000);
console.log('__vehicleTeleport', JSON.stringify(await read()), ' target', TARGET);

// put it back, then try the proper path
await p.evaluate(() => window.__ctx.systems.vehicle.warpTo(1321, 912));
await p.waitForTimeout(1500);
console.log('reset           ', JSON.stringify(await read()));

const wr = await p.evaluate((t) => {
  const r = window.__ctx.systems.vehicle.warpTo(t[0], t[1]);
  return r ? [Math.round(r.x), Math.round(r.z)] : null;
}, TARGET);
await p.waitForTimeout(2000);
console.log('warpTo returned ', JSON.stringify(wr));
console.log('warpTo          ', JSON.stringify(await read()), ' target', TARGET);

await b.close();
