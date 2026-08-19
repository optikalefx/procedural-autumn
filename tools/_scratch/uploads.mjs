// Which buffer attributes get re-uploaded, how big they are, and on which frames.
//
// `attribute.needsUpdate = true` re-uploads the WHOLE buffer unless an update
// range is set, so a system that fills 300 of a 1500-instance cap still pays
// for 1500. This tags every attribute in the scene with the object that owns it
// and records each version bump with the attribute's byte size.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','30')), RES=arg('res','1536'), QUALITY=arg('quality',null);
await acquire('uploads');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,160)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
const q=new URLSearchParams({res:RES}); if(QUALITY)q.set('quality',QUALITY);
await page.goto(`http://localhost:5178/?${q}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
await page.waitForTimeout(1500);
await page.evaluate(()=>{
  const e=window.__engine, ctx=window.__ctx, r=e.renderer;
  const P=window.__perf={started:performance.now(),bytes:{},hits:{},frames:[],ranged:{}};
  let F=0, FB={};
  const rootOf=(o)=>{let p=o;while(p.parent&&p.parent!==e.scene)p=p.parent;return p.name||p.type;};
  const tag=(attr,label)=>{
    if(!attr||attr.__tagged) return; attr.__tagged=true;
    const bytes=attr.array.byteLength;
    let v=attr.version;
    Object.defineProperty(attr,'version',{ configurable:true,
      get(){return v;},
      set(nv){ if(nv>v){ const ranged=attr.updateRanges&&attr.updateRanges.length>0;
          let b=bytes;
          if(ranged){ b=0; for(const rg of attr.updateRanges) b+=rg.count*attr.array.BYTES_PER_ELEMENT; }
          P.bytes[label]=(P.bytes[label]||0)+b; P.hits[label]=(P.hits[label]||0)+1;
          if(ranged) P.ranged[label]=1;
          FB[label]=(FB[label]||0)+b; } v=nv; } });
  };
  const sweep=()=>{ e.scene.traverse(o=>{ const g=o.geometry; if(!g)return; const root=rootOf(o);
    for(const k in g.attributes) tag(g.attributes[k], `${root}.${k}`);
    if(g.index) tag(g.index, `${root}.index`);
    if(o.isInstancedMesh){ tag(o.instanceMatrix, `${root}.instanceMatrix`); if(o.instanceColor) tag(o.instanceColor,`${root}.instanceColor`); } }); };
  sweep(); setInterval(sweep, 800);
  let last=performance.now();
  e.onLateUpdate(()=>{ const now=performance.now(); F++;
    P.frames.push({t:now-P.started, ms:now-last, kb:Object.values(FB).reduce((a,b)=>a+b,0)/1024,
      top:Object.entries(FB).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([k,v])=>`${k} ${(v/1024).toFixed(0)}kB`)});
    last=now; FB={}; });
  const input=ctx.input;window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;
  const f=P.frames.slice(20);
  return {frames:f.length, secs:(f[f.length-1].t-f[0].t)/1000,
    rows:Object.entries(P.bytes).map(([k,v])=>[k,v/1024/1024,P.hits[k],!!P.ranged[k]]).sort((a,b)=>b[1]-a[1]).slice(0,20),
    worst:[...f].sort((a,b)=>b.ms-a.ms).slice(0,10).map(x=>({t:+(x.t/1000).toFixed(1),ms:+x.ms.toFixed(0),kb:+x.kb.toFixed(0),top:x.top})),
    heaviest:[...f].sort((a,b)=>b.kb-a.kb).slice(0,8).map(x=>({t:+(x.t/1000).toFixed(1),ms:+x.ms.toFixed(0),kb:+x.kb.toFixed(0),top:x.top}))};});
await browser.close();
console.log(`frames ${d.frames} over ${d.secs.toFixed(1)}s\n`);
console.log('attribute                                  total MB   uploads   ranged');
for(const [k,mb,n,rg] of d.rows) console.log(`  ${k.padEnd(40)} ${mb.toFixed(1).padStart(8)} ${String(n).padStart(9)}   ${rg?'yes':'no'}`);
console.log('\nheaviest upload frames:');
for(const x of d.heaviest) console.log(`  ${String(x.t).padStart(6)}s ${String(x.ms).padStart(5)}ms  ${String(x.kb).padStart(6)} kB   ${x.top.join('  ')}`);
console.log('\nslowest frames:');
for(const x of d.worst) console.log(`  ${String(x.t).padStart(6)}s ${String(x.ms).padStart(5)}ms  ${String(x.kb).padStart(6)} kB   ${x.top.join('  ')}`);
