// Walk the mp3's own frame headers and add up the real duration, independent of
// any decoder. If the file contains more audio than decodeAudioData hands back,
// that is the bug — and it would explain a file that sounds right on disk and
// like a half-second of noise in the game.
import { readFileSync } from 'node:fs';
const BITRATE = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];      // MPEG1 L3
const BITRATE2 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];         // MPEG2/2.5 L3
const RATE = { 3: [44100,48000,32000], 2: [22050,24000,16000], 0: [11025,12000,8000] };

for (const f of process.argv.slice(2)) {
  const b = readFileSync(f);
  let i = 0, frames = 0, samples = 0, sr = 0, tags = [];
  // Skip ID3v2 if present.
  if (b.slice(0, 3).toString() === 'ID3') {
    const sz = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    tags.push(`ID3v2 ${sz + 10}B`);
    i = sz + 10;
  }
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const verBits = (b[i + 1] >> 3) & 0x03;
    const layer = (b[i + 1] >> 1) & 0x03;
    if (layer !== 1) { i++; continue; }                       // layer III only
    const brIdx = (b[i + 2] >> 4) & 0x0f;
    const srIdx = (b[i + 2] >> 2) & 0x03;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) { i++; continue; }
    const rates = RATE[verBits] ?? RATE[0];
    const rate = rates[srIdx];
    const kbps = (verBits === 3 ? BITRATE : BITRATE2)[brIdx];
    const spf = verBits === 3 ? 1152 : 576;
    const pad = (b[i + 2] >> 1) & 1;
    const len = Math.floor((spf / 8 * kbps * 1000) / rate) + pad;
    if (len < 4) { i++; continue; }
    if (frames === 0) {
      sr = rate;
      const tail = b.slice(i, i + len).toString('latin1');
      if (tail.includes('Xing')) tags.push('Xing');
      if (tail.includes('Info')) tags.push('Info');
      if (tail.includes('LAME')) tags.push('LAME');
    }
    frames++; samples += spf; i += len;
  }
  console.log(`${f}`);
  console.log(`  ${b.length} bytes, ${frames} frames, ${sr} Hz`);
  console.log(`  real duration from frames: ${(samples / sr).toFixed(3)} s   ${tags.join(' ') || '(no header tag)'}`);
}
