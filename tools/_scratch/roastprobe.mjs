#!/usr/bin/env node
/**
 * roastprobe — dump what `camp_roast_view.js`'s off-screen value probe actually
 * DRAWS, as a PNG, at several render-target types and sizes.
 *
 *   node tools/_scratch/roastprobe.mjs --hour 20.4
 *
 * Written to find one bug and worth keeping for the next one of its kind. The
 * round-6 backdrop solve renders the scene into a small render target and reads
 * the pixels back; the first version of it came back with the terrain and the
 * camp floor simply ABSENT — sky showing through where the dirt should be, at
 * some seats and not others — while the value numbers it produced looked
 * entirely plausible, because the sky at dusk (0.19 linear) is very close to a
 * fire-lit cobble.
 *
 * The cause: `EffectComposer` sets `renderer.autoClear = false` on the renderer
 * it is constructed with, and never puts it back. A `renderer.render` into
 * anybody else's target therefore does not clear that target's DEPTH, so the
 * first render into a fresh target looks right and every one after it inherits
 * the previous frame's depth buffer and drops everything not nearer than what
 * was already there. `_probeRender` clears explicitly now.
 *
 * If a probe frame ever looks wrong again: this writes `probe-seat*.png` (the
 * probe's own output), `live-seat2.png` (the canvas, for comparison) and
 * `var-*.png` (the same frame at float/half/byte and 320/800/1600 wide).
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const HOUR = parseFloat(arg('hour', '20.4'));
const DIR = arg('dir', 'shots/roast/r6-diag');
const URL = `${process.env.AUTUMN_URL || 'http://127.0.0.1:5251'}?res=1600&car=camper`;
mkdirSync(DIR, { recursive: true });
const release = await acquire('roastprobe');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
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
  await page.evaluate(({ at }) => { const s = window.__camp.pitchNear(at.x, at.z, { instant: true, radius: 14 }); return s ? { x: s.x, z: s.z } : null; }, { at: parkAt });
  await page.evaluate(() => {
    window.__roast.enter(); window.__roast.setOverlay(false);
    window.__roast.setDoneness(0.55); window.__roast.setHeight(0.24); window.__roast.setSpin(0); window.__roast.setClock(3.0);
  });
  await page.waitForFunction(() => (window.__roast.state().t ?? 0) >= 0.999, null, { timeout: 15000, polling: 60 });

  // seat 2, probe rendered several ways
  const dump = await page.evaluate(() => {
    const THREE = window.__THREE ?? window.THREE;
    const V = window.__roast.view;
    V._bearing = (2 / 8) * Math.PI * 2; V._measureSeatY();
    window.__roast.pose({ right: 0.142, near: 0.24 });
    window.__roast.setDoneness(0.55); window.__roast.setHeight(0.24); window.__roast.setClock(3.0);
    const r = V.ctx.renderer, cam = V.ctx.camera, scene = V.ctx.scene;
    const out = [];
    const variants = [
      { n: 'float-320', W: 320, type: THREE.FloatType },
      { n: 'float-1600', W: 1600, type: THREE.FloatType },
      { n: 'byte-320', W: 320, type: THREE.UnsignedByteType },
      { n: 'half-320', W: 320, type: THREE.HalfFloatType },
      { n: 'float-800', W: 800, type: THREE.FloatType },
    ];
    const save = V._probeBegin();
    for (const v of variants) {
      const H = Math.round(v.W / cam.aspect);
      const rt = new THREE.WebGLRenderTarget(v.W, H, { type: v.type, depthBuffer: true, stencilBuffer: false });
      V.held.visible = false;
      r.setRenderTarget(rt); r.render(scene, cam);
      const Arr = v.type === THREE.FloatType ? Float32Array : (v.type === THREE.UnsignedByteType ? Uint8Array : Uint16Array);
      const buf = new Arr(v.W * H * 4);
      let err = null;
      try { r.readRenderTargetPixels(rt, 0, 0, v.W, H, buf); } catch (e) { err = String(e.message); }
      r.setRenderTarget(null);
      // to PNG, downsampled to 320 wide
      const OW = 320, OH = Math.round(OW / cam.aspect);
      const cv = document.createElement('canvas'); cv.width = OW; cv.height = OH;
      const cx = cv.getContext('2d'); const id = cx.createImageData(OW, OH);
      const dec = (x) => v.type === THREE.HalfFloatType ? x / 1024 : (v.type === THREE.UnsignedByteType ? x / 255 : x);
      for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
        const sx = Math.round(x / OW * v.W), sy = Math.round((1 - (y + 0.5) / OH) * H);
        const sK = (Math.min(H - 1, sy) * v.W + Math.min(v.W - 1, sx)) * 4, dK = (y * OW + x) * 4;
        for (let c = 0; c < 3; c++) id.data[dK + c] = Math.round(255 * Math.min(1, Math.pow(Math.max(0, dec(buf[sK + c])), 1 / 2.2)));
        id.data[dK + 3] = 255;
      }
      cx.putImageData(id, 0, 0);
      out.push({ n: v.n, err, png: cv.toDataURL('image/png') });
      rt.dispose();
    }
    V._probeEnd(save);
    return out;
  });
  for (const d of dump) { writeFileSync(`${DIR}/var-${d.n}.png`, Buffer.from(d.png.split(',')[1], 'base64')); console.log(d.n, d.err ?? 'ok'); }

  // what is in the scene that could paint the whole frame
  const objs = await page.evaluate(() => {
    const V = window.__roast.view;
    const out = [];
    V.ctx.scene.traverse((o) => {
      if (!o.isMesh && !o.isPoints && !o.isLine) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m) return;
      if (m.depthTest === false || o.renderOrder !== 0 || m.transparent) {
        out.push({ n: o.name || '(unnamed)', parent: o.parent?.name || '', order: o.renderOrder,
          depthTest: m.depthTest, depthWrite: m.depthWrite, transparent: m.transparent,
          blending: m.blending, vis: o.visible, type: m.type });
      }
    });
    return out.slice(0, 60);
  });
  console.log(JSON.stringify(objs.slice(0, 6), null, 1));
} finally { await browser.close(); release(); }
