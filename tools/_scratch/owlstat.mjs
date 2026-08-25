#!/usr/bin/env node
/**
 * Does the logbook credit `seen.owl`?
 *
 * Stats._treeBirds walks TreeBirds' own slots and credits `seen.<key>` for any
 * bird within 130 m of the CAMPER (not the camera) and inside the frustum, so
 * this parks an owl a short way in front of the vehicle, points the camera at
 * it, runs a few frames and reads the store.
 *
 *   AUTUMN_URL=http://127.0.0.1:5193 node tools/_scratch/owlstat.mjs
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5193') + '/?car=camper';
await acquire('shot');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const r = await page.evaluate(async () => {
  const THREE = window.__THREE, e = window.__engine;
  window.__lighting.hour = 22; window.__lighting.cycleSpeed = 0;
  await window.__settle(40);
  const tb = window.__systems.wildlife.treeBirds;
  const veh = window.__systems.vehicle.position;
  let p = null;
  for (const [dx, dz] of [[35, 0], [0, 35], [-35, 0], [0, -35], [60, 60], [-60, -60]]) {
    p = tb.debugPerchNear(veh.x + dx, veh.z + dz, 'owl');
    if (p) break;
  }
  if (!p) return { err: 'no perch near the camper' };
  const before = window.__stats.get('seen.owl');
  window.__forceCamera = true;
  e.camera.position.set(veh.x, veh.y + 2, veh.z);
  e.camera.lookAt(new THREE.Vector3(p.x, p.y, p.z));
  await window.__settle(90);
  return {
    perch: p,
    dist: Math.hypot(p.x - veh.x, p.z - veh.z),
    before,
    after: window.__stats.get('seen.owl'),
    eagles: window.__stats.get('seen.baldEagle'),
  };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
