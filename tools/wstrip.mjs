#!/usr/bin/env node
/**
 * Wildlife motion strip.
 *
 * A single frame cannot tell you whether a walk cycle reads, whether a planted
 * foot is skating, or whether a flee actually triggers. This steps the real
 * simulation at a fixed timestep and tiles the frames into one PNG, so the
 * whole gait cycle can be looked at at once.
 *
 *   node tools/wstrip.mjs --species deer --mode walk --out shots/wildlife/s.png
 *   node tools/wstrip.mjs --species rabbit --mode flee --frames 12 --step 2
 *   node tools/wstrip.mjs --species bear --mode free --track 0 --dist 9
 *
 * modes:  free | graze | walk | flee | alert | burst | flock | ladder
 *
 * `ladder` frames the same animal at 4 / 9 / 20 / 45 / 90 / 170 m, which is the
 * only honest way to check the brief's "reads at 2 m, 40 m and 400 m".
 *
 * The engine's own rAF loop is stopped and `_loop()` is called by hand with a
 * patched clock, so the strip is deterministic and independent of how fast the
 * capture machine happens to be. Frames are read out of the GL back buffer and
 * composited in a 2D canvas, which is the only way to get one file out of many
 * renders without a native image library.
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const SPECIES = arg('species', 'deer');
const MODE = arg('mode', 'walk');
const FRAMES = parseInt(arg('frames', '8'), 10);
const STEP = parseInt(arg('step', '9'), 10);          // sim frames between captures
const DT = parseFloat(arg('dt', String(1 / 60)));
const COLS = parseInt(arg('cols', '4'), 10);
const TW = parseInt(arg('w', '460'), 10);
const TH = parseInt(arg('h', '320'), 10);
const DIST = parseFloat(arg('dist', SPECIES === 'rabbit' ? '2.2' : SPECIES === 'bear' ? '6.5' : '5.5'));
const ELEV = parseFloat(arg('elev', '0.24'));          // camera elevation, radians
const YAW = parseFloat(arg('yaw', '1.5708'));          // side-on by default
const TRACK = arg('track', '1') !== '0';
const HOUR = arg('hour', '16.7');
const FOV = parseFloat(arg('fov', '34'));
const COUNT = parseInt(arg('count', '0'), 10) || null;
const WARM = parseInt(arg('warm', '0'), 10);   // sim frames run before capture
const RES = arg('res', '640');
const ANCHOR = arg('anchor', 'meadow');
const OUT = resolve(arg('out', `shots/wildlife/strip-${SPECIES}-${MODE}.png`));

const URL = `${arg('url', 'http://localhost:5178')}?res=${RES}`;

await acquire('wstrip');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: TW, height: TH }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const result = await page.evaluate(async (P) => {
  const THREE = window.__THREE;
  const e = window.__engine, W = window.__world;
  const wl = window.__systems.wildlife;
  const ST = { free: -1, idle: 0, graze: 1, wander: 2, alert: 3, flee: 4, patrol: 5 };

  window.__lighting.hour = parseFloat(P.HOUR);
  window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;

  // Stand the camera in a meadow so the spawn search has somewhere to work.
  const anchor = (window.__cameraAnchors[P.ANCHOR] || window.__cameraAnchors.vista)();
  e.camera.position.set(anchor.x, W.getHeight(anchor.x, anchor.z) + 2, anchor.z);
  e.camera.rotation.set(0, anchor.yaw ?? 0, 0, 'YXZ');
  e.camera.fov = P.FOV;
  e.camera.updateProjectionMatrix();

  wl.debugClear();
  wl.debugThreat(null);
  const spawn = wl.debugSpawn(P.SPECIES, { dist: 16, clear: 9, count: P.COUNT ?? (P.SPECIES === 'deer' ? 3 : undefined) });
  if (!spawn) return { error: 'no spawn' };

  const live = () => wl.debugState();
  const first = live()[0];
  if (!first) return { error: 'spawned but nothing live' };

  // Find the actual animal object so the camera can follow it.
  const findBrain = () => {
    let any = null;
    for (const per of wl.pool[P.SPECIES]) {
      for (const a of per) {
        if (!a.active) continue;
        if (a.slot === 0) return a;
        any = any ?? a;
      }
    }
    return any;
  };
  const A = findBrain();

  // ── pose the subject for the mode under test ─────────────────────────────
  if (P.MODE === 'walk') {
    A.brain.state = 2;
    A.brain.target.set(spawn.x + Math.sin(1.9) * 260, 0, spawn.z + Math.cos(1.9) * 260);
    A.brain.timer = 1e6;
    A.brain.leader = true;
  } else if (P.MODE === 'flee') {
    // A camper arriving fast from one side. This is the real trigger path, not
    // a forced state, so the freeze-then-bolt sequencing gets tested too.
    wl.debugThreat(spawn.x + 12, spawn.z + 12, 16);
  } else if (P.MODE === 'burst') {
    wl.debugBurst(spawn.x, spawn.y + 5.5, spawn.z);
  } else if (ST[P.MODE] >= 0) {
    A.brain.state = ST[P.MODE];
    A.brain.timer = 1e6;
  }

  // ── manual, fixed-step driving ───────────────────────────────────────────
  e.stop();
  e.clock.getDelta = () => P.DT;

  const canvas = e.renderer.domElement;
  const cw = canvas.width, ch = canvas.height;
  const strip = document.createElement('canvas');
  const cols = P.COLS, rows = Math.ceil(P.FRAMES / cols);
  strip.width = cw * cols; strip.height = ch * rows;
  const g2 = strip.getContext('2d');
  g2.fillStyle = '#101014';
  g2.fillRect(0, 0, strip.width, strip.height);
  const img = g2.createImageData(cw, ch);
  const buf = new Uint8Array(cw * ch * 4);
  const gl = e.renderer.getContext();

  // A fixed camera is the honest skating test: a planted foot must hold one
  // screen position while the body travels over it. Tracking keeps a fast
  // animal in frame but hides exactly that.
  const anchorP = { x: 0, y: 0, z: 0, h: 0 };
  const lookP = { x: 0, y: 0, z: 0 };
  // Birds live in the sky, so they get their own framing: a fixed camera at
  // head height pointing up and along.
  const sky = P.MODE === 'burst' || P.MODE === 'flock';
  const LADDER = [4, 9, 20, 45, 90, 170];
  let ladderD = P.DIST;
  const place = () => {
    if (sky) {
      const yaw = anchorP.h + P.YAW;
      if (P.MODE === 'flock') {
        // Stand on the ground by the animal and look up at the flock — the
        // angle the player actually gets.
        const F = wl.birds.flocks[0];
        lookP.x = F.cx; lookP.y = F.cy; lookP.z = F.cz;
        e.camera.position.set(anchorP.x, anchorP.y + 2.0, anchorP.z);
      } else {
        e.camera.position.set(
          lookP.x + Math.sin(yaw) * P.DIST, anchorP.y + 2.0, lookP.z + Math.cos(yaw) * P.DIST);
      }
      e.camera.lookAt(lookP.x, lookP.y, lookP.z);
      window.__postfx?.setFocus?.(P.DIST * 2);
      return;
    }
    const p = P.TRACK ? A.brain.pos : anchorP;
    // A fixed camera has to be *fixed*: both branches read the live heading, so
    // the camera swung round with the animal and hid exactly the skating the
    // untracked mode exists to expose.
    const yaw = (P.TRACK ? A.brain.heading : anchorP.h) + P.YAW;
    const h = A.rig.proto.height * A.scale;
    const ce = Math.cos(P.ELEV), se = Math.sin(P.ELEV);
    e.camera.position.set(
      p.x + Math.sin(yaw) * ladderD * ce,
      p.y + h * 0.55 + ladderD * se,
      p.z + Math.cos(yaw) * ladderD * ce,
    );
    // Never let the camera end up inside a hill — a river bank puts the ideal
    // orbit position a metre underground more often than not.
    const gy = W.getHeight(e.camera.position.x, e.camera.position.z) + 1.6;
    if (e.camera.position.y < gy) e.camera.position.y = gy;
    e.camera.lookAt(p.x, p.y + h * 0.55, p.z);
    // Keep the subject in focus. The depth of field is part of the shipping
    // look, so the strip keeps it and just points it at the animal.
    window.__postfx?.setFocus?.(ladderD);
  };

  // Settle: let streaming, the gait clock and the post chain reach steady state.
  anchorP.x = A.brain.pos.x; anchorP.y = A.brain.pos.y; anchorP.z = A.brain.pos.z;
  anchorP.h = A.brain.heading;
  lookP.x = A.brain.pos.x;
  lookP.y = A.brain.pos.y + 4.5;
  lookP.z = A.brain.pos.z;
  if (P.MODE === 'flock') {
    // Frame the flock where it actually is rather than guessing at the sky.
    const F = wl.birds.flocks[0];
    lookP.x = F.cx; lookP.y = F.cy; lookP.z = F.cz;
    anchorP.x = A.brain.pos.x; anchorP.z = A.brain.pos.z;
  }
  place();
  for (let i = 0; i < 40; i++) { place(); e._loop(); }
  if (P.MODE === 'burst') {
    // Fire after the settle so the whole flight is inside the strip, and frame
    // on the burst origin rather than on the animal.
    const bp = wl.debugBurst(anchorP.x, anchorP.y + 5.0, anchorP.z);
    lookP.x = bp.x; lookP.y = bp.y; lookP.z = bp.z;
    place();
  }
  if (!P.TRACK && !sky) {
    // Aim the fixed camera at the middle of the path the animal is about to
    // walk, so the whole strip stays in frame.
    const h0 = A.brain.heading;
    const travel = Math.max(A.brain.speed, A.brain.wantSpeed) * P.FRAMES * P.STEP * P.DT * 0.5;
    anchorP.x = A.brain.pos.x + Math.sin(h0) * travel;
    anchorP.y = A.brain.pos.y;
    anchorP.z = A.brain.pos.z + Math.cos(h0) * travel;
    place();
  }

  // Extra un-captured simulation before the strip starts. A flee has to get
  // through the freeze (up to 2.2 s) before there is anything to look at, and
  // without this the whole strip is eight tiles of a deer standing still.
  for (let i = 0; i < P.WARM; i++) { place(); e._loop(); }

  const notes = [];
  for (let f = 0; f < P.FRAMES; f++) {
    if (P.MODE === 'ladder') ladderD = LADDER[Math.min(f, LADDER.length - 1)];
    for (let s = 0; s < P.STEP; s++) { place(); e._loop(); }
    // The back buffer is occasionally read empty — a compositor race that shows
    // up as a black tile. Re-render and read again rather than shipping a strip
    // with a hole in it.
    let mid = 0;
    for (let tries = 0; tries < 4; tries++) {
      e.renderer.setRenderTarget(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const o = ((ch >> 1) * cw + (cw >> 1)) * 4;
      mid = buf[o] + buf[o + 1] + buf[o + 2];
      if (mid > 4) break;
      place(); e._loop();
    }
    // GL origin is bottom-left; ImageData is top-left.
    for (let y = 0; y < ch; y++) {
      const src = (ch - 1 - y) * cw * 4;
      img.data.set(buf.subarray(src, src + cw * 4), y * cw * 4);
    }
    const cx = (f % cols) * cw, cy = ((f / cols) | 0) * ch;
    g2.putImageData(img, cx, cy);

    // Per-frame telemetry, drawn on the tile. Reading "flee / bound / 9.4 m/s"
    // off the picture is the difference between judging motion and guessing.
    const NM = ['idle', 'graze', 'wander', 'alert', 'flee', 'patrol'];
    const st = { state: NM[A.brain.state], gait: A.rig.gaitName, speed: A.brain.speed, lod: A.lod };
    const line = P.MODE === 'ladder'
      ? `${ladderD} m   lod ${st.lod}   ${st.state}`
      : `${f}  ${st.state}  ${st.gait}  ${st.speed.toFixed(1)}m/s`;
    g2.font = 'bold 13px monospace';
    g2.fillStyle = 'rgba(0,0,0,0.62)';
    g2.fillRect(cx + 4, cy + 4, g2.measureText(line).width + 10, 19);
    g2.fillStyle = '#ffe9b0';
    g2.fillText(line, cx + 9, cy + 18);
    g2.strokeStyle = 'rgba(255,255,255,0.18)';
    g2.strokeRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
    notes.push({ f, ...st });
  }

  e.start();
  return {
    url: strip.toDataURL('image/png'),
    notes,
    calls: e.renderer.info.render.calls,
    tris: e.renderer.info.render.triangles,
  };
}, { SPECIES, MODE, FRAMES, STEP, DT, COLS, DIST, ELEV, YAW, TRACK, HOUR, FOV, COUNT, ANCHOR, WARM });

if (result.error) {
  console.error('wstrip:', result.error);
  if (errors.length) console.error(errors.slice(0, 6));
  await browser.close();
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(result.url.split(',')[1], 'base64'));
console.log(`strip: ${OUT}`);
console.log('frames:', JSON.stringify(result.notes));
console.log('stats:', JSON.stringify({ calls: result.calls, tris: result.tris }));
if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 8), null, 1));
await browser.close();
