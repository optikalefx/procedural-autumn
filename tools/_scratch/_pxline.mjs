import { readPNG } from '../_pngread.mjs';
const img = readPNG(process.argv[2]); const {w:W,px}=img;
// args: x0,y0 x1,y1 halfwidth nsamples
const [a,b] = process.argv.slice(3,5).map(s=>s.split(',').map(Number));
const HW = Number(process.argv[5]||14), N = Number(process.argv[6]||8);
for(let k=0;k<=N;k++){
  const t=k/N, x=Math.round(a[0]+(b[0]-a[0])*t), y=Math.round(a[1]+(b[1]-a[1])*t);
  let best=null, dark=null;
  for(let d=-HW;d<=HW;d++){
    const i=y*W+(x+d); const r=px[i*3],g=px[i*3+1],bb=px[i*3+2];
    const l=0.2126*r+0.7152*g+0.0722*bb;
    if(!best||l>best.l)best={d,r,g,b:bb,l};
    if(!dark||l<dark.l)dark={d,r,g,b:bb,l};
  }
  console.log(`  t=${t.toFixed(2)} (${x},${y})  brightest ${best.r},${best.g},${best.b} luma ${best.l.toFixed(1)} @dx${best.d}   darkest ${dark.r},${dark.g},${dark.b} luma ${dark.l.toFixed(1)}`);
}
