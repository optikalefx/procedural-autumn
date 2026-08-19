#!/bin/zsh
# Frame the nearest instance of one cover archetype and capture it.
#   coverframe.sh <archKey> <outPng> [dist] [eyeY] [side: lit|back]
KEY=$1; OUT=$2; D=${3:-2.4}; HY=${4:-1.05}; SIDE=${5:-lit}
EV="(()=>{const gc=window.__systems.groundCover,T=window.__THREE,cam=window.__engine.camera;const m=new T.Matrix4(),p=new T.Vector3();let best=null,bd=1e9;for(const mesh of gc.meshes){if(!mesh.visible)continue;if(mesh.name.indexOf('cover_${KEY}_')!==0)continue;for(let i=0;i<mesh.count;i++){mesh.getMatrixAt(i,m);p.setFromMatrixPosition(m);const d=p.distanceTo(cam.position);if(d<bd){bd=d;best=p.clone();}}}if(best){const sd=window.__lighting.sunDir.clone();const h=new T.Vector3(sd.x,0,sd.z).normalize();const s='${SIDE}'==='lit'?1:-1;cam.position.set(best.x+h.x*${D}*s,best.y+${HY},best.z+h.z*${D}*s);cam.lookAt(best.x,best.y+0.45,best.z);cam.updateMatrixWorld(true);}window.__coverFramed=best?best.toArray():null;})()"
node tools/shot.mjs --view meadow --out "$OUT" --w 1600 --h 900 --eval "$EV"
