import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 500, height: 400 } });
const msgs = [];
p.on('console', m => msgs.push(m.type()+': '+m.text().slice(0,600)));
p.on('pageerror', e => msgs.push('PAGEERROR: '+e.message.slice(0,900)));
await p.goto((process.env.AUTUMN_URL||'http://localhost:5178')+'/?seed=20261018', { waitUntil:'domcontentloaded' });
try { await p.waitForFunction(() => window.__ready === true, null, { timeout: 120000, polling: 250 }); console.log('READY'); }
catch { console.log('NOT READY'); }
console.log(msgs.slice(-40).join('\n'));
await b.close();
