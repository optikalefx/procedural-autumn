// What is in the shadow pass?
//
// systime.mjs puts shadowMap.render at 3.0 ms mean / 14.3 ms p95 and 201 of the
// frame's 533 draw calls. That is a big, spiky, resolution-independent slice
// and nothing in this harness has ever said WHICH objects it is made of. This
// hooks Object3D.onBeforeRender during the shadow pass and tallies the calls
// and triangles by the scene root that owns them.
//
//   node tools/_scratch/shadowcost.mjs --seconds 20
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '20')), RES = arg('res', '1536'), QUALITY = arg('quality', null);
await acquire('shadowcost');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
const q = new URLSearchParams({ res: RES }); if (QUALITY) q.set('quality', QUALITY);
await page.goto(`http://localhost:5178/?${q}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const THREE = window.__THREE, e = window.__engine, ctx = window.__ctx, r = e.renderer, gl = r.getContext();
  const P = window.__sc = { shadow: {}, scene: {}, frames: 0, cfg: null, shadowMs: 0 };
  const rootOf = (o) => { let q = o; while (q.parent && q.parent !== e.scene) q = q.parent; return q.name || q.type; };
  let inShadow = false, current = null;
  // Every renderable passes through WebGLRenderer.renderBufferDirect; that is
  // the only place the object and the draw are known at the same time.
  const orbd = r.renderBufferDirect.bind(r);
  r.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    current = object;
    return orbd(camera, scene, geometry, material, object, group);
  };
  const tally = (m, obj, tris) => {
    const k = rootOf(obj) + ' / ' + (obj.name || obj.type);
    const row = m[k] ?? (m[k] = { calls: 0, tris: 0 });
    row.calls++; row.tris += tris;
  };
  for (const fn of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    const g = gl[fn].bind(gl);
    gl[fn] = function (...a) {
      if (current) {
        const count = typeof a[1] === 'number' ? a[1] : 0;
        const inst = fn.endsWith('Instanced') ? (a[a.length - 1] | 0) : 1;
        tally(inShadow ? P.shadow : P.scene, current, (count / 3) * inst);
      }
      return g(...a);
    };
  }
  const sm = r.shadowMap, of_ = sm.render.bind(sm);
  sm.render = function (...a) { const t = performance.now(); inShadow = true; const o = of_(...a); inShadow = false; P.shadowMs += performance.now() - t; return o; };
  e.onLateUpdate(() => { P.frames++; });
  const l = ctx.lighting;
  P.cfg = { mapSize: l?.sun?.shadow?.mapSize?.toArray?.() ?? null,
            cam: l?.sun?.shadow?.camera ? { l: l.sun.shadow.camera.left, r: l.sun.shadow.camera.right, t: l.sun.shadow.camera.top, b: l.sun.shadow.camera.bottom, n: l.sun.shadow.camera.near, f: l.sun.shadow.camera.far } : null,
            type: r.shadowMap.type, enabled: r.shadowMap.enabled, autoUpdate: r.shadowMap.autoUpdate };
  const input = ctx.input; window.__drive = true;
  const tick = () => { if (!window.__drive) return; const t = performance.now() / 1000;
    input.axes.throttle = 1; input.axes.steer = Math.sin(t * 0.42) * 0.75; requestAnimationFrame(tick); };
  tick();
  void THREE;
});
await page.waitForTimeout(SECONDS * 1000);
const d = await page.evaluate(() => { window.__drive = false; const P = window.__sc;
  const rows = (m) => Object.entries(m).map(([k, v]) => ({ k, calls: +(v.calls / P.frames).toFixed(2), tris: Math.round(v.tris / P.frames) }))
    .sort((a, b) => b.calls - a.calls);
  return { frames: P.frames, cfg: P.cfg, shadowMs: +(P.shadowMs / P.frames).toFixed(2), shadow: rows(P.shadow), scene: rows(P.scene) }; });
await browser.close();
console.log(`frames ${d.frames}   shadow pass ${d.shadowMs} ms/frame`);
console.log('shadow config', JSON.stringify(d.cfg));
const show = (t, rows) => {
  const c = rows.reduce((a, x) => a + x.calls, 0), tr = rows.reduce((a, x) => a + x.tris, 0);
  console.log(`\n${t}  —  ${c.toFixed(1)} calls/frame, ${(tr / 1e6).toFixed(2)} M tris/frame`);
  console.log('   calls      tris   object');
  for (const r of rows.slice(0, 26)) console.log(`${String(r.calls).padStart(8)}${String(r.tris).padStart(10)}   ${r.k}`);
};
show('SHADOW PASS', d.shadow);
show('SCENE + POST', d.scene);
