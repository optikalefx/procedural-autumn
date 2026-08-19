// Calibrate: 2 m slope (what the mask reads today) vs stencil slope at the
// widths TerrainMaterial's relief normals actually use.
import { readFileSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
const b = decodeBake(readFileSync('public/bakes/world-20261018-1536-b52f2ff5.pab').buffer);
const R=b.res, W=b.worldSize, texel=W/R, h=b.height, N=R*R;
const at=(x,y)=>h[Math.min(R-1,Math.max(0,y))*R+Math.min(R-1,Math.max(0,x))];
function slopeAt(x,y,em){ const e=Math.max(1,Math.round(em/texel));
  const gx=(at(x+e,y)-at(x-e,y))/(2*e*texel), gz=(at(x,y+e)-at(x,y-e))/(2*e*texel);
  return Math.hypot(gx,gz); }
const widths=[2,9,16,30,62,90];
const acc=widths.map(()=>[]);
for(let y=50;y<R-50;y+=3) for(let x=50;x<R-50;x+=3){
  const s0=slopeAt(x,y,2); if(h[y*R+x]<110) continue;
  if(s0<0.6||s0>2.6) continue;
  for(let k=0;k<widths.length;k++) acc[k].push(slopeAt(x,y,widths[k]));
}
const q=(a,p)=>{const s=Float64Array.from(a).sort(); return s[Math.floor(p*(s.length-1))];};
console.log('steep samples', acc[0].length);
console.log('width  mean   p10    p50    p90   ripple(RMS of s-sSmooth30)');
for(let k=0;k<widths.length;k++){
  const a=acc[k]; const m=a.reduce((s,v)=>s+v,0)/a.length;
  let rr=0; for(let i=0;i<a.length;i++){const d=a[i]-acc[3][i]; rr+=d*d;}
  console.log(`${String(widths[k]).padStart(4)}m ${m.toFixed(3)} ${q(a,0.1).toFixed(3)} ${q(a,0.5).toFixed(3)} ${q(a,0.9).toFixed(3)}   ${Math.sqrt(rr/a.length).toFixed(3)}`);
}
// How often does the 2 m slope cross a threshold that the 16 m slope does not?
for(const thr of [0.95,1.03,1.15]){
  let flip=0,n=0;
  for(let i=0;i<acc[0].length;i++){ n++; if((acc[0][i]>thr)!==(acc[2][i]>thr)) flip++; }
  console.log(`threshold ${thr}: 2 m and 16 m disagree on ${(100*flip/n).toFixed(1)}% of steep samples`);
}
