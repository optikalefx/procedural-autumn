#!/usr/bin/env node
/**
 * Approach series — the only way to see pop-in without driving.
 *
 * A still frame cannot show pop-in, and a driving capture shows it mixed with
 * everything else that moves. This walks the camera BACKWARDS along one fixed
 * sight-line in fixed steps, at the chase camera's real geometry (5 m up,
 * looking slightly down), so the same patch of ground is photographed from
 * 8, 16, 24 ... metres. Flip through the frames and any prop that arrives does
 * so at a repeatable, measurable distance.
 *
 *   node tools/_scratch/approach.mjs --dir shots/lod/after --steps 7 --gap 8
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/lod/run');
const STEPS = parseInt(arg('steps', '7'), 10);
const GAP = parseFloat(arg('gap', '8'));
const ANCHOR = arg('anchor', 'meadow');
// Runtime overrides, so the OLD ladder can be photographed from the same build
// and the same viewpoint as the new one — a strict A/B of one frame.
const OV = {
  coverVis: arg('cover', null) === null ? null : parseFloat(arg('cover')),
  near: arg('near', null) ? arg('near').split(',').map(Number) : null,
  mid: arg('mid', null) ? arg('mid').split(',').map(Number) : null,
};
const W = parseInt(arg('w', '1280'), 10);
const H = parseInt(arg('h', '760'), 10);

mkdirSync(DIR, { recursive: true });
await acquire('approach');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, q) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close(){}, send(){}, addEventListener(){}, removeEventListener(){},
               set onopen(_){}, set onclose(_){}, set onerror(_){}, set onmessage(_){} };
    }
    return new R(u, q);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
await page.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

await page.evaluate((ov) => {
  const S = window.__systems;
  if (ov.coverVis !== null && S.groundCover) { S.groundCover.visMul = ov.coverVis; S.groundCover._dirty = true; }
  if (S.grass) {
    if (ov.near) S.grass.rings[0].material.userData.uniforms.uFadeOut.value.set(ov.near[0], ov.near[1]);
    if (ov.mid) S.grass.rings[1].material.userData.uniforms.uFadeIn.value.set(ov.mid[0], ov.mid[1]);
  }
}, OV);

// Resolve the sight-line once, then only step along it.
const line = await page.evaluate((anchor) => {
  const a = window.__cameraAnchors[anchor]();
  return { x: a.x, z: a.z, yaw: a.yaw ?? 0 };
}, ANCHOR);

for (let i = 0; i < STEPS; i++) {
  const back = i * GAP;
  await page.evaluate(async ({ line, back }) => {
    const e = window.__engine, wd = window.__world;
    // The chase camera's real pose: 5 m up, 0.12 rad down. Everything in the
    // grass and cover fade ladders is keyed on distance from HERE.
    const gx = line.x - Math.sin(line.yaw) * back;
    const gz = line.z - Math.cos(line.yaw) * back;
    const gy = wd.getHeight(gx, gz) + 5.0;
    e.camera.fov = 55; e.camera.updateProjectionMatrix();
    e.camera.position.set(gx, gy, gz);
    e.camera.lookAt(gx + Math.sin(line.yaw) * 40, gy - Math.tan(0.12) * 40, gz + Math.cos(line.yaw) * 40);
    window.__forceCamera = true;
    window.dispatchEvent(new Event('resize'));
    await window.__settle(150);
  }, { line, back });
  const buf = await page.screenshot();
  writeFileSync(`${DIR}/back${String(back).padStart(3, '0')}.png`, buf);
  process.stdout.write(`back ${back} m  `);
}
console.log('\n' + DIR);
await browser.close();
