#!/usr/bin/env node
/**
 * Several camps at once.
 *
 * The player: "if I forget to pack up camp, I can't make a new camp elsewhere.
 * Let's not make that a requirement. I can make as many camps as I want as long
 * as they aren't right next to each other."
 *
 * So: pitch a run of them, check they all survive, check one too close is
 * refused (and offered as a pack-up instead), and check the cap recycles the
 * furthest rather than blocking.
 */
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
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 260)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 260)); });
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { const p = window.__poi.best('meadow'); window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9); });
await page.waitForTimeout(2400);

const r = await page.evaluate(async () => {
  const camp = window.__camp, v = window.__systems.vehicle, W = window.__world;
  const S = window.__campSiteMod;
  const spin = (n) => new Promise((res) => { let i = 0; const t = () => (++i >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
  const out = { steps: [] };
  camp.strike(); await spin(20);

  // Pitch a run of camps at increasing distance from the camper, each far
  // enough from the last that the separation rule is satisfied.
  const placed = [];
  for (let i = 0; i < 6; i++) {
    const a = i * 1.1;
    const d = 30 + i * 22;
    const px = v.position.x + Math.cos(a) * d, pz = v.position.z + Math.sin(a) * d;
    const s = S.bestSite(W, px, pz, { blocked: (bx, bz, br) => camp._blocked(bx, bz, br) });
    if (!s.ok) { out.steps.push({ i, skipped: s.reason }); continue; }
    const c = camp.pitchAt(s.x, s.z, { instant: true });
    await spin(6);
    placed.push(c && { x: +c.x.toFixed(1), z: +c.z.toFixed(1) });
    out.steps.push({ i, pitched: !!c, camps: camp.camps.length,
                     props: camp.camps.map((q) => q.props.length) });
  }

  // A site right on top of an existing camp must refuse — and must hand back
  // that camp as the pack-up target.
  const first = camp.camps[0];
  const near = S.bestSite(W, first.x + 1.5, first.z + 1.5,
    { blocked: (bx, bz, br) => camp._blocked(bx, bz, br) });
  out.overlap = { ok: near.ok, reason: near.reason,
                  packTargetIsThatCamp: camp._packTarget === first };

  // Far enough away must be fine again.
  const away = S.bestSite(W, first.x + 40, first.z + 40,
    { blocked: (bx, bz, br) => camp._blocked(bx, bz, br) });
  out.away = { ok: away.ok, reason: away.reason };

  out.final = {
    camps: camp.camps.length,
    slotsBusy: camp._pool.filter((s2) => s2.busy).length,
    poolSize: camp._pool.length,
    tentsPerCamp: camp.camps.map((c) => c.props.filter((p) => p.item.kind === 'tent').length),
    firesDistinct: new Set(camp.camps.map((c) => c.fire)).size,
    groundsDistinct: new Set(camp.camps.map((c) => c.ground)).size,
    separations: camp.camps.flatMap((c, i2) => camp.camps.slice(i2 + 1)
      .map((d2) => +Math.hypot(c.x - d2.x, c.z - d2.z).toFixed(1))),
  };

  // Striking one must free its slot and leave the rest alone.
  const before = camp.camps.length;
  camp._strike(camp.camps[0], true);
  await spin(4);
  out.afterStrike = { was: before, now: camp.camps.length,
                      slotsBusy: camp._pool.filter((s2) => s2.busy).length };
  return out;
});
console.log(JSON.stringify(r, null, 1));
if (errs.length) console.log('PAGE ERRORS:', errs.slice(0, 5));
await browser.close();
