#!/usr/bin/env node
/**
 * duskvalue — the DESIGN_BRIEF's one hard rule about this feature, measured.
 *
 *   node tools/_scratch/duskvalue.mjs <frame.png> <ROAST.json>
 *
 * "At dusk a white marshmallow is the only object in the game that can
 * out-value the flame", and if it does, the frame is a reject however pretty it
 * is. So: the subject's maximum LINEAR luma against the frame's own upper
 * quantiles, read off the shipped PNG rather than off an opinion. The
 * marshmallow's disc comes from the harness's `probe.mallowPx`, so this
 * measures the pixels the harness itself says are the subject.
 *
 * Round 4  mallowMax 0.537, frame p99.9 0.685 — 0.15 of headroom.
 * Round 5  mallowMax 0.545, frame p99.9 0.747 — 0.20. Still passes, wider.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [file, jsonFile] = process.argv.slice(2);
const j = JSON.parse(readFileSync(jsonFile, 'utf8'));
const fr = j.frames.find((f) => f.name === 'dusk-held-clean');
const px = fr.probe.mallowPx;
const b = await chromium.launch();
const p = await b.newPage();
const buf = readFileSync(file).toString('base64');
await p.goto('about:blank');
const r = await p.evaluate(async ({ b64, m }) => {
  const img = new Image();
  await new Promise((res) => { img.onload = res; img.src = 'data:image/png;base64,' + b64; });
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  const d = c.getContext('2d').getImageData(0, 0, img.width, img.height).data;
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (i) => 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
  // the marshmallow: a disc of its measured diameter at its measured centre
  const R = m.diameter / 2;
  let mMax = 0; const mAll = [];
  for (let y = Math.floor(m.y - R); y <= m.y + R; y++)
    for (let x = Math.floor(m.x - R); x <= m.x + R; x++) {
      if ((x - m.x) ** 2 + (y - m.y) ** 2 > R * R * 0.8) continue;
      const L = lum((y * img.width + x) * 4);
      mAll.push(L); if (L > mMax) mMax = L;
    }
  // the flame: the brightest connected mass, taken as the top 2% of the frame
  const all = [];
  for (let i = 0; i < d.length; i += 4) all.push(lum(i));
  all.sort((a, z) => a - z);
  const q = (f) => all[Math.floor(f * (all.length - 1))];
  mAll.sort((a, z) => a - z);
  return { mallowMax: mMax, mallowP95: mAll[Math.floor(0.95 * (mAll.length - 1))],
    frameP95: q(0.95), frameP98: q(0.98), frameP999: q(0.999), frameMax: all[all.length - 1] };
}, { b64: buf, m: px });
console.log(JSON.stringify(r, null, 1));
await b.close();
