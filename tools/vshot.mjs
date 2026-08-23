#!/usr/bin/env node
/**
 * Vehicle contact sheet.
 *
 *   node tools/vshot.mjs --dir shots/vehicle/r3
 *   node tools/vshot.mjs --dir shots/vehicle/r3 --hour 16.7 --res 768
 *   node tools/vshot.mjs --dir shots/x --only hero3q,wheel
 *
 * One browser, one world bake, one capture slot — then every framing of the
 * camper the model actually needs judging from.  Ten separate `shot.mjs --view
 * vehicle` runs would cost ten bakes for the same information.
 *
 * Framings are polar around the camper: `az` is measured from its nose,
 * so they stay meaningful wherever it happens to be parked.
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

// Where the camera stands, in polar coordinates around the camper: `az` = 0 is
// straight ahead of its nose, +pi is directly behind. `elev` is metres above the
// body origin, `aim` metres above it for the look-at, `off` shifts the look-at
// forward along the camper so close-ups can frame one end.
const FRAMES = {
  hero3q:  { az: 0.85, dist: 8.6, elev: 1.9,  fov: 40, aim: 0.75 },
  rear3q:  { az: 2.30, dist: 8.2, elev: 2.1,  fov: 40, aim: 0.70 },
  side:    { az: 1.57, dist: 9.4, elev: 1.0,  fov: 36, aim: 0.75 },
  front:   { az: 0.0,  dist: 7.4, elev: 1.3,  fov: 38, aim: 0.70 },
  rear:    { az: 3.14, dist: 7.2, elev: 1.5,  fov: 38, aim: 0.70 },
  high:    { az: 1.10, dist: 8.0, elev: 6.2,  fov: 44, aim: 0.60 },
  wheel:   { az: 1.75, dist: 3.4, elev: 0.30, fov: 34, aim: -0.10, off: 1.4 },
  rack:    { az: 2.30, dist: 4.6, elev: 3.0,  fov: 40, aim: 1.70, off: -0.6 },
  nose:    { az: 0.65, dist: 4.6, elev: 0.9,  fov: 34, aim: 0.30, off: 1.3 },
  far:     { az: 0.85, dist: 34,  elev: 7.0,  fov: 34, aim: 0.9 },
};

const RES = arg('res', '768');
const HOUR = arg('hour', null);
const DIR = arg('dir', 'shots/vehicle/v');
const ONLY = arg('only', null)?.split(',');
// Park the camper somewhere open first: judging materials while it is buried in
// a thicket tells you about the thicket.
const PARK = arg('park', null);
const W = parseInt(arg('w', '1400'), 10);
const H = parseInt(arg('h', '900'), 10);
// Which car to shoot. There is more than one model now (vehicle_models.js) and
// the page picks at random when nothing pins it, which would make a contact
// sheet a coin toss. `--car roamer` for the second one.
const CAR = arg('car', 'camper');
const URL = `${arg('url', (process.env.AUTUMN_URL || 'http://localhost:5178'))}?res=${RES}&car=${CAR}`;

async function main() {
  const release = await acquire('vshot');
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  // Seven authors share the dev server; every save reloads the page and throws
  // out of whatever evaluate was in flight. Stub the HMR socket so a contact
  // sheet is not a coin toss. Pass --hmr to keep live reload.
  if (!argv.includes('--hmr')) {
    await page.addInitScript(() => {
      const Real = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
          return {
            readyState: 3, url, protocol: '',
            addEventListener() {}, removeEventListener() {}, send() {}, close() {},
            set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {},
          };
        }
        return new Real(url, protocols);
      };
      window.WebSocket.prototype = Real.prototype;
    });
  }
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => !!window.__vehicle, null, { timeout: 30000 });
  if (PARK) {
    await page.evaluate((kind) => {
      const p = window.__poi.best(kind) ?? { x: 0, z: 0 };
      window.__vehicleTeleport(p.x, p.z, p.yaw ?? 0.9);
    }, PARK === true ? 'meadow' : PARK);
  }
  await page.waitForTimeout(1500);         // let the springs settle

  mkdirSync(resolve(DIR), { recursive: true });
  const names = (ONLY ?? Object.keys(FRAMES)).filter((n) => FRAMES[n]);

  for (const name of names) {
    const f = FRAMES[name];
    await page.evaluate(async ({ f, hour }) => {
      const THREE = window.__THREE, e = window.__engine, v = window.__vehicle;
      if (hour !== null) { window.__lighting.hour = parseFloat(hour); window.__lighting.cycleSpeed = 0; }
      const a = v.heading + f.az;
      const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      const centre = v.position.clone()
        .addScaledVector(v.forward, f.off ?? 0)
        .addScaledVector(new THREE.Vector3(0, 1, 0), f.aim);
      const pos = centre.clone().addScaledVector(dir, f.dist);
      pos.y = v.position.y + f.elev;
      e.camera.fov = f.fov;
      e.camera.updateProjectionMatrix();
      e.camera.position.copy(pos);
      e.camera.lookAt(centre);
      window.__forceCamera = true;
      if (window.__settle) await window.__settle(30);
    }, { f, hour: HOUR });
    await page.waitForTimeout(900);
    const out = resolve(DIR, `${name}.png`);
    await page.screenshot({ path: out });
    console.log(`shot: ${out}`);
  }

  const stats = await page.evaluate(() => ({
    fps: window.__fps ?? null,
    calls: window.__engine?.renderer?.info?.render?.calls ?? null,
    tris: window.__engine?.renderer?.info?.render?.triangles ?? null,
  }));
  console.log('stats:', JSON.stringify(stats));
  if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 6), null, 1));
  await browser.close();
  release();
}

main().catch((e) => { console.error(e); process.exit(1); });
