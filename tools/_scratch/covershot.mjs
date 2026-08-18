#!/usr/bin/env node
// Debug capture: same harness as tools/shot.mjs but runs an --eval snippet in
// the page after posing the camera. Used only for diagnosis.
import { chromium } from 'playwright';
import { acquire } from '/Users/sean/htdocs/procedural-fall/tools/_lock.mjs';
import { VIEWS } from '/Users/sean/htdocs/procedural-fall/tools/shot.mjs';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const RES = arg('res', '640');
const URL = 'http://localhost:5178?res=' + RES;
const view = arg('view', 'meadow');
const out = resolve(arg('out', 'shots/cover/dbg.png'));
const evalStr = arg('eval', '');

await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 400)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('CON', m.text().slice(0, 600)); });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

await page.evaluate(async (v) => {
  const THREE = window.__THREE, e = window.__engine, wd = window.__world;
  const api = window.__cameraAnchors || {};
  window.__lighting.hour = v.hour; window.__lighting.cycleSpeed = 0;
  const anchor = (api[v.anchor] || api.vista)();
  let yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
  if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
  const gy = wd.getHeight(anchor.x, anchor.z) + v.height;
  e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
  e.camera.position.set(anchor.x, gy, anchor.z);
  e.camera.lookAt(anchor.x + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, anchor.z + Math.cos(yaw) * v.dist);
  window.__forceCamera = true;
  if (window.__settle) await window.__settle(60);
}, VIEWS[view]);

if (evalStr) console.log('eval:', await page.evaluate(evalStr));
await page.waitForTimeout(1200);
if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out });
console.log('shot:', out);
if (argv.includes('--ab')) {
  const off = out.replace(/\.png$/, '-off.png');
  await page.evaluate(() => { window.__systems.groundCover.group.visible = false; });
  await page.waitForTimeout(700);
  await page.screenshot({ path: off });
  console.log('shot:', off);
  await page.evaluate(() => { window.__systems.groundCover.group.visible = true; });
}
console.log('stats:', JSON.stringify(await page.evaluate(() => ({
  calls: window.__engine.renderer.info.render.calls,
  tris: window.__engine.renderer.info.render.triangles,
  fps: window.__fps,
  cover: window.__systems?.groundCover?.stats,
}))));
await browser.close();
