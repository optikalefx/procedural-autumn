// Paired same-frame proof. On every frame that carries a non-finite pixel:
//   1. re-render unchanged            -> confirms it is not a transient
//   2. repair the zero-length normals -> re-render -> read
//   3. restore the original normals   -> re-render -> read
// All three happen on the same frame with the same camera, the same world
// streaming state and the same vehicle pose, so nothing but the normals differs.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const PORT=arg('port','5178'), SECONDS=parseFloat(arg('seconds','120'));
await acquire('nanhunt');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.routeWebSocket(new RegExp(`^wss?://(localhost|127\\.0\\.0\\.1):${PORT}/`),()=>{});
await page.goto(`http://127.0.0.1:${PORT}/?res=768`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
await page.waitForTimeout(1500);
const out=await page.evaluate(async (SECONDS)=>{
  const e=window.__engine, ctx=window.__ctx, r=e.renderer, pf=ctx.postfx;
  const S=window.__systems??ctx.systems??{};
  const rig=S.vehicle?.group ?? e.scene.getObjectByName('vehicleRig');
  const meshes=[]; rig.traverse(o=>{ if(o.isMesh||o.isInstancedMesh) meshes.push(o); });
  const saved=meshes.map(m=>Float32Array.from(m.geometry.getAttribute('normal').array));
  let zeroCount=0;
  for(const s of saved) for(let v=0;v<s.length;v+=3) if(s[v]===0&&s[v+1]===0&&s[v+2]===0) zeroCount++;
  const setRepaired=(on)=>{ meshes.forEach((m,i)=>{ const a=m.geometry.getAttribute('normal');
    if(!on){ a.array.set(saved[i]); } else { const arr=a.array, s=saved[i];
      for(let v=0;v<arr.length;v+=3){ if(s[v]===0&&s[v+1]===0&&s[v+2]===0){arr[v]=0;arr[v+1]=1;arr[v+2]=0;}
        else {arr[v]=s[v];arr[v+1]=s[v+1];arr[v+2]=s[v+2];} } }
    a.needsUpdate=true; }); };
  let buf=null,bw=0,bh=0;
  const read=()=>{const t=pf.composer.inputBuffer;
    if(t.width!==bw||t.height!==bh){bw=t.width;bh=t.height;buf=new Uint16Array(bw*bh*4);}
    r.readRenderTargetPixels(t,0,0,bw,bh,buf);
    let bad=0,fx=-1,fy=-1; for(let i=0;i<buf.length;i++) if(((buf[i]>>10)&0x1f)===0x1f){bad++;
      if(fx<0){const p=i>>2;fx=p%bw;fy=(p/bw)|0;}} return {bad,fx,fy};};
  const input=ctx.input; const t0=performance.now(); window.__d=true;
  const tick=()=>{if(!window.__d)return;const t=(performance.now()-t0)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
  const pairs=[]; let n=0,hits=0;
  await new Promise((resolve)=>{
    const step=()=>{ n++; const a=read();
      if(a.bad){ hits++;
        pf.render(0.016); const same=read();
        setRepaired(true);  pf.render(0.016); const fixed=read();
        setRepaired(false); pf.render(0.016); const back=read();
        if(pairs.length<40) pairs.push({t:+((performance.now()-t0)/1000).toFixed(1),
          at:[a.fx,a.fy], first:a.bad, rerender:same.bad, repaired:fixed.bad, restored:back.bad});
      }
      if((performance.now()-t0)/1000>=SECONDS){resolve();return;}
      requestAnimationFrame(step); }; step();
  });
  window.__d=false;
  return {n,hits,pairs,zeroCount,rt:[bw,bh]};
},SECONDS);
console.log(`\nHDR buffer ${out.rt.join('x')}   zero-length vertex normals in the rig: ${out.zeroCount}`);
console.log(`frames sampled ${out.n}, frames with a non-finite pixel ${out.hits} (${(100*out.hits/out.n).toFixed(2)}%)\n`);
console.log('   t(s)      at        original  re-render  normals-repaired  normals-restored');
for(const p of out.pairs)
  console.log(`  ${String(p.t).padStart(6)}  ${String(p.at.join(',')).padStart(9)}  ${String(p.first).padStart(8)}  ${String(p.rerender).padStart(9)}  ${String(p.repaired).padStart(16)}  ${String(p.restored).padStart(16)}`);
const nz=out.pairs.filter(p=>p.rerender>0);
console.log(`\npaired trials where the frame reproduced: ${nz.length}`);
console.log(`  still non-finite with normals repaired: ${nz.filter(p=>p.repaired>0).length}`);
console.log(`  still non-finite with normals restored: ${nz.filter(p=>p.restored>0).length}`);
await browser.close();
