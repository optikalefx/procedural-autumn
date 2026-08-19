// Second-stage bisection: the NaN is drawn by the vehicle rig. Which mesh, and
// which material property?
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const PORT=arg('port','5178'), SECONDS=parseFloat(arg('seconds','90'));
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
  let buf=null,bw=0,bh=0;
  const read=()=>{const t=pf.composer.inputBuffer;
    if(t.width!==bw||t.height!==bh){bw=t.width;bh=t.height;buf=new Uint16Array(bw*bh*4);}
    r.readRenderTargetPixels(t,0,0,bw,bh,buf);
    let bad=0; for(let i=0;i<buf.length;i++) if(((buf[i]>>10)&0x1f)===0x1f) bad++; return bad;};
  const input=ctx.input; const t0=performance.now();
  window.__d=true; const tick=()=>{if(!window.__d)return;const t=(performance.now()-t0)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
  const inventory=meshes.map((m,i)=>({i,name:m.name||'(unnamed)',
    mat:(Array.isArray(m.material)?m.material:[m.material]).map(x=>({type:x.type,
      metalness:x.metalness,roughness:x.roughness,transmission:x.transmission,
      clearcoat:x.clearcoat,ior:x.ior,name:x.name,flat:x.flatShading,
      sheen:x.sheen,iridescence:x.iridescence,specularIntensity:x.specularIntensity}))}));
  const events=[]; let n=0,hits=0;
  await new Promise((resolve)=>{
    const step=()=>{
      n++; const bad=read();
      if(bad){ hits++;
        pf.render(0.016); const again=read();
        if(again && events.length<4){
          const trials=[];
          for(const m of meshes){ const was=m.visible; m.visible=false; pf.render(0.016);
            const v=read(); m.visible=was; if(!v) trials.push(m.name||'(unnamed)'); }
          pf.render(0.016);
          // material-property probes on the culprit meshes
          const props=[];
          for(const nm of trials){ const m=meshes.find(x=>(x.name||'(unnamed)')===nm); if(!m)continue;
            const mats=Array.isArray(m.material)?m.material:[m.material];
            props.push({mesh:nm, mats:mats.map(x=>({type:x.type,metalness:x.metalness,roughness:x.roughness,
              transmission:x.transmission,clearcoat:x.clearcoat,ior:x.ior,envMapIntensity:x.envMapIntensity,
              flatShading:x.flatShading,side:x.side,name:x.name}))});
          }
          events.push({bad,culprits:trials,props});
        }
      }
      if((performance.now()-t0)/1000>=SECONDS){resolve();return;}
      requestAnimationFrame(step);
    }; step();
  });
  window.__d=false;
  return {n,hits,events,inventory,meshCount:meshes.length};
},SECONDS);
console.log(`meshes in rig: ${out.meshCount}   frames ${out.n}  hits ${out.hits}`);
for(const ev of out.events){
  console.log(`\nbad=${ev.bad}  meshes whose removal clears it: ${JSON.stringify(ev.culprits)}`);
  for(const p of ev.props) console.log('   ', JSON.stringify(p));
}
console.log('\ninventory:');
for(const m of out.inventory) console.log('   ', JSON.stringify(m));
await browser.close();
