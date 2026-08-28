// I picked the cover's gain off a PEAK. This file's peak is two isolated
// transients 20-30 dB above its own body, so peak-matching sets the clicks to
// the synth's level and leaves the swell inaudible — which is what "harsh" is.
// Match LOUDNESS (rms over the sounding window) instead and see what the peak
// then does.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage();
await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async () => {
  const { JournalAudio } = await import('/src/audio/journal_audio.js');
  const stat = (mono, sr) => {
    const peak = Math.max(...Array.from(mono, Math.abs));
    // rms over the SOUNDING window only — anything above -40 dB of peak.
    const gate = peak * 0.01;
    let s = 0, n = 0;
    for (let i = 0; i < mono.length; i++) if (Math.abs(mono[i]) > gate) { s += mono[i] * mono[i]; n++; }
    const rms = n ? Math.sqrt(s / n) : 0;
    return { peak: +peak.toFixed(4), rms: +rms.toFixed(4),
             crestDb: +(20 * Math.log10(peak / Math.max(rms, 1e-9))).toFixed(1) };
  };
  const render = async (name, noSample) => {
    const oac = new OfflineAudioContext(2, 48000 * 2, 48000);
    const ja = new JournalAudio(oac, oac.destination);
    await ja.loadSamples().catch(() => {});
    if (noSample) ja._noSample = true;
    ja.cue(name);
    const buf = await oac.startRendering();
    const n = buf.length, mono = new Float32Array(n);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / 2; }
    return stat(mono, 48000);
  };
  return {
    sampledCover: await render('cover', false),
    synthCover: await render('cover', true),
    slap: await render('slap', false),
    page: await render('page', false),
  };
});
console.log('sampled cover (gain 4.26):', JSON.stringify(out.sampledCover));
console.log('synth cover  (the target):', JSON.stringify(out.synthCover));
console.log('slap                     :', JSON.stringify(out.slap));
console.log('page                     :', JSON.stringify(out.page));
const g = 4.26 * (out.synthCover.rms / out.sampledCover.rms);
console.log(`\ngain that matches the synth's LOUDNESS: ${g.toFixed(2)}`);
console.log(`  -> peak would be ${(out.sampledCover.peak * g / 4.26).toFixed(4)} (slap peak ${out.slap.peak})`);
await b.close();
