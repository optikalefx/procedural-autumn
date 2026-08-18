// One-off: capture the same grass view with the post chain's AO / bloom / vignette
// toggled, to find what is eating the near field.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';

const VIEWS = {
  low:    { anchor:'meadow', height:1.2, dist:8, pitch:-0.02, fov:60, hour:17.2 },
  lowsun: { anchor:'meadow', height:1.15, dist:8, pitch:0.02, fov:60, hour:17.9, faceSun:true },
};
const dir = '/Users/sean/htdocs/procedural-fall/shots/grass/diag';
mkdirSync(dir, { recursive: true });
await acquire('grass-diag');
const b = await chromium.launch({ args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--disable-frame-rate-limit'] });
const p = await b.newPage({ viewport:{width:1024,height:576}, deviceScaleFactor:1 });
p.on('pageerror', e => console.log('ERR', e.message));
await p.goto('http://localhost:5178?res=768');
await p.waitForFunction(() => window.__ready === true, null, { timeout:240000, polling:300 });

async function pose(v) {
  await p.evaluate(async (v) => {
    const e = window.__engine, wd = window.__world;
    window.__lighting.hour = v.hour; window.__lighting.cycleSpeed = 0;
    const a = (window.__cameraAnchors[v.anchor] || window.__cameraAnchors.vista)();
    let yaw = a.yaw ?? 0;
    if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
    const gy = wd.getHeight(a.x, a.z) + v.height;
    e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
    e.camera.position.set(a.x, gy, a.z);
    e.camera.lookAt(a.x + Math.sin(yaw)*v.dist, gy + Math.tan(v.pitch)*v.dist, a.z + Math.cos(yaw)*v.dist);
    window.__forceCamera = true;
    await window.__settle(70);
  }, v);
}
async function setPost(mode) {
  return p.evaluate((mode) => {
    const fx = window.__postfx || window.__systems?.postfx;
    if (!fx) return 'no postfx';
    if (fx.ao) fx.ao.enabled = (mode !== 'noao');
    if (fx.vignette) fx.vignette.blendMode.opacity.value = (mode === 'novig') ? 0 : 1;
    return Object.keys(fx).join(',');
  }, mode);
}
for (const [name, v] of Object.entries(VIEWS)) {
  await pose(v);
  for (const mode of ['on','noao']) {
    console.log(name, mode, await setPost(mode));
    await p.waitForTimeout(900);
    await p.screenshot({ path: `${dir}/${name}_${mode}.png` });
  }
}
await b.close();
