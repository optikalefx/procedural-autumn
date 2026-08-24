/**
 * Is the boat launch gate calibrated? Sweeps every shoreline point in the map,
 * measures how big the water body actually is, and scores the gate against it.
 */
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5197';
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
await p.goto(`${URL}/?seed=${SEED}&car=camper&res=768`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
console.log(await p.evaluate(() => {
  const w = window.__world;
  const grad = (x, z) => {
    const e = 1.5;
    const h = w.getHydro(x, z);
    const xr = w.getHydro(x+e,z).sdf, xl = w.getHydro(x-e,z).sdf;
    const zr = w.getHydro(x,z+e).sdf, zl = w.getHydro(x,z-e).sdf;
    let gx = (xr-xl)/(2*e), gz = (zr-zl)/(2*e);
    const m = Math.hypot(gx,gz); if (m>1e-6){gx/=m;gz/=m;}
    return { sdf: h.sdf, span: h.span, gx, gz };
  };
  const snap = (x, z, target=2.5) => {
    let px=x, pz=z, g=null;
    for (let i=0;i<3;i++){ g=grad(px,pz); if (Math.abs(g.gx)+Math.abs(g.gz)<1e-5) break;
      const st=g.sdf-target; px-=st*g.gx; pz-=st*g.gz; }
    g=grad(px,pz); return {x:px,z:pz,gx:g.gx,gz:g.gz,sdf:g.sdf};
  };
  const rows = [];
  for (let x=-1200;x<=1200;x+=20) for (let z=-1200;z<=1200;z+=20) {
    if (!w.isInBounds(x,z)) continue;
    const s0 = w.getHydro(x,z).sdf;
    if (s0 < -6 || s0 > 2) continue;
    const s = snap(x,z);
    if (w.getRiver(s.x, s.z) > 0.05) continue;              // flowing water is out either way
    // GROUND TRUTH: how far from ANY shore does this body get, walking in?
    // max sdf along the gradient is "half the width of the water in front".
    let maxSdf = 0;
    for (let d = 0; d <= 200; d += 4) {
      const q = w.getHydro(s.x + s.gx*d, s.z + s.gz*d);
      if (q.sdf > maxSdf) maxSdf = q.sdf;
    }
    // what the gate sees, at several probe distances
    const spanAt = (d) => w.getHydro(s.x + s.gx*d, s.z + s.gz*d).span;
    rows.push({ maxSdf, s14: spanAt(14), s25: spanAt(25), s40: spanAt(40) });
  }
  const q = (a,pc)=>{const b2=a.slice().sort((u,v)=>u-v);return +b2[Math.floor((b2.length-1)*pc)].toFixed(1);};
  // "a real lake" = water at least 40 m across in front of the bow (maxSdf>=20)
  const real = rows.filter(r => r.maxSdf >= 20);
  const puddle = rows.filter(r => r.maxSdf < 8);
  const out = {
    shorePoints: rows.length,
    realLakeShore: real.length,
    puddleShore: puddle.length,
    maxSdf: { p50:q(rows.map(r=>r.maxSdf),.5), p90:q(rows.map(r=>r.maxSdf),.9), max:q(rows.map(r=>r.maxSdf),1) },
    spanProbeCeiling: {
      at14: q(rows.map(r=>r.s14),1), at25: q(rows.map(r=>r.s25),1), at40: q(rows.map(r=>r.s40),1),
    },
    onRealLakes: {
      s14: { p10:q(real.map(r=>r.s14),.1), p50:q(real.map(r=>r.s14),.5), max:q(real.map(r=>r.s14),1) },
      s25: { p10:q(real.map(r=>r.s25),.1), p50:q(real.map(r=>r.s25),.5), max:q(real.map(r=>r.s25),1) },
    },
    onPuddles: {
      s14: { p50:q(puddle.map(r=>r.s14),.5), p90:q(puddle.map(r=>r.s14),.9), max:q(puddle.map(r=>r.s14),1) },
      s25: { p50:q(puddle.map(r=>r.s25),.5), p90:q(puddle.map(r=>r.s25),.9), max:q(puddle.map(r=>r.s25),1) },
    },
  };
  // score candidate (probe, threshold) pairs: accept real lakes, reject puddles
  const grid = [];
  for (const probe of [14, 25, 40]) {
    for (const thr of [3, 4, 5, 6, 8, 10, 14]) {
      const key = probe === 14 ? 's14' : probe === 25 ? 's25' : 's40';
      const passReal = real.filter(r => r[key] >= thr).length / Math.max(1, real.length);
      const passPud  = puddle.filter(r => r[key] >= thr).length / Math.max(1, puddle.length);
      grid.push(`probe ${String(probe).padStart(2)} thr ${String(thr).padStart(2)}  lakes ${(100*passReal).toFixed(0).padStart(3)}%  puddles ${(100*passPud).toFixed(0).padStart(3)}%`);
    }
  }
  return JSON.stringify(out, null, 1) + '\n\n' + grid.join('\n');
}));
await b.close();
