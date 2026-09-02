#!/usr/bin/env node
/**
 * The synthesised fire and `public/audio/campfire.mp3`, measured on the SAME
 * tap at the SAME distances inside ONE page load — which is the only way the
 * two are comparable (see AGENTS.md on paired deltas).
 *
 *   node tools/_scratch/_firemix.mjs
 *
 * `A.measure('camp')` is the fire's own metering tap, so nothing here is
 * contaminated by the wind or the water: what it reports is the camp bus and
 * nothing else. Each row is 8 s of frames, long enough that the synthesised
 * crackle scheduler (0.55–2.6 s between bursts) contributes more than one
 * draw, and long enough for seven of the recording's loops.
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const base = arg('base', 'http://localhost:5178');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
page.on('console', (m) => { if (m.type() === 'error') console.log('C:', m.text().slice(0, 300)); });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (/vite/i.test(String(protocols))) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto(`${base}?res=768&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.keyboard.press('KeyM');
await page.waitForTimeout(900);
await page.evaluate(() => window.__audio?.setMuted(false));
await page.waitForFunction(() => window.__audio?.started === true, null, { timeout: 20000 });
await page.waitForTimeout(600);
console.log('sample loaded:', await page.evaluate(async () => {
  await window.__audio.camp.loadSamples();
  const b = window.__audio.camp._fire;
  return b ? `${b.duration.toFixed(4)}s ${b.length}fr ${b.numberOfChannels}ch @${b.sampleRate}` : 'NULL (synth fallback)';
}));

await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(2200);

// Pitch ONE camp and leave it lit for the whole run: striking it between rows
// would re-roll the site and every distance would be measured at a different
// place on the ground.
await page.evaluate(() => {
  const camp = window.__camp, v = window.__systems.vehicle;
  window.__site = camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  window.__forceCamera = true;
});

const row = (dist, noSample) => page.evaluate(async ({ dist, noSample }) => {
  const A = window.__audio, site = window.__site, c = window.__engine.camera;
  A.camp._noSample = noSample;
  const place = () => {
    c.position.set(site.x + dist, site.y + 1.6, site.z);
    c.lookAt(site.x, site.y + 0.4, site.z);
    c.updateMatrixWorld(true);
  };
  place();
  await new Promise((r) => setTimeout(r, 1200));          // let the level settle
  const c0 = A.camp.state.crackles;
  let peak = 0, rms = 0, n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 8000) {
    place();
    await new Promise(requestAnimationFrame);
    const m = A.measure('camp');
    if (m) { if (m.peak > peak) peak = m.peak; rms += m.rms; n++; }
  }
  return { dist, src: noSample ? 'synth' : 'mp3  ', level: +A.camp.state.level.toFixed(3),
    crackles: A.camp.state.crackles - c0, peak: +peak.toFixed(4), rms: +(rms / Math.max(n, 1)).toFixed(5) };
}, { dist, noSample });

console.log('\n dist   source   level   crackles    peak       rms');
const rows = [];
for (const d of [2.5, 8, 16]) for (const ns of [true, false]) {
  const r = await row(d, ns);
  rows.push(r);
  console.log(`${String(r.dist).padStart(5)}   ${r.src}    ${String(r.level).padEnd(6)}  ${String(r.crackles).padStart(5)}     ${r.peak.toFixed(4)}   ${r.rms.toFixed(5)}`);
}
console.log('\nmp3 vs synth, per distance:');
for (const d of [2.5, 8, 16]) {
  const a = rows.find((r) => r.dist === d && r.src === 'synth'), b = rows.find((r) => r.dist === d && r.src !== 'synth');
  console.log(`  ${String(d).padStart(4)} m   rms ${(20 * Math.log10(b.rms / a.rms)).toFixed(2)} dB   peak ${(20 * Math.log10(b.peak / a.peak)).toFixed(2)} dB   → gain × ${(a.rms / b.rms).toFixed(3)} would match rms`);
}
await browser.close();
