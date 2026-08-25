#!/usr/bin/env node
/**
 * Scratch: one posed night frame with the firefly debug uniform settable, and
 * optionally a burst of frames a fraction of a second apart (the blink test).
 *
 *   AUTUMN_URL=http://127.0.0.1:5199 node tools/_scratch/ffshot.mjs \
 *       --view camp --hour 22 --shots 4 --gap 140 --dir shots/ff-blink
 */
import { chromium } from 'playwright';
import { acquire } from './../_lock.mjs';
import { POSE_SRC } from './../_pose.mjs';
import { VIEWS } from './../shot.mjs';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '?seed=' + arg('seed', '20261018');
const view = arg('view', 'camp');
const hour = Number(arg('hour', '22'));
const debug = Number(arg('debug', '0'));
const dir = arg('dir', 'shots/ff-dbg');
const shots = Number(arg('shots', '1'));
const gap = Number(arg('gap', '120'));
const tag = arg('tag', '');

const EXTRA = {
  camp: { anchor: 'meadow', height: 1.7, dist: 8, pitch: -0.06, fov: 60 },
  bank: { anchor: 'mouth', height: 2.0, dist: 14, pitch: -0.10, fov: 60 },
  high: { anchor: 'peak', height: 6, dist: 20, pitch: -0.05, fov: 60 },
};
const ALL = { ...VIEWS, ...EXTRA };

await acquire('ffshot');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('ERR', e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/POSTHOG/.test(m.text())) console.log('CERR', m.text()); });
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {} };
    }
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

let frozen = null;
for (const f of ['review/anchors.json', 'shots/_anchors.json']) {
  if (existsSync(f)) { try { frozen = { ...JSON.parse(readFileSync(f, 'utf8')), ...(frozen ?? {}) }; } catch { /* corrupt */ } }
}
const poseFn = new Function('P', POSE_SRC);
await p.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, hour);
await p.evaluate(poseFn, { v: ALL[view], frozen, dynamic: ['vehicle'] });
await p.evaluate(async () => { if (window.__settleStable) await window.__settleStable(); await window.__settle(400); });
mkdirSync(dir, { recursive: true });
const base = `${view}-h${String(hour).replace('.', 'p')}${tag}`;
// --tune "sizeMul:gain:coreR:haloG,..." sweeps the shaping knobs in one boot.
const tunes = arg('tune', null) ? String(arg('tune')).split(',') : [null];
for (const d of String(arg('debugs', String(debug))).split(',').map(Number)) {
 for (const t of tunes) {
  await p.evaluate(([dv, tv]) => {
    const ff = window.__systems.wildlife.fireflies;
    const u = ff?.uniforms ?? {};
    if (u.uDebug) u.uDebug.value = dv;
    if (tv) {
      const [sm, g, cr, hg] = tv.split(':').map(Number);
      if (u.uSizeMul) u.uSizeMul.value = sm;
      if (u.uGain) u.uGain.value = g;
      if (u.uCoreR) u.uCoreR.value = cr;
      if (u.uHaloG) u.uHaloG.value = hg;
    }
  }, [d, t]);
  const suffix = (argv.includes('--debugs') ? `-d${d}` : '') + (t ? '-t' + t.replace(/:/g, '_') : '');
  for (let i = 0; i < shots; i++) {
    await p.waitForTimeout(i === 0 ? 500 : gap);
    await p.screenshot({ path: `${dir}/${base}${suffix}${shots > 1 ? '-' + i : ''}.png` });
  }
 }
}
const info = await p.evaluate(() => {
  const ff = window.__systems.wildlife.fireflies;
  const u = ff?.uniforms ?? {};
  return { visible: ff?.points?.visible, op: u.uOpacity?.value, dens: u.uDensity?.value, px: u.uPixelScale?.value };
});
console.log('ok', dir, JSON.stringify(info));
await b.close();
