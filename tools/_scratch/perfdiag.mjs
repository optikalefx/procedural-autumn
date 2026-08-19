// Diagnostic: same drive as tools/perf.mjs but NO screenshots, plus per-system
// update timing, so instrument artifacts are separated from real hitches.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS = parseFloat(arg('seconds','30'));
const RES = arg('res','768');
const QUALITY = arg('quality',null);
await acquire('perf');
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('PAGEERROR', String(e.message).slice(0,200)));
page.on('console', m => { if (m.type()==='error') console.log('CONSOLE-ERR', m.text().slice(0,200)); });
const params = new URLSearchParams({ res: RES }); if (QUALITY) params.set('quality', QUALITY);
await page.goto(`http://localhost:5178/?${params}`, { waitUntil:'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForTimeout(1500);

await page.evaluate(() => {
  const e = window.__engine, ctx = window.__ctx, r = e.renderer;
  const P = window.__perf = { frames: [], started: performance.now(), acc: {}, base: { geo: r.info.memory.geometries, tex: r.info.memory.textures } };
  const cur = {};
  const wrap = (obj, name, label) => {
    if (!obj || typeof obj[name] !== 'function') return;
    const orig = obj[name].bind(obj);
    obj[name] = function (...a) { const t = performance.now(); const out = orig(...a); const d = performance.now()-t; cur[label]=(cur[label]||0)+d; P.acc[label]=(P.acc[label]||0)+d; return out; };
  };
  for (const [n, s] of Object.entries(ctx.systems)) wrap(s, 'update', n);
  for (const [n, s] of Object.entries(ctx.systems)) wrap(s, 'lateUpdate', n+'.late');
  wrap(ctx.terrain, 'update', 'terrain');
  wrap(ctx.lighting, 'update', 'lighting');
  wrap(ctx.sky, 'update', 'sky');
  wrap(ctx.postfx, 'render', 'postfx');
  wrap(ctx.stylize, 'update', 'stylize');
  wrap(ctx.atmosphere, 'update', 'atmos');
  let last = performance.now();
  e.onLateUpdate(() => {
    const now = performance.now();
    const rec = { t: now - P.started, ms: now - last, calls: r.info.render.calls, tris: r.info.render.triangles, geo: r.info.memory.geometries, tex: r.info.memory.textures, s: {} };
    for (const k in cur) { if (cur[k] > 0.6) rec.s[k] = +cur[k].toFixed(1); cur[k] = 0; }
    P.frames.push(rec); last = now;
  });
  const input = window.__ctx?.input;
  window.__perfDrive = true;
  const tick = () => { if (!window.__perfDrive) return; const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1; input.axes.brake=0; input.axes.steer=Math.sin(t*0.42)*0.75; input.axes.handbrake=0;
    requestAnimationFrame(tick); };
  tick();
});
await page.waitForTimeout(SECONDS*1000);
const data = await page.evaluate(() => {
  const P = window.__perf; window.__perfDrive = false;
  const f = P.frames.slice(30);
  const ms = f.map(x=>x.ms).sort((a,b)=>a-b);
  const pct = p => ms[Math.min(ms.length-1, Math.floor(p*ms.length))];
  const last = f[f.length-1];
  const tot = f.reduce((a,b)=>a+b.ms,0);
  const acc = Object.entries(P.acc).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k, +(v/f.length).toFixed(2), +(100*v/tot).toFixed(1)]);
  return { frames:f.length, p50:+pct(.5).toFixed(2), p95:+pct(.95).toFixed(2), p99:+pct(.99).toFixed(2),
    h33:f.filter(x=>x.ms>33).length, h50:f.filter(x=>x.ms>50).length, h100:f.filter(x=>x.ms>100).length,
    maxCalls: Math.max(...f.map(x=>x.calls)), maxTris: Math.max(...f.map(x=>x.tris)),
    growth: { geo: last.geo-P.base.geo, tex: last.tex-P.base.tex },
    worst: [...f].sort((a,b)=>b.ms-a.ms).slice(0,14).map(x=>({t:+(x.t/1000).toFixed(1), ms:+x.ms.toFixed(1), calls:x.calls, s:x.s})),
    acc,
  };
});
await browser.close();
console.log(`p50 ${data.p50}  p95 ${data.p95}  p99 ${data.p99}   >33 ${data.h33}  >50 ${data.h50}  >100 ${data.h100}  (${data.frames} frames)`);
console.log(`peak ${data.maxCalls} calls  ${(data.maxTris/1e6).toFixed(2)}M tris   growth geo +${data.growth.geo} tex +${data.growth.tex}`);
console.log('\nmean ms/frame by system (ms, % of wall):');
for (const [k,v,p] of data.acc) if (v >= 0.05) console.log(`  ${k.padEnd(16)} ${String(v).padStart(7)}  ${p}%`);
console.log('\nworst frames:');
for (const w of data.worst) console.log(`  ${String(w.t).padStart(6)}s ${String(w.ms).padStart(7)}ms ${String(w.calls).padStart(5)}c  ${JSON.stringify(w.s)}`);
