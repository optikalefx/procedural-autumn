#!/usr/bin/env node
/**
 * The `river` hillside, defined from world data instead of by eye.
 *
 *   node tools/_scratch/cover/rivermap.mjs --out shots/cover/x1/hill
 *
 * Ray-marches the baked heightfield through EVERY screen pixel of the real
 * `river` VIEW pose (tools/shot.mjs VIEWS.river — height 6, dist 30, pitch
 * -0.18, fov 54, yawOffset 0.42, index 3), and writes a 1-bit PNG mask of the
 * pixels whose terrain hit is nearer than --maxd and steeper than --minslope.
 * That mask is the "hillside", and every number quoted about the hillside is
 * then quoted over it — not over a rect.
 *
 * The predecessor tool beside this one (hillprobe.mjs) probed the same anchor
 * at height 1.75 / fov 55 with no yaw offset, which is a different framing from
 * the one the contact sheet photographs. Four reference targets in the last
 * five critic passes were wrong for exactly that class of reason.
 *
 * It also prints, over the masked pixels only:
 *   · the distribution of slope / surface weights / _ground() / _groundTiny()
 *   · a census of ground-cover instances whose screen projection lands inside
 *     the mask, by archetype and by distance band
 * so "the hillside is bare" can be resolved into "nothing is placed there" vs
 * "things are placed there and do not read".
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import zlib from 'node:zlib';
import { acquire } from '../../_lock.mjs';
import { VIEWS } from '../../shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const VIEW = arg('view', 'river');
const OUT = arg('out', 'shots/cover/x1/hill');
const W = parseInt(arg('w', '1280'), 10), H = parseInt(arg('h', '720'), 10);
const STEP = parseInt(arg('step', '4'), 10);      // march every Nth pixel, box-fill
const MAXD = Number(arg('maxd', '140'));
const MINSLOPE = Number(arg('minslope', '0.60'));

mkdirSync(dirname(OUT), { recursive: true });

await acquire('cover-rivermap');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('page error:', String(e)));
await page.goto(arg('url', 'http://localhost:5178') + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const res = await page.evaluate(async ({ v, W, H, STEP, MAXD, MINSLOPE }) => {
  const THREE = window.__THREE;
  const e = window.__engine, wd = window.__world;
  const frozen = await (await fetch('/review/anchors.json')).json();
  window.__lighting.hour = v.hour;
  window.__lighting.cycleSpeed = 0;
  const anchor = frozen[v.anchor];
  const yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
  const back = v.standOff ?? 0;
  const gx = anchor.x - Math.sin(yaw) * back;
  const gz = anchor.z - Math.cos(yaw) * back;
  const gy = wd.getHeight(gx, gz) + v.height;
  e.camera.fov = v.fov;
  e.camera.aspect = W / H;
  e.camera.updateProjectionMatrix();
  e.camera.position.set(gx, gy, gz);
  e.camera.lookAt(gx + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, gz + Math.cos(yaw) * v.dist);
  e.camera.updateMatrixWorld(true);
  window.__forceCamera = true;
  if (window.__settleStable) await window.__settleStable(1500, 30);

  const gcs = window.__systems.groundCover.scatter;
  const scratch = {};
  const dir = new THREE.Vector3();
  const mask = new Uint8Array(W * H);
  // Distance-banded copies of the same mask. "Where does cover stop dressing
  // the slope" is a question about metres, and a screen-space grid row cannot
  // answer it — the ground under one row of pixels spans 8 m at the bottom of
  // the frame and 300 m at the horizon.
  const BANDS = [[0, 15], [15, 40], [40, 80], [80, 140]];
  const bandMasks = BANDS.map(() => new Uint8Array(W * H));
  const acc = { n: 0, slope: 0, grass: 0, rock: 0, dirt: 0, sand: 0, snow: 0, dry: 0,
    moist: 0, ground: 0, tiny: 0, d: 0, groundZero: 0, tinyZero: 0 };
  const dband = {};
  const slopeHist = new Array(10).fill(0);
  for (let y = 0; y < H; y += STEP) {
    for (let x = 0; x < W; x += STEP) {
      const ndcx = (x + 0.5) / W * 2 - 1, ndcy = 1 - (y + 0.5) / H * 2;
      dir.set(ndcx, ndcy, 0.5).unproject(e.camera).sub(e.camera.position).normalize();
      let t = 0.4, hit = false, hx = 0, hz = 0;
      for (let k = 0; k < 6000 && t < MAXD + 5; k++) {
        const px = e.camera.position.x + dir.x * t;
        const py = e.camera.position.y + dir.y * t;
        const pz = e.camera.position.z + dir.z * t;
        if (py <= wd.getHeight(px, pz)) { hit = true; hx = px; hz = pz; break; }
        t += Math.max(0.20, t * 0.010);
      }
      if (!hit || t > MAXD) continue;
      const slope = wd.getSlope(hx, hz);
      if (slope < MINSLOPE) continue;
      // Anything with standing water on it is river, not hillside.
      if ((wd.getWaterDepth(hx, hz) ?? 0) > 0.02) continue;
      const w = wd.getSurfaceWeights(hx, hz, scratch);
      const g = gcs._ground(hx, hz, 1.6), gt = gcs._groundTiny(hx, hz);
      acc.n++; acc.slope += slope; acc.grass += w.grass; acc.rock += w.rock;
      acc.dirt += w.dirt; acc.sand += w.sand ?? 0; acc.snow += w.snow;
      acc.dry += w.dry ?? 0; acc.moist += wd.getMoisture(hx, hz);
      acc.ground += g; acc.tiny += gt; acc.d += t;
      if (g < 0.06) acc.groundZero++;
      if (gt < 0.20) acc.tinyZero++;
      slopeHist[Math.min(9, Math.floor(slope / 0.25))]++;
      const b = Math.min(9, Math.floor(t / 20)) * 20;
      dband[b] = (dband[b] || 0) + 1;
      const bi = BANDS.findIndex(([a2, b2]) => t >= a2 && t < b2);
      for (let yy = y; yy < Math.min(H, y + STEP); yy++)
        for (let xx = x; xx < Math.min(W, x + STEP); xx++) {
          mask[yy * W + xx] = 255;
          if (bi >= 0) bandMasks[bi][yy * W + xx] = 255;
        }
    }
  }

  // Cover instances whose root projects inside the mask.
  const gc = window.__systems.groundCover;
  const m = new THREE.Matrix4(), q = new THREE.Vector3();
  const byArch = {}, distBand = {};
  let inMask = 0, onScreen = 0;
  for (const s of gc.slots) {
    const mesh = s.mesh;
    if (!mesh || !mesh.count) continue;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m); q.setFromMatrixPosition(m);
      const d = q.distanceTo(e.camera.position);
      const pr = q.clone().project(e.camera);
      if (Math.abs(pr.x) > 1 || Math.abs(pr.y) > 1 || pr.z > 1) continue;
      onScreen++;
      const sx = Math.min(W - 1, Math.max(0, Math.round((pr.x + 1) / 2 * W)));
      const sy = Math.min(H - 1, Math.max(0, Math.round((1 - pr.y) / 2 * H)));
      if (!mask[sy * W + sx]) continue;
      inMask++;
      const key = mesh.name.replace(/[.#].*$/, '');
      byArch[key] = (byArch[key] || 0) + 1;
      const b = Math.min(7, Math.floor(d / 20)) * 20;
      distBand[b] = (distBand[b] || 0) + 1;
    }
  }

  const mean = (k) => acc.n ? +(acc[k] / acc.n).toFixed(3) : null;
  return {
    cam: [+gx.toFixed(1), +gy.toFixed(1), +gz.toFixed(1)], yaw: +yaw.toFixed(3),
    maskPct: +(100 * acc.n * 1 / ((W / STEP) * (H / STEP))).toFixed(2),
    samples: acc.n,
    mean: {
      dist: mean('d'), slope: mean('slope'), grass: mean('grass'), rock: mean('rock'),
      dirt: mean('dirt'), sand: mean('sand'), snow: mean('snow'), dry: mean('dry'),
      moist: mean('moist'), ground: mean('ground'), tiny: mean('tiny'),
    },
    groundVetoPct: acc.n ? +(100 * acc.groundZero / acc.n).toFixed(1) : null,
    tinyVetoPct: acc.n ? +(100 * acc.tinyZero / acc.n).toFixed(1) : null,
    slopeHist, terrainDistBand: dband, coverDistBand: distBand,
    bands: BANDS.map((b2, i) => ({ band: b2.join('-') + 'm',
      pxPct: +(100 * bandMasks[i].reduce((s2, v) => s2 + (v ? 1 : 0), 0) / (W * H)).toFixed(2) })),
    cover: { onScreen, inMask, byArch, distBand: distBand },
    maskB64: btoa(String.fromCharCode(...new Uint8Array(mask.buffer.slice(0, 0)))) || null,
    mask: Array.from(mask).join('') ? null : null,
    maskBytes: null,
    maskArr: Array.from(new Uint8Array(mask)),
    bandArrs: bandMasks.map((m2) => Array.from(new Uint8Array(m2))),
    bandNames: BANDS.map((b2) => b2.join('_')),
  };
}, { v: VIEWS[VIEW], W, H, STEP, MAXD, MINSLOPE });

// ── write the mask as a greyscale PNG ────────────────────────────────────────
const px = Buffer.from(res.maskArr);
const bandArrs = res.bandArrs, bandNames = res.bandNames;
delete res.maskArr; delete res.maskB64; delete res.mask; delete res.maskBytes;
delete res.bandArrs; delete res.bandNames;
const raw = Buffer.alloc(H * (W + 1));
for (let y = 0; y < H; y++) { raw[y * (W + 1)] = 0; px.copy(raw, y * (W + 1) + 1, y * W, (y + 1) * W); }
const crcT = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const B of b) c = crcT[(c ^ B) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 0;
writeFileSync(`${OUT}-mask.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));

const writeMask = (buf, path) => {
  const raw2 = Buffer.alloc(H * (W + 1));
  for (let y = 0; y < H; y++) { raw2[y * (W + 1)] = 0; buf.copy(raw2, y * (W + 1) + 1, y * W, (y + 1) * W); }
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw2)), chunk('IEND', Buffer.alloc(0))]));
};
bandArrs.forEach((a2, i) => writeMask(Buffer.from(a2), `${OUT}-d${bandNames[i]}.png`));
console.log(JSON.stringify(res, null, 1));
console.log(`wrote ${OUT}-mask.png and ${bandNames.length} band masks  ${W}x${H}`);
await browser.close();
