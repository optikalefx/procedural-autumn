#!/usr/bin/env node
/**
 * The bike crosses this lip at 11.6 m/s and does not leave the ground, while
 * the unit sim launches off it every time and both agree on the terrain to the
 * millimetre. So ask the physics ITSELF, in the game, what it is deciding on:
 * the speed it thinks it is making, the heading it is fitting the curvature
 * along, and the two sides of the launch inequality.
 */
import { chromium } from 'playwright';

const PORT = process.argv[2] ?? '5272';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${PORT}/?quality=low`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__bike && !!window.__engine, null, { timeout: 60000 });

await page.evaluate(() => {
  const e = window.__engine;
  e.adaptive = false; e.autoQuality = false;
  const DT = 1 / 60; let budget = 0;
  window.__grant = () => { budget += DT; };
  e.clock.getDelta = () => { if (budget <= 1e-9) return 0; budget -= DT; return DT; };
});

const rows = await page.evaluate(() => new Promise((res) => {
  const B = window.__bike;
  B.dismount();
  B.parkAt(616.3, 17.5, { yaw: 2.7489 });
  B.mount();
  B.bike.phys.speed = 11;
  B.drive(1, 0);
  const p = B.bike.phys, out = [];
  let n = 0;
  const f = () => {
    const d = Math.hypot(p.x - 623.9, p.z + 1.0);
    if (d < 6) {
      const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
      const ypp = p._curvature ? p._curvature(fx, fz) : null;
      out.push({
        d: +d.toFixed(2), speed: +p.speed.toFixed(2), made: +p.made.toFixed(2),
        heading: +p.heading.toFixed(3), ypp: ypp === null ? null : +ypp.toFixed(4),
        lhs: ypp === null ? null : +(p.made * p.made * ypp).toFixed(1),
        air: p.airborne, blocked: p.blocked,
        hasCurv: typeof p._curvature, hasVy: typeof p.vy,
      });
    }
    window.__grant();
    if (++n < 300) requestAnimationFrame(f); else res(out);
  };
  requestAnimationFrame(f);
}));

console.log(`threshold: launch when made² · y'' < -12.31`);
for (const r of rows) console.log(JSON.stringify(r));
await browser.close();
