import { chromium } from 'playwright';
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '?seed=20261018&car=camper';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 } });
p.on('console', (m) => { const t = m.text(); if (/home sites/.test(t)) console.log(t); });
await p.goto(URL, { waitUntil: 'load', timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await b.close();
