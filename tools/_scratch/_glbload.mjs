#!/usr/bin/env node
/** Boot once and report what the loader measured for every hand-authored species. */
import { chromium } from 'playwright';
const URL = (process.env.AUTUMN_URL || 'http://localhost:5212') + '?seed=20261018&car=camper&quality=high';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const lines = [];
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[glb_rig]') || m.type() === 'error') lines.push(`[${m.type()}] ${t.slice(0, 400)}`);
});
await page.goto(URL, { waitUntil: 'load', timeout: 240000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 300000 });
await page.evaluate(() => window.__settleStable?.() ?? window.__settle?.(60));
for (const l of lines) console.log(l);
const gaits = await page.evaluate(() => {
  const out = {};
  for (const k of ['deer', 'bear', 'fox']) {
    const sp = window.__systems.wildlife?.SPECIES?.[k];
    if (sp) out[k] = sp.gait;
  }
  return out;
});
console.log('GAITS', JSON.stringify(gaits));
await browser.close();
