// Are journal.mp3 and page.mp3 actually two different recordings? They are the
// same byte length and the same duration, which is odd enough to check.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle'] });
const page = await b.newPage();
await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });
const out = await page.evaluate(async () => {
  const ac = new OfflineAudioContext(1, 8, 48000);
  const get = async (u) => {
    const bf = await ac.decodeAudioData(await (await fetch(u)).arrayBuffer());
    const n = bf.length, m = new Float32Array(n);
    for (let c = 0; c < bf.numberOfChannels; c++) { const d = bf.getChannelData(c);
      for (let i = 0; i < n; i++) m[i] += d[i] / bf.numberOfChannels; }
    return m;
  };
  const j = await get('/audio/journal.mp3'), p = await get('/audio/page.mp3');
  const n = Math.min(j.length, p.length);
  let num = 0, a2 = 0, b2 = 0;
  for (let i = 0; i < n; i += 5) { num += j[i] * p[i]; a2 += j[i] * j[i]; b2 += p[i] * p[i]; }
  const env = (x, lbl) => {
    const W = 4800, out = [];
    for (let i = 0; i + W <= x.length; i += W) {
      let s = 0; for (let k = i; k < i + W; k++) s += x[k] * x[k];
      out.push((Math.sqrt(s / W)).toFixed(4));
    }
    return `${lbl}: ${out.join(' ')}`;
  };
  return {
    correlation: +(num / Math.sqrt((a2 * b2) || 1)).toFixed(4),
    journalPeak: +Math.max(...Array.from(j, Math.abs)).toFixed(4),
    pagePeak: +Math.max(...Array.from(p, Math.abs)).toFixed(4),
    journalEnv: env(j, 'journal.mp3, rms per 100ms'),
    pageEnv: env(p, 'page.mp3,    rms per 100ms'),
  };
});
console.log(out.journalEnv);
console.log(out.pageEnv);
console.log(`\npeaks: journal ${out.journalPeak}  page ${out.pagePeak}`);
console.log(`correlation between the two files: ${out.correlation}`);
console.log(Math.abs(out.correlation) > 0.9
  ? '  -> these are effectively the SAME recording'
  : '  -> genuinely different recordings');
await b.close();
