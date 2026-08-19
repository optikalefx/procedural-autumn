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
  const P=window.__perf={started:performance.now(),frames:[],created:{},disposed:{},progs:[],newProgs:[],compiled:[],lightChanges:[]};
  let F={link:0,linkMs:0,compile:0,compileMs:0,bytes:0,texBytes:0,texMs:0,texCalls:0,made:{},disp:0};
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
  // three detaches shaders after linking, so the source has to be captured as
  // it goes in rather than read back off the program afterwards.
  const shaderSrc=new WeakMap(), progShaders=new WeakMap();
  const oSrc=gl.shaderSource.bind(gl);
  gl.shaderSource=function(sh,src){ shaderSrc.set(sh,src); return oSrc(sh,src); };
  const oAttach=gl.attachShader.bind(gl);
  gl.attachShader=function(pr,sh){ const l=progShaders.get(pr)||[]; l.push(sh); progShaders.set(pr,l); return oAttach(pr,sh); };
  const oLink=gl.linkProgram.bind(gl);
  gl.linkProgram=function(p){ const t=performance.now(); const o=oLink(p); const d=performance.now()-t;
    // three stamps `#define SHADER_NAME <material type or name>` into every
    // program, which is the only way to say WHICH material linked late.
    let name='?';
    for(const sh of (progShaders.get(p)||[])){
      const src=shaderSrc.get(sh)||'';
      const m=src.match(/#define SHADER_NAME ([^\n]+)/);
      if(m){ name=m[1].trim();
        const defs=[...src.matchAll(/^#define (USE_[A-Z0-9_]+|[A-Z0-9_]*SHADOW[A-Z0-9_]*|DEPTH_PACKING[^\n]*)/gm)].map(x=>x[1]);
        if(defs.length) name+=' ['+defs.slice(0,8).join(',')+']';
        break; } }
    F.link++; F.linkMs+=d; P.progs.push({t:+(performance.now()-P.started).toFixed(0),ms:+d.toFixed(1),name}); return o; };
  const oComp=gl.compileShader.bind(gl);
  gl.compileShader=function(s){ const t=performance.now(); const o=oComp(s); F.compile++; F.compileMs+=performance.now()-t; return o; };
  // the call that actually blocks on a link finishing
  const oGetProg=gl.getProgramParameter.bind(gl);
  gl.getProgramParameter=function(p,n){ const t=performance.now(); const o=oGetProg(p,n); F.linkMs+=performance.now()-t; return o; };
  for(const fn of ['bufferData','bufferSubData']){
    const g=gl[fn].bind(gl);
    gl[fn]=function(...a){ for(const x of a) if(x&&x.byteLength) F.bytes+=x.byteLength; return g(...a); }; }
  for(const fn of ['texImage2D','texSubImage2D','texImage3D','compressedTexImage2D','texStorage2D','generateMipmap']){
    if(typeof gl[fn]!=='function') continue; const g=gl[fn].bind(gl);
    gl[fn]=function(...a){ const t=performance.now();
      for(const x of a) if(x&&x.byteLength) F.texBytes+=x.byteLength;
      if(x0(a)) F.texBytes+=x0(a);
      const o=g(...a); F.texMs+=performance.now()-t; F.texCalls++; return o; }; }
  function x0(a){ // width*height*4 estimate when the source is an ImageBitmap/canvas
    const w=a.find((v)=>typeof v==='number'&&v>16); return 0*(w||0); }
  // Name the material that compiles late by tagging every material in the
  // scene with the object that carries it and recording the call.
  const rootOf=(o)=>{let q=o;while(q.parent&&q.parent!==e.scene)q=q.parent;return q.name||q.type;};
  const tagMats=()=>{ e.scene.traverse((o)=>{ const ms=o.material; if(!ms) return;
    for(const m of (Array.isArray(ms)?ms:[ms])){
      if(m.__tagged) continue; m.__tagged=true;
      const label=`${rootOf(o)} / ${o.name||o.type} / ${m.type}${m.name?':'+m.name:''}`;
      const prev=m.onBeforeCompile;
      m.onBeforeCompile=function(sh,rr){ P.compiled.push({t:+(performance.now()-P.started).toFixed(0),label,
        why:m.__lastDirty||'(not seen)'});
        return prev ? prev.call(this,sh,rr) : undefined; };
      // Who invalidated it? needsUpdate is a setter that bumps version; record
      // the call site so the recompile can be traced to the line that caused it.
      Object.defineProperty(m,'needsUpdate',{ configurable:true,
        set(v){ if(v===true){ m.version++;
          m.__lastDirty=((new Error()).stack||'').split('\n').slice(1,7)
            .map(x=>x.trim().replace(/^at\s+/,''))
            .filter(x=>x.includes('/src/')||x.includes('three'))
            .map(x=>x.replace(/.*\/src\//,'src/').replace(/\?[^:)]*/,'').replace(/.*deps\//,'three:'))
            .slice(0,3).join(' < ')||'(unknown)'; } },
        get(){ return false; } });
    }
    for(const k of ['customDepthMaterial','customDistanceMaterial']){
      const m=o[k]; if(!m||m.__tagged) continue; m.__tagged=true;
      const label=`${rootOf(o)} / ${o.name||o.type} / ${k}`;
      const prev=m.onBeforeCompile;
      m.onBeforeCompile=function(sh,rr){ P.compiled.push({t:+(performance.now()-P.started).toFixed(0),label});
        return prev ? prev.call(this,sh,rr) : undefined; };
    } }); };
  tagMats(); setInterval(tagMats, 500);
  // A change in the scene's light counts changes every material's program cache
  // key, so one light appearing or a shadow toggling rebuilds the whole scene.
  const lightSig=()=>{ let d=0,ds=0,sp=0,sps=0,pt=0,hemi=0;
    e.scene.traverse((o)=>{ if(!o.isLight||!o.visible) return;
      if(o.isDirectionalLight){ d++; if(o.castShadow) ds++; }
      else if(o.isSpotLight){ sp++; if(o.castShadow) sps++; }
      else if(o.isPointLight) pt++; else if(o.isHemisphereLight) hemi++; });
    return `dir ${d}/${ds}  spot ${sp}/${sps}  point ${pt}  hemi ${hemi}`; };
  P.lastSig=lightSig();
  // three keeps its own program list with the material name on it, which is a
  // far more reliable label than anything recoverable from the GL objects.
  const progNames=()=>(r.info.programs||[]).map((x)=>x.name+'|'+(x.cacheKey||''));
  let known=new Set(progNames());
  let last=performance.now();
  e.onLateUpdate(()=>{ const now=performance.now();
    const sig=lightSig();
    if(sig!==P.lastSig){ P.lightChanges.push({t:+(now-P.started).toFixed(0),from:P.lastSig,to:sig}); P.lastSig=sig; }
    const cur=progNames();
    if(cur.length!==known.size){ for(const n of cur) if(!known.has(n)){
      P.newProgs.push({t:+(now-P.started).toFixed(0), name:n}); known.add(n); } }
    P.frames.push({t:now-P.started, ms:now-last, geo:r.info.memory.geometries, tex:r.info.memory.textures,
      prog:r.info.programs?.length??0, calls:r.info.render.calls, ...F});
    last=now; F={link:0,linkMs:0,compile:0,compileMs:0,bytes:0,texBytes:0,texMs:0,texCalls:0,made:{},disp:0}; });
  const input=ctx.input; window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{ const P=window.__perf; window.__perfDrive=false;
  const f=P.frames.slice(20);
  const keys=new Set([...Object.keys(P.created),...Object.keys(P.disposed)]);
  return { frames:f.length, first:f[0], last:f[f.length-1], progs:P.progs,
    newProgs:P.newProgs, compiled:P.compiled, lightChanges:P.lightChanges, rows:[...keys].map(k=>({site:k,made:P.created[k]||0,disp:P.disposed[k]||0,leak:(P.created[k]||0)-(P.disposed[k]||0)}))
        .sort((a,b)=>b.leak-a.leak).slice(0,14),
    worst:[...f].sort((a,b)=>b.ms-a.ms).slice(0,12).map(row),
    early:P.frames.filter(x=>x.t<6000).sort((a,b)=>b.ms-a.ms).slice(0,12).map(row) };
  function row(x){ return {t:+(x.t/1000).toFixed(2),ms:+x.ms.toFixed(0),
      link:x.link,linkMs:+x.linkMs.toFixed(0),compile:x.compile,compileMs:+x.compileMs.toFixed(0),
      kb:+(x.bytes/1024).toFixed(0),tkb:+(x.texBytes/1024).toFixed(0),tms:+x.texMs.toFixed(0),tn:x.texCalls,
      made:Object.entries(x.made).map(([k,v])=>`${v}x ${k.split(' < ')[0]}`).join(', '),disp:x.disp}; }
});
await browser.close();
console.log(`frames ${d.frames}`);
console.log(`geometries ${d.first.geo} -> ${d.last.geo}   textures ${d.first.tex} -> ${d.last.tex}   programs ${d.first.prog} -> ${d.last.prog}`);
console.log(`\nprogram links during the run (t ms after start, link cost):`);
for(const p of d.progs) console.log(`   ${String(p.t).padStart(7)} ms   ${String(p.ms).padStart(6)} ms`);
console.log('\nchanges to the scene light counts (each one rebuilds every program):');
for(const c of d.lightChanges) console.log(`   ${String(c.t).padStart(7)} ms   ${c.from}   ->   ${c.to}`);
console.log('\nmaterials whose shader was (re)built after the game was ready:');
for(const c of d.compiled) console.log(`   ${String(c.t).padStart(7)} ms   ${c.label}\n                 invalidated by: ${c.why}`);
console.log('\nmaterials that compiled a NEW program after the game was ready:');
for(const p of d.newProgs) console.log(`   ${String(p.t).padStart(7)} ms   ${p.name.slice(0,260)}`);
console.log('\ngeometries created / disposed, by the code that built them:');
console.log('  leak   made   disp   site');
for(const r of d.rows) console.log(`  ${String(r.leak).padStart(5)}  ${String(r.made).padStart(5)}  ${String(r.disp).padStart(5)}   ${r.site}`);
const show=(w)=>console.log(`  ${String(w.t).padStart(7)}s ${String(w.ms).padStart(5)}ms  links ${w.link}(${w.linkMs}ms) compiles ${w.compile}(${w.compileMs}ms)  buf ${w.kb}kB  tex ${w.tkb}kB in ${w.tn} calls (${w.tms}ms)  geoDisp ${w.disp}  built: ${w.made||'-'}`);
console.log('\nworst frames:');
for(const w of d.worst) show(w);
console.log('\nworst frames in the first 6 s:');
for(const w of d.early) show(w);
