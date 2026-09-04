#!/usr/bin/env node
/**
 * Film the bike getting air, in the real game.
 *
 * The headless unit harness (bikefly.mjs) proves the physics; this proves the
 * game — the model, the camera, the audio cue and the logbook all see the same
 * flight the unit sim does. It runs on reel.mjs's granted clock for the reason
 * that file gives: a slow frame must cost wall clock, not screen time, or the
 * capture films a world running in slow motion and calls it gameplay.
 *
 *   node tools/_scratch/bikeair_video.mjs [--port 5272] [--seconds 14]
 *
 * Writes review/bike-air.mp4 and prints the flight telemetry, frame by frame,
 * because the repo's own debug-visual-video note says a capture without
 * telemetry cannot tell "it worked" from "it stopped".
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const PORT = arg('port', '5272');
const SECONDS = Number(arg('seconds', 14));
const FPS = 60, W = 1280, H = 720;
const FRAMES = Math.round(SECONDS * FPS);
const TMP = 'review/_bikeair';
const OUT = 'review/bike-air.mp4';

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync('review', { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// A fresh headless context is a brand-new player, so the first-run journal opens
// 400 ms after boot — on a REAL setTimeout, which the granted clock cannot hold
// off — and the open book fills the frame. reel.mjs and shot.mjs have carried
// these three lines since the popup shipped; the peak of the first successful
// jump here was filmed entirely behind the title page.
//
// The HMR stub is the other half of reel.mjs's boilerplate: several checkouts
// share this machine and a save mid-film reloads the page and throws out the run.
await page.addInitScript(() => {
  try {
    const k = 'pa.hud';
    const st = JSON.parse(localStorage.getItem(k) ?? '{}') || {};
    st.introSeen = true; st.seenHint = true; st.escSeen = true;
    localStorage.setItem(k, JSON.stringify(st));
  } catch { /* storage unavailable; the run is still worth attempting */ }
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {},
               set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});

await page.goto(`http://127.0.0.1:${PORT}/?quality=high&pixelratio=native&iscale=1`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__bike && !!window.__engine, null, { timeout: 60000 });

// ── take the clock (reel.mjs's recipe) ───────────────────────────────────────
await page.evaluate((fps) => {
  const e = window.__engine;
  e.adaptive = false; e.autoQuality = false;
  const DT = 1 / fps; let budget = 0;
  window.__grant = () => { budget += DT; };
  e.clock.getDelta = () => { if (budget <= 1e-9) return 0; budget -= DT; return DT; };
}, FPS);

// ── where to film ────────────────────────────────────────────────────────────
//
// `--at x,z,heading --lip x,z` films a run that tools/_scratch/bikefind.mjs has
// already RIDDEN in the unit sim and knows produces a flight. Four earlier takes
// of this tool chose runs from terrain statistics alone and filmed, in order: a
// bike stuck in a tree, a bike that never moved, a 15 m/s descent down ground so
// smooth it had no curvature to launch from, and a pass 18 m wide of the lip.
// Terrain statistics cannot answer "will a bike get there, fast, and leave the
// ground" — only riding it can, and riding it headless is free.
//
// Without --at it falls back to searching here, which is kept because it is how
// the shortlist was found in the first place, and is honest about being worse.
const AT = arg('at', null), LIPARG = arg('lip', null);
let spots;
if (AT) {
  const [x, z, h] = AT.split(',').map(Number);
  const [lx, lz] = (LIPARG ?? '').split(',').map(Number);
  spots = [{ x, z, h, lipX: lx, lipZ: lz, fromFind: true }];
} else {
  spots = await page.evaluate(() => {
    const W = window.__bike.ctx.world;
    const H = (x, z) => W.getHeight(x, z);
    const SPAN = 2.2, G = 9.81, TARGET = 11;
    const found = [];
    for (let i = 0; i < 40000; i++) {
      const x = (Math.random() * 2 - 1) * 1150, z = (Math.random() * 2 - 1) * 1150;
      if (W.getWaterDepth(x, z) > 0.1) continue;
      let bh = 0, bd = -1e9;
      for (let a = 0; a < 16; a++) {
        const h = a / 16 * Math.PI * 2;
        const d = H(x, z) - H(x + Math.sin(h) * 12, z + Math.cos(h) * 12);
        if (d > bd) { bd = d; bh = h; }
      }
      if (bd < 3) continue;
      const fx = Math.sin(bh), fz = Math.cos(bh), hh = SPAN * 0.5;
      const at = (k) => H(x + fx * k * hh, z + fz * k * hh);
      const ypp = (2 * at(-2) - at(-1) - 2 * at(0) - at(1) + 2 * at(2)) / (7 * hh * hh);
      if (TARGET * TARGET * ypp > -(G + 2.5)) continue;
      const sx = x - fx * 55, sz = z - fz * 55;
      if (W.getSlope(sx, sz) > 0.5 || W.getWaterDepth(sx, sz) > 0.1) continue;
      const runIn = H(sx, sz) - H(x, z);
      if (runIn < 8) continue;
      found.push({ x: sx, z: sz, h: bh, lipX: +x.toFixed(0), lipZ: +z.toFixed(0), score: runIn - ypp * 40 });
    }
    return found.sort((a, b) => b.score - a.score).slice(0, 25);
  });
}
console.log(`[bikeair] ${spots.length} run(s) to try`);

