// Dump SKY_STATE and the Clouds uniforms straight out of the running page, so
// a value question can be answered without a capture. Scratch, not a gate.
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:5180';
const hours = (process.argv[3] ?? '0,6.3,7.4,17.1,19,19.8,21').split(',').map(Number);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
await page.goto(URL + '?res=256', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 600000, polling: 250 });

console.log(await page.evaluate((hours) => {
  const sys = Object.values(window.__systems ?? {}).find((s) => s?.name === 'Clouds');
  const L = 'colorManagement=' + String(window.__THREE?.ColorManagement?.enabled);
  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const f = (c) => `[${c.r.toFixed(4)},${c.g.toFixed(4)},${c.b.toFixed(4)}] L=${lum(c).toFixed(4)}`;
  const out = [L];
  for (const h of hours) {
    window.__lighting.hour = h;
    window.__lighting.cycleSpeed = 0;
    window.__lighting.update(0.016, window.__ctx?.camera?.position ?? null);
    sys.update(0.016, 100);
    const u = sys.uniforms;
    const S = window.__lighting.constructor;
    out.push(`h${h}  lit ${f(u.uLit.value)}  dark ${f(u.uDark.value)}  amb ${f(u.uAmbient.value)}`);
    out.push(`      rim ${f(u.uRim.value)}  rimAmt ${u.uRimAmt.value.toFixed(3)} silver ${u.uSilver.value.toFixed(3)}` +
             ` low ${u.uLowSun.value.toFixed(2)} below ${u.uBelow.value.toFixed(2)} cover ${u.uCover.value.toFixed(3)} cirrus ${u.uCirrus.value.toFixed(3)}`);
    out.push(`      key [${u.uLightDir.value.x.toFixed(2)},${u.uLightDir.value.y.toFixed(2)},${u.uLightDir.value.z.toFixed(2)}]` +
             `  horizon ${f(u.uHorizon.value)}  horizonSun ${f(u.uHorizonSun.value)}`);
    void S;
  }
  return out.join('\n');
}, hours));

await browser.close();
