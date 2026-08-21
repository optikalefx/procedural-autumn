#!/usr/bin/env node
/**
 * wedge — how does the camper end up parked *inside* a mountainside?
 *
 *   node tools/_scratch/wedge.mjs                  # ledge sites, hands off
 *   node tools/_scratch/wedge.mjs --sites 14 --seconds 14
 *
 * The screenshot that started this: camper nose-first into a steep face, tilted
 * far past anything drivable, speedo reading 0, and staying there. The three
 * ways out of a bad pose are all conditional, and this measures whether any of
 * them fires:
 *
 *   · the auto-right, which needs upDot < 0.18;
 *   · the stuck detector, which needs a pedal AND `!airborne`;
 *   · the buried guard, which needs the body origin 1.6 m under getHeight.
 *
 * A camper wedged on its chassis box with no wheel in contact is airborne by
 * the physics' definition, so it is invisible to the second one. This looks for
 * poses that satisfy none of the three and hold for the whole recording.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const SITES = parseInt(arg('sites', '12'), 10);
const SECONDS = parseFloat(arg('seconds', '12'));
const RES = arg('res', '640');
const URL = `${arg('url', 'http://localhost:5178')}?res=${RES}`;
const f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const deg = (u) => (Math.acos(Math.max(-1, Math.min(1, u))) * 180) / Math.PI;

async function main() {
  const release = await acquire('wedge');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
        return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
                 send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
      }
      return new Real(url, protocols);
    };
    window.WebSocket.prototype = Real.prototype;
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`booting ${URL} …`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => typeof window.__vehicleState === 'function', null, { timeout: 20000 });
  await page.waitForTimeout(1500);

  await page.evaluate(() => {
    const W = window.__world;
    /**
     * Broken ground, on purpose: steep AND badly non-planar over the camper's
     * own footprint. holdtest.mjs rejects exactly these sites because they are
     * where the camper lands inside the hill instead of on it.
     */
    window.__ledgeSites = (n) => {
      const out = [];
      for (let i = 0; i < 120000 && out.length < n; i++) {
        const x = (Math.random() * 2 - 1) * 1400, z = (Math.random() * 2 - 1) * 1400;
        if (!W.isInBounds(x, z) || W.getWaterDepth(x, z) > 0.02) continue;
        const h0 = W.getHeight(x, z), d = 2.0;
        const gx = (W.getHeight(x + d, z) - W.getHeight(x - d, z)) / (2 * d);
        const gz = (W.getHeight(x, z + d) - W.getHeight(x, z - d)) / (2 * d);
        const g = Math.hypot(gx, gz);
        if (g < 0.75) continue;
        let resid = 0, bad = false;
        for (let a = 0; a < 12; a++) {
          const ang = (a / 12) * Math.PI * 2;
          const dx = Math.cos(ang) * 2.2, dz = Math.sin(ang) * 2.2;
          if (!W.isInBounds(x + dx, z + dz) || W.getWaterDepth(x + dx, z + dz) > 0.02) { bad = true; break; }
          resid = Math.max(resid, Math.abs(W.getHeight(x + dx, z + dz) - (h0 + gx * dx + gz * dz)));
        }
        if (bad || resid < 0.5) continue;
        out.push({ x, z, g, resid });
      }
      return out;
    };

    window.__rec = (ms) => new Promise((res) => {
      const out = []; const t0 = performance.now();
      const tick = () => {
        const s = window.__vehicleState();
        const P = window.__vehicle.phys;
        out.push({ t: (performance.now() - t0) / 1000, x: s.x, y: s.y, z: s.z,
                   speed: s.speed, up: s.up, grounded: s.grounded, rec: s.recoveries,
                   held: s.held, hold: s.hold, ground: s.ground, rocks: s.rockColliders,
                   air: P.airborne, stuckFor: P._stuckFor, invFor: P._invertedFor });
        if (performance.now() - t0 >= ms) res(out); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });

  /** Hold a key down for `ms` and record while it is held. */
  const drive = async (key, ms) => {
    await page.keyboard.down(key);
    const rows = await page.evaluate((m) => window.__rec(m), ms);
    await page.keyboard.up(key);
    return rows;
  };

  const sites = await page.evaluate((n) => window.__ledgeSites(n), SITES);
  console.log(`\n${sites.length} ledge sites (gradient > 0.75, footprint residual > 0.5 m)\n`);
  console.log('  site         grad | tilt°  wheels  air  burial | throttle 4 s: moved  toast?  verdict');

  let wedged = 0;
  for (const s of sites) {
    await page.evaluate(([x, z]) => window.__vehicleTeleport(x, z, Math.random() * 6.28), [s.x, s.z]);
    const rows = await page.evaluate((ms) => window.__rec(ms), SECONDS * 1000);
    const rec0 = rows[0].rec;
    const last = rows[rows.length - 1];
    // Settled = the last 4 s of the hands-off recording went nowhere.
    const tail = rows.filter((r) => r.t > last.t - 4);
    const span = Math.max(...tail.map((r) => Math.hypot(r.x - last.x, r.y - last.y, r.z - last.z)));
    const tilt = deg(last.up);
    const burial = last.ground - last.y;
    const recov = last.rec - rec0;

    if (span > 0.5) {
      console.log(`  ${f(s.x, 0).padStart(6)},${f(s.z, 0).padStart(6)}  ${f(s.g)} | still sliding (${f(span)} m in the last 4 s)`);
      continue;
    }

    // Now the player's move: hold the throttle and see if anything happens.
    const drv = await drive('KeyW', 4000);
    const end = drv[drv.length - 1];
    const moved = Math.hypot(end.x - last.x, end.y - last.y, end.z - last.z);
    const toast = Math.max(...drv.map((r) => r.stuckFor)) > 2.4;

    let verdict = 'drives away';
    if (moved < 1.0) {
      verdict = (end.rec > last.rec) ? 'auto-recovered' : 'STUCK';
      if (verdict === 'STUCK' && !toast) { verdict = 'STUCK, and silently'; wedged++; }
    }
    console.log(`  ${f(s.x, 0).padStart(6)},${f(s.z, 0).padStart(6)}  ${f(s.g)} |`
      + ` ${f(tilt, 0).padStart(4)}  ${String(last.grounded).padStart(4)}  ${String(last.air).padStart(5)}`
      + `  ${f(burial).padStart(5)} | ${f(moved).padStart(11)} m  ${String(toast).padStart(5)}   ${verdict}`
      + (recov ? `  (${recov} recoveries while settling)` : ''));
  }
  console.log(`\n${wedged}/${sites.length} stuck with the throttle open and no 'Stuck? Press R'.`);
  if (errors.length) console.log('page errors:', errors.slice(0, 3));
  await browser.close();
  release();
}
main().catch((e) => { console.error(e); process.exit(1); });
