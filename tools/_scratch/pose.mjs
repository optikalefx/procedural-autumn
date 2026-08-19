import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const rel = await acquire('pose');
const b = await chromium.launch({ args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport:{width:1600,height:900} });
await ctx.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
      return { readyState:3, url, protocol:'', addEventListener(){}, removeEventListener(){}, send(){}, close(){},
               set onopen(_){}, set onmessage(_){}, set onclose(_){}, set onerror(_){} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
const p = await ctx.newPage();
await p.goto('http://localhost:5178?res=1536');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.evaluate(() => window.__settle(180));
console.log(await p.evaluate(() => {
  const c = window.__ctx.camera, T = window.__THREE;
  const d = c.getWorldDirection(new T.Vector3());
  return JSON.stringify({
    pos: [+c.position.x.toFixed(2), +c.position.y.toFixed(2), +c.position.z.toFixed(2)],
    look: [+(c.position.x+d.x*60).toFixed(2), +(c.position.y+d.y*60).toFixed(2), +(c.position.z+d.z*60).toFixed(2)],
    fov: c.fov, hour: window.__sky?.hour ?? window.__ctx.systems?.weather?.hour ?? null,
  });
}));
await b.close(); rel?.();
