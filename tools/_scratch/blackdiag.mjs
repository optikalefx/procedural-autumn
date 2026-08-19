// Are the black frames real? Read back the presented buffer every Nth frame and
// record the renderer state that produced it.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','30')), RES=arg('res','768'), EVERY=parseInt(arg('every','1'),10);
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(1000);
await page.evaluate((EVERY)=>{
  const e=window.__engine,ctx=window.__ctx,r=e.renderer;
  const P=window.__perf={started:performance.now(),n:0,samples:0,dark:[],hist:[]};
  const gl=r.getContext(); const W=32,H=18; const px=new Uint8Array(W*H*4);
  const orig=ctx.postfx.render.bind(ctx.postfx);
  ctx.postfx.render=function(dt){ orig(dt);
    if((P.n++%EVERY)!==0) return;
    P.samples++;
    const info=r.info.render;
    const calls=info.calls, tris=info.triangles;
    const rt=r.getRenderTarget();
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);
    let dark=0,sum=0; for(let i=0;i<W*H;i++){const v=(px[i*4]+px[i*4+1]+px[i*4+2])/3;sum+=v;if(v<12)dark++;}
    const f=dark/(W*H);
    P.hist.push(+(sum/(W*H)).toFixed(0));
    if(f>0.5) P.dark.push({t:+(performance.now()-P.started).toFixed(0),f:+f.toFixed(2),calls,tris,
      rt:rt?(rt.width+'x'+rt.height):'null', dbw:gl.drawingBufferWidth, err:gl.getError(),
      lost:gl.isContextLost()});
  };
  const input=ctx.input;window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
},EVERY);
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;
  const h=P.hist; const mean=h.reduce((a,b)=>a+b,0)/h.length;
  return {samples:P.samples,dark:P.dark.slice(0,20),darkN:P.dark.length,mean:+mean.toFixed(1),
    lowest:[...h].sort((a,b)=>a-b).slice(0,12)};});
await browser.close();
console.log(`sampled ${d.samples} presented frames; ${d.darkN} were black`);
console.log('mean brightness', d.mean, ' lowest samples', JSON.stringify(d.lowest));
for(const x of d.dark) console.log(' ', JSON.stringify(x));
