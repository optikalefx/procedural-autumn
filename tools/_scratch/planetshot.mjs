#!/usr/bin/env node
/**
 * planetshot — point the telescope at each planet and photograph it.
 *
 *   node tools/_scratch/planetshot.mjs
 *
 * The planets are four fixed directions inside a fragment shader. Nothing in
 * the game knows where they are, so a capture that sweeps the sky hoping to
 * find one is a capture that reports "no planets" when the aim was wrong. This
 * recomputes plDir() in JS from the same constants, aims the real ScopeView at
 * each in turn, and shoots at both ends of the zoom — which is the actual claim
 * being made: a point in normal play, a disc with moons in the eyepiece.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); const v = argv[i + 1];
  return i === -1 ? d : (v && !v.startsWith('--') ? v : true); };
const W = 1600, H = 900;
const DIR = resolve(arg('dir', 'shots/_scratch/planets'));

// Mirrors PL_POLE and plDir() in src/sky/planets.js. If those change, this must.
const norm = (v) => { const l = Math.hypot(...v); return v.map((c) => c / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const POLE = norm([-0.62, 0.57, 0.54]);
const plDir = (lon, lat) => {
  const u = norm(cross(POLE, [0, 1, 0]));
  const v = cross(POLE, u);
  const c = Math.cos(lat), s = Math.sin(lat);
  return norm([0, 1, 2].map((i) => (u[i] * Math.cos(lon) + v[i] * Math.sin(lon)) * c + POLE[i] * s));
};
const PLANETS = [
  { name: 'venus',   lon: 3.70, lat: 0.050,  moons: 0 },
  { name: 'jupiter', lon: 4.35, lat: -0.040, moons: 4 },
  { name: 'mars',    lon: 5.05, lat: 0.070,  moons: 0 },
  { name: 'saturn',  lon: 5.62, lat: -0.050, moons: 2 },
];
for (const p of PLANETS) {
  p.dir = plDir(p.lon, p.lat);
  p.elevDeg = Math.asin(p.dir[1]) * 180 / Math.PI;
  p.yaw = Math.atan2(-p.dir[0], -p.dir[2]);
  p.pitch = Math.asin(p.dir[1]);
}
console.log('planet directions:');
for (const p of PLANETS) console.log(`  ${p.name.padEnd(8)} elevation ${p.elevDeg.toFixed(1)} deg   ${p.elevDeg < 2 ? '(below the skyline — not shootable)' : ''}`);

const release = await acquire('planetshot');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {},
               set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype; Object.assign(window.WebSocket, Real);
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto('http://localhost:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 30000 });
await page.evaluate(() => { window.__lighting.hour = 0; window.__lighting.cycleSpeed = 0; });
await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(1800);
await page.keyboard.down('Space');
await page.waitForTimeout(1500);

const ok = await page.evaluate(async () => {
  const v = window.__systems.vehicle;
  const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  if (!s) return false;
  const THREE = window.__THREE;
  const mod = await import('/src/camp/camp_telescope.js');
  const site = await import('/src/camp/camp_site.js');
  const { mulberry32 } = await import('/src/core/MathUtils.js');
  const camp = window.__camp.camps ? window.__camp.camps[window.__camp.camps.length - 1] : window.__camp;
  const props = camp.props ?? window.__camp.props;
  const x = s.x + 2.4, z = s.z + 1.2, y = window.__world.getHeight(x, z);
  const g = mod.buildTelescope(mulberry32(0x51ed270b), { variant: 'reflector', wear: 0.45 });
  g.position.set(x, y, z);
  const q = new THREE.Quaternion();
  site.standOn(window.__world, x, z, 0.4, 0.22, q);
  g.quaternion.copy(q);
  (camp.root ?? window.__camp.root).add(g);
  props.push({ obj: g, item: { kind: 'telescope', x, y, z, yaw: 0.4 }, delay: 0 });
  window.__camp.scope.enter(g);
  return true;
});
if (!ok) { console.error('planetshot: no site'); await browser.close(); release(); process.exit(2); }
await page.waitForTimeout(1400);

mkdirSync(DIR, { recursive: true });
const aim = async (p, fov) => {
  await page.evaluate(({ yaw, pitch, fov }) => {
    const s = window.__camp.scope;
    s.yaw = yaw; s.pitch = pitch; s.fov = fov; s.fovTarget = fov;
  }, { yaw: p.yaw, pitch: p.pitch, fov });
  await page.waitForTimeout(700);
};

for (const p of PLANETS) {
  if (p.elevDeg < 2) { console.log(`${p.name}: below the skyline, skipped`); continue; }
  for (const fov of [6, 18]) {
    await aim(p, fov);
    await page.screenshot({ path: resolve(DIR, `${p.name}-fov${fov}.png`) });
  }
  console.log(`shot ${p.name} (${p.moons} moons)`);
}
// And the other end of the claim: what a planet looks like in normal play,
// with no telescope involved. If it is a blob at the game's own 52 deg it is
// not a planet, it is a bug in the sky.
await page.keyboard.press('Escape');
await page.waitForTimeout(900);
for (const p of PLANETS) {
  if (p.elevDeg < 2) continue;
  await page.evaluate(({ yaw, pitch }) => {
    const THREE = window.__THREE, cam = window.__engine.camera;
    window.__forceCamera = true;
    cam.fov = 52; cam.updateProjectionMatrix();
    cam.rotation.set(pitch, yaw, 0, 'YXZ');
  }, { yaw: p.yaw, pitch: p.pitch });
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(DIR, `${p.name}-play52.png`), clip: { x: 640, y: 290, width: 320, height: 320 } });
}
console.log('shot all four at the game default 52 deg (320px crops)');

console.log(errs.length ? `PAGE ERRORS:\n  ${errs.slice(0, 6).join('\n  ')}` : 'no page errors');
console.log(DIR);
await browser.close();
release();
