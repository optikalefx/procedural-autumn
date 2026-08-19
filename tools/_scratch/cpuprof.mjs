// V8 sampling profile of a real drive. Reports self-time by function, and the
// hot windows (>60 ms) with the samples that landed inside them.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const SECONDS=parseFloat(arg('seconds','25')), RES=arg('res','768');
await acquire('perf');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await page.waitForTimeout(1000);
await page.evaluate(()=>{const ctx=window.__ctx,input=ctx.input;const t0=performance.now();window.__perfDrive=true;
  const tick=()=>{if(!window.__perfDrive)return;const t=(performance.now()-t0)/1000;
    input.axes.throttle=1;input.axes.brake=0;input.axes.steer=Math.sin(t*0.42)*0.75;requestAnimationFrame(tick);};tick();});
const cdp=await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval',{interval:200});
await cdp.send('Profiler.start');
await page.waitForTimeout(SECONDS*1000);
const {profile}=await cdp.send('Profiler.stop');
await page.evaluate(()=>{window.__perfDrive=false;});
await browser.close();
const byId=new Map(profile.nodes.map(n=>[n.id,n]));
const label=n=>{const f=n.callFrame; const url=(f.url||'').replace(/^https?:\/\/[^/]+/,'').replace(/\?.*$/,'');
  return `${f.functionName||'(anon)'} ${url}:${f.lineNumber+1}`;};
const self={}; const totalDelta=profile.timeDeltas.reduce((a,b)=>a+b,0);
// self time per node from samples
const dt={}; for(let i=0;i<profile.samples.length;i++){const id=profile.samples[i];dt[id]=(dt[id]||0)+(profile.timeDeltas[i]||0);}
for(const id in dt){const n=byId.get(+id); if(!n)continue; const k=label(n); self[k]=(self[k]||0)+dt[id];}
const rows=Object.entries(self).sort((a,b)=>b[1]-a[1]).slice(0,30);
console.log(`profile ${(totalDelta/1e6).toFixed(1)}s, ${profile.samples.length} samples`);
console.log('\nself time (ms, % of wall):');
for(const [k,v] of rows) console.log(`  ${String((v/1000).toFixed(0)).padStart(7)} ms  ${String((100*v/totalDelta).toFixed(1)).padStart(5)}%  ${k}`);
// long gaps: consecutive samples with a big delta = a stall attributed to the sample's node
const gaps=[];
for(let i=1;i<profile.samples.length;i++){ if(profile.timeDeltas[i]>40000){
  const n=byId.get(profile.samples[i]); const chain=[]; let c=n, guard=0;
  while(c&&guard++<8){chain.push(label(c)); c=profile.nodes.find(x=>x.children&&x.children.includes(c.id));}
  gaps.push({ms:+(profile.timeDeltas[i]/1000).toFixed(1),chain}); }}
gaps.sort((a,b)=>b.ms-a.ms);
console.log('\nstalls > 40 ms (sample delta), innermost frame first:');
for(const g of gaps.slice(0,12)) console.log(`  ${String(g.ms).padStart(7)} ms  ${g.chain.slice(0,5).join('  <  ')}`);
writeFileSync('/tmp/autumn-cpu.cpuprofile', JSON.stringify(profile));
