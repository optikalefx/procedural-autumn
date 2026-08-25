// Does this world have islands in its lakes at all? Connected components over
// the hydro sdf's land cells; anything bounded that does not touch the map
// border is by construction surrounded by water.
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
await p.goto(process.env.AUTUMN_URL || 'http://localhost:5199');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 300 });

const out = await p.evaluate(() => {
  const W = window.__ctx.world, h = W.hydro;
  const R = h.res, T = h.texel, half = W.half;
  const sdf = h.sdf, span = h.span;
  const land = new Uint8Array(R * R);
  for (let i = 0; i < R * R; i++) land[i] = sdf[i] < 0 ? 1 : 0;

  const lab = new Int32Array(R * R).fill(-1);
  const comps = [];
  const stack = new Int32Array(R * R);
  for (let s = 0; s < R * R; s++) {
    if (!land[s] || lab[s] !== -1) continue;
    const id = comps.length;
    let sp = 0; stack[sp++] = s; lab[s] = id;
    let n = 0, border = false;
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9, sx = 0, sz = 0;
    while (sp > 0) {
      const c = stack[--sp]; n++;
      const cx = c % R, cz = (c / R) | 0;
      if (cx === 0 || cz === 0 || cx === R - 1 || cz === R - 1) border = true;
      if (cx < minx) minx = cx; if (cx > maxx) maxx = cx;
      if (cz < minz) minz = cz; if (cz > maxz) maxz = cz;
      sx += cx; sz += cz;
      const nb = [c - 1, c + 1, c - R, c + R];
      for (let k = 0; k < 4; k++) {
        const q = nb[k];
        if (q < 0 || q >= R * R) continue;
        if (k < 2 && Math.abs((q % R) - cx) !== 1) continue;   // no row wrap
        if (!land[q] || lab[q] !== -1) continue;
        lab[q] = id; stack[sp++] = q;
      }
    }
    comps.push({ id, n, border, w: (maxx - minx + 1) * T, d: (maxz - minz + 1) * T,
      x: Math.round((sx / n) * T - half), z: Math.round((sz / n) * T - half) });
  }

  const toWorld = (c) => ({ x: c.x, z: c.z });
  const islands = comps.filter((c) => !c.border).sort((a, c) => c.n - a.n);
  // How open is the water immediately around each island?
  const hy = {};
  const enriched = islands.slice(0, 40).map((c) => {
    let bestSpan = 0, wet = 0, tries = 0;
    for (let a = 0; a < 24; a++) {
      const th = (a / 24) * Math.PI * 2;
      const rr = Math.max(c.w, c.d) / 2 + 12;
      const x = c.x + Math.sin(th) * rr, z = c.z + Math.cos(th) * rr;
      if (!W.isInBounds(x, z)) continue;
      tries++;
      const hh = W.getHydro(x, z, hy);
      if (hh.sdf > 0) wet++;
      if (hh.span > bestSpan) bestSpan = hh.span;
    }
    return { ...toWorld(c), areaM2: c.n * T * T, size: `${c.w}x${c.d} m`,
      ringWaterFrac: +(wet / Math.max(tries, 1)).toFixed(2), maxSpan: +bestSpan.toFixed(1) };
  });

  return {
    components: comps.length,
    touchingBorder: comps.filter((c) => c.border).length,
    largestArea: comps.sort((a, c) => c.n - a.n)[0].n * T * T,
    islands: enriched.length,
    top: enriched,
  };
});

console.log(JSON.stringify(out, null, 1));
await b.close();
