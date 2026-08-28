#!/usr/bin/env node
/**
 * Does a goat actually get on the rock?
 *
 * Wakes a real (not debugSpawn'd) alpine home site that has a boulder in it,
 * parks the camera beside it, runs the simulation on a granted clock, and
 * reports what the band did — plus a strip of frames so the climb can be
 * looked at rather than believed.
 *
 *   AUTUMN_URL=http://127.0.0.1:5213 node tools/_scratch/goatperch.mjs --species goat
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SPECIES = arg('species', 'goat');
const SECONDS = parseFloat(arg('seconds', '180'));
const FRAMES = parseInt(arg('frames', '8'), 10);
const HOUR = parseFloat(arg('hour', '11'));
const OUT = resolve(arg('out', `shots/wildlife/perch-${SPECIES}.png`));

await acquire('wstrip');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 560, height: 380 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(process.env.AUTUMN_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const out = await page.evaluate(async (P) => {
  const e = window.__engine, W = window.__world, wl = window.__systems.wildlife;
  window.__lighting.hour = P.HOUR;
  window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  wl.debugClear();
  wl.debugThreat(null);

  // A site of this species that actually has a boulder in it.
  const S = wl.sites, ki = wl.keys.indexOf(P.SPECIES);
  const cfg = wl.pool[P.SPECIES][0][0].brain.cfg.rock;
  let si = -1, rock = null;
  for (let i = 0; i < S.n && si < 0; i++) {
    if (S.spec[i] !== ki) continue;
    const g = { rocks: null };
    wl._findPerches(g, S.x[i], S.z[i], cfg);
    if (g.rocks.length) { si = i; rock = g.rocks[0]; }
  }
  if (si < 0) return { error: 'no site with a perch' };

  // Camera on the uphill side, back far enough to see the whole outcrop.
  const cx = rock.x + 11, cz = rock.z + 11;
  const cy = W.getHeight(cx, cz) + 3.2;
  e.camera.position.set(cx, cy, cz);
  e.camera.fov = 40;
  e.camera.updateProjectionMatrix();
  // Look AWAY to start with. `_scan`'s frustum guard refuses to wake a site
  // inside the view cone at anything under the far edge of its spawn band —
  // "nothing pops into existence in view" — so a camera pointed straight at
  // the outcrop keeps it asleep forever.
  const lookAway = () => e.camera.lookAt(cx + (cx - rock.x), cy, cz + (cz - rock.z));
  const lookAt = () => e.camera.lookAt(rock.x, rock.top + 0.6, rock.z);
  lookAway();

  e.stop();
  const DT = 1 / 30;
  e.clock.getDelta = () => DT;

  const states = {};
  const NM = ['idle', 'graze', 'wander', 'alert', 'flee', 'patrol', 'watch', 'climb', 'perch'];
  let maxLift = 0, perchFrames = 0, everPerched = 0, everClimbed = 0;
  const seen = new Set();
  const steps = Math.round(P.SECONDS / DT);

  const canvas = e.renderer.domElement;
  const cw = canvas.width, ch = canvas.height;
  const strip = document.createElement('canvas');
  const cols = 4, rows = Math.ceil(P.FRAMES / cols);
  strip.width = cw * cols; strip.height = ch * rows;
  const g2 = strip.getContext('2d');
  g2.fillStyle = '#101014'; g2.fillRect(0, 0, strip.width, strip.height);
  const img = g2.createImageData(cw, ch);
  const buf = new Uint8Array(cw * ch * 4);
  const gl = e.renderer.getContext();
  let shot = 0, cool = 0, threatAt = null, heldWithThreat = 0;

  const grab = (label) => {
    for (let t = 0; t < 4; t++) {
      e.renderer.setRenderTarget(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const o = ((ch >> 1) * cw + (cw >> 1)) * 4;
      if (buf[o] + buf[o + 1] + buf[o + 2] > 4) break;
      e._loop();
    }
    for (let y = 0; y < ch; y++) {
      const src = (ch - 1 - y) * cw * 4;
      img.data.set(buf.subarray(src, src + cw * 4), y * cw * 4);
    }
    const px = (shot % cols) * cw, py = ((shot / cols) | 0) * ch;
    g2.putImageData(img, px, py);
    g2.font = 'bold 13px monospace';
    g2.fillStyle = 'rgba(0,0,0,0.62)';
    g2.fillRect(px + 4, py + 4, g2.measureText(label).width + 10, 19);
    g2.fillStyle = '#ffe9b0';
    g2.fillText(label, px + 9, py + 18);
    g2.strokeStyle = 'rgba(255,255,255,0.18)';
    g2.strokeRect(px + 0.5, py + 0.5, cw - 1, ch - 1);
    shot++;
  };

  // Re-aimed EVERY frame: the camera rig takes it back otherwise, and the
  // strip comes out looking at the camper.
  const turnAt = Math.round(4 / DT);
  const aim = (tx, ty, tz, back) => {
    const d = back ?? 1;
    e.camera.position.set(tx + 7.5 * d, ty + 2.6, tz + 7.5 * d);
    e.camera.lookAt(tx, ty, tz);
  };
  for (let s = 0; s < steps; s++) {
    let watch = null;
    for (const per of wl.pool[P.SPECIES]) for (const a of per) {
      if (a.active && (a.brain.state === 7 || a.brain.state === 8)) { watch = a; break; }
    }
    if (s < turnAt) { e.camera.position.set(cx, cy, cz); e.camera.lookAt(cx + (cx - rock.x), cy, cz + (cz - rock.z)); }
    else if (watch) aim(watch.brain.pos.x, watch.brain.pos.y + 0.55, watch.brain.pos.z);
    else aim(rock.x, rock.top + 0.5, rock.z);
    e._loop();
    cool--;
    let anyPerch = null, anyClimb = null;
    for (const per of wl.pool[P.SPECIES]) {
      for (const a of per) {
        if (!a.active) continue;
        seen.add(a);
        const nm = NM[a.brain.state] ?? `?${a.brain.state}`;
        states[nm] = (states[nm] || 0) + 1;
        const lift = a.brain.pos.y - W.getHeight(a.brain.pos.x, a.brain.pos.z);
        if (lift > maxLift) maxLift = lift;
        if (a.brain.state === 8) { anyPerch = a; perchFrames++; }
        if (a.brain.state === 7) anyClimb = a;
      }
    }
    if (anyPerch) everPerched++;
    if (anyClimb) everClimbed++;
    // ── does it come down for you? ──────────────────────────────────────
    // The claim under test is "not very scared": a perched animal is supposed
    // to hold its rock and watch, and only leave if the camper gets inside
    // `fleeDist`. Park one 14 m away for the second half of the run.
    if (s === Math.round(steps * 0.55) && anyPerch) {
      threatAt = { x: anyPerch.brain.pos.x + 13, z: anyPerch.brain.pos.z + 5 };
      wl.debugThreat(threatAt.x, threatAt.z, 0);
    }
    if (threatAt && anyPerch) heldWithThreat++;
    if (shot < P.FRAMES && cool <= 0 && (anyPerch || anyClimb)) {
      const a = anyPerch ?? anyClimb;
      const lift = a.brain.pos.y - W.getHeight(a.brain.pos.x, a.brain.pos.z);
      grab(`${(s * DT).toFixed(0)}s  ${NM[a.brain.state]}  +${lift.toFixed(2)}m`);
      cool = Math.round(3 / DT);
    }
  }
  while (shot < P.FRAMES) grab(`${(steps * DT).toFixed(0)}s  end`);

  e.start();
  const post = { rocks: null };
  wl._findPerches(post, S.x[si], S.z[si], cfg);
  const raw = [];
  const RK = window.__systems.rocks;
  RK.rocksAround(S.x[si], S.z[si], cfg.search, cfg.minSize, raw);
  const rawDump = raw.map((i2) => ({ a: i2.arch, s: +i2.size.toFixed(2), r: +RK.reachOf(i2).toFixed(2),
    rise: +(RK.topOf(i2) - W.getHeight(i2.x, i2.z)).toFixed(2) }));
  return {
    site: si, rock: { x: +rock.x.toFixed(1), z: +rock.z.toFixed(1), r: +rock.r.toFixed(2), rise: +rock.rise.toFixed(2) },
    alive: seen.size, states, maxLift: +maxLift.toFixed(2),
    climbFrames: everClimbed, perchFrames: everPerched, steps,
    threatParked: !!threatAt, perchFramesWithThreatParked: heldWithThreat,
    url: strip.toDataURL('image/png'),
  };
}, { SPECIES, SECONDS, FRAMES, HOUR });

if (out.error) { console.error(out.error); await browser.close(); process.exit(1); }
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(out.url.split(',')[1], 'base64'));
delete out.url;
console.log(JSON.stringify(out, null, 1));
console.log('strip:', OUT);
if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 6), null, 1));
await browser.close();
