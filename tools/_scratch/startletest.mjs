// Drives a synthetic threat at settled birds and measures how long each species
// holds before it flushes. Pure unit-stepping: no rendering, no wall clock.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('probe');

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
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
await p.goto(process.env.AUTUMN_URL || 'http://localhost:5252', { timeout: 240000, waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 500 });

const rows = await p.evaluate(() => {
  const tb = window.__ctx.systems.wildlife.treeBirds;
  const out = [];
  // A settled stand-in per species, stepped by hand with a threat parked at a
  // given range. timer is pinned high so a flush can only come from the threat.
  const trial = (key, range, speed) => {
    const si = tb.slots.findIndex((sl) => sl[0].spec.key === key);
    const bird = tb.slots[si][0];
    bird.active = true; bird.state = 0; bird.spooked = 0;
    bird.x = 0; bird.z = 0; bird.y = 10; bird.timer = 9999;
    const threat = { x: range, z: 0, speed };
    const DT = 1 / 30;
    // Spy on the DECISION, not the state change: at this synthetic position
    // there is no island to fly to, so a colony bird's _launch legitimately
    // fails and it stays put — which would read as "never flushed".
    const real = tb._launch.bind(tb);
    let firedAt = null;
    tb._launch = (bb, ax, az) => { if (firedAt === null && ax !== undefined) firedAt = true; return real(bb, ax, az); };
    try {
      for (let i = 0; i < 30 * 30; i++) {        // 30 s of sim
        bird.timer = 9999;
        tb._step(bird, DT, threat);
        if (firedAt === true) return +(i * DT).toFixed(2);
      }
    } finally { tb._launch = real; }
    return null;                                  // never flushed
  };
  for (const key of ['flamingo', 'heron', 'baldEagle']) {
    const S = tb.slots.find((sl) => sl[0].spec.key === key)[0].spec;
    out.push({
      key, startle: S.startle, startleDelay: S.startleDelay ?? 0,
      atHalfRadius: trial(key, S.startle * 0.5, 10),
      justOutside: trial(key, S.startle * 1.2, 10),
      parkedAlongside: trial(key, S.startle * 0.5, 0),   // stationary vehicle
    });
  }
  // Does a pass-by bank credit toward a later flush? Comment says no.
  const si = tb.slots.findIndex((sl) => sl[0].spec.key === 'flamingo');
  const bird = tb.slots[si][0];
  bird.active = true; bird.state = 0; bird.spooked = 0;
  bird.x = 0; bird.z = 0; bird.y = 10;
  const real = tb._launch.bind(tb);
  let fired = null;
  tb._launch = (bb, ax, az) => { if (fired === null && ax !== undefined) fired = true; return real(bb, ax, az); };
  const DT = 1 / 30;
  let t = 0, flushT = null;
  const run = (secs, range) => {
    for (let i = 0; i < secs / DT; i++) {
      bird.timer = 9999;
      tb._step(bird, DT, { x: range, z: 0, speed: 10 });
      t += DT;
      if (fired === true && flushT === null) flushT = +t.toFixed(2);
    }
  };
  run(3, 7); run(3, 60); run(8, 7);     // 3 s close, 3 s away, then close again
  tb._launch = real;
  out.push({ decay: { totalSimT: +t.toFixed(1), flushedAt: flushT } });
  return out;
});

console.log('species     startle  delay | flush at 0.5r | outside r | parked alongside');
for (const r of rows) {
  if (r.decay) { console.log(`pass-by then return: flushed at ${r.decay.flushedAt}s of ${r.decay.totalSimT}s (3s close, 3s away, then close)`); continue; }
  const f = (v) => (v === null ? 'never' : `${v}s`);
  console.log(`${r.key.padEnd(11)} ${String(r.startle).padStart(4)} m ${String(r.startleDelay).padStart(5)}s |`
    + ` ${f(r.atHalfRadius).padStart(13)} | ${f(r.justOutside).padStart(9)} | ${f(r.parkedAlongside).padStart(16)}`);
}
await b.close();
