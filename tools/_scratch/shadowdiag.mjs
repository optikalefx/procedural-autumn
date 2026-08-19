// What is in the shadow pass, per subtree.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','20')), RES=arg('res','768');
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(1000);
await page.evaluate(()=>{
  const e=window.__engine, ctx=window.__ctx, r=e.renderer;
  const P=window.__perf={sh:{},shTri:{},main:{},frames:0,started:performance.now(),shCalls:0,mainCalls:0};
  const rootOf=(o)=>{let p=o;while(p.parent&&p.parent!==e.scene)p=p.parent;return p.name||p.type;};
  const tris=(o)=>{const g=o.geometry;if(!g)return 0;const c=g.index?g.index.count:(g.attributes.position?.count||0);
    const inst=o.isInstancedMesh?o.count:(g.instanceCount!==undefined&&g.instanceCount!==Infinity?g.instanceCount:1);return c/3*inst;};
  const hook=()=>{e.scene.traverse(o=>{if(!(o.isMesh||o.isPoints||o.isLine||o.isSprite))return;if(o.__hk)return;o.__hk=true;
    const k=rootOf(o);
    o.onBeforeRender=function(){P.main[k]=(P.main[k]||0)+1;};
    o.onBeforeShadow=function(){P.sh[k]=(P.sh[k]||0)+1;P.shTri[k]=(P.shTri[k]||0)+tris(this);};});};
  hook(); setInterval(hook,1000);
  const so=r.shadowMap.render.bind(r.shadowMap);
  r.shadowMap.render=function(...a){const c0=r.info.render.calls;const t=performance.now();const out=so(...a);
    P.shCalls+=r.info.render.calls-c0;P.shMs=(P.shMs||0)+(performance.now()-t);return out;};
  e.onLateUpdate(()=>{P.frames++;});
  const input=ctx.input;window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-P.started)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();
});
await page.waitForTimeout(SECONDS*1000);
const d=await page.evaluate(()=>{const P=window.__perf;window.__perfDrive=false;
  const ks=new Set([...Object.keys(P.sh),...Object.keys(P.main)]);
  return {frames:P.frames,shCalls:+(P.shCalls/P.frames).toFixed(1),shMs:+(P.shMs/P.frames).toFixed(2),
    rows:[...ks].map(k=>[k,+((P.sh[k]||0)/P.frames).toFixed(1),+((P.shTri[k]||0)/P.frames/1000).toFixed(0),+((P.main[k]||0)/P.frames).toFixed(1)]).sort((a,b)=>b[1]-a[1])};});
await browser.close();
console.log(`frames ${d.frames}   shadow pass: ${d.shCalls} draws/frame, ${d.shMs} ms/frame`);
console.log('subtree              shadowDraws  shadowKtris   mainDraws');
let a=0,b=0,c=0; for(const [k,s,t,m] of d.rows){a+=s;b+=t;c+=m;console.log(`  ${k.padEnd(20)} ${String(s).padStart(8)} ${String(t).padStart(12)} ${String(m).padStart(11)}`);}
console.log(`  ${'TOTAL'.padEnd(20)} ${a.toFixed(1).padStart(8)} ${b.toFixed(0).padStart(12)} ${c.toFixed(1).padStart(11)}`);
