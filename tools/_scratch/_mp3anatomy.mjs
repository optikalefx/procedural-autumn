// What is actually inside journal.mp3, per channel — in case the content is in
// one channel, or the export went wrong in a way a mono mix would hide.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle'] });
const page = await b.newPage();
await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });
const out = await page.evaluate(async () => {
  const ac = new OfflineAudioContext(1, 8, 48000);
  const look = async (u) => {
    const bf = await ac.decodeAudioData(await (await fetch(u)).arrayBuffer());
    const per = [];
    for (let c = 0; c < bf.numberOfChannels; c++) {
      const d = bf.getChannelData(c);
      let pk = 0, s = 0;
      for (let i = 0; i < d.length; i++) { pk = Math.max(pk, Math.abs(d[i])); s += d[i] * d[i]; }
      // 100 ms envelope so the shape is readable.
      const env = [];
      const W = 4800;
      for (let i = 0; i + W <= d.length; i += W) {
        let e = 0; for (let k = i; k < i + W; k++) e += d[k] * d[k];
        env.push(Math.sqrt(e / W).toFixed(4));
      }
      per.push({ ch: c, peak: +pk.toFixed(4), rms: +Math.sqrt(s / d.length).toFixed(5), env: env.join(' ') });
    }
    return { url: u, sr: bf.sampleRate, seconds: +(bf.length / bf.sampleRate).toFixed(3),
             channels: bf.numberOfChannels, per };
  };
  return { journal: await look('/audio/journal.mp3'), page: await look('/audio/page.mp3') };
});
for (const k of ['journal', 'page']) {
  const f = out[k];
  console.log(`\n${f.url}  ${f.seconds}s  ${f.sr}Hz  ${f.channels}ch`);
  for (const c of f.per) console.log(`  ch${c.ch} peak ${c.peak}  rms ${c.rms}\n       ${c.env}`);
}
await b.close();
