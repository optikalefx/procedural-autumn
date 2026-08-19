import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const [file, x, y, w, h, out, scale='2'] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:64,height:64}});
const b64 = readFileSync(file).toString('base64');
const png = await p.evaluate(async ({b64,file,x,y,w,h,scale})=>{
  const img=new Image(); img.src='data:image/'+(file.endsWith('.png')?'png':'jpeg')+';base64,'+b64; await img.decode();
  const c=new OffscreenCanvas(w*scale,h*scale); const g=c.getContext('2d');
  g.imageSmoothingEnabled=false;
  g.drawImage(img,x,y,w,h,0,0,w*scale,h*scale);
  const blob=await c.convertToBlob({type:'image/png'});
  const buf=new Uint8Array(await blob.arrayBuffer());
  return Array.from(buf);
},{b64,file,x:+x,y:+y,w:+w,h:+h,scale:+scale});
writeFileSync(out, Buffer.from(png));
console.log(out);
await b.close();
