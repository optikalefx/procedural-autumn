#!/usr/bin/env node
/**
 * Attribute the p95 hitch. Drives, records every frame time alongside what the
 * two vegetation streamers did in that frame, and reports the worst frames with
 * their cause attached.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '26'));
await acquire('hitch');
const b = await chromium.launch({ args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--disable-frame-rate-limit'] });
const p = await b.newPage({ viewport:{width:1170,height:870}, deviceScaleFactor:2 });
await p.addInitScript(() => { const R=window.WebSocket; window.WebSocket=function(u,q){ if(typeof u==='string'&&/[?&]token=|vite-hmr|__vite/.test(u)) return {readyState:3,url:u,close(){},send(){},addEventListener(){},removeEventListener(){},set onopen(_){},set onclose(_){},set onerror(_){},set onmessage(_){}}; return new R(u,q);}; window.WebSocket.prototype=R.prototype; Object.assign(window.WebSocket,R); });
await p.goto('http://localhost:5178/?res=1536',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:300});
const out = await p.evaluate(async (secs) => {
  const e=window.__engine, gc=window.__systems.groundCover;
  const rows=[]; let last=performance.now();
  e.onLateUpdate(()=>{ const now=performance.now();
    rows.push([now-last, +(gc.stats.packMs||0).toFixed(2), +(gc.stats.buildMs||0).toFixed(2), +(gc.stats.groundMs||0).toFixed(2)]);
    gc.stats.packMs=0; gc.stats.buildMs=0; gc.stats.groundMs=0; last=now; });
  const inp=window.__ctx.input; window.__drive=true; const t0=performance.now();
  const tick=()=>{ if(!window.__drive) return; const t=(performance.now()-t0)/1000; inp.axes.throttle=1; inp.axes.steer=Math.sin(t*0.42)*0.7; requestAnimationFrame(tick); }; tick();
  await new Promise(r=>setTimeout(r, secs*1000));
  window.__drive=false;
  const all=rows.slice(60);
  const s=[...all].sort((a,b)=>a[0]-b[0]);
  const pct=(q)=>s[Math.min(s.length-1,Math.floor(q*s.length))][0];
  const worst=[...all].sort((a,b)=>b[0]-a[0]).slice(0,14);
  return { n:all.length, p50:+pct(0.5).toFixed(1), p95:+pct(0.95).toFixed(1), p99:+pct(0.99).toFixed(1),
           worst, packMax:gc.stats.packMaxMs, packs:gc.stats.packs, instances:gc.stats.instances,
           overs:{ '>45':all.filter(r=>r[0]>45).length, '>45_withPack':all.filter(r=>r[0]>45&&r[1]>1).length,
                   '>45_withBuild':all.filter(r=>r[0]>45&&(r[2]>1||r[3]>1)).length } };
}, SECONDS);
await b.close();
console.log(JSON.stringify({...out, worst:out.worst.map(w=>`dt=${w[0].toFixed(0)} pack=${w[1]} build=${w[2]} ground=${w[3]}`)}, null, 1));
