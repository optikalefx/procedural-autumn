import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';
const buf = readFileSync('public/models/fox_reference.glb');
new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength), '', (g) => {
  const walk = g.animations.find(a => a.name === 'Walk');
  const bone = g.scene.getObjectByName('fore_upperL');
  const rest = bone.quaternion.clone();
  console.log('REST rotation of fore_upperL :', rest.toArray().map(v=>+v.toFixed(4)).join(', '),
              ' = angle', (2*Math.acos(Math.min(1,Math.abs(rest.w)))*180/Math.PI).toFixed(1)+'deg');

  const tr = walk.tracks.find(t => t.name === 'fore_upperL.quaternion');
  const q = new THREE.Quaternion(), d = new THREE.Quaternion();
  const restInv = rest.clone().invert();
  console.log('\nkey  baked-abs-angle   delta-from-rest');
  for (let i = 0; i < tr.values.length; i += 4) {
    q.set(tr.values[i], tr.values[i+1], tr.values[i+2], tr.values[i+3]);
    d.copy(restInv).multiply(q);
    const abs = 2*Math.acos(Math.min(1,Math.abs(q.w)))*180/Math.PI;
    const del = 2*Math.acos(Math.min(1,Math.abs(d.w)))*180/Math.PI;
    console.log(`  ${(i/4).toString().padStart(2)}   ${abs.toFixed(1).padStart(7)}deg   ${del.toFixed(1).padStart(7)}deg`);
  }

  // What my shipped widenStride does: scale the ABSOLUTE rotation.
  const wrong = new THREE.Quaternion().set(tr.values[0],tr.values[1],tr.values[2],tr.values[3]);
  const scaledWrong = new THREE.Quaternion().slerp(wrong, 4);
  console.log('\nkey0 absolute        :', (2*Math.acos(Math.min(1,Math.abs(wrong.w)))*180/Math.PI).toFixed(1)+'deg');
  console.log('key0 x4 (what ships) :', (2*Math.acos(Math.min(1,Math.abs(scaledWrong.w)))*180/Math.PI).toFixed(1)+'deg  <-- includes the rest pose');
  const right = restInv.clone().multiply(wrong);
  const scaledRight = new THREE.Quaternion().slerp(right, 4);
  const recomposed = rest.clone().multiply(scaledRight);
  console.log('key0 delta x4, recomposed:', (2*Math.acos(Math.min(1,Math.abs(recomposed.w)))*180/Math.PI).toFixed(1)+'deg  <-- correct');
});
