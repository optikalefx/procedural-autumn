#!/usr/bin/env node
/**
 * The water's true per-pixel alpha, measured rather than reasoned about.
 *
 *   node tools/_scratch/alphamap.mjs poses.json outdir
 *
 * Three frames of one pose: with water, without water, and with the water
 * material's blending switched off so its own alpha is ignored and it
 * composites opaque. Then alpha = (with - without) / (opaque - without),
 * per channel, taken where the denominator is big enough to divide by. That is
 * the coverage the surface actually achieved, at every pixel, with no model of
 * the shader in it.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readPNG } from '../_pngread.mjs';

const poses = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const dir = process.argv[3] || 'shots/alpha';
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5211/?seed=20261018&quality=ultra';
mkdirSync(dir, { recursive: true });
await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(u, p);
  };
  window.WebSocket.prototype = RealWS.prototype; Object.assign(window.WebSocket, RealWS);
});
page.on('pageerror', (e) => console.error('ERR', String(e).slice(0, 160)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { const e = window.__engine; e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1; });

for (const p of poses) {
  await page.evaluate(async (v) => {
    const THREE = window.__THREE, e = window.__engine;
    window.__lighting.hour = v.hour ?? 16.7; window.__lighting.cycleSpeed = 0;
    for (const n of ['Trees', 'Grass', 'GroundCover', 'Rocks', 'Wildlife', 'Camp', 'Weather', 'Clouds', 'Waterfalls']) {
      const o = e.scene.getObjectByName(n); if (o) o.visible = !(v.hide || []).includes(n);
    }
    e.camera.fov = v.fov ?? 50; e.camera.updateProjectionMatrix();
    e.camera.position.set(...v.pos);
    e.camera.lookAt(new THREE.Vector3(...v.look));
    window.__forceCamera = true;
    // freeze so the three frames differ by the water alone
    e.stop();
    window.__draw = () => { if (e._render) e._render(0, e.elapsed); else e.renderer.render(e.scene, e.camera); };
    for (let i = 0; i < 12; i++) window.__draw();
  }, p);
  await page.waitForTimeout(500);
  const shot = async (tag) => { const f = resolve(dir, `${p.name}-${tag}.png`); await page.screenshot({ path: f }); return f; };
  const withW = await shot('with');
  // The reference frame differs from the first by the ALPHA VALUE and by
  // nothing else. Switching `transparent` off was tried and is not a control:
  // it moves the mesh from three.js's transparent pass to its opaque one and
  // turns depth writes back on, so the frames differ in render order too — the
  // instrument then reported 0.78 for a shader whose alpha had been forced to
  // 1.0, which is the signature of measuring the wrong difference. A clone of
  // the same material with `gl_FragColor`'s alpha replaced by 1.0 keeps the
  // pass, the sorting, the depth state and every uniform.
  await page.evaluate(() => {
    const w = window.__systems.water;
    const src = w.material;
    const opaque = src.clone();
    opaque.fragmentShader = src.fragmentShader.replace(
      'gl_FragColor = vec4(col, alpha);', 'gl_FragColor = vec4(col, 1.0);');
    opaque.uniforms = src.uniforms;                  // share, do not copy
    opaque.needsUpdate = true;
    w._swap = [];
    window.__engine.scene.getObjectByName('Water').traverse((o) => {
      if (!o.isMesh) return;
      w._swap.push([o, o.material]);
      o.material = opaque;
    });
    for (let i = 0; i < 12; i++) window.__draw();
  });
  await page.waitForTimeout(400);
  const opq = await shot('opaque');
  await page.evaluate(() => {
    const w = window.__systems.water;
    for (const [o, m] of w._swap) o.material = m;
    const g = window.__engine.scene.getObjectByName('Water'); g.visible = false;
    for (let i = 0; i < 12; i++) window.__draw();
  });
  await page.waitForTimeout(400);
  const noW = await shot('nowater');
  await page.evaluate(() => { window.__engine.scene.getObjectByName('Water').visible = true; window.__draw(); });

  // ── alpha map ──
  const A = readPNG(withW), B = readPNG(noW), C = readPNG(opq);
  const W = A.w, H = A.h, ch = A.px.length / (W * H);
  const cw = 100, chh = 34;
  let out = '';
  const hist = new Array(11).fill(0);
  let n = 0, sum = 0;
  for (let ry = 0; ry < chh; ry++) {
    let row = '';
    for (let rx = 0; rx < cw; rx++) {
      let s = 0, c = 0;
      const x0 = Math.floor(rx / cw * W), x1 = Math.floor((rx + 1) / cw * W);
      const y0 = Math.floor(ry / chh * H), y1 = Math.floor((ry + 1) / chh * H);
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * W + x) * ch;
        let num = 0, den = 0;
        for (let k = 0; k < 3; k++) { num += (A.px[i + k] - B.px[i + k]); den += (C.px[i + k] - B.px[i + k]); }
        if (Math.abs(den) < 120) continue;   // sum over three channels; below this the ratio is noise
        const a = Math.max(0, Math.min(1, num / den));
        s += a; c++;
      }
      if (!c) { row += ' '; continue; }
      const a = s / c; n++; sum += a; hist[Math.min(10, Math.round(a * 10))]++;
      row += a < 0.1 ? '.' : a < 0.3 ? ':' : a < 0.5 ? '-' : a < 0.7 ? '+' : a < 0.9 ? '*' : '#';
    }
    out += row + '\n';
  }
  console.log(`\n=== ${p.name} — water alpha (. <10%  : <30%  - <50%  + <70%  * <90%  # >=90%)`);
  console.log(out);
  const all = [];
  for (let b = 0; b <= 10; b++) for (let k = 0; k < hist[b]; k++) all.push(b / 10);
  console.log(`covered cells ${n}  mean ${(sum / n).toFixed(2)}  median ${all[all.length >> 1].toFixed(2)}  ` +
              `p10 ${all[Math.floor(all.length * 0.1)].toFixed(2)}  under 0.5: ${(hist.slice(0, 5).reduce((a, b) => a + b, 0) / n * 100).toFixed(0)}%`);
}
await browser.close();
