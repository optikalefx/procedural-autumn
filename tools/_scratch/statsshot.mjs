#!/usr/bin/env node
/**
 * statsshot — the settings sheet's three pages, photographed.
 *
 *   node tools/_scratch/statsshot.mjs --dir shots/_scratch/logbook
 *
 * `statscheck.mjs` proves the numbers; this proves the sheet still lays out
 * with a third page in it — the two-button footer, the logbook's own header,
 * and the sky catalogue below the fold.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = resolve(arg('dir', 'shots/_scratch/logbook'));
mkdirSync(DIR, { recursive: true });

await acquire('statsshot');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 780 } });
p.on('pageerror', (e) => console.log('PAGEERR', e.message));
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
        removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {},
        set onmessage(_) {} };
    }
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
  // A logbook with plausible history in it, so the layout is judged against
  // numbers of a realistic width rather than against a column of em dashes.
  try {
    localStorage.setItem('pa.stats', JSON.stringify({
      v: 1, firstPlayed: Date.parse('2026-07-02'), lastPlayed: Date.now(), sessions: 23,
      n: {
        'time.total': 41400, 'drive.time': 22800, 'drive.dist': 214000,
        'drive.night': 4100, 'drive.rescues': 17,
        'drive.time.camper': 15200, 'drive.dist.camper': 148000,
        'drive.time.roamer': 7600, 'drive.dist.roamer': 66000,
        'air.time': 213, 'air.jumps': 141,
        'water.time': 5400, 'water.dist': 9100, 'water.strokes': 2840,
        'boat.launch.canoe': 12, 'boat.launch.kayak': 7,
        'water.time.canoe': 3600, 'water.time.kayak': 1800,
        'camp.made': 31, 'camp.struck': 27, 'camp.night': 12, 'camp.dogs': 26,
        'camp.time': 8800,
        'seen.deer': 84, 'seen.bear': 6, 'seen.rabbit': 52, 'seen.flocks': 39,
        'birds.startled': 71,
        'photo.taken': 46, 'photo.time': 2600,
        'scope.uses': 9, 'scope.time': 1750,
      },
      hi: { 'session.long': 5400, 'speed.top': 34.2, 'alt.high': 421, 'range.far': 1840, 'air.long': 2.4 },
      lo: { 'bear.near': 21.4 },
      sets: {
        seeds: ['20261018', '7', '99123'],
        falls: ['20261018:0', '20261018:3', '20261018:5', '7:2', '7:9', '99123:1'],
        poi: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
        species: ['deer', 'bear', 'rabbit'],
        sky: ['venus', 'jupiter', 'moon'],
      },
    }));
  } catch { /* private mode */ }
});
await p.goto(`${process.env.AUTUMN_URL || 'http://localhost:5178'}/?seed=20261018&res=512&car=camper&quality=low`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 300 });
const frames = (n) => p.evaluate((k) => new Promise((r) => {
  let i = 0; const t = () => (++i >= k ? r() : requestAnimationFrame(t)); requestAnimationFrame(t);
}), n);

await p.evaluate(() => window.__hud.toggleSettings());
await frames(20);
await p.screenshot({ path: `${DIR}/settings.png` });

await p.evaluate(() => window.__hud.settings._showPage('stats'));
await frames(20);
await p.screenshot({ path: `${DIR}/logbook-top.png` });

await p.evaluate(() => { const n = window.__hud.settings.bodyStats; n.scrollTop = n.scrollHeight; });
await frames(10);
await p.screenshot({ path: `${DIR}/logbook-bottom.png` });

console.log('wrote', DIR);
await b.close();
