// A/B a tweak WITHIN one page load, alternating in 4 s blocks, so machine
// contention hits both arms equally. Reports the median of each arm.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const RES=arg('res','768'), ON=arg('on',''), OFF=arg('off',''), LABEL=arg('label','tweak'), BLOCKS=parseInt(arg('blocks','6'),10);
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(3000);
await page.evaluate(()=>{
  const e=window.__engine,ctx=window.__ctx,r=e.renderer;
  const P=window.__perf={frames:[],started:performance.now(),arm:0};
  let last=performance.now();
  e.onLateUpdate(()=>{const now=performance.now();P.frames.push({ms:now-last,arm:P.arm,calls:r.info.render.calls,tris:r.info.render.triangles});last=now;});
  const input=ctx.input;window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
for(let b=0;b<BLOCKS;b++){
  const on=b%2===1;
  await page.evaluate(([code,arm])=>{ if(code) (new Function('ctx','window','THREE',code))(window.__ctx,window,window.__THREE); window.__perf.arm=-1; },[on?ON:OFF,0]);
  await page.waitForTimeout(700);   // settle after the switch
  await page.evaluate((arm)=>{window.__perf.arm=arm;}, on?1:0);
  await page.waitForTimeout(4000);
  await page.evaluate(()=>{window.__perf.arm=-1;});
}
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;
  const pick=(a)=>{const f=P.frames.filter(x=>x.arm===a);const ms=f.map(x=>x.ms).sort((x,y)=>x-y);
    return {n:f.length,p50:+ms[Math.floor(.5*ms.length)].toFixed(2),p95:+ms[Math.floor(.95*ms.length)].toFixed(2),
      calls:Math.round(f.reduce((s,x)=>s+x.calls,0)/f.length),tris:+(f.reduce((s,x)=>s+x.tris,0)/f.length/1e6).toFixed(2)};};
  return {off:pick(0),on:pick(1)};});
await browser.close();
const f=(k,v)=>`${k} p50 ${String(v.p50).padStart(6)} p95 ${String(v.p95).padStart(6)} calls ${String(v.calls).padStart(4)} ${v.tris}M (${v.n})`;
console.log(`${LABEL}\n  ${f('base  ',d.off)}\n  ${f('tweak ',d.on)}\n  delta p50 ${(d.on.p50-d.off.p50).toFixed(2)} ms, p95 ${(d.on.p95-d.off.p95).toFixed(2)} ms`);
