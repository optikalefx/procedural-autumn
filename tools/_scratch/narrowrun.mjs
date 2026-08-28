/**
 * Does a NARROW channel stop a kayak?
 *
 * Picks the thinnest floatable reaches in the map rather than the widest, puts
 * a kayak on each and paddles it, and reports distance made good against the
 * channel width it was in. The question is whether narrowness blocks passage
 * at all — the physics has no width test, so it should not, and this is what
 * says so with a number.
 *
 *   node tools/_scratch/narrowrun.mjs [--secs 90] [--n 8]
 */
import { chromium } from 'playwright';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SECS = +arg('secs', 90), NT = +arg('n', 8);
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5263';
const SEED = process.env.SEED || '20262018';
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
console.log('booting…', SEED);
await p.goto(`${URL}/?seed=${SEED}&car=camper&res=768`, { timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
const out = await p.evaluate(async ({ SECS, NT }) => {
  const w = window.__world;
  const { BoatPhysics } = await import('/src/boat/boat_physics.js');
  const KAYAK = { length: 4.2, beam: 0.60, draft: 0.11 };
  const FLOAT = KAYAK.draft + 0.15;
  const lv = (x, z) => { const v = w._water?.levelAt?.(x, z); return v == null ? null : v; };
  const dep = (x, z) => { const l = lv(x, z); return l == null ? -1 : l - w.getHeight(x, z); };
  const fdir = (x, z) => { const f = w.getFlow(x, z, {}); const m = Math.hypot(f.vx, f.vz);
    return m > 1e-4 ? { x: f.vx / m, z: f.vz / m, m } : null; };
  // floatable width across the flow
  const widthAt = (x, z) => {
    const f = fdir(x, z); if (!f) return 0;
    const nx = -f.z, nz = f.x;
    let a = 0, c = 0;
    for (let d = 0.5; d <= 60; d += 0.5) { if (dep(x + nx * d, z + nz * d) < FLOAT) break; a = d; }
    for (let d = 0.5; d <= 60; d += 0.5) { if (dep(x - nx * d, z - nz * d) < FLOAT) break; c = d; }
    return a + c;
  };
  // How much continuous floatable channel lies downstream, and how narrow it
  // gets along the way — the reach is only as wide as its tightest point.
  const reachOf = (x, z) => {
    let px = x, pz = z, len = 0, minW = 1e9;
    for (let i = 0; i < 60; i++) {
      const f = fdir(px, pz); if (!f || f.m < 0.15) break;
      px += f.x * 4; pz += f.z * 4;
      if (!w.isInBounds(px, pz)) break;
      if (w.getRiver(px, pz) < 0.20) break;
      if (dep(px, pz) < FLOAT) break;
      minW = Math.min(minW, widthAt(px, pz));
      len += 4;
    }
    return { len, minW: minW === 1e9 ? 0 : minW };
  };

  // Candidates: reaches with real length, sorted NARROWEST first.
  const cands = [];
  for (let x = -1200; x <= 1200; x += 16) for (let z = -1200; z <= 1200; z += 16) {
    if (!w.isInBounds(x, z)) continue;
    if (w.getRiver(x, z) < 0.4) continue;
    if (dep(x, z) < FLOAT) continue;
    const f = fdir(x, z); if (!f || f.m < 0.3) continue;
    const r = reachOf(x, z);
    if (r.len < 100) continue;                       // needs somewhere to go
    cands.push({ x, z, reach: r.len, minW: r.minW, w0: widthAt(x, z) });
  }
  cands.sort((a, c) => a.minW - c.minW);
  const picks = [];
  for (const c of cands) {
    if (picks.length >= NT) break;
    if (picks.some(q => Math.hypot(q.x - c.x, q.z - c.z) < 180)) continue;
    picks.push(c);
  }

  const qq = (a, pc) => { if (!a.length) return null; const s = a.slice().sort((u, v) => u - v); return +s[Math.floor((s.length - 1) * pc)].toFixed(2); };
  const runs = [];
  for (const pk of picks) {
    const f0 = fdir(pk.x, pk.z);
    const ph = new BoatPhysics(w, KAYAK, { maxSpeed: 3.8, bobSeed: 1 });
    ph.place(pk.x, pk.z, Math.atan2(f0.x, f0.z));
    const dt = 1 / 60; let dist = 0, px = ph.x, pz = ph.z;
    let stuck = 0, worst = 0; const widths = [];
    for (let i = 0; i < SECS / dt; i++) {
      const ff = fdir(ph.x, ph.z);
      let turn = 0;
      if (ff && ff.m > 0.15) {
        let d = Math.atan2(ff.x, ff.z) - ph.heading;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        turn = Math.max(-1, Math.min(1, d * 1.6));
      }
      ph.step(dt, i * dt, { fwd: 1, back: 0, turn });
      const step = Math.hypot(ph.x - px, ph.z - pz); dist += step; px = ph.x; pz = ph.z;
      if (step / dt < 0.2) { stuck += dt; worst = Math.max(worst, stuck); } else stuck = 0;
      if (i % 30 === 0) widths.push(widthAt(ph.x, ph.z));
    }
    runs.push({ from: [Math.round(pk.x), Math.round(pk.z)],
      reachLen: pk.reach, tightestInReach: +pk.minW.toFixed(1),
      travelled: +dist.toFixed(0), avgSpeed: +(dist / SECS).toFixed(2),
      longestStuckSec: +worst.toFixed(1),
      widthSeen: { min: qq(widths, 0), p50: qq(widths, .5) },
      beached: ph.beached });
  }
  // Map-wide: how narrow does floatable river actually get?
  const allW = [];
  for (let x = -1200; x <= 1200; x += 12) for (let z = -1200; z <= 1200; z += 12) {
    if (!w.isInBounds(x, z)) continue;
    if (w.getRiver(x, z) < 0.4) continue;
    if (dep(x, z) < FLOAT) continue;
    const ww = widthAt(x, z); if (ww > 0) allW.push(ww);
  }
  const frac = (a, f) => +(a.filter(f).length / Math.max(1, a.length)).toFixed(3);
  return {
    channelWidthMapWide: { n: allW.length, min: qq(allW, 0), p05: qq(allW, .05),
      p25: qq(allW, .25), p50: qq(allW, .5), p95: qq(allW, .95) },
    underKayakLength_4_2m: frac(allW, v => v < 4.2),
    under5m: frac(allW, v => v < 5),
    under8m: frac(allW, v => v < 8),
    runs,
  };
}, { SECS, NT });
console.log(JSON.stringify(out, null, 1));
await b.close();
