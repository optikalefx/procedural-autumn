#!/usr/bin/env node
/**
 * tentlab — put the A-frame in a real camp, on real ground, at real scale.
 *
 *   node tools/_scratch/tentlab.mjs --dir shots/camp/ridge/r1 --colorway 0
 *   node tools/_scratch/tentlab.mjs --dir shots/camp/ridge/r1 --colorway 2 --wide
 *
 * The gallery stage is a neutral studio and it lies about two things this prop
 * lives or dies on: value against red dirt and granite, and scale against a
 * 4.7 m camper. So this pitches the camp exactly as `campshot` does, then swaps
 * whichever tent the layout rolled for a ridge tent of the wanted colourway at
 * the same position, yaw and tilt — same argument as `scopelab.mjs`, which
 * cannot wait for the RNG to place a telescope either.
 *
 * `--wide` also shoots the hearth and wide framings, which is the only pair that
 * says whether the thing belongs in the camp at all: a prop that is beautiful in
 * a turntable and wrong in the wide shot is a failed prop.
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

const DIR = arg('dir', 'shots/camp/ridge/lab');
const CW = parseInt(arg('colorway', '0'), 10);
const PREFIX = arg('prefix', `cw${CW}`);
const RES = arg('res', '768');
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const WEAR = parseFloat(arg('wear', '0.45'));
const DAY = parseFloat(arg('hour', '11.0'));

// campshot's PROP.tent framing, verbatim.
const P = { az: 0.80, dist: 3.9, elev: 1.35, fov: 38, aim: 0.55 };

const release = await acquire('tentlab');
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
page.on('crash', () => errors.push('PAGE CRASHED'));

await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 30000 });

await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(1600);

const site = await page.evaluate(async ({ colorway, wear }) => {
  const v = window.__systems.vehicle;
  const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  if (!s) return null;
  const THREE = window.__THREE;
  const mod = await import('/src/camp/camp_tent_ridge.js');
  const siteMod = await import('/src/camp/camp_site.js');
  const { mulberry32 } = await import('/src/core/MathUtils.js');

  // Take the layout's own tent slot — position, yaw and tilt — and put the
  // A-frame in it. Anything else would be measuring a placement nobody ships.
  const i = window.__camp.props.findIndex((p) => p.item.kind === 'tent');
  if (i === -1) return null;
  const old = window.__camp.props[i];
  const it = old.item;
  window.__camp.root.remove(old.obj);

  const g = mod.buildRidgeTent(mulberry32(0x4a17e5 + colorway), { colorway, wear });
  g.position.set(it.x, it.y, it.z);
  const q = new THREE.Quaternion();
  siteMod.standOn(window.__world, it.x, it.z, it.yaw, it.tilt ?? 0.55, q);
  g.quaternion.copy(q);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  window.__camp.root.add(g);
  window.__camp.props[i] = { obj: g, item: it, delay: 0 };
  // The pitch was `instant`, so the raise has already run and every other prop
  // is at scale 1. Set this one there by hand rather than re-running
  // `_applyRaise`, whose signature is not this harness's business.
  g.visible = true;
  g.scale.setScalar(1);

  const bb = new THREE.Box3().setFromObject(g);
  return { ...s, x: it.x, y: it.y, z: it.z, yaw: it.yaw,
           height: bb.max.y - bb.min.y, minY: bb.min.y - it.y,
           foot: g.userData.footprint, colorway: g.userData.colorway,
           vehAxis: Math.atan2(v.position.x - s.x, v.position.z - s.z) };
}, { colorway: CW, wear: WEAR });

if (!site) { console.error('tentlab: no camp / no tent slot'); await browser.close(); release(); process.exit(2); }
console.log(`tentlab: ${site.colorway} at ${site.x.toFixed(1)},${site.z.toFixed(1)} ` +
            `height ${site.height.toFixed(3)} m  minY ${site.minY.toFixed(4)}  foot ${site.foot.toFixed(3)}`);
mkdirSync(resolve(DIR), { recursive: true });
await page.waitForTimeout(1200);
const jobs = [
  ['front', 0.00], ['fq', 0.80], ['side', 1.57], ['bq', 2.35], ['back', 3.14],
].map(([name, az]) => ({ name: `${PREFIX}-${name}`, f: { ...P, az }, hour: DAY, on: 'tent' }));
jobs.push({ name: `${PREFIX}-dusk`, f: { ...P, az: 0.80 }, hour: 20.4, on: 'tent' });
if (has('wide')) {
  jobs.push({ name: `${PREFIX}-hearth`, f: { az: 3.14, dist: 8.5, elev: 1.55, fov: 46, aim: 0.55 }, hour: DAY, on: 'site' });
  jobs.push({ name: `${PREFIX}-wide`, f: { az: 2.35, dist: 22.0, elev: 5.0, fov: 42, aim: 0.9 }, hour: DAY, on: 'site' });
}

for (const job of jobs) {
  try {
  await page.evaluate(async ({ f, hour, on, site: st }) => {
    const THREE = window.__THREE, e = window.__engine;
    window.__lighting.hour = hour; window.__lighting.cycleSpeed = 0;
    const p = on === 'tent'
      ? window.__camp.props.find((q) => q.item.kind === 'tent').item
      : { x: st.x, y: st.y, z: st.z, yaw: st.vehAxis };
    const a = p.yaw + f.az;
    e.camera.fov = f.fov;
    e.camera.updateProjectionMatrix();
    e.camera.position.set(p.x + Math.sin(a) * f.dist, p.y + f.elev, p.z + Math.cos(a) * f.dist);
    e.camera.lookAt(new THREE.Vector3(p.x, p.y + f.aim, p.z));
    window.__forceCamera = true;
    if (window.__settleStable) await window.__settleStable(600, 24);
  }, { f: job.f, hour: job.hour, on: job.on,
       site: { x: site.x, y: site.y, z: site.z, vehAxis: site.vehAxis } });
  await page.waitForTimeout(600);
  const out = resolve(DIR, `${job.name}.png`);
  await page.screenshot({ path: out });
  console.log(`shot: ${out}`);
  } catch (e) { console.log(`FAILED ${job.name}: ${e.message.split('\n')[0]}`); break; }
}

if (errors.length) console.log('page-errors:', JSON.stringify([...new Set(errors)].slice(0, 8), null, 1));
await browser.close();
release();
