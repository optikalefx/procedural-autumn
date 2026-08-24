#!/usr/bin/env node
/**
 * Who is actually lighting the frame, hour by hour.
 *
 * Same trick as fireworth.mjs: shoot each hour twice per light — once whole,
 * once with that one light zeroed — and difference them. The difference IS
 * that light's contribution, and unlike reading intensities off the objects it
 * accounts for the thing that matters at twilight, which is that a key below
 * the horizon still lights VERTICAL faces at full strength while contributing
 * nothing at all to flat ground.
 *
 * So the frame is split: `gnd` is the near ground the camera looks down on,
 * `vert` is the band where the tent, the camper and the trunks stand.
 *
 *   node tools/_scratch/keysplit.mjs --dir review/keysplit --url http://127.0.0.1:5190
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { readPNG } from '../_pngread.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); if (i === -1) return d;
  const v = argv[i + 1]; return v && !v.startsWith('--') ? v : true; };

const DIR = arg('dir', 'review/keysplit');
const URL = `${arg('url', 'http://127.0.0.1:5190')}/?res=768`;
const W = 1280, H = 720;
const HOURS = String(arg('hours', '18.4,18.9,19.0,19.4,20.0,21.0')).split(',').map(Number);
const F = { az: 3.14, dist: 8.0, elev: 1.6, fov: 46, aim: 0.5 };

// Each arm zeroes exactly one light for one frame.
const LIGHTS = ['none', 'sun', 'hemi', 'fill', 'moon'];

function bands(a, b) {
  // vert: the horizon band, where standing things are. gnd: the near ground.
  const w = a.w, h = a.h;
  const reg = { vert: [Math.floor(h * 0.30), Math.floor(h * 0.55)],
                gnd:  [Math.floor(h * 0.62), h] };
  const out = {};
  for (const [k, [y0, y1]] of Object.entries(reg)) {
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      sum += (Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1])
            + Math.abs(a.px[i + 2] - b.px[i + 2])) / 3;
      n++;
    }
    out[k] = +(sum / n).toFixed(2);
  }
  return out;
}

async function main() {
  const release = await acquire('keysplit');
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
  page.on('pageerror', (e) => console.log('ERR', String(e)));
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
    return s ? { x: s.x, y: s.y, z: s.z, radius: s.radius,
      vehAxis: Math.atan2(v.position.x - s.x, v.position.z - s.z) } : null;
  });
  if (!site) { console.error('no camp site'); await browser.close(); release(); process.exit(2); }
  mkdirSync(resolve(DIR), { recursive: true });

  const shoot = (hour, kill) => page.evaluate(async (a) => {
    const THREE = window.__THREE, e = window.__engine, L = window.__lighting;
    L.hour = a.hour; L.cycleSpeed = 0;
    // Kill one light AFTER the frame's update() has written it, every frame.
    if (!L.__ks) {
      L.__ks = 1;
      const orig = L.update.bind(L);
      L.update = function (dt, focus) {
        orig(dt, focus);
        const k = L.__kill;
        if (k && k !== 'none' && L[k]) L[k].intensity = 0;
      };
    }
    L.__kill = a.kill;
    // The fire is not the subject here, and its flicker is noise on a diff.
    window.__fireTune = { gain: 1, light: 0.00001, dist: 1, decay: NaN, dayI: NaN,
      duskI: NaN, nightI: NaN, bed: 1, ember: 1, smoke: 1, knee: 1, elev: NaN };
    const ang = a.site.vehAxis + a.F.az, dist = a.F.dist * Math.max(0.62, (a.site.radius ?? 5.8) / 5.8);
    e.camera.fov = a.F.fov; e.camera.updateProjectionMatrix();
    e.camera.position.set(a.site.x + Math.sin(ang) * dist, a.site.y + a.F.elev, a.site.z + Math.cos(ang) * dist);
    e.camera.lookAt(new THREE.Vector3(a.site.x, a.site.y + a.F.aim, a.site.z));
    window.__forceCamera = true;
    if (window.__settleStable) await window.__settleStable(600, 24);
    return { sunElev: +L.sunDir.y.toFixed(4), sunI: +L.sun.intensity.toFixed(2),
      sunShadow: L.sun.castShadow, hemiI: +L.hemi.intensity.toFixed(3),
      moonI: +(L.moon?.intensity ?? -1).toFixed(3), moonShadow: !!L.moon?.castShadow,
      moonElevDeg: +(Math.asin(Math.max(-1, Math.min(1, L.moon?.position?.clone().normalize().y ?? 0))) * 180 / Math.PI).toFixed(1) };
  }, { hour, kill, site, F });

  const rows = [];
  for (const hour of HOURS) {
    const info = await shoot(hour, 'none');
    await page.waitForTimeout(300);
    const base = resolve(DIR, `h${String(hour).replace('.', 'p')}-all.png`);
    await page.screenshot({ path: base });
    const A = readPNG(base);
    const contrib = {};
    for (const k of LIGHTS.slice(1)) {
      await shoot(hour, k);
      await page.waitForTimeout(300);
      const f = resolve(DIR, `h${String(hour).replace('.', 'p')}-no${k}.png`);
      await page.screenshot({ path: f });
      contrib[k] = bands(A, readPNG(f));
    }
    rows.push({ hour, ...info, contrib });
    console.log(`h${String(hour).padEnd(5)} elev ${String(info.sunElev).padEnd(8)} sunI ${String(info.sunI).padEnd(5)} ` +
      `(shadow ${String(info.sunShadow).padEnd(5)}) moonI ${String(info.moonI).padEnd(6)} moon ${String(info.moonElevDeg).padEnd(5)}deg`);
    for (const k of LIGHTS.slice(1)) {
      console.log(`      ${k.padEnd(5)} -> ground ${String(contrib[k].gnd).padEnd(7)} standing ${contrib[k].vert}`);
    }
  }
  writeFileSync(resolve(DIR, 'ROWS.json'), JSON.stringify(rows, null, 1));
  await browser.close(); release();
}
main().catch((e) => { console.error(e); process.exit(1); });
