// Which GL entry points are called how often per frame, and how much data goes
// through the matrix uploads. uniformMatrix4fv dominated the CPU profile; this
// says whether that is call count or payload size.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','15')), RES=arg('res','1536');
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(1200);
await page.evaluate(()=>{
  const e=window.__engine,r=e.renderer,gl=r.getContext();
  const C={}, EL={};
  const names=['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced','uniformMatrix4fv','uniformMatrix3fv','uniform3f','uniform1f','uniform4fv','uniform3fv','uniform1i','bindVertexArray','useProgram','bindTexture','bufferSubData','texSubImage2D','bindBuffer','vertexAttribPointer','bindFramebuffer','viewport','activeTexture','depthMask','uniform2f'];
  for(const n of names){ if(typeof gl[n]!=='function')continue; const f=gl[n].bind(gl);
    gl[n]=function(...a){ C[n]=(C[n]||0)+1;
      if(n==='uniformMatrix4fv'||n==='uniformMatrix3fv'){ const v=a[2]; EL[n]=(EL[n]||0)+((v&&v.length)||0); }
      return f(...a); }; }
  const P=window.__perf={C,EL,frames:0,started:performance.now()};
  e.onLateUpdate(()=>{P.frames++;});
  const input=window.__ctx.input;window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;
  return {frames:P.frames, rows:Object.entries(P.C).map(([k,v])=>[k,+(v/P.frames).toFixed(1)]).sort((a,b)=>b[1]-a[1]),
    el:Object.entries(P.EL).map(([k,v])=>[k,+(v/P.frames).toFixed(0)])};});
await browser.close();
console.log(`frames ${d.frames}`);
console.log('gl call                     per frame');
for(const [k,v] of d.rows) console.log(`  ${k.padEnd(26)} ${String(v).padStart(9)}`);
console.log('\nmatrix floats uploaded per frame:'); for(const [k,v] of d.el) console.log(`  ${k.padEnd(26)} ${String(v).padStart(9)} floats`);
