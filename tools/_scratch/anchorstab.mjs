// P3: is poi.anchor() the same across separate page loads?
import { chromium } from 'playwright';
import { acquire } from '/Users/sean/htdocs/procedural-fall/tools/_lock.mjs';
await acquire('anchorstab');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const runs = [];
for (let i = 0; i < 3; i++) {
  const p = await b.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
  await p.goto('http://localhost:5178/?res=512');
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
  runs.push(await p.evaluate(() => {
    const poi = window.__systems?.poi ?? window.__poi ?? globalThis.__poi;
    const src = window.__cameraAnchors;
    const out = {};
    for (const k of ['road', 'meadow', 'river', 'forest', 'waterfall']) {
      let a = null;
      try { a = src?.[k]?.(); } catch { /* not all exist */ }
      if (!a && poi?.anchor) { try { a = poi.anchor(k); } catch { /* */ } }
      out[k] = a ? [Math.round(a.x), Math.round(a.z), +(a.yaw ?? 0).toFixed(3)] : null;
    }
    return out;
  }));
  await p.close();
}
const keys = Object.keys(runs[0]);
let bad = 0;
for (const k of keys) {
  const s = runs.map((r) => JSON.stringify(r[k]));
  const same = s.every((v) => v === s[0]);
  if (!same) bad++;
  console.log(`${same ? 'STABLE  ' : 'UNSTABLE'} ${k.padEnd(10)} ${s.join('  |  ')}`);
}
console.log(bad === 0 ? '\nall anchors identical across 3 page loads' : `\n${bad} unstable`);
await b.close();
