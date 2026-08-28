#!/usr/bin/env node
/**
 * _skyocc — is `clearSky` telling the truth about the terrain?
 *
 *   node tools/_scratch/_skyocc.mjs --dir /tmp/skyocc
 *
 * The march is the gate that stops the hunt crediting a photograph of a cliff
 * with the moon somewhere behind it, and a march is exactly the kind of test
 * that can be confidently wrong. So it is checked against the RENDERER rather
 * than against itself: at each pose, aim the long lens at the moon, render the
 * frame twice — once normally and once with the sky's moon uniforms zeroed —
 * and count the changed pixels in the middle of the frame. If the moon is
 * really there it is 745 px across and the count is enormous; if a ridge is in
 * front of it the count is the post chain's dither.
 *
 * Poses are drawn at random on the valley floor and sorted into blocked and
 * clear by `clearSky` itself, so the two columns are the claim and the pixels
 * are the verdict.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readPNG } from '../_pngread.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const OUT = resolve(arg('dir', '/tmp/skyocc'));
const WANT = parseInt(arg('n', '12'), 10);          // of each kind
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
               set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, pr);
  };
});
page.on('pageerror', (e) => console.log('  [page error]', String(e)));
await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
console.log('booted');

const poses = await page.evaluate(async ({ WANT }) => {
  const e = window.__engine;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
  window.__lighting.hour = 23.0; window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  const hudRoot = window.__systems.hud?.root;
  if (hudRoot) hudRoot.style.display = 'none';
  await window.__settle(20);

  const sky = window.__sky;
  if (!sky.__killPatched) {
    const orig = sky.update.bind(sky);
    sky.update = (...a) => {
      orig(...a);
      if (window.__skyKill) { sky.uniforms.uMoonDiscI.value = 0; sky.uniforms.uMoonHaloI.value = 0; }
    };
    sky.__killPatched = true;
  }
  window.__skyKill = false;

  const { _internals } = await import('/src/game/hunt_detect.js');
  const md = window.__lighting.computeMoonDir(23.0);
  const blocked = [], clear = [];
  let s = 31337 >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 40000 && (blocked.length < WANT || clear.length < WANT); i++) {
    const x = (rnd() - 0.5) * 3000, z = (rnd() - 0.5) * 3000;
    const g = window.__world.getHeight(x, z);
    if (!Number.isFinite(g)) continue;
    // A camera under a lake photographs nothing, and it is not the march's
    // fault. Eye height is 1.7 m, so anything deeper than that is submerged.
    const wet = window.__ctx.world.getWaterDepth?.(x, z) ?? 0;
    if (wet >= 1.7) continue;
    const eye = { x, y: g + 1.7, z };
    const ok = _internals.clearSky(window.__ctx.world, eye, md);
    if (ok && clear.length < WANT) clear.push({ x: +x.toFixed(1), z: +z.toFixed(1), y: +eye.y.toFixed(1), wet: +wet.toFixed(2), claim: 'clear' });
    if (!ok && blocked.length < WANT) blocked.push({ x: +x.toFixed(1), z: +z.toFixed(1), y: +eye.y.toFixed(1), wet: +wet.toFixed(2), claim: 'blocked' });
  }
  return { moon: [md.x, md.y, md.z], list: [...blocked, ...clear] };
}, { WANT });

console.log(`moonDir ${poses.moon.map((v) => v.toFixed(3)).join(', ')} — ${poses.list.length} poses\n`);

/** Changed pixels inside the middle of the frame, where the moon is aimed. */
function centreDiff(a, b, half = 420) {
  const { w, h, px: da } = a; const db = b.px;
  const x0 = (w / 2 - half) | 0, x1 = (w / 2 + half) | 0;
  const y0 = Math.max(0, (h / 2 - half) | 0), y1 = Math.min(h, (h / 2 + half) | 0);
  let n = 0, max = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * w + x) * 3;
      const d = Math.abs(da[p] - db[p]) + Math.abs(da[p + 1] - db[p + 1]) + Math.abs(da[p + 2] - db[p + 2]);
      if (d > 60) n++;
      if (d > max) max = d;
    }
  }
  return { changed: n, max };
}

const rows = [];
for (let i = 0; i < poses.list.length; i++) {
  const p = poses.list[i];
  await page.evaluate(async ({ p, md }) => {
    const cam = window.__ctx.camera;
    window.__ctx.worldPaused = false;
    cam.position.set(p.x, p.y, p.z);
    cam.fov = 2.9; cam.updateProjectionMatrix();
    cam.lookAt(p.x + md[0] * 1000, p.y + md[1] * 1000, p.z + md[2] * 1000);
    cam.updateMatrixWorld(true);
    if (window.__settleStable) await window.__settleStable(900, 24);
    await window.__settle(60);
    window.__ctx.worldPaused = true;
    window.__skyKill = false;
    await window.__settle(6);
  }, { p, md: poses.moon });
  const on = resolve(OUT, `${p.claim}-${i}-on.png`);
  const off = resolve(OUT, `${p.claim}-${i}-off.png`);
  await page.screenshot({ path: on });
  await page.evaluate(async () => { window.__skyKill = true; await window.__settle(6); });
  await page.screenshot({ path: off });
  await page.evaluate(async () => { window.__skyKill = false; await window.__settle(4); });
  const d = centreDiff(readPNG(on), readPNG(off));
  rows.push({ ...p, ...d, on });
  console.log(`${p.claim.padEnd(8)} (${String(p.x).padStart(8)}, ${String(p.z).padStart(8)})  ` +
              `moon pixels in the middle of the frame: ${String(d.changed).padStart(7)}  (max delta ${d.max})`);
}
writeFileSync(resolve(OUT, 'rows.json'), JSON.stringify(rows, null, 1));

const b = rows.filter((r) => r.claim === 'blocked').map((r) => r.changed);
const c = rows.filter((r) => r.claim === 'clear').map((r) => r.changed);
const stat = (v) => v.length ? `min ${Math.min(...v)}  median ${v.slice().sort((x, y) => x - y)[v.length >> 1]}  max ${Math.max(...v)}` : 'none';
console.log(`\nclearSky said BLOCKED: ${stat(b)}`);
console.log(`clearSky said CLEAR:   ${stat(c)}`);
const hidden = rows.filter((r) => r.claim === 'clear' && r.changed < 500);
console.log(`\nblocked poses with any moon on screen: ${b.filter((v) => v >= 500).length} of ${b.length}` +
            `   <- the march's own false positives`);
console.log(`clear poses with NO moon on screen:    ${hidden.length} of ${c.length}` +
            `   <- non-terrain occluders, which this march does not test for`);
for (const r of hidden) console.log(`   (${r.x}, ${r.z}) wet ${r.wet}  ${r.on}`);
await browser.close();
