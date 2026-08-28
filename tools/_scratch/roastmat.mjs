#!/usr/bin/env node
/**
 * roastmat — dump the marshmallow's REAL world transform, at every height in
 * the view's band, so the toast rates can be derived offline against the pose
 * the game actually holds.
 *
 * Why this exists. Every rate in src/camp/marshmallow_toast.js is quoted at
 * "250 mm above the flame's hottest point, ON AXIS", and tools/_scratch/
 * toastsim.mjs drives exactly that. The view does not: it holds the stick out
 * to the right and toward the lens so the marshmallow does not hide the flame,
 * which puts it ~0.32 m off the fire's axis at every height. Distance is then
 * dominated by that offset and the whole height band is much flatter than the
 * on-axis table implies.
 *
 * Deriving rates in the browser costs a two-minute headless run per candidate.
 * This dumps the six numbers that matter — the world matrix, the fire's hot
 * point, its power — once, and tools/_scratch/toastband.mjs then replays the
 * real ToastMap against them in node in milliseconds.
 *
 *   node tools/_scratch/roastmat.mjs --out tools/_scratch/banks/roastpose.json
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquire } from '../_lock.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const HOUR = parseFloat(arg('hour', '20.4'));
const OUT = arg('out', 'tools/_scratch/banks/roastpose.json');
const HEIGHTS = String(arg('heights', '0.10,0.16,0.24,0.32,0.40,0.50')).split(',').map(Number);
const URL = `${process.env.AUTUMN_URL || 'http://127.0.0.1:5251'}?res=900&car=camper`;

const release = await acquire('roastmat');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
let out = null;
try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 60000 });
  await page.evaluate(() => { const e = window.__engine; if (e) { e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1; } });
  await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, HOUR);
  const parkAt = await page.evaluate(() => {
    const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
    window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9); return { x: p.x, z: p.z };
  });
  await page.waitForTimeout(1600);
  await page.keyboard.down('Space'); await page.waitForTimeout(1000);
  await page.keyboard.up('Space'); await page.waitForTimeout(2400);
  await page.waitForFunction(() => typeof window.__camp?.pitchNear === 'function', null, { timeout: 60000, polling: 250 });
  await page.evaluate(({ at }) => { window.__camp.pitchNear(at.x, at.z, { instant: true, radius: 14 }); }, { at: parkAt });

  out = await page.evaluate(({ HEIGHTS }) => {
    const R = window.__roast;
    R.enter(); R.setOverlay(false); R.setT(1);
    const V = R.view;
    const THREE = window.__THREE ?? window.THREE;
    const fp = V._firePos(new THREE.Vector3());
    const res = { fire: { x: fp.x, y: fp.y, z: fp.z, top: V._fire.top, power: V._fire.power }, heights: {} };
    const held = V.prop?.userData?.held ?? null;
    res.mallow = held ? { radius: held.radius ?? null, half: held.half ?? null, edge: held.edge ?? null } : null;
    for (const H of HEIGHTS) {
      R.setHeight(H); R.setSpin(0); R.step(1 / 600); R.setHeight(H); R.setSpin(0);
      V.mallow.updateMatrixWorld(true);
      const m0 = V.mallow.matrixWorld.elements.slice();
      R.setSpin(Math.PI / 2); V.mallow.updateMatrixWorld(true);
      const m1 = V.mallow.matrixWorld.elements.slice();
      const p = new THREE.Vector3().setFromMatrixPosition(V.mallow.matrixWorld);
      res.heights[H] = { m0: Array.from(m0), m90: Array.from(m1), pos: { x: p.x, y: p.y, z: p.z }, power: V._fire.power };
      R.setSpin(0);
    }
    return res;
  }, { HEIGHTS });
} finally {
  await browser.close();
  release();
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
const hot = { x: out.fire.x, y: out.fire.y + out.fire.top, z: out.fire.z };
console.log('fire', out.fire, 'hot', hot);
for (const [h, r] of Object.entries(out.heights)) {
  const dx = r.pos.x - hot.x, dy = r.pos.y - hot.y, dz = r.pos.z - hot.z;
  console.log(`h=${h}  pos ${r.pos.x.toFixed(3)},${r.pos.y.toFixed(3)},${r.pos.z.toFixed(3)}  ` +
    `above ${dy.toFixed(3)}  rho ${Math.hypot(dx, dz).toFixed(3)}  dist ${Math.hypot(dx, dy, dz).toFixed(3)}  power ${r.power}`);
}
console.log('wrote', OUT);
