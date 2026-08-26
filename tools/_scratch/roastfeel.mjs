#!/usr/bin/env node
/**
 * roastfeel — is being in the heat PERCEPTIBLE, as a strip rather than a still.
 *
 *   node tools/_scratch/roastfeel.mjs --hour 20.4 --dir shots/roast/r7-feel
 *
 * The round-7 question is a motion question: a player who lowers the stick has
 * to know within about a second that something changed, and a player holding it
 * too high has to feel the absence. A single frame cannot answer that and a
 * single frame is all `roastshot.mjs` shoots per state.
 *
 * So this steps `window.__roast.step(dt)` on a granted clock while walking the
 * HEIGHT COMMAND down the band at the rate the S key walks it (H_PER_SEC), and
 * takes a frame every 0.25 s of simulated time — the same hand, the same
 * seconds, the same damping the player feels. It writes:
 *
 *   step-NN.png     the full frame
 *   crop-NN.png     a 300x300 crop centred on the marshmallow, which is the
 *                   strip a reader should actually judge
 *   FEEL.json       height, heatTarget, heat, steam, glow and the measured
 *                   luma of the plume box, per step
 *
 * The luma box is the honest instrument: a 60x90 px window directly ABOVE the
 * marshmallow, where the steam is and the marshmallow is not, sampled off the
 * canvas. If lowering the stick does not move that number, the plume is not
 * there whatever the state dump says.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const HOUR = parseFloat(arg('hour', '20.4'));
const DIR = arg('dir', 'shots/roast/r7-feel');
const W = 1600, H = 900;
const URL = `${process.env.AUTUMN_URL || 'http://127.0.0.1:5251'}?res=${W}&car=camper`;
const DT = 1 / 60;
const EVERY = 15;            // frames between shutters: 0.25 s of simulated time
const SHOTS = 17;            // 4 s of hand: 0.50 -> 0.10 takes 1.5 s at H_PER_SEC

mkdirSync(DIR, { recursive: true });
const release = await acquire('roastfeel');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
const rows = [];
try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 60000 });
  await page.evaluate(() => { const e = window.__engine; if (e) { e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1; } });
  await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, HOUR);

  const parkAt = await page.evaluate(() => {
    const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
    window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9); return { x: p.x, z: p.z };
  });
  await page.waitForTimeout(1600);
  await page.keyboard.down('Space'); await page.waitForTimeout(1000);
  await page.keyboard.up('Space'); await page.waitForTimeout(2400);
  await page.waitForFunction(() => typeof window.__camp?.pitchNear === 'function', null, { timeout: 60000, polling: 250 });
  // The return value is UNWRAPPED deliberately: `pitchNear` hands back the camp
  // record, which carries live THREE objects, and letting Playwright serialise
  // that sends a protocol message big enough to kill the pipe outright
  // ("Cannot create a string longer than 0x1fffffe8"). Take two numbers.
  await page.evaluate(({ at }) => {
    const s = window.__camp.pitchNear(at.x, at.z, { instant: true, radius: 14 });
    return s ? { x: s.x, z: s.z } : null;
  }, { at: parkAt });
  await page.waitForTimeout(1200);

  // Sit down, settle, and hold it at the TOP of the band: out of the heat, which
  // is the state the complaint is about.
  await page.evaluate(() => { window.__roast.enter(); });
  await page.waitForFunction(() => (window.__roast.state().t ?? 0) >= 0.999, null, { timeout: 20000, polling: 60 });
  await page.evaluate(() => {
    const R = window.__roast;
    R.setOverlay(false);
    R.setHeight(0.50);
    R.setSpin(0);
    R.setClock(3.0);
  });
  // Stop the world and draw by hand, exactly as `roastshot.mjs`'s `freeze()`
  // does: with the loop stopped the fire, the embers, the smoke and the sun all
  // hold still, so consecutive frames of this strip differ by the HAND and by
  // nothing else. Every granted second below is one this tool asked for.
  await page.evaluate(() => {
    const e = window.__engine;
    e.stop();
    window.__roastDraw = () => {
      if (e._render) e._render(0, e.elapsed);
      else e.renderer.render(e.scene, e.camera);
    };
    window.__roastDraw();
  });

  for (let i = 0; i < SHOTS; i++) {
    const st = await page.evaluate(({ dt, n, i, per }) => {
      const R = window.__roast, V = R.view;
      const THREE = window.__THREE;
      for (let k = 0; k < n; k++) {
        // The S key, exactly: the COMMAND walks at H_PER_SEC and the held
        // height damps toward it. Nothing here touches `height` directly, so
        // what is photographed is the arm, not a teleport.
        if (i > 1) V.heightCmd = Math.max(0.10, V.heightCmd - per * dt);
        R.step(dt);
      }
      // ── the plume box, read off the DRAWING BUFFER, TWICE ──────────────
      //
      // Not through `drawImage(canvas, …)` into a 2d context: the engine's
      // WebGL context runs without `preserveDrawingBuffer`, so a 2d copy taken
      // after the draw comes back uniformly ZERO and looks exactly like a plume
      // that is not there. (It did, for one whole run of this tool.)
      // `readPixels` in the same task as the draw is the honest read, and it
      // has to happen BEFORE `state()`, which spends two off-screen renders on
      // the backdrop measurement.
      //
      // TWICE, because the box sits above the marshmallow and the marshmallow
      // descends INTO the fire: at the bottom of the band the flame column is
      // behind that box, and a single reading cannot tell a plume from a flame.
      // So the steam is taken out of the graph, the same frame is drawn again,
      // and the difference is the steam and nothing else.
      const gl = V.ctx.renderer.getContext();
      const BW = 60, BH = 90;
      const q0 = V.mallow.getWorldPosition(new THREE.Vector3()).project(V.ctx.camera);
      const px0 = Math.round((q0.x * 0.5 + 0.5) * window.innerWidth);
      const py0 = Math.round((0.5 - q0.y * 0.5) * window.innerHeight);
      const bx = Math.max(0, Math.min(gl.drawingBufferWidth - BW, px0 - BW / 2));
      // 46 px above the subject's centre is clear of its own top edge at this
      // framing (the marshmallow is ~84 px across), so the box is plume, flame
      // or background — never sugar.
      const by = Math.max(0, Math.min(gl.drawingBufferHeight - BH,
        gl.drawingBufferHeight - (py0 - 46)));
      const buf = new Uint8Array(BW * BH * 4);
      const lin = (v) => { const t = v / 255; return t <= 0.04045 ? t / 12.92 : Math.pow((t + 0.055) / 1.055, 2.4); };
      const readBox = () => {
        gl.readPixels(bx, by, BW, BH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let sum = 0, mx = 0;
        for (let k = 0; k < buf.length; k += 4) {
          const L = 0.2126 * lin(buf[k]) + 0.7152 * lin(buf[k + 1]) + 0.0722 * lin(buf[k + 2]);
          sum += L; if (L > mx) mx = L;
        }
        return { mean: +(sum / (BW * BH)).toFixed(5), max: +mx.toFixed(5) };
      };
      window.__roastDraw();
      const plume = readBox();
      const par = V.steam?.parent ?? null;
      if (par) par.remove(V.steam);
      window.__roastDraw();
      const bare = readBox();
      if (par) par.add(V.steam);
      // Leave the canvas holding the REAL frame, which is the one photographed.
      window.__roastDraw();

      const s = R.state();
      return {
        height: +s.height.toFixed(4), heightCmd: +s.heightCmd.toFixed(4),
        heatTarget: +s.heatTarget.toFixed(4), heat: +s.heat.toFixed(4),
        steam: +s.steam.toFixed(4), glow: +s.glow.toFixed(4),
        doneness: +s.doneness.toFixed(4), clear: s.clear, distinct: s.distinct,
        margin: s.margin, marginLight: s.backdrop?.marginLight ?? null,
        marginDark: s.backdrop?.marginDark ?? null,
        px: px0, py: py0, plume, bare,
      };
    }, { dt: DT, n: EVERY, i, per: 0.27 });

    const tag = String(i).padStart(2, '0');
    await page.screenshot({ path: `${DIR}/step-${tag}.png` });
    const cx = Math.max(150, Math.min(W - 150, st.px));
    const cy = Math.max(150, Math.min(H - 150, st.py));
    await page.screenshot({
      path: `${DIR}/crop-${tag}.png`,
      clip: { x: cx - 150, y: cy - 150, width: 300, height: 300 },
    });

    rows.push({ i, t: +(i * EVERY * DT).toFixed(2), ...st });
    console.log(`${tag}  t=${(i * EVERY * DT).toFixed(2)}s  h=${st.height.toFixed(3)}  ` +
      `heat=${st.heatTarget.toFixed(3)} -> glow=${st.heat.toFixed(3)}  steam=${st.steam.toFixed(3)}  ` +
      `plume ${st.plume.mean.toFixed(4)}/${st.bare.mean.toFixed(4)} max ${st.plume.max.toFixed(4)}/${st.bare.max.toFixed(4)}  done=${st.doneness.toFixed(3)}`);
  }

  writeFileSync(`${DIR}/FEEL.json`, JSON.stringify({ hour: HOUR, dt: DT, every: EVERY, rows }, null, 2));
  console.log(`\nwrote ${DIR}/FEEL.json`);
  console.log(`next: node tools/sheet.mjs --dir ${DIR} --cols 6 --cell 300`);
} finally {
  await browser.close();
  await release();
}
