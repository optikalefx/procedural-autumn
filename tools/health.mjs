#!/usr/bin/env node
/**
 * Boot health check. Several authors edit this tree concurrently; this answers
 * "is the app currently bootable, and if not, whose module broke it" quickly
 * and cheaply (small viewport, low bake resolution).
 */
import { chromium } from 'playwright';

const res = process.argv[2] ?? '512';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message)));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });

let ok = false;
try {
  await p.goto(`http://localhost:5178/?res=${res}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 120000, polling: 300 });
  ok = true;
} catch { /* reported below */ }

const info = ok ? await p.evaluate(() => ({
  fps: window.__fps,
  calls: window.__engine?.renderer?.info?.render?.calls,
  tris: window.__engine?.renderer?.info?.render?.triangles,
  systems: Object.fromEntries(Object.entries(window.__systems ?? {}).map(([k, v]) => [k, v.enabled !== false])),
})) : { bootError: await p.evaluate(() => window.__bootError ?? null) };

console.log(JSON.stringify({ ok, ...info, errors: [...new Set(errs)].slice(0, 6) }, null, 1));
await b.close();
process.exit(ok ? 0 : 1);
