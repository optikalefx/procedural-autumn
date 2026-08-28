#!/usr/bin/env node
/**
 * One frame of the roasting stick leaning on a WOODPILE.
 *
 * `roastshot.mjs` pitches at a fixed POI and that camp always has a table, so
 * the table always wins the lean and the woodpile seat — the one the player
 * photographed a stick standing out of — is unreachable through it. This walks
 * compact camps (which never get a table) until one seats on the pile, then
 * frames it three-quarter front off the PROP's own yaw, the way campshot does.
 *
 *   node tools/_scratch/woodstick.mjs --out shots/roast/wood.png [--hour 20.4]
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const OUT = arg('out', 'shots/roast/wood.png');
const HOUR = arg('hour', null);
const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5251') + '?res=768&car=camper';

const release = await acquire('woodstick');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype;
});
await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const found = await p.evaluate(async (hour) => {
  const C = window.__camp;
  if (hour !== null) { window.__lighting.hour = parseFloat(hour); window.__lighting.cycleSpeed = 0; }
  window.__campSmall = true;
  for (let i = 0; i < 90; i++) {
    const a = i * 2.39996, r = 40 + i * 11;
    C.strike();
    const s = C.pitchNear(Math.cos(a) * r, Math.sin(a) * r,
                          { instant: true, radius: 16, small: true });
    if (!s) continue;
    const st = C.props.find((q) => q.item.kind === 'roaststick');
    const w = C.props.find((q) => q.item.kind === 'woodpile');
    if (!st || !w) continue;
    const rest = st.item.rest;
    if (Math.hypot(w.item.x - rest.x, w.item.z - rest.z) > 0.9) continue;
    // The stick's own endpoints in world space. Framing off the PROP's yaw put
    // the marshmallow outside the frame — the lean's bearing is what matters,
    // and only the built object knows it.
    st.obj.updateMatrixWorld(true);
    const d = st.obj.userData.roast;
    const bt = d.butt.clone().applyMatrix4(st.obj.matrixWorld);
    const ml = d.mallow.clone().applyMatrix4(st.obj.matrixWorld);
    return { bx: bt.x, by: bt.y, bz: bt.z, mx: ml.x, my: ml.y, mz: ml.z };
  }
  return null;
}, HOUR);

if (!found) { console.error('no compact camp seated its stick on a woodpile'); await b.close(); release(); process.exit(2); }

await p.evaluate(async (f) => {
  const THREE = window.__THREE, e = window.__engine;
  // Broadside to the lean, so the whole diagonal — butt, contact, cantilever,
  // marshmallow — is in one plane facing the lens. That is the only framing
  // that can answer "is it leaning on the pile or standing in it".
  const butt = new THREE.Vector3(f.bx, f.by, f.bz);
  const mall = new THREE.Vector3(f.mx, f.my, f.mz);
  const mid = butt.clone().add(mall).multiplyScalar(0.5);
  const along = Math.atan2(mall.x - butt.x, mall.z - butt.z);
  const a = along + Math.PI * 0.5 + 0.35;      // broadside, swung 20 deg round
  const dist = 2.6;
  e.camera.fov = 40; e.camera.updateProjectionMatrix();
  e.camera.position.set(mid.x + Math.sin(a) * dist, mid.y + 0.55, mid.z + Math.cos(a) * dist);
  e.camera.lookAt(mid);
  window.__forceCamera = true;
  if (window.__settleStable) await window.__settleStable(600, 24);
}, found);
await p.waitForTimeout(700);

mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(resolve(OUT), await p.screenshot());
console.log(`shot ${OUT}  butt ${found.bx.toFixed(1)},${found.bz.toFixed(1)}  mallow ${found.mx.toFixed(1)},${found.mz.toFixed(1)}`);
await b.close(); release();
