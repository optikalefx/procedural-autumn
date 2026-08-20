#!/usr/bin/env node
/**
 * Bench for the camera-occlusion fade (render/Occlusion.js), CRITIC_FINDINGS D2.
 *
 * Two captures of this scene taken minutes apart differ in half their pixels,
 * so every comparison here happens inside ONE page load with the clock STOPPED:
 * `engine.stop()` and then a hand-driven render inside a rAF, which freezes wind,
 * time of day, vehicle and camera. The only thing that changes between two
 * frames is the uniform block, so a pixel that differs differs because of the
 * effect.
 *
 * Reports, per variant:
 *   engaged   fraction of the frame the effect changes at all (feature on vs
 *             feature off) — this is "how generous is the shape", measured
 *             without reference to what the pattern looks like
 *   control   the same diff taken between two identical frames; the noise floor
 *
 *   node tools/_scratch/occlab.mjs --dir shots/occlab
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/occlab');
const WARM = parseFloat(arg('warm', '14000'));
const W = parseInt(arg('w', '1200'), 10);
const H = parseInt(arg('h', '720'), 10);

mkdirSync(DIR, { recursive: true });
await acquire('occlab');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
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

// Drive into forest — the effect only engages behind a moving camper, and the
// canonical poses deliberately do not have one on screen.
await p.evaluate((warm) => {
  window.__lighting.hour = 16.7; window.__lighting.cycleSpeed = 0;
  const inp = window.__ctx.input; window.__drive = true; const t0 = performance.now();
  const tick = () => { if (!window.__drive) return; const t = (performance.now() - t0) / 1000;
    inp.axes.throttle = 1; inp.axes.steer = Math.sin(t * 0.19) * 0.28; requestAnimationFrame(tick); };
  tick();
  return new Promise((r) => setTimeout(r, warm));
}, WARM);

// ── freeze ─────────────────────────────────────────────────────────────────
const frozen = await p.evaluate(() => {
  window.__drive = false;
  const e = window.__engine;
  e.stop();
  // The update loop is what normally aims the frustum, and it is stopped, so
  // aim it by hand every step — otherwise every variant renders with whatever
  // uniforms happened to be latched when the clock stopped, and every diff is
  // zero.
  const veh = window.__systems.vehicle;
  window.__step = () => new Promise((res) => requestAnimationFrame(() => {
    window.__occlusion.setTarget(e.camera, veh.position);
    e._render ? e._render(0, e.elapsed) : e.renderer.render(e.scene, e.camera);
    requestAnimationFrame(() => res());
  }));
  const v = window.__systems.vehicle, c = e.camera;
  return { camDist: +c.position.distanceTo(v.position).toFixed(2),
           cam: [c.position.x, c.position.y, c.position.z].map((n) => +n.toFixed(1)) };
});
console.log('frozen', JSON.stringify(frozen));

// ── how big are the clumps the near sphere is given? ───────────────────────
const clumps = await p.evaluate(() => {
  const T = window.__THREE, cam = window.__engine.camera;
  const g = window.__engine.scene.getObjectByName('Trees');
  const rows = [];
  const m = new T.Matrix4(), pos = new T.Vector3(), sc = new T.Vector3(), q = new T.Quaternion();
  g.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const aS = o.geometry.getAttribute('aSize');
    if (!aS) return;
    let maxA = 0;
    for (let i = 0; i < aS.count; i++) maxA = Math.max(maxA, aS.getX(i), aS.getY(i));
    let maxScale = 0;
    for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); m.decompose(pos, q, sc); maxScale = Math.max(maxScale, sc.x); }
    rows.push({ mesh: o.name || 'leaf', verts: aS.count, maxHalfSize: +maxA.toFixed(2),
                maxScale: +maxScale.toFixed(2), maxRadius: +(maxA * maxScale).toFixed(2), instances: o.count });
  });
  return rows;
});
console.log('leaf clump extents handed to occludeFadeAt:');
for (const r of clumps) console.log(`  ${r.mesh} instances ${r.instances} maxHalfSize ${r.maxHalfSize} m x maxScale ${r.maxScale} = radius ${r.maxRadius} m`);

// ── the measurement ────────────────────────────────────────────────────────
await p.evaluate(() => {
  window.__diff = async (b64a, b64b) => {
    const dec = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); return i; };
    const [A, B] = await Promise.all([dec(b64a), dec(b64b)]);
    const c = new OffscreenCanvas(A.width, A.height), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(A, 0, 0); const a = g.getImageData(0, 0, A.width, A.height).data;
    g.clearRect(0, 0, A.width, A.height); g.drawImage(B, 0, 0);
    const bb = g.getImageData(0, 0, A.width, A.height).data;
    let n = 0; const tot = a.length / 4;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - bb[i]) + Math.abs(a[i + 1] - bb[i + 1]) + Math.abs(a[i + 2] - bb[i + 2]) > 18) n++;
    }
    return +(n / tot).toFixed(4);
  };
});

const shot = async () => { await p.evaluate(() => window.__step()); return (await p.screenshot()).toString('base64'); };
const setP = (o) => p.evaluate((o) => Object.assign(window.__occlusion.params, o), o);

const BASE = await p.evaluate(() => ({ ...window.__occlusion.params }));
const off = await (async () => { await setP({ enabled: false }); return shot(); })();
const offCtl = await shot();
await setP({ enabled: true });
const control = await p.evaluate(([a, c]) => window.__diff(a, c), [off, offCtl]);
console.log(`control (two identical frames): ${control}`);

const VARIANTS = JSON.parse(arg('variants', 'null')) ?? [
  { name: 'as-shipped', params: {} },
];
for (const v of VARIANTS) {
  await setP({ ...BASE, enabled: true, ...v.params });
  const on = await shot();
  const engaged = await p.evaluate(([a, c]) => window.__diff(a, c), [off, on]);
  writeFileSync(`${DIR}/${v.name}.png`, Buffer.from(on, 'base64'));
  console.log(`${v.name.padEnd(22)} engaged ${engaged}  (control ${control})`);
}
writeFileSync(`${DIR}/off.png`, Buffer.from(off, 'base64'));
await b.close();
