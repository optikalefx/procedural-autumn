// A/B the deflute pass: contour-parallel ripple in the SLOPE field on steep faces.
import { TerrainGen } from '../../src/world/TerrainGen.js';
const RES=768, W=3072, texel=W/RES;
function run(off){
  const g=new TerrainGen({res:RES,worldSize:W});
  if(off) g._deflute=()=>{};
  g.height=new Float32Array(RES*RES);g.hardness=new Float32Array(RES*RES);g.sediment=new Float32Array(RES*RES);
  g._tectonic();g._erode(Math.round(RES*RES*0.22));g._relax();
  return g.height;
}
function blur(src,radM){const R=RES,N=R*R,rad=Math.max(1,Math.round(radM/texel)),inv=1/(rad*2+1);
 const cl=v=>v<0?0:v>=R?R-1:v;let a=Float32Array.from(src);const t=new Float32Array(N);
 for(let y=0;y<R;y++){const row=y*R;let s=0;for(let k=-rad;k<=rad;k++)s+=a[row+cl(k)];
  for(let x=0;x<R;x++){t[row+x]=s*inv;s+=a[row+cl(x+rad+1)]-a[row+cl(x-rad)];}}
 for(let x=0;x<R;x++){let s=0;for(let k=-rad;k<=rad;k++)s+=t[cl(k)*R+x];
  for(let y=0;y<R;y++){a[y*R+x]=s*inv;s+=t[cl(y+rad+1)*R+x]-t[cl(y-rad)*R+x];}}
 return a;}
function metric(h){
  const R=RES,N=R*R;
  const sl=(a,e)=>{const o=new Float32Array(N);
    for(let y=e;y<R-e;y++)for(let x=e;x<R-e;x++){const i=y*R+x;
      const gx=(a[i+e]-a[i-e])/(2*e*texel),gz=(a[i+e*R]-a[i-e*R])/(2*e*texel);o[i]=Math.hypot(gx,gz);}
    return o;};
  const s1=sl(h,1), s8=sl(h,8);        // 4 m and 32 m
  let n=0,rr=0,mean=0,relief=0;
  const lp=blur(h,30);
  for(let i=0;i<N;i++){ if(s8[i]<0.7||h[i]<110)continue; const d=s1[i]-s8[i];rr+=d*d;n++;mean+=s1[i];
    const r=h[i]-lp[i]; relief+=r*r; }
  return { steep:n, ripple:+Math.sqrt(rr/n).toFixed(3), meanSlope:+(mean/n).toFixed(3),
           fineRelief:+Math.sqrt(relief/n).toFixed(3) };
}
console.log('OFF', metric(run(true)));
console.log('ON ', metric(run(false)));
