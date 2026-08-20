// Rect-restricted colorstats, for the trees author.
//
// Same statistics and the same hue buckets as tools/colorstats.mjs, so numbers
// here are directly comparable with the critic's — but it takes NO capture slot
// (it decodes an image, it does not bake a world) and it accepts a fractional
// --rect, which is what a claim about "the needles at 3 m" needs.
//
//   node tools/_scratch/tstat.mjs a.png b.png --rect 0.30,0.40,0.10,0.12
//
// Also prints the channel ratio 1 : G/R : B/R, which is the form every conifer
// measurement in docs/CRITIC_FINDINGS.md is quoted in.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const flagVals = new Set(argv.filter((a) => a.startsWith('--')).map((a) => argv[argv.indexOf(a) + 1]));
const files = argv.filter((a) => !a.startsWith('--') && !flagVals.has(a));
const RECT = String(arg('rect', '0,0,1,1')).split(',').map(Number);
// --green restricts every statistic to the green-led chromatic population
// (G > R, chroma > 0.06). A conifer spire is forty pixels wide against a pink
// sky, so ANY rect drawn around one in a wide shot is half background — which
// is how a needle can be reported as red-led when it is not. A population
// filter has no such failure mode.
const GREEN = argv.includes('--green');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });

const rows = [];
for (const f of files) {
  const ext = f.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  const b64 = readFileSync(f).toString('base64');
  rows.push({ file: basename(f), ...await page.evaluate(async ({ b64, ext, RECT, GREEN }) => {
    const img = new Image();
    img.src = `data:image/${ext};base64,${b64}`;
    await img.decode();
    const sx = Math.round(RECT[0] * img.width), sy = Math.round(RECT[1] * img.height);
    const sw = Math.max(1, Math.round(RECT[2] * img.width));
    const sh = Math.max(1, Math.round(RECT[3] * img.height));
    const c = new OffscreenCanvas(sw, sh);
    const g = c.getContext('2d');
    g.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const d = g.getImageData(0, 0, sw, sh).data;

    const lumas = [], chromas = [];
    const hues = new Array(12).fill(0);
    let neutral = 0, vivid = 0, n = 0, sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      const chroma = mx - mn;
      if (GREEN && !(gg > r && chroma > 0.06)) continue;
      sr += d[i]; sg += d[i + 1]; sb += d[i + 2];
      const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      lumas.push(l); chromas.push(chroma);
      if (chroma < 0.06) neutral++;
      if (chroma > 0.35) vivid++;
      if (chroma > 0.04) {
        let h;
        if (mx === r) h = ((gg - b) / chroma + 6) % 6;
        else if (mx === gg) h = (b - r) / chroma + 2;
        else h = (r - gg) / chroma + 4;
        hues[Math.min(11, Math.floor((h / 6) * 12))] += 1;
      }
      n++;
    }
    if (!n) return { srgb: 'none', ratio: 'none', lumaMean: 0, lumaP05: 0, lumaP95: 0,
                     lumaRange: 0, contrastStd: 0, chromaMean: 0, neutralPct: 0,
                     vividPct: 0, sharePct: 0, hueHist: new Array(12).fill(0) };
    lumas.sort((a, b) => a - b);
    const pct = (p) => lumas[Math.min(lumas.length - 1, Math.floor(p * lumas.length))];
    const mean = lumas.reduce((a, b) => a + b, 0) / lumas.length;
    const varr = lumas.reduce((a, b) => a + (b - mean) ** 2, 0) / lumas.length;
    const hueTotal = hues.reduce((a, b) => a + b, 0) || 1;
    const R = sr / n, G = sg / n, B = sb / n;
    return {
      srgb: `${R.toFixed(0)},${G.toFixed(0)},${B.toFixed(0)}`,
      ratio: `1:${(G / R).toFixed(2)}:${(B / R).toFixed(2)}`,
      lumaMean: +mean.toFixed(3),
      lumaP05: +pct(0.05).toFixed(3),
      lumaP95: +pct(0.95).toFixed(3),
      lumaRange: +(pct(0.95) - pct(0.05)).toFixed(3),
      contrastStd: +Math.sqrt(varr).toFixed(3),
      chromaMean: +(chromas.reduce((a, b) => a + b, 0) / n).toFixed(3),
      sharePct: +((n / (sw * sh)) * 100).toFixed(1),
      neutralPct: +((neutral / n) * 100).toFixed(1),
      vividPct: +((vivid / n) * 100).toFixed(1),
      hueHist: hues.map((v) => +((v / hueTotal) * 100).toFixed(1)),
    };
  }, { b64, ext, RECT, GREEN }) });
}
await browser.close();

const HUE = ['red', 'orange', 'yellow', 'y-grn', 'green', 'sprg', 'cyan', 'azure', 'blue', 'violet', 'mgnta', 'rose'];
const pad = (s, w) => String(s).padEnd(w);
const num = (v, w = 18) => String(v).padStart(w);
console.log(pad('metric', 13) + rows.map((r) => num(r.file.slice(0, 17))).join(''));
for (const k of ['srgb', 'ratio', 'sharePct', 'lumaMean', 'lumaP05', 'lumaP95', 'lumaRange',
                 'contrastStd', 'chromaMean', 'neutralPct', 'vividPct']) {
  console.log(pad(k, 13) + rows.map((r) => num(r[k])).join(''));
}
console.log('\nhue % of chromatic px' + `   (rect ${RECT.join(',')})`);
for (let i = 0; i < 12; i++) {
  console.log(pad(HUE[i], 13) + rows.map((r) => num(r.hueHist[i])).join(''));
}
console.log(pad('yel+ygrn', 13) + rows.map((r) => num(+(r.hueHist[2] + r.hueHist[3]).toFixed(1))).join(''));
