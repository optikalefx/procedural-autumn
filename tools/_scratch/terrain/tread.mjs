// "Locally gentle but regionally steep" = a tread cut into a wall. Does that
// conjunction separate the contour ribbons from honest hillside meadow, and is
// it stable across the 62-96 m range the coarse stencil actually spans?
import { readFileSync, readdirSync } from 'node:fs';
import { decodeBake } from '../../../src/world/bakeFormat.js';
const f = readdirSync('public/bakes').filter(n=>n.includes('-1536-'))[0];
const b = decodeBake(readFileSync('public/bakes/'+f).buffer);
const R=b.res, W=b.worldSize, texel=W/R, h=b.height, sl=b.slope;
const at=(x,y)=>h[Math.min(R-1,Math.max(0,y))*R+Math.min(R-1,Math.max(0,x))];
const ats=(x,y)=>sl[Math.min(R-1,Math.max(0,y))*R+Math.min(R-1,Math.max(0,x))];
const ss=(a,bb,v)=>{const t=Math.min(1,Math.max(0,(v-a)/(bb-a)));return t*t*(3-2*t);};
const rA=Math.round(11/texel), rB=Math.round(17/texel);
const LP=(x,y)=>ats(x,y)*0.20+(ats(x+rA,y)+ats(x-rA,y)+ats(x,y+rA)+ats(x,y-rA))*0.11
  +(ats(x+rB,y+rB)+ats(x-rB,y-rB)+ats(x+rB,y-rB)+ats(x-rB,y+rB))*0.09;
const wide=(x,y,em)=>{const e=Math.max(1,Math.round(em/texel));
  return Math.hypot((at(x+e,y)-at(x-e,y))/(2*e*texel),(at(x,y+e)-at(x,y-e))/(2*e*texel));};
const D=Math.round(40/texel);
const grid=new Uint8Array(R*R), valid=new Uint8Array(R*R), steepA=new Float32Array(R*R);
for(let y=30;y<R-30;y++)for(let x=30;x<R-30;x++){
  const alt=at(x,y); if(alt<70) continue; valid[y*R+x]=1;
  const lp=LP(x,y), alpine=ss(120,250,alt), soil=0.72+(0.51-0.72)*alpine;
  const st=ss(soil,soil+0.72,lp); steepA[y*R+x]=st;
  if(st*1.26-0.20+ss(232,330,alt)*0.34<0.44) grid[y*R+x]=1;
}
for(const em of [62,80,96]){
  const rib=[],blob=[],rock=[];
  for(let y=30+D;y<R-30-D;y+=2)for(let x=30+D;x<R-30-D;x+=2){
    if(!valid[y*R+x])continue;
    const t=(1-steepA[y*R+x])*wide(x,y,em);
    if(!grid[y*R+x]){rock.push(t);continue;}
    const gx=at(x+1,y)-at(x-1,y),gz=at(x,y+1)-at(x,y-1),m=Math.hypot(gx,gz)||1;
    const up=grid[(y+Math.round(gz/m*D))*R+(x+Math.round(gx/m*D))];
    const dn=grid[(y-Math.round(gz/m*D))*R+(x-Math.round(gx/m*D))];
    (!up&&!dn?rib:blob).push(t);
  }
  const q=(a,p)=>{const s=Float64Array.from(a).sort();return s[Math.floor(p*(s.length-1))];};
  console.log(`stencil ${em} m — (1-steep)*regional|grad|`);
  console.log(`  ribbon   p25 ${q(rib,0.25).toFixed(3)} p50 ${q(rib,0.5).toFixed(3)} p75 ${q(rib,0.75).toFixed(3)}`);
  console.log(`  hillside p25 ${q(blob,0.25).toFixed(3)} p50 ${q(blob,0.5).toFixed(3)} p75 ${q(blob,0.75).toFixed(3)}`);
  for (const thr of [0.35,0.5,0.65]) {
    const fr=rib.filter(v=>v>thr).length/rib.length, fb=blob.filter(v=>v>thr).length/blob.length;
    console.log(`    > ${thr}: ${(100*fr).toFixed(0)}% of ribbon, ${(100*fb).toFixed(0)}% of hillside`);
  }
}
