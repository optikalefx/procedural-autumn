import { TerrainGen } from '../../src/world/TerrainGen.js';
const R=256, W=512;                     // 2 m texels
const g=new TerrainGen({res:R, worldSize:W});
const N=R*R;
g.massifW=new Float32Array(N).fill(1);
const h=new Float32Array(N), slope=new Float32Array(N);
// plane sloping in +x at 45 deg + contour-parallel ripple of 20 m, amp 2 m
for(let y=0;y<R;y++)for(let x=0;x<R;x++){const i=y*R+x;
  h[i]= x*2*1.0 + 2.0*Math.sin(x*2*2*Math.PI/20);}
for(let y=1;y<R-1;y++)for(let x=1;x<R-1;x++){const i=y*R+x;
  const gx=(h[i+1]-h[i-1])/4, gz=(h[i+R]-h[i-R])/4; slope[i]=Math.hypot(gx,gz);}
const before=Float32Array.from(h);
g._deflute(h);
let a=0,b=0,n=0;
for(let y=40;y<R-40;y++)for(let x=40;x<R-40;x++){const i=y*R+x;
  // ripple amplitude estimate: deviation from a local 40 m mean along x
  let m=0; for(let k=-10;k<=10;k++) m+=before[i+k]; m/=21;
  let m2=0; for(let k=-10;k<=10;k++) m2+=h[i+k]; m2/=21;
  a+=(before[i]-m)**2; b+=(h[i]-m2)**2; n++;}
console.log('ripple RMS before', Math.sqrt(a/n).toFixed(3), 'after', Math.sqrt(b/n).toFixed(3));
