import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [,,file,...regs]=process.argv;
const b64=readFileSync(file).toString('base64');
const ext=file.toLowerCase().endsWith('.png')?'png':'jpeg';
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:64,height:64}});
const out=await page.evaluate(async ({b64,ext,regs})=>{
  const img=new Image();
  await new Promise((r,j)=>{img.onload=r;img.onerror=j;img.src=`data:image/${ext};base64,${b64}`;});
  const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
  const g=c.getContext('2d');g.drawImage(img,0,0);
  const res=[`${img.width}x${img.height}`];
  for(const r of regs){
    const [x0,y0,x1,y1]=r.split(',').map(Number);
    const d=g.getImageData(x0,y0,x1-x0,y1-y0).data;
    let R=0,G=0,B=0,n=0;const ls=[];
    for(let i=0;i<d.length;i+=4){R+=d[i];G+=d[i+1];B+=d[i+2];n++;ls.push((0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2])/255);}
    ls.sort((a,b)=>a-b);
    const q=(t)=>ls[Math.round(t*(ls.length-1))].toFixed(3);
    res.push(`[${r}] srgb(${(R/n)|0},${(G/n)|0},${(B/n)|0}) L p05=${q(.05)} p50=${q(.5)} p95=${q(.95)}`);
  }
  return res;
},{b64,ext,regs});
console.log(file); out.forEach(l=>console.log('  '+l));
await browser.close();
