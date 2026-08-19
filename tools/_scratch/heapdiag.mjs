// Is the frame budget being eaten by GC? Track JS heap sawtooth and correlate
// heap drops (collections) with frame hitches.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','30')), RES=arg('res','768');
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit','--enable-precise-memory-info']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(1000);
await page.evaluate(()=>{
  const e=window.__engine,ctx=window.__ctx,r=e.renderer;
  const P=window.__perf={frames:[],started:performance.now()};
  let last=performance.now();
  e.onLateUpdate(()=>{const now=performance.now();
    P.frames.push({t:now-P.started,ms:now-last,heap:performance.memory?performance.memory.usedJSHeapSize:0,calls:r.info.render.calls});last=now;});
  const input=ctx.input;window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;const f=P.frames.slice(30);
  let alloc=0,drops=[];
  for(let i=1;i<f.length;i++){const dh=f[i].heap-f[i-1].heap; if(dh>0)alloc+=dh; else if(dh<-2e6)drops.push({t:+(f[i].t/1000).toFixed(1),mb:+(dh/1e6).toFixed(1),ms:+f[i].ms.toFixed(1)});}
  const secs=(f[f.length-1].t-f[0].t)/1000;
  const ms=f.map(x=>x.ms).sort((a,b)=>a-b);
  return {n:f.length,secs:+secs.toFixed(1),allocMBps:+(alloc/1e6/secs).toFixed(2),allocKBframe:+(alloc/1024/f.length).toFixed(1),
    p50:+ms[Math.floor(.5*ms.length)].toFixed(2),p99:+ms[Math.floor(.99*ms.length)].toFixed(2),
    drops:drops.slice(0,25), heap0:+(f[0].heap/1e6).toFixed(1), heapN:+(f[f.length-1].heap/1e6).toFixed(1),
    worst:[...f].sort((a,b)=>b.ms-a.ms).slice(0,10).map(x=>({t:+(x.t/1000).toFixed(1),ms:+x.ms.toFixed(1),heapMB:+(x.heap/1e6).toFixed(1)}))};});
await browser.close();
console.log(`frames ${d.n} over ${d.secs}s  p50 ${d.p50} p99 ${d.p99}`);
console.log(`heap ${d.heap0} -> ${d.heapN} MB   allocation ${d.allocMBps} MB/s  (${d.allocKBframe} KB/frame)`);
console.log('GC drops (>2MB):'); for(const x of d.drops) console.log(`  ${String(x.t).padStart(6)}s ${x.mb} MB   frame ${x.ms} ms`);
console.log('worst:'); for(const w of d.worst) console.log(`  ${String(w.t).padStart(6)}s ${String(w.ms).padStart(7)}ms heap ${w.heapMB} MB`);
