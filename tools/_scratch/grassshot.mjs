// Close-range grass judgement frame: eye at 0.55 m over the meadow anchor,
// looking at a point 2 m ahead — which is what the player actually sees of the
// field. Supports --variants like lookdiag so several blade tunings can be
// compared inside one page load.
import { chromium } from 'playwright';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const W = parseInt(arg('w', '1600'), 10), H = parseInt(arg('h', '900'), 10);
const RES = arg('res', null);
const ANCHOR = arg('anchor', 'meadow');
const EYE = parseFloat(arg('eye', '0.55'));
const DIST = parseFloat(arg('dist', '2.0'));
const FOV = parseFloat(arg('fov', '40'));
const HOUR = parseFloat(arg('hour', '17.2'));
const OUT = arg('out', null);

await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto('http://localhost:5178' + (RES ? `?res=${RES}` : ''), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
const frozen = existsSync('review/anchors.json') ? JSON.parse(readFileSync('review/anchors.json', 'utf8')) : {};

await page.evaluate(({ a, eye, dist, fov, hour, faceSun }) => {
  const THREE = window.__THREE, e = window.__engine, wd = window.__world;
  window.__lighting.hour = hour;
  window.__lighting.cycleSpeed = 0;
  window.__atmosphere.params.cloudShadow = 0;
  let yaw = a.yaw ?? 0;
  if (faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
  const pos = new THREE.Vector3(a.x, wd.getHeight(a.x, a.z) + eye, a.z);
  const tx = a.x + Math.sin(yaw) * dist, tz = a.z + Math.cos(yaw) * dist;
  const look = new THREE.Vector3(tx, wd.getHeight(tx, tz) + 0.12, tz);
  e.camera.fov = fov; e.camera.updateProjectionMatrix();
  e.camera.position.copy(pos); e.camera.lookAt(look);
  window.__forceCamera = true;
  window.dispatchEvent(new Event('resize'));
}, { a: frozen[ANCHOR], eye: EYE, dist: DIST, fov: FOV, hour: HOUR, faceSun: argv.includes('--facesun') });

await page.evaluate(() => window.__settle?.(90));
await page.waitForTimeout(1500);

if (OUT) {
  if (!existsSync(dirname(resolve(OUT)))) mkdirSync(dirname(resolve(OUT)), { recursive: true });
  await page.screenshot({ path: resolve(OUT) });
  console.log('shot:', OUT);
}
const VAR = arg('variants', null), DIR = arg('dir', 'shots/look/grass');
if (VAR) {
  mkdirSync(resolve(DIR), { recursive: true });
  for (const [name, js] of JSON.parse(VAR)) {
    await page.evaluate((s) => eval(s), js);
    await page.evaluate(() => window.__settle?.(30));
    await page.waitForTimeout(700);
    await page.screenshot({ path: resolve(DIR, name + '.png') });
    console.log('shot:', name);
  }
}
await browser.close();
