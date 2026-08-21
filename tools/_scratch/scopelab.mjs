#!/usr/bin/env node
/**
 * scopelab — turntable a camp telescope that the layout only rolls 1 time in 6.
 *
 *   node tools/_scratch/scopelab.mjs --dir shots/camp/scope/r1 --variant reflector
 *   node tools/_scratch/scopelab.mjs --dir shots/camp/scope/r1 --variant refractor --small
 *
 * Same argument as `chairlab.mjs`, one step further along. `campshot
 * --turntable telescope` needs the layout to have placed one, and the whole
 * point of this prop is that it usually has not — waiting for the RNG is not a
 * capture strategy. So: pitch the camp exactly as campshot does, then build the
 * telescope directly and drop it where the layout would have put it (on the
 * flank behind the seats), keeping campshot's own framings so a lab frame and a
 * contact-sheet frame of the same object are the same picture.
 *
 * `--wide` also shoots the hearth framing with the scope in it, which is the
 * only frame that says whether the thing belongs in the camp at all — a prop
 * that is beautiful in a turntable and wrong in the wide shot is a failed prop.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

const DIR = arg('dir', 'shots/camp/scope/lab');
const VARIANT = arg('variant', 'reflector');
const PREFIX = arg('prefix', VARIANT);
const RES = arg('res', '768');
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const WEAR = parseFloat(arg('wear', '0.45'));

// campshot's PROP.telescope framing, verbatim.
const P = { az: 0.85, dist: 2.90, elev: 1.30, fov: 36, aim: 0.72 };
const SMALL_P = { az: 0.85, dist: 2.00, elev: 0.95, fov: 36, aim: 0.48 };

const release = await acquire('scopelab');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {},
               set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 30000 });

await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(1600);

const site = await page.evaluate(async ({ variant, wear, small }) => {
  const v = window.__systems.vehicle;
  const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14, small });
  if (!s) return null;
  const THREE = window.__THREE;
  const mod = await import('/src/camp/camp_telescope.js');
  const site = await import('/src/camp/camp_site.js');
  const { mulberry32 } = await import('/src/core/MathUtils.js');

  // Where the layout would have put it: on the flank behind the seats.
  const chairs = window.__camp.props.filter((p) => p.item.kind === 'chair');
  let ax = 0, az = 0;
  for (const c of chairs) { ax += c.item.x - s.x; az += c.item.z - s.z; }
  const seat = chairs.length ? Math.atan2(az, ax) : 0;
  const R = window.__camp.site?.radius ?? 5.8;
  const a = seat + 1.7;
  const r = R * (small ? 0.53 : 0.55);
  const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
  const y = window.__world.getHeight(x, z);

  const g = mod.buildTelescope(mulberry32(0x51ed270b), { variant, wear });
  g.position.set(x, y, z);
  const q = new THREE.Quaternion();
  site.standOn(window.__world, x, z, Math.atan2(s.x - x, s.z - z), 0.22, q);
  g.quaternion.copy(q);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  window.__camp.root.add(g);
  window.__camp.props.push({ obj: g, item: { kind: 'telescope', x, y, z, yaw: Math.atan2(s.x - x, s.z - z) }, delay: 0 });

  const bb = new THREE.Box3().setFromObject(g);
  return { ...s, x, z, y, yaw: Math.atan2(s.x - x, s.z - z),
           height: bb.max.y - bb.min.y, minY: bb.min.y - y,
           foot: g.userData.footprint,
           vehAxis: Math.atan2(v.position.x - s.x, v.position.z - s.z) };
}, { variant: VARIANT, wear: WEAR, small: has('small') });

if (!site) { console.error('scopelab: no valid site'); await browser.close(); release(); process.exit(2); }
console.log(`scopelab: ${VARIANT} at ${site.x.toFixed(1)},${site.z.toFixed(1)} ` +
            `height ${site.height.toFixed(3)} m  minY ${site.minY.toFixed(4)}  foot ${site.foot.toFixed(3)}`);
mkdirSync(resolve(DIR), { recursive: true });

const F = VARIANT === 'refractor' ? SMALL_P : P;
const AZ = [
  ['front', 0.00, F.elev], ['fq', 0.75, F.elev], ['side', 1.57, F.elev],
  ['bq', 2.35, F.elev], ['back', 3.14, F.elev], ['high', 0.90, F.elev + F.dist * 0.75],
];
// Every job names its own hour. `--hour` on one frame freezes the cycle for the
// whole session, so a job list where only the dusk frame sets one shoots every
// frame AFTER it at dusk too — which is how the first run produced a "midday"
// camp frame lit by the fire.
const DAY = parseFloat(arg('hour', '11.0'));
const jobs = AZ.map(([name, az, elev]) => ({ name: `${PREFIX}-${name}`, f: { ...F, az, elev }, hour: DAY }));
jobs.push({ name: `${PREFIX}-dusk`, f: { ...F, az: 0.85 }, hour: 20.4 });
if (has('wide')) {
  jobs.push({ name: `${PREFIX}-camp`, f: { az: 0.85, dist: 8.2, elev: 2.2, fov: 46, aim: 1.1 }, hour: DAY });
  jobs.push({ name: `${PREFIX}-campdusk`, f: { az: 0.85, dist: 8.2, elev: 2.2, fov: 46, aim: 1.1 }, hour: 20.4 });
}

for (const job of jobs) {
  await page.evaluate(async ({ f, hour }) => {
    const THREE = window.__THREE, e = window.__engine;
    if (hour !== null) { window.__lighting.hour = hour; window.__lighting.cycleSpeed = 0; }
    const p = window.__camp.props.find((q) => q.item.kind === 'telescope').item;
    const a = p.yaw + f.az;
    e.camera.fov = f.fov;
    e.camera.updateProjectionMatrix();
    e.camera.position.set(p.x + Math.sin(a) * f.dist, p.y + f.elev, p.z + Math.cos(a) * f.dist);
    e.camera.lookAt(new THREE.Vector3(p.x, p.y + f.aim, p.z));
    window.__forceCamera = true;
    if (window.__settleStable) await window.__settleStable(600, 24);
  }, { f: job.f, hour: job.hour });
  await page.waitForTimeout(600);
  const out = resolve(DIR, `${job.name}.png`);
  await page.screenshot({ path: out });
  console.log(`shot: ${out}`);
}

if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 8), null, 1));
await browser.close();
release();
