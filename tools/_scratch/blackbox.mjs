// Locate axis-aligned black rectangles in captured PNGs.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
const files=process.argv.slice(2);
await acquire('perf');
const b=await chromium.launch();
const p=await b.newPage();
await p.goto('about:blank');
for(const f of files){
  const b64=readFileSync(f).toString('base64');
  const r=await p.evaluate(async (b64)=>{
    const img=new Image(); img.src='data:image/png;base64,'+b64; await img.decode();
    const c=new OffscreenCanvas(img.width,img.height); const g=c.getContext('2d');
    g.drawImage(img,0,0); const d=g.getImageData(0,0,img.width,img.height).data;
    const W=img.width,H=img.height; let x0=1e9,y0=1e9,x1=-1,y1=-1,n=0;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4;
      if(d[i]<6&&d[i+1]<6&&d[i+2]<6){n++;if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}}
    return {W,H,n,frac:+(n/(W*H)).toFixed(3),box:n?[x0,y0,x1-x0+1,y1-y0+1]:null};
  },b64);
  console.log(`${f}  ${r.W}x${r.H}  blackPx ${r.frac}  box ${JSON.stringify(r.box)}`);
}
await b.close();
