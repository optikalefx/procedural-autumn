// scratch: isolate waterfall sub-meshes at one framing, one page load.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
const argv = process.argv.slice(2);
const arg = (n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const RES = arg('res','1024'), DIR = arg('dir','shots/water/diag2');
const POS = arg('pos','-600,26,624').split(',').map(Number);
const LOOK = arg('look','-632,16,622').split(',').map(Number);
const HOUR = parseFloat(arg('hour','16.6'));
mkdirSync(DIR,{recursive:true});
await acquire('shot');
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=metal']});
const p = await b.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
// A peer saving a file reloads the page and destroys the run mid-frame. Neuter
// Vite's HMR socket before any page script gets to open it.
await p.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close(){}, send(){}, addEventListener(){}, removeEventListener(){},
               set onopen(_){}, set onclose(_){}, set onerror(_){}, set onmessage(_){} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
  Object.assign(window.WebSocket, Real);
});
const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto(`http://localhost:5178?res=${RES}`,{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await p.evaluate(async ({POS,LOOK,HOUR})=>{
  const T=window.__THREE,e=window.__engine;
  window.__lighting.hour=HOUR; window.__lighting.cycleSpeed=0;
  e.camera.fov=50; e.camera.updateProjectionMatrix();
  e.camera.position.set(...POS); e.camera.lookAt(new T.Vector3(...LOOK));
  window.__forceCamera=true;
  if (window.__settle) await window.__settle(120);
}, {POS,LOOK,HOUR});
const names=['WaterfallSheets','WaterfallSpray','WaterfallBurst','WaterfallMist','PlungePools'];
const found = await p.evaluate(()=>{const o=[];window.__engine.scene.traverse(n=>{if(/waterfall|plunge|spray|mist|burst|sheet/i.test(n.name))o.push({n:n.name,t:n.type,v:n.visible,c:n.geometry?.instanceCount??n.geometry?.index?.count??0});});return JSON.stringify(o);});
console.log('meshes:',found);
const shots=[['all',[]],['poolonly',['WaterfallSheets','WaterfallSpray','WaterfallBurst','WaterfallMist']],['mistonly',['WaterfallSheets','WaterfallSpray','WaterfallBurst','PlungePools']],['burstonly',['WaterfallSheets','WaterfallSpray','WaterfallMist','PlungePools']],['nosheet',['WaterfallSheets']]];
for(const [label,hide] of shots){
  await p.evaluate((h)=>{window.__engine.scene.traverse(n=>{if(/Waterfall|Plunge/i.test(n.name||''))n.visible=!h.includes(n.name);});},hide);
  await p.waitForTimeout(700);
  await p.screenshot({path:`${DIR}/${label}.png`});
  console.log('shot:',`${DIR}/${label}.png`);
}
if(errs.length)console.log('page-errors:',JSON.stringify(errs.slice(0,6)));
await b.close();
