// Snapshot the scene graph before/after a drive: which subtree accumulates.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','30')), RES=arg('res','768');
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(1000);
const snap=()=>page.evaluate(()=>{
  const e=window.__engine, r=e.renderer;
  const byRoot={}, geos=new Set();
  const rootOf=(o)=>{ let p=o, name=o.name; while(p.parent&&p.parent!==e.scene){p=p.parent;} return p.name||p.type; };
  e.scene.traverse(o=>{ if(!o.isMesh&&!o.isPoints&&!o.isLine&&!o.isSprite)return;
    const k=rootOf(o)+'/'+(o.isInstancedMesh?'inst':o.type);
    byRoot[k]=(byRoot[k]||0)+1; if(o.geometry) geos.add(o.geometry.uuid); });
  const rootCounts={}; e.scene.traverse(o=>{ if(o.parent===e.scene) rootCounts[o.name||o.type]=(rootCounts[o.name||o.type]||0)+1; });
  let n=0; e.scene.traverse(()=>n++);
  return {byRoot, objs:n, uniqueGeo:geos.size, geoMem:r.info.memory.geometries, texMem:r.info.memory.textures,
          roots:Object.keys(rootCounts)};
});
const a=await snap();
await page.evaluate(()=>{ const ctx=window.__ctx, input=ctx.input; window.__perfDrive=true; const t0=performance.now();
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-t0)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);}; tick(); });
await page.waitForTimeout(SECONDS*1000);
await page.evaluate(()=>{window.__perfDrive=false;});
const b=await snap();
await browser.close();
console.log('roots:', a.roots.join(', '));
console.log(`objs ${a.objs} -> ${b.objs}   uniqueGeo ${a.uniqueGeo} -> ${b.uniqueGeo}   geoMem ${a.geoMem} -> ${b.geoMem}  texMem ${a.texMem} -> ${b.texMem}`);
const keys=new Set([...Object.keys(a.byRoot),...Object.keys(b.byRoot)]);
console.log('\nrenderables by subtree (before -> after):');
for(const k of [...keys].sort()) { const x=a.byRoot[k]||0,y=b.byRoot[k]||0; console.log(`  ${k.padEnd(42)} ${String(x).padStart(5)} -> ${String(y).padStart(5)}  ${y-x>0?'+'+(y-x):''}`); }
