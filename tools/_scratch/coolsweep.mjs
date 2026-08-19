#!/usr/bin/env node
/**
 * One browser boot, several look-uniform settings, N views.
 *
 * A `--view` run of shot.mjs costs a whole page load, so sweeping a single
 * uniform across four values and three views is twelve boots. This poses each
 * view once and re-renders it per setting, which is one boot for the lot — and
 * it is the difference between a sweep being affordable and being skipped.
 *
 *   node tools/_scratch/coolsweep.mjs --views meadow,drive --set shadowCoolAmt \
 *        --vals 0.42,0.7,0.95 --dir shots/look/sweep
 *
 * `--set` names a key on window.__stylize.params. `--js` instead runs arbitrary
 * source with the value bound to `v`.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquire } from '../_lock.mjs';
import { VIEWS } from '../shot.mjs';
import { readFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const VIEW_NAMES = (arg('views', 'meadow')).split(',');
const VALS = (arg('vals', '0')).split(',').map(Number);
const SET = arg('set', null);
const JS = arg('js', null);
const DIR = arg('dir', 'shots/look/sweep');
const RES = arg('res', '768');
const W = parseInt(arg('w', '1280'), 10), H = parseInt(arg('h', '720'), 10);

await acquire('coolsweep');
mkdirSync(DIR, { recursive: true });

const frozen = existsSync('review/anchors.json')
  ? JSON.parse(readFileSync('review/anchors.json', 'utf8')) : {};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[page]', String(e)));
await page.goto(`http://localhost:5178?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

for (const name of VIEW_NAMES) {
  const v = VIEWS[name];
  if (!v) { console.error('unknown view', name); continue; }
  await page.evaluate(async ({ v, frozen }) => {
    const THREE = window.__THREE, e = window.__engine, wd = window.__world;
    const api = window.__cameraAnchors || {};
    window.__lighting.hour = v.hour; window.__lighting.cycleSpeed = 0;
    const cached = v.anchor === 'vehicle' ? null : frozen[v.anchor];
    const anchor = cached ?? ((v.index && window.__anchorAt)
      ? window.__anchorAt(v.anchor, v.index)
      : (api[v.anchor] || api.vista)());
    let yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
    if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
    let pos, look;
    if (v.subject) {
      const gx = anchor.x - Math.sin(yaw) * v.dist, gz = anchor.z - Math.cos(yaw) * v.dist;
      pos = new THREE.Vector3(gx, wd.getHeight(gx, gz) + v.height, gz);
      look = new THREE.Vector3(anchor.x, wd.getHeight(anchor.x, anchor.z) + (anchor.lookY ?? 1.4), anchor.z);
    } else {
      const back = v.standOff ?? 0;
      const gx = anchor.x - Math.sin(yaw) * back, gz = anchor.z - Math.cos(yaw) * back;
      const gy = wd.getHeight(gx, gz) + v.height;
      pos = new THREE.Vector3(gx, gy, gz);
      look = new THREE.Vector3(gx + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist,
        gz + Math.cos(yaw) * v.dist);
    }
    const ray = new THREE.Raycaster(); ray.far = 6;
    const dir = new THREE.Vector3();
    for (let a = 0; a < 6; a++) {
      dir.copy(look).sub(pos).normalize(); ray.set(pos, dir);
      const hits = ray.intersectObjects(e.scene.children, true)
        .filter((h) => h.distance > 0.05 && h.object.visible && h.object.name !== 'Sky' && !h.object.isPoints);
      if (!hits.length || hits[0].distance > 3.0) break;
      pos.y += 2.2; pos.addScaledVector(dir, -2.0); look.y += 0.7;
    }
    const g = wd.getHeight(pos.x, pos.z) + 1.4; if (pos.y < g) pos.y = g;
    e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
    e.camera.position.copy(pos); e.camera.lookAt(look);
    window.__forceCamera = true;
    window.__atmosphere.params.cloudShadow = 0;
    window.dispatchEvent(new Event('resize'));
    await window.__settle(60);
  }, { v, frozen });

  for (const val of VALS) {
    await page.evaluate(async ({ SET, JS, val }) => {
      if (SET) window.__stylize.params[SET] = val;
      if (JS) eval(JS.replaceAll('$v', String(val)));
      await window.__settle(45);
    }, { SET, JS, val });
    await page.waitForTimeout(1200);
    const out = resolve(DIR, `${name}-${String(val).replace('.', 'p')}.png`);
    writeFileSync(out, await page.screenshot({ type: 'png' }));
    console.log('shot:', out);
  }
}
await browser.close();
