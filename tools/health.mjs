#!/usr/bin/env node
/**
 * Boot health check. Several authors edit this tree concurrently; this answers
 * "is the app currently bootable, and if not, whose module broke it" quickly
 * and cheaply (small viewport, low bake resolution).
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';

const res = process.argv[2] ?? '512';
await acquire('health');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
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

// A shader that fails to LINK is invisible to lint and to the winding audit:
// the module parses, the geometry is correct, and the system simply renders
// nothing. That is how the game shipped for a while with no grass anywhere and
// no trunks on any tree, while every other check passed. Three's link failures
// arrive on the console, so gate on them explicitly.
const SHADER_FAIL = /Shader Error|VALIDATE_STATUS|not compiled|redefinition|ERROR: 0:/i;
const shaderErrs = [];
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message)));
p.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  errs.push(t.slice(0, 300));
  if (SHADER_FAIL.test(t)) shaderErrs.push(t.slice(0, 900));
});
p.on('pageerror', (e) => { if (SHADER_FAIL.test(String(e.message))) shaderErrs.push(String(e.message).slice(0, 900)); });

let ok = false;
try {
  await p.goto(`http://localhost:5178/?res=${res}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 120000, polling: 300 });
  ok = true;
} catch { /* reported below */ }

const info = ok ? await p.evaluate(() => ({
  fps: window.__fps,
  calls: window.__engine?.renderer?.info?.render?.calls,
  tris: window.__engine?.renderer?.info?.render?.triangles,
  systems: Object.fromEntries(Object.entries(window.__systems ?? {}).map(([k, v]) => [k, v.enabled !== false])),
})) : { bootError: await p.evaluate(() => window.__bootError ?? null) };

const uniqShader = [...new Set(shaderErrs)];
console.log(JSON.stringify({
  ok: ok && uniqShader.length === 0,
  ...info,
  shaderFailures: uniqShader.length,
  errors: [...new Set(errs)].slice(0, 6),
}, null, 1));

if (uniqShader.length) {
  console.error(`\n✗ ${uniqShader.length} shader(s) failed to compile or link.`);
  console.error('  A system whose shader does not link renders NOTHING, silently —');
  console.error('  lint and the winding audit both pass while it is happening.\n');
  for (const e of uniqShader) console.error(e.split('\n').slice(0, 12).join('\n') + '\n');
}

await b.close();
process.exit(ok && !uniqShader.length ? 0 : 1);
