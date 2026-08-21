#!/usr/bin/env node
/**
 * The complaint measured in the real game: park the camera one metre from a
 * river polyline point and read the rivers bus, its spectrum, and how it sits
 * against the rest of the mix.
 *
 *   node tools/_scratch/creeknear.mjs            # current tree
 *   git stash push src/audio/water.js && node … && git stash pop   # the A/B
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 700, height: 420 } });
await page.goto('http://localhost:5178?res=480', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.mouse.click(350, 210);
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const a = window.__audio, w = a.water;
  // The busiest river point in the valley — the worst case the player meets.
  let best = -1, bf = -1;
  for (let i = 0; i < w.rvN; i++) if (w.rvF[i] > bf) { bf = w.rvF[i]; best = i; }
  const x = w.rvX[best], z = w.rvZ[best];
  const terrainY = window.__engine?.world?.heightAt?.(x, z) ?? 0;
  window.__forceCamera = true;
  const c = window.__engine.camera;
  c.position.set(x + 1, terrainY + 1.6, z);
  c.updateMatrixWorld(true);
  await new Promise((r) => setTimeout(r, 4000));           // let the smoothing settle

  const meter = (bus, ms) => new Promise((resolve) => {
    let peak = 0, rms = 0, n = 0;
    const t0 = performance.now();
    const tick = () => {
      const m = a.measure(bus);
      if (m) { if (m.peak > peak) peak = m.peak; rms += m.rms; n++; }
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else resolve({ peak, rms: n ? rms / n : 0 });
    };
    requestAnimationFrame(tick);
  });
  const buses = {};
  for (const b of ['rivers', 'falls', 'ambience', 'master']) buses[b] = await meter(b, 2500);
  const v = w.rivers.find((r) => r.target === best) ?? w.rivers[0];
  return {
    flow: +bf.toFixed(2),
    voice: { level: +v.level.toFixed(4), air: Math.round(v.air.frequency.value),
      low: +v.gLow.gain.value.toFixed(3), body: +v.gBody.gain.value.toFixed(3),
      hiss: +v.gHiss.gain.value.toFixed(3) },
    buses,
  };
});
await browser.close();
const dB = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-inf');
console.log(`river point flow ${out.flow}, camera 1 m away`);
console.log(' voice:', JSON.stringify(out.voice));
for (const [k, m] of Object.entries(out.buses)) {
  console.log(`  ${k.padEnd(9)} rms ${dB(m.rms).padStart(6)} dBFS   peak ${dB(m.peak).padStart(6)} dBFS`);
}
