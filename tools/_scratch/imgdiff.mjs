import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [a,b] = process.argv.slice(2);
const br = await chromium.launch(); const p = await br.newPage({viewport:{width:64,height:64}});
const out = await p.evaluate(async ({A,B})=>{
  const ld = async (s)=>{const i=new Image(); i.src='data:image/png;base64,'+s; await i.decode(); const c=new OffscreenCanvas(i.width,i.height); const g=c.getContext('2d'); g.drawImage(i,0,0); return g.getImageData(0,0,i.width,i.height);};
  const x=await ld(A), y=await ld(B);
  let n=0, sum=0, max=0, cnt=0;
  for(let i=0;i<x.data.length;i+=4){const d=(Math.abs(x.data[i]-y.data[i])+Math.abs(x.data[i+1]-y.data[i+1])+Math.abs(x.data[i+2]-y.data[i+2]))/3; sum+=d; if(d>max)max=d; if(d>6)cnt++; n++;}
  return {meanDiff:+(sum/n).toFixed(2), maxDiff:max, pctChanged:+(100*cnt/n).toFixed(2)};
},{A:readFileSync(a).toString('base64'),B:readFileSync(b).toString('base64')});
console.log(a,'vs',b,JSON.stringify(out)); await br.close();
