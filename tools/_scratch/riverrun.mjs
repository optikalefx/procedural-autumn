/**
 * Paddle a kayak down real river reaches and report what the SHIPPING physics
 * actually did — distance made good, and the river state it published.
 *
 *   node tools/_scratch/riverrun.mjs [--secs 120] [--n 8] [--fwd 1] [--drift]
 *
 * --drift paddles nothing: pure current, which is the "does a river carry a
 * boat" question on its own.
 */
import { chromium } from 'playwright';
const argv=process.argv.slice(2);const arg=(n,d)=>{const i=argv.indexOf(`--${n}`);return i===-1?d:argv[i+1];};
const has=(n)=>argv.includes(`--${n}`);
const SECS=+arg('secs',120), NT=+arg('n',8), FWD=has('drift')?0:+arg('fwd',1);
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5262';
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
const out = await p.evaluate(async ({SECS,NT,FWD}) => {
  const w = window.__world;
  const { BoatPhysics } = await import('/src/boat/boat_physics.js');
  const { sdfGrad } = await import('/src/boat/boat_site.js');
  const KAYAK={length:4.2,beam:0.60,draft:0.11};
  const fdir=(x,z)=>{const f=w.getFlow(x,z,{});const m=Math.hypot(f.vx,f.vz);
    return m>1e-4?{x:f.vx/m,z:f.vz/m,m,q:f.q}:null;};
  // Pick MID-REACH launch points, not river mouths. Sorting candidates by sdf
  // picks the widest water on the mask, which is exactly where a channel opens
  // into a lake — the first cut of this harness launched every boat at a mouth
  // and then scored it on lake paddling. Score a candidate by how much CHANNEL
  // lies downstream of it instead: walk the flow 4 m at a time and count how
  // far the river mask holds up.
  const reachLen=(x,z)=>{
    let px=x,pz=z,len=0;
    for(let i=0;i<60;i++){
      const f=fdir(px,pz); if(!f||f.m<0.15)break;
      px+=f.x*4; pz+=f.z*4;
      if(!w.isInBounds(px,pz))break;
      if(w.getRiver(px,pz)<0.20)break;
      len+=4;
    }
    return len;
  };
  const cands=[];
  for(let x=-1200;x<=1200;x+=16)for(let z=-1200;z<=1200;z+=16){
    if(!w.isInBounds(x,z))continue;
    if(w.getRiver(x,z)<0.5)continue;
    const h=w.getHydro(x,z); if(h.sdf<1.5)continue;
    const f=fdir(x,z); if(!f||f.m<0.4)continue;
    const rl=reachLen(x,z); if(rl<120)continue;
    cands.push({x,z,sdf:h.sdf,reach:rl});
  }
  cands.sort((a,c)=>c.reach-a.reach);
  const picks=[];
  for(const c of cands){if(picks.length>=NT)break;
    if(picks.some(q=>Math.hypot(q.x-c.x,q.z-c.z)<200))continue;picks.push(c);}

  const qq=(a,pc)=>{if(!a.length)return null;const s=a.slice().sort((u,v)=>u-v);return +s[Math.floor((s.length-1)*pc)].toFixed(2);};
  const runs=[];
  for(const pk of picks){
    const f0=fdir(pk.x,pk.z);
    const ph=new BoatPhysics(w,KAYAK,{maxSpeed:3.8,bobSeed:1});
    ph.place(pk.x,pk.z,Math.atan2(f0.x,f0.z));
    const dt=1/60; let dist=0,px=ph.x,pz=ph.z;
    const sdfs=[],deps=[],spds=[],rivs=[],curs=[],pits=[];
    let beachWhy=null; let stuck=0, worstStuck=0, onRiverFrames=0, N=Math.round(SECS/dt);
    for(let i=0;i<N;i++){
      const t=i*dt;
      const ff=fdir(ph.x,ph.z);
      let turn=0;
      if(FWD>0&&ff&&ff.m>0.15){const want=Math.atan2(ff.x,ff.z);let d=want-ph.heading;
        while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;
        turn=Math.max(-1,Math.min(1,d*1.6));}
      const wasB=ph.beached;
      ph.step(dt,t,{fwd:FWD,back:0,turn});
      if(!wasB&&ph.beached&&beachWhy===null){
        beachWhy={t:+t.toFixed(1), depth:+ph.depth.toFixed(2), riv:+ph.riverness.toFixed(2),
          cur:+ph.current.toFixed(2), shallow: ph.depth < KAYAK.draft+0.15,
          pin:+(ph._pinT??0).toFixed(2), river:+w.getRiver(ph.x,ph.z).toFixed(2)};
      }
      const step=Math.hypot(ph.x-px,ph.z-pz); dist+=step; px=ph.x; pz=ph.z;
      if(step/dt<0.2){stuck+=dt; worstStuck=Math.max(worstStuck,stuck);} else stuck=0;
      const g=sdfGrad(w,ph.x,ph.z);
      sdfs.push(g.sdf); deps.push(ph.depth); spds.push(Math.abs(ph.speed));
      rivs.push(ph.riverness); curs.push(ph.current); pits.push(ph.pitch);
      if(w.getRiver(ph.x,ph.z)>0.15)onRiverFrames++;
    }
    runs.push({from:[Math.round(pk.x),Math.round(pk.z)], reach:pk.reach,
      travelled:+dist.toFixed(0), avgSpeed:+(dist/SECS).toFixed(2),
      longestStuckSec:+worstStuck.toFixed(1),
      onRiverPct:+(onRiverFrames/N).toFixed(2),
      sdf:{p05:qq(sdfs,.05),p50:qq(sdfs,.5),p95:qq(sdfs,.95)},
      depth:{p05:qq(deps,.05),p50:qq(deps,.5)},
      speed:{p50:qq(spds,.5)}, riverness:{p50:qq(rivs,.5)}, current:{p50:qq(curs,.5)},
      pitchDegP95:+(qq(pits.map(Math.abs),.95)*180/Math.PI).toFixed(1),
      endBeached:ph.beached, beachWhy});
  }
  const T=runs.map(r=>r.travelled).sort((a,c)=>a-c);
  return { mode: FWD>0?'paddling':'drifting', seconds:SECS,
    medianTravel:T[runs.length>>1], minTravel:T[0], maxTravel:T[T.length-1],
    everStuckOver5s: runs.filter(r=>r.longestStuckSec>5).length,
    beached: runs.filter(r=>r.endBeached).length,
    runs };
}, {SECS,NT,FWD});
console.log(JSON.stringify(out,null,1));
await b.close();
