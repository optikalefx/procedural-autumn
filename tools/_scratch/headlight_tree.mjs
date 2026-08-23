#!/usr/bin/env node
/**
 * Headlights-on-trees check.
 *
 * Parks the camper at the forest anchor at night with the beams up, puts the
 * camera on the rear quarter looking down the beam, and screenshots. Exists
 * because no canonical view frames "the car's own light landing on a trunk":
 * `drive`/`chase` look at the road from behind the canopy, and `forest` has no
 * car in it. Before the LOCAL_LIGHTS block in tree_material.js, trees inside
 * the beam stayed pure silhouette while the grass beside them lit up.
 *
 *   node tools/_scratch/headlight_tree.mjs --url http://127.0.0.1:5191 \
 *       --out /tmp/headlight.png [--hour 22]
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const BASE = arg('url', 'http://127.0.0.1:5191');
const OUT  = arg('out', '/tmp/headlight.png');
const HOUR = Number(arg('hour', 22));
const URL  = `${BASE}/?seed=20261018&car=camper`;

await acquire('headlight_tree');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, HOUR);
await page.evaluate(() => {
  const a = window.__cameraAnchors.forest();
  window.__vehicleTeleport(a.x, a.z, a.yaw ?? 0);
});
// Let the headlight mix damp up (rate 2.2/s) and the drop-in settle.
await page.evaluate(() => window.__settle(240));
await page.evaluate(() => {
  const THREE = window.__THREE, e = window.__engine;
  const veh = window.__ctx.systems.vehicle;
  const p = veh.position, yaw = veh.heading;
  const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  window.__forceCamera = true;
  e.camera.position.set(p.x - f.x * 9, p.y + 3.4, p.z - f.z * 9);
  e.camera.lookAt(p.x + f.x * 18, p.y + 1.2, p.z + f.z * 18);
  e.camera.fov = 55;
  e.camera.updateProjectionMatrix();
});
await page.evaluate(() => window.__settle(30));
await page.screenshot({ path: OUT });
if (errors.length) console.error('page errors:\n' + errors.join('\n'));
console.log(OUT);
await browser.close();
process.exit(0);
