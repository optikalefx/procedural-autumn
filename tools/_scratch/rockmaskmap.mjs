#!/usr/bin/env node
/**
 * Where on screen does the rock material actually draw?
 *
 *   node tools/_scratch/rockmaskmap.mjs shots/rocks/mask-hero-paint.png
 *
 * Feed it a frame captured with the rock material forced to pure red
 * (uRockDesat 1, uRockCast 6,0,0). Prints the share of the frame the material
 * owns, its bounding box, and a coarse occupancy grid so a measurement rect can
 * be aimed at rock instead of at whatever is behind it.
 *
 * Written because two separate findings in docs/CRITIC_FINDINGS.md quote rock
 * colour on rects picked by eye off a screenshot, and a rect picked that way
 * cannot tell a rock from the terrain massif it is sitting on.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
// --diff A B: mask = pixels that differ by more than --thresh (default 6/255).
// Use it with a rocks-hidden frame; a paint mask misses anything far enough
// away that the haze has eaten the paint, and rock at 800 m is exactly that.
const DIFF = argv.includes('--diff');
// indexOf returns -1 when the flag is absent, and argv[0] is then read as the
// threshold — Number('--diff') is NaN and every `diff > NaN` is false, so the
// tool reported a clean 0% for a frame pair that differs in 17% of its pixels.
const rgI = argv.indexOf('--region');
// Restrict the mask to a rect. A frame-wide average over every rock in view
// dilutes the handful of blocks a critic is actually pointing at.
const REGION = rgI === -1 ? null : argv[rgI + 1].split(',').map(Number);
const thI = argv.indexOf('--thresh');
const TH = thI === -1 ? 6 : Number(argv[thI + 1]);
const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--thresh' && argv[i - 1] !== '--region');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const pairs = DIFF ? [[files[0], files[1]]] : files.map((f) => [f, null]);
for (const [f, f2] of pairs) {
  const res = await page.evaluate(async ({ b64, b642, TH, REGION }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    let d2 = null;
    if (b642) {
      const j = new Image();
      j.src = 'data:image/png;base64,' + b642;
      await j.decode();
      const c2 = new OffscreenCanvas(j.width, j.height);
      const g2 = c2.getContext('2d', { willReadFrequently: true });
      g2.drawImage(j, 0, 0);
      d2 = g2.getImageData(0, 0, j.width, j.height).data;
    }
    const GX = 20, GY = 12;
    const grid = Array.from({ length: GY }, () => new Array(GX).fill(0));
    const cell = Array.from({ length: GY }, () => new Array(GX).fill(0));
    let hits = 0, n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    // Stats over the masked pixels only, in BOTH frames: what the rock renders
    // as, and what is behind it. That pair is the only honest way to ask
    // whether rock and its host read as the same substance — a rect drawn round
    // a rock also contains the hillside it sits on.
    const pairs = [];
    const accA = { r: 0, g: 0, b: 0, c: 0, l: 0, neutral: 0, vivid: 0 };
    const accB = { r: 0, g: 0, b: 0, c: 0, l: 0, neutral: 0, vivid: 0 };
    const push = (a, r, g2, b2) => {
      const R = r / 255, G = g2 / 255, B = b2 / 255;
      const ch = Math.max(R, G, B) - Math.min(R, G, B);
      a.r += R; a.g += G; a.b += B; a.c += ch;
      a.l += 0.2126 * R + 0.7152 * G + 0.0722 * B;
      if (ch < 0.06) a.neutral++;
      if (ch > 0.35) a.vivid++;
    };
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const gy = Math.min(GY - 1, Math.floor(y / img.height * GY));
      const gx = Math.min(GX - 1, Math.floor(x / img.width * GX));
      cell[gy][gx]++; n++;
      // "Red-led far beyond anything the palette contains." The most saturated
      // warm thing in the scene is a crimson canopy, which stays under +60.
      const inRegion = !REGION || (x >= REGION[0] * img.width && x < (REGION[0] + REGION[2]) * img.width
        && y >= REGION[1] * img.height && y < (REGION[1] + REGION[3]) * img.height);
      const hit = inRegion && (d2
        ? (Math.abs(r - d2[i]) + Math.abs(gg - d2[i + 1]) + Math.abs(b - d2[i + 2])) / 3 > TH
        : (r - gg > 70 && r - b > 70));
      if (hit) {
        hits++; grid[gy][gx]++;
        if (d2) {
          push(accA, r, gg, b); push(accB, d2[i], d2[i + 1], d2[i + 2]);
          pairs.push([0.2126 * r + 0.7152 * gg + 0.0722 * b, r, gg, b, d2[i], d2[i + 1], d2[i + 2]]);
        }
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return {
      w: img.width, h: img.height, pct: +(100 * hits / n).toFixed(3), hits,
      bbox: hits ? [+(x0 / img.width).toFixed(3), +(y0 / img.height).toFixed(3),
        +((x1 - x0) / img.width).toFixed(3), +((y1 - y0) / img.height).toFixed(3)] : null,
      grid: grid.map((row, gy) => row.map((v, gx) => Math.round(100 * v / cell[gy][gx]))),
      // Rock's own lit end against exactly what that lit end covers. A chip
      // that reads as pasted onto a hillside is a *value* relation to the one
      // surface behind it, which no rect average can see.
      bands: d2 && hits ? (() => {
        pairs.sort((p, q) => p[0] - q[0]);
        const k = Math.max(1, Math.floor(pairs.length / 3));
        const band = (arr) => {
          const m = (f) => arr.reduce((s2, p) => s2 + f(p), 0) / arr.length;
          const lum = (r, g2, b2) => (0.2126 * r + 0.7152 * g2 + 0.0722 * b2) / 255;
          return {
            rock: [Math.round(m((p) => p[1])), Math.round(m((p) => p[2])), Math.round(m((p) => p[3]))],
            host: [Math.round(m((p) => p[4])), Math.round(m((p) => p[5])), Math.round(m((p) => p[6]))],
            rockL: +m((p) => lum(p[1], p[2], p[3])).toFixed(3),
            hostL: +m((p) => lum(p[4], p[5], p[6])).toFixed(3),
          };
        };
        return { dark: band(pairs.slice(0, k)), lit: band(pairs.slice(-k)) };
      })() : null,
      masked: d2 && hits ? [accA, accB].map((a) => ({
        srgb: [Math.round(255 * a.r / hits), Math.round(255 * a.g / hits), Math.round(255 * a.b / hits)],
        ratio: [1, +(a.g / a.r).toFixed(3), +(a.b / a.r).toFixed(3)],
        luma: +(a.l / hits).toFixed(3), chroma: +(a.c / hits).toFixed(3),
        neutralPct: +(100 * a.neutral / hits).toFixed(1), vividPct: +(100 * a.vivid / hits).toFixed(1),
      })) : null,
    };
  }, { b64: readFileSync(f).toString('base64'), b642: f2 ? readFileSync(f2).toString('base64') : null, TH, REGION });
  console.log(`${f}${f2 ? ' vs ' + f2 : ''}  ${res.w}x${res.h}  mask covers ${res.pct}% of pixels  bbox ${JSON.stringify(res.bbox)}`);
  if (res.masked) {
    const [A, B] = res.masked;
    console.log(`  masked pixels in A (rock):   srgb(${A.srgb}) ${A.ratio.join(':')} luma ${A.luma} chroma ${A.chroma} neutral ${A.neutralPct}% vivid ${A.vividPct}%`);
    console.log(`  masked pixels in B (behind): srgb(${B.srgb}) ${B.ratio.join(':')} luma ${B.luma} chroma ${B.chroma} neutral ${B.neutralPct}% vivid ${B.vividPct}%`);
  }
  if (res.bands) for (const [k, b] of Object.entries(res.bands))
    console.log(`  ${k.padEnd(4)} third of rock: rock srgb(${b.rock}) L ${b.rockL}  vs what it covers srgb(${b.host}) L ${b.hostL}   rock/host luma ${(b.rockL / b.hostL).toFixed(3)}`);
  console.log('  occupancy %, 20x12 grid (row = 1/12 of frame height):');
  for (const row of res.grid) console.log('   ' + row.map((v) => String(v).padStart(3)).join(''));
}
await browser.close();
