// Does tools/perf.mjs's own page.screenshot() cause the hitches and the black
// frames it reports? Records the page-time window of every screenshot and
// checks, independently, whether the *rendered* frame was ever black using an
// in-page readPixels immediately after the composer finishes.
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
await page.waitForTimeout(1000);
await page.evaluate(()=>{
  const e=window.__engine,ctx=window.__ctx,r=e.renderer;
  const P=window.__perf={frames:[],started:performance.now(),shots:[],dark:[]};
  const gl=r.getContext(); const W=32,H=18; const px=new Uint8Array(W*H*4);
  let n=0;
  const orig=ctx.postfx.render.bind(ctx.postfx);
  ctx.postfx.render=function(dt){ orig(dt);
    if((n++%8)===0){ // readback of the just-presented frame, cheap sample grid
      const dw=gl.drawingBufferWidth, dh=gl.drawingBufferHeight;
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);
      let dark=0; for(let i=0;i<W*H;i++){ if((px[i*4]+px[i*4+1]+px[i*4+2])/3<12) dark++; }
      const f=dark/(W*H); if(f>0.5) P.dark.push({t:performance.now()-P.started,f:+f.toFixed(2),dw,dh});
    }};
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
  const buf=await page.screenshot();
  const t1=await page.evaluate((n)=>{const P=window.__perf;const t=performance.now()-P.started;P.shots.push([P.__t0,t]);return t;},0);
  await page.evaluate(([a,b])=>{window.__perf.shots[window.__perf.shots.length-1]=[a,b];},[t0,t1]);
  void buf;
}
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;const f=P.frames.slice(30);
  const ms=f.map(x=>x.ms).sort((a,b)=>a-b);
  const inShot=(t)=>P.shots.some(([a,b])=>t>=a-60&&t<=b+60);
  const big=f.filter(x=>x.ms>100);
  return {n:f.length,p50:+ms[Math.floor(.5*ms.length)].toFixed(2),p95:+ms[Math.floor(.95*ms.length)].toFixed(2),
    p99:+ms[Math.floor(.99*ms.length)].toFixed(2),h50:f.filter(x=>x.ms>50).length,h100:big.length,
    big:big.map(x=>({t:+(x.t/1000).toFixed(1),ms:+x.ms.toFixed(1),inShot:inShot(x.t)})),
    shots:P.shots.map(([a,b])=>[+(a/1000).toFixed(1),+((b-a)).toFixed(0)]), dark:P.dark};});
await browser.close();
console.log(`frames ${d.n}  p50 ${d.p50} p95 ${d.p95} p99 ${d.p99}  >50 ${d.h50}  >100 ${d.h100}`);
console.log('screenshot windows (page time s, duration ms):', JSON.stringify(d.shots));
console.log('frames >100 ms:'); for(const b of d.big) console.log(`  ${String(b.t).padStart(6)}s ${String(b.ms).padStart(7)}ms  insideScreenshot=${b.inShot}`);
console.log('in-page readPixels black frames:', JSON.stringify(d.dark));
