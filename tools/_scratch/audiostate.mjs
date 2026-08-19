// Report the persisted audio setting — "sound is gone" is usually this.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('audiostate');
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('http://localhost:5178/?res=512', { waitUntil: 'domcontentloaded' });
const stored = await p.evaluate(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    out[k] = localStorage.getItem(k);
  }
  return out;
});
console.log('localStorage on this origin:', JSON.stringify(stored, null, 1));
await b.close();
