// Static-camera GPU cost per canonical view, all variants in ONE session.
//
// Two things this exists for. First, a driven run is not a controlled
// experiment: the camper travels further in the same wall clock when the frame
// is cheaper, so every A/B compares two different stretches of map. Posing the
// camera at a frozen anchor removes that. Second, five authors share this
// machine and a capture slot can take ten minutes to come free, so every
// variant is measured inside one page load rather than one process each.
//
//   node tools/_scratch/viewcost.mjs --views drive,forest --variants \
//     "base=()=>{}::no ao=()=>{window.__ctx.postfx.ao.enabled=false}"
//
// Variants are separated by '::' and each is 'label=js'. Each is applied, then
// undone by re-applying the first variant's `undo` if given as 'label=js|undo'.
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
// Inlined, not imported: `import ... from '../shot.mjs'` runs that file's
// main() and fires an entire extra capture, which then sits on a capture slot.
const VIEWS = {
  // Wide establishing shot over the valley — the "box art" frame.
  hero:      { anchor: 'vista',    height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  // Eye-level drive shot: what the player actually stares at for hours.
  drive:     { anchor: 'road',     height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
  // Down in the meadow, grass in the foreground.
  meadow:    { anchor: 'meadow',   height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  // Forest interior — canopy, trunks, dappled light.
  forest:    { anchor: 'forest',   height: 3.0, dist: 14,  pitch: 0.02,  fov: 60, hour: 16.4 },
  // River bank, water in frame.
  river:     { anchor: 'river',    height: 5.2, dist: 26,  pitch: -0.16, fov: 54, hour: 16.9, yawOffset: 0.42 },
  // The tallest waterfall, framed from below.
  waterfall: { anchor: 'waterfall',height: 11,  dist: 58,  pitch: 0.08,  fov: 50, hour: 16.2, yawOffset: -0.55 },
  // High peaks and aerial perspective.
  peaks:     { anchor: 'peak',     height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
  // The vehicle, three-quarter hero framing.
  vehicle:   { anchor: 'vehicle',  height: 2.6, dist: 11,  pitch: -0.10, fov: 44, hour: 17.0, subject: true },
  // Golden-hour backlit shot — the money frame for foliage translucency.
  backlit:   { anchor: 'meadow',   height: 2.4, dist: 10,  pitch: 0.04,  fov: 52, hour: 17.9, faceSun: true },
  // Dawn cool pass, checks the grade does not fall apart off-golden-hour.
  dawn:      { anchor: 'vista',    height: 48,  dist: 130, pitch: -0.13, fov: 46, hour: 7.4 },
};
const argv=process.argv.slice(2); const arg=(n,d=null)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const RES=arg('res','768'), QUALITY=arg('quality',null);
const FRAMES=parseInt(arg('frames','90'),10);
const REPEATS=parseInt(arg('repeats','3'),10);
const VIEWNAMES=(arg('views','drive,forest,backlit')).split(',');
const VARIANTS=(arg('variants','base=()=>{}')).split('::').map(s=>{
  const i=s.indexOf('='); const rest=s.slice(i+1); const j=rest.lastIndexOf('|');
  return {label:s.slice(0,i), on:j===-1?rest:rest.slice(0,j), off:j===-1?'()=>{}':rest.slice(j+1)};});
const frozen = existsSync('shots/_anchors.json') ? JSON.parse(readFileSync('shots/_anchors.json','utf8')) : {};
await acquire('viewcost');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,160)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
const q=new URLSearchParams({res:RES}); if(QUALITY)q.set('quality',QUALITY);
await page.goto(`http://localhost:5178/?${q}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
process.stderr.write('[viewcost] ready\n');
const measure=(FRAMES)=>page.evaluate((FRAMES)=>new Promise((res)=>{
  const e=window.__engine,r=e.renderer; const ms=[],calls=[],tris=[]; let last=performance.now(),n=0,done=false;
  e.onLateUpdate(()=>{ if(done)return; const now=performance.now();
    if(n++>2){ms.push(now-last);calls.push(r.info.render.calls);tris.push(r.info.render.triangles);}
    last=now;
    if(ms.length>=FRAMES){ done=true; const s=[...ms].sort((a,b)=>a-b);
      res({p50:+s[Math.floor(s.length*0.5)].toFixed(2),p95:+s[Math.floor(s.length*0.95)].toFixed(2),
           calls:Math.max(...calls),tris:+(Math.max(...tris)/1e6).toFixed(2)}); } });
}),FRAMES);
const table={};
for(const name of VIEWNAMES){
  const v=VIEWS[name]; if(!v){console.log('unknown view',name);continue;}
  await page.evaluate(async ({v,frozen})=>{
    const THREE=window.__THREE, e=window.__engine, wd=window.__world, api=window.__cameraAnchors||{};
    window.__lighting.hour=v.hour; window.__lighting.cycleSpeed=0;
    const anchor = frozen[v.anchor] ?? (api[v.anchor]||api.vista)();
    let yaw=(anchor.yaw??0)+(v.yawOffset??0);
    if(v.faceSun){const sd=window.__lighting.sunDir; yaw=Math.atan2(sd.x,sd.z);}
    let pos,look;
    if(v.subject){ const gx=anchor.x-Math.sin(yaw)*v.dist, gz=anchor.z-Math.cos(yaw)*v.dist;
      pos=new THREE.Vector3(gx,wd.getHeight(gx,gz)+v.height,gz);
      look=new THREE.Vector3(anchor.x,wd.getHeight(anchor.x,anchor.z)+(anchor.lookY??1.4),anchor.z); }
    else { const back=v.standOff??0; const gx=anchor.x-Math.sin(yaw)*back, gz=anchor.z-Math.cos(yaw)*back;
      const gy=wd.getHeight(gx,gz)+v.height; pos=new THREE.Vector3(gx,gy,gz);
      look=new THREE.Vector3(gx+Math.sin(yaw)*v.dist, gy+Math.tan(v.pitch)*v.dist, gz+Math.cos(yaw)*v.dist); }
    e.camera.fov=v.fov; e.camera.updateProjectionMatrix();
    e.camera.position.copy(pos); e.camera.lookAt(look);
    window.__forceCamera=true; window.dispatchEvent(new Event('resize'));
    if(window.__settle) await window.__settle(90);
  },{v,frozen});
  // Interleaved, and repeated. Another author's capture starting halfway
  // through a sweep moves every later number by 10 ms, which reads as a result;
  // cycling A,B,C,A,B,C and taking the median per arm spreads that over all of
  // them instead of over whichever arm happened to be running.
  for(let rep=0; rep<REPEATS; rep++){
    for(const va of VARIANTS){
      await page.evaluate((src)=>eval(src)(), va.on);
      await page.waitForTimeout(500);
      const r=await measure(FRAMES);
      await page.evaluate((src)=>eval(src)(), va.off);
      const cell=(table[va.label]||(table[va.label]={}));
      (cell[name]||(cell[name]=[])).push(r);
      process.stderr.write(`[viewcost] ${name} / ${va.label} rep${rep} p50 ${r.p50} calls ${r.calls} tris ${r.tris}M\n`);
    }
  }
}
await browser.close();
const hdr=VIEWNAMES.map(n=>n.padStart(20)).join('');
console.log(`\nstatic-camera cost  (res ${RES}${QUALITY?' q='+QUALITY:''}, ${FRAMES} frames)   p50 ms / calls / Mtris`);
console.log('variant'.padEnd(26)+hdr);
const med=(a)=>{const s=[...a].sort((x,y)=>x-y);return s[s.length>>1];};
for(const va of VARIANTS){ const row=VIEWNAMES.map(n=>{const rs=table[va.label]?.[n];
  return (rs?`${med(rs.map(r=>r.p50)).toFixed(1)} ${Math.max(...rs.map(r=>r.calls))} ${Math.max(...rs.map(r=>r.tris))}M`:'-').padStart(20);}).join('');
  console.log(va.label.padEnd(26)+row); }
