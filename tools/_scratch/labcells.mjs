// Scratch: per-cell post-tone-curve colour of a toastlab sheet.
//   node tools/_scratch/labcells.mjs sheet.png [tile]
// Cells are laid out by toastlab: PAD 10, HDR 34, ROWLBL 24, LBL 22.
import { readPNG } from '../_pngread.mjs';
const [p, T] = process.argv.slice(2);
const TILE = +(T ?? 420), PAD = 10, HDR = 34, ROWLBL = 24, LBL = 22;
const STATES = ['raw', 't20', 't42', 't60', 't78', 't95', 'uneven', 'burning', 'coldchar'];
const LIGHTS = ['day', 'fire'];
const img = readPNG(p), bpp = img.px.length / (img.w * img.h);
const lin = (u) => { const c = u / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const hue = (r, g, b) => { const mx = Math.max(r,g,b), mn = Math.min(r,g,b), c = mx-mn; if (c<1) return [0,0];
  let h = mx===r ? ((g-b)/c+6)%6 : mx===g ? (b-r)/c+2 : (r-g)/c+4; return [h*60, c/mx]; };
console.log('light state    lum    meanRGB         hue   sat   redClip%');
for (let li = 0; li < LIGHTS.length; li++) {
  const y0 = HDR + li * (ROWLBL + TILE + LBL + PAD) + ROWLBL;
  for (let si = 0; si < STATES.length; si++) {
    const x0 = PAD + si * (TILE + PAD);
    let n = 0, R = 0, G = 0, B = 0, L = 0, clip = 0;
    for (let y = y0 + 20; y < y0 + TILE - 20; y++) for (let x = x0 + 20; x < x0 + TILE - 20; x++) {
      const o = (y * img.w + x) * bpp, r = img.px[o], g = img.px[o+1], b = img.px[o+2];
      if (r < 12 && g < 12 && b < 45) continue;           // sheet background
      n++; R += r; G += g; B += b; if (r >= 250) clip++;
      L += 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
    }
    if (!n) continue;
    const rgb = [R/n, G/n, B/n].map(Math.round);
    const [h, s] = hue(...rgb);
    console.log(LIGHTS[li].padEnd(5), STATES[si].padEnd(8), (L/n).toFixed(3),
      `[${rgb.join(',')}]`.padEnd(15), `${h.toFixed(0)}deg`.padStart(6), s.toFixed(2).padStart(5),
      (100*clip/n).toFixed(1).padStart(6));
  }
}
