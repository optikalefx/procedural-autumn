#!/usr/bin/env node
// Which materials link a NEW program when a camp is pitched?
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (p === 'vite-hmr' || String(p).includes('vite')) return { readyState: 3, url: u, protocol: '', addEventListener() {}, removeEventListener() {}, send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    return new Real(u, p);
  };
  window.WebSocket.prototype = Real.prototype;
});
page.on('console', (m) => { const t = m.text(); if (/camp|prewarm|program/i.test(t)) console.log('LOG:', t.slice(0, 300)); });
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { const p = window.__poi.best('meadow'); window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9); });
await page.waitForTimeout(2500);

const r = await page.evaluate(async () => {
  const e = window.__engine, camp = window.__camp, v = window.__systems.vehicle;
  const key = (p) => `${p.cacheKey ?? ''}`.slice(0, 90);
  const snap = () => new Set((e.renderer.info.programs ?? []).map((p) => `${p.id}|${key(p)}`));
  const spin = (n) => new Promise((res) => { let i = 0; const t = () => (++i >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
  camp.strike(); await spin(40);
  const before = snap();
  camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  await spin(120);
  const after = snap();
  const added = [...after].filter((k) => !before.has(k));
  // Which materials in the camp have no program the prewarm could have cached?
  const mats = new Map();
  const collect = (o, tag) => o?.traverse?.((n) => {
    if (!n.material) return;
    for (const m of (Array.isArray(n.material) ? n.material : [n.material])) {
      mats.set(m.uuid, { tag, name: m.name || n.name || m.type, type: m.type,
                         cast: n.castShadow, custom: !!n.customDepthMaterial });
    }
  });
  collect(camp.root, 'props');
  collect(camp.fire?.group, 'fire');
  collect(camp.ground?.mesh, 'ground');
  return { addedCount: added.length, added: added.slice(0, 40),
           campMaterials: [...mats.values()] };
});
console.log('new programs at pitch:', r.addedCount);
for (const a of r.added) console.log('  ', a);
console.log('\ncamp materials in scene:');
for (const m of r.campMaterials) console.log(`   ${m.tag.padEnd(7)} ${String(m.name).padEnd(26)} ${m.type.padEnd(22)} cast=${m.cast} customDepth=${m.custom}`);
await browser.close();
