// Two WAVs, one question. (A) the mp3 decoded, untouched. (B) exactly what the
// game's cover cue produces under ?soundtest=cover, rendered through the same
// master gain and limiter the live path uses. If A and B sound the same, the
// game is faithful and the file is the problem. If they differ, it is mine.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('/tmp/coverab', { recursive: true });
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle'] });
const page = await b.newPage();
await page.goto(`${URL}/?soundtest=cover`, { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async () => {
  const { JournalAudio } = await import('/src/audio/journal_audio.js');
  const raw = async () => {
    const ac = new OfflineAudioContext(1, 8, 48000);
    const bf = await ac.decodeAudioData(await (await fetch('/audio/journal.mp3')).arrayBuffer());
    return [Array.from(bf.getChannelData(0)),
            Array.from(bf.getChannelData(bf.numberOfChannels > 1 ? 1 : 0))];
  };
  const viaGame = async () => {
    const oac = new OfflineAudioContext(2, 48000 * 2, 48000);
    // The live chain: bus -> master(0.71) -> limiter -> out.
    const master = oac.createGain(); master.gain.value = 0.71;
    const lim = oac.createDynamicsCompressor();
    lim.threshold.value = -6; lim.knee.value = 6; lim.ratio.value = 14;
    lim.attack.value = 0.004; lim.release.value = 0.18;
    master.connect(lim).connect(oac.destination);
    const ja = new JournalAudio(oac, master);
    await ja.loadSamples();
    ja.cue('cover');
    const r = await oac.startRendering();
    return [Array.from(r.getChannelData(0)), Array.from(r.getChannelData(1))];
  };
  return { raw: await raw(), game: await viaGame() };
});

const wav = (ch, sr = 48000) => {
  const n = ch[0].length, c = ch.length;
  const b = Buffer.alloc(44 + n * c * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * c * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(c, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * c * 2, 28);
  b.writeUInt16LE(c * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * c * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) {
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, ch[k][i])) * 32767), o); o += 2;
  }
  return b;
};
writeFileSync('/tmp/coverab/A-the-mp3-untouched.wav', wav(out.raw));
writeFileSync('/tmp/coverab/B-what-the-game-outputs.wav', wav(out.game));
// A reduce, not Math.max(...spread): 48000 arguments blows the call stack.
const pk = (c) => {
  let m = 0;
  for (const ch of c) for (const v of ch) { const a = Math.abs(v); if (a > m) m = a; }
  return m.toFixed(4);
};
console.log(`A peak ${pk(out.raw)}   B peak ${pk(out.game)}`);
await b.close();
