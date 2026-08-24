#!/usr/bin/env node
/**
 * What is the fire's light WORTH at each hour, and what eats it.
 *
 * Layout-independent by construction: at every hour the same frame is shot
 * twice, once with the fire's point light on and once with it off, and the
 * answer is the difference between them. That is exactly "how much of this
 * picture is the fire", and it does not care where the camp lottery put the
 * tent.
 *
 * Arms move ONE post term at a time to the value it would hold at full night,
 * so a change in the fire's worth can be attributed to a term rather than to
 * the hour.
 *
 *   node tools/_scratch/zz_fireworth.mjs --dir review/fireworth --url http://127.0.0.1:5190
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { readPNG } from '../_pngread.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); if (i === -1) return d;
  const v = argv[i + 1]; return v && !v.startsWith('--') ? v : true; };

const DIR = arg('dir', 'review/fireworth');
const URL = `${arg('url', 'http://127.0.0.1:5190')}/?res=768`;
const W = 1280, H = 720;
const HOURS = String(arg('hours', '18.4,18.9,19.0,19.4,20.0,20.6,21.0,23.0')).split(',').map(Number);

// Tight on the camp: fire in the middle, chairs and tent in the ring.
const F = { az: 3.14, dist: 6.4, elev: 1.35, fov: 46, aim: 0.45 };

const PATCH = `
  const P = window.__postfx;
  if (!P.__fw) {
    P.__fw = 1;
    const orig = P._driveTimeOfDay.bind(P);
    P._driveTimeOfDay = function () {
      orig();
      const o = P.__ov;
      if (!o) return;
      const u = P.grade.uniforms;
      if (o.contrast != null) u.get('uContrast').value = o.contrast;
      if (o.lift != null) u.get('uLift').value = o.lift;
      if (o.toe != null) u.get('uToe').value = o.toe;
      if (o.offset != null) P.tone.offsetScale = o.offset;
      if (o.expo != null) P.tone.exposure = P._baseExposure * o.expo;
    };
  }
`;

const HRS = [19.0, 19.4];
const ARMS = [
  { name: 'ship',     ov: 'null' },
  { name: 'c105',     ov: '{ contrast: 1.05 }',                hoursOnly: HRS },
  { name: 'c130',     ov: '{ contrast: 1.30 }',                hoursOnly: HRS },
  { name: 'lift',     ov: '{ lift: 0.003 }',                   hoursOnly: HRS },
  { name: 'toe',      ov: '{ toe: 0.0088 }',                   hoursOnly: HRS },
  { name: 'offset',   ov: '{ offset: 0.15 }',                  hoursOnly: HRS },
  { name: 'expo',     ov: '{ expo: 1.166 }',                   hoursOnly: HRS },
  { name: 'nightall', ov: '{ contrast: 1.05, lift: 0.003, toe: 0.0088, offset: 0.15, expo: 1.166 }', hoursOnly: HRS },
];

function diffStats(a, b) {
  // Mean absolute sRGB difference over the lower 2/3 of the frame (ground and
  // props; the sky and the massif are not what the fire lights), plus the
  // count of pixels the fire moves by more than 8 levels — "how much of the
  // picture can you see the fire in".
  const w = a.w, h = a.h, y0 = Math.floor(h * 0.34);
  let sum = 0, n = 0, hit = 0, peak = 0;
  for (let y = y0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const d = (Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1])
               + Math.abs(a.px[i + 2] - b.px[i + 2])) / 3;
      sum += d; n++;
      if (d > 8) hit++;
      if (d > peak) peak = d;
    }
  }
  return { mean: +(sum / n).toFixed(3), pct: +(100 * hit / n).toFixed(2), peak: +peak.toFixed(0) };
}

async function main() {
  const release = await acquire('fireworth');
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (String(protocols).includes('vite')) return { readyState: 3, url, protocol: '',
        addEventListener(){}, removeEventListener(){}, send(){}, close(){},
        set onopen(_){}, set onmessage(_){}, set onclose(_){}, set onerror(_){} };
      return new Real(url, protocols);
    };
    window.WebSocket.prototype = Real.prototype;
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 30000 });
  await page.evaluate(() => {
    const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
    window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
  });
  await page.waitForTimeout(1600);
  const site = await page.evaluate(() => {
    const v = window.__systems.vehicle;
    const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
    if (!s) return null;
    return { x: s.x, y: s.y, z: s.z, radius: s.radius,
      vehAxis: Math.atan2(v.position.x - s.x, v.position.z - s.z) };
  });
  if (!site) { console.error('no camp site'); await browser.close(); release(); process.exit(2); }
  mkdirSync(resolve(DIR), { recursive: true });

  const pose = async ({ F, site, hour, patch, ov, fire }) => page.evaluate(async (a) => {
    const THREE = window.__THREE, e = window.__engine;
    window.__lighting.hour = a.hour; window.__lighting.cycleSpeed = 0;
    // eslint-disable-next-line no-new-func
    new Function(a.patch)();
    // eslint-disable-next-line no-new-func
    window.__postfx.__ov = new Function('return ' + a.ov)();
    window.__fireTune = { gain: 1, light: a.fire ? 1 : 0.00001, dist: 1, decay: NaN,
      dayI: NaN, duskI: NaN, nightI: NaN, bed: 1, ember: 1, smoke: 1, knee: 1, elev: NaN };
    const ang = a.site.vehAxis + a.F.az, dist = a.F.dist * Math.max(0.62, (a.site.radius ?? 5.8) / 5.8);
    e.camera.fov = a.F.fov; e.camera.updateProjectionMatrix();
    e.camera.position.set(a.site.x + Math.sin(ang) * dist, a.site.y + a.F.elev, a.site.z + Math.cos(ang) * dist);
    e.camera.lookAt(new THREE.Vector3(a.site.x, a.site.y + a.F.aim, a.site.z));
    window.__forceCamera = true;
    if (window.__settleStable) await window.__settleStable(600, 24);
    return {
      sunElev: +window.__lighting.sunDir.y.toFixed(4),
      fireI: +window.__camp.fireLight.intensity.toFixed(3),
      contrast: +window.__postfx.grade.uniforms.get('uContrast').value.toFixed(3),
      lift: +window.__postfx.grade.uniforms.get('uLift').value.toFixed(4),
      expo: +window.__postfx.tone.exposure.toFixed(4),
      uNight: +window.__postfx.grade.uniforms.get('uNight').value.toFixed(3),
    };
  }, { F, site, hour, patch, ov, fire });

  const rows = [];
  for (const hour of HOURS) {
    for (const arm of ARMS) {
      if (arm.hoursOnly && !arm.hoursOnly.includes(hour)) continue;
      const tag = `h${String(hour).replace('.', 'p')}-${arm.name}`;
      const info = await pose({ F, site, hour, patch: PATCH, ov: arm.ov, fire: true });
      await page.waitForTimeout(350);
      const fA = resolve(DIR, `${tag}-fire.png`);
      await page.screenshot({ path: fA });
      await pose({ F, site, hour, patch: PATCH, ov: arm.ov, fire: false });
      await page.waitForTimeout(350);
      const fB = resolve(DIR, `${tag}-nofire.png`);
      await page.screenshot({ path: fB });
      const d = diffStats(readPNG(fA), readPNG(fB));
      rows.push({ hour, arm: arm.name, ...info, ...d });
      console.log(`h${String(hour).padEnd(5)} ${arm.name.padEnd(9)} elev ${String(info.sunElev).padEnd(8)} ` +
        `fireI ${String(info.fireI).padEnd(6)} con ${String(info.contrast).padEnd(6)} lift ${String(info.lift).padEnd(7)} ` +
        `expo ${String(info.expo).padEnd(7)} | fire worth: mean ${String(d.mean).padEnd(7)} pct>8 ${String(d.pct).padEnd(6)} peak ${d.peak}`);
    }
  }
  writeFileSync(resolve(DIR, 'ROWS.json'), JSON.stringify(rows, null, 1));
  if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 4), null, 1));
  await browser.close(); release();
}
main().catch((e) => { console.error(e); process.exit(1); });
