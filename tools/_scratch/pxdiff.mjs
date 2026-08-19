// Numeric before/after difference between two shot directories.
//
// `tools/ab.mjs` pairs frames for a human to judge; this puts a number on the
// same pair, so "did not change the picture" is a measurement rather than an
// impression. Reports mean and 99.9th-percentile per-pixel difference in 0-255
// units, plus the fraction of pixels that moved by more than 2 levels (below
// which nothing is visible on screen).
import { chromium } from 'playwright';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const A=arg('a'), B=arg('b');
if(!A||!B){ console.error('need --a <dir> --b <dir>'); process.exit(1); }
const pngs=(d)=>existsSync(d)?readdirSync(d).filter(f=>f.endsWith('.png')):[];
const shared=pngs(A).filter(f=>pngs(B).includes(f));
const browser=await chromium.launch();
const page=await browser.newPage();
await page.goto('about:blank');
console.log('view              mean d   p99.9 d   >2 levels   >8 levels');
let worst=0;
for(const f of shared){
  const r=await page.evaluate(async ([a,b])=>{
    const load=async(src)=>{const i=new Image();i.src='data:image/png;base64,'+src;await i.decode();
      const c=new OffscreenCanvas(i.width,i.height);const g=c.getContext('2d');g.drawImage(i,0,0);
      return g.getImageData(0,0,i.width,i.height);};
    const ia=await load(a), ib=await load(b);
    if(ia.width!==ib.width||ia.height!==ib.height) return {err:'size'};
    const n=ia.width*ia.height; const d=new Uint8Array(n); let sum=0,c2=0,c8=0;
    for(let i=0;i<n;i++){ const o=i*4;
      const dd=Math.max(Math.abs(ia.data[o]-ib.data[o]),Math.abs(ia.data[o+1]-ib.data[o+1]),Math.abs(ia.data[o+2]-ib.data[o+2]));
      d[i]=dd; sum+=dd; if(dd>2)c2++; if(dd>8)c8++; }
    const hist=new Uint32Array(256); for(let i=0;i<n;i++)hist[d[i]]++;
    let acc=0,p999=0; for(let v=0;v<256;v++){acc+=hist[v]; if(acc>=n*0.999){p999=v;break;}}
    return {mean:sum/n, p999, f2:c2/n, f8:c8/n};
  },[readFileSync(join(A,f)).toString('base64'), readFileSync(join(B,f)).toString('base64')]);
  if(r.err){ console.log(`  ${basename(f,'.png').padEnd(12)} size mismatch`); continue; }
  worst=Math.max(worst,r.f8);
  console.log(`  ${basename(f,'.png').padEnd(14)} ${r.mean.toFixed(2).padStart(7)} ${String(r.p999).padStart(9)} ${(100*r.f2).toFixed(2).padStart(10)}% ${(100*r.f8).toFixed(2).padStart(10)}%`);
}
await browser.close();
console.log(`\nworst view: ${(100*worst).toFixed(2)}% of pixels moved by more than 8 levels`);
