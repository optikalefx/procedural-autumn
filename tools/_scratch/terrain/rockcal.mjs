// Reproduce the shader's grass/rock decision on the bake and measure where a
// gold ribbon can be drawn on a massif, plus what a regional (wide) slope term
// would do about it.
import { readFileSync, readdirSync } from 'node:fs';
import { decodeBake } from '../../../src/world/bakeFormat.js';
const f = readdirSync('public/bakes').filter(n => n.includes('-1536-'))[0];
const b = decodeBake(readFileSync('public/bakes/' + f).buffer);
const R = b.res, W = b.worldSize, texel = W / R, h = b.height, sl = b.slope;
console.log('bake', f, 'res', R, 'worldSize', W, 'texel', texel.toFixed(2));
const at  = (x, y) => h[Math.min(R-1,Math.max(0,y))*R + Math.min(R-1,Math.max(0,x))];
const ats = (x, y) => sl[Math.min(R-1,Math.max(0,y))*R + Math.min(R-1,Math.max(0,x))];

// the shader's slopeLP: 8 taps, rings at 11 m and 17 m, weights .20/.11x4/.09x4
const rA = Math.max(1, Math.round(11 / texel)), rB = Math.max(1, Math.round(17 / texel));
function slopeLP(x, y) {
  return ats(x,y)*0.20
    + (ats(x+rA,y)+ats(x-rA,y)+ats(x,y+rA)+ats(x,y-rA))*0.11
    + (ats(x+rB,y+rB)+ats(x-rB,y-rB)+ats(x+rB,y-rB)+ats(x-rB,y+rB))*0.09;
}
// candidate regional slope: |grad| of the height field over a wide stencil
function slopeWide(x, y, em) {
  const e = Math.max(1, Math.round(em / texel));
  const gx = (at(x+e,y)-at(x-e,y))/(2*e*texel), gz = (at(x,y+e)-at(x,y-e))/(2*e*texel);
  return Math.hypot(gx, gz);
}
const ss = (a, bb, v) => { const t = Math.min(1, Math.max(0, (v-a)/(bb-a))); return t*t*(3-2*t); };

const bins = new Map();
let n = 0, gold = 0;
const goldByAlt = new Array(9).fill(0), totByAlt = new Array(9).fill(0);
const wideAtGold = [], wideAtRock = [];
for (let y = 40; y < R-40; y += 2) for (let x = 40; x < R-40; x += 2) {
  const alt = at(x, y);
  if (alt < 150) continue;                       // massif ground only
  const lp = slopeLP(x, y);
  const alpine = ss(120, 250, alt);
  const soilHold = 0.72 + (0.51-0.72)*alpine;
  const steep = ss(soilHold, soilHold+0.72, lp);
  // rockBase without the noise breakers (altWarp mean == alt)
  const rockBase = steep*1.26 - 0.20 + ss(232, 330, alt)*0.34;
  n++;
  const isGold = rockBase < 0.44;
  if (isGold) gold++;
  const bi = Math.min(8, Math.floor((alt-150)/25));
  totByAlt[bi]++; if (isGold) goldByAlt[bi]++;
  const w = slopeWide(x, y, 64);
  (isGold ? wideAtGold : wideAtRock).push(w);
  const key = isGold ? 'gold' : 'rock';
  const e = bins.get(key) || { n:0, lp:0, alt:0 };
  e.n++; e.lp += lp; e.alt += alt; bins.set(key, e);
}
console.log(`samples above 150 m: ${n}, painted GRASS: ${gold} (${(100*gold/n).toFixed(1)}%)`);
for (const [k,v] of bins) console.log(`  ${k}: n=${v.n} meanSlopeLP=${(v.lp/v.n).toFixed(3)} meanAlt=${(v.alt/v.n).toFixed(0)}`);
console.log('grass share by altitude band (25 m bands from 150 m):');
for (let i=0;i<9;i++) if (totByAlt[i]) console.log(`  ${150+i*25}-${175+i*25} m: ${(100*goldByAlt[i]/totByAlt[i]).toFixed(1)}%  (n=${totByAlt[i]})`);
const q = (a,p) => { const s = Float64Array.from(a).sort(); return s[Math.floor(p*(s.length-1))]; };
if (wideAtGold.length && wideAtRock.length) {
  console.log('regional |grad| at 64 m stencil:');
  console.log(`  on GRASS pixels: p10 ${q(wideAtGold,0.1).toFixed(3)} p50 ${q(wideAtGold,0.5).toFixed(3)} p90 ${q(wideAtGold,0.9).toFixed(3)}`);
  console.log(`  on ROCK  pixels: p10 ${q(wideAtRock,0.1).toFixed(3)} p50 ${q(wideAtRock,0.5).toFixed(3)} p90 ${q(wideAtRock,0.9).toFixed(3)}`);
}

// Does a REGIONAL slope separate ribbon grass (a band on a wall) from
// hillside grass (a blob on a flank)?
{
  const D = Math.round(40/texel);
  const ss2 = ss;
  const grid = new Uint8Array(R*R), valid = new Uint8Array(R*R);
  for (let y=30;y<R-30;y++) for (let x=30;x<R-30;x++) {
    const alt = at(x,y); if (alt < 90) continue;
    valid[y*R+x]=1;
    const lp = slopeLP(x,y);
    const alpine = ss2(120,250,alt), soilHold = 0.72+(0.51-0.72)*alpine;
    const steep = ss2(soilHold, soilHold+0.72, lp);
    if (steep*1.26 - 0.20 + ss2(232,330,alt)*0.34 < 0.44) grid[y*R+x]=1;
  }
  const rib=[], blob=[], rock=[];
  for (let y=30+D;y<R-30-D;y+=2) for (let x=30+D;x<R-30-D;x+=2) {
    if (!valid[y*R+x]) continue;
    const w = slopeWide(x,y,80);
    if (!grid[y*R+x]) { rock.push(w); continue; }
    const gx=at(x+1,y)-at(x-1,y), gz=at(x,y+1)-at(x,y-1), m=Math.hypot(gx,gz)||1;
    const up=grid[(y+Math.round(gz/m*D))*R+(x+Math.round(gx/m*D))];
    const dn=grid[(y-Math.round(gz/m*D))*R+(x-Math.round(gx/m*D))];
    (!up && !dn ? rib : blob).push(w);
  }
  const q=(a,p)=>{const s=Float64Array.from(a).sort();return s[Math.floor(p*(s.length-1))];};
  const rep=(n,a)=>console.log(`  ${n.padEnd(14)} n=${String(a.length).padStart(7)} p10 ${q(a,0.1).toFixed(3)} p25 ${q(a,0.25).toFixed(3)} p50 ${q(a,0.5).toFixed(3)} p75 ${q(a,0.75).toFixed(3)} p90 ${q(a,0.9).toFixed(3)}`);
  console.log('regional |grad| over an 80 m stencil, ground above 90 m:');
  rep('ribbon grass', rib); rep('hillside grass', blob); rep('rock', rock);
}
