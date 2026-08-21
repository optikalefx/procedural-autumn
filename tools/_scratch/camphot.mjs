#!/usr/bin/env node
/**
 * The blown-out pool of light on the grass at dusk.
 *
 * Reported by a peer session against the telescope: an oval 8-10 m across in
 * which the meadow clips to pure white, centred well off the fire, at hour
 * 20.4. Anything pale standing in it reads as blown out, and the brief's
 * hardest rule is that nothing out-values the fire.
 *
 * Rather than squint at a PNG: read the light's ACTUAL state and position each
 * frame, and compare it against where the fires are. If the light is not at a
 * fire, the carry logic is wrong; if it is, the falloff is.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 850 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (p === 'vite-hmr' || String(p).includes('vite')) return { readyState: 3, url: u, protocol: '', addEventListener() {}, removeEventListener() {}, send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    return new Real(u, p);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { const p = window.__poi.best('meadow'); window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9); });
await page.waitForTimeout(2400);

// Latch the park brake the way a player does. The dip is gated on
// `vehicle.brakeHold`, which is driven by the physics — setting it from an
// evaluate lasts exactly one frame before `update` overwrites it, and the first
// run of this test measured the UNDIPPED beam while believing otherwise.
await page.evaluate(() => { window.__lighting.hour = 20.4; window.__lighting.cycleSpeed = 0; });
await page.keyboard.down('Space');
await page.waitForTimeout(1000);
await page.keyboard.up('Space');
await page.waitForTimeout(2500);          // let the dip ease in
const brake = await page.evaluate(() => ({
  brakeHold: window.__systems.vehicle.brakeHold,
  parkDip: +(window.__systems.vehicle._parkDip ?? -1).toFixed(3),
  beam: +(window.__systems.vehicle.headlights?.[0]?.intensity ?? -1).toFixed(1),
}));
console.log('brake:', JSON.stringify(brake));

const r = await page.evaluate(async () => {
  const camp = window.__camp, v = window.__systems.vehicle;
  const spin = (n) => new Promise((res) => { let i = 0; const t = () => (++i >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
  camp.strike(); await spin(20);
  const c = camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  await spin(40);

  // Sample the light over a second: intensity flickers, position should not.
  const L = camp.fireLight;
  const samples = [];
  for (let i = 0; i < 40; i++) {
    await new Promise(requestAnimationFrame);
    samples.push({ i: +L.intensity.toFixed(2),
                   x: +L.position.x.toFixed(2), y: +L.position.y.toFixed(2), z: +L.position.z.toFixed(2) });
  }
  const iv = samples.map((s) => s.i);
  const off = samples.map((s) => Math.hypot(s.x - c.x, s.z - c.z));
  return {
    camp: { x: +c.x.toFixed(2), z: +c.z.toFixed(2), y: +c.y.toFixed(2), radius: c.radius },
    light: {
      distance: L.distance, decay: L.decay,
      colour: '#' + L.color.getHexString(),
      intensityMin: +Math.min(...iv).toFixed(2),
      intensityMax: +Math.max(...iv).toFixed(2),
      offFireMax: +Math.max(...off).toFixed(2),
      y: samples[samples.length - 1].y,
    },
    // What three actually multiplies at 1 m, 2 m and 4 m from a point light
    // with this intensity and decay. Three's punctual falloff is
    // intensity / distance^decay, with intensity already scaled by 4*pi in
    // physically-correct mode — this is the raw shape of it.
    falloff: [0.5, 1, 2, 4, 8].map((d) => ({
      d, mul: +(Math.max(...iv) / Math.pow(d, L.decay)).toFixed(2),
    })),
    // The camp's own props for reference.
    props: camp.camps[0].props.map((p) => ({
      kind: p.item.kind,
      dFromFire: +Math.hypot(p.item.x - c.x, p.item.z - c.z).toFixed(2),
    })),
  };
});
console.log(JSON.stringify(r, null, 1));

mkdirSync(resolve('shots/camp/hot'), { recursive: true });
await page.evaluate(async (c) => {
  const e = window.__engine;
  e.camera.fov = 50; e.camera.updateProjectionMatrix();
  e.camera.position.set(c.x + 11, c.y + 7, c.z + 11);
  e.camera.lookAt(c.x, c.y, c.z);
  window.__forceCamera = true;
  if (window.__settleStable) await window.__settleStable(600, 24);
}, r.camp);
await page.waitForTimeout(600);
await page.screenshot({ path: resolve('shots/camp/hot/dusk.png') });
console.log('shot: shots/camp/hot/dusk.png');
await browser.close();
