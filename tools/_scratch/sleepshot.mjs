// One frame: the tent's offer at a given hour. `node tools/_scratch/sleepshot.mjs --hour 18.2`
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const HOUR = parseFloat(arg('hour', '18.2'));
const OUT = arg('out', `shots/sleep/offer-h${HOUR}.png`);
await acquire('campshot');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
        set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
await p.goto('http://localhost:5178/?car=camper');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await p.waitForTimeout(1400);
await p.evaluate(() => { const h = window.__systems.hud; if (h?.journal?.visible) h.toggleJournal(); });
await p.evaluate(() => { const q = window.__poi.best('meadow') ?? { x: 0, z: 0 }; window.__vehicleTeleport?.(q.x, q.z, q.yaw ?? 0.9); });
await p.waitForTimeout(1800);
await p.keyboard.down('Space'); await p.waitForTimeout(900); await p.keyboard.up('Space');
await p.waitForTimeout(1200);
await p.evaluate((h) => {
  const L = window.__lighting, V = window.__systems.vehicle;
  L.hour = h; L.cycleSpeed = 0;
  window.__camp.pitchNear(V.position.x, V.position.z);
}, HOUR);
await p.waitForTimeout(2500);
const tentScreen = () => p.evaluate(() => {
  const t = window.__camp.camps[0].props.find((q) => q.item.kind === 'tent');
  const v = new window.__THREE.Vector3(t.item.x, t.item.y + 0.62, t.item.z).project(window.__ctx.camera);
  return { x: Math.round((v.x * 0.5 + 0.5) * innerWidth), y: Math.round((-v.y * 0.5 + 0.5) * innerHeight) };
});
for (let i = 0; i < 6; i++) {
  const c = await tentScreen();
  await p.mouse.move(c.x, c.y);
  await p.waitForTimeout(150);
  const after = await tentScreen();
  if (Math.hypot(after.x - c.x, after.y - c.y) < 4) break;
}
await p.waitForTimeout(200);
console.log(`h${HOUR}  ready=${await p.evaluate(() => window.__camp.sleep.ready())}  ` +
  `prompt="${await p.evaluate(() => (window.__camp.prompt.el.textContent || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim())}"`);
await p.screenshot({ path: OUT });
console.log(OUT);
await b.close();
