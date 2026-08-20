// What rock is near the water, and did the widened riverbed process put
// anything oversized on a beach? Also reports any block whose base is clear of
// the ground, so a floating-crag report can be attributed rather than guessed.
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
  const rs = await import('/src/rocks/RockScatter.js');
  const SF = cs.shoreField(W);
  const sc = new rs.RockScatter(W, 20261018);
  sc.setFootprints(window.__systems.rocks?.scatter?._foot ?? {});

  const spots = [['mouth', window.__anchorAt('mouth', 0)], ['river', window.__anchorAt('river', 3)]];
  const res = {};
  for (const [name, a] of spots) {
    if (!a) continue;
    const CELL = 64;
    const inst = [];
    const c0x = Math.floor((a.x - 160) / CELL), c0z = Math.floor((a.z - 160) / CELL);
    for (let cz = c0z; cz < c0z + 6; cz++) {
      for (let cx = c0x; cx < c0x + 6; cx++) sc.generateCell(cx, cz, CELL, 0, inst);
    }
    const byKind = {}, near = {}, big = [];
    for (const i of inst) {
      byKind[i.kind] = (byKind[i.kind] || 0) + 1;
      const sd = SF.at(i.x, i.z);
      if (sd < 3) near[i.arch] = (near[i.arch] || 0) + 1;
      if (i.size > 3.0 && i.kind === 'riverbed') {
        big.push({ arch: i.arch, size: +i.size.toFixed(1), sd: +sd.toFixed(1),
                   river: +W.getRiver(i.x, i.z).toFixed(2) });
      }
    }
    // Air under the base: y minus the ground beneath, per instance origin.
    let air = 0;
    for (const i of inst) if (i.y - W.getHeight(i.x, i.z) > i.size * 0.6) air++;
    res[name] = { at: [a.x | 0, a.z | 0], total: inst.length, byKind, nearWaterByArch: near,
                  bigRiverbed: big.slice(0, 12), bigRiverbedCount: big.length, airborne: air };
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await b.close();
