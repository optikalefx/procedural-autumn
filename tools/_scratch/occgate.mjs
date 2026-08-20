#!/usr/bin/env node
/**
 * What the frustum GATE costs on the CPU, and how often it fires.
 *
 * The gate is the price of keeping bark and rock on their cheap programs in
 * the frames that do not need the fade (see render/Occlusion.js), so it is paid
 * in every frame and has to be small. It is also the thing that decides how
 * often the expensive programs are used at all, which is the other half of
 * whether this feature is affordable — so both numbers come out of one drive.
 *
 *   node tools/_scratch/occgate.mjs --secs 60
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const SECS = parseFloat(arg('secs', '60'));
await acquire('occgate');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
await p.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await p.goto('http://localhost:5178/?res=1024', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(2500);

await p.evaluate(() => {
  const tr = window.__systems.trees, rk = window.__systems.rocks;
  const S = window.__g = { ms: [], barkFrames: 0, rockFrames: 0, frames: 0, barkInst: [], barkDrawn: [] };
  const wrap = (o) => { const f = o._gateOcclusion.bind(o); return () => { const t = performance.now(); f(); return performance.now() - t; }; };
  const gt = wrap(tr), gr = wrap(rk);
  tr._gateOcclusion = () => {}; rk._gateOcclusion = () => {};
  window.__engine.onLateUpdate(() => {
    const ms = gt() + gr();
    S.frames++; S.ms.push(ms);
    const on = tr._barkSlots.filter((s) => s.occOn);
    if (on.length) { S.barkFrames++; S.barkInst.push(on.reduce((a, s) => a + s.count, 0)); }
    if (rk.meshes.some((m) => m.userData.occOn)) S.rockFrames++;
    S.barkDrawn.push(tr._barkSlots.reduce((a, s) => a + s.count, 0));
  });
  const inp = window.__ctx.input; window.__drive = true; const t0 = performance.now();
  const tick = () => { if (!window.__drive) return; const t = (performance.now() - t0) / 1000;
    inp.axes.throttle = 1; inp.axes.steer = Math.sin(t * 0.37) * 0.62; requestAnimationFrame(tick); };
  tick();
});
await p.waitForTimeout(SECS * 1000);
const r = await p.evaluate(() => {
  const S = window.__g; window.__drive = false;
  const ms = S.ms.slice().sort((a, b) => a - b);
  const q = (f) => +ms[Math.floor(f * (ms.length - 1))].toFixed(3);
  const mean = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : 0;
  return { frames: S.frames, gateP50: q(0.5), gateP95: q(0.95), gateMax: +ms[ms.length - 1].toFixed(3),
           barkFramesPct: +(100 * S.barkFrames / S.frames).toFixed(1),
           rockFramesPct: +(100 * S.rockFrames / S.frames).toFixed(1),
           meanBarkInstancesOnOccProgram: mean(S.barkInst),
           meanBarkInstancesDrawn: mean(S.barkDrawn) };
});
console.log(JSON.stringify(r, null, 1));
await b.close();
