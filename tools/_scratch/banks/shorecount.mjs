// What does the shore layer actually emit, and where does it stop?
// Runs CoverScatter directly over the cells around a shoreline and counts by
// archetype, then reports which gate rejected each candidate.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
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
  const cs = await import('/src/vegetation/cover_scatter.js');
  const cf = await import('/src/vegetation/cover_forms.js');
  const SF = cs.shoreField(W);
  const sc = new cs.CoverScatter(W, 20261018, { mul: 1 });

  const CELL = 48;
  // Cells around the river anchor and around the deep channel the probe found.
  const spots = [['anchor', window.__anchorAt('river', 3)], ['channel', { x: 136, z: 636 }],
                 ['mouth', window.__anchorAt('mouth', 0)]];
  const res = {};
  for (const [name, a] of spots) {
    if (!a) continue;
    const c0x = Math.floor((a.x - 120) / CELL), c0z = Math.floor((a.z - 120) / CELL);
    const counts = {};
    const buf = new Float32Array(12200 * cs.COVER_STRIDE);
    let cells = 0;
    for (let cz = c0z; cz < c0z + 6; cz++) {
      for (let cx = c0x; cx < c0x + 6; cx++) {
        const n = sc._layerShore(cx, cz, CELL, 0, buf, 0, 12200);
        cells++;
        for (let i = 0; i < n; i++) {
          const ai = buf[i * cs.COVER_STRIDE + 17];
          const v = buf[i * cs.COVER_STRIDE + 18];
          const k = `${cf.COVER_ARCHETYPES[ai].key}_${v}`;
          counts[k] = (counts[k] || 0) + 1;
        }
      }
    }

    // Rejection census over the same area, replaying the gates by hand.
    const rej = { far: 0, ground: 0, deep: 0, standWet: 0, roll: 0, dampThin: 0, okWet: 0, okDry: 0 };
    for (let k = 0; k < 20000; k++) {
      const x = a.x - 144 + Math.random() * 288, z = a.z - 144 + Math.random() * 288;
      const sd = SF.at(x, z);
      if (sd > 5.5) { rej.far++; continue; }
      const g = sc._shoreGround(x, z, 0.80);
      if (g < 0.10) { rej.ground++; continue; }
      const depth = W.getWaterDepth(x, z);
      if (depth > 0.80) { rej.deep++; continue; }
      if (depth > 0.04) rej.okWet++; else rej.okDry++;
    }
    res[name] = { at: [a.x | 0, a.z | 0], cells, counts, rej };
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await b.close();
