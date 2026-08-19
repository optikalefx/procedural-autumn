// Breaks postfx.render down per composer pass, tracks program compiles and
// texture/geometry churn per frame.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','30')), RES=arg('res','768'), QUALITY=arg('quality',null);
await acquire('perf');
const browser = await chromium.launch({ args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport:{width:1600,height:900}, deviceScaleFactor:1 });
page.on('pageerror', e=>console.log('PAGEERROR', String(e.message).slice(0,200)));
const params=new URLSearchParams({res:RES}); if(QUALITY)params.set('quality',QUALITY);
await page.goto(`http://localhost:5178/?${params}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(1500);
await page.evaluate(()=>{
  const e=window.__engine, ctx=window.__ctx, r=e.renderer;
  const P=window.__perf={frames:[],started:performance.now()};
  const cur={};
  const wrap=(obj,name,label)=>{ if(!obj||typeof obj[name]!=='function')return; const o=obj[name].bind(obj);
    obj[name]=function(...a){const t=performance.now();const out=o(...a);cur[label]=(cur[label]||0)+(performance.now()-t);return out;};};
  const comp=ctx.postfx.composer;
  comp.passes.forEach((p,i)=>wrap(p,'render',`${i}:${p.name||p.constructor.name}`));
  // shadow map
  wrap(r.shadowMap,'render','shadowmap');
  // program compile
  const pr=r.properties; // no-op
  let lastProg=r.info.programs.length;
  let last=performance.now();
  e.onLateUpdate(()=>{
    const now=performance.now();
    const rec={t:now-P.started,ms:now-last,calls:r.info.render.calls,prog:r.info.programs.length,geo:r.info.memory.geometries,tex:r.info.memory.textures,s:{}};
    for(const k in cur){ if(cur[k]>0.5) rec.s[k]=+cur[k].toFixed(1); cur[k]=0; }
    P.frames.push(rec); last=now;
  });
  const input=ctx.input; window.__perfDrive=true;
  const tick=()=>{ if(!window.__perfDrive)return; const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1; input.axes.brake=0; input.axes.steer=Math.sin(t*0.42)*0.75; input.axes.handbrake=0; requestAnimationFrame(tick);};
  tick();
});
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{
  const P=window.__perf; window.__perfDrive=false; const f=P.frames.slice(30);
  const ms=f.map(x=>x.ms).sort((a,b)=>a-b); const pct=p=>ms[Math.floor(p*ms.length)];
  const agg={}; for(const x of f) for(const k in x.s) agg[k]=(agg[k]||0)+x.s[k];
  const tot=f.reduce((a,b)=>a+b.ms,0);
  return {n:f.length,p50:+pct(.5).toFixed(2),p95:+pct(.95).toFixed(2),p99:+pct(.99).toFixed(2),
    h50:f.filter(x=>x.ms>50).length,h100:f.filter(x=>x.ms>100).length,
    agg:Object.entries(agg).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k,+(v/f.length).toFixed(2),+(100*v/tot).toFixed(1)]),
    progStart:f[0].prog, progEnd:f[f.length-1].prog,
    worst:[...f].sort((a,b)=>b.ms-a.ms).slice(0,12).map(x=>({t:+(x.t/1000).toFixed(1),ms:+x.ms.toFixed(1),c:x.calls,prog:x.prog,geo:x.geo,tex:x.tex,s:x.s})),
    // program growth events
    progJumps: f.map((x,i)=>i>0&&x.prog!==f[i-1].prog?{t:+(x.t/1000).toFixed(1),from:f[i-1].prog,to:x.prog,ms:+x.ms.toFixed(1)}:null).filter(Boolean),
    texJumps: f.map((x,i)=>i>0&&x.tex!==f[i-1].tex?{t:+(x.t/1000).toFixed(1),from:f[i-1].tex,to:x.tex,ms:+x.ms.toFixed(1)}:null).filter(Boolean).slice(0,20),
  };
});
await browser.close();
console.log(`p50 ${d.p50} p95 ${d.p95} p99 ${d.p99}  >50 ${d.h50} >100 ${d.h100} (${d.n})  prog ${d.progStart}->${d.progEnd}`);
console.log('\nper-pass mean ms/frame:'); for(const [k,v,p] of d.agg) console.log(`  ${k.padEnd(28)} ${String(v).padStart(7)}  ${p}%`);
console.log('\nprogram compiles:', JSON.stringify(d.progJumps));
console.log('texture jumps:', JSON.stringify(d.texJumps));
console.log('\nworst frames:'); for(const w of d.worst) console.log(`  ${String(w.t).padStart(6)}s ${String(w.ms).padStart(7)}ms c=${w.c} prog=${w.prog} geo=${w.geo} tex=${w.tex} ${JSON.stringify(w.s)}`);
