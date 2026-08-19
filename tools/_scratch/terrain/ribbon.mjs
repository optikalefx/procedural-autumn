// How much of the massif grass is a thin CONTOUR RIBBON (grass sandwiched
// between rock up-slope and down-slope) rather than a real hillside blob?
// Sweep the width of the low-pass the grass/rock line reads its slope through.
import { readFileSync, readdirSync } from 'node:fs';
import { decodeBake } from '../../../src/world/bakeFormat.js';
const f = readdirSync('public/bakes').filter(n => n.includes('-1536-'))[0];
const b = decodeBake(readFileSync('public/bakes/' + f).buffer);
const R = b.res, W = b.worldSize, texel = W / R, h = b.height, sl = b.slope;
const at  = (x,y) => h[Math.min(R-1,Math.max(0,y))*R + Math.min(R-1,Math.max(0,x))];
const ats = (x,y) => sl[Math.min(R-1,Math.max(0,y))*R + Math.min(R-1,Math.max(0,x))];
const ss = (a,bb,v) => { const t = Math.min(1,Math.max(0,(v-a)/(bb-a))); return t*t*(3-2*t); };

function makeLP(r1m, r2m) {
  const rA = Math.max(1, Math.round(r1m/texel)), rB = Math.max(1, Math.round(r2m/texel));
  return (x,y) => ats(x,y)*0.20
    + (ats(x+rA,y)+ats(x-rA,y)+ats(x,y+rA)+ats(x,y-rA))*0.11
    + (ats(x+rB,y+rB)+ats(x-rB,y-rB)+ats(x+rB,y-rB)+ats(x-rB,y+rB))*0.09;
}
function run(r1, r2, scale, label) {
  const LP = makeLP(r1, r2);
  const grid = new Uint8Array(R*R);          // 1 = grass
  const valid = new Uint8Array(R*R);
  for (let y=30;y<R-30;y+=1) for (let x=30;x<R-30;x+=1) {
    const alt = at(x,y); if (alt < 150) continue;
    valid[y*R+x] = 1;
    const lp = LP(x,y) * scale;
    const alpine = ss(120,250,alt);
    const soilHold = 0.72 + (0.51-0.72)*alpine;
    const steep = ss(soilHold, soilHold+0.72, lp);
    const rockBase = steep*1.26 - 0.20 + ss(232,330,alt)*0.34;
    if (rockBase < 0.44) grid[y*R+x] = 1;
  }
  // ribbon test: walk up and down the local height gradient; grass sandwiched
  // by rock within 40 m both ways is a contour band.
  const D = Math.round(40/texel);
  let grass=0, ribbon=0, tot=0;
  for (let y=30+D;y<R-30-D;y+=2) for (let x=30+D;x<R-30-D;x+=2) {
    if (!valid[y*R+x]) continue; tot++;
    if (!grid[y*R+x]) continue; grass++;
    const gx = at(x+1,y)-at(x-1,y), gz = at(x,y+1)-at(x,y-1);
    const m = Math.hypot(gx,gz) || 1;
    const ux = gx/m, uz = gz/m;
    const up = grid[(y+Math.round(uz*D))*R + (x+Math.round(ux*D))];
    const dn = grid[(y-Math.round(uz*D))*R + (x-Math.round(ux*D))];
    if (!up && !dn) ribbon++;
  }
  console.log(`${label.padEnd(26)} grass ${(100*grass/tot).toFixed(1)}%  of that, contour-ribbon ${(100*ribbon/Math.max(1,grass)).toFixed(1)}%  (ribbon = ${(100*ribbon/tot).toFixed(1)}% of massif)`);
}
run(11, 17, 1.0, 'current 11/17 m');
run(20, 32, 1.0, '20/32 m');
run(28, 46, 1.0, '28/46 m');
run(40, 66, 1.0, '40/66 m');
run(56, 92, 1.0, '56/92 m');
