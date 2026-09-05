/** Is the moon drawn, and where? One frame from a normal camera at its own direction. */
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 900, height: 900 } });
await p.addInitScript(() => { try { const k='pa.hud'; const s=JSON.parse(localStorage.getItem(k)??'{}')||{};
  s.introSeen=true; s.seenHint=true; s.escSeen=true; localStorage.setItem(k,JSON.stringify(s)); } catch {} });
await p.goto('http://127.0.0.1:5193/?seed=5&quality=high&pixelratio=native&iscale=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
for (const hour of [22, 1, 2]) {
  const info = await p.evaluate((h) => {
    const L = window.__lighting, e = window.__engine, wd = window.__world;
    L.hour = h; L.cycleSpeed = 0;
    const md = L.computeMoonDir ? L.computeMoonDir(h) : L.moonDir;
    window.__forceCamera = true;
    const x = 909.28, z = -160.15, g = wd.getHeight(x, z);
    e.camera.fov = 40; e.camera.updateProjectionMatrix();
    e.camera.position.set(x, g + 1.7, z);
    e.camera.lookAt(x + md.x * 100, g + 1.7 + md.y * 100, z + md.z * 100);
    return { hour: h, moon: { x: +md.x.toFixed(3), y: +md.y.toFixed(3), z: +md.z.toFixed(3) },
             state: Object.keys(L.state ?? {}).filter(k => /moon|star|milky/i.test(k)).join(',') };
  }, hour);
  await p.waitForTimeout(1800);
  await p.screenshot({ path: `shots/trailer/mooncheck-${hour}.png` });
  console.log(JSON.stringify(info));
}
await b.close();
