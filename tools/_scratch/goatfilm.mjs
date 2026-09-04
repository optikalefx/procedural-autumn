#!/usr/bin/env node
/**
 * Film one goat, camera locked on it, brain and rig telemetry per frame. Pass
 * `--threat` to put a camper in the picture: the threat states are where both
 * of this animal's reported faults lived, and every aggregate harness in here
 * runs threat-free.
 *
 *   AUTUMN_URL=http://127.0.0.1:5188 node tools/_scratch/goatfilm.mjs \
 *       --seconds 60 --rock yes --threat 32 --out tools/_scratch/goatfilm
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '60'));
const SPEC = arg('species', 'goat');
const WANT_ROCK = arg('rock', 'yes');
const OUT = arg('out', 'tools/_scratch/goatfilm');
const FPS = parseFloat(arg('fps', '8'));
const DIST = parseFloat(arg('dist', '9'));
// The reported scenario is an animal being WATCHED. Park a pretend camper this
// far off; 0 films the animal alone. Without one, ALERT / WATCH / a held PERCH
// never run, and those are two thirds of what a player ever sees of a goat.
const THREAT = parseFloat(arg('threat', '0'));
mkdirSync(OUT, { recursive: true });

const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5188') + '/?res=768&car=camper';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('ERR', String(e)));
// A fresh headless context is a brand-new player, so `HUD.maybeShowIntro`
// opens the first-run journal 400 ms after boot and its view dims the world
// behind it — every frame of the first film was a picture of a book. Same
// recipe as `tools/shot.mjs`.
await page.addInitScript(() => {
  try {
    const k = 'pa.hud';
    const s = JSON.parse(localStorage.getItem(k) ?? '{}') || {};
    s.introSeen = true; s.seenHint = true; s.escSeen = true;
    localStorage.setItem(k, JSON.stringify(s));
  } catch { /* storage may be unavailable; the film is still worth taking */ }
});
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const ok = await page.evaluate(async (P) => {
  const e = window.__engine, wl = window.__systems.wildlife, W = window.__world;
  window.__lighting.cycleSpeed = 0;
  window.__lighting.setTimeOfDay?.(0.42);          // midday, so the film is readable
  window.__forceCamera = true;
  wl.debugClear();

  const S = wl.sites, ki = wl.keys.indexOf(P.SPEC);
  const rcfg = wl.pool[P.SPEC][0][0].brain.cfg.rock;
  let pick = null, rock = null;
  for (let i = 0; i < S.n && pick === null; i++) {
    if (S.spec[i] !== ki) continue;
    let has = null;
    if (rcfg) { const g = { rocks: null }; wl._findPerches(g, S.x[i], S.z[i], rcfg); has = g.rocks[0] || null; }
    if (P.WANT_ROCK === 'any' || (P.WANT_ROCK === 'yes') === !!has) { pick = i; rock = has; }
  }
  if (pick === null) return null;

  if (P.THREAT > 0) wl.debugThreat(S.x[pick] + P.THREAT, S.z[pick], 0);
  else wl.debugThreat(null);

  // Stand the camera at the site so `_scan` wakes it, then hand over to the
  // chase camera below.
  const cx = S.x[pick] + 20, cz = S.z[pick] + 20, cy = W.getHeight(cx, cz) + 4;
  e.camera.position.set(cx, cy, cz);
  e.camera.lookAt(S.x[pick], cy, S.z[pick]);
  e.camera.updateMatrixWorld(true);

  window.__pickGoat = () => {
    for (const grp of wl.pool[P.SPEC]) for (const a of grp) if (a.active) return a;
    return null;
  };
  window.__goatCam = (a) => {
    const b = a.brain, cam = e.camera;
    // Uphill of the animal so the camera is never inside the mountain, and
    // broadside to its heading so a turn is legible.
    const ang = b.heading + Math.PI * 0.5;
    let bx = b.pos.x + Math.sin(ang) * P.DIST, bz = b.pos.z + Math.cos(ang) * P.DIST;
    const hy = W.getHeight(bx, bz);
    cam.position.set(bx, Math.max(hy + 1.4, b.pos.y + 2.2), bz);
    cam.lookAt(b.pos.x, b.pos.y + 0.7, b.pos.z);
  };
  window.__goatTel = (a) => {
    const b = a.brain, r = a.rig;
    const NM = ['idle', 'graze', 'wander', 'alert', 'flee', 'patrol', 'watch', 'climb', 'perch'];
    const w = (s) => +(r.act?.[s]?.getEffectiveWeight() ?? 0).toFixed(2);
    return {
      st: NM[b.state],
      hd: +(b.heading * 180 / Math.PI).toFixed(0),
      wh: +(b.wantHeading * 180 / Math.PI).toFixed(0),
      av: +b._avoid.toFixed(2),
      spd: +b.speed.toFixed(2),
      yaw: +(b.yawRate * 180 / Math.PI).toFixed(0),
      td: +Math.hypot(b.target.x - b.pos.x, b.target.z - b.pos.z).toFixed(1),
      rk: b.rock ? +Math.hypot(b.rock.x - b.pos.x, b.rock.z - b.pos.z).toFixed(1) : -1,
      gait: r.gaitName,
      wW: w('walk'), sW: w('stand'), tW: w('trot'), aW: w('alert'), gW: w('graze'),
      ts: +(r.act?.walk?.timeScale ?? 0).toFixed(2),
      pin: +b._pinned.toFixed(1),
      tmr: +b.timer.toFixed(2),
      alarm: +(b.group?.alarm ?? -1).toFixed(2),
      d: +(wl._threatOverride ? Math.hypot(wl._threatOverride.x - b.pos.x, wl._threatOverride.z - b.pos.z) : -1).toFixed(1),
      corn: +b._cornered.toFixed(1),
      live: (() => { let n = 0; for (const g of wl.pool[P.SPEC]) for (const q of g) if (q.active) n++; return n; })(),
    };
  };
  return { site: pick, rock: rock ? { r: +rock.r.toFixed(2), rise: +rock.rise.toFixed(2) } : null };
}, { SPEC, WANT_ROCK, DIST, THREAT });

if (!ok) { console.log('no site'); await browser.close(); process.exit(1); }
console.log('site', JSON.stringify(ok));

// Let the site wake.
await page.waitForFunction(() => !!window.__pickGoat(), null, { timeout: 60000, polling: 100 });

const log = [];
const t0 = Date.now();
let i = 0;
while ((Date.now() - t0) < SECONDS * 1000) {
  const m = await page.evaluate(() => {
    const a = window.__pickGoat();
    if (!a) return null;
    window.__goatCam(a);
    return window.__goatTel(a);
  });
  if (!m) break;
  await page.screenshot({ path: `${OUT}/f${String(i).padStart(3, '0')}.png` });
  log.push({ f: i, t: +((Date.now() - t0) / 1000).toFixed(2), ...m });
  i++;
  const due = t0 + (i * 1000) / FPS;
  const wait = due - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
}
writeFileSync(`${OUT}/log.json`, JSON.stringify(log, null, 1));
console.log(log.map((e) => `${e.f} t${e.t} ${e.st} hd${e.hd} wh${e.wh} av${e.av} spd${e.spd} yaw${e.yaw} td${e.td} rk${e.rk} ${e.gait} w${e.wW} s${e.sW} ts${e.ts} tmr${e.tmr} alarm${e.alarm} d${e.d} corn${e.corn} live${e.live}`).join('\n'));
await browser.close();
