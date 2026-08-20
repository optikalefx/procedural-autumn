import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('boom');
const b = await chromium.launch({ args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--disable-frame-rate-limit'] });
const p = await b.newPage({ viewport:{width:900,height:600} });
await p.addInitScript(() => { const R=window.WebSocket; window.WebSocket=function(u,q){ if(typeof u==='string'&&/[?&]token=|vite-hmr|__vite/.test(u)) return {readyState:3,url:u,close(){},send(){},addEventListener(){},removeEventListener(){},set onopen(_){},set onclose(_){},set onerror(_){},set onmessage(_){}}; return new R(u,q);}; window.WebSocket.prototype=R.prototype; Object.assign(window.WebSocket,R); });
await p.goto('http://localhost:5178/?res=640',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:300});
const out = await p.evaluate(async () => {
  const inp = window.__ctx.input; window.__drive=true;
  const tick=()=>{ if(!window.__drive) return; inp.axes.throttle=1; inp.axes.steer=0.15; requestAnimationFrame(tick); }; tick();
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  await sleep(9000);
  const s=[];
  for(let i=0;i<20;i++){
    const cam=window.__engine.camera.position, v=window.__systems.vehicle;
    const vp=v.position;
    s.push({ d:+Math.hypot(cam.x-vp.x,cam.z-vp.z).toFixed(2), h:+(cam.y-vp.y).toFixed(2),
             spd:+Math.abs(v.speed).toFixed(1), zoom:+(window.__systems.cameraRig?.zoom ?? window.__ctx.systems.cameraRig?.zoom ?? -1).toFixed(1) });
    await sleep(250);
  }
  window.__drive=false;
  return { s, sysnames:Object.keys(window.__systems) };
});
await b.close();
const d=out.s.map(x=>x.d).sort((a,b)=>a-b);
console.log('camera->camper horizontal dist: min',d[0],'med',d[d.length>>1],'max',d[d.length-1]);
console.log('speed', out.s.map(x=>x.spd).join(','));
console.log(JSON.stringify(out.s.slice(0,4)));
console.log('systems', out.sysnames.join(','));
