#!/usr/bin/env node
/**
 * Natural-encounter capture (wildlife author, scratch).
 *
 * Every other harness here places an animal with `debugSpawn`, which is exempt
 * from the stand-off and frames on an exact point. That is right for isolating
 * a hide treatment and useless for judging placement, because placement is the
 * thing debugSpawn overrides. This drives an offroad chord at player speed with
 * the brains running and the sites streaming normally, and saves frames where a
 * deer is genuinely in view at the ranges the player actually meets one.
 *
 *   node tools/_scratch/wnat.mjs --shots 6 --tag after
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SHOTS = parseInt(arg('shots', '6'), 10);
const TAG = arg('tag', 'nat');
const SPEED = parseFloat(arg('speed', '13'));
const DIR = resolve(`shots/wl/${TAG}`);

await acquire('wnat');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1170, height: 870 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (/vite|token=/.test(String(url)) || String(protocols).includes('vite')) {
      return { readyState: 3, url, addEventListener(){}, removeEventListener(){}, send(){}, close(){},
               set onopen(_){}, set onmessage(_){}, set onclose(_){}, set onerror(_){} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto('http://localhost:5178?res=1024');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

await page.evaluate(() => {
  const e = window.__engine;
  window.__forceCamera = true;
  window.__lighting.hour = 16.7; window.__lighting.cycleSpeed = 0;
  e.stop(); e.clock.getDelta = () => 1 / 30;
  const canvas = e.renderer.domElement;
  for (const el of document.querySelectorAll('body *')) {
    if (el === canvas || el.contains(canvas) || el.closest('canvas')) continue;
    el.style.display = 'none';
  }
  // Drive state, kept on the page so each step is one cheap call.
  window.__W = { t: 0, leg: 0 };
});

mkdirSync(DIR, { recursive: true });

const step = async (n, scan = true) => page.evaluate(async ({ N, SCAN }) => {
  const T = window.__THREE, e = window.__engine, W = window.__world;
  const wl = window.__systems.wildlife;
  const cam = e.camera, S = window.__W;
  const half = (W.half ?? 1024) * 0.82;
  const dt = 1 / 30, SP = 13;
  const ZOOM = 19, PITCH = 0.2145;
  cam.fov = 52; cam.updateProjectionMatrix();
  const fr = new T.Frustum(), pm = new T.Matrix4(), sph = new T.Sphere();

  for (let i = 0; i < N; i++) {
    // A straight chord, restarted on a new bearing when it runs off the map.
    const th = S.leg * 1.37 + 0.19;
    const px = Math.cos(th) * (-half + SP * S.t);
    const pz = Math.sin(th) * (-half + SP * S.t);
    if (SP * S.t > half * 2) { S.leg++; S.t = 0; continue; }
    S.t += dt;
    if (!W.isInBounds(px, pz)) continue;

    const gy = W.getHeight(px, pz);
    const anchorY = gy + 1.05 + 0.0577 * 2.4;
    const cp = Math.cos(PITCH), sp2 = Math.sin(PITCH);
    const ex = px - Math.cos(th) * ZOOM * cp, ez = pz - Math.sin(th) * ZOOM * cp;
    let ey = anchorY + ZOOM * sp2;
    ey = Math.max(ey, W.getHeight(ex, ez) + 2.0);
    cam.position.set(ex, ey, ez);
    cam.lookAt(px, anchorY, pz);
    cam.updateMatrixWorld(true);
    // The camper is the threat, and it is where the eye is looking.
    wl.debugThreat(px, pz, SP);
    e._loop();

    if (!SCAN) continue;
    // Anything worth stopping for?
    pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    fr.setFromProjectionMatrix(pm);
    for (const A of wl.debugState()) {
      if (A.key !== 'deer') continue;
      const d = Math.hypot(A.x - cam.position.x, A.z - cam.position.z);
      if (d < 55 || d > 110) continue;
      sph.center.set(A.x, A.y + 0.9, A.z); sph.radius = 1.2;
      if (!fr.intersectsSphere(sph)) continue;
      const v = new T.Vector3(A.x, A.y + 0.8, A.z).project(cam);
      const sx = (v.x * 0.5 + 0.5) * 1170, sy = (-v.y * 0.5 + 0.5) * 870;
      if (sx < 150 || sx > 1020 || sy < 120 || sy > 700) continue;
      // Not behind a hill.
      let blocked = false;
      for (let t2 = 0.06; t2 < 0.97; t2 += 0.015) {
        const mx = cam.position.x + (A.x - cam.position.x) * t2;
        const mz = cam.position.z + (A.z - cam.position.z) * t2;
        const ly = cam.position.y + (A.y + 0.8 - cam.position.y) * t2;
        if (W.getHeight(mx, mz) > ly + 0.3) { blocked = true; break; }
      }
      if (blocked) continue;
      const dThreat = Math.hypot(A.x - px, A.z - pz);
      return { hit: true, d: +d.toFixed(1), state: A.state, speed: +(A.speed ?? 0).toFixed(2),
               dThreat: +dThreat.toFixed(1), dEff: +(dThreat - SP * 1.15).toFixed(1),
               sx: Math.round(sx), sy: Math.round(sy),
               canopy: +wl._canopy(A.x, A.z, 11).toFixed(2) };
    }
  }
  return { hit: false };
}, { N: n, SCAN: scan });

const found = [];
for (let s = 0; s < SHOTS; s++) {
  let r = null;
  for (let tries = 0; tries < 40 && !(r && r.hit); tries++) r = await step(120);
  if (!r || !r.hit) break;
  const f = `${DIR}/enc${s}-${r.d}m-${r.state}.png`;
  writeFileSync(f, await page.screenshot({ type: 'png' }));
  found.push({ file: f, ...r });
  await step(340, false);   // move on so the next shot is a different encounter
}
console.log(JSON.stringify(found, null, 1));
if (errs.length) console.error('page errors:', errs.slice(0, 4));
await browser.close();
