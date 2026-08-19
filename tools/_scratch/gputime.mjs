// True GPU time per render pass, via EXT_disjoint_timer_query_webgl2.
//
// Wall-clock frame time in this harness is useless for attributing cost: it is
// vsync-quantised (16.7 / 33.3 ms) and it collapses to ~2 ms the moment a
// variant stops presenting anything, so "removing X made the frame 15x faster"
// is usually "removing X stopped the picture reaching the screen". A timer
// query measures the GPU's own nanoseconds on a span of commands and does not
// care about either.
//
//   node tools/_scratch/gputime.mjs --views drive,forest --res 768
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d=null)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const RES=arg('res','768'), QUALITY=arg('quality',null);
const REPEATS=parseInt(arg('repeats','3'),10);
const VARIANTS=(arg('variants','base=()=>{}')).split('::').map(s=>{
  const i=s.indexOf('='); const rest=s.slice(i+1); const j=rest.lastIndexOf('|');
  return {label:s.slice(0,i), on:j===-1?rest:rest.slice(0,j), off:j===-1?'()=>{}':rest.slice(j+1)};});
const FRAMES=parseInt(arg('frames','120'),10);
const VIEWNAMES=(arg('views','drive,forest')).split(',');
// Inlined, not imported: importing tools/shot.mjs runs its main().
const VIEWS={
  hero:{anchor:'vista',height:62,dist:150,pitch:-0.16,fov:46,hour:16.7},
  drive:{anchor:'road',height:4.2,dist:12,pitch:-0.10,fov:55,hour:16.7,standOff:16},
  meadow:{anchor:'meadow',height:1.6,dist:6,pitch:-0.05,fov:58,hour:17.2},
  forest:{anchor:'forest',height:3.0,dist:14,pitch:0.02,fov:60,hour:16.4},
  river:{anchor:'river',height:5.2,dist:26,pitch:-0.16,fov:54,hour:16.9,yawOffset:0.42},
  waterfall:{anchor:'waterfall',height:11,dist:58,pitch:0.08,fov:50,hour:16.2,yawOffset:-0.55},
  peaks:{anchor:'peak',height:120,dist:420,pitch:-0.10,fov:42,hour:16.0},
  backlit:{anchor:'meadow',height:2.4,dist:10,pitch:0.04,fov:52,hour:17.9,faceSun:true},
  dawn:{anchor:'vista',height:48,dist:130,pitch:-0.13,fov:46,hour:7.4},
};
const frozen = existsSync('shots/_anchors.json') ? JSON.parse(readFileSync('shots/_anchors.json','utf8')) : {};
await acquire('gputime');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,160)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
const q=new URLSearchParams({res:RES}); if(QUALITY)q.set('quality',QUALITY);
await page.goto(`http://localhost:5178/?${q}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
await page.evaluate(()=>{
  const e=window.__engine, r=e.renderer, gl=r.getContext();
  const ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if(!ext){ window.__gpu={err:'no timer query'}; return; }
  const G=window.__gpu={acc:{},n:{},pending:[],free:[],frames:0};
  const getQ=()=>G.free.pop()||gl.createQuery();
  // One TIME_ELAPSED query may be active at a time, so every span here is
  // strictly sequential: pass i ends before pass i+1 begins.
  let active=false;
  const span=(label,fn)=>{ if(active) return fn();
    const qy=getQ(); gl.beginQuery(ext.TIME_ELAPSED_EXT,qy); active=true;
    const out=fn(); gl.endQuery(ext.TIME_ELAPSED_EXT); active=false;
    G.pending.push([label,qy]); return out; };
  window.__gpuSpan=span;
  const pf=window.__ctx.postfx, c=pf.composer;
  c.passes.forEach((p,i)=>{ const o=p.render.bind(p);
    p.render=function(...a){ return span(`${i} ${p.constructor.name}`, ()=>o(...a)); }; });
  const sm=r.shadowMap; const so=sm.render.bind(sm);
  sm.render=function(...a){ return span('  shadowMap', ()=>so(...a)); };
  const drain=()=>{ for(let i=G.pending.length-1;i>=0;i--){ const [label,qy]=G.pending[i];
    if(!gl.getQueryParameter(qy,gl.QUERY_RESULT_AVAILABLE)) continue;
    const ns=gl.getQueryParameter(qy,gl.QUERY_RESULT);
    G.acc[label]=(G.acc[label]||0)+ns/1e6; G.n[label]=(G.n[label]||0)+1;
    G.pending.splice(i,1); G.free.push(qy); } };
  e.onLateUpdate(()=>{ G.frames++; drain(); });
});
const out=[];
for(const name of VIEWNAMES){
  const v=VIEWS[name]; if(!v){console.log('unknown view',name);continue;}
  await page.evaluate(async ({v,frozen})=>{
    const THREE=window.__THREE, e=window.__engine, wd=window.__world, api=window.__cameraAnchors||{};
    window.__lighting.hour=v.hour; window.__lighting.cycleSpeed=0;
    const anchor = frozen[v.anchor] ?? (api[v.anchor]||api.vista)();
    let yaw=(anchor.yaw??0)+(v.yawOffset??0);
    if(v.faceSun){const sd=window.__lighting.sunDir; yaw=Math.atan2(sd.x,sd.z);}
    const back=v.standOff??0; const gx=anchor.x-Math.sin(yaw)*back, gz=anchor.z-Math.cos(yaw)*back;
    const gy=wd.getHeight(gx,gz)+v.height;
    e.camera.fov=v.fov; e.camera.updateProjectionMatrix();
    e.camera.position.set(gx,gy,gz);
    e.camera.lookAt(gx+Math.sin(yaw)*v.dist, gy+Math.tan(v.pitch)*v.dist, gz+Math.cos(yaw)*v.dist);
    window.__forceCamera=true; window.dispatchEvent(new Event('resize'));
    if(window.__settle) await window.__settle(90);
  },{v,frozen});
  for(let rep=0; rep<REPEATS; rep++){
    for(const va of VARIANTS){
      await page.evaluate((src)=>eval(src)(), va.on);
      await page.waitForTimeout(500);
      await page.evaluate(()=>{const G=window.__gpu;G.acc={};G.n={};G.frames=0;});
      const r=await page.evaluate((FRAMES)=>new Promise((res)=>{
        const e=window.__engine,G=window.__gpu; let n=0,done=false;
        e.onLateUpdate(()=>{ if(done)return; if(++n<FRAMES)return; done=true;
          setTimeout(()=>{ const rows=Object.entries(G.acc).map(([k,v])=>[k,v/(G.n[k]||1)]);
            res({rows, calls:e.renderer.info.render.calls, tris:+(e.renderer.info.render.triangles/1e6).toFixed(2)}); },300); });
      }),FRAMES);
      await page.evaluate((src)=>eval(src)(), va.off);
      out.push([name,va.label,r]);
      process.stderr.write(`[gputime] ${name} / ${va.label} rep${rep} total ${r.rows.reduce((a,b)=>a+b[1],0).toFixed(1)} ms\n`);
    }
  }
}
await browser.close();
const med=(a)=>{const s=[...a].sort((x,y)=>x-y);return s[s.length>>1];};
const key=(k)=>k.replace(/^(\d+) /,'$1 ').replace(/\$[0-9a-z$]+/,'N8AOPass');
console.log(`\nGPU ms per pass (median of ${REPEATS} interleaved reps)   res ${RES}${QUALITY?' q='+QUALITY:''}`);
for(const name of VIEWNAMES){
  console.log(`\n  ${name}`);
  const labels=[...new Set(out.filter(o=>o[0]===name).map(o=>o[1]))];
  const passes=[...new Set(out.filter(o=>o[0]===name).flatMap(o=>o[2].rows.map(r=>key(r[0]))))].sort();
  console.log('    '+'variant'.padEnd(24)+passes.map(p=>p.slice(0,14).padStart(16)).join('')+'           total   calls    tris');
  for(const L of labels){
    const runs=out.filter(o=>o[0]===name&&o[1]===L).map(o=>o[2]);
    const cell=(p)=>med(runs.map(r=>{const f=r.rows.find(x=>key(x[0])===p);return f?f[1]:0;}));
    const tot=passes.reduce((a,p)=>a+cell(p),0);
    console.log('    '+L.padEnd(24)+passes.map(p=>cell(p).toFixed(2).padStart(16)).join('')+
      tot.toFixed(2).padStart(16)+String(Math.max(...runs.map(r=>r.calls))).padStart(8)+String(Math.max(...runs.map(r=>r.tris))).padStart(8));
  }
}
