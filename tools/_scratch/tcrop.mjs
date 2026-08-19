import { PNG } from 'pngjs';
import fs from 'node:fs';
const [,,src,X0,Y0,W,H,out,S] = process.argv;
const p = PNG.sync.read(fs.readFileSync(src));
const x0=+X0,y0=+Y0,w=+W,h=+H,scale=+(S||1);
const o = new PNG({width:w*scale, height:h*scale});
for(let y=0;y<h*scale;y++)for(let x=0;x<w*scale;x++){
  const sx=Math.min(p.width-1,x0+Math.floor(x/scale)), sy=Math.min(p.height-1,y0+Math.floor(y/scale));
  const si=(sy*p.width+sx)*4, di=(y*o.width+x)*4;
  o.data[di]=p.data[si];o.data[di+1]=p.data[si+1];o.data[di+2]=p.data[si+2];o.data[di+3]=255;
}
fs.writeFileSync(out, PNG.sync.write(o));
console.log('ok', out);
