// Which gain puts journal.mp3 where the synthesised cover sits? Four columns
// disagree, and hp200 is the one that decides — the small-speaker ordering
// (cover & slap on top, page under, cross at the bottom) is a rule this file
// holds, and it is measured through a 4th-order 200 Hz high-pass.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage();
await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async () => {
  const TAKE = [0.02, 0.52];
  const measure = (mono, sr) => {
    const peak = Math.max(...Array.from(mono, Math.abs));
    let s = 0; for (let i = 0; i < mono.length; i++) s += mono[i] * mono[i];
    return { peak: +peak.toFixed(4), rms: +Math.sqrt(s / mono.length).toFixed(4) };
  };
  // A 2nd-order RBJ high-pass, applied twice — 4th order, as the file's table is.
  const hp = (x, sr, f0, Q = 0.7071) => {
    const w = 2 * Math.PI * f0 / sr, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * Q);
    const b0 = (1 + cs) / 2, b1 = -(1 + cs), b2 = (1 + cs) / 2;
    const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = (b0 / a0) * x[i] + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  };

  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ac.decodeAudioData(await (await fetch('/audio/journal.mp3')).arrayBuffer());
  const sr = buf.sampleRate;
  const i0 = Math.round(TAKE[0] * sr), i1 = Math.round(TAKE[1] * sr);
  const mono = new Float32Array(i1 - i0);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = i0; i < i1; i++) mono[i - i0] += d[i] / buf.numberOfChannels;
  }
  const raw = measure(mono, sr);
  const rawHp = measure(hp(hp(mono, sr, 200), sr, 200), sr);

  // The ladder as it stands (from journal_audio.js's own table).
  const target = { coverPeak: 0.230, coverHp: 0.1319, pageHp: 0.1146, slapHp: 0.1356 };
  const gPeak = target.coverPeak / raw.peak;
  const gHp = target.coverHp / rawHp.peak;
  const rows = [];
  for (const g of [gPeak, gHp, 4, 5, 5.5, 6, 6.5]) {
    rows.push({
      gain: +g.toFixed(3),
      peak: +(raw.peak * g).toFixed(4),
      hp200: +(rawHp.peak * g).toFixed(4),
      underSlap: rawHp.peak * g < target.slapHp,
      overPage: rawHp.peak * g > target.pageHp,
    });
  }
  return { raw, rawHp, gainForPeak: +gPeak.toFixed(3), gainForHp: +gHp.toFixed(3), rows };
});
console.log('raw take   ', JSON.stringify(out.raw), ' hp200', JSON.stringify(out.rawHp));
console.log('gain to match cover peak :', out.gainForPeak);
console.log('gain to match cover hp200:', out.gainForHp);
console.table ? console.table(out.rows) : console.log(out.rows);
for (const r of out.rows) console.log(JSON.stringify(r));
await b.close();
