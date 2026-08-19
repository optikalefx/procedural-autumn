// Capture the canonical views under several settings in ONE page load.
//
// Five authors are editing the same tree, so two `shot.mjs --all` runs ten
// minutes apart are not an A/B of my change — they also contain everyone
// else's. Posing each view once and photographing it under each variant in the
// same session is the only way to isolate one setting.
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d=null)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const RES=arg('res','768'), QUALITY=arg('quality',null), DIR=arg('dir','shots/perf/sweep');
const VIEWNAMES=(arg('views','drive,forest,backlit,meadow,hero')).split(',');
const VARIANTS=(arg('variants','base=()=>{}')).split('::').map(x=>{
  const i=x.indexOf('='); return {label:x.slice(0,i), on:x.slice(i+1)};});
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
await acquire('looksweep');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,160)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
const q=new URLSearchParams({res:RES}); if(QUALITY)q.set('quality',QUALITY);
await page.goto(`http://localhost:5178/?${q}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
for(const va of VARIANTS) mkdirSync(`${DIR}/${va.label}`,{recursive:true});
for(const name of VIEWNAMES){
  const v=VIEWS[name]; if(!v) continue;
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
  for(const va of VARIANTS){
    await page.evaluate((src)=>eval(src)(), va.on);
    await page.evaluate(async ()=>{ if(window.__settle) await window.__settle(8); });
    await page.waitForTimeout(300);
    writeFileSync(`${DIR}/${va.label}/${name}.png`, await page.screenshot());
  }
  process.stderr.write(`[looksweep] ${name}\n`);
}
await browser.close();
console.log(`wrote ${VIEWNAMES.length} view(s) x ${VARIANTS.length} variant(s) under ${DIR}/`);
