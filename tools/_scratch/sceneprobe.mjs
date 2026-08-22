import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5204';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 320, height: 240 } });
p.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 200)));
await p.goto(`${URL}/?res=512`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
console.log(JSON.stringify(await p.evaluate(() => {
  const e = window.__engine, s = e.scene, r = e.renderer;
  const cc = new window.__THREE.Color(); r.getClearColor(cc);
  return {
    children: s.children.map((c) => `${c.name || c.type}:${c.visible}`),
    background: s.background ? s.background.getHexString?.() ?? String(s.background) : null,
    clear: cc.getHexString(), clearAlpha: r.getClearAlpha(),
    autoClear: r.autoClear,
    hasRenderCb: !!e._render,
    postfx: Object.keys(window.__postfx || {}),
  };
}), null, 1));
await b.close();
