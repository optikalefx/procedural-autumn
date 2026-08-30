#!/usr/bin/env node
/**
 * HUD capture + interaction harness.
 *
 *   node tools/hudshot.mjs --dir shots/ui/r2 --res 768
 *   node tools/hudshot.mjs --dir shots/ui/r3 --view meadow --w 1600 --h 900
 *
 * `shot.mjs` is the right tool for judging the *world*; this is the right tool
 * for judging the interface on top of it. One browser session (one capture
 * slot) produces every frame a UI review needs:
 *
 *   full.png       the HUD in place over the game
 *   compass.png    the heading strip, cropped and enlarged
 *   dash.png       the speedo cluster, cropped and enlarged
 *   settings.png   the settings sheet open
 *   photo.png      photo mode, world held still
 *   dark.png       the same HUD at dawn, to check legibility on a pale sky
 *
 * It also exercises the photo-mode save path and reports whether a real PNG
 * came out of it, because a screenshot cannot tell you that.
 */
import { chromium } from 'playwright';
import { mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquire } from './_lock.mjs';

// Deliberately *not* imported from shot.mjs: that module runs a capture on
// import, so `import { VIEWS }` quietly took a second capture slot and wrote a
// stray hero.png into this run's output directory.
const VIEWS = {
  drive:  { anchor: 'road',   height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
  meadow: { anchor: 'meadow', height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  hero:   { anchor: 'vista',  height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  river:  { anchor: 'river',  height: 5.2, dist: 26,  pitch: -0.16, fov: 54, hour: 16.9, yawOffset: 0.42 },
  dawn:   { anchor: 'vista',  height: 48,  dist: 130, pitch: -0.13, fov: 46, hour: 7.4 },
};

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const RES = arg('res', '768');
const DIR = arg('dir', 'shots/ui/hud');
const VIEW = arg('view', 'drive');
// Pin the car: the page picks at random when nothing does, and a capture
// that changed vehicle between runs would not be comparable. --car roamer
// for the other one. See AGENTS.md.
const CAR = arg('car', 'camper');
const URL = `${arg('url', (process.env.AUTUMN_URL || 'http://localhost:5178'))}?res=${RES}&car=${CAR}`;

async function main() {
  const release = await acquire('hudshot');
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
           '--disable-frame-rate-limit', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  const page = await context.newPage();

  // A peer saving a file mid-run reloads the page and throws away the HUD
  // state this harness has just set up.
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
        return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
                 send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
      }
      return new Real(url, protocols);
    };
    window.WebSocket.prototype = Real.prototype;
  });
  // The HUD stands down for the capture harness by default; this session is
  // explicitly here to photograph it.
  await page.addInitScript(() => { window.__hudForce = true; });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  mkdirSync(resolve(DIR), { recursive: true });
  console.log(`booting ${URL} …`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => !!window.__hud, null, { timeout: 30000 });
  await page.waitForTimeout(600);

  // The first-run hint only exists for the first thirteen seconds of the first
  // session, so it has to be photographed before anything else happens.
  await shot('hint');

  // Drive for a few seconds so the dash is showing real numbers rather than a
  // parked zero — a speedometer reading 0 tells you nothing about the layout.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4500);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(400);

  const pose = async (view, hour) => {
    await page.evaluate(async ({ v, hourArg }) => {
      const THREE = window.__THREE;
      const e = window.__engine;
      window.__lighting.hour = hourArg ?? v.hour;
      window.__lighting.cycleSpeed = 0;
      const anchor = (window.__cameraAnchors[v.anchor] ?? window.__cameraAnchors.vista)();
      const yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
      const back = v.standOff ?? 0;
      const gx = anchor.x - Math.sin(yaw) * back;
      const gz = anchor.z - Math.cos(yaw) * back;
      const gy = window.__world.getHeight(gx, gz) + v.height;
      e.camera.fov = v.fov;
      e.camera.updateProjectionMatrix();
      e.camera.position.set(gx, gy, gz);
      e.camera.lookAt(new THREE.Vector3(
        gx + Math.sin(yaw) * v.dist,
        gy + Math.tan(v.pitch) * v.dist,
        gz + Math.cos(yaw) * v.dist));
      window.__forceCamera = true;
      window.dispatchEvent(new Event('resize'));
      if (window.__settle) await window.__settle(50);
    }, { v: VIEWS[view] ?? VIEWS.drive, hourArg: hour });
    await page.waitForTimeout(900);
    await ensureFrame();
  };

  /**
   * The harness intermittently comes back with an all-black frame after a pose
   * — shot.mjs carries the same retry for the same reason. A UI review done on
   * a black frame is worse than useless: it looks like the HUD is perfectly
   * legible.
   */
  const ensureFrame = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const buf = await page.screenshot({ clip: { x: 0, y: H * 0.35, width: W, height: H * 0.3 } });
      const dark = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = new OffscreenCanvas(120, 40);
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, 120, 40);
        const d = g.getImageData(0, 0, 120, 40).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if ((d[i] + d[i + 1] + d[i + 2]) / 3 < 12) n++;
        return n / (d.length / 4);
      }, buf.toString('base64'));
      if (dark < 0.6) return true;
      console.error(`[hudshot] frame came back ${(dark * 100) | 0}% black; re-rendering (${attempt + 1}/4)`);
      await page.evaluate(() => { window.dispatchEvent(new Event('resize')); return window.__settle?.(90); });
      await page.waitForTimeout(1100);
    }
    console.error('[hudshot] never got a lit frame — the shots below are not a fair review');
    return false;
  };

  async function shot(name, clip) {
    const path = resolve(DIR, `${name}.png`);
    await page.screenshot({ path, clip });
    console.log(`shot: ${path}`);
  }

  // ── the HUD over the game ───────────────────────────────────────────────
  await pose(VIEW);
  await shot('full');

  // Cropped and enlarged: the only way to judge a 12 px letterform.
  const box = async (sel) => page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: Math.max(0, r.x - 20), y: Math.max(0, r.y - 16),
             width: Math.min(r.width + 40, window.innerWidth), height: r.height + 32 };
  }, sel);

  const compassBox = await box('.pa-compass');
  if (compassBox) await shot('compass', compassBox);
  const dashBox = await box('.pa-dash');
  if (dashBox) await shot('dash', dashBox);
  // The minimap is judged on whether you could pick a direction from it alone,
  // which needs it enlarged — 170 px of contour is not reviewable in situ.
  const mapBox = await box('.pa-map');
  if (mapBox) await shot('map', mapBox);

  // ── settings ────────────────────────────────────────────────────────────
  await page.evaluate(() => window.__hud.toggleSettings());
  await page.waitForTimeout(700);
  await shot('settings');
  const sheetBox = await box('.pa-sheet');
  if (sheetBox) await shot('settings_crop', sheetBox);
  await page.evaluate(() => window.__hud.toggleSettings());
  await page.waitForTimeout(500);

  // ── photo mode ──────────────────────────────────────────────────────────
  // Photo mode only — the world stays frozen (T is what starts it), which is
  // also what keeps this shot reproducible frame to frame.
  await page.evaluate(() => window.__hud.togglePhoto());
  await page.waitForTimeout(900);
  await shot('photo');

  // The save path, exercised for real: a click on the shutter must produce a
  // download whose payload is a PNG of the right size.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    page.evaluate(() => window.__hud.photo.capture()),
  ]);
  const bytes = await page.evaluate(() => window.__hud.photo.lastPhotoBytes ?? 0);
  if (download) {
    // Keep the file. A byte count proves a download fired; only the image
    // proves the photo is a photo — the first full-res run wrote a 40 KB PNG
    // and nothing but opening it would have said whether that was a flat sky
    // or an empty frame.
    const saved = resolve(DIR, 'saved_photo.png');
    await download.saveAs(saved);
    const { size } = statSync(saved);
    console.log(`photo save: "${download.suggestedFilename()}" -> ${saved} (${(size / 1024).toFixed(0)} KB on disk)`);
  } else {
    console.log(`photo save: NO DOWNLOAD FIRED (dataURL ${bytes} chars)`);
  }

  await page.waitForTimeout(600);
  await page.evaluate(() => window.__hud.togglePhoto());
  await page.waitForTimeout(500);

  // ── legibility against a pale dawn sky ──────────────────────────────────
  await pose('dawn', 7.4);
  await shot('dawn');

  // ── keyboard reachability ───────────────────────────────────────────────
  // "Keyboard and gamepad reachable" is a requirement, not a hope: open the
  // sheet with Escape, walk it with Tab, and confirm focus actually lands on
  // real controls inside it.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const kb = { opened: await page.evaluate(() => window.__hud.settings.open) };
  kb.firstFocus = await page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    seen.push(await page.evaluate(() => {
      const a = document.activeElement;
      return a && document.querySelector('.pa-sheet')?.contains(a)
        ? `${a.tagName.toLowerCase()}${a.type ? ':' + a.type : ''}` : 'OUTSIDE';
    }));
  }
  kb.tabbed = seen.join(' ');
  // Arrow keys must move a focused slider.
  await page.evaluate(() => document.querySelector('.pa-sheet input[type=range]')?.focus());
  const before = await page.evaluate(() => +document.querySelector('.pa-sheet input[type=range]').value);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const after = await page.evaluate(() => +document.querySelector('.pa-sheet input[type=range]').value);
  kb.sliderMoved = after !== before ? `${before} → ${after}` : 'NO';
  // And WASD typed into the sheet must not drive the camper away.
  const posBefore = await page.evaluate(() => window.__vehicleState().x);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1200);
  await page.keyboard.up('KeyW');
  const posAfter = await page.evaluate(() => window.__vehicleState().x);
  kb.leakedToVehicle = Math.abs(posAfter - posBefore) > 1.5 ? `YES (${(posAfter - posBefore).toFixed(1)} m)` : 'no';
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  kb.closed = !(await page.evaluate(() => window.__hud.settings.open));
  console.log('keyboard:', JSON.stringify(kb));

  // ── HUD state readout ───────────────────────────────────────────────────
  const state = await page.evaluate(() => ({
    trip: +window.__hud.trip.toFixed(1),
    found: window.__hud.found,
    total: window.__hud.total,
    marks: window.__hud.marks.map((m) => `${m.kind}@${Math.round(m.dist)}m`),
    hudBlocksCanvas: (() => {
      // The canvas must still receive a click through the middle of the screen.
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return el?.id !== 'gl' ? (el?.className || el?.id || 'unknown') : false;
    })(),
    nodes: document.querySelectorAll('#pa-hud *').length,
  }));
  console.log('hud:', JSON.stringify(state));
  // The HUD must disappear from every other author's art captures. This is the
  // default path (no __hudForce), so it is worth proving rather than assuming.
  const polite = await page.evaluate(async () => {
    window.__hudForce = false;
    await new Promise((r) => setTimeout(r, 700));
    const n = document.getElementById('pa-hud');
    return { cls: n.className, opacity: getComputedStyle(n).opacity };
  });
  console.log('capture-politeness:', JSON.stringify(polite));

  const perf = await page.evaluate(() => ({ fps: window.__fps, calls: window.__engine.renderer.info.render.calls }));
  console.log('perf:', JSON.stringify(perf));
  if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 6), null, 1));

  await browser.close();
  release();
}

main().catch((e) => { console.error(e); process.exit(1); });
