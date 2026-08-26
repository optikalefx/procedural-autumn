// The recorded cover, measured through the real cue path, against the ladder
// it has to sit in — and with the asset refused, to prove the fallback.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });

async function run(blockCover) {
  const page = await b.newPage();
  if (blockCover) await page.route('**/audio/journal.mp3', (r) => r.abort());
  await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });
  return page.evaluate(async () => {
    const { JournalAudio } = await import('/src/audio/journal_audio.js');
    const hp = (x, sr, f0, Q = 0.7071) => {
      const w = 2 * Math.PI * f0 / sr, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * Q);
      const b0 = (1 + cs) / 2, b1 = -(1 + cs), b2 = (1 + cs) / 2;
      const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
      const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < x.length; i++) {
        const v = (b0/a0)*x[i] + (b1/a0)*x1 + (b2/a0)*x2 - (a1/a0)*y1 - (a2/a0)*y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
      } return y;
    };
    const render = async (name) => {
      const oac = new OfflineAudioContext(2, 48000 * 2, 48000);
      const ja = new JournalAudio(oac, oac.destination);
      await ja.loadSamples().catch(() => {});
      ja.cue(name);
      const buf = await oac.startRendering();
      const n = buf.length, mono = new Float32Array(n);
      for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c);
        for (let i = 0; i < n; i++) mono[i] += d[i] / 2; }
      const pk = Math.max(...Array.from(mono, Math.abs));
      const h = hp(hp(mono, 48000, 200), 48000, 200);
      return { peak: +pk.toFixed(4), hp200: +Math.max(...Array.from(h, Math.abs)).toFixed(4) };
    };
    const out = {};
    for (const n of ['cover', 'page', 'cross', 'slap']) out[n] = await render(n);
    return out;
  }).finally(() => page.close());
}

const live = await run(false);
console.log('with journal.mp3 :', JSON.stringify(live));
const order = live.slap.hp200 > live.cover.hp200 && live.cover.hp200 > live.page.hp200
           && live.page.hp200 > live.cross.hp200;
console.log(order ? '  PASS - small-speaker order slap > cover > page > cross'
                  : '  FAIL - order broken');
const gone = await run(true);
console.log('asset refused    :', JSON.stringify(gone));
console.log(gone.cover.peak > 0.15 ? '  PASS - synthesised cover still sounds' : '  FAIL - silent');
await b.close();
