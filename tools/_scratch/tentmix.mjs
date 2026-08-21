#!/usr/bin/env node
/**
 * tentmix — does the layout actually roll both tents, and does the right
 * builder run for each?
 *
 * The harness that shot the A-frame FORCED it into the tent slot, which proves
 * the model and proves nothing about the wiring. This pitches real camps at
 * real sites and reads back, for each one, the `style` the layout drew and the
 * group name the builder stamped — `camp_tent` for the dome, `camp_tent_ridge`
 * for the A-frame. A mismatch between those two columns is the dispatch broken.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const N = parseInt(process.argv[2] ?? '24', 10);
const release = await acquire('tentmix');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {},
               set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://localhost:5178/?res=512', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 30000 });
await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(1500);

const rows = await page.evaluate(async (n) => {
  const v = window.__systems.vehicle;
  const out = [];
  for (let i = 0; i < n; i++) {
    // Walk the pitch point around so the site RNG (seeded on the site) differs.
    const a = (i / n) * Math.PI * 2;
    const x = v.position.x + Math.cos(a) * (3 + (i % 5) * 1.7);
    const z = v.position.z + Math.sin(a) * (3 + (i % 5) * 1.7);
    const s = window.__camp.pitchNear(x, z, { instant: true, radius: 14 });
    if (!s) { out.push(null); continue; }
    const t = window.__camp.props.find((q) => q.item.kind === 'tent');
    out.push(t ? { style: t.item.opts?.style ?? '(none)', cw: t.item.opts?.colorway,
                   built: t.obj.name, cwName: t.obj.userData.colorway } : null);
    window.__camp.strike?.(true);
    await new Promise((r) => setTimeout(r, 40));
  }
  return out;
}, N);

const good = rows.filter(Boolean);
const tally = {};
let mismatch = 0;
for (const r of good) {
  const want = r.style === 'ridge' ? 'camp_tent_ridge' : 'camp_tent';
  if (r.built !== want) { mismatch++; console.log(`  MISMATCH style=${r.style} built=${r.built}`); }
  tally[`${r.style} -> ${r.built}`] = (tally[`${r.style} -> ${r.built}`] ?? 0) + 1;
}
console.log(`${good.length}/${rows.length} camps pitched a tent`);
for (const [k, v] of Object.entries(tally)) console.log(`  ${v.toString().padStart(3)}  ${k}`);
console.log(`colourways seen: ${[...new Set(good.map((r) => r.cwName))].sort().join(', ')}`);
if (errors.length) console.log('page-errors:', [...new Set(errors)].slice(0, 6));
console.log(mismatch ? `FAIL: ${mismatch} dispatch mismatches` : 'OK: every tent built by the right builder');
await browser.close();
release();
process.exit(mismatch ? 1 : 0);
