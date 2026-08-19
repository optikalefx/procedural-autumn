import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('audiocheck');
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 300)); });
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close(){}, send(){}, addEventListener(){}, removeEventListener(){},
               set onopen(_){}, set onclose(_){}, set onerror(_){}, set onmessage(_){} };
    }
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
await p.goto('http://localhost:5178/?res=768', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

const before = await p.evaluate(() => { const a = window.__systems.audio; return { started: a.started, failed: a.failed }; });

// What is actually on top of the canvas at the click point?
const hit = await p.evaluate(() => {
  const el = document.elementFromPoint(400, 300);
  const chain = [];
  let n = el;
  while (n && chain.length < 5) {
    const cs = getComputedStyle(n);
    chain.push({ tag: n.tagName, id: n.id, cls: (n.className || '').toString().slice(0, 40),
                 pointerEvents: cs.pointerEvents, opacity: cs.opacity, display: cs.display, z: cs.zIndex });
    n = n.parentElement;
  }
  return chain;
});
console.log('elementFromPoint(400,300):', JSON.stringify(hit, null, 1));

// A real gesture, dispatched the way a player produces one.
await p.mouse.click(400, 300);
await p.keyboard.down('KeyW');
await p.waitForTimeout(2500);
await p.keyboard.up('KeyW');

const after = await p.evaluate(() => {
  const a = window.__systems.audio;
  const ac = a.actx;
  let peak = null;
  try {
    if (a._probe) { const d = new Float32Array(a._probe.fftSize); a._probe.getFloatTimeDomainData(d);
      peak = Math.max(...Array.from(d, Math.abs)); }
  } catch (e) { peak = 'probe error: ' + e.message; }
  return {
    started: a.started, failed: a.failed, muted: a.muted, volume: a.volume,
    ctxState: ac ? ac.state : null,
    ctxTime: ac ? +ac.currentTime.toFixed(3) : null,
    sampleRate: ac ? ac.sampleRate : null,
    peak,
  };
});

console.log(JSON.stringify({ before, after, errors: [...new Set(errs)].slice(0, 6) }, null, 1));
await b.close();
