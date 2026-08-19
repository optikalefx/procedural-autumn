// Ground truth for "flashing black": capture what the compositor actually
// presents, via CDP screencast, and analyse it in a second page so the game
// page is never blocked.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','30')), RES=arg('res','768');
const FLAGS=['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization'];
if(!argv.includes('--vsync'))FLAGS.push('--disable-frame-rate-limit');
await acquire('perf');
const browser=await chromium.launch({args:FLAGS});
const VW=parseInt(arg('w','1600'),10), VH=parseInt(arg('h','900'),10);
const page=await browser.newPage({viewport:{width:VW,height:VH},deviceScaleFactor:1});
const helper=await browser.newPage();
await helper.goto('about:blank');
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(1000);
if(argv.includes('--renderonly')) await page.evaluate(()=>{const P=window.__postfx;for(const x of P.composer.passes)x.enabled=false;P.renderPass.enabled=true;P.renderPass.renderToScreen=true;});
if(argv.includes('--nomain')) await page.evaluate(()=>{const P=window.__postfx;P.mainPass.enabled=false;if(P.ao){P.ao.enabled=true;P.ao.renderToScreen=true;}else{P.renderPass.renderToScreen=true;}});
if(argv.includes('--nopost')) await page.evaluate(()=>{ window.__engine._render=null; });
if(argv.includes('--noao')) await page.evaluate(()=>{ if(window.__postfx.ao) window.__postfx.ao.enabled=false; });
if(argv.includes('--nodrive')) await page.evaluate(()=>{ window.__nodrive=true; });
if(argv.includes('--nohud')) await page.evaluate(()=>{const h=document.getElementById('pa-hud'); if(h)h.style.display='none';});
if(argv.includes('--noblur')) await page.evaluate(()=>{const s=document.createElement('style');s.textContent='*{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}';document.head.appendChild(s);});
await page.evaluate(()=>{const ctx=window.__ctx,input=ctx.input;const t0=performance.now();window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;if(window.__nodrive){requestAnimationFrame(tick);return;}const t=(performance.now()-t0)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();});
await page.bringToFront();
const cdp=await page.context().newCDPSession(page);
const frames=[];
cdp.on('Page.screencastFrame', async (p)=>{ frames.push(p.data);
  try { await cdp.send('Page.screencastFrameAck',{sessionId:p.sessionId}); } catch {} });
await cdp.send('Page.startScreencast',{format:'jpeg',quality:50,maxWidth:320,maxHeight:180,everyNthFrame:1});
await page.waitForTimeout(SECONDS*1000);
await cdp.send('Page.stopScreencast');
await page.evaluate(()=>{window.__perfDrive=false;});
console.log('screencast frames captured:', frames.length);
const res=await helper.evaluate(async (list)=>{
  const out=[];
  for(let i=0;i<list.length;i++){
    const b=await fetch('data:image/jpeg;base64,'+list[i]).then(r=>r.blob());
    const img=await createImageBitmap(b);
    const c=new OffscreenCanvas(img.width,img.height); const g=c.getContext('2d');
    g.drawImage(img,0,0); const d=g.getImageData(0,0,img.width,img.height).data;
    let sum=0,dark=0; const n=img.width*img.height;
    const colDark=new Array(img.width).fill(0), rowDark=new Array(img.height).fill(0);
    for(let y=0;y<img.height;y++)for(let x=0;x<img.width;x++){const j=(y*img.width+x)*4;
      const v=(d[j]+d[j+1]+d[j+2])/3; sum+=v; if(v<12){dark++;colDark[x]++;rowDark[y]++;}}
    out.push({i,mean:+(sum/n).toFixed(1),dark:+(dark/n).toFixed(3),
      deadCols:+(colDark.filter(c=>c>=img.height*0.97).length/img.width).toFixed(2),
      deadRows:+(rowDark.filter(c=>c>=img.width*0.97).length/img.height).toFixed(2), w:img.width,h:img.height});
  }
  return out;
},frames.slice(0,1200));
const bad0=res.filter(r=>r.dark>0.5||r.deadCols>0.2||r.deadRows>0.2).slice(0,6);
import('node:fs').then(fs=>{for(const b of bad0){fs.writeFileSync(`/tmp/blackframe-${b.i}.jpg`, Buffer.from(frames[b.i],'base64'));}
 const ok=res.find(r=>r.dark<0.05); if(ok)fs.writeFileSync(`/tmp/okframe-${ok.i}.jpg`, Buffer.from(frames[ok.i],'base64'));});
await browser.close();
const bad=res.filter(r=>r.dark>0.5||r.deadCols>0.2||r.deadRows>0.2);
const means=res.map(r=>r.mean).sort((a,b)=>a-b);
console.log(`analysed ${res.length} presented frames; ${bad.length} black or partial`);
console.log('lowest means:', JSON.stringify(means.slice(0,10)));
for(const b of bad.slice(0,15)) console.log(' ', JSON.stringify(b));
