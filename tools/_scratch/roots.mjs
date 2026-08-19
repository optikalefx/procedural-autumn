import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('probe');
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist']});
const p = await b.newPage({viewport:{width:800,height:600}});
await p.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await p.goto('http://localhost:5178/?res=768',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
console.log(await p.evaluate(()=>{
  const out=[];
  window.__engine.scene.children.forEach(c=>{let n=0,t=0;c.traverse(o=>{if(o.isMesh||o.isPoints||o.isLine){n++;}});out.push(`${c.name||c.type} [${c.type}] meshes=${n}`);});
  return out.join('\n');
}));
await b.close();
