import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readPNG } from '../_pngread.mjs';
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5197';
const SEED = process.env.SEED || '20261018';
const HOUR = parseFloat(process.env.HOUR || '19.4');
const OUT = process.env.OUT || '/tmp/boatdecomp2';
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
await p.goto(`${URL}/?seed=${SEED}&car=camper`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
console.log(await p.evaluate(async (hour) => {
  const boat = window.__systems.boat;
  const a = window.__anchorAt('river', 3);
  boat.spawnAt(a.x, a.z, {}); boat.board(); boat.drive(0, 0);
  window.__lighting.hour = hour; window.__lighting.cycleSpeed = 0;
  window.__bm = []; boat._aboard.group.traverse(o => { if (o.isMesh) window.__bm.push(o); });
  if (window.__settleStable) await window.__settleStable();
  return 'boarded';
}, HOUR));
const RECTS = { hull: [560, 490, 180, 130], shore: [200, 300, 200, 60] };
function stats(path) {
  const img = readPNG(path); const out = {};
  for (const [k, [x, y, w, h]] of Object.entries(RECTS)) {
    let r=0,g=0,bl=0,n=0;
    for (let j=y;j<y+h;j++) for (let i=x;i<x+w;i++){const o=(j*img.w+i)*3;r+=img.px[o];g+=img.px[o+1];bl+=img.px[o+2];n++;}
    out[k]=[Math.round(r/n),Math.round(g/n),Math.round(bl/n)];
  }
  return out;
}
async function arm(label, fn) {
  if (fn) await p.evaluate(fn);
  await p.waitForTimeout(900);
  const path = `${OUT}/${label}.png`;
  writeFileSync(path, await p.screenshot());
  const s = stats(path);
  console.log(label.padEnd(16), 'hull', String(s.hull).padEnd(16), 'shore', String(s.shore));
}
await arm('base', () => { window.__lighting.keyOverride = null; });
await arm('sunI=0', () => { window.__lighting.keyOverride = { sunI: 0 }; });
await arm('sunI=3', () => { window.__lighting.keyOverride = { sunI: 3 }; });
await arm('hemiI=0', () => { window.__lighting.keyOverride = { hemiI: 0 }; });
await arm('hemiI=3', () => { window.__lighting.keyOverride = { hemiI: 3 }; });
await arm('ambScale4', () => { window.__lighting.keyOverride = null; window.__lighting.ambientScale = 4; });
await arm('ambScale1', () => { window.__lighting.ambientScale = 1; });
await arm('noshadowmesh', () => { window.__bm.forEach(m => m.receiveShadow = false); });
await arm('sunCastOff', () => { window.__bm.forEach(m => m.receiveShadow = true); window.__lighting.sun.castShadow = false; Object.defineProperty(window.__lighting.sun, 'castShadow', { value: false, writable: false }); });
await arm('styleFloor5x', () => {
  const s = window.__stylize; s.params.floor = 0.6; s.apply?.(); s.sync?.(); s.update?.();
});
await b.close();
