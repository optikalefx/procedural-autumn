/** Trace ONE reach frame by frame and dump the state around the stall. */
import { chromium } from 'playwright';
const argv=process.argv.slice(2);const arg=(n,d)=>{const i=argv.indexOf(`--${n}`);return i===-1?d:argv[i+1];};
const X=+arg('x',624), Z=+arg('z',688), SECS=+arg('secs',120);
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
const out = await p.evaluate(async ({X,Z,SECS}) => {
  const w = window.__world;
  const { BoatPhysics } = await import('/src/boat/boat_physics.js');
  const { sdfGrad } = await import('/src/boat/boat_site.js');
  const KAYAK={length:4.2,beam:0.60,draft:0.11};
  const fdir=(x,z)=>{const f=w.getFlow(x,z,{});const m=Math.hypot(f.vx,f.vz);
    return m>1e-4?{x:f.vx/m,z:f.vz/m,m,q:f.q}:null;};
  const f0=fdir(X,Z);
  const ph=new BoatPhysics(w,KAYAK,{maxSpeed:3.8,bobSeed:1});
  ph.place(X,Z,Math.atan2(f0.x,f0.z));
  const dt=1/60; const rows=[]; let px=ph.x,pz=ph.z;
  for(let i=0;i<SECS/dt;i++){
    const t=i*dt;
    const ff=fdir(ph.x,ph.z); let turn=0;
    if(ff&&ff.m>0.15){const want=Math.atan2(ff.x,ff.z);let d=want-ph.heading;
      while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;
      turn=Math.max(-1,Math.min(1,d*1.6));}
    ph.step(dt,t,{fwd:1,back:0,turn});
    if(i%30===0){
      const g=sdfGrad(w,ph.x,ph.z);
      const step=Math.hypot(ph.x-px,ph.z-pz)/0.5;
      rows.push({t:+t.toFixed(1),x:+ph.x.toFixed(0),z:+ph.z.toFixed(0),
        v:+step.toFixed(2), spd:+ph.speed.toFixed(2), sdf:+g.sdf.toFixed(2),
        dep:+ph.depth.toFixed(2), riv:+ph.riverness.toFixed(2),
        cur:+ph.current.toFixed(2), rm:+w.getRiver(ph.x,ph.z).toFixed(2),
        b:ph.beached?1:0});
      px=ph.x; pz=ph.z;
    }
  }
  return rows;
}, {X,Z,SECS});
console.log('t\tx\tz\tv\tspd\tsdf\tdep\triv\tcur\trm\tb');
for(const r of out) console.log(`${r.t}\t${r.x}\t${r.z}\t${r.v}\t${r.spd}\t${r.sdf}\t${r.dep}\t${r.riv}\t${r.cur}\t${r.rm}\t${r.b}`);
await b.close();
