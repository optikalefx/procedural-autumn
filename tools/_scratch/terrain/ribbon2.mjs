// Does folding drainage CURVATURE into the grass/rock line break the contour
// ribbons? A gully runs down a flank, so a curvature term is vertical
// structure — the one thing a slope-and-altitude line cannot have.
import { readFileSync, readdirSync } from 'node:fs';
import { decodeBake } from '../../../src/world/bakeFormat.js';
const f = readdirSync('public/bakes').filter(n => n.includes('-1536-'))[0];
const b = decodeBake(readFileSync('public/bakes/' + f).buffer);
const R = b.res, W = b.worldSize, texel = W/R, h = b.height, sl = b.slope;
const at  = (x,y) => h[Math.min(R-1,Math.max(0,y))*R + Math.min(R-1,Math.max(0,x))];
const ats = (x,y) => sl[Math.min(R-1,Math.max(0,y))*R + Math.min(R-1,Math.max(0,x))];
const ss = (a,bb,v) => { const t = Math.min(1,Math.max(0,(v-a)/(bb-a))); return t*t*(3-2*t); };
const rA = Math.round(11/texel), rB = Math.round(17/texel);
const LP = (x,y) => ats(x,y)*0.20
  + (ats(x+rA,y)+ats(x-rA,y)+ats(x,y+rA)+ats(x,y-rA))*0.11
  + (ats(x+rB,y+rB)+ats(x-rB,y-rB)+ats(x+rB,y-rB)+ats(x-rB,y+rB))*0.09;
// the shader's curv, at the clamped far-field stencil (30 m fine / 96 m coarse)
function curvAt(x,y,sm){ const e=Math.max(1,Math.round(sm/texel));
  return ((at(x-e,y)+at(x+e,y)+at(x,y-e)+at(x,y+e))*0.25 - at(x,y)) / (sm*0.42); }
const sc = (v,k) => v/(1+Math.abs(v)*k);

function run(kCurv, label) {
  const grid = new Uint8Array(R*R), valid = new Uint8Array(R*R);
  for (let y=30;y<R-30;y++) for (let x=30;x<R-30;x++) {
    const alt = at(x,y); if (alt < 150) continue;
    valid[y*R+x]=1;
    const lp = LP(x,y);
    const alpine = ss(120,250,alt), soilHold = 0.72+(0.51-0.72)*alpine;
    const steep = ss(soilHold, soilHold+0.72, lp);
    const curv = sc(curvAt(x,y,96),0.85)*0.20 + sc(curvAt(x,y,30),0.55)*0.80;
    const rockBase = steep*1.26 - 0.20 + ss(232,330,alt)*0.34 - curv*kCurv;
    if (rockBase < 0.44) grid[y*R+x]=1;
  }
  const D = Math.round(40/texel);
  let grass=0, ribbon=0, tot=0;
  for (let y=30+D;y<R-30-D;y+=2) for (let x=30+D;x<R-30-D;x+=2) {
    if (!valid[y*R+x]) continue; tot++;
    if (!grid[y*R+x]) continue; grass++;
    const gx=at(x+1,y)-at(x-1,y), gz=at(x,y+1)-at(x,y-1), m=Math.hypot(gx,gz)||1;
    const up=grid[(y+Math.round(gz/m*D))*R + (x+Math.round(gx/m*D))];
    const dn=grid[(y-Math.round(gz/m*D))*R + (x-Math.round(gx/m*D))];
    if (!up && !dn) ribbon++;
  }
  console.log(`${label.padEnd(16)} grass ${(100*grass/tot).toFixed(1)}%  ribbon ${(100*ribbon/Math.max(1,grass)).toFixed(1)}% of grass  = ${(100*ribbon/tot).toFixed(2)}% of massif`);
}
for (const k of [0, 0.3, 0.6, 1.0, 1.6, 2.4]) run(k, `curv x${k}`);
