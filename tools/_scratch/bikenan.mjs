// Where a parked camp bike's heading goes NaN. Read-only instrumentation:
// wraps BikePhysics.prototype.step on the live page and captures the first
// frame the field stops being finite.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('probe');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.log('ERR', e.message));
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
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 300 });
await p.waitForTimeout(1500);
await p.evaluate(() => { const h = window.__systems.hud; if (h?.journal?.visible) h.toggleJournal(); });
await p.evaluate(() => { const q = window.__poi.best('meadow') ?? { x: 0, z: 0 }; window.__vehicleTeleport?.(q.x, q.z, q.yaw ?? 0.9); });
await p.waitForTimeout(1800);
await p.keyboard.down('Space'); await p.waitForTimeout(900); await p.keyboard.up('Space');
await p.waitForTimeout(1200);

// First pitch: just to get hold of the BikePhysics prototype.
await p.evaluate(() => { const V = window.__systems.vehicle; window.__camp.pitchNear(V.position.x, V.position.z); });
await p.waitForTimeout(800);

await p.evaluate(() => {
  const ph = window.__systems.bike.bike.phys;
  const proto = Object.getPrototypeOf(ph);
  const step = proto.step;
  const snap = (o) => ({ heading: o.heading, speed: o.speed, x: o.x, y: o.y, z: o.z,
    yawRate: o.yawRate, grade: o.grade, made: o.made, lean: o.lean, blocked: o.blocked,
    wade: o.wade, wading: o.wading, grassiness: o.grassiness, grassCover: o.grassCover,
    steerAngle: o.steerAngle, wheelAngle: o.wheelAngle, half: o.half });
  window.__nanReport = null;
  window.__steps = 0;
  proto.step = function (dt, t, inp) {
    const before = snap(this);
    const wasFinite = Number.isFinite(this.heading);
    const r = step.call(this, dt, t, inp);
    window.__steps++;
    if (wasFinite && !Number.isFinite(this.heading) && !window.__nanReport) {
      window.__nanReport = { step: window.__steps, dt, inp: { ...inp }, before, after: snap(this) };
    }
    return r;
  };
  // Strike and re-pitch so a fresh bike is parked with the wrapper in place.
  for (const c of [...window.__camp.camps]) window.__camp._strike(c, true);
});
await p.waitForTimeout(600);
await p.evaluate(() => { const V = window.__systems.vehicle; window.__camp.pitchNear(V.position.x, V.position.z); });
await p.waitForTimeout(2500);
console.log(JSON.stringify(await p.evaluate(() => ({
  steps: window.__steps,
  headingNow: window.__systems.bike?.bike?.phys?.heading ?? 'no bike',
  report: window.__nanReport,
})), null, 1));
await b.close();
