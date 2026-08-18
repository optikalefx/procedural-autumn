// Resilient probe: peers' HMR reloads keep destroying the execution context,
// so re-wait for __ready and retry the evaluate instead of dying.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

await acquire('probe');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto('http://localhost:5178');

const expr = process.argv[2] || "'no expr'";
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 300 });
    console.log(await p.evaluate(expr));
    break;
  } catch (e) {
    console.error(`[retry ${attempt}] ${String(e.message).slice(0, 90)}`);
    await p.waitForTimeout(2500);
  }
}
await b.close();
