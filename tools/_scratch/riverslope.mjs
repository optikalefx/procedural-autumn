/** River surface slope along the flow, and river-mask vs sdf near banks. */
import { chromium } from 'playwright';
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
const out = await p.evaluate(() => {
  const w = window.__world;
  const flowDir=(x,z)=>{if(!w.flowVX)return null;const R=w.res,half=w.half;
    const gx=Math.round((x+half)/(half*2)*(R-1)),gz=Math.round((z+half)/(half*2)*(R-1));
    const i=Math.max(0,Math.min(R*R-1,gz*R+gx));const vx=w.flowVX[i],vz=w.flowVZ[i],m=Math.hypot(vx,vz);
    return m>1e-4?{x:vx/m,z:vz/m,m,q:w.flowQ[i]}:null;};
  const lvAt=(x,z)=>{const v=w._water?.levelAt?.(x,z);return v==null?null:v;};
  const slopes=[], maskAtWall=[], maskMid=[];
  for(let x=-1200;x<=1200;x+=12)for(let z=-1200;z<=1200;z+=12){
    if(!w.isInBounds(x,z))continue;
    if(w.getRiver(x,z)<0.35)continue;
    const h=w.getHydro(x,z); if(h.sdf<=0)continue;
    const f=flowDir(x,z); if(!f)continue;
    const a=lvAt(x-f.x*4,z-f.z*4), c=lvAt(x+f.x*4,z+f.z*4);
    if(a!=null&&c!=null) slopes.push((a-c)/8);        // + = downhill downstream
    // river mask where the sdf wall bites (sdf ~1.2) vs mid-channel
    if(h.sdf>0.9&&h.sdf<1.6) maskAtWall.push(w.getRiver(x,z));
    if(h.sdf>4) maskMid.push(w.getRiver(x,z));
  }
  const qq=(a,pc)=>{if(!a.length)return null;const s=a.slice().sort((u,v)=>u-v);return +s[Math.floor((s.length-1)*pc)].toFixed(4);};
  const st=(a)=>({n:a.length,p05:qq(a,.05),p50:qq(a,.5),p95:qq(a,.95),max:qq(a,1)});
  return { surfaceSlopeAlongFlow: st(slopes),
           slopeDegP50: +(Math.atan(qq(slopes,.5))*180/Math.PI).toFixed(2),
           slopeDegP95: +(Math.atan(qq(slopes,.95))*180/Math.PI).toFixed(2),
           riverMaskAtSdf1_2: st(maskAtWall), riverMaskMidChannel: st(maskMid) };
});
console.log(JSON.stringify(out,null,1));
await b.close();
