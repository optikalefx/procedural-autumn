// Where does a frame go? Wall time per system update, plus the render callback
// split into shadow / scene / post, measured on a real drive.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','25')), RES=arg('res','1536'), QUALITY=arg('quality',null);
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
const q=new URLSearchParams({res:RES}); if(QUALITY)q.set('quality',QUALITY);
await page.goto(`http://localhost:5178/?${q}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(1200);
await page.evaluate(()=>{
  const e=window.__engine, ctx=window.__ctx, r=e.renderer;
  const S={};                                  // label -> array of ms this frame
  const cur={};                                // label -> ms accumulated this frame
  const rec=(k,ms)=>{cur[k]=(cur[k]||0)+ms;};
  const wrap=(o,n,label)=>{ if(!o||typeof o[n]!=='function')return; const f=o[n].bind(o);
    o[n]=function(...a){const t=performance.now(); const out=f(...a); rec(label,performance.now()-t); return out;};};
  for(const [n,s] of Object.entries(ctx.systems)){ wrap(s,'update',n); wrap(s,'lateUpdate',n+'~late'); }
  wrap(ctx.terrain,'update','terrain'); wrap(ctx.lighting,'update','lighting');
  wrap(ctx.sky,'update','sky'); wrap(ctx.stylize,'update','stylize'); wrap(ctx.atmosphere,'update','atmosphere');
  wrap(ctx.postfx,'render','POSTFX.render');
  // shadow pass inside the renderer
  const sm=r.shadowMap; const of_=sm.render.bind(sm);
  sm.render=function(...a){const t=performance.now(); const o=of_(...a); rec('  ..shadowMap',performance.now()-t); return o;};
  const orr=r.render.bind(r);
  let drawCalls=0, shadowCalls=0, inShadow=false;
  const gl=r.getContext();
  for(const fn of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']){
    const g=gl[fn].bind(gl); gl[fn]=function(...a){ drawCalls++; if(inShadow) shadowCalls++; return g(...a); }; }
  sm.render=function(...a){const t=performance.now(); inShadow=true; const o=of_(...a); inShadow=false; rec('  ..shadowMap',performance.now()-t); return o;};
  r.render=function(...a){const t=performance.now(); const o=orr(...a); rec('  ..renderer.render',performance.now()-t); return o;};
  const P=window.__perf={S,frames:0,started:performance.now(),ft:[],draws:[],sdraws:[],worst:[]};
  // Split the frame into the part we run and the part the browser runs, so a
  // stall can be pinned on the render, on a system, or on neither (a GC or a
  // compositor/driver stall between frames, which no amount of system tuning
  // will touch).
  let last=performance.now(), lateEnd=performance.now();
  e.onUpdate(()=>{ const now=performance.now(); rec('~gap before update', now-lateEnd); });
  e.onLateUpdate(()=>{ const now=performance.now();
    const ft=now-last;
    if(ft>60){ const parts=Object.entries(cur).sort((a,b)=>b[1]-a[1]).slice(0,4)
      .map(([k,v])=>`${k} ${v.toFixed(0)}`);
      P.worst.push({t:+((now-P.started)/1000).toFixed(1),ms:+ft.toFixed(0),parts,
        heap:performance.memory?(performance.memory.usedJSHeapSize/1048576)|0:0}); }
    P.ft.push(ft); last=now; P.frames++; lateEnd=now;
    for(const k in cur){ (S[k]||(S[k]=[])).push(cur[k]); delete cur[k]; }
    P.draws.push(drawCalls); P.sdraws.push(shadowCalls); drawCalls=0; shadowCalls=0; });
  const input=ctx.input;window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;
  const st=(a)=>{const s=[...a].sort((x,y)=>x-y);const sum=a.reduce((p,c)=>p+c,0);
    return {mean:sum/a.length, p50:s[Math.floor(s.length*0.5)]||0, p95:s[Math.floor(s.length*0.95)]||0, max:s[s.length-1]||0, sum};};
  const rows=Object.entries(P.S).map(([k,v])=>[k,st(v),v.length]);
  return {frames:P.frames, ft:st(P.ft), rows:rows.map(([k,s,n])=>[k,+s.mean.toFixed(2),+s.p50.toFixed(2),+s.p95.toFixed(2),+s.max.toFixed(1),n]).sort((a,b)=>b[1]-a[1]),
    draws:st(P.draws), sdraws:st(P.sdraws), worst:P.worst.sort((a,b)=>b.ms-a.ms).slice(0,14)};});
await browser.close();
console.log(`frames ${d.frames}   frame time mean ${d.ft.mean.toFixed(1)} p50 ${d.ft.p50.toFixed(1)} p95 ${d.ft.p95.toFixed(1)} max ${d.ft.max.toFixed(0)}`);
console.log(`GL draw calls/frame  total mean ${d.draws.mean.toFixed(0)} max ${d.draws.max}   of which shadow mean ${d.sdraws.mean.toFixed(0)} max ${d.sdraws.max}`);
console.log('\nlabel                     mean     p50     p95     max   frames');
for(const [k,m,p50,p95,mx,n] of d.rows) if(m>=0.05) console.log(`  ${k.padEnd(22)} ${String(m).padStart(6)} ${String(p50).padStart(7)} ${String(p95).padStart(7)} ${String(mx).padStart(7)} ${String(n).padStart(7)}`);
console.log('\nframes over 60 ms, with where the time went (ms):');
for(const w of d.worst) console.log(`  ${String(w.t).padStart(6)}s ${String(w.ms).padStart(5)}ms  heap ${w.heap}MB   ${w.parts.join('   ')}`);
