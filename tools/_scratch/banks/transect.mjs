// A section across the bank at the `river` anchor: what does the shore layer
// see on the strip of bare clay the capture shows between the water and the
// grass? Ray-marched from the camera so the samples land on the pixels that
// look bare, rather than along an arbitrary bearing.
import { chromium } from 'playwright';
import { VIEWS } from '../../shot.mjs';
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
await p.goto('http://localhost:5178/');
await p.waitForFunction(() => window.__ready, null, { timeout: 300000 });

const out = await p.evaluate(async (view) => {
  const W = window.__world;
  const cs = await import('/src/vegetation/cover_scatter.js');
  const SF = cs.shoreField(W);
  const sc = new cs.CoverScatter(W, 20261018, { mul: 1 });

  // Walk out from the anchor in every direction and record the first crossing
  // of a waterline, then a section through it.
  const a = window.__anchorAt(view === 'river' ? 'river' : 'mouth', view === 'river' ? 3 : 0);
  const rows = [];
  for (let k = 0; k < 16 && rows.length < 5; k++) {
    const ang = (k / 16) * Math.PI * 2;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    let hit = -1;
    for (let t = 2; t < 90; t += 1) {
      if (W.getWaterDepth(a.x + dx * t, a.z + dz * t) > 0.05) { hit = t; break; }
    }
    if (hit < 0) continue;
    const row = { ang: +ang.toFixed(2), hit, s: [] };
    for (let t = hit + 6; t >= hit - 4; t -= 1) {
      const x = a.x + dx * t, z = a.z + dz * t;
      row.s.push({
        t: +(t - hit).toFixed(0),
        d: +W.getWaterDepth(x, z).toFixed(2),
        sd: +SF.at(x, z).toFixed(1),
        sl: +W.getSlope(x, z).toFixed(2),
        sg: +sc._shoreGround(x, z, 0.04).toFixed(2),
        sand: +W.getSurfaceWeights(x, z, {}).sand.toFixed(2),
        grass: +W.getSurfaceWeights(x, z, {}).grass.toFixed(2),
      });
    }
    rows.push(row);
  }
  return { at: [a.x | 0, a.z | 0], rows };
}, process.argv[2] || 'river');

for (const r of out.rows) {
  console.log(`--- bearing ${r.ang} rad, waterline at ${r.hit} m from (${out.at})`);
  console.log('  t(out->in):', r.s.map((v) => String(v.t).padStart(6)).join(''));
  console.log('  depth     :', r.s.map((v) => v.d.toFixed(2).padStart(6)).join(''));
  console.log('  shoreDist :', r.s.map((v) => v.sd.toFixed(1).padStart(6)).join(''));
  console.log('  slope     :', r.s.map((v) => v.sl.toFixed(2).padStart(6)).join(''));
  console.log('  shoreGnd  :', r.s.map((v) => v.sg.toFixed(2).padStart(6)).join(''));
  console.log('  sandW     :', r.s.map((v) => v.sand.toFixed(2).padStart(6)).join(''));
  console.log('  grassW    :', r.s.map((v) => v.grass.toFixed(2).padStart(6)).join(''));
}
await b.close();
