#!/usr/bin/env node
/**
 * Drive and capture at a fixed interval. A still cannot show pop-in; six frames
 * half a second apart, flipped through, can — anything that arrives does so in
 * the gap between two of them.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/lod/motion');
const N = parseInt(arg('n', '6'), 10);
const GAP = parseFloat(arg('gap', '500'));
const WARM = parseFloat(arg('warm', '14000'));
mkdirSync(DIR, { recursive: true });
await acquire('motionstrip');
const b = await chromium.launch({ args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport:{width:1200,height:720} });
await p.addInitScript(() => { const R=window.WebSocket; window.WebSocket=function(u,q){ if(typeof u==='string'&&/[?&]token=|vite-hmr|__vite/.test(u)) return {readyState:3,url:u,close(){},send(){},addEventListener(){},removeEventListener(){},set onopen(_){},set onclose(_){},set onerror(_){},set onmessage(_){}}; return new R(u,q);}; window.WebSocket.prototype=R.prototype; Object.assign(window.WebSocket,R); });
await p.goto('http://localhost:5178/?res=1536',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:300});
const ov = { cover: arg('cover', null), near: arg('near', null), mid: arg('mid', null) };
await p.evaluate((o) => {
  const S = window.__systems;
  if (o.cover !== null) { S.groundCover.visMul = parseFloat(o.cover); S.groundCover._dirty = true; }
  if (o.near) S.grass.rings[0].material.userData.uniforms.uFadeOut.value.fromArray(o.near.split(',').map(Number));
  if (o.mid) S.grass.rings[1].material.userData.uniforms.uFadeIn.value.fromArray(o.mid.split(',').map(Number));
}, ov);
await p.evaluate((warm) => { const inp=window.__ctx.input; window.__drive=true; const t0=performance.now();
  const tick=()=>{ if(!window.__drive) return; const t=(performance.now()-t0)/1000; inp.axes.throttle=1; inp.axes.steer=Math.sin(t*0.18)*0.25; requestAnimationFrame(tick); }; tick();
  return new Promise(r=>setTimeout(r, warm)); }, WARM);
for (let i = 0; i < N; i++) {
  const st = await p.evaluate(() => ({ s:+Math.abs(window.__systems.vehicle.speed).toFixed(1) }));
  writeFileSync(`${DIR}/f${i}.png`, await p.screenshot());
  process.stdout.write(`f${i}(${st.s}m/s) `);
  await p.evaluate((g)=>new Promise(r=>setTimeout(r,g)), GAP);
}
await p.evaluate(()=>{ window.__drive=false; });
console.log('\n' + DIR);
await b.close();
