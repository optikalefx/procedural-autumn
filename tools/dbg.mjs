import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:800,height:450}});
p.on('pageerror', e => console.log('PAGEERROR:', e.stack?.split('\n').slice(0,6).join('\n')));
p.on('console', m => { if (m.type()==='error') console.log('CONSOLE:', m.text()); });
await p.goto('http://localhost:5178');
await p.waitForTimeout(45000);
console.log('ready=', await p.evaluate(()=>window.__ready));
await b.close();
