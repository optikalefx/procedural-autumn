#!/bin/zsh
# 2 m ground close-ups at the pinned road / meadow anchors, cloud shadow frozen.
#   closeup.sh <dir>
DIR=${1:-shots/cover/take}
mkdir -p "$DIR"
mk () {
  X=$1; Z=$2; YAW=$3; EYE=$4; AHEAD=$5; TGT=$6; HOUR=$7; OUT=$8
  EV="(async()=>{const e=window.__engine,wd=window.__world;window.__lighting.hour=$HOUR;window.__lighting.cycleSpeed=0;if(window.__atmosphere&&window.__atmosphere.params)window.__atmosphere.params.cloudShadow=0;const gy=wd.getHeight($X,$Z);e.camera.fov=55;e.camera.updateProjectionMatrix();e.camera.position.set($X,gy+$EYE,$Z);e.camera.lookAt($X+Math.sin($YAW)*$AHEAD,gy+$TGT,$Z+Math.cos($YAW)*$AHEAD);e.camera.updateMatrixWorld(true);window.__forceCamera=true;await window.__settle(150);})()"
  node tools/shot.mjs --view drive --out "$OUT" --w 1600 --h 900 --eval "$EV"
}
mk 1329.8529666835984 1031.6716535573803 1.3640704496667366 1.55 2.0 0.15 16.7 "$DIR/close-road-2m.png"
mk -1200.96 -1320.96 5.6941366846315 1.50 2.2 0.20 17.2 "$DIR/close-grass-2m.png"
