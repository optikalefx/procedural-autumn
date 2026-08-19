// What actually happened on the frames that hitched?
//
// Frame time on this machine is vsync-quantised and shared with four other
// authors' captures, so "this frame took 300 ms" needs a cause attached to it
// before it means anything. This records, per frame: shader compiles and
// program links (with their wall cost), bytes uploaded, geometries created and
// disposed with the source site that made them, and then prints the worst
// frames with that ledger attached.
//
//   node tools/_scratch/hitchwhy.mjs --seconds 45 --res 1536
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','45')), RES=arg('res','1536'), QUALITY=arg('quality',null);
await acquire('hitchwhy');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,160)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
const q=new URLSearchParams({res:RES}); if(QUALITY)q.set('quality',QUALITY);
await page.goto(`http://localhost:5178/?${q}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
await page.evaluate(()=>{
  const THREE=window.__THREE, e=window.__engine, ctx=window.__ctx, r=e.renderer, gl=r.getContext();
  const P=window.__perf={started:performance.now(),frames:[],created:{},disposed:{},progs:[]};
  let F={link:0,linkMs:0,compile:0,compileMs:0,bytes:0,made:{},disp:0};
  const site=()=>{ const st=(new Error()).stack.split('\n').slice(2,10)
      .map(s=>s.trim().replace(/^at\s+/,'')).filter(s=>s.includes('/src/'))
      .map(s=>s.replace(/.*\/src\//,'src/').replace(/\?[^:]*/,'').replace(/:\d+\)?$/,''));
    return st.slice(0,3).join(' < ')||'unknown'; };
  const bump=(m,k,n=1)=>{m[k]=(m[k]||0)+n;};
  // geometry lifetime, attributed to the code that built it
  const oSet=THREE.BufferGeometry.prototype.setAttribute;
  THREE.BufferGeometry.prototype.setAttribute=function(...a){
    if(!this.__site){ this.__site=site(); bump(P.created,this.__site); bump(F.made,this.__site); }
    return oSet.apply(this,a); };
  const oDisp=THREE.BufferGeometry.prototype.dispose;
  THREE.BufferGeometry.prototype.dispose=function(){ bump(P.disposed,this.__site||'unknown'); F.disp++; return oDisp.apply(this); };
  // shader work
  const oLink=gl.linkProgram.bind(gl);
  gl.linkProgram=function(p){ const t=performance.now(); const o=oLink(p); const d=performance.now()-t;
    F.link++; F.linkMs+=d; P.progs.push({t:+(performance.now()-P.started).toFixed(0),ms:+d.toFixed(1)}); return o; };
  const oComp=gl.compileShader.bind(gl);
  gl.compileShader=function(s){ const t=performance.now(); const o=oComp(s); F.compile++; F.compileMs+=performance.now()-t; return o; };
  // the call that actually blocks on a link finishing
  const oGetProg=gl.getProgramParameter.bind(gl);
  gl.getProgramParameter=function(p,n){ const t=performance.now(); const o=oGetProg(p,n); F.linkMs+=performance.now()-t; return o; };
  for(const fn of ['bufferData','bufferSubData','texImage2D','texSubImage2D','texImage3D','compressedTexImage2D']){
    if(typeof gl[fn]!=='function') continue; const g=gl[fn].bind(gl);
    gl[fn]=function(...a){ for(const x of a) if(x&&x.byteLength) F.bytes+=x.byteLength; return g(...a); }; }
  let last=performance.now();
  e.onLateUpdate(()=>{ const now=performance.now();
    P.frames.push({t:now-P.started, ms:now-last, geo:r.info.memory.geometries, tex:r.info.memory.textures,
      prog:r.info.programs?.length??0, calls:r.info.render.calls, ...F});
    last=now; F={link:0,linkMs:0,compile:0,compileMs:0,bytes:0,made:{},disp:0}; });
  const input=ctx.input; window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{ const P=window.__perf; window.__perfDrive=false;
  const f=P.frames.slice(20);
  const keys=new Set([...Object.keys(P.created),...Object.keys(P.disposed)]);
  return { frames:f.length, first:f[0], last:f[f.length-1], progs:P.progs,
    rows:[...keys].map(k=>({site:k,made:P.created[k]||0,disp:P.disposed[k]||0,leak:(P.created[k]||0)-(P.disposed[k]||0)}))
        .sort((a,b)=>b.leak-a.leak).slice(0,14),
    worst:[...f].sort((a,b)=>b.ms-a.ms).slice(0,12).map(x=>({t:+(x.t/1000).toFixed(1),ms:+x.ms.toFixed(0),
      link:x.link,linkMs:+x.linkMs.toFixed(0),compile:x.compile,compileMs:+x.compileMs.toFixed(0),
      kb:+(x.bytes/1024).toFixed(0),made:Object.entries(x.made).map(([k,v])=>`${v}x ${k.split(' < ')[0]}`).join(', '),disp:x.disp})) };
});
await browser.close();
console.log(`frames ${d.frames}`);
console.log(`geometries ${d.first.geo} -> ${d.last.geo}   textures ${d.first.tex} -> ${d.last.tex}   programs ${d.first.prog} -> ${d.last.prog}`);
console.log(`\nprogram links during the run (t ms after start, link cost):`);
for(const p of d.progs) console.log(`   ${String(p.t).padStart(7)} ms   ${p.ms} ms`);
console.log('\ngeometries created / disposed, by the code that built them:');
console.log('  leak   made   disp   site');
for(const r of d.rows) console.log(`  ${String(r.leak).padStart(5)}  ${String(r.made).padStart(5)}  ${String(r.disp).padStart(5)}   ${r.site}`);
console.log('\nworst frames:');
for(const w of d.worst) console.log(`  ${String(w.t).padStart(6)}s ${String(w.ms).padStart(5)}ms  links ${w.link}(${w.linkMs}ms) compiles ${w.compile}(${w.compileMs}ms)  upload ${w.kb}kB  geoDisp ${w.disp}  built: ${w.made||'-'}`);
