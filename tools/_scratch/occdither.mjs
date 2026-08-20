#!/usr/bin/env node
/**
 * Look at the occlusion dither, two patterns, same frame.
 *
 * CRITIC_FINDINGS D2 is about how the fade LOOKS, and looks are the one thing
 * two runs cannot compare on this project — two captures of this tree 34 minutes
 * apart differed in half their pixels. So: drive, stop the clock, then hot-swap
 * the threshold function inside the already-compiled leaf material and render
 * the same frozen frame again. Camera, wind, sun, vehicle and every clump are
 * bit-identical between the two images; the only thing that changed is the
 * pattern.
 *
 *   node tools/_scratch/occdither.mjs --dir shots/occdither --poses 4
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/occdither');
const POSES = parseInt(arg('poses', '4'), 10);
const WARM = parseFloat(arg('warm', '11000'));
const STRIDE = parseFloat(arg('stride', '5000'));

// The candidate. Interleaved gradient noise: aperiodic, low-discrepancy in a
// local neighbourhood, two multiplies and two fracts, no texture.
const IGN = `
float occBayer4( vec2 p ) {
  vec2 q = mod( p, 256.0 );
  return fract( 52.9829189 * fract( dot( q, vec2( 0.06711056, 0.00583715 ) ) ) );
}`;

mkdirSync(DIR, { recursive: true });
await acquire('occdither');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1200, height: 720 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, q) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
               set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, q);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
await p.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(700);

await p.evaluate(() => {
  window.__lighting.hour = 16.7; window.__lighting.cycleSpeed = 0;
  const inp = window.__ctx.input; window.__drive = true; const t0 = performance.now();
  const tick = () => { if (!window.__drive) return; const t = (performance.now() - t0) / 1000;
    inp.axes.throttle = 1; inp.axes.steer = Math.sin(t * 0.19) * 0.30; requestAnimationFrame(tick); };
  tick();
});
await p.waitForTimeout(WARM);

await p.evaluate(() => {
  const e = window.__engine, veh = window.__systems.vehicle;
  window.__freeze = () => {
    e.stop();
    window.__step = () => new Promise((res) => requestAnimationFrame(() => {
      window.__occlusion.setTarget(e.camera, veh.position);
      e._render ? e._render(0, e.elapsed) : e.renderer.render(e.scene, e.camera);
      requestAnimationFrame(() => res());
    }));
  };
  window.__thaw = () => { e.start(); };

  // Every material that carries OCCLUDE_DITHER, found by its marker.
  window.__leafMats = () => {
    const out = new Set();
    window.__engine.scene.traverse((o) => {
      const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of ms) if (m.fragmentShader && m.fragmentShader.includes('OCCLUDE_DITHER_DECLARED')) out.add(m);
    });
    return [...out];
  };
  window.__origFrag = new Map();
  window.__setDither = (glsl) => {
    for (const m of window.__leafMats()) {
      if (!window.__origFrag.has(m)) window.__origFrag.set(m, m.fragmentShader);
      const orig = window.__origFrag.get(m);
      if (glsl === null) { m.fragmentShader = orig; }
      else {
        // Replace only the threshold function; occludeCut() and everything
        // around it stay exactly as they are.
        const start = orig.indexOf('float occBayer2(');
        const end = orig.indexOf('\n}', orig.indexOf('float occBayer4(')) + 2;
        if (start < 0 || end < 2) return 'MARKER-NOT-FOUND';
        m.fragmentShader = orig.slice(0, start) + glsl.trim() + orig.slice(end);
      }
      m.needsUpdate = true;
    }
    return window.__leafMats().length;
  };

  window.__diff = async (b64a, b64b) => {
    const dec = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); return i; };
    const [A, B] = await Promise.all([dec(b64a), dec(b64b)]);
    const c = new OffscreenCanvas(A.width, A.height), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(A, 0, 0); const a = g.getImageData(0, 0, A.width, A.height).data;
    g.clearRect(0, 0, A.width, A.height); g.drawImage(B, 0, 0);
    const bb = g.getImageData(0, 0, A.width, A.height).data;
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - bb[i]) + Math.abs(a[i + 1] - bb[i + 1]) + Math.abs(a[i + 2] - bb[i + 2]) > 18) n++;
    }
    return +(n / (a.length / 4)).toFixed(4);
  };
});

const shot = async () => { await p.evaluate(() => window.__step()); return (await p.screenshot()).toString('base64'); };

for (let k = 0; k < POSES; k++) {
  await p.evaluate(() => { window.__drive = false; window.__freeze(); });
  await p.waitForTimeout(250);

  const info = await p.evaluate(() => {
    const c = window.__engine.camera, v = window.__systems.vehicle;
    return { mats: window.__leafMats().length, dist: +c.position.distanceTo(v.position).toFixed(1) };
  });

  await p.evaluate(() => window.__setDither(null));
  const bayer = await shot();
  await p.evaluate(() => { window.__occlusion.params.enabled = false; });
  const off = await shot();
  await p.evaluate(() => { window.__occlusion.params.enabled = true; });
  const engaged = await p.evaluate(([a, c]) => window.__diff(a, c), [off, bayer]);
  // Shape contributions, same frozen frame.
  const base = await p.evaluate(() => ({ ...window.__occlusion.params }));
  await p.evaluate((b) => Object.assign(window.__occlusion.params, b, { nearFull: 0.01, nearNone: 0.02 }), base);
  const coneOnly = await shot();
  await p.evaluate((b) => Object.assign(window.__occlusion.params, b, { wide: 0.01 }), base);
  const sphereOnly = await shot();
  await p.evaluate((b) => Object.assign(window.__occlusion.params, b), base);
  const coneFrac = await p.evaluate(([a, c]) => window.__diff(a, c), [off, coneOnly]);
  const sphereFrac = await p.evaluate(([a, c]) => window.__diff(a, c), [off, sphereOnly]);

  const rep = await p.evaluate((g) => window.__setDither(g), IGN);
  const ign = await shot();
  const patternDelta = await p.evaluate(([a, c]) => window.__diff(a, c), [bayer, ign]);
  await p.evaluate(() => window.__setDither(null));

  writeFileSync(`${DIR}/p${k}-bayer.png`, Buffer.from(bayer, 'base64'));
  writeFileSync(`${DIR}/p${k}-ign.png`, Buffer.from(ign, 'base64'));
  writeFileSync(`${DIR}/p${k}-off.png`, Buffer.from(off, 'base64'));
  console.log(`pose ${k} chase ${info.dist} m  mats ${rep}  engaged ${engaged} (cone ${coneFrac}, sphere ${sphereFrac})  pattern-delta ${patternDelta}`);

  if (k < POSES - 1) {
    await p.evaluate(() => {
      window.__thaw();
      const inp = window.__ctx.input; window.__drive = true; const t0 = performance.now();
      const tick = () => { if (!window.__drive) return; const t = (performance.now() - t0) / 1000;
        inp.axes.throttle = 1; inp.axes.steer = Math.sin(t * 0.23 + 1.1) * 0.34; requestAnimationFrame(tick); };
      tick();
    });
    await p.waitForTimeout(STRIDE);
  }
}
await b.close();
console.log('wrote', DIR);
