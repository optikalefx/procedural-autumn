// Who creates BufferGeometries at runtime, and who fails to dispose them.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','30')), RES=arg('res','768');
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(1000);
await page.evaluate(()=>{
  const T=window.__THREE, e=window.__engine, ctx=window.__ctx;
  const created={}, disposed={}, perFrame={};
  const site=()=>{ const st=(new Error()).stack.split('\n').slice(2,9)
      .map(s=>s.trim().replace(/^at\s+/,'')).filter(s=>s.includes('/src/'))
      .map(s=>s.replace(/.*\/src\//,'src/').replace(/\?[^:]*/,'').replace(/:\d+\)?$/,''));
    return st.slice(0,3).join(' < ') || 'unknown'; };
  const bump=(m,k,n=1)=>{m[k]=(m[k]||0)+n;};
  const origSet=T.BufferGeometry.prototype.setAttribute;
  T.BufferGeometry.prototype.setAttribute=function(...a){ if(!this.__site){ this.__site=site(); bump(created,this.__site); bump(perFrame,this.__site);} return origSet.apply(this,a); };
  const origDisp=T.BufferGeometry.prototype.dispose;
  T.BufferGeometry.prototype.dispose=function(){ bump(disposed,this.__site||'unknown'); return origDisp.apply(this); };
  const P=window.__perf={created,disposed,frames:[],started:performance.now()};
  const r=e.renderer; let last=performance.now();
  e.onLateUpdate(()=>{ const now=performance.now();
    const made={}; for(const k in perFrame){made[k]=perFrame[k];delete perFrame[k];}
    P.frames.push({t:now-P.started,ms:now-last,geo:r.info.memory.geometries,made}); last=now;});
  const input=ctx.input; window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};
  tick();
});
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{ const P=window.__perf; window.__perfDrive=false;
  const f=P.frames.slice(20);
  const keys=new Set([...Object.keys(P.created),...Object.keys(P.disposed)]);
  const rows=[...keys].map(k=>({site:k,made:P.created[k]||0,disp:P.disposed[k]||0,leak:(P.created[k]||0)-(P.disposed[k]||0)})).sort((a,b)=>b.leak-a.leak);
  return {rows, geoStart:f[0].geo, geoEnd:f[f.length-1].geo,
    worst:[...f].sort((a,b)=>b.ms-a.ms).slice(0,10).map(x=>({t:+(x.t/1000).toFixed(1),ms:+x.ms.toFixed(1),geo:x.geo,made:x.made}))};
});
await browser.close();
console.log(`geo ${d.geoStart} -> ${d.geoEnd}`);
console.log('\ncreated / disposed / leaked by site (runtime only):');
for(const r of d.rows) console.log(`  made ${String(r.made).padStart(5)}  disp ${String(r.disp).padStart(5)}  leak ${String(r.leak).padStart(5)}   ${r.site}`);
console.log('\nworst frames:'); for(const w of d.worst) console.log(`  ${String(w.t).padStart(6)}s ${String(w.ms).padStart(7)}ms geo=${w.geo} made=${JSON.stringify(w.made)}`);
