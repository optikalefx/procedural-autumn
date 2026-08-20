import * as THREE from 'three';
import { Lighting, SKY_STATE } from '../../src/render/Lighting.js';
const scene = new THREE.Scene();
const L = new Lighting(scene, 'high');
let prev = null;
const R = (v) => (v * 180 / Math.PI).toFixed(1);
for (let h = 0; h < 24.001; h += 0.004) {
  L.hour = h; L.update(0.016, null);
  const s = SKY_STATE;
  const cur = { sx: s.sunDir.x, sz: s.sunDir.z, se: s.sunElev, mx: s.moonDir.x, mz: s.moonDir.z,
    me: s.moonElev, day: s.dayFactor, star: s.starAmount, night: s.nightFactor, mi: s.moonIntensity };
  if (prev) {
    for (const k of Object.keys(cur)) {
      const d = Math.abs(cur[k] - prev[k]);
      if (d > 0.010) console.log(`JUMP ${k} at h${h.toFixed(3)}  ${prev[k].toFixed(3)} -> ${cur[k].toFixed(3)}`);
    }
  }
  prev = cur;
}
console.log('--- table');
for (const h of [18,18.3,18.9,19,19.4,19.8,20.4,21,22,0,2,4,5,5.2,5.6,6.2,6.3,7,7.4]) {
  L.hour = h; L.update(0.016, null);
  const s = SKY_STATE;
  console.log(`h${String(h).padStart(5)} sunEl ${R(Math.asin(s.sunElev)).padStart(6)}  moonEl ${R(Math.asin(s.moonElev)).padStart(6)}  day ${s.dayFactor.toFixed(2)} moonI ${s.moonIntensity.toFixed(2)} star ${s.starAmount.toFixed(2)} mw ${s.milkyWay.toFixed(2)} night ${s.nightFactor.toFixed(2)} moonLight ${L.moon.intensity.toFixed(3)} shadow ${L.moon.castShadow ? 'Y' : '-'}/${L.sun.castShadow ? 'S' : '-'}`);
}
