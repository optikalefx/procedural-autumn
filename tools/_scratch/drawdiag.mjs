// Draw calls & triangles per subtree per frame, via onBeforeRender hooks.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','20')), RES=arg('res','768'), QUALITY=arg('quality',null);
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
const p=new URLSearchParams({res:RES}); if(QUALITY)p.set('quality',QUALITY);
await page.goto(`http://localhost:5178/?${p}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(1000);
await page.evaluate(()=>{
  const e=window.__engine, ctx=window.__ctx, r=e.renderer;
  const P=window.__perf={acc:{},tri:{},frames:0,started:performance.now(),maxCalls:0};
  const rootOf=(o)=>{let p=o;while(p.parent&&p.parent!==e.scene)p=p.parent;return p.name||p.type;};
  const hook=()=>{ e.scene.traverse(o=>{ if(!(o.isMesh||o.isPoints||o.isLine||o.isSprite))return; if(o.__hooked)return; o.__hooked=true;
    const k=rootOf(o); o.onBeforeRender=function(){ P.acc[k]=(P.acc[k]||0)+1;
      const g=this.geometry; let t=0; if(g){ const idx=g.index?g.index.count:(g.attributes.position?g.attributes.position.count:0);
        t=idx/3*(this.isInstancedMesh?this.count:(g.instanceCount!==undefined&&g.instanceCount!==Infinity?g.instanceCount:1)); }
      P.tri[k]=(P.tri[k]||0)+t; }; }); };
  hook(); setInterval(hook,1000);
  e.onLateUpdate(()=>{P.frames++;P.maxCalls=Math.max(P.maxCalls,r.info.render.calls);});
  const input=ctx.input;window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;
  return {frames:P.frames,maxCalls:P.maxCalls,
    rows:Object.entries(P.acc).map(([k,v])=>[k,+(v/P.frames).toFixed(1),+((P.tri[k]||0)/P.frames/1000).toFixed(0)]).sort((a,b)=>b[1]-a[1])};});
await browser.close();
console.log(`frames ${d.frames}  peak renderer calls ${d.maxCalls}`);
console.log('subtree            draws/frame   ktris/frame');
let tc=0,tt=0; for(const [k,v,t] of d.rows){ tc+=v; tt+=t; console.log(`  ${k.padEnd(22)} ${String(v).padStart(7)} ${String(t).padStart(10)}`); }
console.log(`  ${'TOTAL(main pass)'.padEnd(22)} ${tc.toFixed(1).padStart(7)} ${tt.toFixed(0).padStart(10)}`);
