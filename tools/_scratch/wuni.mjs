#!/usr/bin/env node
/**
 * wuni — capture one framing several times, changing ONE water uniform between
 * shots, inside a single page load.
 *
 *   node tools/_scratch/wuni.mjs --view mouth --uniform uCoolGain --values 0,0.28,0.55 --dir shots/_cool
 *
 * The point is that a uniform sweep costs one bake instead of N. Everything
 * else in the frame is identical between the shots by construction: the clock
 * is stopped and the render path is called directly, so the pair differs by the
 * uniform and by nothing else.
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
import { VIEWS } from '../shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const VIEWNAMES = arg('view', 'mouth').split(',');
const UNI = arg('uniform', 'uCoolGain');
const VALUES = arg('values', '0,0.55').split(',').map(Number);
const DIR = arg('dir', 'shots/_wuni');
const HIDE = (arg('hide', '') || '').split(',').filter(Boolean);
const W = 1600, H = 900;
const URL = (process.env.AUTUMN_URL || 'http://localhost:5182');
const FROZEN = existsSync('review/anchors.json') ? JSON.parse(readFileSync('review/anchors.json', 'utf8')) : {};
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

await acquire('shot');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
await page.evaluate(() => { const e = window.__engine; if (!e) return; e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1; });

for (const name of VIEWNAMES) {
  const v = VIEWS[name];
  await page.evaluate(async (P) => {
    const v = P.v, THREE = window.__THREE, e = window.__engine, wd = window.__world;
    const api = window.__cameraAnchors || {};
    e.start();
    window.__lighting.hour = v.hour; window.__lighting.cycleSpeed = 0;
    const anchor = P.frozen[v.anchor] ?? ((v.index && window.__anchorAt) ? window.__anchorAt(v.anchor, v.index) : (api[v.anchor] || api.vista)());
    let yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
    if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
    const back = v.standOff ?? 0;
    const gx = anchor.x - Math.sin(yaw) * back, gz = anchor.z - Math.cos(yaw) * back;
    const gy = wd.getHeight(gx, gz) + v.height;
    const pos = new THREE.Vector3(gx, gy, gz);
    const look = new THREE.Vector3(gx + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, gz + Math.cos(yaw) * v.dist);
    const ray = new THREE.Raycaster(); ray.far = 6; const dir = new THREE.Vector3();
    for (let a = 0; a < 6; a++) {
      dir.copy(look).sub(pos).normalize(); ray.set(pos, dir);
      const hits = ray.intersectObjects(e.scene.children, true)
        .filter(h => h.distance > 0.05 && h.object.visible && h.object.name !== 'Sky' && !h.object.isPoints);
      if (!hits.length || hits[0].distance > 3.0) break;
      pos.y += 2.2; pos.addScaledVector(dir, -2.0); look.y += 0.7;
    }
    const g = wd.getHeight(pos.x, pos.z) + 1.4; if (pos.y < g) pos.y = g;
    e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
    e.camera.position.copy(pos); e.camera.lookAt(look);
    window.__forceCamera = true; window.dispatchEvent(new Event('resize'));
    if (window.__settleStable) await window.__settleStable(); else await window.__settle?.(60);
    for (const n of P.hide) { const o = e.scene.getObjectByName(n); if (o) o.visible = false; }
    await window.__settle?.(30);
  }, { v, frozen: FROZEN, hide: HIDE });
  await page.waitForTimeout(1200);

  const ok = await page.evaluate((uni) => {
    const e = window.__engine;
    e.stop();
    window.__frozenDraw = () => { if (e._render) e._render(0, e.elapsed); else e.renderer.render(e.scene, e.camera); };
    let u = null;
    e.scene.getObjectByName('Water')?.traverse(o => { if (!u && o.material?.uniforms?.[uni]) u = o.material.uniforms; });
    window.__wu = u; window.__frozenDraw();
    return !!u;
  }, UNI);
  if (!ok) { console.error(`${name}: no uniform ${UNI}`); continue; }

  for (const val of VALUES) {
    await page.evaluate(({ uni, val }) => { window.__wu[uni].value = val; window.__frozenDraw(); }, { uni: UNI, val });
    await page.waitForTimeout(120);
    const p = `${DIR}/${name}-${UNI}-${val}.png`;
    await page.screenshot({ path: p });
    console.log(`shot: ${p}`);
  }
  await page.evaluate(() => { window.__frozenDraw = null; window.__engine.start(); });
}
await browser.close();
