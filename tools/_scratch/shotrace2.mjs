// Frame times only (no in-page readback), with the harness's own screenshot
// windows recorded in page time, so hitches can be attributed.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','30')), RES=arg('res','768');
const NOSHOT=argv.includes('--noshot');
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.evaluate(()=>{
  const e=window.__engine,ctx=window.__ctx;
  const P=window.__perf={frames:[],started:performance.now(),shots:[]};
  let last=performance.now();
  e.onLateUpdate(()=>{const now=performance.now();P.frames.push({t:now-P.started,ms:now-last});last=now;});
  const input=ctx.input;window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
const SAMPLES=8;
for(let i=0;i<SAMPLES;i++){
  await page.waitForTimeout(SECONDS*1000/SAMPLES);
  if(NOSHOT) continue;
  const t0=await page.evaluate(()=>performance.now()-window.__perf.started);
  await page.screenshot();
  await page.evaluate(([a])=>{window.__perf.shots.push([a, performance.now()-window.__perf.started]);},[t0]);
}
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;const f=P.frames.slice(30);
  const ms=f.map(x=>x.ms).sort((a,b)=>a-b);
  const inShot=(t)=>P.shots.some(([a,b])=>t>=a-40&&t<=b+120);
  const big=f.filter(x=>x.ms>50);
  return {n:f.length,p50:+ms[Math.floor(.5*ms.length)].toFixed(2),p95:+ms[Math.floor(.95*ms.length)].toFixed(2),
    p99:+ms[Math.floor(.99*ms.length)].toFixed(2),
    h50:big.length,h50out:big.filter(x=>!inShot(x.t)).length,
    h100:f.filter(x=>x.ms>100).length,h100out:f.filter(x=>x.ms>100&&!inShot(x.t)).length,
    shots:P.shots.map(([a,b])=>[+(a/1000).toFixed(1),Math.round(b-a)]),
    worstOut:f.filter(x=>!inShot(x.t)).sort((a,b)=>b.ms-a.ms).slice(0,8).map(x=>({t:+(x.t/1000).toFixed(1),ms:+x.ms.toFixed(1)}))};});
await browser.close();
console.log(`frames ${d.n}  p50 ${d.p50} p95 ${d.p95} p99 ${d.p99}`);
console.log(`>50ms ${d.h50} (of which ${d.h50out} outside a screenshot window)`);
console.log(`>100ms ${d.h100} (of which ${d.h100out} outside a screenshot window)`);
console.log('screenshot windows [startS, durationMs]:', JSON.stringify(d.shots));
console.log('worst frames NOT in a screenshot window:', JSON.stringify(d.worstOut));
