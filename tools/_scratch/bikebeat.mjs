#!/usr/bin/env node
/**
 * The bike's rhythm bonus, end to end in the GAME.
 *
 * The unit harness (bikerhythm.mjs) proves the physics. This proves the chain
 * the player actually touches: the throttle axis the input layer sets, the
 * meter, the speed it buys, and the dial glow the HUD draws from the craft's
 * own tempo rather than from an imported constant.
 *
 *   node tools/_scratch/bikebeat.mjs [--port 5272]
 */
import { chromium } from 'playwright';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const PORT = arg('port', '5272');

// The GPU args matter here, not just for looks: without them Chromium software
// -renders every frame and this harness grants ~4000 of them. The first version
// omitted them and the very first 16-second pattern blew a 120 s timeout.
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.addInitScript(() => {
  try {
    const k = 'pa.hud';
    const st = JSON.parse(localStorage.getItem(k) ?? '{}') || {};
    st.introSeen = true; st.seenHint = true; st.escSeen = true;
    localStorage.setItem(k, JSON.stringify(st));
  } catch { /* storage unavailable */ }
  // Stub the vite HMR socket. Without it a save in this worktree reloads the
  // page mid-run and the harness dies with "Execution context was destroyed",
  // which is how the first attempt at this ended — reel.mjs and shot.mjs have
  // carried these lines for the same reason.
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

// Flat ground, so the grade term does not drown what is being measured.
const spot = await page.evaluate(() => {
  const W = window.__bike.ctx.world;
  for (let i = 0; i < 40000; i++) {
    const x = (Math.random() * 2 - 1) * 1100, z = (Math.random() * 2 - 1) * 1100;
    if (W.getSlope(x, z) > 0.1 || W.getWaterDepth(x, z) > 0.05) continue;
    return { x, z, h: Math.random() * Math.PI * 2 };
  }
  return null;
});
if (!spot) { console.log('[beat] no flat start found'); await browser.close(); process.exit(1); }
console.log(`[beat] flat start ${spot.x.toFixed(0)},${spot.z.toFixed(0)}`);

const run = (gap) => page.evaluate(([s, gap]) => new Promise((res) => {
  const B = window.__bike;
  B.dismount();
  B.parkAt(s.x, s.z, { yaw: s.h });
  B.mount();
  if (!B.bike?.phys) return res({ error: 'parkAt/mount failed' });
  const p = B.bike.phys;
  const HOLD = 0.10, DT = 1 / 60, SECS = 16;
  let n = 0;
  const speeds = [], meters = [];
  let litFrames = 0, seen = 0;
  const f = () => {
    const t = n * DT;
    // `drive` writes the same script the touch controls and the keyboard both
    // land on, so this exercises the real throttle path and not a private hook.
    B.drive(gap === null ? 1 : ((t % gap) < HOLD ? 1 : 0), 0);
    window.__grant();
    n++;
    if (n * DT > 6) {
      speeds.push(Math.abs(p.speed)); meters.push(p.rhythm);
      // What the HUD is drawing right now.
      const el = document.querySelector('.pa-speedo');
      if (el) { seen++; if (el.classList.contains('pa-beat')) litFrames++; }
    }
    if (n * DT < SECS) requestAnimationFrame(f);
    else {
      const q = (a, pc) => a.slice().sort((u, v) => u - v)[Math.floor(pc * (a.length - 1))];
      const el = document.querySelector('.pa-speedo');
      res({ speed: +q(speeds, 0.5).toFixed(2), meter: +q(meters, 0.5).toFixed(2),
        litPct: seen ? +(100 * litFrames / seen).toFixed(0) : null,
        fadeVar: el ? getComputedStyle(el).getPropertyValue('--pa-beat-off').trim() : null,
        beat: B.current?.beat ?? null, dialKmh: document.querySelector('.pa-speed-num')?.textContent ?? null });
    }
  };
  requestAnimationFrame(f);
}), [spot, gap]);

console.log('pattern        speed p50   meter p50   dial lit   --pa-beat-off');
for (const [name, gap] of [['hold', null], ['on-beat 0.50s', 0.5], ['mash 0.25s', 0.25], ['slow 1.0s', 1.0]]) {
  const t0 = Date.now();
  const r = await Promise.race([run(gap),
    new Promise((_, rj) => setTimeout(() => rj(new Error(`${name} timed out`)), 120000))]);
  if (r.error) { console.log(`${name.padEnd(14)} ERROR ${r.error}`); continue; }
  process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(0)}s] `);
  console.log(`${name.padEnd(14)} ${String(r.speed).padStart(6)} m/s ${String(r.meter).padStart(8)}` +
    `   ${String(r.litPct).padStart(5)}%   ${r.fadeVar}`);
  if (name === 'hold') console.log(`   beat descriptor from Bike.current: ${JSON.stringify(r.beat)}`);
}
await browser.close();
