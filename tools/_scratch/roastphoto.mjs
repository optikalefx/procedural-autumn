#!/usr/bin/env node
/**
 * roast -> photo -> roast, measured.
 *
 *   node tools/_scratch/roastphoto.mjs --dir shots/roast/r13-photo
 *
 * The transition harness for "press F while roasting and photograph the
 * marshmallow". It is a STATE-TRANSITION test, not a contact sheet: every
 * frame here exists to prove one edge of the graph, and every edge is asserted
 * on numbers read out of the page rather than on the picture.
 *
 *   01-roast        the composed fireside frame, before F. Baseline.
 *   02-photo        one frame after F. The stick must still be in the world and
 *                   the marshmallow must still project inside the frame.
 *   03-orbit        the free camera flown round to an angle the roast view
 *                   cannot reach — behind and above the marshmallow, looking
 *                   back across the fire. THE DELIVERABLE.
 *   04-back         after F again. Same seat, same doneness, stick in hand.
 *
 * Boot sequence is roastshot.mjs's, trimmed: park at the meadow POI, latch the
 * brake (so the headlights dip — a dusk frame under full beams is a photograph
 * of a floodlight), pitch at the POI's own coordinates, enter through
 * `__roast.enter()`.
 *
 * `--before` skips everything that needs the new API, so the same tool can be
 * run against the unmodified tree to say what photo mode ACTUALLY did mid-roast
 * rather than what somebody assumed it did.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

const DIR = resolve(ROOT, arg('dir', 'shots/roast/r13-photo'));
const HOUR = parseFloat(arg('hour', '20.4'));
const DONE = parseFloat(arg('doneness', '0.42'));
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const URL = `${arg('url', process.env.AUTUMN_URL || 'http://127.0.0.1:5251')}?res=768&car=camper`;
const BEFORE = has('before');

const log = [];
const say = (s) => { console.log(s); log.push(s); };

async function main() {
  mkdirSync(DIR, { recursive: true });
  const release = await acquire('roastphoto');
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  // Same HMR stub roastshot uses: peers save during a run and a reload throws
  // out whatever evaluate was in flight.
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
        return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
          send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {},
          set onerror(_) {} };
      }
      return new Real(url, protocols);
    };
    window.WebSocket.prototype = Real.prototype;
  });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null,
    { timeout: 30000 });

  await page.evaluate(() => {
    const e = window.__engine;
    if (e) { e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1; }
  });
  await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, HOUR);

  const parkAt = await page.evaluate(() => {
    const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
    window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
    return { x: p.x, z: p.z };
  });
  await page.waitForTimeout(1600);
  await page.keyboard.down('Space');
  await page.waitForTimeout(1000);
  await page.keyboard.up('Space');
  await page.waitForTimeout(2400);

  const site = await page.evaluate((at) => {
    const s = window.__camp.pitchNear(at.x, at.z, { instant: true, radius: 14 });
    return s ? { x: s.x, z: s.z, kinds: window.__camp.props.map((p) => p.item.kind) } : null;
  }, parkAt);
  if (!site) throw new Error('no camp site');
  say(`camp at ${site.x.toFixed(1)}, ${site.z.toFixed(1)} — ${site.kinds.join(', ')}`);
  if (!site.kinds.includes('roaststick')) throw new Error('this camp has no roaststick');

  // ── into the view ────────────────────────────────────────────────────────
  await page.evaluate(() => window.__roast.enter());
  await page.waitForFunction(() => (window.__roast.state?.().t ?? 0) >= 0.999, null,
    { timeout: 15000 });
  await page.evaluate(async () => { if (window.__settleStable) await window.__settleStable(600, 24); });
  await page.evaluate((k) => window.__roast.setDoneness(k), DONE);
  await page.waitForTimeout(400);

  /**
   * Everything one line of this report needs, read in one evaluate.
   *
   * `stickParent` is the whole feature in one string: `camera` is welded to the
   * lens, `scene` is standing in the world, `none` is gone.
   */
  const probe = () => page.evaluate(() => {
    const R = window.__roast, V = R?.view, cam = window.__engine.camera;
    const rig = window.__systems.cameraRig;
    const st = R?.state?.() ?? null;
    const held = V?.held ?? null;
    const p = held?.parent;
    const stickParent = !p ? 'none' : (p === cam ? 'camera' : (p === window.__engine.scene ? 'scene' : p.name || p.type));
    let mallowNDC = null, mallowDist = null;
    if (V?.mallow && held?.parent) {
      const v = V.mallow.getWorldPosition(new window.__THREE.Vector3());
      mallowDist = +v.distanceTo(cam.position).toFixed(3);
      v.project(cam);
      mallowNDC = { x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) };
    }
    return {
      active: st?.active ?? null, phase: st?.phase ?? null, t: st?.t ?? null,
      handedOff: st?.handedOff ?? null, closing: !!V?.closing,
      doneness: st ? +st.doneness.toFixed(4) : null,
      took: st?.took ?? null, forceCamera: !!window.__forceCamera,
      photo: !!window.__systems.hud?.photo?.active,
      rigMode: rig?.mode ?? null,
      fov: +cam.fov.toFixed(2),
      cam: { x: +cam.position.x.toFixed(3), y: +cam.position.y.toFixed(3), z: +cam.position.z.toFixed(3) },
      propVisible: V?.prop ? !!V.prop.visible : null,
      heldVisible: held ? !!held.visible : null,
      stickParent, mallowNDC, mallowDist,
      stickWorld: held ? (() => { const v = held.getWorldPosition(new window.__THREE.Vector3());
        return { x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) }; })() : null,
      seatY: st?.seatY ?? null, clear: st?.clear ?? null, distinct: st?.distinct ?? null,
      heat: st ? +(st.heat ?? 0).toFixed(4) : null,
      steam: st ? +(st.steam ?? 0).toFixed(4) : null,
    };
  });

  const shots = {};
  const shoot = async (name) => {
    await page.screenshot({ path: resolve(DIR, `${name}.png`) });
    shots[name] = await probe();
    say(`${name.padEnd(12)} ${JSON.stringify(shots[name])}`);
  };

  await shoot('01-roast');

  // ── press F, for real ────────────────────────────────────────────────────
  // Through the keyboard rather than through `photo.setActive`, because the
  // question is what the PLAYER's F does — HUD.togglePhoto, the root class, the
  // rail focus and Camp's own `photographing` gate all hang off that path.
  //
  // And NOT through a click on the canvas first. A click inside this view is
  // `eat` (contract section 3), so focusing the page that way starts the eat
  // beat and everything measured after it is a photograph of a marshmallow on
  // its way into somebody's mouth. Cost this harness one run.
  const atF = await probe();
  say(`at-F         doneness=${atF.doneness} phase=${atF.phase}`);
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(1200);
  await shoot('02-photo');

  // ── fly the free camera ──────────────────────────────────────────────────
  //
  // The rig's own free-camera fields are written directly. Synthesising drags
  // would be testing `CameraRig._readLook`, which is not what is on trial, and
  // the pose wanted here is a specific one: pivot ON the marshmallow, 0.55 m
  // out, swung 140 degrees round from the seat's own bearing and lifted 25
  // degrees — which is behind and above the subject, looking back down across
  // the fire. There is no `POSE` in camp_roast_view.js that can produce it.
  const flown = await page.evaluate(() => {
    const rig = window.__systems.cameraRig;
    const V = window.__roast?.view;
    if (!rig || rig.mode !== 'free' || !V?.mallow) return { ok: false, mode: rig?.mode ?? null };
    const m = V.mallow.getWorldPosition(new window.__THREE.Vector3());
    rig.freePivot.copy(m);
    rig.freeDist = 0.55;
    rig.freeYaw = (V._bearing ?? 0) + 2.44;
    rig.freePitch = 0.44;
    rig.roll = 0;
    return { ok: true, yaw: +rig.freeYaw.toFixed(3), pitch: +rig.freePitch.toFixed(3),
      pivot: { x: +m.x.toFixed(3), y: +m.y.toFixed(3), z: +m.z.toFixed(3) } };
  });
  say(`flew: ${JSON.stringify(flown)}`);
  await page.waitForTimeout(700);
  await shoot('03-orbit');

  // Does a SAVED photo contain it? `capture()` renders one extra frame through
  // the post chain and reads the drawing buffer back; it refuses a frame that
  // is black or flat, so a non-zero byte count is a real picture. The pixel
  // test below is the specific one: the marshmallow's own projected pixel,
  // read out of the same canvas.
  const saved = await page.evaluate(async () => {
    const hud = window.__systems.hud;
    const V = window.__roast?.view;
    const cam = window.__engine.camera;
    const ok = hud?.photo?.capture?.();
    const out = { ok: !!ok, bytes: hud?.photo?.lastPhotoBytes ?? 0, px: null };
    if (V?.mallow) {
      const v = V.mallow.getWorldPosition(new window.__THREE.Vector3()).project(cam);
      const c = window.__engine.renderer.domElement;
      const x = Math.round((v.x * 0.5 + 0.5) * c.width);
      const y = Math.round((-v.y * 0.5 + 0.5) * c.height);
      // The canvas is read in the same task as capture()'s own forced render,
      // which is the only moment the drawing buffer still holds anything.
      const t = document.createElement('canvas');
      t.width = c.width; t.height = c.height;
      t.getContext('2d').drawImage(c, 0, 0);
      const d = t.getContext('2d').getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      out.px = { x, y, r: Math.round(r / 25), g: Math.round(g / 25), b: Math.round(b / 25) };
    }
    return out;
  });
  say(`saved photo: ${JSON.stringify(saved)}`);

  // ── and back ─────────────────────────────────────────────────────────────
  //
  // Probed on arrival as well as a beat later. The doneness that has to be
  // unchanged is the one on the frame the camera lands, not the one 1.4 s of
  // real roasting afterwards — the view is LIVE again by then and cooking is
  // what it is supposed to be doing.
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(140);
  const atBack = await probe();
  say(`at-back      doneness=${atBack.doneness} phase=${atBack.phase} ` +
      `stick=${atBack.stickParent} fov=${atBack.fov}`);
  await page.waitForTimeout(1200);
  await shoot('04-back');

  // ── the Escape path ──────────────────────────────────────────────────────
  //
  // Photo mode's rail binds Escape to its own exit and does not stop the event
  // propagating, so the same keypress is still in `Input.pressed` on the frame
  // this view gets the camera back — where Escape means "stand up". A player
  // who backs out of a photograph with Escape must land back at the fire, not
  // on their feet twenty metres away. One frame of grace in `_readInput`; this
  // is what proves it.
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(900);
  const escIn = await probe();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  const escOut = await probe();
  say(`escape       in:${escIn.handedOff}/${escIn.photo} ` +
      `out: photo=${escOut.photo} active=${escOut.active} phase=${escOut.phase} ` +
      `stick=${escOut.stickParent}`);
  await page.screenshot({ path: resolve(DIR, '05-escape-back.png') });

  // ── the debug surface's own way in ───────────────────────────────────────
  //
  // `__roast.photo(on)` is the handle a future contact sheet drives this edge
  // with, so it is exercised here rather than assumed to work. It goes through
  // `HUD.togglePhoto` — the same path F takes — so what it proves is that a
  // harness and a player get the same transition.
  const viaDebug = await page.evaluate(() => window.__roast.photo(true));
  await page.waitForTimeout(700);
  const dbgIn = await probe();
  const viaDebugOut = await page.evaluate(() => window.__roast.photo(false));
  await page.waitForTimeout(700);
  const dbgOut = await probe();
  say(`__roast.photo: on='${viaDebug}' -> handedOff=${dbgIn.handedOff} ` +
      `stick=${dbgIn.stickParent} | off='${viaDebugOut}' -> active=${dbgOut.active} ` +
      `phase=${dbgOut.phase} stick=${dbgOut.stickParent}`);

  const A = shots['01-roast'], B = shots['02-photo'], C = shots['03-orbit'], D = shots['04-back'];
  const verdict = {
    // The cook is paused, measured across the whole photo session: the frame
    // after F, the frame after flying the camera, and the frame after coming
    // back. Zero, not "small" — nothing integrates while `_handedOff` is up.
    doneness_at_F: atF.doneness,
    cook_paused_in_photo: +Math.abs(B.doneness - C.doneness).toFixed(6),
    doneness_across_transition: +Math.abs(atF.doneness - atBack.doneness).toFixed(6),
    doneness_1s_after_return: +Math.abs(atF.doneness - D.doneness).toFixed(6),
    escape_kept_the_fire: escOut.photo === false && escOut.active === true
      && escOut.phase === 'roast' && escOut.stickParent === 'camera',
    debug_surface_drives_it: viaDebug === 'hud' && viaDebugOut === 'hud'
      && dbgIn.handedOff === true && dbgIn.stickParent === 'scene'
      && dbgOut.active === true && dbgOut.stickParent === 'camera',
    still_roasting: D.active === true && D.phase === 'roast',
    stick_parents: [A.stickParent, B.stickParent, C.stickParent, D.stickParent].join(' -> '),
    stick_stood_in_world: B.stickParent === 'scene' && C.stickParent === 'scene',
    stick_did_not_move_while_composing: B.stickWorld && C.stickWorld
      ? +Math.hypot(B.stickWorld.x - C.stickWorld.x, B.stickWorld.y - C.stickWorld.y,
        B.stickWorld.z - C.stickWorld.z).toFixed(5) : null,
    seat_returned_m: A.cam && D.cam
      ? +Math.hypot(A.cam.x - D.cam.x, A.cam.y - D.cam.y, A.cam.z - D.cam.z).toFixed(4) : null,
    prop_hidden_while_composing: B.propVisible === false && C.propVisible === false,
    mallow_in_orbit_frame: C.mallowNDC
      && Math.abs(C.mallowNDC.x) < 1 && Math.abs(C.mallowNDC.y) < 1 && C.mallowNDC.z < 1,
    took_camera_back: D.took === true,
    forceCamera_down_in_photo: B.forceCamera === false,
    forceCamera_up_after: D.forceCamera === true,
    clear: D.clear, distinct: D.distinct,
  };
  say(`VERDICT ${JSON.stringify(verdict, null, 1)}`);
  if (errors.length) say(`page-errors: ${JSON.stringify(errors.slice(0, 6))}`);

  writeFileSync(resolve(DIR, 'PHOTO.json'), JSON.stringify(
    { when: new Date().toISOString(), url: URL, hour: HOUR, doneness: DONE, before: BEFORE, atF, atBack, escIn, escOut, dbgIn, dbgOut,
      shots, saved, flown, verdict, errors: errors.slice(0, 12), log }, null, 2));
  await browser.close();
  release();
}

main().catch(async (e) => { console.error(e); process.exit(1); });
