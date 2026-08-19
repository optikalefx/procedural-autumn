#!/usr/bin/env node
/**
 * Crop / magnify a region of a PNG so it can be looked at with the Read tool.
 *
 *   node tools/_scratch/crop.mjs shots/water/x.png --rect 0.1,0.7,0.5,0.3 --out shots/water/x-crop.png
 *
 * --rect is x,y,w,h in *fractions* of the source image, so it survives a change
 * of capture resolution. --scale magnifies (default: fit to 1000 px wide).
 *
 * Also prints the mean sRGB of the crop, which is how a colour claim in a
 * comment gets to be a measurement rather than an impression.
 *
 * No native image library in this tree, so the decode goes through the same
 * headless canvas every other measuring tool here uses.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const flagVals = new Set(argv.filter((a) => a.startsWith('--')).map((a) => argv[argv.indexOf(a) + 1]));
const files = argv.filter((a) => !a.startsWith('--') && !flagVals.has(a) && /\.(png|jpe?g)$/i.test(a));
const RECT = String(arg('rect', '0,0,1,1')).split(',').map(Number);
const OUT = arg('out', null);
const WIDE = parseInt(arg('wide', '1000'), 10);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });

for (const f of files) {
  const ext = f.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  const b64 = readFileSync(f).toString('base64');
  const r = await page.evaluate(async ({ b64, ext, RECT, WIDE }) => {
    const img = new Image();
    img.src = `data:image/${ext};base64,${b64}`;
    await img.decode();
    const sx = Math.round(RECT[0] * img.width), sy = Math.round(RECT[1] * img.height);
    const sw = Math.max(1, Math.round(RECT[2] * img.width));
    const sh = Math.max(1, Math.round(RECT[3] * img.height));
    const scale = Math.min(4, Math.max(1, WIDE / sw));
    const W = Math.round(sw * scale), H = Math.round(sh * scale);
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    let R = 0, G = 0, B = 0;
    for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; }
    const n = d.length / 4;
    const blob = await c.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return { png: btoa(s), mean: [R / n, G / n, B / n].map((v) => Math.round(v)), W, H };
  }, { b64, ext, RECT, WIDE });
  const out = OUT ?? f.replace(/\.(png|jpe?g)$/i, '-crop.png');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(r.png, 'base64'));
  const [R, G, B] = r.mean;
  const ratio = R > 0 ? `1:${(G / R).toFixed(2)}:${(B / R).toFixed(2)}` : 'n/a';
  console.log(`${out}  ${r.W}x${r.H}  mean srgb(${R},${G},${B})  ${ratio}`);
}
await browser.close();
