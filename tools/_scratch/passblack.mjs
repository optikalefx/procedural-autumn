// On a black frame, which pass first produced black?
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','20')), RES=arg('res','768');
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(1500);
await page.evaluate(()=>{
  const e=window.__engine,ctx=window.__ctx,r=e.renderer,P=window.__perf={started:performance.now(),black:0,tot:0,rec:[],trace:null};
  const gl=r.getContext(); const W=16,H=9; const px=new Uint8Array(W*H*4);
  const buf=new Uint16Array(4*4*4);
  const rtSum=(rt)=>{ try{ r.readRenderTargetPixels(rt,0,0,4,4,buf); let s=0; for(let i=0;i<buf.length;i+=4) s+=buf[i]+buf[i+1]+buf[i+2]; return s; }catch(err){ return -1; } };
  const c=ctx.postfx.composer;
  c.passes.forEach((p,i)=>{ const o=p.render.bind(p);
    p.render=function(rend,inB,outB,dt,st){ o(rend,inB,outB,dt,st);
      if(P.trace) P.trace.push([`${i}:${p.constructor.name.slice(0,14)}`, rtSum(inB), rtSum(outB)]); }; });
  const read=()=>{gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);
    let d=0;for(let i=0;i<W*H;i++){if((px[i*4]+px[i*4+1]+px[i*4+2])/3<12)d++;}return d/(W*H);};
  const orig=ctx.postfx.render.bind(ctx.postfx);
  ctx.postfx.render=function(dt){ orig(dt); P.tot++;
    if(read()>0.5){ P.black++;
      if(P.rec.length<4){ P.trace=[]; orig(dt); const after=read(); P.rec.push({t:+(performance.now()-P.started).toFixed(0),after,trace:P.trace}); P.trace=null; } } };
  const input=ctx.input;window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;return {black:P.black,tot:P.tot,rec:P.rec};});
await browser.close();
console.log(`black ${d.black}/${d.tot}`);
for(const r of d.rec){ console.log(`t=${r.t} rerenderStillBlack=${r.after}`); for(const s of r.trace) console.log('   ',s.join('  in/out sums: ')); }
