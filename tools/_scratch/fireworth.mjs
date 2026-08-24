#!/usr/bin/env node
/**
 * What is a camp fire's light WORTH on screen at each hour, and what eats it.
 *
 * Layout-independent by construction: at every hour the same instant is drawn
 * twice, once with the fire's point light on and once with it off, and the
 * answer is the difference. That is exactly "how much of this picture is the
 * fire", and it does not care where the camp lottery put the tent.
 *
 * ── THE CLOCK IS FROZEN, AND THE FIRST VERSION OF THIS FILE WASN'T ─────────
 *
 * The first version let the engine run between the two grabs and read a
 * noise floor as signal. How large a floor: the sibling instrument
 * (keysplit.mjs, same construction) reported the MOON contributing 14.5 sRGB
 * levels to a frame in which the moon's intensity was exactly zero — that is
 * the grass, the leaf cards and the embers moving between the two shots, and
 * it is not a constant, it ran 2.9 to 14.5 across six hours. An hour-to-hour
 * comparison built on it is comparing wind as much as fire.
 *
 * So the engine is STOPPED and both frames of a pair are drawn from one
 * pinned instant, the idiom sepdiag.mjs and shadowcrawl.mjs already use and
 * for the same reason. Sun elevation is written directly rather than through
 * `hour`, because Lighting.update() does not run while the engine is stopped.
 *
 *   node tools/_scratch/fireworth.mjs --dir review/fireworth --url http://127.0.0.1:5190
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
const HOURS = String(arg('hours', '17.1,18.3,18.9,19.0,19.4,20.0,20.6,21.0,23.0')).split(',').map(Number);
const F = { az: 3.14, dist: 6.4, elev: 1.35, fov: 46, aim: 0.45 };

// `before` puts the three split terms back on the `night` ramp, i.e. the tree
// as it stood before the split. Computed in the page from sunElev so the two
// arms differ in nothing else.
const ARMS = String(arg('arms', 'after,before')).split(',');

function diffStats(a, b) {
  const w = a.w, h = a.h, y0 = Math.floor(h * 0.34);
  let sum = 0, n = 0, hit = 0, peak = 0;
  for (let y = y0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const d = (Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1])
             + Math.abs(a.px[i + 2] - b.px[i + 2])) / 3;
    sum += d; n++;
    if (d > 8) hit++;
    if (d > peak) peak = d;
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

  // Pose and settle while the engine still runs, then stop it for good.
  await page.evaluate(async (a) => {
    const THREE = window.__THREE, e = window.__engine;
    const ang = a.site.vehAxis + a.F.az, dist = a.F.dist * Math.max(0.62, (a.site.radius ?? 5.8) / 5.8);
    e.camera.fov = a.F.fov; e.camera.updateProjectionMatrix();
    e.camera.position.set(a.site.x + Math.sin(ang) * dist, a.site.y + a.F.elev, a.site.z + Math.cos(ang) * dist);
    e.camera.lookAt(new THREE.Vector3(a.site.x, a.site.y + a.F.aim, a.site.z));
    window.__forceCamera = true;
    if (window.__settleStable) await window.__settleStable(1200, 40);
  }, { site, F });

  await page.evaluate(() => {
    const e = window.__engine;
    e.stop();
    window.__frozenDraw = () => { if (e._render) e._render(0, e.elapsed); else e.renderer.render(e.scene, e.camera); };
    const u = window.__systems.trees?.shared;
    if (u) { u.uTime.value = 20; u.uWindStrength.value = 0.45; u.uWindDir.value.set(1, 0, 0); }
    window.__frozenDraw(); window.__frozenDraw();
  });

  // One pinned instant, drawn with the fire lit and then dark. Everything the
  // fire's own update() would animate (flicker, embers, smoke) is pinned too,
  // because update() does not run — so the ONLY difference between the pair is
  // the point light's intensity.
  const pair = (hour, arm) => page.evaluate(async (a) => {
    const L = window.__lighting, P = window.__postfx, C = window.__camp;
    L.hour = a.hour; L.cycleSpeed = 0;
    L.update(0, window.__engine.camera.position);   // one hand-driven lighting tick
    const e = L.sunDir.y;
    if (a.arm === 'before') {
      let n = (-0.045 - e) / 0.115; n = n < 0 ? 0 : n > 1 ? 1 : n;
      const night = n * n * (3 - 2 * n), K = P.look;
      P.__pre = () => {
        const u = P.grade.uniforms;
        u.get('uToe').value = 0.022 * (1 - K.nightToeCut * night);
        u.get('uLift').value = 0.020 * (1 - K.nightLiftCut * night);
        P.tone.offsetScale = 1 - (1 - K.nightOffset) * night;
      };
    } else { P.__pre = null; }
    if (!P.__fw) {
      P.__fw = 1;
      const orig = P._driveTimeOfDay.bind(P);
      P._driveTimeOfDay = function () { orig(); if (P.__pre) P.__pre(); };
    }
    P._driveTimeOfDay();
    const keep = C.fireLight.intensity;
    window.__frozenDraw(); window.__frozenDraw();
    const info = { sunElev: +e.toFixed(4), fireI: +keep.toFixed(3),
      lift: +P.grade.uniforms.get('uLift').value.toFixed(4),
      toe: +P.grade.uniforms.get('uToe').value.toFixed(4),
      contrast: +P.grade.uniforms.get('uContrast').value.toFixed(3),
      expo: +P.tone.exposure.toFixed(4) };
    window.__fwRestore = () => { C.fireLight.intensity = keep; window.__frozenDraw(); };
    window.__fwDark = () => { C.fireLight.intensity = 0; window.__frozenDraw(); window.__frozenDraw(); };
    return info;
  }, { hour, arm });

  const rows = [];
  for (const hour of HOURS) {
    for (const arm of ARMS) {
      const tag = `h${String(hour).replace('.', 'p')}-${arm}`;
      const info = await pair(hour, arm);
      const fA = resolve(DIR, `${tag}-fire.png`);
      await page.screenshot({ path: fA });
      await page.evaluate(() => window.__fwDark());
      const fB = resolve(DIR, `${tag}-nofire.png`);
      await page.screenshot({ path: fB });
      await page.evaluate(() => window.__fwRestore());
      const d = diffStats(readPNG(fA), readPNG(fB));
      rows.push({ hour, arm, ...info, ...d });
      console.log(`h${String(hour).padEnd(5)} ${arm.padEnd(7)} elev ${String(info.sunElev).padEnd(8)} ` +
        `fireI ${String(info.fireI).padEnd(6)} lift ${String(info.lift).padEnd(7)} con ${String(info.contrast).padEnd(6)} ` +
        `| fire worth: mean ${String(d.mean).padEnd(7)} pct>8 ${String(d.pct).padEnd(6)} peak ${d.peak}`);
    }
  }
  writeFileSync(resolve(DIR, 'ROWS.json'), JSON.stringify(rows, null, 1));
  await browser.close(); release();
}
main().catch((e) => { console.error(e); process.exit(1); });
