#!/usr/bin/env node
/**
 * Pitch a camp on a genuinely sloping hillside and photograph it.
 *
 * The player was refused twice on ordinary sloping ground. Every other harness
 * in this round photographs flat meadow, which is exactly the ground that was
 * never the problem — so this one goes looking for a hillside of a given grade
 * and pitches on it.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const LO = parseFloat(arg('lo', '0.26')), HI = parseFloat(arg('hi', '0.40'));
const DIR = arg('dir', 'shots/camp/slope');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 850 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (p === 'vite-hmr' || String(p).includes('vite')) return { readyState: 3, url: u, protocol: '', addEventListener() {}, removeEventListener() {}, send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    return new Real(u, p);
  };
  window.WebSocket.prototype = Real.prototype;
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const found = await page.evaluate(({ LO, HI }) => {
  const S = window.__campSiteMod, W = window.__world;
  // Rocks and trees stream in around the camera, so the blocker can only see
  // what is resident. Walk outward from where the camper already is.
  const v = window.__systems.vehicle;
  for (let i = 0; i < 40000; i++) {
    // Golden-angle spiral out from the origin: covers the valley evenly and
    // finds near sites first, so the camper does not have to be teleported to
    // the far rim to find a hillside.
    const a = i * 2.39996, r = 6 * Math.sqrt(i);
    const x = v.position.x + Math.cos(a) * r, z = v.position.z + Math.sin(a) * r;
    if (r > 260) break;
    if (!W.isInBounds(x, z)) continue;
    // The SAME blocker the game uses. Without it this picked a site with a
    // three-metre boulder sitting in the middle of it and photographed the
    // boulder — the game would never have offered that site to a player.
    const s = S.bestSite(W, x, z, {
      blocked: (bx, bz, br) => window.__camp._blocked(bx, bz, br),
    });
    if (!s.ok || !s.small) continue;
    if (s.grade < LO || s.grade > HI) continue;
    return { x, z, grade: +s.grade.toFixed(3), bump: +s.bumpiness.toFixed(3),
             relief: +s.relief.toFixed(2), score: +s.score.toFixed(2) };
  }
  return null;
}, { LO, HI });

if (!found) { console.error(`no compact site with grade in ${LO}..${HI}`); await browser.close(); process.exit(2); }
console.log('hillside site:', JSON.stringify(found));

mkdirSync(resolve(DIR), { recursive: true });
await page.evaluate(async (f) => {
  const v = window.__systems.vehicle, e = window.__engine, T = window.__THREE;
  // Park the camper uphill of the site so the frame has it in.
  window.__vehicleTeleport?.(f.x + 9, f.z + 9, 2.2);
  await new Promise((r) => setTimeout(r, 1800));
  window.__lighting.hour = 16.8; window.__lighting.cycleSpeed = 0;
  window.__camp.pitchAt(f.x, f.z, { instant: true });
  const y = window.__world.getHeight(f.x, f.z);
  e.camera.fov = 48; e.camera.updateProjectionMatrix();
  // Far enough out and high enough up to clear whatever the valley put next to
  // the site — the first run of this framed the inside of a boulder.
  e.camera.position.set(f.x - 7.5, y + 7.0, f.z - 7.5);
  e.camera.lookAt(f.x, y + 0.35, f.z);
  window.__forceCamera = true;
  if (window.__settleStable) await window.__settleStable(600, 24);
}, found);
await page.waitForTimeout(700);
await page.screenshot({ path: resolve(DIR, 'hillside.png') });
console.log('shot:', resolve(DIR, 'hillside.png'));
const state = await page.evaluate(() => ({
  props: window.__camp.props.map((p) => p.item.kind),
  radius: window.__camp.site?.radius, small: window.__camp.site?.small,
}));
console.log('camp:', JSON.stringify(state));
if (errs.length) console.log('page-errors:', errs.slice(0, 3));
await browser.close();
