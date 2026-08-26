import { readPNG } from '../_pngread.mjs';
const img = readPNG(process.argv[2]); const {w:W,px}=img;
for (const spec of process.argv.slice(3)) {
  const [x,y,r]=spec.split(',').map(Number);
  const R=r||0; let n=0,a=0,b=0,c=0,mx=0;
  for(let dy=-R;dy<=R;dy++)for(let dx=-R;dx<=R;dx++){
    const i=(y+dy)*W+(x+dx); n++; a+=px[i*3];b+=px[i*3+1];c+=px[i*3+2];
    const l=0.2126*px[i*3]+0.7152*px[i*3+1]+0.0722*px[i*3+2]; if(l>mx)mx=l;
  }
  const L=0.2126*a/n+0.7152*b/n+0.0722*c/n;
  console.log(`  (${x},${y})±${R}  mean rgb ${(a/n).toFixed(0)},${(b/n).toFixed(0)},${(c/n).toFixed(0)}   luma ${L.toFixed(1)}  peak ${mx.toFixed(1)}`);
}
