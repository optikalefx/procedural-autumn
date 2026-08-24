import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readPNG } from '../_pngread.mjs';
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5197';
const SEED = process.env.SEED || '20261018';
const HOURS = (process.env.HOURS || '17.0,18.3,19.0,19.4,20.2').split(',').map(Number);
const OUT = process.env.OUT || '/tmp/boathues';
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
console.log(await p.evaluate(async () => {
  const L = window.__lighting, b = window.__systems.boat;
  L.cycleSpeed = 0;
  const a = window.__anchorAt('river', 3);
  b.spawnAt(a.x, a.z, {}); b.board(); b.drive(0, 0); b._focusT = 0;
  return 'aboard, probe=' + !!b._probe;
}));
await p.waitForTimeout(3000);
const R = { hull: [520, 470, 240, 150], sky: [520, 60, 240, 60] };
function stats(path) {
  const img = readPNG(path); const o = {};
  for (const [k, [x, y, w, h]] of Object.entries(R)) {
    let r=0,g=0,bl=0,n=0;
    for (let j=y;j<y+h;j++) for (let i=x;i<x+w;i++){const q=(j*img.w+i)*3;r+=img.px[q];g+=img.px[q+1];bl+=img.px[q+2];n++;}
    o[k]=[Math.round(r/n),Math.round(g/n),Math.round(bl/n)];
  }
  return o;
}
const LU = (c) => Math.round(0.2126*c[0]+0.7152*c[1]+0.0722*c[2]);
// warmth = R/B ratio. >1 warm, <1 cool.
const RB = (c) => +(c[0] / Math.max(1, c[2])).toFixed(2);
for (const h of HOURS) {
  await p.evaluate(async (hour) => {
    const L = window.__lighting, b = window.__systems.boat;
    L.hour = hour; L.cycleSpeed = 0;
    for (let i = 0; i < 4; i++) await new Promise(r => requestAnimationFrame(r));
    b._aboard.phys.heading = Math.atan2(L.sunDir.x, L.sunDir.z);
    b._lookYaw = 0; b._camSnap = true; b._focusT = 0;
    b._probe.update(true);
    for (let i = 0; i < 4; i++) await new Promise(r => requestAnimationFrame(r));
  }, h);
  await p.waitForTimeout(1400);
  const path = `${OUT}/h${String(h).replace('.','_')}.png`;
  writeFileSync(path, await p.screenshot());
  const s = stats(path);
  console.log(`h=${h}`.padEnd(8), 'hull', String(s.hull).padEnd(15),
    `L=${String(LU(s.hull)).padEnd(4)} R/B=${String(RB(s.hull)).padEnd(5)}`,
    '| sky', String(s.sky).padEnd(16), `R/B=${RB(s.sky)}`);
}
await b.close();
