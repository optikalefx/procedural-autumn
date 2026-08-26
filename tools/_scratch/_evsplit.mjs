// Scratch: where the within-ring unevenness actually is. Runs the real
// ToastMap to golden at the default height and prints each band's mean and
// standard deviation, plus one whole ring of 24 texels. Written to find out
// why `evenness` plateaus at 0.78 no matter how fast the marshmallow is
// turned; the answer is the 13.9-degree spear skew (_axischk.mjs).
//   node tools/_scratch/_evsplit.mjs <spin rad/s>
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { ToastMap } from '/Users/sean/htdocs/procedural-fall/.claude/worktrees/water-birds-flamingos-herons-28bc65/src/camp/marshmallow_toast.js';
const bank = JSON.parse(readFileSync('/Users/sean/htdocs/procedural-fall/.claude/worktrees/water-birds-flamingos-herons-28bc65/tools/_scratch/banks/roastpose.json','utf8'));
const FIRE = { pos: new THREE.Vector3(bank.fire.x, bank.fire.y, bank.fire.z), top: bank.fire.top, power: 1 };
const rec = bank.heights['0.24'];
const M0 = new THREE.Matrix4().fromArray(rec.m0), M90 = new THREE.Matrix4().fromArray(rec.m90);
const p = new THREE.Vector3().setFromMatrixPosition(M0);
const R = new THREE.Matrix4().extractRotation(M90).multiply(new THREE.Matrix4().extractRotation(M0).invert());
const q = new THREE.Quaternion().setFromRotationMatrix(R);
const axis = new THREE.Vector3(q.x,q.y,q.z).normalize();
const obj = new THREE.Object3D(); obj.matrixAutoUpdate=false;
const at=(s)=>{obj.matrixWorld.copy(M0)
 .premultiply(new THREE.Matrix4().makeTranslation(-p.x,-p.y,-p.z))
 .premultiply(new THREE.Matrix4().makeRotationAxis(axis,s))
 .premultiply(new THREE.Matrix4().makeTranslation(p.x,p.y,p.z)); return obj;};
const SPIN = parseFloat(process.argv[2] ?? '2.0');
const map = new ToastMap();
let t=0; const DT=1/60;
while (map.doneness < 0.55 && t < 300) { map.update(DT, at(t*SPIN), FIRE); t += DT; }
console.log('spin', SPIN, 'gold at', t.toFixed(1), 'evenness', map.evenness.toFixed(3));
{ const j=6; console.log(' ring 6 toast:', Array.from({length:map.rings},(_,i)=>map.toast[j*map.rings+i].toFixed(3)).join(' ')); }
for (let j=0;j<map.bands;j++){
  let s=0,s2=0; for(let i=0;i<map.rings;i++){const v=map.toast[j*map.rings+i]; s+=v; s2+=v*v;}
  const m=s/map.rings, sd=Math.sqrt(Math.max(0,s2/map.rings-m*m));
  console.log(' band',String(j).padStart(2),'mean',m.toFixed(3),'sd',sd.toFixed(4));
}
