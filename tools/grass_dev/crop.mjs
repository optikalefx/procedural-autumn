// Crop-and-magnify a capture so a defect can actually be looked at.
//
// The judgement frames are 1280–1600 px wide and the Read tool shows them at
// about that size; a 120 px band of muddy grass is unreadable at that scale.
// This pulls out a normalised rectangle and upscales it (nearest, so pixel
// structure survives) into its own PNG.
//
//   node tools/grass_dev/crop.mjs shots/grass/r1/low.png out.png 0,0.45,1,0.35
//                                  <in>          <out>    x,y,w,h  (0..1)
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { acquire } from '../_lock.mjs';

const [inFile, outFile, rect = '0,0.5,1,0.5', scaleArg = '2'] = process.argv.slice(2);
if (!inFile || !outFile) { console.error('usage: crop.mjs <in> <out> x,y,w,h [scale]'); process.exit(1); }
const [rx, ry, rw, rh] = rect.split(',').map(Number);
const scale = Number(scaleArg);

await acquire('grass-crop');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const b64 = readFileSync(inFile).toString('base64');
const ext = inFile.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';

const dataUrl = await page.evaluate(async ({ b64, ext, rx, ry, rw, rh, scale }) => {
  const img = new Image();
  img.src = `data:image/${ext};base64,${b64}`;
  await img.decode();
  const sx = Math.round(rx * img.width),  sy = Math.round(ry * img.height);
  const sw = Math.round(rw * img.width),  sh = Math.round(rh * img.height);
  const c = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s);
}, { b64, ext, rx, ry, rw, rh, scale });

mkdirSync(dirname(resolve(outFile)), { recursive: true });
writeFileSync(resolve(outFile), Buffer.from(dataUrl, 'base64'));
console.log('crop', outFile);
await browser.close();
