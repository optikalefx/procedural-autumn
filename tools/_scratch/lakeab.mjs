/**
 * Lake regression A/B for the river physics change.
 *
 * Runs the SHIPPING BoatPhysics and a pristine copy of the base commit's
 * (tools/_scratch/boat_physics.base.js) through identical scripted paddles on
 * identical LAKE launch sites, in one page load, and reports any divergence.
 * Lake behaviour is meant to be untouched: riverness is 0 on standing water,
 * which zeroes the current, the weathercock, the trim and the float floor, so
 * the two models should agree to within floating-point noise.
 *
 *   node tools/_scratch/lakeab.mjs [--secs 60] [--n 12]
 */
import { chromium } from 'playwright';
import { materialiseBase } from './_baseof.mjs';
const BASE = materialiseBase('src/boat/boat_physics.js', 'boat_physics');
console.log('baseline:', BASE.ref.slice(0,8));

const argv=process.argv.slice(2);const arg=(n,d)=>{const i=argv.indexOf(`--${n}`);return i===-1?d:argv[i+1];};
const SECS=+arg('secs',60), NT=+arg('n',12);
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5263';
const SEED = process.env.SEED || '20261018';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 500, height: 400 } });
p.on('pageerror', e => console.log('ERR', e.message));
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState:3, url, close(){}, send(){}, addEventListener(){}, removeEventListener(){},
        set onopen(_){}, set onclose(_){}, set onerror(_){}, set onmessage(_){} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype; Object.assign(window.WebSocket, RealWS);
});
console.log('booting…');
await p.goto(`${URL}/?seed=${SEED}&car=camper&res=768`, { timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
const out = await p.evaluate(async ({SECS,NT,BASEURL}) => {
  const w = window.__world;
  const NEW = (await import('/src/boat/boat_physics.js')).BoatPhysics;
  const OLD = (await import(BASEURL)).BoatPhysics;
  const { shoreSnap, validateLaunch } = await import('/src/boat/boat_site.js');
  const CANOE={length:5.0,beam:0.90,draft:0.15}, KAYAK={length:4.2,beam:0.60,draft:0.11};

  // Real LAKE launch sites: whatever the shipping gate accepts on still water.
  const picks=[];
  for(let x=-1200;x<=1200 && picks.length<NT;x+=20)for(let z=-1200;z<=1200 && picks.length<NT;z+=20){
    if(!w.isInBounds(x,z))continue;
    const s0=w.getHydro(x,z).sdf; if(s0<-6||s0>2)continue;
    const s=shoreSnap(w,x,z);
    if(w.getRiver(s.x,s.z)>0.05)continue;              // lakes only
    const v=validateLaunch(w,x,z,null);
    if(!v.ok)continue;
    if(picks.some(q=>Math.hypot(q.x-v.x,q.z-v.z)<160))continue;
    picks.push({x:v.x,z:v.z,heading:v.heading});
  }

  // A deterministic scripted paddle: some straight, some hard turns, some
  // deliberate runs at the shore. Identical for both models.
  const script=(i,t)=>{
    const ph=(t+i*3.1)%24;
    if(ph<6)  return {fwd:1,back:0,turn:0};
    if(ph<10) return {fwd:1,back:0,turn:0.9};
    if(ph<14) return {fwd:1,back:0,turn:-0.9};
    if(ph<18) return {fwd:1,back:0,turn:0.25};
    if(ph<21) return {fwd:0,back:1,turn:0};
    return {fwd:1,back:0,turn:-0.35};
  };
  const run=(Klass,dim,pk,i)=>{
    const ph=new Klass(w,dim,{maxSpeed:dim===KAYAK?3.8:3.2,bobSeed:1});
    ph.place(pk.x,pk.z,pk.heading);
    const dt=1/60; let dist=0,px=ph.x,pz=ph.z,beaches=0,wasB=false,maxRiv=0,maxCur=0,wedgeFrames=0,maxRm=0;
    for(let k=0;k<SECS/dt;k++){
      ph.step(dt,k*dt,script(i,k*dt));
      dist+=Math.hypot(ph.x-px,ph.z-pz); px=ph.x; pz=ph.z;
      if(ph.beached&&!wasB)beaches++; wasB=ph.beached;
      maxRiv=Math.max(maxRiv,ph.riverness??0); maxCur=Math.max(maxCur,ph.current??0);
      if((ph._wedgeT??0)>0)wedgeFrames++;
      maxRm=Math.max(maxRm,w.getRiver(ph.x,ph.z));
    }
    return {x:ph.x,z:ph.z,heading:ph.heading,speed:ph.speed,dist,beaches,beached:ph.beached,
      maxRiv:+maxRiv.toFixed(3),maxCur:+maxCur.toFixed(3),wedgeFrames,maxRm:+maxRm.toFixed(3)};
  };
  const rows=[];
  for(let i=0;i<picks.length;i++)for(const [nm,dim] of [['canoe',CANOE],['kayak',KAYAK]]){
    const a=run(OLD,dim,picks[i],i), b2=run(NEW,dim,picks[i],i);
    rows.push({site:i,kind:nm,
      dPos:+Math.hypot(a.x-b2.x,a.z-b2.z).toFixed(4),
      dDist:+(b2.dist-a.dist).toFixed(4),
      dHead:+Math.abs(a.heading-b2.heading).toFixed(4),
      beaches:[a.beaches,b2.beaches], beached:[a.beached,b2.beached],
      maxRiv:b2.maxRiv, maxCur:b2.maxCur, maxRiverMask:b2.maxRm,
      wedgeFrames:[a.wedgeFrames,b2.wedgeFrames]});
  }
  const worst=rows.slice().sort((u,v)=>v.dPos-u.dPos)[0];
  return { sites:picks.length, runs:rows.length,
    maxPosDivergence_m:+Math.max(...rows.map(r=>r.dPos)).toFixed(4),
    maxDistDivergence_m:+Math.max(...rows.map(r=>Math.abs(r.dDist))).toFixed(4),
    maxHeadingDivergence_rad:+Math.max(...rows.map(r=>r.dHead)).toFixed(4),
    beachCountMismatches: rows.filter(r=>r.beaches[0]!==r.beaches[1]).length,
    beachedStateMismatches: rows.filter(r=>r.beached[0]!==r.beached[1]).length,
    worst, rows: rows.filter(r=>r.dPos>0.01) };
}, {SECS,NT,BASEURL:BASE.url});
console.log(JSON.stringify(out,null,1));
await b.close();
