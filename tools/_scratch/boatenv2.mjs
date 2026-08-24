import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readPNG } from '../_pngread.mjs';
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5197';
const SEED = process.env.SEED || '20261018';
const HOUR = parseFloat(process.env.HOUR || '19.0');
const OUT = process.env.OUT || '/tmp/boatenv2';
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
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
console.log(await p.evaluate(async (hour) => {
  const L = window.__lighting; L.hour = hour; L.cycleSpeed = 0;
  const boat = window.__systems.boat;
  const a = window.__anchorAt('river', 3);
  boat.spawnAt(a.x, a.z, {}); boat.board(); boat.drive(0, 0);
  await new Promise(r => requestAnimationFrame(r));
  boat._aboard.phys.heading = Math.atan2(L.sunDir.x, L.sunDir.z);
  boat._camSnap = true;
  window.__bm = []; boat._aboard.group.traverse(o => { if (o.isMesh) window.__bm.push(o); });
  window.__envI0 = window.__bm.map(m => m.material.envMapIntensity);
  return 'ready elev=' + L.sunDir.y.toFixed(3) + ' authored envI=' + JSON.stringify(window.__envI0);
}, HOUR));
await p.waitForTimeout(4000);
const RECTS = { hull: [520, 470, 240, 150], shore: [80, 200, 200, 70], sky: [520, 60, 240, 60] };
function stats(path) {
  const img = readPNG(path); const out = {};
  for (const [k, [x, y, w, h]] of Object.entries(RECTS)) {
    let r=0,g=0,bl=0,n=0;
    for (let j=y;j<y+h;j++) for (let i=x;i<x+w;i++){const o=(j*img.w+i)*3;r+=img.px[o];g+=img.px[o+1];bl+=img.px[o+2];n++;}
    out[k]=[Math.round(r/n),Math.round(g/n),Math.round(bl/n)];
  }
  return out;
}
const LU = (c) => Math.round(0.2126*c[0]+0.7152*c[1]+0.0722*c[2]);
async function arm(label, fn) {
  const r = await p.evaluate(fn); if (r) console.log('  ', r);
  await p.waitForTimeout(1400);
  const path = `${OUT}/${label}.png`;
  writeFileSync(path, await p.screenshot());
  const s = stats(path);
  console.log(label.padEnd(18), 'hull', String(s.hull).padEnd(15), `L=${String(LU(s.hull)).padEnd(4)}`,
    'shore', String(s.shore).padEnd(15), `L=${String(LU(s.shore)).padEnd(4)}`, 'sky', `L=${LU(s.sky)}`);
}
await arm('a-base', () => 'base');
await arm('b-boatenv-authored', async () => {
  const mk = await import('/src/vehicle/model_kit.js');
  window.__env = mk.buildEnvMap(window.__engine.renderer);
  window.__bm.forEach((m, i) => { m.material.envMap = window.__env; m.material.needsUpdate = true; });
  return 'envMap on boat materials only, at authored envMapIntensity';
});
for (const k of [0.5, 0.3, 0.15]) {
  await arm(`c-scale${k}`, new Function(`window.__bm.forEach((m,i)=>{m.material.envMapIntensity = window.__envI0[i]*${k};}); return 'envI x ${k}';`));
}
await arm('d-off', () => { window.__bm.forEach((m,i)=>{ m.material.envMap = null; m.material.envMapIntensity = window.__envI0[i]; m.material.needsUpdate = true; }); return 'off'; });
await b.close();
