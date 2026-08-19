// Rank systems by bytes allocated per frame (precise heap deltas summed).
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','25')), RES=arg('res','768');
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit','--enable-precise-memory-info']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(1000);
await page.evaluate(()=>{
  const e=window.__engine,ctx=window.__ctx;
  const A={}, N={};
  const M=()=>performance.memory.usedJSHeapSize;
  const wrap=(o,n,label)=>{ if(!o||typeof o[n]!=='function')return; const f=o[n].bind(o);
    o[n]=function(...a){const h=M();const out=f(...a);const d=M()-h; if(d>0){A[label]=(A[label]||0)+d;} N[label]=(N[label]||0)+1; return out;};};
  for(const [n,s] of Object.entries(ctx.systems)) { wrap(s,'update',n); wrap(s,'lateUpdate',n+'.late'); }
  wrap(ctx.terrain,'update','terrain'); wrap(ctx.lighting,'update','lighting'); wrap(ctx.sky,'update','sky');
  wrap(ctx.postfx,'render','postfx'); wrap(ctx.stylize,'update','stylize'); wrap(ctx.atmosphere,'update','atmosphere');
  const P=window.__perf={A,N,started:performance.now(),frames:0,h0:M()};
  e.onLateUpdate(()=>{P.frames++;});
  const input=ctx.input;window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;
  return {frames:P.frames, rows:Object.entries(P.A).map(([k,v])=>[k,+(v/P.frames/1024).toFixed(1)]).sort((a,b)=>b[1]-a[1])};});
await browser.close();
console.log(`frames ${d.frames}`);
console.log('KB allocated per frame (lower bound; nested calls double-count parents):');
for(const [k,v] of d.rows) if(v>=1) console.log(`  ${k.padEnd(18)} ${String(v).padStart(8)} KB`);
