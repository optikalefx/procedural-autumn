/**
 * Calibrate a river launch gate. For every riverbank point in the map,
 * measure the things a gate could test — floatable channel width across the
 * flow, depth, turbulence, distance to the nearest waterfall lip — and score
 * candidate thresholds against ground truth ("is there a real reach here").
 */
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5263';
const SEED = process.env.SEED || '20261018';
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
await p.goto(`${URL}/?seed=${SEED}&car=camper&res=768`, { timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
const out = await p.evaluate(async () => {
  const w = window.__world;
  const { shoreSnap } = await import('/src/boat/boat_site.js');
  const DRAFT = 0.11, MARGIN = 0.15, FLOAT = DRAFT + MARGIN;   // kayak
  const lv = (x, z) => { const v = w._water?.levelAt?.(x, z); return v == null ? null : v; };
  const dep = (x, z) => { const l = lv(x, z); return l == null ? -1 : l - w.getHeight(x, z); };
  const falls = (w.waterfalls || []).map(f => ({ x: f.x, z: f.z }));
  const fallDist = (x, z) => { let m = 1e9; for (const f of falls) m = Math.min(m, Math.hypot(f.x - x, f.z - z)); return m; };

  const rows = [];
  for (let x = -1200; x <= 1200; x += 16) for (let z = -1200; z <= 1200; z += 16) {
    if (!w.isInBounds(x, z)) continue;
    const s0 = w.getHydro(x, z).sdf; if (s0 < -6 || s0 > 2) continue;
    const s = shoreSnap(w, x, z);
    const riv = w.getRiver(s.x, s.z); if (riv <= 0.05) continue;
    const f = w.getFlow(s.x, s.z, {}); const coh = Math.hypot(f.vx, f.vz);
    // floatable width ACROSS the flow, through the launch point
    let nx = 0, nz = 0;
    if (coh > 1e-3) { nx = -f.vz / coh; nz = f.vx / coh; } else { nx = -s.gz; nz = s.gx; }
    let L = 0, R = 0;
    for (let d = 0.5; d <= 60; d += 0.5) { if (dep(s.x + nx * d, s.z + nz * d) < FLOAT) break; R = d; }
    for (let d = 0.5; d <= 60; d += 0.5) { if (dep(s.x - nx * d, s.z - nz * d) < FLOAT) break; L = d; }
    // GROUND TRUTH: how much continuous floatable channel lies downstream?
    let px = s.x, pz = s.z, reach = 0;
    for (let i = 0; i < 80; i++) {
      const ff = w.getFlow(px, pz, {}); const m = Math.hypot(ff.vx, ff.vz);
      if (m < 0.12) break;
      px += ff.vx / m * 4; pz += ff.vz / m * 4;
      if (!w.isInBounds(px, pz)) break;
      if (w.getRiver(px, pz) < 0.15) break;
      if (dep(px, pz) < FLOAT) break;
      reach += 4;
    }
    rows.push({ riv, width: L + R, depth: dep(s.x, s.z), turb: f.turb, q: f.q, coh,
      fall: fallDist(s.x, s.z), reach,
      span: w.getHydro(s.x + s.gx * 14, s.z + s.gz * 14).span });
  }
  const qq = (a, pc) => { if (!a.length) return null; const s = a.slice().sort((u, v) => u - v); return +s[Math.floor((s.length - 1) * pc)].toFixed(2); };
  const st = (a) => ({ p05: qq(a, .05), p25: qq(a, .25), p50: qq(a, .5), p75: qq(a, .75), p95: qq(a, .95) });
  const frac = (a, f) => +(a.filter(f).length / Math.max(1, a.length)).toFixed(3);
  // "a real reach" = 80 m or more of continuous floatable channel downstream
  const real = rows.filter(r => r.reach >= 80);
  const dud = rows.filter(r => r.reach < 20);
  const table = [];
  for (const wmin of [3, 4, 5, 6, 8, 10]) {
    table.push({ widthMin: wmin,
      realAccepted: frac(real, r => r.width >= wmin),
      dudAccepted: frac(dud, r => r.width >= wmin) });
  }
  return { n: rows.length, realReaches: real.length, duds: dud.length,
    width: st(rows.map(r => r.width)), widthOnReal: st(real.map(r => r.width)),
    widthOnDud: st(dud.map(r => r.width)),
    depth: st(rows.map(r => r.depth)), turb: st(rows.map(r => r.turb)),
    turbOnReal: st(real.map(r => r.turb)),
    fallDist: st(rows.map(r => r.fall)), reach: st(rows.map(r => r.reach)),
    spanWouldAccept6: frac(rows, r => r.span >= 6),
    widthTable: table,
    turbTable: [0.35, 0.45, 0.55, 0.7].map(t => ({ turbMax: t,
      realAccepted: frac(real, r => r.turb <= t), dudAccepted: frac(dud, r => r.turb <= t) })),
  };
});
console.log(JSON.stringify(out, null, 1));
await b.close();
