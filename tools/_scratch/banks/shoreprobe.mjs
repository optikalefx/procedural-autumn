// Why is nothing standing at the waterline? Probe the actual inputs the shore
// layer reads, at the `river` anchor, rather than reasoning about which gate
// might be closing.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
// Neuter Vite HMR: peers save files constantly and a reload kills the run.
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
await p.goto('http://localhost:5178/?res=768');
await p.waitForFunction(() => window.__ready, null, { timeout: 180000 });

const out = await p.evaluate(async () => {
  const W = window.__world;
  const mod = await import('/src/vegetation/cover_scatter.js');
  const SF = mod.shoreField(W);

  // How much of the baked grid is even marked wet?
  const R = W.res;
  let wet = 0, marked = 0, negative = 0;
  for (let i = 0; i < R * R; i++) {
    if (W.water[i] > -9000) {
      marked++;
      const d = W.water[i] - W.height[i];
      if (d > 0.02) wet++; else negative++;
    }
  }

  // Walk the first river polyline and report the section across it.
  const line = W.riverPolylines?.[0] ?? [];
  const rows = [];
  for (let k = 6; k < line.length && rows.length < 6; k += Math.max(1, (line.length / 8) | 0)) {
    const pt = line[k];
    const row = { x: pt.x | 0, z: pt.z | 0, w: +pt.w?.toFixed(1), flow: +pt.flow?.toFixed(2), s: [] };
    // Section perpendicular to the line
    const nx = line[k + 1] ? -(line[k + 1].z - pt.z) : 1;
    const nz = line[k + 1] ? (line[k + 1].x - pt.x) : 0;
    const l = Math.hypot(nx, nz) || 1;
    for (let t = -14; t <= 14; t += 2) {
      const x = pt.x + (nx / l) * t, z = pt.z + (nz / l) * t;
      row.s.push({
        t,
        d: +W.getWaterDepth(x, z).toFixed(2),
        sd: +SF.at(x, z).toFixed(1),
        sl: +W.getSlope(x, z).toFixed(2),
        rv: +W.getRiver(x, z).toFixed(2),
      });
    }
    rows.push(row);
  }

  // And the same at the river anchor the capture uses.
  const a = window.__anchorAt('river', 3);
  const anchor = { x: a?.x | 0, z: a?.z | 0, s: [] };
  if (a) {
    for (let t = 0; t <= 40; t += 4) {
      for (const dir of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const x = a.x + dir[0] * t, z = a.z + dir[1] * t;
        anchor.s.push({ t, dir: dir.join(''), d: +W.getWaterDepth(x, z).toFixed(2), sd: +SF.at(x, z).toFixed(1), sl: +W.getSlope(x, z).toFixed(2) });
      }
    }
  }

  return { res: R, marked, wet, negative, rows, anchor };
});
console.log(JSON.stringify(out, null, 1));
await b.close();
