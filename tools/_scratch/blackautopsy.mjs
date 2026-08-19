// A black frame here is reproducible: re-rendering the identical frame comes
// back black too. So it can be taken apart. On a hit this re-renders the same
// frame with one thing changed at a time and reports which change brings the
// picture back, and scans the scene HDR buffer for non-finite values.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','90')), RES=arg('res','768');
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,160)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
await page.waitForTimeout(1500);
await page.evaluate(()=>{
  const e=window.__engine, ctx=window.__ctx, r=e.renderer, pf=ctx.postfx;
  const gl=r.getContext(); const W=32,H=18; const px=new Uint8Array(W*H*4);
  const P=window.__perf={started:performance.now(),n:0,hits:[],autopsies:[]};
  // deepen the chain so hits are frequent enough to catch in one run
  pf.bloom.mipmapBlurPass.levels=6;
  const orig=pf.render.bind(pf);
  const read=()=>{ gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);
    let d=0,s=0; for(let i=0;i<W*H;i++){const v=(px[i*4]+px[i*4+1]+px[i*4+2])/3; s+=v; if(v<14)d++;}
    return {dark:d/(W*H), mean:s/(W*H)}; };
  const scanHDR=()=>{ // scene colour before the effects, scanned for Inf/NaN
    try{ const c=pf.composer; const rt=c.inputBuffer;
      const buf=new Float32Array(64*36*4);
      r.readRenderTargetPixels(rt,0,0,64,36,buf);
      let bad=0,max=0; for(let i=0;i<buf.length;i++){ const v=buf[i];
        if(!Number.isFinite(v)) bad++; else if(v>max) max=v; }
      return {bad, max:+max.toFixed(1), w:rt.width, h:rt.height};
    }catch(err){ return {err:String(err).slice(0,60)}; } };
  pf.render=function(dt){
    orig(dt); P.n++;
    const a=read();
    if(a.dark<0.5 || P.autopsies.length>=4) return;
    const hdr=scanHDR();
    const trials=[];
    const b=pf.bloom, ao=pf.ao, dof=pf.dof;
    const push=(label,setup,undo)=>{ setup(); orig(dt); trials.push([label,+read().mean.toFixed(1)]); undo(); };
    push('as-is', ()=>{}, ()=>{});
    push('bloom opacity 0', ()=>{b.blendMode.opacity.value=0;}, ()=>{b.blendMode.opacity.value=1;});
    push('bloom levels 1', ()=>{b.mipmapBlurPass.levels=1;}, ()=>{b.mipmapBlurPass.levels=6;});
    push('bloom intensity 0', ()=>{b.intensity=0;}, ()=>{b.intensity=0.38;});
    if(dof) push('dof opacity 0', ()=>{dof.blendMode.opacity.value=0;}, ()=>{dof.blendMode.opacity.value=1;});
    if(ao) push('ao off', ()=>{ao.enabled=false;}, ()=>{ao.enabled=true;});
    push('after all undone', ()=>{}, ()=>{});
    P.autopsies.push({t:+(performance.now()-P.started).toFixed(0), hdr, trials,
      cam:[+e.camera.position.x.toFixed(0),+e.camera.position.y.toFixed(0),+e.camera.position.z.toFixed(0)]});
  };
  const input=ctx.input; window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;return {n:P.n,a:P.autopsies};});
await browser.close();
console.log(`${d.a.length} black frames autopsied out of ${d.n} presented`);
for(const a of d.a){
  console.log(`\nt=${a.t}ms cam ${a.cam.join(',')}   scene HDR ${a.hdr.w}x${a.hdr.h}: ${a.hdr.bad} non-finite samples, max ${a.hdr.max}${a.hdr.err?'  '+a.hdr.err:''}`);
  console.log('   mean screen brightness (0-255) with one thing changed:');
  for(const [k,v] of a.trials) console.log(`     ${k.padEnd(22)} ${v}`);
}