/**
 * Park here, pedal for three seconds of world time, and report how far it got.
 *
 * Three and not the half-second the first version used. From a standing start
 * half a second is 0.2-0.3 m however good the run is, so a "moved > 0.8 m" gate
 * rejected all 25 candidates and reported that none could get rolling — which
 * was the gate's opinion, not the bike's.
 */
const tryRun = async (s) => page.evaluate((s) => new Promise((res) => {
  const B = window.__bike;
  // Get OFF first. `parkAt` is refused while a bike is already being ridden, and
  // it is refused silently: every retry after the first one reused the stale
  // bike at the previous spot, so fifteen different candidates reported the
  // same position, the same speed to sixteen decimal places, and the same
  // verdict. The giveaway was `gotX` never matching `askedX`, which is why the
  // trial reports both.
  B.dismount();
  const parked = B.parkAt(s.x, s.z, { yaw: s.h });
  const mounted = B.mount();
  B.drive(1, 0);
  const p = B.bike?.phys;
  if (!p) return res({ moved: 0, blocked: null, why: 'no bike after parkAt' });
  const W = B.ctx.world;
  const x0 = p.x, z0 = p.z;
  let n = 0;
  const f = () => {
    window.__grant();
    if (++n < 180) requestAnimationFrame(f);
    else res({
      moved: Math.hypot(p.x - x0, p.z - z0), blocked: p.blocked, v: Math.abs(p.speed),
      riding: B._riding, mounted: !!mounted,
      askedX: +s.x.toFixed(0), gotX: +x0.toFixed(0), askedZ: +s.z.toFixed(0), gotZ: +z0.toFixed(0),
      slope: +W.getSlope(x0, z0).toFixed(2), water: +W.getWaterDepth(x0, z0).toFixed(2),
      trunks: (B.ctx.systems?.trees?.trunksNear?.(x0, z0, 6) ?? []).length,
      rock: !!B.ctx.systems?.rocks?.boulderNear?.(x0, z0, 2.4, 0.55),
      grade: +p.grade.toFixed(2),
    });
  };
  requestAnimationFrame(f);
}), s);

let spot = null;
for (const cand of spots) {
  const r = await tryRun(cand);
  console.log(`[bikeair] try ${cand.x.toFixed(0)},${cand.z.toFixed(0)} → ${JSON.stringify(r)}`);
  if (Math.abs(r.gotX - r.askedX) > 2 || Math.abs(r.gotZ - r.askedZ) > 2) continue;  // park refused
  // A --at run has already been ridden end to end in the unit sim, so the only
  // thing the trial can still tell us is whether the GAME has something in the
  // way that the unit sim does not — a trunk or a boulder. Distance travelled
  // in the first three seconds is a proxy for that and a bad one: this gate at
  // 12 m rejected a verified 2.9 m jump for arriving 11.34 m in.
  if (cand.fromFind) { if (!r.blocked) { spot = cand; break; } continue; }
  if (r.moved > 12 && !r.blocked) { spot = cand; break; }
}
if (!spot) { console.log('[bikeair] no candidate could get rolling'); await browser.close(); process.exit(1); }
console.log('[bikeair] run chosen', spot);

