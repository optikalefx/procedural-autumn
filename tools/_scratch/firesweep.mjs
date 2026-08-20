#!/usr/bin/env node
/**
 * Sweep a camp_fire tuning knob at a fixed hour, in ONE page load.
 *
 *   node tools/_scratch/firesweep.mjs --hour 20.4 --key light --vals 1,1.6,2.4,3.4
 *
 * The capture pool holds two slots and a page load is most of a minute, so a
 * ladder of eight guesses through campshot is twenty minutes of queue for eight
 * frames of the same camp. This drives `window.__fireTune` between screenshots
 * instead. Scratch only — the shipping look is always re-shot through campshot.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const HOUR = parseFloat(arg('hour', '20.4'));
const KEY = arg('key', 'light');
const VALS = arg('vals', '1').split(',').map(Number);
const DIR = arg('dir', 'shots/camp/fire/sweep');
const VIEW = arg('view', 'fireside');
const FIX = arg('fix', '');   // e.g. "gain=2.4,bed=0.6"
const W = 1600, H = 900;

const VIEWS = {
  fireside: { az: 0.75, dist: 3.3, elev: 0.62, fov: 40, aim: 0.35 },
  fire:     { az: 0.60, dist: 1.90, elev: 0.75, fov: 36, aim: 0.30 },
  hearth:   { az: 3.14, dist: 8.5, elev: 1.55, fov: 46, aim: 0.55, ref: 'vehicle' },
};

const release = await acquire('firesweep');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (p === 'vite-hmr' || String(p).includes('vite')) {
      return { readyState: 3, url: u, addEventListener(){}, removeEventListener(){}, send(){}, close(){},
               set onopen(_){}, set onmessage(_){}, set onclose(_){}, set onerror(_){} };
    }
    return new Real(u, p);
  };
  window.WebSocket.prototype = Real.prototype;
});
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:5178/?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 30000 });
await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(1600);
const site = await page.evaluate((hour) => {
  const v = window.__systems.vehicle;
  window.__lighting.hour = hour; window.__lighting.cycleSpeed = 0;
  const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  if (!s) return null;
  const chairs = window.__camp.props.filter((p) => p.item.kind === 'chair');
  let ax = 0, az = 0;
  for (const c of chairs) { ax += c.item.x - s.x; az += c.item.z - s.z; }
  return { ...s, axis: chairs.length ? Math.atan2(ax, az) : 0,
           vehAxis: Math.atan2(v.position.x - s.x, v.position.z - s.z) };
}, HOUR);
if (!site) { console.error('no site'); await browser.close(); release(); process.exit(2); }

mkdirSync(resolve(DIR), { recursive: true });
const fix = {};
for (const kv of FIX.split(',')) { if (!kv) continue; const [k, v] = kv.split('='); fix[k] = Number(v); }

for (const val of VALS) {
  await page.evaluate(async ({ f, site, key, val, fix }) => {
    const THREE = window.__THREE, e = window.__engine;
    window.__fireTune = { gain: 1, light: 1, bed: 1, ember: 1, smoke: 1, knee: 1, ...fix, [key]: val };
    const a = (f.ref === 'vehicle' ? site.vehAxis : site.axis) + f.az;
    e.camera.fov = f.fov; e.camera.updateProjectionMatrix();
    e.camera.position.set(site.x + Math.sin(a) * f.dist, site.y + f.elev, site.z + Math.cos(a) * f.dist);
    e.camera.lookAt(site.x, site.y + f.aim, site.z);
    window.__forceCamera = true;
    if (window.__settleStable) await window.__settleStable(600, 24);
  }, { f: VIEWS[VIEW], site, key: KEY, val, fix });
  await page.waitForTimeout(400);
  const out = resolve(DIR, `${VIEW}-${KEY}-${val}.png`);
  await page.screenshot({ path: out });
  console.log('shot:', out);
}
if (errors.length) console.log('page-errors:', errors.slice(0, 5));
await browser.close();
release();
