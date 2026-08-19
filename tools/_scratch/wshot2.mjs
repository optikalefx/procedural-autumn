// scratch: water-author capture harness. Free cameras, HMR neutered, retries.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
const argv = process.argv.slice(2);
const arg = (n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const RES = arg('res','1024'), DIR = arg('dir','shots/water/x');
const W = +arg('w','1600'), H = +arg('h','900');
const FRAMES = arg('frames','').split(';').filter(Boolean).map(f=>{
  const [name,pos,look,hour] = f.split('@');
  return { name, pos: pos.split(',').map(Number), look: look.split(',').map(Number), hour: parseFloat(hour||'16.7') };
});
const HIDE = (arg('hide','')||'').split(',').filter(Boolean);
mkdirSync(DIR,{recursive:true});
await acquire('shot');
const browser = await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist']});
const page = await browser.newPage({viewport:{width:W,height:H},deviceScaleFactor:1});
// Vite full-reloads whenever any of a dozen authors saves a file. Kill the HMR
// socket before page scripts run, or a peer's save destroys the run mid-frame.
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close(){}, send(){}, addEventListener(){}, removeEventListener(){},
               set onopen(_){}, set onclose(_){}, set onerror(_){}, set onmessage(_){} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
page.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await page.goto(`http://localhost:5178?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
for (const f of FRAMES) {
  for (let attempt=0; attempt<3; attempt++) {
    try {
      await page.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
      await page.evaluate(async (f)=>{
        const T=window.__THREE,e=window.__engine;
        window.__lighting.hour=f.hour; window.__lighting.cycleSpeed=0;
        e.camera.fov=50; e.camera.updateProjectionMatrix();
        e.camera.position.set(...f.pos); e.camera.lookAt(new T.Vector3(...f.look));
        window.__forceCamera=true;
        if (window.__settle) await window.__settle(150);
      }, f);
      break;
    } catch (err) { if (attempt===2) throw err; await page.waitForTimeout(2500); }
  }
  await page.waitForTimeout(1200);
  // Re-applied per frame, not once at load: water and waterfall chunks stream
  // in by distance, so anything hidden before the camera moved is a mesh that
  // did not exist yet.
  if (HIDE.length) await page.evaluate((h)=>{window.__engine.scene.traverse(n=>{if(h.includes(n.name))n.visible=false;});},HIDE);
  await page.waitForTimeout(120);
  await page.screenshot({path:`${DIR}/${f.name}.png`});
  console.log('shot:',`${DIR}/${f.name}.png`);
}
if(errs.length)console.log('page-errors:',JSON.stringify(errs.slice(0,6)));
await browser.close();
