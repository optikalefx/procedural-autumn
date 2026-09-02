// How often does the spawn heading point AWAY from the middle of the map?
// Dumps the road candidates the spawn search scans (Vehicle.init: first of the
// top 24 that is dry, in bounds and under slope 0.42) with the sign of
// forward · (centre - here) for each.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const URL = process.env.AUTUMN_URL || 'http://localhost:5178';
const SEED = process.argv[2] || '';
await acquire('probe');
const b = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
p.on('pageerror', e => console.log('ERR', e.message));
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
        set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await p.goto(URL + '?car=camper' + (SEED ? '&seed=' + SEED : ''));
await p.waitForFunction(() => window.__ready === true, null, { timeout: 600000, polling: 300 });
console.log(JSON.stringify(await p.evaluate(() => {
  const poi = window.__vehicle.ctx.poi;
  const W = window.__vehicle.ctx.world;
  // forward is (sin yaw, cos yaw); centre of the map is the origin
  const inward = (x, z, yaw) =>
    +((Math.sin(yaw) * -x + Math.cos(yaw) * -z) / (Math.hypot(x, z) || 1)).toFixed(2);
  const stands = (c) => W.getWaterDepth(c.x, c.z) <= 0.05 && W.getSlope(c.x, c.z) <= 0.42;
  const road = poi.list.road;
  // What the OLD rule picked: first of the top 24 that stands up, yaw as-is.
  const before = road.slice(0, 24).find(stands);
  const st = window.__vehicleState();
  return {
    roadAnchors: road.length,
    facingOut: road.filter((c) => inward(c.x, c.z, c.yaw) < 0).length,
    before: before && {
      i: road.indexOf(before), x: Math.round(before.x), z: Math.round(before.z),
      heading: +before.yaw.toFixed(3), inward: inward(before.x, before.z, before.yaw),
      edgeAhead: (() => {   // metres of map ahead of the nose
        let t = 0; while (t < 4000 && Math.abs(before.x + Math.sin(before.yaw) * t) < 1536
                          && Math.abs(before.z + Math.cos(before.yaw) * t) < 1536) t += 5;
        return t;
      })(),
    },
    after: {
      x: Math.round(st.x), z: Math.round(st.z),
      heading: +st.heading.toFixed(3), inward: inward(st.x, st.z, st.heading),
      edgeAhead: (() => {
        let t = 0; while (t < 4000 && Math.abs(st.x + Math.sin(st.heading) * t) < 1536
                          && Math.abs(st.z + Math.cos(st.heading) * t) < 1536) t += 5;
        return t;
      })(),
    },
  };
}), null, 1));
await b.close();
