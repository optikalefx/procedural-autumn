// Scratch: what `evenness` reads at the moment roastshot.mjs's `onesided` stop
// condition fires (doneness >= 0.28 AND evenness <= 0.72), never turning, down
// the height band. roastshot then WARNS if that number is above 0.6, and the
// two thresholds cannot both be satisfied — see the note in the header of
// src/camp/marshmallow_toast.js under "AND ONE MORE INSTRUMENT".
//
//   node tools/_scratch/_unevenchk.mjs
//
// The optional argument is a module to import ToastMap from, so the same
// question can be asked of a throwaway copy of the file with different
// constants. Make the copy and delete it in the same breath; do not leave one
// in the tree to rot:
//
//   sed -e "s#from './camp_materials.js'#from '../../src/camp/camp_materials.js'#" \
//       -e "s#from '../core/MathUtils.js'#from '../../src/core/MathUtils.js'#" \
//       -e "s#from '../render/Stylize.js'#from '../../src/render/Stylize.js'#" \
//       -e "s#^const TOAST_ACC = .*;#const TOAST_ACC = 2.80;#" \
//       -e "s#^const TOAST_K = .*;#const TOAST_K = 0.0326;#" \
//       src/camp/marshmallow_toast.js > tools/_scratch/_toastold.mjs
//   node tools/_scratch/_unevenchk.mjs ./_toastold.mjs && rm tools/_scratch/_toastold.mjs
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
const MOD = process.argv[2] ?? '../../src/camp/marshmallow_toast.js';
const { ToastMap } = await import(MOD);
const bank = JSON.parse(readFileSync('tools/_scratch/banks/roastpose.json','utf8'));
const FIRE = { pos: new THREE.Vector3(bank.fire.x, bank.fire.y, bank.fire.z), top: bank.fire.top, power: 1 };
for (const h of ['0.1','0.16','0.24']) {
  const rec = bank.heights[h]; if (!rec) continue;
  const M0 = new THREE.Matrix4().fromArray(rec.m0);
  const obj = new THREE.Object3D(); obj.matrixAutoUpdate = false; obj.matrixWorld.copy(M0);
  const map = new ToastMap();
  let t = 0, fired = null; const DT = 1/60;
  const trace = [];
  while (t < 120) {
    map.update(DT, obj, FIRE); t += DT;
    const d = map.doneness, e = map.evenness;
    if (!fired && d >= 0.28 && e <= 0.72) fired = { t, d, e };
    if (Math.abs(t % 5) < DT/2) trace.push(`${t.toFixed(0)}s d=${d.toFixed(2)} e=${e.toFixed(2)}`);
  }
  console.log(MOD.replace(/.*\//,''), 'h='+h, fired ? `onesided at ${fired.t.toFixed(1)}s  doneness ${fired.d.toFixed(3)}  evenness ${fired.e.toFixed(3)}` : 'never fired');
  console.log('   ', trace.slice(0,8).join('  '));
}
