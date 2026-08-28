// Scratch: how much of the surface qualifies for ignition, and when. The
// ignition test in marshmallow_toast.js needs an area fraction that a
// never-turned marshmallow reaches and a single cap texel cannot; this prints
// the peak qualifying area (char > IGNITE_CHAR and live > IGNITE_HEAT) and the
// time it peaks, for the whole height band, under whichever policy is asked.
//   node tools/_scratch/_ignarea.mjs <spin rad/s>
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { ToastMap } from '../../src/camp/marshmallow_toast.js';
const bank = JSON.parse(readFileSync('tools/_scratch/banks/roastpose.json','utf8'));
const FIRE = { pos: new THREE.Vector3(bank.fire.x, bank.fire.y, bank.fire.z), top: bank.fire.top, power: 1 };
const SPIN = parseFloat(process.argv[2] ?? '0');
for (const h of Object.keys(bank.heights).map(Number).sort((a,b)=>a-b)) {
  const rec = bank.heights[h];
  const M0 = new THREE.Matrix4().fromArray(rec.m0), M90 = new THREE.Matrix4().fromArray(rec.m90);
  const p = new THREE.Vector3().setFromMatrixPosition(M0);
  const R = new THREE.Matrix4().extractRotation(M90).multiply(new THREE.Matrix4().extractRotation(M0).invert());
  const qq = new THREE.Quaternion().setFromRotationMatrix(R);
  const axis = new THREE.Vector3(qq.x,qq.y,qq.z); axis.lengthSq()<1e-12?axis.set(0,1,0):axis.normalize();
  const obj = new THREE.Object3D(); obj.matrixAutoUpdate=false;
  const at=(s)=>{obj.matrixWorld.copy(M0)
   .premultiply(new THREE.Matrix4().makeTranslation(-p.x,-p.y,-p.z))
   .premultiply(new THREE.Matrix4().makeRotationAxis(axis,s))
   .premultiply(new THREE.Matrix4().makeTranslation(p.x,p.y,p.z)); return obj;};
  const map = new ToastMap();
  let t=0, peakArea=0, tPeak=0; const DT=1/60;
  while (t<150) {
    map.update(DT, at(t*SPIN), FIRE); t+=DT;
    let a=0;
    for(let i=0;i<map.count;i++) if (map.char[i]>0.78 && map.live[i]>0.70) a+=map.area[i];
    if (a>peakArea){peakArea=a;tPeak=t;}
    if (map.burning) break;
  }
  console.log(`spin ${SPIN}  h=${h.toFixed(2)}  max qualifying area ${peakArea.toFixed(3)} at ${tPeak.toFixed(1)}s  liveMax ${map.heat.toFixed(3)}`);
}
