// Scratch: is the marshmallow speared straight? Compares the axis the stick
// ROLLS about — extracted from the two matrices roastmat.mjs dumps at spin 0
// and spin 90 — against the marshmallow's own local +Z, which is the axis the
// toast map's lattice is laid out around. Round 10 found 0.9708 at every
// height, i.e. 13.9 degrees of skew, which caps `evenness` at about 0.81
// however fast the player turns. See the header of marshmallow_toast.js.
//   node tools/_scratch/_axischk.mjs
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
const bank = JSON.parse(readFileSync('tools/_scratch/banks/roastpose.json','utf8'));
for (const [h,rec] of Object.entries(bank.heights)) {
  const M0 = new THREE.Matrix4().fromArray(rec.m0), M90 = new THREE.Matrix4().fromArray(rec.m90);
  const R = new THREE.Matrix4().extractRotation(M90).multiply(new THREE.Matrix4().extractRotation(M0).invert());
  const q = new THREE.Quaternion().setFromRotationMatrix(R);
  const spinAxis = new THREE.Vector3(q.x,q.y,q.z).normalize();
  const localZ = new THREE.Vector3(0,0,1).applyMatrix4(new THREE.Matrix4().extractRotation(M0)).normalize();
  const localY = new THREE.Vector3(0,1,0).applyMatrix4(new THREE.Matrix4().extractRotation(M0)).normalize();
  const localX = new THREE.Vector3(1,0,0).applyMatrix4(new THREE.Matrix4().extractRotation(M0)).normalize();
  const ang = 2*Math.acos(Math.min(1,Math.abs(q.w)))*180/Math.PI;
  console.log(`h=${h}  spin angle ${ang.toFixed(1)} deg   axis.localZ ${spinAxis.dot(localZ).toFixed(4)}  axis.localY ${spinAxis.dot(localY).toFixed(4)}  axis.localX ${spinAxis.dot(localX).toFixed(4)}`);
}
