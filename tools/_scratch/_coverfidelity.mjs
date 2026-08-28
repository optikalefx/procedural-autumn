// Is what comes out of cue('cover') the file, or the file with things done to
// it? Correlate the rendered cue against the raw mp3 sample-for-sample. A pure
// gain gives correlation 1.0; a window, a resample or a filter does not.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage();
await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });
const out = await page.evaluate(async () => {
  const { JournalAudio } = await import('/src/audio/journal_audio.js');
  const oac = new OfflineAudioContext(2, 48000 * 2, 48000);
  const ja = new JournalAudio(oac, oac.destination);
  await ja.loadSamples();
  ja.cue('cover');
  const r = await oac.startRendering();
  const mix = (buf) => { const n = buf.length, m = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) m[i] += d[i] / buf.numberOfChannels; } return m; };
  const played = mix(r);
  const ac2 = new OfflineAudioContext(1, 8, 48000);
  const raw = mix(await ac2.decodeAudioData(await (await fetch('/audio/journal.mp3')).arrayBuffer()));

  // Find where the cue starts (it is scheduled a few ms in) and correlate.
  let best = { lag: 0, r: -1 };
  for (let lag = 0; lag < 48000 * 0.05; lag += 1) {
    let num = 0, a2 = 0, b2 = 0;
    for (let i = 0; i < raw.length; i += 7) {
      const x = raw[i], y = played[i + lag] ?? 0;
      num += x * y; a2 += x * x; b2 += y * y;
    }
    const rr = num / Math.sqrt((a2 * b2) || 1);
    if (rr > best.r) best = { lag, r: rr };
  }
  // The implied gain, from the ratio of energies at that lag.
  let sx = 0, sy = 0;
  for (let i = 0; i < raw.length; i += 7) { sx += raw[i] * raw[i]; sy += (played[i + best.lag] ?? 0) ** 2; }
  return {
    rawDurationS: +(raw.length / 48000).toFixed(3),
    correlation: +best.r.toFixed(4),
    impliedGain: +Math.sqrt(sy / (sx || 1)).toFixed(3),
    rawPeak: +Math.max(...Array.from(raw, Math.abs)).toFixed(4),
    playedPeak: +Math.max(...Array.from(played, Math.abs)).toFixed(4),
  };
});
console.log(JSON.stringify(out, null, 1));
console.log(out.correlation > 0.999
  ? 'PASS - what plays is the file, scaled and nothing else'
  : `NOT CLEAN - correlation ${out.correlation}, something is still altering it`);
await b.close();
