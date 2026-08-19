import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const file = process.argv[2];
const pts = process.argv.slice(3).map(s=>s.split(',').map(Number));
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:64,height:64}});
const b64 = readFileSync(file).toString('base64');
console.log(await p.evaluate(async ({b64,pts,file})=>{
  const img=new Image(); img.src='data:image/'+(file.endsWith('.png')?'png':'jpeg')+';base64,'+b64; await img.decode();
  const c=new OffscreenCanvas(img.width,img.height); const g=c.getContext('2d');
  g.drawImage(img,0,0); const out=[];
  for(const [x,y] of pts){
    // average a 7x7 block
    const d=g.getImageData(x-3,y-3,7,7).data; let r=0,gr=0,bl=0,n=0;
    for(let i=0;i<d.length;i+=4){r+=d[i];gr+=d[i+1];bl+=d[i+2];n++;}
    r/=n;gr/=n;bl/=n;
    const R=r/255,G=gr/255,B=bl/255;
    const l=0.2126*R+0.7152*G+0.0722*B;
    const chroma=Math.max(R,G,B)-Math.min(R,G,B);
    out.push(`(${x},${y}) rgb(${r.toFixed(0)},${gr.toFixed(0)},${bl.toFixed(0)}) luma ${l.toFixed(3)} chroma ${chroma.toFixed(3)}`);
  }
  return out.join('\n');
},{b64,pts,file}));
await b.close();
