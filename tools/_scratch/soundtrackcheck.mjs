// Verify the authored bed decodes, starts on schedule, and reaches the bus.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('soundtrack');
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 800, height: 500 } });
const errs = [];
p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await p.goto('http://localhost:5178/?res=512', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await p.mouse.click(400, 250);
await p.waitForTimeout(3000);

const loaded = await p.evaluate(() => {
  const st = window.__systems.audio.soundtrack;
  return st ? { ...st.state, failed: st.failed, level: st.level } : { missing: true };
});

// Force it on rather than waiting out the natural 20-45 s delay.
const heard = await p.evaluate(async () => {
  const a = window.__systems.audio;
  const st = a.soundtrack;
  st._t = 0; st._until = 0;
  st.update(0.016, false);
  await new Promise(r => setTimeout(r, 9000));
  // Tap the music bus directly rather than guessing at an existing meter.
  const an = a.actx.createAnalyser();
  an.fftSize = 2048;
  a.buses.music.connect(an);
  await new Promise(r => setTimeout(r, 1500));
  let peak = 0, rms = 0;
  const d = new Float32Array(an.fftSize);
  for (let k = 0; k < 24; k++) {
    an.getFloatTimeDomainData(d);
    for (const v of d) { const x = Math.abs(v); if (x > peak) peak = x; rms += v * v; }
    await new Promise(r => setTimeout(r, 60));
  }
  rms = Math.sqrt(rms / (24 * d.length));
  return {
    playing: st.playing, plays: st.state.plays, loaded: st.state.loaded,
    duration: st.state.duration,
    outGain: +st.out.gain.value.toFixed(4),
    musicBusPeak: +peak.toFixed(4),
    musicBusRmsDb: rms > 0 ? +(20 * Math.log10(rms)).toFixed(1) : -Infinity,
  };
});

console.log(JSON.stringify({ loaded, heard, errors: [...new Set(errs)].slice(0, 4) }, null, 1));
await b.close();
