// Prove the cause: repair the zero-length vertex normals on the camper at
// runtime and see whether the non-finite pixels stop. Three arms in one page
// load so machine load hits them equally.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const PORT=arg('port','5178'), SECONDS=parseFloat(arg('seconds','60'));
await acquire('nanhunt');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.routeWebSocket(new RegExp(`^wss?://(localhost|127\\.0\\.0\\.1):${PORT}/`),()=>{});
await page.goto(`http://127.0.0.1:${PORT}/?res=768`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
await page.waitForTimeout(1500);

await page.evaluate(()=>{
  const e=window.__engine, ctx=window.__ctx, r=e.renderer, pf=ctx.postfx;
  const S=window.__systems??ctx.systems??{};
  const rig=S.vehicle?.group ?? e.scene.getObjectByName('vehicleRig');
  window.__rigMeshes=[]; rig.traverse(o=>{ if(o.isMesh||o.isInstancedMesh) window.__rigMeshes.push(o); });
  // Keep a pristine copy of every normal array so arms can be toggled.
  window.__savedNor=window.__rigMeshes.map(m=>Float32Array.from(m.geometry.getAttribute('normal').array));
  window.__repair=(on)=>{
    window.__rigMeshes.forEach((m,i)=>{
      const a=m.geometry.getAttribute('normal');
      if(!on){ a.array.set(window.__savedNor[i]); a.needsUpdate=true; return; }
      const arr=a.array; let fixed=0;
      for(let v=0;v<a.count;v++){ const x=arr[v*3],y=arr[v*3+1],z=arr[v*3+2];
        if(x*x+y*y+z*z===0){ arr[v*3]=0; arr[v*3+1]=1; arr[v*3+2]=0; fixed++; } }
      a.needsUpdate=true; window.__fixedTotal=(window.__fixedTotal||0)+fixed;
    });
  };
  let buf=null,bw=0,bh=0;
  window.__read=()=>{const t=pf.composer.inputBuffer;
    if(t.width!==bw||t.height!==bh){bw=t.width;bh=t.height;buf=new Uint16Array(bw*bh*4);}
    r.readRenderTargetPixels(t,0,0,bw,bh,buf);
    let bad=0,fx=-1,fy=-1; for(let i=0;i<buf.length;i++) if(((buf[i]>>10)&0x1f)===0x1f){bad++;
      if(fx<0){const p=i>>2;fx=p%bw;fy=(p/bw)|0;}} return {bad,fx,fy};};
  const input=ctx.input; const t0=performance.now(); window.__d=true;
  const tick=()=>{if(!window.__d)return;const t=(performance.now()-t0)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});

const runArm=async (label,setup,seconds)=>{
  await page.evaluate((s)=>eval(s)(),setup);
  const r=await page.evaluate((sec)=>new Promise((res)=>{
    let n=0,hits=0,worst=0,first=null; const t0=performance.now();
    const step=()=>{ const a=window.__read(); n++;
      if(a.bad){hits++; if(a.bad>worst)worst=a.bad; if(!first)first=[a.fx,a.fy];}
      if((performance.now()-t0)/1000>=sec){res({n,hits,worst,first});return;}
      requestAnimationFrame(step); }; step();
  }),seconds);
  console.log(`${label.padEnd(34)} ${String(r.hits).padStart(5)} / ${String(r.n).padStart(5)} frames carried a non-finite pixel  (${(100*r.hits/Math.max(1,r.n)).toFixed(2)}%)  worst=${r.worst}${r.first?'  first at '+r.first.join(','):''}`);
  return r;
};

console.log(`\nnormfix — driving on port ${PORT}, ${SECONDS}s per arm\n`);
await runArm('baseline (as shipped)','()=>{window.__repair(false);}',SECONDS);
await runArm('zero normals repaired','()=>{window.__repair(true);}',SECONDS);
await runArm('back to baseline','()=>{window.__repair(false);}',SECONDS);
await runArm('repaired again','()=>{window.__repair(true);}',SECONDS);
console.log('\nvertices repaired per pass:', await page.evaluate(()=>window.__fixedTotal));
await page.evaluate(()=>{window.__d=false;});
await browser.close();
