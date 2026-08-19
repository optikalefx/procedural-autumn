// Which effect in the main EffectPass is associated with the black frames?
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','15')), RES=arg('res','768'), KEEP=arg('keep','all');
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,300)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(1500);
const TWEAK=arg('tweak','');
const built=await page.evaluate(([KEEP,TWEAK])=>{
  const P=window.__postfx, c=P.composer, cam=window.__engine.camera;
  if(KEEP!=='all'){
    const names=KEEP.split(',');
    const pool={dof:P.dof,bloom:P.bloom,tone:P.tone,vignette:P.vignette,grade:P.grade,smaa:P.smaa};
    const eff=names.map(n=>pool[n]).filter(Boolean);
    const EP=P.mainPass.constructor;
    c.removePass(P.mainPass);
    const np=new EP(cam, ...eff);
    c.addPass(np); P.mainPass=np;
  }
  if(TWEAK) { try { (new Function('P','window', TWEAK))(P, window); } catch(e){ console.error('tweak failed', e); } }
  return c.passes.map(p=>p.constructor.name+(p.renderToScreen?':screen':''));
},[KEEP,TWEAK]);
await page.evaluate(()=>{
  const e=window.__engine,ctx=window.__ctx,r=e.renderer,P=window.__perf={black:0,tot:0,started:performance.now()};
  const gl=r.getContext(); const W=16,H=9; const px=new Uint8Array(W*H*4);
  const orig=ctx.postfx.render.bind(ctx.postfx);
  ctx.postfx.render=function(dt){orig(dt);P.tot++;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);
    let d=0;for(let i=0;i<W*H;i++){if((px[i*4]+px[i*4+1]+px[i*4+2])/3<12)d++;}
    if(d/(W*H)>0.5)P.black++;};
  const input=ctx.input;window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;return {black:P.black,tot:P.tot};});
await browser.close();
console.log(`keep=${KEEP}  passes=${built.join('|')}  black ${d.black}/${d.tot} = ${(100*d.black/d.tot).toFixed(1)}%`);
