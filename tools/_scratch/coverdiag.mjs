#!/usr/bin/env node
// One-session diagnostic: several screenshots of the SAME world bake, so a
// mid-session re-bake by another author cannot make two shots incomparable.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { VIEWS } from '../shot.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const view = arg('view', 'meadow');
const dir = resolve(arg('dir', 'shots/cover/diag'));
mkdirSync(dir, { recursive: true });

await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CON', m.text().slice(0, 300)); });
await page.goto('http://localhost:5178?res=' + arg('res', '640'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

await page.evaluate(async (v) => {
  const e = window.__engine, wd = window.__world;
  const api = window.__cameraAnchors || {};
  window.__lighting.hour = v.hour; window.__lighting.cycleSpeed = 0;
  const a = (api[v.anchor] || api.vista)();
  let yaw = (a.yaw ?? 0) + (v.yawOffset ?? 0);
  if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
  const gy = wd.getHeight(a.x, a.z) + v.height;
  e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
  e.camera.position.set(a.x, gy, a.z);
  e.camera.lookAt(a.x + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, a.z + Math.cos(yaw) * v.dist);
  window.__forceCamera = true;
  if (window.__settle) await window.__settle(60);
}, VIEWS[view]);

const steps = [
  ['0-normal', '1'],
  ['1-nocover', 'window.__systems.groundCover.group.visible=false, 1'],
  ['2-nograss', '(window.__systems.groundCover.group.visible=true, window.__systems.grass.group.visible=false, 1)'],
  ['3-shrubonly', '(()=>{const g=window.__systems.groundCover;g.enabled=false;for(const m of g.meshes)m.visible=m.name.indexOf("shrubDark")>=0&&m.count>0;return 1;})()'],
  ['4-shrubhuge', '(()=>{const T=window.__THREE,g=window.__systems.groundCover;const M=new T.Matrix4(),p=new T.Vector3(),q=new T.Quaternion(),sc=new T.Vector3();for(const s of g.slots){if(s.mesh.name.indexOf("shrubDark")<0)continue;for(let i=0;i<s.mesh.count;i++){s.mesh.getMatrixAt(i,M);M.decompose(p,q,sc);sc.multiplyScalar(3);M.compose(p,q,sc);s.mesh.setMatrixAt(i,M);}s.mesh.instanceMatrix.needsUpdate=true;}return 1;})()'],
];
for (const [name, expr] of steps) {
  await page.evaluate(expr);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${dir}/${name}.png` });
  console.log('shot:', `${dir}/${name}.png`);
}
console.log('stats:', JSON.stringify(await page.evaluate(() => ({
  calls: window.__engine.renderer.info.render.calls,
  cover: window.__systems.groundCover.stats,
}))));
await browser.close();
