import * as THREE from 'three';
import { Lighting, SKY_STATE } from '../../src/render/Lighting.js';
const scene = new THREE.Scene();
const L = new Lighting(scene, 'high');
for (const h of [16,17.1,18,18.3,19,19.4,19.8,20.4,21,22,0,2,4,5,5.6,6.3,7,7.4,8]) {
  L.hour = h;
  L.update(0.016, null);
  const s = SKY_STATE;
  const d = s.sunDir, m = s.moonDir;
  console.log(
    `h${String(h).padStart(5)} sunElev ${s.sunElev.toFixed(3)} day ${s.dayFactor.toFixed(3)} moonI ${s.moonIntensity.toFixed(3)} moonElev ${s.moonElev.toFixed(3)} cover ${s.cloudCover.toFixed(3)} star ${s.starAmount.toFixed(2)} sunAz ${(Math.atan2(d.z,d.x)*180/Math.PI).toFixed(0)} moonAz ${(Math.atan2(m.z,m.x)*180/Math.PI).toFixed(0)} lit #${s.cloudLit.getHexString()} dark #${s.cloudDark.getHexString()} amb #${s.cloudAmbient.getHexString()} glow #${s.glow.getHexString()} glowI ${s.glowIntensity.toFixed(2)} sunHor #${s.sunHorizon.getHexString()} hor #${s.horizon.getHexString()} fogFar #${s.fogFar.getHexString()}`);
}
