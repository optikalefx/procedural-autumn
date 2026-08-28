import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-gl=angle','--enable-unsafe-swiftshader']});
const p = await b.newPage({viewport:{width:800,height:500}});
p.on('pageerror', e=>console.log('[pageerror]', e.message));
p.on('console', m=>{ if(m.type()==='error') console.log('[error]', m.text()); });
await p.goto('http://127.0.0.1:5199/tools/_scratch/_journal_lab.html', {waitUntil:'load'});
await p.waitForFunction('window.__ready', null, {timeout:60000});
console.log(await p.evaluate(async () => {
  const j = window.__j;
  j.open({}); j.update(0.5); j.close(); j.update(0.6);
  try { j.dispose(); } catch (e) { return 'dispose threw: ' + e.message; }
  try { j.update(0.1); j.render(null); } catch (e) { return 'post-dispose threw: ' + e.message; }
  return 'dispose ok';
}));
await p.waitForTimeout(700);
await b.close();
