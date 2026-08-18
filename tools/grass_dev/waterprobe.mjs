// Objective check for the "grass standing in open water" defect: walk every
// live instance buffer and ask WorldData how deep the water is at that blade.
// Shallow hits are the intended reed fringe; anything past 0.15 m is a bug.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

await acquire('grass-waterprobe');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto('http://localhost:5178?res=768');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

for (const view of ['river', 'drive', 'vehicle']) {
  const out = await p.evaluate(async (view) => {
    const e = window.__engine, wd = window.__world;
    const a = (window.__cameraAnchors[view] || window.__cameraAnchors.vista)();
    const gy = wd.getHeight(a.x, a.z) + 3;
    e.camera.position.set(a.x, gy, a.z);
    e.camera.lookAt(a.x + Math.sin(a.yaw ?? 0) * 10, gy - 1, a.z + Math.cos(a.yaw ?? 0) * 10);
    window.__forceCamera = true;
    await window.__settle(60);
    const g = window.__systems.grass, S = 14;
    let tot = 0, shallow = 0, deep = 0;
    for (const r of g.rings) for (const t of r.tiles) {
      if (t.count <= 0) continue;
      const ox = (t.ix + 0.5) * r.tileSize, oz = (t.iz + 0.5) * r.tileSize;
      for (let i = 0; i < t.count; i += 17) {
        const k = i * S;
        const d = wd.getWaterDepth(ox + t.data[k], oz + t.data[k + 2]);
        tot++; if (d > 0.02) shallow++; if (d > 0.15) deep++;
      }
    }
    return { view, sampled: tot, shallowPct: +(100 * shallow / tot).toFixed(3), deepPct: +(100 * deep / tot).toFixed(3) };
  }, view);
  console.log(JSON.stringify(out));
}
await b.close();
