// What the HDR sanity pass costs. Interleaved blocks in one page load so
// machine load hits both arms equally.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const PORT=arg('port','5178'), BLOCK=parseFloat(arg('block','6')), ROUNDS=parseInt(arg('rounds','5'),10);
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const close=async()=>{try{await browser.close();}catch{/* gone */}};
process.on('exit',()=>{browser.close().catch(()=>{});});
try{
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.routeWebSocket(new RegExp(`^wss?://(localhost|127\\.0\\.0\\.1):${PORT}/`),()=>{});
await page.goto(`http://127.0.0.1:${PORT}/?res=1536`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
await page.waitForTimeout(2000);
await page.evaluate(()=>{const ctx=window.__ctx,input=ctx.input;const t0=performance.now();window.__d=true;
  const tick=()=>{if(!window.__d)return;const t=(performance.now()-t0)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();});
const arms={on:[],off:[]};
for(let r=0;r<ROUNDS;r++){
  for(const on of [true,false]){
    const d=await page.evaluate(async ({on,BLOCK})=>{
      window.__ctx.postfx.sanity.enabled=on;
      await new Promise(res=>{let k=0;const w=()=>{if(++k>10){res();return;}requestAnimationFrame(w);};w();});
      const ts=[]; let last=performance.now();
      await new Promise(res=>{const t0=performance.now();
        const step=()=>{const n=performance.now();ts.push(n-last);last=n;
          if(n-t0>=BLOCK*1000){res();return;}requestAnimationFrame(step);};step();});
      ts.sort((a,b)=>a-b);
      return {n:ts.length,p50:ts[ts.length>>1],p95:ts[Math.floor(ts.length*0.95)]};
    },{on,BLOCK});
    arms[on?'on':'off'].push(d);
  }
}
await page.evaluate(()=>{window.__d=false;});
const agg=(a)=>({frames:a.reduce((s,x)=>s+x.n,0),
  p50:+(a.reduce((s,x)=>s+x.p50,0)/a.length).toFixed(2),
  p95:+(a.reduce((s,x)=>s+x.p95,0)/a.length).toFixed(2)});
const on=agg(arms.on), off=agg(arms.off);
console.log(`\nHDR sanity pass cost, ${ROUNDS} interleaved blocks of ${BLOCK}s each, driving\n`);
console.log(`  pass ON   frames ${String(on.frames).padStart(5)}   p50 ${on.p50} ms   p95 ${on.p95} ms`);
console.log(`  pass OFF  frames ${String(off.frames).padStart(5)}   p50 ${off.p50} ms   p95 ${off.p95} ms`);
console.log(`  delta                       p50 ${(on.p50-off.p50).toFixed(2)} ms  p95 ${(on.p95-off.p95).toFixed(2)} ms`);
} finally { await close(); }
