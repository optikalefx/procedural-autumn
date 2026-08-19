// Scan the scene HDR buffer for non-finite values across every canonical view.
//
// One NaN fragment is invisible on its own and catastrophic after the bloom
// mip chain averages it outward — that is the black square. This is the
// regression test for it: it looks for the cause (a non-finite channel in the
// HDR buffer) rather than for the symptom, so it does not depend on the bloom
// happening to spread it far enough to notice on the frame it samples.
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d=null)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const RES=arg('res','768'), QUALITY=arg('quality',null);
const W=parseInt(arg('w','1280'),10), H=parseInt(arg('h','720'),10);
const FRAMES=parseInt(arg('frames','90'),10);
const VIEWNAMES=(arg('views','hero,drive,meadow,forest,river,waterfall,peaks,backlit,dawn')).split(',');
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
await acquire('nansweep');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:W,height:H},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,160)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
const q=new URLSearchParams({res:RES}); if(QUALITY)q.set('quality',QUALITY);
await page.goto(`http://localhost:5178/?${q}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
console.log(`view          frames   frames with a non-finite HDR pixel   worst count`);
let total=0;
for(const name of VIEWNAMES){
  const v=VIEWS[name]; if(!v) continue;
  await page.evaluate(async ({v,frozen})=>{
    const e=window.__engine, wd=window.__world, api=window.__cameraAnchors||{};
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
    if(window.__settle) await window.__settle(60);
  },{v,frozen});
  const r=await page.evaluate((FRAMES)=>new Promise((res)=>{
    const e=window.__engine, r=e.renderer, pf=window.__ctx.postfx;
    const rt=pf.composer.inputBuffer; const w=rt.width, h=rt.height;
    const buf=new Uint16Array(w*h*4);
    let n=0, hits=0, worst=0, first=null;
    const step=()=>{
      r.readRenderTargetPixels(pf.composer.inputBuffer,0,0,w,h,buf);
      let bad=0, at=null;
      for(let i=0;i<buf.length;i++) if(((buf[i]>>10)&0x1f)===0x1f){ bad++;
        if(!at){ const p=i>>2; at=[p%w,(p/w)|0]; } }
      if(bad){ hits++; if(bad>worst)worst=bad; if(!first)first=at; }
      if(++n>=FRAMES){ res({n,hits,worst,first}); return; }
      requestAnimationFrame(step);
    };
    step();
  }),FRAMES);
  total+=r.hits;
  console.log(`  ${name.padEnd(12)} ${String(r.n).padStart(5)}   ${String(r.hits).padStart(30)}   ${String(r.worst).padStart(10)}${r.first?'  first at ('+r.first.join(',')+')':''}`);
}
await browser.close();
console.log(total===0 ? '\nclean: no non-finite pixel in any view' : `\n${total} frames carried a non-finite pixel`);
