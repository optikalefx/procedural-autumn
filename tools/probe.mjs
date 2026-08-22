import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';
await acquire('probe');
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:400,height:300}});
p.on('pageerror', e=>console.log('ERR',e.message));
// Neuter Vite's HMR client before any page script runs. A dozen authors edit
  // this tree concurrently, and a peer saving a file mid-run reloads the page
  // and kills the run with "Execution context was destroyed".
  await p.addInitScript(() => {
    const RealWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
        return {
          readyState: 3, url, close() {}, send() {},
          addEventListener() {}, removeEventListener() {},
          set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {},
        };
      }
      return new RealWS(url, protocols);
    };
    window.WebSocket.prototype = RealWS.prototype;
    Object.assign(window.WebSocket, RealWS);
  });

await p.goto((process.env.AUTUMN_URL || 'http://localhost:5178'));
await p.waitForFunction(()=>window.__ready===true,null,{timeout:180000,polling:300});
console.log(await p.evaluate(process.argv[2] || "'no expr'"));
await b.close();
