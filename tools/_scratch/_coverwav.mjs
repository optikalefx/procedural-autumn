// Render what cue('cover') actually produces, and decode the raw mp3, and write
// both as WAVs. Arguing about what a sound is like in prose is how the last two
// rounds went; listening to the two files side by side settles it.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('/tmp/coverwav', { recursive: true });
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage();
await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async () => {
  const { JournalAudio } = await import('/src/audio/journal_audio.js');
  const grab = async (what) => {
    if (what === 'raw') {
      const ac = new OfflineAudioContext(1, 8, 48000);
      const buf = await ac.decodeAudioData(await (await fetch('/audio/journal.mp3')).arrayBuffer());
      return [Array.from(buf.getChannelData(0)), Array.from(buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0))];
    }
    const oac = new OfflineAudioContext(2, 48000 * 2, 48000);
    const ja = new JournalAudio(oac, oac.destination);
    await ja.loadSamples();
    if (what === 'synth') ja._noSample = true;
    ja.cue('cover');
    const r = await oac.startRendering();
    return [Array.from(r.getChannelData(0)), Array.from(r.getChannelData(1))];
  };
  return { raw: await grab('raw'), game: await grab('game'), synth: await grab('synth') };
});

const wav = (chans, sr = 48000) => {
  const n = chans[0].length, ch = chans.length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, chans[c][i]));
    buf.writeInt16LE(Math.round(v * 32767), o); o += 2;
  }
  return buf;
};
writeFileSync('/tmp/coverwav/1-your-file-raw.wav', wav(out.raw));
writeFileSync('/tmp/coverwav/2-what-the-game-plays.wav', wav(out.game));
writeFileSync('/tmp/coverwav/3-the-old-synth-cover.wav', wav(out.synth));
console.log('wrote three WAVs to /tmp/coverwav/');
await b.close();
