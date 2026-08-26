// Which path does cue('cover') actually take in the LIVE game — the recording
// or the synthesised fallback? My own verification measured the two as nearly
// identical, which is the shape of a test that never exercised the sample.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage();
page.on('console', (m) => { const t = m.text(); if (/journal:audio/.test(t)) console.log('  [page]', t); });
await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async () => {
  const { JournalAudio } = await import('/src/audio/journal_audio.js');
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const ja = new JournalAudio(ac, ac.destination);
  await ja.loadSamples();
  // Which function does the dispatch pick?
  const picked = [];
  const realCover = ja._sampledCover.bind(ja);
  ja._sampledCover = (c) => { picked.push('SAMPLE'); return realCover(c); };
  // VOICES is module-private, so detect the synth by its absence of a buffer.
  const before = picked.length;
  ja.cue('cover');
  await new Promise((r) => setTimeout(r, 60));
  return {
    coverBufferLoaded: !!ja._cover,
    coverDuration: ja._cover ? +ja._cover.duration.toFixed(3) : null,
    pageBufferLoaded: !!ja._page,
    tookSamplePath: picked.length > before,
    noSampleFlag: !!ja._noSample,
  };
});
console.log(JSON.stringify(out, null, 1));
console.log(out.tookSamplePath ? 'cue("cover") IS playing journal.mp3'
                               : 'cue("cover") is playing the SYNTH — the sample is not reaching it');
await b.close();
