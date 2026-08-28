/**
 * One river cross-section, three definitions of "where the water ends":
 * the hydro sdf (what BoatPhysics walls on), the DRAWN water mesh (what the
 * player sees), and floatable depth. If they disagree, the boat is walled
 * inside visible water.
 */
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
    return m>1e-4?{x:vx/m,z:vz/m,m}:null;};
  const lv=(x,z)=>{const v=w._water?.levelAt?.(x,z); return v==null?null:v;};
  const rows=[];
  for(let x=-1200;x<=1200;x+=12)for(let z=-1200;z<=1200;z+=12){
    if(!w.isInBounds(x,z))continue;
    if(w.getRiver(x,z)<0.45)continue;
    const h=w.getHydro(x,z); if(h.sdf<=0)continue;
    const f=flowDir(x,z); if(!f)continue;
    const nx=-f.z,nz=f.x;
    const walk=(test)=>{let L=0,R2=0;
      for(let d=0.5;d<=45;d+=0.5){if(!test(x+nx*d,z+nz*d))break;R2=d;}
      for(let d=0.5;d<=45;d+=0.5){if(!test(x-nx*d,z-nz*d))break;L=d;}
      return L+R2;};
    const wSdf = walk((a,c)=>w.getHydro(a,c).sdf>0);
    const wDrawn = walk((a,c)=>lv(a,c)!==null);
    const wFloat = walk((a,c)=>{const l=lv(a,c);return l!==null && l-w.getHeight(a,c)>0.26;});
    const wWall = walk((a,c)=>w.getHydro(a,c).sdf>1.2);       // the SHORE_SDF corridor
    rows.push({wSdf,wDrawn,wFloat,wWall,sdf:h.sdf});
  }
  const qq=(a,pc)=>{if(!a.length)return null;const s=a.slice().sort((u,v)=>u-v);return +s[Math.floor((s.length-1)*pc)].toFixed(2);};
  const st=(a)=>({p05:qq(a,.05),p25:qq(a,.25),p50:qq(a,.5),p75:qq(a,.75),p95:qq(a,.95)});
  const frac=(a,f)=>+(a.filter(f).length/Math.max(1,a.length)).toFixed(3);
  return { n:rows.length,
    widthBySdf: st(rows.map(r=>r.wSdf)),
    widthByDrawnMesh: st(rows.map(r=>r.wDrawn)),
    widthByFloatDepth: st(rows.map(r=>r.wFloat)),
    corridorInsideWall: st(rows.map(r=>r.wWall)),
    midChannelSdf: st(rows.map(r=>r.sdf)),
    corridorNarrowerThan2m: frac(rows,r=>r.wWall<2),
    corridorZero: frac(rows,r=>r.wWall<=0),
    drawnWiderThanSdfBy: st(rows.map(r=>r.wDrawn-r.wSdf)),
    floatWiderThanCorridorBy: st(rows.map(r=>r.wFloat-r.wWall)),
  };
});
console.log(JSON.stringify(out,null,1));
await b.close();
