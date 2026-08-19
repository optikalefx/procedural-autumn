// Wavelength of the corrugation: 1-D power spectrum of height sampled along
// the local fall line on steep faces.
import { readFileSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
const b=decodeBake(readFileSync(process.argv[2]).buffer);
const R=b.res,W=b.worldSize,texel=W/R,h=b.height,N=R*R;
function blur(src,radM){const rad=Math.max(1,Math.round(radM/texel)),inv=1/(rad*2+1);
 const cl=v=>v<0?0:v>=R?R-1:v;let a=Float32Array.from(src);const t=new Float32Array(N);
 for(let y=0;y<R;y++){const row=y*R;let s=0;for(let k=-rad;k<=rad;k++)s+=a[row+cl(k)];
  for(let x=0;x<R;x++){t[row+x]=s*inv;s+=a[row+cl(x+rad+1)]-a[row+cl(x-rad)];}}
 for(let x=0;x<R;x++){let s=0;for(let k=-rad;k<=rad;k++)s+=t[cl(k)*R+x];
  for(let y=0;y<R;y++){a[y*R+x]=s*inv;s+=t[cl(y+rad+1)*R+x]-t[cl(y-rad)*R+x];}}
 return a;}
const dir=blur(h,60);
const bil=(a,gx,gy)=>{gx=Math.min(R-1.001,Math.max(0,gx));gy=Math.min(R-1.001,Math.max(0,gy));
 const x=gx|0,y=gy|0,fx=gx-x,fy=gy-y,i=y*R+x;
 return a[i]*(1-fx)*(1-fy)+a[i+1]*fx*(1-fy)+a[i+R]*(1-fx)*fy+a[i+R+1]*fx*fy;};
const M=64;                       // samples per transect, 2 m apart = 128 m
const pw=new Float64Array(M/2); let cnt=0;
for(let y=60;y<R-60;y+=7)for(let x=60;x<R-60;x+=7){
  const i=y*R+x;
  const gx=(h[i+1]-h[i-1])/(2*texel),gz=(h[i+R]-h[i-R])/(2*texel);
  if(Math.hypot(gx,gz)<0.9||h[i]<110)continue;
  const dx=dir[i+1]-dir[i-1],dz=dir[i+R]-dir[i-R];const L=Math.hypot(dx,dz);if(L<1e-5)continue;
  const ux=dx/L,uz=dz/L;
  const t=new Float64Array(M);
  for(let k=0;k<M;k++) t[k]=bil(h,x+ux*(k-M/2),y+uz*(k-M/2));
  // detrend + hann
  let m=0;for(let k=0;k<M;k++)m+=t[k];m/=M;
  const s0=t[0]-m,s1=t[M-1]-m;
  for(let k=0;k<M;k++){const lin=s0+(s1-s0)*k/(M-1);t[k]=(t[k]-m-lin)*(0.5-0.5*Math.cos(2*Math.PI*k/(M-1)));}
  for(let f=1;f<M/2;f++){let re=0,im=0;
    for(let k=0;k<M;k++){const a=-2*Math.PI*f*k/M;re+=t[k]*Math.cos(a);im+=t[k]*Math.sin(a);}
    pw[f]+=(re*re+im*im);}
  cnt++;
}
console.log('transects',cnt);
console.log('lambda(m)  power');
for(let f=1;f<M/2;f++){const lam=M*texel/f; if(lam<4||lam>90)continue;
  console.log(lam.toFixed(1).padStart(7), (pw[f]/cnt).toExponential(2));}
