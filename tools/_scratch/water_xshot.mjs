// scratch capture harness: same views as tools/shot.mjs plus --eval <js> run
// after the camera is posed, so subsystems can be toggled for diagnosis.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); if (i === -1) return d; const v = argv[i+1]; return v && !v.startsWith('--') ? v : true; };
const has = (n) => argv.includes(`--${n}`);
const VIEWS = {
  hero:      { anchor: 'vista',    height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  drive:     { anchor: 'road',     height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7 },
  meadow:    { anchor: 'meadow',   height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  forest:    { anchor: 'forest',   height: 3.0, dist: 14,  pitch: 0.02,  fov: 60, hour: 16.4 },
  river:     { anchor: 'river',    height: 3.4, dist: 16,  pitch: -0.12, fov: 54, hour: 16.9 },
  waterfall: { anchor: 'waterfall',height: 8,   dist: 46,  pitch: 0.10,  fov: 50, hour: 16.2 },
  peaks:     { anchor: 'peak',     height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
  vehicle:   { anchor: 'vehicle',  height: 2.1, dist: 9,   pitch: -0.06, fov: 44, hour: 17.0 },
  backlit:   { anchor: 'meadow',   height: 2.4, dist: 10,  pitch: 0.04,  fov: 52, hour: 17.9, faceSun: true },
  dawn:      { anchor: 'vista',    height: 48,  dist: 130, pitch: -0.13, fov: 46, hour: 7.4 },
};
const OUT_W = parseInt(arg('w','1600'),10), OUT_H = parseInt(arg('h','900'),10);
const params = new URLSearchParams();
for (const k of ['res','quality','seed']) { const v = arg(k,null); if (v) params.set(k, v); }
const qs = params.toString();
const URL = 'http://localhost:5178' + (qs ? `?${qs}` : '');

await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--enable-webgl','--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: OUT_W, height: OUT_H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

// --frames "name@x,y,z@x,y,z[@hour];…"  — several free cameras in one page load
const frames = arg('frames', null);
const views = frames ? frames.split(';').map((f,i)=>{
  const [nm,p1,l1,hr] = f.split('@');
  return { free:true, name:nm||('f'+i), pos:p1, look:l1, hour:hr };
}) : (has('all') ? Object.keys(VIEWS) : String(arg('view','hero')).split(','));
const dir = arg('dir','shots/water/x');
const evalJs = arg('eval', null);
const seen = {};
const delay = parseInt(arg('delay','1400'), 10);
for (const item of views) {
  const free = typeof item === 'object';
  const name = free ? item.name : item;
  const v = free ? { fov: 50, hour: item.hour || 16.7 } : VIEWS[name];
  await page.evaluate(async ({ v, posStr, lookStr, hourArg }) => {
    const THREE = window.__THREE, e = window.__engine, wd = window.__world;
    const api = window.__cameraAnchors || {};
    window.__lighting.hour = hourArg ? parseFloat(hourArg) : (v ? v.hour : 16.7);
    window.__lighting.cycleSpeed = 0;
    let pos, look;
    if (posStr) {
      const p = posStr.split(',').map(Number), l = (lookStr||'0,0,0').split(',').map(Number);
      pos = new THREE.Vector3(p[0],p[1],p[2]); look = new THREE.Vector3(l[0],l[1],l[2]);
    } else {
      const anchor = (api[v.anchor] || api.vista)();
      let yaw = anchor.yaw ?? 0;
      if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
      const gx = anchor.x, gz = anchor.z, gy = wd.getHeight(gx,gz) + v.height;
      pos = new THREE.Vector3(gx,gy,gz);
      look = new THREE.Vector3(gx+Math.sin(yaw)*v.dist, gy+Math.tan(v.pitch)*v.dist, gz+Math.cos(yaw)*v.dist);
    }
    e.camera.fov = v ? v.fov : 50; e.camera.updateProjectionMatrix();
    e.camera.position.copy(pos); e.camera.lookAt(look);
    window.__forceCamera = true;
    if (window.__settle) await window.__settle(60);
  }, { v, posStr: free ? item.pos : arg('pos'), lookStr: free ? item.look : arg('look'),
       hourArg: free ? (item.hour || null) : arg('hour') });
  if (evalJs) await page.evaluate(evalJs);
  await page.waitForTimeout(delay);
  seen[name] = (seen[name] || 0) + 1;
  const out = resolve(dir, seen[name] > 1 ? `${name}${seen[name]}.png` : `${name}.png`);
  if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  console.log('shot:', out);
}
if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0,6)));
await browser.close();
