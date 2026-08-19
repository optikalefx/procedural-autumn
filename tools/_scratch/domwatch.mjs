// Close out the HUD hypothesis with evidence rather than with reading.
//
// The HUD hides itself whenever window.__forceCamera is set, which is what
// every capture in this project sets, so no test image has ever contained it.
// This runs the game with the HUD visible and driving, and on EVERY frame walks
// the whole DOM looking for any element that is both large (over 300x300 CSS px)
// and near-black, plus a MutationObserver logging every node the HUD adds or
// removes. If a mis-sized panel, a modal scrim or a stray canvas is the black
// square, it cannot hide from this.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const PORT=arg('port','5178'), SECONDS=parseFloat(arg('seconds','120'));
const W=parseInt(arg('w','2000'),10), H=parseInt(arg('h','1100'),10);
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:W,height:H},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.routeWebSocket(new RegExp(`^wss?://(localhost|127\\.0\\.0\\.1):${PORT}/`),()=>{});
await page.goto(`http://127.0.0.1:${PORT}/?res=1536`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
await page.waitForTimeout(1500);
const out=await page.evaluate(async ({SECONDS})=>{
  const ctx=window.__ctx, input=ctx.input;
  const R={frames:0, big:[], mutations:[], canvases:[], maxSeen:{w:0,h:0,sel:''}};
  const sel=(n)=>{ if(!n||!n.tagName) return String(n); let s=n.tagName.toLowerCase();
    if(n.id)s+='#'+n.id; if(n.className&&typeof n.className==='string')s+='.'+n.className.trim().split(/\s+/).join('.');
    return s; };
  const nearBlack=(c)=>{ const m=/rgba?\(([^)]+)\)/.exec(c); if(!m) return false;
    const p=m[1].split(',').map(Number); const a=p.length>3?p[3]:1;
    return a>0.5 && (p[0]+p[1]+p[2])/3 < 40; };
  new MutationObserver((recs)=>{ for(const r of recs){
    for(const n of r.addedNodes) if(n.nodeType===1&&R.mutations.length<80) R.mutations.push('+ '+sel(n));
    for(const n of r.removedNodes) if(n.nodeType===1&&R.mutations.length<80) R.mutations.push('- '+sel(n));
  }}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class']});
  const t0=performance.now(); window.__d=true;
  const drive=()=>{ if(!window.__d)return; const t=(performance.now()-t0)/1000;
    input.axes.throttle=1; input.axes.brake=0; input.axes.steer=Math.sin(t*0.42)*0.75;
    requestAnimationFrame(drive); }; drive();
  await new Promise((resolve)=>{
    const step=()=>{ R.frames++;
      for(const n of document.body.querySelectorAll('*')){
        if(n.id==='gl') continue;                       // the WebGL canvas itself
        const r=n.getBoundingClientRect();
        if(r.width<300||r.height<300) continue;
        const cs=getComputedStyle(n);
        if(cs.visibility==='hidden'||cs.display==='none'||parseFloat(cs.opacity)<0.02) continue;
        if(n.tagName==='CANVAS'&&R.canvases.length<20) R.canvases.push(`${sel(n)} ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)}`);
        if(r.width*r.height>R.maxSeen.w*R.maxSeen.h){R.maxSeen={w:Math.round(r.width),h:Math.round(r.height),sel:sel(n)};}
        if(nearBlack(cs.backgroundColor)&&R.big.length<40)
          R.big.push(`${sel(n)} ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)} bg=${cs.backgroundColor} op=${cs.opacity}`);
      }
      if((performance.now()-t0)/1000>=SECONDS){resolve();return;}
      requestAnimationFrame(step); }; step();
  });
  window.__d=false;
  R.hudTree=[...document.querySelectorAll('#pa-hud *')].length;
  return R;
},{SECONDS});
console.log(`\ndomwatch — port ${PORT}, ${W}x${H}, driving, HUD visible`);
console.log(`frames scanned: ${out.frames}   nodes under #pa-hud: ${out.hudTree}`);
console.log(`largest visible non-canvas element seen: ${out.maxSeen.sel} ${out.maxSeen.w}x${out.maxSeen.h}`);
console.log(`\nlarge (>300x300) near-black elements: ${out.big.length}`);
for(const b of out.big) console.log('   ',b);
console.log(`\nlarge canvases other than #gl: ${out.canvases.length}`);
for(const c of out.canvases) console.log('   ',c);
console.log(`\nDOM mutations observed (first 80): ${out.mutations.length}`);
for(const m of out.mutations.slice(0,20)) console.log('   ',m);
await browser.close();
