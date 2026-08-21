#!/usr/bin/env node
/**
 * wedgeshot — put the camper in the wedged pose and photograph it.
 *
 *   node tools/_scratch/wedgeshot.mjs --site -239,33 --out shots/wedge.png
 *
 * Also measures how much of the *drawn* camper is under the *drawn* ground,
 * which is the part the player actually sees: the chassis collider stops at
 * y +0.92 / z +2.22 in body space and the shell it is wearing goes to +1.16 /
 * +2.34, so the model can be inside a hill the collider is resting on.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const [SX, SZ] = String(arg('site', '-239,33')).split(',').map(Number);
const OUT = arg('out', 'shots/wedge.png');
const SETTLE = parseFloat(arg('settle', '14'));
const URL = `${arg('url', 'http://localhost:5178')}?res=${arg('res', '1024')}`;

async function main() {
  const release = await acquire('wedgeshot');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
        return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
                 send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
      }
      return new Real(url, protocols);
    };
    window.WebSocket.prototype = Real.prototype;
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => typeof window.__vehicleState === 'function', null, { timeout: 20000 });
  await page.waitForTimeout(1500);

  await page.evaluate(([x, z]) => window.__vehicleTeleport(x, z, 2.1), [SX, SZ]);
  await page.waitForTimeout(SETTLE * 1000);

  const report = await page.evaluate(() => {
    const THREE = window.__THREE, W = window.__world, V = window.__vehicle;
    const s = window.__vehicleState();
    // Corners of the drawn shell (DIM in CamperModel.js), in body space.
    const box = [];
    for (const x of [-0.95, 0.95]) for (const y of [-0.30, 1.16]) for (const z of [-2.32, 2.34]) box.push([x, y, z]);
    const q = V.rig.quaternion, p = V.rig.position;
    let deepest = 0, deepestPt = null;
    for (const c of box) {
      const v = new THREE.Vector3(...c).applyQuaternion(q).add(p);
      const under = W.getHeight(v.x, v.z) - v.y;
      if (under > deepest) { deepest = under; deepestPt = [v.x, v.y, v.z]; }
    }
    const P = V.phys;
    return {
      state: s, deepest, deepestPt,
      airborne: P.airborne, stuckFor: P._stuckFor, invertedFor: P._invertedFor,
      tilt: (Math.acos(Math.min(1, Math.max(-1, s.up))) * 180) / Math.PI,
      // What each of the three escape hatches needs, and where it actually is.
      gates: {
        autoRight: `upDot ${s.up.toFixed(3)} vs < 0.18`,
        buried: `origin ${(s.y - s.ground).toFixed(2)} m over getHeight vs < -1.6`,
        stuck: `airborne ${P.airborne} (must be false), stuckFor ${P._stuckFor.toFixed(2)} vs > 4.5`,
      },
    };
  });
  console.log(JSON.stringify(report, null, 2));

  mkdirSync(dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT });
  console.log(`\nwrote ${OUT}`);
  await browser.close();
  release();
}
main().catch((e) => { console.error(e); process.exit(1); });
