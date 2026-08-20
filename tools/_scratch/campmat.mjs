#!/usr/bin/env node
// Which camp materials are NOT the same objects at pitch as at prewarm?
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
// Snapshot the camp's material uuids the instant the prewarm is released.
await page.addInitScript(() => {
  window.__matSnap = [];
  const grab = () => {
    const c = window.__camp;
    if (!c) return;
    const out = [];
    const walk = (o, tag) => o?.traverse?.((n) => {
      if (!n.material) return;
      for (const m of (Array.isArray(n.material) ? n.material : [n.material])) {
        out.push({ tag, uuid: m.uuid, type: m.type, name: m.name || n.name });
      }
    });
    walk(c._warm?.group, 'warmprops');
    walk(c.fire?.group, 'fire');
    walk(c.ground?.mesh, 'ground');
    if (c._warm) window.__matSnap = out;     // keep overwriting until released
  };
  const iv = setInterval(grab, 16);
  setTimeout(() => clearInterval(iv), 20000);
});
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { const p = window.__poi.best('meadow'); window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9); });
await page.waitForTimeout(2500);

const r = await page.evaluate(async () => {
  const c = window.__camp, v = window.__systems.vehicle;
  const spin = (n) => new Promise((res) => { let i = 0; const t = () => (++i >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
  c.strike(); await spin(30);
  c.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  await spin(90);
  const now = [];
  const walk = (o, tag) => o?.traverse?.((n) => {
    if (!n.material) return;
    for (const m of (Array.isArray(n.material) ? n.material : [n.material])) {
      now.push({ tag, uuid: m.uuid, type: m.type, name: m.name || n.name });
    }
  });
  walk(c.root, 'props'); walk(c.fire?.group, 'fire'); walk(c.ground?.mesh, 'ground');
  const warmed = new Set((window.__matSnap ?? []).map((m) => m.uuid));
  const fresh = now.filter((m) => !warmed.has(m.uuid));
  const uniq = new Map();
  for (const m of fresh) uniq.set(m.uuid, m);
  return { warmedCount: warmed.size, nowCount: now.length, fresh: [...uniq.values()] };
});
console.log(`prewarm saw ${r.warmedCount} materials; the pitched camp has ${r.nowCount} material slots`);
console.log(`materials that are NEW objects at pitch (${r.fresh.length}):`);
for (const m of r.fresh) console.log(`   ${m.tag.padEnd(8)} ${m.type.padEnd(22)} ${m.name}`);
await browser.close();
