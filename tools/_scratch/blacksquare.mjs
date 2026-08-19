// Hunt the flashing black rectangle.
//
// The still harness never sees it and perf.mjs only samples eight or eleven
// frames out of two thousand, so the artefact is reported as "1/8" or missed
// entirely. This reads the presented framebuffer on EVERY frame at 64x36,
// tracks the running median darkness, and records any frame whose dark area
// jumps above it — with the bounding box of the dark region, so a full-frame
// drop can be told apart from a rectangle sitting in the middle of the picture.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','40')), RES=arg('res','1536'), QUALITY=arg('quality',null);
const EVAL=arg('eval',null), LABEL=arg('label',EVAL?EVAL.slice(0,50):'baseline'), SHOTS=arg('shots',null);
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
const q=new URLSearchParams({res:RES}); if(QUALITY)q.set('quality',QUALITY);
await page.goto(`http://localhost:5178/?${q}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(1500);
if(EVAL) await page.evaluate(EVAL);
await page.evaluate(()=>{
  const e=window.__engine, ctx=window.__ctx, r=e.renderer;
  const gl=r.getContext(); const W=64,H=36; const px=new Uint8Array(W*H*4);
  const P=window.__perf={started:performance.now(),n:0,hits:[],base:[],maxDark:0};
  const orig=ctx.postfx.render.bind(ctx.postfx);
  ctx.postfx.render=function(dt){
    orig(dt); P.n++;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);
    let dark=0,x0=1e9,y0=1e9,x1=-1,y1=-1;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){ const i=(y*W+x)*4;
      if((px[i]+px[i+1]+px[i+2])/3 < 14){ dark++; if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; } }
    const f=dark/(W*H);
    P.base.push(f); if(P.base.length>90) P.base.shift();
    const med=[...P.base].sort((a,b)=>a-b)[P.base.length>>1];
    if(P.maxDark<f) P.maxDark=f;
    // A rectangle appearing where there was none: dark area at least 3% of the
    // frame and at least 2.5% above the running median for this stretch of road.
    if(f>0.03 && f-med>0.025 && P.hits.length<40){
      const cam=e.camera.position;
      P.hits.push({t:+(performance.now()-P.started).toFixed(0), frac:+f.toFixed(3), med:+med.toFixed(3),
        box:[x0,y0,x1-x0+1,y1-y0+1], fill:+(dark/Math.max(1,(x1-x0+1)*(y1-y0+1))).toFixed(2),
        cam:[+cam.x.toFixed(1),+cam.y.toFixed(1),+cam.z.toFixed(1)], calls:r.info.render.calls});
    }
  };
  const input=ctx.input;window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
const shots=[];
if(SHOTS){ mkdirSync(SHOTS,{recursive:true});
  const t0=Date.now();
  while(Date.now()-t0 < SECONDS*1000){
    const n=await page.evaluate(()=>window.__perf.hits.length);
    if(n>shots.length){ shots.push(1); const b=await page.screenshot();
      writeFileSync(`${SHOTS}/hit${shots.length}.png`, b); }
  }
} else await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;
  return {n:P.n,hits:P.hits,maxDark:P.maxDark};});
await browser.close();
console.log(`${LABEL}: ${d.hits.length} dark-jump frames out of ${d.n} presented (max dark fraction ${d.maxDark.toFixed(3)})`);
console.log('grid is 64x36; box is [x,y,w,h] in grid cells, fill = dark cells / box area');
for(const h of d.hits) console.log('  '+JSON.stringify(h));
