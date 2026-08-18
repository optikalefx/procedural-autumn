#!/usr/bin/env node
/**
 * Tree-author scratch capture: same framing rules as shot.mjs, but lets a
 * snippet run in the page before the frame (`--js`) so LOD tiers, wind and
 * individual meshes can be isolated. Takes a capture slot like every other tool.
 *
 *   node tools/_treeshot.mjs --view forest --res 768 --js "…" --out shots/x.png
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';
import { VIEWS } from './shot.mjs';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

await acquire('treeshot');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: +arg('w', 1280), height: +arg('h', 720) } });
p.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 300)));
await p.goto(`http://localhost:5178/?res=${arg('res', '768')}`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });

const names = arg('views', arg('view', 'hero')).split(',');
for (const name of names) {
  const v = VIEWS[name];
  await p.evaluate(async ({ v, js, hour, posStr, lookStr }) => {
    const THREE = window.__THREE, e = window.__engine, wd = window.__world;
    window.__lighting.hour = hour ? parseFloat(hour) : (v ? v.hour : 16.7);
    window.__lighting.cycleSpeed = 0;
    if (posStr) {
      const q = posStr.split(',').map(Number), l = (lookStr || '0,0,0').split(',').map(Number);
      e.camera.fov = 50; e.camera.updateProjectionMatrix();
      e.camera.position.set(q[0], q[1], q[2]);
      e.camera.lookAt(new THREE.Vector3(l[0], l[1], l[2]));
    } else {
      const a = (window.__cameraAnchors[v.anchor] || window.__cameraAnchors.vista)();
      let yaw = a.yaw ?? 0;
      if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
      const gy = wd.getHeight(a.x, a.z) + v.height;
      e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
      e.camera.position.set(a.x, gy, a.z);
      e.camera.lookAt(a.x + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, a.z + Math.cos(yaw) * v.dist);
    }
    window.__forceCamera = true;
    if (js) (new Function(js))();
    await window.__settle(60);
  }, { v, js: arg('js', ''), hour: arg('hour'), posStr: arg('pos'), lookStr: arg('look') });
  await p.waitForTimeout(1000);
  const out = resolve(names.length > 1 ? `${arg('dir', 'shots/trees/dbg')}/${name}.png` : arg('out', 'shots/trees/dbg/x.png'));
  if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
  await p.screenshot({ path: out });
  console.log('shot:', out);
}
console.log('stats:', JSON.stringify(await p.evaluate(() => ({
  fps: window.__fps, calls: window.__engine.renderer.info.render.calls,
  tris: window.__engine.renderer.info.render.triangles,
  trees: window.__systems.trees?.stats,
}))));
await b.close();
