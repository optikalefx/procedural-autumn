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

// The threshold that SHIPPED before 4c1fda7 — the ordered 4x4 Bayer — so the
// current build can be A/B'd back against it on one frozen frame.
const BAYER = `
float occBayer2( float x, float y ) { return mod( 2.0 * x + 3.0 * y, 4.0 ); }
float occThreshold( vec2 p ) {
  vec2 q = mod( floor( p ), 4.0 );
  vec2 h = floor( q * 0.5 );
  vec2 l = mod( q, 2.0 );
  return ( 4.0 * occBayer2( l.x, l.y ) + occBayer2( h.x, h.y ) ) * 0.0625;
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
        // Matches either threshold: the shipped occThreshold(), or the older
        // occBayer2()/occBayer4() pair, so this tool works either way round.
        const first = orig.indexOf('float occBayer2(') >= 0
          ? orig.indexOf('float occBayer2(') : orig.indexOf('float occThreshold(');
        const last = orig.indexOf('float occBayer4(') >= 0
          ? orig.indexOf('float occBayer4(') : orig.indexOf('float occThreshold(');
        const start = first;
        const end = orig.indexOf('\n}', last) + 2;
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

  const rep = await p.evaluate((g) => window.__setDither(g), BAYER);
  const other = await shot();
  const patternDelta = await p.evaluate(([a, c]) => window.__diff(a, c), [bayer, other]);
  await p.evaluate(() => window.__setDither(null));

  writeFileSync(`${DIR}/p${k}-shipped.png`, Buffer.from(bayer, 'base64'));
  writeFileSync(`${DIR}/p${k}-oldbayer.png`, Buffer.from(other, 'base64'));
  writeFileSync(`${DIR}/p${k}-off.png`, Buffer.from(off, 'base64'));
  console.log(`pose ${k} chase ${info.dist} m  mats ${rep}  engaged ${engaged} (cone ${coneFrac}, sphere ${sphereFrac})  pattern-delta ${patternDelta}`);

  // ── is the near sphere too generous? (CRITIC_FINDINGS D2, second half) ────
  // Same frozen frame, so these are like for like.
  if (engaged > 0.004) {
    for (const v of [
      { n: 'near-1.80-4.20 (shipped)', p: {} },
      { n: 'near-1.40-3.20', p: { nearFull: 1.4, nearNone: 3.2 } },
      { n: 'near-1.00-2.40', p: { nearFull: 1.0, nearNone: 2.4 } },
      { n: 'near-off',       p: { nearFull: 0.01, nearNone: 0.02 } },
    ]) {
      await p.evaluate(([b, o]) => Object.assign(window.__occlusion.params, b, o), [base, v.p]);
      const img = await shot();
      const f = await p.evaluate(([a, c]) => window.__diff(a, c), [off, img]);
      writeFileSync(`${DIR}/p${k}-${v.n.split(' ')[0]}.png`, Buffer.from(img, 'base64'));
      console.log(`    ${v.n.padEnd(24)} engaged ${f}`);
    }
    await p.evaluate((b) => Object.assign(window.__occlusion.params, b), base);
  }

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
