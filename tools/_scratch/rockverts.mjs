import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, p) {
    if (p === 'vite-hmr' || String(p).includes('vite')) return { readyState: 3, url, protocol: '', addEventListener(){}, removeEventListener(){}, send(){}, close(){}, set onopen(_){}, set onmessage(_){}, set onclose(_){}, set onerror(_){} };
    return new Real(url, p);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://localhost:5178?res=512');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
const out = await page.evaluate(() => {
  const lib = window.__systems.rocks.library;
  const rows = [];
  for (const [arch, geoms] of Object.entries(lib)) {
    for (let v = 0; v < geoms.length; v++) {
      const g = geoms[v];
      const pos = g.attributes.position.array;
      const n = pos.length / 3;
      const uniq = new Set();
      for (let i = 0; i < pos.length; i += 3) {
        uniq.add(`${Math.round(pos[i]*1e3)},${Math.round(pos[i+1]*1e3)},${Math.round(pos[i+2]*1e3)}`);
      }
      g.computeBoundingBox();
      const b = g.boundingBox;
      rows.push({ arch, v, verts: n, uniq: uniq.size,
        bb: [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((q) => +q.toFixed(2)) });
    }
  }
  return rows;
});
const byArch = {};
for (const r of out) (byArch[r.arch] ??= []).push(r);
for (const [a, rows] of Object.entries(byArch)) {
  const uniq = rows.map((r) => r.uniq);
  const b = rows[0].bb;
  console.log(`${a.padEnd(9)} variants ${String(rows.length).padStart(2)}  uniq verts ${Math.min(...uniq)}–${Math.max(...uniq)}   v0 bb y[${b[1]}, ${b[4]}] x[${b[0]}, ${b[3]}]`);
}
console.log('total variants', out.length, ' total uniq', out.reduce((s, r) => s + r.uniq, 0));
await browser.close();
