import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const release = await acquire('boomdiag');
const b = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 } });
await p.goto('http://localhost:5178/?res=512', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await p.keyboard.press('KeyM'); await p.waitForTimeout(400);
await p.evaluate(() => { window.__audio.setMuted(false);
  const q = window.__poi.best('meadow'); window.__vehicleTeleport?.(q.x, q.z, 0); });
// The chase camera lerps a long way home after a teleport — 1.6 km in the first
// run of this probe — so sampling too early measures the catch-up, not the boom.
// Wait until the listener has actually arrived at the camper.
await p.waitForFunction(() => {
  try {
    const L = window.__audio?.L, v = window.__vehicleState?.();
    if (!L || !v || !Number.isFinite(v.x)) return false;
    return Math.hypot(L.x - v.x, L.z - v.z) < 30;
  } catch { return false; }
}, null, { timeout: 120000, polling: 250 });
await p.keyboard.down('KeyW');
await p.waitForTimeout(4000);
const s = await p.evaluate(() => new Promise((res) => {
  const out = []; const t0 = performance.now();
  const tick = () => {
    const L = window.__audio.L, v = window.__vehicleState();
    out.push({ back: Math.hypot(L.x - v.x, L.z - v.z), up: L.y - v.y, sp: Math.abs(v.speed) });
    if (performance.now() - t0 < 8000) requestAnimationFrame(tick);
    else res(out);
  };
  requestAnimationFrame(tick);
}));
await p.keyboard.up('KeyW');
const q = (k) => { const a = s.map(o => o[k]).sort((x, y) => x - y);
  return `${a[0].toFixed(1)} … ${a[a.length >> 1].toFixed(1)} … ${a[a.length - 1].toFixed(1)}`; };
console.log(`samples ${s.length}  speed ${q('sp')} m/s`);
console.log(`listener behind camper : ${q('back')} m`);
console.log(`listener above camper  : ${q('up')} m`);
await b.close(); release();