// `--speed N` puts the bike on the lip's approach already rolling.
//
// It is not a cheat for the measurement, it is a shorter one: the question is
// whether a bike CARRYING SPEED over a crest leaves the ground, and a 60 m
// pedal-up to the crest only adds the chance of a tree in the way — which is
// exactly what spoiled the previous take, stalling the bike 38 m short of a lip
// the unit sim clears every time. The launch itself is untouched; `_vertical`
// never asks where the speed came from.
const SPEED = Number(arg('speed', 0));
// Point it and let go. Any steering at all changes which line the bike takes
// over the crest, and the crest is only a crest along one of them.
const NOSTEER = process.argv.includes('--nosteer');
await page.evaluate(([s, v, ns]) => {
  const B = window.__bike;
  B.dismount();
  B.parkAt(s.x, s.z, { yaw: s.h });
  B.mount();
  if (v > 0) B.bike.phys.speed = v;
  B.drive(1, 0);
  window.__noSteer = ns;
}, [spot, SPEED, NOSTEER]);

// ── ride, filming ────────────────────────────────────────────────────────────
const tele = [];
for (let i = 0; i < FRAMES; i++) {
  const t = await page.evaluate((lip) => new Promise((res) => {
    const B = window.__bike, W = B.ctx.world, p = B.bike.phys;
    // AIM at the lip while it is still ahead, then hold the fall line past it.
    // Steering by local gradient alone drifts: the previous take passed 18 m
    // wide of the chosen lip at 15.2 m/s and filmed no jump at all. A lip is a
    // point, and a rider going for one points at it.
    const dx = lip.x - p.x, dz = lip.z - p.z;
    const dist = Math.hypot(dx, dz);
    // Aim while the lip is far, then HOLD THE LINE for the last 12 m.
    //
    // Still steering at the lip was why the previous take crossed it at
    // 11.6 m/s and stayed on the ground: `_curvature` is fitted along the
    // bike's own heading, and a rider turning across a ridge genuinely meets a
    // gentler crest than one going straight over it. That is the physics being
    // right, not wrong — measured at the same lip, going straight, the launch
    // fires and the bike is airborne for the whole crossing. A rider hitting a
    // jump does not steer on the lip either.
    let turn = 0;
    if (dist > 12 && !window.__noSteer) {
      let err = Math.atan2(dx, dz) - p.heading;             // +Z is heading 0
      err = Math.atan2(Math.sin(err), Math.cos(err));
      turn = Math.max(-1, Math.min(1, err * 2.2));
    }
    B.drive(1, turn);
    window.__grant();
    requestAnimationFrame(() => requestAnimationFrame(() => res({
      x: +p.x.toFixed(1), z: +p.z.toFixed(1), y: +p.y.toFixed(2),
      v: +Math.abs(p.speed).toFixed(2), air: p.airborne,
      airT: +p.airT.toFixed(2), peak: +p.airPeak.toFixed(2),
      land: +p.landImpact.toFixed(1), grade: +p.grade.toFixed(2), blocked: p.blocked,
    })));
  }), { x: spot.lipX, z: spot.lipZ });
  tele.push(t);
  await page.screenshot({ path: `${TMP}/f${String(i).padStart(5, '0')}.png` });
}

await browser.close();

// ── what happened ────────────────────────────────────────────────────────────
const flights = [];
let run = null;
for (const t of tele) {
  if (t.air) run ??= { start: t, peak: 0, frames: 0 };
  if (t.air && run) { run.peak = Math.max(run.peak, t.peak); run.frames++; }
  if (!t.air && run) {
    if (run.frames > 3) flights.push({
      air: +(run.frames / FPS).toFixed(2), peak: +run.peak.toFixed(2),
      at: `${run.start.x},${run.start.z}`, launchV: run.start.v, land: t.land,
    });
    run = null;
  }
}
const top = Math.max(...tele.map(t => t.v));
console.log(`[bikeair] top speed ${top.toFixed(1)} m/s over ${SECONDS}s`);
console.log(`[bikeair] flights over 3 frames:`, flights.length ? flights : 'none');
writeFileSync(`${TMP}/telemetry.json`, JSON.stringify(tele, null, 1));
if (errors.length) console.log('[bikeair] page errors:', errors.slice(0, 5));

execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS),
  '-i', `${TMP}/f%05d.png`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
console.log(`[bikeair] wrote ${OUT}`);
