// Frame-time cost of a single feature: run the same drive with a tweak applied.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','18')), RES=arg('res','768'), TWEAK=arg('tweak',''), LABEL=arg('label',TWEAK||'control');
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(3000);
if(TWEAK) await page.evaluate((t)=>{ (new Function('ctx','window','THREE',t))(window.__ctx,window,window.__THREE); },TWEAK);
await page.evaluate(()=>{
  const e=window.__engine,ctx=window.__ctx,r=e.renderer;
  const P=window.__perf={frames:[],started:performance.now()};
  let last=performance.now();
  e.onLateUpdate(()=>{const now=performance.now();P.frames.push({ms:now-last,calls:r.info.render.calls,tris:r.info.render.triangles});last=now;});
  const input=ctx.input;window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;const f=P.frames.slice(40);
  const ms=f.map(x=>x.ms).sort((a,b)=>a-b);const q=p=>+ms[Math.floor(p*ms.length)].toFixed(2);
  return {n:f.length,p50:q(.5),p95:q(.95),p99:q(.99),calls:Math.round(f.reduce((a,b)=>a+b.calls,0)/f.length),
    tris:+(f.reduce((a,b)=>a+b.tris,0)/f.length/1e6).toFixed(2)};});
await browser.close();
console.log(`${LABEL.padEnd(28)} p50 ${String(d.p50).padStart(6)}  p95 ${String(d.p95).padStart(6)}  p99 ${String(d.p99).padStart(6)}  calls ${d.calls}  ${d.tris}M`);
